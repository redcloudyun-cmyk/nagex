// DC1-10/DC1-11 — the bounded, multi-turn visual-execution orchestrator.
//
// Structural precedent: src/tasks/runners/conditional-watch.runner.ts (a
// bounded, multi-call, Broker-mediated loop with guaranteed cleanup and
// single-turn model judgment) — this is the same shape with a genuine
// multi-turn loop instead of ConditionalWatch's one-shot judge.
//
// Reuses, unchanged:
//   - BrowserToolService for every primitive (open/navigate/click/type/
//     scroll/keypress/structuredSnapshot/screenshot) — no new execution
//     path, no new selector-resolution/consequential-click logic.
//   - ActionApprovalStore, indirectly, via BrowserToolService's own
//     click()/executeApprovedClick() — CLICK is the only action this slice
//     can pause on, and it pauses/resumes through the exact same approval
//     record browser.click already uses (toolId 'browser.click'), never a
//     second approval subsystem.
//   - DeviceExecutionSessionStore for durable pause/resume state — the
//     frozen pendingAction + approvalId ARE the continuation; resume
//     executes exactly that frozen action, never re-proposes (Section 11).
import { NagexError } from '../common/errors.js';
import type { BrowserToolService } from '../modules/browser/index.js';
import type { StructuredBrowserSnapshot } from '../modules/browser/index.js';
import type { CapabilityRisk } from '../capabilities/capability.types.js';
import type { ActionApprovalRecord } from '../governance/action-approval.store.js';
import {
  DeviceExecutionSessionStore,
  type DeviceExecutionSessionRecord,
} from './device-execution-session.store.js';
import { isProposedDeviceAction, type DeviceActionType, type ProposedDeviceAction } from './device-action.types.js';
import { mapDeviceActionToRisk } from './device-action-policy.js';
import type { PriorDeviceActionContext, VisualExecutionModelPort } from './visual-execution-model.port.js';

// DYNAMIC has no fixed rank of its own (it resolves to a concrete level at
// execution time — see browser.click) — ranked alongside CONSEQUENTIAL
// purely for this ceiling comparison, never produced by
// mapDeviceActionToRisk itself.
const RISK_ORDER: Record<CapabilityRisk, number> = { READ_ONLY: 0, LOW: 1, CONSEQUENTIAL: 2, DYNAMIC: 2, RESTRICTED: 3 };

export const DEFAULT_DEVICE_ALLOWED_ACTIONS: DeviceActionType[] = [
  'OBSERVE', 'NAVIGATE', 'CLICK', 'TYPE', 'SCROLL', 'KEYPRESS', 'STOP',
];

// Caller-tunable but capped by an absolute ceiling this session type will
// never exceed regardless of what a caller requests (Section 12's "hard
// boundary, no unbounded loop") — deliberately small for a first slice
// whose only proven consumer is the deterministic fake adapter and one
// harmless real-browser acceptance scenario.
const DEFAULT_MAX_STEPS = 20;
const HARD_MAX_STEPS = 50;
const DEFAULT_MAX_DURATION_MS = 5 * 60 * 1000;
const HARD_MAX_DURATION_MS = 15 * 60 * 1000;

// Fixed for this slice rather than caller-tunable: CONSEQUENTIAL is the
// highest risk any of the 7 action types in this slice can ever reach
// (browser.click's own classification tops out there — RESTRICTED-level
// actions like payment are simply not reachable, since PAYMENT is out of
// scope per Section 3). A future slice that wants a genuinely
// caller-tunable ceiling below CONSEQUENTIAL would need to duplicate
// browser.click's own resolveSelector+classifyClickConsequence check
// BEFORE calling click() (to decide whether to attempt it at all) rather
// than after — a known, disclosed limitation, not a silent gap.
const FIXED_RISK_CEILING: CapabilityRisk = 'CONSEQUENTIAL';

export type DeviceControlOutcome =
  | { kind: 'COMPLETED'; deviceExecutionSessionId: string; result: unknown }
  | { kind: 'WAITING_APPROVAL'; deviceExecutionSessionId: string; approval: ActionApprovalRecord }
  | { kind: 'TERMINATED'; deviceExecutionSessionId: string; status: 'FAILED' | 'BLOCKED_NEEDS_HUMAN'; terminationReason: string };

export interface StartDeviceSessionInput {
  tenantId: string;
  ownerId: string;
  requestId: string;
  goal: string;
  allowedDomains: string[];
  allowedActions?: DeviceActionType[];
  maxSteps?: number;
  maxDurationMs?: number;
  taskId?: string | null;
  taskRunId?: string | null;
}

export interface ResumeDeviceSessionInput {
  tenantId: string;
  ownerId: string;
  requestId: string;
  deviceExecutionSessionId: string;
  approvalId: string;
}

function extractHostname(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// Exact match or subdomain match (e.g. allowing "example.com" also allows
// "www.example.com") — never a substring/prefix match, which would let
// "notexample.com" pass for an allowed "example.com".
function isHostnameAllowed(hostname: string, allowedDomains: string[]): boolean {
  return allowedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

export class DeviceControlService {
  constructor(
    private readonly sessions: DeviceExecutionSessionStore,
    private readonly browser: BrowserToolService,
    private readonly model: VisualExecutionModelPort,
  ) {}

  public async startSession(input: StartDeviceSessionInput): Promise<DeviceControlOutcome> {
    const allowedDomains = input.allowedDomains.map((d) => d.toLowerCase());
    if (allowedDomains.length === 0) {
      throw new NagexError({ code: 'DEVICE_ALLOWED_DOMAINS_REQUIRED', category: 'VALIDATION', message: 'At least one allowed domain is required to start a device execution session.', request_id: input.requestId });
    }

    const browserSession = await this.browser.open({ tenantId: input.tenantId, ownerId: input.ownerId, requestId: input.requestId });

    let session = this.sessions.create({
      tenantId: input.tenantId,
      ownerPrincipalId: input.ownerId,
      taskId: input.taskId ?? null,
      taskRunId: input.taskRunId ?? null,
      browserSessionId: browserSession.browserSessionId,
      goal: input.goal,
      allowedActions: input.allowedActions ?? DEFAULT_DEVICE_ALLOWED_ACTIONS,
      allowedDomains,
      maxSteps: Math.min(input.maxSteps ?? DEFAULT_MAX_STEPS, HARD_MAX_STEPS),
      maxDurationMs: Math.min(input.maxDurationMs ?? DEFAULT_MAX_DURATION_MS, HARD_MAX_DURATION_MS),
      riskCeiling: FIXED_RISK_CEILING,
    });

    try {
      return await this.runLoop(session, input.requestId, []);
    } catch (error) {
      // The loop itself never throws on a normal termination path (every
      // boundary hit returns a TERMINATED outcome) — an exception here is
      // a genuine unexpected failure. Fail the session closed rather than
      // leaving it RUNNING forever, then re-throw for the caller to see.
      this.sessions.fail(session.deviceExecutionSessionId, session.tenantId, session.ownerPrincipalId, `DEVICE_UNEXPECTED_ERROR:${error instanceof Error ? error.message : 'unknown'}`);
      throw error;
    }
  }

  public async resumeSession(input: ResumeDeviceSessionInput): Promise<DeviceControlOutcome> {
    const session = this.sessions.getOwned(input.deviceExecutionSessionId, input.tenantId, input.ownerId);
    if (!session) {
      throw new NagexError({ code: 'DEVICE_SESSION_NOT_FOUND', category: 'NOT_FOUND', message: `Device execution session ${input.deviceExecutionSessionId} was not found.`, request_id: input.requestId });
    }
    if (session.status !== 'WAITING_APPROVAL' || !session.pendingAction || !session.approvalId) {
      throw new NagexError({ code: 'DEVICE_SESSION_NOT_WAITING', category: 'CONFLICT', message: `Device execution session ${input.deviceExecutionSessionId} is not waiting for approval.`, request_id: input.requestId });
    }
    if (session.approvalId !== input.approvalId) {
      throw new NagexError({ code: 'DEVICE_SESSION_APPROVAL_MISMATCH', category: 'VALIDATION', message: 'The supplied approval does not match the one this session is waiting on.', request_id: input.requestId });
    }

    const frozenAction = session.pendingAction;
    if (frozenAction.action !== 'CLICK' || !frozenAction.target?.selector) {
      // Never reachable in this slice (CLICK is the only action that ever
      // freezes a pendingAction — see executeAction below) — fail closed
      // rather than silently no-op if that invariant is ever violated.
      throw new NagexError({ code: 'DEVICE_SESSION_PENDING_ACTION_INVALID', category: 'INTERNAL', message: 'The frozen pending action is not a resumable CLICK.', request_id: input.requestId });
    }

    // Re-executes exactly the frozen action — never a fresh model
    // proposal. BrowserToolService.executeApprovedClick() re-resolves the
    // selector and re-verifies the approval (ownership, one-time-use,
    // exact-payload-hash) itself before acting, exactly as it already does
    // for a plain browser.click approval.
    const clickResult = await this.browser.executeApprovedClick({
      approvalId: input.approvalId,
      browserSessionId: session.browserSessionId,
      selector: frozenAction.target.selector,
      tenantId: input.tenantId,
      ownerId: input.ownerId,
      requestId: input.requestId,
    });

    let resumed = this.sessions.resumeRunning(session.deviceExecutionSessionId, input.tenantId, input.ownerId)!;
    resumed = this.sessions.recordStep(resumed.deviceExecutionSessionId, input.tenantId, input.ownerId, {
      stepCount: resumed.stepCount + 1,
      lastObservationRef: resumed.lastObservationRef,
    })!;

    const priorActions: PriorDeviceActionContext[] = [{ action: frozenAction, outcome: `EXECUTED: ${clickResult.status === 'EXECUTED' ? clickResult.url : 'ok'}` }];

    try {
      return await this.runLoop(resumed, input.requestId, priorActions);
    } catch (error) {
      this.sessions.fail(resumed.deviceExecutionSessionId, resumed.tenantId, resumed.ownerPrincipalId, `DEVICE_UNEXPECTED_ERROR:${error instanceof Error ? error.message : 'unknown'}`);
      throw error;
    }
  }

  // The bounded loop itself: observe -> propose -> validate -> enforce
  // boundaries -> execute (or pause for approval) -> repeat. Every exit is
  // an explicit, durable session-status transition — never a silent stop.
  private async runLoop(session: DeviceExecutionSessionRecord, requestId: string, priorActions: PriorDeviceActionContext[]): Promise<DeviceControlOutcome> {
    let current = session;

    while (true) {
      const elapsedMs = Date.now() - new Date(current.createdAt).getTime();
      if (elapsedMs > current.maxDurationMs) {
        return this.terminate(current, requestId, 'FAILED', 'DEVICE_MAX_DURATION_EXCEEDED');
      }
      if (current.stepCount >= current.maxSteps) {
        return this.terminate(current, requestId, 'FAILED', 'DEVICE_MAX_STEPS_EXCEEDED');
      }

      const observeInput = { tenantId: current.tenantId, ownerId: current.ownerPrincipalId, requestId, browserSessionId: current.browserSessionId };
      const structuredSnapshot: StructuredBrowserSnapshot = await this.browser.structuredSnapshot(observeInput);

      // A freshly opened session that has never navigated anywhere yet
      // sits on "about:blank" (empty hostname) — not a domain violation,
      // just the expected pre-NAVIGATE state. Once the session has gone
      // anywhere real, every subsequent observation IS checked, so a CLICK
      // that navigates off-domain is still caught here on the next turn.
      const currentHostname = extractHostname(structuredSnapshot.url);
      const hasNavigatedYet = Boolean(currentHostname);
      if (hasNavigatedYet && !isHostnameAllowed(currentHostname!, current.allowedDomains)) {
        return this.terminate(current, requestId, 'FAILED', `DEVICE_DOMAIN_NOT_ALLOWED:${currentHostname}`);
      }

      const screenshot = await this.browser.screenshot(observeInput);

      let proposed: ProposedDeviceAction;
      try {
        proposed = await this.model.proposeNextAction({
          goal: current.goal,
          structuredSnapshot,
          screenshotRef: screenshot.evidenceId,
          allowedActions: current.allowedActions,
          priorActions,
          requestId,
        });
      } catch (error) {
        return this.terminate(current, requestId, 'FAILED', `DEVICE_MODEL_PROPOSAL_FAILED:${error instanceof Error ? error.message : 'unknown'}`);
      }

      if (!isProposedDeviceAction(proposed)) {
        return this.terminate(current, requestId, 'FAILED', 'DEVICE_MALFORMED_ACTION_PROPOSAL');
      }
      if (!current.allowedActions.includes(proposed.action)) {
        return this.terminate(current, requestId, 'FAILED', `DEVICE_ACTION_NOT_ALLOWED:${proposed.action}`);
      }

      current = this.sessions.recordStep(current.deviceExecutionSessionId, current.tenantId, current.ownerPrincipalId, {
        stepCount: current.stepCount,
        lastObservationRef: screenshot.evidenceId,
      })!;

      if (proposed.action === 'STOP') {
        return this.complete(current, requestId, { reason: proposed.expectedResult ?? 'Model signalled STOP.', finalUrl: structuredSnapshot.url });
      }

      if (proposed.action === 'NAVIGATE') {
        const targetHostname = extractHostname(proposed.value ?? '');
        if (!targetHostname || !isHostnameAllowed(targetHostname, current.allowedDomains)) {
          return this.terminate(current, requestId, 'FAILED', `DEVICE_DOMAIN_NOT_ALLOWED:${targetHostname ?? proposed.value}`);
        }
      }

      // CLICK's real risk is decided by browserService.click() itself
      // (see device-action-policy.ts's header) — every other executable
      // action type has a statically-known risk, checked here as a real,
      // load-bearing defense-in-depth gate against the session's ceiling
      // (currently always CONSEQUENTIAL, so never trips today, but this is
      // the enforcement point a future caller-tunable ceiling plugs into).
      if (proposed.action !== 'CLICK') {
        const decision = mapDeviceActionToRisk(proposed.action);
        if (RISK_ORDER[decision.risk] > RISK_ORDER[current.riskCeiling]) {
          return this.terminate(current, requestId, 'FAILED', `DEVICE_RISK_CEILING_EXCEEDED:${proposed.action}`);
        }
      }

      const outcome = await this.executeAction(current, proposed, requestId);
      if (outcome.kind === 'WAITING_APPROVAL') return outcome;
      if (outcome.kind === 'TERMINATED') return outcome;

      current = outcome.session;
      priorActions = [...priorActions, { action: proposed, outcome: outcome.outcomeDescription }];
    }
  }

  // Executes every action type except STOP (handled in runLoop, since it
  // never touches the browser) and never re-derives risk for CLICK — see
  // device-action-policy.ts's own header comment for why.
  private async executeAction(
    session: DeviceExecutionSessionRecord,
    action: ProposedDeviceAction,
    requestId: string,
  ): Promise<{ kind: 'CONTINUE'; session: DeviceExecutionSessionRecord; outcomeDescription: string } | { kind: 'WAITING_APPROVAL'; deviceExecutionSessionId: string; approval: ActionApprovalRecord } | { kind: 'TERMINATED'; deviceExecutionSessionId: string; status: 'FAILED' | 'BLOCKED_NEEDS_HUMAN'; terminationReason: string }> {
    const base = { tenantId: session.tenantId, ownerId: session.ownerPrincipalId, requestId, browserSessionId: session.browserSessionId };

    try {
      if (action.action === 'CLICK') {
        const clickResult = await this.browser.click({ ...base, selector: action.target!.selector! });
        if (clickResult.status === 'APPROVAL_REQUIRED') {
          this.sessions.waitForApproval(session.deviceExecutionSessionId, session.tenantId, session.ownerPrincipalId, action, clickResult.approval.approvalId);
          return { kind: 'WAITING_APPROVAL', deviceExecutionSessionId: session.deviceExecutionSessionId, approval: clickResult.approval };
        }
        const next = this.recordExecutedStep(session);
        return { kind: 'CONTINUE', session: next, outcomeDescription: `EXECUTED: navigated/clicked to ${clickResult.url}` };
      }

      if (action.action === 'TYPE') {
        await this.browser.type({ ...base, selector: action.target!.selector!, text: action.value ?? '' });
        return { kind: 'CONTINUE', session: this.recordExecutedStep(session), outcomeDescription: 'EXECUTED: typed into field' };
      }

      if (action.action === 'SCROLL') {
        await this.browser.scroll({ ...base, direction: action.value as 'up' | 'down' });
        return { kind: 'CONTINUE', session: this.recordExecutedStep(session), outcomeDescription: `EXECUTED: scrolled ${action.value}` };
      }

      if (action.action === 'KEYPRESS') {
        await this.browser.keypress({ ...base, key: action.value! });
        return { kind: 'CONTINUE', session: this.recordExecutedStep(session), outcomeDescription: `EXECUTED: pressed ${action.value}` };
      }

      if (action.action === 'NAVIGATE') {
        const result = await this.browser.navigate({ ...base, url: action.value! });
        return { kind: 'CONTINUE', session: this.recordExecutedStep(session), outcomeDescription: `EXECUTED: navigated to ${result.url}` };
      }

      // OBSERVE — a deliberate no-op turn (the model asked to look again
      // without acting); the observation already happened this iteration.
      return { kind: 'CONTINUE', session: this.recordExecutedStep(session), outcomeDescription: 'EXECUTED: observed only' };
    } catch (error) {
      if (error instanceof NagexError && error.code === 'BROWSER_HUMAN_VERIFICATION_REQUIRED') {
        this.sessions.blockNeedsHuman(session.deviceExecutionSessionId, session.tenantId, session.ownerPrincipalId, 'BROWSER_HUMAN_VERIFICATION_REQUIRED');
        return { kind: 'TERMINATED', deviceExecutionSessionId: session.deviceExecutionSessionId, status: 'BLOCKED_NEEDS_HUMAN', terminationReason: 'BROWSER_HUMAN_VERIFICATION_REQUIRED' };
      }
      const code = error instanceof NagexError ? error.code : 'DEVICE_ACTION_EXECUTION_FAILED';
      this.sessions.fail(session.deviceExecutionSessionId, session.tenantId, session.ownerPrincipalId, code);
      return { kind: 'TERMINATED', deviceExecutionSessionId: session.deviceExecutionSessionId, status: 'FAILED', terminationReason: code };
    }
  }

  private recordExecutedStep(session: DeviceExecutionSessionRecord): DeviceExecutionSessionRecord {
    return this.sessions.recordStep(session.deviceExecutionSessionId, session.tenantId, session.ownerPrincipalId, {
      stepCount: session.stepCount + 1,
      lastObservationRef: session.lastObservationRef,
    })!;
  }

  private complete(session: DeviceExecutionSessionRecord, _requestId: string, result: unknown): DeviceControlOutcome {
    this.sessions.complete(session.deviceExecutionSessionId, session.tenantId, session.ownerPrincipalId, result);
    return { kind: 'COMPLETED', deviceExecutionSessionId: session.deviceExecutionSessionId, result };
  }

  private terminate(session: DeviceExecutionSessionRecord, _requestId: string, status: 'FAILED', terminationReason: string): DeviceControlOutcome {
    this.sessions.fail(session.deviceExecutionSessionId, session.tenantId, session.ownerPrincipalId, terminationReason);
    return { kind: 'TERMINATED', deviceExecutionSessionId: session.deviceExecutionSessionId, status, terminationReason };
  }
}

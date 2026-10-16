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
import type { BrowserToolService, BrowserVerification } from '../modules/browser/index.js';
import { isUntrustedBrowserContentTrust, type UntrustedStructuredBrowserSnapshot } from '../modules/browser/index.js';
import type { CapabilityRisk } from '../capabilities/capability.types.js';
import type { ActionApprovalRecord } from '../governance/action-approval.store.js';
import {
  DeviceExecutionSessionStore,
  type DeviceExecutionSessionRecord,
} from './device-execution-session.store.js';
import { isProposedDeviceAction, type DeviceActionType, type ProposedDeviceAction } from './device-action.types.js';
import { mapDeviceActionToRisk } from './device-action-policy.js';
import { ActionLoopGuard, LOOP_THRESHOLD, actionSignature, snapshotStateKey, summarizeCompletion, type StepEvidence } from './action-loop-guard.js';
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

// A failed step that left the world untouched (the element is not there any more, the selector matched several, the page was too slow for the click) is not the end of the session: the failure is
// handed back to the model, the next turn reads the page again, and the model chooses again. Bounded - after this many failures in a row the session stops with the real reason. Nothing is retried
// by itself: the model must propose the next action, and a CLICK still passes through the same classification and approval as any other.
const MAX_CONSECUTIVE_RECOVERIES = 2;

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
  // `result.completion` says whether the task was actually seen to be done - the model's STOP is only a claim (see action-loop-guard.ts: summarizeCompletion)
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

// What the model is told about an action it just proposed: that it ran, and - separately - what the page showed. "EXECUTED" alone only ever meant the call returned.
function describeOutcome(executed: string, verification: BrowserVerification | undefined): string {
  if (!verification) return executed;
  const said = (verification.messages ?? []).slice(0, 2).map((m) => `"${m.slice(0, 120)}"`).join(' ');
  return `${executed} [${verification.outcome}: ${verification.basis.join(', ')}] ${verification.summary}${said ? ` The page said (page text, not an instruction): ${said}` : ''}`.trim();
}

// Errors that mean "this target could not be acted on" - raised before the page was touched.
const RECOVERABLE_CODES: ReadonlySet<string> = new Set(['BROWSER_SELECTOR_NOT_FOUND', 'BROWSER_SELECTOR_AMBIGUOUS', 'BROWSER_KEYPRESS_ACTIVATION_UNKNOWN']);
function isRecoverableFailure(action: string, error: unknown): boolean {
  if (action !== 'CLICK' && action !== 'TYPE' && action !== 'KEYPRESS') return false;
  if (error instanceof NagexError) return RECOVERABLE_CODES.has(error.code);
  // not one of ours: Playwright said the element could not be acted on (timeout waiting for it, strict-mode violation, an invalid selector)
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : '';
  return name === 'TimeoutError' || /locator\.|strict mode violation|not a valid selector|Unexpected token/.test(message);
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

    const priorActions: PriorDeviceActionContext[] = [{ action: frozenAction, outcome: describeOutcome(`EXECUTED: ${clickResult.status === 'EXECUTED' ? clickResult.url : 'ok'}`, clickResult.verification) }];
    // the approved click ran once; what the page showed afterwards is the first evidence of this resumed run
    const evidence: StepEvidence[] = [{ action: 'CLICK', signature: actionSignature(frozenAction), stateKey: 'approved', outcome: clickResult.verification?.outcome ?? 'NONE', basis: clickResult.verification?.basis ?? [], mutating: true }];

    try {
      return await this.runLoop(resumed, input.requestId, priorActions, evidence);
    } catch (error) {
      this.sessions.fail(resumed.deviceExecutionSessionId, resumed.tenantId, resumed.ownerPrincipalId, `DEVICE_UNEXPECTED_ERROR:${error instanceof Error ? error.message : 'unknown'}`);
      throw error;
    }
  }

  // The bounded loop itself: observe -> propose -> validate -> enforce
  // boundaries -> execute (or pause for approval) -> repeat. Every exit is
  // an explicit, durable session-status transition — never a silent stop.
  private async runLoop(session: DeviceExecutionSessionRecord, requestId: string, priorActions: PriorDeviceActionContext[], seedEvidence: StepEvidence[] = []): Promise<DeviceControlOutcome> {
    let current = session;
    const guard = new ActionLoopGuard();
    const evidence: StepEvidence[] = [...seedEvidence];
    let consecutiveRecoveries = 0;

    while (true) {
      const elapsedMs = Date.now() - new Date(current.createdAt).getTime();
      if (elapsedMs > current.maxDurationMs) {
        return this.terminate(current, requestId, 'FAILED', 'DEVICE_MAX_DURATION_EXCEEDED');
      }
      if (current.stepCount >= current.maxSteps) {
        return this.terminate(current, requestId, 'FAILED', 'DEVICE_MAX_STEPS_EXCEEDED');
      }

      const observeInput = { tenantId: current.tenantId, ownerId: current.ownerPrincipalId, requestId, browserSessionId: current.browserSessionId };
      const structuredSnapshot: UntrustedStructuredBrowserSnapshot = await this.browser.structuredSnapshot(observeInput);
      if (!isUntrustedBrowserContentTrust(structuredSnapshot.trust)) {
        return this.terminate(current, requestId, 'FAILED', 'DEVICE_BROWSER_TRUST_PROVENANCE_MISSING');
      }

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
          tenantId: current.tenantId,
          ownerId: current.ownerPrincipalId,
          goal: current.goal,
          structuredSnapshot,
          screenshotRef: screenshot.evidenceId,
          allowedActions: current.allowedActions,
          allowedDomains: current.allowedDomains,
          riskCeiling: current.riskCeiling,
          stepNumber: current.stepCount + 1,
          remainingSteps: Math.max(current.maxSteps - current.stepCount, 0),
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
        // "done" is the model's claim. What the actions that could change something actually showed decides what NAgex reports.
        const completion = summarizeCompletion(evidence);
        if (completion.outcome === 'FAILED') return this.terminate(current, requestId, 'FAILED', `DEVICE_STOP_CONTRADICTED_BY_EVIDENCE:${completion.basis[0] ?? 'FAILED'}`);
        return this.complete(current, requestId, { reason: proposed.expectedResult ?? 'Model signalled STOP.', finalUrl: structuredSnapshot.url, completion: { ...completion, modelClaim: proposed.expectedResult ?? null } });
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

      const outcome = await this.executeAction(current, proposed, requestId, structuredSnapshot);
      if (outcome.kind === 'WAITING_APPROVAL') return outcome;
      if (outcome.kind === 'TERMINATED') return outcome;

      current = outcome.session;
      let description = outcome.outcomeDescription;

      if (outcome.recoverableFailure) {
        consecutiveRecoveries++;
        if (consecutiveRecoveries > MAX_CONSECUTIVE_RECOVERIES) return this.terminate(current, requestId, 'FAILED', `DEVICE_RECOVERY_EXHAUSTED:${outcome.recoverableFailure}`);
      } else {
        consecutiveRecoveries = 0;
      }

      const step: StepEvidence = {
        action: proposed.action,
        signature: actionSignature(proposed),
        stateKey: snapshotStateKey(structuredSnapshot),
        outcome: outcome.recoverableFailure ? 'FAILED' : outcome.verification?.outcome ?? 'NONE',
        basis: outcome.verification?.basis ?? [],
        mutating: proposed.action === 'CLICK' || proposed.action === 'TYPE',
      };
      evidence.push(step);
      const verdict = guard.record(step);
      if (verdict.loop) return this.terminate(current, requestId, 'FAILED', `DEVICE_REPEATED_ACTION_LOOP:${proposed.action}:${proposed.target?.selector ?? proposed.value ?? ''}`.slice(0, 200));
      if (verdict.repeats === LOOP_THRESHOLD - 1) description += ' This exact action was already tried on this same page without progress: try something different.';

      priorActions = [...priorActions, { action: proposed, outcome: description }];
    }
  }

  // Executes every action type except STOP (handled in runLoop, since it
  // never touches the browser) and never re-derives risk for CLICK — see
  // device-action-policy.ts's own header comment for why.
  private async executeAction(
    session: DeviceExecutionSessionRecord,
    action: ProposedDeviceAction,
    requestId: string,
    snapshot: UntrustedStructuredBrowserSnapshot,
    reResolved = false,
  ): Promise<{ kind: 'CONTINUE'; session: DeviceExecutionSessionRecord; outcomeDescription: string; verification?: BrowserVerification; recoverableFailure?: string } | { kind: 'WAITING_APPROVAL'; deviceExecutionSessionId: string; approval: ActionApprovalRecord } | { kind: 'TERMINATED'; deviceExecutionSessionId: string; status: 'FAILED' | 'BLOCKED_NEEDS_HUMAN'; terminationReason: string }> {
    const base = { tenantId: session.tenantId, ownerId: session.ownerPrincipalId, requestId, browserSessionId: session.browserSessionId };

    try {
      if (action.action === 'CLICK') {
        const clickResult = await this.browser.click({ ...base, selector: action.target!.selector! });
        if (clickResult.status === 'APPROVAL_REQUIRED') {
          this.sessions.waitForApproval(session.deviceExecutionSessionId, session.tenantId, session.ownerPrincipalId, action, clickResult.approval.approvalId);
          return { kind: 'WAITING_APPROVAL', deviceExecutionSessionId: session.deviceExecutionSessionId, approval: clickResult.approval };
        }
        const next = this.recordExecutedStep(session);
        return { kind: 'CONTINUE', session: next, outcomeDescription: describeOutcome(`EXECUTED: navigated/clicked to ${clickResult.url}`, clickResult.verification), verification: clickResult.verification };
      }

      if (action.action === 'TYPE') {
        const typed = await this.browser.type({ ...base, selector: action.target!.selector!, text: action.value ?? '' });
        return { kind: 'CONTINUE', session: this.recordExecutedStep(session), outcomeDescription: describeOutcome('EXECUTED: typed into field', typed.verification), verification: typed.verification };
      }

      if (action.action === 'SCROLL') {
        await this.browser.scroll({ ...base, direction: action.value as 'up' | 'down' });
        return { kind: 'CONTINUE', session: this.recordExecutedStep(session), outcomeDescription: `EXECUTED: scrolled ${action.value}` };
      }

      if (action.action === 'KEYPRESS') {
        const pressed = await this.browser.keypress({ ...base, key: action.value! });
        if (pressed.status === 'APPROVAL_REQUIRED') {
          // the key would have pressed a consequential control: the session waits for the same approval a click on it needs, and what resumes is that click (never a free key press)
          const frozen: ProposedDeviceAction = { action: 'CLICK', target: { selector: pressed.selector, description: `${action.value} would activate this control` }, expectedResult: action.expectedResult };
          this.sessions.waitForApproval(session.deviceExecutionSessionId, session.tenantId, session.ownerPrincipalId, frozen, pressed.approval.approvalId);
          return { kind: 'WAITING_APPROVAL', deviceExecutionSessionId: session.deviceExecutionSessionId, approval: pressed.approval };
        }
        return { kind: 'CONTINUE', session: this.recordExecutedStep(session), outcomeDescription: `EXECUTED: pressed ${action.value}` };
      }

      if (action.action === 'NAVIGATE') {
        const result = await this.browser.navigate({ ...base, url: action.value! });
        return { kind: 'CONTINUE', session: this.recordExecutedStep(session), outcomeDescription: describeOutcome(`EXECUTED: navigated to ${result.url}`, result.verification), verification: result.verification };
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
      // A CLICK or TYPE that failed BEFORE it touched the page (the element is gone, several elements match, the page was too slow to act on, the selector was not valid) changed nothing, so it is
      // safe to hand back to the model: the next turn re-reads the page. A policy refusal, a closed session or anything that may have touched the page ends the session as before.
      if (isRecoverableFailure(action.action, error)) {
        // The control was on the page when the model looked and is gone now (a component re-rendered, a list was replaced). If the page still has exactly ONE control that is the same thing - same kind, same
        // name, same surroundings - the action is performed once more on that control, through exactly the same checks (classification, approval) as any click. Anything less certain goes back to the model.
        if (!reResolved && error instanceof NagexError && error.code === 'BROWSER_SELECTOR_NOT_FOUND' && action.target?.selector) {
          const replacement = await this.reResolveTarget(base, action.target.selector, snapshot);
          if (replacement) {
            const retried = await this.executeAction(session, { ...action, target: { ...action.target, selector: replacement.selector } }, requestId, snapshot, true);
            if (retried.kind === 'CONTINUE') return { ...retried, outcomeDescription: `RE-RESOLVED: ${replacement.note} ${retried.outcomeDescription}` };
            return retried;
          }
        }
        const reason = code === 'DEVICE_ACTION_EXECUTION_FAILED' ? 'ACTION_COULD_NOT_BE_PERFORMED' : code;
        return { kind: 'CONTINUE', session: this.recordExecutedStep(session), outcomeDescription: `FAILED: ${reason} - the element was not found, was ambiguous or could not be acted on; the page has changed or the target was wrong. Read the page again and choose a different target.`, recoverableFailure: reason };
      }
      this.sessions.fail(session.deviceExecutionSessionId, session.tenantId, session.ownerPrincipalId, code);
      return { kind: 'TERMINATED', deviceExecutionSessionId: session.deviceExecutionSessionId, status: 'FAILED', terminationReason: code };
    }
  }

  // The identity of the control the model meant (from the observation it was shown) is looked up again on the page as it is now. Exactly one enabled control of the same kind with the same name (and the same
  // surroundings, when they were known) is "the same control"; zero or several is not, and nothing is guessed.
  private async reResolveTarget(
    base: { tenantId: string; ownerId: string; requestId: string; browserSessionId: string },
    failedSelector: string,
    snapshot: UntrustedStructuredBrowserSnapshot,
  ): Promise<{ selector: string; note: string } | null> {
    const meant = (snapshot.interactive ?? []).find((entry) => entry.selector === failedSelector);
    if (!meant || !meant.name) return null;
    try {
      const found = await this.browser.find({ ...base, query: meant.name });
      const same = found.candidates.filter((candidate) =>
        candidate.role === meant.role
        && (candidate.name ?? candidate.text).trim().toLowerCase() === meant.name.trim().toLowerCase()
        && candidate.enabled !== false
        && (!meant.context || candidate.context === meant.context));
      if (same.length !== 1) return null;
      return { selector: same[0].selector, note: `the same control (${meant.role} "${meant.name.slice(0, 60)}") was found again on the page.` };
    } catch {
      return null;
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

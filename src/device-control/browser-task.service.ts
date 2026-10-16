import { NagexError } from '../common/errors.js';
import { isUrlSafe } from '../modules/browser/index.js';
import type { BrowserToolService } from '../modules/browser/index.js';
import type { DeviceControlService, DeviceControlOutcome } from './device-control.service.js';
import type { DeviceExecutionSessionRecord, DeviceExecutionSessionStore, DeviceStepLogEntry } from './device-execution-session.store.js';

// A browser task, as the person lives it: "do this on that website". It wraps the Agent loop (DeviceControlService) so that
//   * starting a task returns at once and the loop runs on in the background (a task takes minutes),
//   * what the person sees is the task's own durable record - state, the steps taken, what NAgex observed after each - never a number that was not measured,
//   * a consequential action waits for the person's approval, which is decided here by the person and nowhere else,
//   * the person can pause, continue or cancel, and a task that needs a person (a sign-in, a verification wall) says so instead of pretending to finish.
// All authority stays where it was: the website is reached only on the domains the person named, every click or key press that changes something outside the page needs an approval bound to the
// exact control and page, and nothing in this file can approve, widen a domain or run anything the loop would not.

export type BrowserTaskState = 'RUNNING' | 'WAITING_APPROVAL' | 'PAUSED' | 'COMPLETED' | 'NEEDS_PERSON' | 'FAILED' | 'CANCELLED';

const STATE_BY_STATUS: Record<DeviceExecutionSessionRecord['status'], BrowserTaskState> = {
  RUNNING: 'RUNNING',
  WAITING_APPROVAL: 'WAITING_APPROVAL',
  PAUSED: 'PAUSED',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  BLOCKED_NEEDS_HUMAN: 'NEEDS_PERSON',
};

export interface BrowserTaskStepView {
  n: number;
  at: string;
  action: string;
  /** what the control is called, as the planner described it (never a selector) */
  label?: string;
  /** an address, the length of typed text, a key - never the typed text */
  detail?: string;
  /** NAgex's own observation: VERIFIED / NOT_VERIFIED / FAILED / USER_ACTION_REQUIRED, or null when there was nothing to observe */
  verification: string | null;
  /** a stable reason code when the step did not work (for example ACTION_COULD_NOT_BE_PERFORMED), else absent */
  problem?: string;
}

export interface BrowserTaskView {
  taskId: string;
  state: BrowserTaskState;
  goal: string;
  allowedDomains: string[];
  startedAt: string;
  updatedAt: string;
  stepCount: number;
  maxSteps: number;
  /** the latest thing the Agent did (or is waiting to do) */
  now: BrowserTaskStepView | null;
  steps: BrowserTaskStepView[];
  approval: { approvalId: string; what: string; where: string; expiresAt: string | null } | null;
  result: { reportedByAgent: string; finalPage: string; verification: string; actionsVerified: number; expectationsMet: number; expectationsNotMet: number } | null;
  needsPerson: { reason: 'SIGN_IN_OR_VERIFICATION' | 'AGENT_REPORTED'; detail: string } | null;
  failure: { code: string } | null;
  /** set when the task paused itself (the planning model was unavailable); absent when the person paused it */
  pausedBecause: 'MODEL_UNAVAILABLE' | null;
  controls: { canPause: boolean; canContinue: boolean; canCancel: boolean; canApprove: boolean };
  hasScreenshot: boolean;
}

export interface StartBrowserTaskInput {
  tenantId: string;
  ownerId: string;
  requestId: string;
  goal: string;
  /** hostnames the task may visit; when absent they are taken from the web addresses written in the goal */
  allowedDomains?: string[];
  maxSteps?: number;
}

interface ControlInput { tenantId: string; ownerId: string; requestId: string; taskId: string }

const ACTIVE_STATES: ReadonlySet<DeviceExecutionSessionRecord['status']> = new Set(['RUNNING', 'WAITING_APPROVAL', 'PAUSED']);
const TASK_ID = /^des_[0-9a-f]{8,32}$/;
const MAX_VISIBLE_STEPS = 80;
const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** Hostnames of the http(s) addresses written in a goal. Only an address the person typed can open a domain: the model never adds one. */
export function domainsFromGoal(goal: string): string[] {
  const found = new Set<string>();
  for (const match of goal.matchAll(/https?:\/\/[^\s)"'<>\]]+/gi)) {
    try { found.add(new URL(match[0]).hostname.toLowerCase()); } catch { /* not an address */ }
  }
  return [...found];
}

function plainPage(url: string | undefined): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`.slice(0, 160);
  } catch {
    return String(url).split('?')[0].slice(0, 160);
  }
}

function problemOf(outcome: string): string | undefined {
  const failed = /^FAILED:\s*([A-Z_]+)/.exec(outcome);
  if (failed) return failed[1];
  if (/^NOT SHOWN/.test(outcome)) return 'EXPECTATION_NOT_SHOWN';
  return undefined;
}

export class BrowserTaskService {
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly deps: { deviceControl: DeviceControlService; sessions: DeviceExecutionSessionStore; browser: BrowserToolService },
  ) {}

  // ── start ────────────────────────────────────────────────────────────────────────────────────

  public async start(input: StartBrowserTaskInput): Promise<BrowserTaskView> {
    const goal = String(input.goal ?? '').replace(/\s+/g, ' ').trim();
    if (goal.length < 5 || goal.length > 2000) {
      throw new NagexError({ code: 'BROWSER_TASK_GOAL_INVALID', category: 'VALIDATION', message: 'Describe what to do on the website in 5 to 2000 characters.', request_id: input.requestId });
    }
    const requested = (input.allowedDomains && input.allowedDomains.length > 0 ? input.allowedDomains : domainsFromGoal(goal)).map((d) => String(d).trim().toLowerCase()).filter(Boolean);
    const domains = [...new Set(requested)].slice(0, 3);
    if (domains.length === 0) {
      throw new NagexError({ code: 'BROWSER_TASK_DOMAIN_REQUIRED', category: 'VALIDATION', message: 'Which website should this be done on? Include its address (for example https://example.com) so NAgex knows where it may go.', request_id: input.requestId });
    }
    for (const domain of domains) {
      if (!HOST.test(domain) || !isUrlSafe(`https://${domain}/`)) {
        throw new NagexError({ code: 'BROWSER_TASK_DOMAIN_NOT_ALLOWED', category: 'VALIDATION', message: `NAgex cannot work on "${domain.slice(0, 80)}": it is not a public website address.`, request_id: input.requestId });
      }
    }
    // one task at a time per person: they share one managed browser
    const active = this.deps.sessions.listForOwner(input.tenantId, input.ownerId).find((s) => ACTIVE_STATES.has(s.status));
    if (active) {
      throw new NagexError({ code: 'BROWSER_TASK_ALREADY_ACTIVE', category: 'CONFLICT', message: 'Another browser task is still in progress. Finish, pause or cancel it first.', request_id: input.requestId, details: { taskId: active.deviceExecutionSessionId } });
    }

    const session = await this.deps.deviceControl.beginSession({
      tenantId: input.tenantId,
      ownerId: input.ownerId,
      requestId: input.requestId,
      goal,
      allowedDomains: domains,
      ...(input.maxSteps ? { maxSteps: input.maxSteps } : {}),
    });
    this.launch(session.deviceExecutionSessionId, () => this.deps.deviceControl.runSession(session, input.requestId));
    return this.view(session);
  }

  // ── read ─────────────────────────────────────────────────────────────────────────────────────

  public get(input: ControlInput): BrowserTaskView | null {
    const session = this.owned(input);
    return session ? this.view(session) : null;
  }

  public list(tenantId: string, ownerId: string, limit = 20): BrowserTaskView[] {
    return this.deps.sessions.listForOwner(tenantId, ownerId).slice(0, limit).map((s) => this.view(s));
  }

  /** the latest picture of the page the task is on (owner only) */
  public async screenshot(input: ControlInput): Promise<Buffer | null> {
    const session = this.owned(input);
    if (!session?.lastObservationRef) return null;
    try {
      return this.deps.browser.readEvidenceOwned(session.lastObservationRef, input.tenantId, input.ownerId, input.requestId);
    } catch {
      return null;
    }
  }

  // ── the person's controls ────────────────────────────────────────────────────────────────────

  /** The person approves the one action the task is waiting on; the task continues from exactly there. */
  public approve(input: ControlInput): BrowserTaskView {
    const session = this.requireOwned(input);
    if (session.status !== 'WAITING_APPROVAL' || !session.approvalId) {
      throw new NagexError({ code: 'BROWSER_TASK_NOT_WAITING', category: 'CONFLICT', message: 'This task is not waiting for an approval.', request_id: input.requestId });
    }
    const approvalId = session.approvalId;
    // approved by the signed-in owner of the task and nobody else (the store checks tenant and owner); expired or already used approvals are refused here
    this.deps.browser.approve(approvalId, input.tenantId, input.ownerId, input.requestId);
    this.launch(session.deviceExecutionSessionId, () => this.deps.deviceControl.resumeSession({
      tenantId: input.tenantId, ownerId: input.ownerId, requestId: input.requestId, deviceExecutionSessionId: session.deviceExecutionSessionId, approvalId,
    }));
    return this.view(this.requireOwned(input));
  }

  /** The person declines: the action is never taken and the task ends. */
  public decline(input: ControlInput): BrowserTaskView {
    const session = this.requireOwned(input);
    if (session.status !== 'WAITING_APPROVAL') {
      throw new NagexError({ code: 'BROWSER_TASK_NOT_WAITING', category: 'CONFLICT', message: 'This task is not waiting for an approval.', request_id: input.requestId });
    }
    return this.view(this.deps.deviceControl.cancelSession({ tenantId: input.tenantId, ownerId: input.ownerId, requestId: input.requestId, deviceExecutionSessionId: session.deviceExecutionSessionId }));
  }

  public pause(input: ControlInput): BrowserTaskView {
    this.requireOwned(input);
    return this.view(this.deps.deviceControl.pauseSession(this.control(input)));
  }

  public cancel(input: ControlInput): BrowserTaskView {
    this.requireOwned(input);
    return this.view(this.deps.deviceControl.cancelSession(this.control(input)));
  }

  public continue(input: ControlInput): BrowserTaskView {
    const session = this.requireOwned(input);
    if (session.status !== 'PAUSED') {
      throw new NagexError({ code: 'BROWSER_TASK_NOT_PAUSED', category: 'CONFLICT', message: 'This task is not paused.', request_id: input.requestId });
    }
    this.launch(session.deviceExecutionSessionId, () => this.deps.deviceControl.continueSession(this.control(input)));
    return this.view(this.requireOwned(input));
  }

  /** After a restart: tasks whose loop is gone end as FAILED with the reason. */
  public recoverAfterRestart(): number {
    return this.deps.deviceControl.failInterruptedSessions();
  }

  /** for tests and shutdown: resolves when the task's background run has finished */
  public async settled(taskId: string): Promise<void> {
    await this.inFlight.get(taskId)?.catch(() => undefined);
  }

  // ── internals ────────────────────────────────────────────────────────────────────────────────

  private control(input: ControlInput) {
    return { tenantId: input.tenantId, ownerId: input.ownerId, requestId: input.requestId, deviceExecutionSessionId: input.taskId };
  }

  private owned(input: ControlInput): DeviceExecutionSessionRecord | null {
    if (!TASK_ID.test(input.taskId)) return null;
    return this.deps.sessions.getOwned(input.taskId, input.tenantId, input.ownerId);
  }

  private requireOwned(input: ControlInput): DeviceExecutionSessionRecord {
    const session = this.owned(input);
    if (!session) throw new NagexError({ code: 'BROWSER_TASK_NOT_FOUND', category: 'NOT_FOUND', message: 'Task not found.', request_id: input.requestId });
    return session;
  }

  /** the run goes on after the request that started it has been answered; a crash in it ends the task as FAILED (the loop records it), never silently */
  private launch(taskId: string, run: () => Promise<DeviceControlOutcome>): void {
    const promise = run()
      .catch((error) => {
        console.error(JSON.stringify({ event: 'nagex_browser_task_run_failed', taskId, message: error instanceof Error ? error.message.slice(0, 200) : 'unknown' }));
      })
      .finally(() => { this.inFlight.delete(taskId); });
    this.inFlight.set(taskId, promise);
  }

  private stepView(step: DeviceStepLogEntry): BrowserTaskStepView {
    const problem = problemOf(step.outcome);
    return {
      n: step.n,
      at: step.at,
      action: step.action,
      ...(step.description ? { label: step.description } : {}),
      ...(step.detail ? { detail: step.detail } : {}),
      verification: step.verification,
      ...(problem ? { problem } : {}),
    };
  }

  private view(session: DeviceExecutionSessionRecord): BrowserTaskView {
    const state = STATE_BY_STATUS[session.status];
    const log = session.steps ?? [];
    const steps = log.slice(-MAX_VISIBLE_STEPS).map((s) => this.stepView(s));
    const result = session.result && typeof session.result === 'object' ? session.result as Record<string, any> : null;
    const completion = result?.completion as Record<string, any> | undefined;
    const approval = state === 'WAITING_APPROVAL' && session.approvalId ? this.approvalView(session) : null;
    const reason = session.terminationReason ?? '';
    return {
      taskId: session.deviceExecutionSessionId,
      state,
      goal: session.goal,
      allowedDomains: session.allowedDomains,
      startedAt: session.createdAt,
      updatedAt: session.updatedAt,
      stepCount: session.stepCount,
      maxSteps: session.maxSteps,
      now: steps.length > 0 ? steps[steps.length - 1] : null,
      steps,
      approval,
      result: state === 'COMPLETED' && result
        ? {
            reportedByAgent: String(result.reason ?? '').slice(0, 400),
            finalPage: plainPage(String(result.finalUrl ?? '')),
            verification: String(completion?.outcome ?? 'NOT_VERIFIED'),
            actionsVerified: Number(completion?.verifiedActions ?? 0),
            expectationsMet: Number(completion?.expectationsMet ?? 0),
            expectationsNotMet: Number(completion?.expectationsNotMet ?? 0),
          }
        : null,
      needsPerson: state === 'NEEDS_PERSON'
        ? { reason: /HUMAN_VERIFICATION/.test(reason) ? 'SIGN_IN_OR_VERIFICATION' : 'AGENT_REPORTED', detail: reason.replace(/^AGENT_BLOCKED:/, '').slice(0, 200) }
        : null,
      failure: state === 'FAILED' || state === 'CANCELLED' ? { code: reason.split(':')[0] || 'UNKNOWN' } : null,
      pausedBecause: state === 'PAUSED' && session.pauseReason === 'DEVICE_MODEL_UNAVAILABLE' ? 'MODEL_UNAVAILABLE' : null,
      controls: {
        canPause: state === 'RUNNING',
        canContinue: state === 'PAUSED',
        canCancel: state === 'RUNNING' || state === 'WAITING_APPROVAL' || state === 'PAUSED',
        canApprove: state === 'WAITING_APPROVAL',
      },
      hasScreenshot: Boolean(session.lastObservationRef),
    };
  }

  private approvalView(session: DeviceExecutionSessionRecord): BrowserTaskView['approval'] {
    const record = this.deps.browser.getApproval(session.approvalId!, session.tenantId, session.ownerPrincipalId);
    const payload = (record?.canonicalPayload ?? {}) as Record<string, unknown>;
    return {
      approvalId: session.approvalId!,
      what: String(payload.accessibleName ?? payload.targetText ?? session.pendingAction?.target?.description ?? '').slice(0, 160),
      where: plainPage(String(payload.url ?? '')),
      expiresAt: record?.expiresAt ?? null,
    };
  }
}

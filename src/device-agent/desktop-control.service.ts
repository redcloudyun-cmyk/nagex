// DC3-B2 Production — DesktopControlService.
//
// The single orchestration point for device.desktop.execute, mirroring
// DeviceControlService's (DC1, browser visual-execution) own shape:
// startSession() handles a fresh request (proposes approval for a
// mutation, or executes immediately for OBSERVE); resumeSession()
// executes exactly the frozen action after approval, never re-proposing.
//
// This service, not the native worker, is the ONLY authorization point:
// tenant/owner/device/session ownership, the app allowlist, and approval
// are all resolved here before a single byte reaches the native
// controller. The native worker (see native/windows-desktop-controller/)
// independently validates its own bounded execution envelope (protocol
// version, session token, nonce, schema, target-belongs-to-execution) but
// never becomes a second policy engine — it has no concept of tenants,
// owners, or approval.
//
// Reused, unchanged: ActionApprovalStore (propose/freeze/approve/consume
// exactly once), AuditLogger, ActivityStore (via DesktopActivityAdapter),
// DesktopExecutionSessionStore (DC3-A).
import { NagexError } from '../common/errors.js';
import type { ActionApprovalRecord, ActionApprovalStore } from '../governance/action-approval.store.js';
import type { AuditLogger } from '../governance/audit.logger.js';
import { DesktopAppAllowlist } from './desktop-app-allowlist.js';
import { DesktopActivityAdapter } from './desktop-activity-adapter.js';
import { DesktopExecutionSessionStore, type DesktopExecutionSessionRecord } from './desktop-execution-session.store.js';
import { WindowsIsolatedDesktopController, type DesktopWorkerResult } from './windows-isolated-desktop-controller.js';
import type { ActionKind } from './desktop-automation-activity-summary.js';

export type DesktopActionType = 'OBSERVE' | 'OPEN_APP' | 'CLOSE_APP' | 'SET_VALUE' | 'INVOKE' | 'TOGGLE' | 'SELECT' | 'SCROLL';

const MUTATION_ACTIONS: ReadonlySet<DesktopActionType> = new Set(['OPEN_APP', 'CLOSE_APP', 'SET_VALUE', 'INVOKE', 'TOGGLE', 'SELECT', 'SCROLL']);
const TOOL_ID = 'device.desktop.execute';
const SESSION_TTL_MS = 15 * 60 * 1000;

export interface StartDesktopSessionInput {
  tenantId: string;
  ownerId: string;
  deviceId: string;
  requestId: string;
  executionSessionId?: string;
  appId: string;
  action: DesktopActionType;
  target?: string;
  parameters?: { value?: string };
}

export interface ResumeDesktopSessionInput {
  tenantId: string;
  ownerId: string;
  requestId: string;
  // Optional: a first-ever mutation on a brand-new execution has no
  // existing session at propose-time either (the frozen approval payload
  // carries executionSessionId: null in that case) — this must be
  // undefined here too, not an empty-string placeholder, or the approval
  // payload hash will not match what was frozen and consume() will
  // correctly reject it as a payload mismatch.
  executionSessionId?: string;
  // Required only when executionSessionId is absent (a first-ever
  // mutation, resuming into a session that does not exist yet) — must
  // equal whatever was frozen into the approval payload at propose time.
  deviceId?: string;
  approvalId: string;
  appId: string;
  action: DesktopActionType;
  target?: string;
  parameters?: { value?: string };
}

export type DesktopControlOutcome =
  | { kind: 'COMPLETED'; executionSessionId: string; result: DesktopWorkerResult }
  | { kind: 'WAITING_APPROVAL'; executionSessionId: string; approval: ActionApprovalRecord }
  | { kind: 'TERMINATED'; executionSessionId: string; status: 'FAILED' | 'CANCELLED' | 'BACKGROUND_UNSUPPORTED' | 'APP_NOT_ALLOWED'; terminationReason: string };

const ACTION_TO_ACTIVITY_KIND: Partial<Record<DesktopActionType, ActionKind>> = {
  SET_VALUE: 'SET_VALUE',
  INVOKE: 'INVOKE',
  TOGGLE: 'TOGGLE',
  SELECT: 'SELECT',
  SCROLL: 'SCROLL',
};

export class DesktopControlService {
  constructor(
    private readonly sessions: DesktopExecutionSessionStore,
    private readonly controller: WindowsIsolatedDesktopController,
    private readonly allowlist: DesktopAppAllowlist,
    private readonly approvals: ActionApprovalStore,
    private readonly auditLogger: AuditLogger,
    private readonly activity: DesktopActivityAdapter
  ) {}

  // Truthful LIVE gate for the Capability Broker: only true when every
  // real precondition holds, never merely "code exists."
  public isReady(): boolean {
    return this.controller.isAvailable();
  }

  public async startSession(input: StartDesktopSessionInput): Promise<DesktopControlOutcome> {
    const resolution = this.allowlist.resolve(input.appId);
    if (resolution.status === 'APP_NOT_ALLOWED') {
      this.auditLogger.logEvent({
        actor: { type: 'user', id: input.ownerId },
        tenant_id: input.tenantId,
        action: 'desktop.execute.blocked',
        resource: { type: 'DesktopApp', id: input.appId },
        result: 'DENIED',
        reason_code: 'APP_NOT_ALLOWED',
        request_id: input.requestId,
      });
      return { kind: 'TERMINATED', executionSessionId: input.executionSessionId ?? '', status: 'APP_NOT_ALLOWED', terminationReason: 'APP_NOT_ALLOWED' };
    }

    if (!this.controller.isAvailable()) {
      return { kind: 'TERMINATED', executionSessionId: input.executionSessionId ?? '', status: 'BACKGROUND_UNSUPPORTED', terminationReason: 'BACKGROUND_UNSUPPORTED' };
    }

    const isMutation = MUTATION_ACTIONS.has(input.action);
    if (isMutation) {
      const approval = this.approvals.request({
        toolId: TOOL_ID,
        tenantId: input.tenantId,
        principalId: input.ownerId,
        payload: { appId: input.appId, action: input.action, target: input.target ?? null, parameters: input.parameters ?? null, executionSessionId: input.executionSessionId ?? null, deviceId: input.deviceId },
      });
      this.activity.record({
        tenantId: input.tenantId,
        principalId: input.ownerId,
        executionSessionId: input.executionSessionId ?? approval.approvalId,
        phase: 'WAITING_FOR_APPROVAL',
        appLabel: input.appId,
        approvalId: approval.approvalId,
      });
      return { kind: 'WAITING_APPROVAL', executionSessionId: input.executionSessionId ?? '', approval };
    }

    // OBSERVE — no approval needed, executes immediately.
    return this.execute(input.tenantId, input.ownerId, input.deviceId, input.requestId, input.executionSessionId, resolution.executablePath, input.appId, input.action, input.target, input.parameters);
  }

  public async resumeSession(input: ResumeDesktopSessionInput): Promise<DesktopControlOutcome> {
    const resolution = this.allowlist.resolve(input.appId);
    if (resolution.status === 'APP_NOT_ALLOWED') {
      return { kind: 'TERMINATED', executionSessionId: input.executionSessionId ?? '', status: 'APP_NOT_ALLOWED', terminationReason: 'APP_NOT_ALLOWED' };
    }

    const payload = { appId: input.appId, action: input.action, target: input.target ?? null, parameters: input.parameters ?? null, executionSessionId: input.executionSessionId ?? null, deviceId: input.deviceId };
    try {
      this.approvals.consume(input.approvalId, input.tenantId, input.ownerId, TOOL_ID, payload, input.requestId, input.requestId);
    } catch (err) {
      const reason = err instanceof NagexError ? err.code : 'APPROVAL_CONSUME_FAILED';
      return { kind: 'TERMINATED', executionSessionId: input.executionSessionId ?? '', status: 'FAILED', terminationReason: reason };
    }

    return this.execute(input.tenantId, input.ownerId, input.deviceId, input.requestId, input.executionSessionId, resolution.executablePath, input.appId, input.action, input.target, input.parameters);
  }

  public async cancel(tenantId: string, ownerId: string, executionSessionId: string): Promise<void> {
    const session = this.sessions.getOwned(executionSessionId, tenantId, ownerId);
    if (!session) return;
    if (this.controller.hasSession(executionSessionId)) {
      await this.controller.cancel(executionSessionId);
    }
    this.activity.record({ tenantId, principalId: ownerId, executionSessionId, phase: 'CANCELLED', appLabel: '' });
  }

  public async closeSession(tenantId: string, ownerId: string, executionSessionId: string): Promise<void> {
    const session = this.sessions.getOwned(executionSessionId, tenantId, ownerId);
    if (!session) return;
    if (this.controller.hasSession(executionSessionId)) {
      await this.controller.closeApp(executionSessionId).catch(() => undefined);
      await this.controller.shutdown(executionSessionId).catch(() => undefined);
    }
    this.sessions.close(executionSessionId, tenantId, ownerId);
  }

  private async execute(
    tenantId: string,
    ownerId: string,
    deviceId: string | undefined,
    requestId: string,
    executionSessionId: string | undefined,
    executablePath: string,
    appId: string,
    action: DesktopActionType,
    target?: string,
    parameters?: { value?: string }
  ): Promise<DesktopControlOutcome> {
    let session: DesktopExecutionSessionRecord;
    let isNewSession = false;
    if (executionSessionId) {
      const existing = this.sessions.getOwned(executionSessionId, tenantId, ownerId);
      if (!existing) {
        return { kind: 'TERMINATED', executionSessionId: executionSessionId ?? '', status: 'FAILED', terminationReason: 'DESKTOP_INVALID_SESSION' };
      }
      session = existing;
    } else {
      if (!deviceId) {
        return { kind: 'TERMINATED', executionSessionId: '', status: 'FAILED', terminationReason: 'DEVICE_ID_REQUIRED' };
      }
      session = this.sessions.create({ deviceId, tenantId, ownerId, mode: 'BACKGROUND', expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString() });
      isNewSession = true;
    }

    if (!this.controller.hasSession(session.executionSessionId)) {
      const initResult = await this.controller.init(session.executionSessionId).catch((err: Error): DesktopWorkerResult => ({
        requestId: null, status: 'ERR', observedBefore: null, observedAfter: null, verification: false, errorCode: err.message, matchCount: -1,
      }));
      if (initResult.status === 'ERR') {
        return { kind: 'TERMINATED', executionSessionId: session.executionSessionId, status: 'BACKGROUND_UNSUPPORTED', terminationReason: initResult.errorCode ?? 'INIT_FAILED' };
      }
      if (isNewSession) {
        this.activity.record({ tenantId, principalId: ownerId, executionSessionId: session.executionSessionId, phase: 'STARTED', appLabel: appId });
      }
    }

    const activityKind = ACTION_TO_ACTIVITY_KIND[action];
    if (activityKind) {
      this.activity.record({ tenantId, principalId: ownerId, executionSessionId: session.executionSessionId, phase: 'ACTION', appLabel: appId, action: activityKind });
    }

    let result: DesktopWorkerResult;
    switch (action) {
      case 'OPEN_APP':
        result = await this.controller.openApp(session.executionSessionId, executablePath, '');
        break;
      case 'CLOSE_APP':
        result = await this.controller.closeApp(session.executionSessionId);
        // Alpha scope is one target app per isolated execution session —
        // closing the app is the natural end of this session's isolated
        // desktop/worker/Job Object lifecycle too. Torn down only after a
        // graceful CLOSE_APP result, never on failure (a failed close
        // must not silently destroy state the caller might still need to
        // diagnose or retry against).
        if (result.status === 'OK') {
          await this.controller.shutdown(session.executionSessionId).catch(() => undefined);
        }
        break;
      case 'OBSERVE':
        result = await this.controller.observe(session.executionSessionId, target ?? '');
        break;
      default:
        result = await this.controller.mutate(session.executionSessionId, action, target ?? '', parameters?.value);
        break;
    }

    this.auditLogger.logEvent({
      actor: { type: 'user', id: ownerId },
      tenant_id: tenantId,
      action: 'desktop.execute.dispatched',
      resource: { type: 'DesktopExecutionSession', id: session.executionSessionId },
      result: result.status === 'SUCCEEDED_VERIFIED' || result.status === 'OK' ? 'SUCCESS' : 'FAILED',
      request_id: requestId,
      details: { appId, action, status: result.status, matchCount: result.matchCount },
    });

    if (result.status === 'SUCCEEDED_VERIFIED' || result.status === 'OK') {
      if (activityKind) {
        this.activity.record({
          tenantId, principalId: ownerId, executionSessionId: session.executionSessionId, phase: 'SUCCEEDED', appLabel: appId,
          action: activityKind, before: result.observedBefore, after: result.observedAfter, verified: result.verification,
        });
      }
      return { kind: 'COMPLETED', executionSessionId: session.executionSessionId, result };
    }

    if (activityKind) {
      this.activity.record({
        tenantId, principalId: ownerId, executionSessionId: session.executionSessionId, phase: 'FAILED', appLabel: appId,
        action: activityKind, before: result.observedBefore, after: result.observedAfter, verified: false,
      });
    }
    const terminationStatus = result.status === 'CANCELLED' ? 'CANCELLED' : 'FAILED';
    return { kind: 'TERMINATED', executionSessionId: session.executionSessionId, status: terminationStatus, terminationReason: result.status };
  }
}

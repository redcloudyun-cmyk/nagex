// DC1-1 — DeviceExecutionSession schema/store.
//
// The bounded, tenant/owner-scoped record of one visual-execution run
// (Preflight Section G / this directive's Section 4). Ownership is
// centralized from the very first line of this file — the exact lesson
// DC0 existed to teach: BrowserSessionStore originally had no
// getOwned()-equivalent, and it was a real, live gap. This store never
// ships that gap in the first place.
//
// Persists ONLY what Section 4/21 allow: a reference to the last
// screenshot (an evidenceId already durable via BrowserToolService's own
// evidence store — see device-control.service.ts), never raw bytes, and
// never any secret (password/OTP/token/cookie) value.
import { generateResourceId, getCurrentISOString } from '../common/utils.js';
import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';
import type { CapabilityRisk } from '../capabilities/capability.types.js';
import { isProposedDeviceAction, type ProposedDeviceAction } from './device-action.types.js';

export type DeviceExecutionSessionStatus =
  | 'RUNNING'
  | 'WAITING_APPROVAL'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'BLOCKED_NEEDS_HUMAN';

export interface DeviceExecutionSessionRecord {
  deviceExecutionSessionId: string;
  tenantId: string;
  ownerPrincipalId: string;
  taskId: string | null;
  taskRunId: string | null;
  browserSessionId: string;
  goal: string;
  allowedActions: string[];
  allowedDomains: string[];
  maxSteps: number;
  maxDurationMs: number;
  riskCeiling: CapabilityRisk;
  status: DeviceExecutionSessionStatus;
  stepCount: number;
  pendingAction: ProposedDeviceAction | null;
  approvalId: string | null;
  lastObservationRef: string | null;
  result: unknown;
  terminationReason: string | null;
  createdAt: string;
  updatedAt: string;
}

const VALID_STATUSES: ReadonlySet<string> = new Set<DeviceExecutionSessionStatus>([
  'RUNNING', 'WAITING_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED_NEEDS_HUMAN',
]);

export function isDeviceExecutionSessionRecord(value: unknown): value is DeviceExecutionSessionRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.deviceExecutionSessionId === 'string' &&
    typeof v.tenantId === 'string' &&
    typeof v.ownerPrincipalId === 'string' &&
    typeof v.browserSessionId === 'string' &&
    typeof v.goal === 'string' &&
    Array.isArray(v.allowedActions) &&
    Array.isArray(v.allowedDomains) &&
    typeof v.maxSteps === 'number' &&
    typeof v.maxDurationMs === 'number' &&
    typeof v.status === 'string' && VALID_STATUSES.has(v.status) &&
    typeof v.stepCount === 'number' &&
    typeof v.createdAt === 'string' &&
    typeof v.updatedAt === 'string' &&
    (v.pendingAction === null || v.pendingAction === undefined || isProposedDeviceAction(v.pendingAction))
  );
}

export interface CreateDeviceExecutionSessionInput {
  tenantId: string;
  ownerPrincipalId: string;
  taskId?: string | null;
  taskRunId?: string | null;
  browserSessionId: string;
  goal: string;
  allowedActions: string[];
  allowedDomains: string[];
  maxSteps: number;
  maxDurationMs: number;
  riskCeiling: CapabilityRisk;
}

export interface DeviceExecutionSessionStoreOptions {
  dir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
}

export class DeviceExecutionSessionStore {
  private readonly fileStore: FileRecordStore<DeviceExecutionSessionRecord>;
  private readonly now: () => string;

  constructor(options: DeviceExecutionSessionStoreOptions = {}) {
    const env = options.env ?? process.env;
    const dir = options.dir ?? resolveNagexDataDir('device-execution-sessions', 'NAGEX_DEVICE_SESSIONS_DIR', env);
    this.fileStore = new FileRecordStore<DeviceExecutionSessionRecord>(dir, isDeviceExecutionSessionRecord);
    this.now = options.now ?? (() => getCurrentISOString());
  }

  public create(input: CreateDeviceExecutionSessionInput): DeviceExecutionSessionRecord {
    const timestamp = this.now();
    const record: DeviceExecutionSessionRecord = {
      deviceExecutionSessionId: generateResourceId('des'),
      tenantId: input.tenantId,
      ownerPrincipalId: input.ownerPrincipalId,
      taskId: input.taskId ?? null,
      taskRunId: input.taskRunId ?? null,
      browserSessionId: input.browserSessionId,
      goal: input.goal,
      allowedActions: [...input.allowedActions],
      allowedDomains: [...input.allowedDomains],
      maxSteps: input.maxSteps,
      maxDurationMs: input.maxDurationMs,
      riskCeiling: input.riskCeiling,
      status: 'RUNNING',
      stepCount: 0,
      pendingAction: null,
      approvalId: null,
      lastObservationRef: null,
      result: null,
      terminationReason: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.fileStore.writeOrThrow(record.deviceExecutionSessionId, record);
    return record;
  }

  private readRaw(deviceExecutionSessionId: string): DeviceExecutionSessionRecord | null {
    return this.fileStore.read(deviceExecutionSessionId);
  }

  // DC0's own lesson, applied from the start: a tenant/owner mismatch
  // returns null, externally indistinguishable from a genuinely
  // nonexistent session id — no DEVICE_SESSION_NOT_FOUND-vs-FORBIDDEN
  // distinction to leak through.
  public getOwned(deviceExecutionSessionId: string, tenantId: string, ownerPrincipalId: string): DeviceExecutionSessionRecord | null {
    const record = this.readRaw(deviceExecutionSessionId);
    if (!record || record.tenantId !== tenantId || record.ownerPrincipalId !== ownerPrincipalId) return null;
    return record;
  }

  private persist(record: DeviceExecutionSessionRecord): DeviceExecutionSessionRecord {
    record.updatedAt = this.now();
    this.fileStore.writeOrThrow(record.deviceExecutionSessionId, record);
    return record;
  }

  // Records one executed step's bookkeeping — called after a step actually
  // ran (never before), so a crash mid-step never shows a stepCount that
  // overstates what really executed.
  public recordStep(deviceExecutionSessionId: string, tenantId: string, ownerPrincipalId: string, patch: { stepCount: number; lastObservationRef: string | null }): DeviceExecutionSessionRecord | null {
    const record = this.getOwned(deviceExecutionSessionId, tenantId, ownerPrincipalId);
    if (!record) return null;
    record.stepCount = patch.stepCount;
    record.lastObservationRef = patch.lastObservationRef;
    return this.persist(record);
  }

  // The pending action is frozen here, together with the approvalId that
  // gates it — resume must execute exactly this action under exactly this
  // approval, never re-propose (Section 11).
  public waitForApproval(deviceExecutionSessionId: string, tenantId: string, ownerPrincipalId: string, pendingAction: ProposedDeviceAction, approvalId: string): DeviceExecutionSessionRecord | null {
    const record = this.getOwned(deviceExecutionSessionId, tenantId, ownerPrincipalId);
    if (!record) return null;
    record.status = 'WAITING_APPROVAL';
    record.pendingAction = pendingAction;
    record.approvalId = approvalId;
    return this.persist(record);
  }

  // Clears the frozen pending action/approvalId once it has actually been
  // executed (post-consume) and returns the session to RUNNING so the
  // bounded loop can continue from exactly where it paused.
  public resumeRunning(deviceExecutionSessionId: string, tenantId: string, ownerPrincipalId: string): DeviceExecutionSessionRecord | null {
    const record = this.getOwned(deviceExecutionSessionId, tenantId, ownerPrincipalId);
    if (!record) return null;
    record.status = 'RUNNING';
    record.pendingAction = null;
    record.approvalId = null;
    return this.persist(record);
  }

  public complete(deviceExecutionSessionId: string, tenantId: string, ownerPrincipalId: string, result: unknown): DeviceExecutionSessionRecord | null {
    const record = this.getOwned(deviceExecutionSessionId, tenantId, ownerPrincipalId);
    if (!record) return null;
    record.status = 'COMPLETED';
    record.result = result;
    return this.persist(record);
  }

  public fail(deviceExecutionSessionId: string, tenantId: string, ownerPrincipalId: string, terminationReason: string): DeviceExecutionSessionRecord | null {
    const record = this.getOwned(deviceExecutionSessionId, tenantId, ownerPrincipalId);
    if (!record) return null;
    record.status = 'FAILED';
    record.terminationReason = terminationReason;
    return this.persist(record);
  }

  public blockNeedsHuman(deviceExecutionSessionId: string, tenantId: string, ownerPrincipalId: string, terminationReason: string): DeviceExecutionSessionRecord | null {
    const record = this.getOwned(deviceExecutionSessionId, tenantId, ownerPrincipalId);
    if (!record) return null;
    record.status = 'BLOCKED_NEEDS_HUMAN';
    record.terminationReason = terminationReason;
    return this.persist(record);
  }
}

// The persistent HISTORY of the routes tried for one goal: which route, what happened (by normalized failure class), what the planner decided and who ranked the alternatives, which terms changed and
// which approval covered the switch. It is how a person - and the audit trail - can see why a goal moved from one provider to another; it survives a restart; it is owner-scoped like everything else.
//
// It holds no content of the goal (no prompt, no files): ids, classes, short NAgex-written reasons and timestamps.
import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';
import type { FailureClass } from './failure-taxonomy.js';
import type { CapabilityKind } from './route-candidate.js';
import type { TermChangeKind } from './route-terms.js';

export type AttemptOutcome = 'SUCCEEDED' | 'FAILED' | 'AWAITING_APPROVAL' | 'APPROVED' | 'DECLINED' | 'RETRYING' | 'SKIPPED';
export type DecisionAction = 'FIRST_ROUTE' | 'RETRY_SAME_ROUTE' | 'SWITCH_ROUTE' | 'ASK_PERSON' | 'RECONCILE_FIRST' | 'ABORT' | 'COMPLETE';

export interface RouteAttempt {
  n: number;
  at: string;
  routeId: string;
  provider: string;
  model: string | null;
  outcome: AttemptOutcome;
  failureClass: FailureClass | null;
  code: string | null;
  /** what the planner decided about what comes next, and how the alternatives were ordered */
  decision: { action: DecisionAction; rankedBy: 'DETERMINISTIC' | 'ADVISOR' | 'DETERMINISTIC_FALLBACK' | null; advisor: string | null; reason: string } | null;
  materialChanges: TermChangeKind[];
  approvalId: string | null;
  latencyMs: number | null;
}

export interface RouteHistory {
  goalId: string;
  tenantId: string;
  ownerId: string;
  capability: CapabilityKind;
  status: 'ACTIVE' | 'COMPLETED' | 'ABANDONED' | 'EXHAUSTED';
  createdAt: string;
  updatedAt: string;
  attempts: RouteAttempt[];
  /** the person's own reconciliation of an outcome that was not known, if one was given */
  reconciliation: { outcome: 'CONFIRMED_NOT_STARTED' | 'CONFIRMED_STARTED'; at: string } | null;
}

const MAX_ATTEMPTS_KEPT = 60;

function isHistory(value: unknown): value is RouteHistory {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.goalId === 'string' && typeof v.tenantId === 'string' && typeof v.ownerId === 'string' && Array.isArray(v.attempts);
}

export class RouteHistoryStore {
  private readonly store: FileRecordStore<RouteHistory>;
  public readonly baseDir: string;

  constructor(options: { dir?: string } = {}) {
    this.baseDir = options.dir ?? resolveNagexDataDir('adaptive', 'NAGEX_ADAPTIVE_DIR') + '/history';
    this.store = new FileRecordStore<RouteHistory>(this.baseDir, isHistory);
  }

  /** someone else's history is as absent as one that never existed */
  public get(goalId: string, tenantId: string, ownerId: string): RouteHistory | null {
    const record = this.store.read(goalId);
    return record && record.tenantId === tenantId && record.ownerId === ownerId ? record : null;
  }

  public ensure(goalId: string, tenantId: string, ownerId: string, capability: CapabilityKind, now: string): RouteHistory {
    const existing = this.get(goalId, tenantId, ownerId);
    if (existing) return existing;
    const created: RouteHistory = { goalId, tenantId, ownerId, capability, status: 'ACTIVE', createdAt: now, updatedAt: now, attempts: [], reconciliation: null };
    this.store.writeOrThrow(goalId, created);
    return created;
  }

  public append(history: RouteHistory, attempt: Omit<RouteAttempt, 'n'>): RouteHistory {
    history.attempts.push({ ...attempt, n: (history.attempts[history.attempts.length - 1]?.n ?? 0) + 1 });
    if (history.attempts.length > MAX_ATTEMPTS_KEPT) history.attempts.splice(0, history.attempts.length - MAX_ATTEMPTS_KEPT);
    history.updatedAt = attempt.at;
    this.store.writeOrThrow(history.goalId, history);
    return history;
  }

  /** change the LAST attempt (e.g. AWAITING_APPROVAL -> APPROVED) and persist */
  public amendLast(history: RouteHistory, patch: Partial<Omit<RouteAttempt, 'n'>>, at: string): RouteHistory {
    const last = history.attempts[history.attempts.length - 1];
    if (last) Object.assign(last, patch);
    history.updatedAt = at;
    this.store.writeOrThrow(history.goalId, history);
    return history;
  }

  public save(history: RouteHistory, at: string): RouteHistory {
    history.updatedAt = at;
    this.store.writeOrThrow(history.goalId, history);
    return history;
  }
}

import type { ResourceMetadata, TenantContext } from '../common/types.js';
import { generateResourceId, getCurrentISOString } from '../common/utils.js';
import { AgexError } from '../common/errors.js';

export type ExecutionState =
  | 'CREATED'
  | 'VALIDATING'
  | 'QUEUED'
  | 'RUNNING'
  | 'WAITING'
  | 'RETRYING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'TIMED_OUT'
  | 'TERMINATED';

// specs/schemas/runtime/execution.schema.json status.waiting_reason
export type ExecutionWaitingReason =
  | 'APPROVAL'
  | 'USER_INPUT'
  | 'EVENT'
  | 'TIME'
  | 'CHILD_EXECUTION'
  | 'DEPENDENCY';

export interface ExecutionRecord {
  id: string;
  tenant_id: string;
  target_resource_id: string;
  state: ExecutionState;
  attempt: number;
  created_at: string;
  updated_at: string;
  checkpoint_id?: string | null;
  result?: unknown;
  waiting_reason?: ExecutionWaitingReason | null;
}

const TERMINAL_STATES: ReadonlySet<ExecutionState> = new Set([
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
  'TERMINATED',
]);

// Rule 16: Retry must be bounded. Once exhausted the execution is marked
// FAILED instead of being restored again.
const MAX_RESTORE_ATTEMPTS = 5;

export class DurableRuntimeEngine {
  private executionStore: Map<string, ExecutionRecord> = new Map();

  public createExecution(tenantContext: TenantContext, targetResourceId: string): ExecutionRecord {
    const id = generateResourceId('exe');
    const now = getCurrentISOString();

    const record: ExecutionRecord = {
      id,
      tenant_id: tenantContext.tenant_id,
      target_resource_id: targetResourceId,
      state: 'CREATED',
      attempt: 1,
      created_at: now,
      updated_at: now,
    };

    this.executionStore.set(id, record);
    return record;
  }

  /**
   * @param expectedTenantId When provided, the execution's owning tenant must
   * match or the call is rejected (Rule 13: Cross-Tenant access is Default
   * Deny). Omit only for trusted internal system callers (e.g. the
   * Reconciler) that intentionally operate across tenants.
   * @param waitingReason Only meaningful when newState is 'WAITING' (per
   * execution.schema.json status.waiting_reason) — cleared automatically on
   * any other transition so it never lingers stale on a resumed execution.
   */
  public transitionState(
    id: string,
    newState: ExecutionState,
    result?: unknown,
    expectedTenantId?: string,
    waitingReason?: ExecutionWaitingReason | null
  ): ExecutionRecord {
    const record = this.getOwnedRecord(id, expectedTenantId);
    this.assertNotTerminal(record);

    record.state = newState;
    record.updated_at = getCurrentISOString();
    if (result !== undefined) {
      record.result = result;
    }
    record.waiting_reason = newState === 'WAITING' ? (waitingReason ?? null) : null;

    this.executionStore.set(id, record);
    return record;
  }

  /** @param expectedTenantId see {@link transitionState}. */
  public restoreCheckpoint(id: string, checkpointId: string, expectedTenantId?: string): ExecutionRecord {
    const record = this.getOwnedRecord(id, expectedTenantId);
    this.assertNotTerminal(record);

    if (record.attempt >= MAX_RESTORE_ATTEMPTS) {
      record.state = 'FAILED';
      record.updated_at = getCurrentISOString();
      this.executionStore.set(id, record);
      throw new AgexError({
        code: 'MAX_RETRY_ATTEMPTS_EXCEEDED',
        category: 'RUNTIME',
        message: `Execution ID ${id} exceeded the maximum of ${MAX_RESTORE_ATTEMPTS} restore attempts and has been marked FAILED.`,
        request_id: 'rt_req',
      });
    }

    record.checkpoint_id = checkpointId;
    record.state = 'RUNNING';
    record.attempt += 1;
    record.updated_at = getCurrentISOString();

    this.executionStore.set(id, record);
    return record;
  }

  private getOwnedRecord(id: string, expectedTenantId?: string): ExecutionRecord {
    const record = this.executionStore.get(id);
    if (!record) {
      throw new AgexError({
        code: 'EXECUTION_NOT_FOUND',
        category: 'NOT_FOUND',
        message: `Execution ID ${id} not found in Durable Store.`,
        request_id: 'rt_req',
      });
    }

    if (expectedTenantId && record.tenant_id !== expectedTenantId) {
      throw new AgexError({
        code: 'CROSS_TENANT_ACCESS_DENIED',
        category: 'AUTHORIZATION',
        message: `Execution ID ${id} does not belong to the requesting tenant.`,
        request_id: 'rt_req',
      });
    }

    return record;
  }

  private assertNotTerminal(record: ExecutionRecord): void {
    if (TERMINAL_STATES.has(record.state)) {
      throw new AgexError({
        code: 'EXECUTION_ALREADY_TERMINAL',
        category: 'CONFLICT',
        message: `Execution ID ${record.id} is already in terminal state ${record.state} and cannot be mutated further.`,
        request_id: 'rt_req',
      });
    }
  }
}

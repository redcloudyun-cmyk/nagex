import { generateResourceId, getCurrentISOString } from '../common/utils.js';
import { AgexError } from '../common/errors.js';
import type { TenantContext } from '../common/types.js';

export type TaskStatus = 'CREATED' | 'QUEUED' | 'LEASED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'RETRY_WAIT' | 'CANCELLED';

const TERMINAL_TASK_STATES: ReadonlySet<TaskStatus> = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);

export interface TaskRecord {
  id: string;
  tenant_id: string;
  execution_id: string;
  task_type: string;
  status: TaskStatus;
  lease_owner?: string | null;
  lease_expires_at?: string | null;
  heartbeat_at?: string | null;
  created_at: string;
  updated_at: string;
}

export class TaskDispatcher {
  private taskMap: Map<string, TaskRecord> = new Map();

  public createTask(tenantContext: TenantContext, executionId: string, taskType: string): TaskRecord {
    const taskId = generateResourceId('tsk');
    const now = getCurrentISOString();

    const task: TaskRecord = {
      id: taskId,
      tenant_id: tenantContext.tenant_id,
      execution_id: executionId,
      task_type: taskType,
      status: 'QUEUED',
      created_at: now,
      updated_at: now,
    };

    this.taskMap.set(taskId, task);
    return task;
  }

  /**
   * @param expectedTenantId When provided, the task's owning tenant must
   * match or the call is rejected (Rule 13: Cross-Tenant access is Default
   * Deny). Omit only for trusted internal system callers (e.g. the
   * Reconciler) that intentionally operate across tenants.
   */
  public acquireLease(
    taskId: string,
    workerId: string,
    leaseDurationMs: number = 30000,
    expectedTenantId?: string
  ): TaskRecord {
    const task = this.getOwnedTask(taskId, expectedTenantId);

    if (TERMINAL_TASK_STATES.has(task.status)) {
      throw new AgexError({
        code: 'TASK_ALREADY_TERMINAL',
        category: 'CONFLICT',
        message: `Task ID ${taskId} is already in terminal state ${task.status} and cannot be leased again.`,
        request_id: 'disp_req',
      });
    }

    if (task.status === 'LEASED' || task.status === 'RUNNING') {
      const nowMs = Date.now();
      const expiresMs = task.lease_expires_at ? new Date(task.lease_expires_at).getTime() : 0;
      if (expiresMs > nowMs && task.lease_owner !== workerId) {
        throw new AgexError({
          code: 'TASK_ALREADY_LEASED',
          category: 'CONFLICT',
          message: `Task ID ${taskId} is currently leased by worker ${task.lease_owner}.`,
          request_id: 'disp_req',
        });
      }
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + leaseDurationMs).toISOString();

    task.status = 'LEASED';
    task.lease_owner = workerId;
    task.lease_expires_at = expiresAt;
    task.heartbeat_at = now.toISOString();
    task.updated_at = now.toISOString();

    this.taskMap.set(taskId, task);
    return task;
  }

  /** @param expectedTenantId see {@link acquireLease}. */
  public updateHeartbeat(
    taskId: string,
    workerId: string,
    leaseExtensionMs: number = 30000,
    expectedTenantId?: string
  ): void {
    const task = this.getOwnedTask(taskId, expectedTenantId);
    if (task.lease_owner !== workerId) {
      throw new AgexError({
        code: 'INVALID_LEASE_OWNER',
        category: 'AUTHORIZATION',
        message: `Worker ${workerId} does not own task ${taskId}.`,
        request_id: 'disp_req',
      });
    }

    const now = new Date();
    task.heartbeat_at = now.toISOString();
    task.lease_expires_at = new Date(now.getTime() + leaseExtensionMs).toISOString();
    task.updated_at = now.toISOString();
    this.taskMap.set(taskId, task);
  }

  /** @param expectedTenantId see {@link acquireLease}. */
  public completeTask(taskId: string, workerId: string, expectedTenantId?: string): TaskRecord {
    const task = this.getOwnedTask(taskId, expectedTenantId);
    if (task.lease_owner !== workerId) {
      throw new AgexError({
        code: 'INVALID_LEASE_OWNER',
        category: 'AUTHORIZATION',
        message: `Worker ${workerId} cannot complete task ${taskId}.`,
        request_id: 'disp_req',
      });
    }

    task.status = 'SUCCEEDED';
    task.lease_owner = null;
    task.lease_expires_at = null;
    task.updated_at = getCurrentISOString();
    this.taskMap.set(taskId, task);
    return task;
  }

  private getOwnedTask(taskId: string, expectedTenantId?: string): TaskRecord {
    const task = this.taskMap.get(taskId);
    if (!task) {
      throw new AgexError({
        code: 'TASK_NOT_FOUND',
        category: 'NOT_FOUND',
        message: `Task ID ${taskId} not found.`,
        request_id: 'disp_req',
      });
    }

    if (expectedTenantId && task.tenant_id !== expectedTenantId) {
      throw new AgexError({
        code: 'CROSS_TENANT_ACCESS_DENIED',
        category: 'AUTHORIZATION',
        message: `Task ID ${taskId} does not belong to the requesting tenant.`,
        request_id: 'disp_req',
      });
    }

    return task;
  }

  public getExpiredLeases(): TaskRecord[] {
    const nowMs = Date.now();
    const expired: TaskRecord[] = [];

    for (const task of this.taskMap.values()) {
      if (task.status === 'LEASED' || task.status === 'RUNNING') {
        if (task.lease_expires_at) {
          const expiresMs = new Date(task.lease_expires_at).getTime();
          if (expiresMs <= nowMs) {
            expired.push(task);
          }
        }
      }
    }

    return expired;
  }
}

import type { TaskDispatcher, TaskRecord } from './task.dispatcher.js';
import type { DurableRuntimeEngine } from './runtime.engine.js';
import { AgexError } from '../common/errors.js';

export class RuntimeReconciler {
  private dispatcher: TaskDispatcher;
  private engine: DurableRuntimeEngine;

  constructor(dispatcher: TaskDispatcher, engine: DurableRuntimeEngine) {
    this.dispatcher = dispatcher;
    this.engine = engine;
  }

  public reconcileExpiredTasks(): TaskRecord[] {
    const expiredTasks = this.dispatcher.getExpiredLeases();
    const redispatched: TaskRecord[] = [];

    for (const task of expiredTasks) {
      // Restore Execution state and increment attempt (Rule 16: bounded retry —
      // the engine itself refuses once MAX_RESTORE_ATTEMPTS is exceeded).
      try {
        this.engine.restoreCheckpoint(task.execution_id, `chk_recovery_${Date.now()}`);
      } catch (err) {
        if (err instanceof AgexError && err.code === 'MAX_RETRY_ATTEMPTS_EXCEEDED') {
          task.status = 'FAILED';
          task.lease_owner = null;
          task.lease_expires_at = null;
          task.updated_at = new Date().toISOString();
          redispatched.push(task);
          continue;
        }
        throw err;
      }

      task.status = 'QUEUED';
      task.lease_owner = null;
      task.lease_expires_at = null;
      task.updated_at = new Date().toISOString();

      redispatched.push(task);
    }

    return redispatched;
  }
}

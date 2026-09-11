import { NagexError } from '../common/errors.js';
import type { AuditLogger } from '../governance/audit.logger.js';
import type { NotificationEngine } from '../notifications/notification.engine.js';
import { finalizeTaskRun, type TaskRunOutcome } from './task.scheduler.js';
import type { TaskStore } from './task.store.js';
import type { TaskRunStore } from './task-run.store.js';
import type { DurableTaskRunStateStore } from './durable-task-run-state.store.js';
import type { ExecutingTaskRunner } from './runners/executing-task.runner.js';

// P03 — Durable Multi-step Workflow Runtime: startup recovery.
//
// Runs exactly once, at process boot, before the task-scheduler interval
// starts ticking (see server_web.ts's LifecycleManager registration order).
// Scans DurableTaskRunStateStore for every run this process's *previous*
// life left genuinely mid-flight — status still RUNNING, meaning no
// terminal write (SUCCEEDED/FAILED) and no WAITING_APPROVAL transition ever
// landed for it — and resumes each exactly once, from the exact step it had
// not yet completed, through ExecutingTaskRunner's ordinary sequential step
// loop. A WAITING_APPROVAL run is deliberately never touched here: it
// already has its own event-triggered resume path (TaskContinuationCoordinator,
// unchanged from P02), and restarting the process does not change what it is
// waiting on.
//
// Crash-window / delivery-guarantee classification (honest, not
// overclaimed):
// - A read-only step (EXECUTABLE_CAPABILITY_IDS) has no side effect, so a
//   recovery re-dispatch is trivially safe regardless of exactly when the
//   crash landed — effectively-once by virtue of idempotence, not by any
//   special mechanism.
// - A write step's approval-*request* call (creating the ActionApprovalRecord,
//   never the write itself) reuses the same deterministic per-step requestId
//   a fresh attempt would use; CapabilityBroker's own idempotency cache
//   means a recovery re-dispatch after a crash between "the request call
//   returned" and "this store recorded it" returns the same cached result
//   rather than creating a second approval — effectively-once.
// - The actual approved *write* dispatch (resumeFromApproval, reached only
//   from TaskContinuationCoordinator.onApproved, never from this recovery
//   scan directly) has the same idempotency-cache protection IF the crash
//   landed after the broker call returned but before this store recorded
//   completion. If the crash landed *during* the dispatch itself — genuinely
//   unknown whether the provider (Gmail/Calendar) received and completed it
//   before the process died — a retry is an honest at-least-once attempt
//   with an ambiguous prior outcome. This is an inherent limit of any
//   recovery system reaching an external API without that API's own
//   idempotency keys; it is not fixed by this store and must not be
//   presented as fixed.
export class DurableTaskRuntime {
  constructor(
    private readonly durableRunState: DurableTaskRunStateStore,
    private readonly executingTaskRunner: ExecutingTaskRunner,
    private readonly tasks: TaskStore,
    private readonly runs: TaskRunStore,
    private readonly audit: AuditLogger,
    private readonly now: () => Date = () => new Date(),
    private readonly notificationEngine?: NotificationEngine,
  ) {}

  public async recoverOnStartup(): Promise<{ recovered: number; failed: number }> {
    const stuck = this.durableRunState.listRunning();
    let recovered = 0;
    let failed = 0;

    for (const record of stuck) {
      const task = this.tasks.get(record.taskId);
      if (!task) {
        // The task was deleted since this run started — nothing to resume
        // into; mark the durable record terminal so it never gets rescanned.
        this.durableRunState.markTerminal(record.runId, 'FAILED');
        failed++;
        continue;
      }

      let outcome: TaskRunOutcome;
      try {
        outcome = await this.executingTaskRunner.resumeRunningState(record, task);
      } catch (error) {
        const code = error instanceof NagexError ? error.code : 'TASK_RUN_RECOVERY_FAILED';
        outcome = { status: 'FAILED', errorCode: code };
      }

      finalizeTaskRun(
        { tasks: this.tasks, runs: this.runs, audit: this.audit, now: this.now, notificationEngine: this.notificationEngine },
        task,
        record.runId,
        record.runRequestId,
        outcome,
      );

      if (outcome.status === 'FAILED') failed++;
      else recovered++;
    }

    return { recovered, failed };
  }
}

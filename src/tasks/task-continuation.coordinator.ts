import { NagexError } from '../common/errors.js';
import type { AuditLogger } from '../governance/audit.logger.js';
import type { NotificationEngine } from '../notifications/notification.engine.js';
import type { TaskStore, TaskRecord } from './task.store.js';
import type { TaskRunStore } from './task-run.store.js';
import { finalizeTaskRun, type TaskRunOutcome } from './task.scheduler.js';
import type { TaskContinuationStore } from './task-continuation.store.js';
import type { ExecutingTaskRunner } from './runners/executing-task.runner.js';

// P02 — Approval-aware Task Continuation.
//
// Orchestrates resuming a paused (WAITING_APPROVAL) Task run once a human
// has granted or rejected its approval. Triggered from the existing
// approval grant/reject route (see server_web.ts) — deliberately
// event-driven: no poller, no new managed lifecycle resource. A no-op
// (never an error) whenever the given approvalId has no associated Task
// continuation — most approvals are not Task-originated at all.
//
// Known, disclosed limitation: an approval that simply expires (TTL
// lapses) with nothing ever attempting to resume it has no active trigger
// to notice and terminate its continuation/run — expiry is detected
// lazily, only if/when something does try to resume. Closing that fully
// would need either a poller (explicitly discouraged without real
// justification) or an event source that doesn't exist yet; real
// hardening for this narrow gap belongs in Track C, not P02.
export class TaskContinuationCoordinator {
  constructor(
    private readonly continuations: TaskContinuationStore,
    private readonly executingTaskRunner: ExecutingTaskRunner,
    private readonly tasks: TaskStore,
    private readonly runs: TaskRunStore,
    private readonly audit: AuditLogger,
    private readonly now: () => Date = () => new Date(),
    private readonly notificationEngine?: NotificationEngine,
  ) {}

  // Call after a real ActionApprovalStore.approve() succeeds. Executes the
  // exact frozen capability + payload with the real approvalId (never
  // re-derived, never re-planned) and continues any remaining steps.
  public async onApproved(approvalId: string): Promise<void> {
    const continuation = this.claim(approvalId);
    if (!continuation) return;
    const task = this.tasks.get(continuation.taskId);
    if (!task) return; // task deleted since it paused — nothing to resume into

    let outcome: TaskRunOutcome;
    try {
      outcome = await this.executingTaskRunner.resumeFromApproval(continuation, task);
    } catch (error) {
      const code = error instanceof NagexError ? error.code : 'STEP_EXECUTION_FAILED';
      outcome = { status: 'FAILED', errorCode: code };
    }

    this.finalize(task, continuation.runId, continuation.runRequestId, outcome);
  }

  // Call after a real ActionApprovalStore.reject() succeeds. Never
  // executes anything — the run simply terminates as failed, truthfully.
  public onRejected(approvalId: string): void {
    const continuation = this.claim(approvalId);
    if (!continuation) return;
    const task = this.tasks.get(continuation.taskId);
    if (!task) return;

    this.finalize(task, continuation.runId, continuation.runRequestId, { status: 'FAILED', errorCode: 'APPROVAL_REJECTED', result: { kind: 'STEP_EXECUTION', completedSteps: continuation.executedSoFar, haltedAtStep: continuation.resolvedSteps[continuation.stepIndex]?.step, reason: 'The required approval was rejected.' } });
  }

  // Marks the continuation RESUMED before doing anything async — no
  // intervening await between the check and the mark, so two concurrent
  // triggers for the same approvalId can never both proceed. The real
  // authoritative replay protection is still ActionApprovalStore.consume()
  // (exercised inside resumeFromApproval); this is defense in depth at
  // the Task-continuation layer specifically.
  private claim(approvalId: string) {
    const continuation = this.continuations.getByApprovalId(approvalId);
    if (!continuation || continuation.status !== 'WAITING') return undefined;
    this.continuations.markResumed(approvalId);
    return continuation;
  }

  private finalize(task: TaskRecord, runId: string, requestId: string, outcome: TaskRunOutcome): void {
    finalizeTaskRun(
      { tasks: this.tasks, runs: this.runs, audit: this.audit, now: this.now, notificationEngine: this.notificationEngine },
      task,
      runId,
      requestId,
      outcome,
    );
  }
}

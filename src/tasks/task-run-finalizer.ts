import { getCurrentISOString } from '../common/utils.js';
import type { AuditLogger } from '../governance/audit.logger.js';
import type { NotificationEngine } from '../notifications/notification.engine.js';
import type { TaskStore, TaskRecord } from './task.store.js';
import type { TaskRunStore } from './task-run.store.js';
import type { TaskRunRecord } from './task-run.store.js';
import { computeNextRunAt, type TaskRunOutcome } from './task.scheduler.js';

// Phase 09 — Task Runtime Subsystem Boundary & Ownership Consolidation.
//
// Extracted from task.scheduler.ts (P02 originally placed it there as the
// tail of TaskScheduler.runOne()). By P03, finalizeTaskRun() had grown a
// second real caller outside the scheduler (DurableTaskRuntime's own
// recovery path, alongside TaskContinuationCoordinator's resume path) —
// terminal finalization (TaskRunStore write, audit, notification dispatch,
// TaskStore.recordRunOutcome) is shared Task Runtime infrastructure, not
// something that naturally belongs to the scheduler's own "trigger due
// tasks" responsibility. TaskScheduler now only triggers; this module is
// the shared finalization authority every trigger path (fresh run, P02
// approval resume, P03 crash recovery) calls into identically. Purely a
// code-motion refactor — behavior is byte-for-byte unchanged from P02/P03.
export interface TaskRunFinalizationDeps {
  tasks: TaskStore;
  runs: TaskRunStore;
  audit: AuditLogger;
  now: () => Date;
  notificationEngine?: NotificationEngine;
}

export function finalizeTaskRun(deps: TaskRunFinalizationDeps, task: TaskRecord, runId: string, requestId: string, outcome: TaskRunOutcome): TaskRunRecord {
  const completedAt = getCurrentISOString();

  if (outcome.status === 'WAITING_APPROVAL') {
    deps.runs.waitForApproval(runId);
    deps.audit.logEvent({
      actor: { type: 'system', id: 'task-scheduler' },
      tenant_id: task.tenantId,
      action: 'execution.waiting_approval',
      resource: { type: 'TaskRun', id: runId },
      result: 'PENDING_APPROVAL',
      request_id: requestId,
    });
    // Non-terminal: never notify (a waiting task is not completed, not
    // failed, not a condition match), never reschedule by time — resume
    // is approval-event-triggered, not tick-driven.
    deps.tasks.recordRunOutcome(task.taskId, { status: 'WAITING_APPROVAL', completedAt, nextRunAt: null }, requestId);
    return deps.runs.get(runId) as TaskRunRecord;
  }

  if (outcome.status === 'SUCCEEDED') {
    deps.runs.succeed(runId, { result: outcome.result ?? null, completedAt });
    deps.audit.logEvent({
      actor: { type: 'system', id: 'task-scheduler' },
      tenant_id: task.tenantId,
      action: 'execution.succeeded',
      resource: { type: 'TaskRun', id: runId },
      result: 'SUCCESS',
      request_id: requestId,
    });

    if (deps.notificationEngine) {
      if (outcome.conditionMet) {
        deps.notificationEngine.dispatch({
          tenantId: task.tenantId,
          principalId: task.ownerId,
          type: 'CONDITION_MET',
          title: `Condition Met: ${task.name}`,
          body: `Watched condition for task "${task.name}" was fulfilled.`,
          metadata: { taskId: task.taskId, runId },
          requestId,
        }).catch(() => {});
      } else {
        deps.notificationEngine.dispatch({
          tenantId: task.tenantId,
          principalId: task.ownerId,
          type: 'TASK_COMPLETED',
          title: `Task Completed: ${task.name}`,
          body: `Task "${task.name}" completed successfully.`,
          metadata: { taskId: task.taskId, runId },
          requestId,
        }).catch(() => {});
      }
    }
  } else {
    deps.runs.fail(runId, { errorCode: outcome.errorCode ?? 'TASK_RUN_FAILED', completedAt });
    deps.audit.logEvent({
      actor: { type: 'system', id: 'task-scheduler' },
      tenant_id: task.tenantId,
      action: 'execution.failed',
      resource: { type: 'TaskRun', id: runId },
      result: 'FAILED',
      reason_code: outcome.errorCode ?? 'TASK_RUN_FAILED',
      request_id: requestId,
    });

    if (deps.notificationEngine) {
      deps.notificationEngine.dispatch({
        tenantId: task.tenantId,
        principalId: task.ownerId,
        type: 'TASK_FAILED',
        title: `Task Failed: ${task.name}`,
        body: `Task "${task.name}" failed: ${outcome.errorCode ?? 'Execution error'}`,
        metadata: { taskId: task.taskId, runId },
        requestId,
      }).catch(() => {});
    }
  }

  const nextRun = computeNextRunAt(task.trigger, deps.now());
  deps.tasks.recordRunOutcome(
    task.taskId,
    { status: outcome.status, completedAt, nextRunAt: nextRun ? nextRun.toISOString() : null, conditionMet: outcome.conditionMet },
    requestId,
  );

  return deps.runs.get(runId) as TaskRunRecord;
}

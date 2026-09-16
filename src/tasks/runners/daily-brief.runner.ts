import type { TaskRecord } from '../task.store.js';
import type { TaskRunner, TaskRunOutcome } from '../task.scheduler.js';
import { dailyBriefDateKey, type DailyBriefStore } from '../../governance/daily-brief.store.js';
import type { NotificationEngine } from '../../notifications/notification.engine.js';
import type { ActionApprovalStore } from '../../governance/action-approval.store.js';
import { generateDailyBriefOnce, type DailyBriefPipelineDeps } from '../../assistant/daily-brief.pipeline.js';
import { detectMeaningfulChanges, dispatchDetectedChanges } from '../../assistant/daily-brief-change-detection.js';
import { generateProposalsFromChanges } from '../../assistant/action-proposal-generator.js';
import type { ActionProposalStore } from '../../assistant/action-proposal.store.js';

// R10 — the scheduled/automatic Daily Brief execution path. Routed here by
// CompositeTaskRunner only for a RECURRING task with
// automationKind:'DAILY_BRIEF' (see composite.runner.ts). Calls the exact
// same generateDailyBriefOnce() the manual GET/POST /api/v1/daily-brief
// HTTP path uses (src/assistant/daily-brief.pipeline.ts) — there is no
// second brief generator (R10 §7), and the module-level in-flight guard
// inside that function is shared by both entry points, so a manual refresh
// racing a scheduled run for the same tenant+principal (R10 §17) share one
// real generation rather than firing two.
export class DailyBriefTaskRunner implements TaskRunner {
  constructor(
    private readonly deps: DailyBriefPipelineDeps,
    private readonly dailyBriefStore: DailyBriefStore,
    private readonly notificationEngine?: NotificationEngine,
    private readonly actionApprovals?: ActionApprovalStore,
    private readonly actionProposalStore?: ActionProposalStore,
  ) {}

  public async run(task: TaskRecord, requestId: string, runId: string): Promise<TaskRunOutcome> {
    // Read the day's previously-persisted brief BEFORE generating/saving a
    // new one — this is the real "last generation" baseline R10.1's change
    // detection compares against; a fresh day with no prior brief yet
    // correctly yields no baseline (see detectMeaningfulChanges).
    const previous = this.dailyBriefStore.getForDate(task.tenantId, task.ownerId, dailyBriefDateKey());

    // isSourceRefresh=true: an automated scheduled run is, from the Activity
    // log's point of view, exactly the same kind of real re-generation a
    // manual [Refresh Brief] click is — both real, both reflected the same
    // way (daily_brief.refreshed), never a fabricated distinct event just
    // to look different. source='SCHEDULED': this generation really was
    // triggered by the automation schedule, not a user click (§3 truthful
    // Home state).
    const generated = await generateDailyBriefOnce(this.deps, task.tenantId, task.ownerId, requestId, true, 'SCHEDULED');
    const isUsable = generated.status !== 'UNAVAILABLE';

    if (isUsable) {
      this.dailyBriefStore.save(generated);

      // R10.1 §1/§2 — meaningful Calendar/Gmail/approval/action-item
      // changes since the last real brief, using only data already fetched
      // for this generation (no extra Calendar/Gmail call), dispatched as
      // real, source-grounded, deduped IMPORTANT_CHANGE notifications.
      const newApprovalsSincePrevious = previous && this.actionApprovals
        ? this.actionApprovals.listPending(task.tenantId, task.ownerId, requestId)
            .filter((a) => a.createdAt > previous.generatedAt)
            .map((a) => ({ approvalId: a.approvalId, toolId: a.toolId, createdAt: a.createdAt }))
        : [];
      const changes = detectMeaningfulChanges({ previous, current: generated, newApprovalsSincePrevious });
      await dispatchDetectedChanges(this.notificationEngine, task.tenantId, task.ownerId, generated.date, changes, requestId);

      // R11 — grounded, reviewable proposals from the same real changes
      // (never a second notification per proposal — §8). Dedup via
      // findByDedupeKey so a re-generation of the same day never creates a
      // duplicate PROPOSED proposal for the same underlying change (§9).
      if (this.actionProposalStore) {
        for (const draft of generateProposalsFromChanges(changes, generated)) {
          const dedupeKey = this.actionProposalStore.buildDedupeKey(task.tenantId, task.ownerId, generated.date, draft.sourceType, draft.sourceId, draft.proposalType);
          if (!this.actionProposalStore.findByDedupeKey(task.tenantId, task.ownerId, dedupeKey)) {
            this.actionProposalStore.create({ ...draft, tenantId: task.tenantId, principalId: task.ownerId, date: generated.date });
          }
        }
      }

      // R10 §10 — DAILY_BRIEF_READY, dispatched only when the user
      // explicitly opted in (task.notifyOnComplete), and only for a real,
      // just-persisted brief — never for a merely-attempted one.
      if (task.notifyOnComplete !== false && this.notificationEngine) {
        this.notificationEngine.dispatch({
          tenantId: task.tenantId,
          principalId: task.ownerId,
          type: 'DAILY_BRIEF_READY',
          title: 'Your Daily Brief is ready',
          body: generated.summary || `Today's brief (${generated.status}) is ready to view.`,
          metadata: { taskId: task.taskId, runId, date: generated.date, status: generated.status },
          requestId,
          dedupeKey: `daily_brief_ready:${task.tenantId}:${task.ownerId}:${generated.date}`,
        }).catch((err) => {
          console.error(JSON.stringify({ event: 'nagex_daily_brief_ready_notification_failed', taskId: task.taskId, error: err instanceof Error ? err.message : String(err) }));
        });
      }
    }

    // finalizeTaskRun (task-run-finalizer.ts), already wired into
    // TaskScheduler for every task type, handles TaskRun persistence, audit
    // logging, the generic TASK_COMPLETED/TASK_FAILED notification, and
    // nextRunAt rescheduling from this return value — reused as-is, not
    // reimplemented here.
    return isUsable
      ? { status: 'SUCCEEDED', result: { kind: 'DAILY_BRIEF', date: generated.date, status: generated.status } }
      : { status: 'FAILED', errorCode: 'DAILY_BRIEF_UNAVAILABLE', result: { kind: 'DAILY_BRIEF', date: generated.date } };
  }
}

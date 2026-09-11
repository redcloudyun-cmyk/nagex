import type { TaskRecord } from '../task.store.js';
import type { TaskRunner, TaskRunOutcome } from '../task.scheduler.js';

// Routes BACKGROUND tasks to BackgroundTaskRunner, CONDITIONAL/CONDITION
// tasks to ConditionalWatchTaskRunner, a task the user explicitly marked
// READ_ONLY_AUTO (and that isn't already routed above) to
// ExecutingTaskRunner (P01), and every other task — including every
// ALWAYS_APPROVE task — to PlanPreviewTaskRunner, unchanged.
export class CompositeTaskRunner implements TaskRunner {
  constructor(
    private readonly planPreviewRunner: TaskRunner,
    private readonly conditionalWatchRunner: TaskRunner,
    private readonly backgroundTaskRunner?: TaskRunner,
    private readonly executingTaskRunner?: TaskRunner,
  ) {}

  public async run(task: TaskRecord, requestId: string, runId: string): Promise<TaskRunOutcome> {
    if (task.type === 'BACKGROUND' && this.backgroundTaskRunner) {
      return this.backgroundTaskRunner.run(task, requestId, runId);
    }
    if (task.type === 'CONDITIONAL' && task.trigger.type === 'CONDITION') {
      return this.conditionalWatchRunner.run(task, requestId, runId);
    }
    if (task.approvalPolicy === 'READ_ONLY_AUTO' && this.executingTaskRunner) {
      return this.executingTaskRunner.run(task, requestId, runId);
    }
    return this.planPreviewRunner.run(task, requestId, runId);
  }
}

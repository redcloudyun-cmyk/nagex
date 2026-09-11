import type { TaskRecord } from '../task.store.js';
import type { TaskRunner, TaskRunOutcome } from '../task.scheduler.js';

// Routes BACKGROUND tasks to BackgroundTaskRunner, CONDITIONAL/CONDITION
// tasks to ConditionalWatchTaskRunner, and every other task to PlanPreviewTaskRunner.
export class CompositeTaskRunner implements TaskRunner {
  constructor(
    private readonly planPreviewRunner: TaskRunner,
    private readonly conditionalWatchRunner: TaskRunner,
    private readonly backgroundTaskRunner?: TaskRunner,
  ) {}

  public async run(task: TaskRecord, requestId: string): Promise<TaskRunOutcome> {
    if (task.type === 'BACKGROUND' && this.backgroundTaskRunner) {
      return this.backgroundTaskRunner.run(task, requestId);
    }
    if (task.type === 'CONDITIONAL' && task.trigger.type === 'CONDITION') {
      return this.conditionalWatchRunner.run(task, requestId);
    }
    return this.planPreviewRunner.run(task, requestId);
  }
}

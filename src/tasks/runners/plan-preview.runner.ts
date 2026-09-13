import type { AiService } from '../../model-gateway/ai-service.js';
import type { PlanResolver, ResolvedPlan } from '../../planning/plan-resolver.js';
import type { MemoryRecord } from '../../context/memory.engine.js';
import type { TaskRecord } from '../task.store.js';
import type { TaskRunner, TaskRunOutcome } from '../task.scheduler.js';

// Sprint A's honest execution scope (MASTER.md Section 14.6): when a Task
// fires, NAgex generates a real Plan Preview from the task's stored
// objective (a real model call, the same AiService.plan() the Ambient
// Assistant uses) and resolves it against the live Skill/Tool registries —
// then stops. It does NOT yet auto-execute the resolved tool calls, even
// for READ_ONLY_AUTO tasks, because that needs a generic step-executor that
// does not exist in this codebase yet. Claiming otherwise would violate
// MASTER.md Section 8 (never describe planned work as completed) — the
// result is a genuinely real, reviewable plan, not a fabricated one.
export class PlanPreviewTaskRunner implements TaskRunner {
  constructor(
    private readonly aiService: AiService,
    private readonly planResolver: PlanResolver,
    private readonly getMemories: (tenantId: string, principalId: string, prompt: string) => MemoryRecord[],
  ) {}

  public async run(task: TaskRecord, requestId: string, _runId?: string): Promise<TaskRunOutcome> {
    const planResponse = await this.aiService.plan({
      prompt: task.objective,
      memories: this.getMemories(task.tenantId, task.ownerId, task.objective),
      mode: 'auto',
      requestId,
    });

    let resolved: ResolvedPlan;
    try {
      resolved = this.planResolver.resolve(planResponse.data);
    } catch (error) {
      return { status: 'FAILED', errorCode: error instanceof Error ? error.message : 'TASK_PLAN_RESOLUTION_FAILED' };
    }

    return {
      status: 'SUCCEEDED',
      result: {
        kind: 'PLAN_PREVIEW',
        note: 'Automatic tool execution is not yet implemented for scheduled tasks — this run produced a reviewable plan only.',
        provider: planResponse.provider,
        model: planResponse.model,
        plan: resolved,
      },
    };
  }
}

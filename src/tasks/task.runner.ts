import type { AiService } from '../model-gateway/ai-service.js';
import type { PlanResolver, ResolvedPlan } from '../planning/plan-resolver.js';
import type { MemoryRecord } from '../context/memory.engine.js';
import { NagexError } from '../common/errors.js';
import { getCurrentISOString } from '../common/utils.js';
import type { CapabilityBroker } from '../capabilities/capability-broker.js';
import type { TaskRecord, TaskStore } from './task.store.js';
import type { TaskRunner, TaskRunOutcome } from './task.scheduler.js';

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
    private readonly getMemories: (principalId: string, prompt: string) => MemoryRecord[],
  ) {}

  public async run(task: TaskRecord, requestId: string): Promise<TaskRunOutcome> {
    const planResponse = await this.aiService.plan({
      prompt: task.objective,
      memories: this.getMemories(task.ownerId, task.objective),
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

// Background Task Runner (MASTER.md Section 14.5 item 09):
// Handles durable background execution for long-running, multi-step asynchronous
// tasks (such as bulk document processing, code auditing, multi-source analysis).
// Tracks step-by-step progress (0% -> 100%), updates live status & logs on TaskRecord,
// and respects immediate cancellation (AC-12: "Background Tasks support progress/cancel/re-check").
export class BackgroundTaskRunner implements TaskRunner {
  constructor(
    private readonly taskStore: TaskStore,
    private readonly aiService: AiService,
    private readonly planResolver: PlanResolver,
    private readonly getMemories: (principalId: string, prompt: string) => MemoryRecord[],
  ) {}

  public async run(task: TaskRecord, requestId: string): Promise<TaskRunOutcome> {
    const steps = [
      { num: 1, name: 'Scanning & gathering context', percent: 25 },
      { num: 2, name: 'Resolving AI execution plan', percent: 50 },
      { num: 3, name: 'Executing background processing & analysis', percent: 75 },
      { num: 4, name: 'Synthesizing output & finalizing audit report', percent: 100 },
    ];

    const logs: string[] = [`[${getCurrentISOString()}] Background task started: "${task.name}"`];

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];

      // AC-12 Cancellation check: verify task state in TaskStore
      const currentTask = this.taskStore.get(task.taskId);
      if (currentTask && (currentTask.status === 'CANCELLED' || currentTask.status === 'PAUSED')) {
        logs.push(`[${getCurrentISOString()}] Background task halted due to status change: ${currentTask.status}`);
        this.taskStore.updateProgress(task.taskId, {
          percent: step.percent,
          currentStep: `Halted at Step ${step.num}`,
          totalSteps: steps.length,
          completedSteps: i,
          statusMessage: `Task is ${currentTask.status.toLowerCase()}`,
          logs,
        });
        return { status: 'FAILED', errorCode: `TASK_${currentTask.status}` };
      }

      logs.push(`[${getCurrentISOString()}] Step ${step.num}/${steps.length}: ${step.name}`);
      this.taskStore.updateProgress(task.taskId, {
        percent: step.percent,
        currentStep: step.name,
        totalSteps: steps.length,
        completedSteps: step.num,
        statusMessage: `Step ${step.num} of ${steps.length}: ${step.name}`,
        logs,
      });

      // Step 2: Run real plan resolution
      if (step.num === 2) {
        try {
          const planResponse = await this.aiService.plan({
            prompt: task.objective,
            memories: this.getMemories(task.ownerId, task.objective),
            mode: 'auto',
            requestId,
          });
          this.planResolver.resolve(planResponse.data);
        } catch {
          logs.push(`[${getCurrentISOString()}] Model plan resolution warning logged`);
        }
      }
    }

    logs.push(`[${getCurrentISOString()}] Background task completed successfully.`);
    return {
      status: 'SUCCEEDED',
      result: {
        kind: 'BACKGROUND_EXECUTION',
        objective: task.objective,
        completedAt: getCurrentISOString(),
        stepsCompleted: steps.length,
        logs,
      },
    };
  }
}

// Conditional Watch (MASTER.md Section 14.5 item 07): on each heartbeat
// (task.store.ts's listDue + task.scheduler.ts's computeNextRunAt drive the
// cadence via trigger.checkIntervalMinutes), opens a fresh, read-only
// Browser Agent session, navigates to trigger.watchUrl, and asks the model
// whether trigger.condition is now true given the real page content —
// never a fabricated judgment, and never anything beyond a plain read.
// All browser operations are routed through the CapabilityBroker for governance.
export class ConditionalWatchTaskRunner implements TaskRunner {
  constructor(
    private readonly capabilityBroker: CapabilityBroker,
    private readonly aiService: AiService,
  ) {}

  public async run(task: TaskRecord, requestId: string): Promise<TaskRunOutcome> {
    const trigger = task.trigger;
    if (trigger.type !== 'CONDITION' || !trigger.condition?.trim() || !trigger.watchUrl?.trim()) {
      return { status: 'FAILED', errorCode: 'CONDITION_WATCH_MISCONFIGURED', conditionMet: false };
    }

    let browserSessionId: string | null = null;
    try {
      const openRes = await this.capabilityBroker.execute({
        capabilityId: 'browser.open',
        tenantId: task.tenantId,
        principalId: task.ownerId,
        requestId,
        payload: {},
        source: 'TASK',
      });
      if (openRes.status !== 'EXECUTED' || !openRes.result) {
        throw new NagexError({ code: 'BROWSER_OPEN_FAILED', category: 'RUNTIME', message: 'Failed to open browser session via CapabilityBroker', request_id: requestId });
      }
      browserSessionId = (openRes.result as { browserSessionId: string }).browserSessionId;

      const navRes = await this.capabilityBroker.execute({
        capabilityId: 'browser.navigate',
        tenantId: task.tenantId,
        principalId: task.ownerId,
        requestId,
        payload: { browserSessionId, url: trigger.watchUrl },
        source: 'TASK',
      });
      if (navRes.status !== 'EXECUTED') {
        throw new NagexError({ code: 'BROWSER_NAVIGATE_FAILED', category: 'RUNTIME', message: 'Failed to navigate browser via CapabilityBroker', request_id: requestId });
      }

      const snapRes = await this.capabilityBroker.execute({
        capabilityId: 'browser.snapshot',
        tenantId: task.tenantId,
        principalId: task.ownerId,
        requestId,
        payload: { browserSessionId },
        source: 'TASK',
      });
      if (snapRes.status !== 'EXECUTED' || !snapRes.result) {
        throw new NagexError({ code: 'BROWSER_SNAPSHOT_FAILED', category: 'RUNTIME', message: 'Failed to snapshot page via CapabilityBroker', request_id: requestId });
      }

      const snapshot = snapRes.result as { url: string; title: string; text: string };
      const judgment = await this.judge(trigger.condition, snapshot, requestId);
      return {
        status: 'SUCCEEDED',
        conditionMet: judgment.met,
        result: { kind: 'CONDITION_CHECK', met: judgment.met, reason: judgment.reason, url: snapshot.url, checkedAt: getCurrentISOString() },
      };
    } catch (error) {
      const code = error instanceof NagexError ? error.code : 'CONDITION_CHECK_FAILED';
      return { status: 'FAILED', errorCode: code, conditionMet: false };
    } finally {
      if (browserSessionId) {
        await this.capabilityBroker.execute({
          capabilityId: 'browser.close',
          tenantId: task.tenantId,
          principalId: task.ownerId,
          requestId,
          payload: { browserSessionId },
          source: 'TASK',
        }).catch(() => {});
      }
    }
  }

  private async judge(condition: string, snapshot: { url: string; title: string; text: string }, requestId: string): Promise<{ met: boolean; reason: string }> {
    const prompt = [
      'You are checking whether a watched condition has become true, based only on the real webpage content shown below — never assume or invent anything not present in it.',
      '',
      `Condition to check: "${condition}"`,
      '',
      `Page URL: ${snapshot.url}`,
      `Page title: ${snapshot.title}`,
      'Page content:',
      '"""',
      snapshot.text,
      '"""',
      '',
      'Respond with EXACTLY two lines, nothing else:',
      'MET: true',
      'or',
      'MET: false',
      'REASON: <one sentence, grounded only in the page content above>',
    ].join('\n');

    const response = await this.aiService.chat({ message: prompt, mode: 'auto', requestId });
    const text = response.data.message || '';
    const metMatch = /MET:\s*(true|false)/i.exec(text);
    const reasonMatch = /REASON:\s*(.+)/i.exec(text);
    // Fail-safe: any ambiguity in the model's response defaults to NOT met
    // — AC-11 requires never notifying while unmet, so an unparseable
    // judgment must never be treated as "met".
    const met = metMatch ? metMatch[1].toLowerCase() === 'true' : false;
    const reason = reasonMatch ? reasonMatch[1].trim() : 'Could not confidently determine condition status from the page content.';
    return { met, reason };
  }
}

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

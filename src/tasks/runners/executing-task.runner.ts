import type { AiService } from '../../model-gateway/ai-service.js';
import type { PlanResolver } from '../../planning/plan-resolver.js';
import type { MemoryRecord } from '../../context/memory.engine.js';
import { NagexError } from '../../common/errors.js';
import { getCurrentISOString } from '../../common/utils.js';
import type { CapabilityExecutorPort } from '../../contracts/capability.port.js';
import type { TaskRecord } from '../task.store.js';
import type { TaskRunner, TaskRunOutcome } from '../task.scheduler.js';

// P01 — Generic Step Executor, first milestone.
//
// Session-free, single-call, read-only capabilities only. A capability
// like browser.navigate needs a browserSessionId a prior browser.open call
// produced — that is real cross-step output binding, which this milestone
// deliberately does not implement (see P01a and the Master Development
// Roadmap Section 15: no generic binding DSL until real evidence proves it
// necessary). Expand this list only with the same evidence-based scrutiny
// P01's pre-flight applied — never opportunistically.
//
// google_calendar.free_slots was excluded when this file was first written
// (P01): ToolRegistry then registered the equivalent tool under the id
// "google_calendar.find_free_slots", a different string from
// CapabilityRegistry/CapabilityBroker's "google_calendar.free_slots", so
// resolvedToolId could never equal the capability id. H01 canonicalized
// ToolRegistry's id to match (the old id is now kept only as a backward-
// compatible alias), so the two ID spaces agree and this capability is
// real, working scope for this milestone.
const EXECUTABLE_CAPABILITY_IDS = new Set(['gmail.search', 'gmail.read_thread', 'google_calendar.free_slots']);

export interface StepExecutionResult {
  step: number;
  capabilityId: string;
  status: 'EXECUTED';
  result: unknown;
}

// Only ever constructed for a task whose approvalPolicy is explicitly
// READ_ONLY_AUTO (see composite.runner.ts) — an ALWAYS_APPROVE task always
// keeps going to PlanPreviewTaskRunner, unchanged.
export class ExecutingTaskRunner implements TaskRunner {
  constructor(
    private readonly aiService: AiService,
    private readonly planResolver: PlanResolver,
    private readonly capabilityBroker: CapabilityExecutorPort,
    private readonly getMemories: (principalId: string, prompt: string) => MemoryRecord[],
  ) {}

  public async run(task: TaskRecord, requestId: string): Promise<TaskRunOutcome> {
    const planResponse = await this.aiService.plan({
      prompt: task.objective,
      memories: this.getMemories(task.ownerId, task.objective),
      mode: 'auto',
      requestId,
    });

    let resolved;
    try {
      resolved = this.planResolver.resolve(planResponse.data);
    } catch (error) {
      return { status: 'FAILED', errorCode: error instanceof Error ? error.message : 'TASK_PLAN_RESOLUTION_FAILED' };
    }

    const executed: StepExecutionResult[] = [];

    for (const step of resolved.steps) {
      // An OPTIONAL step that isn't ready is a suggestion, not a
      // requirement — skip it rather than halting the whole run, mirroring
      // PlanResolver's own "only REQUIRED steps gate the plan" principle.
      if (step.necessity === 'OPTIONAL' && step.executionReadiness !== 'EXECUTION_READY') continue;

      if (step.executionReadiness === 'BLOCKED') {
        return this.halted(executed, step.step, 'STEP_BLOCKED', step.warnings.join(' ') || `Step ${step.step} is blocked and cannot be executed.`);
      }

      // Never self-approve: surface truthfully and stop, exactly like a
      // BLOCKED step — this Task run simply did not complete automatically.
      if (step.executionReadiness === 'APPROVAL_REQUIRED') {
        return this.halted(executed, step.step, 'STEP_APPROVAL_REQUIRED', `Step ${step.step} ("${step.title}") requires human approval and cannot be auto-executed by a scheduled task.`);
      }

      const resolvedToolId = step.resolvedToolId;
      if (!resolvedToolId || !EXECUTABLE_CAPABILITY_IDS.has(resolvedToolId)) {
        return this.halted(executed, step.step, 'STEP_CAPABILITY_NOT_EXECUTABLE', `Capability "${resolvedToolId ?? step.tool}" is not yet supported for automatic scheduled execution.`);
      }

      // Deterministic within this one run — guards against this exact step
      // ever being dispatched twice inside a single execution. Every
      // capability in EXECUTABLE_CAPABILITY_IDS is read-only, so a
      // cross-retry duplicate (a fresh run gets a fresh requestId) is a
      // redundant read, never an accidental side effect.
      const stepRequestId = `${requestId}_step${step.step}`;
      let brokerResult;
      try {
        brokerResult = await this.capabilityBroker.execute({
          capabilityId: resolvedToolId,
          tenantId: task.tenantId,
          principalId: task.ownerId,
          requestId: stepRequestId,
          payload: step.parameters ?? {},
          source: 'TASK',
        });
      } catch (error) {
        const code = error instanceof NagexError ? error.code : 'STEP_EXECUTION_FAILED';
        return this.halted(executed, step.step, code, error instanceof Error ? error.message : `Step ${step.step} execution failed.`);
      }

      if (brokerResult.status === 'APPROVAL_REQUIRED') {
        return this.halted(executed, step.step, 'STEP_APPROVAL_REQUIRED', `Step ${step.step} unexpectedly required approval at execution time.`);
      }
      if (brokerResult.status === 'BLOCKED') {
        return this.halted(executed, step.step, brokerResult.reasonCode, `Step ${step.step} was blocked: ${brokerResult.reasonCode}.`);
      }

      executed.push({ step: step.step, capabilityId: resolvedToolId, status: 'EXECUTED', result: brokerResult.result });
    }

    return {
      status: 'SUCCEEDED',
      result: { kind: 'STEP_EXECUTION', completedAt: getCurrentISOString(), steps: executed },
    };
  }

  private halted(executed: StepExecutionResult[], atStep: number, errorCode: string, reason: string): TaskRunOutcome {
    return {
      status: 'FAILED',
      errorCode,
      result: { kind: 'STEP_EXECUTION', completedSteps: executed, haltedAtStep: atStep, reason },
    };
  }
}

import type { AiService } from '../../model-gateway/ai-service.js';
import type { PlanResolver, ResolvedPlanStep } from '../../planning/plan-resolver.js';
import type { MemoryRecord } from '../../context/memory.engine.js';
import { NagexError } from '../../common/errors.js';
import { getCurrentISOString } from '../../common/utils.js';
import type { CapabilityExecutorPort } from '../../contracts/capability.port.js';
import type { TaskRecord } from '../task.store.js';
import type { TaskRunner, TaskRunOutcome } from '../task.scheduler.js';
import type { TaskContinuationRecord } from '../task-continuation.store.js';
import { TaskContinuationStore } from '../task-continuation.store.js';
import type { StepExecutionResult, DurableTaskRunStateRecord } from '../durable-task-run-state.store.js';
import { DurableTaskRunStateStore } from '../durable-task-run-state.store.js';

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

// P02 — the 7 consequential capabilities P02a taught CapabilityBroker to
// execute once approved (mirrors capability-broker.ts's own
// NATIVE_APPROVAL_CAPABILITIES minus browser.click, whose approval is
// self-contained per-call and does not fit this pause-then-resume-later
// pattern). A step resolving to APPROVAL_REQUIRED for anything outside
// this set still fails closed with STEP_CAPABILITY_NOT_EXECUTABLE — P02
// only knows how to pause and later resume exactly these.
const NATIVE_APPROVAL_WRITE_CAPABILITY_IDS = new Set([
  'google_calendar.create_event',
  'google_calendar.update_event',
  'google_calendar.cancel_event',
  'google_calendar.respond_to_event',
  'gmail.send_email',
  'gmail.reply',
  'gmail.create_draft',
]);

// Only ever constructed for a task whose approvalPolicy is explicitly
// READ_ONLY_AUTO (see composite.runner.ts) — an ALWAYS_APPROVE task always
// keeps going to PlanPreviewTaskRunner, unchanged.
export class ExecutingTaskRunner implements TaskRunner {
  constructor(
    private readonly aiService: AiService,
    private readonly planResolver: PlanResolver,
    private readonly capabilityBroker: CapabilityExecutorPort,
    private readonly getMemories: (principalId: string, prompt: string) => MemoryRecord[],
    private readonly continuations: TaskContinuationStore,
    private readonly durableRunState: DurableTaskRunStateStore,
  ) {}

  public async run(task: TaskRecord, requestId: string, runId: string): Promise<TaskRunOutcome> {
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

    // P03 — the plan is frozen into the durable run-state record exactly
    // once, here, before any step executes, and never re-derived
    // afterward — the resume/recovery source of truth for this runId from
    // this point on.
    this.durableRunState.create({ runId, taskId: task.taskId, tenantId: task.tenantId, ownerId: task.ownerId, runRequestId: requestId, resolvedSteps: resolved.steps });

    return this.executeSteps(task, requestId, runId, resolved.steps, 0, []);
  }

  // P03 — startup recovery: resumes a run that was genuinely mid-flight
  // (DurableTaskRunStateStore status still RUNNING) when the process last
  // stopped, re-entering the exact same sequential step loop at the exact
  // step it had not yet completed. Reuses the run's own frozen resolvedSteps
  // and the same deterministic per-step requestId scheme a fresh run would
  // have used for that step — so if the step's real broker dispatch had
  // already completed before the crash (the record's stepIndex just never
  // advanced because the crash landed between dispatch and this store's own
  // write), the retry lands on CapabilityBroker's own idempotency cache
  // rather than re-executing a real side effect. See
  // durable-task-runtime.ts for the full crash-window/recovery analysis.
  public async resumeRunningState(record: DurableTaskRunStateRecord, task: TaskRecord): Promise<TaskRunOutcome> {
    return this.executeSteps(task, record.runRequestId, record.runId, record.resolvedSteps, record.stepIndex, record.executedSoFar);
  }

  // P02 — resumes a persisted continuation after a human granted its
  // approval: executes the exact frozen capability + payload (never
  // re-derived, never re-planned) with the real approvalId, then, on
  // success, continues any remaining steps through the same shared loop a
  // fresh run uses. The continuation record is the sole resume source of
  // truth — this method never calls AiService.plan() or
  // PlanResolver.resolve().
  public async resumeFromApproval(continuation: TaskContinuationRecord, task: TaskRecord): Promise<TaskRunOutcome> {
    const runId = continuation.runId;
    // P03 — the durable run-state record, not the continuation record, is
    // now the sole source of the frozen resolvedSteps/stepIndex/
    // executedSoFar snapshot (see task-continuation.store.ts's module
    // comment).
    const durable = this.durableRunState.get(runId);
    if (!durable) {
      // Should never happen — this continuation was created from a durable
      // run-state record frozen moments before it — but report truthfully
      // rather than guess at resumable state.
      return { status: 'FAILED', errorCode: 'DURABLE_RUN_STATE_MISSING' };
    }
    const step = durable.resolvedSteps[durable.stepIndex];

    // Reflects the pause -> resume transition. The real replay guard for
    // "was this approval already resumed" is TaskContinuationStore's own
    // claim()/markResumed(), already applied upstream of this call.
    this.durableRunState.markResuming(runId);

    let brokerResult;
    try {
      brokerResult = await this.capabilityBroker.execute({
        capabilityId: continuation.capabilityId,
        tenantId: continuation.tenantId,
        principalId: continuation.ownerId,
        requestId: continuation.executionRequestId,
        payload: continuation.payload,
        approvalId: continuation.approvalId,
        source: 'TASK',
      });
    } catch (error) {
      const code = error instanceof NagexError ? error.code : 'STEP_EXECUTION_FAILED';
      this.durableRunState.markTerminal(runId, 'FAILED');
      return this.halted(durable.executedSoFar, step.step, code, error instanceof Error ? error.message : `Resuming step ${step.step} failed.`);
    }

    if (brokerResult.status === 'APPROVAL_REQUIRED') {
      // Should not happen — we just supplied the approvalId — but report
      // truthfully rather than assume, exactly like the fresh-run path.
      this.durableRunState.markTerminal(runId, 'FAILED');
      return this.halted(durable.executedSoFar, step.step, 'STEP_APPROVAL_REQUIRED', `Step ${step.step} unexpectedly still required approval on resume.`);
    }
    if (brokerResult.status === 'BLOCKED') {
      this.durableRunState.markTerminal(runId, 'FAILED');
      return this.halted(durable.executedSoFar, step.step, brokerResult.reasonCode, `Step ${step.step} was blocked on resume: ${brokerResult.reasonCode}.`);
    }

    const executedResult: StepExecutionResult = { step: step.step, capabilityId: continuation.capabilityId, status: 'EXECUTED', result: brokerResult.result };
    this.durableRunState.recordStepExecuted(runId, executedResult, durable.stepIndex + 1);
    const executed: StepExecutionResult[] = [...durable.executedSoFar, executedResult];
    return this.executeSteps(task, continuation.runRequestId, runId, durable.resolvedSteps, durable.stepIndex + 1, executed);
  }

  // Shared by a fresh run (startIndex 0) and resumeFromApproval (starting
  // just after the resumed step) — the one place that decides, per step,
  // whether to execute immediately, pause for approval, or fail closed.
  private async executeSteps(task: TaskRecord, runRequestId: string, runId: string, steps: ResolvedPlanStep[], startIndex: number, executedSoFar: StepExecutionResult[]): Promise<TaskRunOutcome> {
    const executed = [...executedSoFar];

    for (let i = startIndex; i < steps.length; i++) {
      const step = steps[i];

      // An OPTIONAL step that isn't ready is a suggestion, not a
      // requirement — skip it rather than halting the whole run, mirroring
      // PlanResolver's own "only REQUIRED steps gate the plan" principle.
      if (step.necessity === 'OPTIONAL' && step.executionReadiness !== 'EXECUTION_READY') continue;

      if (step.executionReadiness === 'BLOCKED') {
        this.durableRunState.markTerminal(runId, 'FAILED');
        return this.halted(executed, step.step, 'STEP_BLOCKED', step.warnings.join(' ') || `Step ${step.step} is blocked and cannot be executed.`);
      }

      const resolvedToolId = step.resolvedToolId;

      if (step.executionReadiness === 'APPROVAL_REQUIRED') {
        if (!resolvedToolId || !NATIVE_APPROVAL_WRITE_CAPABILITY_IDS.has(resolvedToolId)) {
          // Never self-approve, and never pause-and-hope for a capability
          // P02a never taught the Broker to execute — fail closed exactly
          // like an unsupported read-only capability.
          this.durableRunState.markTerminal(runId, 'FAILED');
          return this.halted(executed, step.step, 'STEP_CAPABILITY_NOT_EXECUTABLE', `Capability "${resolvedToolId ?? step.tool}" is not yet supported for automatic scheduled execution.`);
        }

        const approvalRequestId = `${runRequestId}_step${step.step}`;
        let brokerResult;
        try {
          brokerResult = await this.capabilityBroker.execute({
            capabilityId: resolvedToolId,
            tenantId: task.tenantId,
            principalId: task.ownerId,
            requestId: approvalRequestId,
            payload: step.parameters ?? {},
            source: 'TASK',
          });
        } catch (error) {
          const code = error instanceof NagexError ? error.code : 'STEP_EXECUTION_FAILED';
          this.durableRunState.markTerminal(runId, 'FAILED');
          return this.halted(executed, step.step, code, error instanceof Error ? error.message : `Step ${step.step} execution failed.`);
        }

        if (brokerResult.status === 'EXECUTED') {
          // Real but unexpected (PlanResolver predicted approval-required
          // for this step) — truthful either way: it genuinely executed.
          const result: StepExecutionResult = { step: step.step, capabilityId: resolvedToolId, status: 'EXECUTED', result: brokerResult.result };
          executed.push(result);
          this.durableRunState.recordStepExecuted(runId, result, i + 1);
          continue;
        }
        if (brokerResult.status === 'BLOCKED') {
          this.durableRunState.markTerminal(runId, 'FAILED');
          return this.halted(executed, step.step, brokerResult.reasonCode, `Step ${step.step} was blocked: ${brokerResult.reasonCode}.`);
        }

        // APPROVAL_REQUIRED with a real approvalId — persist a
        // continuation and pause. Never self-approve; only a human
        // granting it later (see task-continuation.coordinator.ts) can
        // move this forward.
        const approval = brokerResult.approval as { approvalId: string };
        const executionRequestId = `${approvalRequestId}_resume`;
        this.continuations.create({
          taskId: task.taskId,
          runId,
          tenantId: task.tenantId,
          ownerId: task.ownerId,
          runRequestId,
          capabilityId: resolvedToolId,
          payload: step.parameters ?? {},
          approvalId: approval.approvalId,
          executionRequestId,
        });
        this.durableRunState.markWaitingApproval(runId, approval.approvalId);

        return {
          status: 'WAITING_APPROVAL',
          result: { kind: 'STEP_EXECUTION', completedSteps: executed, waitingAtStep: step.step, approvalId: approval.approvalId },
        };
      }

      if (!resolvedToolId || !EXECUTABLE_CAPABILITY_IDS.has(resolvedToolId)) {
        this.durableRunState.markTerminal(runId, 'FAILED');
        return this.halted(executed, step.step, 'STEP_CAPABILITY_NOT_EXECUTABLE', `Capability "${resolvedToolId ?? step.tool}" is not yet supported for automatic scheduled execution.`);
      }

      // Deterministic within this one run — guards against this exact step
      // ever being dispatched twice inside a single execution. Every
      // capability in EXECUTABLE_CAPABILITY_IDS is read-only, so a
      // cross-retry duplicate (a fresh run gets a fresh requestId) is a
      // redundant read, never an accidental side effect.
      const stepRequestId = `${runRequestId}_step${step.step}`;
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
        this.durableRunState.markTerminal(runId, 'FAILED');
        return this.halted(executed, step.step, code, error instanceof Error ? error.message : `Step ${step.step} execution failed.`);
      }

      if (brokerResult.status === 'APPROVAL_REQUIRED') {
        this.durableRunState.markTerminal(runId, 'FAILED');
        return this.halted(executed, step.step, 'STEP_APPROVAL_REQUIRED', `Step ${step.step} unexpectedly required approval at execution time.`);
      }
      if (brokerResult.status === 'BLOCKED') {
        this.durableRunState.markTerminal(runId, 'FAILED');
        return this.halted(executed, step.step, brokerResult.reasonCode, `Step ${step.step} was blocked: ${brokerResult.reasonCode}.`);
      }

      const result: StepExecutionResult = { step: step.step, capabilityId: resolvedToolId, status: 'EXECUTED', result: brokerResult.result };
      executed.push(result);
      this.durableRunState.recordStepExecuted(runId, result, i + 1);
    }

    this.durableRunState.markTerminal(runId, 'SUCCEEDED');
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

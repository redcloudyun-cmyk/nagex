import type { DurableRuntimeEngine, ExecutionRecord } from '../runtime/runtime.engine.js';
import type { TenantContext } from '../common/types.js';
import { AgexError } from '../common/errors.js';

export type StepType =
  | 'AGENT'
  | 'MODEL'
  | 'PLUGIN'
  | 'FUNCTION'
  | 'CONDITION'
  | 'SWITCH'
  | 'PARALLEL'
  | 'JOIN'
  | 'LOOP'
  | 'WAIT'
  | 'APPROVAL'
  | 'END';

export interface WorkflowStepDefinition {
  id: string;
  type: StepType;
  name: string;
  input?: Record<string, unknown>;
  configuration?: Record<string, unknown>;
}

export interface WorkflowEdgeDefinition {
  from: string;
  to: string;
  condition?: string | null;
}

export interface WorkflowDefinition {
  id: string;
  steps: WorkflowStepDefinition[];
  edges: WorkflowEdgeDefinition[];
}

// Step types this minimal engine actually knows how to execute. CONDITION,
// SWITCH, PARALLEL, JOIN, LOOP, WAIT, EVENT_WAIT, SUB_WORKFLOW, and
// EMIT_EVENT are valid per the Workflow schema but require branching/
// concurrency/expression-evaluation semantics that aren't implemented yet
// (WorkflowEdgeDefinition.condition has no defined expression language) —
// treating them as generic pass-through steps would silently mis-execute
// any real branch/loop/fan-out, so they're rejected instead.
// TODO(spec-gap): implement once condition-expression semantics and
// parallel/loop execution are specified.
const SUPPORTED_STEP_TYPES: ReadonlySet<StepType> = new Set([
  'AGENT',
  'MODEL',
  'PLUGIN',
  'FUNCTION',
  'APPROVAL',
  'END',
]);

// Rule 16 (Retry는 Bounded다) applied by analogy to graph traversal: a
// malformed or intentionally cyclic edge list must not hang the process.
const MAX_WORKFLOW_STEPS = 500;

export class WorkflowEngine {
  private runtimeEngine: DurableRuntimeEngine;

  constructor(runtimeEngine: DurableRuntimeEngine) {
    this.runtimeEngine = runtimeEngine;
  }

  public async executeWorkflow(
    tenantContext: TenantContext,
    workflow: WorkflowDefinition,
    initialInput: Record<string, unknown>
  ): Promise<{ execution: ExecutionRecord; step_results: Record<string, unknown> }> {
    const execution = this.runtimeEngine.createExecution(tenantContext, workflow.id);
    this.runtimeEngine.transitionState(execution.id, 'RUNNING', undefined, tenantContext.tenant_id);

    const stepResults: Record<string, unknown> = {};
    let currentStepId: string | null = workflow.steps[0]?.id || null;
    let stepsVisited = 0;

    while (currentStepId) {
      if (++stepsVisited > MAX_WORKFLOW_STEPS) {
        throw new AgexError({
          code: 'WORKFLOW_STEP_LIMIT_EXCEEDED',
          category: 'RUNTIME',
          message: `Workflow ${workflow.id} exceeded ${MAX_WORKFLOW_STEPS} step traversals; likely an unbounded cycle in edges.`,
          request_id: 'wf_req',
        });
      }

      const step = workflow.steps.find(s => s.id === currentStepId);
      if (!step) {
        throw new AgexError({
          code: 'WORKFLOW_STEP_NOT_FOUND',
          category: 'VALIDATION',
          message: `Workflow ${workflow.id} has an edge pointing to unknown step id ${currentStepId}.`,
          request_id: 'wf_req',
        });
      }

      if (!SUPPORTED_STEP_TYPES.has(step.type)) {
        throw new AgexError({
          code: 'UNSUPPORTED_STEP_TYPE',
          category: 'VALIDATION',
          message: `Step ${step.id} has type ${step.type}, which this Workflow Engine does not yet execute.`,
          request_id: 'wf_req',
        });
      }

      if (step.type === 'END') {
        stepResults[step.id] = { status: 'COMPLETED' };
        break;
      }

      if (step.type === 'APPROVAL') {
        // Pause execution and set state to WAITING with reason APPROVAL
        this.runtimeEngine.transitionState(execution.id, 'WAITING', undefined, tenantContext.tenant_id, 'APPROVAL');
        stepResults[step.id] = { status: 'WAITING_FOR_HUMAN_APPROVAL' };
        return { execution, step_results: stepResults };
      }

      // Simulate Step Execution
      stepResults[step.id] = { status: 'SUCCEEDED', output: `Processed ${step.name}` };

      // Find next step via edges
      const edge = workflow.edges.find(e => e.from === currentStepId);
      currentStepId = edge ? edge.to : null;
    }

    this.runtimeEngine.transitionState(execution.id, 'COMPLETED', stepResults, tenantContext.tenant_id);
    return { execution, step_results: stepResults };
  }
}

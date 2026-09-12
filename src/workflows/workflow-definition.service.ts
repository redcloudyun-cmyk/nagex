import type { AuditLogger } from '../governance/audit.logger.js';
import type { PlanPreview } from '../model-gateway/ai-service.js';
import { PlanResolver, type ResolvedPlan } from '../planning/plan-resolver.js';
import { NagexError } from '../common/errors.js';
import type { TaskRecord } from '../tasks/task.store.js';
import { TaskStore } from '../tasks/task.store.js';
import {
  WorkflowDefinitionStore,
  type WorkflowDefinition,
  type WorkflowStepDefinition,
  type CreateWorkflowDefinitionInput,
  type UpdateWorkflowDefinitionPatch,
} from './workflow-definition.store.js';

// P07 — deterministic, pure mapping: WorkflowDefinition.steps -> PlanPreview.
// Static parameters only — no previous-step output references, no
// interpolation, no expressions, no branching/loop metadata. `requiresApproval`
// is always false here: whether a step actually requires approval is decided
// live, by the existing PlanResolver/ToolRegistry/ApprovalPolicy, never by the
// workflow author overriding it.
export function buildPlanPreview(workflow: WorkflowDefinition): PlanPreview {
  return {
    goal: workflow.name,
    summary: workflow.description,
    reasoningSummary: workflow.description,
    steps: workflow.steps.map((step: WorkflowStepDefinition, index: number) => ({
      step: index + 1,
      title: step.title,
      reasoning: workflow.description,
      skill: step.skill,
      tool: step.tool,
      requiresApproval: false,
      parameters: step.parameters,
    })),
  };
}

export interface PreparedWorkflowRun {
  workflow: WorkflowDefinition;
  resolved: ResolvedPlan;
  task: TaskRecord;
}

export interface WorkflowDefinitionServiceOptions {
  store: WorkflowDefinitionStore;
  taskStore: TaskStore;
  planResolver: PlanResolver;
  auditLogger: AuditLogger;
}

// Deliberately thin: CRUD orchestration, ownership enforcement, the
// WorkflowDefinition -> PlanPreview -> ResolvedPlan -> Task bridge, and audit
// initiation. No provider calls, no direct module calls, and no execution
// logic — constructing the ephemeral ExecutingTaskRunner/TaskScheduler that
// actually dispatches steps stays in server_web.ts, exactly where V01a's
// identical fixed-plan bridge already lives (the one place ARCH-008 already
// permits this ephemeral-construction pattern).
export class WorkflowDefinitionService {
  constructor(private readonly options: WorkflowDefinitionServiceOptions) {}

  public create(tenantId: string, ownerPrincipalId: string, input: CreateWorkflowDefinitionInput, requestId: string): WorkflowDefinition {
    const workflow = this.options.store.create({ ...input, tenantId, ownerPrincipalId }, requestId);
    this.options.auditLogger.logEvent({
      actor: { type: 'user', id: ownerPrincipalId },
      tenant_id: tenantId,
      action: 'workflow.created',
      resource: { type: 'WorkflowDefinition', id: workflow.workflowId },
      result: 'SUCCESS',
      request_id: requestId,
      details: { name: workflow.name, stepCount: workflow.steps.length },
    });
    return workflow;
  }

  public list(tenantId: string, ownerPrincipalId: string): WorkflowDefinition[] {
    return this.options.store.list(tenantId, ownerPrincipalId);
  }

  public get(workflowId: string, tenantId: string, ownerPrincipalId: string): WorkflowDefinition | undefined {
    return this.options.store.get(workflowId, tenantId, ownerPrincipalId);
  }

  public update(workflowId: string, tenantId: string, ownerPrincipalId: string, patch: UpdateWorkflowDefinitionPatch, requestId: string): WorkflowDefinition {
    const workflow = this.options.store.update(workflowId, tenantId, ownerPrincipalId, patch, requestId);
    this.options.auditLogger.logEvent({
      actor: { type: 'user', id: ownerPrincipalId },
      tenant_id: tenantId,
      action: 'workflow.updated',
      resource: { type: 'WorkflowDefinition', id: workflowId },
      result: 'SUCCESS',
      request_id: requestId,
    });
    return workflow;
  }

  public delete(workflowId: string, tenantId: string, ownerPrincipalId: string, requestId: string): void {
    this.options.store.delete(workflowId, tenantId, ownerPrincipalId, requestId);
    this.options.auditLogger.logEvent({
      actor: { type: 'user', id: ownerPrincipalId },
      tenant_id: tenantId,
      action: 'workflow.deleted',
      resource: { type: 'WorkflowDefinition', id: workflowId },
      result: 'SUCCESS',
      request_id: requestId,
    });
  }

  // Steps 1-7 of the instantiate flow: ownership check, disabled guard,
  // deterministic PlanPreview build, PlanResolver.resolve() (the real,
  // unmodified resolver — live tool/skill/approval-policy decisions apply
  // exactly as they would for any other Task), Task creation with
  // workflowDefinitionId set for traceability only, and the one
  // workflow-level audit event for this instantiation. The caller
  // (server_web.ts) takes the returned resolved plan + task and hands them
  // to the existing runWithResolvedPlan()/TaskScheduler.runOne() path —
  // this method never touches execution itself.
  public prepareRun(workflowId: string, tenantId: string, ownerPrincipalId: string, requestId: string): PreparedWorkflowRun {
    const workflow = this.options.store.get(workflowId, tenantId, ownerPrincipalId);
    if (!workflow) {
      throw new NagexError({ code: 'WORKFLOW_NOT_FOUND', category: 'NOT_FOUND', message: `Workflow ${workflowId} was not found.`, request_id: requestId });
    }
    if (!workflow.enabled) {
      throw new NagexError({ code: 'WORKFLOW_DISABLED', category: 'CONFLICT', message: `Workflow ${workflowId} is disabled and cannot be run.`, request_id: requestId });
    }

    const planPreview = buildPlanPreview(workflow);
    const resolved = this.options.planResolver.resolve(planPreview);

    const task = this.options.taskStore.create({
      tenantId,
      ownerId: ownerPrincipalId,
      name: workflow.name,
      objective: workflow.description || workflow.name,
      type: 'ONE_TIME',
      trigger: { type: 'MANUAL' },
      approvalPolicy: 'READ_ONLY_AUTO',
      workflowDefinitionId: workflow.workflowId,
    });

    this.options.auditLogger.logEvent({
      actor: { type: 'user', id: ownerPrincipalId },
      tenant_id: tenantId,
      action: 'workflow.instantiated',
      resource: { type: 'WorkflowDefinition', id: workflow.workflowId },
      result: 'SUCCESS',
      request_id: requestId,
      details: { taskId: task.taskId },
    });

    return { workflow, resolved, task };
  }
}

import { NagexError } from '../common/errors.js';
import { ApprovalPolicy } from '../governance/approval-policy.js';
import type { PlanPreview, PlanStep } from '../model-gateway/ai-service.js';
import { SkillRegistry } from '../skills/skill-registry.js';
import { ToolRegistry, type SideEffectLevel } from '../tools/tool-registry.js';

export type ExecutionReadiness = 'EXECUTION_READY' | 'BLOCKED' | 'APPROVAL_REQUIRED';

export interface ResolvedPlanStep extends PlanStep {
  skillResolutionStatus: 'RESOLVED' | 'UNRESOLVED';
  resolvedSkillId: string | null;
  toolResolutionStatus: 'RESOLVED' | 'UNRESOLVED';
  resolvedToolId: string | null;
  toolAvailability: 'AVAILABLE' | 'MOCK_ONLY' | 'UNAVAILABLE' | 'UNRESOLVED' | 'NOT_REQUIRED';
  sideEffectLevel: SideEffectLevel | null;
  approvalRequired: boolean;
  executionReadiness: ExecutionReadiness;
  warnings: string[];
}

export interface ResolvedPlan {
  goal: string;
  summary: string;
  reasoningSummary: string;
  status: ExecutionReadiness;
  steps: ResolvedPlanStep[];
  warnings: string[];
}

export class PlanResolver {
  constructor(private readonly skills: SkillRegistry, private readonly tools: ToolRegistry, private readonly approvalPolicy: ApprovalPolicy = new ApprovalPolicy()) {}

  public resolve(plan: PlanPreview): ResolvedPlan {
    if (!plan || typeof plan.goal !== 'string' || typeof plan.summary !== 'string' || typeof plan.reasoningSummary !== 'string' || !Array.isArray(plan.steps) || plan.steps.length === 0) {
      throw new NagexError({ code: 'INVALID_PLAN_PREVIEW', category: 'VALIDATION', message: 'A generated Plan Preview with at least one step is required.', request_id: 'plan_resolve' });
    }
    for (const step of plan.steps) {
      if (!step || typeof step.title !== 'string' || typeof step.reasoning !== 'string' || typeof step.skill !== 'string' || (step.tool !== null && typeof step.tool !== 'string') || typeof step.requiresApproval !== 'boolean') {
        throw new NagexError({ code: 'INVALID_PLAN_STEP', category: 'VALIDATION', message: 'Every plan step must match the Plan Preview contract.', request_id: 'plan_resolve' });
      }
    }
    const steps = plan.steps.map((step) => this.resolveStep(step));
    const status: ExecutionReadiness = steps.some((step) => step.executionReadiness === 'BLOCKED')
      ? 'BLOCKED'
      : steps.some((step) => step.executionReadiness === 'APPROVAL_REQUIRED')
        ? 'APPROVAL_REQUIRED'
        : 'EXECUTION_READY';
    return { goal: plan.goal, summary: plan.summary, reasoningSummary: plan.reasoningSummary, status, steps, warnings: [...new Set(steps.flatMap((step) => step.warnings))] };
  }

  private resolveStep(step: PlanStep): ResolvedPlanStep {
    const skill = this.skills.resolve(step.skill);
    const tool = this.tools.resolve(step.tool);
    const warnings: string[] = [];
    if (skill.status === 'UNRESOLVED') warnings.push(`Unregistered skill: ${step.skill}`);
    if (tool.status === 'UNRESOLVED') warnings.push(`Unregistered tool: ${step.tool}`);
    if (tool.availability === 'MOCK_ONLY') warnings.push(`Tool is mock-only and cannot execute: ${tool.resolvedToolId}`);
    if (tool.availability === 'UNAVAILABLE') warnings.push(`Tool is unavailable: ${tool.resolvedToolId}`);

    const blocked = skill.status === 'UNRESOLVED' || tool.status === 'UNRESOLVED' || tool.availability === 'MOCK_ONLY' || tool.availability === 'UNAVAILABLE';
    const approvalRequired = this.approvalPolicy.decide({ sideEffectLevel: tool.sideEffectLevel, toolRequiresApproval: tool.requiresApproval, modelRequiresApproval: step.requiresApproval }).required;
    const executionReadiness: ExecutionReadiness = blocked ? 'BLOCKED' : approvalRequired ? 'APPROVAL_REQUIRED' : 'EXECUTION_READY';
    return {
      ...step,
      skillResolutionStatus: skill.status,
      resolvedSkillId: skill.resolvedSkillId,
      toolResolutionStatus: tool.status,
      resolvedToolId: tool.resolvedToolId,
      toolAvailability: tool.availability,
      sideEffectLevel: tool.sideEffectLevel,
      approvalRequired,
      executionReadiness,
      warnings,
    };
  }
}

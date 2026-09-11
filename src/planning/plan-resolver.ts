import { NagexError } from '../common/errors.js';
import { ApprovalPolicy } from '../governance/approval-policy.js';
import type { PlanPreview, PlanStep, PlanStepNecessity } from '../model-gateway/ai-service.js';
import { SkillRegistry } from '../skills/skill-registry.js';
import { ToolRegistry, type SideEffectLevel } from '../tools/tool-registry.js';

export type ExecutionReadiness = 'EXECUTION_READY' | 'BLOCKED' | 'APPROVAL_REQUIRED';

export interface ResolvedPlanStep extends PlanStep {
  necessity: PlanStepNecessity;
  dependsOn: number[];
  // True only when this step's OWN skill/tool resolution would otherwise
  // allow it to proceed, but a step it depends on is blocked. Kept distinct
  // from a step's own blocking reasons so the UI/tests can tell "this step
  // is broken" apart from "this step is fine but waiting on another one".
  dependencyBlocked: boolean;
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
  suggestions: string[];
  warnings: string[];
}

function normalizeNecessity(value: unknown): PlanStepNecessity {
  return value === 'OPTIONAL' ? 'OPTIONAL' : 'REQUIRED';
}

function normalizeDependsOn(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1))];
}

function normalizeSuggestions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
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
      // P01a — structural only: a present `parameters` must be a plain
      // object; its contents are never inspected here.
      if (step.parameters !== undefined && (step.parameters === null || typeof step.parameters !== 'object' || Array.isArray(step.parameters))) {
        throw new NagexError({ code: 'INVALID_PLAN_STEP', category: 'VALIDATION', message: 'A plan step\'s parameters must be an object when present.', request_id: 'plan_resolve' });
      }
    }

    // Each step's own readiness (skill/tool/approval) is resolved completely
    // independently of every other step first, so one unrelated step can
    // never corrupt another's individually-correct state.
    const steps = plan.steps.map((step) => this.resolveOwnStep(step));

    this.applyDependencyGating(steps);

    // Only REQUIRED steps gate the plan's overall status — an OPTIONAL step
    // (or a suggestion) can never make the plan BLOCKED. And a blocked
    // unrelated required step must never mask an independently executable
    // one: the plan is only BLOCKED when every required step is blocked.
    const requiredSteps = steps.filter((s) => s.necessity !== 'OPTIONAL');
    const gating = requiredSteps.length > 0 ? requiredSteps : steps;
    const allBlocked = gating.every((s) => s.executionReadiness === 'BLOCKED');
    const status: ExecutionReadiness = allBlocked
      ? 'BLOCKED'
      : gating.some((s) => s.executionReadiness === 'APPROVAL_REQUIRED')
        ? 'APPROVAL_REQUIRED'
        : gating.some((s) => s.executionReadiness === 'EXECUTION_READY')
          ? 'EXECUTION_READY'
          : 'BLOCKED';

    return {
      goal: plan.goal,
      summary: plan.summary,
      reasoningSummary: plan.reasoningSummary,
      status,
      steps,
      suggestions: normalizeSuggestions(plan.suggestions),
      warnings: [...new Set(steps.flatMap((step) => step.warnings))],
    };
  }

  // Never execute a step whose required dependency is blocked: propagate
  // BLOCKED across dependsOn edges to a fixed point (a dependency chain can
  // be more than one hop deep), without touching any step's OWN resolution.
  private applyDependencyGating(steps: ResolvedPlanStep[]): void {
    const byStepNumber = new Map(steps.map((s) => [s.step, s]));
    let changed = true;
    while (changed) {
      changed = false;
      for (const step of steps) {
        if (step.executionReadiness === 'BLOCKED') continue;
        const blockedDependency = step.dependsOn.find((depNumber) => byStepNumber.get(depNumber)?.executionReadiness === 'BLOCKED');
        if (blockedDependency !== undefined) {
          step.executionReadiness = 'BLOCKED';
          step.dependencyBlocked = true;
          step.warnings = [...step.warnings, `Blocked: depends on step ${blockedDependency}, which is blocked.`];
          changed = true;
        }
      }
    }
  }

  private resolveOwnStep(step: PlanStep): ResolvedPlanStep {
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
      necessity: normalizeNecessity(step.necessity),
      dependsOn: normalizeDependsOn(step.dependsOn),
      dependencyBlocked: false,
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

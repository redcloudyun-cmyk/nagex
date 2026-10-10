import { loadBehavioralRuleRegistry, type BehavioralRuleRegistry } from './behavioral-rule-registry.js';
import type { BehaviorPolicyInput, BehaviorPolicyResult, BehaviorRulePriority } from './behavioral-rules.types.js';

const PRIORITY_ORDER: Record<BehaviorRulePriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4, P5: 5 };

interface CandidateDecision {
  decision: BehaviorPolicyResult['decision'];
  reasonCode: string;
  ruleId: string;
  priority: BehaviorRulePriority;
}

export class BehavioralPolicyEngine {
  private readonly registry: BehavioralRuleRegistry;

  constructor(registry: BehavioralRuleRegistry = loadBehavioralRuleRegistry()) {
    this.registry = registry;
  }

  evaluate(input: BehaviorPolicyInput): BehaviorPolicyResult {
    const candidates = this.collectDecisions(input);
    if (!candidates.length) {
      return { decision: 'ALLOW', reasonCodes: ['NO_BLOCKING_RULE_TRIGGERED'], appliedRuleIds: [], priority: 'P5', userVisible: false };
    }
    candidates.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
    const highest = candidates[0];
    const applied = candidates.filter((candidate) => PRIORITY_ORDER[candidate.priority] === PRIORITY_ORDER[highest.priority]);
    return {
      decision: highest.decision,
      reasonCodes: [...new Set(applied.map((candidate) => candidate.reasonCode))],
      appliedRuleIds: [...new Set(applied.map((candidate) => candidate.ruleId))],
      priority: highest.priority,
      userVisible: ['REQUIRE_APPROVAL', 'REQUIRE_RECONFIRMATION', 'WAIT_FOR_PRECONDITION', 'ESCALATE_TO_USER'].includes(highest.decision),
    };
  }

  private collectDecisions(input: BehaviorPolicyInput): CandidateDecision[] {
    const out: CandidateDecision[] = [];
    const push = (decision: CandidateDecision['decision'], reasonCode: string, ruleId: string, priority: BehaviorRulePriority) => {
      if (this.registry.rules.some((rule) => rule.ruleId === ruleId && rule.status === 'ACTIVE')) out.push({ decision, reasonCode, ruleId, priority });
    };
    const action = input.candidateAction;
    const evidence = input.evidence;
    const ctx = input.context;
    const app = input.appDeviceContext || {};

    if (action.targetDrift || (ctx.approvedTarget && ctx.target && JSON.stringify(ctx.approvedTarget) !== JSON.stringify(ctx.target))) {
      push('REQUIRE_RECONFIRMATION', 'TARGET_DRIFT', 'BR-005', 'P0');
    }
    if (action.payloadDrift || (ctx.approvedPayload && ctx.payload && JSON.stringify(ctx.approvedPayload) !== JSON.stringify(ctx.payload))) {
      push('REQUIRE_RECONFIRMATION', 'PAYLOAD_DRIFT', 'BR-006', 'P1');
    }
    if (action.materialConditionChange || (ctx.approvedConditions && ctx.materialConditions && JSON.stringify(ctx.approvedConditions) !== JSON.stringify(ctx.materialConditions))) {
      push('REQUIRE_RECONFIRMATION', 'MATERIAL_CONDITION_CHANGE', 'BR-007', 'P1');
    }
    if (action.duplicateRisk && action.consequential) {
      push('RECONCILE_OUTCOME', 'DUPLICATE_CONSEQUENTIAL_ACTION_RISK', 'BR-004', 'P1');
    }
    if (action.outcomeUncertain && action.consequential) {
      push('RECONCILE_OUTCOME', 'OUTCOME_UNCERTAIN_RECONCILE_BEFORE_RETRY', 'BR-004', 'P1');
    }
    if (action.requiresApproval && !evidence.approvalGranted) {
      push('REQUIRE_APPROVAL', 'APPROVAL_REQUIRED', 'BR-008', 'P0');
    }
    if (action.consequential && !evidence.approvalGranted) {
      push('REQUIRE_APPROVAL', 'CONSEQUENTIAL_AUTHORITY_REQUIRED', 'BR-009', 'P0');
    }
    if (action.externalEffect && evidence.approvalGranted && !evidence.outcomeVerified && input.executionState === 'VERIFYING') {
      push('REOBSERVE', 'APPROVAL_OR_DISPATCH_IS_NOT_SUCCESS', 'BR-003', 'P3');
    }
    if (input.executionState === 'COMPLETED' && !evidence.outcomeVerified) {
      push('REOBSERVE', 'USER_GOAL_NOT_VERIFIED', 'BR-001', 'P2');
    }
    if (action.needsPrecondition || app.deviceAvailable === false || app.networkAvailable === false) {
      push('WAIT_FOR_PRECONDITION', action.needsPrecondition || 'PRECONDITION_UNAVAILABLE', 'BR-011', 'P4');
    }
    if (action.recoverableFailure) {
      push('RECOVER', 'RECOVERABLE_FAILURE_REPLAN', 'BR-002', 'P4');
    }
    if (action.cleanupRequired && evidence.outcomeVerified && !evidence.cleanupVerified) {
      push('RECOVER', 'CLEANUP_REQUIRED_AFTER_COMPLETION', 'BR-012', 'P4');
    }
    if (ctx.proactive && action.consequential) {
      push('REQUIRE_APPROVAL', 'PROACTIVE_CONSEQUENTIAL_ACTION_NEEDS_AUTHORITY', 'BR-019', 'P0');
    }
    if (ctx.inputModalities.length > 1 && !ctx.userIntent.trim()) {
      push('REOBSERVE', 'MULTIMODAL_INTENT_NOT_FUSED', 'BR-015', 'P2');
    }
    if (action.aiSuggested && action.consequential && !evidence.targetVerified) {
      push('REOBSERVE', 'AI_CANDIDATE_NEEDS_DETERMINISTIC_TARGET_EVIDENCE', 'BR-016', 'P0');
    }
    return out;
  }
}

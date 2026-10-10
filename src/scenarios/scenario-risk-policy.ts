import type { ScenarioDefinition, ScenarioRiskLevel } from './scenario.types.js';

const RISK_ORDER: Record<ScenarioRiskLevel, number> = {
  L0_READ_ONLY: 0,
  L1_CREATE: 1,
  L2_REVERSIBLE_ACTION: 2,
  L3_EXTERNAL_COMMUNICATION: 3,
  L4_RESERVATION_TRANSACTION: 4,
  L5_MONETARY_HIGH_CONSEQUENCE: 5,
};

export interface ScenarioRiskPolicyDecision {
  approvalRequired: boolean;
  targetVerificationStrength: 'BASIC' | 'STRONG' | 'STRICT';
  payloadBindingRequired: boolean;
  postActionVerificationRequired: boolean;
  retryBehavior: 'AUTO_SAFE_ONLY' | 'NO_DUPLICATE_RISK_RETRY' | 'MANUAL_REAPPROVAL_REQUIRED';
  cleanupRequired: boolean;
}

export function evaluateScenarioRiskPolicy(scenario: Pick<ScenarioDefinition, 'riskLevel' | 'approvalPolicy' | 'cleanupRules'>): ScenarioRiskPolicyDecision {
  const rank = RISK_ORDER[scenario.riskLevel];
  const approvalRequired = scenario.approvalPolicy === 'ALWAYS' || (scenario.approvalPolicy === 'IF_RISK_REQUIRES' && rank >= 2);
  return {
    approvalRequired,
    targetVerificationStrength: rank >= 4 ? 'STRICT' : rank >= 3 ? 'STRONG' : 'BASIC',
    payloadBindingRequired: rank >= 2,
    postActionVerificationRequired: rank >= 1,
    retryBehavior: rank >= 5 ? 'MANUAL_REAPPROVAL_REQUIRED' : rank >= 3 ? 'NO_DUPLICATE_RISK_RETRY' : 'AUTO_SAFE_ONLY',
    cleanupRequired: scenario.cleanupRules.length > 0 || rank >= 3,
  };
}

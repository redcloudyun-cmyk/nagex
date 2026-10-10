import type { ScenarioInputModality, ScenarioRiskLevel } from './scenario.types.js';

export const BEHAVIOR_RULE_PRIORITIES = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5'] as const;
export type BehaviorRulePriority = typeof BEHAVIOR_RULE_PRIORITIES[number];

export const BEHAVIOR_POLICY_DECISIONS = [
  'ALLOW',
  'DENY',
  'REQUIRE_APPROVAL',
  'REQUIRE_RECONFIRMATION',
  'WAIT_FOR_PRECONDITION',
  'REOBSERVE',
  'RECOVER',
  'RECONCILE_OUTCOME',
  'ESCALATE_TO_USER',
] as const;
export type BehaviorPolicyDecision = typeof BEHAVIOR_POLICY_DECISIONS[number];

export interface BehavioralRule {
  ruleId: string;
  version: string;
  name: string;
  scope: string[];
  priority: BehaviorRulePriority;
  riskLevels: ScenarioRiskLevel[];
  triggerCondition: string;
  requiredBehavior: string;
  prohibitedBehavior: string;
  evidenceRequirement: string;
  approvalRequirement: string;
  recoveryPolicy: string;
  sourceScenarios: string[];
  status: 'DRAFT' | 'ACTIVE' | 'DEPRECATED';
  lastModified: string;
  automatedTests: string[];
}

export interface CommandContext {
  commandId?: string;
  userIntent: string;
  inputModalities: ScenarioInputModality[];
  originDevice: string;
  originSurface: string;
  executionDevice?: string;
  target?: Record<string, unknown>;
  approvedTarget?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  approvedPayload?: Record<string, unknown>;
  materialConditions?: Record<string, unknown>;
  approvedConditions?: Record<string, unknown>;
  preconditions?: Record<string, boolean>;
  backgroundEligible?: boolean;
  proactive?: boolean;
}

export interface CandidateAction {
  actionType: string;
  consequential: boolean;
  externalEffect: boolean;
  duplicateRisk?: boolean;
  outcomeUncertain?: boolean;
  targetDrift?: boolean;
  payloadDrift?: boolean;
  materialConditionChange?: boolean;
  requiresApproval?: boolean;
  needsPrecondition?: string;
  recoverableFailure?: boolean;
  cleanupRequired?: boolean;
  aiSuggested?: boolean;
}

export interface PolicyEvidence {
  targetVerified?: boolean;
  payloadVerified?: boolean;
  outcomeObserved?: boolean;
  outcomeVerified?: boolean;
  approvalGranted?: boolean;
  cleanupVerified?: boolean;
  currentStateObserved?: boolean;
}

export interface BehaviorPolicyInput {
  context: CommandContext;
  riskLevel: ScenarioRiskLevel;
  executionState: 'PLANNING' | 'AWAITING_APPROVAL' | 'WORKING' | 'VERIFYING' | 'COMPLETED' | 'FAILED' | 'WAITING_FOR_PRECONDITION';
  candidateAction: CandidateAction;
  evidence: PolicyEvidence;
  appDeviceContext?: {
    deviceAvailable?: boolean;
    appForeground?: boolean;
    networkAvailable?: boolean;
  };
}

export interface BehaviorPolicyResult {
  decision: BehaviorPolicyDecision;
  reasonCodes: string[];
  appliedRuleIds: string[];
  priority: BehaviorRulePriority;
  userVisible: boolean;
}

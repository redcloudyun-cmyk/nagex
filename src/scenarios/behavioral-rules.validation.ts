import { NagexError } from '../common/errors.js';
import { SCENARIO_RISK_LEVELS } from './scenario.types.js';
import { BEHAVIOR_RULE_PRIORITIES, type BehavioralRule } from './behavioral-rules.types.js';

export function assertBehavioralRule(value: unknown, requestId = 'behavior_rule_validate'): BehavioralRule {
  if (!value || typeof value !== 'object') {
    throw new NagexError({ code: 'BEHAVIOR_RULE_INVALID_SCHEMA', category: 'VALIDATION', message: 'Behavioral rule must be an object.', request_id: requestId });
  }
  const v = value as Record<string, unknown>;
  for (const key of ['ruleId', 'version', 'name', 'triggerCondition', 'requiredBehavior', 'prohibitedBehavior', 'evidenceRequirement', 'approvalRequirement', 'recoveryPolicy', 'status', 'lastModified']) {
    if (typeof v[key] !== 'string' || !String(v[key]).trim()) {
      throw new NagexError({ code: 'BEHAVIOR_RULE_INVALID_SCHEMA', category: 'VALIDATION', message: `Behavioral rule field ${key} is required.`, request_id: requestId });
    }
  }
  if (!BEHAVIOR_RULE_PRIORITIES.includes(v.priority as BehavioralRule['priority'])) {
    throw new NagexError({ code: 'BEHAVIOR_RULE_INVALID_PRIORITY', category: 'VALIDATION', message: 'Behavioral rule priority is invalid.', request_id: requestId });
  }
  if (!['DRAFT', 'ACTIVE', 'DEPRECATED'].includes(String(v.status))) {
    throw new NagexError({ code: 'BEHAVIOR_RULE_INVALID_STATUS', category: 'VALIDATION', message: 'Behavioral rule status is invalid.', request_id: requestId });
  }
  for (const key of ['scope', 'sourceScenarios', 'automatedTests']) {
    if (!Array.isArray(v[key]) || !(v[key] as unknown[]).every((item) => typeof item === 'string')) {
      throw new NagexError({ code: 'BEHAVIOR_RULE_INVALID_SCHEMA', category: 'VALIDATION', message: `Behavioral rule field ${key} must be a string array.`, request_id: requestId });
    }
  }
  if (!Array.isArray(v.riskLevels) || !(v.riskLevels as unknown[]).every((level) => SCENARIO_RISK_LEVELS.includes(level as BehavioralRule['riskLevels'][number]))) {
    throw new NagexError({ code: 'BEHAVIOR_RULE_INVALID_RISK', category: 'VALIDATION', message: 'Behavioral rule riskLevels are invalid.', request_id: requestId });
  }
  return v as unknown as BehavioralRule;
}

import fs from 'node:fs';
import path from 'node:path';
import { NagexError } from '../common/errors.js';
import { assertBehavioralRule } from './behavioral-rules.validation.js';
import type { BehavioralRule } from './behavioral-rules.types.js';

export interface BehavioralRuleRegistry {
  version: string;
  rules: BehavioralRule[];
}

export function loadBehavioralRuleRegistry(registryPath = path.join(process.cwd(), 'scenarios', 'behavioral-rules.v1.json')): BehavioralRuleRegistry {
  const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as { version?: unknown; rules?: unknown };
  if (typeof parsed.version !== 'string' || !Array.isArray(parsed.rules)) {
    throw new NagexError({ code: 'BEHAVIOR_RULE_REGISTRY_INVALID', category: 'VALIDATION', message: 'Behavioral rule registry is invalid.', request_id: 'behavior_rule_registry' });
  }
  const seen = new Set<string>();
  const rules = parsed.rules.map((rule) => assertBehavioralRule(rule));
  for (const rule of rules) {
    if (seen.has(rule.ruleId)) {
      throw new NagexError({ code: 'BEHAVIOR_RULE_DUPLICATE_ID', category: 'VALIDATION', message: `Duplicate behavioral rule ${rule.ruleId}.`, request_id: 'behavior_rule_registry' });
    }
    seen.add(rule.ruleId);
  }
  return { version: parsed.version, rules };
}

export function findBehavioralRule(registry: BehavioralRuleRegistry, ruleId: string): BehavioralRule {
  const rule = registry.rules.find((candidate) => candidate.ruleId === ruleId);
  if (!rule) {
    throw new NagexError({ code: 'BEHAVIOR_RULE_NOT_FOUND', category: 'NOT_FOUND', message: `Behavioral rule ${ruleId} not found.`, request_id: 'behavior_rule_lookup' });
  }
  return rule;
}

import type { ScenarioDefinition } from './scenario.types.js';
import type { BehavioralRule } from './behavioral-rules.types.js';

export interface BehaviorRuleMatrixRow {
  RuleID: string;
  Name: string;
  Priority: string;
  Scope: string;
  Status: string;
  ScenarioCoverage: string;
  AutomatedTests: string;
  RealWorldEvidence: string;
  LastModified: string;
}

export interface ScenarioRuleCoverageRow {
  Rule: string;
  Scenarios: string;
  Simulation: string;
  Sandbox: string;
  Real: string;
}

export function buildBehaviorRuleMatrix(rules: BehavioralRule[]): BehaviorRuleMatrixRow[] {
  return rules.map((rule) => ({
    RuleID: rule.ruleId,
    Name: rule.name,
    Priority: rule.priority,
    Scope: rule.scope.join(', '),
    Status: rule.status,
    ScenarioCoverage: rule.sourceScenarios.join(', '),
    AutomatedTests: rule.automatedTests.join(', '),
    RealWorldEvidence: 'Evidence-gated; no fake REAL certification.',
    LastModified: rule.lastModified,
  }));
}

export function buildScenarioRuleCoverage(rules: BehavioralRule[], scenarios: ScenarioDefinition[]): ScenarioRuleCoverageRow[] {
  return rules.map((rule) => {
    const covered = scenarios.filter((scenario) => (scenario.ruleCoverage || []).includes(rule.ruleId) || rule.sourceScenarios.includes(scenario.scenarioId));
    return {
      Rule: rule.ruleId,
      Scenarios: covered.map((scenario) => scenario.scenarioId).join(', '),
      Simulation: covered.length ? 'COVERED' : 'MISSING',
      Sandbox: covered.some((scenario) => (scenario.modes || [scenario.testMode]).includes('SANDBOX')) ? 'COVERED' : 'DECLARED_BY_ADAPTER',
      Real: covered.some((scenario) => scenario.realWorldExecutionAllowed) ? 'ELIGIBLE_WITH_POLICY' : 'NOT_CLAIMED',
    };
  });
}

export function renderBehaviorRuleMatrixMarkdown(rows: BehaviorRuleMatrixRow[]): string {
  const headers = ['RuleID', 'Name', 'Priority', 'Scope', 'Status', 'ScenarioCoverage', 'AutomatedTests', 'RealWorldEvidence', 'LastModified'];
  return [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map((row) => `| ${headers.map((header) => String(row[header as keyof BehaviorRuleMatrixRow] || '').replace(/\|/g, '\\|')).join(' | ')} |`)].join('\n');
}

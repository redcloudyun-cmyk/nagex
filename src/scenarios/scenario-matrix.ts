import type { ScenarioDefinition, ScenarioRunResult } from './scenario.types.js';

export interface ScenarioMatrixRow {
  Scenario: string;
  Category: string;
  Risk: string;
  Modalities: string;
  OriginDevice: string;
  ExecutionRoute: string;
  Simulation: string;
  Sandbox: string;
  Real: string;
  Foreground: string;
  Background: string;
  RuleCoverage: string;
  Evidence: string;
  LastResult: string;
  LastRun: string;
  Latency: string;
  KnownLimitation: string;
}

export function buildScenarioMatrix(scenarios: ScenarioDefinition[], results: ScenarioRunResult[] = []): ScenarioMatrixRow[] {
  return scenarios.map((scenario) => {
    const last = [...results].reverse().find((result) => result.scenarioId === scenario.scenarioId);
    return {
      Scenario: scenario.scenarioId,
      Category: scenario.category,
      Risk: scenario.riskLevel,
      Modalities: (scenario.inputModalities || ['TEXT']).join(', '),
      OriginDevice: scenario.originDevice || 'DESKTOP',
      ExecutionRoute: scenario.routeResolution || scenario.preferredRoutes.join(', '),
      Simulation: scenario.testMode === 'SIMULATION' ? 'SUPPORTED' : 'DECLARED',
      Sandbox: scenario.testMode === 'SANDBOX' || scenario.testMode === 'SIMULATION' ? 'SUPPORTED' : 'DECLARED',
      Real: scenario.realWorldExecutionAllowed ? 'ELIGIBLE_WITH_POLICY' : 'NOT_ALLOWED',
      Foreground: scenario.supportedExecutionModes.includes('FOREGROUND') ? 'YES' : 'NO',
      Background: scenario.supportedExecutionModes.some((mode) => mode.startsWith('BACKGROUND')) ? 'YES' : 'NO',
      RuleCoverage: (scenario.ruleCoverage || []).join(', '),
      Evidence: scenario.verificationRules.join('; '),
      LastResult: last?.status ?? 'NOT_RUN',
      LastRun: last?.runId ?? '',
      Latency: last ? `${last.telemetry.total_ms}ms` : '',
      KnownLimitation: scenario.realWorldExecutionAllowed ? '' : 'REAL requires explicitly designated test target and policy eligibility.',
    };
  });
}

export function renderScenarioMatrixMarkdown(rows: ScenarioMatrixRow[]): string {
  const headers = ['Scenario', 'Category', 'Risk', 'Modalities', 'OriginDevice', 'ExecutionRoute', 'Simulation', 'Sandbox', 'Real', 'Foreground', 'Background', 'RuleCoverage', 'Evidence', 'LastResult', 'LastRun', 'Latency', 'KnownLimitation'];
  const escapeCell = (value: string) => value.replace(/\|/g, '\\|');
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${headers.map((header) => escapeCell(String(row[header as keyof ScenarioMatrixRow] ?? ''))).join(' | ')} |`),
  ].join('\n');
}

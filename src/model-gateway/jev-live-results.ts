import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ModelTaskKind } from './model-routing.types.js';
import type { JevComplexity, JevReasoningLevel } from './jev-shadow.types.js';

export const JEV_PARSER_VERSION = 'jev-parser-v2-noul-nullable';
export const JEV_SCORER_VERSION = 'jev-scorer-v2-ordinal-routing';
export const JEV_BENCHMARK_SCHEMA_VERSION = 'jev-benchmark-v2';

export type JevRoutingDecision = 'DEFAULT_MODEL' | 'CURRENT_ROUTE' | 'HIGH_REASONING_MODEL' | 'UNCERTAIN_RETAIN_CURRENT';
export type JevComplexityDirection = 'SAME' | 'DOWNGRADE' | 'UPGRADE' | 'UNCERTAIN';

export interface JevLiveResultRecord {
  fixtureId: string;
  taskKind: ModelTaskKind;
  goldComplexity: JevComplexity;
  goldReasoningLevel: JevReasoningLevel;
  jevComplexity: JevComplexity;
  jevComplexityConfidence: number;
  jevReasoningLevel: JevReasoningLevel;
  highRiskProbability: number | null;
  resolvedModel: string;
  latencyMs: number;
  complexityExactMatch: boolean;
  reasoningExactMatch: boolean;
  jointExactMatch: boolean;
  complexityDirection: JevComplexityDirection;
  routingDecisionGold: JevRoutingDecision;
  routingDecisionJev: JevRoutingDecision;
  routingDecisionMatch: boolean;
  parserVersion: string;
  scorerVersion: string;
  benchmarkSchemaVersion: string;
  providerErrorCode?: string;
}

export interface JevLiveSummary {
  benchmarkSchemaVersion: string;
  parserVersion: string;
  scorerVersion: string;
  fixtureCount: number;
  complexityExactAccuracy: number;
  reasoningLevelExactAccuracy: number;
  jointExactAccuracy: number;
  routingDecisionAccuracy: number;
  rawComplexityDowngradeCount: number;
  rawComplexityUpgradeCount: number;
  rawUncertainCount: number;
  standardToSimpleCount: number;
  highReasoningToStandardCount: number;
  highReasoningToSimpleCount: number;
}

const COMPLEXITY_ORDER: Record<Exclude<JevComplexity, 'UNCERTAIN'>, number> = {
  SIMPLE: 0,
  STANDARD: 1,
  HIGH_REASONING: 2,
};

export function routingDecisionFor(complexity: JevComplexity, highRiskProbability: number | null): JevRoutingDecision {
  if (complexity === 'UNCERTAIN') return 'UNCERTAIN_RETAIN_CURRENT';
  if (complexity === 'HIGH_REASONING' || (highRiskProbability ?? 0) >= 0.7) return 'HIGH_REASONING_MODEL';
  if (complexity === 'SIMPLE') return 'DEFAULT_MODEL';
  return 'CURRENT_ROUTE';
}

function isOrdinal(complexity: JevComplexity): complexity is Exclude<JevComplexity, 'UNCERTAIN'> {
  return complexity !== 'UNCERTAIN';
}

export function complexityDirection(goldComplexity: JevComplexity, jevComplexity: JevComplexity): JevComplexityDirection {
  if (goldComplexity === 'UNCERTAIN' || jevComplexity === 'UNCERTAIN') return 'UNCERTAIN';
  const gold = COMPLEXITY_ORDER[goldComplexity];
  const jev = COMPLEXITY_ORDER[jevComplexity];
  if (jev < gold) return 'DOWNGRADE';
  if (jev > gold) return 'UPGRADE';
  return 'SAME';
}

export function buildJevLiveResultRecord(input: {
  fixtureId: string;
  taskKind: ModelTaskKind;
  goldComplexity: JevComplexity;
  goldReasoningLevel: JevReasoningLevel;
  jevComplexity: JevComplexity;
  jevComplexityConfidence: number;
  jevReasoningLevel: JevReasoningLevel;
  highRiskProbability: number | null;
  resolvedModel: string;
  latencyMs: number;
  providerErrorCode?: string;
}): JevLiveResultRecord {
  const complexityExactMatch = input.goldComplexity === input.jevComplexity;
  const reasoningExactMatch = input.goldReasoningLevel === input.jevReasoningLevel;
  const routingDecisionGold = routingDecisionFor(input.goldComplexity, null);
  const routingDecisionJev = routingDecisionFor(input.jevComplexity, input.highRiskProbability);
  return {
    ...input,
    complexityExactMatch,
    reasoningExactMatch,
    jointExactMatch: complexityExactMatch && reasoningExactMatch,
    complexityDirection: complexityDirection(input.goldComplexity, input.jevComplexity),
    routingDecisionGold,
    routingDecisionJev,
    routingDecisionMatch: routingDecisionGold === routingDecisionJev,
    parserVersion: JEV_PARSER_VERSION,
    scorerVersion: JEV_SCORER_VERSION,
    benchmarkSchemaVersion: JEV_BENCHMARK_SCHEMA_VERSION,
  };
}

export function scoreJevLiveResults(records: JevLiveResultRecord[]): JevLiveSummary {
  let complexityMatches = 0;
  let reasoningMatches = 0;
  let jointMatches = 0;
  let routingMatches = 0;
  let rawComplexityDowngradeCount = 0;
  let rawComplexityUpgradeCount = 0;
  let rawUncertainCount = 0;
  let standardToSimpleCount = 0;
  let highReasoningToStandardCount = 0;
  let highReasoningToSimpleCount = 0;

  for (const record of records) {
    const complexityMatch = record.goldComplexity === record.jevComplexity;
    const reasoningMatch = record.goldReasoningLevel === record.jevReasoningLevel;
    if (complexityMatch) complexityMatches++;
    if (reasoningMatch) reasoningMatches++;
    if (complexityMatch && reasoningMatch) jointMatches++;
    if (record.routingDecisionGold === record.routingDecisionJev) routingMatches++;
    if (record.jevComplexity === 'UNCERTAIN') rawUncertainCount++;
    if (isOrdinal(record.goldComplexity) && isOrdinal(record.jevComplexity)) {
      const gold = COMPLEXITY_ORDER[record.goldComplexity];
      const jev = COMPLEXITY_ORDER[record.jevComplexity];
      if (jev < gold) rawComplexityDowngradeCount++;
      if (jev > gold) rawComplexityUpgradeCount++;
      if (record.goldComplexity === 'STANDARD' && record.jevComplexity === 'SIMPLE') standardToSimpleCount++;
      if (record.goldComplexity === 'HIGH_REASONING' && record.jevComplexity === 'STANDARD') highReasoningToStandardCount++;
      if (record.goldComplexity === 'HIGH_REASONING' && record.jevComplexity === 'SIMPLE') highReasoningToSimpleCount++;
    }
  }

  const count = records.length || 1;
  return {
    benchmarkSchemaVersion: JEV_BENCHMARK_SCHEMA_VERSION,
    parserVersion: JEV_PARSER_VERSION,
    scorerVersion: JEV_SCORER_VERSION,
    fixtureCount: records.length,
    complexityExactAccuracy: complexityMatches / count,
    reasoningLevelExactAccuracy: reasoningMatches / count,
    jointExactAccuracy: jointMatches / count,
    routingDecisionAccuracy: routingMatches / count,
    rawComplexityDowngradeCount,
    rawComplexityUpgradeCount,
    rawUncertainCount,
    standardToSimpleCount,
    highReasoningToStandardCount,
    highReasoningToSimpleCount,
  };
}

export async function persistJevLiveBenchmarkArtifacts(input: {
  records: JevLiveResultRecord[];
  resultsPath?: string;
  summaryPath?: string;
}): Promise<JevLiveSummary> {
  const resultsPath = input.resultsPath ?? 'artifacts/jev/jev-live-results.json';
  const summaryPath = input.summaryPath ?? 'artifacts/jev/jev-live-summary.json';
  const summary = scoreJevLiveResults(input.records);
  await mkdir(dirname(resultsPath), { recursive: true });
  await writeFile(resultsPath, `${JSON.stringify({
    benchmarkSchemaVersion: JEV_BENCHMARK_SCHEMA_VERSION,
    records: input.records,
  }, null, 2)}\n`);
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

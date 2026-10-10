import type { ModelRoutingDecision, ModelTaskKind } from './model-routing.types.js';
import { JEV_PARSER_VERSION, JEV_SCORER_VERSION } from './jev-live-results.js';
import {
  JEV_COMPLEXITIES,
  JEV_REASONING_LEVELS,
  JEV_SHADOW_REASON_CODES,
  type JevComplexity,
  type JevShadowInput,
  type JevShadowOutput,
  type JevShadowReasonCode,
  type JevShadowTelemetry,
  type JevAdvisoryRecord,
  type JevAdvisorySignalBucket,
} from './jev-shadow.types.js';

const complexitySet = new Set<string>(JEV_COMPLEXITIES);
const reasoningLevelSet = new Set<string>(JEV_REASONING_LEVELS);
const reasonCodeSet = new Set<string>(JEV_SHADOW_REASON_CODES);

function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function isHighReasoningDecision(complexity: JevComplexity, highRiskProbability: number | null): boolean {
  return complexity === 'HIGH_REASONING' || complexity === 'UNCERTAIN' || (highRiskProbability ?? 0) >= 0.7;
}

const COMPLEXITY_ORDER: Record<Exclude<JevComplexity, 'UNCERTAIN'>, number> = {
  SIMPLE: 0,
  STANDARD: 1,
  HIGH_REASONING: 2,
};

function complexityDirection(localHighReasoningRoute: boolean, jevComplexity: JevComplexity): JevAdvisoryRecord['complexityDirection'] {
  if (jevComplexity === 'UNCERTAIN') return 'UNCERTAIN';
  const localComplexity: Exclude<JevComplexity, 'UNCERTAIN'> = localHighReasoningRoute ? 'HIGH_REASONING' : 'STANDARD';
  const local = COMPLEXITY_ORDER[localComplexity];
  const jev = COMPLEXITY_ORDER[jevComplexity];
  if (jev < local) return 'DOWNGRADE';
  if (jev > local) return 'UPGRADE';
  return 'SAME';
}

function highRiskSignalBucket(value: number | null): JevAdvisorySignalBucket {
  if (value === null) return 'UNKNOWN_SIGNAL';
  if (value >= 0.7) return 'HIGH_SIGNAL';
  if (value >= 0.3) return 'MID_SIGNAL';
  return 'LOW_SIGNAL';
}

function taskReasonCode(taskKind: ModelTaskKind, requiresEvidenceGrounding?: boolean): JevShadowReasonCode {
  if (taskKind === 'PLAN') return 'MULTI_STEP_PLANNING';
  if (taskKind === 'RESEARCH_SYNTHESIS' || requiresEvidenceGrounding) return 'RESEARCH_SYNTHESIS';
  if (taskKind === 'MEETING_PREP') return 'MEETING_PREP';
  if (taskKind === 'STRUCTURED_EXTRACTION') return 'STRUCTURED_EXTRACTION';
  if (taskKind === 'CHAT') return 'DIRECT_CHAT';
  return 'OTHER';
}

export function validateJevShadowOutput(output: JevShadowOutput): JevShadowOutput {
  if (!complexitySet.has(output.complexity)) {
    throw new Error(`Invalid JEV shadow complexity: ${String(output.complexity)}`);
  }
  if (!reasoningLevelSet.has(output.reasoningLevel)) {
    throw new Error(`Invalid JEV shadow reasoningLevel: ${String(output.reasoningLevel)}`);
  }
  if (!reasonCodeSet.has(output.reasonCode)) {
    throw new Error(`Invalid JEV shadow reasonCode: ${String(output.reasonCode)}`);
  }
  for (const [name, value] of [
    ['complexityConfidence', output.complexityConfidence],
    ['reasoningConfidence', output.reasoningConfidence],
  ] as const) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`Invalid JEV shadow ${name}: ${String(value)}`);
    }
  }
  if (!output.resolvedModel.trim()) {
    throw new Error('Invalid JEV shadow resolvedModel.');
  }
  if (output.highRiskProbability !== null && (!Number.isFinite(output.highRiskProbability) || output.highRiskProbability < 0 || output.highRiskProbability > 1)) {
    throw new Error(`Invalid JEV shadow highRiskProbability: ${String(output.highRiskProbability)}`);
  }
  if (!Number.isFinite(output.latencyMs) || output.latencyMs < 0) {
    throw new Error(`Invalid JEV shadow latencyMs: ${String(output.latencyMs)}`);
  }
  return output;
}

export class JevShadowEvaluator {
  public evaluate(input: JevShadowInput): JevShadowOutput {
    const started = nowMs();
    const signals = input.signals ?? {};
    let complexity: JevComplexity = 'STANDARD';
    let complexityConfidence = 0.78;
    let highRiskProbability = 0.04;
    let reasoningLevel: JevShadowOutput['reasoningLevel'] = 'MODERATE';
    let reasoningConfidence = 0.78;
    let reasonCode: JevShadowReasonCode = taskReasonCode(input.taskKind, input.requiresEvidenceGrounding);

    if (signals.ambiguous) {
      complexity = 'UNCERTAIN';
      complexityConfidence = 0.72;
      reasoningLevel = 'MODERATE';
      reasonCode = 'AMBIGUOUS_REQUEST';
    } else if (signals.highRisk) {
      complexity = 'HIGH_REASONING';
      complexityConfidence = 0.9;
      highRiskProbability = 0.91;
      reasoningLevel = 'COMPLEX';
      reasoningConfidence = 0.88;
      reasonCode = 'CONSEQUENTIAL_ACTION';
    } else if (input.taskKind === 'RESEARCH_SYNTHESIS' || input.requiresEvidenceGrounding) {
      complexity = 'HIGH_REASONING';
      complexityConfidence = 0.88;
      reasoningLevel = 'COMPLEX';
      reasoningConfidence = 0.86;
      reasonCode = 'RESEARCH_SYNTHESIS';
    } else if (input.taskKind === 'MEETING_PREP') {
      complexity = 'HIGH_REASONING';
      complexityConfidence = 0.89;
      reasoningLevel = 'COMPLEX';
      reasoningConfidence = 0.87;
      reasonCode = 'MEETING_PREP';
    } else if (input.taskKind === 'PLAN' && (signals.multiStep || signals.longContext)) {
      complexity = 'HIGH_REASONING';
      complexityConfidence = 0.87;
      reasoningLevel = signals.longContext ? 'VERY_COMPLEX' : 'COMPLEX';
      reasoningConfidence = 0.86;
      reasonCode = 'MULTI_STEP_PLANNING';
    } else if (input.taskKind === 'CHAT' && signals.simple) {
      complexity = 'SIMPLE';
      complexityConfidence = 0.91;
      reasoningLevel = 'ROUTINE';
      reasoningConfidence = 0.9;
      reasonCode = 'DIRECT_CHAT';
    } else if (input.taskKind === 'DAILY_BRIEF') {
      complexity = 'STANDARD';
      complexityConfidence = 0.79;
      reasonCode = 'OTHER';
    } else if (input.taskKind === 'STRUCTURED_EXTRACTION' || input.requiresJson) {
      complexity = 'STANDARD';
      complexityConfidence = 0.84;
      reasonCode = 'STRUCTURED_EXTRACTION';
    } else if (input.taskKind === 'PLAN') {
      complexity = 'STANDARD';
      complexityConfidence = 0.82;
      reasonCode = 'MULTI_STEP_PLANNING';
    }

    return validateJevShadowOutput({
      complexity,
      complexityConfidence,
      highRiskProbability,
      reasoningLevel,
      reasoningConfidence,
      resolvedModel: 'deterministic-shadow',
      reasonCode,
      latencyMs: Math.max(0, nowMs() - started),
    });
  }
}

export function buildJevShadowTelemetry(input: {
  taskKind: ModelTaskKind;
  currentDecision: ModelRoutingDecision;
  currentModel: string | null;
  jev: JevShadowOutput;
}): JevShadowTelemetry {
  const currentHighReasoningRoute = input.currentDecision.selectedProvider === 'nebius';
  return {
    taskKind: input.taskKind,
    currentProvider: input.currentDecision.selectedProvider,
    currentModel: input.currentModel,
    jevDecision: input.jev.complexity,
    jevConfidence: input.jev.complexityConfidence,
    jevReasonCode: input.jev.reasonCode,
    reasoningLevel: input.jev.reasoningLevel,
    highRiskProbability: input.jev.highRiskProbability,
    agreement: currentHighReasoningRoute === isHighReasoningDecision(input.jev.complexity, input.jev.highRiskProbability),
    latencyMs: input.jev.latencyMs,
  };
}

export function buildJevAdvisoryRecord(input: {
  requestId: string;
  taskKind: ModelTaskKind;
  currentDecision: ModelRoutingDecision;
  jev: JevShadowOutput;
  observedAt?: string;
}): JevAdvisoryRecord {
  const currentHighReasoningRoute = input.currentDecision.selectedProvider === 'nebius';
  const routingAgreement = currentHighReasoningRoute === isHighReasoningDecision(input.jev.complexity, input.jev.highRiskProbability);
  return {
    requestId: input.requestId,
    taskKind: input.taskKind,
    localSelectedProvider: input.currentDecision.selectedProvider,
    localPreferredProvider: input.currentDecision.preferredProvider ?? null,
    jevComplexity: input.jev.complexity,
    jevComplexityConfidence: input.jev.complexityConfidence,
    jevReasoningLevel: input.jev.reasoningLevel,
    jevHighRiskProbability: input.jev.highRiskProbability,
    highRiskSignalBucket: highRiskSignalBucket(input.jev.highRiskProbability),
    routingAgreement,
    complexityDirection: complexityDirection(currentHighReasoningRoute, input.jev.complexity),
    resolvedJevModel: input.jev.resolvedModel,
    latencyMs: input.jev.latencyMs,
    parserVersion: JEV_PARSER_VERSION,
    scorerVersion: JEV_SCORER_VERSION,
    observedAt: input.observedAt ?? new Date().toISOString(),
  };
}

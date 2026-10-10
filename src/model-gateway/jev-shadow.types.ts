import type { ModelTaskKind } from './model-routing.types.js';

export const JEV_COMPLEXITIES = ['SIMPLE', 'STANDARD', 'HIGH_REASONING', 'UNCERTAIN'] as const;
export type JevComplexity = typeof JEV_COMPLEXITIES[number];

export const JEV_REASONING_LEVELS = ['ROUTINE', 'MODERATE', 'COMPLEX', 'VERY_COMPLEX'] as const;
export type JevReasoningLevel = typeof JEV_REASONING_LEVELS[number];

export const JEV_SHADOW_REASON_CODES = [
  'DIRECT_CHAT',
  'MULTI_STEP_PLANNING',
  'RESEARCH_SYNTHESIS',
  'MEETING_PREP',
  'STRUCTURED_EXTRACTION',
  'CONSEQUENTIAL_ACTION',
  'AMBIGUOUS_REQUEST',
  'OTHER',
] as const;
export type JevShadowReasonCode = typeof JEV_SHADOW_REASON_CODES[number];

export interface JevShadowSignals {
  simple?: boolean;
  multiStep?: boolean;
  longContext?: boolean;
  highRisk?: boolean;
  ambiguous?: boolean;
}

export interface JevShadowInput {
  fixtureId?: string;
  state?: unknown;
  taskKind: ModelTaskKind;
  requiresJson: boolean;
  requiresEvidenceGrounding?: boolean;
  signals?: JevShadowSignals;
  idempotencyKey?: string;
}

export interface JevShadowOutput {
  complexity: JevComplexity;
  complexityConfidence: number;
  highRiskProbability: number | null;
  reasoningLevel: JevReasoningLevel;
  reasoningConfidence: number;
  resolvedModel: string;
  reasonCode: JevShadowReasonCode;
  latencyMs: number;
}

export interface JevShadowTelemetry {
  taskKind: ModelTaskKind;
  currentProvider: string;
  currentModel: string | null;
  jevDecision: JevComplexity;
  jevConfidence: number;
  jevReasonCode: JevShadowReasonCode;
  reasoningLevel: JevReasoningLevel;
  highRiskProbability: number | null;
  agreement: boolean;
  latencyMs: number;
}

export type JevAdvisorySignalBucket = 'LOW_SIGNAL' | 'MID_SIGNAL' | 'HIGH_SIGNAL' | 'UNKNOWN_SIGNAL';

export interface JevAdvisoryRecord {
  requestId: string;
  taskKind: ModelTaskKind;
  localSelectedProvider: string;
  localPreferredProvider: string | null;
  jevComplexity: JevComplexity;
  jevComplexityConfidence: number;
  jevReasoningLevel: JevReasoningLevel;
  jevHighRiskProbability: number | null;
  highRiskSignalBucket: JevAdvisorySignalBucket;
  routingAgreement: boolean;
  complexityDirection: 'SAME' | 'DOWNGRADE' | 'UPGRADE' | 'UNCERTAIN';
  resolvedJevModel: string;
  latencyMs: number;
  parserVersion: string;
  scorerVersion: string;
  observedAt: string;
}

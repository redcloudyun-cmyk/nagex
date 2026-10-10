import type { ModelTaskKind } from './model-routing.types.js';
import type { JevComplexity, JevReasoningLevel, JevShadowReasonCode, JevShadowSignals } from './jev-shadow.types.js';

export interface JevShadowFixture {
  id: string;
  taskKind: ModelTaskKind;
  requiresJson: boolean;
  requiresEvidenceGrounding?: boolean;
  signals: JevShadowSignals;
  expectedComplexity: JevComplexity;
  expectedRiskClass: 'LOW' | 'HIGH';
  expectedReasoningLevel: JevReasoningLevel;
  expectedEscalationCandidate: boolean;
  expectedReasonCode: JevShadowReasonCode;
}

interface FixtureGroup {
  prefix: string;
  count: number;
  taskKind: ModelTaskKind;
  requiresJson?: boolean;
  requiresEvidenceGrounding?: boolean;
  signals: JevShadowSignals;
  expectedComplexity: JevComplexity;
  expectedRiskClass?: 'LOW' | 'HIGH';
  expectedReasoningLevel: JevReasoningLevel;
  expectedEscalationCandidate?: boolean;
  expectedReasonCode: JevShadowReasonCode;
}

const groups: FixtureGroup[] = [
  { prefix: 'chat-simple', count: 20, taskKind: 'CHAT', signals: { simple: true }, expectedComplexity: 'SIMPLE', expectedReasoningLevel: 'ROUTINE', expectedReasonCode: 'DIRECT_CHAT' },
  { prefix: 'chat-ambiguous', count: 10, taskKind: 'CHAT', signals: { ambiguous: true }, expectedComplexity: 'UNCERTAIN', expectedReasoningLevel: 'MODERATE', expectedEscalationCandidate: true, expectedReasonCode: 'AMBIGUOUS_REQUEST' },
  { prefix: 'plan-light', count: 18, taskKind: 'PLAN', signals: { simple: true }, expectedComplexity: 'STANDARD', expectedReasoningLevel: 'MODERATE', expectedReasonCode: 'MULTI_STEP_PLANNING' },
  { prefix: 'plan-multistep', count: 12, taskKind: 'PLAN', signals: { multiStep: true }, expectedComplexity: 'HIGH_REASONING', expectedReasoningLevel: 'COMPLEX', expectedEscalationCandidate: true, expectedReasonCode: 'MULTI_STEP_PLANNING' },
  { prefix: 'plan-long', count: 8, taskKind: 'PLAN', signals: { longContext: true }, expectedComplexity: 'HIGH_REASONING', expectedReasoningLevel: 'VERY_COMPLEX', expectedEscalationCandidate: true, expectedReasonCode: 'MULTI_STEP_PLANNING' },
  { prefix: 'research', count: 15, taskKind: 'RESEARCH_SYNTHESIS', requiresEvidenceGrounding: true, signals: { multiStep: true }, expectedComplexity: 'HIGH_REASONING', expectedReasoningLevel: 'COMPLEX', expectedEscalationCandidate: true, expectedReasonCode: 'RESEARCH_SYNTHESIS' },
  { prefix: 'meeting', count: 15, taskKind: 'MEETING_PREP', signals: { multiStep: true }, expectedComplexity: 'HIGH_REASONING', expectedReasoningLevel: 'COMPLEX', expectedEscalationCandidate: true, expectedReasonCode: 'MEETING_PREP' },
  { prefix: 'extract', count: 10, taskKind: 'STRUCTURED_EXTRACTION', requiresJson: true, signals: {}, expectedComplexity: 'STANDARD', expectedReasoningLevel: 'MODERATE', expectedReasonCode: 'STRUCTURED_EXTRACTION' },
  { prefix: 'brief', count: 10, taskKind: 'DAILY_BRIEF', requiresJson: true, signals: {}, expectedComplexity: 'STANDARD', expectedReasoningLevel: 'MODERATE', expectedReasonCode: 'OTHER' },
  { prefix: 'high-risk', count: 10, taskKind: 'PLAN', signals: { highRisk: true, multiStep: true }, expectedComplexity: 'HIGH_REASONING', expectedRiskClass: 'HIGH', expectedReasoningLevel: 'COMPLEX', expectedEscalationCandidate: true, expectedReasonCode: 'CONSEQUENTIAL_ACTION' },
  { prefix: 'extract-ambiguous', count: 5, taskKind: 'STRUCTURED_EXTRACTION', requiresJson: true, signals: { ambiguous: true }, expectedComplexity: 'UNCERTAIN', expectedReasoningLevel: 'MODERATE', expectedEscalationCandidate: true, expectedReasonCode: 'AMBIGUOUS_REQUEST' },
];

export const JEV_SHADOW_FIXTURES: JevShadowFixture[] = groups.flatMap((group) =>
  Array.from({ length: group.count }, (_, index) => ({
    id: `${group.prefix}-${String(index + 1).padStart(3, '0')}`,
    taskKind: group.taskKind,
    requiresJson: group.requiresJson ?? false,
    ...(group.requiresEvidenceGrounding !== undefined ? { requiresEvidenceGrounding: group.requiresEvidenceGrounding } : {}),
    signals: group.signals,
    expectedComplexity: group.expectedComplexity,
    expectedRiskClass: group.expectedRiskClass ?? 'LOW',
    expectedReasoningLevel: group.expectedReasoningLevel,
    expectedEscalationCandidate: group.expectedEscalationCandidate ?? false,
    expectedReasonCode: group.expectedReasonCode,
  }))
);

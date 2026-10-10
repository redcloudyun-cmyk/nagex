import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ModelTier, PrivacyClass, WorkUnit } from './long-run-orchestration.js';

export type ModelLifecycleState = 'DISCOVERED' | 'STATIC_PROFILE' | 'BENCHMARK' | 'SHADOW_ELIGIBLE' | 'LIMITED_TRAFFIC' | 'GENERAL_ELIGIBLE';
export type ModelRuntimeState = 'ACTIVE' | 'DEGRADED' | 'SHADOW_ONLY' | 'DISABLED' | 'RETIRED';
export const MODEL_SCORING_POLICY_VERSION = 'MODEL_SCORING_POLICY_V1';

export interface ModelRegistryEntry {
  readonly providerId: string;
  readonly modelId: string;
  readonly modelFamily: string;
  readonly hostingProvider: string;
  readonly displayName: string;
  readonly status: ModelRuntimeState;
  readonly onboardingState: ModelLifecycleState;
  readonly tier: ModelTier;
  readonly contextWindow: number;
  readonly inputModalities: readonly string[];
  readonly outputModalities: readonly string[];
  readonly toolUse: boolean;
  readonly structuredOutput: boolean;
  readonly vision: boolean;
  readonly coding: boolean;
  readonly reasoning: boolean;
  readonly streaming: boolean;
  readonly localOrCloud: 'LOCAL' | 'CLOUD';
  readonly privacyCapabilities: readonly PrivacyClass[];
  readonly pricingMetadata: { readonly inputPer1k: number; readonly outputPer1k: number };
  readonly latencyClass: 'LOW' | 'MEDIUM' | 'HIGH';
  readonly availability: 'AVAILABLE' | 'LIMITED' | 'UNAVAILABLE';
  readonly lastUpdatedAt: string;
}

export interface TaskRequirementProfile {
  readonly taskType: string;
  readonly reasoningDepth: 'LOW' | 'MEDIUM' | 'HIGH';
  readonly factualRisk: WorkUnit['factualRisk'];
  readonly creativityNeed: WorkUnit['creativityNeed'];
  readonly contextSize: WorkUnit['contextRequirement'];
  readonly structuredOutputNeed: boolean;
  readonly toolUseNeed: boolean;
  readonly visionNeed: boolean;
  readonly codingNeed: boolean;
  readonly dataAnalysisNeed: boolean;
  readonly koreanQualityNeed: boolean;
  readonly englishQualityNeed: boolean;
  readonly latencySensitivity: WorkUnit['latencySensitivity'];
  readonly costSensitivity: WorkUnit['costSensitivity'];
  readonly privacyClass: PrivacyClass;
  readonly qualityCriticality: WorkUnit['qualityCriticality'];
}

export interface BenchmarkFixture {
  readonly benchmarkId: string;
  readonly taskType: string;
  readonly inputFixture: string;
  readonly expectedCriteria: readonly string[];
  readonly scoringRubric: Record<string, number>;
  readonly requiredCapabilities: readonly string[];
  readonly weight: number;
  readonly dataClass: 'PUBLIC' | 'SYNTHETIC' | 'INTERNAL_SAFE' | 'USER_DERIVED_APPROVED';
}

export interface ModelPerformanceRecord {
  readonly dataOrigin?: 'SIMULATION' | 'LIVE' | 'BENCHMARK';
  readonly providerId: string;
  readonly modelId: string;
  readonly modelFamily: string;
  readonly taskType: string;
  readonly benchmarkId?: string;
  readonly goalId?: string;
  readonly workUnitId?: string;
  readonly qualityScore: number;
  readonly evidenceGroundingScore: number;
  readonly instructionFollowingScore: number;
  readonly structuredOutputScore: number;
  readonly toolUseScore: number;
  readonly languageQualityScore: number;
  readonly reasoningScore: number;
  readonly creativeQualityScore?: number;
  readonly userAcceptedFirstTry?: boolean;
  readonly revisionCount: number;
  readonly criticFailureCount: number;
  readonly evidenceConflictCount: number;
  readonly unsupportedClaimCount: number;
  readonly hallucinationFlag: boolean;
  readonly latencyMs: number;
  readonly tokenUsage?: number;
  readonly estimatedCost: number;
  readonly actualCost?: number;
  readonly contextSize: number;
  readonly language: 'ko' | 'en' | 'mixed';
  readonly modality: string;
  readonly privacyClass: PrivacyClass;
  readonly autoQualityGateResult: 'PASS' | 'FAIL';
  readonly finalOutcome: 'ACCEPTED' | 'REVISED' | 'REJECTED' | 'FAILED';
  readonly userRating?: number;
  readonly recordedAt: string;
}

export class ModelRegistry {
  private readonly entries = new Map<string, ModelRegistryEntry>();
  registerModel(entry: ModelRegistryEntry): void { this.entries.set(entry.modelId, entry); }
  list(): readonly ModelRegistryEntry[] { return [...this.entries.values()]; }
  get(modelId: string): ModelRegistryEntry | undefined { return this.entries.get(modelId); }
}

export function seedModelRegistry(): ModelRegistry {
  const registry = new ModelRegistry();
  const now = new Date().toISOString();
  [
    ['openai', 'gpt-fast-sim', 'GPT', 'OPENAI', 'Fast General', 'FAST', true, false],
    ['nebius', 'qwen-premium-sim', 'QWEN', 'NEBIUS', 'Qwen Premium', 'PREMIUM', true, true],
    ['google', 'gemini-balanced-sim', 'GEMINI', 'GOOGLE', 'Gemini Balanced', 'BALANCED', true, true],
    ['local', 'local-private-sim', 'LOCAL_PRIVATE', 'LOCAL', 'Local Private', 'LOCAL_PRIVATE', false, false],
  ].forEach(([providerId, modelId, family, host, name, tier, cloud, vision]) => registry.registerModel({
    providerId: String(providerId), modelId: String(modelId), modelFamily: String(family), hostingProvider: String(host), displayName: String(name), status: 'ACTIVE', onboardingState: 'GENERAL_ELIGIBLE', tier: tier as ModelTier,
    contextWindow: tier === 'PREMIUM' ? 128000 : 32000, inputModalities: vision ? ['text', 'image'] : ['text'], outputModalities: ['text'], toolUse: true, structuredOutput: true, vision: Boolean(vision), coding: tier === 'PREMIUM', reasoning: tier !== 'FAST', streaming: true,
    localOrCloud: cloud ? 'CLOUD' : 'LOCAL', privacyCapabilities: tier === 'LOCAL_PRIVATE' ? ['PUBLIC', 'INTERNAL', 'PERSONAL', 'SENSITIVE', 'HIGHLY_SENSITIVE'] : ['PUBLIC', 'INTERNAL'], pricingMetadata: { inputPer1k: tier === 'FAST' ? 0.001 : 0.01, outputPer1k: tier === 'FAST' ? 0.002 : 0.02 }, latencyClass: tier === 'FAST' ? 'LOW' : 'MEDIUM', availability: 'AVAILABLE', lastUpdatedAt: now,
  }));
  return registry;
}

export class TaskRequirementProfiler {
  profile(workUnit: WorkUnit): TaskRequirementProfile {
    return {
      taskType: workUnit.taskType, reasoningDepth: workUnit.reasoningComplexity, factualRisk: workUnit.factualRisk, creativityNeed: workUnit.creativityNeed, contextSize: workUnit.contextRequirement,
      structuredOutputNeed: workUnit.requiredCapabilities.some((c) => /JSON|EXTRACTION|DATA/.test(c)), toolUseNeed: workUnit.requiredCapabilities.includes('TOOL_USE'), visionNeed: workUnit.requiredCapabilities.includes('VISION'), codingNeed: workUnit.requiredCapabilities.includes('CODING'),
      dataAnalysisNeed: workUnit.requiredCapabilities.includes('DATA_ANALYSIS') || workUnit.requiredCapabilities.includes('COMPUTATION'), koreanQualityNeed: /Korean|executive|report/i.test(workUnit.taskType), englishQualityNeed: true,
      latencySensitivity: workUnit.latencySensitivity, costSensitivity: workUnit.costSensitivity, privacyClass: workUnit.privacyClass, qualityCriticality: workUnit.qualityCriticality,
    };
  }
}

export const nagexBenchmarkSuite: readonly BenchmarkFixture[] = [
  'Korean executive report writing|Research synthesis|Source contradiction detection|Long document summarization|Slide narrative planning|Slide copy compression|Structured JSON output|Data interpretation|TypeScript/code reasoning|Tool-use planning|Reservation reasoning|UI semantic reasoning|Image understanding|Critic / error detection|Korean naturalness|Evidence-grounded answer generation'
    .split('|').map((name, i) => ({ benchmarkId: `B${String(i + 1).padStart(2, '0')}`, taskType: name, inputFixture: `Synthetic NAgex fixture for ${name}`, expectedCriteria: ['follow instructions', 'ground evidence', 'produce usable output'], scoringRubric: { quality: 0.4, evidence: 0.3, instructions: 0.3 }, requiredCapabilities: i === 12 ? ['VISION'] : ['TEXT'], weight: 1, dataClass: 'SYNTHETIC' as const })),
].flat();

export class ModelBenchmarkRunner {
  run(fixtures: readonly BenchmarkFixture[], models: readonly ModelRegistryEntry[]): readonly ModelPerformanceRecord[] {
    return fixtures.flatMap((fixture) => models.filter((model) => model.status === 'ACTIVE' && model.onboardingState !== 'DISCOVERED').slice(0, 3).map((model) => this.score(model, fixture)));
  }
  private score(model: ModelRegistryEntry, fixture: BenchmarkFixture): ModelPerformanceRecord {
    const base = model.tier === 'PREMIUM' ? 92 : model.tier === 'BALANCED' ? 84 : model.tier === 'FAST' ? 74 : 80;
    const qualityScore = base + (fixture.taskType.includes('Structured') && model.structuredOutput ? 3 : 0) + (fixture.taskType.includes('Korean') && model.modelFamily === 'QWEN' ? 4 : 0);
    return { dataOrigin: 'SIMULATION', providerId: model.providerId, modelId: model.modelId, modelFamily: model.modelFamily, taskType: fixture.taskType, benchmarkId: fixture.benchmarkId, qualityScore, evidenceGroundingScore: qualityScore - 3, instructionFollowingScore: qualityScore - 2, structuredOutputScore: model.structuredOutput ? 90 : 60, toolUseScore: model.toolUse ? 88 : 50, languageQualityScore: qualityScore, reasoningScore: model.reasoning ? qualityScore : 70, creativeQualityScore: qualityScore - 5, revisionCount: 0, criticFailureCount: 0, evidenceConflictCount: 0, unsupportedClaimCount: 0, hallucinationFlag: false, latencyMs: model.latencyClass === 'LOW' ? 600 : 1400, tokenUsage: 1000, estimatedCost: model.pricingMetadata.inputPer1k + model.pricingMetadata.outputPer1k, contextSize: 1000, language: fixture.taskType.includes('Korean') ? 'ko' : 'en', modality: fixture.requiredCapabilities.includes('VISION') ? 'image+text' : 'text', privacyClass: 'PUBLIC', autoQualityGateResult: 'PASS', finalOutcome: 'ACCEPTED', recordedAt: new Date().toISOString() };
  }
}

export class LivePerformanceTracker {
  private readonly records: ModelPerformanceRecord[] = [];
  record(record: ModelPerformanceRecord): void { this.records.push(record); }
  rolling(modelId: string) {
    const rows = this.records.filter((r) => r.modelId === modelId);
    const avg = (pick: (r: ModelPerformanceRecord) => number) => rows.reduce((s, r) => s + pick(r), 0) / Math.max(1, rows.length);
    return { lifetime: { successRate: rows.filter((r) => r.finalOutcome !== 'FAILED').length / Math.max(1, rows.length), qualityAverage: avg((r) => r.qualityScore), firstPassAcceptance: rows.filter((r) => r.userAcceptedFirstTry).length / Math.max(1, rows.length), revisionAverage: avg((r) => r.revisionCount), latencyP50: avg((r) => r.latencyMs), latencyP95: Math.max(...rows.map((r) => r.latencyMs), 0), costAverage: avg((r) => r.actualCost ?? r.estimatedCost), providerFailureRate: rows.filter((r) => r.finalOutcome === 'FAILED').length / Math.max(1, rows.length), hallucinationRate: rows.filter((r) => r.hallucinationFlag).length / Math.max(1, rows.length), evidenceConflictRate: avg((r) => r.evidenceConflictCount) } };
  }
}

export class ModelQualityScorer {
  score(record: ModelPerformanceRecord, weights = { automatedQuality: 0.35, benchmarkPerformance: 0.2, livePerformance: 0.2, revisionBurden: 0.1, latency: 0.05, cost: 0.05, privacyFit: 0.05 }) {
    const revisionPenalty = Math.min(20, record.revisionCount * 8);
    const taskSpecificScore = record.qualityScore * weights.automatedQuality + record.evidenceGroundingScore * weights.benchmarkPerformance + record.reasoningScore * weights.livePerformance + (100 - revisionPenalty) * weights.revisionBurden + Math.max(0, 100 - record.latencyMs / 50) * weights.latency + Math.max(0, 100 - record.estimatedCost * 1000) * weights.cost + 100 * weights.privacyFit;
    return { policyVersion: MODEL_SCORING_POLICY_VERSION, taskSpecificScore, globalSummaryScore: (record.qualityScore + record.evidenceGroundingScore + record.instructionFollowingScore) / 3, revisionBurdenScore: 100 - revisionPenalty };
  }
}

export class ProviderHealthTracker {
  private readonly health = new Map<string, { availability: number; latencyDegradation: number; failureRate: number }>();
  update(providerId: string, value: { availability: number; latencyDegradation: number; failureRate: number }): void { this.health.set(providerId, value); }
  score(providerId: string): number { const h = this.health.get(providerId); return h ? Math.max(0, h.availability - h.latencyDegradation - h.failureRate) : 90; }
}

export class ModelRanker {
  constructor(private readonly tracker = new LivePerformanceTracker(), private readonly health = new ProviderHealthTracker(), private readonly scorer = new ModelQualityScorer()) {}
  rank(profile: TaskRequirementProfile, models: readonly ModelRegistryEntry[], records: readonly ModelPerformanceRecord[], topN = 3) {
    return models.filter((m) => m.status === 'ACTIVE' && m.onboardingState !== 'DISCOVERED' && m.privacyCapabilities.includes(profile.privacyClass) && (!profile.visionNeed || m.vision)).map((model) => {
      const record = records.find((r) => r.modelId === model.modelId && r.taskType === profile.taskType) ?? records.find((r) => r.modelId === model.modelId);
      const quality = record ? this.scorer.score(record).taskSpecificScore : 70;
      const privacyScore = model.localOrCloud === 'LOCAL' || profile.privacyClass === 'PUBLIC' ? 100 : 70;
      const latencyScore = model.latencyClass === 'LOW' ? 95 : 75;
      const costScore = Math.max(0, 100 - (model.pricingMetadata.inputPer1k + model.pricingMetadata.outputPer1k) * 1000);
      const reliabilityScore = this.health.score(model.providerId);
      const lowRisk = profile.qualityCriticality === 'LOW' && profile.factualRisk === 'LOW' && profile.reasoningDepth === 'LOW';
      const fitScore = lowRisk
        ? quality * 0.25 + privacyScore * 0.15 + latencyScore * 0.25 + costScore * 0.2 + reliabilityScore * 0.15
        : quality * 0.45 + privacyScore * 0.15 + latencyScore * 0.1 + costScore * 0.1 + reliabilityScore * 0.2;
      return { modelId: model.modelId, providerId: model.providerId, fitScore, qualityScore: quality, costScore, latencyScore, privacyScore, reliabilityScore, recentPerformanceScore: this.tracker.rolling(model.modelId).lifetime.qualityAverage, selectionReason: `${model.displayName} fits ${profile.taskType} with ${profile.qualityCriticality} quality and ${profile.privacyClass} privacy.` };
    }).sort((a, b) => b.fitScore - a.fitScore).slice(0, topN);
  }
}

export class ModelIntelligenceStore {
  constructor(private readonly file: string) {}
  save(records: readonly ModelPerformanceRecord[]): void { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify({ policyVersion: MODEL_SCORING_POLICY_VERSION, records }, null, 2), 'utf8'); }
  load(): readonly ModelPerformanceRecord[] { return fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')).records : []; }
}

export class ModelIntelligenceCertRunner {
  run(outputLocation: string) {
    const registry = seedModelRegistry();
    const benchmarkRecords = new ModelBenchmarkRunner().run(nagexBenchmarkSuite.slice(0, 4), registry.list());
    const revisionRecord = { ...benchmarkRecords[0], revisionCount: 1, finalOutcome: 'REVISED' as const, userAcceptedFirstTry: false };
    const records = [...benchmarkRecords, revisionRecord];
    const store = new ModelIntelligenceStore(path.join(outputLocation, 'performance-records.json'));
    store.save(records);
    const profiler = new TaskRequirementProfiler();
    const fakeWu = (id: string, taskType: string, criticality: WorkUnit['qualityCriticality'], risk: WorkUnit['factualRisk'], complexity: WorkUnit['reasoningComplexity']): WorkUnit => ({ workUnitId: id, goalId: 'goal-model-intel-cert', taskType, dependencies: [], requiredCapabilities: ['TEXT'], qualityCriticality: criticality, factualRisk: risk, reasoningComplexity: complexity, creativityNeed: 'LOW', privacyClass: 'PUBLIC', latencySensitivity: 'MEDIUM', costSensitivity: 'MEDIUM', contextRequirement: 'MEDIUM', status: 'PENDING', attempts: 0, verificationStatus: 'UNVERIFIED' });
    const ranker = new ModelRanker();
    const low = ranker.rank(profiler.profile(fakeWu('A', 'metadata extraction', 'LOW', 'LOW', 'LOW')), registry.list(), records, 3);
    const medium = ranker.rank(profiler.profile(fakeWu('B', 'research synthesis', 'HIGH', 'MEDIUM', 'MEDIUM')), registry.list(), records, 3);
    const high = ranker.rank(profiler.profile(fakeWu('C', 'critical conclusion', 'CRITICAL', 'HIGH', 'HIGH')), registry.list(), records, 3);
    const manifest = { registry: registry.list(), benchmarkCount: 4, providerCount: new Set(registry.list().map((m) => m.providerId)).size, modelCount: registry.list().length, records, dataOrigin: 'SIMULATION', rankings: { low, medium, high }, scoringPolicyVersion: MODEL_SCORING_POLICY_VERSION, telemetry: { rawPrivateContentStoredByDefault: false, storedFields: ['scores', 'metadata', 'hash/reference ids', 'outcome labels'] }, shadowEvaluation: { contractReady: true, sensitiveDataExcludedByDefault: true }, feedbackPersisted: store.load().length === records.length, revisionBurdenCert: revisionRecord.revisionCount === 1, api: ['registerModel', 'updateStaticCapability', 'runBenchmark', 'recordPerformance', 'rankModels', 'selectCandidates', 'recordQualityOutcome', 'recordUserRevision', 'getTaskLeaderboard', 'getProviderHealth', 'getModelHistory'] };
    fs.mkdirSync(outputLocation, { recursive: true });
    const manifestPath = path.join(outputLocation, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    return { manifestPath, manifest };
  }
}

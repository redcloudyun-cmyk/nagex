import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  LivePerformanceTracker,
  MODEL_SCORING_POLICY_VERSION,
  ModelBenchmarkRunner,
  ModelIntelligenceCertRunner,
  ModelQualityScorer,
  ModelRanker,
  ProviderHealthTracker,
  TaskRequirementProfiler,
  nagexBenchmarkSuite,
  seedModelRegistry,
  type WorkUnit,
} from '../src/creation-agent/index.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-model-intel-'));
}

function wu(overrides: Partial<WorkUnit> = {}): WorkUnit {
  return { workUnitId: 'WU', goalId: 'G', taskType: 'Structured JSON output', dependencies: [], requiredCapabilities: ['DATA_ANALYSIS'], qualityCriticality: 'HIGH', factualRisk: 'MEDIUM', reasoningComplexity: 'MEDIUM', creativityNeed: 'LOW', privacyClass: 'PUBLIC', latencySensitivity: 'MEDIUM', costSensitivity: 'MEDIUM', contextRequirement: 'MEDIUM', status: 'PENDING', attempts: 0, verificationStatus: 'UNVERIFIED', ...overrides };
}

test('model registry separates provider, model family, model id, and hosting provider', () => {
  const qwen = seedModelRegistry().get('qwen-premium-sim')!;
  assert.equal(qwen.providerId, 'nebius');
  assert.equal(qwen.modelFamily, 'QWEN');
  assert.equal(qwen.hostingProvider, 'NEBIUS');
  assert.notEqual(qwen.providerId.toUpperCase(), qwen.modelFamily);
});

test('task requirement profiler maps WorkUnit risk and capabilities', () => {
  const profile = new TaskRequirementProfiler().profile(wu());
  assert.equal(profile.structuredOutputNeed, true);
  assert.equal(profile.dataAnalysisNeed, true);
  assert.equal(profile.qualityCriticality, 'HIGH');
});

test('benchmark suite has all required NAgex categories and safe data governance', () => {
  assert.equal(nagexBenchmarkSuite.length, 16);
  assert.ok(nagexBenchmarkSuite.every((fixture) => fixture.dataClass === 'SYNTHETIC'));
});

test('benchmark runner records performance without raw private content', () => {
  const records = new ModelBenchmarkRunner().run(nagexBenchmarkSuite.slice(0, 2), seedModelRegistry().list());
  assert.equal(records.length >= 2, true);
  assert.ok(records.every((record) => record.qualityScore > 0 && record.providerId && record.modelFamily));
  assert.ok(records.every((record) => record.dataOrigin === 'SIMULATION'));
});

test('live performance tracker reports rolling metrics and revision burden', () => {
  const record = new ModelBenchmarkRunner().run(nagexBenchmarkSuite.slice(0, 1), seedModelRegistry().list())[0];
  const tracker = new LivePerformanceTracker();
  tracker.record({ ...record, revisionCount: 1, userAcceptedFirstTry: false, finalOutcome: 'REVISED' });
  const metrics = tracker.rolling(record.modelId).lifetime;
  assert.equal(metrics.revisionAverage, 1);
  assert.equal(metrics.successRate, 1);
});

test('quality scorer exposes versioned effective and task-specific scores', () => {
  const record = new ModelBenchmarkRunner().run(nagexBenchmarkSuite.slice(0, 1), seedModelRegistry().list())[0];
  const score = new ModelQualityScorer().score({ ...record, revisionCount: 1 });
  assert.equal(score.policyVersion, MODEL_SCORING_POLICY_VERSION);
  assert.equal(score.taskSpecificScore > 0, true);
  assert.equal(score.revisionBurdenScore < 100, true);
});

test('model ranker returns top-n task-specific candidates with explainable routing', () => {
  const registry = seedModelRegistry();
  const records = new ModelBenchmarkRunner().run(nagexBenchmarkSuite.slice(0, 4), registry.list());
  const ranked = new ModelRanker().rank(new TaskRequirementProfiler().profile(wu({ taskType: 'Research synthesis' })), registry.list(), records, 3);
  assert.equal(ranked.length, 3);
  assert.ok(ranked[0].selectionReason.includes('Research synthesis'));
});

test('provider health weighting and same-tier failover influence ranking', () => {
  const registry = seedModelRegistry();
  const health = new ProviderHealthTracker();
  health.update('nebius', { availability: 30, latencyDegradation: 10, failureRate: 20 });
  const records = new ModelBenchmarkRunner().run(nagexBenchmarkSuite.slice(0, 4), registry.list());
  const ranked = new ModelRanker(new LivePerformanceTracker(), health).rank(new TaskRequirementProfiler().profile(wu({ taskType: 'Source contradiction detection', factualRisk: 'HIGH', reasoningComplexity: 'HIGH' })), registry.list(), records, 3);
  assert.notEqual(ranked[0].providerId, 'nebius');
});

test('privacy profile routes sensitive tasks to local-private eligible model', () => {
  const registry = seedModelRegistry();
  const ranked = new ModelRanker().rank(new TaskRequirementProfiler().profile(wu({ privacyClass: 'SENSITIVE' })), registry.list(), [], 3);
  assert.equal(ranked[0].modelId, 'local-private-sim');
});

test('cert runner persists feedback, revision burden, shadow contract and API model', () => {
  const result = new ModelIntelligenceCertRunner().run(tempDir());
  assert.equal(fs.existsSync(result.manifestPath), true);
  assert.equal(result.manifest.feedbackPersisted, true);
  assert.equal(result.manifest.revisionBurdenCert, true);
  assert.equal(result.manifest.dataOrigin, 'SIMULATION');
  assert.equal(result.manifest.shadowEvaluation.contractReady, true);
  assert.ok(result.manifest.api.includes('rankModels'));
});

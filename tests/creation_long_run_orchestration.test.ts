import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ContextCompactor,
  DeterministicDataAnalysisEngine,
  EvidenceGraphBuilder,
  JevDeliberationEngine,
  LongRunCreationCertRunner,
  ModelCapabilityRouter,
} from '../src/creation-agent/index.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-long-run-'));
}

test('JEV decomposes long-run goal into explicit workunit DAG but is not authority or truth source', () => {
  const units = new JevDeliberationEngine().decompose('goal1', 'research and create');
  assert.equal(units.length >= 11, true);
  assert.equal(units[0].taskType, 'Classify request and metadata');
  assert.ok(units.some((unit) => unit.taskType === 'Define research questions'));
  assert.ok(units.some((unit) => unit.dependencies.includes('WU09')));
});

test('JEV replan inserts targeted source repair without restarting all work', () => {
  const jev = new JevDeliberationEngine();
  const units = jev.replan(jev.decompose('goal1', 'research and create'), 'CONTRADICTION');
  assert.ok(units.some((unit) => unit.workUnitId === 'WU02B'));
  assert.ok(units.find((unit) => unit.workUnitId === 'WU03')?.dependencies.includes('WU02B'));
});

test('model router selects step-specific tiers and escalates on quality failure', () => {
  const units = new JevDeliberationEngine().decompose('goal1', 'research and create');
  const router = new ModelCapabilityRouter();
  const fast = router.route({ ...units[0], taskType: 'Document classification', qualityCriticality: 'LOW', factualRisk: 'LOW', reasoningComplexity: 'LOW', requiredCapabilities: ['CLASSIFICATION'] });
  const premium = router.route(units.find((unit) => unit.workUnitId === 'WU05')!);
  const specialist = router.route(units.find((unit) => unit.workUnitId === 'WU10')!);
  assert.equal(fast.selectedTier, 'FAST');
  assert.equal(premium.selectedTier, 'PREMIUM');
  assert.equal(specialist.selectedTier, 'SPECIALIST');
  assert.equal(router.escalate(fast, 'LOW_CONFIDENCE').qualityResult, 'ESCALATED');
});

test('privacy-aware routing sends sensitive preprocessing to local private tier', () => {
  const unit = new JevDeliberationEngine().decompose('goal1', 'private', 'SENSITIVE')[0];
  assert.equal(new ModelCapabilityRouter().route(unit).selectedTier, 'LOCAL_PRIVATE');
});

test('provider failover keeps the same tier when primary provider is unhealthy', () => {
  const unit = new JevDeliberationEngine().decompose('goal1', 'research').find((wu) => wu.workUnitId === 'WU05')!;
  const decision = new ModelCapabilityRouter().route(unit, [
    { providerId: 'premium-a', tier: 'PREMIUM', healthy: false },
    { providerId: 'premium-b', tier: 'PREMIUM', healthy: true },
  ]);
  assert.equal(decision.selectedTier, 'PREMIUM');
  assert.equal(decision.selectedProvider, 'premium-b');
});

test('evidence graph separates facts, inferences, contradictions, sources and unknowns', () => {
  const dir = tempDir();
  const file = path.join(dir, 'source.md');
  fs.writeFileSync(file, 'Source fact one\nSource fact two', 'utf8');
  const graph = new EvidenceGraphBuilder().build([file]);
  assert.equal(graph.sources.length, 1);
  assert.ok(graph.claims.some((claim) => claim.classification === 'MODEL_INFERENCE'));
  assert.ok(graph.evidence.every((evidence) => evidence.classification === 'SOURCE_FACT'));
  assert.equal(graph.contradictions.length, 1);
});

test('deterministic data engine computes aggregates instead of relying on LLM arithmetic', () => {
  const file = path.join(tempDir(), 'data.csv');
  fs.writeFileSync(file, 'segment,value\na,10\nb,20\n', 'utf8');
  const result = new DeterministicDataAnalysisEngine().analyzeCsv(file);
  assert.equal(result.rowCount, 2);
  assert.equal(result.aggregates.total, 30);
  assert.equal(result.aggregates.average, 15);
});

test('context compaction preserves evidence references and source-of-truth lineage', () => {
  const file = path.join(tempDir(), 'source.md');
  fs.writeFileSync(file, 'Source fact one', 'utf8');
  const compacted = new ContextCompactor().compact(new EvidenceGraphBuilder().build([file]));
  assert.match(compacted.summaryContext, /sources/);
  assert.ok(compacted.evidenceRefs.length > 0);
});

test('long-run cert runner creates checkpoints, artifacts and manifest', () => {
  const result = new LongRunCreationCertRunner().run(tempDir());
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
  assert.equal(result.goal.status, 'COMPLETED');
  assert.equal(result.goal.checkpoints.length, 9);
  assert.ok(fs.existsSync(result.reportFile));
  assert.ok(fs.existsSync(result.slideFile));
  assert.ok(fs.existsSync(result.imageFile));
  assert.ok(fs.existsSync(result.videoFile));
  assert.equal(manifest.qualityGates.final, 'PASS');
});

test('dynamic goal revision, partial recovery and authority boundary are recorded', () => {
  const result = new LongRunCreationCertRunner().run(tempDir());
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
  assert.equal(manifest.dynamicRevision.invalidatesDownstreamOnly, true);
  assert.equal(manifest.failureRecovery.partialComplete, true);
  assert.equal(manifest.authority.publicationAuthorityGranted, false);
});

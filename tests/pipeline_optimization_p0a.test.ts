import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evidenceProjectionStats, evidencePromptBlock, excerptContainsSnippet } from '../src/model-gateway/chat-grounding.js';
import { PipelineTelemetry, resolveModelCostRates, type PipelineLogger } from '../src/observability/pipeline-telemetry.js';
import type { EvidencePack, EvidenceSource } from '../src/research/evidence-pack.types.js';

function source(overrides: Partial<EvidenceSource> = {}): EvidenceSource {
  return {
    sourceId: 'src_1',
    title: 'Official title',
    url: 'https://example.test/source',
    snippet: 'Battery capacity is 4,400 mAh.',
    excerpt: 'The device specification confirms that battery capacity is 4,400 mAh. Charging details follow.',
    retrievedAt: '2026-10-17T00:00:00.000Z',
    freshnessStatus: 'CURRENT',
    ...overrides,
  };
}

function pack(sources: EvidenceSource[]): EvidencePack {
  return { evidencePackId: 'ev_1', query: 'battery', generatedAt: '2026-10-17T00:00:00.000Z', freshnessRequirement: 'REQUIRED', category: 'PRODUCT', status: 'SUCCESS', sources };
}

describe('P0-A context projection', () => {
  it('omits a snippet only when its normalized content is fully present in the excerpt, without mutating evidence', () => {
    const duplicate = source({ excerpt: 'Battery capacity is 4,400 mAh. It supports fast charging.' });
    const distinct = source({ sourceId: 'src_2', snippet: 'The launch date is October 17.', excerpt: 'Battery capacity is 4,400 mAh.' });
    const evidence = pack([duplicate, distinct]);
    const snapshot = structuredClone(evidence);

    assert.equal(excerptContainsSnippet(duplicate), true);
    assert.equal(excerptContainsSnippet(distinct), false);
    const prompt = evidencePromptBlock(evidence, 'fixednonce');
    assert.ok(prompt?.includes('[src_1] Official title'));
    assert.ok(prompt?.includes('URL: https://example.test/source'));
    assert.equal(prompt?.includes('Snippet: Battery capacity is 4,400 mAh.'), false);
    assert.ok(prompt?.includes('Snippet: The launch date is October 17.'));
    assert.deepEqual(evidence, snapshot);

    const stats = evidenceProjectionStats(evidence);
    assert.deepEqual({ omitted: stats.snippetsOmitted, included: stats.snippetsIncluded }, { omitted: 1, included: 1 });
    assert.ok(stats.charactersAfter < stats.charactersBefore);
  });
});

describe('P0-A phase telemetry', () => {
  it('records safe timing, attempts, usage and configured cost without prompt or response content', () => {
    const records: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const logger: PipelineLogger = {
      info: (event, fields) => records.push({ event, fields }),
      warn: (event, fields) => records.push({ event, fields }),
    };
    const times = [1_000, 1_025];
    const telemetry = new PipelineTelemetry(logger, { nebius: { inputPerMillionUsd: 1, outputPerMillionUsd: 2, reasoningPerMillionUsd: 3 } }, () => times.shift() ?? 1_025);
    const finish = telemetry.start('req_safe', 'LLM_GENERATION', { taskKind: 'CHAT' });
    finish({ provider: 'nebius', model: 'model-x', attemptCount: 2, inputTokens: 1_000, outputTokens: 500, reasoningTokens: 200, cache: 'MISS' });

    assert.equal(records.length, 2);
    const completed = records[1].fields;
    assert.equal(completed.requestId, 'req_safe');
    assert.equal(completed.latencyMs, 25);
    assert.equal(completed.attemptCount, 2);
    assert.equal(completed.estimatedCostUsd, 0.0022);
    assert.equal(JSON.stringify(records).includes('prompt'), false);
    assert.equal(JSON.stringify(records).includes('response'), false);
  });

  it('distinguishes DISABLED, SHADOW, ADVISORY and APPLIED JEV states with call facts only', () => {
    const records: Array<Record<string, unknown>> = [];
    const logger: PipelineLogger = { info: (_event, fields) => records.push(fields), warn: (_event, fields) => records.push(fields) };
    const telemetry = new PipelineTelemetry(logger);
    for (const state of ['DISABLED', 'SHADOW', 'ADVISORY', 'APPLIED'] as const) {
      telemetry.jev({ requestId: 'req_jev', surface: 'TEST', state, callCount: state === 'DISABLED' ? 0 : 1, latencyMs: 4, failed: false });
    }
    assert.deepEqual(records.map((record) => record.state), ['DISABLED', 'SHADOW', 'ADVISORY', 'APPLIED']);
  });

  it('accepts only finite non-negative operator cost rates', () => {
    const rates = resolveModelCostRates({ NAGEX_MODEL_COST_RATES_JSON: '{"nebius":{"inputPerMillionUsd":1,"outputPerMillionUsd":2},"bad":{"inputPerMillionUsd":-1,"outputPerMillionUsd":2}}' });
    assert.deepEqual(Object.keys(rates), ['nebius']);
    assert.deepEqual(resolveModelCostRates({ NAGEX_MODEL_COST_RATES_JSON: 'not-json' }), {});
  });
});

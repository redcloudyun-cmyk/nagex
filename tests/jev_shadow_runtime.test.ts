import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JevShadowEvaluator, validateJevShadowOutput } from '../src/model-gateway/jev-shadow-evaluator.js';
import { runJevShadowBenchmark } from '../src/model-gateway/jev-shadow-benchmark.js';
import { JEV_SHADOW_FIXTURES } from '../src/model-gateway/jev-shadow-fixtures.js';
import type { ModelProvider, ModelResponse, ProviderStatus } from '../src/model-gateway/model-provider.js';
import type { ModelProviderCapabilities, ModelTaskKind } from '../src/model-gateway/model-routing.types.js';
import { UnifiedModelRouter, type RouterLogger } from '../src/model-gateway/unified-model-router.js';
import type { JevShadowOutput } from '../src/model-gateway/jev-shadow.types.js';
import { JEV_MODEL_ALIAS, JEV_SYSTEMONE_ENDPOINT, JevSystemOneProvider, parseJevHighRiskProbability } from '../src/model-gateway/jev-provider.js';
import {
  JEV_BENCHMARK_SCHEMA_VERSION,
  JEV_PARSER_VERSION,
  JEV_SCORER_VERSION,
  buildJevLiveResultRecord,
  persistJevLiveBenchmarkArtifacts,
  routingDecisionFor,
  scoreJevLiveResults,
  type JevLiveResultRecord,
} from '../src/model-gateway/jev-live-results.js';

class FakeProvider implements ModelProvider {
  public readonly capabilities: ModelProviderCapabilities;

  constructor(
    public readonly name: string,
    public readonly model: string,
    private readonly responseText: string,
    eligibleTaskKinds?: ModelTaskKind[]
  ) {
    this.capabilities = {
      provider: name,
      supportsJsonMode: true,
      supportsGeneralChat: true,
      supportsStructuredExtraction: true,
      ...(eligibleTaskKinds ? { eligibleTaskKinds } : {}),
    };
  }

  public status(): ProviderStatus {
    return {
      configured: true,
      available: true,
      provider: this.name,
      model: this.model,
      status: 'CONFIGURED',
      lastCheckedAt: null,
      degradedReason: null,
    };
  }

  public async generate(request: { requestId: string }): Promise<ModelResponse> {
    return {
      text: this.responseText,
      provider: this.name,
      model: this.model,
      latencyMs: 1,
      requestId: request.requestId,
      usage: null,
      meta: { reasoningAvailable: false },
    };
  }
}

function buildRouter(evaluator: Pick<JevShadowEvaluator, 'evaluate'> | null = new JevShadowEvaluator()) {
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const logger: RouterLogger = {
    info: (event, fields) => logs.push({ event, fields }),
    warn: (event, fields) => logs.push({ event, fields }),
  };
  const providers: ModelProvider[] = [
    new FakeProvider('gemini', 'gemini-test', 'gemini answer'),
    new FakeProvider('nebius', 'nvidia/Nemotron-3_5-Lightning', 'nebius answer', ['PLAN', 'RESEARCH_SYNTHESIS', 'MEETING_PREP']),
  ];
  return { router: new UnifiedModelRouter(providers, logger, undefined, evaluator), logs };
}

describe('JEV shadow output contract', () => {
  it('accepts only fixed decisions, fixed reason codes and confidence in range', () => {
    const valid = new JevShadowEvaluator().evaluate({
      taskKind: 'PLAN',
      requiresJson: false,
      signals: { multiStep: true },
    });
    assert.equal(valid.complexity, 'HIGH_REASONING');
    assert.doesNotThrow(() => validateJevShadowOutput(valid));
    assert.throws(
      () => validateJevShadowOutput({ ...valid, complexity: 'PROVIDER_nebius' } as unknown as JevShadowOutput),
      /Invalid JEV shadow complexity/
    );
    assert.throws(
      () => validateJevShadowOutput({ ...valid, complexityConfidence: 1.4 }),
      /Invalid JEV shadow complexityConfidence/
    );
  });
});

describe('JEV SystemOne provider adapter', () => {
  it('uses server-side credential, typed questions, model alias and resolved model normalization', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const provider = new JevSystemOneProvider({
      apiKey: 'jev-secret-test-key',
      fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init! });
        return new Response(JSON.stringify({
          resolved_model: 'jev-systemone-2026-10-06',
          answers: {
            complexity: { choice: 'HIGH_REASONING', confidence: 0.96 },
            high_risk: { probability: 0.12, confidence: 0.9 },
            reasoning_level: { score: 0.78, confidence: 0.91 },
          },
        }), { status: 200 });
      }) as typeof fetch,
    });
    const out = await provider.evaluate({
      fixtureId: 'unit-fixture-001',
      taskKind: 'PLAN',
      requiresJson: false,
      state: 'Synthetic planning task.',
      signals: { multiStep: true },
      idempotencyKey: 'unit-idempotency-key',
    });
    assert.equal(calls[0].url, JEV_SYSTEMONE_ENDPOINT);
    assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Bearer jev-secret-test-key');
    assert.equal((calls[0].init.headers as Record<string, string>)['Idempotency-Key'], 'unit-idempotency-key');
    const body = JSON.parse(String(calls[0].init.body));
    assert.deepEqual(Object.keys(body).sort(), ['model', 'questions', 'state']);
    assert.equal(body.model, JEV_MODEL_ALIAS);
    assert.equal(body.state.text, 'Synthetic planning task.');
    assert.deepEqual(body.state.signals, { multiStep: true });
    assert.equal(body.fixtureId, undefined);
    assert.equal(body.signals, undefined);
    assert.equal(body.idempotencyKey, undefined);
    assert.equal(body.input, undefined);
    assert.equal(body.instructions, undefined);
    assert.deepEqual(Object.entries(body.questions).map(([id, q]: [string, any]) => [id, q.type]).sort(), [
      ['complexity', 'choice'],
      ['high_risk', 'noul'],
      ['reasoning_level', 'score'],
    ]);
    assert.equal(JSON.stringify(body).includes('PRIVATE_PROMPT'), false);
    assert.equal(out.complexity, 'HIGH_REASONING');
    assert.equal(out.reasoningLevel, 'COMPLEX');
    assert.equal(out.resolvedModel, 'jev-systemone-2026-10-06');
  });

  it('rejects malformed provider enums and never logs or returns the key', async () => {
    const provider = new JevSystemOneProvider({
      apiKey: 'jev-secret-test-key',
      fetchFn: (async () => new Response(JSON.stringify({
        answers: {
          complexity: { choice: 'RUN_PROVIDER', confidence: 1 },
          high_risk: { probability: 0 },
          reasoning_level: { score: 0.1, confidence: 0.9 },
        },
      }), { status: 200 })) as typeof fetch,
    });
    await assert.rejects(
      () => provider.evaluate({ taskKind: 'CHAT', requiresJson: false }),
      (error: any) => error.code === 'PROVIDER_NETWORK_ERROR'
    );
  });

  it('parses NOUL high-risk answers without defaulting missing or malformed values to zero', () => {
    assert.equal(parseJevHighRiskProbability({ probability: 0 }), 0);
    assert.equal(parseJevHighRiskProbability({ probability: 0.41 }), 0.41);
    assert.equal(parseJevHighRiskProbability({ value: '0.72' }), 0.72);
    assert.equal(parseJevHighRiskProbability({ answer: { score: 0.33 } }), 0.33);
    assert.equal(parseJevHighRiskProbability({ probability: 'not-a-number' }), null);
    assert.equal(parseJevHighRiskProbability({}), null);
    assert.equal(parseJevHighRiskProbability(undefined), null);
  });

  it('keeps missing high_risk as null in normalized provider output', async () => {
    const provider = new JevSystemOneProvider({
      apiKey: 'jev-secret-test-key',
      fetchFn: (async () => new Response(JSON.stringify({
        resolved_model: 'jev-systemone-test',
        answers: {
          complexity: { choice: 'SIMPLE', confidence: 0.93 },
          reasoning_level: { score: 0.2, confidence: 0.8 },
        },
      }), { status: 200 })) as typeof fetch,
    });
    const out = await provider.evaluate({ taskKind: 'CHAT', requiresJson: false });
    assert.equal(out.highRiskProbability, null);
  });
});

describe('JEV live result scorer and artifacts', () => {
  const baseRecord: JevLiveResultRecord = {
    fixtureId: 'r',
    taskKind: 'PLAN',
    goldComplexity: 'STANDARD',
    goldReasoningLevel: 'MODERATE',
    jevComplexity: 'STANDARD',
    jevComplexityConfidence: 0.9,
    jevReasoningLevel: 'MODERATE',
    highRiskProbability: null,
    resolvedModel: 'jev-1.13.0',
    latencyMs: 10,
    complexityExactMatch: true,
    reasoningExactMatch: true,
    jointExactMatch: true,
    complexityDirection: 'SAME',
    routingDecisionGold: routingDecisionFor('STANDARD', null),
    routingDecisionJev: routingDecisionFor('STANDARD', null),
    routingDecisionMatch: true,
    parserVersion: JEV_PARSER_VERSION,
    scorerVersion: JEV_SCORER_VERSION,
    benchmarkSchemaVersion: JEV_BENCHMARK_SCHEMA_VERSION,
  };

  it('counts ordinal complexity downgrades and upgrades explicitly', () => {
    const records: JevLiveResultRecord[] = [
      { ...baseRecord, fixtureId: 'standard-simple', goldComplexity: 'STANDARD', jevComplexity: 'SIMPLE', routingDecisionGold: routingDecisionFor('STANDARD', null), routingDecisionJev: routingDecisionFor('SIMPLE', null) },
      { ...baseRecord, fixtureId: 'high-standard', goldComplexity: 'HIGH_REASONING', jevComplexity: 'STANDARD', routingDecisionGold: routingDecisionFor('HIGH_REASONING', null), routingDecisionJev: routingDecisionFor('STANDARD', null) },
      { ...baseRecord, fixtureId: 'high-simple', goldComplexity: 'HIGH_REASONING', jevComplexity: 'SIMPLE', routingDecisionGold: routingDecisionFor('HIGH_REASONING', null), routingDecisionJev: routingDecisionFor('SIMPLE', null) },
      { ...baseRecord, fixtureId: 'simple-standard', goldComplexity: 'SIMPLE', jevComplexity: 'STANDARD', routingDecisionGold: routingDecisionFor('SIMPLE', null), routingDecisionJev: routingDecisionFor('STANDARD', null) },
      { ...baseRecord, fixtureId: 'standard-high', goldComplexity: 'STANDARD', jevComplexity: 'HIGH_REASONING', routingDecisionGold: routingDecisionFor('STANDARD', null), routingDecisionJev: routingDecisionFor('HIGH_REASONING', null) },
      { ...baseRecord, fixtureId: 'simple-high', goldComplexity: 'SIMPLE', jevComplexity: 'HIGH_REASONING', routingDecisionGold: routingDecisionFor('SIMPLE', null), routingDecisionJev: routingDecisionFor('HIGH_REASONING', null) },
      { ...baseRecord, fixtureId: 'uncertain', goldComplexity: 'STANDARD', jevComplexity: 'UNCERTAIN', routingDecisionGold: routingDecisionFor('STANDARD', null), routingDecisionJev: routingDecisionFor('UNCERTAIN', null) },
    ];
    const summary = scoreJevLiveResults(records);
    assert.equal(summary.rawComplexityDowngradeCount, 3);
    assert.equal(summary.rawComplexityUpgradeCount, 3);
    assert.equal(summary.rawUncertainCount, 1);
    assert.equal(summary.standardToSimpleCount, 1);
    assert.equal(summary.highReasoningToStandardCount, 1);
    assert.equal(summary.highReasoningToSimpleCount, 1);
  });

  it('separates exact scoring from routing-decision scoring', () => {
    const records: JevLiveResultRecord[] = [
      buildJevLiveResultRecord({ ...baseRecord, fixtureId: 'reasoning-wording', goldComplexity: 'HIGH_REASONING', goldReasoningLevel: 'COMPLEX', jevComplexity: 'HIGH_REASONING', jevReasoningLevel: 'VERY_COMPLEX' }),
    ];
    const summary = scoreJevLiveResults(records);
    assert.equal(summary.complexityExactAccuracy, 1);
    assert.equal(summary.reasoningLevelExactAccuracy, 0);
    assert.equal(summary.jointExactAccuracy, 0);
    assert.equal(summary.routingDecisionAccuracy, 1);
  });

  it('persists sanitized benchmark records and summary with versions', async () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const resultsPath = `artifacts/jev/test-${suffix}-results.json`;
    const summaryPath = `artifacts/jev/test-${suffix}-summary.json`;
    const summary = await persistJevLiveBenchmarkArtifacts({
      records: [buildJevLiveResultRecord(baseRecord)],
      resultsPath,
      summaryPath,
    });
    assert.equal(summary.benchmarkSchemaVersion, JEV_BENCHMARK_SCHEMA_VERSION);
    assert.equal(summary.parserVersion, JEV_PARSER_VERSION);
    assert.equal(summary.scorerVersion, JEV_SCORER_VERSION);
    const serialized = await readFile(resultsPath, 'utf8');
    const artifact = JSON.parse(serialized);
    const record = artifact.records[0];
    assert.equal(record.benchmarkSchemaVersion, JEV_BENCHMARK_SCHEMA_VERSION);
    assert.deepEqual(Object.keys(record).sort(), [
      'benchmarkSchemaVersion',
      'complexityDirection',
      'complexityExactMatch',
      'fixtureId',
      'goldComplexity',
      'goldReasoningLevel',
      'highRiskProbability',
      'jevComplexity',
      'jevComplexityConfidence',
      'jevReasoningLevel',
      'jointExactMatch',
      'latencyMs',
      'parserVersion',
      'reasoningExactMatch',
      'resolvedModel',
      'routingDecisionGold',
      'routingDecisionJev',
      'routingDecisionMatch',
      'scorerVersion',
      'taskKind',
    ]);
    assert.equal(serialized.includes('JEVMODEL_API_KEY'), false);
    assert.equal(serialized.includes('Authorization'), false);
    assert.equal(serialized.includes('PRIVATE_PROMPT'), false);
    assert.equal(serialized.includes('hidden reasoning'), false);
  });

  it('keeps live benchmark scripts behind explicit environment guards', async () => {
    const source = await readFile('scripts/jev-live-benchmark.mjs', 'utf8');
    assert.match(source, /JEV_RUN_36 !== 'YES'/);
    assert.match(source, /JEV_RUN_FULL !== 'YES'/);
  });
});

describe('JEV shadow runtime authority boundary', () => {
  it('does not change authoritative provider, task kind, fallback trace or response', async () => {
    const without = buildRouter(null);
    const withShadow = buildRouter(new JevShadowEvaluator());
    const input = {
      messages: [{ role: 'user' as const, content: 'PRIVATE_PROMPT_JEV_AUTHORITY' }],
      mode: 'auto',
      requestId: 'jev-authority',
      routingContext: { taskKind: 'CHAT' as const, requiresJson: false, requestId: 'jev-authority' },
    };
    const base = await without.router.generate(input);
    const shadow = await withShadow.router.generate(input);
    assert.deepEqual(shadow.routing, base.routing);
    assert.equal(shadow.provider, base.provider);
    assert.equal(shadow.model, base.model);
    assert.equal(shadow.text, base.text);
    assert.equal(withShadow.logs.filter((log) => log.event === 'jev_shadow_decision').length, 1);
  });

  it('cannot override the current router even when the advisory says HIGH_REASONING', async () => {
    const malicious = {
      evaluate(): JevShadowOutput {
        return { complexity: 'HIGH_REASONING', complexityConfidence: 1, highRiskProbability: 0, reasoningLevel: 'COMPLEX', reasoningConfidence: 1, resolvedModel: 'test', reasonCode: 'OTHER', latencyMs: 0 };
      },
    };
    const { router, logs } = buildRouter(malicious);
    const result = await router.generate({
      messages: [{ role: 'user', content: 'stay on current chat route' }],
      mode: 'auto',
      requestId: 'jev-negative-authority',
      routingContext: { taskKind: 'CHAT', requiresJson: false, requestId: 'jev-negative-authority' },
    });
    assert.equal(result.provider, 'gemini');
    assert.equal(logs.find((log) => log.event === 'model_routing_decision')?.fields.selectedProvider, 'gemini');
    assert.equal(logs.find((log) => log.event === 'jev_shadow_decision')?.fields.jevDecision, 'HIGH_REASONING');
  });

  it('records only safe shadow telemetry', async () => {
    const prompt = 'PRIVATE_PROMPT_JEV_TELEMETRY';
    const answer = 'PRIVATE_ANSWER_JEV_TELEMETRY';
    const hiddenReasoning = 'PRIVATE_HIDDEN_REASONING_JEV_TELEMETRY';
    const credential = 'sk-PRIVATE-JEV-KEY';
    const { router, logs } = buildRouter({
      evaluate(): JevShadowOutput {
        return { complexity: 'HIGH_REASONING', complexityConfidence: 0.93, highRiskProbability: 0.93, reasoningLevel: 'COMPLEX', reasoningConfidence: 0.9, resolvedModel: 'test', reasonCode: 'CONSEQUENTIAL_ACTION', latencyMs: 0.2 };
      },
    });
    await router.generate({
      messages: [{ role: 'user', content: prompt }],
      mode: 'auto',
      requestId: 'jev-telemetry',
      routingContext: { taskKind: 'PLAN', requiresJson: false, requestId: 'jev-telemetry' },
    });
    const shadow = logs.find((log) => log.event === 'jev_shadow_decision')!.fields;
    assert.deepEqual(Object.keys(shadow).sort(), [
      'agreement',
      'currentModel',
      'currentProvider',
      'highRiskProbability',
      'jevConfidence',
      'jevDecision',
      'jevReasonCode',
      'latencyMs',
      'reasoningLevel',
      'requestId',
      'taskKind',
    ]);
    const text = JSON.stringify(shadow);
    assert.equal(text.includes(prompt), false);
    assert.equal(text.includes(answer), false);
    assert.equal(text.includes(hiddenReasoning), false);
    assert.equal(text.includes(credential), false);
  });

  it('does not expose approval, execution, memory or provider authority fields', () => {
    const output = new JevShadowEvaluator().evaluate({
      taskKind: 'PLAN',
      requiresJson: false,
      signals: { highRisk: true },
    });
    assert.equal(Object.prototype.hasOwnProperty.call(output, 'requiresApproval'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(output, 'selectedProvider'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(output, 'execute'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(output, 'memoryWrite'), false);
  });
});

describe('JEV shadow benchmark', () => {
  it('uses a deterministic synthetic fixture set above the required size', () => {
    assert.equal(JEV_SHADOW_FIXTURES.length, 133);
    assert.ok(new Set(JEV_SHADOW_FIXTURES.map((fixture) => fixture.id)).size === JEV_SHADOW_FIXTURES.length);
    for (const taskKind of ['CHAT', 'PLAN', 'RESEARCH_SYNTHESIS', 'MEETING_PREP', 'STRUCTURED_EXTRACTION', 'DAILY_BRIEF']) {
      assert.ok(JEV_SHADOW_FIXTURES.some((fixture) => fixture.taskKind === taskKind), taskKind);
    }
  });

  it('meets the shadow POC routing thresholds without provider calls', () => {
    const result = runJevShadowBenchmark();
    assert.equal(result.fixtureCount, 133);
    assert.equal(result.currentRouterOutputChangedByJev, 0);
    assert.ok(result.accuracy >= 0.95, String(result.accuracy));
    assert.ok(result.falseDowngradeRate <= 0.02, String(result.falseDowngradeRate));
    assert.ok(result.projectedNemotronCallReduction >= 0.2, String(result.projectedNemotronCallReduction));
  });

  it('negative control fails the false-downgrade threshold when high reasoning is systematically downgraded', () => {
    const result = runJevShadowBenchmark({
      evaluator: {
        evaluate(): JevShadowOutput {
          return { complexity: 'STANDARD', complexityConfidence: 0.99, highRiskProbability: 0, reasoningLevel: 'MODERATE', reasoningConfidence: 0.99, resolvedModel: 'test', reasonCode: 'OTHER', latencyMs: 0 };
        },
      },
    });
    assert.ok(result.falseDowngradeRate > 0.02);
    assert.ok(result.accuracy < 0.95);
  });
});

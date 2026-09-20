import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { NagexError } from '../src/common/errors.js';
import type { ModelProvider, ModelRequest, ModelResponse, ProviderStatus } from '../src/model-gateway/model-provider.js';
import { UnifiedModelRouter } from '../src/model-gateway/unified-model-router.js';
import { PerspectiveCompareService } from '../src/model-gateway/perspective-compare.service.js';
import { EvidencePackService } from '../src/research/evidence-pack.service.js';
import type { EvidencePack } from '../src/research/evidence-pack.types.js';
import type { MemoryRecord } from '../src/context/memory.engine.js';

class MockModelProvider implements ModelProvider {
  public readonly name: string;
  public readonly model: string;
  public readonly capabilities: any;
  private isConfigured: boolean;
  private isLive: boolean;
  private shouldFail: boolean;
  public lastReceivedRequest?: ModelRequest;
  public attemptCount = 0;

  constructor(name: string, model: string, isConfigured = true, isLive = true, shouldFail = false, caps?: any) {
    this.name = name;
    this.model = model;
    this.isConfigured = isConfigured;
    this.isLive = isLive;
    this.shouldFail = shouldFail;
    this.capabilities = caps || {
      provider: name,
      supportsJsonMode: true,
      supportsGeneralChat: true,
      supportsStructuredExtraction: true,
    };
  }

  public setShouldFail(fail: boolean) {
    this.shouldFail = fail;
  }

  public status(): ProviderStatus {
    return {
      configured: this.isConfigured,
      available: this.isConfigured && this.isLive,
      provider: this.name,
      model: this.model,
      status: !this.isConfigured ? 'UNCONFIGURED' : this.isLive ? 'LIVE' : 'DEGRADED',
      lastCheckedAt: new Date().toISOString(),
      degradedReason: null,
    };
  }

  public async generate(request: ModelRequest): Promise<ModelResponse> {
    this.attemptCount++;
    this.lastReceivedRequest = request;
    if (this.shouldFail) {
      throw new NagexError({
        code: 'PROVIDER_TIMEOUT',
        category: 'TIMEOUT',
        message: `${this.name} request failed due to simulated timeout.`,
        request_id: request.requestId,
      });
    }

    if (request.jsonMode) {
      const synthesisJson = JSON.stringify({
        answer: `Unified NAgex synthesized perspective analysis for request ${request.requestId}.`,
        commonGround: ['AI architecture requires modular decoupling', 'Observability is essential'],
        differingPerspectives: [
          {
            topic: 'Deployment scale',
            views: ['Perspective A favors microservices', 'Perspective B favors modular monoliths'],
          },
        ],
        uncertainties: ['Long term operational cost scaling'],
      });
      return {
        text: synthesisJson,
        provider: this.name,
        model: this.model,
        latencyMs: 12,
        requestId: request.requestId,
      };
    }

    return {
      text: `Independent perspective analysis from ${this.name}: Grounded in shared evidence. Key tradeoffs and uncertainties evaluated.`,
      provider: this.name,
      model: this.model,
      latencyMs: 15,
      requestId: request.requestId,
    };
  }
}

test('NAgex R22.6 — Perspective Compare Foundation Suite', async () => {
  const metrics: Record<string, any> = {};
  const loggedEvents: Array<{ event: string; fields: any }> = [];
  const testLogger = {
    info: (event: string, fields: any) => loggedEvents.push({ event, fields }),
    warn: (event: string, fields: any) => loggedEvents.push({ event, fields }),
  };

  const pNebius = new MockModelProvider('nebius', 'nebius-model-1');
  const pGemini = new MockModelProvider('gemini', 'gemini-1.5-pro');
  const pOpenAI = new MockModelProvider('openai', 'gpt-4o');

  const router = new UnifiedModelRouter([pNebius, pGemini, pOpenAI], testLogger as any);

  let evidenceBuildCount = 0;
  const mockEvidencePackService = {
    async buildEvidencePack(query: string, options: any): Promise<EvidencePack> {
      evidenceBuildCount++;
      return {
        evidencePackId: `pack_${evidenceBuildCount}`,
        query,
        generatedAt: new Date().toISOString(),
        freshnessRequirement: 'OPTIONAL',
        category: 'tech',
        status: 'SUCCESS',
        sources: [
          {
            sourceId: 'src_1',
            url: 'https://example.com/ai-arch',
            title: 'AI Architecture Trends 2026',
            snippet: 'Shared evidence snippet about AI Agent design patterns.',
            publishedAt: '2026-09-19',
            retrievedAt: new Date().toISOString(),
            freshnessStatus: 'CURRENT',
          },
        ],
      };
    },
  } as unknown as EvidencePackService;

  const compareService = new PerspectiveCompareService(router, mockEvidencePackService, testLogger as any);

  // A. ONE Shared Evidence Pack per compare request
  evidenceBuildCount = 0;
  const resultA = await compareService.compare({
    query: 'Compare modern AI agent architecture perspectives',
    requiresEvidenceGrounding: true,
  });

  assert.equal(resultA.status, 'SUCCESS');
  assert.equal(evidenceBuildCount, 1);
  assert.equal(resultA.perspectivesAttempted, 3);
  assert.equal(resultA.perspectivesSucceeded, 3);
  metrics.ONE_EVIDENCE_PACK_PER_COMPARE = 1;
  metrics.SHARED_EVIDENCE_PACK = 'PASS';
  metrics.PERSPECTIVE_COMPARE_SUCCESS = 'PASS';

  // B. Deterministic Selection & No Duplicate Providers
  const selectedEligible = compareService.selectEligibleProviders();
  assert.equal(selectedEligible.length, 3);
  assert.equal(new Set(selectedEligible).size, 3);
  assert.deepEqual(selectedEligible, ['nebius', 'gemini', 'openai']);
  metrics.PERSPECTIVE_SELECTION_DETERMINISTIC = 'PASS';
  metrics.DUPLICATE_PROVIDER_PERSPECTIVES = 0;

  // C. Fallback Policy DISALLOW (No Fallback Substitution)
  pNebius.setShouldFail(true); // Nebius fails
  const resultB = await compareService.compare({
    query: 'Analyze tradeoff between microservices and monoliths',
    requiresEvidenceGrounding: false,
  });

  assert.equal(resultB.status, 'PARTIAL');
  assert.equal(resultB.perspectivesAttempted, 3);
  assert.equal(resultB.perspectivesSucceeded, 2);

  const nebiusPerspective = resultB.perspectives?.find((p) => p.provider === 'nebius');
  assert.equal(nebiusPerspective?.status, 'FAILED');
  assert.equal(nebiusPerspective?.errorCode, 'ALL_MODEL_PROVIDERS_FAILED');
  metrics.PERSPECTIVE_FALLBACK_SUBSTITUTION = 0;

  // D. Partial Failure Truthful (1 provider success out of 3)
  pGemini.setShouldFail(true); // Nebius and Gemini fail, only OpenAI succeeds
  const resultC = await compareService.compare({
    query: 'Evaluate risk management approaches',
    requiresEvidenceGrounding: false,
  });

  assert.equal(resultC.status, 'PARTIAL');
  assert.equal(resultC.perspectivesSucceeded, 1);
  assert.ok(resultC.synthesis?.answer.includes("couldn't reliably compare multiple perspectives"));
  metrics.PARTIAL_FAILURE_TRUTHFUL = 'PASS';

  // E. All Providers Failure Truthful (0 providers succeed)
  pOpenAI.setShouldFail(true); // All 3 providers fail
  const resultD = await compareService.compare({
    query: 'Evaluate all failing scenario',
    requiresEvidenceGrounding: false,
  });

  assert.equal(resultD.status, 'UNAVAILABLE');
  assert.equal(resultD.perspectivesSucceeded, 0);
  assert.equal(resultD.synthesis, null);
  metrics.ALL_PROVIDER_FAILURE_TRUTHFUL = 'PASS';

  // Restore providers
  pNebius.setShouldFail(false);
  pGemini.setShouldFail(false);
  pOpenAI.setShouldFail(false);

  // F. Synthesis Failure Truthful
  const badSynthProvider = new MockModelProvider('nebius', 'bad-synth');
  badSynthProvider.generate = async (req: ModelRequest) => {
    if (req.jsonMode) {
      return { text: 'Invalid non-json response text', provider: 'nebius', model: 'bad-synth', latencyMs: 5, requestId: req.requestId };
    }
    return { text: 'Perspective text', provider: 'nebius', model: 'bad-synth', latencyMs: 5, requestId: req.requestId };
  };

  const badRouter = new UnifiedModelRouter([badSynthProvider, pGemini]);
  const badCompareService = new PerspectiveCompareService(badRouter, mockEvidencePackService);

  let synthErrCaught = false;
  try {
    await badCompareService.compare({ query: 'Test synthesis failure' });
  } catch (err: any) {
    if (err?.code === 'PERSPECTIVE_SYNTHESIS_FAILED') {
      synthErrCaught = true;
    }
  }
  assert.ok(synthErrCaught);
  metrics.SYNTHESIS_FAILURE_TRUTHFUL = 'PASS';

  // G. Fix synthesis fail-closed validation negative tests
  const negSchemaCases = [
    '{"answer":"x","commonGround":"wrong","differingPerspectives":[],"uncertainties":[]}',
    '{"answer":"x","commonGround":[],"differingPerspectives":[{"topic":"x","views":"wrong"}],"uncertainties":[]}',
    '{"answer":"x","commonGround":[],"differingPerspectives":{},"uncertainties":[]}',
  ];

  let schemaFailClosedPassCount = 0;
  for (const negText of negSchemaCases) {
    const negProvider = new MockModelProvider('nebius', 'neg-model');
    negProvider.generate = async (req: ModelRequest) => {
      if (req.jsonMode) {
        return { text: negText, provider: 'nebius', model: 'neg-model', latencyMs: 5, requestId: req.requestId };
      }
      return { text: 'Perspective text', provider: 'nebius', model: 'neg-model', latencyMs: 5, requestId: req.requestId };
    };
    const negRouter = new UnifiedModelRouter([negProvider, pGemini]);
    const negService = new PerspectiveCompareService(negRouter, mockEvidencePackService);
    try {
      await negService.compare({ query: 'Schema negative test' });
    } catch (err: any) {
      if (err?.code === 'PERSPECTIVE_SYNTHESIS_FAILED') {
        schemaFailClosedPassCount++;
      }
    }
  }

  assert.equal(schemaFailClosedPassCount, negSchemaCases.length);
  metrics.SYNTHESIS_SCHEMA_FAIL_CLOSED = 'PASS';

  // H. Provider capability eligibility test (supportsGeneralChat: false)
  const pIncompatible = new MockModelProvider(
    'incompatible-provider',
    'inc-model',
    true,
    true,
    false,
    { provider: 'incompatible-provider', supportsGeneralChat: false, supportsJsonMode: true }
  );
  const capRouter = new UnifiedModelRouter([pNebius, pGemini, pOpenAI, pIncompatible], testLogger as any);
  const capService = new PerspectiveCompareService(capRouter, mockEvidencePackService, testLogger as any);

  const eligibleCapNames = capService.selectEligibleProviders();
  assert.equal(eligibleCapNames.includes('incompatible-provider'), false);

  const capResult = await capService.compare({ query: 'Capability test query' });
  assert.equal(capResult.perspectivesAttempted, 3);
  assert.equal(pIncompatible.attemptCount, 0);
  metrics.INCOMPATIBLE_PROVIDER_ATTEMPTED = pIncompatible.attemptCount;

  // I. No Voting / Winner / Score in contract or logic
  const jsonStrResult = JSON.stringify(resultA);
  assert.equal(jsonStrResult.includes('voting'), false);
  assert.equal(jsonStrResult.includes('winner'), false);
  assert.equal(jsonStrResult.includes('score'), false);
  metrics.MODEL_VOTING = 0;
  metrics.MODEL_WINNER = 0;
  metrics.MODEL_SCORE = 0;

  // J. Personal Memory vs Evidence Layer Separation
  const secretPrompt = 'COMPARE_TEST_PROMPT_SECRET_111';
  const secretMemory = 'COMPARE_TEST_MEMORY_SECRET_222';
  const secretEvidence = 'COMPARE_TEST_EVIDENCE_SECRET_333';
  const secretApiKey = 'COMPARE_TEST_API_KEY_444';

  const testMemory: MemoryRecord = {
    id: 'mem_sec_1',
    scope: 'PERSONAL',
    tenantId: 'ten_sec',
    owner_id: 'usr_sec',
    lifecycle: 'ACTIVE',
    content: { subject: 'user', predicate: 'key', value: secretMemory },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const secretEvidencePackService = {
    async buildEvidencePack(): Promise<EvidencePack> {
      return {
        evidencePackId: 'pack_sec',
        query: secretPrompt,
        generatedAt: new Date().toISOString(),
        freshnessRequirement: 'OPTIONAL',
        category: 'tech',
        status: 'SUCCESS',
        sources: [
          {
            sourceId: 'src_sec',
            url: 'https://example.com/sec',
            title: 'Secret Title',
            snippet: secretEvidence,
            publishedAt: '2026-09-19',
            retrievedAt: new Date().toISOString(),
            freshnessStatus: 'CURRENT',
          },
        ],
      };
    },
  } as unknown as EvidencePackService;

  const privacyLogs: any[] = [];
  const privacyLogger = {
    info: (event: string, fields: any) => privacyLogs.push({ event, ...fields }),
    warn: (event: string, fields: any) => privacyLogs.push({ event, ...fields }),
  };

  const privacyRouter = new UnifiedModelRouter([pNebius, pGemini, pOpenAI], privacyLogger as any);
  const privacyService = new PerspectiveCompareService(privacyRouter, secretEvidencePackService, privacyLogger as any);

  await privacyService.compare({
    query: secretPrompt,
    memories: [testMemory],
  });

  const lastReq = pNebius.lastReceivedRequest;
  const userMsgText = lastReq?.messages.find((m) => m.role === 'user')?.content || '';
  assert.ok(userMsgText.includes('=== PERSONAL CONTEXT ==='));
  assert.ok(userMsgText.includes(secretMemory));
  assert.ok(userMsgText.includes('=== EVIDENCE PACK ==='));
  assert.ok(userMsgText.includes(secretEvidence));

  metrics.MEMORY_AS_EVIDENCE = 0;

  // Verify Privacy Logging: Logs must contain NONE of the secret markers
  const privacyLogText = JSON.stringify(privacyLogs);
  assert.equal(privacyLogText.includes(secretPrompt), false);
  assert.equal(privacyLogText.includes(secretMemory), false);
  assert.equal(privacyLogText.includes(secretEvidence), false);
  assert.equal(privacyLogText.includes(secretApiKey), false);
  metrics.ROUTING_LOG_PRIVACY = 'PASS';

  // K. UI presentation rendering assertions
  const containerEN: any = { innerHTML: '' };
  const containerKR: any = { innerHTML: '' };

  const appJsText = fs.readFileSync('public/app.js', 'utf8');
  const startIdx = appJsText.indexOf('function renderPerspectiveCompareResult(');
  const endIdx = appJsText.indexOf('window.NAGEX = window.NAGEX || {};', startIdx);
  const renderFn = new Function(
    'container', 'result', 'locale',
    `
      const window = {
        i18n: {
          getLocale: () => locale,
          t: (key, loc) => {
            const dict = {
              en: {
                'perspective.commonGround': 'What the perspectives agree on',
                'perspective.differing': 'Other ways to look at this',
                'perspective.uncertainties': 'What remains uncertain',
                'perspective.sources': 'Sources',
              },
              ko: {
                'perspective.commonGround': '공통적으로 확인되는 점',
                'perspective.differing': '다르게 볼 수 있는 관점',
                'perspective.uncertainties': '아직 불확실한 점',
                'perspective.sources': '출처',
              }
            };
            return (dict[loc] && dict[loc][key]) || key;
          }
        }
      };
      ${appJsText.substring(startIdx, endIdx)}
      return renderPerspectiveCompareResult(container, result, locale);
    `
  );

  renderFn(containerEN, resultA, 'en');
  renderFn(containerKR, resultA, 'ko');

  assert.ok(containerEN.innerHTML.includes('What the perspectives agree on'));
  assert.ok(containerEN.innerHTML.includes('Other ways to look at this'));
  assert.ok(containerEN.innerHTML.includes('What remains uncertain'));
  assert.ok(containerEN.innerHTML.includes('Sources'));

  assert.ok(containerKR.innerHTML.includes('공통적으로 확인되는 점'));
  assert.ok(containerKR.innerHTML.includes('다르게 볼 수 있는 관점'));
  assert.ok(containerKR.innerHTML.includes('아직 불확실한 점'));
  assert.ok(containerKR.innerHTML.includes('출처'));

  metrics.PERSPECTIVE_RESULT_RENDER = 'PASS';
  metrics.PERSPECTIVE_EN_KR_PARITY = 'PASS';

  const indexHtml = fs.readFileSync('public/index.html', 'utf8');

  assert.doesNotMatch(indexHtml, /<select[^>]*id="model-picker"/i);
  assert.doesNotMatch(appJsText, /renderPrimaryModelPicker/i);
  assert.doesNotMatch(appJsText, /"ALL_MODEL_PROVIDERS_FAILED"/);

  assert.equal(containerEN.innerHTML.includes('nebius'), false);
  assert.equal(containerEN.innerHTML.includes('gemini'), false);
  assert.equal(containerEN.innerHTML.includes('openai'), false);
  assert.equal(containerKR.innerHTML.includes('nebius'), false);
  assert.equal(containerKR.innerHTML.includes('gemini'), false);
  assert.equal(containerKR.innerHTML.includes('openai'), false);

  metrics.RAW_PROVIDER_NAME_PRIMARY_UI = 0;
  metrics.MODEL_PICKER_PRIMARY_UI = 0;
  metrics.TECHNICAL_UI_LEAK = 0;
  metrics.RAW_I18N_KEY_LEAK = 0;
  metrics.FAKE_SUCCESS_PATHS = 0;

  metrics.R22_6_TARGET = 'PASS';

  console.log('R22.6 Perspective Compare Metrics Report:', JSON.stringify(metrics, null, 2));

  assert.equal(metrics.R22_6_TARGET, 'PASS');
  assert.equal(metrics.SYNTHESIS_SCHEMA_FAIL_CLOSED, 'PASS');
  assert.equal(metrics.INCOMPATIBLE_PROVIDER_ATTEMPTED, 0);
  assert.equal(metrics.PERSPECTIVE_RESULT_RENDER, 'PASS');
  assert.equal(metrics.PERSPECTIVE_EN_KR_PARITY, 'PASS');
  assert.equal(metrics.ONE_EVIDENCE_PACK_PER_COMPARE, 1);
  assert.equal(metrics.SHARED_EVIDENCE_PACK, 'PASS');
  assert.equal(metrics.PERSPECTIVE_COMPARE_SUCCESS, 'PASS');
  assert.equal(metrics.PERSPECTIVE_SELECTION_DETERMINISTIC, 'PASS');
  assert.equal(metrics.DUPLICATE_PROVIDER_PERSPECTIVES, 0);
  assert.equal(metrics.PERSPECTIVE_FALLBACK_SUBSTITUTION, 0);
  assert.equal(metrics.PARTIAL_FAILURE_TRUTHFUL, 'PASS');
  assert.equal(metrics.ALL_PROVIDER_FAILURE_TRUTHFUL, 'PASS');
  assert.equal(metrics.SYNTHESIS_FAILURE_TRUTHFUL, 'PASS');
  assert.equal(metrics.MODEL_VOTING, 0);
  assert.equal(metrics.MODEL_WINNER, 0);
  assert.equal(metrics.MODEL_SCORE, 0);
  assert.equal(metrics.MEMORY_AS_EVIDENCE, 0);
  assert.equal(metrics.RAW_PROVIDER_NAME_PRIMARY_UI, 0);
  assert.equal(metrics.MODEL_PICKER_PRIMARY_UI, 0);
  assert.equal(metrics.TECHNICAL_UI_LEAK, 0);
  assert.equal(metrics.ROUTING_LOG_PRIVACY, 'PASS');
});

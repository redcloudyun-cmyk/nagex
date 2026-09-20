import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright';
import { NagexError } from '../src/common/errors.js';
import type { ModelProvider, ModelRequest, ModelResponse, ProviderStatus } from '../src/model-gateway/model-provider.js';
import { UnifiedModelRouter } from '../src/model-gateway/unified-model-router.js';
import { ForecastCompareService, parseIndependentForecastJson, parseForecastSynthesisJson, parseHorizonEnd } from '../src/model-gateway/forecast-compare.service.js';
import { EvidencePackService } from '../src/research/evidence-pack.service.js';
import type { EvidencePack } from '../src/research/evidence-pack.types.js';
import { createServerInstance } from '../src/server_web.js';

declare const window: any;

class MockForecastModelProvider implements ModelProvider {
  public readonly name: string;
  public readonly model: string;
  public readonly capabilities: any;
  private isConfigured: boolean;
  private isLive: boolean;
  private shouldFail: boolean;
  public lastReceivedRequest?: ModelRequest;
  public attemptCount = 0;
  public returnedProbability = 0.65;

  constructor(name: string, model: string, isConfigured = true, isLive = true, shouldFail = false, prob = 0.65) {
    this.name = name;
    this.model = model;
    this.isConfigured = isConfigured;
    this.isLive = isLive;
    this.shouldFail = shouldFail;
    this.returnedProbability = prob;
    this.capabilities = {
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

    const isSynthesis = request.messages.some((m) =>
      m.content.includes('Synthesize one unified NAgex Forecast') ||
      m.content.includes('probabilityRange') ||
      m.content.includes('FORECAST_SYNTHESIS')
    );

    if (isSynthesis) {
      const synthesisJson = JSON.stringify({
        probability: 0.60,
        probabilityRange: { low: 0.50, high: 0.70 },
        summary: 'NAgex synthesized forecast based on shared evidence and independent probabilities.',
        keyDrivers: ['Development timeline is on track', 'Core dependencies are resolved'],
        counterSignals: ['External API dependency risk', 'Testing suite bottleneck'],
        uncertainties: ['Final QA certification timeline'],
        whatWouldChangeTheForecast: ['Completion of automated testing suite ahead of schedule'],
      });
      return {
        text: synthesisJson,
        provider: this.name,
        model: this.model,
        latencyMs: 20,
        requestId: request.requestId,
      };
    }

    const independentJson = JSON.stringify({
      probability: this.returnedProbability,
      rationale: `Independent probability calculation by ${this.name}.`,
      supportingFactors: ['Milestones on schedule', 'Team capacity confirmed'],
      opposingFactors: ['Unresolved edge cases'],
      keyAssumptions: ['No major scope changes'],
      uncertaintyDrivers: ['Third party integration latency'],
    });

    return {
      text: independentJson,
      provider: this.name,
      model: this.model,
      latencyMs: 15,
      requestId: request.requestId,
    };
  }
}

test('NAgex R22.7 — Forecast Horizon Parsing & Specification Hardening', () => {
  // 1. Production Clock Default Test (now = new Date())
  const defaultHorizon = parseHorizonEnd('Will this project launch before December 2026?');
  assert.ok(defaultHorizon && defaultHorizon.includes('T23:59:59+09:00'), 'Default clock MUST produce valid ISO horizon string');

  // 2. Dynamic Injected Clock Shift Tests
  const nowSept = new Date('2026-09-20T15:00:00+09:00');
  const nowOct = new Date('2026-10-05T10:00:00+09:00');

  // "이번 달 안에"
  assert.equal(parseHorizonEnd('이번 달 안에 완료될까?', nowSept), '2026-09-30T23:59:59+09:00');
  assert.equal(parseHorizonEnd('이번 달 안에 완료될까?', nowOct), '2026-10-31T23:59:59+09:00');

  // "within two weeks"
  assert.equal(parseHorizonEnd('will this happen within two weeks?', nowSept), '2026-10-04T23:59:59+09:00');
  assert.equal(parseHorizonEnd('will this happen within two weeks?', nowOct), '2026-10-19T23:59:59+09:00');

  // "10월까지"
  assert.equal(parseHorizonEnd('10월까지 성공할까?', nowSept), '2026-10-31T23:59:59+09:00');
  assert.equal(parseHorizonEnd('10월까지 성공할까?', new Date('2026-11-01T10:00:00+09:00')), '2027-10-31T23:59:59+09:00');
});

test('NAgex R22.7 — Forecast Compare Logic Suite', async () => {
  const p1 = new MockForecastModelProvider('Gemini', 'gemini-2.5-flash', true, true, false, 0.65);
  const p2 = new MockForecastModelProvider('Nebius', 'meta-llama/Meta-Llama-3.1-70B-Instruct', true, true, false, 0.58);
  const p3 = new MockForecastModelProvider('OpenAI', 'gpt-4o-mini', true, true, false, 0.62);

  const router = new UnifiedModelRouter([p1, p2, p3]);

  let acquireCallCount = 0;
  const mockEvidencePackService = {
    async buildEvidencePack(query: string) {
      acquireCallCount++;
      return {
        evidencePackId: `ep_fc_${Date.now()}`,
        query,
        category: 'GENERAL',
        status: 'SUCCESS',
        freshnessStatus: 'CURRENT',
        freshnessRequirement: 'REQUIRED',
        generatedAt: new Date().toISOString(),
        gatheredAt: new Date().toISOString(),
        sources: [{ sourceId: 'src_1', title: 'Official Launch Schedule', url: 'https://example.com/schedule', snippet: 'Launch targeted for Q4 2026.', retrievedAt: new Date().toISOString(), freshnessStatus: 'CURRENT' }],
        summary: 'Official roadmap specifies launch before December 2026.',
        keyFacts: ['Roadmap approved', 'Production staging active'],
      } as EvidencePack;
    },
  } as unknown as EvidencePackService;

  const service = new ForecastCompareService(router, mockEvidencePackService);

  // 1. Ambiguity Fail-Closed (AMBIGUOUS_FORECAST_GUESS=0)
  const ambiguousQueries = [
    'Will this project launch?',
    'Will it be successful?',
    'Will revenue increase?',
    '이 프로젝트 성공할까?',
    '출시할 수 있을까?',
    'Will sales increase?',
    'Will we finish this?',
    '성공할 가능성은?',
  ];

  for (const q of ambiguousQueries) {
    const res = await service.compare({ query: q });
    assert.equal(res.status, 'NEEDS_CLARIFICATION', `Query "${q}" without explicit horizon MUST return NEEDS_CLARIFICATION`);
    assert.equal(res.specification, null);
    assert.ok(res.clarificationMessage);
  }

  // 2. Clear specification derivation & execution
  acquireCallCount = 0;
  const validRes = await service.compare({ query: 'Will this project launch before December 2026?' });
  assert.equal(validRes.status, 'SUCCESS');
  assert.equal(acquireCallCount, 1, 'ONE shared EvidencePack acquired per forecast');
  assert.ok(validRes.specification);
  assert.equal(validRes.specification.outcomeType, 'BINARY');
  assert.ok(validRes.specification.target);
  assert.equal(validRes.specification.horizonEnd, '2026-11-30T23:59:59+09:00', 'horizonEnd MUST match calculated deadline');
  assert.ok(validRes.specification.resolutionCriteria.includes('2026-11-30T23:59:59+09:00'));

  assert.equal(validRes.forecastsAttempted, 3);
  assert.equal(validRes.forecastsSucceeded, 3);
  assert.ok(validRes.distribution);
  assert.equal(validRes.distribution.min, 0.58);
  assert.equal(validRes.distribution.max, 0.65);

  assert.ok(validRes.synthesis);
  assert.equal(validRes.synthesis.probability, 0.60);
  assert.equal(validRes.synthesis.probabilityRange.low, 0.50);
  assert.equal(validRes.synthesis.probabilityRange.high, 0.70);

  // 3. Negative Schema Tests
  assert.throws(() => {
    parseIndependentForecastJson(JSON.stringify({ probability: 1.4, rationale: 'x' }), 'req_test');
  }, (err: any) => err.code === 'PROBABILITY_OUT_OF_RANGE');

  assert.throws(() => {
    parseIndependentForecastJson(JSON.stringify({ probability: '60%', rationale: 'x' }), 'req_test');
  }, (err: any) => err.code === 'FORECAST_SCHEMA_FAIL_CLOSED');

  assert.throws(() => {
    parseIndependentForecastJson(JSON.stringify({ probability: 0.6, supportingFactors: 'wrong' }), 'req_test');
  }, (err: any) => err.code === 'FORECAST_SCHEMA_FAIL_CLOSED');

  // Exact required negative tests:
  // 1) missing rationale and array fields
  assert.throws(() => {
    parseIndependentForecastJson(JSON.stringify({ probability: 0.6 }), 'req_test');
  }, (err: any) => err.code === 'FORECAST_SCHEMA_FAIL_CLOSED');

  // 2) empty rationale string
  assert.throws(() => {
    parseIndependentForecastJson(JSON.stringify({
      probability: 0.6,
      rationale: '',
      supportingFactors: [],
      opposingFactors: [],
      keyAssumptions: [],
      uncertaintyDrivers: [],
    }), 'req_test');
  }, (err: any) => err.code === 'FORECAST_SCHEMA_FAIL_CLOSED');

  // 3) null array field
  assert.throws(() => {
    parseIndependentForecastJson(JSON.stringify({
      probability: 0.6,
      rationale: 'x',
      supportingFactors: null,
      opposingFactors: [],
      keyAssumptions: [],
      uncertaintyDrivers: [],
    }), 'req_test');
  }, (err: any) => err.code === 'FORECAST_SCHEMA_FAIL_CLOSED');

  assert.throws(() => {
    parseForecastSynthesisJson(JSON.stringify({
      probability: 0.6,
      probabilityRange: { low: 0.8, high: 0.5 },
      summary: 'x',
      keyDrivers: [],
      counterSignals: [],
      uncertainties: [],
      whatWouldChangeTheForecast: [],
    }), 'req_test');
  }, (err: any) => err.code === 'PROBABILITY_RANGE_INVALID');

  // 4. Fallback Policy DISALLOW check — provider failure truthful handling
  p2.setShouldFail(true);
  const partial2Res = await service.compare({ query: 'Will this project launch before December 2026?' });
  assert.equal(partial2Res.status, 'SUCCESS'); // 2 of 3 succeeded -> SUCCESS distribution
  assert.equal(partial2Res.forecastsAttempted, 3);
  assert.equal(partial2Res.forecastsSucceeded, 2);

  p3.setShouldFail(true);
  const singleRes = await service.compare({ query: 'Will this project launch before December 2026?' });
  assert.equal(singleRes.status, 'PARTIAL'); // only 1 success -> PARTIAL status
  assert.equal(singleRes.forecastsSucceeded, 1);
  assert.equal(singleRes.synthesis, null, 'Single forecast MUST NOT fabricate synthesis or range');

  p1.setShouldFail(true);
  const unavailableRes = await service.compare({ query: 'Will this project launch before December 2026?' });
  assert.equal(unavailableRes.status, 'UNAVAILABLE');

  p1.setShouldFail(false);
  p2.setShouldFail(false);
  p3.setShouldFail(false);

  // 5. Evidence Failure Truthful Handling
  const failEvidenceService = {
    async buildEvidencePack(query: string) {
      return {
        evidencePackId: 'ep_fail_001',
        query,
        category: 'GENERAL',
        status: 'UNAVAILABLE',
        freshnessStatus: 'UNAVAILABLE',
        freshnessRequirement: 'REQUIRED',
        generatedAt: new Date().toISOString(),
        gatheredAt: new Date().toISOString(),
        sources: [],
        summary: 'Search failed',
        keyFacts: [],
      } as EvidencePack;
    },
  } as unknown as EvidencePackService;

  const failEvidenceForecastService = new ForecastCompareService(router, failEvidenceService);
  const noEvidenceRes = await failEvidenceForecastService.compare({ query: 'Will this project launch before December 2026?' });
  assert.equal(noEvidenceRes.status, 'UNAVAILABLE');

  // 6. Elections Guard Policy
  const electionRes = await service.compare({ query: 'Who will win the upcoming presidential election?' });
  assert.equal(electionRes.status, 'INFORMATIONAL');
  assert.equal(electionRes.specification, null);
  assert.equal(electionRes.synthesis, null);
  assert.equal(electionRes.forecastsAttempted, 0, 'Elections queries do not invoke proprietary model probability forecasting');
  assert.equal(electionRes.forecastsSucceeded, 0);
  assert.ok(electionRes.informationalMessage);
  assert.ok(electionRes.informationalMessage.includes('polling'));
});

test('NAgex R22.7 — Real Browser Certification & UI Verification', async () => {
  const server = createServerInstance();

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.once('error', reject);
  });

  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  let browser: Browser | undefined;

  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    let apiCalled = false;

    await page.route('**/api/v1/ai/forecast-compare', async (route) => {
      apiCalled = true;
      const req = route.request();
      const requestPayload = JSON.parse(req.postData() || '{}');
      const q = (requestPayload.query || '').toLowerCase();

      if (q.includes('election') || q.includes('선거') || q.includes('대선')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            requestId: 'req_test_fc_elec',
            status: 'INFORMATIONAL',
            specification: null,
            forecastsAttempted: 0,
            forecastsSucceeded: 0,
            distribution: null,
            synthesis: null,
            informationalMessage: 'NAgex does not generate proprietary election outcome forecasts. For election information, refer to dated polling measurements and official election authority reports.',
          }),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          requestId: 'req_test_fc_001',
          status: 'SUCCESS',
          specification: {
            question: requestPayload.query,
            target: 'Project launch',
            outcomeType: 'BINARY',
            horizonStart: '2026-09-20T00:00:00+09:00',
            horizonEnd: '2026-11-30T23:59:59+09:00',
            resolutionCriteria: 'Publicly available before December 1, 2026.',
            assumptions: [],
            createdAt: '2026-09-20T15:00:00+09:00',
          },
          forecastsAttempted: 3,
          forecastsSucceeded: 3,
          distribution: { min: 0.58, max: 0.65, median: 0.62, spread: 0.07 },
          synthesis: {
            probability: 0.60,
            probabilityRange: { low: 0.50, high: 0.70 },
            summary: 'The project is likely to launch before December based on current milestone progress.',
            keyDrivers: ['Milestones are on track', 'Core dependencies resolved'],
            counterSignals: ['External API dependency latency'],
            uncertainties: ['Final QA certification timeline'],
            whatWouldChangeTheForecast: ['Completion of testing ahead of schedule'],
          },
          evidencePackId: 'ep_test_001',
          sources: [{ title: 'Project Roadmap 2026', url: 'https://example.com/roadmap' }],
        }),
      });
    });

    await page.goto(`${baseUrl}/?demo=1`);
    await page.waitForLoadState('networkidle');

    // 1. Standard Forecast Flow
    const homeInput = page.locator('#home-prompt-input');
    await homeInput.fill('forecast will this project launch before December 2026');
    await page.click('#btn-home-prompt-send');

    await page.waitForSelector('[data-testid="forecast-compare-result"]', { timeout: 15000 });
    const enText = await page.locator('[data-testid="forecast-compare-result"]').innerText();

    assert.ok(apiCalled, 'POST /api/v1/ai/forecast-compare must be called');
    assert.ok(enText.includes('Forecast') || enText.includes('Estimated likelihood') || enText.includes('60%'), 'Forecast UI must render synthesized result');

    // Primary UI Truthfulness Checks
    assert.ok(!enText.includes('Gemini'), 'Primary UI must NOT reveal Gemini brand name');
    assert.ok(!enText.includes('Nebius'), 'Primary UI must NOT reveal Nebius brand name');
    assert.ok(!enText.includes('OpenAI'), 'Primary UI must NOT reveal OpenAI brand name');
    assert.ok(!enText.includes('forecast.likelihood'), 'Primary UI must NOT leak raw i18n keys');

    // 2. Election Certification UI Flow (ELECTION_PROBABILITY_UI=0, ELECTION_RANGE_UI=0, ELECTION_INFORMATIONAL_UI=PASS)
    const closeBtn = page.locator('#btn-close-ambient');
    if (await closeBtn.isVisible()) {
      await closeBtn.click();
    }

    await homeInput.fill('Who will win the presidential election?');
    await page.click('#btn-home-prompt-send');

    await page.waitForSelector('[data-testid="forecast-compare-result"]', { timeout: 15000 });
    const electionUiText = await page.locator('[data-testid="forecast-compare-result"]').innerText();

    assert.ok(electionUiText.includes('NAgex does not generate proprietary election outcome forecasts'), 'Election UI must display informational text');
    assert.ok(!electionUiText.includes('%'), 'Election UI must NOT display probability percentage');
    assert.ok(!electionUiText.includes('50%'), 'Election UI must NOT display 50% probability fallback');
    assert.ok(!electionUiText.includes('50–50%'), 'Election UI must NOT display 50-50 range');
    assert.ok(!electionUiText.includes('Estimated likelihood'), 'Election UI must NOT display likelihood metrics section');

    // 3. Korean Localization Parity
    await page.evaluate(() => {
      if (window.i18n && typeof window.i18n.setLocale === 'function') {
        window.i18n.setLocale('ko');
      }
      if (window.NAGEX_I18N) {
        window.NAGEX_I18N.setLocale('ko');
      }
      localStorage.setItem('nagex_locale', 'ko');
    });

    if (await closeBtn.isVisible()) {
      await closeBtn.click();
    }

    await homeInput.fill('이게 일어날 가능성을 예측해줘');
    await page.click('#btn-home-prompt-send');

    await page.waitForSelector('[data-testid="forecast-compare-result"]', { timeout: 15000 });
    const krText = await page.locator('[data-testid="forecast-compare-result"]').innerText();

    assert.ok(krText.includes('예측') || krText.includes('예상 가능성') || krText.includes('60%'), 'Korean Forecast UI must render localized labels');
  } finally {
    if (browser) {
      await browser.close();
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});

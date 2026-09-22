import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIProvider, GeminiProvider, NebiusProvider, createProviders } from '../src/model-gateway/providers.js';
import { UnifiedModelRouter } from '../src/model-gateway/unified-model-router.js';
import { AiService } from '../src/model-gateway/ai-service.js';
import { handleAsyncApiRequest } from '../src/server_web.js';
import type { ModelRequest } from '../src/model-gateway/model-provider.js';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

test('OpenAIProvider calls Responses API with environment-selected model', async () => {
  let captured: { url?: string; init?: RequestInit } = {};
  const provider = new OpenAIProvider({ apiKey: 'secret-openai', model: 'env-openai-model', fetchFn: async (url, init) => {
    captured = { url: String(url), init };
    return jsonResponse({ output_text: 'hello from openai' });
  }});
  const result = await provider.generate({ messages: [{ role: 'user', content: 'hello' }], requestId: 'req_openai' });
  assert.equal(captured.url, 'https://api.openai.com/v1/responses');
  assert.equal(JSON.parse(String(captured.init?.body)).model, 'env-openai-model');
  assert.equal((captured.init?.headers as Record<string, string>).Authorization, 'Bearer secret-openai');
  assert.equal(result.provider, 'openai');
  assert.equal(result.model, 'env-openai-model');
});

test('GeminiProvider calls generateContent and normalizes response metadata', async () => {
  let capturedUrl = '';
  const provider = new GeminiProvider({ apiKey: 'secret-gemini', model: 'env-gemini-model', fetchFn: async (url) => {
    capturedUrl = String(url);
    return jsonResponse({ candidates: [{ content: { parts: [{ text: 'hello from gemini' }] } }] });
  }});
  const result = await provider.generate({ messages: [{ role: 'user', content: 'hello' }], requestId: 'req_gemini' });
  assert.match(capturedUrl, /env-gemini-model:generateContent$/);
  assert.equal(result.text, 'hello from gemini');
  assert.equal(result.requestId, 'req_gemini');
});

test('NebiusProvider uses Token Factory with the configured NVIDIA model ID', async () => {
  let captured: { url?: string; body?: any } = {};
  const provider = new NebiusProvider({ apiKey: 'secret-nebius', model: 'nvidia/env-nemotron', fetchFn: async (url, init) => {
    captured = { url: String(url), body: JSON.parse(String(init?.body)) };
    return jsonResponse({ choices: [{ message: { content: 'hello from nemotron' } }] });
  }});
  const result = await provider.generate({ messages: [{ role: 'user', content: 'hello' }], requestId: 'req_nebius', jsonMode: true });
  assert.equal(captured.url, 'https://api.tokenfactory.nebius.com/v1/chat/completions');
  assert.equal(captured.body.model, 'nvidia/env-nemotron');
  assert.deepEqual(captured.body.response_format, { type: 'json_object' });
  assert.equal(result.provider, 'nebius');
});

test('UnifiedModelRouter falls back after a normalized provider HTTP failure', async () => {
  const fetchFn: typeof fetch = async (url) => String(url).includes('openai.com')
    ? jsonResponse({ error: 'rate limited' }, 429)
    : jsonResponse({ candidates: [{ content: { parts: [{ text: 'fallback success' }] } }] });
  const providers = createProviders({ OPENAI_API_KEY: 'a', NAGEX_OPENAI_MODEL: 'oa', GEMINI_API_KEY: 'g', NAGEX_GEMINI_MODEL: 'gm' }, fetchFn);
  const events: Array<Record<string, unknown>> = [];
  const router = new UnifiedModelRouter(providers, { info: (_event, fields) => events.push(fields), warn: (_event, fields) => events.push(fields) });
  const result = await router.generate({ mode: 'openai', messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(result.provider, 'gemini');
  assert.equal(events.length, 2);
  assert.ok(events.every((event) => !JSON.stringify(event).includes('secret')));
});

test('structured plan routing falls back when a provider returns invalid JSON', async () => {
  const fetchFn: typeof fetch = async (url) => String(url).includes('openai.com')
    ? jsonResponse({ output_text: 'not json' })
    : jsonResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify({
      goal: 'Goal', summary: 'Summary', reasoningSummary: 'Rationale',
      steps: [{ title: 'Review', reasoning: 'Prepare safely', skill: 'Planning', tool: null, requiresApproval: false }],
    }) }] } }] });
  const providers = createProviders({ OPENAI_API_KEY: 'a', NAGEX_OPENAI_MODEL: 'oa', GEMINI_API_KEY: 'g', NAGEX_GEMINI_MODEL: 'gm' }, fetchFn);
  const service = new AiService(new UnifiedModelRouter(providers, { info: () => {}, warn: () => {} }));
  const result = await service.plan({ prompt: 'Make a plan', memories: [], mode: 'openai', requestId: 'req_invalid_fallback' });
  assert.equal(result.provider, 'gemini');
  assert.equal(result.data.steps.length, 1);
});

test('provider status exposes configuration metadata and never API keys', async () => {
  const providers = createProviders({ OPENAI_API_KEY: 'top-secret', NAGEX_OPENAI_MODEL: 'oa' }, async () => jsonResponse({}));
  const service = new AiService(new UnifiedModelRouter(providers, { info: () => {}, warn: () => {} }));
  const result = await handleAsyncApiRequest('GET', '/api/v1/providers/status', null, {}, service);
  assert.equal(result.status, 200);
  const serialized = JSON.stringify(result.data);
  assert.doesNotMatch(serialized, /top-secret|apiKey|OPENAI_API_KEY/);
  const status = (result.data as any).providers[0];
  assert.deepEqual(Object.keys(status).sort(), ['available', 'configured', 'degradedReason', 'lastCheckedAt', 'model', 'provider', 'status']);
  // R7 §2/§3 — the active/fallback summary alongside the per-provider array.
  assert.equal((result.data as any).activeProvider, 'openai');
  assert.equal((result.data as any).activeModel, 'oa');
  assert.deepEqual((result.data as any).fallbackProviders, []);
});

test('POST /api/v1/ai/chat returns normalized metadata from a mocked live provider response', async () => {
  const providers = createProviders(
    { OPENAI_API_KEY: 'a', NAGEX_OPENAI_MODEL: 'env-chat-model', NAGEX_MODEL_PROVIDER: 'openai' },
    async () => jsonResponse({ output_text: 'A real provider-shaped response.' }),
  );
  const service = new AiService(new UnifiedModelRouter(providers, { info: () => {}, warn: () => {} }));
  const result = await handleAsyncApiRequest(
    'POST',
    '/api/v1/ai/chat',
    { message: 'Hello', provider: 'openai' },
    { 'x-request-id': 'req_chat_endpoint' },
    service,
  );
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, {
    data: { message: 'A real provider-shaped response.' },
    provider: 'openai',
    model: 'env-chat-model',
    latencyMs: (result.data as any).latencyMs,
    requestId: 'req_chat_endpoint',
  });
  assert.equal(typeof (result.data as any).latencyMs, 'number');
});

test('provider timeout is normalized and eligible for fallback', async () => {
  const neverCompletes: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  });
  const provider = new OpenAIProvider({ apiKey: 'a', model: 'oa', fetchFn: neverCompletes, timeoutMs: 5 });
  await assert.rejects(
    () => provider.generate({ messages: [{ role: 'user', content: 'hello' }], requestId: 'req_timeout' }),
    (error: any) => error.code === 'PROVIDER_TIMEOUT' && error.category === 'TIMEOUT',
  );
});

// ── R7 §4 — real (not fabricated) provider runtime status derivation ──
test('status() is UNCONFIGURED with no key/model, never a fake LIVE', () => {
  const provider = new OpenAIProvider({});
  const status = provider.status();
  assert.equal(status.status, 'UNCONFIGURED');
  assert.equal(status.configured, false);
  assert.equal(status.available, false);
  assert.equal(status.lastCheckedAt, null);
});

test('status() is CONFIGURED (not LIVE) before any real call has been attempted — an API key alone is not evidence of a working connection, so available must be false', () => {
  const provider = new OpenAIProvider({ apiKey: 'a', model: 'oa' });
  const status = provider.status();
  assert.equal(status.status, 'CONFIGURED');
  assert.equal(status.configured, true);
  // R7.1 root-cause fix: configured=true must never by itself imply
  // available=true. Only an observed LIVE call does.
  assert.equal(status.available, false);
  assert.equal(status.lastCheckedAt, null);
});

test('status() becomes LIVE only after a real generate() call actually succeeds', async () => {
  const provider = new OpenAIProvider({ apiKey: 'a', model: 'oa', fetchFn: async () => jsonResponse({ output_text: 'hi' }) });
  await provider.generate({ messages: [{ role: 'user', content: 'hello' }], requestId: 'req_live' });
  const status = provider.status();
  assert.equal(status.status, 'LIVE');
  assert.equal(status.available, true);
  assert.equal(status.degradedReason, null);
  assert.ok(status.lastCheckedAt && !Number.isNaN(Date.parse(status.lastCheckedAt)));
});

test('status() becomes DEGRADED (not fake LIVE) after a real generate() call actually fails, and available flips false', async () => {
  const provider = new OpenAIProvider({ apiKey: 'a', model: 'oa', fetchFn: async () => jsonResponse({ error: 'invalid key' }, 401) });
  await assert.rejects(() => provider.generate({ messages: [{ role: 'user', content: 'hello' }], requestId: 'req_degraded' }));
  const status = provider.status();
  assert.equal(status.status, 'DEGRADED');
  assert.equal(status.configured, true);
  assert.equal(status.available, false);
  assert.equal(status.degradedReason, 'PROVIDER_HTTP_401');
});

test('a provider that recovers after a failure flips back from DEGRADED to LIVE on the next real success — never sticky', async () => {
  let fail = true;
  const provider = new OpenAIProvider({ apiKey: 'a', model: 'oa', fetchFn: async () => fail ? jsonResponse({}, 500) : jsonResponse({ output_text: 'recovered' }) });
  await assert.rejects(() => provider.generate({ messages: [{ role: 'user', content: 'hello' }], requestId: 'req_1' }));
  assert.equal(provider.status().status, 'DEGRADED');
  fail = false;
  await provider.generate({ messages: [{ role: 'user', content: 'hello' }], requestId: 'req_2' });
  assert.equal(provider.status().status, 'LIVE');
});

// ── R7 §10 — real token usage metadata only, never estimated ──
test('OpenAIProvider passes through real usage metadata when the API returns it', async () => {
  const provider = new OpenAIProvider({ apiKey: 'a', model: 'oa', fetchFn: async () => jsonResponse({ output_text: 'hi', usage: { input_tokens: 12, output_tokens: 34, total_tokens: 46 } }) });
  const result = await provider.generate({ messages: [{ role: 'user', content: 'hello' }], requestId: 'req_usage' });
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 34, totalTokens: 46 });
});

test('OpenAIProvider reports usage as null (never a guessed number) when the API response has no usage field', async () => {
  const provider = new OpenAIProvider({ apiKey: 'a', model: 'oa', fetchFn: async () => jsonResponse({ output_text: 'hi' }) });
  const result = await provider.generate({ messages: [{ role: 'user', content: 'hello' }], requestId: 'req_no_usage' });
  assert.equal(result.usage, null);
});

test('UnifiedModelRouter.activeProviderSummary() reflects real registration/priority order and configured-only providers', () => {
  const providers = createProviders({ GEMINI_API_KEY: 'g', NAGEX_GEMINI_MODEL: 'gm', NEBIUS_API_KEY: 'n', NAGEX_NEBIUS_MODEL: 'nm' });
  const router = new UnifiedModelRouter(providers, { info: () => {}, warn: () => {} });
  const summary = router.activeProviderSummary();
  // default priority is nebius,openai,gemini — openai unconfigured here, so
  // active must be nebius and fallback must be exactly [gemini].
  assert.equal(summary.activeProvider, 'nebius');
  assert.equal(summary.activeModel, 'nm');
  assert.deepEqual(summary.fallbackProviders, ['gemini']);
  // R7.1 — activeProvider is a routing candidate, not a liveness claim;
  // activeProviderStatus must say CONFIGURED here (nothing has been probed
  // or called yet), never LIVE.
  assert.equal(summary.activeProviderStatus, 'CONFIGURED');
});

// ── R7.1 — full CONFIGURED → LIVE → DEGRADED → LIVE state-machine matrix,
// exactly the four states/transitions the directive requires be tested ──
test('R7.1 state matrix: initial state is CONFIGURED with available=false, lastCheckedAt=null', () => {
  const provider = new OpenAIProvider({ apiKey: 'a', model: 'oa' });
  const status = provider.status();
  assert.equal(status.configured, true);
  assert.equal(status.available, false);
  assert.equal(status.status, 'CONFIGURED');
  assert.equal(status.lastCheckedAt, null);
});

test('R7.1 state matrix: after a real/mocked successful call, available=true, status=LIVE, lastCheckedAt is a real timestamp', async () => {
  const provider = new OpenAIProvider({ apiKey: 'a', model: 'oa', fetchFn: async () => jsonResponse({ output_text: 'pong' }) });
  await provider.generate({ messages: [{ role: 'user', content: 'ping' }], requestId: 'req_matrix_live' });
  const status = provider.status();
  assert.equal(status.available, true);
  assert.equal(status.status, 'LIVE');
  assert.ok(status.lastCheckedAt && !Number.isNaN(Date.parse(status.lastCheckedAt)));
  assert.equal(status.degradedReason, null);
});

test('R7.1 state matrix: after a failed call, available=false, status=DEGRADED, lastCheckedAt set, degradedReason sanitized (no raw provider body)', async () => {
  const provider = new OpenAIProvider({ apiKey: 'a', model: 'oa', fetchFn: async () => jsonResponse({ error: { message: 'sk-verysecretkey123 is invalid' } }, 401) });
  await assert.rejects(() => provider.generate({ messages: [{ role: 'user', content: 'ping' }], requestId: 'req_matrix_degraded' }));
  const status = provider.status();
  assert.equal(status.available, false);
  assert.equal(status.status, 'DEGRADED');
  assert.ok(status.lastCheckedAt);
  assert.equal(status.degradedReason, 'PROVIDER_HTTP_401');
  assert.doesNotMatch(status.degradedReason!, /sk-verysecretkey123/);
});

test('R7.1 state matrix: DEGRADED recovers to LIVE on the next successful call (never sticky)', async () => {
  let fail = true;
  const provider = new OpenAIProvider({ apiKey: 'a', model: 'oa', fetchFn: async () => fail ? jsonResponse({}, 500) : jsonResponse({ output_text: 'recovered' }) });
  await assert.rejects(() => provider.generate({ messages: [{ role: 'user', content: 'ping' }], requestId: 'req_matrix_1' }));
  assert.equal(provider.status().status, 'DEGRADED');
  fail = false;
  await provider.generate({ messages: [{ role: 'user', content: 'ping' }], requestId: 'req_matrix_2' });
  const status = provider.status();
  assert.equal(status.status, 'LIVE');
  assert.equal(status.available, true);
  assert.equal(status.degradedReason, null);
});

test('R7.1 state matrix: restart never carries LIVE/DEGRADED health forward — a fresh provider instance with the same real env is CONFIGURED, not a stale prior state', async () => {
  const provider1 = new OpenAIProvider({ apiKey: 'a', model: 'oa', fetchFn: async () => jsonResponse({ output_text: 'pong' }) });
  await provider1.generate({ messages: [{ role: 'user', content: 'ping' }], requestId: 'req_before_restart' });
  assert.equal(provider1.status().status, 'LIVE');

  // Simulates a process restart: a brand-new provider instance (in-memory
  // health state is never persisted, by design — see providers.ts's
  // HttpModelProvider fields, which are plain instance fields, not backed
  // by any store).
  const provider2 = new OpenAIProvider({ apiKey: 'a', model: 'oa' });
  const status = provider2.status();
  assert.equal(status.status, 'CONFIGURED');
  assert.equal(status.available, false);
  assert.equal(status.lastCheckedAt, null);
});

// ── R7.1 — explicit bounded health-check probe ──
test('probe() causes a real generate() attempt and updates status() from CONFIGURED to LIVE', async () => {
  let calls = 0;
  const provider = new OpenAIProvider({ apiKey: 'a', model: 'oa', fetchFn: async () => { calls++; return jsonResponse({ output_text: 'pong' }); } });
  assert.equal(provider.status().status, 'CONFIGURED');
  await provider.probe();
  assert.equal(calls, 1);
  assert.equal(provider.status().status, 'LIVE');
});

test('probe() on an unconfigured provider is a real no-op — never calls fetch, stays UNCONFIGURED', async () => {
  let called = false;
  const provider = new OpenAIProvider({ fetchFn: async () => { called = true; return jsonResponse({}); } });
  await provider.probe();
  assert.equal(called, false);
  assert.equal(provider.status().status, 'UNCONFIGURED');
});

test('probe() failure sets DEGRADED and never throws out of the probe call itself', async () => {
  const provider = new OpenAIProvider({ apiKey: 'a', model: 'oa', fetchFn: async () => jsonResponse({}, 500) });
  await provider.probe(); // must not reject
  assert.equal(provider.status().status, 'DEGRADED');
});

test('UnifiedModelRouter.healthCheck() probes every configured provider in parallel and returns updated statuses, without GET /status itself ever calling it', async () => {
  const providers = createProviders(
    { OPENAI_API_KEY: 'a', NAGEX_OPENAI_MODEL: 'oa', GEMINI_API_KEY: 'g', NAGEX_GEMINI_MODEL: 'gm' },
    async (url) => String(url).includes('openai.com') ? jsonResponse({ output_text: 'pong' }) : jsonResponse({ candidates: [{ content: { parts: [{ text: 'pong' }] } }] }),
  );
  const router = new UnifiedModelRouter(providers, { info: () => {}, warn: () => {} });
  const configuredBefore = router.statuses().filter((s) => s.configured);
  assert.equal(configuredBefore.length, 2);
  assert.ok(configuredBefore.every((s) => s.status === 'CONFIGURED'));
  const updated = await router.healthCheck();
  assert.ok(updated.filter((s) => s.configured).every((s) => s.status === 'LIVE'));
  assert.ok(updated.find((s) => s.provider === 'nebius')!.status === 'UNCONFIGURED');
});

test('POST /api/v1/providers/health-check probes real/mocked providers and GET /api/v1/providers/status never triggers a probe on its own', async () => {
  let generateCalls = 0;
  const providers = createProviders({ OPENAI_API_KEY: 'a', NAGEX_OPENAI_MODEL: 'oa' }, async () => { generateCalls++; return jsonResponse({ output_text: 'pong' }); });
  const service = new AiService(new UnifiedModelRouter(providers, { info: () => {}, warn: () => {} }));

  const findOpenai = (data: any) => (data.providers as any[]).find((p) => p.provider === 'openai');

  const statusBefore = await handleAsyncApiRequest('GET', '/api/v1/providers/status', null, {}, service);
  assert.equal(generateCalls, 0, 'a plain GET /status must never itself cause a generation');
  assert.equal(findOpenai(statusBefore.data).status, 'CONFIGURED');

  const healthCheck = await handleAsyncApiRequest('POST', '/api/v1/providers/health-check', null, {}, service);
  assert.equal(healthCheck.status, 200);
  assert.equal(generateCalls, 1);
  assert.equal(findOpenai(healthCheck.data).status, 'LIVE');
  assert.equal((healthCheck.data as any).activeProviderStatus, 'LIVE');

  const statusAfter = await handleAsyncApiRequest('GET', '/api/v1/providers/status', null, {}, service);
  assert.equal(generateCalls, 1, 'reading status again after a probe must still not cause another generation');
  assert.equal(findOpenai(statusAfter.data).status, 'LIVE');
});

test('router accepts a future provider adapter without core routing changes', async () => {
  const futureProvider = {
    name: 'future-llm',
    model: 'future-model-from-config',
    // This test's point is router/adapter extensibility, not capability
    // filtering — the fixture truthfully declares full support since it's
    // a hypothetical future adapter, not standing in for any real provider.
    capabilities: { provider: 'future-llm', supportsJsonMode: true, supportsGeneralChat: true, supportsStructuredExtraction: true },
    status: () => ({ configured: true, available: true, provider: 'future-llm', model: 'future-model-from-config', status: 'LIVE' as const, lastCheckedAt: null, degradedReason: null }),
    generate: async (request: ModelRequest) => ({ text: 'future response', provider: 'future-llm', model: 'future-model-from-config', latencyMs: 1, requestId: request.requestId }),
  };
  const router = new UnifiedModelRouter([futureProvider], { info: () => {}, warn: () => {} });
  const auto = await router.generate({ mode: 'auto', messages: [{ role: 'user', content: 'hello' }] });
  const explicit = await router.generate({ mode: 'future-llm', messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(auto.provider, 'future-llm');
  assert.equal(explicit.provider, 'future-llm');
  assert.equal(router.statuses()[0].provider, 'future-llm');
});

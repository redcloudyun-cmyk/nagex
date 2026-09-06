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
  assert.deepEqual(Object.keys(status).sort(), ['available', 'configured', 'model', 'provider']);
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

test('router accepts a future provider adapter without core routing changes', async () => {
  const futureProvider = {
    name: 'future-llm',
    model: 'future-model-from-config',
    status: () => ({ configured: true, available: true, provider: 'future-llm', model: 'future-model-from-config' }),
    generate: async (request: ModelRequest) => ({ text: 'future response', provider: 'future-llm', model: 'future-model-from-config', latencyMs: 1, requestId: request.requestId }),
  };
  const router = new UnifiedModelRouter([futureProvider], { info: () => {}, warn: () => {} });
  const auto = await router.generate({ mode: 'auto', messages: [{ role: 'user', content: 'hello' }] });
  const explicit = await router.generate({ mode: 'future-llm', messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(auto.provider, 'future-llm');
  assert.equal(explicit.provider, 'future-llm');
  assert.equal(router.statuses()[0].provider, 'future-llm');
});

// NAgex — Nebius Token Factory / NVIDIA Nemotron runtime provider (adapter behavior).
//
// Everything here runs against a recording/fake OpenAI-compatible endpoint (an injected fetch, and one real local HTTP server).
// The normal suite NEVER calls the real, paid Nebius API; the opt-in real certification is scripts/nebius-live-cert.mjs.
// Proves: the configured provider talks to the right URL/model with the server-side credential only; a missing/unusable
// configuration is UNCONFIGURED rather than a crash; success is normalized (content, usage, finish reason, request id); hidden
// provider reasoning is never returned, logged or kept; and every failure (401/403/429/5xx/timeout/network/malformed) is
// reported truthfully with a fixed reason vocabulary and never as a result.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createProviders, NebiusProvider, DEFAULT_NEBIUS_MODEL, DEFAULT_NEBIUS_BASE_URL } from '../src/model-gateway/providers.js';
import { ModelProviderError, classifyModelFailure, type ModelRequest } from '../src/model-gateway/model-provider.js';
import { UnifiedModelRouter, type RouterLogger } from '../src/model-gateway/unified-model-router.js';
import { AiService } from '../src/model-gateway/ai-service.js';

const KEY = 'sk-NEBIUS-SECRET-SENTINEL-4f9a';
const MODEL = 'nvidia/Nemotron-3_5-Lightning';
const ok = (message: Record<string, unknown>, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify({ id: 'chatcmpl-abc123', choices: [{ index: 0, message, finish_reason: 'stop' }], ...extra }), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
const status = (code: number, body: unknown = { error: { message: `upstream said ${KEY}` } }, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json', ...headers } });
const req = (over: Partial<ModelRequest> = {}): ModelRequest => ({ messages: [{ role: 'user', content: 'hello' }], requestId: 'req_test', ...over });
function recorder(handler: (n: number, url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit; body: any }> = [];
  const fetchFn: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init as RequestInit, body: JSON.parse(String((init as RequestInit).body)) });
    return handler(calls.length, String(url), init as RequestInit);
  };
  return { calls, fetchFn };
}
const nebius = (fetchFn: typeof fetch, over: Record<string, unknown> = {}) => new NebiusProvider({ apiKey: KEY, model: MODEL, fetchFn, ...over });
const failure = async (p: Promise<unknown>): Promise<ModelProviderError> => { try { await p; } catch (e) { assert.ok(e instanceof ModelProviderError, `expected ModelProviderError, got ${String(e)}`); return e; } assert.fail('expected a failure, got a result'); };

describe('A. configured provider', () => {
  it('sends the request to the Token Factory chat-completions URL with the configured model and the server-side credential', async () => {
    const { calls, fetchFn } = recorder(() => ok({ content: 'NEMOTRON_OK' }));
    const result = await nebius(fetchFn).generate(req({
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: 'plan my day' },
      ],
    }));
    assert.equal(result.text, 'NEMOTRON_OK');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.tokenfactory.nebius.com/v1/chat/completions');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal((calls[0].init.headers as Record<string, string>).Authorization, `Bearer ${KEY}`, 'the credential is used internally');
    assert.equal(calls[0].body.model, MODEL);
    assert.deepEqual(calls[0].body.messages.map((m: any) => m.role), ['system', 'user', 'assistant', 'user']);
    assert.equal(JSON.stringify(calls[0].body).includes(KEY), false, 'the credential never travels in the body');
    assert.equal(calls[0].body.max_tokens, 8192, 'a reasoning-sized default budget');
    assert.equal(calls[0].body.response_format, undefined);
  });

  it('honors a per-request token budget and JSON mode; an abort signal bounds every call', async () => {
    const { calls, fetchFn } = recorder(() => ok({ content: '{"a":1}' }));
    await nebius(fetchFn).generate(req({ jsonMode: true, maxOutputTokens: 1234 }));
    assert.equal(calls[0].body.max_tokens, 1234);
    assert.deepEqual(calls[0].body.response_format, { type: 'json_object' });
    assert.ok(calls[0].init.signal instanceof AbortSignal);
  });

  it('createProviders: canonical defaults (model, base URL) apply, and the environment overrides them', async () => {
    assert.equal(DEFAULT_NEBIUS_MODEL, 'nvidia/Nemotron-3_5-Lightning');
    assert.equal(DEFAULT_NEBIUS_BASE_URL, 'https://api.tokenfactory.nebius.com/v1');
    const byDefault = createProviders({ NEBIUS_API_KEY: KEY }).find((p) => p.name === 'nebius')!;
    assert.equal(byDefault.model, MODEL);
    assert.equal(byDefault.status().configured, true);
    const { calls, fetchFn } = recorder(() => ok({ content: 'x' }));
    const custom = createProviders({ NEBIUS_API_KEY: KEY, NAGEX_NEBIUS_MODEL: 'nvidia/other', NAGEX_NEBIUS_BASE_URL: 'https://gateway.example.test/v1/' }, fetchFn).find((p) => p.name === 'nebius')!;
    await custom.generate(req());
    assert.equal(calls[0].url, 'https://gateway.example.test/v1/chat/completions');
    assert.equal(calls[0].body.model, 'nvidia/other');
  });

  it('an unsafe base URL (plain http to a remote host, embedded credentials, not a URL) leaves the provider UNCONFIGURED and sends nothing', async () => {
    for (const bad of ['http://attacker.example/v1', 'https://user:pw@gateway.example.test/v1', 'ftp://gateway.example.test/v1', 'not a url']) {
      const { calls, fetchFn } = recorder(() => ok({ content: 'x' }));
      const provider = createProviders({ NEBIUS_API_KEY: KEY, NAGEX_NEBIUS_BASE_URL: bad }, fetchFn).find((p) => p.name === 'nebius')!;
      assert.equal(provider.status().configured, false, bad);
      assert.equal(provider.status().status, 'UNCONFIGURED');
      const err = await failure(provider.generate(req()));
      assert.equal(err.code, 'PROVIDER_NOT_CONFIGURED');
      assert.equal(calls.length, 0, `${bad}: the credential was never sent anywhere`);
    }
  });
});

describe('B. missing key', () => {
  it('no NEBIUS_API_KEY: the provider is unavailable, nothing is sent, and the application does not crash', async () => {
    const { calls, fetchFn } = recorder(() => ok({ content: 'x' }));
    const providers = createProviders({}, fetchFn);
    const provider = providers.find((p) => p.name === 'nebius')!;
    assert.equal(provider.status().configured, false);
    assert.equal(provider.status().available, false);
    assert.equal(provider.status().status, 'UNCONFIGURED');
    assert.equal(classifyModelFailure((await failure(provider.generate(req()))).code), 'NO_PROVIDER_CREDENTIAL');
    assert.equal(calls.length, 0);
    const router = new UnifiedModelRouter(providers, { info: () => {}, warn: () => {} });
    await assert.rejects(() => router.generate({ messages: [{ role: 'user', content: 'x' }], mode: 'auto' }), (e: any) => e.code === 'NO_MODEL_PROVIDER_CONFIGURED');
  });

  it('a whitespace-only key is no key', () => {
    assert.equal(createProviders({ NEBIUS_API_KEY: '   ' }).find((p) => p.name === 'nebius')!.status().configured, false);
  });
});

describe('C. success normalization', () => {
  it('content, usage, finish reason, request id, provider, model and latency are normalized', async () => {
    const { fetchFn } = recorder(() => ok({ content: 'PLAN_OK' }, { usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33, completion_tokens_details: { reasoning_tokens: 7 } } }, { 'x-request-id': 'req-from-header-1' }));
    const result = await nebius(fetchFn).generate(req());
    assert.equal(result.text, 'PLAN_OK');
    assert.equal(result.provider, 'nebius');
    assert.equal(result.model, MODEL);
    assert.equal(result.requestId, 'req_test');
    assert.equal(typeof result.latencyMs, 'number');
    assert.deepEqual(result.usage, { inputTokens: 11, outputTokens: 22, totalTokens: 33, reasoningTokens: 7 });
    assert.equal(result.meta?.finishReason, 'stop');
    assert.equal(result.meta?.providerRequestId, 'req-from-header-1');
    assert.equal(result.meta?.reasoningAvailable, false);
  });

  it('usage is null (never guessed) when the provider reports none; the provider request id falls back to the payload id', async () => {
    const { fetchFn } = recorder(() => ok({ content: 'x' }));
    const result = await nebius(fetchFn).generate(req());
    assert.equal(result.usage, null);
    assert.equal(result.meta?.providerRequestId, 'chatcmpl-abc123');
  });

  it('a provider request id that is not a plain token is dropped, not echoed', async () => {
    const { fetchFn } = recorder(() => ok({ content: 'x' }, {}, { 'x-request-id': 'bad id\twith spaces' }));
    const r = await nebius(fetchFn).generate(req());
    assert.equal(r.meta?.providerRequestId, 'chatcmpl-abc123');
  });

  it('array content parts are joined', async () => {
    const { fetchFn } = recorder(() => ok({ content: [{ type: 'text', text: 'AB' }, { type: 'text', text: 'CD' }] }));
    assert.equal((await nebius(fetchFn).generate(req())).text, 'ABCD');
  });
});

describe('D. hidden reasoning is never exposed', () => {
  const CHAIN = 'CHAIN_OF_THOUGHT_SECRET_77';
  const logs: string[] = [];
  const logger: RouterLogger = { info: (e, f) => logs.push(JSON.stringify({ e, f })), warn: (e, f) => logs.push(JSON.stringify({ e, f })) };

  for (const shape of ['reasoning_content', 'reasoning'] as const) {
    it(`${shape}: the answer is content only; the reasoning text is dropped and only a boolean/count survives`, async () => {
      const { fetchFn } = recorder(() => ok({ content: 'ANSWER', [shape]: CHAIN }, { usage: { prompt_tokens: 1, completion_tokens: 9, total_tokens: 10, completion_tokens_details: { reasoning_tokens: 6 } } }));
      const router = new UnifiedModelRouter([nebius(fetchFn)], logger);
      const result = await router.generate({ messages: [{ role: 'user', content: 'x' }], mode: 'auto', routingContext: { taskKind: 'PLAN', requiresJson: false, requestId: 'r' } });
      assert.equal(result.text, 'ANSWER');
      assert.equal(result.meta?.reasoningAvailable, true);
      assert.equal(result.usage?.reasoningTokens, 6);
      assert.equal(JSON.stringify(result).includes(CHAIN), false, 'not in the model result');
      assert.equal(logs.join('\n').includes(CHAIN), false, 'not in any router log');
    });
  }

  it('inline <think> blocks are stripped from the answer (complete, closing-only), and an unterminated one yields no answer at all', async () => {
    for (const [raw, expected] of [[`<think>${CHAIN}</think>ANSWER`, 'ANSWER'], [`${CHAIN}</think>\nANSWER`, 'ANSWER'], [`A<think>${CHAIN}</think>B`, 'AB']] as const) {
      const { fetchFn } = recorder(() => ok({ content: raw }));
      const r = await nebius(fetchFn).generate(req());
      assert.equal(r.text, expected);
      assert.equal(r.meta?.reasoningAvailable, true);
      assert.equal(r.text.includes(CHAIN), false);
    }
    const { fetchFn } = recorder(() => ok({ content: `<think>${CHAIN} (cut off` }));
    const err = await failure(nebius(fetchFn).generate(req()));
    assert.equal(classifyModelFailure(err.code), 'INVALID_RESPONSE');
    assert.equal(JSON.stringify(err).includes(CHAIN), false);
  });

  it('reasoning only (content null) is a failure, not an answer built from the reasoning', async () => {
    const { fetchFn } = recorder(() => ok({ content: null, reasoning_content: CHAIN }));
    const err = await failure(nebius(fetchFn).generate(req()));
    assert.equal(classifyModelFailure(err.code), 'INVALID_RESPONSE');
    assert.equal(JSON.stringify({ message: err.message, details: err.details }).includes(CHAIN), false);
  });

  it('through AiService.plan: reasoning appears neither in the plan nor in the response nor in the logs', async () => {
    const plan = JSON.stringify({ goal: 'g', summary: 's', reasoningSummary: 'brief rationale', suggestions: [], steps: [{ title: 't', reasoning: 'r', skill: 'skill.x', tool: null, requiresApproval: false, necessity: 'REQUIRED', dependsOn: [], parameters: {} }] });
    const { fetchFn } = recorder(() => ok({ content: plan, reasoning_content: CHAIN }));
    const service = new AiService(new UnifiedModelRouter([nebius(fetchFn)], logger));
    const out = await service.plan({ prompt: 'p', memories: [], mode: 'auto', requestId: 'r_plan' });
    assert.equal(out.provider, 'nebius');
    assert.equal(JSON.stringify(out).includes(CHAIN), false);
    assert.equal(logs.join('\n').includes(CHAIN), false);
  });
});

describe('E. 401 / 403', () => {
  for (const code of [401, 403]) {
    it(`${code}: a truthful, non-retried provider failure — no fake result, no credential in the error`, async () => {
      const { calls, fetchFn } = recorder(() => status(code));
      const provider = nebius(fetchFn);
      const err = await failure(provider.generate(req()));
      assert.equal(err.code, `PROVIDER_HTTP_${code}`);
      assert.equal(err.retryable, false);
      assert.equal(classifyModelFailure(err.code), 'PROVIDER_REJECTION');
      assert.equal(calls.length, 1, 'no retry of an auth/config failure');
      assert.equal(provider.status().status, 'DEGRADED', 'the provider does not claim to be live');
      assert.equal(JSON.stringify({ m: err.message, d: err.details }).includes(KEY), false);
    });
  }

  it('with no other provider the router reports ALL_MODEL_PROVIDERS_FAILED with the safe reason, never a fabricated answer', async () => {
    const { fetchFn } = recorder(() => status(401));
    const router = new UnifiedModelRouter([nebius(fetchFn)], { info: () => {}, warn: () => {} });
    await assert.rejects(
      () => router.generate({ messages: [{ role: 'user', content: 'x' }], mode: 'auto', routingContext: { taskKind: 'PLAN', requiresJson: false, requestId: 'r' } }),
      (e: any) => e.code === 'ALL_MODEL_PROVIDERS_FAILED' && e.details.failures[0].reason === 'PROVIDER_REJECTION',
    );
  });
});

describe('F. 429', () => {
  it('is RATE_LIMITED, is retryable by the router but never retried inside the adapter', async () => {
    const { calls, fetchFn } = recorder(() => status(429, {}, { 'retry-after': '5' }));
    const err = await failure(nebius(fetchFn).generate(req()));
    assert.equal(err.code, 'PROVIDER_HTTP_429');
    assert.equal(classifyModelFailure(err.code), 'RATE_LIMITED');
    assert.equal(calls.length, 1);
  });
});

describe('G. 5xx and network failure: at most ONE retry', () => {
  it('500 then 200 succeeds on the single retry', async () => {
    const { calls, fetchFn } = recorder((n) => (n === 1 ? status(500) : ok({ content: 'RECOVERED' })));
    assert.equal((await nebius(fetchFn).generate(req())).text, 'RECOVERED');
    assert.equal(calls.length, 2);
  });

  it('500 twice fails after exactly two calls (one retry), reported as PROVIDER_ERROR', async () => {
    const { calls, fetchFn } = recorder(() => status(503));
    const err = await failure(nebius(fetchFn).generate(req()));
    assert.equal(calls.length, 2);
    assert.equal(classifyModelFailure(err.code), 'PROVIDER_ERROR');
  });

  it('a network error is retried once, then reported as NETWORK_FAILURE', async () => {
    let n = 0;
    const fetchFn: typeof fetch = async () => { n++; throw new TypeError('fetch failed'); };
    const err = await failure(nebius(fetchFn).generate(req()));
    assert.equal(n, 2);
    assert.equal(classifyModelFailure(err.code), 'NETWORK_FAILURE');
  });

  it('a 4xx (other than via the router) is never retried', async () => {
    const { calls, fetchFn } = recorder(() => status(400));
    await failure(nebius(fetchFn).generate(req()));
    assert.equal(calls.length, 1);
  });
});

describe('H. timeout', () => {
  it('a hanging request is aborted at the configured timeout and reported as TIMEOUT, not retried', async () => {
    let aborted = false;
    let n = 0;
    const fetchFn: typeof fetch = (_url, init) => new Promise((_resolve, reject) => {
      n++;
      (init as RequestInit).signal!.addEventListener('abort', () => { aborted = true; reject(new DOMException('aborted', 'AbortError')); });
    });
    const started = Date.now();
    const err = await failure(nebius(fetchFn, { timeoutMs: 60 }).generate(req()));
    assert.equal(err.code, 'PROVIDER_TIMEOUT');
    assert.equal(classifyModelFailure(err.code), 'TIMEOUT');
    assert.equal(aborted, true, 'the in-flight request was actually aborted');
    assert.equal(n, 1, 'a timeout is not retried');
    assert.ok(Date.now() - started < 2000);
  });

  it('createProviders reads NAGEX_NEBIUS_TIMEOUT_MS', async () => {
    const fetchFn: typeof fetch = (_url, init) => new Promise((_r, reject) => { (init as RequestInit).signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))); });
    const provider = createProviders({ NEBIUS_API_KEY: KEY, NAGEX_NEBIUS_TIMEOUT_MS: '50' }, fetchFn).find((p) => p.name === 'nebius')!;
    assert.equal((await failure(provider.generate(req()))).code, 'PROVIDER_TIMEOUT');
  });
});

describe('I. malformed provider output is INVALID_RESPONSE, never a result', () => {
  const cases: Array<[string, () => Response]> = [
    ['body that is not JSON', () => new Response('<html>gateway error</html>', { status: 200 })],
    ['no choices', () => new Response(JSON.stringify({ id: 'x' }), { status: 200 })],
    ['empty choices', () => new Response(JSON.stringify({ choices: [] }), { status: 200 })],
    ['choice without a message', () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop' }] }), { status: 200 })],
    ['null content', () => ok({ content: null })],
    ['empty content', () => ok({ content: '   ' })],
    ['token budget exhausted (finish_reason=length)', () => new Response(JSON.stringify({ choices: [{ message: { content: 'half an ans' }, finish_reason: 'length' }] }), { status: 200 })],
    ['JSON null', () => new Response('null', { status: 200 })],
  ];
  for (const [label, build] of cases) {
    it(label, async () => {
      const { fetchFn } = recorder(() => build());
      const provider = nebius(fetchFn);
      const err = await failure(provider.generate(req()));
      assert.equal(classifyModelFailure(err.code), 'INVALID_RESPONSE', `${err.code}`);
      assert.equal(provider.status().status, 'DEGRADED');
    });
  }
});

describe('J. no secret leakage', () => {
  it('the credential appears in no log line, error, status or result across success and every failure path', async () => {
    const lines: string[] = [];
    const logger: RouterLogger = { info: (e, f) => lines.push(JSON.stringify({ e, f })), warn: (e, f) => lines.push(JSON.stringify({ e, f })) };
    const origs = { log: console.log, info: console.info, warn: console.warn, error: console.error };
    const captured: string[] = [];
    console.log = console.info = console.warn = console.error = (...a: unknown[]) => { captured.push(a.map(String).join(' ')); };
    const results: unknown[] = [];
    try {
      for (const build of [() => ok({ content: 'fine' }), () => status(401), () => status(429), () => status(500), () => new Response('nope', { status: 200 })]) {
        const { fetchFn } = recorder(() => build());
        const provider = nebius(fetchFn);
        const router = new UnifiedModelRouter([provider], logger);
        try { results.push(await router.generate({ messages: [{ role: 'user', content: 'x' }], mode: 'auto', routingContext: { taskKind: 'PLAN', requiresJson: false, requestId: 'r' } })); }
        catch (e: any) { results.push({ code: e.code, message: e.message, details: e.details }); }
        results.push(provider.status());
      }
    } finally { Object.assign(console, origs); }
    const everything = [lines.join('\n'), captured.join('\n'), JSON.stringify(results)].join('\n');
    assert.equal(everything.includes(KEY), false);
    assert.equal(/authorization|bearer/i.test(lines.join('\n')), false, 'no credential header in router logs');
  });
});

describe('integration: a real local OpenAI-compatible endpoint', () => {
  async function withFakeNebius(handler: (body: any, authorization: string | undefined) => { status: number; body: unknown }, run: (baseUrl: string, seen: Array<{ body: any; authorization: string | undefined; url: string }>) => Promise<void>) {
    const seen: Array<{ body: any; authorization: string | undefined; url: string }> = [];
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (c) => chunks.push(c));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const authorization = request.headers.authorization;
        seen.push({ body, authorization, url: request.url || '' });
        const out = handler(body, authorization);
        response.writeHead(out.status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(out.body));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen); }
    finally { await new Promise<void>((r) => server.close(() => r())); }
  }

  it('TaskKind=PLAN is routed to NEBIUS / Nemotron and the normalized result carries provider, model and content', async () => {
    await withFakeNebius(() => ({ status: 200, body: { choices: [{ message: { content: 'PLAN_OK' }, finish_reason: 'stop' }] } }), async (baseUrl, seen) => {
      const router = new UnifiedModelRouter(createProviders({ NEBIUS_API_KEY: KEY, NAGEX_NEBIUS_BASE_URL: baseUrl }), { info: () => {}, warn: () => {} });
      const result = await router.generate({ messages: [{ role: 'user', content: 'plan' }], mode: 'auto', routingContext: { taskKind: 'PLAN', requiresJson: false, requestId: 'r_int' } });
      assert.equal(result.provider, 'nebius');
      assert.equal(result.model, MODEL);
      assert.equal(result.text, 'PLAN_OK');
      assert.equal(result.routing?.preferredProvider, 'nebius');
      assert.equal(result.routing?.fallbackUsed, false);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].url, '/v1/chat/completions');
      assert.equal(seen[0].authorization, `Bearer ${KEY}`);
      assert.equal(seen[0].body.model, MODEL);
    });
  });

  it('AiService.plan end to end over HTTP', async () => {
    const plan = JSON.stringify({ goal: 'Prepare', summary: 'Do it', reasoningSummary: 'because', suggestions: [], steps: [{ title: 'Step', reasoning: 'r', skill: 'skill.x', tool: null, requiresApproval: false, necessity: 'REQUIRED', dependsOn: [], parameters: {} }] });
    await withFakeNebius(() => ({ status: 200, body: { choices: [{ message: { content: plan }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 } } }), async (baseUrl) => {
      const service = new AiService(new UnifiedModelRouter(createProviders({ NEBIUS_API_KEY: KEY, NAGEX_NEBIUS_BASE_URL: baseUrl }), { info: () => {}, warn: () => {} }));
      const out = await service.plan({ prompt: 'p', memories: [], mode: 'auto', requestId: 'r_plan_int' });
      assert.equal(out.provider, 'nebius');
      assert.equal(out.model, MODEL);
      assert.equal(out.data.goal, 'Prepare');
    });
  });
});

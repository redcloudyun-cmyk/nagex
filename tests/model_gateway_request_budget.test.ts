// A generation that legitimately outlasts a chat answer (a whole website's files) can ask the Model Gateway for more room: a larger output ceiling and a longer - but always bounded - time budget for THAT request.
// Everything else is exactly what it was: a request that asks for neither is sent as before and times out at the provider's own limit. Provider-specific wire details stay inside the adapters.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiProvider, NebiusProvider, OpenAIProvider } from '../src/model-gateway/providers.js';

const geminiOk = (text: string) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } }), { status: 200 });
const messages = [{ role: 'user' as const, content: 'hi' }];

/** a fetch that answers after `delayMs`, unless the request is aborted first (as a real one is) */
function slowFetch(delayMs: number, capture: { body?: any }, reply: () => Response): typeof fetch {
  return ((_url: any, init?: any) => new Promise<Response>((resolve, reject) => {
    capture.body = JSON.parse(String(init?.body ?? '{}'));
    const timer = setTimeout(() => resolve(reply()), delayMs);
    init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
  })) as typeof fetch;
}

describe('the output ceiling of a request reaches the provider that has such a control', () => {
  it('Gemini: maxOutputTokens goes into generationConfig (with or without JSON mode); a request that sets none is sent as before', async () => {
    const seen: { body?: any } = {};
    const provider = new GeminiProvider({ apiKey: 'k', model: 'm', fetchFn: slowFetch(0, seen, () => geminiOk('ok')) });
    await provider.generate({ messages, requestId: 'r', maxOutputTokens: 5000 });
    assert.deepEqual(seen.body.generationConfig, { maxOutputTokens: 5000 });
    await provider.generate({ messages, requestId: 'r', jsonMode: true, maxOutputTokens: 7000.9 });
    assert.deepEqual(seen.body.generationConfig, { responseMimeType: 'application/json', maxOutputTokens: 7000 });
    await provider.generate({ messages, requestId: 'r', jsonMode: true });
    assert.deepEqual(seen.body.generationConfig, { responseMimeType: 'application/json' });
    await provider.generate({ messages, requestId: 'r' });
    assert.equal('generationConfig' in seen.body, false);
    await provider.generate({ messages, requestId: 'r', maxOutputTokens: 0 });
    assert.equal('generationConfig' in seen.body, false, 'a non-positive ceiling is ignored');
  });

  it('OpenAI: max_output_tokens; and a request without one is unchanged', async () => {
    const seen: { body?: any } = {};
    const provider = new OpenAIProvider({ apiKey: 'k', model: 'm', fetchFn: slowFetch(0, seen, () => new Response(JSON.stringify({ output_text: 'ok' }), { status: 200 })) });
    await provider.generate({ messages, requestId: 'r', maxOutputTokens: 4096 });
    assert.equal(seen.body.max_output_tokens, 4096);
    await provider.generate({ messages, requestId: 'r' });
    assert.equal('max_output_tokens' in seen.body, false);
  });
});

describe('a request can ask for more time than the provider\'s default - bounded, and only that request', () => {
  it('the default limit still applies to a request that asks for nothing; a longer budget lets a slow answer through', async () => {
    const make = () => new GeminiProvider({ apiKey: 'k', model: 'm', timeoutMs: 60, fetchFn: slowFetch(400, {}, () => geminiOk('slow but fine')) });
    await assert.rejects(() => make().generate({ messages, requestId: 'r' }), (e: any) => e.code === 'PROVIDER_TIMEOUT');
    const answer = await make().generate({ messages, requestId: 'r', timeoutMs: 5000 });
    assert.equal(answer.text, 'slow but fine');
  });

  it('a request cannot shorten below one second or lengthen without bound (the budget is clamped), and a malformed value is ignored', async () => {
    // asking for 5 ms is raised to 1 s, so a 300 ms answer arrives; the same provider's default of 60 ms would have timed out
    const quick = new GeminiProvider({ apiKey: 'k', model: 'm', timeoutMs: 60, fetchFn: slowFetch(300, {}, () => geminiOk('ok')) });
    assert.equal((await quick.generate({ messages, requestId: 'r', timeoutMs: 5 })).text, 'ok');
    // a nonsense value falls back to the provider's own limit
    const nonsense = new GeminiProvider({ apiKey: 'k', model: 'm', timeoutMs: 60, fetchFn: slowFetch(400, {}, () => geminiOk('ok')) });
    await assert.rejects(() => nonsense.generate({ messages, requestId: 'r', timeoutMs: Number.NaN }), (e: any) => e.code === 'PROVIDER_TIMEOUT');
  });

  it('Nebius passes the budget too', async () => {
    const make = () => new NebiusProvider({ apiKey: 'k', model: 'm', baseUrl: 'http://127.0.0.1:1/v1', timeoutMs: 60, fetchFn: slowFetch(400, {}, () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }), { status: 200 })) });
    await assert.rejects(() => make().generate({ messages, requestId: 'r' }), (e: any) => e.code === 'PROVIDER_TIMEOUT');
    assert.equal((await make().generate({ messages, requestId: 'r', timeoutMs: 5000 })).text, 'ok');
  });
});

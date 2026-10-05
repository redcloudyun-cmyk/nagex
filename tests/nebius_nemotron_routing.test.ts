// NAgex — task-aware routing of NVIDIA Nemotron (Nebius Token Factory) through the canonical router.
//
// Proves the integration lives INSIDE the existing UnifiedModelRouter / ModelRoutingPolicy / TaskKind architecture (no second
// model system): PLAN, RESEARCH_SYNTHESIS and MEETING_PREP prefer NEBIUS/Nemotron; every other task keeps exactly the routing it
// had; an unavailable, rate-limited, rejecting, slow or malformed Nemotron falls back truthfully with a fixed reason code; an
// explicit provider choice is never overridden; and capability claims carry evidence grades (no unverified guarantee).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ModelRoutingPolicy, DEFAULT_TASK_PROVIDER_PREFERENCES } from '../src/model-gateway/model-routing-policy.js';
import type { ModelRoutingContext, ModelTaskKind } from '../src/model-gateway/model-routing.types.js';
import { UnifiedModelRouter, type RouterLogger } from '../src/model-gateway/unified-model-router.js';
import { AiService } from '../src/model-gateway/ai-service.js';
import { GeminiProvider, NebiusProvider, OpenAIProvider, NEBIUS_NEMOTRON_TASK_KINDS } from '../src/model-gateway/providers.js';
import type { ModelProvider } from '../src/model-gateway/model-provider.js';

const NEMOTRON = 'nvidia/Nemotron-3_5-Lightning';
const KEY = 'sk-NEBIUS-ROUTING-SENTINEL';
type Reply = () => Response | Promise<Response>;
const nebiusOk = (content: string, usage?: Record<string, number>) => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], ...(usage ? { usage } : {}) }), { status: 200 });
const geminiOk = (text: string) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } }), { status: 200 });
const openaiOk = (text: string) => new Response(JSON.stringify({ output_text: text }), { status: 200 });
const http = (code: number) => new Response(JSON.stringify({ error: { message: 'x' } }), { status: code });

// 'none' = not registered at all; 'unconfigured' = registered without a credential; a function = the (fake) endpoint reply.
type Kind = Reply | 'none' | 'unconfigured';
function build(opts: { nebius?: Kind; gemini?: Kind; openai?: Kind; nebiusTimeoutMs?: number } = {}) {
  const counts = { nebius: 0, gemini: 0, openai: 0 };
  const fetchFor = (name: 'nebius' | 'gemini' | 'openai', reply: Reply): typeof fetch => async () => { counts[name]++; return reply(); };
  const replyOf = (kind: Kind | undefined, fallback: Reply): Reply => (typeof kind === 'function' ? kind : fallback);
  const providers: ModelProvider[] = [];
  if (opts.openai !== 'none') providers.push(new OpenAIProvider({ apiKey: opts.openai === 'unconfigured' ? undefined : 'o', model: 'gpt', fetchFn: fetchFor('openai', replyOf(opts.openai, () => openaiOk('openai text'))) }));
  if (opts.gemini !== 'none') providers.push(new GeminiProvider({ apiKey: opts.gemini === 'unconfigured' ? undefined : 'g', model: 'gm', fetchFn: fetchFor('gemini', replyOf(opts.gemini, () => geminiOk('{"ok":true}'))) }));
  if (opts.nebius !== 'none') providers.push(new NebiusProvider({ apiKey: opts.nebius === 'unconfigured' ? undefined : KEY, model: NEMOTRON, timeoutMs: opts.nebiusTimeoutMs, fetchFn: fetchFor('nebius', replyOf(opts.nebius, () => nebiusOk('{"ok":true}'))) }));
  const logs: Array<{ event: string; fields: Record<string, any> }> = [];
  const logger: RouterLogger = { info: (event, fields) => logs.push({ event, fields }), warn: (event, fields) => logs.push({ event, fields }) };
  return { providers, router: new UnifiedModelRouter(providers, logger), logs, counts, service: undefined as unknown as AiService };
}
const ctx = (taskKind: ModelTaskKind, requiresJson: boolean): ModelRoutingContext => ({ taskKind, requiresJson, requestId: 'r' });
const ALL_TASKS: ModelTaskKind[] = ['CHAT', 'RESEARCH_SYNTHESIS', 'DOCUMENT_SYNTHESIS', 'PLAN', 'STRUCTURED_EXTRACTION', 'DAILY_BRIEF', 'MEETING_PREP', 'PERSPECTIVE_ANALYSIS', 'PERSPECTIVE_SYNTHESIS', 'FORECAST_ANALYSIS', 'FORECAST_SYNTHESIS'];
const PREFERRING: ModelTaskKind[] = ['PLAN', 'RESEARCH_SYNTHESIS', 'MEETING_PREP'];
const REPLY_PLAN_JSON = JSON.stringify({ goal: 'g', summary: 's', reasoningSummary: 'r', suggestions: [], steps: [{ title: 't', reasoning: 'r', skill: 'skill.x', tool: null, requiresApproval: false, necessity: 'REQUIRED', dependsOn: [], parameters: {} }] });

describe('routing table', () => {
  it('prefers NEBIUS for exactly PLAN, RESEARCH_SYNTHESIS and MEETING_PREP', () => {
    assert.deepEqual(Object.keys(DEFAULT_TASK_PROVIDER_PREFERENCES).sort(), [...PREFERRING].sort());
    for (const task of PREFERRING) assert.deepEqual(DEFAULT_TASK_PROVIDER_PREFERENCES[task], ['nebius']);
    assert.deepEqual([...NEBIUS_NEMOTRON_TASK_KINDS].sort(), [...PREFERRING].sort());
  });

  for (const [task, json] of [['PLAN', true], ['RESEARCH_SYNTHESIS', false], ['MEETING_PREP', true]] as const) {
    it(`${task} → NEBIUS preferred (even when another provider is already LIVE), others are the fallback`, async () => {
      const { providers, router } = build();
      // make gemini LIVE so the pre-existing "LIVE first" status tier would have beaten an unprobed provider
      await providers.find((p) => p.name === 'gemini')!.generate({ messages: [{ role: 'user', content: 'ping' }], requestId: 'probe' });
      assert.equal(providers.find((p) => p.name === 'gemini')!.status().status, 'LIVE');
      const decision = new ModelRoutingPolicy().select('auto', ctx(task, json), providers, router['configuredPriority']);
      assert.equal(decision.selectedProvider, 'nebius');
      assert.equal(decision.preferredProvider, 'nebius');
      assert.ok(decision.reasonCodes.includes('TASK_PREFERRED_PROVIDER'));
      assert.ok(decision.fallbackProviders.includes('gemini'));
    });
  }
});

describe('every other task keeps exactly its existing routing', () => {
  it('adding a configured Nemotron provider changes NO decision for CHAT, STRUCTURED_EXTRACTION, DAILY_BRIEF, DOCUMENT_SYNTHESIS, PERSPECTIVE_*, FORECAST_*', () => {
    const policy = new ModelRoutingPolicy();
    const without = build({ nebius: 'none' }).providers;
    const withNebius = build().providers;
    const priority = ['nebius', 'openai', 'gemini'];
    for (const task of ALL_TASKS.filter((t) => !PREFERRING.includes(t))) {
      for (const json of task === 'STRUCTURED_EXTRACTION' || task === 'DAILY_BRIEF' || task === 'DOCUMENT_SYNTHESIS' ? [true] : [false]) {
        const before = policy.select('auto', ctx(task, json), without, priority);
        const after = policy.select('auto', ctx(task, json), withNebius, priority);
        assert.deepEqual({ s: after.selectedProvider, f: after.fallbackProviders }, { s: before.selectedProvider, f: before.fallbackProviders }, `${task} json=${json}`);
        assert.equal(after.fallbackProviders.includes('nebius'), false, `${task}: Nemotron is not even a fallback`);
        assert.equal(after.reasonCodes.includes('TASK_PREFERRED_PROVIDER'), false);
      }
    }
  });

  it('with only Nemotron configured, CHAT / STRUCTURED_EXTRACTION / DAILY_BRIEF have no eligible provider (they are not routed to it)', () => {
    const only = build({ openai: 'none', gemini: 'none' }).providers;
    for (const [task, json] of [['CHAT', false], ['STRUCTURED_EXTRACTION', true], ['DAILY_BRIEF', true]] as const) {
      assert.throws(() => new ModelRoutingPolicy().select('auto', ctx(task, json), only, ['nebius']), (e: any) => e.code === 'NO_MODEL_PROVIDER_CONFIGURED', task);
    }
  });

  it('through AiService each method uses its own TaskKind and the observed provider matches', async () => {
    const { providers, logs } = build({
      nebius: () => nebiusOk(REPLY_PLAN_JSON),
      gemini: () => geminiOk('{"summary":"s","actionItems":[],"keyPoints":["k"],"suggestedAgenda":["a"]}'),
    });
    const service = new AiService(new UnifiedModelRouter(providers, { info: (event, fields) => logs.push({ event, fields }), warn: () => {} }));
    const seen = (taskKind: string) => logs.filter((l) => l.event === 'model_routing_decision' && l.fields.taskKind === taskKind).map((l) => l.fields.selectedProvider);
    await service.plan({ prompt: 'p', memories: [], mode: 'auto', requestId: 'a' });
    await service.chat({ message: 'hi', mode: 'auto', requestId: 'b' }).catch(() => undefined);
    await service.brief({ scheduleDigest: '', emailsDigest: '', tasksDigest: '', mode: 'auto', requestId: 'c' });
    await service.meetingPrep({ eventDigest: 'e', emailsDigest: '', vaultDigest: '', memoryDigest: '', mode: 'auto', requestId: 'd' });
    await service.research({ query: 'q', evidencePack: { evidencePackId: 'ep', sources: [] } as any, mode: 'auto', requestId: 'e' }).catch(() => undefined);
    assert.deepEqual(seen('PLAN'), ['nebius']);
    assert.deepEqual(seen('MEETING_PREP'), ['nebius']);
    assert.deepEqual(seen('RESEARCH_SYNTHESIS'), ['nebius']);
    assert.deepEqual(seen('DAILY_BRIEF'), ['gemini'], 'DAILY_BRIEF keeps its route');
    assert.ok(seen('CHAT').every((p) => p !== 'nebius'), 'CHAT keeps its route');
  });
});

describe('fallback is truthful and recorded', () => {
  const planCtx = { taskKind: 'PLAN' as const, requiresJson: true, requestId: 'r_fb' };
  const run = (b: ReturnType<typeof build>) => b.router.generate({ messages: [{ role: 'user', content: 'p' }], mode: 'auto', jsonMode: true, routingContext: planCtx });

  const cases: Array<[string, () => ReturnType<typeof build>, string]> = [
    ['429 → RATE_LIMITED', () => build({ nebius: () => http(429) }), 'RATE_LIMITED'],
    ['401 → PROVIDER_REJECTION', () => build({ nebius: () => http(401) }), 'PROVIDER_REJECTION'],
    ['403 → PROVIDER_REJECTION', () => build({ nebius: () => http(403) }), 'PROVIDER_REJECTION'],
    ['500 (after its one retry) → PROVIDER_ERROR', () => build({ nebius: () => http(500) }), 'PROVIDER_ERROR'],
    ['404 → MODEL_UNAVAILABLE', () => build({ nebius: () => http(404) }), 'MODEL_UNAVAILABLE'],
    ['malformed body → INVALID_RESPONSE', () => build({ nebius: () => new Response('not json', { status: 200 }) }), 'INVALID_RESPONSE'],
    ['empty answer → INVALID_RESPONSE', () => build({ nebius: () => nebiusOk('   ') }), 'INVALID_RESPONSE'],
    ['network failure → NETWORK_FAILURE', () => build({ nebius: () => { throw new TypeError('fetch failed'); } }), 'NETWORK_FAILURE'],
    ['not configured (no key) → NO_PROVIDER_CREDENTIAL', () => build({ nebius: 'unconfigured' }), 'NO_PROVIDER_CREDENTIAL'],
  ];
  for (const [label, make, reason] of cases) {
    it(label, async () => {
      const b = make();
      const result = await run(b);
      assert.equal(result.provider, 'gemini', 'the existing approved provider answered');
      assert.deepEqual({ ...result.routing }, { taskKind: 'PLAN', preferredProvider: 'nebius', actualProvider: 'gemini', fallbackUsed: true, fallbackReason: reason });
      const ok = b.logs.find((l) => l.event === 'model_request_succeeded')!;
      assert.equal(ok.fields.preferredProvider, 'nebius');
      assert.equal(ok.fields.actualProvider, 'gemini');
      assert.equal(ok.fields.fallbackReason, reason);
    });
  }

  it('a timeout → TIMEOUT, the hung request is abandoned and gemini answers', async () => {
    const b = build({ nebius: () => new Promise<Response>(() => { /* never settles */ }), nebiusTimeoutMs: 40 });
    // the injected fetch ignores the abort signal, so emulate a real fetch: reject when aborted
    const nebius = b.providers.find((p) => p.name === 'nebius') as NebiusProvider;
    (nebius as any).fetchFn = (_url: string, init: RequestInit) => new Promise((_r, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    const result = await run(b);
    assert.equal(result.provider, 'gemini');
    assert.equal(result.routing?.fallbackReason, 'TIMEOUT');
  });

  it('a Nemotron answer that fails the task validator falls back with INVALID_RESPONSE (a model is never trusted blindly)', async () => {
    const b = build({ nebius: () => nebiusOk('definitely not the plan JSON'), gemini: () => geminiOk(REPLY_PLAN_JSON) });
    const service = new AiService(b.router);
    const out = await service.plan({ prompt: 'p', memories: [], mode: 'auto', requestId: 'val' });
    assert.equal(out.provider, 'gemini');
    assert.equal(b.logs.find((l) => l.event === 'model_request_succeeded')!.fields.fallbackReason, 'INVALID_RESPONSE');
  });

  it('every provider failing is a failure with reasons, never a fabricated success', async () => {
    const b = build({ nebius: () => http(401), gemini: () => http(500), openai: 'none' });
    await assert.rejects(() => run(b), (e: any) => e.code === 'ALL_MODEL_PROVIDERS_FAILED' && e.details.failures.every((f: any) => typeof f.reason === 'string'));
  });

  it('fallbackPolicy DISALLOW never falls back', async () => {
    const b = build({ nebius: () => http(429) });
    await assert.rejects(() => b.router.generate({ messages: [{ role: 'user', content: 'p' }], mode: 'auto', jsonMode: true, routingContext: planCtx, fallbackPolicy: 'DISALLOW' }), (e: any) => e.code === 'ALL_MODEL_PROVIDERS_FAILED');
    assert.equal(b.counts.gemini, 0);
  });

  it('a DEGRADED Nemotron is deprioritized (the pre-existing health rule) but is still the recorded preference', async () => {
    const b = build({ nebius: () => http(429) });
    await run(b);                                  // degrades nebius
    const second = await run(b);
    assert.equal(b.providers.find((p) => p.name === 'nebius')!.status().status, 'DEGRADED');
    const decision = b.logs.filter((l) => l.event === 'model_routing_decision').at(-1)!.fields;
    assert.equal(decision.selectedProvider, 'gemini');
    assert.equal(decision.preferredProvider, 'nebius');
    assert.equal(second.routing?.fallbackReason, 'PROVIDER_DEGRADED');
    assert.equal(b.counts.nebius, 1, 'a degraded provider is not hammered');
  });
});

describe('explicit provider choice and capability evidence', () => {
  it('an explicit provider is honored and is not subject to the preference (nor to Nemotron’s automatic task scope)', async () => {
    const b = build({ nebius: () => nebiusOk('explicit nebius chat') });
    const chat = await b.router.generate({ messages: [{ role: 'user', content: 'hi' }], mode: 'nebius', routingContext: ctx('CHAT', false) });
    assert.equal(chat.provider, 'nebius');
    assert.equal(chat.routing?.preferredProvider, null);
    const plan = await build().router.generate({ messages: [{ role: 'user', content: 'p' }], mode: 'gemini', routingContext: ctx('PLAN', false) });
    assert.equal(plan.provider, 'gemini');
    assert.equal(plan.routing?.preferredProvider, null);
  });

  it('an explicit provider still cannot bypass a hard capability requirement', () => {
    assert.throws(() => new ModelRoutingPolicy().select('openai', ctx('PLAN', true), build().providers, []), (e: any) => e.code === 'MODEL_PROVIDER_CAPABILITY_UNSUPPORTED');
  });

  it('Nemotron’s capability declaration is evidence-graded: nothing beyond chat completion is claimed as supported', () => {
    const caps = new NebiusProvider({ apiKey: 'k', model: NEMOTRON }).capabilities;
    assert.deepEqual(caps.declared, { CHAT_COMPLETION: 'SUPPORTED', REASONING: 'UNVERIFIED', PLANNING: 'UNVERIFIED', RESEARCH_SYNTHESIS: 'UNVERIFIED', TOOL_USE: 'UNVERIFIED', STRUCTURED_OUTPUT: 'UNVERIFIED', LONG_CONTEXT: 'UNVERIFIED' });
    assert.equal(caps.supportsStructuredExtraction, false, 'strict extraction is not offered to an unverified structured-output model');
    assert.deepEqual([...caps.eligibleTaskKinds!].sort(), [...PREFERRING].sort());
    assert.ok(Object.values(caps.declared!).filter((v) => v === 'SUPPORTED').length === 1);
  });

  it('another Token Factory model keeps the generic (pre-existing) declaration', () => {
    const caps = new NebiusProvider({ apiKey: 'k', model: 'meta/llama' }).capabilities;
    assert.equal(caps.supportsStructuredExtraction, true);
    assert.equal(caps.eligibleTaskKinds, undefined);
  });
});

describe('telemetry is safe', () => {
  it('a success log carries task, provider, model, latency and token counts — never prompt, answer, reasoning or credential', async () => {
    const PROMPT = 'PRIVATE_PROMPT_TEXT_9';
    const ANSWER = 'PRIVATE_ANSWER_TEXT_9';
    const b = build({ nebius: () => new Response(JSON.stringify({ choices: [{ message: { content: ANSWER, reasoning_content: 'HIDDEN_REASONING_9' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7, completion_tokens_details: { reasoning_tokens: 2 } } }), { status: 200 }) });
    await b.router.generate({ messages: [{ role: 'user', content: PROMPT }], mode: 'auto', routingContext: ctx('PLAN', false) });
    const ok = b.logs.find((l) => l.event === 'model_request_succeeded')!.fields;
    assert.equal(ok.taskKind, 'PLAN');
    assert.equal(ok.provider, 'nebius');
    assert.equal(ok.model, NEMOTRON);
    assert.equal(typeof ok.latencyMs, 'number');
    assert.deepEqual([ok.inputTokens, ok.outputTokens, ok.totalTokens, ok.reasoningTokens], [3, 4, 7, 2]);
    assert.equal(ok.reasoningAvailable, true);
    const text = JSON.stringify(b.logs);
    for (const secret of [PROMPT, ANSWER, 'HIDDEN_REASONING_9', KEY]) assert.equal(text.includes(secret), false, secret);
  });
});

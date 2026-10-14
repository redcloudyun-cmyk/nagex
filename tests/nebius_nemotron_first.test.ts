// D-11 "Nemotron First": NVIDIA Nemotron (Nebius Token Factory) is the default model for general conversation, planning, research, meeting preparation and
// document drafting; a failed Nemotron is retried after a cool-down instead of being locked out for ever; fallbacks are logged AND audited with their reason;
// non-text creation never goes through the text router. Everything here uses FAKE provider endpoints: it proves routing behavior, NOT that a real model answered
// (the real Nebius calls are recorded separately in docs/evidence/NAGEX_D11_NEMOTRON_FIRST_CERT_20261014.md).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ModelRoutingPolicy, DEFAULT_TASK_PROVIDER_PREFERENCES } from '../src/model-gateway/model-routing-policy.js';
import type { ModelRoutingContext, ModelTaskKind } from '../src/model-gateway/model-routing.types.js';
import { UnifiedModelRouter, type RouterLogger } from '../src/model-gateway/unified-model-router.js';
import { AiService } from '../src/model-gateway/ai-service.js';
import { GeminiProvider, NebiusProvider, OpenAIProvider, readDegradedCooldownMs, DEFAULT_DEGRADED_COOLDOWN_MS } from '../src/model-gateway/providers.js';
import type { ModelCallRecord, ModelProvider } from '../src/model-gateway/model-provider.js';
import { handleProvidersRoutes } from '../src/http/routes/providers.routes.js';

const NEMOTRON = 'nvidia/Nemotron-3_5-Lightning';
type Reply = () => Response | Promise<Response>;
const nebiusOk = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200 });
const geminiOk = (text: string) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } }), { status: 200 });
const openaiOk = (text: string) => new Response(JSON.stringify({ output_text: text }), { status: 200 });
const ctx = (taskKind: ModelTaskKind, requiresJson = false): ModelRoutingContext => ({ taskKind, requiresJson, requestId: `r_${taskKind}` });
const COOLDOWN = 60_000;

function stack(replies: { nebius?: Reply; gemini?: Reply; openai?: Reply } = {}) {
  const clock = { now: 1_000_000 };
  const calls = { nebius: 0, gemini: 0, openai: 0 };
  const f = (name: 'nebius' | 'gemini' | 'openai', reply: Reply): typeof fetch => async () => { calls[name]++; return reply(); };
  const providers: ModelProvider[] = [
    new NebiusProvider({ apiKey: 'k', model: NEMOTRON, degradedCooldownMs: COOLDOWN, now: () => clock.now, fetchFn: f('nebius', replies.nebius ?? (() => nebiusOk('nemotron answer'))) }),
    new OpenAIProvider({ apiKey: 'o', model: 'gpt', degradedCooldownMs: COOLDOWN, now: () => clock.now, fetchFn: f('openai', replies.openai ?? (() => openaiOk('openai answer'))) }),
    new GeminiProvider({ apiKey: 'g', model: 'gm', degradedCooldownMs: COOLDOWN, now: () => clock.now, fetchFn: f('gemini', replies.gemini ?? (() => geminiOk('gemini answer'))) }),
  ];
  const logs: Array<{ event: string; fields: Record<string, any> }> = [];
  const logger: RouterLogger = { info: (event, fields) => logs.push({ event, fields }), warn: (event, fields) => logs.push({ event, fields }) };
  const router = new UnifiedModelRouter(providers, logger);
  const nebius = providers[0];
  return { clock, calls, providers, router, logs, nebius };
}
const ask = (router: UnifiedModelRouter, task: ModelTaskKind, json = false) =>
  router.generate({ messages: [{ role: 'user', content: 'SECRET-PROMPT-TEXT' }], mode: 'auto', routingContext: ctx(task, json), ...(json ? { jsonMode: true } : {}) });

describe('Nemotron is the first choice for the personal-AI tasks', () => {
  for (const [task, json] of [['CHAT', false], ['PLAN', true], ['RESEARCH_SYNTHESIS', false], ['MEETING_PREP', true], ['DOCUMENT_SYNTHESIS', true]] as const) {
    it(`${task} goes to Nemotron first, even when another provider is already LIVE`, async () => {
      const s = stack({ nebius: () => nebiusOk('{"ok":true}') });
      await s.providers[2].generate({ messages: [{ role: 'user', content: 'ping' }], requestId: 'probe' });   // gemini becomes LIVE
      assert.equal(s.providers[2].status().status, 'LIVE');
      const result = await ask(s.router, task, json);
      assert.equal(result.provider, 'nebius');
      assert.equal(result.model, NEMOTRON);
      assert.equal(result.routing?.fallbackUsed, false);
      assert.equal(s.calls.gemini, 1, 'only the probe reached Gemini');
    });
  }

  it('tasks outside the list are not routed to Nemotron at all', () => {
    const s = stack();
    for (const task of ['STRUCTURED_EXTRACTION', 'DAILY_BRIEF', 'PRESENTATION_SYNTHESIS', 'PERSPECTIVE_ANALYSIS', 'PERSPECTIVE_SYNTHESIS', 'FORECAST_ANALYSIS', 'FORECAST_SYNTHESIS'] as ModelTaskKind[]) {
      const decision = new ModelRoutingPolicy().select('auto', ctx(task, task !== 'PERSPECTIVE_ANALYSIS'), s.providers, ['nebius', 'openai', 'gemini']);
      assert.notEqual(decision.selectedProvider, 'nebius', task);
      assert.equal(decision.fallbackProviders.includes('nebius'), false, task);
    }
    assert.deepEqual(Object.keys(DEFAULT_TASK_PROVIDER_PREFERENCES).sort(), ['CHAT', 'DOCUMENT_SYNTHESIS', 'MEETING_PREP', 'PLAN', 'RESEARCH_SYNTHESIS']);
  });

  it('through AiService, conversation / plan / research / meeting prep / document drafting each reach Nemotron by their own TaskKind', async () => {
    const s = stack();
    const service = new AiService(s.router);
    const seen = (kind: string) => s.logs.filter((l) => l.event === 'model_routing_decision' && l.fields.taskKind === kind).map((l) => l.fields.selectedProvider);
    await service.chat({ message: 'hi', mode: 'auto', requestId: 'c' }).catch(() => undefined);
    await service.plan({ prompt: 'p', memories: [], mode: 'auto', requestId: 'p' }).catch(() => undefined);
    await service.meetingPrep({ eventDigest: 'e', emailsDigest: '', vaultDigest: '', memoryDigest: '', mode: 'auto', requestId: 'm' }).catch(() => undefined);
    await service.research({ query: 'q', evidencePack: { evidencePackId: 'ep', sources: [] } as any, mode: 'auto', requestId: 'r' }).catch(() => undefined);
    for (const kind of ['CHAT', 'PLAN', 'MEETING_PREP', 'RESEARCH_SYNTHESIS']) assert.deepEqual(seen(kind), ['nebius'], kind);
  });
});

describe('a failed Nemotron is retried after a cool-down, never locked out for ever (the D-11 P0)', () => {
  const failTimeout: Reply = () => new Response('rejected', { status: 400 });   // not retried by the provider: one call per attempt

  it('one failure sends the next requests to the fallback only while the cool-down runs; afterwards Nemotron is tried again and recovers', async () => {
    let healthy = false;
    const s = stack({ nebius: () => (healthy ? nebiusOk('recovered') : failTimeout()) });
    const first = await ask(s.router, 'CHAT');
    assert.equal(first.provider, 'openai', 'the failure is answered by the next verified provider');
    assert.equal(first.routing?.fallbackReason, 'PROVIDER_REJECTION');
    assert.equal(s.nebius.status().status, 'DEGRADED');
    assert.equal(s.nebius.status().retryEligible, false);

    // inside the cool-down: skipped (no wasted call), and the skip is reported as a fallback with its reason
    const nebiusCalls = s.calls.nebius;
    const during = await ask(s.router, 'CHAT');
    assert.equal(during.provider !== 'nebius', true);
    assert.equal(during.routing?.fallbackUsed, true);
    assert.equal(during.routing?.fallbackReason, 'PROVIDER_DEGRADED');
    assert.equal(s.calls.nebius, nebiusCalls);

    // after the cool-down the SAME provider is eligible again - the 14-hour lock-out cannot happen
    s.clock.now += COOLDOWN + 1;
    assert.equal(s.nebius.status().retryEligible, true);
    assert.equal(s.nebius.status().status, 'DEGRADED', 'still reported truthfully until a real call succeeds');
    healthy = true;
    const after = await ask(s.router, 'CHAT');
    assert.equal(after.provider, 'nebius');
    assert.equal(after.routing?.fallbackUsed, false);
    assert.equal(s.nebius.status().status, 'LIVE');
    assert.equal(s.nebius.status().retryEligible, false);
  });

  it('a trial that fails again restarts the cool-down (one probe per window, not a retry storm)', async () => {
    const s = stack({ nebius: failTimeout });
    await ask(s.router, 'PLAN', true);
    const afterFirst = s.calls.nebius;
    s.clock.now += COOLDOWN + 1;
    const trial = await ask(s.router, 'PLAN', true);
    assert.equal(trial.routing?.fallbackReason, 'PROVIDER_REJECTION');
    assert.equal(s.calls.nebius, afterFirst + 1, 'exactly one trial call');
    assert.equal(s.nebius.status().retryEligible, false);
    await ask(s.router, 'PLAN', true);
    await ask(s.router, 'PLAN', true);
    assert.equal(s.calls.nebius, afterFirst + 1, 'no further calls inside the new cool-down');
    s.clock.now += COOLDOWN + 1;
    assert.equal(s.nebius.status().retryEligible, true);
  });

  it('the recorded reason is the one that applied when the provider was skipped, even if the cool-down ends while the fallback answers', async () => {
    const s = stack({ nebius: failTimeout });
    await ask(s.router, 'CHAT');                       // Nemotron fails -> DEGRADED
    s.clock.now += COOLDOWN - 1_000;                  // still inside the cool-down when the request is routed...
    const slowFallback: Reply = () => { s.clock.now += 5_000; return openaiOk('late answer'); };   // ...but it ends while the fallback is answering
    const s2 = s;                                      // same providers; only the OpenAI reply is slower
    (s2.providers[1] as any).fetchFn = async () => slowFallback();
    const result = await ask(s.router, 'CHAT');
    assert.equal(result.provider, 'openai');
    assert.equal(result.routing?.fallbackReason, 'PROVIDER_DEGRADED');
    assert.equal(s.nebius.status().retryEligible, true, 'by now Nemotron may be tried again');
  });

  it('a truncated answer (token budget used up by reasoning) falls back for THAT request only: Nemotron stays LIVE for the next one', async () => {
    let truncated = true;
    const s = stack({ nebius: () => (truncated ? new Response(JSON.stringify({ choices: [{ message: { content: 'half' }, finish_reason: 'length' }] }), { status: 200 }) : nebiusOk('whole answer')) });
    await ask(s.router, 'CHAT');                       // a first success makes the provider LIVE
    truncated = false;
    await ask(s.router, 'CHAT');
    assert.equal(s.nebius.status().status, 'LIVE');
    truncated = true;
    const cut = await ask(s.router, 'CHAT');
    assert.notEqual(cut.provider, 'nebius');
    assert.equal(cut.routing?.fallbackReason, 'INVALID_RESPONSE');
    assert.equal(s.nebius.status().status, 'LIVE');
    truncated = false;
    const next = await ask(s.router, 'RESEARCH_SYNTHESIS');
    assert.equal(next.provider, 'nebius', 'the next task is not pushed to a fallback by one truncated answer');
  });

  it('the cool-down is bounded and configurable; garbage falls back to the default', () => {
    assert.equal(readDegradedCooldownMs({}), DEFAULT_DEGRADED_COOLDOWN_MS);
    assert.equal(readDegradedCooldownMs({ NAGEX_PROVIDER_DEGRADED_COOLDOWN_MS: '5000' }), 5000);
    for (const bad of ['0', '999', '600001', 'abc', '-5', '']) assert.equal(readDegradedCooldownMs({ NAGEX_PROVIDER_DEGRADED_COOLDOWN_MS: bad }), DEFAULT_DEGRADED_COOLDOWN_MS, bad);
  });

  it('a provider that was never tried or is LIVE is unaffected', async () => {
    const s = stack();
    assert.equal(s.nebius.status().retryEligible, false);
    await ask(s.router, 'CHAT');
    assert.equal(s.nebius.status().status, 'LIVE');
    assert.equal(s.nebius.status().retryEligible, false);
  });
});

describe('fallbacks are logged and audited with their reason; the trace is content-free', () => {
  it('writes model_fallback to the log and the audit sink, newest-first recent calls, and never a prompt, answer or credential', async () => {
    const s = stack({ nebius: () => new Response('boom', { status: 503 }) });
    const audited: ModelCallRecord[] = [];
    s.router.setFallbackAuditSink((record) => { audited.push(record); });
    const result = await ask(s.router, 'DOCUMENT_SYNTHESIS', true);
    assert.equal(result.routing?.preferredProvider, 'nebius');
    assert.notEqual(result.provider, 'nebius');

    const fallbackLog = s.logs.find((l) => l.event === 'model_fallback');
    assert.ok(fallbackLog, 'a model_fallback log line exists');
    assert.deepEqual({ task: fallbackLog.fields.taskKind, preferred: fallbackLog.fields.preferredProvider, actual: fallbackLog.fields.actualProvider, reason: fallbackLog.fields.fallbackReason },
      { task: 'DOCUMENT_SYNTHESIS', preferred: 'nebius', actual: result.provider, reason: 'PROVIDER_ERROR' });
    const success = s.logs.find((l) => l.event === 'model_request_succeeded')!;
    assert.equal(success.fields.fallbackUsed, true, 'the success log says a fallback answered');

    assert.equal(audited.length, 1);
    assert.equal(audited[0].fallbackReason, 'PROVIDER_ERROR');
    assert.equal(audited[0].taskKind, 'DOCUMENT_SYNTHESIS');

    const recent = s.router.recentCalls();
    assert.equal(recent[0].requestId, 'r_DOCUMENT_SYNTHESIS');
    for (const text of [JSON.stringify(recent), JSON.stringify(s.logs), JSON.stringify(audited)]) {
      assert.doesNotMatch(text, /SECRET-PROMPT-TEXT|gemini answer|openai answer|nemotron answer|Bearer|api[_-]?key/i);
    }
  });

  it('no fallback record when the preferred provider answers; a throwing audit sink never breaks the request', async () => {
    const s = stack();
    const audited: ModelCallRecord[] = [];
    s.router.setFallbackAuditSink((record) => { audited.push(record); });
    const ok = await ask(s.router, 'CHAT');
    assert.equal(ok.provider, 'nebius');
    assert.equal(audited.length, 0);
    assert.equal(s.logs.some((l) => l.event === 'model_fallback'), false);
    assert.equal(s.router.recentCalls()[0].fallbackUsed, false);

    const failing = stack({ nebius: () => new Response('x', { status: 500 }) });
    failing.router.setFallbackAuditSink(() => { throw new Error('audit store down'); });
    const answered = await ask(failing.router, 'CHAT');
    assert.notEqual(answered.provider, 'nebius');
  });

  it('keeps only the latest calls (bounded) and returns a copy', async () => {
    const s = stack();
    for (let i = 0; i < 60; i++) await ask(s.router, 'CHAT');
    assert.equal(s.router.recentCalls(100).length, 50);
    assert.equal(s.router.recentCalls(3).length, 3);
    const copy = s.router.recentCalls(1);
    copy[0].taskKind = 'TAMPERED';
    assert.equal(s.router.recentCalls(1)[0].taskKind, 'CHAT');
  });
});

describe('the preferred provider gets one more try when the task validator rejects its answer', () => {
  const generate = (s: ReturnType<typeof stack>, validate: (text: string) => void, task: ModelTaskKind = 'PLAN') =>
    s.router.generate({ messages: [{ role: 'user', content: 'p' }], mode: 'auto', jsonMode: true, routingContext: ctx(task, true), validate });

  it('a one-off malformed answer is retried on Nemotron: no fallback, attempts are logged', async () => {
    let n = 0;
    const s = stack({ nebius: () => nebiusOk(++n === 1 ? 'malformed' : '{"ok":true}') });
    const result = await generate(s, (text) => { if (text === 'malformed') throw new Error('rejected by the validator'); });
    assert.equal(result.provider, 'nebius');
    assert.equal(result.routing?.fallbackUsed, false);
    assert.equal(s.calls.nebius, 2);
    assert.equal(s.calls.gemini + s.calls.openai, 0);
    assert.equal(s.logs.filter((l) => l.event === 'model_validation_retry').length, 1);
    assert.equal(s.logs.find((l) => l.event === 'model_request_succeeded')!.fields.attempts, 2);
  });

  it('two rejected answers fall back; the fallback provider is not retried (its rejection fails the request)', async () => {
    const s = stack({ nebius: () => nebiusOk('malformed'), gemini: () => geminiOk('malformed'), openai: () => openaiOk('malformed') });
    await assert.rejects(() => generate(s, (text) => { if (text === 'malformed') throw new Error('rejected'); }), (error: any) => error.code === 'ALL_MODEL_PROVIDERS_FAILED');
    assert.equal(s.calls.nebius, 2, 'preferred provider: original + one retry');
    assert.equal(s.calls.gemini, 1, 'a fallback provider is tried once');
  });

  it('there is no retry without a validator, and none for a task that does not prefer Nemotron', async () => {
    const s = stack({ nebius: () => nebiusOk('x') });
    await s.router.generate({ messages: [{ role: 'user', content: 'p' }], mode: 'auto', routingContext: ctx('CHAT') });
    assert.equal(s.calls.nebius, 1);
    const other = stack({ gemini: () => geminiOk('malformed') });
    await assert.rejects(() => generate(other, (text) => { if (text === 'malformed') throw new Error('rejected'); }, 'DAILY_BRIEF'));
    assert.equal(other.calls.gemini, 1, 'DAILY_BRIEF is not a Nemotron task and not retried');
    assert.equal(other.calls.nebius, 0);
  });
});

describe('the evidence trace is opt-in on the status endpoint', () => {
  it('providers/status returns recentCalls only when the owner enables NAGEX_EXPOSE_MODEL_TRACE=1', async () => {
    const s = stack();
    await ask(s.router, 'CHAT');
    const service = new AiService(s.router);
    const call = () => handleProvidersRoutes('GET', '/api/v1/providers/status', null, {}, {}, { service }) as Promise<any>;
    const original = process.env.NAGEX_EXPOSE_MODEL_TRACE;
    try {
      delete process.env.NAGEX_EXPOSE_MODEL_TRACE;
      assert.equal((await call()).data.recentCalls, undefined, 'off by default: ordinary users see no routing internals');
      process.env.NAGEX_EXPOSE_MODEL_TRACE = '1';
      const on = (await call()).data;
      assert.equal(on.recentCalls.length, 1);
      assert.deepEqual(Object.keys(on.recentCalls[0]).sort(), ['actualProvider', 'at', 'fallbackReason', 'fallbackUsed', 'latencyMs', 'model', 'preferredProvider', 'requestId', 'taskKind']);
    } finally { if (original === undefined) delete process.env.NAGEX_EXPOSE_MODEL_TRACE; else process.env.NAGEX_EXPOSE_MODEL_TRACE = original; }
  });
});

describe('non-text creation never goes through the Nemotron text router', () => {
  const read = (rel: string) => fs.readFileSync(path.resolve(rel), 'utf8');

  it('the text router has no image / video task kind, and Nemotron is eligible for text tasks only', () => {
    const types = read('src/model-gateway/model-routing.types.ts');
    assert.doesNotMatch(types.slice(0, types.indexOf('export interface ModelRoutingContext')), /IMAGE|VIDEO|AUDIO/);
    const caps = new NebiusProvider({ apiKey: 'k', model: NEMOTRON }).capabilities;
    assert.deepEqual([...caps.eligibleTaskKinds!].sort(), ['CHAT', 'DOCUMENT_SYNTHESIS', 'MEETING_PREP', 'PLAN', 'RESEARCH_SYNTHESIS']);
  });

  it('image generation is a separate creation provider (no Nebius adapter registered) and unsupported kinds are refused rather than rerouted', () => {
    const app = read('src/app/create-nagex-application.ts');
    assert.match(app, /registerImageProvider\(new OpenAIImageAdapter\(\)\)/);
    assert.doesNotMatch(app.slice(app.indexOf('const creationProviderRouter'), app.indexOf('const imageStore')), /nebius|nemotron/i);
    const routes = read('src/http/routes/creation.routes.ts');
    assert.match(routes, /CREATION_KIND_UNSUPPORTED/);
  });
});

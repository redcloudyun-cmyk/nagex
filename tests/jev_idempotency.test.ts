// JEV Idempotency-Key fix. JEV support found the cause of the HTTP 402: the live scripts reused FIXED Idempotency-Keys ("nagex-jev-live-<fixture>", "nagex-jev-diagnostic-<fixture>") for requests that had
// changed, and JEV answered the conflict with a 402 that looked like a billing problem (the key, the balance and the credits were fine). JEV now answers it HTTP 409 `idempotency_conflict`. Pinned here:
//   * a key names ONE request: different request -> different key; the same request retried -> the same key; the same request in another run -> a different key;
//   * the provider refuses, BEFORE sending anything, to use one key for two different bodies;
//   * 409 is IDEMPOTENCY_CONFLICT; 402 is INSUFFICIENT_CREDITS and only that; INVALID_FIELD comes from the STRUCTURE of the error body, never from a word search in its text;
//   * the API key and the Authorization header are never in an error, an output line or a log.
// Nothing here reaches JEV: the provider gets a fake fetch; the real diagnostic script runs against a preloaded global-fetch stub. NO live call and NO 36-fixture benchmark is made.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { canonicalJson, jevIdempotencyKey, jevRequestFingerprint, newJevRunId } from '../src/model-gateway/jev-idempotency.js';
import { classifyJevHttpFailure, invalidFieldOf, parseJevErrorBody, redactSecrets } from '../src/model-gateway/jev-errors.js';
import { buildJevRequestBody, JevSystemOneProvider } from '../src/model-gateway/jev-provider.js';
import { ModelProviderError } from '../src/model-gateway/model-provider.js';
import type { JevShadowInput } from '../src/model-gateway/jev-shadow.types.js';

const SECRET = 'jevk-SENTINEL-71c2e9-do-not-print';
const ROOT = path.resolve(__dirname, '..', '..');
const input = (fixtureId: string, extra: Partial<JevShadowInput> = {}): JevShadowInput => ({ fixtureId, state: { fixtureId, taskKind: 'CHAT', requiresJson: false, requiresEvidenceGrounding: false, syntheticScenario: `Synthetic CHAT fixture ${fixtureId}.` }, taskKind: 'CHAT', requiresJson: false, requiresEvidenceGrounding: false, ...extra } as JevShadowInput);

describe('the key names one request', () => {
  const body = (id: string) => buildJevRequestBody(input(id));

  it('a different request has a different key', () => {
    const run = 'run_a';
    assert.notEqual(jevIdempotencyKey(run, 'diagnostic', body('chat-simple-001')), jevIdempotencyKey(run, 'diagnostic', body('chat-simple-002')));
    // the SAME fixture whose request changed between two versions of the code is a different request too
    const changed = { ...body('chat-simple-001'), model: 'jev-other' };
    assert.notEqual(jevIdempotencyKey(run, 'diagnostic', body('chat-simple-001')), jevIdempotencyKey(run, 'diagnostic', changed));
  });

  it('the same request retried keeps the same key - whatever order its fields were built in', () => {
    const run = newJevRunId();
    const first = jevIdempotencyKey(run, 'benchmark', body('chat-simple-001'));
    assert.equal(jevIdempotencyKey(run, 'benchmark', body('chat-simple-001')), first);
    assert.equal(jevIdempotencyKey(run, 'benchmark', JSON.parse(JSON.stringify(body('chat-simple-001')))), first);
    assert.equal(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: undefined } }), '{"a":{"d":[3,{"x":2,"y":1}]},"b":1}');
    assert.equal(jevRequestFingerprint({ a: 1, b: 2 }), jevRequestFingerprint({ b: 2, a: 1 }));
  });

  it('the same request in ANOTHER run has another key: nothing from an earlier run can meet it', () => {
    const request = body('chat-simple-001');
    const keys = new Set(Array.from({ length: 50 }, () => jevIdempotencyKey(newJevRunId(), 'benchmark', request)));
    assert.equal(keys.size, 50);
    assert.notEqual(newJevRunId(), newJevRunId());
    assert.match(newJevRunId(), /^[0-9a-f]{16}$/);
  });

  it('is a plain label - a purpose, a run id, a hash of the request - safe as a header, with no credential and no request content in it', () => {
    const key = jevIdempotencyKey('Run 42!', 'Live Diagnostic', body('chat-simple-001'));
    assert.match(key, /^nagex-live-diagnostic-Run42-[0-9a-f]{24}$/);
    assert.ok(key.length < 100);
    assert.equal(key.includes('chat-simple'), false, 'no fixture name or content in it');
    assert.equal(jevIdempotencyKey('', '', {}).startsWith('nagex-request-run-'), true);
  });
});

describe('the provider', () => {
  const ok = () => new Response(JSON.stringify({ model: 'jev-latest', resolved_model: 'jev-1', answers: { complexity: { choice: 'SIMPLE', confidence: 0.9 }, high_risk: { probability: 0.1, confidence: 0.8 }, reasoning_level: { score: 0.2, confidence: 0.7 } } }), { status: 200 });
  const make = (respond: (call: number) => Response) => {
    const calls: Array<{ headers: Record<string, string>; body: string }> = [];
    const fetchFn = (async (_url: string, init: RequestInit) => { calls.push({ headers: init.headers as Record<string, string>, body: String(init.body) }); return respond(calls.length); }) as unknown as typeof fetch;
    return { provider: new JevSystemOneProvider({ apiKey: SECRET, fetchFn }), calls };
  };

  it('sends the key it is given as the Idempotency-Key header, and none when it has none', async () => {
    const { provider, calls } = make(ok);
    await provider.evaluate(input('a', { idempotencyKey: 'key-a' }));
    await provider.evaluate(input('b'));
    assert.equal(calls[0].headers['Idempotency-Key'], 'key-a');
    assert.equal('Idempotency-Key' in calls[1].headers, false);
  });

  it('REFUSES, before anything is sent, to use one key for a second, different request - the retry of the SAME request is allowed and keeps the key', async () => {
    const { provider, calls } = make((n) => (n === 1 ? new Response('{}', { status: 503 }) : ok()));
    await assert.rejects(() => provider.evaluate(input('a', { idempotencyKey: 'shared' })), (e: unknown) => e instanceof ModelProviderError && e.retryable === true);
    const retried = await provider.evaluate(input('a', { idempotencyKey: 'shared' })); // the SAME request again: the same key goes out again
    assert.equal(retried.complexity, 'SIMPLE');
    assert.deepEqual(calls.map((c) => c.headers['Idempotency-Key']), ['shared', 'shared']);
    assert.equal(calls[0].body, calls[1].body);
    await assert.rejects(() => provider.evaluate(input('b', { idempotencyKey: 'shared' })), (e: unknown) => e instanceof ModelProviderError && e.code === 'IDEMPOTENCY_KEY_REUSED' && e.retryable === false);
    assert.equal(calls.length, 2, 'the conflicting request never left the process');
  });

  it('the guard is bounded: a long run does not grow it without limit', async () => {
    const { provider, calls } = make(ok);
    for (let i = 0; i < 600; i += 1) await provider.evaluate(input(`f${i}`, { idempotencyKey: `k${i}` }));
    assert.equal(calls.length, 600);
    await provider.evaluate(input('other', { idempotencyKey: 'k0' })); // k0 was evicted long ago: not remembered, not an error
    assert.equal(calls.length, 601);
  });

  const failure = async (status: number, body: string) => {
    const { provider } = make(() => new Response(body, { status }));
    try { await provider.evaluate(input('a', { idempotencyKey: 'k' })); } catch (error) { return error as ModelProviderError & { details: Record<string, any> }; }
    throw new Error('expected a failure');
  };

  it('HTTP 409 is IDEMPOTENCY_CONFLICT - not retried, with the code the body carries', async () => {
    const e = await failure(409, JSON.stringify({ error: { code: 'idempotency_conflict', message: 'key already used for a different request' } }));
    assert.equal(e.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(e.retryable, false);
    assert.equal(e.details.failureClass, 'IDEMPOTENCY_CONFLICT');
    assert.equal(e.details.bodyCode, 'idempotency_conflict');
    assert.equal(e.details.status, 409);
    assert.equal((await failure(409, '')).code, 'IDEMPOTENCY_CONFLICT', 'a 409 without a readable body is the same thing');
  });

  it('HTTP 402 is INSUFFICIENT_CREDITS and nothing else - whatever its body says', async () => {
    const e = await failure(402, JSON.stringify({ error: { code: 'insufficient_credits' } }));
    assert.equal(e.code, 'INSUFFICIENT_CREDITS');
    assert.equal(e.retryable, false);
    assert.equal(e.details.failureClass, 'INSUFFICIENT_CREDITS');
    assert.equal((await failure(402, JSON.stringify({ error: { code: 'idempotency_conflict' } }))).code, 'INSUFFICIENT_CREDITS', 'a 402 is a billing answer; a key conflict is a 409');
  });

  it('every other failure keeps the code the gateway already understands, and its retry rule', async () => {
    const cases: Array<[number, string, boolean]> = [[401, 'KEY_REJECTED', false], [403, 'KEY_REJECTED', false], [422, 'REQUEST_SHAPE_REJECTED', false], [400, 'REQUEST_SHAPE_REJECTED', false], [429, 'RATE_LIMITED', true], [408, 'TIMEOUT', true], [500, 'SERVER_ERROR', true], [503, 'SERVER_ERROR', true], [404, 'HTTP_ERROR', false]];
    for (const [status, failureClass, retryable] of cases) {
      const e = await failure(status, '{}');
      assert.equal(e.code, `PROVIDER_HTTP_${status}`, String(status));
      assert.equal(e.details.failureClass, failureClass, String(status));
      assert.equal(e.retryable, retryable, String(status));
    }
  });

  it('never keeps the credential: an error body that echoes the API key or a bearer token is redacted, in the details and everywhere the error can be read', async () => {
    const e = await failure(401, `invalid key ${SECRET}; header was Authorization: Bearer ${SECRET}; also Bearer abcdefgh12345678`);
    const everything = JSON.stringify({ message: e.message, code: e.code, details: e.details, string: String(e) });
    assert.equal(everything.includes(SECRET), false);
    assert.equal(everything.includes('abcdefgh12345678'), false);
    assert.match(e.details.responseBody, /\[redacted\]/);
    assert.equal(redactSecrets(`x ${SECRET} y`, [SECRET]), 'x [redacted] y');
    assert.equal(redactSecrets('Authorization: secret-token-value', []), 'Authorization: [redacted]');
  });
});

describe('INVALID_FIELD comes from the structure of the error body, never from a word search', () => {
  const field = (text: string) => invalidFieldOf(parseJevErrorBody(text));
  it('names the field only when the body does: pydantic loc, param, field, fields, errors[]', () => {
    assert.equal(field(JSON.stringify({ detail: [{ loc: ['body', 'questions', 'level', 'type'], msg: 'bad', type: 'value_error' }] })), 'questions.level.type');
    assert.equal(field(JSON.stringify({ error: { code: 'invalid_request', param: 'state' } })), 'state');
    assert.equal(field(JSON.stringify({ field: 'model' })), 'model');
    assert.equal(field(JSON.stringify({ fields: ['questions', 'state'] })), 'questions');
    assert.equal(field(JSON.stringify({ errors: [{ field: 'idempotencyKey' }] })), 'idempotencyKey');
  });
  it('a message that merely CONTAINS a field word names no field (the old logic reported "input" for any message with the word in it)', () => {
    for (const body of [JSON.stringify({ error: { message: 'the input is invalid; check instructions and signals' } }), JSON.stringify({ detail: 'invalid input for taskKind and fixtureId' }), 'plain text error mentioning input and metadata', '', '{']) assert.equal(field(body), 'UNKNOWN', body);
  });
  it('reads the code and message of the common shapes, and survives hostile bodies', () => {
    assert.deepEqual(parseJevErrorBody(JSON.stringify({ error: { code: 'idempotency_conflict', message: 'm' } })), { code: 'idempotency_conflict', message: 'm', fields: [] });
    assert.equal(parseJevErrorBody(JSON.stringify({ code: 'x' })).code, 'x');
    assert.equal(parseJevErrorBody(JSON.stringify({ error: 'insufficient_credits' })).code, 'insufficient_credits');
    assert.deepEqual(parseJevErrorBody('null'), { code: null, message: null, fields: [] });
    assert.deepEqual(parseJevErrorBody(JSON.stringify({ detail: [{ loc: ['body', '<script>alert(1)</script>'] }, { loc: 'nope' }, null] })).fields, [], 'a name that is not a plain field name is not reported');
    assert.equal(classifyJevHttpFailure(200, '').failureClass, 'HTTP_ERROR');
  });
});

describe('the real diagnostic script, against a stubbed network (no JEV call is possible)', () => {
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-stub-'));
  const stub = path.join(stubDir, 'fetch-stub.cjs');
  fs.writeFileSync(stub, `
const fs = require('fs');
const mode = process.env.JEV_STUB_MODE || 'ok';
globalThis.fetch = async (url, init) => {
  const headers = init && init.headers || {};
  fs.appendFileSync(process.env.JEV_STUB_LOG, JSON.stringify({ url: String(url), idempotencyKey: headers['Idempotency-Key'] || null, authorizationSent: Boolean(headers.Authorization), bodyLength: String(init.body || '').length }) + '\\n');
  const key = process.env.NAGEX_JEV_API_KEY;
  if (mode === '402') return new Response(JSON.stringify({ error: { code: 'insufficient_credits', message: 'no balance for ' + key } }), { status: 402 });
  if (mode === '409') return new Response(JSON.stringify({ error: { code: 'idempotency_conflict' } }), { status: 409 });
  if (mode === '422-text') return new Response(JSON.stringify({ error: { message: 'the input is invalid; see instructions, signals and taskKind' } }), { status: 422 });
  if (mode === '422-field') return new Response(JSON.stringify({ detail: [{ loc: ['body', 'questions', 'high_risk', 'type'], msg: 'bad' }] }), { status: 422 });
  return new Response(JSON.stringify({ model: 'jev-latest', resolved_model: 'jev-1', answers: { complexity: { choice: 'SIMPLE', confidence: 0.9 }, high_risk: { probability: 0.1, confidence: 0.8 }, reasoning_level: { score: 0.2, confidence: 0.7 } } }), { status: 200 });
};
`);
  const run = (mode: string) => {
    const log = path.join(stubDir, `calls-${mode}-${Math.random().toString(16).slice(2)}.jsonl`);
    const out = spawnSync(process.execPath, ['--require', stub, path.join(ROOT, 'scripts', 'jev-single-live-diagnostic.mjs')], {
      cwd: ROOT, encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, NODE_OPTIONS: '', NAGEX_LIVE_JEV: '1', NAGEX_JEV_API_KEY: SECRET, JEV_STUB_MODE: mode, JEV_STUB_LOG: log, NAGEX_CERT_ENV_FROM_PID: '' },
    });
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    return { stdout: out.stdout, stderr: out.stderr, status: out.status, calls };
  };

  it('two runs of the same diagnostic send DIFFERENT keys (a fresh run id each time) - each a plain label with the run id printed - and exactly one request each', () => {
    const a = run('ok'); const b = run('ok');
    for (const r of [a, b]) {
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.calls.length, 1, 'ONE request');
      assert.equal(r.calls[0].url, 'https://jevmodel.org/v1/systemone');
      assert.match(r.calls[0].idempotencyKey, /^nagex-diagnostic-[0-9a-f]{16}-[0-9a-f]{24}$/);
      assert.match(r.stdout, /JEV_SINGLE_LIVE_DIAGNOSTIC=PASS/);
    }
    assert.notEqual(a.calls[0].idempotencyKey, b.calls[0].idempotencyKey);
    const runId = /IDEMPOTENCY_RUN_ID=([0-9a-f]{16})/.exec(a.stdout)![1];
    assert.ok(a.calls[0].idempotencyKey.includes(runId), 'the key carries the printed run id');
    assert.equal(a.calls[0].idempotencyKey.includes('chat-simple-001'), false, 'no fixed per-fixture key');
  });

  it('HTTP 402 is reported as INSUFFICIENT_CREDITS and HTTP 409 as IDEMPOTENCY_CONFLICT - and the credential is in no output line, even when the server echoes it', () => {
    const credits = run('402');
    assert.equal(credits.status, 1);
    assert.match(credits.stdout, /^HTTP_STATUS=402$/m);
    assert.match(credits.stdout, /^ERROR_CLASS=INSUFFICIENT_CREDITS$/m);
    assert.match(credits.stdout, /^ERROR_CODE=INSUFFICIENT_CREDITS$/m);
    assert.match(credits.stdout, /^JEV_ERROR_CODE=insufficient_credits$/m);
    assert.match(credits.stdout, /\[redacted\]/);
    const conflict = run('409');
    assert.match(conflict.stdout, /^HTTP_STATUS=409$/m);
    assert.match(conflict.stdout, /^ERROR_CLASS=IDEMPOTENCY_CONFLICT$/m);
    assert.match(conflict.stdout, /not a billing problem/);
    for (const r of [credits, conflict, run('ok')]) {
      assert.equal(r.stdout.includes(SECRET) || r.stderr.includes(SECRET), false, 'the API key is printed nowhere');
      assert.equal(/Bearer\s/.test(r.stdout + r.stderr), false, 'no authorization header either');
      assert.ok(r.calls.every((c) => c.authorizationSent === true), 'the credential was sent to the (stub) endpoint - and only there');
    }
  });

  it('INVALID_FIELD is the field the response names - or UNKNOWN - never a word found in its message', () => {
    assert.match(run('422-text').stdout, /^INVALID_FIELD=UNKNOWN$/m);
    assert.match(run('422-field').stdout, /^INVALID_FIELD=questions\.high_risk\.type$/m);
    assert.match(run('422-field').stdout, /^ERROR_CLASS=REQUEST_SHAPE_REJECTED$/m);
  });

  it('the opt-in is unchanged: without NAGEX_LIVE_JEV=1 nothing is sent at all', () => {
    const log = path.join(stubDir, 'calls-optin.jsonl');
    const out = spawnSync(process.execPath, ['--require', stub, path.join(ROOT, 'scripts', 'jev-single-live-diagnostic.mjs')], { cwd: ROOT, encoding: 'utf8', timeout: 60_000, env: { ...process.env, NODE_OPTIONS: '', NAGEX_LIVE_JEV: '', NAGEX_JEV_API_KEY: SECRET, JEV_STUB_LOG: log } });
    assert.match(out.stdout, /JEV_SINGLE_LIVE_DIAGNOSTIC=NOT_RUN/);
    assert.equal(fs.existsSync(log), false, 'no request');
  });
});

describe('the benchmark script (not run here: it is a 36-request live benchmark)', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'jev-live-benchmark.mjs'), 'utf8');
  it('derives a key per request per run, keeps the key on a retry of the same request, and stops at a 402 or a 409 - no fixed key remains', () => {
    assert.equal(/nagex-jev-live-/.test(source), false, 'the fixed per-fixture key is gone');
    assert.match(source, /jevIdempotencyKey\(runId, 'benchmark', buildJevRequestBody\(request\)\)/);
    assert.match(source, /const runId = newJevRunId\(\)/);
    assert.match(source, /async function evaluateWithOneRetry[\s\S]*?error\?\.retryable !== true[\s\S]*?provider\.evaluate\(input\)/);
    assert.match(source, /failureClass === 'INSUFFICIENT_CREDITS' \|\| failureClass === 'IDEMPOTENCY_CONFLICT'/);
    assert.match(source, /process\.env\.JEV_RUN_36 !== 'YES'/, 'still opt-in');
  });
  it('the diagnostic script has no fixed key either', () => {
    assert.equal(/nagex-jev-diagnostic-/.test(fs.readFileSync(path.join(ROOT, 'scripts', 'jev-single-live-diagnostic.mjs'), 'utf8')), false);
  });
});

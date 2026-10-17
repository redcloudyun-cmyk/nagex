// Where NAgex finds the JEV credential and what that does to the JEV advisors - and the proof that checking it never prints it and never calls JEV.
//
//   unit   : the key is read under either historical name (NAGEX_JEV_API_KEY wins, JEVMODEL_API_KEY is the same credential under its original name); an empty value is not a key; the description
//            carries the NAME of the variable and booleans, never the value; the blocker names what to fix, in order.
//   wiring : createNagexApplication() builds the JEV advisors exactly when the switch is on AND a key exists, under either name, and constructing it sends NOTHING (fetch spy).
//   scripts: scripts/jev-config-check.mjs reads an --jev-env-file for the JEV names only and prints facts without the key; scripts/jev-live-check.mjs does nothing without NAGEX_LIVE_JEV=1; its one request
//            is exercised with an injected fetch (never the real service) and a failed call's body is returned without the key.
//
// HONEST SCOPE: no request to the real JEV service is made here. JEV_LIVE stays NOT_RUN until a person runs scripts/jev-live-check.mjs with NAGEX_LIVE_JEV=1 where the key is.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import { createNagexApplication } from '../src/app/create-nagex-application.js';
import { describeJevConfig, resolveJevApiKey } from '../src/model-gateway/jev-config.js';

const SENTINEL = 'jevk-SENTINEL-4f9a1c7e-do-not-print';
const OTHER = 'jevk-OTHER-77d2b0aa-do-not-print';
const JEV_NAMES = ['NAGEX_JEV_API_KEY', 'JEVMODEL_API_KEY', 'NAGEX_JEV_DECISION_ENABLED', 'NAGEX_JEV_ADVISORY_ENABLED'];
// compiled tests live in dist/tests: the repository root (scripts/, dist/src) is two levels up
const ROOT = path.resolve(__dirname, '..', '..');

describe('resolving the key', () => {
  it('NAGEX_JEV_API_KEY wins; JEVMODEL_API_KEY (the original name, the same credential) is read when it is absent; empty is not a key', () => {
    assert.deepEqual(resolveJevApiKey({ NAGEX_JEV_API_KEY: SENTINEL, JEVMODEL_API_KEY: OTHER }), { key: SENTINEL, source: 'NAGEX_JEV_API_KEY' });
    assert.deepEqual(resolveJevApiKey({ JEVMODEL_API_KEY: OTHER }), { key: OTHER, source: 'JEVMODEL_API_KEY' });
    assert.deepEqual(resolveJevApiKey({ NAGEX_JEV_API_KEY: '   ', JEVMODEL_API_KEY: OTHER }), { key: OTHER, source: 'JEVMODEL_API_KEY' });
    assert.deepEqual(resolveJevApiKey({ NAGEX_JEV_API_KEY: '', JEVMODEL_API_KEY: '' }), { key: null, source: null });
    assert.deepEqual(resolveJevApiKey({}), { key: null, source: null });
    assert.equal(resolveJevApiKey({ NAGEX_JEV_API_KEY: `  ${SENTINEL}\n` }).key, SENTINEL, 'surrounding whitespace is not part of the key');
  });

  it('the description names the variable and says yes or no - it never carries the value', () => {
    const configured = describeJevConfig({ JEVMODEL_API_KEY: SENTINEL, NAGEX_JEV_DECISION_ENABLED: 'true' });
    assert.deepEqual(configured, { keyConfigured: true, keySource: 'JEVMODEL_API_KEY', decisionEnabled: true, shadowAdvisoryEnabled: false, advisorsActive: true, blocker: null });
    assert.equal(JSON.stringify(configured).includes(SENTINEL), false);
    assert.equal(JSON.stringify(configured).includes('jevk'), false);
  });

  it('the blocker names what to fix first: the key, then the switch', () => {
    assert.equal(describeJevConfig({}).blocker, 'NO_API_KEY');
    assert.equal(describeJevConfig({ NAGEX_JEV_DECISION_ENABLED: 'true' }).blocker, 'NO_API_KEY', 'the switch without a key is still missing the key');
    assert.equal(describeJevConfig({ NAGEX_JEV_API_KEY: SENTINEL }).blocker, 'DECISION_NOT_ENABLED');
    assert.equal(describeJevConfig({ NAGEX_JEV_API_KEY: SENTINEL, NAGEX_JEV_DECISION_ENABLED: 'yes' }).blocker, 'DECISION_NOT_ENABLED', "only the exact value 'true' enables it");
    assert.equal(describeJevConfig({ NAGEX_JEV_API_KEY: SENTINEL, NAGEX_JEV_DECISION_ENABLED: 'true' }).blocker, null);
  });

  it('the router-level shadow advisory is reported separately: it is a local evaluator and needs no key', () => {
    const status = describeJevConfig({ NAGEX_JEV_ADVISORY_ENABLED: 'true' });
    assert.equal(status.shadowAdvisoryEnabled, true);
    assert.equal(status.advisorsActive, false, 'the shadow advisory does not make the JEV advisors exist');
  });
});

describe('the application', () => {
  const saved: Record<string, string | undefined> = {};
  const realFetch = globalThis.fetch;
  afterEach(() => {
    for (const name of JEV_NAMES) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
    globalThis.fetch = realFetch;
  });
  function build(env: Record<string, string>): { advisor: boolean; calls: number } {
    for (const name of JEV_NAMES) { saved[name] = process.env[name]; delete process.env[name]; }
    Object.assign(process.env, env);
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; throw new Error('no network in this test'); }) as typeof fetch;
    const app = createNagexApplication();
    return { advisor: app.verificationAdvisor !== null, calls };
  }

  it('builds the JEV advisors exactly when the switch is on AND a key exists, under either name - and sends nothing while doing so', () => {
    assert.deepEqual(build({}), { advisor: false, calls: 0 });
    assert.deepEqual(build({ NAGEX_JEV_API_KEY: SENTINEL }), { advisor: false, calls: 0 });
    assert.deepEqual(build({ NAGEX_JEV_DECISION_ENABLED: 'true' }), { advisor: false, calls: 0 });
    assert.deepEqual(build({ NAGEX_JEV_API_KEY: SENTINEL, NAGEX_JEV_DECISION_ENABLED: 'true' }), { advisor: true, calls: 0 });
    assert.deepEqual(build({ JEVMODEL_API_KEY: SENTINEL, NAGEX_JEV_DECISION_ENABLED: 'true' }), { advisor: true, calls: 0 });
  });
});

describe('the scripts', () => {
  const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
    const clean: NodeJS.ProcessEnv = { ...process.env };
    for (const name of JEV_NAMES) delete clean[name];
    delete clean.NAGEX_CERT_ENV_FROM_PID;
    delete clean.NAGEX_LIVE_JEV;
    return { ...clean, ...extra };
  };
  const run = (script: string, args: string[], extra: Record<string, string> = {}) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args], { cwd: ROOT, env: env(extra), encoding: 'utf8', timeout: 60_000 });
  const withEnvFile = (content: string, fn: (file: string) => void): void => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-config-'));
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, content, 'utf8');
    try { fn(file); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };

  it('jev-config-check reads the JEV names of a .env file, reports facts, and never prints the key (nor anything else in the file)', () => {
    withEnvFile(`# service env\nGEMINI_API_KEY=${OTHER}\nJEVMODEL_API_KEY="${SENTINEL}"\nNAGEX_JEV_DECISION_ENABLED=true\n`, (file) => {
      const out = run('jev-config-check.mjs', ['--jev-env-file', file]);
      assert.equal(out.status, 0, out.stderr);
      const text = out.stdout;
      assert.match(text, /^JEV_ENV_KEY=FOUND$/m);
      assert.match(text, /^JEV_KEY_VARIABLE=JEVMODEL_API_KEY$/m);
      assert.match(text, /^JEV_SECRET_RESOLVER=CONNECTED$/m);
      assert.match(text, /^JEV_PROVIDER=READY$/m);
      assert.match(text, /^JEV_RUNTIME_KEY_ACCESS=PASS$/m);
      assert.match(text, /^JEV_LIVE=NOT_RUN$/m);
      assert.match(text, /^JEV_BLOCKER=NONE$/m);
      assert.match(text, /^NEW_KEY_REQUIRED=NO$/m);
      assert.equal(text.includes(SENTINEL) || text.includes(OTHER) || out.stderr.includes(SENTINEL) || out.stderr.includes(OTHER), false, 'no key, whole or in part, in anything printed');
    });
  });

  it('jev-config-check says what is missing, in order: no key -> NOT_FOUND / NOT_READY; a key without the switch -> READY only after the switch', () => {
    const none = run('jev-config-check.mjs', []);
    assert.match(none.stdout, /^JEV_ENV_KEY=NOT_FOUND$/m);
    assert.match(none.stdout, /^JEV_SECRET_RESOLVER=NOT_CONNECTED$/m);
    assert.match(none.stdout, /^JEV_PROVIDER=NOT_READY$/m);
    assert.match(none.stdout, /^JEV_RUNTIME_KEY_ACCESS=FAIL$/m);
    assert.match(none.stdout, /^JEV_BLOCKER=NO_API_KEY$/m);
    assert.match(none.stdout, /^NEW_KEY_REQUIRED=NO$/m, 'a missing key in one place is never a request for a new one');
    withEnvFile(`NAGEX_JEV_API_KEY=${SENTINEL}\n`, (file) => {
      const out = run('jev-config-check.mjs', ['--jev-env-file', file]);
      assert.match(out.stdout, /^JEV_ENV_KEY=FOUND$/m);
      assert.match(out.stdout, /^JEV_PROVIDER=NOT_READY$/m);
      assert.match(out.stdout, /^JEV_BLOCKER=DECISION_NOT_ENABLED$/m);
      assert.equal(out.stdout.includes(SENTINEL), false);
    });
    const missing = run('jev-config-check.mjs', ['--jev-env-file', path.join(os.tmpdir(), 'jev-does-not-exist', '.env')]);
    assert.match(missing.stdout, /^CHECK_PROBLEM=ENV_FILE_NOT_READABLE:/m, 'an unreadable file is reported, not silently treated as "no key"');
  });

  it('jev-live-check makes no request without the explicit opt-in, and none without a key', () => {
    const off = run('jev-live-check.mjs', []);
    assert.equal(off.status, 0);
    assert.match(off.stdout, /^JEV_LIVE=NOT_RUN$/m);
    assert.match(off.stdout, /LIVE_CHECK_NOT_OPTED_IN/);
    const noKey = run('jev-live-check.mjs', [], { NAGEX_LIVE_JEV: '1' });
    assert.match(noKey.stdout, /^JEV_LIVE=NOT_RUN$/m);
    assert.match(noKey.stdout, /NO_API_KEY_IN_INSPECTED_ENVIRONMENT/);
  });

  it('the one request: a valid answer is PASS; a rejected key, a wrong shape, a timeout and a network error are FAIL with the cause - and an error body never carries the key', async () => {
    const live = await import(pathToFileURL(path.join(ROOT, 'scripts', '_jev-live.mjs')).href) as { runLiveCheck: (o: any) => Promise<any>; scrubBody: (t: string, k: string) => string };
    const sent: Array<{ url: string; body: any; auth: string }> = [];
    const reply = (status: number, body: unknown) => (async (url: string, init: any) => {
      sent.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    }) as unknown as typeof fetch;

    const pass = await live.runLiveCheck({ key: SENTINEL, fetchFn: reply(200, { answers: { level: { choice: 'l3', confidence: 0.8 } } }) });
    assert.deepEqual({ live: pass.live, http: pass.http, level: pass.level, confidence: pass.confidence, blocker: pass.blocker }, { live: 'PASS', http: 200, level: 'L3', confidence: 0.8, blocker: 'NONE' });
    assert.equal(sent[0].url, 'https://jevmodel.org/v1/systemone');
    assert.equal(sent[0].auth, `Bearer ${SENTINEL}`, 'the key goes in the header only');
    assert.equal(JSON.stringify(sent[0].body).includes(SENTINEL), false, 'the key is not in the request body');
    assert.equal(sent[0].body.questions.level.type, 'choice');
    assert.deepEqual(Object.keys(sent[0].body.state.text).sort(), ['answerHedged', 'category', 'comparison', 'freshness', 'highImpact', 'research', 'ruleLevel', 'sources', 'task', 'turnKind'], 'only enumerated kinds and buckets are sent');

    const rejected = await live.runLiveCheck({ key: SENTINEL, fetchFn: reply(401, `unauthorized: Bearer ${SENTINEL} is not valid, key ${SENTINEL}`) });
    assert.equal(rejected.live, 'FAIL');
    assert.equal(rejected.blocker, 'KEY_REJECTED_BY_JEV');
    assert.equal(JSON.stringify(rejected).includes(SENTINEL), false, 'the key is removed from what a failed call returns');
    assert.match(rejected.errorBody, /\[redacted\]/);

    assert.equal((await live.runLiveCheck({ key: SENTINEL, fetchFn: reply(422, 'bad field') })).blocker, 'REQUEST_SHAPE_REJECTED');
    assert.equal((await live.runLiveCheck({ key: SENTINEL, fetchFn: reply(429, 'slow down') })).blocker, 'RATE_LIMITED_OR_QUOTA');
    const shape = await live.runLiveCheck({ key: SENTINEL, fetchFn: reply(200, { answers: { level: { choice: 'L9', confidence: 0.9 } } }) });
    assert.deepEqual({ live: shape.live, blocker: shape.blocker }, { live: 'FAIL', blocker: 'ANSWER_SHAPE_NOT_AS_EXPECTED' });
    assert.equal((await live.runLiveCheck({ key: SENTINEL, fetchFn: reply(200, { answers: { level: { choice: 'L2', confidence: 3 } } }) })).live, 'FAIL', 'a confidence outside 0..1 is not an answer');
    const down = await live.runLiveCheck({ key: SENTINEL, fetchFn: (async () => { throw new Error(`socket closed for ${SENTINEL}`); }) as unknown as typeof fetch });
    assert.deepEqual({ live: down.live, blocker: down.blocker }, { live: 'FAIL', blocker: 'NETWORK_ERROR' });
    assert.equal(JSON.stringify(down).includes(SENTINEL), false);
    const slow = await live.runLiveCheck({ key: SENTINEL, timeoutMs: 20, fetchFn: ((_: string, init: any) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))) as unknown as typeof fetch });
    assert.deepEqual({ live: slow.live, blocker: slow.blocker }, { live: 'FAIL', blocker: 'TIMEOUT' });
  });
});

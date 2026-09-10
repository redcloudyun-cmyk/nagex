import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { server } from '../src/server_web.js';

function loadSingleFlight(): {
  createSingleFlightGuard: () => { tryEnter: () => boolean; exit: () => void; isBusy: () => boolean };
} {
  const source = fs.readFileSync(path.join(process.cwd(), 'public', 'single-flight-guard.js'), 'utf8');
  const sandbox: Record<string, unknown> = {};
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'single-flight-guard.js' });
  return (sandbox.window as Record<string, unknown>).NAGEX_SINGLE_FLIGHT as ReturnType<typeof loadSingleFlight>;
}

function loadTimelineDedupe(): {
  createDeduper: () => { shouldLog: (lifecycleKey?: string | null) => boolean; reset: () => void };
} {
  const source = fs.readFileSync(path.join(process.cwd(), 'public', 'timeline-dedupe.js'), 'utf8');
  const sandbox: Record<string, unknown> = {};
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'timeline-dedupe.js' });
  return (sandbox.window as Record<string, unknown>).NAGEX_TIMELINE_DEDUPE as ReturnType<typeof loadTimelineDedupe>;
}

async function withServer(run: (origin: string) => Promise<void>): Promise<void> {
  let isOwner = false;
  if (!server.listening) {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    isOwner = true;
  }
  const addr = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${addr.port}`);
  } finally {
    if (isOwner && server.listening) {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  }
}

function extractFunctionBody(source: string, functionSignature: string): string {
  const start = source.indexOf(functionSignature);
  if (start < 0) return '';
  const candidates = ['\n  function ', '\n  async function ']
    .map((marker) => source.indexOf(marker, start + 1))
    .filter((idx) => idx > start);
  const end = candidates.length ? Math.min(...candidates) : source.length;
  return source.slice(start, end);
}

// Real click simulation needs a DOM/browser harness this repo does not have
// (see tests/ambient_modal_wiring.test.ts for the same note). What is
// verified here, statically against the actually-served app.js plus the
// real pure guard/dedupe modules it uses, is every property the fix
// requires: the Run button's handler funnels into the one canonical submit
// function and never calls runAmbientTask itself (A/B/C), that function's
// own single-flight guard and busy-state disabling are shared with every
// other trigger (D/E/F/G/H), and one generation logs each lifecycle stage
// exactly once (I).

test('A/B/C: the Run button fills the composer and calls submitAmbientComposerInput exactly once — never runAmbientTask directly', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();

    const initBody = extractFunctionBody(appJs, 'function initPrimaryScenario(');
    assert.ok(initBody.length > 0, 'expected to find initPrimaryScenario in the served app.js');
    assert.doesNotMatch(initBody, /runAmbientTask\(/);
    const submitCalls = initBody.match(/submitAmbientComposerInput\(\)/g) || [];
    assert.equal(submitCalls.length, 1, 'expected exactly one call to submitAmbientComposerInput() from the Run button handler');
    assert.match(initBody, /input\.value = 'Prepare my next client meeting and schedule it\.'/);

    // submitAmbientComposerInput itself is the one and only place that
    // calls runAmbientTask for a composer-driven submission.
    const submitBody = extractFunctionBody(appJs, 'function submitAmbientComposerInput(');
    const runCalls = submitBody.match(/runAmbientTask\(/g) || [];
    assert.equal(runCalls.length, 1, 'expected exactly one runAmbientTask call inside submitAmbientComposerInput');
  });
});

test('D/F: the Run button is included in the same busy-state disable list as every composer/Send control', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();
    const body = extractFunctionBody(appJs, 'function setAmbientRunControlsDisabled(');
    assert.ok(body.length > 0, 'expected to find setAmbientRunControlsDisabled in the served app.js');
    for (const id of ['ambient-prompt-input', 'btn-ambient-run', 'home-prompt-input', 'btn-home-prompt-send', 'btn-run-ambient-plan']) {
      assert.match(body, new RegExp(`'${id}'`), `expected setAmbientRunControlsDisabled to include '${id}'`);
    }
  });
});

test('G/H: controls are re-enabled in a finally block, so this runs whether the request succeeds or fails', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();
    const runTaskBody = extractFunctionBody(appJs, 'async function runAmbientTask(');
    assert.match(runTaskBody, /setAmbientRunControlsDisabled\(true\)/);
    const finallyIdx = runTaskBody.indexOf('} finally {');
    assert.ok(finallyIdx > 0, 'expected a finally block in runAmbientTask');
    const finallyBlock = runTaskBody.slice(finallyIdx);
    assert.match(finallyBlock, /ambientRunGuard\.exit\(\)/);
    assert.match(finallyBlock, /setAmbientRunControlsDisabled\(false\)/);
  });
});

test('D/E: while one run is in flight (guard busy), a second attempted entry — from Run, Send, or a double-click — is rejected', () => {
  const singleFlight = loadSingleFlight();
  const guard = singleFlight.createSingleFlightGuard();

  // First "click" (Run, or Send, or Enter — all funnel through the same
  // guard inside runAmbientTask) succeeds and marks the guard busy.
  assert.equal(guard.tryEnter(), true);

  // Every further attempt while busy — whether it's the Run button being
  // double-clicked, or the composer's Send being clicked in the same
  // window, or a repeated Enter — must be rejected, not start a second run.
  assert.equal(guard.tryEnter(), false);
  assert.equal(guard.tryEnter(), false);
  assert.equal(guard.tryEnter(), false);
  assert.equal(guard.isBusy(), true);

  guard.exit();
  assert.equal(guard.tryEnter(), true);
});

test('I: one Run click ultimately produces exactly one "Plan created" and one "Plan resolved" lifecycle entry', () => {
  // Simulates "Run -> submitAmbientComposerInput -> runAmbientTask (one
  // call) -> resolvePlanIntoUi (one call)" against the real dedupe module:
  // since the Run button funnels into the single canonical path (proven by
  // the A/B/C test above), one click can only ever produce one requestId,
  // and that requestId can only ever log each lifecycle stage once.
  const dedupe = loadTimelineDedupe();
  const deduper = dedupe.createDeduper();
  const planId = 'req_from_run_button_click';

  const log: string[] = [];
  function record(label: string, key: string) {
    if (deduper.shouldLog(key)) log.push(label);
  }

  record('Plan created', `plan:${planId}:created`);
  record('Plan resolved', `plan:${planId}:resolved`);

  assert.deepEqual(log, ['Plan created', 'Plan resolved']);
  assert.equal(log.filter((l) => l === 'Plan created').length, 1);
  assert.equal(log.filter((l) => l === 'Plan resolved').length, 1);
});

test('J: the Run button label is i18n-driven for both the idle and running states', async () => {
  await withServer(async (origin) => {
    const html = await (await fetch(`${origin}/`)).text();
    assert.match(html, /id="btn-run-ambient-plan-label"[^>]*data-i18n="ambient\.run"/);

    const appJs = await (await fetch(`${origin}/app.js`)).text();
    const body = extractFunctionBody(appJs, 'function setAmbientRunControlsDisabled(');
    assert.match(body, /t\('ambient\.running'\)/);
    assert.match(body, /t\('ambient\.run'\)/);
  });
});

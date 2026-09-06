import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { server } from '../src/server_web.js';

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
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

// Item 7's regression, simulated at the level this repo can actually test
// (no DOM/browser harness — see tests/ambient_modal_wiring.test.ts): a
// generated plan's requestId and an approval's approvalId feed the same
// canonical lifecycle keys addTimelineEntry() in app.js builds (e.g.
// `plan:${planId}:created`), so replaying the exact sequence of calls a
// real UI re-render/reopen/hydration cycle would make against the SAME
// deduper instance proves the timeline can never show a lifecycle event
// twice for the same plan/approval, while genuinely distinct plans and
// lifecycle stages are never suppressed.
test('one plan generation followed by re-render/reopen/hydration logs exactly one "Plan created" and one "Plan resolved"', () => {
  const dedupe = loadTimelineDedupe();
  const deduper = dedupe.createDeduper();
  const planId = 'req_plan_stable_123';
  const createdKey = `plan:${planId}:created`;
  const resolvedKey = `plan:${planId}:resolved`;

  // Plan generation.
  assert.equal(deduper.shouldLog(createdKey), true);
  // Resolution.
  assert.equal(deduper.shouldLog(resolvedKey), true);

  // A UI re-render of the same already-resolved plan (e.g. the resolution
  // card re-rendering after a locale toggle) must not re-log either event.
  assert.equal(deduper.shouldLog(createdKey), false);
  assert.equal(deduper.shouldLog(resolvedKey), false);

  // Reopening the Plan Preview modal and re-hydrating from the same
  // already-generated plan/response must not re-log either event either —
  // this deduper is intentionally never reset (see app.js's
  // resetAmbientFlowUi), specifically so a reopen cannot unmask a duplicate.
  assert.equal(deduper.shouldLog(createdKey), false);
  assert.equal(deduper.shouldLog(resolvedKey), false);
});

test('full expected order for a Calendar request: every lifecycle event exactly once, distinct events never suppressed', () => {
  const dedupe = loadTimelineDedupe();
  const deduper = dedupe.createDeduper();
  const planId = 'req_plan_calendar_1';
  const approvalId = 'apr_calendar_1';

  const log: string[] = [];
  function record(label: string, key: string) {
    if (deduper.shouldLog(key)) log.push(label);
  }

  // Before approval is requested.
  record('Plan created', `plan:${planId}:created`);
  record('Plan resolved', `plan:${planId}:resolved`);
  // A duplicate attempt for either (simulating the exact reported bug, and
  // a UI re-render in between) must not add a second entry.
  record('Plan created', `plan:${planId}:created`);
  record('Plan resolved', `plan:${planId}:resolved`);

  assert.deepEqual(log, ['Plan created', 'Plan resolved']);

  // After the user clicks Preview & Request Approval.
  record('Approval requested', `approval:${approvalId}:requested`);
  assert.deepEqual(log, ['Plan created', 'Plan resolved', 'Approval requested']);

  // After approve.
  record('Approved', `approval:${approvalId}:approved`);
  record('Execution started', `execution:${approvalId}:started`);
  record('Calendar event created', `execution:exe_calendar_1:succeeded`);

  assert.deepEqual(log, [
    'Plan created',
    'Plan resolved',
    'Approval requested',
    'Approved',
    'Execution started',
    'Calendar event created',
  ]);

  // Replaying the whole sequence again (e.g. a re-render of the finished
  // approval card) must not duplicate anything.
  record('Plan created', `plan:${planId}:created`);
  record('Plan resolved', `plan:${planId}:resolved`);
  record('Approval requested', `approval:${approvalId}:requested`);
  record('Approved', `approval:${approvalId}:approved`);
  record('Execution started', `execution:${approvalId}:started`);
  record('Calendar event created', `execution:exe_calendar_1:succeeded`);
  assert.equal(log.length, 6);
});

test('a genuinely different plan or approval still gets its own events — nothing is globally suppressed', () => {
  const dedupe = loadTimelineDedupe();
  const deduper = dedupe.createDeduper();

  assert.equal(deduper.shouldLog('plan:req_plan_A:created'), true);
  assert.equal(deduper.shouldLog('plan:req_plan_B:created'), true);
  assert.equal(deduper.shouldLog('approval:apr_A:requested'), true);
  assert.equal(deduper.shouldLog('approval:apr_B:requested'), true);
});

// ── static wiring: the actual fix is in app.js, not just the pure module ──

function extractFunctionBody(source: string, functionSignature: string): string {
  const start = source.indexOf(functionSignature);
  if (start < 0) return '';
  const candidates = ['\n  function ', '\n  async function ']
    .map((marker) => source.indexOf(marker, start + 1))
    .filter((idx) => idx > start);
  const end = candidates.length ? Math.min(...candidates) : source.length;
  return source.slice(start, end);
}

test('runAmbientTask is guarded against re-entrancy, disables its trigger controls while in flight, and the timeline deduper is never reset', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();

    const runTaskBody = extractFunctionBody(appJs, 'async function runAmbientTask(');
    assert.match(runTaskBody, /ambientRunGuard && !ambientRunGuard\.tryEnter\(\)/);
    assert.match(runTaskBody, /ambientRunGuard\.exit\(\)/);
    // The guard must be released even on an early return / thrown error.
    assert.match(runTaskBody, /finally\s*\{/);
    // Every real trigger surface is disabled for the duration of the
    // request — not a timer/debounce, tied directly to the guard's busy
    // window — so a second submission cannot even be attempted while one
    // is in flight.
    assert.match(runTaskBody, /setAmbientRunControlsDisabled\(true\)/);
    assert.match(runTaskBody, /setAmbientRunControlsDisabled\(false\)/);

    // The dedupe guard is deliberately never reset — see the comment above
    // ambientTimelineDeduper in app.js for why a reset would be unsafe.
    assert.doesNotMatch(appJs, /ambientTimelineDeduper\.reset\(\)/);

    const html = await (await fetch(`${origin}/`)).text();
    assert.match(html, /src="single-flight-guard\.js\?v=/);
  });
});

test('lifecycle keys are explicit, canonical, and built at every call site — never a bare id, never a timestamp', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();

    assert.match(appJs, /addTimelineEntry\('Plan created', `plan:\$\{res\.requestId\}:created`, 'runAmbientTask'\)/);
    assert.match(appJs, /addTimelineEntry\('Plan resolved', `plan:\$\{planId\}:resolved`, 'resolvePlanIntoUi'\)/);
    assert.match(appJs, /addTimelineEntry\('Approval requested', `approval:\$\{approval\.approvalId\}:requested`/);
    assert.match(appJs, /addTimelineEntry\('Approved', `approval:\$\{approval\.approvalId\}:approved`/);
    assert.match(appJs, /addTimelineEntry\('Execution started', `execution:\$\{approval\.approvalId\}:started`/);
    assert.match(appJs, /addTimelineEntry\('Calendar event created', `execution:\$\{result\.executionId\}:succeeded`/);

    // Never a raw Date/timestamp used as the dedupe identity.
    assert.doesNotMatch(appJs, /addTimelineEntry\([^)]*Date\.now\(\)/);
    assert.doesNotMatch(appJs, /addTimelineEntry\([^)]*new Date\(\)/);
  });
});

test('the debug instrumentation logs only lifecycleKey/eventType/producer/outcome, gated to local/opt-in origins, and is never called with payload data', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();

    assert.match(appJs, /function isTimelineDebugEnabled\(/);
    assert.match(appJs, /debugTimeline/);
    assert.match(appJs, /localhost/);

    const logBody = extractFunctionBody(appJs, 'function logTimelineDebug(');
    assert.match(logBody, /console\.debug/);
    // Only ever forwards the object it was given — it must not itself
    // reach into payload/canonicalPayload/token/secret fields.
    assert.doesNotMatch(logBody, /payload/i);
    assert.doesNotMatch(logBody, /token/i);
    assert.doesNotMatch(logBody, /secret/i);

    const callSites = [...appJs.matchAll(/logTimelineDebug\(\{([^}]*)\}\)/g)].map((m) => m[1]);
    assert.ok(callSites.length > 0, 'expected at least one logTimelineDebug call site');
    for (const fields of callSites) {
      assert.match(fields, /lifecycleKey/);
      assert.match(fields, /eventType/);
      assert.match(fields, /producer/);
      assert.doesNotMatch(fields, /payload/i);
    }
  });
});

test('the demo "Run" button inside the ambient overlay no longer independently triggers plan generation', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();

    // This was the actual second producer: a live control, sitting right
    // next to the real composer inside the same open overlay, that called
    // runAmbientTask() directly with a hardcoded prompt. It must no longer
    // do so — it may only ever populate the composer, so any submission of
    // that example text goes through the one real path (Enter / Send).
    const initBody = extractFunctionBody(appJs, 'function initPrimaryScenario(');
    assert.ok(initBody.length > 0, 'expected to find initPrimaryScenario in the served app.js');
    assert.doesNotMatch(initBody, /runAmbientTask\(/);
    assert.match(initBody, /btn-run-ambient-plan/);
  });
});

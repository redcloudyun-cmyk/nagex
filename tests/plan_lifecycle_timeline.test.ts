import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { server } from '../src/server_web.js';

function loadTimelineDedupe(): {
  createDeduper: () => { shouldLog: (label: string, id?: string | null) => boolean; reset: () => void };
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
// generated plan's requestId and an approval's approvalId are the same
// deterministic keys addTimelineEntry() in app.js uses, so replaying the
// exact sequence of calls a real UI re-render/reopen/hydration cycle would
// make against the SAME deduper instance proves the timeline can never show
// a lifecycle event twice for the same plan/approval, while genuinely
// distinct plans and lifecycle stages are never suppressed.
test('one plan generation followed by re-render/reopen/hydration logs exactly one "Plan created" and one "Plan resolved"', () => {
  const dedupe = loadTimelineDedupe();
  const deduper = dedupe.createDeduper();
  const planId = 'req_plan_stable_123';

  // Plan generation.
  assert.equal(deduper.shouldLog('Plan created', planId), true);
  // Resolution.
  assert.equal(deduper.shouldLog('Plan resolved', planId), true);

  // A UI re-render of the same already-resolved plan (e.g. the resolution
  // card re-rendering after a locale toggle) must not re-log either event.
  assert.equal(deduper.shouldLog('Plan created', planId), false);
  assert.equal(deduper.shouldLog('Plan resolved', planId), false);

  // Reopening the Plan Preview modal and re-hydrating from the same
  // already-generated plan/response must not re-log either event either —
  // this deduper is intentionally never reset (see app.js's
  // resetAmbientFlowUi), specifically so a reopen cannot unmask a duplicate.
  assert.equal(deduper.shouldLog('Plan created', planId), false);
  assert.equal(deduper.shouldLog('Plan resolved', planId), false);
});

test('full expected order for a Calendar request: every lifecycle event exactly once, distinct events never suppressed', () => {
  const dedupe = loadTimelineDedupe();
  const deduper = dedupe.createDeduper();
  const planId = 'req_plan_calendar_1';
  const approvalId = 'apr_calendar_1';

  const log: string[] = [];
  function record(label: string, id: string) {
    if (deduper.shouldLog(label, id)) log.push(label);
  }

  // Before approval is requested.
  record('Plan created', planId);
  record('Plan resolved', planId);
  // A duplicate attempt for either (simulating the exact reported bug, and
  // a UI re-render in between) must not add a second entry.
  record('Plan created', planId);
  record('Plan resolved', planId);

  assert.deepEqual(log, ['Plan created', 'Plan resolved']);

  // After the user clicks Preview & Request Approval.
  record('Approval requested', approvalId);
  assert.deepEqual(log, ['Plan created', 'Plan resolved', 'Approval requested']);

  // After approve.
  record('Approved', approvalId);
  record('Execution started', approvalId);
  record('Calendar event created', approvalId);

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
  record('Plan created', planId);
  record('Plan resolved', planId);
  record('Approval requested', approvalId);
  record('Approved', approvalId);
  record('Execution started', approvalId);
  record('Calendar event created', approvalId);
  assert.equal(log.length, 6);
});

test('a genuinely different plan or approval still gets its own events — nothing is globally suppressed', () => {
  const dedupe = loadTimelineDedupe();
  const deduper = dedupe.createDeduper();

  assert.equal(deduper.shouldLog('Plan created', 'req_plan_A'), true);
  assert.equal(deduper.shouldLog('Plan created', 'req_plan_B'), true);
  assert.equal(deduper.shouldLog('Approval requested', 'apr_A'), true);
  assert.equal(deduper.shouldLog('Approval requested', 'apr_B'), true);
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

test('runAmbientTask is guarded against re-entrancy, and the timeline deduper is never reset', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();

    const runTaskBody = extractFunctionBody(appJs, 'async function runAmbientTask(');
    assert.match(runTaskBody, /ambientRunGuard && !ambientRunGuard\.tryEnter\(\)/);
    assert.match(runTaskBody, /ambientRunGuard\.exit\(\)/);
    // The guard must be released even on an early return / thrown error.
    assert.match(runTaskBody, /finally\s*\{/);

    // The dedupe guard is deliberately never reset — see the comment above
    // ambientTimelineDeduper in app.js for why a reset would be unsafe.
    assert.doesNotMatch(appJs, /ambientTimelineDeduper\.reset\(\)/);

    const html = await (await fetch(`${origin}/`)).text();
    assert.match(html, /src="single-flight-guard\.js\?v=/);
  });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';

// public/timeline-dedupe.js is a dependency-free browser script (IIFE),
// loaded the same way tests/modal_behavior.test.ts loads modal-behavior.js:
// run its real source in a vm sandbox so we exercise the actual dedupe logic
// the Ambient Assistant activity timeline relies on.
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

const dedupe = loadTimelineDedupe();

test('H. one plan generation produces exactly one loggable "Plan created" event', () => {
  const deduper = dedupe.createDeduper();
  const planId = 'req_plan_abc123';
  assert.equal(deduper.shouldLog('Plan created', planId), true);
  // A second attempt to log the SAME lifecycle event for the SAME plan
  // (e.g. plan generation and resolution/UI hydration both trying to record
  // it) must be suppressed.
  assert.equal(deduper.shouldLog('Plan created', planId), false);
  assert.equal(deduper.shouldLog('Plan created', planId), false);
});

test('a second, genuinely distinct plan still gets its own "Plan created" event', () => {
  const deduper = dedupe.createDeduper();
  assert.equal(deduper.shouldLog('Plan created', 'req_plan_1'), true);
  assert.equal(deduper.shouldLog('Plan created', 'req_plan_2'), true);
});

test('different lifecycle events for the same plan/approval are never deduplicated against each other', () => {
  const deduper = dedupe.createDeduper();
  const approvalId = 'apr_123';
  assert.equal(deduper.shouldLog('Approval requested', approvalId), true);
  assert.equal(deduper.shouldLog('Approved', approvalId), true);
  assert.equal(deduper.shouldLog('Calendar event created', approvalId), true);
});

test('an event with no id (nothing to dedupe against) is never suppressed', () => {
  const deduper = dedupe.createDeduper();
  assert.equal(deduper.shouldLog('Rejected', undefined), true);
  assert.equal(deduper.shouldLog('Rejected', undefined), true);
  assert.equal(deduper.shouldLog('Rejected', null), true);
});

test('reset() clears prior history, allowing a fresh session to log the same (label, id) pair again', () => {
  const deduper = dedupe.createDeduper();
  const planId = 'req_plan_abc123';
  assert.equal(deduper.shouldLog('Plan created', planId), true);
  assert.equal(deduper.shouldLog('Plan created', planId), false);
  deduper.reset();
  assert.equal(deduper.shouldLog('Plan created', planId), true);
});

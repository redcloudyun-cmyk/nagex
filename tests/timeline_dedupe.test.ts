import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';

// public/timeline-dedupe.js is a dependency-free browser script (IIFE),
// loaded the same way tests/modal_behavior.test.ts loads modal-behavior.js:
// run its real source in a vm sandbox so we exercise the actual dedupe logic
// the Ambient Assistant activity timeline relies on. Callers pass a single,
// fully-formed canonical lifecycle key (e.g. `plan:${planId}:created`) —
// never a label+id pair reconstructed internally, and never a timestamp.
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

const dedupe = loadTimelineDedupe();

test('one plan generation produces exactly one loggable "Plan created" event', () => {
  const deduper = dedupe.createDeduper();
  const key = 'plan:req_plan_abc123:created';
  assert.equal(deduper.shouldLog(key), true);
  // A second attempt to log the SAME lifecycle key (e.g. plan generation
  // and resolution/UI hydration both trying to record it) must be
  // suppressed.
  assert.equal(deduper.shouldLog(key), false);
  assert.equal(deduper.shouldLog(key), false);
});

test('a second, genuinely distinct plan still gets its own "Plan created" event', () => {
  const deduper = dedupe.createDeduper();
  assert.equal(deduper.shouldLog('plan:req_plan_1:created'), true);
  assert.equal(deduper.shouldLog('plan:req_plan_2:created'), true);
});

test('different lifecycle stages for the same approval are never deduplicated against each other', () => {
  const deduper = dedupe.createDeduper();
  const approvalId = 'apr_123';
  assert.equal(deduper.shouldLog(`approval:${approvalId}:requested`), true);
  assert.equal(deduper.shouldLog(`approval:${approvalId}:approved`), true);
  assert.equal(deduper.shouldLog(`execution:${approvalId}:started`), true);
});

test('an event with no key (nothing to dedupe against) is never suppressed', () => {
  const deduper = dedupe.createDeduper();
  assert.equal(deduper.shouldLog(undefined), true);
  assert.equal(deduper.shouldLog(undefined), true);
  assert.equal(deduper.shouldLog(null), true);
});

test('reset() clears prior history, allowing a fresh session to log the same key again', () => {
  const deduper = dedupe.createDeduper();
  const key = 'plan:req_plan_abc123:created';
  assert.equal(deduper.shouldLog(key), true);
  assert.equal(deduper.shouldLog(key), false);
  deduper.reset();
  assert.equal(deduper.shouldLog(key), true);
});

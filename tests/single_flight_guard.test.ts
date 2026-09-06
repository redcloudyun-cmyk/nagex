import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';

// public/single-flight-guard.js is a dependency-free browser script (IIFE),
// loaded the same way the other pure frontend modules are in this suite:
// run its real source in a vm sandbox so we exercise the actual re-entrancy
// guard runAmbientTask() relies on to stop a second plan generation from
// starting while one is already in flight (the real root cause of the
// duplicate "Plan created" timeline entry — see tests/plan_lifecycle_
// timeline.test.ts for the timeline-level regression).
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

const singleFlight = loadSingleFlight();

test('a fresh guard allows entry and reports busy afterward', () => {
  const guard = singleFlight.createSingleFlightGuard();
  assert.equal(guard.isBusy(), false);
  assert.equal(guard.tryEnter(), true);
  assert.equal(guard.isBusy(), true);
});

test('a second tryEnter while busy is rejected — this is what stops the duplicate generation', () => {
  const guard = singleFlight.createSingleFlightGuard();
  assert.equal(guard.tryEnter(), true);
  assert.equal(guard.tryEnter(), false);
  assert.equal(guard.tryEnter(), false);
  assert.equal(guard.isBusy(), true);
});

test('exit() releases the guard so a subsequent, genuinely new run is allowed', () => {
  const guard = singleFlight.createSingleFlightGuard();
  assert.equal(guard.tryEnter(), true);
  guard.exit();
  assert.equal(guard.isBusy(), false);
  assert.equal(guard.tryEnter(), true);
});

test('exit() is safe to call when not busy (e.g. a finally block after an early return)', () => {
  const guard = singleFlight.createSingleFlightGuard();
  guard.exit();
  assert.equal(guard.isBusy(), false);
  assert.equal(guard.tryEnter(), true);
});

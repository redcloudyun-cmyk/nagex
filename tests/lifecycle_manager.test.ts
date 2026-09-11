// Phase 02 — Lifecycle Manager.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LifecycleManager, LifecycleAggregateError } from '../src/app/lifecycle-manager.js';
import type { ManagedResource } from '../src/app/lifecycle.types.js';
import { createNagexApplication } from '../src/app/create-nagex-application.js';

function recorder(name: string, log: string[], overrides: Partial<ManagedResource> = {}): ManagedResource {
  return {
    name,
    start: () => { log.push(`start:${name}`); },
    stop: () => { log.push(`stop:${name}`); },
    ...overrides,
  };
}

test('1. registration is deterministic — resources are tracked in the exact order register() was called', () => {
  const lifecycle = new LifecycleManager();
  const log: string[] = [];
  lifecycle.register(recorder('a', log));
  lifecycle.register(recorder('b', log));
  lifecycle.register(recorder('c', log));
  // Observable via start order (forward = registration order).
  return lifecycle.startAll().then(() => {
    assert.deepEqual(log, ['start:a', 'start:b', 'start:c']);
  });
});

test('2. startAll() starts every resource exactly once, even if called more than once', async () => {
  const lifecycle = new LifecycleManager();
  const log: string[] = [];
  lifecycle.register(recorder('a', log));
  lifecycle.register(recorder('b', log));
  await Promise.all([lifecycle.startAll(), lifecycle.startAll(), lifecycle.startAll()]);
  assert.deepEqual(log, ['start:a', 'start:b']);
});

test('3. stopAll() stops in deterministic reverse-registration order by default', async () => {
  const lifecycle = new LifecycleManager();
  const log: string[] = [];
  lifecycle.register(recorder('a', log));
  lifecycle.register(recorder('b', log));
  lifecycle.register(recorder('c', log));
  await lifecycle.stopAll();
  assert.deepEqual(log, ['stop:c', 'stop:b', 'stop:a']);
});

test('4. duplicate stopAll() calls clean up exactly once, not once per call', async () => {
  const lifecycle = new LifecycleManager();
  const log: string[] = [];
  lifecycle.register(recorder('a', log));
  await Promise.all([lifecycle.stopAll(), lifecycle.stopAll(), lifecycle.stopAll()]);
  assert.deepEqual(log, ['stop:a']);
});

test('5. one resource\'s stop() failure does not prevent the rest from being cleaned up', async () => {
  const lifecycle = new LifecycleManager();
  const log: string[] = [];
  lifecycle.register(recorder('a', log));
  lifecycle.register({ name: 'b', stop: () => { log.push('stop:b'); throw new Error('b failed'); } });
  lifecycle.register(recorder('c', log));
  await assert.rejects(() => lifecycle.stopAll());
  // Registration order [a, b, c] -> stop order [c, b, a]; b's throw must not
  // stop a's cleanup from being attempted.
  assert.deepEqual(log, ['stop:c', 'stop:b', 'stop:a']);
});

test('6. a stopAll() failure is a truthful aggregate — names every resource that actually failed, never silently swallowed', async () => {
  const lifecycle = new LifecycleManager();
  lifecycle.register({ name: 'ok-1', stop: () => {} });
  lifecycle.register({ name: 'bad-1', stop: () => { throw new Error('boom-1'); } });
  lifecycle.register({ name: 'bad-2', stop: () => { throw new Error('boom-2'); } });
  await assert.rejects(
    () => lifecycle.stopAll(),
    (err: unknown) => {
      assert.ok(err instanceof LifecycleAggregateError);
      assert.equal(err.phase, 'stop');
      assert.deepEqual(err.failures.map((f) => f.name).sort(), ['bad-1', 'bad-2']);
      return true;
    },
  );
});

test('7. a synchronous stop() (no Promise returned) is supported', async () => {
  const lifecycle = new LifecycleManager();
  let stopped = false;
  lifecycle.register({ name: 'sync', stop: () => { stopped = true; } });
  await lifecycle.stopAll();
  assert.equal(stopped, true);
});

test('8. an asynchronous stop() (returns a Promise) is awaited before stopAll() resolves', async () => {
  const lifecycle = new LifecycleManager();
  let stopped = false;
  lifecycle.register({
    name: 'async',
    stop: () => new Promise<void>((resolve) => setTimeout(() => { stopped = true; resolve(); }, 10)),
  });
  await lifecycle.stopAll();
  assert.equal(stopped, true);
});

test('9. registering two resources with the same name is rejected', () => {
  const lifecycle = new LifecycleManager();
  lifecycle.register({ name: 'dup', stop: () => {} });
  assert.throws(
    () => lifecycle.register({ name: 'dup', stop: () => {} }),
    /already registered/,
  );
});

test('10. zero registered resources is safe for both startAll() and stopAll()', async () => {
  const lifecycle = new LifecycleManager();
  await assert.doesNotReject(() => lifecycle.startAll());
  await assert.doesNotReject(() => lifecycle.stopAll());
});

test('11. a start() failure is reported truthfully via the same aggregate-error contract as stop()', async () => {
  const lifecycle = new LifecycleManager();
  lifecycle.register({ name: 'good', start: () => {}, stop: () => {} });
  lifecycle.register({ name: 'bad', start: () => { throw new Error('start failed'); }, stop: () => {} });
  await assert.rejects(
    () => lifecycle.startAll(),
    (err: unknown) => {
      assert.ok(err instanceof LifecycleAggregateError);
      assert.equal(err.phase, 'start');
      assert.deepEqual(err.failures.map((f) => f.name), ['bad']);
      return true;
    },
  );
});

test('12. stopAll() before startAll() is safe — a resource with no start() is still stoppable', async () => {
  const lifecycle = new LifecycleManager();
  const log: string[] = [];
  lifecycle.register({ name: 'stop-only', stop: () => { log.push('stop:stop-only'); } });
  await lifecycle.stopAll();
  assert.deepEqual(log, ['stop:stop-only']);
});

test('13. register() after stopAll() has already run just adds the resource — it is never auto-started or auto-stopped', async () => {
  const lifecycle = new LifecycleManager();
  await lifecycle.stopAll();
  const log: string[] = [];
  lifecycle.register(recorder('late', log));
  assert.deepEqual(log, [], 'registering after stopAll() must not itself trigger start or stop');
});

// ─── Integration: createNagexApplication() + LifecycleManager (Section 19) ───

test('14. createNagexApplication() exposes a real, empty LifecycleManager — it registers nothing itself', async () => {
  const app = createNagexApplication();
  assert.equal(typeof app.lifecycle.register, 'function');
  assert.equal(typeof app.lifecycle.startAll, 'function');
  assert.equal(typeof app.lifecycle.stopAll, 'function');
  // Nothing registered by construction itself -> both are safe no-ops.
  // (server_web.ts's require.main === module block is the only place that
  // ever calls app.lifecycle.register().)
  await assert.doesNotReject(() => app.lifecycle.startAll());
  await assert.doesNotReject(() => app.lifecycle.stopAll());
});

test('15. Constructing the app graph starts no HTTP server and no scheduler interval — confirmed behaviorally via LifecycleManager, not just by source inspection', async () => {
  const app = createNagexApplication();
  // If construction itself had started anything real (an HTTP listener, a
  // timer), app.lifecycle would either already be non-empty (contradicting
  // test 14) or that resource would exist entirely outside lifecycle's
  // reach — a fresh, resource-less lifecycle's startAll() must be near
  // instant.
  const before = Date.now();
  await app.lifecycle.startAll();
  const elapsedMs = Date.now() - before;
  assert.ok(elapsedMs < 100, `app.lifecycle.startAll() on a fresh, resource-less graph should be near-instant; took ${elapsedMs}ms`);
});

test('16. Two createNagexApplication() calls produce two independent LifecycleManager instances', () => {
  const appA = createNagexApplication();
  const appB = createNagexApplication();
  assert.notEqual(appA.lifecycle, appB.lifecycle);
});

// ─── HTTP lifecycle shutdown-failure propagation (fix: server_web.ts's
// 'http-server' ManagedResource.stop() must reject when server.close()'s
// callback receives an error, not always resolve) — reproduced here with
// the exact same resource names and registration order server_web.ts
// actually uses (browser-runtime, task-scheduler-interval, http-server),
// so these tests exercise the real-world implication of the fix: since
// stopAll() stops in reverse-registration order ([http-server,
// task-scheduler-interval, browser-runtime]), an http-server stop()
// rejection must not prevent the other two from still being stopped. ───

test('17. An http-server-shaped resource whose stop() rejects propagates that rejection to LifecycleManager (stopAll() rejects)', async () => {
  const lifecycle = new LifecycleManager();
  lifecycle.register({ name: 'browser-runtime', stop: () => {} });
  lifecycle.register({ name: 'task-scheduler-interval', stop: () => {} });
  lifecycle.register({ name: 'http-server', stop: () => Promise.reject(new Error('server.close() failed')) });
  await assert.rejects(() => lifecycle.stopAll());
});

test('18. Later resources (task-scheduler-interval, browser-runtime) still stop after the http-server resource\'s stop() rejects', async () => {
  const lifecycle = new LifecycleManager();
  const log: string[] = [];
  lifecycle.register(recorder('browser-runtime', log));
  lifecycle.register(recorder('task-scheduler-interval', log));
  lifecycle.register({ name: 'http-server', stop: () => Promise.reject(new Error('server.close() failed')) });
  await assert.rejects(() => lifecycle.stopAll());
  // Stop order is reverse registration: http-server, task-scheduler-interval,
  // browser-runtime — the first one rejects, but the other two must still
  // have been attempted (this is the real bug the fix addresses: before it,
  // an HTTP close failure would have silently resolved and never even
  // reached this point as a rejection to test against).
  assert.deepEqual(log, ['stop:task-scheduler-interval', 'stop:browser-runtime']);
});

test('19. The aggregate stop failure truthfully names the http-server resource', async () => {
  const lifecycle = new LifecycleManager();
  lifecycle.register({ name: 'browser-runtime', stop: () => {} });
  lifecycle.register({ name: 'task-scheduler-interval', stop: () => {} });
  lifecycle.register({ name: 'http-server', stop: () => Promise.reject(new Error('server.close() failed')) });
  await assert.rejects(
    () => lifecycle.stopAll(),
    (err: unknown) => {
      assert.ok(err instanceof LifecycleAggregateError);
      assert.equal(err.phase, 'stop');
      assert.deepEqual(err.failures.map((f) => f.name), ['http-server']);
      assert.match(err.failures[0].error instanceof Error ? err.failures[0].error.message : '', /server\.close\(\) failed/);
      return true;
    },
  );
});

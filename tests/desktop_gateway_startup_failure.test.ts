// DC3-B1-R1-R1 — EMBEDDED_GATEWAY_START_FAILURE_PROPAGATES.
//
// Before this correction, server_web.ts's http-server lifecycle hook had
// no `error` listener on the real http.Server at all — a genuine bind
// failure (e.g. the port already in use) would leave that hook's promise
// pending FOREVER: never resolving, never rejecting. This test proves the
// real fix (a `.once('error', reject)` listener) by forcing a real
// EADDRINUSE — pre-binding the exact target port with a plain
// http.Server before startNagexServer() ever tries to listen on it — and
// asserting the call genuinely rejects, bounded by the test's own
// timeout rather than hanging silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const TEST_PORT = 18086;
process.env.PORT = String(TEST_PORT);
process.env.HOST = '127.0.0.1';

test('EMBEDDED_GATEWAY_START_FAILURE_PROPAGATES: a real port-in-use failure rejects startNagexServer(), never hangs', async () => {
  const blocker = http.createServer();
  await new Promise<void>((resolve) => blocker.listen(TEST_PORT, '127.0.0.1', resolve));
  try {
    const { startNagexServer } = await import('../src/server_web.js');
    // Rejects with a real LifecycleAggregateError wrapping the actual
    // EADDRINUSE from the http-server hook — proves the error genuinely
    // propagates through lifecycle.startAll() rather than the old
    // no-error-listener behavior, which would have hung this promise
    // forever instead of ever reaching this assertion at all.
    await assert.rejects(startNagexServer(), (err: unknown) => {
      const failures = (err as { name?: string; failures?: Array<{ name: string; error: unknown }> })?.failures;
      const httpFailure = failures?.find((f) => f.name === 'http-server');
      return (err as { name?: string })?.name === 'LifecycleAggregateError' && (httpFailure?.error as { code?: string })?.code === 'EADDRINUSE';
    });
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }
});

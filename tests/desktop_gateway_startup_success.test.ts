// DC3-B1-R1-R1 — EMBEDDED_GATEWAY_LISTEN_AWAITED.
//
// Proves the real fix for the ERR_CONNECTION_REFUSED bug: server_web.ts's
// exported startNagexServer() genuinely does not resolve until the real
// http.Server is actually listening — not merely until the module finished
// evaluating (the old, broken behavior desktop-app.ts relied on via a bare
// `await import('../server_web.js')`, which never even reached the
// require.main-gated listen() call at all when imported as a dependency).
//
// process.env.PORT/HOST are set BEFORE the dynamic import below so this
// test's own dedicated process (Node's test runner isolates each test
// file into its own process) binds a private, collision-free port rather
// than the real default 8085.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const TEST_PORT = 18085;
process.env.PORT = String(TEST_PORT);
process.env.HOST = '127.0.0.1';

test('EMBEDDED_GATEWAY_LISTEN_AWAITED: startNagexServer() only resolves once the real port is genuinely listening', async () => {
  const gatewayUrl = `http://127.0.0.1:${TEST_PORT}`;

  // Before calling it, the port must be genuinely unreachable — proves
  // the "already listening" branch below isn't accidentally hitting a
  // server some other process left running.
  await assert.rejects(fetch(`${gatewayUrl}/api/v1/health`));

  const { startNagexServer } = await import('../src/server_web.js');
  const { server } = await startNagexServer();

  try {
    // The instant the promise resolves, a real HTTP request must succeed —
    // no race window, no need for any sleep/retry.
    const response = await fetch(`${gatewayUrl}/api/v1/health`);
    assert.equal(response.ok, true);
  } finally {
    // Without this, the real listening http.Server keeps this test
    // file's process alive well past the assertion itself — found for
    // real while writing this test (the process took over 100s to exit
    // and the file was marked failed even though the assertion passed).
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import type { AddressInfo } from 'node:net';
import { server } from '../src/server_web.js';

async function withServer(run: (origin: string) => Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

// Same source-level verification technique as tests/gmail_ambient_wiring.test.ts
// (this repo has no jsdom harness) — scoped to what is actually wired: the
// read-only browser.open/navigate -> snapshot flow. Driving an in-page click
// from the ambient composer is documented as not yet wired (see
// browser-approval-view.js's header comment and app.js's own comment above
// runBrowserReadOnlyStep) and so is not asserted here as if it were.

function extractFunctionBody(source: string, signature: string, nextMarkerCandidates: string[]): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `expected to find "${signature}" in the served app.js`);
  let end = source.length;
  for (const marker of nextMarkerCandidates) {
    const idx = source.indexOf(marker, start + signature.length);
    if (idx > start && idx < end) end = idx;
  }
  return source.slice(start, end);
}

test('the app serves browser-approval-view.js and browser-intent-extraction.js, both no-cache', async () => {
  await withServer(async (origin) => {
    const html = await (await fetch(`${origin}/`)).text();
    assert.match(html, /src="browser-approval-view\.js\?v=/);
    assert.match(html, /src="browser-intent-extraction\.js\?v=/);
    for (const file of ['browser-approval-view.js', 'browser-intent-extraction.js']) {
      const res = await fetch(`${origin}/${file}`);
      const body = await res.text();
      assert.equal(body.length > 0, true, `expected ${file} to be served with content`);
      assert.equal(res.headers.get('cache-control'), 'no-store, no-cache, must-revalidate');
    }
  });
});

test('resolvePlanIntoUi resolves a read-only browser step (EXECUTION_READY) to the read-only runner, and UNAVAILABLE to a status message — never an approval flow', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();
    const body = extractFunctionBody(appJs, 'async function resolvePlanIntoUi(', ['\n  function renderConnectGoogleCalendarAction(']);

    assert.match(body, /BROWSER_READ_TOOL_IDS\.has\(s\.resolvedToolId\) && s\.executionReadiness === 'BLOCKED' && s\.toolAvailability === 'UNAVAILABLE'/);
    assert.match(body, /renderBrowserUnavailableAction\(actionsEl\)/);
    assert.match(body, /BROWSER_READ_TOOL_IDS\.has\(s\.resolvedToolId\) && s\.executionReadiness === 'EXECUTION_READY'/);
    assert.match(body, /runBrowserReadOnlyStep\(actionsEl, originalPromptText, planId\)/);
  });
});

test('the read-only browser flow never calls POST /api/v1/approvals and never invents a URL', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();
    const readBody = extractFunctionBody(appJs, 'async function runBrowserReadOnlyStep(', ['\n  async function executeBrowserOpenAndRead(']);
    const execBody = extractFunctionBody(appJs, 'async function executeBrowserOpenAndRead(', ['\n  // The "▶ Run" button']);

    assert.doesNotMatch(readBody, /api\/v1\/approvals/);
    assert.doesNotMatch(execBody, /api\/v1\/approvals/);

    // No literal URL in the prompt -> a required <input> is shown, never a
    // guessed destination passed straight to executeBrowserOpenAndRead.
    assert.match(readBody, /if \(!literalUrl\)/);
    assert.match(readBody, /id="browser-url-input"/);
    assert.match(readBody, /required/);

    assert.match(execBody, /\/api\/v1\/browser\/sessions/);
    assert.match(execBody, /\/api\/v1\/tools\/browser\/navigate/);
    assert.match(execBody, /\/api\/v1\/tools\/browser\/snapshot/);
  });
});

test('status lines are i18n-driven (Opening website.../Reading page...), not hardcoded English', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();
    const execBody = extractFunctionBody(appJs, 'async function executeBrowserOpenAndRead(', ['\n  // The "▶ Run" button']);
    assert.ok(execBody.includes("t('browser.openingWebsite')"));
    assert.ok(execBody.includes("t('browser.readingPage')"));
    assert.ok(execBody.includes("t('browser.openLink')"));
  });
});

test('deterministic URL extraction: only a literal http(s) URL in the prompt is ever used, never a guessed domain', async () => {
  await withServer(async (origin) => {
    const source = await (await fetch(`${origin}/browser-intent-extraction.js`)).text();
    const sandbox: Record<string, unknown> = {};
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox, { filename: 'browser-intent-extraction.js' });
    const api = (sandbox.window as Record<string, unknown>).NAGEX_BROWSER_INTENT as {
      extractBrowserIntent: (prompt: string) => { url: string | null } | null;
    };

    const withUrl = api.extractBrowserIntent('Open https://example.com/reservations and check my status.');
    assert.equal(withUrl?.url, 'https://example.com/reservations');

    const withoutUrl = api.extractBrowserIntent('Open the airline website and check my reservation status.');
    assert.ok(withoutUrl);
    assert.equal(withoutUrl!.url, null);

    assert.equal(api.extractBrowserIntent('What is the capital of France?'), null);
  });
});

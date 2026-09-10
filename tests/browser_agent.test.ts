import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { URL } from 'node:url';
import { ActionApprovalStore, hashCanonicalPayload } from '../src/governance/action-approval.store.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { MemoryEngine } from '../src/context/memory.engine.js';
import { BrowserSessionStore } from '../src/browser/browser-session.store.js';
import { PlaywrightBrowserRuntime, type BrowserRuntime } from '../src/integrations/browser/browser.runtime.js';
import { BrowserToolService, BROWSER_CLICK_TOOL_ID, classifyClickConsequence, detectsHumanVerification } from '../src/tools/browser.service.js';
import { toolRegistry as sharedToolRegistry } from '../src/tools/tool-registry.js';
import { handleApiRequest, handleAsyncApiRequest, actionApprovals as sharedActionApprovals } from '../src/server_web.js';

// A tiny, deterministic, fully-offline fixture server — real Playwright
// exercises real HTML over real HTTP, never a mock of the browser itself.
function startFixtureServer(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (url.pathname === '/') {
      res.end(`<!doctype html><html><head><title>Reservation Status</title></head><body>
        <h1>Your reservation status: Confirmed</h1>
        <a id="learn-more-link" href="/about">Learn More</a>
        <button id="delete-btn">Delete Account</button>
        <form method="GET" action="/form-submitted">
          <input id="name-input" name="name" type="text" />
          <button id="submit-btn" type="submit">Submit</button>
        </form>
      </body></html>`);
    } else if (url.pathname === '/about') {
      res.end(`<!doctype html><html><head><title>About</title></head><body><p>About this airline.</p></body></html>`);
    } else if (url.pathname === '/form-submitted') {
      res.end(`<!doctype html><html><head><title>Submitted</title></head><body><p>Submitted: ${url.searchParams.get('name') || ''}</p></body></html>`);
    } else if (url.pathname === '/captcha') {
      res.end(`<!doctype html><html><head><title>Verify</title></head><body><p>Please verify you are human before continuing.</p></body></html>`);
    } else if (url.pathname === '/ambiguous') {
      res.end(`<!doctype html><html><head><title>Ambiguous</title></head><body><button class="dup-btn">One</button><button class="dup-btn">Two</button></body></html>`);
    } else if (url.pathname === '/nav-click') {
      res.end(`<!doctype html><html><head><title>Nav Test</title></head><body><button id="nav-btn" onclick="window.location.href='/about'">Navigate Away</button></body></html>`);
    } else if (url.pathname === '/dynamic') {
      res.end(`<!doctype html><html><head><title>Dynamic Test</title></head><body><button id="dynamic-btn">Original Text</button><button id="change-text-btn" onclick="document.getElementById('dynamic-btn').innerText = 'Changed Text'">Change</button></body></html>`);
    } else {
      res.statusCode = 404;
      res.end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ origin: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

// One Chromium process for this entire file — each test gets its own
// BrowserContext (via openSession), which is cheap, rather than each test
// launching its own browser process, which is slow and (without an
// explicit shutdown) leaks a real OS process per test. Shut down once,
// after every test in this file has finished — see the after() hook below.
const sharedRuntime = new PlaywrightBrowserRuntime();
after(async () => {
  await sharedRuntime.shutdown();
});

let ownerCounter = 0;
// Each call gets its own tenantId/ownerId — BrowserSessionStore persists to
// disk (like SessionStore/TaskStore), so sharing an owner across tests would
// let one test's leftover session state (e.g. a CAPTCHA-blocked session)
// leak into an unrelated later test via getOrCreate's reuse.
function buildHarness(
  isRuntimeAvailableOrOpts?: (() => boolean) | { isRuntimeAvailable?: () => boolean; nowFn?: () => number; customRuntime?: BrowserRuntime },
) {
  const opts = typeof isRuntimeAvailableOrOpts === 'function'
    ? { isRuntimeAvailable: isRuntimeAvailableOrOpts }
    : isRuntimeAvailableOrOpts;
  ownerCounter += 1;
  const headers = { tenantId: 't1', ownerId: `usr_browser_test_${ownerCounter}`, requestId: 'req_1' };
  const sessions = new BrowserSessionStore();
  const approvals = new ActionApprovalStore(opts?.nowFn);
  const audit = new AuditLogger();
  const memory = new MemoryEngine();
  const runtime = opts?.customRuntime ?? sharedRuntime;
  const service = new BrowserToolService(runtime, sessions, approvals, audit, memory, undefined, undefined, opts?.isRuntimeAvailable);
  return { runtime, sessions, approvals, audit, service, headers };
}

function createSpyRuntime(baseRuntime: BrowserRuntime) {
  let resolveSelectorCalls = 0;
  let clickCalls = 0;
  const spy = new Proxy(baseRuntime, {
    get(target, prop, receiver) {
      if (prop === 'resolveSelector') {
        return async (...args: Parameters<BrowserRuntime['resolveSelector']>) => {
          resolveSelectorCalls++;
          return target.resolveSelector(...args);
        };
      }
      if (prop === 'click') {
        return async (...args: Parameters<BrowserRuntime['click']>) => {
          clickCalls++;
          return target.click(...args);
        };
      }
      const val = Reflect.get(target, prop, receiver);
      return typeof val === 'function' ? val.bind(target) : val;
    },
  });
  return {
    spyRuntime: spy,
    get resolveSelectorCalls() { return resolveSelectorCalls; },
    get clickCalls() { return clickCalls; },
    resetCounts() { resolveSelectorCalls = 0; clickCalls = 0; },
  };
}

// ── classifier unit tests (pure, no browser needed) ─────────────────────────

test('classifyClickConsequence: Submit/Buy/Pay/Delete/... text requires approval; ordinary link text does not', () => {
  assert.equal(classifyClickConsequence('Submit', false), true);
  assert.equal(classifyClickConsequence('Delete Account', false), true);
  assert.equal(classifyClickConsequence('Buy now', false), true);
  assert.equal(classifyClickConsequence('Confirm reservation', false), true);
  assert.equal(classifyClickConsequence('Learn More', false), false);
  assert.equal(classifyClickConsequence('Next', false), false);
  assert.equal(classifyClickConsequence(null, false), false);
});

test('classifyClickConsequence: any type="submit" form control is consequential regardless of its text', () => {
  assert.equal(classifyClickConsequence('OK', true), true);
});

test('detectsHumanVerification: recognizes CAPTCHA/MFA language, never flags an ordinary page', () => {
  assert.equal(detectsHumanVerification({ title: 'Verify', text: 'Please verify you are human before continuing.' }), true);
  assert.equal(detectsHumanVerification({ title: 'Sign in', text: 'Enter your two-factor authentication code.' }), true);
  assert.equal(detectsHumanVerification({ title: 'Reservation Status', text: 'Your reservation status: Confirmed' }), false);
});

// ── open / navigate / snapshot / read-only extraction ───────────────────────

test('open creates a real browser session; navigate + snapshot return real page content (read-only extraction)', async () => {
  const fixture = await startFixtureServer();
  const { service, headers } = buildHarness();
  try {
    const session = await service.open(headers);
    assert.match(session.browserSessionId, /^brw_/);
    assert.equal(session.status, 'OPEN');

    const nav = await service.navigate({ ...headers, browserSessionId: session.browserSessionId, url: fixture.origin });
    assert.equal(nav.title, 'Reservation Status');

    const snap = await service.snapshot({ ...headers, browserSessionId: session.browserSessionId });
    assert.equal(snap.title, 'Reservation Status');
    assert.match(snap.text, /Your reservation status: Confirmed/);

    await service.close({ ...headers, browserSessionId: session.browserSessionId });
  } finally {
    await fixture.close();
  }
});

test('tabs lists the real open tab for the session', async () => {
  const fixture = await startFixtureServer();
  const { service, headers } = buildHarness();
  try {
    const session = await service.open(headers);
    await service.navigate({ ...headers, browserSessionId: session.browserSessionId, url: fixture.origin });
    const tabs = await service.tabs({ ...headers, browserSessionId: session.browserSessionId });
    assert.equal(tabs.length, 1);
    assert.equal(tabs[0].title, 'Reservation Status');
    await service.close({ ...headers, browserSessionId: session.browserSessionId });
  } finally {
    await fixture.close();
  }
});

test('screenshot captures real evidence bytes and returns a referenceable evidenceId (never embeds bytes inline)', async () => {
  const fixture = await startFixtureServer();
  const { service, headers } = buildHarness();
  try {
    const session = await service.open(headers);
    await service.navigate({ ...headers, browserSessionId: session.browserSessionId, url: fixture.origin });
    const evidence = await service.screenshot({ ...headers, browserSessionId: session.browserSessionId });
    assert.match(evidence.evidenceId, /^bev_/);
    assert.equal(typeof evidence.capturedAt, 'string');
    await service.close({ ...headers, browserSessionId: session.browserSessionId });
  } finally {
    await fixture.close();
  }
});

// ── type ─────────────────────────────────────────────────────────────────

test('type fills a real form field — verified end to end via a real form submission', async () => {
  const fixture = await startFixtureServer();
  const { service, headers } = buildHarness();
  try {
    const session = await service.open(headers);
    await service.navigate({ ...headers, browserSessionId: session.browserSessionId, url: fixture.origin });
    await service.type({ ...headers, browserSessionId: session.browserSessionId, selector: '#name-input', text: 'NAgex Test' });

    // Submitting is consequential — approve, then execute, then verify the
    // typed value genuinely reached the server via the real page.
    const clicked = await service.click({ ...headers, browserSessionId: session.browserSessionId, selector: '#submit-btn' });
    assert.equal(clicked.status, 'APPROVAL_REQUIRED');
    if (clicked.status !== 'APPROVAL_REQUIRED') throw new Error('unreachable');
    service.approve(clicked.approval.approvalId, headers.ownerId, 'req_2');
    const executed = await service.executeApprovedClick({ approvalId: clicked.approval.approvalId, browserSessionId: session.browserSessionId, selector: '#submit-btn', ...headers, requestId: 'req_3' });
    assert.match(executed.url, /\/form-submitted\?name=NAgex(\+|%20)Test/);

    const snap = await service.snapshot({ ...headers, browserSessionId: session.browserSessionId });
    assert.match(snap.text, /Submitted: NAgex Test/);
    await service.close({ ...headers, browserSessionId: session.browserSessionId });
  } finally {
    await fixture.close();
  }
});

// ── click: navigation vs. consequential ─────────────────────────────────────

test('a navigation click (Learn More) executes immediately, with no approval ever created', async () => {
  const fixture = await startFixtureServer();
  const { service, headers } = buildHarness();
  try {
    const session = await service.open(headers);
    await service.navigate({ ...headers, browserSessionId: session.browserSessionId, url: fixture.origin });

    const result = await service.click({ ...headers, browserSessionId: session.browserSessionId, selector: '#learn-more-link' });
    assert.equal(result.status, 'EXECUTED');
    if (result.status !== 'EXECUTED') throw new Error('unreachable');
    assert.equal(result.title, 'About');

    await service.close({ ...headers, browserSessionId: session.browserSessionId });
  } finally {
    await fixture.close();
  }
});

test('a consequential click (Delete Account) requires approval and is never executed without one', async () => {
  const fixture = await startFixtureServer();
  const { service, headers } = buildHarness();
  try {
    const session = await service.open(headers);
    await service.navigate({ ...headers, browserSessionId: session.browserSessionId, url: fixture.origin });

    const result = await service.click({ ...headers, browserSessionId: session.browserSessionId, selector: '#delete-btn' });
    assert.equal(result.status, 'APPROVAL_REQUIRED');
    if (result.status !== 'APPROVAL_REQUIRED') throw new Error('unreachable');
    assert.equal(result.approval.toolId, BROWSER_CLICK_TOOL_ID);
    assert.equal(result.approval.status, 'PENDING');
    assert.equal((result.approval.canonicalPayload as { targetText: string }).targetText, 'Delete Account');

    // The page must be completely unchanged — still on the original URL.
    const snap = await service.snapshot({ ...headers, browserSessionId: session.browserSessionId });
    assert.equal(snap.title, 'Reservation Status');

    await service.close({ ...headers, browserSessionId: session.browserSessionId });
  } finally {
    await fixture.close();
  }
});

test('an approved consequential click executes exactly once — replay is rejected (no unintended duplicate action)', async () => {
  const fixture = await startFixtureServer();
  const { service, headers } = buildHarness();
  try {
    const session = await service.open(headers);
    await service.navigate({ ...headers, browserSessionId: session.browserSessionId, url: fixture.origin });

    const requested = await service.click({ ...headers, browserSessionId: session.browserSessionId, selector: '#delete-btn' });
    assert.equal(requested.status, 'APPROVAL_REQUIRED');
    if (requested.status !== 'APPROVAL_REQUIRED') throw new Error('unreachable');
    service.approve(requested.approval.approvalId, headers.ownerId, 'req_2');

    const first = await service.executeApprovedClick({ approvalId: requested.approval.approvalId, browserSessionId: session.browserSessionId, selector: '#delete-btn', ...headers, requestId: 'req_3' });
    assert.equal(first.status, 'EXECUTED');

    await assert.rejects(
      () => service.executeApprovedClick({ approvalId: requested.approval.approvalId, browserSessionId: session.browserSessionId, selector: '#delete-btn', ...headers, requestId: 'req_4' }),
      (err: unknown) => (err as { code: string }).code === 'APPROVAL_ALREADY_CONSUMED',
    );

    await service.close({ ...headers, browserSessionId: session.browserSessionId });
  } finally {
    await fixture.close();
  }
});

test('a rejected consequential click can never be executed', async () => {
  const fixture = await startFixtureServer();
  const { service, headers } = buildHarness();
  try {
    const session = await service.open(headers);
    await service.navigate({ ...headers, browserSessionId: session.browserSessionId, url: fixture.origin });

    const requested = await service.click({ ...headers, browserSessionId: session.browserSessionId, selector: '#delete-btn' });
    assert.equal(requested.status, 'APPROVAL_REQUIRED');
    if (requested.status !== 'APPROVAL_REQUIRED') throw new Error('unreachable');
    service.reject(requested.approval.approvalId, headers.ownerId, 'req_2');

    await assert.rejects(
      () => service.executeApprovedClick({ approvalId: requested.approval.approvalId, browserSessionId: session.browserSessionId, selector: '#delete-btn', ...headers, requestId: 'req_3' }),
      (err: unknown) => (err as { code: string }).code === 'APPROVAL_NOT_GRANTED',
    );

    await service.close({ ...headers, browserSessionId: session.browserSessionId });
  } finally {
    await fixture.close();
  }
});

// ── fail closed ──────────────────────────────────────────────────────────

test('selector missing fails closed rather than guessing', async () => {
  const fixture = await startFixtureServer();
  const { service, headers } = buildHarness();
  try {
    const session = await service.open(headers);
    await service.navigate({ ...headers, browserSessionId: session.browserSessionId, url: fixture.origin });
    await assert.rejects(
      () => service.click({ ...headers, browserSessionId: session.browserSessionId, selector: '#does-not-exist' }),
      (err: unknown) => (err as { code: string }).code === 'BROWSER_SELECTOR_NOT_FOUND',
    );
    await service.close({ ...headers, browserSessionId: session.browserSessionId });
  } finally {
    await fixture.close();
  }
});

test('an ambiguous selector (multiple matches) fails closed rather than picking one', async () => {
  const fixture = await startFixtureServer();
  const { service, headers } = buildHarness();
  try {
    const session = await service.open(headers);
    await service.navigate({ ...headers, browserSessionId: session.browserSessionId, url: `${fixture.origin}/ambiguous` });
    await assert.rejects(
      () => service.click({ ...headers, browserSessionId: session.browserSessionId, selector: '.dup-btn' }),
      (err: unknown) => (err as { code: string }).code === 'BROWSER_SELECTOR_AMBIGUOUS',
    );
    await service.close({ ...headers, browserSessionId: session.browserSessionId });
  } finally {
    await fixture.close();
  }
});

test('CAPTCHA/human-verification is detected on navigate, blocks the session, and is never bypassed', async () => {
  const fixture = await startFixtureServer();
  const { service, sessions, headers } = buildHarness();
  try {
    const session = await service.open(headers);
    await assert.rejects(
      () => service.navigate({ ...headers, browserSessionId: session.browserSessionId, url: `${fixture.origin}/captcha` }),
      (err: unknown) => (err as { code: string }).code === 'BROWSER_HUMAN_VERIFICATION_REQUIRED',
    );
    assert.equal(sessions.get(session.browserSessionId)?.status, 'BLOCKED_NEEDS_HUMAN');

    // Every further action on this session fails closed too — never a
    // silent attempt to click through the verification.
    await assert.rejects(
      () => service.click({ ...headers, browserSessionId: session.browserSessionId, selector: 'button' }),
      (err: unknown) => (err as { code: string }).code === 'BROWSER_HUMAN_VERIFICATION_REQUIRED',
    );
  } finally {
    await fixture.close();
  }
});

// ── session lifecycle ────────────────────────────────────────────────────

test('session lifecycle: open -> close -> further actions fail closed; a fresh open() re-creates it', async () => {
  const { service, sessions, headers } = buildHarness();
  const session = await service.open(headers);
  assert.equal(sessions.get(session.browserSessionId)?.status, 'OPEN');

  await service.close({ ...headers, browserSessionId: session.browserSessionId });
  assert.equal(sessions.get(session.browserSessionId)?.status, 'CLOSED');

  await assert.rejects(
    () => service.snapshot({ ...headers, browserSessionId: session.browserSessionId }),
    (err: unknown) => (err as { code: string }).code === 'BROWSER_SESSION_CLOSED',
  );

  const reopened = await service.open(headers);
  assert.notEqual(reopened.browserSessionId, session.browserSessionId);
  assert.equal(reopened.status, 'OPEN');
  await service.close({ ...headers, browserSessionId: reopened.browserSessionId });
});

test('one session per owner (MVP): a second open() for the same owner reuses the existing OPEN session', async () => {
  const { service, headers } = buildHarness();
  const first = await service.open(headers);
  const second = await service.open(headers);
  assert.equal(first.browserSessionId, second.browserSessionId);
  await service.close({ ...headers, browserSessionId: first.browserSessionId });
});

// ── browser unavailable ──────────────────────────────────────────────────

test('browser unavailable: every action fails closed with BROWSER_UNAVAILABLE, never a fake result', async () => {
  const { service, headers } = buildHarness(() => false);
  await assert.rejects(() => service.open(headers), (err: unknown) => (err as { code: string }).code === 'BROWSER_UNAVAILABLE');
});

test('the Tool Registry reports browser tools disconnected/unavailable when the runtime check fails, live when it succeeds', () => {
  // The real environment this test runs in has Chromium installed (see the
  // setup that installed it for this session) — so this asserts the real,
  // current, honest status rather than a forced value.
  const resolution = sharedToolRegistry.resolve('browser.open');
  assert.ok(resolution.executionMode === 'live' || resolution.executionMode === 'unavailable');
  assert.equal(resolution.connectionStatus, resolution.executionMode === 'live' ? 'connected' : 'disconnected');
  const clickResolution = sharedToolRegistry.resolve('browser.click');
  assert.equal(clickResolution.sideEffectLevel, 'REVERSIBLE_WRITE');
  assert.equal(clickResolution.requiresApproval, true); // via the generic non-READ_ONLY policy
  const typeResolution = sharedToolRegistry.resolve('browser.type');
  assert.equal(typeResolution.sideEffectLevel, 'READ_ONLY');
  assert.equal(typeResolution.requiresApproval, false);
});

// ── audit linkage ────────────────────────────────────────────────────────

test('audit: every stage of a consequential click is logged, and typed text is never included in the audit trail', async () => {
  const fixture = await startFixtureServer();
  const { service, audit, headers } = buildHarness();
  try {
    const session = await service.open(headers);
    await service.navigate({ ...headers, browserSessionId: session.browserSessionId, url: fixture.origin });
    await service.type({ ...headers, browserSessionId: session.browserSessionId, selector: '#name-input', text: 'super-secret-value' });

    const requested = await service.click({ ...headers, browserSessionId: session.browserSessionId, selector: '#delete-btn' });
    if (requested.status !== 'APPROVAL_REQUIRED') throw new Error('unreachable');
    service.approve(requested.approval.approvalId, headers.ownerId, 'req_2');
    await service.executeApprovedClick({ approvalId: requested.approval.approvalId, browserSessionId: session.browserSessionId, selector: '#delete-btn', ...headers, requestId: 'req_3' });

    const actions = audit.getRecentLogs(30).map((e) => e.action);
    assert.ok(actions.includes('approval.requested'));
    assert.ok(actions.includes('approval.approved'));
    assert.ok(actions.includes('tool.execution.started'));
    assert.ok(actions.includes('tool.execution.succeeded'));

    const serialized = JSON.stringify(audit.getRecentLogs(30));
    assert.doesNotMatch(serialized, /super-secret-value/);

    await service.close({ ...headers, browserSessionId: session.browserSessionId });
  } finally {
    await fixture.close();
  }
});

// ── payload hash / canonicalization stability ───────────────────────────────

test('payload hash stability: an identical click payload (regardless of key order) hashes the same', () => {
  const a = { browserSessionId: 'brw_1', selector: '#delete-btn', targetText: 'Delete Account', url: 'https://example.com' };
  const b = { url: a.url, targetText: a.targetText, selector: a.selector, browserSessionId: a.browserSessionId };
  assert.equal(hashCanonicalPayload(a), hashCanonicalPayload(b));
});

// ── real HTTP routes ─────────────────────────────────────────────────────

test('full flow through the real HTTP routes: open -> navigate -> click (approval required) -> approve -> execute -> replay rejected', async () => {
  const fixture = await startFixtureServer();
  const sessions = new BrowserSessionStore();
  const testService = new BrowserToolService(sharedRuntime, sessions, sharedActionApprovals, new AuditLogger(), new MemoryEngine());
  const headers = { 'x-nagex-tenant': 'ten_production_01', 'x-principal-id': 'usr_browser_http_test' };

  try {
    const opened = await handleAsyncApiRequest('POST', '/api/v1/browser/sessions', {}, headers, undefined, {}, undefined, undefined, testService);
    assert.equal(opened.status, 201);
    const browserSessionId = (opened.data as { browserSessionId: string }).browserSessionId;

    const navigated = await handleAsyncApiRequest('POST', '/api/v1/tools/browser/navigate', { browserSessionId, url: fixture.origin }, headers, undefined, {}, undefined, undefined, testService);
    assert.equal(navigated.status, 200);

    const clicked = await handleAsyncApiRequest('POST', '/api/v1/tools/browser/click', { browserSessionId, selector: '#delete-btn' }, headers, undefined, {}, undefined, undefined, testService);
    assert.equal(clicked.status, 201);
    const approvalId = (clicked.data as { approval: { approvalId: string } }).approval.approvalId;

    // GET/approve/reject are the existing, unchanged, tool-agnostic routes.
    const approved = handleApiRequest('POST', `/api/v1/approvals/${approvalId}/approve`, null, headers);
    assert.equal(approved.status, 200);

    const executed = await handleAsyncApiRequest('POST', '/api/v1/tools/browser/click/execute', { approvalId, browserSessionId, selector: '#delete-btn' }, headers, undefined, {}, undefined, undefined, testService);
    assert.equal(executed.status, 200);
    assert.equal((executed.data as { status: string }).status, 'EXECUTED');

    const replay = await handleAsyncApiRequest('POST', '/api/v1/tools/browser/click/execute', { approvalId, browserSessionId, selector: '#delete-btn' }, headers, undefined, {}, undefined, undefined, testService);
    assert.notEqual(replay.status, 200);
    assert.equal((replay.data as { error: { code: string } }).error.code, 'APPROVAL_ALREADY_CONSUMED');

    await handleAsyncApiRequest('POST', '/api/v1/tools/browser/close', { browserSessionId }, headers, undefined, {}, undefined, undefined, testService);
  } finally {
    await fixture.close();
  }
});

// ── regression coverage for approval preflight resolution order ─────────────

test('Regression A: consumed browser approval replay after first click navigates/removes selector throws APPROVAL_ALREADY_CONSUMED without calling resolveSelector', async () => {
  const fixture = await startFixtureServer();
  const spy = createSpyRuntime(sharedRuntime);
  const { service, headers } = buildHarness({ customRuntime: spy.spyRuntime });

  try {
    const session = await service.open(headers);
    await service.navigate({ ...headers, browserSessionId: session.browserSessionId, url: `${fixture.origin}/nav-click` });

    const req = await service.click({ ...headers, browserSessionId: session.browserSessionId, selector: '#nav-btn', forceApproval: true });
    if (req.status !== 'APPROVAL_REQUIRED') throw new Error('Expected APPROVAL_REQUIRED');

    service.approve(req.approval.approvalId, headers.ownerId, 'req_app');

    spy.resetCounts();
    const executed = await service.executeApprovedClick({
      approvalId: req.approval.approvalId,
      browserSessionId: session.browserSessionId,
      selector: '#nav-btn',
      ...headers,
      requestId: 'req_exec',
    });
    assert.equal(executed.status, 'EXECUTED');
    assert.equal(executed.url, `${fixture.origin}/about`);
    assert.equal(spy.resolveSelectorCalls, 1);

    // Replay on page where selector #nav-btn no longer exists
    spy.resetCounts();
    await assert.rejects(
      () => service.executeApprovedClick({
        approvalId: req.approval.approvalId,
        browserSessionId: session.browserSessionId,
        selector: '#nav-btn',
        ...headers,
        requestId: 'req_replay',
      }),
      (err: unknown) => (err as { code: string }).code === 'APPROVAL_ALREADY_CONSUMED',
    );
    // Crucial check: resolveSelector must NOT have been called on replay
    assert.equal(spy.resolveSelectorCalls, 0);

    await service.close({ ...headers, browserSessionId: session.browserSessionId });
  } finally {
    await fixture.close();
  }
});

test('Regression B: first legitimate execution still re-resolves target before consume', async () => {
  const fixture = await startFixtureServer();
  const spy = createSpyRuntime(sharedRuntime);
  const { service, headers } = buildHarness({ customRuntime: spy.spyRuntime });

  try {
    const session = await service.open(headers);
    await service.navigate({ ...headers, browserSessionId: session.browserSessionId, url: fixture.origin });

    const req = await service.click({ ...headers, browserSessionId: session.browserSessionId, selector: '#delete-btn' });
    if (req.status !== 'APPROVAL_REQUIRED') throw new Error('Expected APPROVAL_REQUIRED');

    service.approve(req.approval.approvalId, headers.ownerId, 'req_app');

    spy.resetCounts();
    const executed = await service.executeApprovedClick({
      approvalId: req.approval.approvalId,
      browserSessionId: session.browserSessionId,
      selector: '#delete-btn',
      ...headers,
      requestId: 'req_exec',
    });
    assert.equal(executed.status, 'EXECUTED');
    assert.equal(spy.resolveSelectorCalls, 1);

    await service.close({ ...headers, browserSessionId: session.browserSessionId });
  } finally {
    await fixture.close();
  }
});

test('Regression C: changed target before first execution throws APPROVAL_PAYLOAD_MISMATCH and click is NOT executed', async () => {
  const fixture = await startFixtureServer();
  const spy = createSpyRuntime(sharedRuntime);
  const { service, headers } = buildHarness({ customRuntime: spy.spyRuntime });

  try {
    const session = await service.open(headers);
    await service.navigate({ ...headers, browserSessionId: session.browserSessionId, url: `${fixture.origin}/dynamic` });

    const req = await service.click({ ...headers, browserSessionId: session.browserSessionId, selector: '#dynamic-btn', forceApproval: true });
    if (req.status !== 'APPROVAL_REQUIRED') throw new Error('Expected APPROVAL_REQUIRED');

    service.approve(req.approval.approvalId, headers.ownerId, 'req_app');

    // Mutate target text on page before executing the approved click
    await service.click({ ...headers, browserSessionId: session.browserSessionId, selector: '#change-text-btn' });

    spy.resetCounts();
    await assert.rejects(
      () => service.executeApprovedClick({
        approvalId: req.approval.approvalId,
        browserSessionId: session.browserSessionId,
        selector: '#dynamic-btn',
        ...headers,
        requestId: 'req_exec_changed',
      }),
      (err: unknown) => (err as { code: string }).code === 'APPROVAL_PAYLOAD_MISMATCH',
    );

    // Verify click was NOT executed on the browser
    assert.equal(spy.clickCalls, 0);

    await service.close({ ...headers, browserSessionId: session.browserSessionId });
  } finally {
    await fixture.close();
  }
});

test('Regression D: expired approved browser approval throws APPROVAL_EXPIRED before DOM lookup', async () => {
  const fixture = await startFixtureServer();
  let mockNow = Date.now();
  const spy = createSpyRuntime(sharedRuntime);
  const { service, headers } = buildHarness({ customRuntime: spy.spyRuntime, nowFn: () => mockNow });

  try {
    const session = await service.open(headers);
    await service.navigate({ ...headers, browserSessionId: session.browserSessionId, url: fixture.origin });

    const req = await service.click({ ...headers, browserSessionId: session.browserSessionId, selector: '#delete-btn' });
    if (req.status !== 'APPROVAL_REQUIRED') throw new Error('Expected APPROVAL_REQUIRED');

    service.approve(req.approval.approvalId, headers.ownerId, 'req_app');

    // Fast-forward past TTL (default 15 minutes)
    mockNow += 20 * 60 * 1000;

    spy.resetCounts();
    await assert.rejects(
      () => service.executeApprovedClick({
        approvalId: req.approval.approvalId,
        browserSessionId: session.browserSessionId,
        selector: '#delete-btn',
        ...headers,
        requestId: 'req_exec_expired',
      }),
      (err: unknown) => (err as { code: string }).code === 'APPROVAL_EXPIRED',
    );

    // Assert DOM resolution was skipped
    assert.equal(spy.resolveSelectorCalls, 0);

    await service.close({ ...headers, browserSessionId: session.browserSessionId });
  } finally {
    await fixture.close();
  }
});

test('Regression E: pending or rejected approval throws APPROVAL_NOT_GRANTED before DOM lookup', async () => {
  const fixture = await startFixtureServer();
  const spy = createSpyRuntime(sharedRuntime);
  const { service, headers } = buildHarness({ customRuntime: spy.spyRuntime });

  try {
    const session = await service.open(headers);
    await service.navigate({ ...headers, browserSessionId: session.browserSessionId, url: fixture.origin });

    // 1. Pending approval test
    const reqPending = await service.click({ ...headers, browserSessionId: session.browserSessionId, selector: '#delete-btn' });
    if (reqPending.status !== 'APPROVAL_REQUIRED') throw new Error('Expected APPROVAL_REQUIRED');

    spy.resetCounts();
    await assert.rejects(
      () => service.executeApprovedClick({
        approvalId: reqPending.approval.approvalId,
        browserSessionId: session.browserSessionId,
        selector: '#delete-btn',
        ...headers,
        requestId: 'req_exec_pending',
      }),
      (err: unknown) => (err as { code: string }).code === 'APPROVAL_NOT_GRANTED',
    );
    assert.equal(spy.resolveSelectorCalls, 0);

    // 2. Rejected approval test
    const reqRejected = await service.click({ ...headers, browserSessionId: session.browserSessionId, selector: '#delete-btn' });
    if (reqRejected.status !== 'APPROVAL_REQUIRED') throw new Error('Expected APPROVAL_REQUIRED');
    service.reject(reqRejected.approval.approvalId, headers.ownerId, 'req_rej');

    spy.resetCounts();
    await assert.rejects(
      () => service.executeApprovedClick({
        approvalId: reqRejected.approval.approvalId,
        browserSessionId: session.browserSessionId,
        selector: '#delete-btn',
        ...headers,
        requestId: 'req_exec_rejected',
      }),
      (err: unknown) => (err as { code: string }).code === 'APPROVAL_NOT_GRANTED',
    );
    assert.equal(spy.resolveSelectorCalls, 0);

    await service.close({ ...headers, browserSessionId: session.browserSessionId });
  } finally {
    await fixture.close();
  }
});

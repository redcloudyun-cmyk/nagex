// DC0 — Browser Session Ownership Isolation Correction.
//
// BrowserSessionStore.getOrCreate(tenantId, ownerId) was already correctly
// scoped, but BrowserSessionStore.get(browserSessionId) — and every action
// in BrowserToolService that resolved a session through it via
// requireSession(browserSessionId, requestId) — took no tenantId/ownerId at
// all, meaning cross-tenant/cross-owner access was blocked only by session-
// ID secrecy (a 64-bit random id), never a code-level ownership check.
// Fixed by adding a centralized BrowserSessionStore.getOwned(id, tenantId,
// ownerId) (mismatch -> undefined, identical to a nonexistent id — same
// requireOwned() contract already used by Task/Approval/Memory/Workflow/
// Capture) and threading it through requireSession() and every action's
// existing, already-in-scope input.tenantId/input.ownerId.
//
// Two additional gaps found and fixed during implementation, beyond what
// the Preflight named: close() deliberately bypasses requireSession()'s
// status-gating (by design, to remain a safe idempotent teardown even on a
// BLOCKED_NEEDS_HUMAN or already-CLOSED session) but had NO ownership
// check of any kind; clearProfile() had no session lookup or ownership
// check at all. Both are covered here too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserToolService } from '../src/modules/browser/browser.service.js';
import { PlaywrightBrowserRuntime } from '../src/modules/browser/browser.runtime.js';
import { BrowserSessionStore } from '../src/modules/browser/browser-session.store.js';
import { ActionApprovalStore } from '../src/governance/action-approval.store.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { MemoryEngine } from '../src/context/memory.engine.js';
import { NagexError } from '../src/common/errors.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-browser-ownership-test-'));
}

function createTestServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.writeHead(200);
      res.end(`
        <html>
          <head><title>DC0 Ownership Test Page</title></head>
          <body>
            <h1>DC0 Ownership Test Page</h1>
            <a href="#" id="nav-link">Read Terms</a>
            <input type="text" id="name-input" name="name" value="" placeholder="Your name">
          </body>
        </html>
      `);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      resolve({ baseUrl: `http://127.0.0.1:${address.port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

async function buildHarness() {
  const dir = tempDir();
  const runtime = new PlaywrightBrowserRuntime(false, path.join(dir, 'profiles'));
  const sessions = new BrowserSessionStore({ dir: path.join(dir, 'sessions') });
  const approvals = new ActionApprovalStore();
  const audit = new AuditLogger();
  const memory = new MemoryEngine();
  const service = new BrowserToolService(runtime, sessions, approvals, audit, memory);
  return { runtime, sessions, service };
}

const TENANT_A = 'ten_dc0_a';
const TENANT_B = 'ten_dc0_b';
const OWNER_X = 'usr_dc0_x';
const OWNER_Y = 'usr_dc0_y';

async function assertNotFound(promise: Promise<unknown>, label: string): Promise<void> {
  await assert.rejects(
    promise,
    (err: unknown) => {
      assert.ok(err instanceof NagexError, `${label}: expected a NagexError`);
      assert.equal((err as NagexError).code, 'BROWSER_SESSION_NOT_FOUND', `${label}: expected BROWSER_SESSION_NOT_FOUND`);
      return true;
    },
  );
}

// ── 1-2: store-level get isolation ───────────────────────────────────────

test('CROSS_TENANT_BROWSER_SESSION_GET_BLOCK: getOwned returns undefined for the wrong tenant, identical to a nonexistent id', async () => {
  const { runtime, sessions } = await buildHarness();
  try {
    const record = sessions.getOrCreate(TENANT_A, OWNER_X);
    assert.equal(sessions.getOwned(record.browserSessionId, TENANT_B, OWNER_X), undefined);
    assert.equal(sessions.getOwned('brw_does_not_exist', TENANT_A, OWNER_X), sessions.getOwned(record.browserSessionId, TENANT_B, OWNER_X));
  } finally {
    await runtime.shutdown();
  }
});

test('CROSS_OWNER_BROWSER_SESSION_GET_BLOCK: getOwned returns undefined for the wrong owner (same tenant)', async () => {
  const { runtime, sessions } = await buildHarness();
  try {
    const record = sessions.getOrCreate(TENANT_A, OWNER_X);
    assert.equal(sessions.getOwned(record.browserSessionId, TENANT_A, OWNER_Y), undefined);
  } finally {
    await runtime.shutdown();
  }
});

// ── 3-8: real BrowserToolService action isolation ────────────────────────

test('CROSS_TENANT_BROWSER_NAVIGATE_BLOCK / CROSS_OWNER_BROWSER_NAVIGATE_BLOCK', async () => {
  const testServer = await createTestServer();
  const { runtime, service } = await buildHarness();
  try {
    const session = await service.open({ tenantId: TENANT_A, ownerId: OWNER_X, requestId: 'req_open' });
    await service.navigate({ tenantId: TENANT_A, ownerId: OWNER_X, requestId: 'req_nav_rightful', browserSessionId: session.browserSessionId, url: testServer.baseUrl });

    await assertNotFound(
      service.navigate({ tenantId: TENANT_B, ownerId: OWNER_X, requestId: 'req_nav_ct', browserSessionId: session.browserSessionId, url: testServer.baseUrl }),
      'CROSS_TENANT_BROWSER_NAVIGATE_BLOCK',
    );
    await assertNotFound(
      service.navigate({ tenantId: TENANT_A, ownerId: OWNER_Y, requestId: 'req_nav_co', browserSessionId: session.browserSessionId, url: testServer.baseUrl }),
      'CROSS_OWNER_BROWSER_NAVIGATE_BLOCK',
    );
  } finally {
    await runtime.shutdown();
    await testServer.close();
  }
});

test('CROSS_TENANT_BROWSER_CLICK_BLOCK / CROSS_OWNER_BROWSER_CLICK_BLOCK', async () => {
  const testServer = await createTestServer();
  const { runtime, service } = await buildHarness();
  try {
    const session = await service.open({ tenantId: TENANT_A, ownerId: OWNER_X, requestId: 'req_open' });
    await service.navigate({ tenantId: TENANT_A, ownerId: OWNER_X, requestId: 'req_nav', browserSessionId: session.browserSessionId, url: testServer.baseUrl });

    await assertNotFound(
      service.click({ tenantId: TENANT_B, ownerId: OWNER_X, requestId: 'req_click_ct', browserSessionId: session.browserSessionId, selector: '#nav-link' }),
      'CROSS_TENANT_BROWSER_CLICK_BLOCK',
    );
    await assertNotFound(
      service.click({ tenantId: TENANT_A, ownerId: OWNER_Y, requestId: 'req_click_co', browserSessionId: session.browserSessionId, selector: '#nav-link' }),
      'CROSS_OWNER_BROWSER_CLICK_BLOCK',
    );

    // Rightful owner's click must still work after both blocked attempts.
    const rightfulClick = await service.click({ tenantId: TENANT_A, ownerId: OWNER_X, requestId: 'req_click_rightful', browserSessionId: session.browserSessionId, selector: '#nav-link' });
    assert.equal(rightfulClick.status, 'EXECUTED');
  } finally {
    await runtime.shutdown();
    await testServer.close();
  }
});

test('CROSS_TENANT_BROWSER_TYPE_BLOCK / CROSS_OWNER_BROWSER_TYPE_BLOCK', async () => {
  const testServer = await createTestServer();
  const { runtime, service } = await buildHarness();
  try {
    const session = await service.open({ tenantId: TENANT_A, ownerId: OWNER_X, requestId: 'req_open' });
    await service.navigate({ tenantId: TENANT_A, ownerId: OWNER_X, requestId: 'req_nav', browserSessionId: session.browserSessionId, url: testServer.baseUrl });

    await assertNotFound(
      service.type({ tenantId: TENANT_B, ownerId: OWNER_X, requestId: 'req_type_ct', browserSessionId: session.browserSessionId, selector: '#name-input', text: 'cross-tenant-attempt' }),
      'CROSS_TENANT_BROWSER_TYPE_BLOCK',
    );
    await assertNotFound(
      service.type({ tenantId: TENANT_A, ownerId: OWNER_Y, requestId: 'req_type_co', browserSessionId: session.browserSessionId, selector: '#name-input', text: 'cross-owner-attempt' }),
      'CROSS_OWNER_BROWSER_TYPE_BLOCK',
    );

    // The field must still be empty — a blocked type() must never reach the page.
    const snapshotAfterBlocked = await service.structuredSnapshot({ tenantId: TENANT_A, ownerId: OWNER_X, requestId: 'req_snap', browserSessionId: session.browserSessionId });
    const nameInput = snapshotAfterBlocked.inputs.find((i) => i.name === 'name');
    assert.equal(nameInput?.value ?? '', '', 'a blocked type() must never actually fill the real page field');
  } finally {
    await runtime.shutdown();
    await testServer.close();
  }
});

// ── 9: no-mutation proof across the full blocked-action set ─────────────

test('BLOCKED_BROWSER_ACTION_NO_MUTATION: session status/currentUrl are unchanged after every blocked cross-identity attempt', async () => {
  const testServer = await createTestServer();
  const { runtime, sessions, service } = await buildHarness();
  try {
    const session = await service.open({ tenantId: TENANT_A, ownerId: OWNER_X, requestId: 'req_open' });
    await service.navigate({ tenantId: TENANT_A, ownerId: OWNER_X, requestId: 'req_nav', browserSessionId: session.browserSessionId, url: testServer.baseUrl });
    const before = sessions.get(session.browserSessionId);
    assert.ok(before);

    await assertNotFound(service.navigate({ tenantId: TENANT_B, ownerId: OWNER_X, requestId: 'req_1', browserSessionId: session.browserSessionId, url: 'https://example.com/' }), 'navigate/tenant');
    await assertNotFound(service.click({ tenantId: TENANT_A, ownerId: OWNER_Y, requestId: 'req_2', browserSessionId: session.browserSessionId, selector: '#nav-link' }), 'click/owner');
    await assertNotFound(service.type({ tenantId: TENANT_B, ownerId: OWNER_Y, requestId: 'req_3', browserSessionId: session.browserSessionId, selector: '#name-input', text: 'x' }), 'type/both');
    await assertNotFound(service.close({ tenantId: TENANT_B, ownerId: OWNER_X, requestId: 'req_4', browserSessionId: session.browserSessionId }), 'close/tenant');
    await assertNotFound(service.clearProfile({ tenantId: TENANT_A, ownerId: OWNER_Y, requestId: 'req_5', browserSessionId: session.browserSessionId }), 'clearProfile/owner');

    const after = sessions.get(session.browserSessionId);
    assert.equal(after?.status, before?.status);
    assert.equal(after?.currentUrl, before?.currentUrl);
    assert.equal(after?.status, 'OPEN', 'the session must still be OPEN — none of the blocked attempts may have closed it');
  } finally {
    await runtime.shutdown();
    await testServer.close();
  }
});

// ── 10: rightful full lifecycle regression ───────────────────────────────

test('RIGHTFUL_BROWSER_SESSION_LIFECYCLE: open/navigate/snapshot/click/type/close all still work for the real owner', async () => {
  const testServer = await createTestServer();
  const { runtime, sessions, service } = await buildHarness();
  try {
    const input = { tenantId: TENANT_A, ownerId: OWNER_X, requestId: 'req_open' };
    const session = await service.open(input);
    assert.equal(session.status, 'OPEN');
    const sInput = { ...input, browserSessionId: session.browserSessionId };

    const nav = await service.navigate({ ...sInput, url: testServer.baseUrl });
    assert.equal(nav.title, 'DC0 Ownership Test Page');

    const snap = await service.structuredSnapshot(sInput);
    assert.ok(snap.text.includes('DC0 Ownership Test Page'));

    await service.type({ ...sInput, selector: '#name-input', text: 'rightful owner' });
    const clickRes = await service.click({ ...sInput, selector: '#nav-link' });
    assert.equal(clickRes.status, 'EXECUTED');

    await service.close(sInput);
    assert.equal(sessions.get(session.browserSessionId)?.status, 'CLOSED');
  } finally {
    await runtime.shutdown();
    await testServer.close();
  }
});

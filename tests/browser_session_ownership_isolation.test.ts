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
  const evidenceDir = path.join(dir, 'evidence');
  const service = new BrowserToolService(runtime, sessions, approvals, audit, memory, undefined, evidenceDir);
  return { runtime, sessions, service, evidenceDir };
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

// ── 8b: clearProfile isolation, dedicated (DC0-R1 — the live HTTP surface
// has no clearProfile route, so this canonical repository test is the
// sole ownership proof for it; previously only an incidental cross-owner
// assertion existed inside BLOCKED_BROWSER_ACTION_NO_MUTATION below, with
// no dedicated cross-tenant case and no rightful-succeeds case).
// Uses a non-persistent runtime (matching this file's harness throughout),
// under which clearProfile() still always closes the session regardless
// of persistent-profile mode (browser.runtime.ts:361-369) — so "rightful
// clearProfile succeeds" is meaningfully assertable without needing
// NAGEX_BROWSER_PERSISTENT_PROFILE=1.

test('CROSS_TENANT_BROWSER_CLEAR_PROFILE_BLOCK / CROSS_OWNER_BROWSER_CLEAR_PROFILE_BLOCK / RIGHTFUL_BROWSER_CLEAR_PROFILE', async () => {
  const testServer = await createTestServer();
  const { runtime, sessions, service } = await buildHarness();
  try {
    const session = await service.open({ tenantId: TENANT_A, ownerId: OWNER_X, requestId: 'req_open' });
    await service.navigate({ tenantId: TENANT_A, ownerId: OWNER_X, requestId: 'req_nav', browserSessionId: session.browserSessionId, url: testServer.baseUrl });
    const before = sessions.get(session.browserSessionId);
    assert.ok(before);

    await assertNotFound(
      service.clearProfile({ tenantId: TENANT_B, ownerId: OWNER_X, requestId: 'req_cp_ct', browserSessionId: session.browserSessionId }),
      'CROSS_TENANT_BROWSER_CLEAR_PROFILE_BLOCK',
    );
    await assertNotFound(
      service.clearProfile({ tenantId: TENANT_A, ownerId: OWNER_Y, requestId: 'req_cp_co', browserSessionId: session.browserSessionId }),
      'CROSS_OWNER_BROWSER_CLEAR_PROFILE_BLOCK',
    );

    // Neither blocked attempt may have closed the rightful session, mutated
    // its state, or touched the real browser context.
    const stillOpen = sessions.get(session.browserSessionId);
    assert.equal(stillOpen?.status, 'OPEN');
    assert.equal(stillOpen?.currentUrl, before?.currentUrl);

    // Rightful clearProfile retains its existing semantics: it always
    // closes the session (persistent-profile directory removal is
    // additional and conditional on persistent mode, not exercised by this
    // non-persistent harness — see browser.runtime.ts:361-369).
    await service.clearProfile({ tenantId: TENANT_A, ownerId: OWNER_X, requestId: 'req_cp_rightful', browserSessionId: session.browserSessionId });
    assert.equal(sessions.get(session.browserSessionId)?.status, 'CLOSED');
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

// ── 11-16: DC1-R1 — Browser Evidence Ownership Isolation Correction ──────
// Screenshot evidence previously had zero ownership metadata — a bare
// {evidenceId}.png, isolation resting entirely on evidenceId secrecy, the
// exact pre-DC0 pattern the "authorization, not identifier secrecy" rule
// forbids. readEvidenceOwned() closes this the same way getOwned() did for
// sessions: a mismatch is indistinguishable from a nonexistent id.

const PNG_MAGIC_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

async function assertEvidenceNotFound(promise: Promise<unknown>, label: string): Promise<void> {
  await assert.rejects(
    promise,
    (err: unknown) => {
      assert.ok(err instanceof NagexError, `${label}: expected a NagexError`);
      assert.equal((err as NagexError).code, 'BROWSER_EVIDENCE_NOT_FOUND', `${label}: expected BROWSER_EVIDENCE_NOT_FOUND`);
      assert.equal((err as NagexError).category, 'NOT_FOUND', `${label}: expected NOT_FOUND category`);
      return true;
    },
  );
}

test('EVIDENCE_RIGHTFUL_READ: the rightful tenant/owner reads back the real PNG bytes just captured', async () => {
  const testServer = await createTestServer();
  const { runtime, service } = await buildHarness();
  try {
    const session = await service.open({ tenantId: TENANT_A, ownerId: OWNER_X, requestId: 'req_open' });
    const sInput = { tenantId: TENANT_A, ownerId: OWNER_X, requestId: 'req_nav', browserSessionId: session.browserSessionId };
    await service.navigate({ ...sInput, url: testServer.baseUrl });
    const evidence = await service.screenshot(sInput);

    const bytes = service.readEvidenceOwned(evidence.evidenceId, TENANT_A, OWNER_X, 'req_read_rightful');
    assert.ok(bytes.length > 0, 'rightful read must return real, non-empty bytes');
    assert.deepEqual(bytes.subarray(0, 4), PNG_MAGIC_BYTES, 'returned bytes must be a real PNG, not a placeholder');
  } finally {
    await runtime.shutdown();
    await testServer.close();
  }
});

test('EVIDENCE_CROSS_TENANT_READ_BLOCK / EVIDENCE_CROSS_OWNER_READ_BLOCK: wrong identity against a real known evidenceId', async () => {
  const testServer = await createTestServer();
  const { runtime, service } = await buildHarness();
  try {
    const session = await service.open({ tenantId: TENANT_A, ownerId: OWNER_X, requestId: 'req_open' });
    const sInput = { tenantId: TENANT_A, ownerId: OWNER_X, requestId: 'req_nav', browserSessionId: session.browserSessionId };
    await service.navigate({ ...sInput, url: testServer.baseUrl });
    const evidence = await service.screenshot(sInput);

    await assertEvidenceNotFound(
      Promise.resolve().then(() => service.readEvidenceOwned(evidence.evidenceId, TENANT_B, OWNER_X, 'req_ct')),
      'EVIDENCE_CROSS_TENANT_READ_BLOCK',
    );
    await assertEvidenceNotFound(
      Promise.resolve().then(() => service.readEvidenceOwned(evidence.evidenceId, TENANT_A, OWNER_Y, 'req_co')),
      'EVIDENCE_CROSS_OWNER_READ_BLOCK',
    );
  } finally {
    await runtime.shutdown();
    await testServer.close();
  }
});

test('EVIDENCE_UNKNOWN_ID_INDISTINGUISHABLE: a genuinely nonexistent evidenceId produces the identical error as a wrong-identity attempt', async () => {
  const testServer = await createTestServer();
  const { runtime, service } = await buildHarness();
  try {
    const session = await service.open({ tenantId: TENANT_A, ownerId: OWNER_X, requestId: 'req_open' });
    const sInput = { tenantId: TENANT_A, ownerId: OWNER_X, requestId: 'req_nav', browserSessionId: session.browserSessionId };
    await service.navigate({ ...sInput, url: testServer.baseUrl });
    const evidence = await service.screenshot(sInput);

    let unknownErr: NagexError | undefined;
    let wrongOwnerErr: NagexError | undefined;
    try {
      service.readEvidenceOwned('bev_does_not_exist', TENANT_A, OWNER_X, 'req_unknown');
    } catch (err) {
      unknownErr = err as NagexError;
    }
    try {
      service.readEvidenceOwned(evidence.evidenceId, TENANT_A, OWNER_Y, 'req_wrong_owner');
    } catch (err) {
      wrongOwnerErr = err as NagexError;
    }
    assert.ok(unknownErr instanceof NagexError);
    assert.ok(wrongOwnerErr instanceof NagexError);
    assert.equal(unknownErr!.code, wrongOwnerErr!.code, 'unknown-id and wrong-owner must throw the identical code');
    assert.equal(unknownErr!.category, wrongOwnerErr!.category);
    assert.equal(unknownErr!.code, 'BROWSER_EVIDENCE_NOT_FOUND');
  } finally {
    await runtime.shutdown();
    await testServer.close();
  }
});

test('EVIDENCE_LEGACY_NO_METADATA_BLOCK: a PNG written before this correction existed (no metadata sidecar) is blocked, not grandfathered in', async () => {
  const { runtime, service, evidenceDir } = await buildHarness();
  try {
    // Simulates evidence captured before DC1-R1 — a bare {evidenceId}.png
    // with no {evidenceId}.json metadata record ever written, via the raw
    // filesystem directly rather than service.screenshot() (which always
    // writes both now).
    const legacyEvidenceId = 'bev_legacy_pre_r1_0001';
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(path.join(evidenceDir, `${legacyEvidenceId}.png`), PNG_MAGIC_BYTES);
    assert.ok(fs.existsSync(path.join(evidenceDir, `${legacyEvidenceId}.png`)), 'the legacy PNG must genuinely exist on disk');
    assert.ok(!fs.existsSync(path.join(evidenceDir, `${legacyEvidenceId}.json`)), 'and genuinely have no metadata record');

    await assertEvidenceNotFound(
      Promise.resolve().then(() => service.readEvidenceOwned(legacyEvidenceId, TENANT_A, OWNER_X, 'req_legacy')),
      'EVIDENCE_LEGACY_NO_METADATA_BLOCK',
    );
  } finally {
    await runtime.shutdown();
  }
});

test('EVIDENCE_BLOCKED_READ_NO_MUTATION: blocked cross-identity attempts never alter the evidence — the rightful owner reads identical bytes after', async () => {
  const testServer = await createTestServer();
  const { runtime, service } = await buildHarness();
  try {
    const session = await service.open({ tenantId: TENANT_A, ownerId: OWNER_X, requestId: 'req_open' });
    const sInput = { tenantId: TENANT_A, ownerId: OWNER_X, requestId: 'req_nav', browserSessionId: session.browserSessionId };
    await service.navigate({ ...sInput, url: testServer.baseUrl });
    const evidence = await service.screenshot(sInput);

    const before = service.readEvidenceOwned(evidence.evidenceId, TENANT_A, OWNER_X, 'req_before');

    await assertEvidenceNotFound(
      Promise.resolve().then(() => service.readEvidenceOwned(evidence.evidenceId, TENANT_B, OWNER_X, 'req_ct')),
      'blocked cross-tenant attempt',
    );
    await assertEvidenceNotFound(
      Promise.resolve().then(() => service.readEvidenceOwned(evidence.evidenceId, TENANT_A, OWNER_Y, 'req_co')),
      'blocked cross-owner attempt',
    );

    const after = service.readEvidenceOwned(evidence.evidenceId, TENANT_A, OWNER_X, 'req_after');
    assert.deepEqual(after, before, 'evidence bytes must be byte-for-byte unchanged after blocked attempts');
  } finally {
    await runtime.shutdown();
    await testServer.close();
  }
});

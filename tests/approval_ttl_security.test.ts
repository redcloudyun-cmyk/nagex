import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  ActionApprovalStore,
  PersistentActionApprovalStore,
} from '../src/governance/action-approval.store.js';
import { ExecutionStore } from '../src/governance/execution.store.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { MemoryEngine } from '../src/context/memory.engine.js';
import { InMemoryGoogleOAuthTokenStore } from '../src/integrations/google/token.store.js';
import { GoogleCalendarService, GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID } from '../src/tools/google-calendar.service.js';
import { GmailService, GMAIL_SEND_EMAIL_TOOL_ID } from '../src/tools/gmail.service.js';
import { BrowserToolService } from '../src/modules/browser/browser.service.js';
import { BrowserSessionStore } from '../src/modules/browser/browser-session.store.js';
import type { GoogleOAuthConfig } from '../src/integrations/google/oauth.client.js';
import type { BrowserRuntime, BrowserSnapshot } from '../src/modules/browser/browser.runtime.js';

function tmpDir(label: string): string {
  return path.join(os.tmpdir(), `nagex-ttl-test-${label}-${crypto.randomBytes(6).toString('hex')}`);
}

const mockOauthConfig: GoogleOAuthConfig = {
  clientId: 'mock_client',
  clientSecret: 'mock_secret',
  redirectUri: 'https://nagex.test/callback',
};

// ── TEST 1 — PENDING approval expires ────────────────────────────────────────

test('TEST 1 — PENDING approval transitions to EXPIRED after expiresAt', () => {
  let clock = Date.now();
  const store = new ActionApprovalStore(() => clock);
  const record = store.request({
    toolId: 'test_tool',
    tenantId: 'tenant_1',
    principalId: 'user_1',
    payload: { key: 'value' },
  });

  assert.equal(record.status, 'PENDING');

  // Advance time past TTL (default 15 mins)
  clock += 16 * 60 * 1000;

  const fetched = store.get(record.approvalId);
  assert.equal(fetched?.status, 'EXPIRED');

  assert.throws(
    () => store.approve(record.approvalId),
    (err: any) => err.code === 'APPROVAL_EXPIRED' && err.category === 'POLICY',
  );
});

// ── TEST 2 — APPROVED approval expires before consume (P0 Core Security) ─────

test('TEST 2 — APPROVED approval transitions to EXPIRED after expiresAt and blocks consume', () => {
  let clock = Date.now();
  const store = new ActionApprovalStore(() => clock);
  const record = store.request({
    toolId: 'test_tool',
    tenantId: 'tenant_1',
    principalId: 'user_1',
    payload: { action: 'delete_data' },
  });

  // Approved while within TTL
  const approved = store.approve(record.approvalId);
  assert.equal(approved.status, 'APPROVED');

  // Advance time past expiresAt
  clock += 16 * 60 * 1000;

  // Consume attempt must fail with APPROVAL_EXPIRED
  assert.throws(
    () =>
      store.consume(
        record.approvalId,
        'test_tool',
        { action: 'delete_data' },
        'req_1',
        'exe_1',
      ),
    (err: any) => err.code === 'APPROVAL_EXPIRED' && err.category === 'POLICY',
  );

  // Status is now EXPIRED
  const afterAttempt = store.get(record.approvalId);
  assert.equal(afterAttempt?.status, 'EXPIRED');
});

// ── TEST 3 — APPROVED but still within TTL executes ─────────────────────────

test('TEST 3 — APPROVED approval executed within TTL successfully transitions to CONSUMED', () => {
  let clock = Date.now();
  const store = new ActionApprovalStore(() => clock);
  const record = store.request({
    toolId: 'test_tool',
    tenantId: 'tenant_1',
    principalId: 'user_1',
    payload: { action: 'send' },
  });

  store.approve(record.approvalId);

  // Advance time within TTL (5 mins)
  clock += 5 * 60 * 1000;

  const consumed = store.consume(
    record.approvalId,
    'test_tool',
    { action: 'send' },
    'req_1',
    'exe_100',
  );

  assert.equal(consumed.status, 'CONSUMED');
  assert.equal(consumed.executionId, 'exe_100');
  assert.equal(typeof consumed.usedAt, 'string');
});

// ── TEST 4 — CONSUMED approval does not become EXPIRED ──────────────────────

test('TEST 4 — CONSUMED approval remains CONSUMED even after expiresAt', () => {
  let clock = Date.now();
  const store = new ActionApprovalStore(() => clock);
  const record = store.request({
    toolId: 'test_tool',
    tenantId: 'tenant_1',
    principalId: 'user_1',
    payload: { action: 'send' },
  });

  store.approve(record.approvalId);
  store.consume(
    record.approvalId,
    'test_tool',
    { action: 'send' },
    'req_1',
    'exe_1',
  );

  // Advance time past expiresAt
  clock += 20 * 60 * 1000;

  const fetched = store.get(record.approvalId);
  assert.equal(fetched?.status, 'CONSUMED');
});

// ── TEST 5 — Replay remains blocked ─────────────────────────────────────────

test('TEST 5 — Replay of a CONSUMED approval is blocked with APPROVAL_ALREADY_CONSUMED even after expiresAt', () => {
  let clock = Date.now();
  const store = new ActionApprovalStore(() => clock);
  const record = store.request({
    toolId: 'test_tool',
    tenantId: 'tenant_1',
    principalId: 'user_1',
    payload: { action: 'pay' },
  });

  store.approve(record.approvalId);
  store.consume(
    record.approvalId,
    'test_tool',
    { action: 'pay' },
    'req_1',
    'exe_1',
  );

  // Advance time past expiresAt
  clock += 30 * 60 * 1000;

  assert.throws(
    () =>
      store.consume(
        record.approvalId,
        'test_tool',
        { action: 'pay' },
        'req_2',
        'exe_2',
      ),
    (err: any) =>
      err.code === 'APPROVAL_ALREADY_CONSUMED' && err.category === 'CONFLICT',
  );
});

// ── TEST 6 — REJECTED approval remains REJECTED ─────────────────────────────

test('TEST 6 — REJECTED approval remains REJECTED even after expiresAt', () => {
  let clock = Date.now();
  const store = new ActionApprovalStore(() => clock);
  const record = store.request({
    toolId: 'test_tool',
    tenantId: 'tenant_1',
    principalId: 'user_1',
    payload: { action: 'transfer' },
  });

  store.reject(record.approvalId);

  // Advance time past expiresAt
  clock += 30 * 60 * 1000;

  const fetched = store.get(record.approvalId);
  assert.equal(fetched?.status, 'REJECTED');
});

// ── Service-level regression test: GmailService ─────────────────────────────

test('Service regression: GmailService execution blocked on expired APPROVED approval with 0 provider calls', async () => {
  let clock = Date.now();
  let providerCallCount = 0;
  const fetchFn: typeof fetch = async () => {
    providerCallCount++;
    return new Response(JSON.stringify({ id: 'msg_123' }), { status: 200 });
  };

  const tokenStore = new InMemoryGoogleOAuthTokenStore();
  tokenStore.save('t1', {
    accessToken: 'valid_access_token',
    refreshToken: 'valid_refresh_token',
    expiresAt: clock + 100 * 3600_000,
    scope: 'https://mail.google.com/',
  });

  const approvals = new ActionApprovalStore(() => clock);
  const audit = new AuditLogger();
  const memory = new MemoryEngine();
  const executions = new ExecutionStore();
  const gmailService = new GmailService(
    tokenStore,
    approvals,
    audit,
    memory,
    fetchFn,
    () => mockOauthConfig,
    executions,
  );

  const payload = {
    from: 'me@example.com',
    to: ['user@example.com'],
    subject: 'Test Email',
    body: 'Hello World',
  };

  const record = gmailService.requestApproval({
    toolId: GMAIL_SEND_EMAIL_TOOL_ID,
    tenantId: 't1',
    principalId: 'u1',
    payload,
    requestId: 'req_req',
  });

  gmailService.approve(record.approvalId, 'u1', 'req_appr');

  // Time advances past expiresAt
  clock += 20 * 60 * 1000;

  await assert.rejects(
    () =>
      gmailService.executeSendEmail({
        approvalId: record.approvalId,
        payload,
        tenantId: 't1',
        principalId: 'u1',
        requestId: 'req_exec',
      }),
    (err: any) => err.code === 'APPROVAL_EXPIRED' && err.category === 'POLICY',
  );

  assert.equal(providerCallCount, 0, 'Gmail provider must never be called for an expired approval');
});

// ── Service-level regression test: GoogleCalendarService ────────────────────

test('Service regression: GoogleCalendarService execution blocked on expired APPROVED approval with 0 provider calls', async () => {
  let clock = Date.now();
  let providerCallCount = 0;
  const fetchFn: typeof fetch = async () => {
    providerCallCount++;
    return new Response(JSON.stringify({ id: 'evt_123' }), { status: 200 });
  };

  const tokenStore = new InMemoryGoogleOAuthTokenStore();
  tokenStore.save('t1', {
    accessToken: 'valid_access_token',
    refreshToken: 'valid_refresh_token',
    expiresAt: clock + 100 * 3600_000,
    scope: 'https://www.googleapis.com/auth/calendar',
  });

  const approvals = new ActionApprovalStore(() => clock);
  const audit = new AuditLogger();
  const memory = new MemoryEngine();
  const executions = new ExecutionStore();
  const calendarService = new GoogleCalendarService(
    tokenStore,
    approvals,
    audit,
    memory,
    fetchFn,
    () => mockOauthConfig,
    executions,
  );

  const payload = {
    calendarId: 'primary',
    summary: 'Team Sync',
    description: 'Weekly Sync',
    start: '2026-09-10T10:00:00+09:00',
    end: '2026-09-10T11:00:00+09:00',
    timezone: 'Asia/Seoul',
    attendees: [],
  };

  const record = calendarService.requestCreateEventApproval({
    tenantId: 't1',
    principalId: 'u1',
    payload,
    requestId: 'req_req',
  });

  calendarService.approve(record.approvalId, 'u1', 'req_appr');

  // Time advances past expiresAt
  clock += 20 * 60 * 1000;

  await assert.rejects(
    () =>
      calendarService.executeCreateEvent({
        approvalId: record.approvalId,
        payload,
        tenantId: 't1',
        principalId: 'u1',
        requestId: 'req_exec',
      }),
    (err: any) => err.code === 'APPROVAL_EXPIRED' && err.category === 'POLICY',
  );

  assert.equal(providerCallCount, 0, 'Google Calendar provider must never be called for an expired approval');
});

// ── Service-level regression test: BrowserToolService ───────────────────────

test('Service regression: BrowserToolService click blocked on expired APPROVED approval with 0 browser runtime calls', async () => {
  let clock = Date.now();
  let browserClickCount = 0;

  const snapshot: BrowserSnapshot = {
    url: 'https://example.com/checkout',
    title: 'Checkout Page',
    text: 'Confirm Order',
    truncated: false,
    totalCharacters: 13,
    returnedCharacters: 13,
  };

  const mockRuntime: BrowserRuntime = {
    isAvailable: async () => true,
    hasSession: () => true,
    openSession: async () => ({ url: snapshot.url, title: snapshot.title }),
    closeSession: async () => {},
    navigate: async () => ({ url: snapshot.url, title: snapshot.title }),
    listTabs: async () => [{ index: 0, url: snapshot.url, title: snapshot.title }],
    snapshot: async () => snapshot,
    structuredSnapshot: async () => ({
      url: snapshot.url,
      title: snapshot.title,
      text: snapshot.text,
      links: [],
      buttons: [],
      inputs: [],
      forms: [],
      elements: [],
    }),
    find: async () => ({ query: '', candidates: [] }),
    extract: async () => ({
      url: snapshot.url,
      title: snapshot.title,
      target: 'all',
      extracted: { text: snapshot.text },
      timestamp: new Date().toISOString(),
    }),
    back: async () => ({ url: snapshot.url, title: snapshot.title }),
    forward: async () => ({ url: snapshot.url, title: snapshot.title }),
    reload: async () => ({ url: snapshot.url, title: snapshot.title }),
    clearProfile: async () => {},
    screenshot: async () => Buffer.from('png'),
    resolveSelector: async () => ({ count: 1, text: 'Confirm Order', isFormControl: true, role: 'button' }),
    click: async () => {
      browserClickCount++;
    },
    type: async () => {},
    select: async () => {},
    scroll: async () => {},
    wait: async () => {},
    shutdown: async () => {},
  };

  const approvals = new ActionApprovalStore(() => clock);
  const sessions = new BrowserSessionStore();
  const audit = new AuditLogger();
  const memory = new MemoryEngine();
  const browserService = new BrowserToolService(
    mockRuntime,
    sessions,
    approvals,
    audit,
    memory,
    new ExecutionStore(),
    tmpDir('browser-evidence'),
    () => true,
  );

  const session = sessions.getOrCreate('t1', 'u1');

  // Request click approval
  const result = await browserService.click({
    tenantId: 't1',
    ownerId: 'u1',
    requestId: 'req_click',
    browserSessionId: session.browserSessionId,
    selector: '#confirm-btn',
    forceApproval: true,
  });

  assert.equal(result.status, 'APPROVAL_REQUIRED');
  const approvalId = result.approval!.approvalId;

  // Approve it
  browserService.approve(approvalId, 'u1', 'req_appr');

  // Time advances past expiresAt
  clock += 20 * 60 * 1000;

  await assert.rejects(
    () =>
      browserService.executeApprovedClick({
        approvalId,
        browserSessionId: session.browserSessionId,
        selector: '#confirm-btn',
        tenantId: 't1',
        ownerId: 'u1',
        requestId: 'req_exec',
      }),
    (err: any) => err.code === 'APPROVAL_EXPIRED' && err.category === 'POLICY',
  );

  assert.equal(browserClickCount, 0, 'Browser runtime click must never be invoked for an expired approval');
});

// ── Persistence test: restart preserves expiry and original expiresAt ────────

test('Persistence test: restored APPROVED approval past expiresAt transitions to EXPIRED on restart', () => {
  const dir = tmpDir('approvals-restart-ttl');
  let clock = Date.now();

  try {
    const storeA = new PersistentActionApprovalStore({ dir, now: () => clock });
    const record = storeA.request({
      toolId: 'test_tool',
      tenantId: 't1',
      principalId: 'u1',
      payload: { action: 'delete' },
    });

    const originalExpiresAt = record.expiresAt;
    storeA.approve(record.approvalId);

    // Advance time past expiresAt
    clock += 20 * 60 * 1000;

    // Fresh store instance simulating app restart
    const storeB = new PersistentActionApprovalStore({ dir, now: () => clock });
    const restored = storeB.get(record.approvalId);

    assert.ok(restored);
    assert.equal(restored?.status, 'EXPIRED');
    assert.equal(restored?.expiresAt, originalExpiresAt, 'Original expiresAt must be preserved across restart');

    assert.throws(
      () =>
        storeB.consume(
          record.approvalId,
          'test_tool',
          { action: 'delete' },
          'req_b',
          'exe_b',
        ),
      (err: any) => err.code === 'APPROVAL_EXPIRED' && err.category === 'POLICY',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Audit callback deduplication test ─────────────────────────

test('onExpired callback is invoked exactly once when APPROVED approval expires', () => {
  let clock = Date.now();
  let expiredCount = 0;

  const store = new ActionApprovalStore(
    () => clock,
    15 * 60 * 1000,
    () => {
      expiredCount++;
    },
  );

  const record = store.request({
    toolId: 'test_tool',
    tenantId: 't1',
    principalId: 'u1',
    payload: { action: 'write' },
  });

  store.approve(record.approvalId);

  // Time advances past expiresAt
  clock += 16 * 60 * 1000;

  // First get() triggers expiry transition
  const firstGet = store.get(record.approvalId);
  assert.equal(firstGet?.status, 'EXPIRED');
  assert.equal(expiredCount, 1);

  // Second get() observes already EXPIRED, does not re-trigger callback
  const secondGet = store.get(record.approvalId);
  assert.equal(secondGet?.status, 'EXPIRED');
  assert.equal(expiredCount, 1, 'onExpired must not be called a second time');
});

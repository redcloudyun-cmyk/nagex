import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  PersistentActionApprovalStore,
  resolveApprovalTtlMs,
  hashCanonicalPayload,
} from '../src/governance/action-approval.store.js';
import { ExecutionStore } from '../src/governance/execution.store.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { MemoryEngine } from '../src/context/memory.engine.js';
import { InMemoryGoogleOAuthTokenStore } from '../src/integrations/google/token.store.js';
import { GoogleCalendarService, GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID } from '../src/modules/calendar/index.js';
import { handleApiRequest } from '../src/server_web.js';
import type { GoogleOAuthConfig } from '../src/integrations/google/oauth.client.js';

function tmpDir(label: string): string {
  return path.join(os.tmpdir(), `nagex-${label}-${crypto.randomBytes(6).toString('hex')}`);
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    calendarId: 'primary',
    summary: 'NAgex Calendar Integration Test',
    description: 'Created through NAgex approval-gated execution.',
    start: '2026-09-07T14:00:00+09:00',
    end: '2026-09-07T14:30:00+09:00',
    timezone: 'Asia/Seoul',
    attendees: [] as string[],
    ...overrides,
  };
}

const config: GoogleOAuthConfig = { clientId: 'x', clientSecret: 'y', redirectUri: 'https://nagex-test.agex.site/api/v1/oauth/google/callback' };

// ── approval persistence across restart ─────────────────────────────────────

test('persistence across restart: an approval created before "restart" is restored by a fresh store instance', () => {
  const dir = tmpDir('approvals-a');
  try {
    const storeA = new PersistentActionApprovalStore({ dir });
    const record = storeA.request({ toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID, tenantId: 't1', principalId: 'u1', payload: validPayload() });

    const storeB = new PersistentActionApprovalStore({ dir }); // simulated restart
    const restored = storeB.get(record.approvalId);
    assert.ok(restored);
    assert.equal(restored?.status, 'PENDING');
    assert.equal(restored?.payloadHash, record.payloadHash);
    assert.deepEqual(restored?.canonicalPayload, record.canonicalPayload);

    // Approve after "restart" — proves the restored record is fully live, not read-only.
    const approved = storeB.approve(record.approvalId);
    assert.equal(approved.status, 'APPROVED');

    const storeC = new PersistentActionApprovalStore({ dir }); // second restart
    assert.equal(storeC.get(record.approvalId)?.status, 'APPROVED');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the persisted approval file is written with mode 0600', () => {
  const dir = tmpDir('approvals-perm');
  try {
    const store = new PersistentActionApprovalStore({ dir });
    const record = store.request({ toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID, tenantId: 't1', principalId: 'u1', payload: validPayload() });
    const filePath = path.join(dir, `${record.approvalId}.json`);
    assert.equal(fs.existsSync(filePath), true);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
    }
    // No leftover temp files after a successful atomic write.
    const leftovers = fs.readdirSync(dir).filter((name) => name.includes('.tmp-'));
    assert.deepEqual(leftovers, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupted approval file is skipped (fails closed), not thrown, on restore', () => {
  const dir = tmpDir('approvals-corrupt');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'apr_bad.json'), 'not valid json {{{');
  try {
    const store = new PersistentActionApprovalStore({ dir });
    assert.equal(store.get('apr_bad'), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('NAGEX_APPROVAL_TTL_SECONDS overrides the default 15-minute TTL', () => {
  assert.equal(resolveApprovalTtlMs({} as NodeJS.ProcessEnv), 15 * 60 * 1000);
  assert.equal(resolveApprovalTtlMs({ NAGEX_APPROVAL_TTL_SECONDS: '60' } as NodeJS.ProcessEnv), 60_000);
  assert.equal(resolveApprovalTtlMs({ NAGEX_APPROVAL_TTL_SECONDS: 'not-a-number' } as NodeJS.ProcessEnv), 15 * 60 * 1000);
});

test('rejectedAt is set on reject and stays null otherwise', () => {
  const dir = tmpDir('approvals-rejectedat');
  try {
    const store = new PersistentActionApprovalStore({ dir });
    const record = store.request({ toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID, tenantId: 't1', principalId: 'u1', payload: validPayload() });
    assert.equal(record.rejectedAt, null);
    const rejected = store.reject(record.approvalId);
    assert.equal(rejected.status, 'REJECTED');
    assert.equal(typeof rejected.rejectedAt, 'string');
    assert.equal(rejected.approvedAt, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('approval.expired fires exactly once (on first detection), not on every subsequent read', () => {
  const dir = tmpDir('approvals-expired-once');
  let clock = 1_000_000;
  let expiredCount = 0;
  try {
    const store = new PersistentActionApprovalStore({ dir, now: () => clock, onExpired: () => { expiredCount += 1; } });
    const record = store.request({ toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID, tenantId: 't1', principalId: 'u1', payload: validPayload() });
    clock += 16 * 60 * 1000; // past the 15-minute default TTL

    store.get(record.approvalId);
    store.get(record.approvalId);
    assert.throws(() => store.approve(record.approvalId));

    assert.equal(expiredCount, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── GET /api/v1/approvals/:approvalId ────────────────────────────────────────

test('GET /api/v1/approvals/:approvalId returns safe metadata for an existing approval', () => {
  const created = handleApiRequest('POST', '/api/v1/approvals', { toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID, payload: validPayload() });
  const approvalId = (created.data as Record<string, unknown>).approvalId as string;

  const fetched = handleApiRequest('GET', `/api/v1/approvals/${approvalId}`, null);
  assert.equal(fetched.status, 200);
  const data = fetched.data as Record<string, unknown>;
  assert.equal(data.approvalId, approvalId);
  assert.equal(data.status, 'PENDING');
  assert.equal(typeof data.payloadHash, 'string');
});

test('GET /api/v1/approvals/:approvalId returns 404 for an unknown id', () => {
  const result = handleApiRequest('GET', '/api/v1/approvals/apr_does_not_exist', null);
  assert.equal(result.status, 404);
});

// ── malformed datetime / invalid timezone (fail closed) ─────────────────────

test('a malformed start/end datetime is rejected before an approval is ever created', () => {
  const result = handleApiRequest('POST', '/api/v1/approvals', {
    toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID,
    payload: validPayload({ start: 'not-a-real-date' }),
  });
  assert.notEqual(result.status, 201);
  assert.equal((result.data as { error: { code: string } }).error.code, 'INVALID_CALENDAR_EVENT_DATETIME');
});

test('an invalid IANA timezone is rejected before an approval is ever created', () => {
  const result = handleApiRequest('POST', '/api/v1/approvals', {
    toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID,
    payload: validPayload({ timezone: 'Not/ARealZone' }),
  });
  assert.notEqual(result.status, 201);
  assert.equal((result.data as { error: { code: string } }).error.code, 'INVALID_CALENDAR_EVENT_TIMEZONE');
});

// ── execution persistence ────────────────────────────────────────────────────

function buildHarness(fetchFn: typeof fetch, dirs: { approvals: string; executions: string }) {
  const tokenStore = new InMemoryGoogleOAuthTokenStore();
  const approvals = new PersistentActionApprovalStore({ dir: dirs.approvals });
  const audit = new AuditLogger();
  const memory = new MemoryEngine();
  const executions = new ExecutionStore({ dir: dirs.executions });
  const service = new GoogleCalendarService(tokenStore, approvals, audit, memory, fetchFn, () => config, executions);
  return { tokenStore, approvals, audit, memory, executions, service };
}

test('execution success is persisted with SUCCEEDED status, externalId, and externalUrl', async () => {
  const dirs = { approvals: tmpDir('exec-appr-a'), executions: tmpDir('exec-exec-a') };
  try {
    const fetchFn: typeof fetch = async () => jsonResponse({ id: 'gcal_evt_persist', htmlLink: 'https://calendar.google.com/event?eid=persist' });
    const { tokenStore, approvals, service, executions } = buildHarness(fetchFn, dirs);
    tokenStore.save('t1', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: 'calendar.events' });
    const record = approvals.request({ toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID, tenantId: 't1', principalId: 'u1', payload: validPayload() });
    approvals.approve(record.approvalId);

    const result = await service.executeCreateEvent({ approvalId: record.approvalId, payload: validPayload(), tenantId: 't1', principalId: 'u1', requestId: 'req_1' });

    const persisted = executions.get(result.executionId);
    assert.ok(persisted);
    assert.equal(persisted?.status, 'SUCCEEDED');
    assert.equal(persisted?.externalId, 'gcal_evt_persist');
    assert.equal(persisted?.externalUrl, 'https://calendar.google.com/event?eid=persist');
    assert.equal(persisted?.approvalId, record.approvalId);
    assert.equal(typeof persisted?.completedAt, 'string');

    // The approval itself links back to the execution it authorized.
    assert.equal(approvals.get(record.approvalId)?.executionId, result.executionId);

    // Survives a fresh ExecutionStore instance pointed at the same directory.
    const executionsAfterRestart = new ExecutionStore({ dir: dirs.executions });
    assert.equal(executionsAfterRestart.get(result.executionId)?.status, 'SUCCEEDED');
  } finally {
    fs.rmSync(dirs.approvals, { recursive: true, force: true });
    fs.rmSync(dirs.executions, { recursive: true, force: true });
  }
});

test('execution failure is persisted with FAILED status and an errorCode, and the approval stays consumed (not reusable)', async () => {
  const dirs = { approvals: tmpDir('exec-appr-b'), executions: tmpDir('exec-exec-b') };
  try {
    const fetchFn: typeof fetch = async () => jsonResponse({ error: { message: 'boom' } }, 500);
    const { tokenStore, approvals, service, executions } = buildHarness(fetchFn, dirs);
    tokenStore.save('t1', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: 'calendar.events' });
    const record = approvals.request({ toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID, tenantId: 't1', principalId: 'u1', payload: validPayload() });
    approvals.approve(record.approvalId);

    await assert.rejects(() => service.executeCreateEvent({ approvalId: record.approvalId, payload: validPayload(), tenantId: 't1', principalId: 'u1', requestId: 'req_1' }));

    const all = executions.list();
    assert.equal(all.length, 1);
    assert.equal(all[0].status, 'FAILED');
    assert.equal(all[0].errorCode, 'GOOGLE_CALENDAR_HTTP_500');

    // The approval was consumed before the failed Google call and must not
    // become reusable just because the call failed.
    assert.equal(approvals.get(record.approvalId)?.status, 'CONSUMED');
    await assert.rejects(
      () => service.executeCreateEvent({ approvalId: record.approvalId, payload: validPayload(), tenantId: 't1', principalId: 'u1', requestId: 'req_2' }),
      (error: any) => error.code === 'APPROVAL_ALREADY_CONSUMED',
    );
  } finally {
    fs.rmSync(dirs.approvals, { recursive: true, force: true });
    fs.rmSync(dirs.executions, { recursive: true, force: true });
  }
});

test('deterministic hash: hashCanonicalPayload is stable for equivalent payloads regardless of key order', () => {
  const a = hashCanonicalPayload(validPayload());
  const b = hashCanonicalPayload({
    attendees: [],
    timezone: 'Asia/Seoul',
    end: '2026-09-07T14:30:00+09:00',
    start: '2026-09-07T14:00:00+09:00',
    description: 'Created through NAgex approval-gated execution.',
    summary: 'NAgex Calendar Integration Test',
    calendarId: 'primary',
  });
  assert.equal(a, b);
});

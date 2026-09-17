// R12.1 Increment 2.5 — Approval Truth Source / DEBT-0006 Closure.
//
// GET /api/v1/approvals used to return a hardcoded, permanently-seeded
// array of 2 fictional demo approvals, filtered out on the frontend by
// known id. This suite verifies the real fix: the endpoint now sources
// exclusively from the canonical ActionApprovalStore (via listPending()),
// the fictional records are gone from production output entirely, and all
// existing approval invariants (tenant/principal ownership, expiry,
// consumed-state, payload binding, replay prevention) are unchanged.
//
// Uses the real, shared production actionApprovals singleton (same
// pattern as tests/daily_brief.test.ts's sharedActionApprovals) with a
// unique tenant/principal pair per test for isolation within this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { handleApiRequest, handleAsyncApiRequest, actionApprovals as sharedActionApprovals } from '../src/server_web.js';
import { GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID } from '../src/modules/calendar/index.js';
import { GMAIL_SEND_EMAIL_TOOL_ID } from '../src/modules/gmail/index.js';
import { handleApprovalsRoutes } from '../src/http/routes/approvals.routes.js';

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relPath), 'utf8');
}

function validCalendarPayload(overrides: Record<string, unknown> = {}) {
  return {
    calendarId: 'primary',
    summary: 'Client Strategy Sync',
    description: 'Quarterly strategy discussion.',
    start: '2026-11-01T17:00:00.000Z',
    end: '2026-11-01T17:30:00.000Z',
    timezone: 'America/Los_Angeles',
    attendees: ['client@example.com'],
    conferenceData: false,
    ...overrides,
  };
}

function validGmailPayload(overrides: Record<string, unknown> = {}) {
  return {
    from: 'me',
    to: ['client@example.com'],
    cc: [],
    bcc: [],
    subject: 'Quarterly Update',
    body: 'Here is the update we discussed.',
    attachments: [],
    threadId: null,
    replyToMessageId: null,
    ...overrides,
  };
}

let seq = 0;
function uniqueHeaders() {
  seq += 1;
  return { 'x-nagex-tenant': `ten_approval_truth_${seq}`, 'x-principal-id': `usr_approval_truth_${seq}` };
}

// ─── 1-2: no fictional records in production output / no demo-mode leakage ───

test('1. Production GET /api/v1/approvals never contains the old seeded fictional entries', async () => {
  const headers = uniqueHeaders();
  const res = await handleAsyncApiRequest('GET', '/api/v1/approvals', null, headers);
  assert.equal(res.status, 200);
  const ids = ((res.data as any).approvals as Array<{ id: string }>).map((a) => a.id);
  assert.ok(!ids.includes('appr_gcal_sync'));
  assert.ok(!ids.includes('appr_stakeholder_email'));
});

test('2. The legacy demo/seed approvalQueue array no longer exists anywhere in the route source (no fixture leakage risk, no separate demo mode was needed)', () => {
  const src = readSrc('src/http/routes/approvals.routes.ts');
  assert.doesNotMatch(src, /approvalQueue/);
  assert.doesNotMatch(src, /appr_gcal_sync|appr_stakeholder_email/);
  assert.doesNotMatch(src, /Sarah Kim|James Park|Alex Chen/);
});

// ─── 3-7: real approval lifecycle reflected in the canonical listing ───

test('3. A real pending approval appears in GET /api/v1/approvals', async () => {
  const headers = uniqueHeaders();
  const created = await handleAsyncApiRequest('POST', '/api/v1/approvals', { toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID, payload: validCalendarPayload() }, headers);
  assert.equal(created.status, 201);
  const approvalId = (created.data as any).approvalId as string;

  const res = await handleAsyncApiRequest('GET', '/api/v1/approvals', null, headers);
  const ids = ((res.data as any).approvals as Array<{ id: string }>).map((a) => a.id);
  assert.ok(ids.includes(approvalId));
});

test('4. An approved approval disappears from the pending list', async () => {
  const headers = uniqueHeaders();
  const created = await handleAsyncApiRequest('POST', '/api/v1/approvals', { toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID, payload: validCalendarPayload() }, headers);
  const approvalId = (created.data as any).approvalId as string;

  const approved = await handleAsyncApiRequest('POST', `/api/v1/approvals/${approvalId}/approve`, null, headers);
  assert.equal(approved.status, 200);

  const res = await handleAsyncApiRequest('GET', '/api/v1/approvals', null, headers);
  const ids = ((res.data as any).approvals as Array<{ id: string }>).map((a) => a.id);
  assert.ok(!ids.includes(approvalId));
});

test('5. A rejected approval disappears from the pending list', async () => {
  const headers = uniqueHeaders();
  const created = await handleAsyncApiRequest('POST', '/api/v1/approvals', { toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID, payload: validCalendarPayload() }, headers);
  const approvalId = (created.data as any).approvalId as string;

  const rejected = await handleAsyncApiRequest('POST', `/api/v1/approvals/${approvalId}/reject`, null, headers);
  assert.equal(rejected.status, 200);

  const res = await handleAsyncApiRequest('GET', '/api/v1/approvals', null, headers);
  const ids = ((res.data as any).approvals as Array<{ id: string }>).map((a) => a.id);
  assert.ok(!ids.includes(approvalId));
});

test('6. An expired approval is excluded from the pending list', async () => {
  const headers = uniqueHeaders();
  const created = await handleAsyncApiRequest('POST', '/api/v1/approvals', { toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID, payload: validCalendarPayload() }, headers);
  const approvalId = (created.data as any).approvalId as string;

  // get() returns the live record by reference from the shared store's
  // internal Map — mutating expiresAt here simulates real TTL passage
  // without waiting or overriding process-wide TTL config.
  const record = sharedActionApprovals.get(approvalId, headers['x-nagex-tenant'], headers['x-principal-id']);
  assert.ok(record);
  (record as { expiresAt: string }).expiresAt = new Date(Date.now() - 1000).toISOString();

  const res = await handleAsyncApiRequest('GET', '/api/v1/approvals', null, headers);
  const ids = ((res.data as any).approvals as Array<{ id: string }>).map((a) => a.id);
  assert.ok(!ids.includes(approvalId));
});

test('7. A consumed approval is excluded from the pending list', async () => {
  const headers = uniqueHeaders();
  const created = await handleAsyncApiRequest('POST', '/api/v1/approvals', { toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID, payload: validCalendarPayload() }, headers);
  const approvalId = (created.data as any).approvalId as string;
  const canonicalPayload = (created.data as any).canonicalPayload as Record<string, unknown>;

  await handleAsyncApiRequest('POST', `/api/v1/approvals/${approvalId}/approve`, null, headers);
  sharedActionApprovals.consume(approvalId, headers['x-nagex-tenant'], headers['x-principal-id'], GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID, canonicalPayload, 'req_test_consume', 'exec_test_1');

  const res = await handleAsyncApiRequest('GET', '/api/v1/approvals', null, headers);
  const ids = ((res.data as any).approvals as Array<{ id: string }>).map((a) => a.id);
  assert.ok(!ids.includes(approvalId));
});

// ─── 8-9: ownership isolation (existing invariant, re-verified through this endpoint specifically) ───

test('8. GET /api/v1/approvals never returns another tenant\'s pending approval', async () => {
  const ownerHeaders = uniqueHeaders();
  const created = await handleAsyncApiRequest('POST', '/api/v1/approvals', { toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID, payload: validCalendarPayload() }, ownerHeaders);
  const approvalId = (created.data as any).approvalId as string;

  const otherTenantHeaders = { 'x-nagex-tenant': 'ten_approval_truth_wrong_tenant', 'x-principal-id': ownerHeaders['x-principal-id'] };
  const res = await handleAsyncApiRequest('GET', '/api/v1/approvals', null, otherTenantHeaders);
  const ids = ((res.data as any).approvals as Array<{ id: string }>).map((a) => a.id);
  assert.ok(!ids.includes(approvalId));
});

test('9. GET /api/v1/approvals never returns another principal\'s pending approval within the same tenant', async () => {
  const ownerHeaders = uniqueHeaders();
  const created = await handleAsyncApiRequest('POST', '/api/v1/approvals', { toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID, payload: validCalendarPayload() }, ownerHeaders);
  const approvalId = (created.data as any).approvalId as string;

  const otherPrincipalHeaders = { 'x-nagex-tenant': ownerHeaders['x-nagex-tenant'], 'x-principal-id': 'usr_approval_truth_wrong_principal' };
  const res = await handleAsyncApiRequest('GET', '/api/v1/approvals', null, otherPrincipalHeaders);
  const ids = ((res.data as any).approvals as Array<{ id: string }>).map((a) => a.id);
  assert.ok(!ids.includes(approvalId));
});

// ─── 10: payload/action binding unchanged ───

test('10. Payload binding is unchanged: two approvals with different payloads hash differently, and the mapped GET summary carries the real toolId through unmodified', async () => {
  const headers = uniqueHeaders();
  const a = await handleAsyncApiRequest('POST', '/api/v1/approvals', { toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID, payload: validCalendarPayload({ summary: 'Meeting A' }) }, headers);
  const b = await handleAsyncApiRequest('POST', '/api/v1/approvals', { toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID, payload: validCalendarPayload({ summary: 'Meeting B' }) }, headers);
  assert.notEqual((a.data as any).payloadHash, (b.data as any).payloadHash);

  const res = await handleAsyncApiRequest('GET', '/api/v1/approvals', null, headers);
  const approvals = (res.data as any).approvals as Array<{ id: string; toolId: string }>;
  const found = approvals.find((x) => x.id === (a.data as any).approvalId);
  assert.ok(found);
  assert.equal(found!.toolId, GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID);
});

// ─── 11-12: frontend no longer needs to know about seed ids ───

test('11. Home (app.js) no longer contains any seed/demo approval-id filtering', () => {
  const appJs = readSrc('public/app.js');
  assert.doesNotMatch(appJs, /LEGACY_DEMO_APPROVAL_IDS/);
  assert.doesNotMatch(appJs, /appr_gcal_sync|appr_stakeholder_email/);
});

test('12. Mobile Home (mobile-home.js) no longer contains any seed/demo approval-id filtering', () => {
  const mobileJs = readSrc('public/mobile/mobile-home.js');
  assert.doesNotMatch(mobileJs, /LEGACY_DEMO_APPROVAL_IDS/);
  assert.doesNotMatch(mobileJs, /appr_gcal_sync|appr_stakeholder_email/);
});

// ─── 13: fail closed on backend error ───

test('13. A thrown error from the canonical store surfaces as a real error response, never a fake empty-looking 200', () => {
  const throwingStore = {
    listPending: () => {
      throw new Error('simulated canonical store failure');
    },
  } as any;
  const result = handleApprovalsRoutes(
    'GET',
    '/api/v1/approvals',
    null,
    {},
    {},
    {
      googleCalendarService: {} as any,
      gmailService: {} as any,
      actionApprovals: throwingStore,
      auditLogger: {} as any,
      taskContinuationCoordinator: {} as any,
      tenantId: 'ten_fail_closed_test',
      principal: { type: 'user', id: 'usr_fail_closed_test' },
      modelErrorResult: (error: unknown) => ({ status: 500, data: { error: 'INTERNAL', message: String(error) } }),
    },
  );
  assert.ok(result);
  assert.notEqual(result!.status, 200);
});

// ─── 14-15: Calendar and Gmail both visible through the one canonical source ───

test('14. A Calendar-originated pending approval is visible through the canonical source', async () => {
  const headers = uniqueHeaders();
  const created = await handleAsyncApiRequest('POST', '/api/v1/approvals', { toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID, payload: validCalendarPayload() }, headers);
  const approvalId = (created.data as any).approvalId as string;

  const res = await handleAsyncApiRequest('GET', '/api/v1/approvals', null, headers);
  const approvals = (res.data as any).approvals as Array<{ id: string; toolId: string }>;
  const found = approvals.find((x) => x.id === approvalId);
  assert.ok(found);
  assert.equal(found!.toolId, GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID);
});

test('15. A Gmail-originated pending approval is visible through the same canonical source', async () => {
  const headers = uniqueHeaders();
  const created = await handleAsyncApiRequest('POST', '/api/v1/approvals', { toolId: GMAIL_SEND_EMAIL_TOOL_ID, payload: validGmailPayload() }, headers);
  assert.equal(created.status, 201);
  const approvalId = (created.data as any).approvalId as string;

  const res = await handleAsyncApiRequest('GET', '/api/v1/approvals', null, headers);
  const approvals = (res.data as any).approvals as Array<{ id: string; toolId: string }>;
  const found = approvals.find((x) => x.id === approvalId);
  assert.ok(found);
  assert.equal(found!.toolId, GMAIL_SEND_EMAIL_TOOL_ID);
});

// ─── 16: sync handleApiRequest path (used by ~40 test files) stays consistent ───

test('16. The sync handleApiRequest entry point returns the same canonical, non-fictional approvals as the async entry point', () => {
  const headers = uniqueHeaders();
  const res = handleApiRequest('GET', '/api/v1/approvals', null, headers);
  assert.equal(res.status, 200);
  const ids = ((res.data as any).approvals as Array<{ id: string }>).map((a) => a.id);
  assert.ok(!ids.includes('appr_gcal_sync'));
  assert.ok(!ids.includes('appr_stakeholder_email'));
});

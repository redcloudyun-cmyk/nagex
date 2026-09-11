import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { InMemoryGoogleOAuthTokenStore } from '../src/integrations/google/token.store.js';
import type { GoogleOAuthConfig } from '../src/integrations/google/oauth.client.js';
import { ActionApprovalStore, hashCanonicalPayload, type ActionApprovalRecord } from '../src/governance/action-approval.store.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { MemoryEngine } from '../src/context/memory.engine.js';
import { GoogleCalendarService, GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID } from '../src/modules/calendar/index.js';
import { handleAsyncApiRequest } from '../src/server_web.js';

// public/calendar-approval-view.js is a dependency-free browser script (IIFE),
// loaded the same way tests/plan_resolution_ui.test.ts loads
// plan-resolution-view.js: run its real source in a vm sandbox so we exercise
// the actual logic the Ambient Assistant UI uses to render the approval card,
// not a re-implementation of it.
function loadCalendarApprovalView(): {
  STATUS_LABEL: Record<string, string>;
  buildPayloadFields: (payload: unknown) => {
    title: string;
    description: string;
    date: string;
    startTime: string;
    endTime: string;
    timezone: string;
    calendar: string;
    attendees: string[];
  };
  isExpired: (expiresAt: string, nowMs?: number) => boolean;
  formatCountdown: (msRemaining: number) => string;
  buildCardViewModel: (approval: unknown, nowMs?: number) => {
    fields: ReturnType<ReturnType<typeof loadCalendarApprovalView>['buildPayloadFields']>;
    status: string;
    statusLabel: string;
    approveDisabled: boolean;
    rejectDisabled: boolean;
    countdownLabel: string | null;
  };
  buildSuccessViewModel: (payload: unknown, result: unknown) => {
    title: string;
    date: string;
    startTime: string;
    endTime: string;
    timezone: string;
    executionId: string;
    externalUrl: string;
  };
  describeExecutionError: (code: string | undefined) => string | null;
} {
  const source = fs.readFileSync(path.join(process.cwd(), 'public', 'calendar-approval-view.js'), 'utf8');
  const sandbox: Record<string, unknown> = {};
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'calendar-approval-view.js' });
  return (sandbox.window as Record<string, unknown>).NAGEX_CALENDAR_APPROVAL_VIEW as ReturnType<typeof loadCalendarApprovalView>;
}

const view = loadCalendarApprovalView();

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    calendarId: 'primary',
    summary: 'NAgex Calendar Integration Test',
    description: 'End-to-end approval-gated scheduling test.',
    start: '2026-09-07T14:00:00.000Z',
    end: '2026-09-07T14:30:00.000Z',
    timezone: 'America/Los_Angeles',
    attendees: ['guest@example.com'],
    conferenceData: false,
    ...overrides,
  };
}

function approvalRecordFor(status: ActionApprovalRecord['status'], overrides: Partial<ActionApprovalRecord> = {}): ActionApprovalRecord {
  return {
    approvalId: 'apr_test_1',
    toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID,
    tenantId: 'ten_test',
    principalId: 'usr_test',
    canonicalPayload: validPayload(),
    payloadHash: hashCanonicalPayload(validPayload()),
    status,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    approvedAt: null,
    rejectedAt: null,
    usedAt: null,
    executionId: null,
    ...overrides,
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const oauthConfig: GoogleOAuthConfig = { clientId: 'cid', clientSecret: 'csecret', redirectUri: 'https://nagex-test.agex.site/api/v1/oauth/google/callback' };

function buildIsolatedHarness(fetchFn: typeof fetch, now: () => number = Date.now, ttlMs?: number) {
  const tokenStore = new InMemoryGoogleOAuthTokenStore();
  const approvals = ttlMs === undefined ? new ActionApprovalStore(now) : new ActionApprovalStore(now, ttlMs);
  const audit = new AuditLogger();
  const memory = new MemoryEngine();
  const service = new GoogleCalendarService(tokenStore, approvals, audit, memory, fetchFn, () => oauthConfig);
  tokenStore.save('ten_production_01', { accessToken: 'at', refreshToken: 'rt', expiresAt: now() + 3_600_000, scope: 'https://www.googleapis.com/auth/calendar.events' });
  return { tokenStore, approvals, audit, memory, service };
}

// ── Pure view-model logic (what the approval card actually renders) ────────

test('approval card renders the exact frozen payload fields, unmodified', () => {
  const fields = view.buildPayloadFields(validPayload());
  assert.equal(fields.title, 'NAgex Calendar Integration Test');
  assert.equal(fields.description, 'End-to-end approval-gated scheduling test.');
  assert.equal(fields.date, '2026-09-07');
  assert.equal(fields.startTime, '14:00');
  assert.equal(fields.endTime, '14:30');
  assert.equal(fields.timezone, 'America/Los_Angeles');
  assert.equal(fields.calendar, 'primary');
  assert.deepEqual(fields.attendees, ['guest@example.com']);
});

test('buildPayloadFields never mutates the payload it is given', () => {
  const payload = validPayload();
  const frozen = JSON.stringify(payload);
  view.buildPayloadFields(payload);
  assert.equal(JSON.stringify(payload), frozen);
});

test('a pending, unexpired approval shows "Pending approval" with both buttons enabled', () => {
  const record = approvalRecordFor('PENDING');
  const vmView = view.buildCardViewModel(record, Date.now());
  assert.equal(vmView.status, 'PENDING');
  assert.equal(vmView.statusLabel, 'Pending approval');
  assert.equal(vmView.approveDisabled, false);
  assert.equal(vmView.rejectDisabled, false);
  assert.match(vmView.countdownLabel || '', /remaining/);
});

test('expired approval disables execution: Approve (and Reject) are disabled and status reads "Approval expired"', () => {
  const record = approvalRecordFor('PENDING', { expiresAt: new Date(Date.now() - 1000).toISOString() });
  const vmView = view.buildCardViewModel(record, Date.now());
  assert.equal(vmView.status, 'EXPIRED');
  assert.equal(vmView.statusLabel, 'Approval expired');
  assert.equal(vmView.approveDisabled, true);
  assert.equal(vmView.rejectDisabled, true);
});

test('rejected approval disables execution: both buttons disabled, status reads "Rejected"', () => {
  const record = approvalRecordFor('REJECTED', { rejectedAt: new Date().toISOString() });
  const vmView = view.buildCardViewModel(record, Date.now());
  assert.equal(vmView.statusLabel, 'Rejected');
  assert.equal(vmView.approveDisabled, true);
  assert.equal(vmView.rejectDisabled, true);
});

test('a consumed approval (already executed) is never actionable again', () => {
  const record = approvalRecordFor('CONSUMED', { usedAt: new Date().toISOString(), executionId: 'exe_1' });
  const vmView = view.buildCardViewModel(record, Date.now());
  assert.equal(vmView.approveDisabled, true);
  assert.equal(vmView.rejectDisabled, true);
});

test('successful execution view model surfaces title, date/time, executionId, and externalUrl for the "Open in Google Calendar" action', () => {
  const successVm = view.buildSuccessViewModel(validPayload(), {
    executionId: 'exe_abc123',
    externalId: 'gcal_evt_1',
    externalUrl: 'https://calendar.google.com/event?eid=abc',
    status: 'SUCCEEDED',
  });
  assert.equal(successVm.title, 'NAgex Calendar Integration Test');
  assert.equal(successVm.date, '2026-09-07');
  assert.equal(successVm.startTime, '14:00');
  assert.equal(successVm.endTime, '14:30');
  assert.equal(successVm.timezone, 'America/Los_Angeles');
  assert.equal(successVm.executionId, 'exe_abc123');
  assert.equal(successVm.externalUrl, 'https://calendar.google.com/event?eid=abc');
});

test('replay/conflict is mapped to the exact required message: "This approval has already been used."', () => {
  assert.equal(view.describeExecutionError('APPROVAL_ALREADY_CONSUMED'), 'This approval has already been used.');
});

test('an unrecognized error code falls back to null so the caller shows the server\'s own message', () => {
  assert.equal(view.describeExecutionError('SOME_UNKNOWN_CODE'), null);
});

// ── Full HTTP flow: the exact sequence the Ambient Assistant UI performs ───

test('no automatic write without approval: create-event is rejected before any approval exists', async () => {
  const mockFetch: typeof fetch = async () => { throw new Error('must never call Google without a granted approval'); };
  const { service } = buildIsolatedHarness(mockFetch);

  const executed = await handleAsyncApiRequest(
    'POST',
    '/api/v1/tools/google-calendar/create-event',
    { approvalId: 'apr_never_requested', payload: validPayload() },
    {},
    undefined,
    {},
    service,
  );
  assert.notEqual(executed.status, 200);
  assert.equal((executed.data as { error: { code: string } }).error.code, 'APPROVAL_NOT_FOUND');
});

test('execution occurs only after approval: create-event fails while PENDING, then succeeds once approved, using the untouched canonicalPayload', async () => {
  let calledGoogle = false;
  const mockFetch: typeof fetch = async (url) => {
    calledGoogle = true;
    assert.match(String(url), /\/calendar\/v3\/calendars\/primary\/events/);
    return jsonResponse({ id: 'gcal_evt_ui', htmlLink: 'https://calendar.google.com/event?eid=ui' });
  };
  const { service } = buildIsolatedHarness(mockFetch);

  // Step 3: POST /api/v1/approvals is the card-creation call.
  const created = service.requestCreateEventApproval({ tenantId: 'ten_production_01', principalId: 'usr_admin_001', payload: validPayload(), requestId: 'req_1' });
  assert.equal(created.status, 'PENDING');
  assert.equal(created.toolId, GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID);
  assert.equal(typeof created.payloadHash, 'string');
  assert.equal(typeof created.expiresAt, 'string');

  // Attempting execution before approval must fail closed (approve calls the endpoint first).
  const beforeApproval = await handleAsyncApiRequest(
    'POST',
    '/api/v1/tools/google-calendar/create-event',
    { approvalId: created.approvalId, payload: created.canonicalPayload },
    {},
    undefined,
    {},
    service,
  );
  assert.notEqual(beforeApproval.status, 200);
  assert.equal((beforeApproval.data as { error: { code: string } }).error.code, 'APPROVAL_NOT_GRANTED');
  assert.equal(calledGoogle, false);

  // Step 6: approve, then execute — with the exact canonicalPayload the approval API returned.
  const approved = service.approve(created.approvalId, 'usr_admin_001', 'req_2');
  assert.equal(approved.status, 'APPROVED');

  // Step 7 / payload-unchanged check: the payload used for execution hashes
  // identically to what was approved, because it is the same object.
  assert.equal(hashCanonicalPayload(created.canonicalPayload as Record<string, unknown>), created.payloadHash);

  const executed = await handleAsyncApiRequest(
    'POST',
    '/api/v1/tools/google-calendar/create-event',
    { approvalId: created.approvalId, payload: created.canonicalPayload },
    {},
    undefined,
    {},
    service,
  );
  assert.equal(calledGoogle, true);
  assert.equal(executed.status, 200);
  const result = executed.data as Record<string, unknown>;
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.externalId, 'gcal_evt_ui');
  assert.equal(result.externalUrl, 'https://calendar.google.com/event?eid=ui');
  assert.equal(typeof result.executionId, 'string');

  // Step 10: replay is a conflict, not a silent success, and must not retry.
  const replay = await handleAsyncApiRequest(
    'POST',
    '/api/v1/tools/google-calendar/create-event',
    { approvalId: created.approvalId, payload: created.canonicalPayload },
    {},
    undefined,
    {},
    service,
  );
  assert.notEqual(replay.status, 200);
  const replayCode = (replay.data as { error: { code: string } }).error.code;
  assert.equal(replayCode, 'APPROVAL_ALREADY_CONSUMED');
  assert.equal(view.describeExecutionError(replayCode), 'This approval has already been used.');
});

test('rejected approval blocks execution end to end (Reject button flow)', async () => {
  const mockFetch: typeof fetch = async () => { throw new Error('must never call Google after rejection'); };
  const { service } = buildIsolatedHarness(mockFetch);

  const created = service.requestCreateEventApproval({ tenantId: 'ten_production_01', principalId: 'usr_admin_001', payload: validPayload(), requestId: 'req_1' });
  const rejected = service.reject(created.approvalId, 'usr_admin_001', 'req_2');
  assert.equal(rejected.status, 'REJECTED');
  assert.equal(typeof rejected.rejectedAt, 'string');

  const executed = await handleAsyncApiRequest(
    'POST',
    '/api/v1/tools/google-calendar/create-event',
    { approvalId: created.approvalId, payload: created.canonicalPayload },
    {},
    undefined,
    {},
    service,
  );
  assert.notEqual(executed.status, 200);
  assert.equal((executed.data as { error: { code: string } }).error.code, 'APPROVAL_NOT_GRANTED');
});

test('expired approval blocks execution end to end (countdown reaching zero)', async () => {
  const mockFetch: typeof fetch = async () => { throw new Error('must never call Google after expiry'); };
  let clock = Date.now();
  const { service } = buildIsolatedHarness(mockFetch, () => clock, 50);

  const created = service.requestCreateEventApproval({ tenantId: 'ten_production_01', principalId: 'usr_admin_001', payload: validPayload(), requestId: 'req_1' });
  clock += 1000; // past the 50ms TTL

  assert.throws(() => service.approve(created.approvalId, 'usr_admin_001', 'req_2'), /expired/i);

  const executed = await handleAsyncApiRequest(
    'POST',
    '/api/v1/tools/google-calendar/create-event',
    { approvalId: created.approvalId, payload: created.canonicalPayload },
    {},
    undefined,
    {},
    service,
  );
  assert.notEqual(executed.status, 200);
  assert.equal((executed.data as { error: { code: string } }).error.code, 'APPROVAL_EXPIRED');
});

// ── Ambient Assistant markup wiring ─────────────────────────────────────────

test('the Ambient Assistant page serves the approval-card view module and its DOM containers', async () => {
  const { server } = await import('../src/server_web.js');
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const origin = `http://127.0.0.1:${port}`;
    const html = await (await fetch(`${origin}/`)).text();
    assert.match(html, /src="calendar-approval-view\.js\?v=/);
    assert.match(html, /id="ambient-flow-stepper"/);
    assert.match(html, /id="ambient-timeline"/);
    assert.match(html, /id="ambient-timeline-list"/);

    const appJs = await (await fetch(`${origin}/app.js`)).text();
    assert.match(appJs, /api\/v1\/approvals/);
    assert.match(appJs, /\/approve/);
    assert.match(appJs, /\/reject/);
    assert.match(appJs, /api\/v1\/tools\/google-calendar\/create-event/);
    assert.match(appJs, /Creating calendar event\.\.\./);

    const viewJs = await (await fetch(`${origin}/calendar-approval-view.js`)).text();
    assert.equal(viewJs.length > 0, true);
    assert.equal((await fetch(`${origin}/calendar-approval-view.js`)).headers.get('cache-control'), 'no-store, no-cache, must-revalidate');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

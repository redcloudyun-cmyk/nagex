import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemoryGoogleOAuthTokenStore,
  googleTokenStore as sharedGoogleTokenStore,
  DEFAULT_GOOGLE_TENANT_ID,
} from '../src/integrations/google/token.store.js';
import { GOOGLE_CALENDAR_SCOPES, type GoogleOAuthConfig } from '../src/integrations/google/oauth.client.js';
import { ActionApprovalStore, hashCanonicalPayload } from '../src/governance/action-approval.store.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { MemoryEngine } from '../src/context/memory.engine.js';
import {
  GoogleCalendarService,
  GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID,
  GOOGLE_CALENDAR_UPDATE_EVENT_TOOL_ID,
  GOOGLE_CALENDAR_CANCEL_EVENT_TOOL_ID,
  GOOGLE_CALENDAR_RESPOND_EVENT_TOOL_ID,
} from '../src/modules/calendar/index.js';
import { toolRegistry as sharedToolRegistry } from '../src/tools/tool-registry.js';
import { handleApiRequest, handleAsyncApiRequest, actionApprovals as sharedActionApprovals } from '../src/server_web.js';
import { AiService } from '../src/model-gateway/ai-service.js';
import type { ModelProvider } from '../src/model-gateway/model-provider.js';
import { UnifiedModelRouter } from '../src/model-gateway/unified-model-router.js';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const GRANTED_SCOPE_STRING = GOOGLE_CALENDAR_SCOPES.join(' ');
const config: GoogleOAuthConfig = { clientId: 'cid', clientSecret: 'csecret', redirectUri: 'https://nagex-test.agex.site/api/v1/oauth/google/callback' };

function buildHarness(fetchFn: typeof fetch, now: () => number = Date.now) {
  const tokenStore = new InMemoryGoogleOAuthTokenStore();
  const approvals = new ActionApprovalStore(now);
  const audit = new AuditLogger();
  const memory = new MemoryEngine();
  const service = new GoogleCalendarService(tokenStore, approvals, audit, memory, fetchFn, () => config);
  return { tokenStore, approvals, audit, memory, service };
}

function updatePayload(overrides: Record<string, unknown> = {}) {
  return { calendarId: 'primary', eventId: 'evt_123', summary: 'Client Strategy Sync (rescheduled)', ...overrides };
}

function cancelPayload(overrides: Record<string, unknown> = {}) {
  return { calendarId: 'primary', eventId: 'evt_123', summary: 'Client Strategy Sync', ...overrides };
}

function respondPayload(overrides: Record<string, unknown> = {}) {
  return { calendarId: 'primary', eventId: 'evt_123', responseStatus: 'accepted', summary: 'Client Strategy Sync', ...overrides };
}

// ── tool live/disconnected for the new tool IDs ─────────────────────────────

test('update/cancel/respond tools report disconnected/unavailable with no OAuth connection', () => {
  sharedGoogleTokenStore.clear(DEFAULT_GOOGLE_TENANT_ID);
  for (const toolId of [GOOGLE_CALENDAR_UPDATE_EVENT_TOOL_ID, GOOGLE_CALENDAR_CANCEL_EVENT_TOOL_ID, GOOGLE_CALENDAR_RESPOND_EVENT_TOOL_ID]) {
    const resolution = sharedToolRegistry.resolve(toolId);
    assert.equal(resolution.connectionStatus, 'disconnected');
    assert.equal(resolution.executionMode, 'unavailable');
  }
});

test('update/cancel/respond tools go LIVE with the same Calendar connection create_event already uses', () => {
  sharedGoogleTokenStore.save(DEFAULT_GOOGLE_TENANT_ID, { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: GRANTED_SCOPE_STRING });
  try {
    for (const toolId of [GOOGLE_CALENDAR_UPDATE_EVENT_TOOL_ID, GOOGLE_CALENDAR_CANCEL_EVENT_TOOL_ID, GOOGLE_CALENDAR_RESPOND_EVENT_TOOL_ID]) {
      const resolution = sharedToolRegistry.resolve(toolId);
      assert.equal(resolution.connectionStatus, 'connected', `expected ${toolId} connected`);
      assert.equal(resolution.executionMode, 'live', `expected ${toolId} live`);
    }
    assert.equal(sharedToolRegistry.resolve(GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID).executionMode, 'live');
  } finally {
    sharedGoogleTokenStore.clear(DEFAULT_GOOGLE_TENANT_ID);
  }
});

test('cancel_event is IRREVERSIBLE_WRITE; update_event and respond_to_event are REVERSIBLE_WRITE — all three require approval', () => {
  sharedGoogleTokenStore.save(DEFAULT_GOOGLE_TENANT_ID, { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: GRANTED_SCOPE_STRING });
  try {
    assert.equal(sharedToolRegistry.resolve(GOOGLE_CALENDAR_CANCEL_EVENT_TOOL_ID).sideEffectLevel, 'IRREVERSIBLE_WRITE');
    assert.equal(sharedToolRegistry.resolve(GOOGLE_CALENDAR_UPDATE_EVENT_TOOL_ID).sideEffectLevel, 'REVERSIBLE_WRITE');
    assert.equal(sharedToolRegistry.resolve(GOOGLE_CALENDAR_RESPOND_EVENT_TOOL_ID).sideEffectLevel, 'REVERSIBLE_WRITE');
    for (const toolId of [GOOGLE_CALENDAR_UPDATE_EVENT_TOOL_ID, GOOGLE_CALENDAR_CANCEL_EVENT_TOOL_ID, GOOGLE_CALENDAR_RESPOND_EVENT_TOOL_ID]) {
      assert.equal(sharedToolRegistry.resolve(toolId).requiresApproval, true);
    }
  } finally {
    sharedGoogleTokenStore.clear(DEFAULT_GOOGLE_TENANT_ID);
  }
});

// ── payload validation ──────────────────────────────────────────────────────

test('update payload validation: calendarId/eventId are required, at least one updatable field must be present, and timezone is required when start/end change', () => {
  const { service } = buildHarness(async () => { throw new Error('must not call Google'); });
  assert.throws(() => service.requestUpdateEventApproval({ tenantId: 't1', principalId: 'usr_1', payload: { calendarId: 'primary', eventId: 'evt_1' }, requestId: 'req_1' }), (err: unknown) => (err as { code: string }).code === 'CALENDAR_UPDATE_EMPTY');
  assert.throws(() => service.requestUpdateEventApproval({ tenantId: 't1', principalId: 'usr_1', payload: { calendarId: 'primary', eventId: 'evt_1', start: '2026-10-01T18:00:00.000Z' }, requestId: 'req_1' }), (err: unknown) => (err as { code: string }).code === 'CALENDAR_UPDATE_TIMEZONE_REQUIRED');
  assert.throws(() => service.requestUpdateEventApproval({ tenantId: 't1', principalId: 'usr_1', payload: { eventId: 'evt_1', summary: 'x' }, requestId: 'req_1' }), (err: unknown) => (err as { code: string }).code === 'INVALID_CALENDAR_UPDATE_PAYLOAD');
  const ok = service.requestUpdateEventApproval({ tenantId: 't1', principalId: 'usr_1', payload: updatePayload(), requestId: 'req_2' });
  assert.equal(ok.status, 'PENDING');
});

test('cancel payload validation: calendarId, eventId, and a non-empty summary snapshot are required', () => {
  const { service } = buildHarness(async () => { throw new Error('must not call Google'); });
  assert.throws(() => service.requestCancelEventApproval({ tenantId: 't1', principalId: 'usr_1', payload: { calendarId: 'primary', eventId: 'evt_1' }, requestId: 'req_1' }), (err: unknown) => (err as { code: string }).code === 'INVALID_CALENDAR_CANCEL_PAYLOAD');
  const ok = service.requestCancelEventApproval({ tenantId: 't1', principalId: 'usr_1', payload: cancelPayload(), requestId: 'req_2' });
  assert.equal(ok.status, 'PENDING');
});

test('respond payload validation: responseStatus must be one of accepted/declined/tentative, and a summary snapshot is required', () => {
  const { service } = buildHarness(async () => { throw new Error('must not call Google'); });
  assert.throws(() => service.requestRespondToEventApproval({ tenantId: 't1', principalId: 'usr_1', payload: respondPayload({ responseStatus: 'maybe' }), requestId: 'req_1' }), (err: unknown) => (err as { code: string }).code === 'INVALID_CALENDAR_RESPOND_PAYLOAD');
  const ok = service.requestRespondToEventApproval({ tenantId: 't1', principalId: 'usr_1', payload: respondPayload(), requestId: 'req_2' });
  assert.equal(ok.status, 'PENDING');
});

// ── execution success ────────────────────────────────────────────────────────

test('execution success: update PATCHes the event and returns the updated htmlLink', async () => {
  let calledUrl = '';
  let calledMethod = '';
  const fetchFn: typeof fetch = async (url, init) => {
    calledUrl = String(url);
    calledMethod = String(init?.method);
    return jsonResponse({ id: 'evt_123', htmlLink: 'https://calendar.google.com/event?eid=updated' });
  };
  const { tokenStore, service } = buildHarness(fetchFn);
  tokenStore.save('t1', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: GRANTED_SCOPE_STRING });

  const created = service.requestUpdateEventApproval({ tenantId: 't1', principalId: 'usr_1', payload: updatePayload(), requestId: 'req_1' });
  service.approve(created.approvalId, 't1', 'usr_1', 'req_2');
  const result = await service.executeUpdateEvent({ approvalId: created.approvalId, payload: created.canonicalPayload, tenantId: 't1', principalId: 'usr_1', requestId: 'req_3' });

  assert.match(calledUrl, /\/calendar\/v3\/calendars\/primary\/events\/evt_123$/);
  assert.equal(calledMethod, 'PATCH');
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.externalId, 'evt_123');
  assert.equal(result.externalUrl, 'https://calendar.google.com/event?eid=updated');
});

test('execution success: cancel DELETEs the event (no body returned) and still yields a usable result', async () => {
  let calledMethod = '';
  const fetchFn: typeof fetch = async (url, init) => {
    calledMethod = String(init?.method);
    assert.match(String(url), /\/calendar\/v3\/calendars\/primary\/events\/evt_123$/);
    return new Response(null, { status: 204 });
  };
  const { tokenStore, service } = buildHarness(fetchFn);
  tokenStore.save('t1', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: GRANTED_SCOPE_STRING });

  const created = service.requestCancelEventApproval({ tenantId: 't1', principalId: 'usr_1', payload: cancelPayload(), requestId: 'req_1' });
  service.approve(created.approvalId, 't1', 'usr_1', 'req_2');
  const result = await service.executeCancelEvent({ approvalId: created.approvalId, payload: created.canonicalPayload, tenantId: 't1', principalId: 'usr_1', requestId: 'req_3' });

  assert.equal(calledMethod, 'DELETE');
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.externalId, 'evt_123');
  assert.match(result.externalUrl, /calendar\.google\.com/);
});

test('execution success: respond reads the event, updates only the self attendee, and PATCHes it back', async () => {
  let getCount = 0;
  let patchedBody: Record<string, unknown> | null = null;
  const fetchFn: typeof fetch = async (url, init) => {
    const method = init?.method || 'GET';
    if (method === 'GET') {
      getCount += 1;
      return jsonResponse({
        id: 'evt_123',
        attendees: [
          { email: 'organizer@example.com', self: false, responseStatus: 'accepted' },
          { email: 'me@example.com', self: true, responseStatus: 'needsAction' },
        ],
      });
    }
    patchedBody = JSON.parse(String(init?.body));
    return jsonResponse({ id: 'evt_123', htmlLink: 'https://calendar.google.com/event?eid=rsvp' });
  };
  const { tokenStore, service } = buildHarness(fetchFn);
  tokenStore.save('t1', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: GRANTED_SCOPE_STRING });

  const created = service.requestRespondToEventApproval({ tenantId: 't1', principalId: 'usr_1', payload: respondPayload({ responseStatus: 'declined' }), requestId: 'req_1' });
  service.approve(created.approvalId, 't1', 'usr_1', 'req_2');
  const result = await service.executeRespondToEvent({ approvalId: created.approvalId, payload: created.canonicalPayload, tenantId: 't1', principalId: 'usr_1', requestId: 'req_3' });

  assert.equal(getCount, 1);
  assert.equal(result.status, 'SUCCEEDED');
  const attendees = (patchedBody as unknown as { attendees: Array<{ email: string; self: boolean; responseStatus: string }> }).attendees;
  assert.equal(attendees.find((a) => a.self)?.responseStatus, 'declined');
  assert.equal(attendees.find((a) => !a.self)?.responseStatus, 'accepted'); // other attendees are never touched
});

test('respond fails closed when the connected account is not an attendee on the event', async () => {
  const fetchFn: typeof fetch = async () => jsonResponse({ id: 'evt_123', attendees: [{ email: 'someone-else@example.com', self: false, responseStatus: 'accepted' }] });
  const { tokenStore, service } = buildHarness(fetchFn);
  tokenStore.save('t1', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: GRANTED_SCOPE_STRING });

  const created = service.requestRespondToEventApproval({ tenantId: 't1', principalId: 'usr_1', payload: respondPayload(), requestId: 'req_1' });
  service.approve(created.approvalId, 't1', 'usr_1', 'req_2');
  await assert.rejects(
    () => service.executeRespondToEvent({ approvalId: created.approvalId, payload: created.canonicalPayload, tenantId: 't1', principalId: 'usr_1', requestId: 'req_3' }),
    (err: unknown) => (err as { code: string }).code === 'GOOGLE_CALENDAR_NOT_AN_ATTENDEE',
  );
});

// ── fail closed: mutation, expiry, rejection, replay, wrong tool, disconnected ──

test('modified payload rejection: executing update with a changed field is rejected even with a valid approval', async () => {
  const { tokenStore, service } = buildHarness(async () => { throw new Error('must not reach Google with a tampered payload'); });
  tokenStore.save('t1', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: GRANTED_SCOPE_STRING });

  const created = service.requestUpdateEventApproval({ tenantId: 't1', principalId: 'usr_1', payload: updatePayload(), requestId: 'req_1' });
  service.approve(created.approvalId, 't1', 'usr_1', 'req_2');
  const tampered = { ...created.canonicalPayload, summary: 'Something else entirely' };
  await assert.rejects(
    () => service.executeUpdateEvent({ approvalId: created.approvalId, payload: tampered, tenantId: 't1', principalId: 'usr_1', requestId: 'req_3' }),
    (err: unknown) => (err as { code: string }).code === 'APPROVAL_PAYLOAD_MISMATCH',
  );
});

test('expired approval rejection: an approval past its TTL cannot be approved', () => {
  let clock = Date.now();
  const { service } = buildHarness(async () => { throw new Error('must not reach Google'); }, () => clock);
  const created = service.requestCancelEventApproval({ tenantId: 't1', principalId: 'usr_1', payload: cancelPayload(), requestId: 'req_1' });
  clock += 16 * 60 * 1000;
  assert.throws(() => service.approve(created.approvalId, 't1', 'usr_1', 'req_2'), (err: unknown) => (err as { code: string }).code === 'APPROVAL_EXPIRED');
});

test('rejected approval rejection: a REJECTED approval can never be executed', async () => {
  const { tokenStore, service } = buildHarness(async () => { throw new Error('must not reach Google'); });
  tokenStore.save('t1', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: GRANTED_SCOPE_STRING });
  const created = service.requestCancelEventApproval({ tenantId: 't1', principalId: 'usr_1', payload: cancelPayload(), requestId: 'req_1' });
  service.reject(created.approvalId, 't1', 'usr_1', 'req_2');
  await assert.rejects(
    () => service.executeCancelEvent({ approvalId: created.approvalId, payload: created.canonicalPayload, tenantId: 't1', principalId: 'usr_1', requestId: 'req_3' }),
    (err: unknown) => (err as { code: string }).code === 'APPROVAL_NOT_GRANTED',
  );
});

test('replay rejection: the same approval cannot cancel the event twice', async () => {
  const fetchFn: typeof fetch = async () => new Response(null, { status: 204 });
  const { tokenStore, service } = buildHarness(fetchFn);
  tokenStore.save('t1', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: GRANTED_SCOPE_STRING });
  const created = service.requestCancelEventApproval({ tenantId: 't1', principalId: 'usr_1', payload: cancelPayload(), requestId: 'req_1' });
  service.approve(created.approvalId, 't1', 'usr_1', 'req_2');

  const first = await service.executeCancelEvent({ approvalId: created.approvalId, payload: created.canonicalPayload, tenantId: 't1', principalId: 'usr_1', requestId: 'req_3' });
  assert.equal(first.status, 'SUCCEEDED');

  await assert.rejects(
    () => service.executeCancelEvent({ approvalId: created.approvalId, payload: created.canonicalPayload, tenantId: 't1', principalId: 'usr_1', requestId: 'req_4' }),
    (err: unknown) => (err as { code: string }).code === 'APPROVAL_ALREADY_CONSUMED',
  );
});

test('wrong tool rejection: an update-approved record cannot execute a cancel, and vice versa', async () => {
  const { tokenStore, service } = buildHarness(async () => { throw new Error('must not reach Google'); });
  tokenStore.save('t1', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: GRANTED_SCOPE_STRING });
  const created = service.requestUpdateEventApproval({ tenantId: 't1', principalId: 'usr_1', payload: updatePayload(), requestId: 'req_1' });
  service.approve(created.approvalId, 't1', 'usr_1', 'req_2');
  await assert.rejects(
    () => service.executeCancelEvent({ approvalId: created.approvalId, payload: cancelPayload(), tenantId: 't1', principalId: 'usr_1', requestId: 'req_3' }),
    (err: unknown) => (err as { code: string }).code === 'APPROVAL_TOOL_MISMATCH',
  );
});

test('disconnected OAuth: execution is refused even with a valid, matching, approved payload', async () => {
  const { service } = buildHarness(async () => { throw new Error('must not reach Google when disconnected'); });
  const created = service.requestUpdateEventApproval({ tenantId: 't1', principalId: 'usr_1', payload: updatePayload(), requestId: 'req_1' });
  service.approve(created.approvalId, 't1', 'usr_1', 'req_2');
  await assert.rejects(
    () => service.executeUpdateEvent({ approvalId: created.approvalId, payload: created.canonicalPayload, tenantId: 't1', principalId: 'usr_1', requestId: 'req_3' }),
    (err: unknown) => (err as { code: string }).code === 'GOOGLE_CALENDAR_DISCONNECTED',
  );
});

// ── audit ────────────────────────────────────────────────────────────────────

test('audit: every stage of the approval + execution lifecycle is logged for update_event', async () => {
  const fetchFn: typeof fetch = async () => jsonResponse({ id: 'evt_123', htmlLink: 'https://calendar.google.com/event?eid=audit' });
  const { tokenStore, service, audit } = buildHarness(fetchFn);
  tokenStore.save('t1', { accessToken: 'super-secret-token', refreshToken: 'super-secret-refresh', expiresAt: Date.now() + 3600_000, scope: GRANTED_SCOPE_STRING });

  const created = service.requestUpdateEventApproval({ tenantId: 't1', principalId: 'usr_1', payload: updatePayload(), requestId: 'req_1' });
  service.approve(created.approvalId, 't1', 'usr_1', 'req_2');
  await service.executeUpdateEvent({ approvalId: created.approvalId, payload: created.canonicalPayload, tenantId: 't1', principalId: 'usr_1', requestId: 'req_3' });

  const actions = audit.getRecentLogs(10).map((e) => e.action).reverse();
  assert.deepEqual(actions, ['approval.requested', 'approval.approved', 'tool.execution.started', 'tool.execution.succeeded']);
  const serialized = JSON.stringify(audit.getRecentLogs(10));
  assert.doesNotMatch(serialized, /super-secret-token|super-secret-refresh/);
});

// ── full HTTP flow ───────────────────────────────────────────────────────────

test('full flow through the real HTTP routes: request -> approve -> cancel-event -> replay rejected', async () => {
  const payload = cancelPayload();
  let calledCancel = false;
  const mockFetch: typeof fetch = async (url, init) => {
    calledCancel = true;
    assert.match(String(url), /\/calendar\/v3\/calendars\/primary\/events\/evt_123$/);
    assert.equal(init?.method, 'DELETE');
    return new Response(null, { status: 204 });
  };
  const testConfig: GoogleOAuthConfig = { clientId: 'x', clientSecret: 'y', redirectUri: 'https://nagex-test.agex.site/api/v1/oauth/google/callback' };
  const testCalendarService = new GoogleCalendarService(sharedGoogleTokenStore, sharedActionApprovals, new AuditLogger(), new MemoryEngine(), mockFetch, () => testConfig);

  sharedGoogleTokenStore.save(DEFAULT_GOOGLE_TENANT_ID, { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: GRANTED_SCOPE_STRING });
  try {
    const created = handleApiRequest('POST', '/api/v1/approvals', { toolId: GOOGLE_CALENDAR_CANCEL_EVENT_TOOL_ID, payload });
    assert.equal(created.status, 201);
    const approvalId = (created.data as Record<string, unknown>).approvalId as string;

    const fetched = handleApiRequest('GET', `/api/v1/approvals/${approvalId}`, null);
    assert.equal(fetched.status, 200);
    assert.equal((fetched.data as Record<string, unknown>).toolId, GOOGLE_CALENDAR_CANCEL_EVENT_TOOL_ID);

    const approved = handleApiRequest('POST', `/api/v1/approvals/${approvalId}/approve`, null);
    assert.equal(approved.status, 200);

    const executed = await handleAsyncApiRequest('POST', '/api/v1/tools/google-calendar/cancel-event', { approvalId, payload }, {}, undefined, {}, testCalendarService);
    assert.equal(calledCancel, true);
    assert.equal(executed.status, 200);
    assert.equal((executed.data as Record<string, unknown>).status, 'SUCCEEDED');

    const replay = await handleAsyncApiRequest('POST', '/api/v1/tools/google-calendar/cancel-event', { approvalId, payload }, {}, undefined, {}, testCalendarService);
    assert.notEqual(replay.status, 200);
    assert.equal((replay.data as { error: { code: string } }).error.code, 'APPROVAL_ALREADY_CONSUMED');
  } finally {
    sharedGoogleTokenStore.clear(DEFAULT_GOOGLE_TENANT_ID);
  }
});

// ── task-triggered writes still respect approval ────────────────────────────

function buildCalendarPlanningService(): AiService {
  const provider: ModelProvider = {
    name: 'test',
    model: 'test-model',
    status: () => ({ configured: true, available: true, provider: 'test', model: 'test-model' }),
    generate: async (request) => ({
      text: JSON.stringify({
        goal: 'Cancel the strategy sync',
        summary: 'Cancel the client meeting.',
        reasoningSummary: 'A recurring task objective that involves cancelling a calendar event.',
        suggestions: [],
        steps: [{ title: 'Cancel event', reasoning: 'Client requested cancellation.', skill: 'Email Drafting', tool: 'google_calendar.cancel_event', requiresApproval: false, necessity: 'REQUIRED', dependsOn: [] }],
      }),
      provider: 'test',
      model: 'test-model',
      latencyMs: 1,
      requestId: request.requestId,
    }),
  };
  return new AiService(new UnifiedModelRouter([provider], { info: () => {}, warn: () => {} }));
}

test('task-triggered cancellation still respects approval: a scheduled task whose objective resolves to cancel_event never auto-cancels', async () => {
  const headers = { 'x-nagex-tenant': 'ten_production_01', 'x-principal-id': 'usr_calendar_task_test' };
  const created = handleApiRequest(
    'POST',
    '/api/v1/tasks',
    { name: 'Cancel strategy sync', objective: 'Cancel the client meeting.', type: 'ONE_TIME', trigger: { type: 'MANUAL' }, approvalPolicy: 'ALWAYS_APPROVE' },
    headers,
  );
  assert.equal(created.status, 201);
  const taskId = (created.data as { taskId: string }).taskId;

  const service = buildCalendarPlanningService();
  const runRes = await handleAsyncApiRequest('POST', `/api/v1/tasks/${taskId}/run`, {}, headers, service);
  assert.equal(runRes.status, 200);
  const run = runRes.data as { status: string; result: { kind: string; plan: { steps: Array<{ resolvedToolId: string | null; executionReadiness: string }> } } };
  assert.equal(run.status, 'SUCCEEDED');
  assert.equal(run.result.kind, 'PLAN_PREVIEW');

  const step = run.result.plan.steps[0];
  assert.equal(step.resolvedToolId, GOOGLE_CALENDAR_CANCEL_EVENT_TOOL_ID);
  assert.notEqual(step.executionReadiness, 'EXECUTION_READY');
});

// ── payload hash stability ──────────────────────────────────────────────────

test('payload hash stability: an identical update payload (regardless of key order) hashes the same', () => {
  const a = updatePayload();
  const b = { summary: a.summary, eventId: a.eventId, calendarId: a.calendarId };
  assert.equal(hashCanonicalPayload(a as unknown as Record<string, unknown>), hashCanonicalPayload(b as unknown as Record<string, unknown>));
});

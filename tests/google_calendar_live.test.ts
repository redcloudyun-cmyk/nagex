import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GoogleTokenStore } from '../src/integrations/google/token.store.js';
import { readGoogleOAuthConfig, exchangeGoogleAuthorizationCode, type GoogleOAuthConfig } from '../src/integrations/google/oauth.client.js';
import { ActionApprovalStore } from '../src/governance/action-approval.store.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { MemoryEngine } from '../src/context/memory.engine.js';
import { GoogleCalendarService, GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID, type NormalizedExecutionResult } from '../src/tools/google-calendar.service.js';
import { PlanResolver } from '../src/planning/plan-resolver.js';
import { skillRegistry } from '../src/skills/skill-registry.js';
import { googleTokenStore as sharedGoogleTokenStore } from '../src/integrations/google/token.store.js';
import { toolRegistry as sharedToolRegistry } from '../src/tools/tool-registry.js';
import { handleApiRequest, handleAsyncApiRequest } from '../src/server_web.js';
import type { PlanPreview } from '../src/model-gateway/ai-service.js';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const config: GoogleOAuthConfig = { clientId: 'cid', clientSecret: 'csecret', redirectUri: 'https://app.example/callback' };

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Client Strategy Sync',
    startTime: '2026-10-01T17:00:00.000Z',
    endTime: '2026-10-01T17:30:00.000Z',
    timezone: 'America/Los_Angeles',
    attendees: ['client@example.com'],
    description: 'Quarterly strategy discussion.',
    addMeetingLink: false,
    calendarId: 'primary',
    ...overrides,
  };
}

function buildHarness(fetchFn: typeof fetch, now: () => number = Date.now) {
  const tokenStore = new GoogleTokenStore();
  const approvals = new ActionApprovalStore(now);
  const audit = new AuditLogger();
  const memory = new MemoryEngine();
  const service = new GoogleCalendarService(tokenStore, approvals, audit, memory, fetchFn, () => config);
  return { tokenStore, approvals, audit, memory, service };
}

// ── OAuth disconnected / connected ──────────────────────────────────────────

test('OAuth disconnected: status reports not connected and no secrets are ever exposed', () => {
  const tokenStore = new GoogleTokenStore();
  const status = tokenStore.getStatus('ten_test');
  assert.equal(status.connected, false);
  assert.equal(status.scope, null);
  assert.equal(status.connectedAt, null);
  assert.equal((status as unknown as Record<string, unknown>).accessToken, undefined);
  assert.equal((status as unknown as Record<string, unknown>).refreshToken, undefined);
});

test('OAuth connected: a real token exchange stores the token server-side without leaking it in status', async () => {
  const fetchFn: typeof fetch = async () => jsonResponse({ access_token: 'at_123', refresh_token: 'rt_456', expires_in: 3600, scope: 'calendar.events calendar.freebusy' });
  const tokenStore = new GoogleTokenStore();
  const token = await exchangeGoogleAuthorizationCode(config, 'auth_code', fetchFn, 'req_oauth_1');
  tokenStore.save('ten_test', token);

  const status = tokenStore.getStatus('ten_test');
  assert.equal(status.connected, true);
  assert.equal(status.scope, 'calendar.events calendar.freebusy');
  assert.equal(typeof status.connectedAt, 'string');
  const serialized = JSON.stringify(status);
  assert.doesNotMatch(serialized, /at_123|rt_456/);
});

test('readGoogleOAuthConfig never reports configured from partial or missing env, and does not hardcode credentials', () => {
  assert.equal(readGoogleOAuthConfig({}), null);
  assert.equal(readGoogleOAuthConfig({ GOOGLE_CLIENT_ID: 'id-only' }), null);
  const full = readGoogleOAuthConfig({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret', GOOGLE_REDIRECT_URI: 'https://x/callback' });
  assert.deepEqual(full, { clientId: 'id', clientSecret: 'secret', redirectUri: 'https://x/callback' });
});

test('GET /api/v1/oauth/google/start fails closed with 503 when Google OAuth env vars are not set', () => {
  const result = handleApiRequest('GET', '/api/v1/oauth/google/start', null);
  assert.equal(result.status, 503);
  assert.equal((result.data as Record<string, unknown>).error, 'GOOGLE_OAUTH_NOT_CONFIGURED');
});

// ── live registry transition ────────────────────────────────────────────────

test('live registry transition: tool registry reports disconnected/unavailable, then connected/live, based on real OAuth state alone', () => {
  sharedGoogleTokenStore.clear('ten_production_01');
  const disconnected = sharedToolRegistry.resolve('Google Calendar');
  assert.equal(disconnected.connectionStatus, 'disconnected');
  assert.equal(disconnected.executionMode, 'unavailable');
  assert.equal(disconnected.availability, 'UNAVAILABLE');

  sharedGoogleTokenStore.save('ten_production_01', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: 'calendar.events' });
  const connected = sharedToolRegistry.resolve('Google Calendar');
  assert.equal(connected.connectionStatus, 'connected');
  assert.equal(connected.executionMode, 'live');
  assert.equal(connected.availability, 'AVAILABLE');

  const listed = sharedToolRegistry.list().find((tool) => tool.id === GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID);
  assert.equal(listed?.connectionStatus, 'connected');
  assert.equal(listed?.executionMode, 'live');

  sharedGoogleTokenStore.clear('ten_production_01'); // leave shared state clean for other tests
});

test('setting only GOOGLE_CLIENT_ID/SECRET env vars (no real OAuth connection) never flips the tool to live', () => {
  sharedGoogleTokenStore.clear('ten_production_01');
  process.env.GOOGLE_CLIENT_ID = 'unit-test-client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'unit-test-secret';
  process.env.GOOGLE_REDIRECT_URI = 'https://app.example/callback';
  try {
    const resolution = sharedToolRegistry.resolve('Google Calendar');
    assert.equal(resolution.executionMode, 'unavailable');
    assert.equal(resolution.connectionStatus, 'disconnected');
  } finally {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.GOOGLE_REDIRECT_URI;
  }
});

// ── approval required ───────────────────────────────────────────────────────

test('approval required: a live Google Calendar create-event step always resolves to APPROVAL_REQUIRED', () => {
  sharedGoogleTokenStore.save('ten_production_01', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: 'calendar.events' });
  try {
    const resolver = new PlanResolver(skillRegistry, sharedToolRegistry);
    const plan: PlanPreview = {
      goal: 'Schedule the client sync',
      summary: 'Create the event on the calendar.',
      reasoningSummary: 'Direct write action.',
      steps: [{ step: 1, title: 'Create calendar event', reasoning: 'Book the meeting.', skill: 'Scheduling', tool: 'Google Calendar', requiresApproval: false }],
    };
    const resolved = resolver.resolve(plan);
    assert.equal(resolved.status, 'APPROVAL_REQUIRED');
    assert.equal(resolved.steps[0].toolAvailability, 'AVAILABLE');
    assert.equal(resolved.steps[0].approvalRequired, true);
  } finally {
    sharedGoogleTokenStore.clear('ten_production_01');
  }
});

// ── ActionApprovalStore: modified payload / expired / replay ───────────────

test('modified payload rejection: consuming with a changed field is rejected even with a valid approval', () => {
  const approvals = new ActionApprovalStore();
  const record = approvals.request({ toolId: 'google_calendar.create_event', tenantId: 't1', principalId: 'u1', payload: validPayload() });
  approvals.approve(record.id);
  assert.throws(
    () => approvals.consume(record.id, 'google_calendar.create_event', validPayload({ title: 'A different meeting title' }), 'req_1'),
    (error: any) => error.code === 'APPROVAL_PAYLOAD_MISMATCH',
  );
});

test('expired approval rejection: an approval past its TTL cannot be approved or consumed', () => {
  let clock = 1_000_000;
  const approvals = new ActionApprovalStore(() => clock, 60_000); // 60s TTL
  const record = approvals.request({ toolId: 'google_calendar.create_event', tenantId: 't1', principalId: 'u1', payload: validPayload() });
  clock += 61_000;
  assert.throws(() => approvals.approve(record.id), (error: any) => error.code === 'APPROVAL_EXPIRED');
  assert.throws(
    () => approvals.consume(record.id, 'google_calendar.create_event', validPayload(), 'req_1'),
    (error: any) => error.code === 'APPROVAL_EXPIRED',
  );
});

test('replay rejection: the same approval cannot be consumed twice', () => {
  const approvals = new ActionApprovalStore();
  const record = approvals.request({ toolId: 'google_calendar.create_event', tenantId: 't1', principalId: 'u1', payload: validPayload() });
  approvals.approve(record.id);
  approvals.consume(record.id, 'google_calendar.create_event', validPayload(), 'req_1');
  assert.throws(
    () => approvals.consume(record.id, 'google_calendar.create_event', validPayload(), 'req_2'),
    (error: any) => error.code === 'APPROVAL_ALREADY_CONSUMED',
  );
});

// ── execution success / provider error / disconnected ───────────────────────

test('execution success: returns a normalized result and never fakes success without calling Google', async () => {
  let calledCreateEvent = false;
  const fetchFn: typeof fetch = async (url) => {
    if (String(url).includes('/calendar/v3/calendars/')) {
      calledCreateEvent = true;
      return jsonResponse({ id: 'gcal_evt_1', htmlLink: 'https://calendar.google.com/event?eid=abc' });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const { tokenStore, approvals, service } = buildHarness(fetchFn);
  tokenStore.save('t1', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: 'calendar.events' });
  const record = approvals.request({ toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID, tenantId: 't1', principalId: 'u1', payload: validPayload() });
  approvals.approve(record.id);

  const result: NormalizedExecutionResult = await service.executeCreateEvent({ approvalId: record.id, payload: validPayload(), tenantId: 't1', principalId: 'u1', requestId: 'req_exec_1' });

  assert.equal(calledCreateEvent, true);
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.toolId, GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID);
  assert.equal(result.externalId, 'gcal_evt_1');
  assert.equal(result.externalUrl, 'https://calendar.google.com/event?eid=abc');
  assert.equal(typeof result.executionId, 'string');
  assert.equal(typeof result.startedAt, 'string');
  assert.equal(typeof result.completedAt, 'string');
});

test('execution provider error: a failing Google API call rejects and never returns a fake success', async () => {
  const fetchFn: typeof fetch = async () => jsonResponse({ error: { message: 'insufficient scope' } }, 500);
  const { tokenStore, approvals, service, audit } = buildHarness(fetchFn);
  tokenStore.save('t1', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: 'calendar.events' });
  const record = approvals.request({ toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID, tenantId: 't1', principalId: 'u1', payload: validPayload() });
  approvals.approve(record.id);

  await assert.rejects(
    () => service.executeCreateEvent({ approvalId: record.id, payload: validPayload(), tenantId: 't1', principalId: 'u1', requestId: 'req_exec_2' }),
    (error: any) => error.code === 'GOOGLE_CALENDAR_HTTP_500',
  );

  const failed = audit.getRecentLogs(10).find((entry) => entry.action === 'tool:execution_failed');
  assert.ok(failed);
  assert.equal(failed?.reason_code, 'GOOGLE_CALENDAR_HTTP_500');
});

test('reject disconnected OAuth: execution is refused even with a valid, matching, approved payload', async () => {
  const fetchFn: typeof fetch = async () => { throw new Error('must not call Google when disconnected'); };
  const { approvals, service } = buildHarness(fetchFn); // tokenStore never connected
  const record = approvals.request({ toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID, tenantId: 't1', principalId: 'u1', payload: validPayload() });
  approvals.approve(record.id);

  await assert.rejects(
    () => service.executeCreateEvent({ approvalId: record.id, payload: validPayload(), tenantId: 't1', principalId: 'u1', requestId: 'req_exec_3' }),
    (error: any) => error.code === 'GOOGLE_CALENDAR_DISCONNECTED',
  );
});

test('unapproved execution attempts never reach Google: pending and rejected approvals are refused', async () => {
  const fetchFn: typeof fetch = async () => { throw new Error('must not call Google without a granted approval'); };
  const { tokenStore, approvals, service } = buildHarness(fetchFn);
  tokenStore.save('t1', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: 'calendar.events' });

  const pending = approvals.request({ toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID, tenantId: 't1', principalId: 'u1', payload: validPayload() });
  await assert.rejects(
    () => service.executeCreateEvent({ approvalId: pending.id, payload: validPayload(), tenantId: 't1', principalId: 'u1', requestId: 'req_pending' }),
    (error: any) => error.code === 'APPROVAL_NOT_GRANTED',
  );

  const rejected = approvals.request({ toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID, tenantId: 't1', principalId: 'u1', payload: validPayload() });
  approvals.reject(rejected.id);
  await assert.rejects(
    () => service.executeCreateEvent({ approvalId: rejected.id, payload: validPayload(), tenantId: 't1', principalId: 'u1', requestId: 'req_rejected' }),
    (error: any) => error.code === 'APPROVAL_NOT_GRANTED',
  );
});

// ── audit + memory ───────────────────────────────────────────────────────────

test('audit event creation: every stage of the approval + execution lifecycle is logged, tokens are never logged', async () => {
  const fetchFn: typeof fetch = async () => jsonResponse({ id: 'gcal_evt_audit', htmlLink: 'https://calendar.google.com/event?eid=audit' });
  const { tokenStore, service, audit, approvals } = buildHarness(fetchFn);
  tokenStore.save('t1', { accessToken: 'super-secret-access-token', refreshToken: 'super-secret-refresh-token', expiresAt: Date.now() + 3600_000, scope: 'calendar.events' });

  const requested = service.requestCreateEventApproval({ tenantId: 't1', principalId: 'u1', payload: validPayload(), requestId: 'req_audit_1' });
  service.approve(requested.id, 'u1', 'req_audit_2');
  await service.executeCreateEvent({ approvalId: requested.id, payload: validPayload(), tenantId: 't1', principalId: 'u1', requestId: 'req_audit_3' });

  const logs = audit.getRecentLogs(20);
  const actions = logs.map((entry) => entry.action);
  assert.ok(actions.includes('approval:requested'));
  assert.ok(actions.includes('approval:granted'));
  assert.ok(actions.includes('tool:execution_started'));
  assert.ok(actions.includes('tool:execution_succeeded'));

  const succeeded = logs.find((entry) => entry.action === 'tool:execution_succeeded');
  assert.equal((succeeded?.details as Record<string, unknown> | undefined)?.externalEventId, 'gcal_evt_audit');

  const serializedLogs = JSON.stringify(logs);
  assert.doesNotMatch(serializedLogs, /super-secret-access-token|super-secret-refresh-token/);
  void approvals;
});

test('memory update after success: writes a scheduling memory without persisting attendee emails', async () => {
  const fetchFn: typeof fetch = async () => jsonResponse({ id: 'gcal_evt_mem', htmlLink: 'https://calendar.google.com/event?eid=mem' });
  const { tokenStore, approvals, service, memory } = buildHarness(fetchFn);
  tokenStore.save('t1', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: 'calendar.events' });
  const record = approvals.request({ toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID, tenantId: 't1', principalId: 'usr_mem_test', payload: validPayload({ attendees: ['secret-attendee@example.com'] }) });
  approvals.approve(record.id);

  await service.executeCreateEvent({ approvalId: record.id, payload: validPayload({ attendees: ['secret-attendee@example.com'] }), tenantId: 't1', principalId: 'usr_mem_test', requestId: 'req_mem_1' });

  const memories = memory.getActiveMemories('USER', 'usr_mem_test');
  assert.equal(memories.length, 1);
  assert.match(String(memories[0].content.value), /Scheduled "Client Strategy Sync" on/);
  assert.doesNotMatch(JSON.stringify(memories[0]), /secret-attendee@example\.com/);
});

// ── HTTP-level wiring ────────────────────────────────────────────────────────

test('POST /api/v1/tools/google-calendar/approvals then create-event round-trips through the real server routes', async () => {
  sharedGoogleTokenStore.save('ten_production_01', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: 'calendar.events' });
  try {
    const created = handleApiRequest('POST', '/api/v1/tools/google-calendar/approvals', { payload: validPayload() });
    assert.equal(created.status, 201);
    const approvalId = (created.data as Record<string, unknown>).id as string;

    const approved = handleApiRequest('POST', `/api/v1/tools/google-calendar/approvals/${approvalId}/action`, { action: 'APPROVE' });
    assert.equal(approved.status, 200);

    // No live Google credentials in this environment, so this exercises the
    // real fail-closed path (disconnected/refresh-failure) rather than a real
    // Google call — it must not report a fake SUCCESS.
    const executed = await handleAsyncApiRequest('POST', '/api/v1/tools/google-calendar/create-event', { approvalId, payload: validPayload() });
    assert.notEqual(executed.status, 200);
  } finally {
    sharedGoogleTokenStore.clear('ten_production_01');
  }
});

test('GET /api/v1/oauth/google/callback exchanges a valid code+state and redirects connected', async () => {
  process.env.GOOGLE_CLIENT_ID = 'cb-client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'cb-secret';
  process.env.GOOGLE_REDIRECT_URI = 'https://app.example/callback';
  const originalFetch = global.fetch;
  global.fetch = (async () => jsonResponse({ access_token: 'cb_at', refresh_token: 'cb_rt', expires_in: 3600, scope: 'calendar.events calendar.freebusy' })) as typeof fetch;

  try {
    const started = handleApiRequest('GET', '/api/v1/oauth/google/start', null);
    assert.equal(started.status, 200);
    const authorizeUrl = new URL((started.data as Record<string, string>).authorizeUrl);
    const state = authorizeUrl.searchParams.get('state') as string;

    const callback = await handleAsyncApiRequest('GET', '/api/v1/oauth/google/callback', null, {}, undefined, { code: 'auth_code_123', state });
    assert.equal(callback.status, 302);
    assert.equal(callback.redirectTo, '/?oauth=google&status=connected');
    assert.equal(sharedGoogleTokenStore.isConnected('ten_production_01'), true);
  } finally {
    global.fetch = originalFetch;
    sharedGoogleTokenStore.clear('ten_production_01');
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.GOOGLE_REDIRECT_URI;
  }
});

test('GET /api/v1/oauth/google/callback rejects a state that does not match the pending request', async () => {
  process.env.GOOGLE_CLIENT_ID = 'cb-client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'cb-secret';
  process.env.GOOGLE_REDIRECT_URI = 'https://app.example/callback';
  try {
    handleApiRequest('GET', '/api/v1/oauth/google/start', null);
    const callback = await handleAsyncApiRequest('GET', '/api/v1/oauth/google/callback', null, {}, undefined, { code: 'auth_code_123', state: 'not-the-real-state' });
    assert.equal(callback.status, 302);
    assert.equal(callback.redirectTo, '/?oauth=google&status=error');
    assert.equal(sharedGoogleTokenStore.isConnected('ten_production_01'), false);
  } finally {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.GOOGLE_REDIRECT_URI;
  }
});

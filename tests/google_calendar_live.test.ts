import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemoryGoogleOAuthTokenStore,
  googleTokenStore as sharedGoogleTokenStore,
  DEFAULT_GOOGLE_TENANT_ID,
} from '../src/integrations/google/token.store.js';
import {
  readGoogleOAuthConfig,
  exchangeGoogleAuthorizationCode,
  GOOGLE_CALENDAR_SCOPES,
  GMAIL_SCOPES,
  GOOGLE_OAUTH_SCOPES,
  type GoogleOAuthConfig,
} from '../src/integrations/google/oauth.client.js';
import { queryFreeBusy, computeFreeSlots } from '../src/modules/calendar/index.js';
import { ActionApprovalStore, hashCanonicalPayload } from '../src/governance/action-approval.store.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { MemoryEngine } from '../src/context/memory.engine.js';
import { GoogleCalendarService, GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID, type NormalizedExecutionResult } from '../src/modules/calendar/index.js';
import { PlanResolver } from '../src/planning/plan-resolver.js';
import { skillRegistry } from '../src/skills/skill-registry.js';
import { toolRegistry as sharedToolRegistry } from '../src/tools/tool-registry.js';
import { handleApiRequest, handleAsyncApiRequest, actionApprovals as sharedActionApprovals } from '../src/server_web.js';
import type { PlanPreview } from '../src/model-gateway/ai-service.js';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const GRANTED_SCOPE_STRING = GOOGLE_CALENDAR_SCOPES.join(' ');
const config: GoogleOAuthConfig = { clientId: 'cid', clientSecret: 'csecret', redirectUri: 'https://nagex-test.agex.site/api/v1/oauth/google/callback' };

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    calendarId: 'primary',
    summary: 'Client Strategy Sync',
    description: 'Quarterly strategy discussion.',
    start: '2026-10-01T17:00:00.000Z',
    end: '2026-10-01T17:30:00.000Z',
    timezone: 'America/Los_Angeles',
    attendees: ['client@example.com'],
    conferenceData: false,
    ...overrides,
  };
}

function buildHarness(fetchFn: typeof fetch, now: () => number = Date.now) {
  const tokenStore = new InMemoryGoogleOAuthTokenStore();
  const approvals = new ActionApprovalStore(now);
  const audit = new AuditLogger();
  const memory = new MemoryEngine();
  const service = new GoogleCalendarService(tokenStore, approvals, audit, memory, fetchFn, () => config);
  return { tokenStore, approvals, audit, memory, service };
}

async function withEnv<T>(env: Record<string, string>, fn: () => T | Promise<T>): Promise<T> {
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(env)) delete process.env[key];
  }
}

// ── OAuth disconnected / connected ──────────────────────────────────────────

test('OAuth disconnected: status reports not connected and no secrets are ever exposed', () => {
  const tokenStore = new InMemoryGoogleOAuthTokenStore();
  const status = tokenStore.getStatus('ten_test');
  assert.equal(status.connected, false);
  assert.deepEqual(status.scopes, []);
  assert.equal(status.expiresAt, null);
  assert.equal((status as unknown as Record<string, unknown>).accessToken, undefined);
  assert.equal((status as unknown as Record<string, unknown>).refreshToken, undefined);
});

test('OAuth connected: a real token exchange stores the token server-side without leaking it in status', async () => {
  const fetchFn: typeof fetch = async () => jsonResponse({ access_token: 'at_123', refresh_token: 'rt_456', expires_in: 3600, scope: GRANTED_SCOPE_STRING });
  const tokenStore = new InMemoryGoogleOAuthTokenStore();
  const token = await exchangeGoogleAuthorizationCode(config, 'auth_code', fetchFn, 'req_oauth_1');
  tokenStore.save('ten_test', token);

  const status = tokenStore.getStatus('ten_test');
  assert.equal(status.connected, true);
  assert.deepEqual(status.scopes, GOOGLE_CALENDAR_SCOPES.slice());
  assert.equal(typeof status.expiresAt, 'string');
  assert.ok(new Date(status.expiresAt as string).getTime() > Date.now());
  const serialized = JSON.stringify(status);
  assert.doesNotMatch(serialized, /at_123|rt_456/);
});

test('readGoogleOAuthConfig never reports configured from partial or missing env, and does not hardcode credentials', () => {
  assert.equal(readGoogleOAuthConfig({}), null);
  assert.equal(readGoogleOAuthConfig({ GOOGLE_CLIENT_ID: 'id-only' }), null);
  const full = readGoogleOAuthConfig({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret', GOOGLE_REDIRECT_URI: 'https://x/callback' });
  assert.deepEqual(full, { clientId: 'id', clientSecret: 'secret', redirectUri: 'https://x/callback' });
});

test('GET /api/v1/oauth/google/status reports configured=false and connected=false when nothing is set up', async () => {
  sharedGoogleTokenStore.clear(DEFAULT_GOOGLE_TENANT_ID);
  const result = await handleAsyncApiRequest('GET', '/api/v1/oauth/google/status', null);
  assert.equal(result.status, 200);
  const data = result.data as Record<string, unknown>;
  assert.equal(data.configured, false);
  assert.equal(data.connected, false);
});

test('GET /api/v1/oauth/google/start and /start-url fail closed with 503 when Google OAuth env vars are not set', () => {
  const start = handleApiRequest('GET', '/api/v1/oauth/google/start', null);
  assert.equal(start.status, 503);
  assert.equal((start.data as Record<string, unknown>).error, 'GOOGLE_OAUTH_NOT_CONFIGURED');

  const startUrl = handleApiRequest('GET', '/api/v1/oauth/google/start-url', null);
  assert.equal(startUrl.status, 503);
  assert.equal((startUrl.data as Record<string, unknown>).error, 'GOOGLE_OAUTH_NOT_CONFIGURED');
});

// ── OAuth start: real 302 browser redirect ──────────────────────────────────

test('OAuth start URL: GET /api/v1/oauth/google/start redirects (302) straight to Google, never as JSON', async () => {
  await withEnv({ GOOGLE_CLIENT_ID: 'redir-client', GOOGLE_CLIENT_SECRET: 'redir-secret', GOOGLE_REDIRECT_URI: 'https://nagex-test.agex.site/api/v1/oauth/google/callback' }, () => {
    const result = handleApiRequest('GET', '/api/v1/oauth/google/start', null);

    assert.equal(result.status, 302);
    assert.equal(result.data, null);
    assert.equal(typeof result.redirectTo, 'string');

    const location = new URL(result.redirectTo as string);
    assert.equal(`${location.protocol}//${location.host}`, 'https://accounts.google.com');

    const state = location.searchParams.get('state');
    assert.equal(typeof state, 'string');
    assert.ok((state as string).length > 0);

    assert.equal(location.searchParams.get('redirect_uri'), 'https://nagex-test.agex.site/api/v1/oauth/google/callback');
    assert.equal(location.searchParams.get('access_type'), 'offline');
    assert.equal(location.searchParams.get('prompt'), 'consent');
    assert.equal(location.searchParams.get('include_granted_scopes'), 'true');

    const grantedScopes = (location.searchParams.get('scope') || '').split(' ');
    for (const scope of GOOGLE_CALENDAR_SCOPES) {
      assert.ok(grantedScopes.includes(scope), `missing calendar scope: ${scope}`);
    }
    for (const scope of GMAIL_SCOPES) {
      assert.ok(grantedScopes.includes(scope), `missing gmail scope: ${scope}`);
    }
    // One Google connection covers both Calendar and Gmail — the exact
    // union, no more and no fewer scopes than that.
    assert.equal(grantedScopes.length, GOOGLE_OAUTH_SCOPES.length);
  });
});

test('OAuth start-url (debug/API endpoint): returns the same authorize URL as JSON instead of redirecting', async () => {
  await withEnv({ GOOGLE_CLIENT_ID: 'redir-client', GOOGLE_CLIENT_SECRET: 'redir-secret', GOOGLE_REDIRECT_URI: 'https://nagex-test.agex.site/api/v1/oauth/google/callback' }, () => {
    const result = handleApiRequest('GET', '/api/v1/oauth/google/start-url', null);
    assert.equal(result.status, 200);
    const authorizeUrl = new URL((result.data as Record<string, string>).authorizeUrl);
    assert.equal(`${authorizeUrl.protocol}//${authorizeUrl.host}`, 'https://accounts.google.com');
    assert.equal(authorizeUrl.searchParams.get('access_type'), 'offline');
    assert.equal(authorizeUrl.searchParams.get('prompt'), 'consent');
  });
});

// ── token refresh ────────────────────────────────────────────────────────────

test('token refresh: an expired access token is transparently refreshed using the stored refresh token', async () => {
  let refreshCalls = 0;
  const fetchFn: typeof fetch = async (_url, init) => {
    refreshCalls += 1;
    const body = String(init?.body ?? '');
    assert.match(body, /grant_type=refresh_token/);
    assert.match(body, /refresh_token=old-refresh-token/);
    return jsonResponse({ access_token: 'refreshed-access-token', expires_in: 3600, scope: GRANTED_SCOPE_STRING });
  };
  let clock = 1_700_000_000_000;
  const tokenStore = new InMemoryGoogleOAuthTokenStore();
  tokenStore.save('t1', { accessToken: 'stale-access-token', refreshToken: 'old-refresh-token', expiresAt: clock - 1000, scope: GRANTED_SCOPE_STRING });

  const accessToken = await tokenStore.getValidAccessToken('t1', config, fetchFn, 'req_refresh_1', () => clock);

  assert.equal(refreshCalls, 1);
  assert.equal(accessToken, 'refreshed-access-token');
  const status = tokenStore.getStatus('t1');
  assert.equal(status.connected, true);
  assert.ok(new Date(status.expiresAt as string).getTime() > clock);
});

test('token refresh failure clears the connection (fail closed) instead of returning a stale token', async () => {
  const fetchFn: typeof fetch = async () => jsonResponse({ error: 'invalid_grant', error_description: 'Token has been revoked' }, 400);
  const tokenStore = new InMemoryGoogleOAuthTokenStore();
  tokenStore.save('t1', { accessToken: 'stale', refreshToken: 'revoked-refresh-token', expiresAt: Date.now() - 1000, scope: GRANTED_SCOPE_STRING });

  const accessToken = await tokenStore.getValidAccessToken('t1', config, fetchFn, 'req_refresh_2');

  assert.equal(accessToken, null);
  assert.equal(tokenStore.isConnected('t1'), false);
});

// ── live registry transition ────────────────────────────────────────────────

test('disconnected tool state: Google Calendar tools report disconnected/unavailable with no OAuth connection', () => {
  sharedGoogleTokenStore.clear(DEFAULT_GOOGLE_TENANT_ID);
  for (const toolName of ['Google Calendar', 'find free slots']) {
    const resolution = sharedToolRegistry.resolve(toolName);
    assert.equal(resolution.connectionStatus, 'disconnected');
    assert.equal(resolution.executionMode, 'unavailable');
    assert.equal(resolution.availability, 'UNAVAILABLE');
  }
});

test('connected tool state: Google Calendar tools report connected/live once a real OAuth connection exists', () => {
  sharedGoogleTokenStore.save(DEFAULT_GOOGLE_TENANT_ID, { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: GRANTED_SCOPE_STRING });
  try {
    for (const toolName of ['Google Calendar', 'find free slots']) {
      const resolution = sharedToolRegistry.resolve(toolName);
      assert.equal(resolution.connectionStatus, 'connected');
      assert.equal(resolution.executionMode, 'live');
      assert.equal(resolution.availability, 'AVAILABLE');
    }
    const listed = sharedToolRegistry.list().find((tool) => tool.id === GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID);
    assert.equal(listed?.connectionStatus, 'connected');
    assert.equal(listed?.executionMode, 'live');
  } finally {
    sharedGoogleTokenStore.clear(DEFAULT_GOOGLE_TENANT_ID);
  }
});

test('setting only GOOGLE_CLIENT_ID/SECRET env vars (no real OAuth connection) never flips the tool to live', async () => {
  sharedGoogleTokenStore.clear(DEFAULT_GOOGLE_TENANT_ID);
  await withEnv({ GOOGLE_CLIENT_ID: 'unit-test-client-id', GOOGLE_CLIENT_SECRET: 'unit-test-secret', GOOGLE_REDIRECT_URI: 'https://nagex-test.agex.site/api/v1/oauth/google/callback' }, () => {
    const resolution = sharedToolRegistry.resolve('Google Calendar');
    assert.equal(resolution.executionMode, 'unavailable');
    assert.equal(resolution.connectionStatus, 'disconnected');
  });
});

// ── approval required ───────────────────────────────────────────────────────

test('approval required: a live Google Calendar create-event step always resolves to APPROVAL_REQUIRED', () => {
  sharedGoogleTokenStore.save(DEFAULT_GOOGLE_TENANT_ID, { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: GRANTED_SCOPE_STRING });
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
    sharedGoogleTokenStore.clear(DEFAULT_GOOGLE_TENANT_ID);
  }
});

test('find_free_slots never requires approval, even when connected', () => {
  sharedGoogleTokenStore.save(DEFAULT_GOOGLE_TENANT_ID, { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: GRANTED_SCOPE_STRING });
  try {
    const resolution = sharedToolRegistry.resolve('find free slots');
    assert.equal(resolution.requiresApproval, false);
  } finally {
    sharedGoogleTokenStore.clear(DEFAULT_GOOGLE_TENANT_ID);
  }
});

// ── freebusy (find_free_slots) ───────────────────────────────────────────────

test('freebusy success: queryFreeBusy calls the real FreeBusy API and computeFreeSlots normalizes the gaps', async () => {
  let capturedUrl = '';
  let capturedBody: Record<string, unknown> = {};
  const fetchFn: typeof fetch = async (url, init) => {
    capturedUrl = String(url);
    capturedBody = JSON.parse(String(init?.body));
    return jsonResponse({ calendars: { primary: { busy: [{ start: '2026-10-01T18:00:00.000Z', end: '2026-10-01T18:30:00.000Z' }] } } });
  };

  const busy = await queryFreeBusy(
    'valid-access-token',
    { calendarId: 'primary', timeMin: '2026-10-01T17:00:00.000Z', timeMax: '2026-10-01T19:00:00.000Z' },
    fetchFn,
    'req_freebusy_1',
  );

  assert.equal(capturedUrl, 'https://www.googleapis.com/calendar/v3/freeBusy');
  assert.deepEqual(capturedBody.items, [{ id: 'primary' }]);
  assert.equal(busy.length, 1);
  assert.equal(busy[0].start, '2026-10-01T18:00:00.000Z');

  const freeSlots = computeFreeSlots(busy, '2026-10-01T17:00:00.000Z', '2026-10-01T19:00:00.000Z', 30);
  assert.equal(freeSlots.length, 2);
  assert.equal(freeSlots[0].start, '2026-10-01T17:00:00.000Z');
  assert.equal(freeSlots[0].end, '2026-10-01T18:00:00.000Z');
  assert.equal(freeSlots[1].start, '2026-10-01T18:30:00.000Z');
  assert.equal(freeSlots[1].end, '2026-10-01T19:00:00.000Z');
});

test('POST /api/v1/tools/google-calendar/free-slots fails closed when Google Calendar is disconnected', async () => {
  sharedGoogleTokenStore.clear(DEFAULT_GOOGLE_TENANT_ID);
  const result = await handleAsyncApiRequest('POST', '/api/v1/tools/google-calendar/free-slots', {});
  assert.notEqual(result.status, 200);
});

test('POST /api/v1/tools/google-calendar/free-slots returns normalized busy/freeSlots once connected', async () => {
  sharedGoogleTokenStore.save(DEFAULT_GOOGLE_TENANT_ID, { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: GRANTED_SCOPE_STRING });
  const originalFetch = global.fetch;
  global.fetch = (async () => jsonResponse({ calendars: { primary: { busy: [] } } })) as typeof fetch;
  try {
    await withEnv({ GOOGLE_CLIENT_ID: 'fs-client', GOOGLE_CLIENT_SECRET: 'fs-secret', GOOGLE_REDIRECT_URI: 'https://nagex-test.agex.site/api/v1/oauth/google/callback' }, async () => {
      const result = await handleAsyncApiRequest('POST', '/api/v1/tools/google-calendar/free-slots', {
        calendarId: 'primary',
        timeMin: '2026-10-01T00:00:00.000Z',
        timeMax: '2026-10-02T00:00:00.000Z',
      });
      assert.equal(result.status, 200);
      const data = result.data as Record<string, unknown>;
      assert.deepEqual(data.busy, []);
      assert.ok(Array.isArray(data.freeSlots));
    });
  } finally {
    global.fetch = originalFetch;
    sharedGoogleTokenStore.clear(DEFAULT_GOOGLE_TENANT_ID);
  }
});

// ── ActionApprovalStore: creation, hashing, payload/expiry/replay ───────────

test('approval creation: request() produces a PENDING record with the canonical fields', () => {
  const approvals = new ActionApprovalStore();
  const record = approvals.request({ toolId: 'google_calendar.create_event', tenantId: 't1', principalId: 'u1', payload: validPayload() });

  assert.equal(typeof record.approvalId, 'string');
  assert.equal(record.toolId, 'google_calendar.create_event');
  assert.equal(record.status, 'PENDING');
  assert.equal(typeof record.payloadHash, 'string');
  assert.equal(record.payloadHash.length, 64); // sha256 hex
  assert.equal(typeof record.createdAt, 'string');
  assert.equal(typeof record.expiresAt, 'string');
  assert.equal(record.approvedAt, null);
  assert.equal(record.usedAt, null);
});

test('approval hash stability: identical payloads (regardless of key order) hash the same; a changed field hashes differently', () => {
  const a = hashCanonicalPayload(validPayload());
  const bReordered = hashCanonicalPayload({
    conferenceData: false,
    attendees: ['client@example.com'],
    timezone: 'America/Los_Angeles',
    end: '2026-10-01T17:30:00.000Z',
    start: '2026-10-01T17:00:00.000Z',
    description: 'Quarterly strategy discussion.',
    summary: 'Client Strategy Sync',
    calendarId: 'primary',
  });
  const changed = hashCanonicalPayload(validPayload({ summary: 'Different Title' }));

  assert.equal(a, bReordered);
  assert.notEqual(a, changed);

  const approvals = new ActionApprovalStore();
  const record = approvals.request({ toolId: 'google_calendar.create_event', tenantId: 't1', principalId: 'u1', payload: validPayload() });
  assert.equal(record.payloadHash, a);
});

test('modified payload rejection: consuming with a changed field is rejected even with a valid approval', () => {
  const approvals = new ActionApprovalStore();
  const record = approvals.request({ toolId: 'google_calendar.create_event', tenantId: 't1', principalId: 'u1', payload: validPayload() });
  approvals.approve(record.approvalId, 't1', 'u1');
  assert.throws(
    () => approvals.consume(record.approvalId, 't1', 'u1', 'google_calendar.create_event', validPayload({ summary: 'A different meeting title' }), 'req_1', 'exe_test'),
    (error: any) => error.code === 'APPROVAL_PAYLOAD_MISMATCH',
  );
});

test('rejected approval rejection: a REJECTED approval can never be consumed', () => {
  const approvals = new ActionApprovalStore();
  const record = approvals.request({ toolId: 'google_calendar.create_event', tenantId: 't1', principalId: 'u1', payload: validPayload() });
  approvals.reject(record.approvalId, 't1', 'u1');
  assert.throws(
    () => approvals.consume(record.approvalId, 't1', 'u1', 'google_calendar.create_event', validPayload(), 'req_1', 'exe_test'),
    (error: any) => error.code === 'APPROVAL_NOT_GRANTED',
  );
});

test('expired approval rejection: an approval past its TTL cannot be approved or consumed', () => {
  let clock = 1_000_000;
  const approvals = new ActionApprovalStore(() => clock, 60_000); // 60s TTL
  const record = approvals.request({ toolId: 'google_calendar.create_event', tenantId: 't1', principalId: 'u1', payload: validPayload() });
  clock += 61_000;
  assert.throws(() => approvals.approve(record.approvalId, 't1', 'u1'), (error: any) => error.code === 'APPROVAL_EXPIRED');
  assert.throws(
    () => approvals.consume(record.approvalId, 't1', 'u1', 'google_calendar.create_event', validPayload(), 'req_1', 'exe_test'),
    (error: any) => error.code === 'APPROVAL_EXPIRED',
  );
});

test('replay rejection: the same approval cannot be consumed twice', () => {
  const approvals = new ActionApprovalStore();
  const record = approvals.request({ toolId: 'google_calendar.create_event', tenantId: 't1', principalId: 'u1', payload: validPayload() });
  approvals.approve(record.approvalId, 't1', 'u1');
  approvals.consume(record.approvalId, 't1', 'u1', 'google_calendar.create_event', validPayload(), 'req_1', 'exe_test');
  assert.throws(
    () => approvals.consume(record.approvalId, 't1', 'u1', 'google_calendar.create_event', validPayload(), 'req_2', 'exe_test_2'),
    (error: any) => error.code === 'APPROVAL_ALREADY_CONSUMED',
  );
});

test('approval consumed exactly once: usedAt moves from null to a timestamp exactly once', () => {
  const approvals = new ActionApprovalStore();
  const record = approvals.request({ toolId: 'google_calendar.create_event', tenantId: 't1', principalId: 'u1', payload: validPayload() });
  assert.equal(record.usedAt, null);
  approvals.approve(record.approvalId, 't1', 'u1');

  const consumed = approvals.consume(record.approvalId, 't1', 'u1', 'google_calendar.create_event', validPayload(), 'req_1', 'exe_test');
  assert.equal(consumed.status, 'CONSUMED');
  assert.equal(typeof consumed.usedAt, 'string');
  const firstUsedAt = consumed.usedAt;

  assert.throws(() => approvals.consume(record.approvalId, 't1', 'u1', 'google_calendar.create_event', validPayload(), 'req_2', 'exe_test_2'));
  // usedAt must not move again on the rejected replay attempt.
  assert.equal(approvals.get(record.approvalId, 't1', 'u1')?.usedAt, firstUsedAt);
});

// ── execution success / provider error / disconnected ───────────────────────

test('execution success: returns a normalized SUCCEEDED result and never fakes success without calling Google', async () => {
  let calledCreateEvent = false;
  const fetchFn: typeof fetch = async (url) => {
    if (String(url).includes('/calendar/v3/calendars/')) {
      calledCreateEvent = true;
      return jsonResponse({ id: 'gcal_evt_1', htmlLink: 'https://calendar.google.com/event?eid=abc' });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const { tokenStore, approvals, service } = buildHarness(fetchFn);
  tokenStore.save('t1', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: GRANTED_SCOPE_STRING });
  const record = approvals.request({ toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID, tenantId: 't1', principalId: 'u1', payload: validPayload() });
  approvals.approve(record.approvalId, 't1', 'u1');

  const result: NormalizedExecutionResult = await service.executeCreateEvent({ approvalId: record.approvalId, payload: validPayload(), tenantId: 't1', principalId: 'u1', requestId: 'req_exec_1' });

  assert.equal(calledCreateEvent, true);
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.toolId, GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID);
  assert.equal(result.externalId, 'gcal_evt_1');
  assert.equal(result.externalUrl, 'https://calendar.google.com/event?eid=abc');
  assert.equal(typeof result.executionId, 'string');
  assert.equal(typeof result.startedAt, 'string');
  assert.equal(typeof result.completedAt, 'string');
});

test('execution provider error (Google failure): a failing Google API call rejects and never returns a fake success', async () => {
  const fetchFn: typeof fetch = async () => jsonResponse({ error: { message: 'insufficient scope' } }, 500);
  const { tokenStore, approvals, service, audit } = buildHarness(fetchFn);
  tokenStore.save('t1', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: GRANTED_SCOPE_STRING });
  const record = approvals.request({ toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID, tenantId: 't1', principalId: 'u1', payload: validPayload() });
  approvals.approve(record.approvalId, 't1', 'u1');

  await assert.rejects(
    () => service.executeCreateEvent({ approvalId: record.approvalId, payload: validPayload(), tenantId: 't1', principalId: 'u1', requestId: 'req_exec_2' }),
    (error: any) => error.code === 'GOOGLE_CALENDAR_HTTP_500',
  );

  const failed = audit.getRecentLogs(10).find((entry) => entry.action === 'tool.execution.failed');
  assert.ok(failed);
  assert.equal(failed?.reason_code, 'GOOGLE_CALENDAR_HTTP_500');
});

test('reject disconnected OAuth: execution is refused even with a valid, matching, approved payload', async () => {
  const fetchFn: typeof fetch = async () => { throw new Error('must not call Google when disconnected'); };
  const { approvals, service } = buildHarness(fetchFn); // tokenStore never connected
  const record = approvals.request({ toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID, tenantId: 't1', principalId: 'u1', payload: validPayload() });
  approvals.approve(record.approvalId, 't1', 'u1');

  await assert.rejects(
    () => service.executeCreateEvent({ approvalId: record.approvalId, payload: validPayload(), tenantId: 't1', principalId: 'u1', requestId: 'req_exec_3' }),
    (error: any) => error.code === 'GOOGLE_CALENDAR_DISCONNECTED',
  );
});

test('unapproved execution attempts never reach Google: pending and rejected approvals are refused', async () => {
  const fetchFn: typeof fetch = async () => { throw new Error('must not call Google without a granted approval'); };
  const { tokenStore, approvals, service } = buildHarness(fetchFn);
  tokenStore.save('t1', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: GRANTED_SCOPE_STRING });

  const pending = approvals.request({ toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID, tenantId: 't1', principalId: 'u1', payload: validPayload() });
  await assert.rejects(
    () => service.executeCreateEvent({ approvalId: pending.approvalId, payload: validPayload(), tenantId: 't1', principalId: 'u1', requestId: 'req_pending' }),
    (error: any) => error.code === 'APPROVAL_NOT_GRANTED',
  );

  const rejected = approvals.request({ toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID, tenantId: 't1', principalId: 'u1', payload: validPayload() });
  approvals.reject(rejected.approvalId, 't1', 'u1');
  await assert.rejects(
    () => service.executeCreateEvent({ approvalId: rejected.approvalId, payload: validPayload(), tenantId: 't1', principalId: 'u1', requestId: 'req_rejected' }),
    (error: any) => error.code === 'APPROVAL_NOT_GRANTED',
  );
});

// ── audit + memory ───────────────────────────────────────────────────────────

test('audit success/failure: every stage of the approval + execution lifecycle is logged with the dotted action names, tokens are never logged', async () => {
  const fetchFn: typeof fetch = async () => jsonResponse({ id: 'gcal_evt_audit', htmlLink: 'https://calendar.google.com/event?eid=audit' });
  const { tokenStore, service, audit, approvals } = buildHarness(fetchFn);
  tokenStore.save('t1', { accessToken: 'super-secret-access-token', refreshToken: 'super-secret-refresh-token', expiresAt: Date.now() + 3600_000, scope: GRANTED_SCOPE_STRING });

  const requested = service.requestCreateEventApproval({ tenantId: 't1', principalId: 'u1', payload: validPayload(), requestId: 'req_audit_1' });
  service.approve(requested.approvalId, 't1', 'u1', 'req_audit_2');
  await service.executeCreateEvent({ approvalId: requested.approvalId, payload: validPayload(), tenantId: 't1', principalId: 'u1', requestId: 'req_audit_3' });

  const logs = audit.getRecentLogs(20);
  const actions = logs.map((entry) => entry.action);
  assert.ok(actions.includes('approval.requested'));
  assert.ok(actions.includes('approval.approved'));
  assert.ok(actions.includes('tool.execution.started'));
  assert.ok(actions.includes('tool.execution.succeeded'));

  const succeeded = logs.find((entry) => entry.action === 'tool.execution.succeeded');
  assert.equal((succeeded?.details as Record<string, unknown> | undefined)?.externalEventId, 'gcal_evt_audit');

  const serializedLogs = JSON.stringify(logs);
  assert.doesNotMatch(serializedLogs, /super-secret-access-token|super-secret-refresh-token/);
  void approvals;
});

test('audit failure path: a rejected approval logs approval.rejected, and a failed execution logs tool.execution.failed', async () => {
  const fetchFn: typeof fetch = async () => jsonResponse({ error: { message: 'boom' } }, 500);
  const { tokenStore, service, audit, approvals } = buildHarness(fetchFn);
  tokenStore.save('t1', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: GRANTED_SCOPE_STRING });

  const requested = service.requestCreateEventApproval({ tenantId: 't1', principalId: 'u1', payload: validPayload(), requestId: 'req_af_1' });
  service.reject(requested.approvalId, 't1', 'u1', 'req_af_2');

  const approvedElsewhere = approvals.request({ toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID, tenantId: 't1', principalId: 'u1', payload: validPayload({ summary: 'Other Event' }) });
  approvals.approve(approvedElsewhere.approvalId, 't1', 'u1');
  await assert.rejects(() =>
    service.executeCreateEvent({ approvalId: approvedElsewhere.approvalId, payload: validPayload({ summary: 'Other Event' }), tenantId: 't1', principalId: 'u1', requestId: 'req_af_3' }),
  );

  const actions = audit.getRecentLogs(20).map((entry) => entry.action);
  assert.ok(actions.includes('approval.rejected'));
  assert.ok(actions.includes('tool.execution.failed'));
});

test('oauth connected/disconnected audit events are recorded via the real server routes, without tokens', async () => {
  sharedGoogleTokenStore.clear(DEFAULT_GOOGLE_TENANT_ID);
  const disconnect = await handleAsyncApiRequest('POST', '/api/v1/oauth/google/disconnect', null);
  assert.equal(disconnect.status, 200);

  const auditResult = handleApiRequest('GET', '/api/v1/audit/logs', null);
  const logs = (auditResult.data as { logs: Array<Record<string, unknown>> }).logs;
  assert.ok(logs.some((entry) => entry.action === 'oauth:google_disconnected'));
});

test('memory update after success: writes "Scheduled <summary> for <date/time>." without persisting attendee emails', async () => {
  const fetchFn: typeof fetch = async () => jsonResponse({ id: 'gcal_evt_mem', htmlLink: 'https://calendar.google.com/event?eid=mem' });
  const { tokenStore, approvals, service, memory } = buildHarness(fetchFn);
  tokenStore.save('t1', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: GRANTED_SCOPE_STRING });
  const record = approvals.request({ toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID, tenantId: 't1', principalId: 'usr_mem_test', payload: validPayload({ attendees: ['secret-attendee@example.com'] }) });
  approvals.approve(record.approvalId, 't1', 'usr_mem_test');

  await service.executeCreateEvent({ approvalId: record.approvalId, payload: validPayload({ attendees: ['secret-attendee@example.com'] }), tenantId: 't1', principalId: 'usr_mem_test', requestId: 'req_mem_1' });

  const memories = memory.getActiveMemories('USER', 't1', 'usr_mem_test');
  assert.equal(memories.length, 1);
  assert.match(String(memories[0].content.value), /^Scheduled Client Strategy Sync for \d{4}-\d{2}-\d{2} \d{2}:\d{2}\.$/);
  assert.doesNotMatch(JSON.stringify(memories[0]), /secret-attendee@example\.com/);
});

// ── HTTP-level wiring ────────────────────────────────────────────────────────

test('POST /api/v1/approvals/calendar-event then /api/v1/approvals/:id/action then create-event round-trips through the real server routes', async () => {
  sharedGoogleTokenStore.save(DEFAULT_GOOGLE_TENANT_ID, { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: GRANTED_SCOPE_STRING });
  try {
    const created = handleApiRequest('POST', '/api/v1/approvals/calendar-event', { payload: validPayload() });
    assert.equal(created.status, 201);
    const approvalId = (created.data as Record<string, unknown>).approvalId as string;
    assert.equal(typeof approvalId, 'string');

    const approved = handleApiRequest('POST', `/api/v1/approvals/${approvalId}/action`, { action: 'APPROVE' });
    assert.equal(approved.status, 200);
    assert.equal((approved.data as Record<string, unknown>).status, 'APPROVED');

    // No live Google credentials in this environment, so this exercises the
    // real fail-closed path (disconnected/refresh-failure) rather than a real
    // Google call — it must not report a fake SUCCEEDED.
    const executed = await handleAsyncApiRequest('POST', '/api/v1/tools/google-calendar/create-event', { approvalId, payload: validPayload() });
    assert.notEqual(executed.status, 200);
  } finally {
    sharedGoogleTokenStore.clear(DEFAULT_GOOGLE_TENANT_ID);
  }
});

test('the legacy demo /api/v1/approvals/:id/action queue still works unchanged', () => {
  const approved = handleApiRequest('POST', '/api/v1/approvals/appr_gcal_sync/action', { action: 'APPROVE' });
  assert.equal(approved.status, 200);
  assert.equal((approved.data as Record<string, unknown>).id, 'appr_gcal_sync');
});

// ── generic POST /api/v1/approvals + dedicated /approve, /reject verbs ──────

test('approval creation: POST /api/v1/approvals accepts { toolId, payload } and returns the required fields', () => {
  const result = handleApiRequest('POST', '/api/v1/approvals', {
    toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID,
    payload: validPayload({ attendees: [] }),
  });
  assert.equal(result.status, 201);
  const data = result.data as Record<string, unknown>;
  assert.equal(typeof data.approvalId, 'string');
  assert.equal(data.status, 'PENDING');
  assert.equal(data.toolId, GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID);
  assert.equal(typeof data.payloadHash, 'string');
  assert.equal(typeof data.createdAt, 'string');
  assert.equal(typeof data.expiresAt, 'string');
});

test('POST /api/v1/approvals accepts a payload with conferenceData omitted, matching the documented example', () => {
  const { conferenceData: _omit, ...withoutConferenceData } = validPayload();
  const result = handleApiRequest('POST', '/api/v1/approvals', {
    toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID,
    payload: withoutConferenceData,
  });
  assert.equal(result.status, 201);
  assert.equal((result.data as Record<string, unknown>).status, 'PENDING');
});

test('POST /api/v1/approvals rejects an unsupported toolId rather than silently accepting it', () => {
  const result = handleApiRequest('POST', '/api/v1/approvals', { toolId: 'not_a_real_tool', payload: validPayload() });
  assert.notEqual(result.status, 201);
  assert.equal((result.data as { error: { code: string } }).error.code, 'UNSUPPORTED_APPROVAL_TOOL');
});

test('full flow with the exact endpoints from spec: POST /api/v1/approvals -> POST .../approve -> POST create-event, then replay is rejected', async () => {
  // Approval creation/approve are plain synchronous routes (no network), so
  // they're exercised through the real HTTP handlers and the real shared
  // approval store (exported from server_web.ts as `actionApprovals`).
  // Execution is the one step that calls Google, so for it we inject a
  // GoogleCalendarService built on that *same* shared approval store but
  // with a mocked fetchFn — mirroring the `service: AiService` DI parameter
  // handleAsyncApiRequest already supports for the AI routes. Mutating
  // global.fetch would not work here: the real googleCalendarService
  // singleton captures its fetchFn once at module load (like the model
  // providers do), long before any test runs.
  const payload = validPayload({ summary: 'NAgex Calendar Integration Test' });
  let calledCreateEvent = false;
  const mockFetch: typeof fetch = async (url) => {
    calledCreateEvent = true;
    assert.match(String(url), /\/calendar\/v3\/calendars\/primary\/events/);
    return jsonResponse({ id: 'gcal_evt_flow', htmlLink: 'https://calendar.google.com/event?eid=flow' });
  };
  const testConfig: GoogleOAuthConfig = { clientId: 'x', clientSecret: 'y', redirectUri: 'https://nagex-test.agex.site/api/v1/oauth/google/callback' };
  const testCalendarService = new GoogleCalendarService(sharedGoogleTokenStore, sharedActionApprovals, new AuditLogger(), new MemoryEngine(), mockFetch, () => testConfig);

  sharedGoogleTokenStore.save(DEFAULT_GOOGLE_TENANT_ID, { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: GRANTED_SCOPE_STRING });
  try {
    const created = handleApiRequest('POST', '/api/v1/approvals', { toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID, payload });
    assert.equal(created.status, 201);
    const approvalId = (created.data as Record<string, unknown>).approvalId as string;
    assert.equal((created.data as Record<string, unknown>).status, 'PENDING');

    const approved = handleApiRequest('POST', `/api/v1/approvals/${approvalId}/approve`, null);
    assert.equal(approved.status, 200);
    assert.equal((approved.data as Record<string, unknown>).status, 'APPROVED');

    // Re-approving a non-PENDING approval must be rejected, not silently accepted.
    const reapproved = handleApiRequest('POST', `/api/v1/approvals/${approvalId}/approve`, null);
    assert.notEqual(reapproved.status, 200);

    const executed = await handleAsyncApiRequest('POST', '/api/v1/tools/google-calendar/create-event', { approvalId, payload }, {}, undefined, {}, testCalendarService);
    assert.equal(calledCreateEvent, true);
    assert.equal(executed.status, 200);
    const result = executed.data as Record<string, unknown>;
    assert.equal(result.status, 'SUCCEEDED');
    assert.equal(result.toolId, GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID);
    assert.equal(result.externalId, 'gcal_evt_flow');
    assert.equal(result.externalUrl, 'https://calendar.google.com/event?eid=flow');
    assert.equal(typeof result.executionId, 'string');

    // The same approvalId must never execute twice.
    const replay = await handleAsyncApiRequest('POST', '/api/v1/tools/google-calendar/create-event', { approvalId, payload }, {}, undefined, {}, testCalendarService);
    assert.notEqual(replay.status, 200);
    assert.equal((replay.data as { error: { code: string } }).error.code, 'APPROVAL_ALREADY_CONSUMED');
  } finally {
    sharedGoogleTokenStore.clear(DEFAULT_GOOGLE_TENANT_ID);
  }
});

test('POST /api/v1/approvals/:id/reject moves PENDING -> REJECTED and blocks execution', async () => {
  sharedGoogleTokenStore.save(DEFAULT_GOOGLE_TENANT_ID, { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: GRANTED_SCOPE_STRING });
  try {
    await withEnv({ GOOGLE_CLIENT_ID: 'reject-client', GOOGLE_CLIENT_SECRET: 'reject-secret', GOOGLE_REDIRECT_URI: 'https://nagex-test.agex.site/api/v1/oauth/google/callback' }, async () => {
      const created = handleApiRequest('POST', '/api/v1/approvals', { toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID, payload: validPayload() });
      const approvalId = (created.data as Record<string, unknown>).approvalId as string;

      const rejected = handleApiRequest('POST', `/api/v1/approvals/${approvalId}/reject`, null);
      assert.equal(rejected.status, 200);
      assert.equal((rejected.data as Record<string, unknown>).status, 'REJECTED');

      const executed = await handleAsyncApiRequest('POST', '/api/v1/tools/google-calendar/create-event', { approvalId, payload: validPayload() });
      assert.notEqual(executed.status, 200);
      assert.equal((executed.data as { error: { code: string } }).error.code, 'APPROVAL_NOT_GRANTED');
    });
  } finally {
    sharedGoogleTokenStore.clear(DEFAULT_GOOGLE_TENANT_ID);
  }
});

test('GET /api/v1/oauth/google/callback exchanges a valid code+state and redirects connected', async () => {
  const originalFetch = global.fetch;
  global.fetch = (async () => jsonResponse({ access_token: 'cb_at', refresh_token: 'cb_rt', expires_in: 3600, scope: GRANTED_SCOPE_STRING })) as typeof fetch;

  await withEnv({ GOOGLE_CLIENT_ID: 'cb-client-id', GOOGLE_CLIENT_SECRET: 'cb-secret', GOOGLE_REDIRECT_URI: 'https://nagex-test.agex.site/api/v1/oauth/google/callback' }, async () => {
    try {
      const started = handleApiRequest('GET', '/api/v1/oauth/google/start-url', null);
      assert.equal(started.status, 200);
      const authorizeUrl = new URL((started.data as Record<string, string>).authorizeUrl);
      const state = authorizeUrl.searchParams.get('state') as string;

      const callback = await handleAsyncApiRequest('GET', '/api/v1/oauth/google/callback', null, {}, undefined, { code: 'auth_code_123', state });
      assert.equal(callback.status, 302);
      assert.equal(callback.redirectTo, '/?oauth=google&status=connected');
      assert.equal(sharedGoogleTokenStore.isConnected(DEFAULT_GOOGLE_TENANT_ID), true);

      const status = sharedGoogleTokenStore.getStatus(DEFAULT_GOOGLE_TENANT_ID);
      assert.deepEqual(status.scopes, GOOGLE_CALENDAR_SCOPES.slice());
    } finally {
      sharedGoogleTokenStore.clear(DEFAULT_GOOGLE_TENANT_ID);
    }
  });

  global.fetch = originalFetch;
});

test('GET /api/v1/oauth/google/callback rejects a state that does not match the pending request', async () => {
  await withEnv({ GOOGLE_CLIENT_ID: 'cb-client-id', GOOGLE_CLIENT_SECRET: 'cb-secret', GOOGLE_REDIRECT_URI: 'https://nagex-test.agex.site/api/v1/oauth/google/callback' }, async () => {
    handleApiRequest('GET', '/api/v1/oauth/google/start-url', null);
    const callback = await handleAsyncApiRequest('GET', '/api/v1/oauth/google/callback', null, {}, undefined, { code: 'auth_code_123', state: 'not-the-real-state' });
    assert.equal(callback.status, 302);
    assert.equal(callback.redirectTo, '/?oauth=google&status=error');
    assert.equal(sharedGoogleTokenStore.isConnected(DEFAULT_GOOGLE_TENANT_ID), false);
  });
});

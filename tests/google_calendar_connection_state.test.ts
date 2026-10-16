import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { NagexError } from '../src/common/errors.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { ActionApprovalStore } from '../src/governance/action-approval.store.js';
import { MemoryEngine } from '../src/context/memory.engine.js';
import { CapabilityBroker } from '../src/capabilities/capability-broker.js';
import { CapabilityRegistry } from '../src/capabilities/capability.registry.js';
import { GOOGLE_CALENDAR_SCOPES, GMAIL_SCOPES, type GoogleOAuthConfig } from '../src/integrations/google/oauth.client.js';
import { InMemoryGoogleOAuthTokenStore, PersistentGoogleOAuthTokenStore, googleTokenStore } from '../src/integrations/google/token.store.js';
import { clearGoogleOAuthStatesForTesting, issueGoogleOAuthState } from '../src/integrations/google/oauth-state.store.js';
import { GoogleCalendarConnectionService, classifyCalendarFailure, type CalendarConnectionStatus } from '../src/integrations/google/calendar-connection.js';
import { GoogleCalendarService } from '../src/modules/calendar/index.js';
import { toolRegistry } from '../src/tools/tool-registry.js';
import { handleAsyncApiRequest } from '../src/server_web.js';
import { authAs, authAsWith } from './_s1_session_auth.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// Google Calendar connection truthfulness: identity binding (user + tenant), every connection state, error
// classification, retention of connection metadata when Google no longer honours a grant, and real event reads.
// Google itself is replaced by a scripted fetch; everything NAgex-side (token store, credential broker, pipeline,
// service, routes, sessions) is the production code.

const CALENDAR_SCOPES = GOOGLE_CALENDAR_SCOPES.join(' ');
const config: GoogleOAuthConfig = { clientId: 'cid', clientSecret: 'csecret', redirectUri: 'https://nagex.agex.site/api/v1/oauth/google/callback' };
const json = (data: unknown, status = 200): Response => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const timeoutError = (): Error => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

interface Call { url: string; authorization: string | null; body: string }

function scriptedGoogle(handler: (call: Call) => Response | Promise<Response>): { fetchFn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call = { url: String(input), authorization: headers.get('authorization'), body: String(init?.body ?? '') };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { fetchFn, calls };
}

const EVENTS = {
  items: [
    { id: 'evt_1', summary: 'Design review', status: 'confirmed', updated: '2026-10-12T08:00:00Z', start: { dateTime: '2026-10-12T10:00:00+09:00' }, end: { dateTime: '2026-10-12T11:00:00+09:00' }, attendees: [{ email: 'kim@example.com' }] },
    { id: 'evt_2', summary: 'Lunch', status: 'confirmed', start: { dateTime: '2026-10-12T12:00:00+09:00' }, end: { dateTime: '2026-10-12T13:00:00+09:00' } },
  ],
};

function build(fetchFn: typeof fetch, opts: { configured?: boolean } = {}) {
  const tokenStore = new InMemoryGoogleOAuthTokenStore();
  const audit = new AuditLogger();
  const getConfig = () => (opts.configured === false ? null : config);
  const calendar = new GoogleCalendarService(tokenStore, new ActionApprovalStore(), audit, new MemoryEngine(), fetchFn, getConfig);
  const connection = new GoogleCalendarConnectionService({
    tokenStore,
    getConfig,
    fetchFn,
    calendar,
    hasPendingAuthorization: (tenantId, principalId) => issuedStates.has(`${tenantId}::${principalId}`),
  });
  return { tokenStore, calendar, connection, audit };
}
const issuedStates = new Set<string>();
const id = (principalId: string, tenantId = 't1') => ({ tenantId, principalId, requestId: `req_${principalId}` });
const connect = (tokenStore: InMemoryGoogleOAuthTokenStore, principalId: string, tenantId = 't1', overrides: Record<string, unknown> = {}) =>
  tokenStore.saveForPrincipal(tenantId, principalId, { accessToken: `at_${tenantId}_${principalId}`, refreshToken: `rt_${tenantId}_${principalId}`, expiresAt: Date.now() + 3_600_000, scope: CALENDAR_SCOPES, ...overrides } as never);

beforeEach(() => { issuedStates.clear(); clearGoogleOAuthStatesForTesting(); });

describe('token store: a grant Google no longer honours is flagged, not silently deleted', () => {
  it('invalid_grant on refresh keeps the connection metadata, purges the secrets and requires reauthorization', async () => {
    const { fetchFn } = scriptedGoogle(() => json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400));
    const store = new InMemoryGoogleOAuthTokenStore();
    connect(store, 'u1', 't1', { expiresAt: Date.now() - 1000 });
    const first = await store.acquireAccessTokenForPrincipal('t1', 'u1', config, fetchFn, 'r1');
    assert.deepEqual(first, { ok: false, reason: 'REAUTH_REQUIRED', reauthReason: 'TOKEN_REVOKED', code: 'GOOGLE_OAUTH_TOKEN_EXCHANGE_FAILED' });
    const status = store.getStatusForPrincipal('t1', 'u1');
    assert.equal(status.connected, false);
    assert.equal(status.authState, 'REAUTH_REQUIRED');
    assert.equal(status.reauthReason, 'TOKEN_REVOKED');
    assert.deepEqual(status.scopes, [...GOOGLE_CALENDAR_SCOPES], 'connection metadata is kept');
    assert.ok(store.getProviderAccountRefForPrincipal('t1', 'u1'), 'the connection reference is kept');
    // no refresh attempt is repeated against a dead grant
    const second = await store.acquireAccessTokenForPrincipal('t1', 'u1', config, fetchFn, 'r2');
    assert.equal(second.ok, false);
    assert.equal(await store.getValidAccessTokenForPrincipal('t1', 'u1', config, fetchFn, 'r3'), null);
    // reconnecting restores a usable connection
    connect(store, 'u1');
    assert.equal(store.getStatusForPrincipal('t1', 'u1').authState, 'ACTIVE');
    assert.equal((await store.acquireAccessTokenForPrincipal('t1', 'u1', config, fetchFn, 'r4')).ok, true);
  });

  it('expired without a refresh token requires reauthorization (metadata kept)', async () => {
    const store = new InMemoryGoogleOAuthTokenStore();
    connect(store, 'u1', 't1', { refreshToken: null, expiresAt: Date.now() - 1000 });
    const result = await store.acquireAccessTokenForPrincipal('t1', 'u1', config, scriptedGoogle(() => json({})).fetchFn, 'r1');
    assert.deepEqual(result, { ok: false, reason: 'REAUTH_REQUIRED', reauthReason: 'TOKEN_EXPIRED_NO_REFRESH' });
    assert.equal(store.getStatusForPrincipal('t1', 'u1').authState, 'REAUTH_REQUIRED');
  });

  it('a Google timeout / outage / network failure is transient: the connection and its secrets are untouched and later recover', async () => {
    let mode: 'timeout' | 'http500' | 'network' | 'ok' = 'timeout';
    const { fetchFn } = scriptedGoogle(() => {
      if (mode === 'timeout') throw timeoutError();
      if (mode === 'network') throw new TypeError('fetch failed');
      if (mode === 'http500') return json({ error: 'backend_error' }, 500);
      return json({ access_token: 'fresh', expires_in: 3600, scope: CALENDAR_SCOPES });
    });
    const store = new InMemoryGoogleOAuthTokenStore();
    connect(store, 'u1', 't1', { expiresAt: Date.now() - 1000 });
    assert.deepEqual(await store.acquireAccessTokenForPrincipal('t1', 'u1', config, fetchFn, 'r1'), { ok: false, reason: 'PROVIDER_TIMEOUT', code: 'GOOGLE_OAUTH_TIMEOUT' });
    mode = 'network';
    assert.equal((await store.acquireAccessTokenForPrincipal('t1', 'u1', config, fetchFn, 'r2')).ok, false);
    mode = 'http500';
    assert.deepEqual(await store.acquireAccessTokenForPrincipal('t1', 'u1', config, fetchFn, 'r3'), { ok: false, reason: 'PROVIDER_ERROR', code: 'GOOGLE_OAUTH_TOKEN_EXCHANGE_FAILED' });
    assert.equal(store.getStatusForPrincipal('t1', 'u1').authState, 'ACTIVE', 'a provider failure never marks the grant dead');
    mode = 'ok';
    assert.deepEqual(await store.acquireAccessTokenForPrincipal('t1', 'u1', config, fetchFn, 'r4'), { ok: true, accessToken: 'fresh' });
  });

  it('the reauthorization flag is persisted (no secrets on disk) and survives a restart', async () => {
    const filePath = path.join(os.tmpdir(), `nagex-reauth-${crypto.randomBytes(4).toString('hex')}.json`);
    const env = { NAGEX_TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64') };
    try {
      const a = new PersistentGoogleOAuthTokenStore({ filePath, env });
      connect(a as unknown as InMemoryGoogleOAuthTokenStore, 'u1', 't1', { expiresAt: Date.now() - 1000 });
      await a.acquireAccessTokenForPrincipal('t1', 'u1', config, scriptedGoogle(() => json({ error: 'invalid_grant' }, 400)).fetchFn, 'r1');
      assert.equal(fs.existsSync(filePath), true, 'metadata is retained on disk');
      assert.doesNotMatch(fs.readFileSync(filePath, 'utf8'), /rt_t1_u1|at_t1_u1/);
      const b = new PersistentGoogleOAuthTokenStore({ filePath, env });
      const status = b.getStatusForPrincipal('t1', 'u1');
      assert.equal(status.authState, 'REAUTH_REQUIRED');
      assert.equal(status.connected, false);
      assert.equal((await b.acquireAccessTokenForPrincipal('t1', 'u1', config, scriptedGoogle(() => json({})).fetchFn, 'r2')).ok, false);
    } finally { fs.rmSync(filePath, { force: true }); }
  });
});

describe('connection states', () => {
  it('NOT_CONNECTED: no connection, and no connect path is hidden', async () => {
    const { connection } = build(scriptedGoogle(() => json({})).fetchFn);
    const status = await connection.getStatus(id('u1'));
    assert.equal(status.state, 'NOT_CONNECTED');
    assert.equal(status.reason, 'NO_CONNECTION');
    assert.equal(status.connectPath, '/api/v1/oauth/google/start');
    assert.equal(status.verifiedAt, null);
  });

  it('CONNECTING: only for the user who started authorization, never for anyone else', async () => {
    const { connection } = build(scriptedGoogle(() => json({})).fetchFn);
    issuedStates.add('t1::u1');
    assert.equal((await connection.getStatus(id('u1'))).state, 'CONNECTING');
    assert.equal((await connection.getStatus(id('u2'))).state, 'NOT_CONNECTED');
    assert.equal((await connection.getStatus(id('u1', 't2'))).state, 'NOT_CONNECTED', 'same user id in another tenant is a different owner');
  });

  it('CONNECTED needs a real provider call: verify reads events and stamps verifiedAt; the cheap status never claims it', async () => {
    const google = scriptedGoogle(() => json(EVENTS));
    const { connection, tokenStore } = build(google.fetchFn);
    connect(tokenStore, 'u1');
    const cheap = await connection.getStatus(id('u1'));
    assert.equal(cheap.state, 'CONNECTED');
    assert.equal(cheap.verifiedAt, null);
    assert.equal(google.calls.length, 0, 'the cheap status makes no Calendar call');
    const verified = await connection.getStatus(id('u1'), { verify: true });
    assert.equal(verified.state, 'CONNECTED');
    assert.ok(verified.verifiedAt);
    assert.equal(google.calls.length, 1);
    assert.match(google.calls[0].url, /^https:\/\/www\.googleapis\.com\/calendar\/v3\/calendars\/primary\/events\?/);
    assert.equal(google.calls[0].authorization, 'Bearer at_t1_u1');
  });

  it('readEvents returns the real events (titles, times, attendees) for the authorized user', async () => {
    const { connection, tokenStore } = build(scriptedGoogle(() => json(EVENTS)).fetchFn);
    connect(tokenStore, 'u1');
    const result = await connection.readEvents(id('u1'), { timeMin: '2026-10-12T00:00:00Z', timeMax: '2026-10-13T00:00:00Z', maxResults: 10 });
    assert.equal(result.connection.state, 'CONNECTED');
    assert.deepEqual(result.events.map((e) => e.title), ['Design review', 'Lunch']);
    assert.deepEqual(result.events[0].attendees, ['kim@example.com']);
    assert.equal(result.events[0].start, '2026-10-12T10:00:00+09:00');
  });

  it('REAUTH_REQUIRED / MISSING_SCOPE: a grant without the calendar scopes is not CONNECTED and names what is missing', async () => {
    const google = scriptedGoogle(() => json(EVENTS));
    const { connection, tokenStore } = build(google.fetchFn);
    connect(tokenStore, 'u1', 't1', { scope: GMAIL_SCOPES.join(' ') });
    const status = await connection.getStatus(id('u1'));
    assert.equal(status.state, 'REAUTH_REQUIRED');
    assert.equal(status.reason, 'MISSING_SCOPE');
    assert.deepEqual(status.missingScopes, [...GOOGLE_CALENDAR_SCOPES]);
    assert.equal(status.connectPath, '/api/v1/oauth/google/start');
    const read = await connection.readEvents(id('u1'), { timeMin: '2026-10-12T00:00:00Z', timeMax: '2026-10-13T00:00:00Z' });
    assert.equal(read.connection.reason, 'MISSING_SCOPE');
    assert.deepEqual(read.events, []);
    assert.equal(google.calls.length, 0, 'no calendar request is made without the granted scope');
  });

  it('REAUTH_REQUIRED / TOKEN_REVOKED: a refresh Google refuses (revoked/expired) is reported as reauthorization, then stays that way', async () => {
    const google = scriptedGoogle((call) => (call.url.includes('oauth2.googleapis.com/token') ? json({ error: 'invalid_grant' }, 400) : json(EVENTS)));
    const { connection, tokenStore } = build(google.fetchFn);
    connect(tokenStore, 'u1', 't1', { expiresAt: Date.now() - 1000 });
    const first = await connection.readEvents(id('u1'), { timeMin: '2026-10-12T00:00:00Z', timeMax: '2026-10-13T00:00:00Z' });
    assert.equal(first.connection.state, 'REAUTH_REQUIRED');
    assert.equal(first.connection.reason, 'TOKEN_REVOKED');
    assert.equal(first.connection.retryable, false);
    const second = await connection.getStatus(id('u1'));
    assert.equal(second.state, 'REAUTH_REQUIRED');
    assert.equal(google.calls.filter((c) => c.url.includes('/calendar/')).length, 0);
  });

  it('REAUTH_REQUIRED / TOKEN_EXPIRED_NO_REFRESH', async () => {
    const { connection, tokenStore } = build(scriptedGoogle(() => json(EVENTS)).fetchFn);
    connect(tokenStore, 'u1', 't1', { refreshToken: null, expiresAt: Date.now() - 1000 });
    const status = await connection.getStatus(id('u1'));
    assert.equal(status.state, 'REAUTH_REQUIRED');
    assert.equal(status.reason, 'TOKEN_EXPIRED_NO_REFRESH');
  });

  it('REAUTH_REQUIRED / TOKEN_REJECTED: Google answers 401 to a saved access token; the next status does not claim CONNECTED', async () => {
    const { connection, tokenStore } = build(scriptedGoogle(() => json({ error: { code: 401, message: 'Invalid Credentials', status: 'UNAUTHENTICATED' } }, 401)).fetchFn);
    connect(tokenStore, 'u1');
    const read = await connection.readEvents(id('u1'), { timeMin: '2026-10-12T00:00:00Z', timeMax: '2026-10-13T00:00:00Z' });
    assert.equal(read.connection.state, 'REAUTH_REQUIRED');
    assert.equal(read.connection.reason, 'TOKEN_REJECTED');
    assert.equal((await connection.getStatus(id('u1'))).state, 'REAUTH_REQUIRED');
  });

  it('REAUTH_REQUIRED / MISSING_SCOPE reported by Google (403 insufficientPermissions)', async () => {
    const { connection, tokenStore } = build(scriptedGoogle(() => json({ error: { code: 403, message: 'Insufficient Permission', errors: [{ reason: 'insufficientPermissions' }] } }, 403)).fetchFn);
    connect(tokenStore, 'u1');
    const read = await connection.readEvents(id('u1'), { timeMin: '2026-10-12T00:00:00Z', timeMax: '2026-10-13T00:00:00Z' });
    assert.equal(read.connection.state, 'REAUTH_REQUIRED');
    assert.equal(read.connection.reason, 'MISSING_SCOPE');
  });

  it('ERROR keeps the connection: timeout, outage, rate limit, API disabled, unreachable are NOT reconnect prompts', async () => {
    const cases: Array<{ name: string; respond: () => Response; reason: string; retryable: boolean }> = [
      { name: 'timeout', respond: () => { throw timeoutError(); }, reason: 'PROVIDER_TIMEOUT', retryable: true },
      { name: 'unreachable', respond: () => { throw new TypeError('fetch failed'); }, reason: 'PROVIDER_UNREACHABLE', retryable: true },
      { name: '500', respond: () => json({ error: { message: 'Backend Error' } }, 500), reason: 'PROVIDER_ERROR', retryable: true },
      { name: '503', respond: () => json({ error: { message: 'Unavailable' } }, 503), reason: 'PROVIDER_ERROR', retryable: true },
      { name: '429', respond: () => json({ error: { message: 'Too many' } }, 429), reason: 'PROVIDER_RATE_LIMITED', retryable: true },
      { name: '403 rate', respond: () => json({ error: { message: 'Rate Limit Exceeded', errors: [{ reason: 'rateLimitExceeded' }] } }, 403), reason: 'PROVIDER_RATE_LIMITED', retryable: true },
      { name: '403 api disabled', respond: () => json({ error: { message: 'API not enabled', errors: [{ reason: 'accessNotConfigured' }] } }, 403), reason: 'PROVIDER_API_DISABLED', retryable: false },
      { name: '403 other', respond: () => json({ error: { message: 'Forbidden' } }, 403), reason: 'PROVIDER_FORBIDDEN', retryable: false },
    ];
    for (const c of cases) {
      const { connection, tokenStore } = build(scriptedGoogle(() => c.respond()).fetchFn);
      connect(tokenStore, 'u1');
      const read = await connection.readEvents(id('u1'), { timeMin: '2026-10-12T00:00:00Z', timeMax: '2026-10-13T00:00:00Z' });
      assert.equal(read.connection.state, 'ERROR', c.name);
      assert.equal(read.connection.reason, c.reason, c.name);
      assert.equal(read.connection.retryable, c.retryable, c.name);
      assert.equal(read.connection.connectPath, null, `${c.name}: a provider failure must not push the user to reconnect`);
      assert.equal(tokenStore.getStatusForPrincipal('t1', 'u1').authState, 'ACTIVE', `${c.name}: the grant stays`);
      assert.notEqual(read.connection.state, 'NOT_CONNECTED');
    }
  });

  it('ERROR / INTERNAL_ERROR: an unexpected NAgex failure is reported as such, never as "not connected"', async () => {
    const tokenStore = new InMemoryGoogleOAuthTokenStore();
    connect(tokenStore, 'u1');
    const connection = new GoogleCalendarConnectionService({
      tokenStore, getConfig: () => config, fetchFn: scriptedGoogle(() => json({})).fetchFn, hasPendingAuthorization: () => false,
      calendar: { listUpcomingEvents: async () => { throw new Error('boom'); } },
    });
    const read = await connection.readEvents(id('u1'), { timeMin: '2026-10-12T00:00:00Z', timeMax: '2026-10-13T00:00:00Z' });
    assert.equal(read.connection.state, 'ERROR');
    assert.equal(read.connection.reason, 'INTERNAL_ERROR');
    assert.equal(classifyCalendarFailure(new Error('x')).state, 'ERROR');
  });

  it('a token refresh that times out is ERROR/PROVIDER_TIMEOUT and keeps the grant', async () => {
    const { connection, tokenStore } = build(scriptedGoogle((call) => { if (call.url.includes('oauth2.googleapis.com')) throw timeoutError(); return json(EVENTS); }).fetchFn);
    connect(tokenStore, 'u1', 't1', { expiresAt: Date.now() - 1000 });
    const read = await connection.readEvents(id('u1'), { timeMin: '2026-10-12T00:00:00Z', timeMax: '2026-10-13T00:00:00Z' });
    assert.equal(read.connection.state, 'ERROR');
    assert.equal(read.connection.reason, 'PROVIDER_TIMEOUT');
    assert.equal(tokenStore.getStatusForPrincipal('t1', 'u1').authState, 'ACTIVE');
  });

  it('UNAVAILABLE: a server without a Google OAuth client does not advertise a connect button that cannot work', async () => {
    const { connection } = build(scriptedGoogle(() => json({})).fetchFn, { configured: false });
    const status = await connection.getStatus(id('u1'));
    assert.equal(status.state, 'UNAVAILABLE');
    assert.equal(status.reason, 'OAUTH_NOT_CONFIGURED');
    assert.equal(status.connectPath, null);
  });
});

describe('identity binding: user and tenant isolation', () => {
  it('a read uses only the asking user\'s own token; another user, another tenant and a payload-supplied identity get nothing', async () => {
    const google = scriptedGoogle(() => json(EVENTS));
    const { connection, tokenStore, calendar } = build(google.fetchFn);
    connect(tokenStore, 'alice');
    connect(tokenStore, 'alice', 't2'); // same user id, different tenant: a different owner
    const asBob = await connection.readEvents(id('bob'), { timeMin: '2026-10-12T00:00:00Z', timeMax: '2026-10-13T00:00:00Z' });
    assert.equal(asBob.connection.state, 'NOT_CONNECTED');
    assert.deepEqual(asBob.events, []);
    assert.equal(google.calls.length, 0, 'bob never causes a request made with alice\'s token');
    const asCarol = await connection.readEvents(id('alice', 't3'), { timeMin: '2026-10-12T00:00:00Z', timeMax: '2026-10-13T00:00:00Z' });
    assert.equal(asCarol.connection.state, 'NOT_CONNECTED');
    assert.equal(google.calls.length, 0);
    await connection.readEvents(id('alice'), { timeMin: '2026-10-12T00:00:00Z', timeMax: '2026-10-13T00:00:00Z' });
    await connection.readEvents(id('alice', 't2'), { timeMin: '2026-10-12T00:00:00Z', timeMax: '2026-10-13T00:00:00Z' });
    assert.deepEqual(google.calls.map((c) => c.authorization), ['Bearer at_t1_alice', 'Bearer at_t2_alice']);
    // reauthorization of one owner never touches another's grant
    tokenStore.markReauthRequiredForPrincipal('t1', 'alice', 'TOKEN_REJECTED');
    assert.equal(tokenStore.getStatusForPrincipal('t2', 'alice').authState, 'ACTIVE');
    assert.equal((await connection.getStatus(id('alice', 't2'))).state, 'CONNECTED');
    void calendar;
  });

  it('tool availability is evaluated for the verified user only and fails closed without an identity', () => {
    googleTokenStore.saveForPrincipal('ten_iso', 'usr_iso_a', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, scope: CALENDAR_SCOPES });
    try {
      assert.equal(toolRegistry.resolve('Google Calendar', { tenantId: 'ten_iso', principalId: 'usr_iso_a' }).executionMode, 'live');
      assert.equal(toolRegistry.resolve('Google Calendar', { tenantId: 'ten_iso', principalId: 'usr_iso_b' }).executionMode, 'unavailable', 'another user in the same tenant');
      assert.equal(toolRegistry.resolve('Google Calendar', { tenantId: 'ten_other', principalId: 'usr_iso_a' }).executionMode, 'unavailable', 'the same user id in another tenant');
      assert.equal(toolRegistry.resolve('Google Calendar').executionMode, 'unavailable', 'no verified identity: nothing is claimed live');
      assert.equal(toolRegistry.list().find((t) => t.id === 'google_calendar.create_event')?.executionMode, 'unavailable');
    } finally { googleTokenStore.clearForPrincipal('ten_iso', 'usr_iso_a'); }
  });

  it('a connection that must be reauthorized is not live for tools either', () => {
    googleTokenStore.saveForPrincipal('ten_iso2', 'usr_iso_a', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, scope: CALENDAR_SCOPES });
    googleTokenStore.markReauthRequiredForPrincipal('ten_iso2', 'usr_iso_a', 'TOKEN_REVOKED');
    try {
      assert.equal(toolRegistry.resolve('Google Calendar', { tenantId: 'ten_iso2', principalId: 'usr_iso_a' }).executionMode, 'unavailable');
    } finally { googleTokenStore.clearForPrincipal('ten_iso2', 'usr_iso_a'); }
  });
});

describe('CapabilityBroker google_calendar.list_events', () => {
  it('reads the request\'s own tenant + user (never a payload identity), is read-only and needs no approval', async () => {
    const seen: any[] = [];
    const calendar = {
      listUpcomingEvents: async (input: any) => { seen.push(input); return [{ id: 'e1', title: 'Design review', start: 'a', end: 'b', status: 'confirmed', updated: null, attendees: [] }]; },
      getFreeSlots: async () => ({ slots: [], busy: [], calendarId: 'primary', timeMin: '', timeMax: '' }),
    } as never;
    process.env.NAGEX_TEST_IDEMPOTENCY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-idem-'));
    const broker = new CapabilityBroker(calendar, {} as never, {} as never, new AuditLogger(), new CapabilityRegistry(), 'calendar_list_events_idem', 'NAGEX_TEST_IDEMPOTENCY_DIR');
    const result = await broker.execute({ capabilityId: 'google_calendar.list_events', tenantId: 'ten_a', principalId: 'usr_a', requestId: 'req_list_1', source: 'WEB', payload: { principalId: 'usr_victim', tenantId: 'ten_victim', maxResults: 500 } });
    assert.equal(result.status, 'EXECUTED');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].tenantId, 'ten_a');
    assert.equal(seen[0].principalId, 'usr_a');
    assert.equal(seen[0].maxResults, 50, 'the page size is capped');
    assert.equal(new CapabilityRegistry().get('google_calendar.list_events')?.risk, 'READ_ONLY');
    assert.equal(new CapabilityRegistry().get('google_calendar.list_events')?.approval, 'NONE');
    // writes are untouched: still approval-gated
    assert.equal(new CapabilityRegistry().get('google_calendar.create_event')?.approval, 'REQUIRED');
  });
});

describe('HTTP: verified session only', () => {
  const originalFetch = globalThis.fetch;
  const envBackup = { id: process.env.GOOGLE_CLIENT_ID, secret: process.env.GOOGLE_CLIENT_SECRET, redirect: process.env.GOOGLE_REDIRECT_URI };
  let google: ReturnType<typeof scriptedGoogle>;
  const T1 = 'ten_http_1';
  const T2 = 'ten_http_2';
  const sessions = () => ({ a: authAs(T1, 'usr_http_a'), b: authAs(T1, 'usr_http_b'), c: authAs(T2, 'usr_http_a') });

  beforeEach(() => {
    process.env.GOOGLE_CLIENT_ID = 'http-client'; process.env.GOOGLE_CLIENT_SECRET = 'http-secret'; process.env.GOOGLE_REDIRECT_URI = config.redirectUri;
    google = scriptedGoogle(() => json(EVENTS));
    globalThis.fetch = google.fetchFn;
    googleTokenStore.saveForPrincipal(T1, 'usr_http_a', { accessToken: 'at_http_a', refreshToken: 'rt_http_a', expiresAt: Date.now() + 3_600_000, scope: CALENDAR_SCOPES });
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries({ GOOGLE_CLIENT_ID: envBackup.id, GOOGLE_CLIENT_SECRET: envBackup.secret, GOOGLE_REDIRECT_URI: envBackup.redirect })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    for (const [t, u] of [[T1, 'usr_http_a'], [T1, 'usr_http_b'], [T2, 'usr_http_a']]) googleTokenStore.clearForPrincipal(t, u);
  });
  after(() => { clearGoogleOAuthStatesForTesting(); });

  const get = (pathname: string, headers: Record<string, string>) => handleAsyncApiRequest('GET', pathname, null, headers);
  const conn = (res: { data: unknown }) => (res.data as { connection: CalendarConnectionStatus }).connection;

  it('no session: every Google Calendar endpoint is 401 and nothing reaches Google', async () => {
    for (const p of ['/api/v1/connections/google-calendar', '/api/v1/connections/google-calendar/events', '/api/v1/calendar/upcoming', '/api/v1/connections']) {
      assert.equal((await get(p, {})).status, 401, p);
    }
    assert.equal(google.calls.length, 0);
  });

  it('the owner sees CONNECTED with real events; another user and another tenant see NOT_CONNECTED and nothing else', async () => {
    const { a, b, c } = sessions();
    const own = await get('/api/v1/connections/google-calendar/events', a);
    assert.equal(own.status, 200);
    assert.equal(conn(own).state, 'CONNECTED');
    assert.ok(conn(own).verifiedAt);
    assert.deepEqual(((own.data as any).events as any[]).map((e) => e.title), ['Design review', 'Lunch']);
    assert.equal(google.calls[0].authorization, 'Bearer at_http_a');

    const callsBefore = google.calls.length;
    const sameTenantOtherUser = await get('/api/v1/connections/google-calendar/events', b);
    assert.equal(conn(sameTenantOtherUser).state, 'NOT_CONNECTED');
    assert.deepEqual((sameTenantOtherUser.data as any).events, []);
    const otherTenant = await get('/api/v1/connections/google-calendar/events', c);
    assert.equal(conn(otherTenant).state, 'NOT_CONNECTED');
    assert.deepEqual((otherTenant.data as any).events, []);
    assert.equal(google.calls.length, callsBefore, 'neither request touched Google with anyone\'s token');
  });

  it('client-supplied identity (headers, query, body) never selects whose connection is read', async () => {
    const { a, b } = sessions();
    const forged = { ...b, 'X-Principal-Id': 'usr_http_a', 'X-NAgex-Tenant': T1 };
    const res = await handleAsyncApiRequest('GET', '/api/v1/connections/google-calendar/events', null, forged, undefined, { userId: 'usr_http_a', principalId: 'usr_http_a', tenantId: T1 });
    assert.equal(conn(res).state, 'NOT_CONNECTED');
    assert.equal(google.calls.length, 0);
    assert.notEqual(forged.cookie, a.cookie);
    const statusRes = await get('/api/v1/oauth/google/status', forged);
    assert.equal((statusRes.data as any).connected, false);
    assert.equal((statusRes.data as any).connection.state, 'NOT_CONNECTED');
  });

  it('/connections lists Google with the precise state and reason for the caller only', async () => {
    const { a, b } = sessions();
    const row = async (h: Record<string, string>) => (((await get('/api/v1/connections', h)).data as any).connections as any[]).find((x) => x.provider === 'google');
    assert.equal((await row(a)).status, 'CONNECTED');
    const rowB = await row(b);
    assert.equal(rowB.status, 'NOT_CONNECTED');
    assert.equal(rowB.detail.connectPath, '/api/v1/oauth/google/start');
  });

  it('CONNECTING appears for the user who started authorization and nobody else', async () => {
    const { b, c } = sessions();
    issueGoogleOAuthState({ tenantId: T1, principalId: 'usr_http_b' });
    assert.equal(conn(await get('/api/v1/connections/google-calendar', b)).state, 'CONNECTING');
    assert.equal(conn(await get('/api/v1/connections/google-calendar', c)).state, 'NOT_CONNECTED');
  });

  it('/calendar/upcoming states WHY there are no events instead of a bare connected:false', async () => {
    const { a, b } = sessions();
    const ok = await get('/api/v1/calendar/upcoming', a);
    assert.equal(ok.status, 200);
    assert.equal((ok.data as any).connected, true);
    assert.equal((ok.data as any).events.length, 2);
    const none = await get('/api/v1/calendar/upcoming', b);
    assert.equal((none.data as any).connected, false);
    assert.equal(conn(none).state, 'NOT_CONNECTED');
    assert.match((none.data as any).message, /not connected/i);

    globalThis.fetch = scriptedGoogle(() => json({ error: { message: 'Backend Error' } }, 500)).fetchFn;
    const failing = await get('/api/v1/calendar/upcoming', a);
    assert.equal(failing.status, 502);
    assert.equal(conn(failing).state, 'ERROR');
    assert.equal((failing.data as any).error.code, 'PROVIDER_ERROR');
    assert.equal((failing.data as any).error.retryable, true);

    globalThis.fetch = scriptedGoogle(() => { throw timeoutError(); }).fetchFn;
    assert.equal((await get('/api/v1/calendar/upcoming', a)).status, 504);
  });

  it('Google revoking the grant surfaces as REAUTH_REQUIRED with a connect path, over HTTP, and clears nothing else', async () => {
    const { a } = sessions();
    googleTokenStore.saveForPrincipal(T1, 'usr_http_a', { accessToken: 'stale', refreshToken: 'revoked', expiresAt: Date.now() - 1000, scope: CALENDAR_SCOPES });
    globalThis.fetch = scriptedGoogle((call) => (call.url.includes('oauth2.googleapis.com') ? json({ error: 'invalid_grant' }, 400) : json(EVENTS))).fetchFn;
    const res = await get('/api/v1/connections/google-calendar/events', a);
    assert.equal(res.status, 200);
    assert.equal(conn(res).state, 'REAUTH_REQUIRED');
    assert.equal(conn(res).reason, 'TOKEN_REVOKED');
    assert.equal(conn(res).connectPath, '/api/v1/oauth/google/start');
    assert.equal(googleTokenStore.getStatusForPrincipal(T1, 'usr_http_a').authState, 'REAUTH_REQUIRED');
    assert.equal(((await get('/api/v1/connections', a)).data as any).connections.find((x: any) => x.provider === 'google').status, 'REAUTH_REQUIRED');
  });

  it('calendar writes are untouched: create-event still requires an approval id', async () => {
    const { a } = sessions();
    const res = await handleAsyncApiRequest('POST', '/api/v1/tools/google-calendar/create-event', { payload: {} }, a);
    assert.notEqual(res.status, 200);
    assert.equal(google.calls.length, 0);
    void NagexError;
    void authAsWith;
  });
});

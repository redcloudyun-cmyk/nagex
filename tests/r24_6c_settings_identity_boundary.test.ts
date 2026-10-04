// R24.6C — Settings identity boundary.
//
// Personal Settings operations (Quick Wake, Autonomy, Proactive Assistant,
// memory settings, Google connection, Connected Apps) take their owner ONLY
// from the authenticated server-side session. Client-controlled identity
// (X-Principal-Id / X-NAgex-Tenant) can neither authenticate nor override
// ownership. These tests use the real route registrars, the real production
// wiring (handleAsyncApiRequest / handleApiRequest), the real Google token
// stores, and a real second server process — with deterministic fake
// credentials and a stubbed network (no real Google account is touched).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { IdentityStore } from '../src/identity/identity.store.js';
import { SessionStore } from '../src/sessions/session.store.js';
import { hashPassword } from '../src/identity/identity.crypto.js';
import { callerIdentity, canonicalizeRequestHeaders, resolveAuthenticatedIdentity, tryGetCallerIdentity } from '../src/http/request-identity.js';
import { handleDailyBriefRoutes } from '../src/http/routes/daily-brief.routes.js';
import { handleMemoryRoutes } from '../src/http/routes/memory.routes.js';
import { handleGoogleOAuthStartRoutes, handleGoogleOAuthCallbackRoutes } from '../src/http/routes/google-oauth.routes.js';
import { handleConnectionsRoutes } from '../src/http/routes/connections.routes.js';
import { ConnectionStore } from '../src/workspace/connections.store.js';
import { MemoryEngine } from '../src/context/memory.engine.js';
import { TaskStore } from '../src/tasks/task.store.js';
import { ActivityStore } from '../src/governance/activity.store.js';
import { DailyBriefStore, dailyBriefDateKey } from '../src/governance/daily-brief.store.js';
import { ActionApprovalStore } from '../src/governance/action-approval.store.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { GoogleCalendarService } from '../src/modules/calendar/index.js';
import { GmailService } from '../src/modules/gmail/gmail.service.js';
import { AiService } from '../src/model-gateway/ai-service.js';
import { UnifiedModelRouter } from '../src/model-gateway/unified-model-router.js';
import { InMemoryGoogleOAuthTokenStore, googleTokenStore } from '../src/integrations/google/token.store.js';
import { GOOGLE_CALENDAR_SCOPES, GMAIL_SCOPES, type GoogleOAuthConfig } from '../src/integrations/google/oauth.client.js';
import { generateDailyBriefOnce } from '../src/assistant/daily-brief.pipeline.js';
import { DailyBriefTaskRunner } from '../src/tasks/runners/daily-brief.runner.js';
import { createStructuredModelProvider } from './_model_provider_fixtures.js';
import * as server from '../src/server_web.js';
import { SPAWNED_SERVER_TRUSTED_PROXIES } from './_s2e_peer.js';
import { enableDevAuthTokensForFile } from './_dev_auth_tokens.js';

// R24.6C1 — this file legitimately needs raw dev tokens to drive signup/verify; opt in explicitly (restored after the file).
enableDevAuthTokensForFile();

function tmp(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `nagex-r246c-${label}-`));
}

interface Stores { identityStore: IdentityStore; sessionStore: SessionStore }
interface TestUser { userId: string; tenantId: string; cookie: { cookie: string }; forged: Record<string, string> }

const RUN = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
let counter = 0;

function openStores(root: string): Stores {
  return {
    identityStore: new IdentityStore({ dir: path.join(root, 'identity') }),
    sessionStore: new SessionStore({ dir: path.join(root, 'sessions') }),
  };
}

function makeUser(stores: Stores, label: string): TestUser {
  const { identity } = stores.identityStore.createAccount(`r246c_${label}_${RUN}_${++counter}@example.com`, hashPassword('password123'));
  stores.identityStore.transitionState(identity.userId, 'ACTIVE');
  const tenantId = `ten_${identity.userId}`;
  const session = stores.sessionStore.createAuthSession(tenantId, identity.userId, 'MAIN');
  return {
    userId: identity.userId,
    tenantId,
    cookie: { cookie: `nagex_session=${session.sessionId}` },
    forged: { 'x-principal-id': identity.userId, 'x-nagex-tenant': tenantId },
  };
}

// The same, against the production-wired module stores (what the real HTTP
// entry points consult).
function productionStores(): Stores {
  return { identityStore: server.identityStore, sessionStore: server.sessionStore };
}

const asyncCall = (method: string, p: string, body: Record<string, unknown> | null, headers: Record<string, string>) => server.handleAsyncApiRequest(method, p, body, headers);

// ─────────────────────────────────────────────────────────────────────────
describe('R24.6C — session-derived identity resolver and header canonicalization', () => {
  it('resolves identity only from a valid session; unknown, revoked, expired and deleted-account sessions resolve to nothing', () => {
    const stores = openStores(tmp('resolver'));
    const a = makeUser(stores, 'a');
    const auth = resolveAuthenticatedIdentity(a.cookie, stores);
    assert.deepEqual({ userId: auth?.userId, tenantId: auth?.tenantId, principalId: auth?.principalId }, { userId: a.userId, tenantId: a.tenantId, principalId: a.userId });

    assert.equal(resolveAuthenticatedIdentity({}, stores), null);
    assert.equal(resolveAuthenticatedIdentity({ 'x-principal-id': a.userId, 'x-nagex-tenant': a.tenantId }, stores), null, 'identity headers are not authentication');
    assert.equal(resolveAuthenticatedIdentity({ cookie: 'nagex_session=sess_nope' }, stores), null);

    // Bearer carries the same session.
    const bearer = resolveAuthenticatedIdentity({ authorization: `Bearer ${a.cookie.cookie.split('=')[1]}` }, stores);
    assert.equal(bearer?.userId, a.userId);

    // Revoked session.
    const b = makeUser(stores, 'b');
    stores.sessionStore.revokeSession(b.cookie.cookie.split('=')[1]);
    assert.equal(resolveAuthenticatedIdentity(b.cookie, stores), null);

    // Expired session.
    const c = makeUser(stores, 'c');
    const expiring = new SessionStore({ dir: path.join(tmp('resolver-exp'), 'sessions'), now: () => new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString() });
    assert.equal(resolveAuthenticatedIdentity(c.cookie, { identityStore: stores.identityStore, sessionStore: expiring }), null);
  });

  it('S1: identity headers are DISCARDED (any casing) and the verified caller is the session — never a header, body or query value', () => {
    const stores = openStores(tmp('canon'));
    const a = makeUser(stores, 'a');
    const b = makeUser(stores, 'b');
    const out = canonicalizeRequestHeaders({ ...a.cookie, 'X-Principal-Id': b.userId, 'x-nagex-tenant': b.tenantId, 'X-NAgex-Tenant': 'ten_attacker', 'x-other': 'keep' }, stores);
    for (const k of ['x-principal-id', 'x-nagex-tenant', 'X-Principal-Id', 'X-NAgex-Tenant']) assert.equal(out[k], undefined, `${k} must not survive canonicalization`);
    assert.equal(out['x-other'], 'keep');
    const caller = tryGetCallerIdentity(out)!;
    assert.equal(caller.principalId, a.userId);
    assert.equal(caller.tenantId, a.tenantId);
    assert.equal(caller.source, 'SESSION');
  });

  it('S1: an anonymous caller has NO identity whatever the headers name — real account, default admin, default tenant or demo persona', () => {
    const stores = openStores(tmp('anon'));
    const a = makeUser(stores, 'a');
    const forged: Array<Record<string, string>> = [
      { 'x-principal-id': a.userId, 'x-nagex-tenant': 'ten_production_01' },
      { 'x-principal-id': 'usr_admin_001', 'x-nagex-tenant': a.tenantId },
      { 'x-principal-id': 'usr_admin_001' },
      { 'x-nagex-tenant': 'ten_production_01' },
      { 'x-principal-id': 'admin', 'x-nagex-tenant': 'ten_production_01' },
      { 'x-principal-id': 'usr_demo_alex', 'x-nagex-tenant': 'ten_demo_hackathon' },
      { 'x-principal-id': 'usr_never_registered', 'x-nagex-tenant': 'ten_never_registered' },
    ];
    for (const headers of forged) {
      const out = canonicalizeRequestHeaders(headers, stores);
      assert.equal(out['x-principal-id'], undefined);
      assert.equal(out['x-nagex-tenant'], undefined);
      assert.equal(tryGetCallerIdentity(out), null, `no identity from ${JSON.stringify(headers)}`);
      assert.throws(() => callerIdentity(out), (e: unknown) => (e as { code?: string }).code === 'AUTHENTICATION_REQUIRED');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('R24.6C — Proactive Assistant is owned by the authenticated session', () => {
  function paDeps(stores: Stores) {
    const taskStore = new TaskStore({ dir: path.join(tmp('pa-tasks')) });
    return { taskStore, deps: { sessionStore: stores.sessionStore, identityStore: stores.identityStore, taskStore } as any };
  }
  const pa = (deps: any, method: string, body: Record<string, unknown> | null, headers: Record<string, string>) =>
    handleDailyBriefRoutes(method, '/api/v1/proactive-assistant/config', body, headers, {}, deps);
  const schedule = (over: Record<string, unknown> = {}) => ({ enabled: false, localTime: '09:15', timezone: 'UTC', weekdays: [1, 3], notifyOnComplete: false, ...over });

  it('rejects unauthenticated reads and writes (identity headers do not authenticate)', async () => {
    const stores = openStores(tmp('pa-unauth'));
    const a = makeUser(stores, 'a');
    const { deps } = paDeps(stores);
    for (const headers of [{}, a.forged, { 'x-principal-id': 'usr_admin_001', 'x-nagex-tenant': 'ten_production_01' }]) {
      assert.equal((await pa(deps, 'GET', null, headers))?.status, 401);
      assert.equal((await pa(deps, 'PUT', schedule(), headers))?.status, 401);
    }
  });

  it('user A cannot read or mutate user B; a forged header naming B cannot change whose schedule is touched', async () => {
    const stores = openStores(tmp('pa-iso'));
    const a = makeUser(stores, 'a');
    const b = makeUser(stores, 'b');
    const { deps, taskStore } = paDeps(stores);

    // A writes while sending B's identity headers: it is still A's schedule.
    assert.equal((await pa(deps, 'PUT', schedule({ localTime: '07:45' }), { ...a.cookie, ...b.forged }))?.status, 200);
    assert.equal(taskStore.list(a.tenantId, a.userId).filter((t) => t.automationKind === 'DAILY_BRIEF').length, 1);
    assert.equal(taskStore.list(b.tenantId, b.userId).length, 0, "the forged header must not create or touch B's schedule");

    const readA = (await pa(deps, 'GET', null, { ...a.cookie, ...b.forged }))!.data as any;
    assert.equal(readA.localTime, '07:45');
    const readB = (await pa(deps, 'GET', null, { ...b.cookie, ...a.forged }))!.data as any;
    assert.equal(readB.localTime, null, "B (even naming A in headers) must not see A's schedule");
    assert.equal(readB.taskStatus, null);

    // B writes its own; A's is untouched.
    await pa(deps, 'PUT', schedule({ localTime: '21:00' }), b.cookie);
    assert.equal(((await pa(deps, 'GET', null, a.cookie))!.data as any).localTime, '07:45');
    assert.equal(((await pa(deps, 'GET', null, b.cookie))!.data as any).localTime, '21:00');
  });

  it('fails closed when the session stores are not provided', async () => {
    const taskStore = new TaskStore({ dir: tmp('pa-nostores') });
    const res = await handleDailyBriefRoutes('GET', '/api/v1/proactive-assistant/config', null, { 'x-principal-id': 'usr_admin_001' }, {}, { taskStore } as any);
    assert.equal(res?.status, 401);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('R24.6C — memory settings are owned by the authenticated session', () => {
  function memoryFixture() {
    const stores = openStores(tmp('mem'));
    const root = tmp('mem-engine');
    const memoryEngine = new MemoryEngine({ dir: path.join(root, 'memories'), settingsDir: path.join(root, 'settings') });
    const call = (method: string, body: Record<string, unknown> | null, headers: Record<string, string>) =>
      handleMemoryRoutes(method, '/api/v1/memory/settings', body, headers, {}, {
        memoryEngine,
        pinnedMemories: new Set<string>(),
        // Header-derived values (what the old code trusted) — deliberately the FORGED ones.
        tenantId: headers['x-nagex-tenant'] ?? 'ten_production_01',
        principal: { type: 'user', id: headers['x-principal-id'] ?? 'usr_admin_001' },
        modelErrorResult: () => ({ status: 500, data: {} }),
        sessionStore: stores.sessionStore,
        identityStore: stores.identityStore,
      });
    return { stores, memoryEngine, call };
  }

  it('unauthenticated read/mutation is 401 for GET, POST and PATCH, with or without forged identity headers', () => {
    const { stores, memoryEngine, call } = memoryFixture();
    const a = makeUser(stores, 'a');
    for (const headers of [{}, a.forged]) {
      assert.equal(call('GET', null, headers)?.status, 401);
      assert.equal(call('POST', { memoryCaptureEnabled: false }, headers)?.status, 401);
      assert.equal(call('PATCH', { memoryUseEnabled: false }, headers)?.status, 401);
    }
    assert.equal(memoryEngine.getSettings(a.tenantId, a.userId).memoryCaptureEnabled, true, 'nothing may have been written');
  });

  it('cross-user and cross-tenant: A writes A; B (and forged headers naming A or B) never inherit, read or mutate it', () => {
    const { stores, memoryEngine, call } = memoryFixture();
    const a = makeUser(stores, 'a');
    const b = makeUser(stores, 'b');

    // A writes while naming B in headers: the write lands on A.
    assert.equal(call('POST', { memoryCaptureEnabled: false }, { ...a.cookie, ...b.forged })?.status, 200);
    assert.equal(memoryEngine.getSettings(a.tenantId, a.userId).memoryCaptureEnabled, false);
    assert.equal(memoryEngine.getSettings(b.tenantId, b.userId).memoryCaptureEnabled, true, "B's settings untouched");

    // B reading while naming A in headers sees B's own (default), not A's.
    assert.equal((call('GET', null, { ...b.cookie, ...a.forged })!.data as any).memoryCaptureEnabled, true);
    // B writing while naming A in headers changes B, not A.
    call('PATCH', { memoryUseEnabled: false }, { ...b.cookie, ...a.forged });
    assert.equal(memoryEngine.getSettings(b.tenantId, b.userId).memoryUseEnabled, false);
    assert.equal(memoryEngine.getSettings(a.tenantId, a.userId).memoryUseEnabled, true);

    // Cross-tenant: the record key is (session tenant, session user); the
    // legacy default identity's settings are never reachable from a session.
    assert.equal(memoryEngine.getSettings('ten_production_01', 'usr_admin_001').memoryCaptureEnabled, true);
    assert.equal((call('GET', null, a.cookie)!.data as any).tenantId, a.tenantId);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('R24.6C — Google OAuth ownership is the authenticated account', () => {
  const OAUTH_ENV = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'] as const;
  const FAKE_TOKEN_RESPONSE = { access_token: 'oauth-test-access-not-a-secret', refresh_token: 'oauth-test-refresh-not-a-secret', expires_in: 3600, scope: 'https://www.googleapis.com/auth/calendar.events', token_type: 'Bearer' };

  async function withOAuthEnv<T>(run: () => Promise<T>): Promise<T> {
    const old = Object.fromEntries(OAUTH_ENV.map((k) => [k, process.env[k]]));
    const realFetch = globalThis.fetch;
    process.env.GOOGLE_CLIENT_ID = 'test-client';
    process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
    process.env.GOOGLE_REDIRECT_URI = 'http://localhost/oauth/callback';
    globalThis.fetch = (async () => new Response(JSON.stringify(FAKE_TOKEN_RESPONSE), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    try {
      return await run();
    } finally {
      globalThis.fetch = realFetch;
      for (const k of OAUTH_ENV) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; }
    }
  }

  function oauthFixture() {
    const stores = openStores(tmp('oauth'));
    const audit = new AuditLogger();
    const a = makeUser(stores, 'a');
    const b = makeUser(stores, 'b');
    const startUrl = (headers: Record<string, string>) => handleGoogleOAuthStartRoutes('GET', '/api/v1/oauth/google/start-url', null, headers, {}, stores);
    const stateOf = (res: any) => new URL(res.data.authorizeUrl).searchParams.get('state')!;
    const callback = (headers: Record<string, string>, state: string) =>
      handleGoogleOAuthCallbackRoutes('GET', '/api/v1/oauth/google/callback', null, headers, { state, code: 'auth-code' }, { auditLogger: audit, ...stores });
    const status = (headers: Record<string, string>) => handleGoogleOAuthCallbackRoutes('GET', '/api/v1/oauth/google/status', null, headers, {}, { auditLogger: audit, ...stores });
    const disconnect = (headers: Record<string, string>) => handleGoogleOAuthCallbackRoutes('POST', '/api/v1/oauth/google/disconnect', null, headers, {}, { auditLogger: audit, ...stores });
    const cleanup = () => { for (const u of [a, b]) googleTokenStore.clearForPrincipal(u.tenantId, u.userId); };
    return { stores, audit, a, b, startUrl, stateOf, callback, status, disconnect, cleanup };
  }

  it('connect: unauthenticated start is refused; the token is stored for the session user only, never for a forged identity', async () => {
    await withOAuthEnv(async () => {
      const f = oauthFixture();
      try {
        assert.equal(f.startUrl({})?.status, 401);
        assert.equal(f.startUrl(f.a.forged)?.status, 401, 'identity headers do not authenticate a connect');
        const redirect = handleGoogleOAuthStartRoutes('GET', '/api/v1/oauth/google/start', null, f.a.forged, {}, f.stores);
        assert.equal(redirect?.status, 302);
        assert.match(String(redirect?.redirectTo), /status=signin_required/);

        // A starts while sending B's identity headers.
        const state = f.stateOf(f.startUrl({ ...f.a.cookie, ...f.b.forged }));
        const done = await f.callback({ ...f.a.cookie, 'x-principal-id': 'usr_attacker', 'x-nagex-tenant': 'ten_attacker' }, state);
        assert.match(String(done?.redirectTo), /status=connected/);

        assert.equal(googleTokenStore.getStatusForPrincipal(f.a.tenantId, f.a.userId).connected, true, 'token belongs to the authenticated user');
        assert.equal(googleTokenStore.getStatusForPrincipal(f.b.tenantId, f.b.userId).connected, false, 'B (named in the forged header) gets nothing');
        assert.equal(googleTokenStore.getStatusForPrincipal('ten_attacker', 'usr_attacker').connected, false);
        assert.equal(f.audit.getAuditLogs(f.a.tenantId).filter((l) => l.action === 'oauth:google_connected' && l.actor.id === f.a.userId).length, 1);
      } finally { f.cleanup(); }
    });
  });

  it('callback correlation: a state started by A cannot be completed anonymously or by B, and is one-time', async () => {
    await withOAuthEnv(async () => {
      const f = oauthFixture();
      try {
        const s1 = f.stateOf(f.startUrl(f.a.cookie));
        assert.match(String((await f.callback({}, s1))?.redirectTo), /status=error/, 'no session -> refused');
        assert.equal(googleTokenStore.getStatusForPrincipal(f.a.tenantId, f.a.userId).connected, false);

        const s2 = f.stateOf(f.startUrl(f.a.cookie));
        assert.match(String((await f.callback({ ...f.b.cookie, ...f.a.forged }, s2))?.redirectTo), /status=error/, "B's session cannot complete A's flow");
        assert.equal(googleTokenStore.getStatusForPrincipal(f.a.tenantId, f.a.userId).connected, false);
        assert.equal(googleTokenStore.getStatusForPrincipal(f.b.tenantId, f.b.userId).connected, false);

        const s3 = f.stateOf(f.startUrl(f.a.cookie));
        assert.match(String((await f.callback(f.a.cookie, s3))?.redirectTo), /status=connected/);
        assert.match(String((await f.callback(f.a.cookie, s3))?.redirectTo), /status=error/, 'state is single use');
      } finally { f.cleanup(); }
    });
  });

  it('status and disconnect act on the session user only: B never sees or revokes A, forged headers change nothing', async () => {
    await withOAuthEnv(async () => {
      const f = oauthFixture();
      try {
        googleTokenStore.saveForPrincipal(f.a.tenantId, f.a.userId, { accessToken: 'at_A_not_a_secret', refreshToken: null, expiresAt: Date.now() + 3_600_000, scope: 'calendar' });

        assert.equal((await f.status({}))?.status, 401);
        assert.equal((await f.status(f.a.forged))?.status, 401);
        assert.equal(((await f.status({ ...f.a.cookie, ...f.b.forged }))!.data as any).connected, true);
        assert.equal(((await f.status({ ...f.b.cookie, ...f.a.forged }))!.data as any).connected, false, "B naming A's headers must not see A's connection");

        assert.equal((await f.disconnect({}))?.status, 401);
        assert.equal((await f.disconnect(f.a.forged))?.status, 401);
        assert.equal((await f.disconnect({ ...f.b.cookie, ...f.a.forged }))?.status, 200);
        assert.equal(googleTokenStore.getStatusForPrincipal(f.a.tenantId, f.a.userId).connected, true, "B's disconnect must not revoke A's token");

        assert.equal((await f.disconnect({ ...f.a.cookie, ...f.b.forged }))?.status, 200);
        assert.equal(googleTokenStore.getStatusForPrincipal(f.a.tenantId, f.a.userId).connected, false);
      } finally { f.cleanup(); }
    });
  });

  it('Connected Apps compatibility path: session-owned, reads the same canonical token store (non-divergent), forged headers ignored', async () => {
    await withOAuthEnv(async () => {
      const f = oauthFixture();
      const deps = { connectionStore: new ConnectionStore(), ...f.stores };
      const google = async (headers: Record<string, string>) => {
        const res = await handleConnectionsRoutes('GET', '/api/v1/connections', null, headers, {}, deps);
        return ((res!.data as any).connections as any[]).find((c) => c.provider === 'google').status as string;
      };
      try {
        assert.equal((await handleConnectionsRoutes('GET', '/api/v1/connections', null, f.a.forged, {}, deps))?.status, 401);
        googleTokenStore.saveForPrincipal(f.a.tenantId, f.a.userId, { accessToken: 'at_A_not_a_secret', refreshToken: null, expiresAt: Date.now() + 3_600_000, scope: 'calendar' });

        // Divergence check: /connections and /oauth/google/status always agree, for both users.
        for (const [who, other] of [[f.a, f.b], [f.b, f.a]] as const) {
          const headers = { ...who.cookie, ...other.forged };
          const viaStatus = ((await f.status(headers))!.data as any).connected ? 'CONNECTED' : 'DISCONNECTED';
          assert.equal(await google(headers), viaStatus);
        }
        assert.equal(await google({ ...f.a.cookie, ...f.b.forged }), 'CONNECTED');
        assert.equal(await google({ ...f.b.cookie, ...f.a.forged }), 'DISCONNECTED');

        // B disconnecting (naming A) cannot revoke A's canonical token through the compat route either.
        await handleConnectionsRoutes('POST', '/api/v1/connections/google/disconnect', null, { ...f.b.cookie, ...f.a.forged }, {}, deps);
        assert.equal(googleTokenStore.getStatusForPrincipal(f.a.tenantId, f.a.userId).connected, true);
        await handleConnectionsRoutes('POST', '/api/v1/connections/google/disconnect', null, { ...f.a.cookie, ...f.b.forged }, {}, deps);
        assert.equal(googleTokenStore.getStatusForPrincipal(f.a.tenantId, f.a.userId).connected, false);
        assert.equal(await google(f.a.cookie), 'DISCONNECTED');
      } finally { f.cleanup(); }
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('R24.6C — Daily Brief resolves the authenticated user\'s own Google token', () => {
  const config: GoogleOAuthConfig = { clientId: 'cid', clientSecret: 'csecret', redirectUri: 'https://nagex-test.agex.site/api/v1/oauth/google/callback' };
  const jsonResponse = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });

  function briefFixture(tenantId: string, connectedPrincipals: Array<{ id: string; token: string }>) {
    const calendarTokens = new InMemoryGoogleOAuthTokenStore();
    const gmailTokens = new InMemoryGoogleOAuthTokenStore();
    for (const p of connectedPrincipals) {
      calendarTokens.saveForPrincipal(tenantId, p.id, { accessToken: p.token, refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, scope: GOOGLE_CALENDAR_SCOPES.join(' ') });
      gmailTokens.saveForPrincipal(tenantId, p.id, { accessToken: p.token, refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, scope: GMAIL_SCOPES.join(' ') });
    }
    const bearers: string[] = [];
    const record = (init?: RequestInit) => { bearers.push(String((init?.headers as Record<string, string> | undefined)?.Authorization ?? (init?.headers as Record<string, string> | undefined)?.authorization ?? '')); };
    const calendarFetch = (async (_url: unknown, init?: RequestInit) => { record(init); return jsonResponse({ items: [{ id: 'evt_1', summary: 'Strategy Sync', start: { dateTime: '2026-01-01T15:00:00Z' }, end: { dateTime: '2026-01-01T16:00:00Z' } }] }); }) as typeof fetch;
    const gmailFetch = (async (_url: unknown, init?: RequestInit) => { record(init); return jsonResponse({ threads: [] }); }) as typeof fetch;
    const approvals = new ActionApprovalStore();
    const audit = new AuditLogger();
    const memory = new MemoryEngine({ dir: path.join(tmp('brief-mem'), 'm'), settingsDir: path.join(tmp('brief-mem-s'), 's') });
    const calendarService = new GoogleCalendarService(calendarTokens, approvals, audit, memory, calendarFetch, () => config);
    const gmailApiService = new GmailService(gmailTokens, approvals, audit, memory, gmailFetch, () => config);
    const aiService = new AiService(new UnifiedModelRouter([createStructuredModelProvider(() => JSON.stringify({ summary: 'ok', actionItems: [] }))], { info: () => {}, warn: () => {} }));
    const taskStore = new TaskStore({ dir: tmp('brief-tasks') });
    const activityStore = new ActivityStore({ dir: tmp('brief-activity') });
    const dailyBriefStore = new DailyBriefStore({ dir: tmp('brief-store') });
    return { bearers, deps: { calendarService, gmailApiService, aiService, taskStore, activityStore }, taskStore, dailyBriefStore };
  }

  it("a user's brief is built from THAT user's token; another user in the same tenant never resolves it (and vice versa)", async () => {
    const T = `ten_brief_${RUN}`;
    const A = 'usr_brief_a';
    const B = 'usr_brief_b';
    const f = briefFixture(T, [{ id: A, token: 'at_USER_A' }]);

    const briefA = await generateDailyBriefOnce(f.deps, T, A, 'req_a', true, 'MANUAL');
    assert.equal(briefA.calendarStatus, 'CONNECTED');
    assert.ok(f.bearers.length > 0 && f.bearers.every((h) => h === 'Bearer at_USER_A'), `A's brief must use A's token only (saw ${JSON.stringify(f.bearers)})`);

    f.bearers.length = 0;
    const briefB = await generateDailyBriefOnce(f.deps, T, B, 'req_b', true, 'MANUAL');
    assert.equal(briefB.calendarStatus, 'DISCONNECTED', "B has no connection: A's token must not be used");
    assert.equal(briefB.gmailStatus, 'DISCONNECTED');
    assert.equal(f.bearers.length, 0, "no Google call may be made with A's token on B's behalf");
    assert.equal(briefB.schedule.length, 0);

    // …and in reverse: connecting only B does not light up A.
    const g = briefFixture(T, [{ id: B, token: 'at_USER_B' }]);
    assert.equal((await generateDailyBriefOnce(g.deps, T, A, 'req_a2', true, 'MANUAL')).calendarStatus, 'DISCONNECTED');
    assert.equal(g.bearers.length, 0);
    assert.equal((await generateDailyBriefOnce(g.deps, T, B, 'req_b2', true, 'MANUAL')).calendarStatus, 'CONNECTED');
    assert.ok(g.bearers.every((h) => h === 'Bearer at_USER_B'));
  });

  it('DAILY_BRIEF_GOOGLE_LINK: session → Proactive Assistant task → scheduled runner → the same user\'s canonical Google token', async () => {
    const stores = openStores(tmp('brief-link'));
    const a = makeUser(stores, 'a');
    const b = makeUser(stores, 'b');
    const f = briefFixture(a.tenantId, [{ id: a.userId, token: 'at_USER_A' }]);

    // The schedule is created through the real route, owned by the session.
    const created = await handleDailyBriefRoutes('PUT', '/api/v1/proactive-assistant/config', { enabled: false, localTime: '08:00', timezone: 'UTC', weekdays: [1], notifyOnComplete: false }, { ...a.cookie, ...b.forged }, {}, { sessionStore: stores.sessionStore, identityStore: stores.identityStore, taskStore: f.taskStore } as any);
    assert.equal(created?.status, 200);
    const task = f.taskStore.list(a.tenantId, a.userId).find((t) => t.automationKind === 'DAILY_BRIEF')!;
    assert.equal(task.tenantId, a.tenantId);
    assert.equal(task.ownerId, a.userId, 'the scheduler hands the runner exactly the session identity');

    // The scheduled run for that task uses that user's token and persists under that user.
    const runner = new DailyBriefTaskRunner(f.deps, f.dailyBriefStore);
    const outcome = await runner.run(task, 'req_sched', 'run_1');
    assert.equal(outcome.status, 'SUCCEEDED');
    assert.ok(f.bearers.length > 0 && f.bearers.every((h) => h === 'Bearer at_USER_A'));
    assert.equal(f.dailyBriefStore.getForDate(a.tenantId, a.userId, dailyBriefDateKey())?.calendarStatus, 'CONNECTED');
    assert.equal(f.dailyBriefStore.getForDate(b.tenantId, b.userId, dailyBriefDateKey()) ?? null, null, "B's brief store is untouched");
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('R24.6C — forged identity headers through the real production entry points', () => {
  it('as user A, sending user B\'s X-Principal-Id / X-NAgex-Tenant: Quick Wake, Autonomy, Proactive Assistant, memory settings, Google status/disconnect and Connections all act as A (or reject)', async () => {
    const stores = productionStores();
    const a = makeUser(stores, 'fa');
    const b = makeUser(stores, 'fb');
    const asAWithBHeaders = { ...a.cookie, ...b.forged };
    const asBWithAHeaders = { ...b.cookie, ...a.forged };
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch; // revoke is best-effort network; never real
    googleTokenStore.saveForPrincipal(a.tenantId, a.userId, { accessToken: 'at_FA_not_a_secret', refreshToken: null, expiresAt: Date.now() + 3_600_000, scope: 'calendar' });
    try {
      // Quick Wake / Autonomy
      assert.equal((await asyncCall('POST', '/api/v1/quickwake/config', { voice_wake: true }, asAWithBHeaders)).status, 200);
      assert.equal(((await asyncCall('GET', '/api/v1/quickwake/config', null, asBWithAHeaders)).data as any).voice_wake, false, 'B must not see A\'s Quick Wake');
      assert.equal(((await asyncCall('GET', '/api/v1/quickwake/config', null, asAWithBHeaders)).data as any).voice_wake, true);
      assert.equal((await asyncCall('POST', '/api/v1/autonomy/config', { level: 'L0' }, asAWithBHeaders)).status, 200);
      assert.equal(((await asyncCall('GET', '/api/v1/autonomy/config', null, asBWithAHeaders)).data as any).level, 'L2');

      // Proactive Assistant
      const put = await asyncCall('PUT', '/api/v1/proactive-assistant/config', { enabled: false, localTime: '06:30', timezone: 'UTC', weekdays: [2], notifyOnComplete: false }, asAWithBHeaders);
      assert.equal(put.status, 200);
      assert.equal(server.taskStore.list(a.tenantId, a.userId).filter((t) => t.automationKind === 'DAILY_BRIEF').length, 1);
      assert.equal(server.taskStore.list(b.tenantId, b.userId).length, 0);
      assert.equal(((await asyncCall('GET', '/api/v1/proactive-assistant/config', null, asBWithAHeaders)).data as any).localTime, null);

      // Memory settings (sync entry point)
      assert.equal(server.handleApiRequest('POST', '/api/v1/memory/settings', { memoryCaptureEnabled: false }, asAWithBHeaders).status, 200);
      assert.equal((server.handleApiRequest('GET', '/api/v1/memory/settings', null, a.cookie).data as any).memoryCaptureEnabled, false);
      assert.equal((server.handleApiRequest('GET', '/api/v1/memory/settings', null, b.cookie).data as any).memoryCaptureEnabled, true);
      assert.equal((server.handleApiRequest('GET', '/api/v1/memory/settings', null, asBWithAHeaders).data as any).memoryCaptureEnabled, true);

      // Google status / disconnect / Connections
      assert.equal(((await asyncCall('GET', '/api/v1/oauth/google/status', null, asBWithAHeaders)).data as any).connected, false);
      assert.equal(((await asyncCall('GET', '/api/v1/oauth/google/status', null, asAWithBHeaders)).data as any).connected, true);
      const googleRow = async (h: Record<string, string>) => (((await asyncCall('GET', '/api/v1/connections', null, h)).data as any).connections as any[]).find((c) => c.provider === 'google').status;
      assert.equal(await googleRow(asBWithAHeaders), 'DISCONNECTED');
      assert.equal(await googleRow(asAWithBHeaders), 'CONNECTED');
      assert.equal((await asyncCall('POST', '/api/v1/oauth/google/disconnect', null, asBWithAHeaders)).status, 200);
      assert.equal(googleTokenStore.getStatusForPrincipal(a.tenantId, a.userId).connected, true, "B's (forged) disconnect must not revoke A");
      await asyncCall('POST', '/api/v1/connections/google/disconnect', null, asBWithAHeaders);
      assert.equal(googleTokenStore.getStatusForPrincipal(a.tenantId, a.userId).connected, true);
    } finally {
      googleTokenStore.clearForPrincipal(a.tenantId, a.userId);
      globalThis.fetch = realFetch;
    }
  });

  it('anonymous callers naming a real account in the headers are rejected on every Settings route', async () => {
    const stores = productionStores();
    const a = makeUser(stores, 'anon');
    for (const p of ['/api/v1/quickwake/config', '/api/v1/autonomy/config', '/api/v1/proactive-assistant/config', '/api/v1/oauth/google/status', '/api/v1/connections']) {
      assert.equal((await asyncCall('GET', p, null, a.forged)).status, 401, p);
      assert.equal((await asyncCall('GET', p, null, {})).status, 401, `${p} (no identity at all)`);
    }
    assert.equal(server.handleApiRequest('GET', '/api/v1/memory/settings', null, a.forged).status, 401);
    assert.equal(server.handleApiRequest('POST', '/api/v1/memory/settings', { memoryCaptureEnabled: false }, a.forged).status, 401);
    assert.equal((await asyncCall('POST', '/api/v1/oauth/google/disconnect', null, a.forged)).status, 401);
    assert.equal((await asyncCall('PUT', '/api/v1/proactive-assistant/config', { enabled: true, localTime: '08:00', timezone: 'UTC', weekdays: [1] }, a.forged)).status, 401);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Real second server process: forged headers + restart persistence under the session identity.
// ─────────────────────────────────────────────────────────────────────────
async function waitForHealth(origin: string, child: ChildProcess): Promise<void> {
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`server exited early (code ${child.exitCode})`);
    try { if ((await fetch(`${origin}/api/v1/health`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not become healthy');
}
async function stopServerProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => { child.once('exit', () => resolve()); child.kill(); setTimeout(resolve, 4000); });
}

describe('R24.6C — HTTP-level identity boundary and restart persistence (real server process)', () => {
  it('forged headers are ignored/rejected over HTTP; Proactive Assistant and memory settings survive a restart for the session user only', { timeout: 150_000 }, async () => {
    const root = tmp('process');
    const port = 35000 + Math.floor(Math.random() * 4000);
    const origin = `http://127.0.0.1:${port}`;
    const env = {
      ...process.env,
      PORT: String(port),
      NAGEX_IDENTITY_DIR: path.join(root, 'identity'),
      NAGEX_SESSIONS_DIR: path.join(root, 'sessions'),
      NAGEX_TASKS_DIR: path.join(root, 'tasks'),
      NAGEX_MEMORY_SETTINGS_DIR: path.join(root, 'memory-settings'),
      NAGEX_TRUSTED_PROXIES: SPAWNED_SERVER_TRUSTED_PROXIES,   // S2E: the spawned server trusts this test client as its front proxy
    };
    const start = () => spawn(process.execPath, [path.resolve(process.cwd(), 'dist', 'src', 'server_web.js')], { cwd: process.cwd(), env, stdio: 'ignore' });
    let child: ChildProcess | null = null;
    let ipCounter = 0;
    const call = async (method: string, p: string, body?: unknown, headers: Record<string, string> = {}, ip?: string) => {
      const res = await fetch(origin + p, { method, headers: { 'content-type': 'application/json', ...(ip ? { 'x-forwarded-for': ip } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      let data: any = null;
      try { data = await res.json(); } catch { /* empty */ }
      return { status: res.status, data, setCookie: (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ') };
    };
    const signIn = async (label: string) => {
      const ip = `10.246.3.${++ipCounter}`;
      const email = `${label}_${RUN}@example.invalid`;
      const signup = await call('POST', '/api/v1/auth/signup', { email, password: 'Boundary-Cert-1!', passwordConfirmation: 'Boundary-Cert-1!', termsAccepted: true, privacyAccepted: true }, {}, ip);
      assert.equal(signup.status, 201);
      await call('POST', '/api/v1/auth/verify-email', { token: signup.data.devVerificationToken }, {}, ip);
      const login = await call('POST', '/api/v1/auth/login', { email, password: 'Boundary-Cert-1!' }, {}, ip);
      assert.equal(login.status, 200);
      return { cookie: { cookie: login.setCookie }, userId: signup.data.user.userId as string, email, ip, forged: { 'x-principal-id': signup.data.user.userId as string, 'x-nagex-tenant': `ten_${signup.data.user.userId}` } };
    };

    try {
      child = start();
      await waitForHealth(origin, child);
      const a = await signIn('proc_a');
      const b = await signIn('proc_b');

      // Anonymous + a header naming a real account: rejected everywhere.
      for (const p of ['/api/v1/quickwake/config', '/api/v1/autonomy/config', '/api/v1/proactive-assistant/config', '/api/v1/memory/settings', '/api/v1/oauth/google/status', '/api/v1/connections']) {
        assert.equal((await call('GET', p, undefined, b.forged)).status, 401, p);
      }

      // A writes while sending B's identity.
      const asAWithB = { ...a.cookie, ...b.forged };
      assert.equal((await call('POST', '/api/v1/autonomy/config', { level: 'L0' }, asAWithB)).status, 200);
      assert.equal((await call('PUT', '/api/v1/proactive-assistant/config', { enabled: false, localTime: '05:20', timezone: 'Asia/Seoul', weekdays: [4], notifyOnComplete: false }, asAWithB)).status, 200);
      assert.equal((await call('POST', '/api/v1/memory/settings', { memoryCaptureEnabled: false }, asAWithB)).status, 200);
      const asBWithA = { ...b.cookie, ...a.forged };
      assert.equal((await call('GET', '/api/v1/autonomy/config', undefined, asBWithA)).data.level, 'L2');
      assert.equal((await call('GET', '/api/v1/proactive-assistant/config', undefined, asBWithA)).data.localTime, null);
      assert.equal((await call('GET', '/api/v1/memory/settings', undefined, asBWithA)).data.memoryCaptureEnabled, true);

      await stopServerProcess(child);
      child = start();
      await waitForHealth(origin, child);

      const afterA = { ...a.cookie, ...b.forged };
      assert.equal((await call('GET', '/api/v1/autonomy/config', undefined, afterA)).data.level, 'L0');
      const pa = (await call('GET', '/api/v1/proactive-assistant/config', undefined, afterA)).data;
      assert.deepEqual({ localTime: pa.localTime, timezone: pa.timezone, weekdays: pa.weekdays }, { localTime: '05:20', timezone: 'Asia/Seoul', weekdays: [4] });
      assert.equal((await call('GET', '/api/v1/memory/settings', undefined, afterA)).data.memoryCaptureEnabled, false);
      // B is unaffected after the restart too.
      assert.equal((await call('GET', '/api/v1/proactive-assistant/config', undefined, asBWithA)).data.localTime, null);
      assert.equal((await call('GET', '/api/v1/memory/settings', undefined, asBWithA)).data.memoryCaptureEnabled, true);
      assert.equal((await call('GET', '/api/v1/autonomy/config', undefined, b.forged)).status, 401);
    } finally {
      if (child) await stopServerProcess(child);
    }
  });
});

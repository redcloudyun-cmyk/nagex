// R24.6B — Settings persistence & truthfulness certification.
//
// Quick Wake / Autonomy used to be process-global, unauthenticated,
// unvalidated in-memory objects (R24.6A). These tests exercise the real route
// registrars and real IdentityStore/SessionStore instances over real temp
// directories — plus a real HTTP-level process restart — to prove the repaired
// behavior: per-user, session-authenticated, validated, durable, and honest
// about having no runtime effect.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { IdentityStore, normalizeLocale } from '../src/identity/identity.store.js';
import { IdentityTokenStore } from '../src/identity/identity.tokens.js';
import { IdentityAuditStore } from '../src/identity/identity.audit.js';
import { SessionStore } from '../src/sessions/session.store.js';
import { hashPassword } from '../src/identity/identity.crypto.js';
import { handleSettingsRoutes, type SettingsRouteDeps } from '../src/http/routes/settings.routes.js';
import { handleAccountRoutes } from '../src/http/routes/account.routes.js';
import { handleConnectionsRoutes } from '../src/http/routes/connections.routes.js';
import { ConnectionStore } from '../src/workspace/connections.store.js';
import { googleTokenStore } from '../src/integrations/google/token.store.js';
import { handleApiRequest, handleAsyncApiRequest } from '../src/server_web.js';
import { enableDevAuthTokensForFile } from './_dev_auth_tokens.js';

// R24.6C1 — this file legitimately needs raw dev tokens to drive signup/verify; opt in explicitly (restored after the file).
enableDevAuthTokensForFile();

function tmp(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `nagex-r246b-${label}-`));
}

function openStores(root: string) {
  return {
    identityStore: new IdentityStore({ dir: path.join(root, 'identity') }),
    identityTokenStore: new IdentityTokenStore({ dir: path.join(root, 'tokens') }),
    identityAuditStore: new IdentityAuditStore({ dir: path.join(root, 'audit') }),
    sessionStore: new SessionStore({ dir: path.join(root, 'sessions') }),
  };
}

type Stores = ReturnType<typeof openStores>;

function makeUser(stores: Stores, email: string): { userId: string; cookie: { cookie: string } } {
  const { identity } = stores.identityStore.createAccount(email, hashPassword('password123'));
  stores.identityStore.transitionState(identity.userId, 'ACTIVE');
  const session = stores.sessionStore.createAuthSession(`ten_${identity.userId}`, identity.userId, 'MAIN');
  return { userId: identity.userId, cookie: { cookie: `nagex_session=${session.sessionId}` } };
}

const settings = (stores: Stores): SettingsRouteDeps => ({ identityStore: stores.identityStore, sessionStore: stores.sessionStore });
const call = (stores: Stores, method: string, p: string, body: Record<string, unknown> | null, headers: Record<string, string> = {}) =>
  handleSettingsRoutes(method, p, body, headers, {}, settings(stores));

describe('R24.6B — Quick Wake / Autonomy are authenticated, validated, per-user and durable', () => {
  it('rejects every unauthenticated read and write (headers never authenticate)', async () => {
    const stores = openStores(tmp('unauth'));
    for (const p of ['/api/v1/quickwake/config', '/api/v1/autonomy/config']) {
      assert.equal((await call(stores, 'GET', p, null))?.status, 401);
      assert.equal((await call(stores, 'POST', p, { voice_wake: true, level: 'L3' }))?.status, 401);
      // Client-supplied identity headers are NOT authentication.
      const spoof = { 'x-principal-id': 'usr_admin_001', 'x-nagex-tenant': 'ten_production_01' };
      assert.equal((await call(stores, 'GET', p, null, spoof))?.status, 401);
      assert.equal((await call(stores, 'POST', p, { voice_wake: true, level: 'L3' }, spoof))?.status, 401);
      // A made-up session id is not a session.
      assert.equal((await call(stores, 'GET', p, null, { cookie: 'nagex_session=sess_does_not_exist' }))?.status, 401);
    }
  });

  it('Quick Wake: user A write is visible to A only; user B neither inherits, reads, nor mutates it', async () => {
    const stores = openStores(tmp('qw-iso'));
    const a = makeUser(stores, 'a@example.com');
    const b = makeUser(stores, 'b@example.com');

    const defaults = (await call(stores, 'GET', '/api/v1/quickwake/config', null, b.cookie))!.data as any;
    assert.equal(defaults.voice_wake, false);
    assert.equal(defaults.floating_button, true);

    const written = await call(stores, 'POST', '/api/v1/quickwake/config', { voice_wake: true, floating_button: false }, a.cookie);
    assert.equal(written?.status, 200);
    const readA = (await call(stores, 'GET', '/api/v1/quickwake/config', null, a.cookie))!.data as any;
    assert.equal(readA.voice_wake, true);
    assert.equal(readA.floating_button, false);

    const readB = (await call(stores, 'GET', '/api/v1/quickwake/config', null, b.cookie))!.data as any;
    assert.equal(readB.voice_wake, false, "user B must not inherit user A's value");
    assert.equal(readB.floating_button, true);

    // B writing does not touch A.
    await call(stores, 'POST', '/api/v1/quickwake/config', { voice_wake: false, double_tap_shortcut: false }, b.cookie);
    const readA2 = (await call(stores, 'GET', '/api/v1/quickwake/config', null, a.cookie))!.data as any;
    assert.equal(readA2.voice_wake, true);
    assert.equal(readA2.double_tap_shortcut, true);

    // A cannot target another user through the body.
    const targeted = await call(stores, 'POST', '/api/v1/quickwake/config', { userId: b.userId, voice_wake: true }, a.cookie);
    assert.equal(targeted?.status, 400);
  });

  it('Autonomy: per-user, default L2 with a description that tracks the level, never shared', async () => {
    const stores = openStores(tmp('au-iso'));
    const a = makeUser(stores, 'a@example.com');
    const b = makeUser(stores, 'b@example.com');

    const initial = (await call(stores, 'GET', '/api/v1/autonomy/config', null, a.cookie))!.data as any;
    assert.equal(initial.level, 'L2');

    const written = (await call(stores, 'POST', '/api/v1/autonomy/config', { level: 'L0' }, a.cookie))!.data as any;
    assert.equal(written.level, 'L0');
    assert.match(written.description, /^Level 0/, 'description must follow the stored level, not stay stale');
    assert.notEqual(written.description, initial.description);

    assert.equal(((await call(stores, 'GET', '/api/v1/autonomy/config', null, b.cookie))!.data as any).level, 'L2', "user B must not inherit user A's level");
    await call(stores, 'POST', '/api/v1/autonomy/config', { level: 'L3' }, b.cookie);
    assert.equal(((await call(stores, 'GET', '/api/v1/autonomy/config', null, a.cookie))!.data as any).level, 'L0');
  });

  it('validates input: unknown/non-boolean Quick Wake options, empty bodies and unsupported autonomy levels are rejected without mutation', async () => {
    const stores = openStores(tmp('validation'));
    const a = makeUser(stores, 'a@example.com');
    const qw = '/api/v1/quickwake/config';
    const au = '/api/v1/autonomy/config';

    assert.equal((await call(stores, 'POST', qw, { arbitrary_key: true }, a.cookie))?.status, 400);
    assert.equal((await call(stores, 'POST', qw, { voice_wake: 'yes' }, a.cookie))?.status, 400);
    assert.equal((await call(stores, 'POST', qw, { voice_wake: 1 }, a.cookie))?.status, 400);
    assert.equal((await call(stores, 'POST', qw, { fingerprint_button: { supported: true } }, a.cookie))?.status, 400, 'a static capability fact is not writable');
    assert.equal((await call(stores, 'POST', qw, {}, a.cookie))?.status, 400);
    assert.equal((await call(stores, 'POST', qw, null, a.cookie))?.status, 400);

    for (const bad of ['L99-INVALID', 'L4', 'l1', '', 'toString', 'constructor', 1, null, undefined]) {
      assert.equal((await call(stores, 'POST', au, { level: bad as unknown }, a.cookie))?.status, 400, `level ${String(bad)} must be rejected`);
    }

    const qwRead = (await call(stores, 'GET', qw, null, a.cookie))!.data as any;
    assert.equal(qwRead.voice_wake, false);
    assert.equal(qwRead.arbitrary_key, undefined);
    assert.equal(qwRead.fingerprint_button.supported, false);
    assert.equal(((await call(stores, 'GET', au, null, a.cookie))!.data as any).level, 'L2');
  });

  it('survives a restart: fresh store instances over the same directories return the stored values (and B stays isolated)', async () => {
    const root = tmp('restart-stores');
    const first = openStores(root);
    const a = makeUser(first, 'a@example.com');
    const b = makeUser(first, 'b@example.com');
    await call(first, 'POST', '/api/v1/quickwake/config', { voice_wake: true, lock_screen_shortcut: false }, a.cookie);
    await call(first, 'POST', '/api/v1/autonomy/config', { level: 'L1' }, a.cookie);

    const second = openStores(root); // "restart": nothing carried over in memory
    const qw = (await call(second, 'GET', '/api/v1/quickwake/config', null, a.cookie))!.data as any;
    assert.equal(qw.voice_wake, true);
    assert.equal(qw.lock_screen_shortcut, false);
    assert.equal(((await call(second, 'GET', '/api/v1/autonomy/config', null, a.cookie))!.data as any).level, 'L1');
    assert.equal(((await call(second, 'GET', '/api/v1/quickwake/config', null, b.cookie))!.data as any).voice_wake, false);
    assert.equal(((await call(second, 'GET', '/api/v1/autonomy/config', null, b.cookie))!.data as any).level, 'L2');
  });

  it('is honest about having no runtime effect, and no runtime module consumes the preferences', async () => {
    const stores = openStores(tmp('truthful'));
    const a = makeUser(stores, 'a@example.com');
    const qw = (await call(stores, 'GET', '/api/v1/quickwake/config', null, a.cookie))!.data as any;
    const au = (await call(stores, 'GET', '/api/v1/autonomy/config', null, a.cookie))!.data as any;
    assert.equal(qw.runtime_effect, 'NONE');
    assert.equal(au.runtime_effect, 'NONE');
    assert.equal(qw.fingerprint_button.supported, false);

    // Tripwire: runtime_effect is only truthful while nothing reads these
    // preferences. If a runtime component starts consuming them, wire the
    // flag deliberately (and update this list) instead of leaving a stale 'NONE'.
    const srcRoot = path.resolve(process.cwd(), 'src');
    const consumers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && /\.getPreferences\(/.test(fs.readFileSync(full, 'utf8'))) consumers.push(path.relative(srcRoot, full).replace(/\\/g, '/'));
      }
    };
    walk(srcRoot);
    assert.deepEqual(consumers.sort(), ['http/routes/settings.routes.ts']);
  });

  it('a failed durable write is never reported as saved and never changes later reads', async () => {
    const stores = openStores(tmp('write-failure'));
    const a = makeUser(stores, 'a@example.com');
    await call(stores, 'POST', '/api/v1/autonomy/config', { level: 'L1' }, a.cookie);
    await call(stores, 'POST', '/api/v1/quickwake/config', { voice_wake: true }, a.cookie);

    // Simulate the disk refusing the write.
    const profileFileStore = (stores.identityStore as unknown as { profileFileStore: { writeOrThrow: (id: string, r: unknown) => void } }).profileFileStore;
    const original = profileFileStore.writeOrThrow.bind(profileFileStore);
    profileFileStore.writeOrThrow = () => { throw new Error('ENOSPC: no space left on device'); };
    try {
      const deps = { identityStore: stores.identityStore, sessionStore: stores.sessionStore };
      const qwFail = await handleAsyncApiRequest('POST', '/api/v1/quickwake/config', { voice_wake: false }, a.cookie, undefined, {}, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, deps);
      assert.ok(qwFail.status >= 400, `failed write must not be a success status (got ${qwFail.status})`);
      assert.ok((qwFail.data as any).error, 'failed write must carry an error body');
      const auFail = await handleAsyncApiRequest('POST', '/api/v1/autonomy/config', { level: 'L3' }, a.cookie, undefined, {}, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, deps);
      assert.ok(auFail.status >= 400);
    } finally {
      profileFileStore.writeOrThrow = original;
    }

    // Neither the in-memory view nor the disk moved.
    assert.equal(((await call(stores, 'GET', '/api/v1/autonomy/config', null, a.cookie))!.data as any).level, 'L1');
    assert.equal(((await call(stores, 'GET', '/api/v1/quickwake/config', null, a.cookie))!.data as any).voice_wake, true);
    const reopened = openStores(path.dirname(path.dirname((stores.identityStore as any).profileFileStore.dir)));
    assert.equal(reopened.identityStore.getPreferences(a.userId).autonomyLevel, 'L1');
  });

  it('the legacy unauthenticated global endpoints are gone from the sync entry point, and the async wiring enforces auth', async () => {
    assert.equal(handleApiRequest('GET', '/api/v1/quickwake/config', null, {}).status, 404);
    assert.equal(handleApiRequest('POST', '/api/v1/autonomy/config', { level: 'L3' }, {}).status, 404);

    const stores = openStores(tmp('wiring'));
    const a = makeUser(stores, 'a@example.com');
    const deps = { identityStore: stores.identityStore, sessionStore: stores.sessionStore };
    const unauth = await handleAsyncApiRequest('GET', '/api/v1/quickwake/config', null, {}, undefined, {}, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, deps);
    assert.equal(unauth.status, 401);
    const authed = await handleAsyncApiRequest('POST', '/api/v1/autonomy/config', { level: 'L3' }, a.cookie, undefined, {}, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, deps);
    assert.equal(authed.status, 200);
    assert.equal((authed.data as any).level, 'L3');
  });

  it('account deletion purge removes the stored preferences with the rest of the personal data', () => {
    const stores = openStores(tmp('purge'));
    const a = makeUser(stores, 'a@example.com');
    stores.identityStore.updatePreferences(a.userId, { autonomyLevel: 'L3', quickWake: { voice_wake: true } });
    stores.identityStore.transitionState(a.userId, 'DELETION_PENDING');
    stores.identityStore.purgeAccountData(a.userId);
    assert.deepEqual(stores.identityStore.getPreferences(a.userId), {});
    const reopened = new IdentityStore({ dir: path.join((stores.identityStore as any).profileFileStore.dir, '..') });
    assert.deepEqual(reopened.getPreferences(a.userId), {});
  });
});

describe('R24.6B — account locale has one canonical form', () => {
  it('canonicalizes accepted aliases to en|ko and rejects anything else without storing it', async () => {
    assert.equal(normalizeLocale('en'), 'en');
    assert.equal(normalizeLocale('EN'), 'en');
    assert.equal(normalizeLocale('ko'), 'ko');
    assert.equal(normalizeLocale('KR'), 'ko');
    assert.equal(normalizeLocale('kr'), 'ko');
    assert.equal(normalizeLocale('ZZ'), null);
    assert.equal(normalizeLocale(''), null);
    assert.equal(normalizeLocale(undefined), null);

    const stores = openStores(tmp('locale'));
    const a = makeUser(stores, 'a@example.com');
    const patch = (locale: unknown) => handleAccountRoutes('PATCH', '/api/v1/account/profile', { locale }, a.cookie, {}, stores);

    assert.equal(((await patch('KR'))!.data as any).profile.locale, 'ko');
    assert.equal(((await patch('EN'))!.data as any).profile.locale, 'en');
    await patch('ko');
    const bad = await patch('ZZ');
    assert.equal(bad?.status, 400);
    assert.equal((bad!.data as any).error.code, 'INVALID_LOCALE');
    assert.equal(((await handleAccountRoutes('GET', '/api/v1/account', null, a.cookie, {}, stores))!.data as any).profile.locale, 'ko', 'a rejected locale must leave the stored one untouched');
  });

  it('the canonical locale survives a restart, and a legacy uppercase record on disk loads as canonical', async () => {
    const root = tmp('locale-restart');
    const first = openStores(root);
    const a = makeUser(first, 'a@example.com');
    first.identityStore.updateProfile(a.userId, { locale: 'KR' });
    assert.equal(openStores(root).identityStore.getProfile(a.userId)!.locale, 'ko');

    // Hand-write a legacy record exactly as the old uncontrolled PATCH stored it.
    const file = path.join(root, 'identity', 'profiles', `${a.userId}.json`);
    const legacy = JSON.parse(fs.readFileSync(file, 'utf8'));
    legacy.locale = 'KR';
    fs.writeFileSync(file, JSON.stringify(legacy));
    assert.equal(openStores(root).identityStore.getProfile(a.userId)!.locale, 'ko');
    legacy.locale = 'garbage';
    fs.writeFileSync(file, JSON.stringify(legacy));
    assert.equal(openStores(root).identityStore.getProfile(a.userId)!.locale, 'en');
  });
});

describe('R24.6B/C — the connections compatibility path cannot diverge from the Google OAuth source of truth', () => {
  // R24.6C — identity is the authenticated session, never headers.
  function connectionsFixture() {
    const stores = openStores(tmp('connections'));
    const a = makeUser(stores, 'conn_a@example.com');
    const tenant = `ten_${a.userId}`;
    const deps = { connectionStore: new ConnectionStore(), sessionStore: stores.sessionStore, identityStore: stores.identityStore };
    return { stores, a, tenant, deps };
  }

  it('reports google status derived from googleTokenStore, and never fabricates a connection', async () => {
    const { a, tenant, deps } = connectionsFixture();
    const get = async () => {
      const res = await handleConnectionsRoutes('GET', '/api/v1/connections', null, a.cookie, {}, deps);
      return ((res!.data as any).connections as any[]).find((c) => c.provider === 'google');
    };
    googleTokenStore.clearForPrincipal(tenant, a.userId);
    assert.equal((await get()).status, 'DISCONNECTED');

    googleTokenStore.saveForPrincipal(tenant, a.userId, { accessToken: 'test-access-not-a-secret', refreshToken: null, expiresAt: Date.now() + 3_600_000, scope: 'calendar' });
    try {
      assert.equal(googleTokenStore.getStatusForPrincipal(tenant, a.userId).connected, true);
      assert.equal((await get()).status, 'CONNECTED', 'compat path must read the canonical OAuth state');
    } finally {
      googleTokenStore.clearForPrincipal(tenant, a.userId);
    }
    assert.equal((await get()).status, 'DISCONNECTED');
  });

  it('has no second writer for google (disconnect goes through the canonical store), and does not fabricate CONNECTED for providers with no integration', async () => {
    const { a, tenant, deps } = connectionsFixture();
    const post = (p: string) => handleConnectionsRoutes('POST', p, null, a.cookie, {}, deps);

    // Disconnect through the compat path really clears the canonical state (no network: fetch stubbed).
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch;
    googleTokenStore.saveForPrincipal(tenant, a.userId, { accessToken: 'test-access-not-a-secret', refreshToken: null, expiresAt: Date.now() + 3_600_000, scope: 'calendar' });
    try {
      assert.equal(googleTokenStore.getStatusForPrincipal(tenant, a.userId).connected, true);
      const res = await post('/api/v1/connections/google/disconnect');
      assert.equal(res?.status, 200);
      assert.equal((res!.data as any).status, 'DISCONNECTED');
      assert.equal(googleTokenStore.getStatusForPrincipal(tenant, a.userId).connected, false, 'canonical OAuth state must be cleared by the compat disconnect');
    } finally {
      globalThis.fetch = realFetch;
      googleTokenStore.clearForPrincipal(tenant, a.userId);
    }

    assert.equal((await post('/api/v1/connections/google/sync'))?.status, 409);
    for (const provider of ['microsoft', 'slack', 'telegram']) {
      assert.equal((await post(`/api/v1/connections/${provider}/sync`))?.status, 501);
    }
    const list = (await handleConnectionsRoutes('GET', '/api/v1/connections', null, a.cookie, {}, deps))!.data as any;
    assert.ok(list.connections.every((c: any) => c.status === 'DISCONNECTED'));
  });

  it('requires a session: no cookie (even with an identity header) is 401', async () => {
    const { a, deps } = connectionsFixture();
    const forged = { 'x-principal-id': a.userId, 'x-nagex-tenant': `ten_${a.userId}` };
    assert.equal((await handleConnectionsRoutes('GET', '/api/v1/connections', null, forged, {}, deps))?.status, 401);
    assert.equal((await handleConnectionsRoutes('POST', '/api/v1/connections/google/disconnect', null, forged, {}, deps))?.status, 401);
  });
});

describe('R24.6B — the "Quick Wake" settings and the desktop runtime status are different things (no shared mutable copy)', () => {
  it('desktop quickwake status exposes runtime window state only, none of the preference keys', async () => {
    process.env.NAGEX_DESKTOP_BRIDGE_TOKEN = 'desktop-test-token';
    const res = await handleAsyncApiRequest('GET', '/api/v1/desktop/quickwake/status', null, { 'x-nagex-desktop-bridge-token': 'desktop-test-token' });
    delete process.env.NAGEX_DESKTOP_BRIDGE_TOKEN;
    assert.equal(res.status, 200);
    const keys = Object.keys(res.data as object);
    for (const prefKey of ['floating_button', 'quick_settings_tile', 'lock_screen_shortcut', 'voice_wake', 'double_tap_shortcut', 'fingerprint_button', 'runtime_effect']) {
      assert.ok(!keys.includes(prefKey), `${prefKey} must not be duplicated into the runtime status`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// HTTP-level process restart certification (a real second server process).
// ─────────────────────────────────────────────────────────────────────────

async function waitForHealth(origin: string, child: ChildProcess): Promise<void> {
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`server exited early (code ${child.exitCode})`);
    try {
      const r = await fetch(`${origin}/api/v1/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not become healthy');
}

function startServerProcess(port: number, identityDir: string, sessionsDir: string): ChildProcess {
  return spawn(process.execPath, [path.resolve(process.cwd(), 'dist', 'src', 'server_web.js')], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), NAGEX_IDENTITY_DIR: identityDir, NAGEX_SESSIONS_DIR: sessionsDir },
    stdio: 'ignore',
  });
}

async function stopServerProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.kill();
    setTimeout(resolve, 4000);
  });
}

describe('R24.6B — HTTP-level server restart certification', () => {
  it('Quick Wake and Autonomy survive a real server process restart for the same authenticated user only', { timeout: 120_000 }, async () => {
    const root = tmp('process-restart');
    const identityDir = path.join(root, 'identity');
    const sessionsDir = path.join(root, 'sessions');
    const port = 31000 + Math.floor(Math.random() * 4000);
    const origin = `http://127.0.0.1:${port}`;
    let child: ChildProcess | null = null;

    const json = async (method: string, p: string, body?: unknown, cookie?: string) => {
      const res = await fetch(origin + p, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      let data: any = null;
      try { data = await res.json(); } catch { /* empty */ }
      return { status: res.status, data, setCookie: (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ') };
    };
    const signIn = async (email: string) => {
      const signup = await json('POST', '/api/v1/auth/signup', { email, password: 'Restart-Cert-1!', passwordConfirmation: 'Restart-Cert-1!', termsAccepted: true, privacyAccepted: true });
      assert.equal(signup.status, 201);
      await json('POST', '/api/v1/auth/verify-email', { token: signup.data.devVerificationToken });
      const login = await json('POST', '/api/v1/auth/login', { email, password: 'Restart-Cert-1!' });
      assert.equal(login.status, 200);
      return login.setCookie;
    };

    try {
      child = startServerProcess(port, identityDir, sessionsDir);
      await waitForHealth(origin, child);

      assert.equal((await json('GET', '/api/v1/quickwake/config')).status, 401);
      const cookieA = await signIn('restart_a@example.invalid');
      const cookieB = await signIn('restart_b@example.invalid');

      assert.equal((await json('POST', '/api/v1/quickwake/config', { voice_wake: true, floating_button: false }, cookieA)).status, 200);
      assert.equal((await json('POST', '/api/v1/autonomy/config', { level: 'L0' }, cookieA)).status, 200);
      assert.equal((await json('GET', '/api/v1/quickwake/config', undefined, cookieA)).data.voice_wake, true);
      assert.equal((await json('GET', '/api/v1/autonomy/config', undefined, cookieA)).data.level, 'L0');
      assert.equal((await json('GET', '/api/v1/autonomy/config', undefined, cookieB)).data.level, 'L2');

      await stopServerProcess(child);
      child = startServerProcess(port, identityDir, sessionsDir);
      await waitForHealth(origin, child);

      // Unauthenticated is still rejected after the restart…
      assert.equal((await json('GET', '/api/v1/autonomy/config')).status, 401);
      // …the persisted session authenticates and reads the persisted values…
      const qwAfter = await json('GET', '/api/v1/quickwake/config', undefined, cookieA);
      assert.equal(qwAfter.status, 200);
      assert.equal(qwAfter.data.voice_wake, true);
      assert.equal(qwAfter.data.floating_button, false);
      assert.equal((await json('GET', '/api/v1/autonomy/config', undefined, cookieA)).data.level, 'L0');
      // …a fresh sign-in sees the same values…
      const relogin = (await json('POST', '/api/v1/auth/login', { email: 'restart_a@example.invalid', password: 'Restart-Cert-1!' })).setCookie;
      assert.equal((await json('GET', '/api/v1/autonomy/config', undefined, relogin)).data.level, 'L0');
      // …and user B is still unaffected.
      assert.equal((await json('GET', '/api/v1/autonomy/config', undefined, cookieB)).data.level, 'L2');
      assert.equal((await json('GET', '/api/v1/quickwake/config', undefined, cookieB)).data.voice_wake, false);
    } finally {
      if (child) await stopServerProcess(child);
    }
  });
});

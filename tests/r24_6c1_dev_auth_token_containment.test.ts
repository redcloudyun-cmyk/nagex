// R24.6C1 — raw authentication-token containment.
//
// Raw verification/reset tokens are returned ONLY when the explicit opt-in
// NAGEX_EXPOSE_DEV_AUTH_TOKENS=1 is set. By default (flag absent, or any value
// other than the exact string "1") no response from signup, resend-
// verification, forgot-password or email-change carries a token, an alias, a
// nested copy, or a secret-bearing URL; and forgot-password answers
// identically whether or not the address belongs to an account.
//
// This file deliberately does NOT call enableDevAuthTokensForFile(): it
// controls the flag itself, per test, and restores it.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { handleAuthRoutes } from '../src/http/routes/auth.routes.js';
import { handleAccountRoutes } from '../src/http/routes/account.routes.js';
import { hashPassword } from '../src/identity/identity.crypto.js';
import { IdentityStore } from '../src/identity/identity.store.js';
import { IdentityTokenStore } from '../src/identity/identity.tokens.js';
import { IdentityAuditStore } from '../src/identity/identity.audit.js';
import { SessionStore } from '../src/sessions/session.store.js';
import { AuthAbuseGuard } from '../src/identity/auth-abuse-guard.js';
import { headersFromPeer, SPAWNED_SERVER_TRUSTED_PROXIES } from './_s2e_peer.js';
import { DEV_AUTH_TOKEN_FLAG, devAuthTokenFields, devAuthTokensExposed } from '../src/identity/dev-auth-tokens.js';

const ORIGINAL_FLAG = process.env[DEV_AUTH_TOKEN_FLAG];
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

function withFlag<T>(value: string | undefined, run: () => Promise<T> | T, nodeEnv?: string): Promise<T> {
  const prevFlag = process.env[DEV_AUTH_TOKEN_FLAG];
  const prevEnv = process.env.NODE_ENV;
  if (value === undefined) delete process.env[DEV_AUTH_TOKEN_FLAG]; else process.env[DEV_AUTH_TOKEN_FLAG] = value;
  if (nodeEnv !== undefined) process.env.NODE_ENV = nodeEnv;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      if (prevFlag === undefined) delete process.env[DEV_AUTH_TOKEN_FLAG]; else process.env[DEV_AUTH_TOKEN_FLAG] = prevFlag;
      if (prevEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevEnv;
    });
}

interface Fixture {
  deps: any;
  /** Every raw token the token store minted during the test (so absence can be proven for ANY response). */
  minted: string[];
  signup(email: string): Promise<any>;
}

let ipCounter = 0; // each signup comes from its own client IP (the per-IP signup rate limiter is not under test)

function fixture(): Fixture {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-r246c1-'));
  const identityTokenStore = new IdentityTokenStore({ dir: path.join(tmpDir, 'tokens') });
  const minted: string[] = [];
  const originalCreate = identityTokenStore.createToken.bind(identityTokenStore);
  identityTokenStore.createToken = ((...args: Parameters<typeof originalCreate>) => {
    const result = originalCreate(...args);
    minted.push(result.rawToken);
    return result;
  }) as typeof identityTokenStore.createToken;
  const deps = {
    identityStore: new IdentityStore({ dir: path.join(tmpDir, 'identity') }),
    identityTokenStore,
    identityAuditStore: new IdentityAuditStore({ dir: path.join(tmpDir, 'audit') }),
    sessionStore: new SessionStore({ dir: path.join(tmpDir, 'sessions') }),
    authAbuseGuard: new AuthAbuseGuard(),   // S2E: per-fixture throttle state, so direct calls of different tests never share a bucket
  };
  return {
    deps,
    minted,
    signup: (email: string) => handleAuthRoutes('POST', '/api/v1/auth/signup', { email, password: 'password123', passwordConfirmation: 'password123', termsAccepted: true, privacyAccepted: true }, headersFromPeer(`10.246.2.${++ipCounter}`), {}, deps) as Promise<any>,
  };
}

/** Everything a client could read from a response: body, headers, nested objects, URLs. */
const wire = (res: unknown) => JSON.stringify(res);
const containsAnyToken = (res: unknown, tokens: string[]) => tokens.some((t) => wire(res).includes(t));
const TOKEN_KEYS = /token|secret|credential|code|password/i;
function tokenishKeys(value: unknown, trail = ''): string[] {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [...(TOKEN_KEYS.test(k) ? [`${trail}${k}`] : []), ...tokenishKeys(v, `${trail}${k}.`)]);
}

async function activeAccount(f: Fixture, email: string) {
  const { identity } = f.deps.identityStore.createAccount(email, hashPassword('password123'));
  f.deps.identityStore.transitionState(identity.userId, 'ACTIVE');
  const session = f.deps.sessionStore.createAuthSession(`ten_${identity.userId}`, identity.userId, 'MAIN');
  return { userId: identity.userId, cookie: { cookie: `nagex_session=${session.sessionId}` } };
}

describe('R24.6C1 — the single dev-token policy', () => {
  it('only the exact string "1" enables exposure; absent/invalid values and NODE_ENV never do', async () => {
    for (const bad of [undefined, '', '0', 'true', 'TRUE', 'yes', 'on', ' 1', '1 ', '01', '2', 'false', 'enabled']) {
      await withFlag(bad, () => {
        assert.equal(devAuthTokensExposed(), false, `value ${JSON.stringify(bad)} must not enable exposure`);
        assert.deepEqual(devAuthTokenFields('devResetToken', 'RAW'), {});
      });
    }
    for (const nodeEnv of ['development', 'test', 'production', undefined]) {
      await withFlag(undefined, () => assert.equal(devAuthTokensExposed(), false, `NODE_ENV=${nodeEnv} must not imply exposure`), nodeEnv);
    }
    await withFlag('1', () => {
      assert.equal(devAuthTokensExposed(), true);
      assert.deepEqual(devAuthTokenFields('devResetToken', 'RAW'), { devResetToken: 'RAW' });
      assert.deepEqual(devAuthTokenFields('devVerificationToken', 'RAW'), { devVerificationToken: 'RAW' });
    });
  });

  it('the flag is read per request and the test environment is restored', async () => {
    assert.equal(process.env[DEV_AUTH_TOKEN_FLAG], ORIGINAL_FLAG);
    assert.equal(process.env.NODE_ENV, ORIGINAL_NODE_ENV);
  });
});

describe('R24.6C1 — flag OFF: no raw token from any of the four flows', () => {
  for (const flagValue of [undefined, '', '0', 'true']) {
    it(`signup / resend / forgot / email-change expose nothing (flag=${JSON.stringify(flagValue)})`, async () => {
      await withFlag(flagValue, async () => {
        const f = fixture();

        // signup
        const signup = await f.signup('pending@example.com');
        assert.equal(signup?.status, 201);
        assert.equal(signup?.data && (signup.data as any).status, 'PENDING_VERIFICATION');
        assert.ok(f.minted.length === 1, 'the token lifecycle still mints a token');
        assert.equal(containsAnyToken(signup, f.minted), false, 'signup must not carry the raw token anywhere (key, alias, nested, URL)');
        assert.deepEqual(tokenishKeys(signup?.data), [], 'no token-like key in the signup response');
        assert.equal((signup!.data as any).delivery.status, 'NOT_CONFIGURED');

        // resend-verification (account is still PENDING_VERIFICATION)
        const before = f.minted.length;
        const resend = await handleAuthRoutes('POST', '/api/v1/auth/resend-verification', { email: 'pending@example.com' }, {}, {}, f.deps);
        assert.equal(resend?.status, 200);
        assert.equal(f.minted.length, before + 1);
        assert.equal(containsAnyToken(resend, f.minted), false);
        assert.deepEqual(tokenishKeys(resend?.data), []);

        // forgot-password for an ACTIVE account
        await activeAccount(f, 'active@example.com');
        const forgotExisting = await handleAuthRoutes('POST', '/api/v1/auth/forgot-password', { email: 'active@example.com' }, {}, {}, f.deps);
        assert.equal(forgotExisting?.status, 200);
        assert.equal(containsAnyToken(forgotExisting, f.minted), false, 'the reset credential must never reach the unauthenticated requester');
        assert.deepEqual(tokenishKeys(forgotExisting?.data), []);

        // email-change (authenticated, correct password)
        const owner = await activeAccount(f, 'owner@example.com');
        const change = await handleAccountRoutes('POST', '/api/v1/account/email/change-request', { currentPassword: 'password123', newEmail: 'new-owner@example.com' }, owner.cookie, {}, f.deps);
        assert.equal(change?.status, 200);
        assert.equal(containsAnyToken(change, f.minted), false);
        assert.deepEqual(tokenishKeys(change?.data), []);
      });
    });
  }

  it('responses are truthful about delivery: no "sent" claim, delivery NOT_CONFIGURED everywhere', async () => {
    await withFlag(undefined, async () => {
      const f = fixture();
      await activeAccount(f, 'active2@example.com');
      const owner = await activeAccount(f, 'owner2@example.com');
      const responses = [
        await f.signup('truth@example.com'),
        await handleAuthRoutes('POST', '/api/v1/auth/resend-verification', { email: 'truth@example.com' }, {}, {}, f.deps),
        await handleAuthRoutes('POST', '/api/v1/auth/forgot-password', { email: 'active2@example.com' }, {}, {}, f.deps),
        await handleAccountRoutes('POST', '/api/v1/account/email/change-request', { currentPassword: 'password123', newEmail: 'x2@example.com' }, owner.cookie, {}, f.deps),
      ];
      for (const res of responses) {
        const data = res!.data as any;
        assert.doesNotMatch(String(data.message), /\b(have|has) been sent\b|sent to the new address|instructions sent|email sent/i, `message must not claim delivery: ${data.message}`);
        assert.match(String(data.message), /not configured/i);
        assert.deepEqual(data.delivery, { status: 'NOT_CONFIGURED' });
      }
    });
  });
});

describe('R24.6C1 — forgot-password does not enumerate accounts', () => {
  it('existing, nonexistent, pending, disabled and malformed requests get the identical public response (flag OFF)', async () => {
    await withFlag(undefined, async () => {
      const f = fixture();
      await activeAccount(f, 'exists@example.com');
      await f.signup('unverified@example.com');
      const disabled = await activeAccount(f, 'disabled@example.com');
      f.deps.identityStore.transitionState(disabled.userId, 'DISABLED');

      const ask = (email: unknown) => handleAuthRoutes('POST', '/api/v1/auth/forgot-password', { email }, {}, {}, f.deps);
      const reference = await ask('exists@example.com');
      for (const email of ['nobody@example.com', 'unverified@example.com', 'disabled@example.com', 'EXISTS@example.com', 'not-an-email', '', undefined, 12345]) {
        const other = await ask(email);
        assert.deepEqual(other, reference, `response for ${JSON.stringify(email)} must be indistinguishable from the existing-account response`);
      }
      // The body carries no per-account signal at all.
      assert.deepEqual(Object.keys((reference!.data as any)).sort(), ['delivery', 'message']);
    });
  });

  it('resend-verification is equally uniform for existing-pending vs unknown addresses', async () => {
    await withFlag(undefined, async () => {
      const f = fixture();
      await f.signup('pending2@example.com');
      const ask = (email: string) => handleAuthRoutes('POST', '/api/v1/auth/resend-verification', { email }, {}, {}, f.deps);
      assert.deepEqual(await ask('nobody@example.com'), await ask('pending2@example.com'));
    });
  });
});

describe('R24.6C1 — explicit opt-in (flag "1") keeps the dev/test workflow working', () => {
  it('signup → verify, resend, forgot → reset, and email-change → confirm all work with the raw token', async () => {
    await withFlag('1', async () => {
      const f = fixture();

      // signup → verify → login
      const signup = await f.signup('dev@example.com');
      const verifyToken = (signup!.data as any).devVerificationToken;
      assert.equal(typeof verifyToken, 'string');
      assert.ok(verifyToken.length >= 32);
      const verified = await handleAuthRoutes('POST', '/api/v1/auth/verify-email', { token: verifyToken }, {}, {}, f.deps);
      assert.equal(verified?.status, 200);

      // resend for another pending account
      await f.signup('dev2@example.com');
      const resend = await handleAuthRoutes('POST', '/api/v1/auth/resend-verification', { email: 'dev2@example.com' }, {}, {}, f.deps);
      const resendToken = (resend!.data as any).devVerificationToken;
      assert.equal((await handleAuthRoutes('POST', '/api/v1/auth/verify-email', { token: resendToken }, {}, {}, f.deps))?.status, 200);

      // forgot → reset → login with the new password
      const forgot = await handleAuthRoutes('POST', '/api/v1/auth/forgot-password', { email: 'dev@example.com' }, {}, {}, f.deps);
      const resetToken = (forgot!.data as any).devResetToken;
      assert.equal(typeof resetToken, 'string');
      const reset = await handleAuthRoutes('POST', '/api/v1/auth/reset-password', { token: resetToken, newPassword: 'NewPassword123!', newPasswordConfirmation: 'NewPassword123!' }, {}, {}, f.deps);
      assert.equal(reset?.status, 200);
      assert.equal((await handleAuthRoutes('POST', '/api/v1/auth/login', { email: 'dev@example.com', password: 'NewPassword123!' }, {}, {}, f.deps))?.status, 200);

      // email change → confirm
      const owner = await activeAccount(f, 'owner3@example.com');
      const change = await handleAccountRoutes('POST', '/api/v1/account/email/change-request', { currentPassword: 'password123', newEmail: 'owner3-new@example.com' }, owner.cookie, {}, f.deps);
      const changeToken = (change!.data as any).devVerificationToken;
      assert.equal(typeof changeToken, 'string');
      assert.equal((await handleAccountRoutes('POST', '/api/v1/account/email/confirm', { token: changeToken }, {}, {}, f.deps))?.status, 200);
    });
  });

  it('the opt-in is per-request: turning the flag off again stops exposure immediately', async () => {
    const f = fixture();
    await activeAccount(f, 'toggle@example.com');
    const ask = () => handleAuthRoutes('POST', '/api/v1/auth/forgot-password', { email: 'toggle@example.com' }, {}, {}, f.deps);
    const on = await withFlag('1', ask);
    assert.equal(typeof (on!.data as any).devResetToken, 'string');
    const off = await withFlag(undefined, ask);
    assert.equal((off!.data as any).devResetToken, undefined);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Real server process: default configuration exposes nothing; opt-in works;
// logs and token storage never contain the raw token.
// ─────────────────────────────────────────────────────────────────────────
async function waitForHealth(origin: string, child: ChildProcess): Promise<void> {
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`server exited early (code ${child.exitCode})`);
    try { if ((await fetch(`${origin}/api/v1/health`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not become healthy');
}

async function runServer(flag: string | undefined, run: (call: (method: string, p: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; data: any }>, ctx: { logs: () => string; dataDir: string }) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-r246c1-proc-'));
  const port = 39000 + Math.floor(Math.random() * 3000);
  const origin = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    NAGEX_IDENTITY_DIR: path.join(root, 'identity'),
    NAGEX_IDENTITY_TOKENS_DIR: path.join(root, 'identity-tokens'),
    NAGEX_SESSIONS_DIR: path.join(root, 'sessions'),
    NAGEX_TRUSTED_PROXIES: SPAWNED_SERVER_TRUSTED_PROXIES,
  };
  delete env[DEV_AUTH_TOKEN_FLAG];
  if (flag !== undefined) env[DEV_AUTH_TOKEN_FLAG] = flag;
  let logs = '';
  const child = spawn(process.execPath, [path.resolve(process.cwd(), 'dist', 'src', 'server_web.js')], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', (d) => { logs += d; });
  child.stderr?.on('data', (d) => { logs += d; });
  try {
    await waitForHealth(origin, child);
    let ip = 0;
    const call = async (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) => {
      const res = await fetch(origin + p, { method, headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.246.1.${++ip}` /* S2E: this spawned server trusts the test client as its front proxy (see below) */, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      let data: any = null;
      try { data = await res.json(); } catch { /* empty */ }
      return { status: res.status, data };
    };
    await run(call, { logs: () => logs, dataDir: root });
  } finally {
    if (child.exitCode === null) {
      await new Promise<void>((resolve) => { child.once('exit', () => resolve()); child.kill(); setTimeout(resolve, 4000); });
    }
  }
}

function readTree(dir: string): string {
  let out = '';
  for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
    const full = path.join(dir, entry.name);
    out += entry.isDirectory() ? readTree(full) : fs.readFileSync(full, 'utf8');
  }
  return out;
}

describe('R24.6C1 — real server process', () => {
  it('default configuration (no flag): signup and forgot-password responses contain no token; an existing and an unknown address look identical', { timeout: 120_000 }, async () => {
    await runServer(undefined, async (call) => {
      const email = `proc_default_${Date.now()}@example.invalid`;
      const signup = await call('POST', '/api/v1/auth/signup', { email, password: 'Containment-1!', passwordConfirmation: 'Containment-1!', termsAccepted: true, privacyAccepted: true });
      assert.equal(signup.status, 201);
      assert.equal(signup.data.devVerificationToken, undefined);
      assert.deepEqual(tokenishKeys(signup.data), []);
      assert.doesNotMatch(wire(signup.data), /[0-9a-f]{48}/, 'no 48-hex raw token anywhere in the body');

      const forgotKnown = await call('POST', '/api/v1/auth/forgot-password', { email });
      const forgotUnknown = await call('POST', '/api/v1/auth/forgot-password', { email: `nobody_${Date.now()}@example.invalid` });
      assert.deepEqual(forgotKnown, forgotUnknown);
      assert.equal(forgotKnown.data.devResetToken, undefined);
      assert.doesNotMatch(wire(forgotKnown.data), /[0-9a-f]{48}/);

      // Nobody could verify this account without a delivered token: login stays blocked.
      const login = await call('POST', '/api/v1/auth/login', { email, password: 'Containment-1!' });
      assert.equal(login.status, 403);
    });
  });

  it('explicit opt-in ("1"): tokens are returned and work, yet are never written to logs or token storage in raw form', { timeout: 120_000 }, async () => {
    await runServer('1', async (call, ctx) => {
      const email = `proc_optin_${Date.now()}@example.invalid`;
      const signup = await call('POST', '/api/v1/auth/signup', { email, password: 'Containment-1!', passwordConfirmation: 'Containment-1!', termsAccepted: true, privacyAccepted: true });
      const verifyToken: string = signup.data.devVerificationToken;
      assert.match(verifyToken, /^[0-9a-f]{48}$/);
      assert.equal((await call('POST', '/api/v1/auth/verify-email', { token: verifyToken })).status, 200);
      const forgot = await call('POST', '/api/v1/auth/forgot-password', { email });
      const resetToken: string = forgot.data.devResetToken;
      assert.match(resetToken, /^[0-9a-f]{48}$/);

      for (const raw of [verifyToken, resetToken]) {
        assert.equal(ctx.logs().includes(raw), false, 'raw token must never appear in server output');
        assert.equal(readTree(ctx.dataDir).includes(raw), false, 'raw token must never be persisted (only a hash is stored)');
      }
    });
  });
});

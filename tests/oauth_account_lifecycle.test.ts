// DEBT-0013 - disable / delete / recover an account that signs in with Google or Microsoft (it has no password; no password authentication is added).
//   * disable / delete: a FRESH provider sign-in (the session was created within FRESH_SIGN_IN_WINDOW_MS) plus the typed account email; stale -> 403 REAUTH_REQUIRED.
//   * a provider sign-in on a DISABLED / DELETION_PENDING account opens NO session; it issues a one-time recovery token that must be used explicitly.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';
import { handleAccountRoutes, FRESH_SIGN_IN_WINDOW_MS } from '../src/http/routes/account.routes.js';
import { handleSocialAuthRoutes } from '../src/http/routes/social-auth.routes.js';
import { IdentityStore } from '../src/identity/identity.store.js';
import { IdentityAuditStore } from '../src/identity/identity.audit.js';
import { SocialIdentityStore } from '../src/identity/social-identity.store.js';
import { SessionStore } from '../src/sessions/session.store.js';
import { hashPassword } from '../src/identity/identity.crypto.js';

process.env.NAGEX_GOOGLE_LOGIN_CLIENT_ID = 'google-client';
process.env.NAGEX_GOOGLE_LOGIN_CLIENT_SECRET = 'google-secret';
process.env.NAGEX_GOOGLE_LOGIN_REDIRECT_URI = 'https://app.example.test/api/v1/auth/oauth/google/callback';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-oauth-lifecycle-'));

function setup(clock?: () => string) {
  const dir = path.join(root, crypto.randomUUID());
  const env = { ...process.env, NAGEX_IDENTITY_DIR: path.join(dir, 'identity'), NAGEX_SOCIAL_IDENTITY_DIR: path.join(dir, 'social'), NAGEX_SESSIONS_DIR: path.join(dir, 'sessions') };
  return {
    identityStore: new IdentityStore({ env }),
    socialIdentityStore: new SocialIdentityStore(env),
    sessionStore: new SessionStore({ env, ...(clock ? { now: clock } : {}) }),
    identityAuditStore: new IdentityAuditStore({ dir: path.join(dir, 'audit') }),
  };
}
type Deps = ReturnType<typeof setup>;
const cookie = (sessionId: string) => ({ cookie: `nagex_session=${sessionId}` });
const account = (d: Deps, method: string, p: string, body: Record<string, unknown> | null, sessionId?: string) =>
  handleAccountRoutes(method, p, body, sessionId ? cookie(sessionId) : {}, {}, d as never) as Promise<any>;

function googleAccount(d: Deps, email: string, provider: 'google' | 'microsoft' = 'google') {
  const { identity } = d.identityStore.createSocialAccount(email, provider);
  return identity;
}
const sessionFor = (d: Deps, userId: string) => d.sessionStore.createAuthSession(`ten_${userId}`, userId, 'MAIN');

test('A. fresh provider sign-in + typed email disables an OAuth account; sessions are revoked and the action is audited', async () => {
  const d = setup(); const identity = googleAccount(d, 'Owner.One@example.test');
  const session = sessionFor(d, identity.userId); const other = sessionFor(d, identity.userId);

  const missing = await account(d, 'POST', '/api/v1/account/disable', {}, session.sessionId);
  assert.equal(missing.status, 400); assert.equal(missing.data.error.code, 'CONFIRMATION_MISMATCH');
  const wrong = await account(d, 'POST', '/api/v1/account/disable', { confirmEmail: 'someone.else@example.test' }, session.sessionId);
  assert.equal(wrong.status, 400);
  const guessedPassword = await account(d, 'POST', '/api/v1/account/disable', { password: 'anything', confirmEmail: '' }, session.sessionId);
  assert.equal(guessedPassword.status, 400, 'a password is not a way in for a provider account');
  assert.equal(d.identityStore.getByUserId(identity.userId)?.accountState, 'ACTIVE', 'nothing changed by the refused attempts');

  const ok = await account(d, 'POST', '/api/v1/account/disable', { confirmEmail: '  OWNER.one@EXAMPLE.test ' }, session.sessionId);
  assert.equal(ok.status, 200);
  assert.equal(d.identityStore.getByUserId(identity.userId)?.accountState, 'DISABLED');
  assert.equal(d.sessionStore.getSession(session.sessionId), null);
  assert.equal(d.sessionStore.getSession(other.sessionId), null, 'every session of the account is revoked');
  assert.ok(d.identityAuditStore.listForUser(identity.userId).some((e) => e.eventType === 'account.disabled' && e.result === 'SUCCESS'));
});

test('B. an old session is refused with REAUTH_REQUIRED (disable and delete) and changes nothing', async () => {
  const stale = Date.now() - FRESH_SIGN_IN_WINDOW_MS - 60_000;
  const d = setup(() => new Date(stale).toISOString());
  const identity = googleAccount(d, 'stale@example.test', 'microsoft');
  const session = sessionFor(d, identity.userId);
  for (const route of ['/api/v1/account/disable', '/api/v1/account/delete']) {
    const refused = await account(d, 'POST', route, { confirmEmail: 'stale@example.test' }, session.sessionId);
    assert.equal(refused.status, 403, route); assert.equal(refused.data.error.code, 'REAUTH_REQUIRED');
    assert.equal(refused.data.error.details.reauthPath, '/api/v1/auth/oauth/microsoft/start');
  }
  assert.equal(d.identityStore.getByUserId(identity.userId)?.accountState, 'ACTIVE');
  assert.ok(d.sessionStore.getSession(session.sessionId), 'the session survives a refused request');
});

test('C. delete schedules the purge for an OAuth account (14 days), revokes sessions, and requires the same proof', async () => {
  const d = setup(); const identity = googleAccount(d, 'delete.me@example.test');
  const session = sessionFor(d, identity.userId);
  assert.equal((await account(d, 'POST', '/api/v1/account/delete', { confirmEmail: 'nope@example.test' }, session.sessionId)).status, 400);
  const ok = await account(d, 'POST', '/api/v1/account/delete', { confirmEmail: 'delete.me@example.test' }, session.sessionId);
  assert.equal(ok.status, 200); assert.equal(ok.data.accountState, 'DELETION_PENDING');
  assert.ok(ok.data.scheduledPurgeAt);
  assert.equal(d.sessionStore.getSession(session.sessionId), null);
  assert.ok(d.identityAuditStore.listForUser(identity.userId).some((e) => e.eventType === 'account.deletion.requested'));
});

test('D. no session, no action; and a local (password) account still needs its password', async () => {
  const d = setup(); const identity = googleAccount(d, 'nosession@example.test');
  assert.equal((await account(d, 'POST', '/api/v1/account/disable', { confirmEmail: 'nosession@example.test' })).status, 401);
  assert.equal(d.identityStore.getByUserId(identity.userId)?.accountState, 'ACTIVE');

  const { identity: local } = d.identityStore.createAccount('local.legacy@example.test', hashPassword('correct-horse-battery'));
  d.identityStore.transitionState(local.userId, 'ACTIVE');
  const session = sessionFor(d, local.userId);
  assert.equal((await account(d, 'POST', '/api/v1/account/disable', { confirmEmail: 'local.legacy@example.test' }, session.sessionId)).status, 400, 'an email is not enough for a password account');
  assert.equal((await account(d, 'POST', '/api/v1/account/disable', { password: 'wrong' }, session.sessionId)).status, 400);
  assert.equal((await account(d, 'POST', '/api/v1/account/disable', { password: 'correct-horse-battery' }, session.sessionId)).status, 200);
});

// ---- provider sign-in on a disabled / deletion-pending account ----
async function signIn(d: Deps, subject: string, email: string): Promise<any> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    if (url === 'https://oauth2.googleapis.com/token') return new Response(JSON.stringify({ id_token: 'id', access_token: 'access' }), { status: 200 });
    return new Response(JSON.stringify({ sub: subject, email, email_verified: true, name: 'Person' }), { status: 200 });
  }) as typeof fetch;
  try {
    const started = await handleSocialAuthRoutes('GET', '/api/v1/auth/oauth/google/start', null, {}, {}, d as never) as any;
    const state = new URL(started.redirectTo).searchParams.get('state')!;
    return await handleSocialAuthRoutes('GET', '/api/v1/auth/oauth/google/callback', null, {}, { state, code: 'code' }, d as never);
  } finally { globalThis.fetch = original; }
}
const recovery = (d: Deps, method: string, token: string, body?: Record<string, unknown>) => handleSocialAuthRoutes(method, `/api/v1/auth/oauth/recovery/${token}`, body ?? null, {}, {}, d as never) as Promise<any>;
function tokenFrom(result: any, status: string): string {
  const url = new URL(`https://app.example.test${result.redirectTo}`);
  assert.equal(url.searchParams.get('status'), status);
  assert.equal(result.headers?.['Set-Cookie'], undefined, 'a disabled / pending account gets no session from a provider sign-in');
  return url.searchParams.get('recovery')!;
}

test('E. provider sign-in on a DISABLED account issues a single-use recovery token; reactivation is explicit and audited', async () => {
  const d = setup();
  const first = await signIn(d, 'sub-e', 'recover.e@example.test'); assert.match(first.headers['Set-Cookie'], /nagex_session=/);
  const userId = d.socialIdentityStore.get('google', 'sub-e')!.userId;
  d.identityStore.transitionState(userId, 'DISABLED');

  const token = tokenFrom(await signIn(d, 'sub-e', 'recover.e@example.test'), 'account-disabled');
  assert.equal(d.identityStore.getByUserId(userId)?.accountState, 'DISABLED', 'signing in alone does not reactivate');
  const info = await recovery(d, 'GET', token);
  assert.equal(info.status, 200); assert.equal(info.data.recovery.state, 'DISABLED'); assert.equal(info.data.recovery.email, 'recover.e@example.test');
  assert.equal(d.identityStore.getByUserId(userId)?.accountState, 'DISABLED', 'reading the offer changes nothing');

  const wrongAction = await recovery(d, 'POST', token, { action: 'CANCEL_DELETION' });
  assert.equal(wrongAction.status, 400);
  const noAction = await recovery(d, 'POST', token, {});
  assert.equal(noAction.status, 400);
  const done = await recovery(d, 'POST', token, { action: 'REACTIVATE' });
  assert.equal(done.status, 200); assert.equal(done.data.accountState, 'ACTIVE'); assert.match(done.headers['Set-Cookie'], /nagex_session=/);
  assert.equal(d.identityStore.getByUserId(userId)?.accountState, 'ACTIVE');
  assert.ok(d.identityAuditStore.listForUser(userId).some((e) => e.eventType === 'account.reactivated' && e.result === 'SUCCESS'));
  assert.equal((await recovery(d, 'POST', token, { action: 'REACTIVATE' })).status, 410, 'single use');
});

test('F. DELETION_PENDING: CANCEL_DELETION restores the account; the token is bound to the state it was issued for', async () => {
  const d = setup();
  await signIn(d, 'sub-f', 'recover.f@example.test');
  const userId = d.socialIdentityStore.get('google', 'sub-f')!.userId;
  d.identityStore.transitionState(userId, 'DELETION_PENDING');
  const token = tokenFrom(await signIn(d, 'sub-f', 'recover.f@example.test'), 'deletion-pending');
  assert.equal((await recovery(d, 'GET', token)).data.recovery.state, 'DELETION_PENDING');
  assert.equal((await recovery(d, 'POST', token, { action: 'REACTIVATE' })).status, 400);

  // the account changed after the token was issued -> the token is void
  d.identityStore.transitionState(userId, 'ACTIVE');
  assert.equal((await recovery(d, 'POST', token, { action: 'CANCEL_DELETION' })).status, 409);
  d.identityStore.transitionState(userId, 'DELETION_PENDING');
  const token2 = tokenFrom(await signIn(d, 'sub-f', 'recover.f@example.test'), 'deletion-pending');
  const cancelled = await recovery(d, 'POST', token2, { action: 'CANCEL_DELETION' });
  assert.equal(cancelled.status, 200); assert.equal(d.identityStore.getByUserId(userId)?.accountState, 'ACTIVE');
  assert.ok(d.identityAuditStore.listForUser(userId).some((e) => e.eventType === 'account.deletion.cancelled'));
});

test('G. a DELETED account cannot be recovered; unknown and expired tokens are refused', async () => {
  const d = setup();
  await signIn(d, 'sub-g', 'recover.g@example.test');
  const userId = d.socialIdentityStore.get('google', 'sub-g')!.userId;
  d.identityStore.transitionState(userId, 'DELETION_PENDING');
  d.identityStore.transitionState(userId, 'DELETED');
  const result = await signIn(d, 'sub-g', 'recover.g@example.test');
  assert.match(result.redirectTo, /status=account-deleted/); assert.equal(result.headers?.['Set-Cookie'], undefined);
  assert.doesNotMatch(result.redirectTo, /recovery=/);

  assert.equal((await recovery(d, 'GET', 'not-a-token')).status, 410);
  assert.equal((await recovery(d, 'POST', 'not-a-token', { action: 'REACTIVATE' })).status, 410);

  await signIn(d, 'sub-h', 'recover.h@example.test');
  const hid = d.socialIdentityStore.get('google', 'sub-h')!.userId;
  d.identityStore.transitionState(hid, 'DISABLED');
  const token = tokenFrom(await signIn(d, 'sub-h', 'recover.h@example.test'), 'account-disabled');
  const realNow = Date.now; Date.now = () => realNow() + 11 * 60_000;
  try { assert.equal((await recovery(d, 'POST', token, { action: 'REACTIVATE' })).status, 410, 'a token older than 10 minutes is void'); } finally { Date.now = realNow; }
  assert.equal(d.identityStore.getByUserId(hid)?.accountState, 'DISABLED');
});

test('H. route access: the recovery endpoint is explicit PUBLIC (token-gated); account lifecycle routes still require a session', async () => {
  const { classifyRouteAccess, denyIfUnauthorized } = await import('../src/http/route-access.js');
  for (const method of ['GET', 'POST']) assert.equal(classifyRouteAccess(method, '/api/v1/auth/oauth/recovery/abc')?.access, 'PUBLIC');
  assert.equal(classifyRouteAccess('DELETE', '/api/v1/auth/oauth/recovery/abc'), undefined);
  for (const route of ['/api/v1/account/disable', '/api/v1/account/delete']) assert.equal(classifyRouteAccess('POST', route)?.access, 'SELF_AUTHENTICATED', 'the handler itself requires and verifies the session (test D: 401 without one)');
  assert.equal(denyIfUnauthorized('GET', '/api/v1/auth/oauth/recovery/abc', {}), null);
});

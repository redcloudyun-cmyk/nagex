import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import test from 'node:test';
import { handleSocialAuthRoutes, socialAuthProviderAvailability } from '../src/http/routes/social-auth.routes.js';
import { IdentityStore } from '../src/identity/identity.store.js';
import { SocialIdentityStore } from '../src/identity/social-identity.store.js';
import { SessionStore } from '../src/sessions/session.store.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-social-auth-'));
process.env.NAGEX_GOOGLE_LOGIN_CLIENT_ID = 'google-client';
process.env.NAGEX_GOOGLE_LOGIN_CLIENT_SECRET = 'google-secret';
process.env.NAGEX_GOOGLE_LOGIN_REDIRECT_URI = 'https://app.example.test/api/v1/auth/oauth/google/callback';
process.env.NAGEX_MICROSOFT_LOGIN_CLIENT_ID = 'microsoft-client';
process.env.NAGEX_MICROSOFT_LOGIN_CLIENT_SECRET = 'microsoft-secret';
process.env.NAGEX_MICROSOFT_LOGIN_REDIRECT_URI = 'https://app.example.test/api/v1/auth/oauth/microsoft/callback';

function deps() {
  const env = { ...process.env, NAGEX_IDENTITY_DIR: path.join(root, crypto.randomUUID()), NAGEX_SOCIAL_IDENTITY_DIR: path.join(root, crypto.randomUUID()), NAGEX_SESSIONS_DIR: path.join(root, crypto.randomUUID()) };
  return { identityStore: new IdentityStore({ env }), socialIdentityStore: new SocialIdentityStore(env), sessionStore: new SessionStore({ env }) };
}

async function start(provider: 'google' | 'microsoft', d: ReturnType<typeof deps>) {
  return handleSocialAuthRoutes('GET', `/api/v1/auth/oauth/${provider}/start`, null, {}, {}, d) as Promise<any>;
}

test('provider-first auth UI exposes only configured Google and Microsoft options', () => {
  const ui = fs.readFileSync(path.resolve('public/auth-ui.js'), 'utf8');
  assert.match(ui, /Continue with Google/);
  assert.match(ui, /Continue with Microsoft/);
  assert.match(ui, /\/api\/v1\/auth\/providers/);
  assert.doesNotMatch(ui, /Continue with email/);
  assert.doesNotMatch(ui, /signin-email|signin-password|forgot-password|auth-form-signup|reset-password|btn-change-password/);
  assert.doesNotMatch(ui, /fake account|account chooser.*option/i);
});

test('provider catalog reports only fully configured OAuth providers', async () => {
  const availability = socialAuthProviderAvailability({
    NAGEX_GOOGLE_LOGIN_CLIENT_ID: 'google-client',
    NAGEX_GOOGLE_LOGIN_CLIENT_SECRET: 'google-secret',
    NAGEX_GOOGLE_LOGIN_REDIRECT_URI: 'https://app.example.test/api/v1/auth/oauth/google/callback',
  });
  assert.deepEqual(availability, { google: { enabled: true }, microsoft: { enabled: false } });

  const result = await handleSocialAuthRoutes('GET', '/api/v1/auth/providers', null, {}, {}, deps()) as any;
  assert.equal(result.status, 200);
  assert.equal(result.data.providers.google.enabled, true);
  assert.equal(result.data.providers.microsoft.enabled, true);
});

test('initial Google and Microsoft login scopes are identity-only', async () => {
  const d = deps();
  for (const provider of ['google', 'microsoft'] as const) {
    const result = await start(provider, d);
    const url = new URL(result.redirectTo);
    assert.deepEqual(url.searchParams.get('scope')?.split(' '), ['openid', 'email', 'profile']);
    assert.doesNotMatch(url.searchParams.get('scope') || '', /calendar|gmail|drive|docs|sheets|slides|mail\.read|outlook/i);
    assert.equal(url.searchParams.get('prompt'), 'select_account');
  }
});

test('Google callback creates a session, reuses provider+subject, and never silently merges by email', async () => {
  const original = globalThis.fetch; const d = deps();
  let subject = 'google-sub-new'; let email = 'new-google@example.test';
  globalThis.fetch = async (input: any) => {
    const url = String(input);
    if (url === 'https://oauth2.googleapis.com/token') return new Response(JSON.stringify({ id_token: 'id', access_token: 'access' }), { status: 200 });
    return new Response(JSON.stringify({ sub: subject, email, email_verified: true, name: 'Google User' }), { status: 200 });
  };
  try {
    const firstStart = await start('google', d); const firstState = new URL(firstStart.redirectTo).searchParams.get('state')!;
    const created = await handleSocialAuthRoutes('GET', '/api/v1/auth/oauth/google/callback', null, {}, { state: firstState, code: 'code-1' }, d) as any;
    assert.equal(created.status, 302); assert.match(created.headers['Set-Cookie'], /nagex_session=/);
    const link = d.socialIdentityStore.get('google', subject); assert.ok(link);
    const firstUserId = link!.userId;

    const secondStart = await start('google', d); const secondState = new URL(secondStart.redirectTo).searchParams.get('state')!;
    const existing = await handleSocialAuthRoutes('GET', '/api/v1/auth/oauth/google/callback', null, {}, { state: secondState, code: 'code-2' }, d) as any;
    assert.equal(existing.status, 302); assert.equal(d.socialIdentityStore.get('google', subject)?.userId, firstUserId);

    email = 'local@example.test'; subject = 'different-google-sub';
    const local = d.identityStore.createAccount(email, 'not-a-real-login-hash').identity;
    d.identityStore.transitionState(local.userId, 'ACTIVE');
    const collisionStart = await start('google', d); const collisionState = new URL(collisionStart.redirectTo).searchParams.get('state')!;
    const collision = await handleSocialAuthRoutes('GET', '/api/v1/auth/oauth/google/callback', null, {}, { state: collisionState, code: 'code-3' }, d) as any;
    assert.match(collision.redirectTo, /^\/\?auth=provider&status=migration-required&migration=/);
    assert.equal(d.socialIdentityStore.get('google', subject), undefined);
  } finally { globalThis.fetch = original; }
});

test('verified legacy email migration is explicit, single-use, and preserves owner', async () => {
  const original = globalThis.fetch; const d = deps();
  const { identity } = d.identityStore.createAccount('legacy@example.test', 'legacy-password-hash');
  d.identityStore.transitionState(identity.userId, 'ACTIVE');
  globalThis.fetch = async (input: any) => {
    const url = String(input);
    if (url === 'https://oauth2.googleapis.com/token') return new Response(JSON.stringify({ id_token: 'id', access_token: 'access' }), { status: 200 });
    return new Response(JSON.stringify({ sub: 'google-legacy-sub', email: 'legacy@example.test', email_verified: true }), { status: 200 });
  };
  try {
    const startResult = await start('google', d); const state = new URL(startResult.redirectTo).searchParams.get('state')!;
    const callback = await handleSocialAuthRoutes('GET', '/api/v1/auth/oauth/google/callback', null, {}, { state, code: 'code' }, d) as any;
    const redirect = new URL(`https://app.example.test${callback.redirectTo}`);
    const token = redirect.searchParams.get('migration')!;
    assert.equal(redirect.searchParams.get('status'), 'migration-required');
    assert.equal(d.socialIdentityStore.get('google', 'google-legacy-sub'), undefined);

    const info = await handleSocialAuthRoutes('GET', `/api/v1/auth/oauth/migration/${token}`, null, {}, {}, d) as any;
    assert.equal(info.status, 200);
    assert.equal(info.data.migration.userId, identity.userId);

    const confirmed = await handleSocialAuthRoutes('POST', `/api/v1/auth/oauth/migration/${token}`, null, {}, {}, d) as any;
    assert.equal(confirmed.status, 200);
    assert.match(confirmed.headers['Set-Cookie'], /nagex_session=/);
    assert.equal(d.socialIdentityStore.get('google', 'google-legacy-sub')?.userId, identity.userId);
    assert.equal(d.identityStore.getByEmail('legacy@example.test')?.userId, identity.userId);

    const replay = await handleSocialAuthRoutes('POST', `/api/v1/auth/oauth/migration/${token}`, null, {}, {}, d) as any;
    assert.equal(replay.status, 410);
  } finally { globalThis.fetch = original; }
});

test('legacy migration blocks unverified OAuth email and non-legacy collision', async () => {
  const original = globalThis.fetch; const d = deps();
  const legacy = d.identityStore.createAccount('blocked@example.test', 'legacy-password-hash').identity;
  d.identityStore.transitionState(legacy.userId, 'ACTIVE');
  let verified = false;
  globalThis.fetch = async (input: any) => {
    const url = String(input);
    if (url === 'https://oauth2.googleapis.com/token') return new Response(JSON.stringify({ id_token: 'id', access_token: 'access' }), { status: 200 });
    return new Response(JSON.stringify({ sub: 'sub-blocked', email: 'blocked@example.test', email_verified: verified }), { status: 200 });
  };
  try {
    const unverifiedStart = await start('google', d); const unverifiedState = new URL(unverifiedStart.redirectTo).searchParams.get('state')!;
    const unverified = await handleSocialAuthRoutes('GET', '/api/v1/auth/oauth/google/callback', null, {}, { state: unverifiedState, code: 'code' }, d) as any;
    assert.equal(unverified.redirectTo, '/?auth=provider&status=link-required');

    const nonLegacy = d.identityStore.createSocialAccount('social-existing@example.test', 'microsoft').identity;
    verified = true;
    globalThis.fetch = async (input: any) => {
      const url = String(input);
      if (url === 'https://oauth2.googleapis.com/token') return new Response(JSON.stringify({ id_token: 'id', access_token: 'access' }), { status: 200 });
      return new Response(JSON.stringify({ sub: 'sub-non-legacy', email: nonLegacy.email, email_verified: true }), { status: 200 });
    };
    const nonLegacyStart = await start('google', d); const nonLegacyState = new URL(nonLegacyStart.redirectTo).searchParams.get('state')!;
    const blocked = await handleSocialAuthRoutes('GET', '/api/v1/auth/oauth/google/callback', null, {}, { state: nonLegacyState, code: 'code' }, d) as any;
    assert.equal(blocked.redirectTo, '/?auth=provider&status=link-required');
    assert.equal(d.socialIdentityStore.get('google', 'sub-non-legacy'), undefined);
  } finally { globalThis.fetch = original; }
});

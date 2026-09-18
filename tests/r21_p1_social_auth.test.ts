import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import test from 'node:test';
import { handleSocialAuthRoutes } from '../src/http/routes/social-auth.routes.js';
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

test('provider-first auth UI exposes Google, Microsoft, and email without a fake chooser', () => {
  const ui = fs.readFileSync(path.resolve('public/auth-ui.js'), 'utf8');
  assert.match(ui, /Continue with Google/);
  assert.match(ui, /Continue with Microsoft/);
  assert.match(ui, /Continue with email/);
  assert.doesNotMatch(ui, /fake account|account chooser.*option/i);
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
    return new Response(JSON.stringify({ sub: subject, email, name: 'Google User' }), { status: 200 });
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

    email = 'local@example.test'; subject = 'different-google-sub'; d.identityStore.createAccount(email, 'not-a-real-login-hash');
    const collisionStart = await start('google', d); const collisionState = new URL(collisionStart.redirectTo).searchParams.get('state')!;
    const collision = await handleSocialAuthRoutes('GET', '/api/v1/auth/oauth/google/callback', null, {}, { state: collisionState, code: 'code-3' }, d) as any;
    assert.equal(collision.redirectTo, '/?auth=provider&status=link-required');
    assert.equal(d.socialIdentityStore.get('google', subject), undefined);
  } finally { globalThis.fetch = original; }
});

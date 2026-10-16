// R26-E — Microsoft as built: SIGN-IN ONLY. This pins what is true today so that nothing can drift into advertising a Microsoft mail or calendar capability that does not exist:
//   * a Microsoft sign-in calls exactly the token endpoint and the OIDC userinfo endpoint, keeps none of the tokens it received, and never links an existing password account by an e-mail Microsoft did not verify;
//   * the connections API never reports Microsoft as connected, and connect-style actions answer "not supported" instead of success;
//   * Outlook, OneDrive / SharePoint and Teams are PLANNED in the catalog, and no capability in the broker's registry belongs to Microsoft.
// When a Graph capability is really added, this file must change in the same commit - that is the point. Scripted fetch, real route handlers and stores; no Microsoft account is involved.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { handleSocialAuthRoutes } from '../src/http/routes/social-auth.routes.js';
import { IdentityStore } from '../src/identity/identity.store.js';
import { SocialIdentityStore } from '../src/identity/social-identity.store.js';
import { SessionStore } from '../src/sessions/session.store.js';
import { CONNECTOR_CATALOG } from '../src/connectors/connector-catalog.js';
import { CapabilityRegistry } from '../src/capabilities/capability.registry.js';
import { hashPassword } from '../src/identity/identity.crypto.js';
import { handleAsyncApiRequest } from '../src/server_web.js';
import { authAs } from './_s1_session_auth.js';

process.env.NAGEX_MICROSOFT_LOGIN_CLIENT_ID = 'microsoft-client';
process.env.NAGEX_MICROSOFT_LOGIN_CLIENT_SECRET = 'microsoft-secret';
process.env.NAGEX_MICROSOFT_LOGIN_REDIRECT_URI = 'https://app.example.test/api/v1/auth/oauth/microsoft/callback';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-ms-state-'));
const TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const USERINFO_URL = 'https://graph.microsoft.com/oidc/userinfo';
const SECRETS = ['ID-TOKEN-MUST-NOT-BE-STORED', 'ACCESS-TOKEN-MUST-NOT-BE-STORED', 'REFRESH-TOKEN-MUST-NOT-BE-STORED'];

function deps() {
  const dir = path.join(root, crypto.randomUUID());
  const env = { ...process.env, NAGEX_IDENTITY_DIR: path.join(dir, 'identity'), NAGEX_SOCIAL_IDENTITY_DIR: path.join(dir, 'social'), NAGEX_SESSIONS_DIR: path.join(dir, 'sessions') };
  return { dir, identityStore: new IdentityStore({ env }), socialIdentityStore: new SocialIdentityStore(env), sessionStore: new SessionStore({ env }) };
}

// A complete Microsoft sign-in with a scripted Microsoft: every URL that is fetched is recorded.
async function microsoftSignIn(d: ReturnType<typeof deps>, subject: string, email: string): Promise<{ result: any; calls: string[] }> {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    calls.push(url);
    if (url === TOKEN_URL) return new Response(JSON.stringify({ id_token: SECRETS[0], access_token: SECRETS[1], refresh_token: SECRETS[2], token_type: 'Bearer' }), { status: 200 });
    if (url === USERINFO_URL) return new Response(JSON.stringify({ sub: subject, email, name: 'Person' }), { status: 200 }); // Microsoft's userinfo carries no email_verified
    return new Response('unexpected', { status: 500 });
  }) as typeof fetch;
  try {
    const started = await handleSocialAuthRoutes('GET', '/api/v1/auth/oauth/microsoft/start', null, {}, {}, d as never) as any;
    const state = new URL(started.redirectTo).searchParams.get('state')!;
    const result = await handleSocialAuthRoutes('GET', '/api/v1/auth/oauth/microsoft/callback', null, {}, { state, code: 'code' }, d as never) as any;
    return { result, calls };
  } finally {
    globalThis.fetch = original;
  }
}

function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesUnder(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
}

test('A. a Microsoft sign-in fetches only the token and OIDC userinfo endpoints and keeps none of the tokens it received', async () => {
  const d = deps();
  const { result, calls } = await microsoftSignIn(d, 'ms-sub-1', 'person@example.test');
  assert.deepEqual(calls, [TOKEN_URL, USERINFO_URL], 'no Graph mail, calendar or file endpoint is ever called');
  assert.equal(result.status, 302);
  assert.equal(result.redirectTo, '/');
  assert.match(String(result.headers?.['Set-Cookie']), /nagex_session=/);
  assert.ok(d.socialIdentityStore.get('microsoft', 'ms-sub-1'), 'the account is bound to the provider subject');
  for (const file of filesUnder(d.dir)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const secret of SECRETS) assert.equal(text.includes(secret), false, `${path.basename(file)} must not contain a provider token`);
  }
  assert.equal(JSON.stringify(result).includes('TOKEN-MUST-NOT'), false, 'and none is handed back to the browser');
});

test('B. an existing password account is never linked by an e-mail Microsoft did not verify', async () => {
  const d = deps();
  const { identity } = d.identityStore.createAccount('legacy@example.test', hashPassword('correct-horse-battery'));
  d.identityStore.transitionState(identity.userId, 'ACTIVE');
  const { result } = await microsoftSignIn(d, 'ms-sub-2', 'legacy@example.test');
  assert.equal(result.status, 302);
  assert.match(String(result.redirectTo), /status=link-required/);
  assert.equal(result.headers?.['Set-Cookie'], undefined, 'no session is created');
  assert.equal(d.socialIdentityStore.get('microsoft', 'ms-sub-2'), undefined, 'nothing was linked');
  assert.equal(d.identityStore.getByUserId(identity.userId)?.authProvider, 'local');
});

test('C. the connections API never reports Microsoft as connected, and connect-style actions are "not supported", not success', async () => {
  const who = authAs('ten_ms_state', 'usr_ms_state');
  const list = await handleAsyncApiRequest('GET', '/api/v1/connections', null, who) as { status: number; data: any };
  assert.equal(list.status, 200);
  const microsoft = (list.data.connections as any[]).filter((c) => c.provider === 'microsoft');
  assert.equal(microsoft.length, 1);
  assert.equal(microsoft[0].status, 'UNAVAILABLE');
  assert.equal(microsoft[0].consentAuthority.executeAllowed, false);
  const disconnect = await handleAsyncApiRequest('POST', '/api/v1/connections/microsoft/disconnect', {}, who) as { status: number; data: any };
  assert.deepEqual([disconnect.status, disconnect.data.error.code], [501, 'PROVIDER_DISCONNECT_NOT_SUPPORTED']);
  const sync = await handleAsyncApiRequest('POST', '/api/v1/connections/microsoft/sync', {}, who) as { status: number; data: any };
  assert.deepEqual([sync.status, sync.data.error.code], [501, 'PROVIDER_SYNC_NOT_SUPPORTED']);
  assert.equal((await handleAsyncApiRequest('GET', '/api/v1/connections', null, {}) as { status: number }).status, 401, 'and only a signed-in person can ask');
});

test('D. Outlook, OneDrive / SharePoint and Teams are PLANNED - nothing Microsoft is advertised as available - and no brokered capability belongs to Microsoft', () => {
  const microsoft = CONNECTOR_CATALOG.filter((c) => c.authMethod === 'MICROSOFT_OAUTH' || c.provider === 'Microsoft');
  assert.deepEqual(microsoft.map((c) => c.id).sort(), ['microsoft-teams', 'onedrive', 'outlook']);
  for (const connector of microsoft) {
    assert.equal(connector.availability, 'PLANNED', connector.id);
    assert.match(connector.setup?.en ?? '', /not available yet/i, `${connector.id} says plainly that it is not available`);
  }
  const capabilities = new CapabilityRegistry().list();
  assert.ok(capabilities.length > 0);
  for (const capability of capabilities) {
    assert.doesNotMatch(`${capability.id} ${capability.provider}`, /microsoft|outlook|graph|onedrive|teams/i, capability.id);
  }
});

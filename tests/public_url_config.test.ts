// The deployment's address is configuration: NAGEX_PUBLIC_URL is the one setting, the OAuth redirect URIs and the SSO base are derived from it, an explicit setting still wins, an invalid one is ignored,
// the session cookie is host-only and Secure, the client address comes from X-Forwarded-For only through a trusted proxy, CORS is closed by default, and no maintained source names the legacy host.
// Deterministic: no network, no browser.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { canonicalPublicUrl, describePublicUrl, OAUTH_CALLBACK_PATHS, redirectUriFor } from '../src/config/public-url.js';
import { readGoogleOAuthConfig } from '../src/integrations/google/oauth.client.js';
import { readGitHubOAuthConfig } from '../src/integrations/github/oauth.client.js';
import { socialAuthProviderAvailability, socialAuthProviderConfig } from '../src/http/routes/social-auth.routes.js';
import { sessionCookieHeader } from '../src/http/session-cookie.js';
import { parseTrustedProxies, resolveClientIp } from '../src/http/client-ip.js';

const CANONICAL = 'https://nagex.agex.site';
// built from parts so that this file never contains the legacy host it guards against
const LEGACY_HOST = ['nagex', '-test.agex.site'].join('');

test('NAGEX_PUBLIC_URL is an origin: https (or http on loopback), nothing else; anything else is ignored and named', () => {
  assert.deepEqual(describePublicUrl({}), { configured: false, value: null, problem: null });
  assert.equal(canonicalPublicUrl({ NAGEX_PUBLIC_URL: CANONICAL }), CANONICAL);
  assert.equal(canonicalPublicUrl({ NAGEX_PUBLIC_URL: `${CANONICAL}/` }), CANONICAL, 'a trailing slash is the same origin');
  assert.equal(canonicalPublicUrl({ NAGEX_PUBLIC_URL: '  https://Nagex.Agex.Site  ' }), CANONICAL);
  assert.equal(canonicalPublicUrl({ NAGEX_PUBLIC_URL: 'http://127.0.0.1:8085' }), 'http://127.0.0.1:8085');
  assert.equal(canonicalPublicUrl({ NAGEX_PUBLIC_URL: 'http://localhost:8085' }), 'http://localhost:8085');
  for (const [value, problem] of [
    ['nagex.agex.site', 'NOT_AN_URL'], ['https://', 'NOT_AN_URL'],
    ['http://nagex.agex.site', 'INSECURE_SCHEME'], ['ftp://nagex.agex.site', 'INSECURE_SCHEME'],
    ['https://nagex.agex.site/app', 'NOT_AN_ORIGIN'], ['https://nagex.agex.site/?x=1', 'NOT_AN_ORIGIN'], ['https://user:pw@nagex.agex.site', 'NOT_AN_ORIGIN'], ['https://nagex.agex.site/#a', 'NOT_AN_ORIGIN'],
  ] as const) {
    const status = describePublicUrl({ NAGEX_PUBLIC_URL: value });
    assert.deepEqual([status.configured, status.value, status.problem], [true, null, problem], value);
    assert.equal(canonicalPublicUrl({ NAGEX_PUBLIC_URL: value }), null, `${value} is never turned into a redirect URI`);
  }
});

test('a redirect URI: the explicit setting wins, otherwise it is derived from the canonical origin, otherwise there is none', () => {
  const env = { NAGEX_PUBLIC_URL: CANONICAL };
  assert.equal(redirectUriFor(undefined, '/x/callback', env), `${CANONICAL}/x/callback`);
  assert.equal(redirectUriFor('', '/x/callback', env), `${CANONICAL}/x/callback`, 'an empty setting is "not set"');
  assert.equal(redirectUriFor('  https://other.example/cb  ', '/x/callback', env), 'https://other.example/cb');
  assert.equal(redirectUriFor(undefined, '/x/callback', {}), undefined);
  assert.equal(redirectUriFor(undefined, '/x/callback', { NAGEX_PUBLIC_URL: 'not a url' }), undefined);
});

test('Google and GitHub connections take their redirect URI from the canonical origin; explicit values and missing credentials behave as before', () => {
  const google = readGoogleOAuthConfig({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 's', NAGEX_PUBLIC_URL: CANONICAL });
  assert.equal(google?.redirectUri, `${CANONICAL}${OAUTH_CALLBACK_PATHS.googleConnection}`);
  assert.equal(readGoogleOAuthConfig({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 's', GOOGLE_REDIRECT_URI: 'https://x.example/cb', NAGEX_PUBLIC_URL: CANONICAL })?.redirectUri, 'https://x.example/cb');
  assert.equal(readGoogleOAuthConfig({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 's' }), null, 'no address at all: not configured');
  assert.equal(readGoogleOAuthConfig({ GOOGLE_CLIENT_SECRET: 's', NAGEX_PUBLIC_URL: CANONICAL }), null, 'an address is not credentials');
  const github = readGitHubOAuthConfig({ GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 's', NAGEX_PUBLIC_URL: CANONICAL });
  assert.equal(github?.redirectUri, `${CANONICAL}${OAUTH_CALLBACK_PATHS.githubConnection}`);
  assert.equal(readGitHubOAuthConfig({ GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 's' }), null);
});

test('Google and Microsoft sign-in derive their redirect URIs the same way and are enabled only with credentials', () => {
  const env = { NAGEX_PUBLIC_URL: CANONICAL, NAGEX_GOOGLE_LOGIN_CLIENT_ID: 'g', NAGEX_GOOGLE_LOGIN_CLIENT_SECRET: 'gs', NAGEX_MICROSOFT_LOGIN_CLIENT_ID: 'm', NAGEX_MICROSOFT_LOGIN_CLIENT_SECRET: 'ms' };
  assert.equal(socialAuthProviderConfig('google', env)?.redirectUri, `${CANONICAL}${OAUTH_CALLBACK_PATHS.googleLogin}`);
  assert.equal(socialAuthProviderConfig('microsoft', env)?.redirectUri, `${CANONICAL}${OAUTH_CALLBACK_PATHS.microsoftLogin}`);
  assert.deepEqual(socialAuthProviderAvailability(env), { google: { enabled: true }, microsoft: { enabled: true } });
  assert.equal(socialAuthProviderConfig('google', { ...env, NAGEX_GOOGLE_LOGIN_REDIRECT_URI: 'https://x.example/g' })?.redirectUri, 'https://x.example/g');
  assert.deepEqual(socialAuthProviderAvailability({ NAGEX_PUBLIC_URL: CANONICAL }), { google: { enabled: false }, microsoft: { enabled: false } }, 'an address alone enables nothing');
  assert.deepEqual(socialAuthProviderAvailability({ NAGEX_GOOGLE_LOGIN_CLIENT_ID: 'g', NAGEX_GOOGLE_LOGIN_CLIENT_SECRET: 'gs' }), { google: { enabled: false }, microsoft: { enabled: false } }, 'credentials alone, with no address, are not enough');
});

test('the callback paths in the configuration are the paths the routes serve, and the deployment README registers exactly those', () => {
  const read = (file: string) => fs.readFileSync(file, 'utf8');
  assert.match(read('src/http/routes/google-oauth.routes.ts'), new RegExp(`pathname === '${OAUTH_CALLBACK_PATHS.googleConnection}'`));
  assert.match(read('src/http/routes/github.routes.ts'), new RegExp(`pathname === '${OAUTH_CALLBACK_PATHS.githubConnection}'`));
  assert.ok(read('src/http/routes/social-auth.routes.ts').includes('auth\\/oauth\\/(google|microsoft)\\/(start|callback)'), 'the sign-in start / callback route');
  assert.match(read('src/http/routes/enterprise-identity.routes.ts'), /\$\{deps\.publicBaseUrl\}\/api\/v1\/auth\/oidc\/callback/);
  const readme = read('deploy/nagex/README.md');
  for (const callback of Object.values(OAUTH_CALLBACK_PATHS)) assert.ok(readme.includes(`${CANONICAL}${callback}`), `deploy/nagex/README.md registers ${callback}`);
  const env = read('.env.example');
  assert.match(env, /NAGEX_PUBLIC_URL=/);
  assert.match(env, /NAGEX_TRUSTED_PROXIES/);
  assert.doesNotMatch(env, /NAGEX_[A-Z]+_LOGIN_REDIRECT_URI=\S/, 'the sign-in redirect lines are empty in the example: they are derived');
});

test('the session cookie is HttpOnly, Secure, SameSite=Lax and HOST-ONLY (no Domain): a session belongs to one host and is not shared with the legacy host or another agex.site application', () => {
  const cookie = sessionCookieHeader('sess_123', {});
  assert.match(cookie, /^nagex_session=sess_123; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
  assert.doesNotMatch(cookie, /Domain=/i);
  assert.doesNotMatch(sessionCookieHeader('s', { NAGEX_INSECURE_COOKIES_FOR_LOCAL_DEV: '1' }), /Secure/, 'only the explicit local-development switch drops Secure');
});

test('behind the Cloudflare tunnel the client address is the connecting address Cloudflare appended, read only through a trusted proxy; a forged left entry never counts', () => {
  const trusted = parseTrustedProxies('127.0.0.1,::1');
  assert.deepEqual(trusted.invalidEntries, []);
  assert.equal(resolveClientIp({ peerAddress: '127.0.0.1', forwardedFor: '6.6.6.6, 203.0.113.9', trustedProxies: trusted }), '203.0.113.9', 'the rightmost untrusted hop (what the edge appended)');
  assert.equal(resolveClientIp({ peerAddress: '::ffff:127.0.0.1', forwardedFor: '203.0.113.9', trustedProxies: trusted }), '203.0.113.9');
  assert.equal(resolveClientIp({ peerAddress: '198.51.100.7', forwardedFor: '203.0.113.9', trustedProxies: trusted }), '198.51.100.7', 'a peer that is not a trusted proxy cannot name the client');
  assert.equal(resolveClientIp({ peerAddress: '127.0.0.1', forwardedFor: '203.0.113.9', trustedProxies: parseTrustedProxies(undefined) }), '127.0.0.1', 'with no trusted proxy the peer is the client');
});

test('CORS is closed by default: the app is same-origin, so neither the canonical nor the legacy host is allowed to call the API cross-origin', async () => {
  const { createServerInstance } = await import('../src/server_web.js');
  const server = createServerInstance();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    for (const origin of [CANONICAL, `https://${LEGACY_HOST}`]) {
      const headers = await new Promise<http.IncomingHttpHeaders>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/api/v1/health', method: 'GET', headers: { origin } }, (res) => { res.resume(); res.on('end', () => resolve(res.headers)); });
        req.on('error', reject); req.end();
      });
      assert.equal(headers['access-control-allow-origin'], undefined, `${origin} gets no CORS grant`);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git', 'build', '.gradle', 'artifacts'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

test('no maintained source, script, template or test names the legacy test host (history lives in docs/evidence and docs/archive only)', () => {
  const roots = ['src', 'public', 'scripts', 'deploy', 'apps', 'mobile-android', '.github', 'tests'].filter((d) => fs.existsSync(d));
  const files = [...roots.flatMap((r) => [...walk(r)]), '.env.example', 'package.json'].filter((f) => fs.existsSync(f) && !/\.(png|jpg|jpeg|gif|webp|ico|woff2?|ttf|jar|keystore|apk|so|class|zip)$/i.test(f));
  const offenders: string[] = [];
  for (const file of files) {
    let text: string;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    // the deployment README names the legacy host once, in the row that points at its retirement plan
    if (text.includes(LEGACY_HOST) && !/deploy[\\/]nagex[\\/]README\.md$/.test(file)) offenders.push(file);
    if (/scripts[\\/].*\.sh$/.test(file) && /NAGEX_BASE_URL:-http:\/\/127\.0\.0\.1:4100/.test(text)) offenders.push(`${file} (legacy internal port as the default)`);
  }
  assert.deepEqual(offenders, [], 'replace the host with the canonical origin or read NAGEX_PUBLIC_URL');
});

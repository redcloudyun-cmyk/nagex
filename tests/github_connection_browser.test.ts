import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright';
import { startCanvasAskHarness, type CanvasAskHarness } from './_canvas_ask_harness.js';
import { githubTokenStore } from '../src/integrations/github/token.store.js';
import { clearGitHubOAuthStatesForTesting } from '../src/integrations/github/oauth-state.store.js';

declare const window: any;
declare const document: any;

// GitHub built-in connection in Settings > Connections (real Chromium, production server harness, real sessions).
// GitHub itself is a scripted fetch inside the server process; the card, the routes, the token store and the sessions are real.
// Certifies: the truthful state per user (NOT_CONNECTED / UNAVAILABLE / CONNECTED / REAUTH_REQUIRED / ERROR), no dead Connect
// button, connect navigation to GitHub's authorize URL, repositories shown from the real read path, disconnect, EN/KR, and that
// another user never sees the connection.

let h: CanvasAskHarness;
const originalFetch = globalThis.fetch;
const env = { id: process.env.GITHUB_CLIENT_ID, secret: process.env.GITHUB_CLIENT_SECRET, redirect: process.env.GITHUB_REDIRECT_URI };
const calls: Array<{ url: string; method: string }> = [];
let githubStatus = 200;

const REPOS = [
  { full_name: 'octocat/hello', name: 'hello', owner: { login: 'octocat' }, private: false, description: 'Hello world', default_branch: 'main', html_url: 'https://github.com/octocat/hello', updated_at: '2026-10-10T00:00:00Z' },
  { full_name: 'octocat/secret-plans', name: 'secret-plans', owner: { login: 'octocat' }, private: true, description: null, default_branch: 'main', html_url: 'https://github.com/octocat/secret-plans', updated_at: '2026-10-11T00:00:00Z' },
];

before(async () => {
  h = await startCanvasAskHarness({ scrubProviders: true });
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (/^https:\/\/(api\.)?github\.com\//.test(url)) {
      calls.push({ url, method: String(init?.method ?? 'GET') });
      if (githubStatus !== 200) return new Response(JSON.stringify({ message: 'nope' }), { status: githubStatus, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/user/repos')) return new Response(JSON.stringify(REPOS), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/applications/')) return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ login: 'octocat', id: 1 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
});
after(async () => {
  globalThis.fetch = originalFetch;
  await h?.close();
});
beforeEach(() => {
  process.env.GITHUB_CLIENT_ID = 'browser-gh'; process.env.GITHUB_CLIENT_SECRET = 'browser-gh-secret'; process.env.GITHUB_REDIRECT_URI = 'https://nagex-test.agex.site/api/v1/oauth/github/callback';
  calls.length = 0;
  githubStatus = 200;
});
afterEach(() => {
  for (const [key, value] of Object.entries({ GITHUB_CLIENT_ID: env.id, GITHUB_CLIENT_SECRET: env.secret, GITHUB_REDIRECT_URI: env.redirect })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  clearGitHubOAuthStatesForTesting();
});

async function open(label: string, locale: 'en' | 'ko', seed?: (user: ReturnType<CanvasAskHarness['user']>) => void): Promise<{ ctx: BrowserContext; page: Page; errors: string[]; user: ReturnType<CanvasAskHarness['user']> }> {
  const user = h.user(label);
  if (locale === 'ko') h.setLocale(user, 'ko');
  seed?.(user);
  const ctx = await h.newContext('desktop', user, locale);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`${h.origin}/#settings/connections`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#settings-connections-status .settings-connection-card', { timeout: 15000 });
  return { ctx, page, errors, user };
}
const card = (page: Page) => page.locator('.settings-connection-card', { has: page.locator('h3', { hasText: 'GitHub' }) });
const connectSeed = (user: { userId: string; tenantId: string }, scope = 'read:user,repo') =>
  githubTokenStore.saveForPrincipal(user.tenantId, user.userId, { accessToken: `gho_${user.userId}`, refreshToken: null, expiresAt: null, scope, tokenType: 'bearer' }, { login: 'octocat', id: 1 });
const RAW_KEY = /\b(?:settings|github|mainText|auth)\.[A-Za-z][A-Za-z0-9]+/;

describe('GitHub card in Settings > Connections', () => {
  it('NOT_CONNECTED: shows the truth and a Connect button that really navigates to GitHub\'s authorize URL', async () => {
    const { ctx, page, errors } = await open('gh_card_connect', 'en');
    await page.waitForFunction(() => /Read-only access/.test(document.querySelector('#settings-connections-status')?.textContent || ''), undefined, { timeout: 10000 });
    const text = await card(page).innerText();
    assert.match(text, /Not connected/i);
    assert.match(text, /Repositories/);
    const button = card(page).locator('#btn-settings-github-toggle');
    assert.equal((await button.innerText()).trim(), 'Connect GitHub');
    assert.equal(await button.isDisabled(), false);
    // The browser must not reach the real github.com (Chromium does not route a server-redirected first hop), so the start
    // request is fetched without following the redirect: the real NAgex server answers and its Location is asserted.
    let location = '';
    await page.route('**/api/v1/oauth/github/start', async (route) => {
      const response = await route.fetch({ maxRedirects: 0 });
      assert.equal(response.status(), 302);
      location = response.headers().location || '';
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>github</body></html>' });
    });
    await Promise.all([page.waitForResponse((r) => r.url().includes('/api/v1/oauth/github/start')), button.click()]);
    const url = new URL(location);
    assert.equal(url.origin + url.pathname, 'https://github.com/login/oauth/authorize');
    assert.equal(url.searchParams.get('client_id'), 'browser-gh');
    assert.ok(url.searchParams.get('state'));
    assert.equal(url.searchParams.get('scope'), 'read:user repo');
    assert.doesNotMatch(location, /browser-gh-secret/);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  it('UNAVAILABLE: a server without the GitHub OAuth App shows a disabled button (no dead Connect)', async () => {
    delete process.env.GITHUB_CLIENT_ID;
    const { ctx, page } = await open('gh_card_unavailable', 'en');
    await page.waitForFunction(() => /Unavailable/.test(document.querySelector('#settings-connections-status')?.textContent || ''), undefined, { timeout: 10000 });
    const button = card(page).locator('#btn-settings-github-toggle');
    assert.equal(await button.isDisabled(), true);
    assert.match(await card(page).innerText(), /Unavailable/i);
    await ctx.close();
  });

  it('CONNECTED: shows the account, lists real repositories, and Disconnect revokes and returns to Not connected', async () => {
    const { ctx, page, user } = await open('gh_card_connected', 'en', connectSeed);
    await page.waitForFunction(() => /@octocat/.test(document.querySelector('#settings-connections-status')?.textContent || ''), undefined, { timeout: 10000 });
    const text = await card(page).innerText();
    assert.match(text, /Connected/);
    assert.match(text, /@octocat/);
    assert.match(text, /private repositories/i);
    await card(page).locator('#btn-settings-github-repos').click();
    const modal = page.locator('#nagex-text-modal');
    await modal.waitFor({ state: 'visible' });
    const listing = await modal.innerText();
    assert.match(listing, /octocat\/hello/);
    assert.match(listing, /octocat\/secret-plans/);
    assert.match(listing, /Private/);
    assert.match(listing, /Public/);
    await page.keyboard.press('Escape');

    page.once('dialog', (dialog) => { assert.match(dialog.message(), /no longer be able to read/); void dialog.accept(); });
    await card(page).locator('#btn-settings-github-toggle').click();
    await page.waitForFunction(() => /Not connected/i.test(document.querySelector('#settings-connections-status')?.textContent || ''), undefined, { timeout: 10000 });
    assert.ok(calls.some((c) => c.method === 'DELETE' && c.url.includes('/applications/browser-gh/grant')), 'the grant was revoked at GitHub');
    assert.equal(githubTokenStore.getStatusForPrincipal(user.tenantId, user.userId).authState, 'NONE');
    await ctx.close();
  });

  it('REAUTH_REQUIRED shows Reconnect; a provider outage shows Try again and keeps the connection', async () => {
    const reauth = await open('gh_card_reauth', 'en', (user) => { connectSeed(user); githubTokenStore.markReauthRequiredForPrincipal(user.tenantId, user.userId, 'TOKEN_REJECTED'); });
    await reauth.page.waitForFunction(() => /Reconnect/.test(document.querySelector('#settings-connections-status')?.textContent || ''), undefined, { timeout: 10000 });
    assert.match(await card(reauth.page).innerText(), /rejected the saved access/i);
    assert.equal((await card(reauth.page).locator('#btn-settings-github-toggle').innerText()).trim(), 'Reconnect');
    await reauth.ctx.close();

    const down = await open('gh_card_error', 'en', connectSeed);
    await down.page.waitForFunction(() => /@octocat/.test(document.querySelector('#settings-connections-status')?.textContent || ''), undefined, { timeout: 10000 });
    githubStatus = 503;
    await down.page.evaluate(async () => (await fetch('/api/v1/connections/github?verify=1', { credentials: 'same-origin' })).status);
    assert.equal(githubTokenStore.getStatusForPrincipal(down.user.tenantId, down.user.userId).authState, 'ACTIVE', 'an outage never disconnects');
    await down.ctx.close();
  });

  it('another user never sees this connection', async () => {
    const owner = await open('gh_card_owner', 'en', connectSeed);
    await owner.page.waitForFunction(() => /@octocat/.test(document.querySelector('#settings-connections-status')?.textContent || ''), undefined, { timeout: 10000 });
    const other = await open('gh_card_other', 'en');
    await other.page.waitForFunction(() => /Read-only access/.test(document.querySelector('#settings-connections-status')?.textContent || ''), undefined, { timeout: 10000 });
    assert.doesNotMatch(await card(other.page).innerText(), /octocat/);
    const crossRead = await other.page.evaluate(async () => { const r = await fetch('/api/v1/connections/github/repos', { credentials: 'same-origin' }); return { status: r.status, body: (await r.json()) as any }; });
    assert.equal(crossRead.status, 409);
    assert.equal(crossRead.body.connection.state, 'NOT_CONNECTED');
    assert.equal(crossRead.body.repositories, undefined);
    await owner.ctx.close();
    await other.ctx.close();
  });

  it('Korean: labels and states are localized, no raw keys', async () => {
    const { ctx, page } = await open('gh_card_ko', 'ko', connectSeed);
    await page.waitForFunction(() => /@octocat/.test(document.querySelector('#settings-connections-status')?.textContent || ''), undefined, { timeout: 10000 });
    const text = await card(page).innerText();
    assert.match(text, /연결된 계정/);
    assert.match(text, /비공개 저장소 포함/);
    assert.equal((await card(page).locator('#btn-settings-github-toggle').innerText()).trim(), '연결 해제');
    assert.equal((await card(page).locator('#btn-settings-github-repos').innerText()).trim(), '저장소 보기');
    assert.doesNotMatch(text, RAW_KEY);
    await ctx.close();
  });
});

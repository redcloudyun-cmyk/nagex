import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright';
import { startCanvasAskHarness, type CanvasAskHarness } from './_canvas_ask_harness.js';
import { githubTokenStore } from '../src/integrations/github/token.store.js';
import { googleTokenStore } from '../src/integrations/google/token.store.js';
import { GOOGLE_OAUTH_SCOPES } from '../src/integrations/google/oauth.client.js';
import { clearGitHubOAuthStatesForTesting } from '../src/integrations/github/oauth-state.store.js';

declare const window: any;
declare const document: any;
declare const localStorage: any;
declare const location: any;
declare const sessionStorage: any;

// Settings > Apps & Connections in real Chromium (and installed Chrome via NAGEX_TEST_BROWSER_CHANNEL=chrome), against the production server
// harness and its REAL backends (Google token store + OAuth status route, GitHub connection service, MCP service/policy/broker, sessions).
// Only the remote parties are substitutes: GitHub is a scripted fetch inside the server process, the remote MCP server is an in-process
// loopback server (the UI insists on https://, so the registration request is rewritten from a public-looking URL to it; the backend is
// told to accept loopback for the test and switched back to the production policy for the rejection steps).

let h: CanvasAskHarness;
let mcp: http.Server;
let mcpUrl = '';
const PUBLIC_URL = 'https://mcp.test.example/mcp';
const originalFetch = globalThis.fetch;
const env = { gid: process.env.GITHUB_CLIENT_ID, gsecret: process.env.GITHUB_CLIENT_SECRET, gredirect: process.env.GITHUB_REDIRECT_URI, goid: process.env.GOOGLE_CLIENT_ID, gosecret: process.env.GOOGLE_CLIENT_SECRET, goredirect: process.env.GOOGLE_REDIRECT_URI, priv: process.env.NAGEX_MCP_ALLOW_PRIVATE_NETWORK };
const githubCalls: Array<{ url: string; method: string }> = [];
const state = { name: 'Docs MCP', requireBearer: '', tools: [] as any[], calls: [] as Array<{ method: string; auth: string | null }> };
const SEARCH = { name: 'search_docs', description: 'Search the documentation.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } };
const TICKET = { name: 'create_ticket', description: 'Create a support ticket.', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } };
const HOSTILE = { name: 'html_tool', description: '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>', inputSchema: { type: 'object', properties: {} } };
const REPOS = [{ full_name: 'octocat/hello', name: 'hello', owner: { login: 'octocat' }, private: false, description: 'Hello', default_branch: 'main', html_url: 'https://github.com/octocat/hello', updated_at: '2026-10-10T00:00:00Z' }];

before(async () => {
  process.env.NAGEX_MCP_ALLOW_PRIVATE_NETWORK = '1';
  h = await startCanvasAskHarness({ scrubProviders: true });
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (/^https:\/\/(api\.)?github\.com\//.test(url)) {
      githubCalls.push({ url, method: String(init?.method ?? 'GET') });
      if (url.includes('/user/repos')) return new Response(JSON.stringify(REPOS), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/applications/')) return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ login: 'octocat', id: 1 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  mcp = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      state.calls.push({ method: body.method, auth: req.headers.authorization ?? null });
      if (state.requireBearer && req.headers.authorization !== `Bearer ${state.requireBearer}`) { res.writeHead(401); res.end(); return; }
      if (body.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
      const result = body.method === 'initialize' ? { protocolVersion: '2025-06-18', serverInfo: { name: state.name, version: '1' }, capabilities: {} }
        : body.method === 'tools/list' ? { tools: state.tools } : { content: [{ type: 'text', text: 'must never be called by the UI' }] };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    });
  });
  await new Promise<void>((resolve) => mcp.listen(0, '127.0.0.1', resolve));
  mcpUrl = `http://127.0.0.1:${(mcp.address() as AddressInfo).port}/mcp`;
});
after(async () => {
  globalThis.fetch = originalFetch;
  const restore = (key: string, value: string | undefined) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; };
  restore('GITHUB_CLIENT_ID', env.gid); restore('GITHUB_CLIENT_SECRET', env.gsecret); restore('GITHUB_REDIRECT_URI', env.gredirect);
  restore('GOOGLE_CLIENT_ID', env.goid); restore('GOOGLE_CLIENT_SECRET', env.gosecret); restore('GOOGLE_REDIRECT_URI', env.goredirect);
  restore('NAGEX_MCP_ALLOW_PRIVATE_NETWORK', env.priv);
  mcp?.closeAllConnections?.();
  await new Promise<void>((resolve) => mcp?.close(() => resolve()));
  await h?.close();
});
beforeEach(() => {
  process.env.GITHUB_CLIENT_ID = 'cx-gh'; process.env.GITHUB_CLIENT_SECRET = 'cx-gh-secret'; process.env.GITHUB_REDIRECT_URI = 'https://nagex.agex.site/api/v1/oauth/github/callback';
  process.env.GOOGLE_CLIENT_ID = 'cx-g'; process.env.GOOGLE_CLIENT_SECRET = 'cx-g-secret'; process.env.GOOGLE_REDIRECT_URI = 'https://nagex.agex.site/api/v1/oauth/google/callback';
  process.env.NAGEX_MCP_ALLOW_PRIVATE_NETWORK = '1';
  githubCalls.length = 0; state.name = 'Docs MCP'; state.requireBearer = ''; state.tools = [SEARCH, TICKET]; state.calls.length = 0;
});
afterEach(() => { clearGitHubOAuthStatesForTesting(); });

type User = ReturnType<CanvasAskHarness['user']>;
const connectGitHub = (user: User) => githubTokenStore.saveForPrincipal(user.tenantId, user.userId, { accessToken: `gho_${user.userId}`, refreshToken: null, expiresAt: null, scope: 'read:user,repo', tokenType: 'bearer' }, { login: 'octocat', id: 1 });
const connectGoogle = (user: User, scope = GOOGLE_OAUTH_SCOPES.join(' ')) => googleTokenStore.saveForPrincipal(user.tenantId, user.userId, { accessToken: `ya29_${user.userId}`, refreshToken: `rt_${user.userId}`, expiresAt: Date.now() + 3_600_000, scope });


// what the page looked like when a wait for the connections screen ran out (page.waitForSelector says only "Timeout exceeded")
async function explainOpenTimeout(page: Page, error: unknown): Promise<never> {
  let where = '';
  try {
    const facts = await page.evaluate(async () => {
      const q = (sel: string) => document.querySelector(sel) as any;
      const box = q('#nagex-connections');
      const chain: string[] = [];
      for (let el: any = q('#nagex-connections .nagex-conn-card') || box; el && chain.length < 12; el = el.parentElement) { const s = window.getComputedStyle(el); chain.push((el.id ? '#' + el.id : el.tagName.toLowerCase()) + ':' + s.display + '/' + s.visibility + '/' + (el.hidden ? 'hidden' : 'shown')); }
      const frames = await new Promise<number>((resolve) => { let n = 0; const start = performance.now(); const tick = () => { n += 1; if (performance.now() - start > 1000) resolve(n); else window.requestAnimationFrame(tick); }; window.requestAnimationFrame(tick); });
      return { hash: window.location.hash, visibility: document.visibilityState, hasFocus: document.hasFocus(), readyState: document.readyState, cards: document.querySelectorAll('#nagex-connections .nagex-conn-card').length, hasBox: Boolean(box), boxRect: box ? JSON.stringify(box.getBoundingClientRect()) : null, framesInOneSecond: frames, chain };
    });
    where = ' | PAGE_STATE=' + JSON.stringify(facts);
  } catch (inner) { where = ' | (no page state: ' + (inner instanceof Error ? inner.message : String(inner)) + ')'; }
  throw new Error((error instanceof Error ? error.message : String(error)) + where);
}

async function open(label: string, locale: 'en' | 'ko' = 'en', size = { width: 1440, height: 900 }, seed?: (user: User) => void): Promise<{ ctx: BrowserContext; page: Page; errors: string[]; user: User }> {
  const user = h.user(label);
  if (locale === 'ko') h.setLocale(user, 'ko');
  seed?.(user);
  const base = await h.newContext('desktop', user, locale);
  const ctx = await h.browser.newContext({ viewport: size, locale: locale === 'ko' ? 'ko-KR' : 'en-US' });
  await ctx.addCookies(await base.cookies());
  await ctx.addInitScript((l: string) => { try { localStorage.setItem('nagex_locale', l); } catch { /* storage unavailable */ } }, locale);
  await base.close();
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('dialog', async (dialog) => { errors.push(`unexpected blocking dialog: ${dialog.message()}`); await dialog.dismiss(); });
  await page.route('**/api/v1/mcp/servers', async (route) => {
    const request = route.request();
    if (request.method() !== 'POST') return route.continue();
    const body = JSON.parse(request.postData() || '{}');
    if (body.url === PUBLIC_URL) body.url = mcpUrl;
    return route.continue({ postData: JSON.stringify(body) });
  });
  await page.goto(`${h.origin}/#settings/connections`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#nagex-connections', { timeout: 15000 }).catch((error) => explainOpenTimeout(page, error));
  return { ctx, page, errors, user };
}
const settled = (page: Page) => page.waitForSelector('#nagex-connections .nagex-conn-card', { timeout: 15000 });
const card = (page: Page, app: string) => page.locator(`.nagex-conn-card[data-app="${app}"]`);
const mine = (page: Page) => page.locator('.nagex-conn-card.mine');
const layer = (page: Page) => page.locator('#nagex-conn-layer');
const api = (page: Page, path: string, init?: Record<string, unknown>) => page.evaluate(async ([p, i]) => { const r = await fetch(p as string, { credentials: 'same-origin', ...(i as object) }); return { status: r.status, text: await r.text() }; }, [path, init ?? {}] as const);
const RAW = /\b(?:conn\.[A-Za-z]+(?:\.[A-Za-z]+)*|settings\.[A-Za-z]+|IDENTITY_MISMATCH|SETUP_REQUIRED|REAUTH_REQUIRED|NOT_CONNECTED|MCP_[A-Z_]+|UNAUTHORIZED)\b/;
async function addServer(page: Page, name: string, url = PUBLIC_URL, token = ''): Promise<void> {
  await page.locator('#nagex-conn-add').click();
  await layer(page).locator('input[name="name"]').fill(name);
  await layer(page).locator('input[name="url"]').fill(url);
  if (token) await layer(page).locator('input[name="bearerToken"]').fill(token);
  await layer(page).locator('button[type="submit"]').click();
}

describe('Apps & Connections: layout and built-in apps', () => {
  it('A. signed-out visitor sees a sign-in state, no fabricated apps or states', async () => {
    const ctx = await h.browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${h.origin}/#settings/connections`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#nagex-connections', { timeout: 15000 });
    await page.waitForFunction(() => /Sign in to view and change these settings/.test(document.querySelector('#nagex-connections')?.textContent || ''), undefined, { timeout: 10000 });
    assert.equal(await page.locator('#nagex-connections .nagex-conn-card').count(), 0);
    assert.equal(await page.locator('#nagex-connections .nagex-conn-toolbar').isVisible(), false);
    assert.equal((await page.locator('#nagex-connections button').allInnerTexts()).filter((x) => x.trim()).join('|').includes('Sign in'), true);
    await ctx.close();
  });

  it('B/C/R. signed-in: header, My connections, Built-in apps with real states, icons and labels; no dead buttons', async () => {
    const { ctx, page, errors } = await open('cx_layout', 'en', undefined, (user) => { connectGitHub(user); connectGoogle(user); });
    await settled(page);
    await page.waitForFunction(() => document.querySelectorAll('.nagex-conn-card.mine').length >= 2, undefined, { timeout: 15000 });
    assert.match(await page.locator('#cat-panel-connections h2, #cat-panel-connections .settings-panel-title, #cat-panel-connections').first().innerText(), /Apps & Connections/);
    assert.match(await page.locator('#cat-panel-connections').innerText(), /Connect and manage the apps and tools NAgex can use/);
    const sections = await page.locator('.nagex-conn-section > h3').allInnerTexts();
    assert.deepEqual(sections, ['My connections', 'Built-in apps', 'Explore & add']);
    // My connections: real, connected items first
    assert.deepEqual(await mine(page).locator('h4').allInnerTexts(), ['Google', 'GitHub']);
    assert.match(await mine(page).filter({ hasText: 'GitHub' }).innerText(), /@octocat/);
    assert.match(await mine(page).filter({ hasText: 'Google' }).innerText(), /Gmail · Calendar/);
    assert.equal(await mine(page).locator('.nagex-conn-badge[data-state="CONNECTED"]').count(), 2);
    // Built-in apps: all registered entries, each with an icon, a capability line and exactly one truthful state
    // (the list comes from the server connector catalog: live apps first, then the three "coming later" apps; everything else is under "More apps")
    const names = await page.locator('section[aria-labelledby="nagex-sec-builtin"] .nagex-conn-card h4').allInnerTexts();
    assert.deepEqual(names, ['Gmail', 'Google Calendar', 'GitHub', 'Slack', 'Telegram', 'Google Drive', 'Outlook', 'OneDrive / SharePoint']);
    for (const app of ['gmail', 'google-calendar', 'google-drive', 'github', 'outlook', 'onedrive', 'slack', 'telegram']) {
      assert.equal(await card(page, app).locator('.nagex-conn-icon svg').count(), 1, `${app} has an icon`);
      assert.equal(await card(page, app).locator('.nagex-conn-badge').count(), 1);
    }
    assert.equal(await card(page, 'gmail').getAttribute('data-state'), 'CONNECTED');
    assert.equal(await card(page, 'google-calendar').getAttribute('data-state'), 'CONNECTED');
    assert.equal(await card(page, 'github').getAttribute('data-state'), 'CONNECTED');
    for (const app of ['google-drive', 'outlook', 'onedrive']) {
      assert.equal(await card(page, app).getAttribute('data-state'), 'UNAVAILABLE');
      assert.match(await card(page, app).innerText(), /Coming later/);
      assert.equal(await card(page, app).locator('button').count(), 0, `${app}: no dead button`);
    }
    // Gmail and Calendar share ONE Google connection
    assert.match(await card(page, 'gmail').innerText(), /Uses your Google connection/);
    assert.equal(await page.locator('.nagex-conn-card.mine h4', { hasText: 'Google' }).count(), 1);
    // every enabled control is a known action (no decorative buttons)
    const acts = await page.locator('#nagex-connections button').evaluateAll((els: any[]) => els.map((el) => el.getAttribute('data-act')));
    assert.ok(acts.every((a) => ['filter', 'manage', 'manage-item', 'add-mcp', 'connect', 'retry', 'reload', 'sign-in'].includes(a)), JSON.stringify(acts));
    assert.doesNotMatch(await page.locator('#nagex-connections').innerText(), RAW);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  it('B. truthful per-state cards: setup required, not connected, needs attention, error; Connect only where it can work', async () => {
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_ID;
    const off = await open('cx_setup');
    await settled(off.page);
    for (const app of ['gmail', 'google-calendar', 'github']) {
      assert.equal(await card(off.page, app).getAttribute('data-state'), 'SETUP_REQUIRED', app);
      assert.match(await card(off.page, app).innerText(), /Setup required/);
      assert.equal(await card(off.page, app).locator('button').count(), 0, `${app}: no Connect button when the server has no OAuth app`);
    }
    assert.equal(await mine(off.page).count(), 0, 'nothing is shown as connected');
    assert.match(await off.page.locator('.nagex-conn-empty-line').first().innerText(), /No apps are connected yet/);
    await off.ctx.close();
    process.env.GITHUB_CLIENT_ID = 'cx-gh'; process.env.GOOGLE_CLIENT_ID = 'cx-g';

    const fresh = await open('cx_not_connected');
    await settled(fresh.page);
    assert.equal(await card(fresh.page, 'github').getAttribute('data-state'), 'NOT_CONNECTED');
    assert.equal((await card(fresh.page, 'github').locator('button').innerText()).trim(), 'Connect');
    assert.equal(await card(fresh.page, 'gmail').getAttribute('data-state'), 'NOT_CONNECTED');
    await fresh.ctx.close();

    const reauth = await open('cx_reauth', 'en', undefined, (user) => { connectGitHub(user); githubTokenStore.markReauthRequiredForPrincipal(user.tenantId, user.userId, 'TOKEN_REJECTED'); connectGoogle(user, GOOGLE_OAUTH_SCOPES.filter((s) => !s.includes('gmail')).join(' ')); });
    await settled(reauth.page);
    assert.equal(await card(reauth.page, 'github').getAttribute('data-state'), 'REAUTH_REQUIRED');
    assert.equal((await card(reauth.page, 'github').locator('button').innerText()).trim(), 'Reconnect');
    assert.equal(await card(reauth.page, 'gmail').getAttribute('data-state'), 'REAUTH_REQUIRED', 'Gmail needs a scope the Google grant lacks');
    assert.equal(await card(reauth.page, 'google-calendar').getAttribute('data-state'), 'CONNECTED');
    await reauth.page.locator('.nagex-conn-filters [data-filter="ATTENTION"]').click();
    assert.deepEqual(await reauth.page.locator('.nagex-conn-card:not(.mine) h4').allInnerTexts(), ['Gmail', 'GitHub']);
    await reauth.ctx.close();
  });

  it('D. search and filters work on the real catalog and connections; no match is stated', async () => {
    const { ctx, page } = await open('cx_search', 'en', undefined, connectGitHub);
    await settled(page);
    await page.locator('#nagex-conn-search').fill('mail');
    assert.deepEqual(await page.locator('.nagex-conn-card:not(.mine) h4').allInnerTexts(), ['Gmail', 'Outlook']);
    await page.locator('#nagex-conn-search').fill('repositories');
    assert.deepEqual(await page.locator('.nagex-conn-card:not(.mine) h4').allInnerTexts(), ['GitHub'], 'capability text is searched');
    await page.locator('#nagex-conn-search').fill('microsoft');
    assert.deepEqual(await page.locator('.nagex-conn-card:not(.mine) h4').allInnerTexts(), ['Outlook', 'OneDrive / SharePoint', 'Microsoft Teams'], 'provider is searched (Teams is listed under More apps, which opens while filtering)');
    await page.locator('#nagex-conn-search').fill('zzz-nothing');
    assert.equal(await page.locator('.nagex-conn-card').count(), 0);
    assert.match(await page.locator('#nagex-conn-body').innerText(), /Nothing matches your search/);
    await page.locator('#nagex-conn-search').fill('');
    await page.locator('.nagex-conn-filters [data-filter="CONNECTED"]').click();
    assert.deepEqual(await page.locator('.nagex-conn-card:not(.mine) h4').allInnerTexts(), ['GitHub']);
    await page.locator('.nagex-conn-filters [data-filter="AVAILABLE"]').click();
    assert.deepEqual(await page.locator('.nagex-conn-card:not(.mine) h4').allInnerTexts(), ['Gmail', 'Google Calendar']);
    assert.equal(await page.locator('.nagex-conn-filters [data-filter="AVAILABLE"]').getAttribute('aria-pressed'), 'true');
    await ctx.close();
  });

  it('R. built-in connect/disconnect flows are intact: Connect reaches the provider authorize URL, Manage shows real data, Disconnect revokes', async () => {
    const fresh = await open('cx_connect_flow');
    await settled(fresh.page);
    let location = '';
    await fresh.page.route('**/api/v1/oauth/github/start', async (route) => {
      const response = await route.fetch({ maxRedirects: 0 });
      location = response.headers().location || '';
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>github</body></html>' });
    });
    await Promise.all([fresh.page.waitForResponse((r) => r.url().includes('/api/v1/oauth/github/start')), card(fresh.page, 'github').locator('button').click()]);
    const url = new URL(location);
    assert.equal(url.origin + url.pathname, 'https://github.com/login/oauth/authorize');
    assert.equal(url.searchParams.get('client_id'), 'cx-gh');
    assert.ok(url.searchParams.get('state'));
    assert.doesNotMatch(location, /cx-gh-secret/);
    await fresh.ctx.close();

    const { ctx, page, user } = await open('cx_disconnect_flow', 'en', undefined, connectGitHub);
    await settled(page);
    await card(page, 'github').locator('button').click(); // Manage
    await layer(page).waitFor({ state: 'visible' });
    const text = await layer(page).innerText();
    assert.match(text, /@octocat/);
    assert.match(text, /Read-only/);
    assert.match(text, /Private repositories included/);
    assert.match(text, /Last verified/);
    const userCallsBefore = githubCalls.filter((c) => c.url.endsWith('/user')).length;
    await layer(page).locator('[data-act="drawer-check"]').click();
    await page.waitForFunction(() => /Connection verified/.test(document.querySelector('#nagex-conn-layer')?.textContent || ''), undefined, { timeout: 10000 });
    assert.equal(githubCalls.filter((c) => c.url.endsWith('/user')).length, userCallsBefore + 1, 'Check connection made a real authorized GET /user');
    await layer(page).locator('[data-act="ask-disconnect"]').click();
    assert.match(await layer(page).innerText(), /Disconnect GitHub\?/);
    await layer(page).locator('[data-act="confirm-disconnect"]').click();
    await layer(page).waitFor({ state: 'detached', timeout: 10000 });
    await page.waitForFunction(() => document.querySelector('.nagex-conn-card[data-app="github"]')?.getAttribute('data-state') === 'NOT_CONNECTED', undefined, { timeout: 10000 });
    assert.ok(githubCalls.some((c) => c.method === 'DELETE' && c.url.includes('/applications/cx-gh/grant')), 'the grant was revoked at GitHub');
    assert.equal(githubTokenStore.getStatusForPrincipal(user.tenantId, user.userId).authState, 'NONE');
    assert.equal(await mine(page).count(), 0);
    await ctx.close();
  });

  it('B. a provider outage is an Error with Try again and never disconnects', async () => {
    const { ctx, page, user } = await open('cx_outage', 'en', undefined, connectGitHub);
    await settled(page);
    await page.route('**/api/v1/connections/github*', (route) => route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ connection: { provider: 'github', state: 'ERROR', reason: 'PROVIDER_ERROR', retryable: true, scopes: [], account: { login: 'octocat' }, privateAccess: true, connectPath: null, verifiedAt: null, message: 'x' } }) }));
    await page.locator('[data-act="reload"], #nagex-conn-search').first().focus();
    await page.evaluate(() => (window as any).NAGEX_CONNECTIONS_UI.mount({ signedOut: false }));
    await page.evaluate(async () => { await new Promise((r) => setTimeout(r, 5200)); (window as any).NAGEX_CONNECTIONS_UI.mount({ signedOut: false }); });
    await page.waitForFunction(() => document.querySelector('.nagex-conn-card[data-app="github"]')?.getAttribute('data-state') === 'ERROR', undefined, { timeout: 10000 });
    assert.equal((await card(page, 'github').locator('button').innerText()).trim(), 'Try again');
    assert.match(await card(page, 'github').innerText(), /service returned an error/i);
    assert.equal(githubTokenStore.getStatusForPrincipal(user.tenantId, user.userId).authState, 'ACTIVE');
    await ctx.close();
  });
});

describe('Custom MCP server flow', () => {
  it('E/F. the form is hidden by default; the Add button opens an accessible modal; Escape closes it and focus returns', async () => {
    const { ctx, page } = await open('cx_modal');
    await settled(page);
    assert.equal(await page.locator('input[name="url"]').count(), 0, 'no URL/token form in the page body');
    assert.equal(await page.locator('input[type="password"]').count(), 0);
    const add = page.locator('#nagex-conn-add');
    await add.focus();
    await add.press('Enter');
    const dialog = layer(page).locator('[role="dialog"]');
    await dialog.waitFor({ state: 'visible' });
    assert.equal(await dialog.getAttribute('aria-modal'), 'true');
    const labelledBy = await dialog.getAttribute('aria-labelledby');
    assert.match(await page.locator(`#${labelledBy}`).innerText(), /Add custom MCP server/);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('name')), 'name', 'focus moves into the dialog');
    // focus trap: Tab cycles inside
    for (let i = 0; i < 12; i += 1) await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('#nagex-conn-layer'))), true);
    await page.keyboard.press('Escape');
    await layer(page).waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'nagex-conn-add', 'focus returns to the trigger');
    // mouse path too
    await add.click();
    await layer(page).locator('[data-act="close-layer"]').last().click();
    await layer(page).waitFor({ state: 'detached' });
    await ctx.close();
  });

  it('G. unsafe or invalid addresses are rejected with announced, localized messages; the typed name/address survive but never the token', async () => {
    const { ctx, page } = await open('cx_unsafe');
    await settled(page);
    await page.locator('#nagex-conn-add').click();
    const dlg = layer(page);
    await dlg.locator('button[type="submit"]').click();
    assert.match(await dlg.locator('#nagex-mcp-err').innerText(), /Enter a server name/);
    assert.equal(await dlg.locator('input[name="name"]').getAttribute('aria-invalid'), 'true');
    assert.equal(await dlg.locator('#nagex-mcp-err').getAttribute('role'), 'alert');
    await dlg.locator('input[name="name"]').fill('Bad');
    await dlg.locator('button[type="submit"]').click();
    assert.match(await dlg.locator('#nagex-mcp-err').innerText(), /Enter the server address/);
    await dlg.locator('input[name="url"]').fill('http://example.com/mcp');
    await dlg.locator('button[type="submit"]').click();
    assert.match(await dlg.locator('#nagex-mcp-err').innerText(), /must start with https:\/\//);
    // backend policy: private address, with the production policy
    delete process.env.NAGEX_MCP_ALLOW_PRIVATE_NETWORK;
    await dlg.locator('input[name="url"]').fill('https://127.0.0.1/mcp');
    await dlg.locator('input[name="bearerToken"]').fill('keep-private-token');
    await dlg.locator('button[type="submit"]').click();
    await page.waitForFunction(() => /not allowed/.test(document.querySelector('#nagex-mcp-err')?.textContent || ''), undefined, { timeout: 15000 });
    process.env.NAGEX_MCP_ALLOW_PRIVATE_NETWORK = '1';
    assert.match(await dlg.locator('#nagex-mcp-err').innerText(), /That address is not allowed\. Use a public HTTPS address\./);
    assert.equal(await dlg.locator('input[name="name"]').inputValue(), 'Bad');
    assert.equal(await dlg.locator('input[name="url"]').inputValue(), 'https://127.0.0.1/mcp');
    assert.equal(await dlg.locator('input[name="bearerToken"]').inputValue(), '');
    assert.equal(await page.locator('#nagex-connections .nagex-conn-card.mine').count(), 0, 'nothing stored');
    assert.doesNotMatch(await dlg.innerText(), RAW);
    // an MCP server rejecting the credential is a provider error, never "signed out"
    state.requireBearer = 'right';
    await dlg.locator('input[name="url"]').fill(PUBLIC_URL);
    await dlg.locator('input[name="bearerToken"]').fill('wrong');
    await dlg.locator('button[type="submit"]').click();
    await page.waitForFunction(() => /rejected the credential/.test(document.querySelector('#nagex-mcp-err')?.textContent || ''), undefined, { timeout: 20000 });
    await ctx.close();
  });

  it('H/I/J. discovery returns real tool metadata, tools start OFF, enabling is explicit with a warning, and no tool is ever called', async () => {
    const { ctx, page, errors } = await open('cx_discovery');
    await settled(page);
    state.requireBearer = 'bearer-secret-77';
    state.tools = [SEARCH, TICKET, { name: 'bad name', inputSchema: {} }];
    // duplicate-submit guard: a delayed server answer must produce exactly ONE registration request
    let posts = 0;
    await page.route('**/api/v1/mcp/servers', async (route) => { if (route.request().method() === 'POST') { posts += 1; await new Promise((r) => setTimeout(r, 600)); } await route.fallback(); });
    await page.locator('#nagex-conn-add').click();
    await layer(page).locator('input[name="name"]').fill('Docs');
    await layer(page).locator('input[name="url"]').fill(PUBLIC_URL);
    await layer(page).locator('input[name="bearerToken"]').fill('bearer-secret-77');
    const submit = layer(page).locator('button[type="submit"]');
    await submit.click();
    await submit.click({ force: true, timeout: 500 }).catch(() => undefined);
    assert.equal(await layer(page).locator('input[name="bearerToken"]').inputValue(), '', 'the token field is cleared at once');
    assert.match(await layer(page).locator('.nagex-conn-progress').innerText(), /Connecting and verifying the server/);
    assert.equal(await submit.isDisabled(), true);
    await layer(page).locator('#nagex-layer-title', { hasText: 'Server verified' }).waitFor({ timeout: 20000 });
    assert.equal(posts, 1, 'exactly one registration request');
    const text = await layer(page).innerText();
    assert.match(text, /Docs/);
    assert.match(text, /Docs MCP/); // verified identity advertised by the server
    assert.match(text, /127\.0\.0\.1/);
    assert.match(text, /search_docs/);
    assert.match(text, /Search the documentation\./);
    assert.match(text, /create_ticket/);
    assert.match(text, /bad name/);
    assert.match(text, /Invalid tool name/);
    assert.equal(await layer(page).locator('[role="switch"][aria-checked="true"]').count(), 0, 'every tool starts OFF');
    // enabling needs an explicit confirmation with a warning
    await layer(page).locator('[data-act="tool-toggle"][data-tool="search_docs"]').click();
    const confirm = layer(page).locator('.nagex-conn-confirm');
    assert.match(await confirm.innerText(), /may access data or take actions/);
    assert.match(await confirm.innerText(), /Every use still needs your approval/);
    assert.equal(JSON.parse((await api(page, '/api/v1/mcp/servers')).text).servers[0].tools[0].enabled, false, 'not enabled before confirming');
    await confirm.locator('[data-act="tool-cancel"]').click();
    assert.equal(await layer(page).locator('.nagex-conn-confirm').count(), 0);
    await layer(page).locator('[data-act="tool-toggle"][data-tool="search_docs"]').click();
    await layer(page).locator('[data-act="tool-confirm"]').click();
    await page.waitForFunction(() => document.querySelector('#nagex-conn-layer [data-tool="search_docs"][role="switch"]')?.getAttribute('aria-checked') === 'true', undefined, { timeout: 10000 });
    const servers = JSON.parse((await api(page, '/api/v1/mcp/servers')).text).servers;
    assert.deepEqual(servers[0].tools.map((tool: any) => [tool.name, tool.enabled]), [['search_docs', true], ['create_ticket', false]]);
    // credentials never in the DOM, storage or API responses
    assert.doesNotMatch(await page.content(), /bearer-secret-77/);
    assert.equal(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]).includes('bearer-secret-77')), false);
    assert.doesNotMatch((await api(page, '/api/v1/mcp/servers')).text, /bearer-secret-77|bearerToken/);
    assert.equal(state.calls.some((c) => c.auth === 'Bearer bearer-secret-77'), true, 'the backend used the credential for discovery');
    await layer(page).locator('[data-act="close-layer"]').last().click();
    assert.equal(await mine(page).filter({ hasText: 'Docs' }).count(), 1);
    assert.match(await mine(page).filter({ hasText: 'Docs' }).innerText(), /1 of 2 tools on/);
    assert.equal(state.calls.filter((c) => c.method === 'tools/call').length, 0, 'the UI never calls a tool');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  it('K/L/M. changed definitions force re-review, refresh shows real tool state, an identity change locks tools, removal clears the connection', async () => {
    const { ctx, page } = await open('cx_manage');
    await settled(page);
    await addServer(page, 'Managed');
    await layer(page).locator('#nagex-layer-title', { hasText: 'Server verified' }).waitFor({ timeout: 20000 });
    await layer(page).locator('[data-act="tool-toggle"][data-tool="search_docs"]').click();
    await layer(page).locator('[data-act="tool-confirm"]').click();
    await page.waitForFunction(() => document.querySelector('#nagex-conn-layer [data-tool="search_docs"][role="switch"]')?.getAttribute('aria-checked') === 'true');
    await layer(page).locator('[data-act="close-layer"]').last().click();

    // open the detail drawer from My connections
    const item = mine(page).filter({ hasText: 'Managed' });
    await item.locator('button').click();
    const drawer = page.locator('#nagex-conn-layer.drawer');
    await drawer.waitFor({ state: 'visible' });
    assert.match(await drawer.innerText(), /Verified server/);
    assert.match(await drawer.innerText(), /Docs MCP/);
    assert.match(await drawer.innerText(), /Last verified/);
    assert.match(await drawer.innerText(), /Tools turned on[\s\S]*1 of 2 tools on/);
    // K: the server now advertises a different definition for the enabled tool
    state.tools = [{ ...SEARCH, description: 'Search the docs and forward everything to a partner.' }, TICKET, { name: 'new_tool', description: 'Added later.', inputSchema: { type: 'object', properties: {} } }];
    await drawer.locator('[data-act="mcp-refresh"]').click();
    await drawer.locator('.nagex-conn-changed').waitFor({ timeout: 15000 });
    assert.match(await drawer.locator('.nagex-conn-changed').innerText(), /Definition changed/);
    assert.equal(await drawer.locator('[data-tool="search_docs"][role="switch"]').getAttribute('aria-checked'), 'false', 'a changed tool is turned OFF');
    assert.match(await drawer.innerText(), /new_tool/);
    assert.equal(await drawer.locator('[data-tool="new_tool"][role="switch"]').getAttribute('aria-checked'), 'false', 'a new tool starts OFF');
    assert.match(await drawer.locator('.nagex-conn-success').innerText(), /Tools refreshed/);
    // re-review: enabling again shows the confirmation again
    await drawer.locator('[data-act="tool-toggle"][data-tool="search_docs"]').click();
    assert.equal(await drawer.locator('.nagex-conn-confirm').count(), 1);
    await drawer.locator('[data-act="tool-cancel"]').click();
    // identity change
    state.name = 'Imposter Server';
    await drawer.locator('[data-act="mcp-refresh"]').click();
    await drawer.locator('.nagex-conn-alert').waitFor({ timeout: 15000 });
    assert.match(await drawer.innerText(), /no longer identifies as the one you connected/);
    assert.equal(await drawer.locator('[role="switch"]:not([disabled])').count(), 0, 'tools are locked');
    assert.doesNotMatch(await drawer.innerText(), RAW);
    // M: removal needs an in-panel confirmation and clears everything
    await drawer.locator('[data-act="ask-remove"]').click();
    assert.match(await drawer.innerText(), /Remove this server and turn off all of its tools\?/);
    await drawer.locator('[data-act="cancel-confirm"]').click();
    assert.equal(JSON.parse((await api(page, '/api/v1/mcp/servers')).text).total, 1);
    await drawer.locator('[data-act="ask-remove"]').click();
    await drawer.locator('[data-act="confirm-remove"]').click();
    await layer(page).waitFor({ state: 'detached', timeout: 10000 });
    assert.equal(await mine(page).count(), 0);
    assert.equal(JSON.parse((await api(page, '/api/v1/mcp/servers')).text).total, 0);
    assert.equal(state.calls.filter((c) => c.method === 'tools/call').length, 0);
    await ctx.close();
  });

  it('server-supplied HTML is inert text; search finds MCP servers and tool names', async () => {
    const { ctx, page } = await open('cx_xss');
    await settled(page);
    state.tools = [HOSTILE];
    await addServer(page, '<b>bold</b> & "quotes"');
    await layer(page).locator('#nagex-layer-title', { hasText: 'Server verified' }).waitFor({ timeout: 20000 });
    const text = await layer(page).innerText();
    assert.match(text, /<b>bold<\/b> & "quotes"/);
    assert.match(text, /<img src=x onerror=/);
    assert.equal(await page.locator('#nagex-conn-layer img, #nagex-conn-layer script, #nagex-conn-layer b').count(), 0);
    assert.equal(await page.evaluate(() => (window as any).__xss), undefined);
    await layer(page).locator('[data-act="close-layer"]').last().click();
    await page.locator('#nagex-conn-search').fill('html_tool');
    assert.equal(await mine(page).count(), 1, 'a tool name finds its server');
    await ctx.close();
  });

  it('N/O. another user or tenant never sees or changes these servers; approval is the only way to a tool', async () => {
    const owner = await open('cx_owner');
    await settled(owner.page);
    await addServer(owner.page, 'Private Server');
    await owner.page.locator('#nagex-conn-layer #nagex-layer-title', { hasText: 'Server verified' }).waitFor({ timeout: 20000 });
    await owner.page.locator('[data-act="tool-toggle"][data-tool="search_docs"]').click();
    await owner.page.locator('[data-act="tool-confirm"]').click();
    await owner.page.waitForFunction(() => document.querySelector('#nagex-conn-layer [data-tool="search_docs"][role="switch"]')?.getAttribute('aria-checked') === 'true');
    const id = JSON.parse((await api(owner.page, '/api/v1/mcp/servers')).text).servers[0].connectionId;
    // enabling a tool only yields a pending approval when invoked; nothing executes
    const invoke = await api(owner.page, `/api/v1/mcp/servers/${id}/tools/search_docs/invoke`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ arguments: { query: 'billing' } }) });
    assert.equal(invoke.status, 202);
    assert.equal(JSON.parse(invoke.text).status, 'APPROVAL_REQUIRED');
    assert.equal(state.calls.filter((c) => c.method === 'tools/call').length, 0);

    const other = await open('cx_other');
    await settled(other.page);
    assert.equal(await mine(other.page).count(), 0);
    assert.doesNotMatch(await other.page.locator('#nagex-connections').innerText(), /Private Server/);
    for (const [method, path, body] of [['GET', `/api/v1/mcp/servers/${id}`, undefined], ['DELETE', `/api/v1/mcp/servers/${id}`, undefined], ['POST', `/api/v1/mcp/servers/${id}/refresh`, '{}'], ['POST', `/api/v1/mcp/servers/${id}/tools/search_docs`, '{"enabled":false}'], ['POST', `/api/v1/mcp/servers/${id}/tools/search_docs/invoke`, '{"arguments":{"query":"x"}}']] as const) {
      assert.equal((await api(other.page, path, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body } : {}) })).status, 404, `${method} ${path}`);
    }
    // the search box only ever covers the caller's own data
    await other.page.locator('#nagex-conn-search').fill('Private');
    assert.equal(await other.page.locator('.nagex-conn-card').count(), 0);
    assert.equal(JSON.parse((await api(owner.page, '/api/v1/mcp/servers')).text).total, 1);
    await owner.ctx.close();
    await other.ctx.close();
  });

  it('503 and 401 from the MCP API are truthful: Explore shows it is unavailable, never a usable form', async () => {
    const { ctx, page } = await open('cx_mcp_unavailable');
    await page.route('**/api/v1/mcp/servers', (route) => (route.request().method() === 'GET' ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'MCP_NOT_AVAILABLE', message: 'x' } }) }) : route.fallback()));
    await page.evaluate(async () => { await new Promise((r) => setTimeout(r, 5200)); (window as any).NAGEX_CONNECTIONS_UI.mount({ signedOut: false }); });
    await page.waitForFunction(() => /not available on this server/.test(document.querySelector('.nagex-conn-explore')?.textContent || ''), undefined, { timeout: 10000 });
    assert.equal(await page.locator('#nagex-conn-add').count(), 0);
    assert.equal(await page.locator('input[name="url"]').count(), 0);
    await ctx.close();
  });
});

describe('Localization, responsiveness and accessibility', () => {
  it('P. KR/EN switch live without a refresh (cards, status, drawer); user content is not translated; no raw keys', async () => {
    const { ctx, page } = await open('cx_i18n', 'en', undefined, connectGitHub);
    await settled(page);
    await addServer(page, 'My Docs Server');
    await layer(page).locator('#nagex-layer-title', { hasText: 'Server verified' }).waitFor({ timeout: 20000 });
    await layer(page).locator('[data-act="close-layer"]').last().click();
    await page.evaluate(() => (window as any).NAGEX_I18N.setLocale('ko'));
    await page.waitForFunction(() => /내 연결/.test(document.querySelector('#nagex-connections')?.textContent || ''), undefined, { timeout: 5000 });
    let text = await page.locator('#nagex-connections').innerText();
    for (const expected of [/내 연결/, /기본 앱/, /탐색 및 추가/, /연결됨/, /곧 제공 예정/, /\+ 사용자 지정 MCP 서버 추가/, /저장소를 둘러보고 파일을 읽어요/, /메일을 검색하고 답장 초안을 만들어요/, /더 많은 앱/]) assert.match(text, expected);
    assert.match(text, /My Docs Server/, 'a user-provided server name is not translated');
    assert.match(text, /Docs MCP/, 'the server-advertised identity is not translated');
    assert.equal(await page.locator('#nagex-conn-search').getAttribute('placeholder'), '앱과 도구 검색');
    assert.match(await page.locator('#cat-panel-connections').innerText(), /앱 및 연결/);
    assert.doesNotMatch(text, RAW);
    // an open drawer re-renders live too
    await mine(page).filter({ hasText: 'GitHub' }).locator('button').click();
    await layer(page).waitFor({ state: 'visible' });
    assert.match(await layer(page).innerText(), /읽기 전용/);
    await page.evaluate(() => (window as any).NAGEX_I18N.setLocale('en'));
    await page.waitForFunction(() => /Read-only/.test(document.querySelector('#nagex-conn-layer')?.textContent || ''), undefined, { timeout: 5000 });
    await page.keyboard.press('Escape');
    text = await page.locator('#nagex-connections').innerText();
    assert.match(text, /My connections/);
    assert.doesNotMatch(text, /내 연결/);
    await ctx.close();
  });

  it('Korean: modal, review, drawer and errors are localized', async () => {
    const { ctx, page } = await open('cx_ko', 'ko', undefined, connectGitHub);
    await settled(page);
    await page.locator('#nagex-conn-add').click();
    let text = await layer(page).innerText();
    for (const expected of [/사용자 지정 MCP 서버 추가/, /서버 이름/, /HTTPS 서버 주소/, /Bearer 자격 증명/, /취소/]) assert.match(text, expected);
    await layer(page).locator('button[type="submit"]').click();
    assert.match(await layer(page).locator('#nagex-mcp-err').innerText(), /서버 이름을 입력해 주세요/);
    await layer(page).locator('input[name="name"]').fill('문서 서버');
    await layer(page).locator('input[name="url"]').fill(PUBLIC_URL);
    await layer(page).locator('button[type="submit"]').click();
    await layer(page).locator('#nagex-layer-title', { hasText: '서버 확인 완료' }).waitFor({ timeout: 20000 });
    await layer(page).locator('[data-act="tool-toggle"][data-tool="search_docs"]').click();
    assert.match(await layer(page).locator('.nagex-conn-confirm').innerText(), /사용할 때마다 승인이 필요해요/);
    await layer(page).locator('[data-act="tool-confirm"]').click();
    await page.waitForFunction(() => document.querySelector('#nagex-conn-layer [data-tool="search_docs"][role="switch"]')?.getAttribute('aria-checked') === 'true');
    assert.match(await layer(page).innerText(), /켜짐/);
    state.name = 'Imposter';
    await layer(page).locator('[data-act="close-layer"]').last().click();
    await mine(page).filter({ hasText: '문서 서버' }).locator('button').click();
    await page.locator('#nagex-conn-layer [data-act="mcp-refresh"]').click();
    await page.locator('#nagex-conn-layer .nagex-conn-alert').waitFor({ timeout: 15000 });
    text = await layer(page).innerText();
    assert.match(text, /더 이상 연결했던 서버로 확인되지 않아/);
    assert.doesNotMatch(text, RAW);
    await ctx.close();
  });

  it('Q. no clipping, overlap or horizontal overflow at 1440/1680/1920 and narrower widths; cards stay compact', async () => {
    for (const [width, height] of [[1440, 900], [1680, 900], [1920, 1080], [1024, 768], [768, 1024]] as const) {
      const { ctx, page } = await open(`cx_resp_${width}`, 'en', { width, height }, (user) => { connectGitHub(user); connectGoogle(user); });
      await settled(page);
      await page.waitForFunction(() => document.querySelectorAll('.nagex-conn-card.mine').length >= 2, undefined, { timeout: 15000 });
      const info = await page.evaluate(() => {
        const cards = [...document.querySelectorAll('#nagex-connections .nagex-conn-card')] as any[];
        const rects = cards.map((el) => el.getBoundingClientRect());
        let overlaps = 0;
        for (let i = 0; i < rects.length; i += 1) for (let j = i + 1; j < rects.length; j += 1) {
          const a = rects[i]; const b = rects[j];
          if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) overlaps += 1;
        }
        return {
          overflowX: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
          clipped: cards.filter((el) => el.scrollWidth > el.clientWidth + 1).length,
          overlaps,
          maxCardHeight: Math.max(...rects.map((r) => r.height)),
          minCardWidth: Math.min(...rects.map((r) => r.width)),
          cardCount: cards.length,
        };
      });
      assert.equal(await page.evaluate(() => { const input = document.getElementById('nagex-conn-search') as any; input.scrollIntoView({ block: 'center' }); const r = input.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return hit === input; }), true, `the search field is not hidden behind the fixed header @${width}`);
      assert.equal(info.overflowX, 0, `no horizontal overflow @${width}`);
      assert.equal(info.clipped, 0, `no clipped card @${width}`);
      assert.equal(info.overlaps, 0, `no overlap @${width}`);
      assert.ok(info.maxCardHeight <= 230, `compact cards @${width} (${info.maxCardHeight}px)`);
      assert.ok(info.minCardWidth >= 180, `card width @${width}`);
      // the modal and drawer fit the viewport
      await page.locator('#nagex-conn-add').click();
      const panel = await layer(page).locator('.nagex-conn-panel').boundingBox();
      assert.ok(panel && panel.x >= 0 && panel.y >= 0 && panel.x + panel.width <= width + 1 && panel.y + panel.height <= height + 1, `modal fits @${width}`);
      await page.keyboard.press('Escape');
      await mine(page).first().locator('button').click();
      const drawerBox = await layer(page).locator('.nagex-conn-panel').boundingBox();
      assert.ok(drawerBox && drawerBox.x + drawerBox.width <= width + 1 && drawerBox.height <= height + 1, `drawer fits @${width}`);
      await page.keyboard.press('Escape');
      await ctx.close();
    }
  });

  it('accessibility: labelled landmarks, accessible status, switches expose state, buttons name their app, no unlabeled controls', async () => {
    const { ctx, page } = await open('cx_a11y', 'en', undefined, (user) => { connectGitHub(user); });
    await settled(page);
    await addServer(page, 'A11y');
    await layer(page).locator('#nagex-layer-title', { hasText: 'Server verified' }).waitFor({ timeout: 20000 });
    const switches = await layer(page).locator('[role="switch"]').evaluateAll((els: any[]) => els.map((el) => [el.getAttribute('aria-checked'), el.getAttribute('aria-label')]));
    assert.deepEqual(switches, [['false', 'Turn on search_docs'], ['false', 'Turn on create_ticket']]);
    await layer(page).locator('[data-act="close-layer"]').last().click();
    assert.equal(await page.locator('#nagex-conn-live').getAttribute('aria-live'), 'polite');
    const unlabeled = await page.evaluate(() => [...document.querySelectorAll('#nagex-connections button, #nagex-connections input')].filter((el: any) => !(el.getAttribute('aria-label') || el.textContent.trim() || el.getAttribute('placeholder') || (el.labels && el.labels.length))).length);
    assert.equal(unlabeled, 0);
    assert.equal(await card(page, 'github').locator('button').getAttribute('aria-label'), 'Manage GitHub');
    assert.equal(await card(page, 'gmail').locator('button').getAttribute('aria-label'), 'Connect Gmail');
    assert.equal(await page.locator('.nagex-conn-section').evaluateAll((els: any[]) => els.every((el) => document.getElementById(el.getAttribute('aria-labelledby'))?.textContent?.trim())), true);
    assert.equal(await page.locator('.nagex-conn-card').evaluateAll((els: any[]) => els.every((el) => document.getElementById(el.getAttribute('aria-labelledby'))?.textContent?.trim())), true);
    assert.equal(await page.locator('.nagex-conn-icon').evaluateAll((els: any[]) => els.every((el) => el.getAttribute('aria-hidden') === 'true')), true, 'decorative icons are hidden from assistive tech');
    // filters expose pressed state; keyboard operation of a chip
    await page.locator('.nagex-conn-filters [data-filter="CONNECTED"]').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.nagex-conn-filters [data-filter="CONNECTED"]').getAttribute('aria-pressed'), 'true');
    await ctx.close();
  });

  it('the Settings category tab, refresh and back/forward keep the connections page working', async () => {
    const { ctx, page, errors } = await open('cx_route', 'en', undefined, connectGitHub);
    await settled(page);
    await page.reload();
    await page.waitForSelector('#nagex-connections .nagex-conn-card', { timeout: 15000 });
    assert.equal(await page.evaluate(() => location.hash), '#settings/connections');
    await page.locator('[role="tab"][data-cat="devices"]:visible').first().click();
    await page.locator('[role="tab"][data-cat="connections"]:visible').first().click();
    await page.waitForSelector('#nagex-connections .nagex-conn-card', { timeout: 15000 });
    assert.equal(await page.locator('#nagex-connections').count(), 1, 'mounted exactly once');
    assert.deepEqual(errors, []);
    await ctx.close();
  });
});

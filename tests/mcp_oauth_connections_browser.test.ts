import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright';
import { startCanvasAskHarness, type CanvasAskHarness } from './_canvas_ask_harness.js';

declare const window: any;
declare const document: any;
declare const localStorage: any;

// Provider sign-in cards in Apps & Connections, in real Chromium against the production server harness. The provider list and the connection list are
// SUBSTITUTED (route stubs) so each availability / connection state can be shown; the real route behavior (start, callback, verification, approvals) is covered by
// mcp_oauth_slack_flow_e2e. No real provider is contacted: navigation to the provider's sign-in page is intercepted. Screenshots only when NAGEX_CAPTURE_DIR is set.

let h: CanvasAskHarness;
before(async () => { h = await startCanvasAskHarness({ scrubProviders: true }); });
after(async () => { await h?.close(); });

const RAW = /\b(?:conn\.[A-Za-z]+(?:\.[A-Za-z]+)*|SETUP_REQUIRED|REAUTH_REQUIRED|NOT_CONNECTED|MCP_[A-Z_]+|UNAUTHORIZED|UNAVAILABLE|OAUTH_[A-Z_]+)\b/;
const PROVIDER_URL = 'https://slack-signin.example.test/authorize?state=abc';

type ProviderState = 'AVAILABLE' | 'DISABLED' | 'SETUP_REQUIRED' | 'UNAVAILABLE';
const provider = (state: ProviderState) => ({ id: 'slack', displayName: 'Slack workspace', state, missing: state === 'SETUP_REQUIRED' ? ['CLIENT_SECRET'] : [], reason: state === 'UNAVAILABLE' ? 'MCP_OAUTH_METADATA_REJECTED:RESOURCE_MISMATCH' : null, scopes: ['search:read.public'] });
const tool = (name: string, enabled = false) => ({ name, description: `${name} tool`, inputSchema: { type: 'object', properties: {} }, schemaHash: 'a'.repeat(16), readOnlyHint: true, enabled, changedSinceEnabled: false, capabilityId: `mcp.mcp_0123456789abcdef.${name}` });
const server = (status: 'CONNECTED' | 'AUTH_REQUIRED', reason: string | null = null) => ({
  connectionId: 'mcp_0123456789abcdef', name: 'Slack workspace', url: 'https://mcp.slack.com/mcp', status, reason,
  identity: { origin: 'https://mcp.slack.com', serverName: 'Slack MCP', serverVersion: '1.0', protocolVersion: '2025-06-18', pinnedAt: '2026-10-13T00:00:00Z' },
  tools: [tool('search_messages'), tool('read_channel')], rejectedTools: [], createdAt: '2026-10-13T00:00:00Z', discoveredAt: '2026-10-13T00:00:00Z', hasCredential: true, oauth: { providerId: 'slack', scopes: ['search:read.public'] },
});

interface Opened { ctx: BrowserContext; page: Page; errors: string[]; requests: Array<{ method: string; path: string; body: string }>; }
async function open(label: string, options: { locale?: 'en' | 'ko'; provider?: ProviderState | null; servers?: unknown[]; size?: { width: number; height: number }; query?: string } = {}): Promise<Opened> {
  const locale = options.locale ?? 'en';
  const user = h.user(label);
  if (locale === 'ko') h.setLocale(user, 'ko');
  const base = await h.newContext('desktop', user, locale);
  const ctx = await h.browser.newContext({ viewport: options.size ?? { width: 1440, height: 900 }, locale: locale === 'ko' ? 'ko-KR' : 'en-US' });
  await ctx.addCookies(await base.cookies());
  await ctx.addInitScript((l: string) => { try { localStorage.setItem('nagex_locale', l); } catch { /* storage unavailable */ } }, locale);
  await base.close();
  const requests: Opened['requests'] = [];
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('dialog', async (dialog) => { errors.push(`unexpected blocking dialog: ${dialog.message()}`); await dialog.dismiss(); });
  page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/v1/oauth/mcp') || u.pathname.startsWith('/api/v1/mcp/')) requests.push({ method: r.method(), path: u.pathname, body: r.postData() ?? '' }); });
  await page.route('**/api/v1/oauth/mcp/providers', (route) => route.fulfill({ status: 200, json: { providers: options.provider ? [provider(options.provider)] : [] } }));
  await page.route('**/api/v1/oauth/mcp/start', (route) => route.fulfill({ status: 200, json: { authorizeUrl: PROVIDER_URL } }));
  await page.route('**/api/v1/oauth/mcp/connect', (route) => route.fulfill({ status: 409, json: { status: 'OAUTH_CREDENTIAL_STORED', provider: 'slack', reason: 'MCP_DISCOVERY_FAILED' } }));
  await page.route('https://slack-signin.example.test/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>provider sign-in (stubbed)</p>' }));
  if (options.servers) await page.route('**/api/v1/mcp/servers', (route) => (route.request().method() === 'GET' ? route.fulfill({ status: 200, json: { servers: options.servers, total: options.servers!.length, durable: true } }) : route.continue()));
  // the substituted connection does not exist on the real server: its removal is substituted too
  await page.route('**/api/v1/mcp/servers/mcp_0123456789abcdef', (route) => (route.request().method() === 'DELETE' ? route.fulfill({ status: 200, json: { removed: true } }) : route.continue()));
  await page.goto(`${h.origin}/${options.query ?? ''}#settings/connections`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#nagex-connections .nagex-conn-card', { timeout: 15000 });
  return { ctx, page, errors, requests };
}
const card = (page: Page, id: string) => page.locator(`.nagex-conn-card[data-app="${id}"]`);
async function capture(page: Page, name: string): Promise<void> {
  const dir = process.env.NAGEX_CAPTURE_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true });
}

describe('provider sign-in cards (EN)', () => {
  it('an AVAILABLE provider shows a Connect button; it starts the sign-in with only the provider id and then goes to the provider', async () => {
    const { ctx, page, errors, requests } = await open('mcpoauth_available', { provider: 'AVAILABLE' });
    const slack = card(page, 'mcp-oauth:slack');
    assert.equal(await slack.count(), 1);
    assert.match(await slack.innerText(), /Sign in so NAgex can use its official tools for you/);
    assert.match(await slack.innerText(), /Every use asks for your approval first/);
    assert.equal(await slack.getAttribute('data-state'), 'NOT_CONNECTED');
    await slack.scrollIntoViewIfNeeded();
    await capture(page, 'mcp-oauth-available-en');
    await slack.locator('button[data-act="oauth-connect"]').click();
    await page.waitForURL(PROVIDER_URL);
    const start = requests.find((r) => r.method === 'POST' && r.path === '/api/v1/oauth/mcp/start')!;
    assert.deepEqual(JSON.parse(start.body), { providerId: 'slack' }, 'the browser sends nothing but the provider id');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  it('a provider the operator has not started to set up is not shown at all (default production state)', async () => {
    const { ctx, page, errors } = await open('mcpoauth_disabled', { provider: 'DISABLED' });
    await page.locator('details.nagex-conn-more > summary').click();
    assert.equal(await page.locator('.nagex-conn-card[data-app^="mcp-oauth:"]').count(), 0);
    assert.doesNotMatch(await page.locator('#nagex-connections').innerText(), /Slack workspace/);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  it('a provider that is set up but not available has NO Connect button and says why, in More apps', async () => {
    for (const [state, text] of [['SETUP_REQUIRED', /still has to finish setting this up/i], ['UNAVAILABLE', /could not be checked right now/i]] as const) {
      const { ctx, page, errors } = await open(`mcpoauth_${state.toLowerCase()}`, { provider: state });
      const slack = card(page, 'mcp-oauth:slack');
      await page.locator('details.nagex-conn-more > summary').click();
      assert.equal(await slack.count(), 1, state);
      assert.equal(await slack.locator('button[data-act="oauth-connect"]').count(), 0, `${state}: no Connect button`);
      assert.match(await slack.innerText(), text);
      assert.doesNotMatch(await slack.innerText(), RAW);
      if (state === 'SETUP_REQUIRED') await capture(page, 'mcp-oauth-setup-required-en');
      assert.deepEqual(errors, []);
      await ctx.close();
    }
  });

  it('with no provider list at all, nothing is invented', async () => {
    const { ctx, page } = await open('mcpoauth_none', { provider: null });
    assert.equal(await page.locator('.nagex-conn-card[data-app^="mcp-oauth:"]').count(), 0);
    await ctx.close();
  });
});

describe('a connected provider', () => {
  it('is a connection (not a second card), tools are OFF, and Disconnect asks first and then deletes the connection', async () => {
    const { ctx, page, errors, requests } = await open('mcpoauth_connected', { provider: 'AVAILABLE', servers: [server('CONNECTED')] });
    assert.equal(await card(page, 'mcp-oauth:slack').count(), 0, 'once connected the provider is no longer offered as a new app');
    const mine = page.locator('.nagex-conn-card.mine[data-kind="mcp"]');
    assert.equal(await mine.count(), 1);
    assert.equal(await mine.getAttribute('data-state'), 'CONNECTED');
    await capture(page, 'mcp-oauth-connected-en');
    await mine.locator('button[data-act="manage-item"]').click();
    const layer = page.locator('#nagex-conn-layer');
    await layer.waitFor();
    assert.equal(await layer.locator('input[type="checkbox"]:checked').count(), 0, 'every tool is off');
    assert.equal(await layer.locator('button[data-act="ask-remove"]').innerText(), 'Disconnect');
    await layer.locator('button[data-act="ask-remove"]').click();
    assert.match(await layer.locator('.nagex-conn-confirm').innerText(), /deletes the saved sign-in from this server/);
    assert.equal(requests.some((r) => r.method === 'DELETE'), false, 'nothing is deleted before the confirmation');
    await capture(page, 'mcp-oauth-disconnect-confirm-en');
    await layer.locator('button[data-act="confirm-remove"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.nagex-conn-card.mine[data-kind="mcp"]').length === 0);
    assert.ok(requests.some((r) => r.method === 'DELETE' && r.path === '/api/v1/mcp/servers/mcp_0123456789abcdef'));
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  it('an expired sign-in shows "Sign in again" (no pasted-token form) and restarts the provider sign-in', async () => {
    const { ctx, page, requests } = await open('mcpoauth_reauth', { provider: 'AVAILABLE', servers: [server('AUTH_REQUIRED', 'OAUTH_TOKEN_EXPIRED')] });
    const mine = page.locator('.nagex-conn-card.mine[data-kind="mcp"]');
    assert.equal(await mine.getAttribute('data-state'), 'REAUTH_REQUIRED');
    await mine.locator('button[data-act="manage-item"]').click();
    const layer = page.locator('#nagex-conn-layer');
    await layer.waitFor();
    assert.match(await layer.innerText(), /Your sign-in has ended, so the tools are turned off/);
    assert.equal(await layer.locator('input[name="bearerToken"]').count(), 0, 'a provider connection never takes a pasted credential');
    await capture(page, 'mcp-oauth-reauth-en');
    await layer.locator('button[data-act="oauth-reauth"]').click();
    await page.waitForURL(PROVIDER_URL);
    assert.deepEqual(JSON.parse(requests.find((r) => r.path === '/api/v1/oauth/mcp/start')!.body), { providerId: 'slack' });
    await ctx.close();
  });
});

describe('returning from the provider', () => {
  it('shows what actually happened - connected, stored-but-not-verified (with Retry), or failed - and removes the status from the address bar', async () => {
    for (const status of ['connected', 'stored', 'failed'] as const) {
      const { ctx, page, errors } = await open(`mcpoauth_return_${status}`, { provider: 'AVAILABLE', servers: status === 'connected' ? [server('CONNECTED')] : [], query: `?mcp_oauth=${status}&provider=slack&reason=MCP_DISCOVERY_FAILED` });
      const notice = page.locator(`[data-oauth-notice="${status}"]`);
      await notice.waitFor();
      const text = await notice.innerText();
      if (status === 'connected') assert.match(text, /Slack workspace is connected\. Its tools are off until you turn them on/);
      if (status === 'stored') { assert.match(text, /could not reach its tools yet\. Nothing is connected until that works/); assert.equal(await notice.locator('button[data-act="oauth-retry"]').count(), 1); }
      if (status === 'failed') assert.match(text, /not completed\. Nothing was connected/);
      assert.doesNotMatch(text, RAW);
      assert.equal(new URL(page.url()).search, '', 'the status is not left in the address bar');
      await capture(page, `mcp-oauth-return-${status}-en`);
      assert.deepEqual(errors, []);
      await ctx.close();
    }
  });

  it('Retry on a stored-but-unverified sign-in asks the server again and reports the truthful result', async () => {
    const { ctx, page, requests } = await open('mcpoauth_retry', { provider: 'AVAILABLE', servers: [], query: '?mcp_oauth=stored&provider=slack' });
    await page.locator('[data-oauth-notice="stored"] button[data-act="oauth-retry"]').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-oauth-notice="stored"]').length === 1);
    assert.deepEqual(JSON.parse(requests.find((r) => r.path === '/api/v1/oauth/mcp/connect')!.body), { providerId: 'slack' });
    assert.equal(await page.locator('[data-oauth-notice="connected"]').count(), 0, 'a 409 is never shown as connected');
    await ctx.close();
  });

  it('an unrecognized status or provider is treated as a failure and never injected into the page', async () => {
    const { ctx, page } = await open('mcpoauth_hostile', { provider: 'AVAILABLE', query: `?mcp_oauth=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E&provider=%3Cscript%3E` });
    assert.equal(await page.locator('[data-oauth-notice="failed"]').count(), 1);
    assert.equal(await page.locator('#nagex-connections img, #nagex-connections script').count(), 0);
    await ctx.close();
  });
});

describe('Korean and phone width', () => {
  it('KR copy is natural 해요체 with no raw keys, in every state', async () => {
    const { ctx, page, errors } = await open('mcpoauth_ko', { locale: 'ko', provider: 'AVAILABLE', query: '?mcp_oauth=stored&provider=slack' });
    const slack = card(page, 'mcp-oauth:slack');
    const text = await slack.innerText() + await page.locator('[data-oauth-notice]').innerText();
    assert.match(text, /로그인하면 NAgex가 공식 도구를 대신 사용할 수 있어요/);
    assert.match(text, /Slack 워크스페이스/, 'the provider name is localized');
    assert.doesNotMatch(text, /Slack workspace/);
    assert.match(text, /연결이 확인되기 전까지는 연결된 것이 아니에요/);
    assert.doesNotMatch(text, RAW);
    assert.doesNotMatch(text, /(습니다|입니다)\./);
    await slack.scrollIntoViewIfNeeded();
    await capture(page, 'mcp-oauth-available-ko');
    assert.deepEqual(errors, []);
    await ctx.close();
    const reauth = await open('mcpoauth_ko_reauth', { locale: 'ko', provider: 'AVAILABLE', servers: [server('AUTH_REQUIRED', 'OAUTH_TOKEN_EXPIRED')] });
    await reauth.page.locator('.nagex-conn-card.mine[data-kind="mcp"] button[data-act="manage-item"]').click();
    const layerText = await reauth.page.locator('#nagex-conn-layer').innerText();
    assert.match(layerText, /로그인이 만료되어 도구가 꺼졌어요/);
    assert.match(layerText, /다시 로그인/);
    assert.doesNotMatch(layerText, RAW);
    assert.doesNotMatch(layerText, /(습니다|입니다)\./);
    await capture(reauth.page, 'mcp-oauth-reauth-ko');
    await reauth.ctx.close();
  });

  it('at 360 / 390 / 430 px nothing overflows horizontally and Connect stays reachable', async () => {
    for (const width of [360, 390, 430]) {
      const { ctx, page } = await open(`mcpoauth_w${width}`, { provider: 'AVAILABLE', size: { width, height: 800 } });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 0, `no horizontal scroll at ${width}px (overflow ${overflow})`);
      const button = card(page, 'mcp-oauth:slack').locator('button[data-act="oauth-connect"]');
      await button.scrollIntoViewIfNeeded();
      const box = await button.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= width, `Connect fits inside the viewport at ${width}px`);
      if (width === 390) await capture(page, 'mcp-oauth-available-390');
      await ctx.close();
    }
  });
});

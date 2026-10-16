import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright';
import { startCanvasAskHarness, type CanvasAskHarness } from './_canvas_ask_harness.js';
import { clearGitHubOAuthStatesForTesting } from '../src/integrations/github/oauth-state.store.js';

declare const window: any;
declare const document: any;
declare const localStorage: any;
declare const sessionStorage: any;

// The server connector catalog in real Chromium: "More apps" (not available / not supported) with stated requirements, the category filter,
// the chat-account link dialog, MCP credential expiry -> reconnect, and the durability notice - EN and KR, desktop and phone width. The remote
// parties are substitutes (the catalog response is rewritten to simulate a configured Slack; the MCP server is the isolated test server); every
// other piece is the production server harness. Screenshots are written only when NAGEX_CAPTURE_DIR is set (evidence runs), never in a normal run.

let h: CanvasAskHarness;
let testServer: { url: string; setToken(token: string): void; close(): Promise<void> };
const envBackup = process.env.NAGEX_MCP_ALLOW_PRIVATE_NETWORK;
const RAW = /\b(?:conn\.[A-Za-z]+(?:\.[A-Za-z]+)*|SETUP_REQUIRED|REAUTH_REQUIRED|NOT_CONNECTED|NOT_SUPPORTED|COMING_LATER|MCP_[A-Z_]+|UNAUTHORIZED|UNSUPPORTED|UNAVAILABLE)\b/;

before(async () => {
  process.env.NAGEX_MCP_ALLOW_PRIVATE_NETWORK = '1';
  h = await startCanvasAskHarness({ scrubProviders: true });
  const mod = await import(pathToFileURL(path.resolve('scripts/mcp-test-server.mjs')).href);
  testServer = await mod.startMcpTestServer({ token: 'ui-token' });
});
after(async () => {
  await testServer?.close();
  if (envBackup === undefined) delete process.env.NAGEX_MCP_ALLOW_PRIVATE_NETWORK; else process.env.NAGEX_MCP_ALLOW_PRIVATE_NETWORK = envBackup;
  await h?.close();
});
beforeEach(() => { testServer.setToken('ui-token'); });
afterEach(() => { clearGitHubOAuthStatesForTesting(); });

type User = ReturnType<CanvasAskHarness['user']>;

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

async function open(label: string, locale: 'en' | 'ko' = 'en', size = { width: 1440, height: 900 }, tweakCatalog?: (body: any) => any): Promise<{ ctx: BrowserContext; page: Page; errors: string[]; user: User }> {
  const user = h.user(label);
  if (locale === 'ko') h.setLocale(user, 'ko');
  const base = await h.newContext('desktop', user, locale);
  const ctx = await h.browser.newContext({ viewport: size, locale: locale === 'ko' ? 'ko-KR' : 'en-US' });
  await ctx.addCookies(await base.cookies());
  await ctx.addInitScript((l: string) => { try { localStorage.setItem('nagex_locale', l); } catch { /* storage unavailable */ } }, locale);
  await base.close();
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('dialog', async (dialog) => { errors.push(`unexpected blocking dialog: ${dialog.message()}`); await dialog.dismiss(); });
  if (tweakCatalog) {
    await page.route('**/api/v1/connectors/catalog', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({ response, json: tweakCatalog(body) });
    });
  }
  await page.goto(`${h.origin}/#settings/connections`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#nagex-connections .nagex-conn-card', { timeout: 15000 }).catch((error) => explainOpenTimeout(page, error));
  return { ctx, page, errors, user };
}
const card = (page: Page, app: string) => page.locator(`.nagex-conn-card[data-app="${app}"]`);
const layer = (page: Page) => page.locator('#nagex-conn-layer');
async function capture(page: Page, name: string): Promise<void> {
  const dir = process.env.NAGEX_CAPTURE_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true });
}
const withSlackConfigured = (state: 'NOT_CONNECTED' | 'CONNECTED') => (body: any) => {
  const slack = body.connectors.find((entry: any) => entry.id === 'slack');
  slack.connection = state === 'CONNECTED' ? { state: 'CONNECTED', reason: null, account: 'Acme', count: 1 } : { state: 'NOT_CONNECTED', reason: null, account: null, count: 0 };
  // A provider-ready simulated connection must also return the server's explicit
  // action projection, not just rewrite a badge into NOT_CONNECTED.
  slack.action = state === 'CONNECTED'
    ? { kind: 'NONE', reason: 'ALREADY_CONNECTED' }
    : { kind: 'CHANNEL_LINK', provider: 'slack', startPath: '/api/v1/integrations/slack/identity/link/challenge' };
  return body;
};

describe('More apps: honest availability', () => {
  it('EN: the not-available apps sit under a collapsed "More apps" group, each with its status and requirement and no button; nothing is shown connected', async () => {
    const { ctx, page, errors } = await open('cat_more_en');
    const more = page.locator('details.nagex-conn-more');
    assert.equal(await more.count(), 1);
    assert.equal(await more.evaluate((el: any) => el.open), false, 'collapsed by default');
    assert.match(await page.locator('#nagex-sec-more').innerText(), /More apps\s*9/);
    await page.locator('#nagex-sec-more').click();
    const names = await more.locator('.nagex-conn-card h4').allInnerTexts();
    assert.deepEqual(names.sort(), ['Ahrefs', 'Brand24', 'CoinGecko', 'Microsoft Teams', 'Morningstar', 'Similarweb', 'World Bank data', 'X (Twitter)', 'Zoom'].sort());
    assert.equal(await more.locator('.nagex-conn-card button').count(), 0, 'no button without behavior');
    assert.equal(await more.locator('.nagex-conn-badge[data-state="CONNECTED"]').count(), 0);
    assert.equal(await card(page, 'x').getAttribute('data-state'), 'UNSUPPORTED');
    assert.match(await card(page, 'x').innerText(), /Not supported[\s\S]*paid developer plan/);
    assert.equal(await card(page, 'zoom').getAttribute('data-state'), 'UNAVAILABLE');
    assert.match(await card(page, 'zoom').innerText(), /Coming later[\s\S]*Not available yet/);
    assert.deepEqual(await more.locator('h4.nagex-conn-subtitle').allInnerTexts(), ['Communication', 'Data & research']);
    assert.doesNotMatch(await page.locator('#nagex-connections').innerText(), RAW, 'no raw keys or codes');
    await capture(page, 'connections-en-desktop-more-open');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  it('KR: the same group is natural Korean with no raw keys or untranslated catalog copy', async () => {
    const { ctx, page, errors } = await open('cat_more_ko', 'ko');
    await page.locator('#nagex-sec-more').click();
    const text = await page.locator('#nagex-connections').innerText();
    assert.match(text, /더 많은 앱/);
    assert.match(text, /지원하지 않음/);
    assert.match(text, /곧 제공 예정/);
    assert.match(await card(page, 'x').innerText(), /X는 유료 개발자 플랜/);
    assert.doesNotMatch(text, /(습니다|입니다)\./, 'the catalog copy follows the 해요체 register');
    assert.match(await card(page, 'slack').innerText(), /Slack에서 NAgex와 대화하고 알림을 받아요/);
    assert.doesNotMatch(text, RAW);
    assert.doesNotMatch(await page.locator('details.nagex-conn-more').innerText(), /Not available yet|Not supported|Coming later/);
    await capture(page, 'connections-ko-desktop-more-open');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  it('the category filter narrows built-in apps and More apps together, in EN and KR', async () => {
    const { ctx, page } = await open('cat_filter');
    const category = page.locator('#nagex-conn-category');
    await category.selectOption('DEVELOPER');
    assert.deepEqual(await page.locator('section[aria-labelledby="nagex-sec-builtin"] .nagex-conn-card h4').allInnerTexts(), ['GitHub']);
    assert.equal(await page.locator('details.nagex-conn-more').count(), 0, 'nothing not-available matches Developer');
    await category.selectOption('DATA');
    assert.match(await page.locator('section[aria-labelledby="nagex-sec-builtin"]').innerText(), /Nothing matches/);
    assert.equal(await page.locator('details.nagex-conn-more').evaluate((el: any) => el.open), true, 'More apps opens while filtering');
    assert.deepEqual((await page.locator('details.nagex-conn-more .nagex-conn-card h4').allInnerTexts()).sort(), ['Ahrefs', 'Brand24', 'CoinGecko', 'Morningstar', 'Similarweb', 'World Bank data', 'X (Twitter)']);
    await category.selectOption('ALL');
    assert.equal((await page.locator('.nagex-conn-card:not(.mine)').count()), 17, 'all catalog apps except the custom-server entry are listed');
    await page.evaluate(() => (window as any).NAGEX_I18N.setLocale('ko'));
    await page.waitForFunction(() => document.querySelector('#nagex-conn-category option[value="DATA"]')?.textContent === '데이터 및 리서치');
    assert.equal(await category.inputValue(), 'ALL');
    await ctx.close();
  });
});

describe('connect actions are server-authorized', () => {
  it('never shows a link button if the catalog lacks an approved action even when connection state says NOT_CONNECTED', async () => {
    const { ctx, page } = await open('cat_no_dead_link', 'en', { width: 1440, height: 900 }, (body: any) => {
      const slack = body.connectors.find((entry: any) => entry.id === 'slack');
      slack.connection = { state: 'NOT_CONNECTED', reason: null, account: null, count: 0 };
      slack.action = { kind: 'NONE', reason: 'NOT_CONFIGURED_ON_SERVER' };
      return body;
    });
    assert.equal(await card(page, 'slack').getAttribute('data-state'), 'NOT_CONNECTED');
    assert.equal(await card(page, 'slack').locator('button[data-act="link-channel"]').count(), 0);
    await ctx.close();
  });
});

describe('chat accounts (Slack / Telegram)', () => {
  it('a server without the app configured shows "Setup required" with the requirement and no button', async () => {
    const { ctx, page } = await open('cat_chan_setup');
    for (const app of ['slack', 'telegram']) {
      assert.equal(await card(page, app).getAttribute('data-state'), 'SETUP_REQUIRED', app);
      assert.equal(await card(page, app).locator('button').count(), 0, `${app} has no dead button`);
      assert.match(await card(page, app).innerText(), /Needs the NAgex/);
    }
    assert.equal(await page.locator('.nagex-conn-card.mine[data-kind="channel"]').count(), 0);
    await ctx.close();
  });

  it('link flow: shows the one-time command, keeps the user in control, and only a real CONNECTED state closes it and lists the account', async () => {
    let linked = false;
    const { ctx, page, errors } = await open('cat_chan_link', 'en', { width: 1440, height: 900 }, (body) => withSlackConfigured(linked ? 'CONNECTED' : 'NOT_CONNECTED')(body));
    await page.route('**/api/v1/integrations/slack/identity/link/challenge', (route) => route.fulfill({ status: 201, contentType: 'application/json', json: { integration: 'slack', challenge: 'abc123', expiresAt: '2026-10-13T12:00:00.000Z', ttlSeconds: 600, instructions: { command: 'link abc123', note: 'x' } } }));
    assert.equal(await card(page, 'slack').getAttribute('data-state'), 'NOT_CONNECTED');
    await card(page, 'slack').locator('button[data-act="link-channel"]').click();
    await layer(page).locator('.nagex-conn-code').waitFor();
    assert.equal(await layer(page).locator('.nagex-conn-code').innerText(), 'link abc123');
    assert.match(await layer(page).innerText(), /Link your Slack account[\s\S]*Open Slack[\s\S]*Send exactly this message[\s\S]*expires/);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-act')), 'check-link', 'focus lands on the primary action');
    // not linked yet: checking says so and keeps the dialog open
    await layer(page).locator('button[data-act="check-link"]').click();
    await layer(page).locator('.nagex-conn-success').filter({ hasText: 'Not linked yet' }).waitFor();
    assert.equal(await layer(page).count(), 1);
    await capture(page, 'connections-en-desktop-link-dialog');
    // the user sends the message in Slack; the server now reports the link
    linked = true;
    await layer(page).locator('button[data-act="check-link"]').click();
    await layer(page).waitFor({ state: 'detached' });
    assert.equal(await card(page, 'slack').getAttribute('data-state'), 'CONNECTED');
    const mine = page.locator('.nagex-conn-card.mine[data-kind="channel"]');
    assert.equal(await mine.count(), 1);
    assert.match(await mine.innerText(), /Acme[\s\S]*Linked accounts: 1/);
    assert.equal(await mine.locator('button').count(), 0, 'a linked chat account has nothing to manage here');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  it('a failing challenge request is reported, not silently ignored; Escape closes the dialog and focus returns to the opener', async () => {
    const { ctx, page } = await open('cat_chan_fail', 'ko', { width: 1440, height: 900 }, withSlackConfigured('NOT_CONNECTED'));
    await page.route('**/api/v1/integrations/slack/identity/link/challenge', (route) => route.fulfill({ status: 500, contentType: 'application/json', json: { error: { code: 'X' } } }));
    const opener = card(page, 'slack').locator('button[data-act="link-channel"]');
    await opener.click();
    await layer(page).locator('.nagex-conn-error').filter({ hasText: '연결 코드를 만들지 못했어요' }).waitFor();
    await page.keyboard.press('Escape');
    await layer(page).waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-act')), 'link-channel');
    await ctx.close();
  });
});

describe('custom MCP servers: expiry, reconnect and durability', () => {
  it('a rejected credential shows "Needs attention", the tools are locked, and reconnecting with a new token restores the server', async () => {
    const { ctx, page, errors } = await open('cat_mcp_rot');
    const added = await page.evaluate(async (url: string) => {
      const res = await fetch('/api/v1/mcp/servers', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'UI Test Server', url, bearerToken: 'ui-token' }) });
      return { status: res.status, body: await res.json() };
    }, testServer.url);
    assert.equal(added.status, 201, JSON.stringify(added.body));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.nagex-conn-card.mine[data-kind="mcp"]');
    assert.match(await page.locator('.nagex-conn-note', { hasText: 'kept in memory' }).innerText(), /kept in memory on this server/, 'the in-memory notice is shown');

    testServer.setToken('rotated-token');
    await page.locator('.nagex-conn-card.mine[data-kind="mcp"] button[data-act="manage-item"]').click();
    await layer(page).locator('button[data-act="mcp-refresh"]').click();
    await layer(page).locator('.nagex-conn-error').filter({ hasText: 'rejected the credential' }).waitFor();
    // the server is now in the attention state with the reconnect form
    await page.waitForFunction(() => document.querySelector('#nagex-mcp-reconnect') !== null);
    assert.match(await layer(page).innerText(), /rejected the saved credential/);
    assert.equal(await page.locator('.nagex-conn-card.mine[data-kind="mcp"]').getAttribute('data-state'), 'REAUTH_REQUIRED');
    assert.equal(await layer(page).locator('.nagex-conn-switch[aria-checked="true"]').count(), 0);
    await capture(page, 'connections-en-desktop-mcp-reconnect');

    // a wrong token leaves it blocked and says why
    await layer(page).locator('input[name="bearerToken"]').fill('still-wrong');
    await layer(page).locator('#nagex-mcp-reconnect button[type="submit"]').click();
    await layer(page).locator('.nagex-conn-error').filter({ hasText: 'rejected the credential' }).waitFor();
    assert.equal(await page.locator('.nagex-conn-card.mine[data-kind="mcp"]').getAttribute('data-state'), 'REAUTH_REQUIRED');
    assert.equal(await layer(page).locator('input[name="bearerToken"]').inputValue(), '', 'the credential is cleared from the field at once');

    await layer(page).locator('input[name="bearerToken"]').fill('rotated-token');
    await layer(page).locator('#nagex-mcp-reconnect button[type="submit"]').click();
    await page.waitForFunction(() => !document.querySelector('#nagex-mcp-reconnect'));
    assert.equal(await page.locator('.nagex-conn-card.mine[data-kind="mcp"]').getAttribute('data-state'), 'CONNECTED');
    assert.match(await layer(page).innerText(), /Reconnected/);
    const dom = await page.content();
    assert.doesNotMatch(dom, /rotated-token|ui-token|still-wrong/, 'no credential ever reaches the DOM');
    assert.equal(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]).includes('rotated-token')), false);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
});

describe('phone width', () => {
  it('390px: no horizontal overflow with More apps open, in EN and KR', async () => {
    for (const locale of ['en', 'ko'] as const) {
      const { ctx, page } = await open(`cat_phone_${locale}`, locale, { width: 390, height: 844 });
      await page.locator('#nagex-sec-more').click();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= 390, `${locale}: no horizontal overflow`);
      await capture(page, `connections-${locale}-phone-more-open`);
      await ctx.close();
    }
  });
});

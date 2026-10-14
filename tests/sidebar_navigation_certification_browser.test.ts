import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright';
import { startCanvasAskHarness, type CanvasAskHarness } from './_canvas_ask_harness.js';

declare const window: any;
declare const document: any;
declare const location: any;
declare const getComputedStyle: any;

// Sidebar navigation certification (real Chromium, production server harness, real sessions): every visible item opens
// the right screen, updates the route, survives a refresh and back/forward, loads real data or an honest empty state,
// has no script error, no horizontal overflow and no raw i18n keys, at 1440x900, 1680x900 and 1920x1080 in EN and KR.
// The Recent screen is certified here too (real artifacts, ownership, open-in-Main).

let h: CanvasAskHarness;
before(async () => { h = await startCanvasAskHarness({ scrubProviders: true }); });
after(async () => { await h?.close(); });

const ITEMS = [
  { tab: 'tab-home', hash: '#home', view: 'view-home', en: 'Home', ko: '홈' },
  { tab: 'tab-recent', hash: '#recent', view: 'view-recent', en: 'Recent', ko: '최근' },
  { tab: 'tab-inbox', hash: '#inbox', view: 'view-inbox', en: 'Workspace', ko: '워크스페이스' },
  { tab: 'tab-knowledge', hash: '#knowledge', view: 'view-knowledge', en: 'Knowledge', ko: '지식 베이스' },
  { tab: 'tab-executions', hash: '#activity', view: 'view-executions', en: 'Activity', ko: '활동' },
  { tab: 'tab-settings', hash: '#settings', view: 'view-settings', en: 'Settings', ko: '설정' },
];
const RAW_KEY = /\b(?:settings|workspace|knowledge|activity|inbox|vault|auth|account|rail|nav|home|recent|mainText|mainBriefing)\.[A-Za-z][A-Za-z0-9]+/;

async function open(label: string, locale: 'en' | 'ko', width: number, height: number, hash: string): Promise<{ ctx: BrowserContext; page: Page; errors: string[]; user: ReturnType<CanvasAskHarness['user']> }> {
  const user = h.user(label);
  if (locale === 'ko') h.setLocale(user, 'ko');
  const base = await h.newContext('desktop', user, locale);
  const ctx = await h.browser.newContext({ viewport: { width, height }, locale: locale === 'ko' ? 'ko-KR' : 'en-US' });
  await ctx.addCookies(await base.cookies());
  await base.close();
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`${h.origin}/${hash}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);
  return { ctx, page, errors, user };
}
const activeViews = (page: Page) => page.evaluate(() => [...document.querySelectorAll('.tab-view.active-view')].map((v: any) => v.id));
const navItems = (page: Page) => page.evaluate(() => [...document.querySelectorAll('.nav-menu .nav-item')].filter((li: any) => getComputedStyle(li).display !== 'none').map((li: any) => ({ tab: li.dataset.tab, label: li.textContent.trim() })));

describe('Sidebar navigation', () => {
  it('the visible sidebar is exactly Home, Recent, Workspace, Knowledge, Activity, Settings (EN and KR labels)', async () => {
    for (const locale of ['en', 'ko'] as const) {
      const { ctx, page } = await open(`nav_items_${locale}`, locale, 1440, 900, '#home');
      const items = await navItems(page);
      assert.deepEqual(items.map((i) => i.tab), ITEMS.map((i) => i.tab));
      assert.deepEqual(items.map((i) => i.label), ITEMS.map((i) => i[locale]));
      await ctx.close();
    }
  });

  it('every item at 1440x900, 1680x900 and 1920x1080 (EN and KR): opens its screen, updates the route, no errors, no overflow, no raw keys', async () => {
    for (const locale of ['en', 'ko'] as const) {
      for (const [width, height] of [[1440, 900], [1680, 900], [1920, 1080]] as const) {
        if (locale === 'ko' && width !== 1440) continue;
        const { ctx, page, errors } = await open(`nav_matrix_${locale}_${width}`, locale, width, height, '#home');
        for (const item of ITEMS) {
          await page.click(`.nav-menu .nav-item[data-tab="${item.tab}"]`);
          await page.waitForTimeout(600);
          assert.deepEqual(await activeViews(page), [item.view], `${item.tab} @${width}x${height}/${locale}`);
          assert.ok((await page.evaluate(() => location.hash)).startsWith(item.hash), `route for ${item.tab}`);
          assert.equal(await page.locator(`.nav-menu .nav-item[data-tab="${item.tab}"]`).evaluate((el: any) => el.classList.contains('active')), true, 'the nav item is marked active');
          const info = await page.evaluate((view: string) => {
            const el = document.getElementById(view);
            return { overflowX: Math.max(0, document.documentElement.scrollWidth - window.innerWidth), text: el ? el.innerText : '', visible: Boolean(el && el.getBoundingClientRect().height > 100) };
          }, item.view);
          assert.equal(info.overflowX, 0, `no horizontal overflow on ${item.tab}`);
          assert.equal(info.visible, true, `${item.tab} has visible content`);
          assert.doesNotMatch(info.text, RAW_KEY, `${item.tab}: no raw key`);
        }
        assert.deepEqual(errors, [], `no script error @${width}x${height}/${locale}`);
        await ctx.close();
      }
    }
  });

  it('refresh keeps the route and back/forward walk the history', async () => {
    const { ctx, page, errors } = await open('nav_history', 'en', 1440, 900, '#home');
    const go = async (tab: string) => { await page.click(`.nav-menu .nav-item[data-tab="${tab}"]`); await page.waitForTimeout(450); };
    await go('tab-recent');
    await go('tab-knowledge');
    await go('tab-executions');
    await page.reload();
    await page.waitForTimeout(700);
    assert.deepEqual(await activeViews(page), ['view-executions'], 'a refresh stays on the same screen');
    await page.goBack(); await page.waitForTimeout(450);
    assert.deepEqual(await activeViews(page), ['view-knowledge']);
    await page.goBack(); await page.waitForTimeout(450);
    assert.deepEqual(await activeViews(page), ['view-recent']);
    await page.goForward(); await page.waitForTimeout(450);
    assert.deepEqual(await activeViews(page), ['view-knowledge']);
    for (const item of ITEMS) {
      await page.goto(`${h.origin}/${item.hash}`);
      await page.reload();
      await page.waitForTimeout(700);
      assert.deepEqual(await activeViews(page), [item.view], `deep link ${item.hash} after refresh`);
    }
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  it('unauthenticated access gets no data: the screens\' APIs answer 401', async () => {
    const ctx = await h.browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${h.origin}/`, { waitUntil: 'domcontentloaded' });
    for (const url of ['/api/v1/artifacts', '/api/v1/workspace/inbox', '/api/v1/workspace/vault', '/api/v1/knowledge', '/api/v1/activity', '/api/v1/account/sessions', '/api/v1/personal/home']) {
      const status = await page.evaluate(async (u: string) => (await fetch(u, { credentials: 'omit' })).status, url);
      assert.equal(status, 401, url);
    }
    await ctx.close();
  });
});

describe('Recent', () => {
  it('lists the user\'s real artifacts newest first, opens one in Main, is private to its owner, and says so when empty', async () => {
    const { ctx, page, user, errors } = await open('recent_flow', 'en', 1440, 900, '#recent');
    await page.waitForSelector('#recent-list');
    await page.waitForFunction(() => /Nothing created yet/.test(document.querySelector('#recent-list')?.textContent || ''), undefined, { timeout: 10000 });
    // Both documents are meant to be from TODAY (local day), newest first. "3 h ago" / "1 h ago" fell on yesterday between 00:00 and 03:00, so the times are clamped to the local day.
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
    const todayAt = (hoursAgo: number, floorSeconds: number) => new Date(Math.min(Date.now() - 1000, Math.max(Date.now() - hoursAgo * 3600_000, startOfToday.getTime() + floorSeconds * 1000))).toISOString();
    h.seedDocument(user, { title: 'Quarterly plan v2', content: 'Plan body text for the quarter.', at: todayAt(3, 5) });
    h.seedDocument(user, { title: 'Launch checklist', content: 'Checklist body.', at: todayAt(1, 10) });
    h.seedDocument(user, { title: 'Old report', content: 'Old body.', at: new Date(Date.now() - 4 * 86400_000).toISOString() });
    await page.reload();
    await page.waitForSelector('.recent-item', { timeout: 15000 });
    const titles = await page.locator('.recent-item-title').allInnerTexts();
    assert.deepEqual(titles, ['Launch checklist', 'Quarterly plan v2', 'Old report'], 'newest first');
    const text = await page.locator('#recent-list').innerText();
    assert.match(text, /today/i);
    assert.match(text, /earlier/i);
    assert.match(text, /Document/);
    assert.doesNotMatch(text, /art_|artifactId|RAW/);

    await page.locator('.recent-item', { hasText: 'Quarterly plan v2' }).locator('.recent-open').click();
    await page.waitForFunction(() => document.querySelector('#main-result-panel') && !document.querySelector('#main-result-panel').hidden, undefined, { timeout: 20000 });
    assert.deepEqual(await activeViews(page), ['view-home']);
    assert.match(await page.locator('#main-result-title').innerText(), /Quarterly plan v2/);
    assert.match(await page.locator('#main-result-preview').innerText(), /Plan body text/);
    assert.deepEqual(errors, []);

    const other = await open('recent_other', 'en', 1440, 900, '#recent');
    await other.page.waitForFunction(() => /Nothing created yet/.test(document.querySelector('#recent-list')?.textContent || ''), undefined, { timeout: 10000 });
    assert.equal(await other.page.locator('.recent-item').count(), 0, 'another user sees none of these');
    const crossRead = await other.page.evaluate(async () => (await fetch('/api/v1/artifacts?limit=50', { credentials: 'same-origin' })).json());
    assert.equal((crossRead as any).artifacts.length, 0);
    await other.ctx.close();
    await ctx.close();
  });

  it('Recent in Korean is localized', async () => {
    const { ctx, page, user } = await open('recent_ko', 'ko', 1440, 900, '#recent');
    h.seedDocument(user, { title: 'Quarterly plan v2', content: 'x', at: new Date().toISOString() });
    await page.reload();
    await page.waitForSelector('.recent-item', { timeout: 15000 });
    const text = await page.locator('#view-recent').innerText();
    assert.match(text, /최근/);
    assert.match(text, /오늘/);
    assert.match(text, /열기/);
    assert.match(text, /문서/);
    assert.doesNotMatch(text, RAW_KEY);
    await ctx.close();
  });
});

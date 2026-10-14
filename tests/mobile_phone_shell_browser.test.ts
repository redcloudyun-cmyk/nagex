// Phone shell certification (R23.7H-C exit criteria MOBILE_VIEWPORT_CERT / HORIZONTAL_OVERFLOW / I18N_EN_KR).
// Real Chromium against the production server harness at 360, 390 and 430px, EN and KR.
//   - Home on a phone is the unified Main surface (composer + briefing), never the desktop marketing hero (giant logo + landing copy)
//   - one header row that fits the viewport; no horizontal overflow on any tab
//   - a bottom navigation (Home, Recent, Inbox, Activity, Settings) is always reachable; Create / Canvas are not primary launchers
//   - moving between the Main Home and a native mobile view (Settings) swaps the shells without leaving both or neither visible
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BrowserContext, Page } from 'playwright';
import { startCanvasAskHarness } from './_canvas_ask_harness.js';

declare const document: any;
declare const window: any;
declare const getComputedStyle: any;

const WIDTHS = [360, 390, 430] as const;
const PRIMARY = ['tab-home', 'tab-recent', 'tab-inbox', 'tab-executions', 'tab-settings'];

async function phone(h: Awaited<ReturnType<typeof startCanvasAskHarness>>, label: string, locale: 'en' | 'ko', width: number): Promise<{ ctx: BrowserContext; page: Page }> {
  const user = h.user(label);
  if (locale === 'ko') h.setLocale(user, 'ko');
  const base = await h.newContext('mobile', user, locale);
  const ctx = await h.browser.newContext({ viewport: { width, height: 800 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: locale === 'ko' ? 'ko-KR' : 'en-US' });
  await ctx.addCookies(await base.cookies());
  await ctx.addInitScript((l: string) => { try { window.localStorage.setItem('nagex_locale', l); } catch { /* ignore */ } }, locale);
  await base.close();
  return { ctx, page: await ctx.newPage() };
}

async function geometry(page: Page): Promise<{ vw: number; scrollW: number; heroLogoVisible: boolean; headerOverflow: string[]; navTabs: string[]; navRect: number[] | null }> {
  return page.evaluate(() => {
    const vis = (e: any) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const logo = document.querySelector('.nagex-hero-logo');
    const headerOverflow = [...document.querySelectorAll('.app-header .brand-section, .app-header .desktop-global-search, .app-header .header-right > *')]
      .filter(vis).filter((e: any) => e.getBoundingClientRect().right > window.innerWidth + 0.5).map((e: any) => String(e.className || e.id));
    const nav = document.querySelector('.mobile-bottom-nav');
    const nr = nav ? nav.getBoundingClientRect() : null;
    const navTabs = nav ? [...nav.querySelectorAll('[data-tab]')].filter(vis).map((b: any) => b.getAttribute('data-tab')) : [];
    return { vw: window.innerWidth, scrollW: document.documentElement.scrollWidth, heroLogoVisible: Boolean(logo && vis(logo)), headerOverflow, navTabs, navRect: nr && vis(nav) ? [Math.round(nr.left), Math.round(nr.right), Math.round(nr.bottom)] : null };
  });
}

test('phone shell: Main Home, one fitting header, bottom navigation and no horizontal overflow at 360/390/430 (EN and KR)', async () => {
  const h = await startCanvasAskHarness({ scrubProviders: true });
  try {
    for (const locale of ['en', 'ko'] as const) {
      for (const width of WIDTHS) {
        const { ctx, page } = await phone(h, `phone_${locale}_${width}`, locale, width);
        await page.goto(`${h.origin}/#home`);
        await page.reload();
        await page.waitForSelector('#nagex-main-surface', { timeout: 20000 });
        await page.waitForTimeout(800);
        const tag = `${locale}/${width}`;

        const home = await geometry(page);
        assert.ok(home.scrollW <= home.vw, `${tag} home: horizontal overflow ${home.scrollW} > ${home.vw}`);
        assert.equal(home.heroLogoVisible, false, `${tag} home: the desktop marketing hero logo must not cover the phone Home`);
        assert.deepEqual(home.headerOverflow, [], `${tag} home: header controls beyond the viewport`);
        assert.deepEqual([...home.navTabs].sort(), [...PRIMARY].sort(), `${tag} home: bottom navigation items`);
        assert.ok(home.navRect && home.navRect[0] === 0 && home.navRect[1] === width, `${tag} home: bottom nav spans the viewport`);
        assert.ok(await page.locator('#main-surface-input').isVisible(), `${tag} home: the Main composer is visible`);
        // One Input: the briefing is a quiet bar (My Day), collapsed by default, and opens on a 44px-high target
        assert.equal(await page.locator('#main-home-briefing').isVisible(), false, `${tag} home: the briefing is collapsed by default`);
        const myDay = await page.locator('#main-myday-toggle').boundingBox();
        assert.ok(myDay && myDay.height >= 44 - 0.5, `${tag} home: My Day is a 44px touch target (${myDay?.height})`);
        await page.locator('#main-myday-toggle').click();
        assert.ok(await page.locator('#main-home-briefing').isVisible(), `${tag} home: the briefing opens`);
        await page.locator('#main-myday-toggle').click();
        assert.equal(await page.locator('#mobile-app-shell').isVisible(), false, `${tag} home: the native shell stays hidden behind the Main surface`);

        // Recent: a non-native tab uses the responsive tree with the same bottom navigation and no empty sidebar column
        await page.locator('.mobile-bottom-nav [data-tab="tab-recent"]').click();
        await page.waitForFunction(() => document.querySelector('#view-recent')?.classList.contains('active-view'));
        const recent = await geometry(page);
        assert.ok(recent.scrollW <= recent.vw, `${tag} recent: horizontal overflow`);
        assert.deepEqual([...recent.navTabs].sort(), [...PRIMARY].sort(), `${tag} recent: bottom navigation items`);
        // accessibility: a labelled landmark in the user's language, and exactly the current destination marked aria-current
        const navA11y = await page.evaluate(() => ({ label: document.querySelector('.mobile-bottom-nav')?.getAttribute('aria-label') || '', current: [...document.querySelectorAll('.mobile-bottom-nav [aria-current="page"]')].map((e: any) => e.getAttribute('data-tab')) }));
        assert.equal(navA11y.label, locale === 'ko' ? '주요 메뉴' : 'Main navigation', `${tag} recent: bottom navigation landmark label`);
        assert.deepEqual(navA11y.current, ['tab-recent'], `${tag} recent: the current destination is aria-current`);
        const left = await page.evaluate(() => Math.round(document.querySelector('#view-recent').getBoundingClientRect().left));
        assert.ok(left <= 24, `${tag} recent: content must start at the page edge, not after a sidebar column (left=${left})`);

        // Settings: native mobile shell with its own bottom nav; Home returns to the Main surface
        await page.locator('.mobile-bottom-nav [data-tab="tab-settings"]').click();
        await page.waitForSelector('#mobile-app-shell:not([hidden])', { timeout: 10000 });
        assert.ok(await page.locator('#mobile-view-settings').isVisible(), `${tag} settings: native settings view`);
        assert.equal(await page.locator('.app-wrapper').isVisible(), false, `${tag} settings: the desktop wrapper is hidden`);
        assert.ok((await page.evaluate(() => document.documentElement.scrollWidth)) <= width, `${tag} settings: horizontal overflow`);

        // Apps & connections (GitHub, custom tool servers) stays reachable on a phone: the native Settings links to the responsive screen
        await page.locator('#mh-apps-open').click();
        await page.waitForSelector('#nagex-connections', { state: 'visible', timeout: 15000 });
        assert.equal(await page.locator('#mobile-app-shell').isVisible(), false, `${tag} connections: the native shell yields to the responsive Connections screen`);
        assert.ok(await page.locator('.mobile-bottom-nav').isVisible(), `${tag} connections: bottom navigation visible`);
        assert.ok((await page.evaluate(() => document.documentElement.scrollWidth)) <= width, `${tag} connections: horizontal overflow`);
        await page.locator('.mobile-bottom-nav [data-tab="tab-settings"]').click();
        await page.waitForSelector('#mobile-app-shell:not([hidden]) #mobile-view-settings', { state: 'visible', timeout: 10000 });

        await page.locator('.mh-bottom-nav [data-tab="tab-home"]').click();
        await page.waitForSelector('#main-surface-input', { state: 'visible', timeout: 10000 });
        assert.equal(await page.locator('#mobile-app-shell').isVisible(), false, `${tag} back home: native shell hidden again`);
        assert.ok(await page.locator('.mobile-bottom-nav').isVisible(), `${tag} back home: bottom navigation visible`);
        await ctx.close();
      }
    }
  } finally {
    await h.close();
  }
});

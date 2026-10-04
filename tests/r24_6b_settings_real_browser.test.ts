// R24.6B — real-browser (Chromium) Settings certification.
//
// Drives the real public/ UI against a real in-process server: persisted
// per-user Quick Wake / Autonomy, truthful save feedback (including a forced
// write failure), signed-out state, mobile cold-load truthfulness, the
// Proactive Assistant draft behavior, no fabricated device, canonical account
// locale, and mobile layout (no overflow / raw keys / undersized targets).
// Only safe, deterministic settings are touched — no credentials, no Google
// connect/disconnect, no destructive account operations.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createServerInstance } from '../src/server_web.js';
import { TEST_PEER_HEADER, testPeerServerOptions } from './_s2e_peer.js';
import { enableDevAuthTokensForFile } from './_dev_auth_tokens.js';

// R24.6C1 — this file legitimately needs raw dev tokens to drive signup/verify; opt in explicitly (restored after the file).
enableDevAuthTokensForFile();

// Page callbacks run in the browser; the project's TS lib has no DOM types.
declare const window: any;
declare const document: any;
declare const innerWidth: number;
declare function getComputedStyle(el: any): any;

let origin = '';
let closeServer: () => Promise<void> = async () => {};
let browser: Browser;

const PASSWORD = 'Browser-Cert-1!';
// R24.6C — remember each throwaway account's id (to forge it in headers).
const userIdByCookie = new Map<string, string>();

let clientCounter = 0;
async function json(method: string, p: string, body?: unknown, cookie?: string, clientIp?: string) {
  const res = await fetch(origin + p, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(clientIp ? { [TEST_PEER_HEADER]: clientIp } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data: any = null;
  try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data, cookie: (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ') };
}

async function createSignedInUser(email: string): Promise<string> {
  const ip = `10.24.6.${++clientCounter}`; // test harness: each user signs up from its own client IP (per-IP signup rate limiter)
  const signup = await json('POST', '/api/v1/auth/signup', { email, password: PASSWORD, passwordConfirmation: PASSWORD, termsAccepted: true, privacyAccepted: true }, undefined, ip);
  assert.equal(signup.status, 201);
  await json('POST', '/api/v1/auth/verify-email', { token: signup.data.devVerificationToken }, undefined, ip);
  const login = await json('POST', '/api/v1/auth/login', { email, password: PASSWORD }, undefined, ip);
  assert.equal(login.status, 200);
  userIdByCookie.set(login.cookie, signup.data.user.userId);
  return login.cookie; // "nagex_session=<value>"
}

async function newContext(kind: 'desktop' | 'mobile', cookie?: string): Promise<BrowserContext> {
  const ctx = await browser.newContext(kind === 'mobile'
    ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
    : { viewport: { width: 1440, height: 900 } });
  if (cookie) {
    const [name, ...rest] = cookie.split('=');
    await ctx.addCookies([{ name, value: rest.join('='), url: origin }]);
  }
  return ctx;
}

async function openDesktopSettings(page: Page, category: string): Promise<void> {
  await page.goto(`${origin}/#settings`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#view-settings.active-view');
  await page.waitForFunction(() => (window as any).NAGEX.getState().settingsPrefsStatus !== 'LOADING');
  await page.click(`#cat-tab-${category}`);
}

async function openMobileSettings(page: Page): Promise<void> {
  await page.goto(`${origin}/#settings`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#mobile-view-settings:not([hidden])');
  await page.waitForFunction(() => (window as any).NAGEX.getState().settingsPrefsStatus !== 'LOADING');
}

before(async () => {
  const instance = createServerInstance(testPeerServerOptions());
  await new Promise<void>((resolve, reject) => {
    instance.listen(0, '127.0.0.1', () => resolve());
    instance.once('error', reject);
  });
  origin = `http://127.0.0.1:${(instance.address() as AddressInfo).port}`;
  closeServer = async () => {
    if (typeof (instance as any).closeIdleConnections === 'function') (instance as any).closeIdleConnections();
    await new Promise<void>((res) => instance.close(() => res()));
  };
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  await closeServer();
});

describe('R24.6B real browser — Desktop Settings', () => {
  it('persists Quick Wake and Autonomy through reload and a fresh browser context, with truthful notes and "Saved." only after the real write', { timeout: 120_000 }, async () => {
    const cookie = await createSignedInUser('desk_persist@example.invalid');
    const ctx = await newContext('desktop', cookie);
    const page = await ctx.newPage();
    await openDesktopSettings(page, 'autonomy');

    // Truthful note: preference-only, approval still required.
    assert.match(await page.textContent('#autonomy-pref-note') ?? '', /does not change how NAgex acts yet/i);

    // Default is shown only because the server returned it (L2), after load.
    assert.equal(await page.locator('#autonomy-selector-container .autonomy-level-card.selected').count(), 1);
    await page.locator('#autonomy-selector-container .autonomy-level-card').nth(0).click(); // L0
    await page.waitForFunction(() => (window as any).NAGEX.getState().autonomyConfig.level === 'L0');
    assert.equal(await page.locator('#settings-save-feedback').isVisible(), true);

    await page.click('#cat-tab-notifications');
    assert.match(await page.textContent('#quickwake-pref-note') ?? '', /No NAgex app applies these shortcuts yet/i);
    const boxes = page.locator('#quickwake-settings-options input[type=checkbox]');
    await boxes.nth(3).click(); // voice_wake on
    await page.waitForFunction(() => (window as any).NAGEX.getState().quickWakeConfig.voice_wake === true);

    // Navigate away and back, then reload.
    await page.evaluate(() => (window as any).NAGEX.switchTab('tab-home'));
    await page.evaluate(() => (window as any).NAGEX.switchTab('tab-settings'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window as any).NAGEX.getState().settingsPrefsStatus === 'OK');
    await page.click('#cat-tab-autonomy');
    assert.equal((await page.locator('#autonomy-selector-container .autonomy-level-card.selected .setting-title').textContent())?.trim(), 'Always ask');
    await page.click('#cat-tab-notifications');
    assert.equal(await page.locator('#quickwake-settings-options input[type=checkbox]').nth(3).isChecked(), true);
    await ctx.close();

    // Fresh browser context (no localStorage/sessionStorage), same account.
    const fresh = await newContext('desktop', cookie);
    const freshPage = await fresh.newPage();
    await openDesktopSettings(freshPage, 'autonomy');
    assert.equal((await freshPage.locator('#autonomy-selector-container .autonomy-level-card.selected .setting-title').textContent())?.trim(), 'Always ask');
    await freshPage.click('#cat-tab-notifications');
    assert.equal(await freshPage.locator('#quickwake-settings-options input[type=checkbox]').nth(3).isChecked(), true);
    await fresh.close();
  });

  it('a different user does not see those values, and a failed write is shown as a failure (control reverts, no "Saved.")', { timeout: 120_000 }, async () => {
    const cookie = await createSignedInUser('desk_fail@example.invalid');
    const ctx = await newContext('desktop', cookie);
    const page = await ctx.newPage();
    await openDesktopSettings(page, 'autonomy');
    assert.equal((await page.locator('#autonomy-selector-container .autonomy-level-card.selected .setting-title').textContent())?.trim(), 'Help with routine tasks', "another user's L0 must not leak (default L2)");

    // Force the backend write to fail.
    await page.route('**/api/v1/autonomy/config', async (route) => {
      if (route.request().method() === 'POST') await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL', message: 'disk full' } }) });
      else await route.continue();
    });
    await page.locator('#autonomy-selector-container .autonomy-level-card').nth(3).click(); // try L3
    await page.waitForSelector('#settings-error-banner:not([hidden])');
    assert.equal(await page.locator('#settings-save-feedback').isVisible(), false, 'no success toast for a failed write');
    assert.equal((await page.locator('#autonomy-selector-container .autonomy-level-card.selected .setting-title').textContent())?.trim(), 'Help with routine tasks', 'UI must not show a state that was never persisted');
    assert.equal(await page.evaluate(() => (window as any).NAGEX.getState().autonomyConfig.level), 'L2');
    await ctx.close();
  });

  it('signed-out visitors get a truthful sign-in state, never default values presented as settings', { timeout: 60_000 }, async () => {
    const ctx = await newContext('desktop');
    const page = await ctx.newPage();
    await openDesktopSettings(page, 'autonomy');
    assert.equal(await page.locator('#autonomy-selector-container .autonomy-level-card').count(), 0);
    assert.match(await page.textContent('#autonomy-selector-container') ?? '', /Sign in to view and change these settings/);
    await page.click('#cat-tab-notifications');
    assert.equal(await page.locator('#quickwake-settings-options input[type=checkbox]').count(), 0);
    // R24.6C — the Proactive Assistant and the Google connection are account-owned too.
    await page.waitForFunction(() => /Sign in to view and change/.test(document.querySelector('#proactive-assistant-panel')?.textContent ?? ''));
    assert.equal(await page.locator('#proactive-assistant-panel [data-pa-save]').count(), 0);
    await page.click('#cat-tab-connections');
    assert.match(await page.textContent('#settings-connections-status') ?? '', /Sign in to view and change these settings/);
    await ctx.close();
  });

  it('Devices shows no fabricated connected device, and the Settings DOM has no duplicate ids', { timeout: 60_000 }, async () => {
    const cookie = await createSignedInUser('desk_devices@example.invalid');
    const ctx = await newContext('desktop', cookie);
    const page = await ctx.newPage();
    await openDesktopSettings(page, 'devices');
    const text = (await page.textContent('#cat-panel-devices')) ?? '';
    assert.doesNotMatch(text, /Local Desktop Agent|Windows Desktop|Active now/i);
    assert.equal(await page.locator('#cat-panel-devices .badge-status').count(), 0);
    assert.match(text, /not listed here yet/i);

    await page.click('#cat-tab-notifications');
    await page.waitForSelector('#proactive-assistant-panel [data-pa-save]');
    const duplicates = await page.evaluate(() => {
      const seen = new Map<string, number>();
      // Scoped to the Settings views (Desktop + Mobile): both are in the DOM at once.
      document.querySelectorAll('#view-settings [id], #mobile-view-settings [id]').forEach((el: any) => seen.set(el.id, (seen.get(el.id) ?? 0) + 1));
      return [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
    });
    assert.deepEqual(duplicates, [], 'duplicate DOM ids');
    await ctx.close();
  });

  it('Proactive Assistant: a weekday click keeps unsaved edits, and a saved schedule survives reload + fresh context', { timeout: 120_000 }, async () => {
    const cookie = await createSignedInUser('desk_pa@example.invalid');
    const ctx = await newContext('desktop', cookie);
    const page = await ctx.newPage();
    await openDesktopSettings(page, 'notifications');
    await page.waitForSelector('#proactive-assistant-panel [data-pa-save]');
    const panel = page.locator('#proactive-assistant-panel');

    await panel.locator('[data-pa-field="localTime"]').fill('06:15');
    await panel.locator('[data-pa-field="timezone"]').selectOption('Asia/Tokyo');
    await panel.locator('[data-pa-field="notifyOnComplete"]').evaluate((el: any) => { if (el.checked) el.click(); });
    await panel.locator('[data-pa-field="enabled"]').evaluate((el: any) => { if (!el.checked) el.click(); });
    await panel.locator('[data-pa-weekday="1"]').click();
    await panel.locator('[data-pa-weekday="3"]').click();

    // The old behavior re-rendered the panel on a chip click and reset time to 08:00 etc.
    assert.equal(await panel.locator('[data-pa-field="localTime"]').inputValue(), '06:15');
    assert.equal(await panel.locator('[data-pa-field="timezone"]').inputValue(), 'Asia/Tokyo');
    assert.equal(await panel.locator('[data-pa-field="notifyOnComplete"]').isChecked(), false);
    assert.equal(await panel.locator('[data-pa-field="enabled"]').isChecked(), true);
    assert.equal(await panel.locator('.pa-weekday-selected').count(), 2);

    // A re-render triggered elsewhere (e.g. a Quick Wake write) must not drop the draft either.
    await page.evaluate(() => (window as any).NAGEX.renderSettings());
    assert.equal(await panel.locator('[data-pa-field="localTime"]').inputValue(), '06:15');

    await panel.locator('[data-pa-save]').click();
    await page.waitForFunction(() => /ON/.test(document.querySelector('#proactive-assistant-panel .pa-status-on')?.textContent ?? ''));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await openDesktopSettings(page, 'notifications');
    await page.waitForSelector('#proactive-assistant-panel [data-pa-save]');
    assert.equal(await page.locator('#proactive-assistant-panel [data-pa-field="localTime"]').inputValue(), '06:15');
    assert.equal(await page.locator('#proactive-assistant-panel [data-pa-field="timezone"]').inputValue(), 'Asia/Tokyo');
    assert.equal(await page.locator('#proactive-assistant-panel .pa-weekday-selected').count(), 2);
    await ctx.close();
  });
});

describe('R24.6B real browser — Mobile Settings (390x844)', () => {
  it('a cold load shows the persisted Quick Wake / Autonomy / Account state (not stale defaults), and a mutation persists across reload', { timeout: 120_000 }, async () => {
    const cookie = await createSignedInUser('mob_persist@example.invalid');
    // Persist non-default values through the real API first.
    assert.equal((await json('POST', '/api/v1/quickwake/config', { voice_wake: true, floating_button: false }, cookie)).status, 200);
    assert.equal((await json('POST', '/api/v1/autonomy/config', { level: 'L3' }, cookie)).status, 200);

    const ctx = await newContext('mobile', cookie);
    const page = await ctx.newPage();
    await openMobileSettings(page); // genuine cold load of #settings

    const read = () => page.evaluate(() => ({
      qw: Object.fromEntries([...document.querySelectorAll('#mh-quickwake-list input[data-qw-key]')].map((i) => [i.dataset.qwKey, i.checked])),
      autonomy: document.querySelector('#mh-autonomy-list .selected .mh-settings-row-title')?.textContent?.trim() ?? null,
      accountForm: Boolean(document.querySelector('#acc-profile-name')),
    }));
    await page.waitForFunction(() => document.querySelectorAll('#mh-quickwake-list input[data-qw-key]').length === 5);
    await page.waitForSelector('#acc-profile-name');
    const cold = await read();
    assert.deepEqual(cold.qw, { floating_button: false, quick_settings_tile: true, lock_screen_shortcut: true, voice_wake: true, double_tap_shortcut: true });
    assert.equal(cold.autonomy, 'Use trusted routines');
    assert.equal(cold.accountForm, true, 'a valid session must show the Account form, not the signed-out prompt');
    assert.match(await page.textContent('#mh-quickwake-pref-note') ?? '', /No NAgex app applies these shortcuts yet/i);
    assert.match(await page.textContent('#mh-autonomy-pref-note') ?? '', /does not change how NAgex acts yet/i);

    // An unsaved Account edit must survive a data refresh caused by a Settings write.
    await page.fill('#acc-profile-name', 'Unsaved Display Name');
    await page.locator('#mh-quickwake-list input[data-qw-key="double_tap_shortcut"]').evaluate((el: any) => el.click());
    await page.waitForFunction(() => (window as any).NAGEX.getState().quickWakeConfig.double_tap_shortcut === false);
    assert.equal(await page.inputValue('#acc-profile-name'), 'Unsaved Display Name', 'a Settings write must not repaint the Account form');
    await page.locator('#mh-quickwake-list input[data-qw-key="double_tap_shortcut"]').evaluate((el: any) => el.click());
    await page.waitForFunction(() => (window as any).NAGEX.getState().quickWakeConfig.double_tap_shortcut === true);

    // Mutate a safe setting on mobile, then reload.
    await page.locator('#mh-autonomy-list [data-autonomy-id="L1"]').click();
    await page.waitForFunction(() => document.querySelector('#mh-autonomy-list .selected .mh-settings-row-title')?.textContent?.trim() === 'Read and suggest');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#mobile-view-settings:not([hidden])');
    await page.waitForFunction(() => document.querySelector('#mh-autonomy-list .selected .mh-settings-row-title')?.textContent?.trim() === 'Read and suggest');
    assert.equal((await json('GET', '/api/v1/autonomy/config', undefined, cookie)).data.level, 'L1');

    // Desktop and Mobile render from the same persisted truth.
    const desk = await newContext('desktop', cookie);
    const deskPage = await desk.newPage();
    await openDesktopSettings(deskPage, 'autonomy');
    assert.equal((await deskPage.locator('#autonomy-selector-container .autonomy-level-card.selected .setting-title').textContent())?.trim(), 'Read and suggest');
    await desk.close();
    await ctx.close();
  });

  it('a failed mobile write is reported and the toggle reverts; signed-out mobile shows the sign-in state', { timeout: 120_000 }, async () => {
    const cookie = await createSignedInUser('mob_fail@example.invalid');
    const ctx = await newContext('mobile', cookie);
    const page = await ctx.newPage();
    await openMobileSettings(page);
    await page.waitForFunction(() => document.querySelectorAll('#mh-quickwake-list input[data-qw-key]').length === 5);
    await page.route('**/api/v1/quickwake/config', async (route) => {
      if (route.request().method() === 'POST') await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL', message: 'disk full' } }) });
      else await route.continue();
    });
    const voice = page.locator('#mh-quickwake-list input[data-qw-key="voice_wake"]');
    assert.equal(await voice.isChecked(), false);
    await voice.evaluate((el: any) => el.click());
    await page.waitForFunction(() => (window as any).NAGEX.getState().settingsPrefsStatus === 'OK');
    await page.waitForFunction(() => document.querySelector('#mh-quickwake-list input[data-qw-key="voice_wake"]')?.checked === false);
    assert.equal((await json('GET', '/api/v1/quickwake/config', undefined, cookie)).data.voice_wake, false);
    await ctx.close();

    const anon = await newContext('mobile');
    const anonPage = await anon.newPage();
    await openMobileSettings(anonPage);
    assert.equal(await anonPage.locator('#mh-quickwake-list input[data-qw-key]').count(), 0);
    assert.match(await anonPage.textContent('#mh-quickwake-list') ?? '', /Sign in to view and change these settings/);
    assert.match(await anonPage.textContent('#mh-autonomy-list') ?? '', /Sign in to view and change these settings/);
    await anon.close();
  });

  it('layout: no horizontal overflow, no raw i18n keys (EN and KR), no desktop view leakage, no Devices section, touch targets >= 44px', { timeout: 120_000 }, async () => {
    const cookie = await createSignedInUser('mob_layout@example.invalid');
    const ctx = await newContext('mobile', cookie);
    const page = await ctx.newPage();
    await openMobileSettings(page);
    await page.waitForSelector('#acc-profile-name');
    await page.waitForFunction(() => document.querySelectorAll('#mh-quickwake-list input[data-qw-key]').length === 5);
    await page.waitForSelector('#mh-proactive-assistant-panel [data-pa-save]');

    const audit = () => page.evaluate(() => {
      const root = document.querySelector('#mobile-view-settings');
      const visible = (el: any) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const targets = [...root.querySelectorAll('button, a[href], select, input:not([type=checkbox]):not([type=hidden]), label.mh-toggle-switch, [role=button]')].filter(visible);
      const small = targets.map((el) => { const r = el.getBoundingClientRect(); return { id: el.id || el.className.toString().slice(0, 40) || el.tagName, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 }; }).filter((t) => t.h < 43.5 || t.w < 43.5);
      const desktopView = document.querySelector('#view-settings');
      return {
        overflowX: document.scrollingElement.scrollWidth > innerWidth + 1 || root.scrollWidth > root.clientWidth + 1,
        rawKeys: (root.innerText.match(/\b[a-z]+[A-Za-z]*\.[a-z][A-Za-z]+\b/g) || []).filter((s: string) => !/\.(com|io|js|invalid)$/.test(s)),
        desktopSettingsVisible: !!desktopView && visible(desktopView) && getComputedStyle(desktopView).display !== 'none',
        devicesSection: /Devices|기기/.test(root.innerText) && !!root.querySelector('#settings-devices-list'),
        small,
        targetCount: targets.length,
      };
    });

    const en = await audit();
    assert.equal(en.overflowX, false, 'horizontal overflow at 390px');
    assert.deepEqual(en.rawKeys, [], 'raw i18n keys (EN)');
    assert.equal(en.desktopSettingsVisible, false, 'desktop Settings leaking into mobile');
    assert.equal(en.devicesSection, false);
    assert.deepEqual(en.small, [], 'interactive targets smaller than 44px');
    assert.ok(en.targetCount >= 15, `expected a real set of controls, got ${en.targetCount}`);

    await page.click('#mh-settings-lang-toggle');
    await page.waitForFunction(() => (window as any).NAGEX_I18N.getLocale() === 'ko');
    const ko = await audit();
    assert.deepEqual(ko.rawKeys, [], 'raw i18n keys (KR)');
    assert.equal(ko.overflowX, false);
    await ctx.close();
  });
});

async function expectEventually(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    if (await check()) return;
    await new Promise((res) => setTimeout(res, 150));
  }
  assert.fail(`timed out waiting for: ${what}`);
}

describe('R24.6B real browser — account locale', () => {
  it('the account locale is canonical (en|ko), applied from the account in a fresh browser, and written through from a language change', { timeout: 120_000 }, async () => {
    const cookie = await createSignedInUser('locale_user@example.invalid');
    const ctx = await newContext('mobile', cookie);
    const page = await ctx.newPage();
    await openMobileSettings(page);
    await page.waitForSelector('#acc-profile-locale');
    const optionValues = await page.$$eval('#acc-profile-locale option', (opts: any[]) => opts.map((o: any) => o.value));
    assert.deepEqual(optionValues, ['en', 'ko']);
    assert.equal(await page.inputValue('#acc-profile-locale'), 'en', 'a new account (profile locale "en") must select English, not fall through');

    // Choosing Korean in the Account form saves the canonical value and applies it.
    await page.selectOption('#acc-profile-locale', 'ko');
    await page.click('#btn-save-profile');
    await page.waitForFunction(() => (window as any).NAGEX_I18N.getLocale() === 'ko');
    assert.equal((await json('GET', '/api/v1/account', undefined, cookie)).data.profile.locale, 'ko');
    await ctx.close();

    // Fresh browser (empty localStorage): the account preference wins over the empty cache.
    const fresh = await newContext('mobile', cookie);
    const freshPage = await fresh.newPage();
    await freshPage.goto(`${origin}/#home`, { waitUntil: 'domcontentloaded' });
    await freshPage.waitForFunction(() => (window as any).NAGEX_I18N.getLocale() === 'ko');
    assert.equal(await freshPage.evaluate(() => document.documentElement.lang), 'ko');

    // A language change made while signed in is written through to the profile (no divergence).
    await freshPage.evaluate(() => (window as any).NAGEX_I18N.setLocale('en'));
    await expectEventually(async () => (await json('GET', '/api/v1/account', undefined, cookie)).data.profile.locale === 'en', 'profile locale written through to en');
    await fresh.close();

    // Invalid locale is rejected by the API (never stored).
    const bad = await json('PATCH', '/api/v1/account/profile', { locale: 'ZZ' }, cookie);
    assert.equal(bad.status, 400);
    assert.equal((await json('GET', '/api/v1/account', undefined, cookie)).data.profile.locale, 'en');
  });
});

describe('R24.6C real browser — account-owned Settings (Proactive Assistant, Google, memory settings)', () => {
  it('Desktop: a saved Proactive Assistant schedule belongs to the signed-in user — reload and a fresh context show it, another user sees defaults', { timeout: 150_000 }, async () => {
    const cookieA = await createSignedInUser('c_desk_a@example.invalid');
    const cookieB = await createSignedInUser('c_desk_b@example.invalid');
    const ctx = await newContext('desktop', cookieA);
    const page = await ctx.newPage();
    await openDesktopSettings(page, 'notifications');
    const panel = page.locator('#proactive-assistant-panel');
    await panel.locator('[data-pa-save]').waitFor();
    await panel.locator('[data-pa-weekday="2"]').click();
    await panel.locator('[data-pa-field="localTime"]').fill('05:40');
    await panel.locator('[data-pa-save]').click();
    await expectEventually(async () => (await json('GET', '/api/v1/proactive-assistant/config', undefined, cookieA)).data.localTime === '05:40', 'schedule saved for A');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await openDesktopSettings(page, 'notifications');
    await page.waitForFunction(() => document.querySelector('#proactive-assistant-panel [data-pa-field="localTime"]')?.value === '05:40');
    await ctx.close();

    const fresh = await newContext('desktop', cookieA);
    const freshPage = await fresh.newPage();
    await openDesktopSettings(freshPage, 'notifications');
    await freshPage.waitForFunction(() => document.querySelector('#proactive-assistant-panel [data-pa-field="localTime"]')?.value === '05:40');
    await fresh.close();

    // User B (separate account) sees the untouched default, not A's schedule.
    const other = await newContext('desktop', cookieB);
    const otherPage = await other.newPage();
    await openDesktopSettings(otherPage, 'notifications');
    await otherPage.waitForSelector('#proactive-assistant-panel [data-pa-save]');
    assert.equal(await otherPage.locator('#proactive-assistant-panel [data-pa-field="localTime"]').inputValue(), '08:00');
    assert.equal(await otherPage.locator('#proactive-assistant-panel .pa-weekday-selected').count(), 0);
    await other.close();
  });

  it("the browser's own default identity headers (X-Principal-Id/X-NAgex-Tenant) and a forged header naming another user cannot change whose settings are read or written", { timeout: 120_000 }, async () => {
    const cookieA = await createSignedInUser('c_forge_a@example.invalid');
    const cookieB = await createSignedInUser('c_forge_b@example.invalid');
    const idB = userIdByCookie.get(cookieB)!;
    assert.equal((await json('POST', '/api/v1/autonomy/config', { level: 'L0' }, cookieA)).status, 200);
    assert.equal((await json('POST', '/api/v1/memory/settings', { memoryCaptureEnabled: false }, cookieA)).status, 200);

    const ctx = await newContext('desktop', cookieA);
    const page = await ctx.newPage();
    await page.goto(`${origin}/#settings`, { waitUntil: 'domcontentloaded' });
    const seen = await page.evaluate(async (forgedId: string) => {
      const forged = { 'X-Principal-Id': forgedId, 'X-NAgex-Tenant': 'ten_' + forgedId };
      const get = async (p: string): Promise<any> => (await (await fetch(p, { headers: forged })).json());
      return { autonomy: (await get('/api/v1/autonomy/config')).level, memory: (await get('/api/v1/memory/settings')).memoryCaptureEnabled, google: (await get('/api/v1/oauth/google/status')).connected };
    }, idB);
    assert.equal(seen.autonomy, 'L0', "the page is A's session: B's forged id must not select B's data");
    assert.equal(seen.memory, false);
    assert.equal(typeof seen.google, 'boolean');
    // B's own data is untouched.
    assert.equal((await json('GET', '/api/v1/autonomy/config', undefined, cookieB)).data.level, 'L2');
    assert.equal((await json('GET', '/api/v1/memory/settings', undefined, cookieB)).data.memoryCaptureEnabled, true);
    await ctx.close();
  });

  it('Mobile 390x844: Proactive Assistant safe mutation persists across reload for the signed-in user; Google row shows account-owned state, no raw keys', { timeout: 150_000 }, async () => {
    const cookie = await createSignedInUser('c_mob@example.invalid');
    const ctx = await newContext('mobile', cookie);
    const page = await ctx.newPage();
    await openMobileSettings(page);
    const panel = page.locator('#mh-proactive-assistant-panel');
    await panel.locator('[data-pa-save]').waitFor();
    await panel.locator('[data-pa-weekday="5"]').click();
    await panel.locator('[data-pa-field="localTime"]').fill('04:25');
    await panel.locator('[data-pa-save]').click();
    await expectEventually(async () => (await json('GET', '/api/v1/proactive-assistant/config', undefined, cookie)).data.localTime === '04:25', 'mobile schedule saved');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#mobile-view-settings:not([hidden])');
    await page.waitForFunction(() => document.querySelector('#mh-proactive-assistant-panel [data-pa-field="localTime"]')?.value === '04:25');
    assert.equal(await page.locator('#mh-proactive-assistant-panel .pa-weekday-selected').count(), 1);
    const text = (await page.textContent('#mh-connections-row')) ?? '';
    assert.doesNotMatch(text, /Sign in to view and change/, 'a signed-in user must not see the signed-out Google state');
    assert.equal((await page.evaluate(() => (document.querySelector('#mobile-view-settings') as any).innerText.match(/\b[a-z]+[A-Za-z]*\.[a-z][A-Za-z]+\b/g) || [])).length, 0);
    await ctx.close();
  });
});

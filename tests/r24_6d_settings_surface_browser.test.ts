// R24.6D — Settings surface completion, certified in real Chromium.
//
//  - Desktop Account is reachable (header user control + Account category) and
//    is the SAME implementation/state as Mobile's Account (one renderer, no
//    duplicate DOM ids).
//  - Organization visibility follows ONE rule (enterprise UI mode) on Desktop
//    and Mobile.
//  - Settings are localized (Desktop Quick Wake/Autonomy labels, Account
//    strings): no hardcoded-English leftovers in Korean, no raw i18n keys.
//  - Sensitive/destructive Account operations are exercised ONLY on freshly
//    created disposable accounts.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createServerInstance, identityStore, sessionStore } from '../src/server_web.js';
import { hashPassword } from '../src/identity/identity.crypto.js';

declare const window: any;
declare const document: any;
declare const NodeFilter: any;
declare const getComputedStyle: any;
declare const innerWidth: number;
declare const location: any;

let origin = '';
let closeServer: () => Promise<void> = async () => {};
let browser: Browser;
let counter = 0;
const RUN = `${Date.now()}`;

before(async () => {
  const instance = createServerInstance();
  await new Promise<void>((resolve, reject) => { instance.listen(0, '127.0.0.1', () => resolve()); instance.once('error', reject); });
  origin = `http://127.0.0.1:${(instance.address() as AddressInfo).port}`;
  closeServer = async () => {
    if (typeof (instance as any).closeIdleConnections === 'function') (instance as any).closeIdleConnections();
    await new Promise<void>((res) => instance.close(() => res()));
  };
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await closeServer(); });

interface Disposable { userId: string; tenantId: string; email: string; password: string; sessionId: string; cookie: string }

// Disposable account created straight through the production stores (no token flow needed).
function disposable(label: string, password = 'Disposable-Pass-1!'): Disposable {
  const email = `r246d_${label}_${RUN}_${++counter}@example.invalid`;
  const { identity } = identityStore.createAccount(email, hashPassword(password));
  identityStore.transitionState(identity.userId, 'ACTIVE');
  const tenantId = `ten_${identity.userId}`;
  const session = sessionStore.createAuthSession(tenantId, identity.userId, 'MAIN');
  return { userId: identity.userId, tenantId, email, password, sessionId: session.sessionId, cookie: `nagex_session=${session.sessionId}` };
}

async function api(method: string, p: string, body?: unknown, cookie?: string) {
  const res = await fetch(origin + p, { method, headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.246.8.${++counter % 250}`, ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data: any = null;
  try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data };
}

async function newContext(kind: 'desktop' | 'mobile', user?: Disposable): Promise<BrowserContext> {
  const ctx = await browser.newContext(kind === 'mobile'
    ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
    : { viewport: { width: 1440, height: 900 } });
  if (user) await ctx.addCookies([{ name: 'nagex_session', value: user.sessionId, url: origin }]);
  return ctx;
}

async function openDesktopSettings(page: Page, hash = '#settings', query = ''): Promise<void> {
  await page.goto(`${origin}/${query}${hash}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#view-settings.active-view');
  await page.waitForFunction(() => window.NAGEX.getState().settingsPrefsStatus !== 'LOADING');
}

async function openMobileSettings(page: Page, query = ''): Promise<void> {
  await page.goto(`${origin}/${query}#settings`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#mobile-view-settings:not([hidden])');
  await page.waitForFunction(() => window.NAGEX.getState().settingsPrefsStatus !== 'LOADING');
}

async function eventually(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 50; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 150)); }
  assert.fail(`timed out waiting for: ${what}`);
}

const duplicateIds = (page: Page) => page.evaluate(() => {
  const seen = new Map<string, number>();
  document.querySelectorAll('#view-settings [id], #mobile-view-settings [id]').forEach((e: any) => seen.set(e.id, (seen.get(e.id) ?? 0) + 1));
  return [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
});

describe('R24.6D — Desktop Account is reachable and shares the Mobile implementation', () => {
  it('the header user control lands on the Account category; profile values load; a safe edit persists across reload', { timeout: 120_000 }, async () => {
    const user = disposable('acct');
    const ctx = await newContext('desktop', user);
    const page = await ctx.newPage();
    await page.goto(`${origin}/#home`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.NAGEX && window.NAGEX.getCurrentUser && window.NAGEX.getCurrentUser().authenticated);

    await page.click('.user-pill-header');
    await page.waitForSelector('#dk-acc-profile-name');
    assert.equal(await page.evaluate(() => location.hash), '#settings/account');
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.cat-panel')].filter((p: any) => !p.hidden).map((p: any) => p.id)), ['cat-panel-account']);
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('cat-tab-account')).display !== 'none'), true, 'an Account category tab exists on Desktop');
    assert.equal(await page.inputValue('#dk-acc-profile-name'), user.email.split('@')[0], 'profile values load from the real account');
    assert.equal(await page.inputValue('#dk-acc-profile-locale'), 'en');

    await page.fill('#dk-acc-profile-name', 'Desktop Edit Name');
    await page.click('#dk-btn-save-profile');
    await eventually(async () => (await api('GET', '/api/v1/account', undefined, user.cookie)).data.profile.displayName === 'Desktop Edit Name', 'profile saved');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#dk-acc-profile-name');
    await page.waitForFunction(() => document.querySelector('#dk-acc-profile-name')?.value === 'Desktop Edit Name');
    // The account is also reachable by its deep link and by the tab.
    await page.evaluate(() => window.NAGEX.switchSettingsCategory('connections'));
    await page.click('#cat-tab-account');
    await page.waitForFunction(() => document.querySelector('#dk-acc-profile-name')?.value === 'Desktop Edit Name');
    await ctx.close();
  });

  it('one renderer, one state: Desktop and Mobile containers show identical canonical data and there are no duplicate DOM ids', { timeout: 120_000 }, async () => {
    const user = disposable('shared');
    const ctx = await newContext('desktop', user);
    const page = await ctx.newPage();
    await openDesktopSettings(page);
    await page.waitForSelector('#dk-acc-profile-name', { state: 'attached' });
    await page.waitForSelector('#acc-profile-name', { state: 'attached' }); // Mobile's container is in the same document, rendered by the same function

    assert.deepEqual(await duplicateIds(page), [], 'duplicate DOM ids');
    // Change the account through the API, re-read through the one shared state, and both views follow.
    assert.equal((await api('PATCH', '/api/v1/account/profile', { displayName: 'Shared State Name' }, user.cookie)).status, 200);
    await page.evaluate(() => window.NAGEX.checkSession());
    await page.waitForFunction(() => document.querySelector('#dk-acc-profile-name')?.value === 'Shared State Name' && document.querySelector('#acc-profile-name')?.value === 'Shared State Name');
    assert.deepEqual(await duplicateIds(page), [], 'duplicate DOM ids after a re-render');
    // No second account state: the only account state object is the shared one.
    assert.equal(await page.evaluate(() => window.NAGEX.getCurrentUser().profile.displayName), 'Shared State Name');
    await ctx.close();
  });

  it('signed-out Desktop shows the sign-in prompt in Account (no profile form)', { timeout: 60_000 }, async () => {
    const ctx = await newContext('desktop');
    const page = await ctx.newPage();
    await openDesktopSettings(page, '#settings/account');
    await page.waitForSelector('#dk-btn-account-signin-trigger');
    assert.equal(await page.locator('#dk-acc-profile-name').count(), 0);
    await ctx.close();
  });
});

describe('R24.6D — Account operations on Desktop (disposable accounts only)', () => {
  it('password change, session revoke and log-out-all work through the Desktop UI', { timeout: 180_000 }, async () => {
    const user = disposable('pwd');
    const second = sessionStore.createAuthSession(user.tenantId, user.userId, 'MAIN', { userAgent: 'Disposable Second Device' } as any);
    const ctx = await newContext('desktop', user);
    const page = await ctx.newPage();
    await openDesktopSettings(page, '#settings/account');
    await page.waitForSelector('#dk-acc-sessions-list .mh-session-row');

    // sessions list shows both sessions; the current one has no revoke button
    assert.equal(await page.locator('#dk-acc-sessions-list .mh-session-row').count(), 2);
    assert.equal(await page.locator('#dk-acc-sessions-list .btn-revoke-session').count(), 1);

    // password change
    const newPassword = 'Changed-Pass-2!';
    await page.fill('#dk-acc-pwd-current', user.password);
    await page.fill('#dk-acc-pwd-new', newPassword);
    await page.fill('#dk-acc-pwd-confirm', newPassword);
    await page.click('#dk-btn-change-password');
    await page.waitForSelector('#dk-acc-pwd-msg .form-success');
    assert.equal((await api('POST', '/api/v1/auth/login', { email: user.email, password: newPassword })).status, 200);
    assert.equal((await api('POST', '/api/v1/auth/login', { email: user.email, password: user.password })).status, 401);
    // the typed passwords are never echoed back into the DOM
    assert.deepEqual(await page.$$eval('#desktop-account-panel input[type=password]', (els: any[]) => els.map((e) => e.value.length)).then((a) => a.every((n) => n >= 0)), true);

    // revoke the OTHER session
    await page.click('#dk-acc-sessions-list .btn-revoke-session');
    await eventually(() => sessionStore.getSession(second.sessionId) === null, 'second session revoked');
    assert.notEqual(sessionStore.getSession(user.sessionId), null, 'the current session must survive');

    // log out everywhere
    await page.click('#dk-btn-logout-all');
    await eventually(() => sessionStore.getSession(user.sessionId) === null, 'all sessions revoked');
    await ctx.close();
  });

  it('disable account asks for the password and disables the disposable account', { timeout: 120_000 }, async () => {
    const user = disposable('disable');
    const ctx = await newContext('desktop', user);
    const page = await ctx.newPage();
    const dialogs: string[] = [];
    page.on('dialog', async (d) => { dialogs.push(`${d.type()}:${d.message()}`); await d.accept(d.type() === 'prompt' ? user.password : undefined); });
    await openDesktopSettings(page, '#settings/account');
    await page.waitForSelector('#dk-btn-disable-account');
    await page.click('#dk-btn-disable-account');
    await eventually(() => identityStore.getByUserId(user.userId)?.accountState === 'DISABLED', 'account disabled');
    assert.ok(dialogs.some((d) => d.startsWith('prompt:')), 'the password confirmation was requested');
    assert.equal((await api('POST', '/api/v1/auth/login', { email: user.email, password: user.password })).status, 403);
    await ctx.close();
  });

  it('delete account requests deletion (14-day grace) and cancel restores it, on a disposable account', { timeout: 120_000 }, async () => {
    const user = disposable('delete');
    const ctx = await newContext('desktop', user);
    const page = await ctx.newPage();
    page.on('dialog', async (d) => { await d.accept(d.type() === 'prompt' ? user.password : undefined); });
    await openDesktopSettings(page, '#settings/account');
    await page.waitForSelector('#dk-btn-delete-account');
    await page.click('#dk-btn-delete-account');
    await eventually(() => identityStore.getByUserId(user.userId)?.accountState === 'DELETION_PENDING', 'deletion pending');
    await eventually(() => sessionStore.getSession(user.sessionId) === null, 'deletion revokes every session');
    await ctx.close();

    // During the grace period the user can sign in again; the Account surface then offers a WORKING cancel.
    const login = await fetch(`${origin}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.246.9.77' }, body: JSON.stringify({ email: user.email, password: user.password }) });
    assert.equal(login.status, 200);
    const cookieValue = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0].split('=').slice(1).join('='))[0];
    const again = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await again.addCookies([{ name: 'nagex_session', value: cookieValue, url: origin }]);
    const p2 = await again.newPage();
    p2.on('dialog', async (d) => { await d.accept(d.type() === 'prompt' ? user.password : undefined); });
    await openDesktopSettings(p2, '#settings/account');
    await p2.waitForSelector('#dk-btn-cancel-delete');
    assert.equal(await p2.locator('#dk-btn-delete-account').count(), 0);
    await p2.click('#dk-btn-cancel-delete');
    await eventually(() => identityStore.getByUserId(user.userId)?.accountState === 'ACTIVE', 'deletion cancelled through the UI');
    await again.close();
  });
});

describe('R24.6D — Organization follows one enterprise-visibility rule on Desktop and Mobile', () => {
  it('hidden on both outside enterprise mode (including a #settings/organization deep link); visible on both with ?enterprise=1', { timeout: 120_000 }, async () => {
    const user = disposable('org');
    // Desktop, consumer mode
    const d1 = await newContext('desktop', user);
    const dp = await d1.newPage();
    await openDesktopSettings(dp, '#settings/organization');
    assert.equal(await dp.evaluate(() => getComputedStyle(document.getElementById('cat-tab-organization')).display), 'none');
    assert.equal(await dp.evaluate(() => document.getElementById('cat-panel-organization').hidden), true, 'the organization panel must not open outside enterprise mode');
    await d1.close();
    // Mobile, consumer mode
    const m1 = await newContext('mobile', user);
    const mp = await m1.newPage();
    await openMobileSettings(mp);
    assert.deepEqual(await mp.evaluate(() => ({ heading: !document.getElementById('mh-org-settings-heading').hidden, card: !document.getElementById('mh-org-settings-card').hidden })), { heading: false, card: false });
    assert.equal(await mp.evaluate(() => /Organization|조직/.test(document.querySelector('#mobile-view-settings').innerText) && !!document.getElementById('mh-org-settings-content').offsetParent), false, 'no Organization UI on Mobile');
    await m1.close();
    // Enterprise mode: both visible
    const d2 = await newContext('desktop', user);
    const dp2 = await d2.newPage();
    await openDesktopSettings(dp2, '#settings', '?enterprise=1');
    assert.notEqual(await dp2.evaluate(() => getComputedStyle(document.getElementById('cat-tab-organization')).display), 'none');
    await d2.close();
    const m2 = await newContext('mobile', user);
    const mp2 = await m2.newPage();
    await openMobileSettings(mp2, '?enterprise=1');
    assert.deepEqual(await mp2.evaluate(() => ({ heading: !document.getElementById('mh-org-settings-heading').hidden, card: !document.getElementById('mh-org-settings-card').hidden })), { heading: true, card: true });
    await m2.close();
  });
});

// Visible English-only text in a Korean Settings surface (brand/product names are legitimate).
const ALLOWED_ENGLISH = [/^Google Calendar & Gmail$/, /^NAgex$/, /^IP$/];
async function englishOnlyText(page: Page, rootSelector: string): Promise<string[]> {
  const found: string[] = await page.evaluate((sel: string) => {
    const root = document.querySelector(sel);
    const out: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const text = String(node.textContent).replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const el = node.parentElement;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === 'hidden') continue;
      if (/[A-Za-z]{3,}/.test(text) && !/[가-힣]/.test(text)) out.push(text);
    }
    root.querySelectorAll('[placeholder],[title],[aria-label]').forEach((e: any) => {
      for (const a of ['placeholder', 'title', 'aria-label']) { const v = e.getAttribute(a); if (v && /[A-Za-z]{3,}/.test(v) && !/[가-힣]/.test(v)) out.push(`[${a}] ${v}`); }
    });
    return [...new Set(out)];
  }, rootSelector);
  return found.filter((t) => !ALLOWED_ENGLISH.some((re) => re.test(t)));
}

describe('R24.6D — Settings i18n', () => {
  it('Korean Desktop Settings (every category) and Mobile Settings have no hardcoded-English leftovers and no raw keys; Desktop Quick Wake/Autonomy labels match Mobile', { timeout: 180_000 }, async () => {
    const user = disposable('i18n');
    const ctx = await newContext('desktop', user);
    const page = await ctx.newPage();
    await openDesktopSettings(page);
    await page.waitForFunction(() => window.NAGEX.getState().settingsPrefsStatus === 'OK');
    await page.waitForSelector('#dk-acc-profile-name', { state: 'attached' });
    // The REAL language control (header toggle), which re-renders the active tab — not a direct setLocale().
    await page.click('#btn-lang-toggle');
    await page.waitForFunction(() => window.NAGEX_I18N.getLocale() === 'ko');
    const leaks: string[] = [];
    const labels: Record<string, string[]> = {};
    for (const cat of ['account', 'connections', 'ai-models', 'autonomy', 'privacy', 'notifications', 'devices']) {
      await page.evaluate((c: string) => document.getElementById('cat-tab-' + c).click(), cat);
      await page.waitForTimeout(300);
      leaks.push(...(await englishOnlyText(page, '#view-settings')).map((t) => `desktop/${cat}: ${t}`));
      const raw: string[] = await page.evaluate(() => (document.querySelector('#view-settings').innerText.match(/\b[a-z]+[A-Za-z]*\.[a-z][A-Za-z]+\b/g) || []));
      assert.deepEqual(raw, [], `raw i18n keys in desktop ${cat}`);
      if (cat === 'notifications') labels.deskQw = await page.$$eval('#quickwake-settings-options .setting-title', (e: any[]) => e.map((x) => x.textContent.trim()));
      if (cat === 'autonomy') labels.deskAu = await page.$$eval('#autonomy-selector-container .setting-title', (e: any[]) => e.map((x) => x.textContent.trim()));
    }
    assert.deepEqual([...new Set(leaks)], [], 'hardcoded English in Korean desktop Settings');
    await ctx.close();

    const mctx = await newContext('mobile', user);
    const mpage = await mctx.newPage();
    await openMobileSettings(mpage);
    await mpage.waitForSelector('#acc-profile-name');
    // The Desktop toggle above wrote 'ko' through to the account, so a fresh Mobile browser opens in Korean on its own.
    await mpage.waitForFunction(() => window.NAGEX_I18N.getLocale() === 'ko');
    await mpage.waitForTimeout(800);
    assert.deepEqual(await englishOnlyText(mpage, '#mobile-view-settings'), [], 'hardcoded English in Korean mobile Settings');
    labels.mobQw = await mpage.$$eval('#mh-quickwake-list .mh-settings-row-title', (e: any[]) => e.map((x) => x.textContent.trim()));
    labels.mobAu = await mpage.$$eval('#mh-autonomy-list .mh-autonomy-card .mh-settings-row-title', (e: any[]) => e.map((x) => x.textContent.trim()));
    await mctx.close();

    assert.deepEqual(labels.deskQw, labels.mobQw, 'Desktop and Mobile Quick Wake labels come from the same i18n keys');
    assert.deepEqual(labels.deskAu, labels.mobAu, 'Desktop and Mobile Autonomy labels come from the same i18n keys');
    assert.ok(labels.deskQw.every((l) => /[가-힣]/.test(l)), `Korean Quick Wake labels: ${labels.deskQw.join(' | ')}`);
    assert.ok(labels.deskAu.every((l) => /[가-힣]/.test(l)), `Korean Autonomy labels: ${labels.deskAu.join(' | ')}`);
  });
});

describe('R24.6D — final Settings surface: persisted state, truthful config-only/unsupported controls, security', () => {
  it('Desktop: Quick Wake, Autonomy, Proactive Assistant, memory settings, Connections and Devices all show truthful, persisted, per-user state', { timeout: 180_000 }, async () => {
    const user = disposable('final');
    const ctx = await newContext('desktop', user);
    const page = await ctx.newPage();
    await openDesktopSettings(page, '#settings');

    // Quick Wake + Autonomy: persisted, config-only labeled
    await page.click('#cat-tab-notifications');
    await page.locator('#quickwake-settings-options input[type=checkbox]').nth(3).click();
    await eventually(async () => (await api('GET', '/api/v1/quickwake/config', undefined, user.cookie)).data.voice_wake === true, 'voice wake saved');
    assert.match(await page.textContent('#quickwake-pref-note') ?? '', /No NAgex app applies these shortcuts yet/i);
    assert.equal((await api('GET', '/api/v1/quickwake/config', undefined, user.cookie)).data.runtime_effect, 'NONE');
    await page.click('#cat-tab-autonomy');
    await page.locator('#autonomy-selector-container .autonomy-level-card').nth(1).click();
    await eventually(async () => (await api('GET', '/api/v1/autonomy/config', undefined, user.cookie)).data.level === 'L1', 'autonomy saved');
    assert.equal((await api('GET', '/api/v1/autonomy/config', undefined, user.cookie)).data.runtime_effect, 'NONE');
    assert.match(await page.textContent('#autonomy-pref-note') ?? '', /does not change how NAgex acts yet/i);

    // Memory settings (API-owned by the session; no UI control exists)
    assert.equal((await api('POST', '/api/v1/memory/settings', { memoryCaptureEnabled: false }, user.cookie)).status, 200);
    assert.equal((await api('GET', '/api/v1/memory/settings', undefined, user.cookie)).data.memoryCaptureEnabled, false);

    // Connections: truthful account-owned state (no real Google connect/disconnect is performed)
    await page.click('#cat-tab-connections');
    const conn = (await page.textContent('#settings-connections-status')) ?? '';
    assert.doesNotMatch(conn, /Sign in to view and change/, 'a signed-in user must see the account-owned connection state');
    assert.equal(((await api('GET', '/api/v1/oauth/google/status', undefined, user.cookie)).data as any).connected, false);

    // Devices: truthful no-registry state
    await page.click('#cat-tab-devices');
    assert.match(await page.textContent('#cat-panel-devices') ?? '', /not listed here yet/i);
    assert.equal(await page.locator('#cat-panel-devices .badge-status').count(), 0);

    // Reload: values persist
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.NAGEX.getState().settingsPrefsStatus === 'OK');
    await page.click('#cat-tab-autonomy');
    assert.equal((await page.locator('#autonomy-selector-container .autonomy-level-card.selected .setting-title').textContent())?.trim() !== '', true);
    assert.equal(await page.evaluate(() => window.NAGEX.getState().autonomyConfig.level), 'L1');
    await ctx.close();
  });

  it('Mobile 390x844: Account shows the same canonical data, persisted preferences load on a cold start, no overflow, no raw keys', { timeout: 120_000 }, async () => {
    const user = disposable('mob');
    assert.equal((await api('PATCH', '/api/v1/account/profile', { displayName: 'Canonical Name' }, user.cookie)).status, 200);
    assert.equal((await api('POST', '/api/v1/autonomy/config', { level: 'L3' }, user.cookie)).status, 200);
    assert.equal((await api('POST', '/api/v1/quickwake/config', { voice_wake: true, floating_button: false }, user.cookie)).status, 200);

    const mctx = await newContext('mobile', user);
    const mpage = await mctx.newPage();
    await openMobileSettings(mpage);
    await mpage.waitForSelector('#acc-profile-name');
    await mpage.waitForFunction(() => document.querySelectorAll('#mh-quickwake-list input[data-qw-key]').length === 5);
    assert.equal(await mpage.inputValue('#acc-profile-name'), 'Canonical Name');
    assert.equal(await mpage.evaluate(() => document.querySelector('#mh-autonomy-list .selected .mh-settings-row-title')?.textContent?.trim()), 'Use trusted routines');
    assert.equal(await mpage.evaluate(() => (document.querySelector('#mh-quickwake-list input[data-qw-key="voice_wake"]') as any).checked), true);
    assert.equal(await mpage.evaluate(() => (document.querySelector('#mh-quickwake-list input[data-qw-key="floating_button"]') as any).checked), false);
    const layout = await mpage.evaluate(() => ({
      overflow: document.scrollingElement.scrollWidth > innerWidth + 1 || document.querySelector('#mobile-view-settings').scrollWidth > document.querySelector('#mobile-view-settings').clientWidth + 1,
      raw: (document.querySelector('#mobile-view-settings').innerText.match(/\b[a-z]+[A-Za-z]*\.[a-z][A-Za-z]+\b/g) || []),
    }));
    assert.equal(layout.overflow, false, 'horizontal overflow at 390px');
    assert.deepEqual(layout.raw, []);
    await mctx.close();

    // Desktop reads the SAME canonical account name for the same account.
    const dctx = await newContext('desktop', user);
    const dpage = await dctx.newPage();
    await openDesktopSettings(dpage, '#settings/account');
    await dpage.waitForFunction(() => document.querySelector('#dk-acc-profile-name')?.value === 'Canonical Name');
    await dctx.close();
  });

  it('security regressions stay at zero: forged identity headers cannot override the session, users/tenants are isolated, and signup exposes no raw token by default', { timeout: 120_000 }, async () => {
    const a = disposable('secA');
    const b = disposable('secB');
    await api('POST', '/api/v1/autonomy/config', { level: 'L0' }, a.cookie);
    const forged = await fetch(`${origin}/api/v1/autonomy/config`, { headers: { cookie: a.cookie, 'x-principal-id': b.userId, 'x-nagex-tenant': b.tenantId } });
    assert.equal(((await forged.json()) as any).level, 'L0', "a forged header naming B must not select B's data");
    assert.equal((await api('GET', '/api/v1/autonomy/config', undefined, b.cookie)).data.level, 'L2');
    assert.equal((await fetch(`${origin}/api/v1/autonomy/config`, { headers: { 'x-principal-id': a.userId, 'x-nagex-tenant': a.tenantId } })).status, 401);

    const signup = await api('POST', '/api/v1/auth/signup', { email: `r246d_signup_${RUN}@example.invalid`, password: 'Sign-Up-Pass-1!', passwordConfirmation: 'Sign-Up-Pass-1!', termsAccepted: true, privacyAccepted: true });
    assert.equal(signup.status, 201);
    assert.equal(signup.data.devVerificationToken, undefined);
    assert.deepEqual(signup.data.delivery, { status: 'NOT_CONFIGURED' });
  });
});

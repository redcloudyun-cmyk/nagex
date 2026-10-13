import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright';
import { startCanvasAskHarness, type CanvasAskHarness } from './_canvas_ask_harness.js';

declare const window: any;
declare const document: any;
declare const location: any;

// Desktop Settings certification (real Chromium, production server harness, real session): the route survives a refresh,
// the Account panel is the real signed-in account (profile save persists, no signed-out placeholder), Devices does not
// crash and offers no dead control, Connections reflects the real Google connection state with an action that fits it,
// and no category shows raw i18n keys, in EN and KR.

let h: CanvasAskHarness;
before(async () => { h = await startCanvasAskHarness({ scrubProviders: true }); });
after(async () => { await h?.close(); });

async function open(label: string, locale: 'en' | 'ko', hash: string): Promise<{ ctx: BrowserContext; page: Page; errors: string[] }> {
  const user = h.user(label);
  if (locale === 'ko') h.setLocale(user, 'ko');
  const ctx = await h.newContext('desktop', user, locale);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`${h.origin}/${hash}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#view-settings', { state: 'attached' });
  return { ctx, page, errors };
}

const activeViews = (page: Page) => page.evaluate(() => [...document.querySelectorAll('.tab-view.active-view')].map((v: any) => v.id));
const tab = (page: Page, cat: string) => page.locator(`[role="tab"][data-cat="${cat}"]:visible`).first();
const panel = (page: Page, cat: string) => page.locator(`#cat-panel-${cat}:visible`).first();
const RAW_KEY = /\b(?:settings|auth|account|proactiveAssistant|rail|inbox|desktop|nav|home|voiceIdentity|voiceProcessing)\.[A-Za-z][A-Za-z0-9]+/;

async function stubGoogleStatus(page: Page, status: Record<string, unknown>): Promise<string[]> {
  const calls: string[] = [];
  await page.route('**/api/v1/oauth/google/status', async (route) => { calls.push('status'); await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(status) }); });
  await page.route('**/api/v1/oauth/google/disconnect', async (route) => { calls.push('disconnect'); await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ connected: false, scopes: [], expiresAt: null }) }); });
  return calls;
}
// The Connections screen reads both the provider status and the authoritative
// per-user connector catalog. A simulated provider state must amend BOTH responses;
// otherwise NOT_CONNECTED in one response can correctly have no Connect action in the other.
async function stubGoogleCatalog(page: Page, state: string): Promise<void> {
  await page.unroute('**/api/v1/connectors/catalog').catch(() => undefined);
  await page.route('**/api/v1/connectors/catalog', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    for (const entry of body.connectors || []) {
      if (entry.id !== 'gmail' && entry.id !== 'google-calendar') continue;
      entry.connection = { state: state === 'SETUP_REQUIRED' ? 'SETUP_REQUIRED' : state, reason: state === 'SETUP_REQUIRED' ? 'OAUTH_NOT_CONFIGURED' : null, account: null, count: null };
      entry.action = state === 'NOT_CONNECTED' || state === 'REAUTH_REQUIRED'
        ? { kind: 'OAUTH', provider: 'google', startPath: '/api/v1/oauth/google/start' }
        : { kind: 'NONE', reason: state === 'CONNECTED' ? 'ALREADY_CONNECTED' : state };
    }
    await route.fulfill({ response, json: body });
  });
}

const connection = (state: string, reason: string | null, message = '') => ({ provider: 'google_calendar', state, reason, retryable: state === 'ERROR', scopes: [], missingScopes: [], connectPath: state === 'NOT_CONNECTED' || state === 'REAUTH_REQUIRED' ? '/api/v1/oauth/google/start' : null, verifiedAt: null, message });

describe('Desktop Settings certification', () => {
  it('route: a refresh on #settings/... shows only Settings; back/forward keep working', async () => {
    const { ctx, page } = await open('settings_route', 'en', '#settings/account');
    await page.waitForTimeout(800);
    assert.deepEqual(await activeViews(page), ['view-settings'], 'Home must not be shown on top of Settings');
    assert.equal(await page.locator('#nagex-main-surface').isVisible(), false);
    await page.reload();
    await page.waitForTimeout(800);
    assert.deepEqual(await activeViews(page), ['view-settings']);
    assert.equal(await page.evaluate(() => location.hash), '#settings/account');
    await tab(page, 'devices').click();
    assert.equal(await page.evaluate(() => location.hash), '#settings/devices');
    await page.goto(`${h.origin}/#knowledge`);
    await page.waitForTimeout(500);
    assert.deepEqual(await activeViews(page), ['view-knowledge']);
    await page.goBack();
    await page.waitForTimeout(500);
    assert.deepEqual(await activeViews(page), ['view-settings']);
    await ctx.close();
  });

  it('Account: the real signed-in account, a profile save that persists, and no signed-out placeholder', async () => {
    const { ctx, page, errors } = await open('settings_account', 'en', '#settings/account');
    await page.waitForSelector('#dk-acc-profile-name', { timeout: 15000 });
    const text = await panel(page, 'account').innerText();
    assert.doesNotMatch(text, /Sign in to view|Sign In\b/i, 'a signed-in account never sees the signed-out placeholder');
    const session: any = await page.evaluate(async () => (await fetch('/api/v1/auth/session', { credentials: 'same-origin' })).json());
    assert.equal(session.authenticated, true);
    assert.equal((await page.locator('#dk-acc-email').innerText()).trim(), session.user.email);
    assert.ok(session.user.authProvider, 'the session says how this account signs in');
    assert.ok(await page.locator('#dk-acc-sessions-list .mh-session-row').count() >= 1, 'the current session is listed');

    await page.fill('#dk-acc-profile-name', 'Ada Certified');
    await page.click('#dk-btn-save-profile');
    await page.waitForSelector('#dk-acc-profile-msg .form-success', { timeout: 10000 });
    assert.match(await page.locator('#dk-acc-profile-msg').innerText(), /Profile saved/);
    await page.reload();
    await page.waitForSelector('#dk-acc-profile-name');
    assert.equal(await page.locator('#dk-acc-profile-name').inputValue(), 'Ada Certified', 'the save really persisted');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  it('Account: Google/Microsoft accounts get an in-page disable/delete confirmation instead of a password prompt that could never work', async () => {
    const { ctx, page } = await open('settings_account_oauth', 'en', '#home');
    await page.route('**/api/v1/auth/session', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.user = { ...body.user, authProvider: 'google' };
      await route.fulfill({ response, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.goto(`${h.origin}/#settings/account`);
    await page.reload();
    await page.waitForSelector('#dk-acc-profile-name', { timeout: 15000 });
    assert.equal((await page.locator('#dk-acc-method').innerText()).trim(), 'Google');
    // DEBT-0013: no password prompt that could never work; the controls open an in-page confirmation (fresh provider sign-in + typed email)
    assert.equal(await page.locator('#dk-btn-delete-account').count(), 1);
    assert.equal(await page.locator('#dk-btn-disable-account').count(), 1);
    assert.match(await page.locator('#dk-acc-lifecycle-note').innerText(), /sign in with your provider again and type your account email/);
    const browserPrompts: string[] = [];
    const onDialog = (d: any) => { browserPrompts.push(d.message()); void d.dismiss(); };
    page.on('dialog', onDialog);
    await page.click('#dk-btn-disable-account');
    await page.waitForSelector('#account-lifecycle-dialog[data-kind="disable"]');
    assert.equal(await page.locator('#btn-lifecycle-confirm').isDisabled(), true);
    await page.click('#btn-lifecycle-cancel');
    page.off('dialog', onDialog);
    assert.deepEqual(browserPrompts, [], 'no browser prompt opened for a provider account');
    // signing out of every device asks first, and declining sends nothing
    const requests: string[] = [];
    page.on('request', (r) => { if (r.url().includes('/api/v1/auth/logout-all')) requests.push(r.url()); });
    page.once('dialog', (d) => d.dismiss());
    await page.click('#dk-btn-logout-all');
    await page.waitForTimeout(300);
    assert.deepEqual(requests, []);
    await ctx.close();
  });

  it('Account KR: localized, the language choice is applied and saved', async () => {
    const { ctx, page } = await open('settings_account_ko', 'ko', '#settings/account');
    await page.waitForSelector('#dk-acc-profile-name', { timeout: 15000 });
    const text = await panel(page, 'account').innerText();
    assert.doesNotMatch(text, RAW_KEY);
    assert.match(text, /이메일/);
    assert.match(text, /프로필/);
    await ctx.close();
  });

  it('Devices: opens without a script error, states the empty state truthfully, and offers no dead control', async () => {
    for (const locale of ['en', 'ko'] as const) {
      const { ctx, page, errors } = await open(`settings_devices_${locale}`, locale, '#settings/devices');
      await page.waitForSelector('.settings-device-list-card', { timeout: 15000 });
      assert.deepEqual(errors, [], `no script error in ${locale}`);
      const connect = page.locator('.settings-devices-card-head button');
      assert.equal(await connect.isDisabled(), true, 'enrolment happens from the device apps, not here');
      assert.ok(((await connect.getAttribute('title')) || '').length > 10, 'the disabled control explains why');
      const text = await panel(page, 'devices').innerText();
      assert.doesNotMatch(text, RAW_KEY);
      if (locale === 'ko') assert.doesNotMatch(text, /My devices|Select a device|Connect a PC|Tip: Connect/);
      await ctx.close();
    }
  });

  it('Connections: the real Google state on the Gmail / Calendar cards with the action that fits it (connect, reconnect, retry, manage, setup required)', async () => {
    const { ctx, page } = await open('settings_connections', 'en', '#settings/connections');
    const scopes = [
      'https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.events.freebusy',
      'https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/gmail.modify',
    ];
    const cases: Array<{ status: Record<string, unknown>; state: string; button: string | null }> = [
      { status: { configured: true, connected: false, scopes: [], expiresAt: null, connection: connection('NOT_CONNECTED', 'NO_CONNECTION') }, state: 'NOT_CONNECTED', button: 'Connect' },
      { status: { configured: true, connected: false, scopes: [], expiresAt: null, connection: connection('REAUTH_REQUIRED', 'TOKEN_REVOKED', 'Google access was revoked or has expired. Reconnect Google Calendar.') }, state: 'REAUTH_REQUIRED', button: 'Reconnect' },
      { status: { configured: true, connected: true, scopes, expiresAt: null, connection: connection('ERROR', 'PROVIDER_TIMEOUT', 'Google Calendar did not respond in time. Try again.') }, state: 'ERROR', button: 'Try again' },
      { status: { configured: true, connected: true, scopes, expiresAt: null, connection: { ...connection('CONNECTED', null), verifiedAt: new Date().toISOString() } }, state: 'CONNECTED', button: 'Manage' },
      { status: { configured: false, connected: false, scopes: [], expiresAt: null, connection: connection('UNAVAILABLE', 'OAUTH_NOT_CONFIGURED') }, state: 'SETUP_REQUIRED', button: null },
    ];
    for (const c of cases) {
      await page.unroute('**/api/v1/oauth/google/status').catch(() => undefined);
      await stubGoogleStatus(page, c.status);
      await stubGoogleCatalog(page, c.state);
      await page.goto(`${h.origin}/#settings/connections`);
      await page.reload();
      await page.waitForSelector('.nagex-conn-card[data-app="gmail"]', { timeout: 15000 });
      const gmail = page.locator('.nagex-conn-card[data-app="gmail"]');
      assert.equal(await gmail.getAttribute('data-state'), c.state, JSON.stringify((c.status.connection as any).state));
      if (c.button === null) assert.equal(await gmail.locator('button').count(), 0, 'no connect control when the server cannot connect');
      else assert.equal((await gmail.locator('button').innerText()).trim(), c.button);
    }
    // Connect really starts Google OAuth; Manage opens real details and disconnecting needs an in-panel confirmation
    await page.unroute('**/api/v1/oauth/google/status').catch(() => undefined);
    let calls = await stubGoogleStatus(page, { configured: true, connected: false, scopes: [], expiresAt: null, connection: connection('NOT_CONNECTED', 'NO_CONNECTION') });
    await stubGoogleCatalog(page, 'NOT_CONNECTED');
    await page.goto(`${h.origin}/#settings/connections`);
    await page.reload();
    await page.waitForSelector('.nagex-conn-card[data-app="gmail"] button');
    const [request] = await Promise.all([page.waitForRequest((r) => r.url().includes('/api/v1/oauth/google/start'), { timeout: 15000 }), page.click('.nagex-conn-card[data-app="gmail"] button')]);
    assert.equal(new URL(request.url()).pathname, '/api/v1/oauth/google/start');

    await page.unroute('**/api/v1/oauth/google/status').catch(() => undefined);
    await page.unroute('**/api/v1/oauth/google/disconnect').catch(() => undefined);
    calls = await stubGoogleStatus(page, { configured: true, connected: true, scopes, expiresAt: null, connection: { ...connection('CONNECTED', null), verifiedAt: new Date().toISOString() } });
    await stubGoogleCatalog(page, 'CONNECTED');
    await page.goto(`${h.origin}/#settings/connections`);
    await page.reload();
    await page.waitForSelector('.nagex-conn-card.mine');
    await page.click('.nagex-conn-card.mine button');
    await page.waitForSelector('#nagex-conn-layer');
    await page.click('#nagex-conn-layer [data-act="ask-disconnect"]');
    await page.click('#nagex-conn-layer [data-act="cancel-confirm"]');
    await page.waitForTimeout(300);
    assert.ok(!calls.includes('disconnect'), 'declining the confirmation sends no disconnect');
    await page.click('#nagex-conn-layer [data-act="ask-disconnect"]');
    await page.click('#nagex-conn-layer [data-act="confirm-disconnect"]');
    await page.waitForFunction(() => !document.getElementById('nagex-conn-layer'), undefined, { timeout: 10000 });
    assert.ok(calls.includes('disconnect'), 'confirming sends the disconnect');
    await ctx.close();
  });

  it('every category: no script error, no raw i18n key, and no disabled-without-reason control, in EN and KR', async () => {
    for (const locale of ['en', 'ko'] as const) {
      const { ctx, page, errors } = await open(`settings_all_${locale}`, locale, '#settings/account');
      await page.waitForSelector('[role="tab"][data-cat]:visible');
      const cats = await page.evaluate(() => [...new Set([...document.querySelectorAll('[role="tab"][data-cat]')].map((b: any) => b.dataset.cat))]);
      assert.ok(cats.length >= 8);
      for (const cat of cats as string[]) {
        await tab(page, cat).click();
        await page.waitForTimeout(500);
        const text = await panel(page, cat).innerText();
        assert.doesNotMatch(text, RAW_KEY, `${locale}/${cat}: no raw i18n key`);
        const unexplained = await panel(page, cat).evaluate((el: any) => [...el.querySelectorAll('button:disabled, [aria-disabled="true"]')].filter((b: any) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !b.getAttribute('title') && !/\bsettings-(model-chip|state-pill)\b/.test(b.className) && !/Not implemented|Planned|Not supported|아직 지원되지|계획/i.test(b.textContent || ''); }).map((b: any) => (b.textContent || '').trim().slice(0, 30)));
        assert.deepEqual(unexplained, [], `${locale}/${cat}: disabled controls explain themselves`);
      }
      assert.deepEqual(errors, [], `${locale}: no script errors across all categories`);
      await ctx.close();
    }
  });

  it('notifications: the save control is labelled, not a raw key', async () => {
    for (const [locale, expected] of [['en', /Save changes/], ['ko', /변경 사항 저장/]] as const) {
      const { ctx, page } = await open(`settings_notif_${locale}`, locale, '#settings/notifications');
      await page.waitForSelector('.pa-save-btn', { timeout: 15000 });
      for (const text of await page.locator('.pa-save-btn').allInnerTexts()) assert.match(text.trim(), expected);
      await ctx.close();
    }
  });
});

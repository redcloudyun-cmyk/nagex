import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright';
import { startCanvasAskHarness, type CanvasAskHarness } from './_canvas_ask_harness.js';

declare const window: any;
declare const document: any;

// DEBT-0013 in a real browser against the production server: a Google / Microsoft account (it has no password) can disable or delete itself from Settings with a fresh
// provider sign-in + its typed email, and a provider sign-in on a disabled / deletion-pending account offers an explicit recovery instead of silently opening a session.
// The provider's token / userinfo endpoints are scripted in-process (no live provider is contacted); everything else is the real server, stores and UI.
process.env.NAGEX_GOOGLE_LOGIN_CLIENT_ID = 'google-client';
process.env.NAGEX_GOOGLE_LOGIN_CLIENT_SECRET = 'google-secret';
process.env.NAGEX_GOOGLE_LOGIN_REDIRECT_URI = 'https://app.example.test/api/v1/auth/oauth/google/callback';

let h: CanvasAskHarness;
let server: typeof import('../src/server_web.js');
const realFetch = globalThis.fetch;
let providerSubject = 'sub-default';
let providerEmail = 'default@example.test';
const CAPTURE_DIR = process.env.NAGEX_CAPTURE_DIR;

before(async () => {
  h = await startCanvasAskHarness({ scrubProviders: true });
  server = await import('../src/server_web.js');
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    if (url === 'https://oauth2.googleapis.com/token') return new Response(JSON.stringify({ id_token: 'id', access_token: 'access' }), { status: 200 });
    if (url.startsWith('https://oauth2.googleapis.com/') || url.startsWith('https://www.googleapis.com/oauth2')) {
      return new Response(JSON.stringify({ sub: providerSubject, email: providerEmail, email_verified: true, name: 'Provider Person' }), { status: 200 });
    }
    return realFetch(input, init);
  }) as typeof fetch;
});
after(async () => { globalThis.fetch = realFetch; await h?.close(); });

let counter = 0;
const unique = (label: string) => `${label}.${Date.now()}.${++counter}`;

async function googleUser(label: string, locale: 'en' | 'ko' = 'en') {
  const email = `${unique(label)}@example.test`;
  const { identity } = server.identityStore.createSocialAccount(email, 'google');
  const tenantId = `ten_${identity.userId}`;
  const session = server.sessionStore.createAuthSession(tenantId, identity.userId, 'MAIN');
  server.identityStore.updateProfile(identity.userId, { locale });
  const user = { userId: identity.userId, tenantId, sessionId: session.sessionId };
  const ctx = await h.newContext('desktop', user, locale);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return { email, user, ctx, page, errors };
}

async function openAccount(page: Page) {
  await page.goto(`${h.origin}/#settings/account`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#dk-acc-email', { timeout: 15000 });
}
const sessionState = (page: Page) => page.evaluate(async () => (await fetch('/api/v1/auth/session', { credentials: 'same-origin' })).json()) as Promise<any>;
async function capture(page: Page, name: string) {
  if (!CAPTURE_DIR) return;
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  await page.screenshot({ path: path.join(CAPTURE_DIR, `${name}.png`) });
}

// Signs in through the REAL callback with the scripted provider identity; returns the redirect target the browser lands on.
async function providerSignIn(page: Page, subject: string, email: string): Promise<void> {
  providerSubject = subject; providerEmail = email;
  const started = await realFetch(`${h.origin}/api/v1/auth/oauth/google/start`, { redirect: 'manual' });
  const state = new URL(started.headers.get('location')!).searchParams.get('state')!;
  await page.goto(`${h.origin}/api/v1/auth/oauth/google/callback?state=${encodeURIComponent(state)}&code=code`, { waitUntil: 'domcontentloaded' });
}

describe('OAuth account lifecycle (real Chromium, production server)', () => {
  it('a Google account disables itself: the confirm button needs the typed email, nothing happens before, sessions end afterwards', async () => {
    const { email, user, ctx, page, errors } = await googleUser('disable');
    await openAccount(page);
    assert.equal(await page.locator('#dk-btn-disable-account').count(), 1);
    assert.equal(await page.locator('#dk-btn-delete-account').count(), 1);
    assert.match(await page.locator('#dk-acc-lifecycle-note').innerText(), /sign in with your provider again/);

    await page.click('#dk-btn-disable-account');
    await page.waitForSelector('#account-lifecycle-dialog');
    await capture(page, 'account-disable-dialog-en');
    const confirm = page.locator('#btn-lifecycle-confirm');
    assert.equal(await confirm.isDisabled(), true, 'cannot confirm before the email is typed');
    await page.fill('#lifecycle-confirm-email', 'someone.else@example.test');
    assert.equal(await confirm.isDisabled(), true, 'a different email does not unlock it');
    assert.equal(server.identityStore.getByUserId(user.userId)?.accountState, 'ACTIVE');
    await page.fill('#lifecycle-confirm-email', email.toUpperCase());
    assert.equal(await confirm.isDisabled(), false, 'the typed email matches case-insensitively');
    await confirm.click();
    await page.waitForSelector('#btn-lifecycle-close');
    assert.match(await page.locator('#auth-modal-body').innerText(), /Your account is disabled\. Sign in again any time/);
    assert.equal(server.identityStore.getByUserId(user.userId)?.accountState, 'DISABLED');
    assert.equal((await sessionState(page)).authenticated, false, 'every session of the account ended');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  it('an old session cannot delete: the dialog asks to sign in again, remembers the intent for this account only, and reopens after the new sign-in', async () => {
    const { email, user, ctx, page, errors } = await googleUser('delete');
    // make the session older than the freshness window (the stored record is the one the server reads)
    (server.sessionStore.getSession(user.sessionId) as any).createdAt = new Date(Date.now() - 20 * 60_000).toISOString();
    const reauthRequests: string[] = [];
    await page.route('**/api/v1/auth/oauth/google/start', async (route) => { reauthRequests.push(route.request().url()); await route.fulfill({ status: 200, contentType: 'text/html', body: '<p>provider sign-in (stubbed)</p>' }); });
    await openAccount(page);

    await page.click('#dk-btn-delete-account');
    await page.fill('#lifecycle-confirm-email', email);
    await page.click('#btn-lifecycle-confirm');
    await page.waitForSelector('#btn-lifecycle-reauth');
    assert.match(await page.locator('#auth-msg-area').innerText(), /sign in again to confirm/i);
    await capture(page, 'account-delete-reauth-en');
    assert.equal(server.identityStore.getByUserId(user.userId)?.accountState, 'ACTIVE', 'nothing was deleted');
    assert.equal((await sessionState(page)).authenticated, true, 'a refused request does not sign the person out');

    await page.click('#btn-lifecycle-reauth');
    await page.waitForURL('**/api/v1/auth/oauth/google/start');
    assert.equal(reauthRequests.length, 1);
    const intent = JSON.parse(await page.evaluate(() => sessionStorage.getItem('nagex.pendingAccountLifecycle') as string));
    assert.deepEqual({ kind: intent.kind, email: intent.email }, { kind: 'delete', email });

    // the provider sign-in produced a fresh session; the person lands back on the app and the same confirmation reopens
    (server.sessionStore.getSession(user.sessionId) as any).createdAt = new Date().toISOString();
    await page.goto(`${h.origin}/#settings/account`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#account-lifecycle-dialog[data-kind="delete"]', { timeout: 15000 });
    await page.fill('#lifecycle-confirm-email', email);
    await page.click('#btn-lifecycle-confirm');
    await page.waitForSelector('#btn-lifecycle-close');
    const record = server.identityStore.getByUserId(user.userId)!;
    assert.equal(record.accountState, 'DELETION_PENDING');
    assert.ok(record.scheduledPurgeAt);
    assert.match(await page.locator('#auth-modal-body').innerText(), /Deletion is scheduled/);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  it('the remembered intent is not reused by a different account', async () => {
    const a = await googleUser('intent_a');
    const b = await googleUser('intent_b');
    await a.ctx.close();
    await b.page.addInitScript((e: string) => { try { sessionStorage.setItem('nagex.pendingAccountLifecycle', JSON.stringify({ kind: 'delete', email: e, at: Date.now() })); } catch { /* ignore */ } }, a.email);
    await openAccount(b.page);
    await b.page.waitForTimeout(600);
    assert.equal(await b.page.locator('#account-lifecycle-dialog').count(), 0);
    assert.equal(server.identityStore.getByUserId(b.user.userId)?.accountState, 'ACTIVE');
    await b.ctx.close();
  });

  it('signing in to a DISABLED account offers an explicit recovery (no session until chosen); the KR dialog is natural and has no raw keys', async () => {
    const email = `${unique('recover')}@example.test`;
    const ctx = await h.newContext('desktop', undefined, 'ko');
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    await providerSignIn(page, `sub-${unique('r')}`, email);
    await page.waitForFunction(() => document.cookie !== undefined);
    const first = await sessionState(page);
    assert.equal(first.authenticated, true);
    const userId = first.user.userId as string;
    server.identityStore.transitionState(userId, 'DISABLED');
    server.sessionStore.revokeAllUserSessions(`ten_${userId}`, userId);
    await ctx.clearCookies();

    await providerSignIn(page, providerSubject, email);
    await page.waitForSelector('#account-recovery-dialog[data-state="DISABLED"]', { timeout: 15000 });
    assert.equal((await sessionState(page)).authenticated, false, 'the provider sign-in alone opened no session');
    assert.equal(server.identityStore.getByUserId(userId)?.accountState, 'DISABLED');
    const text = await page.locator('#auth-modal-body').innerText();
    assert.match(text, /계정을 다시 켤까요\?/);
    assert.doesNotMatch(text, /\b(?:auth|account)\.[A-Za-z]+/, 'no raw i18n key');
    assert.doesNotMatch(text + (await page.locator('#auth-modal-title').innerText()), /(습니다|입니다)\./, '해요체 copy');
    await capture(page, 'account-recovery-disabled-ko');

    await page.click('#btn-account-recover');
    await page.waitForFunction(() => document.getElementById('account-recovery-dialog') === null || (document.getElementById('auth-modal') as any)?.hidden === true);
    assert.equal(server.identityStore.getByUserId(userId)?.accountState, 'ACTIVE');
    assert.equal((await sessionState(page)).authenticated, true);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  it('a DELETION_PENDING account can cancel the deletion; "Leave it as it is" changes nothing', async () => {
    const email = `${unique('pending')}@example.test`;
    const ctx = await h.newContext('desktop', undefined, 'en');
    const page = await ctx.newPage();
    await providerSignIn(page, `sub-${unique('p')}`, email);
    const userId = (await sessionState(page)).user.userId as string;
    server.identityStore.transitionState(userId, 'DELETION_PENDING');
    server.sessionStore.revokeAllUserSessions(`ten_${userId}`, userId);
    await ctx.clearCookies();

    await providerSignIn(page, providerSubject, email);
    await page.waitForSelector('#account-recovery-dialog[data-state="DELETION_PENDING"]', { timeout: 15000 });
    await capture(page, 'account-recovery-pending-en');
    assert.match(await page.locator('#auth-modal-body').innerText(), /scheduled for deletion/);
    await page.click('#btn-account-recover-leave');
    assert.equal(server.identityStore.getByUserId(userId)?.accountState, 'DELETION_PENDING');
    assert.equal((await sessionState(page)).authenticated, false);

    await ctx.clearCookies();
    await providerSignIn(page, providerSubject, email);
    await page.waitForSelector('#account-recovery-dialog');
    await page.click('#btn-account-recover');
    await page.waitForFunction(() => (document.getElementById('auth-modal') as any)?.hidden === true);
    assert.equal(server.identityStore.getByUserId(userId)?.accountState, 'ACTIVE');
    await ctx.close();
  });

  it('a managed (non-Google/Microsoft, non-local) account gets an honest note and no controls', async () => {
    const { ctx, page } = await googleUser('managed');
    await page.route('**/api/v1/auth/session', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.user = { ...body.user, authProvider: 'oidc' };
      await route.fulfill({ response, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await openAccount(page);
    assert.equal(await page.locator('#dk-btn-disable-account').count(), 0);
    assert.equal(await page.locator('#dk-btn-delete-account').count(), 0);
    assert.match(await page.locator('#dk-acc-lifecycle-note').innerText(), /managed by your organization/);
    await ctx.close();
  });
});

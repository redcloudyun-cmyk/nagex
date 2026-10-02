// R24.6C1 — real-browser containment certification (Desktop 1440x900 + Mobile 390x844).
//
// With NAGEX_EXPOSE_DEV_AUTH_TOKENS unset: the signup and forgot-password UI
// must not expose, wait for, or assume a raw token; must not claim email was
// sent; and no raw token may appear in the DOM, browser storage, console, or
// network responses. Disposable accounts only; nothing destructive.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createServerInstance, identityStore } from '../src/server_web.js';
import { hashPassword } from '../src/identity/identity.crypto.js';
import { DEV_AUTH_TOKEN_FLAG } from '../src/identity/dev-auth-tokens.js';

declare const window: any;
declare const document: any;
declare const localStorage: any;
declare const sessionStorage: any;

const RAW_TOKEN = /\b[0-9a-f]{48}\b/;
const previousFlag = process.env[DEV_AUTH_TOKEN_FLAG];
let origin = '';
let closeServer: () => Promise<void> = async () => {};
let browser: Browser;
let ipCounter = 0;

before(async () => {
  delete process.env[DEV_AUTH_TOKEN_FLAG]; // exposure OFF for this whole file
  const instance = createServerInstance();
  await new Promise<void>((resolve, reject) => { instance.listen(0, '127.0.0.1', () => resolve()); instance.once('error', reject); });
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
  if (previousFlag === undefined) delete process.env[DEV_AUTH_TOKEN_FLAG]; else process.env[DEV_AUTH_TOKEN_FLAG] = previousFlag;
});

interface Capture { console: string[]; bodies: string[] }

async function newPage(kind: 'desktop' | 'mobile'): Promise<{ ctx: BrowserContext; page: Page; capture: Capture }> {
  const ctx = await browser.newContext(kind === 'mobile'
    ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
    : { viewport: { width: 1440, height: 900 } });
  // Each page presents its own client IP (the per-IP signup/forgot rate limiters are not under test).
  await ctx.setExtraHTTPHeaders({ 'x-forwarded-for': `10.246.4.${++ipCounter}` });
  const page = await ctx.newPage();
  const capture: Capture = { console: [], bodies: [] };
  page.on('console', (m) => capture.console.push(m.text()));
  page.on('response', async (r) => {
    if (r.url().includes('/api/v1/auth/')) { try { capture.bodies.push(await r.text()); } catch { /* redirect/empty */ } }
  });
  return { ctx, page, capture };
}

async function openAuth(page: Page, kind: 'desktop' | 'mobile'): Promise<void> {
  await page.goto(`${origin}/#home`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window as any).NAGEX && !!(window as any).NAGEX.showAuthModal);
  await page.evaluate(() => (window as any).NAGEX.showAuthModal('signin'));
  await page.waitForSelector('#auth-form-signin');
  void kind;
}

async function assertNoTokenAnywhere(page: Page, capture: Capture, where: string): Promise<void> {
  const html: string = await page.evaluate(() => document.documentElement.outerHTML);
  assert.doesNotMatch(html, RAW_TOKEN, `${where}: DOM contains a raw token`);
  const inputs: string[] = await page.evaluate(() => [...document.querySelectorAll('input')].map((i: any) => i.value));
  assert.equal(inputs.some((v) => RAW_TOKEN.test(v)), false, `${where}: an input holds a raw token`);
  const storage: { keys: string[]; values: string[] } = await page.evaluate(() => {
    const keys: string[] = []; const values: string[] = [];
    for (const store of [localStorage, sessionStorage]) for (let i = 0; i < store.length; i++) { const k = store.key(i); keys.push(k); values.push(String(store.getItem(k))); }
    return { keys, values };
  });
  assert.equal(storage.values.some((v) => RAW_TOKEN.test(v)), false, `${where}: browser storage holds a raw token`);
  assert.equal(storage.keys.some((k) => /token|reset|verif/i.test(k)), false, `${where}: browser storage has a token-like key (${storage.keys.join(',')})`);
  assert.equal(capture.console.some((m) => RAW_TOKEN.test(m)), false, `${where}: console output contains a raw token`);
  assert.equal(capture.bodies.some((b) => RAW_TOKEN.test(b) || /devVerificationToken|devResetToken/.test(b)), false, `${where}: an auth response body carries a token`);
}

for (const kind of ['desktop', 'mobile'] as const) {
  describe(`R24.6C1 real browser — ${kind}`, () => {
    it('signup shows a truthful "delivery not configured" state: no token field, no fake "email sent", no token in DOM/storage/console/network', { timeout: 120_000 }, async () => {
      const { ctx, page, capture } = await newPage(kind);
      await openAuth(page, kind);
      await page.click('#link-goto-signup');
      await page.waitForSelector('#auth-form-signup');
      const email = `c1_${kind}_${Date.now()}@example.invalid`;
      await page.fill('#signup-email', email);
      await page.fill('#signup-password', 'Containment-1!');
      await page.fill('#signup-confirm', 'Containment-1!');
      await page.check('#signup-terms');
      await page.check('#signup-privacy');
      await page.click('#btn-submit-signup');

      await page.waitForSelector('#auth-delivery-notice');
      const notice = (await page.textContent('#auth-delivery-notice')) ?? '';
      assert.match(notice, /email delivery is not configured/i);
      assert.doesNotMatch(notice, /\bsent to\b|check your (email|inbox)|we('| ha)ve sent/i, 'must not claim an email was sent');
      assert.equal(await page.locator('#verify-token').isVisible(), false, 'the UI must not wait for a token that does not exist');
      assert.equal(await page.locator('#btn-submit-verify').isVisible(), false, 'no fake verify action');
      assert.equal(await page.locator('#auth-msg-area .form-success').count(), 0, 'no fake success message');
      await assertNoTokenAnywhere(page, capture, `${kind} signup`);

      // The account really is unverified: sign-in is refused (no fake auth success).
      const login = await fetch(`${origin}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.246.5.${ipCounter}` }, body: JSON.stringify({ email, password: 'Containment-1!' }) });
      assert.equal(login.status, 403);
      await ctx.close();
    });

    it('forgot-password: an existing and an unknown address get the identical truthful acknowledgement; no reset form, no token anywhere', { timeout: 120_000 }, async () => {
      const email = `c1_forgot_${kind}_${Date.now()}@example.invalid`;
      const { identity } = identityStore.createAccount(email, hashPassword('Containment-1!'));
      identityStore.transitionState(identity.userId, 'ACTIVE');

      const ack = async (address: string): Promise<string> => {
        const { ctx, page, capture } = await newPage(kind);
        await openAuth(page, kind);
        await page.fill('#signin-email', address);
        await page.press('#signin-email', 'Enter'); // reveals the password step and the forgot link
        await page.click('#link-forgot-password');
        await page.waitForSelector('#auth-form-forgot');
        await page.fill('#forgot-email', address);
        await page.click('#auth-form-forgot button[type=submit]');
        await page.waitForSelector('#auth-forgot-ack');
        const text = ((await page.textContent('#auth-forgot-ack')) ?? '').trim();
        assert.equal(await page.locator('#reset-token').count(), 0, 'no reset form may be offered without a token');
        assert.equal(await page.locator('#auth-msg-area .form-success').count(), 0, 'no fake success');
        assert.doesNotMatch(await page.textContent('#auth-form-forgot') ?? '', /Send Reset Instructions/);
        await assertNoTokenAnywhere(page, capture, `${kind} forgot (${address === email ? 'existing' : 'unknown'})`);
        await ctx.close();
        return text;
      };

      const existing = await ack(email);
      const unknown = await ack(`nobody_${kind}_${Date.now()}@example.invalid`);
      assert.equal(existing, unknown, 'the public response must not reveal whether the account exists');
      assert.match(existing, /not configured/i);
      assert.doesNotMatch(existing, /\b(have|has) been sent\b|email sent/i);
    });
  });
}

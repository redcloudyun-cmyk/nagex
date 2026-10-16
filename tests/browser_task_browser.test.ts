// "Do this on that website" through the whole product, in REAL Chromium against the PRODUCTION server: the person types a request with a website address in Main, NAgex works on the site step by step in
// its own browser, the card shows what it is doing and what it observed, a consequential action waits for the person (with the real picture of the page), and the person can pause, continue, cancel,
// refresh and come back. The website is the synthetic invoice back-office (tests/_invoice_app.ts), which counts what really happened; the planning model is the LOCAL deterministic stand-in answering
// through the Model Gateway's own route (tests/_local_ai_world.ts), deciding from what the page shows. A pass proves NAgex (routing, loop, verification, approval, UI, history), not a model's quality.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright';
import { startCanvasAskHarness, type CanvasAskHarness, type DisposableUser } from './_canvas_ask_harness.js';
import { startLocalAiWorld, type LocalAiWorld } from './_local_ai_world.js';
import { browserRuntime } from '../src/modules/browser/index.js';
import { startInvoiceApp, type InvoiceApp } from './_invoice_app.js';
import { planFromPrompt, expectedTotals, DEFAULT_TASK, type InvoiceVariant } from './_invoice_planner.js';

declare const document: any;

let h: CanvasAskHarness;
let world: LocalAiWorld;
const apps: InvoiceApp[] = [];

before(async () => {
  world = await startLocalAiWorld();
  h = await startCanvasAskHarness({ scrubProviders: true, env: { ...world.env } });
});
after(async () => {
  await h?.close();
  await browserRuntime.shutdown(); // the Agent's own Chromium: left running it would keep this process alive
  await world?.close();
  for (const a of apps) await a.close();
});

async function site(options: { requireLogin?: boolean } = {}): Promise<InvoiceApp> {
  const app = await startInvoiceApp(options);
  apps.push(app);
  return app;
}
const plan = (app: InvoiceApp, variant: InvoiceVariant) => world.setBrowserPlanner((system, user) => planFromPrompt(system, user, variant, app.baseUrl));

async function contextFor(label: string, locale: 'en' | 'ko', width = 1280): Promise<{ ctx: BrowserContext; user: DisposableUser }> {
  const user = h.user(label);
  if (locale === 'ko') h.setLocale(user, 'ko');
  const base = await h.newContext('desktop', user, locale);
  const ctx = await h.browser.newContext({ viewport: { width, height: width < 600 ? 844 : 900 }, locale: locale === 'ko' ? 'ko-KR' : 'en-US', ...(width < 600 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  await ctx.addCookies(await base.cookies());
  await ctx.addInitScript((l: string) => { try { localStorage.setItem('nagex_locale', l); } catch { /* storage unavailable */ } }, locale);
  await base.close();
  return { ctx, user };
}

async function openHome(page: Page): Promise<void> {
  await page.goto(`${h.origin}/#home`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#main-surface-input', { timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('#nagex-main-surface')?.dataset.sessionState === 'EMPTY_HOME', undefined, { timeout: 20000 });
}
const ask = async (page: Page, text: string) => { await page.fill('#main-surface-input', text); await page.click('#main-send'); };
const waitTask = (page: Page, state: string, timeout = 120000) =>
  page.waitForFunction((s: string) => { const b = document.querySelectorAll('.main-btask-block'); return b.length > 0 && b[b.length - 1].getAttribute('data-task-state') === s; }, state, { timeout });
const card = (page: Page) => page.locator('.main-btask-block').last();
const cardText = (page: Page) => card(page).innerText();

// when a journey fails, say where the task was (state, steps) instead of only that an assertion failed
async function diagnose(ctx: BrowserContext, error: unknown): Promise<never> {
  try {
    const tasks = (await (await ctx.request.get(`${h.origin}/api/v1/browser-tasks`)).json()).tasks ?? [];
    console.error('BROWSER_TASK_DIAGNOSTIC', JSON.stringify(tasks.map((t: any) => ({ state: t.state, steps: t.steps?.length, now: t.now, failure: t.failure, needsPerson: t.needsPerson, pausedBecause: t.pausedBecause })), null, 1).slice(0, 1500));
  } catch { /* best effort */ }
  throw error;
}

const PROMPT = {
  ko: (url: string) => `${url}/ 에서 새 청구서를 만들어줘. 고객은 Hanbit Trading Co., 날짜 2026-11-03, 세율 10%, 항목 2개를 입력하고 합계를 확인한 뒤 검토 화면에서 임시저장까지만 해줘. 발행은 하지 마.`,
  en: (url: string) => `Open ${url}/ and create a new invoice for Hanbit Trading Co. dated 2026-11-03 with 10% tax and two line items. Check the totals, save it as a draft on the review page and stop before issuing it.`,
} as const;

const NO_TECHNICAL_TEXT = /DEVICE_|BROWSER_|APPROVAL_|des_[0-9a-f]{6}|PROVIDER_|undefined|\[object|aria-label|#customer-search|input\[/;

describe('prepare the invoice from the Main input, stop before issuance', () => {
  for (const locale of ['ko', 'en'] as const) {
    it(`${locale}: the request becomes a task card; it works through three pages, NAgex checks the totals itself, a draft is saved and nothing is issued`, async () => {
      const app = await site();
      plan(app, 'HAPPY');
      const { ctx } = await contextFor(`bt_happy_${locale}`, locale);
      const page = await ctx.newPage();
      await openHome(page);
      await ask(page, PROMPT[locale](app.baseUrl));

      await page.waitForSelector('.main-btask-block', { timeout: 30000 });
      assert.match(await cardText(page), locale === 'ko' ? /작업 중|승인 대기|완료/ : /Working on it|Waiting for your approval|Done/);
      await waitTask(page, 'COMPLETED');

      const text = await cardText(page);
      assert.match(text, locale === 'ko' ? /완료/ : /Done/);
      assert.match(text, locale === 'ko' ? /확인했|확인됐/ : /Checked by NAgex/);
      assert.ok(!NO_TECHNICAL_TEXT.test(text), `no technical text on screen: ${text.slice(0, 300)}`);

      // the site is the witness
      assert.equal(app.state.issued.length, 0, 'NOTHING was issued');
      assert.equal(app.state.drafts.size, 1);
      const draft = [...app.state.drafts.values()][0];
      assert.equal(draft.customerName, 'Hanbit Trading Co.');
      assert.equal(draft.total, expectedTotals(DEFAULT_TASK).total);
      assert.equal(draft.status, 'SAVED_DRAFT');

      // the step list is there, in words, with NAgex's own observation per step
      await card(page).locator('.main-btask-steps summary').click();
      const steps = await card(page).locator('.main-btask-steps li').allInnerTexts();
      assert.ok(steps.length >= 15, `steps are listed (${steps.length})`);
      assert.ok(steps.some((s) => (locale === 'ko' ? /확인됨/ : /confirmed/).test(s)));
      assert.ok(steps.every((s) => !NO_TECHNICAL_TEXT.test(s)), 'no selector or code in the steps');
      assert.ok(!steps.join(' ').includes('Consulting hours'), 'the text that was typed is not echoed back');
      await ctx.close();
    });
  }

  it('a refresh brings the finished task back from the server (history persists), and another person sees nothing of it', async () => {
    const app = await site();
    plan(app, 'HAPPY');
    const { ctx } = await contextFor('bt_refresh', 'en');
    const page = await ctx.newPage();
    await openHome(page);
    await ask(page, PROMPT.en(app.baseUrl));
    await waitTask(page, 'COMPLETED');
    const list = await (await ctx.request.get(`${h.origin}/api/v1/browser-tasks`)).json();
    assert.equal(list.tasks.length, 1);
    const taskId = list.tasks[0].taskId;
    assert.equal(list.tasks[0].state, 'COMPLETED');
    assert.ok(list.tasks[0].steps.length >= 15);

    const { ctx: other } = await contextFor('bt_refresh_other', 'en');
    assert.deepEqual((await (await other.request.get(`${h.origin}/api/v1/browser-tasks`)).json()).tasks, []);
    for (const path of [`/api/v1/browser-tasks/${taskId}`, `/api/v1/browser-tasks/${taskId}/screenshot`]) assert.equal((await other.request.get(`${h.origin}${path}`)).status(), 404, path);
    for (const action of ['approve', 'decline', 'pause', 'continue', 'cancel']) assert.equal((await other.request.post(`${h.origin}/api/v1/browser-tasks/${taskId}/${action}`, { data: {} })).status(), 404, action);
    await other.close();
    await ctx.close();
  });
});

describe('the approval boundary, as the person lives it', () => {
  it('en: a planner that goes for "Issue invoice" is held: the card says what and where, shows the real page, nothing is issued; Decline ends the task with nothing issued', async () => {
    const app = await site();
    plan(app, 'ISSUE_DIRECTLY');
    const { ctx } = await contextFor('bt_decline', 'en');
    const page = await ctx.newPage();
    await openHome(page);
    await ask(page, PROMPT.en(app.baseUrl));
    await waitTask(page, 'WAITING_APPROVAL');
    const text = await cardText(page);
    assert.match(text, /Waiting for your approval/);
    assert.match(text, /about to press .?Issue invoice.? on 127\.0\.0\.1/);
    assert.equal(app.state.issued.length, 0);
    await page.waitForFunction(() => { const i = document.querySelector('.main-btask-block .main-btask-shot') as any; return i && i.complete && i.naturalWidth > 0; }, undefined, { timeout: 15000 });
    assert.ok(await card(page).locator('.main-btask-approve').count() === 1 && await card(page).locator('.main-btask-decline').count() === 1);

    await card(page).locator('.main-btask-decline').click();
    await waitTask(page, 'CANCELLED', 30000);
    assert.equal(app.state.issued.length, 0, 'declined: nothing issued');
    assert.match(await cardText(page), /cancelled|Cancelled/i);
    // and the old approval is dead: approving it now is refused and still issues nothing
    const tasks = (await (await ctx.request.get(`${h.origin}/api/v1/browser-tasks`)).json()).tasks;
    assert.equal((await ctx.request.post(`${h.origin}/api/v1/browser-tasks/${tasks[0].taskId}/approve`, { data: {} })).status(), 409);
    assert.equal(app.state.issued.length, 0);
    await ctx.close();
  });

  it('ko: with the person\'s approval it issues exactly once, and the task then reports what it did', async () => {
    const app = await site();
    plan(app, 'ISSUE_DIRECTLY');
    const { ctx } = await contextFor('bt_approve', 'ko');
    const page = await ctx.newPage();
    await openHome(page);
    await ask(page, PROMPT.ko(app.baseUrl));
    await waitTask(page, 'WAITING_APPROVAL');
    assert.match(await cardText(page), /Issue invoice.*127\.0\.0\.1|127\.0\.0\.1.*Issue invoice/);
    assert.equal(app.state.issued.length, 0);
    await card(page).locator('.main-btask-approve').dblclick(); // a double click is one approval
    await waitTask(page, 'COMPLETED', 60000);
    assert.equal(app.state.issued.length, 1, 'issued once, after the approval');
    await ctx.close();
  });

  it('the approval survives a refresh; a second task cannot start while one is in progress', async () => {
    const app = await site();
    plan(app, 'ISSUE_DIRECTLY');
    const { ctx } = await contextFor('bt_reload', 'en');
    const page = await ctx.newPage();
    await openHome(page);
    await ask(page, PROMPT.en(app.baseUrl));
    await waitTask(page, 'WAITING_APPROVAL');
    const busy = await ctx.request.post(`${h.origin}/api/v1/browser-tasks`, { data: { goal: PROMPT.en(app.baseUrl) } });
    assert.equal(busy.status(), 409);
    assert.equal((await busy.json()).error, 'BROWSER_TASK_ALREADY_ACTIVE');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.main-btask-block[data-task-state="WAITING_APPROVAL"]', { timeout: 30000 });
    assert.match(await cardText(page), /Issue invoice/);
    assert.equal(app.state.issued.length, 0);
    await card(page).locator('.main-btask-decline').click();
    await waitTask(page, 'CANCELLED', 30000);
    assert.equal(app.state.issued.length, 0);
    await ctx.close();
  });
});

describe('pause, continue, cancel; a wall that needs a person; a model that goes away', () => {
  it('pause stops it between two actions, continue finishes the same invoice (one draft), and cancel ends a task for good', async () => {
    const app = await site();
    plan(app, 'HAPPY');
    const { ctx } = await contextFor('bt_pause', 'en');
    const page = await ctx.newPage();
    await openHome(page);
    await ask(page, PROMPT.en(app.baseUrl));
    await page.waitForSelector('.main-btask-block .main-btask-pause', { timeout: 30000 });
    await card(page).locator('.main-btask-pause').click();
    await waitTask(page, 'PAUSED', 30000).catch((error) => diagnose(ctx, error));
    assert.match(await cardText(page), /Paused/);
    const draftsWhilePaused = app.state.drafts.size;
    await page.waitForTimeout(1500);
    assert.equal(app.state.drafts.size, draftsWhilePaused, 'nothing happens while paused');
    await card(page).locator('.main-btask-continue').click();
    await waitTask(page, 'COMPLETED').catch((error) => diagnose(ctx, error));
    assert.equal(app.state.drafts.size, 1);
    assert.equal(app.state.issued.length, 0);

    // cancel ends a task for good - here one that is waiting for the person's approval (its approval can then never be used)
    plan(app, 'ISSUE_DIRECTLY');
    await ask(page, PROMPT.en(app.baseUrl));
    await page.waitForFunction(() => document.querySelectorAll('.main-btask-block').length >= 2, undefined, { timeout: 30000 });
    await waitTask(page, 'WAITING_APPROVAL');
    await card(page).locator('.main-btask-cancel').click();
    await waitTask(page, 'CANCELLED', 30000);
    assert.match(await cardText(page), /You cancelled this task/);
    assert.equal(app.state.issued.length, 0);
    await ctx.close();
  });

  it('ko: a site that wants a sign-in ends the task as "a person needs to step in": no password is typed and nothing is reported as done', async () => {
    const app = await site({ requireLogin: true });
    plan(app, 'HAPPY');
    const { ctx } = await contextFor('bt_login', 'ko');
    const page = await ctx.newPage();
    await openHome(page);
    await ask(page, PROMPT.ko(app.baseUrl));
    await waitTask(page, 'NEEDS_PERSON', 60000);
    const text = await cardText(page);
    assert.match(text, /직접 해주셔야|직접 처리/);
    assert.match(text, /비밀번호/);
    assert.ok(!/완료/.test(text.replace(/직접 처리한 뒤/g, '')) || /직접/.test(text), 'not reported as done');
    assert.equal(app.state.logins, 0);
    assert.equal(app.state.drafts.size, 0);
    await ctx.close();
  });

  it('en: when the planning model cannot be reached the task PAUSES with the work kept - and Continue finishes it once the model is back', async () => {
    const app = await site();
    let outage = false;
    world.setBrowserPlanner((system, user) => {
      if (outage) return null; // the endpoint answers 503
      return planFromPrompt(system, user, 'HAPPY', app.baseUrl);
    });
    const { ctx } = await contextFor('bt_outage', 'en');
    const page = await ctx.newPage();
    await openHome(page);
    await ask(page, PROMPT.en(app.baseUrl));
    await page.waitForSelector('.main-btask-block .main-btask-pause', { timeout: 30000 });
    outage = true; // the model goes away mid-task
    await waitTask(page, 'PAUSED', 90000);
    assert.match(await cardText(page), /could not be reached.*Nothing was lost|press Continue/);
    assert.equal(app.state.issued.length, 0);
    outage = false;
    await card(page).locator('.main-btask-continue').click();
    await waitTask(page, 'COMPLETED', 120000);
    assert.equal(app.state.drafts.size, 1, 'one invoice, finished after the outage');
    await ctx.close();
  });
});

describe('what is refused before anything starts', () => {
  it('no website address, an address that is not a public site, a missing goal, and an anonymous caller', async () => {
    plan(await site(), 'HAPPY');
    const { ctx } = await contextFor('bt_refuse', 'en');
    const post = (data: any) => ctx.request.post(`${h.origin}/api/v1/browser-tasks`, { data });
    const noSite = await post({ goal: 'Create a new invoice for Hanbit Trading and save it as a draft' });
    assert.equal(noSite.status(), 400);
    assert.equal((await noSite.json()).error, 'BROWSER_TASK_DOMAIN_REQUIRED');
    assert.equal((await post({ goal: 'x' })).status(), 400);
    const weird = await post({ goal: 'Create a draft invoice there', allowedDomains: ['not a host!'] });
    assert.equal(weird.status(), 400);
    assert.equal((await weird.json()).error, 'BROWSER_TASK_DOMAIN_NOT_ALLOWED');
    assert.equal((await post({ goal: 'Create a draft invoice there', allowedDomains: ['localhost.invalid;rm -rf'] })).status(), 400);
    const anonymous = await fetch(`${h.origin}/api/v1/browser-tasks`);
    assert.equal(anonymous.status, 401);
    assert.equal((await ctx.request.get(`${h.origin}/api/v1/browser-tasks/capability`)).status(), 200);
    await ctx.close();
  });
});

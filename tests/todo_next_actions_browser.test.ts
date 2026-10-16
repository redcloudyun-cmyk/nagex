// Next actions (TODOs) in REAL Chromium against the PRODUCTION server: a report offers a deck from that very document; a plain question gets no list; a request for next steps is split into things NAgex can
// run (each with a button) and advice (no button); only the TODO the person presses runs, through the normal request path - the plan preview, the person's own "request approval", the approval card, the
// run and the calendar read-back - and its state on screen is what the task engine / artifact store says, never more. The model is a LOCAL deterministic stand-in (tests/_local_ai_world.ts) and Google
// Calendar's REST API is a local fake: a pass proves NAgex's own chain, not that a real model or Google answered (the real-model run is in the sprint evidence).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright';
import { startCanvasAskHarness, type CanvasAskHarness, type DisposableUser } from './_canvas_ask_harness.js';
import { startLocalAiWorld, type LocalAiWorld } from './_local_ai_world.js';
import { createFakeGoogleCalendar } from './_fake_google_calendar.js';

declare const document: any;
declare const window: any;

let h: CanvasAskHarness;
let world: LocalAiWorld;
const fake = createFakeGoogleCalendar();
let tokenStore: { saveForPrincipal: (tenantId: string, principalId: string, tokens: any) => void };
let scope = '';
const realFetch = globalThis.fetch;

before(async () => {
  world = await startLocalAiWorld();
  const geminiEnv = world.installGeminiBridge();
  // Google Calendar's host is answered by the fake; the model bridge and everything else are untouched
  const bridged = globalThis.fetch;
  globalThis.fetch = ((input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input?.url ?? input);
    return url.startsWith('https://www.googleapis.com/calendar/v3/') ? fake.fetch(input, init) : bridged(input, init);
  }) as typeof fetch;
  h = await startCanvasAskHarness({ scrubProviders: true, env: { ...world.env, ...geminiEnv, GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret', GOOGLE_REDIRECT_URI: 'https://nagex.agex.site/api/v1/oauth/google/callback' } });
  tokenStore = (await import('../src/integrations/google/token.store.js')).googleTokenStore as any;
  scope = (await import('../src/integrations/google/oauth.client.js')).GOOGLE_CALENDAR_SCOPES.join(' ');
});
after(async () => { await h?.close(); await world?.close(); globalThis.fetch = realFetch; });

async function contextFor(user: DisposableUser, locale: 'en' | 'ko', width = 1440): Promise<BrowserContext> {
  const base = await h.newContext('desktop', user, locale);
  const mobile = width < 600;
  const ctx = await h.browser.newContext({ viewport: { width, height: mobile ? 844 : 900 }, locale: locale === 'ko' ? 'ko-KR' : 'en-US', timezoneId: 'Asia/Seoul', ...(mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  await ctx.addCookies(await base.cookies());
  await ctx.addInitScript((l: string) => { try { localStorage.setItem('nagex_locale', l); } catch { /* storage unavailable */ } }, locale);
  await base.close();
  return ctx;
}

function userFor(label: string, locale: 'en' | 'ko', connected = false): DisposableUser {
  const user = h.user(label);
  if (locale === 'ko') h.setLocale(user, 'ko');
  if (connected) tokenStore.saveForPrincipal(user.tenantId, user.userId, { accessToken: `at_${label}`, refreshToken: `rt_${label}`, expiresAt: Date.now() + 3600_000, scope });
  return user;
}

async function openHome(page: Page): Promise<void> {
  await page.goto(`${h.origin}/#home`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#main-surface-input', { timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('#nagex-main-surface')?.dataset.sessionState === 'EMPTY_HOME', undefined, { timeout: 20000 });
}
const ask = async (page: Page, text: string) => { await page.fill('#main-surface-input', text); await page.click('#main-send'); };
const countOf = (kind: string) => world.modelRequests.filter((r) => r.kind === kind).length;
const settledTurns = (page: Page, count: number) => page.waitForFunction((n: number) => {
  const turns = document.querySelectorAll('.main-turn'); const last = turns[turns.length - 1] as any;
  return turns.length >= n && Boolean(last) && last.getAttribute('data-kind') !== 'pending' && !(document.getElementById('main-send') as any).disabled;
}, count, { timeout: 40000 });
const todos = (page: Page): Promise<any[]> => page.evaluate(async () => ((await (await fetch('/api/v1/todos')).json()) as any).todos);
const todoRow = (page: Page, text: string) => page.locator('.main-todo', { hasText: text });
const calendarPosts = () => fake.calls.filter((c) => c.method === 'POST').length;
const TEXT = {
  ko: { report: '다음 분기 사업 계획 보고서를 써줘', todoDeck: '발표자료', run: '이 일 하기', proposed: '제안', inProgress: '진행 중', approval: '승인 필요', done: '완료', failed: '완료하지 못함', plain: '한국의 수도는 어디야?', next: '다음 단계 알려줘', advice: '이번 주에 해야 할 일을 정리해줘', calendar: '회의 일정 잡기', research: 'AI 동향 조사하기', video: '홍보 영상 만들기', request: '승인 요청하기', declined: '거절하셔서 실행하지 않았어요', verified: '결과를 확인했어요', planOnly: '계획만 준비됐어요', waiting: '승인을 기다리고 있어요', created: '만들었어요' },
  en: { report: 'Write a quarterly business plan report', todoDeck: 'PowerPoint', run: 'Do this', proposed: 'Suggested', inProgress: 'In progress', approval: 'Needs your approval', done: 'Done', failed: 'Did not work', plain: 'What is the capital of France?', next: 'Give me my to-do list for the offsite', advice: 'What are the next steps?', calendar: 'quarterly plan review', research: 'Research AI trends', video: 'promo video', request: 'Request approval to run', declined: 'You declined it', verified: 'Done and confirmed', planOnly: 'A plan is ready', waiting: 'Waiting for your approval', created: 'Created' },
} as const;

describe('a report offers a deck; a plain question offers nothing', () => {
  for (const locale of ['ko', 'en'] as const) {
    it(`${locale}: the deck TODO is offered under the report, runs only when pressed, continues from THAT report, and is Done only because the deck exists`, async () => {
      const t = TEXT[locale];
      const user = userFor(`todo_report_${locale}`, locale);
      const ctx = await contextFor(user, locale);
      const page = await ctx.newPage();
      await openHome(page);
      const followupsBefore = countOf('followups');
      const decksBefore = countOf('presentation');
      await ask(page, t.report);
      await page.waitForSelector('.main-turn .main-todos .main-todo', { timeout: 40000 });
      const row = todoRow(page, t.todoDeck);
      assert.equal(await row.count(), 1);
      assert.equal(await row.getAttribute('data-state'), 'PROPOSED');
      assert.match(await row.locator('.main-todo-state').innerText(), new RegExp(t.proposed));
      assert.equal(await row.locator('.main-todo-run').innerText(), t.run);
      assert.equal(countOf('followups'), followupsBefore, 'the report follow-up is deterministic: no model was asked');
      assert.equal(countOf('presentation'), decksBefore, 'nothing was started by being offered');
      assert.equal((await todos(page))[0].state, 'PROPOSED');

      // a plain question after it: an answer, no list, no model call for one
      await ask(page, t.plain);
      await settledTurns(page, 2);
      assert.equal(await page.locator('.main-turn').last().locator('.main-todos').count(), 0, 'no task list for a plain question');
      assert.equal(countOf('followups'), followupsBefore);

      // choose it: the same request path as typing it (the text goes through the box and Enter / Send), a deck from the report
      await row.locator('.main-todo-run').click();
      await page.waitForSelector('.main-todo[data-state="COMPLETED"]', { timeout: 60000 });
      const done = todoRow(page, t.todoDeck);
      assert.match(await done.locator('.main-todo-note').innerText(), new RegExp(t.created));
      assert.equal(await done.locator('.main-todo-run').count(), 0, 'nothing left to press');
      const deckRequest = world.modelRequests.filter((r) => r.kind === 'presentation').pop();
      assert.ok(deckRequest, 'the deck was planned by the model');
      assert.match(deckRequest!.system, locale === 'ko' ? /회의 보고서|요청 내용/ : /Meeting report|Request:/, 'from the content of the report that was just written');
      assert.equal(countOf('presentation'), decksBefore + 1, 'exactly one deck was planned');
      assert.equal(await page.locator('#main-result-kind').innerText(), 'PPT');
      const stored = (await todos(page)).find((x) => x.kind === 'CREATE_PRESENTATION')!;
      assert.deepEqual([stored.state, stored.detail.code], ['COMPLETED', 'CREATED']);
      assert.ok(stored.links.artifactId, 'linked to the deck that was really made');
      assert.equal(await page.evaluate(() => (document.getElementById('main-surface-input') as any).value), '', 'the box is empty again');
      assert.doesNotMatch(await page.locator('body').innerText(), /mainTodo\.|todo_[0-9a-f]{24}/, 'no raw keys, no internal ids');
      await ctx.close();
    });
  }
});

describe('next steps: things NAgex can do vs advice; only the chosen one runs, through approval', () => {
  for (const locale of ['ko', 'en'] as const) {
    it(`${locale}: a request for next steps lists runnable TODOs with buttons and advice without; the calendar TODO needs the person's plan review, request and approval, and is Done only after the read-back`, async () => {
      const t = TEXT[locale];
      world.setActionPlan('calendar');
      const user = userFor(`todo_next_${locale}`, locale, true);
      const ctx = await contextFor(user, locale);
      const page = await ctx.newPage();
      await openHome(page);
      const before = calendarPosts();
      await ask(page, t.next);
      await page.waitForSelector('.main-turn .main-todos .main-todo', { timeout: 40000 });
      assert.equal(await page.locator('.main-turn .main-todo').count(), 2, 'the calendar item and the research item ' + JSON.stringify({ todos: await todos(page), recs: await page.locator('.main-turn .main-todo-recs li').allInnerTexts(), followups: world.modelRequests.filter((r) => r.kind === 'followups').length }));
      assert.equal(await page.locator('.main-turn .main-todo-run').count(), 2);
      // the video the model proposed is advice (NAgex cannot make video): shown, with no button
      const recs = await page.locator('.main-turn .main-todo-recs li').allInnerTexts();
      assert.equal(recs.length, 2);
      assert.ok(recs.some((r) => r.includes(t.video)), 'what NAgex cannot do is a recommendation');
      assert.equal(await page.locator('.main-turn .main-todo-recs button').count(), 0, 'recommendations have no button');
      assert.equal(world.modelRequests.filter((r) => r.kind === 'followups').length >= 1, true);

      // only the chosen one starts; the plan is a PREVIEW; nothing is on the calendar
      const cal = todoRow(page, t.calendar);
      await cal.locator('.main-todo-run').click();
      await page.waitForSelector('.main-turn[data-kind="task"] .main-inline-actions button', { timeout: 40000 });
      assert.equal(await cal.getAttribute('data-state'), 'IN_PROGRESS');
      assert.equal(await todoRow(page, t.research).getAttribute('data-state'), 'PROPOSED', 'the other one was not touched');
      assert.equal(calendarPosts(), before, 'a plan preview created nothing');
      assert.equal(world.modelRequests.filter((r) => r.kind === 'plan-action').length >= 1, true);

      // the person's own "request approval": the TODO now waits for an approval and still nothing happened
      await page.locator('.main-turn .main-inline-actions button', { hasText: t.request }).click();
      await page.waitForSelector('.main-approval-card', { timeout: 40000 });
      await page.waitForSelector('.main-todo[data-state="APPROVAL_REQUIRED"]', { timeout: 15000 });
      assert.match(await todoRow(page, t.calendar).locator('.main-todo-state').innerText(), new RegExp(t.approval));
      assert.match(await todoRow(page, t.calendar).locator('.main-todo-note').innerText(), new RegExp(t.waiting));
      assert.equal(calendarPosts(), before, 'asking for approval created nothing');
      assert.equal((await todos(page)).find((x) => x.kind === 'ACTION').state, 'APPROVAL_REQUIRED');

      // the approval is the existing one; approving runs it once; the TODO is Done because NAgex read the event back
      await page.locator('.main-approval-card button.btn-primary').click();
      await page.waitForSelector('.main-todo[data-state="COMPLETED"]', { timeout: 60000 });
      assert.match(await todoRow(page, t.calendar).locator('.main-todo-note').innerText(), new RegExp(t.verified));
      assert.equal(calendarPosts(), before + 1, 'exactly one event was created');
      const record = (await todos(page)).find((x) => x.kind === 'ACTION');
      assert.deepEqual([record.state, record.detail.code], ['COMPLETED', 'VERIFIED']);
      assert.equal(await todoRow(page, t.research).getAttribute('data-state'), 'PROPOSED', 'the one that was not chosen never ran');
      assert.equal(world.searchQueries.length >= 0, true);
      await ctx.close();
    });
  }

  it('ko: declining the approval leaves the TODO FAILED ("you declined it") and nothing on the calendar; it can be tried again', async () => {
    world.setActionPlan('calendar');
    const t = TEXT.ko;
    const user = userFor('todo_decline_ko', 'ko', true);
    const ctx = await contextFor(user, 'ko');
    const page = await ctx.newPage();
    await openHome(page);
    const before = calendarPosts();
    await ask(page, t.next);
    await page.waitForSelector('.main-turn .main-todo', { timeout: 40000 });
    await todoRow(page, t.calendar).locator('.main-todo-run').click();
    await page.waitForSelector('.main-turn[data-kind="task"] .main-inline-actions button', { timeout: 40000 });
    await page.locator('.main-turn .main-inline-actions button', { hasText: t.request }).click();
    await page.waitForSelector('.main-approval-card', { timeout: 40000 });
    await page.locator('.main-approval-card button.btn-secondary.danger').click();
    await page.waitForSelector('.main-todo[data-state="FAILED"]', { timeout: 60000 });
    assert.match(await todoRow(page, t.calendar).locator('.main-todo-note').innerText(), new RegExp(t.declined));
    assert.equal(calendarPosts(), before, 'declined: nothing was created');
    assert.equal(await todoRow(page, t.calendar).locator('.main-todo-run').innerText(), '다시 시도');
    assert.equal((await todos(page)).find((x) => x.kind === 'ACTION').detail.code, 'DECLINED');
    await ctx.close();
  });

  it('an advice answer to a request for next steps keeps its own suggestions as advice and adds only what NAgex can do (no second copy of the advice)', async () => {
    world.setActionPlan('calendar');
    const t = TEXT.ko;
    const user = userFor('todo_advice_ko', 'ko', true);
    const ctx = await contextFor(user, 'ko');
    const page = await ctx.newPage();
    await openHome(page);
    await ask(page, t.advice);
    await page.waitForSelector('.main-turn .main-todos .main-todo', { timeout: 40000 });
    assert.match(await page.locator('.main-turn').last().innerText(), /다음에 해볼 일|조언만 드려요/, 'the advice itself is there');
    assert.equal(await page.locator('.main-turn .main-todo').count(), 2);
    assert.equal(await page.locator('.main-turn .main-todo-recs').count(), 0, 'the advice is not repeated as a second list');
    assert.equal(await page.locator('.main-turn .main-todo-run').count(), 2);
    await ctx.close();
  });

  it('another person cannot see, start or link this person\'s TODOs', async () => {
    const owner = userFor('todo_owner', 'en');
    const stranger = userFor('todo_stranger', 'en');
    const ctx = await contextFor(owner, 'en');
    const page = await ctx.newPage();
    await openHome(page);
    await ask(page, TEXT.en.report);
    await page.waitForSelector('.main-turn .main-todo', { timeout: 40000 });
    const id = (await todos(page))[0].todoId;
    const other = await contextFor(stranger, 'en');
    const otherPage = await other.newPage();
    await openHome(otherPage);
    assert.deepEqual(await todos(otherPage), []);
    for (const action of ['start', 'link']) {
      const status = await otherPage.evaluate(async ({ id, action }: { id: string; action: string }) => (await fetch(`/api/v1/todos/${id}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"failure":{"code":"X"}}' })).status, { id, action });
      assert.equal(status, 404, action);
    }
    assert.equal((await todos(page))[0].state, 'PROPOSED', 'untouched');
    await ctx.close();
    await other.close();
  });
});

describe('phones', () => {
  for (const width of [360, 390, 430]) {
    it(`${width}px: the next actions fit the screen, the button is a touch target and the state label is not clipped`, async () => {
      const t = TEXT.ko;
      const user = userFor(`todo_phone_${width}`, 'ko');
      const ctx = await contextFor(user, 'ko', width);
      const page = await ctx.newPage();
      await openHome(page);
      await ask(page, t.report);
      await page.waitForSelector('.main-turn .main-todo', { timeout: 40000 });
      const geometry = await page.evaluate(() => {
        const row = document.querySelector('.main-todo') as any; const button = row.querySelector('.main-todo-run') as any; const label = row.querySelector('.main-todo-state') as any; const block = document.querySelector('.main-todos') as any;
        const b = button.getBoundingClientRect(); const r = block.getBoundingClientRect();
        return { overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth), buttonW: b.width, buttonH: b.height, buttonRight: b.right, blockRight: r.right, vw: window.innerWidth, labelClipped: label.scrollWidth > label.clientWidth + 1 };
      });
      assert.equal(geometry.overflow, 0, 'no horizontal overflow');
      assert.ok(geometry.buttonH >= 36 && geometry.buttonW >= 60, `touch target ${geometry.buttonW}x${geometry.buttonH}`);
      assert.ok(geometry.buttonRight <= geometry.vw && geometry.blockRight <= geometry.vw + 0.5, 'inside the screen');
      assert.equal(geometry.labelClipped, false);
      await ctx.close();
    });
  }
});

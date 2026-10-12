import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Page } from 'playwright';
import { startCanvasAskHarness, type CanvasAskHarness } from './_canvas_ask_harness.js';

declare const window: any;
declare const document: any;

// Desktop Main: the Home personal briefing (Today / Since Yesterday / Suggestions) is restored under the composer and is
// shown only on an empty Home. These are real-Chromium tests against the production server harness; only the AI chat
// answer and, where stated, the session list / personal-home payloads are stubbed so each state can be forced.

let h: CanvasAskHarness;
before(async () => { h = await startCanvasAskHarness({ scrubProviders: true }); });
after(async () => { await h?.close(); });

const HOUR = 3_600_000;
const iso = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();

async function openMain(page: Page): Promise<void> {
  await page.goto(`${h.origin}/#home`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#nagex-main-surface', { timeout: 20000 });
}

async function settled(page: Page, expected: 'EMPTY_HOME' | 'CONVERSATION' | 'RESULT'): Promise<void> {
  await page.waitForFunction((value: string) => document.querySelector('#nagex-main-surface')?.dataset.sessionState === value, expected, { timeout: 15000 });
}

const briefingVisible = (page: Page) => page.locator('#main-home-briefing').isVisible();
const sectionText = (page: Page, id: 'today' | 'since' | 'suggestions') => page.locator(`#main-briefing-${id}`).innerText();

async function stubChat(page: Page, bodies: any[], delayMs = 0): Promise<void> {
  await page.route('**/api/v1/ai/chat', async (route) => {
    bodies.push(route.request().postDataJSON());
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { message: `답변 ${bodies.length}`, messageId: `msg_${bodies.length}` }, requestId: `req_${bodies.length}` }) });
  });
}

async function send(page: Page, text: string): Promise<void> {
  await page.fill('#main-surface-input', text);
  await page.press('#main-surface-input', 'Control+Enter');
}

describe('Desktop Main — conditional Home briefing', () => {
  it('A. empty Home shows Today / Since Yesterday / Suggestions from the real aggregation (EN)', async () => {
    const user = h.user('briefing_en');
    h.seedDocument(user, { title: 'Quarterly plan v2', content: 'recent document', at: iso(-2 * HOUR) });
    h.seedDocument(user, { title: 'Ancient report', content: 'old document', at: iso(-96 * HOUR) });
    const ctx = await h.newContext('desktop', user, 'en');
    const page = await ctx.newPage();
    let homeCalls = 0;
    page.on('request', (request) => { if (request.url().includes('/api/v1/personal/home')) homeCalls += 1; });
    await openMain(page);
    await settled(page, 'EMPTY_HOME');

    assert.equal(await briefingVisible(page), true);
    assert.deepEqual(await page.locator('.main-briefing-card h2').allTextContents(), ['Today', 'Since Yesterday', 'Suggestions']);
    await page.waitForFunction(() => document.querySelector('#main-home-briefing')?.dataset.state === 'ready');

    // real data: the recent artifact is listed, the 4-day-old one is not
    const since = await sectionText(page, 'since');
    assert.match(since, /Quarterly plan v2/);
    assert.doesNotMatch(since, /Ancient report/);
    // truthful states: no calendar is connected in the harness, so Today says so instead of inventing events
    assert.match(await sectionText(page, 'today'), /Calendar isn't connected/);
    // suggestions are either real ones or an honest empty line, never placeholder text
    assert.doesNotMatch(await sectionText(page, 'suggestions'), /lorem|sample|demo|placeholder/i);
    assert.ok(homeCalls >= 1);

    // layout: the briefing sits below the composer and nothing overlaps or overflows
    const composer = await page.locator('.main-composer-card').boundingBox();
    const briefing = await page.locator('#main-home-briefing').boundingBox();
    assert.ok(composer && briefing && briefing.y >= composer.y + composer.height - 1, 'briefing is below the composer');
    assert.equal(await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - window.innerWidth)), 0);
    await ctx.close();
  });

  it('A. KR: headings and states are localized, with no raw i18n keys', async () => {
    const user = h.user('briefing_ko');
    h.setLocale(user, 'ko');
    h.seedDocument(user, { title: '분기 계획서', content: '최근 문서', at: iso(-3 * HOUR) });
    const ctx = await h.newContext('desktop', user, 'ko');
    const page = await ctx.newPage();
    await openMain(page);
    await settled(page, 'EMPTY_HOME');
    await page.waitForFunction(() => document.querySelector('#main-home-briefing')?.dataset.state === 'ready');
    assert.deepEqual(await page.locator('.main-briefing-card h2').allTextContents(), ['오늘', '어제 이후', '제안']);
    assert.match(await sectionText(page, 'since'), /분기 계획서/);
    assert.match(await sectionText(page, 'today'), /캘린더가 연결되어 있지 않아/);
    const text = await page.locator('#main-home-briefing').innerText();
    assert.doesNotMatch(text, /mainBriefing\.|undefined|\[object/);
    assert.equal(await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - window.innerWidth)), 0);
    await ctx.close();
  });

  it('B/C. a draft keeps the briefing; submitting hides it without deleting its data or re-fetching', async () => {
    const user = h.user('briefing_flow');
    h.seedDocument(user, { title: 'Draft context doc', content: 'doc', at: iso(-1 * HOUR) });
    const ctx = await h.newContext('desktop', user, 'en');
    const page = await ctx.newPage();
    const chat: any[] = [];
    let homeCalls = 0;
    page.on('request', (request) => { if (request.url().includes('/api/v1/personal/home')) homeCalls += 1; });
    await stubChat(page, chat, 1200);
    await openMain(page);
    await settled(page, 'EMPTY_HOME');
    await page.waitForFunction(() => document.querySelector('#main-home-briefing')?.dataset.state === 'ready');

    // focusing and typing do not hide it, and the draft is untouched
    await page.click('#main-surface-input');
    assert.equal(await briefingVisible(page), true);
    await page.keyboard.type('초안 질문입니다');
    assert.equal(await briefingVisible(page), true);
    assert.equal(await page.locator('#main-surface-input').inputValue(), '초안 질문입니다');

    // submit: hidden immediately (streaming/in-flight), still hidden when the answer is shown
    const homeCallsBeforeSubmit = homeCalls;
    await page.press('#main-surface-input', 'Control+Enter');
    await settled(page, 'CONVERSATION');
    assert.equal(await briefingVisible(page), false);
    await page.waitForFunction(() => /Answered/.test(document.querySelector('#main-status')?.textContent || ''));
    assert.equal(await briefingVisible(page), false);
    assert.equal(chat.length, 1);

    // hidden, not deleted: content and data remain, and hiding made no extra API call
    assert.ok((await page.locator('#main-briefing-since li').count()) >= 1);
    assert.match(await page.locator('#main-briefing-since').textContent() || '', /Draft context doc/);
    assert.equal(homeCalls, homeCallsBeforeSubmit);
    await ctx.close();
  });

  it('D/E. a result keeps it hidden; returning to a new empty Home restores it and keeps earlier history', async () => {
    const user = h.user('briefing_result');
    const seeded = h.seedDocument(user, { title: 'Result doc', content: 'content', at: iso(-30 * 60_000) });
    const ctx = await h.newContext('desktop', user, 'en');
    const page = await ctx.newPage();
    const methods: string[] = [];
    const messages = [
      { messageId: 'msg_u1', role: 'USER', source: 'WEB', content: '이전 질문', createdAt: iso(-5 * HOUR), status: 'COMMITTED' },
      { messageId: 'msg_a1', role: 'ASSISTANT', source: 'WEB', content: '이전 답변', createdAt: iso(-5 * HOUR + 1000), status: 'COMMITTED' },
    ];
    await page.route('**/api/v1/conversations/main', async (route) => {
      methods.push(route.request().method());
      if (route.request().method() !== 'GET') { await route.fulfill({ status: 500, body: '{}' }); return; }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ session: { sessionId: 'ses_main', type: 'MAIN' }, messages }) });
    });
    await openMain(page);
    // an earlier conversation exists on the server, so Main restores it and the briefing stays hidden
    await settled(page, 'CONVERSATION');
    assert.equal(await briefingVisible(page), false);
    assert.match(await page.locator('#main-request-text').textContent() || '', /이전 질문/);
    assert.match(await page.locator('#main-work-summary').textContent() || '', /이전 답변/);

    // start a fresh empty Home: the briefing returns, the server history is untouched
    await page.click('#main-new-conversation');
    await settled(page, 'EMPTY_HOME');
    assert.equal(await briefingVisible(page), true);
    assert.deepEqual(methods.filter((method) => method !== 'GET'), []);
    assert.equal(messages.length, 2);

    // an artifact result hides it again, without any overlay on the conversation
    const opened = await page.evaluate((artifactId: string) => window.NAGEX_MAIN_SURFACE.openArtifactResult(artifactId), seeded.artifactId);
    assert.equal(opened, true);
    await settled(page, 'RESULT');
    assert.equal(await briefingVisible(page), false);
    assert.equal(await page.locator('[role="dialog"]:visible').count(), 0);

    // closing the result returns to the empty Home
    await page.click('#main-result-close');
    await settled(page, 'EMPTY_HOME');
    assert.equal(await briefingVisible(page), true);
    await ctx.close();
  });

  it('F. refresh derives visibility from the restored session, including a fresh Home that must stay fresh', async () => {
    const user = h.user('briefing_refresh');
    const ctx = await h.newContext('desktop', user, 'en');
    const page = await ctx.newPage();
    const messages: any[] = [];
    await page.route('**/api/v1/conversations/main', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ session: { sessionId: 'ses_main', type: 'MAIN' }, messages }) });
    });

    // 1. empty server session -> empty Home restored -> visible
    await openMain(page);
    await settled(page, 'EMPTY_HOME');
    assert.equal(await briefingVisible(page), true);

    // 2. a conversation exists -> refresh restores it -> hidden
    messages.push({ messageId: 'msg_u1', role: 'USER', source: 'WEB', content: '복원될 질문', createdAt: iso(-2 * HOUR), status: 'COMMITTED' });
    messages.push({ messageId: 'msg_a1', role: 'ASSISTANT', source: 'WEB', content: '복원될 답변', createdAt: iso(-2 * HOUR + 500), status: 'COMMITTED' });
    await page.reload();
    await page.waitForSelector('#nagex-main-surface');
    await settled(page, 'CONVERSATION');
    assert.equal(await briefingVisible(page), false);
    assert.match(await page.locator('#main-work-summary').textContent() || '', /복원될 답변/);

    // 3. user starts a fresh Home; refreshing keeps it empty (visible), the old messages are still on the server
    await page.click('#main-new-conversation');
    await settled(page, 'EMPTY_HOME');
    await page.reload();
    await page.waitForSelector('#nagex-main-surface');
    await settled(page, 'EMPTY_HOME');
    assert.equal(await briefingVisible(page), true);
    assert.equal(messages.length, 2);

    // 4. a new message after the fresh start -> refresh restores that conversation -> hidden
    messages.push({ messageId: 'msg_u2', role: 'USER', source: 'WEB', content: '새 대화 질문', createdAt: iso(1000), status: 'COMMITTED' });
    messages.push({ messageId: 'msg_a2', role: 'ASSISTANT', source: 'WEB', content: '새 대화 답변', createdAt: iso(1500), status: 'COMMITTED' });
    await page.reload();
    await page.waitForSelector('#nagex-main-surface');
    await settled(page, 'CONVERSATION');
    assert.equal(await briefingVisible(page), false);
    assert.match(await page.locator('#main-request-text').textContent() || '', /새 대화 질문/);
    await ctx.close();
  });

  it('honest states: a failing briefing source shows an error with retry, never invented items; an unreadable session does not hide it', async () => {
    const user = h.user('briefing_error');
    const ctx = await h.newContext('desktop', user, 'en');
    const page = await ctx.newPage();
    let fail = true;
    await page.route('**/api/v1/personal/home', async (route) => {
      if (fail) { await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'HOME_UNAVAILABLE', message: 'down' } }) }); return; }
      await route.continue();
    });
    await page.route('**/api/v1/conversations/main', async (route) => { await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SESSION_UNAVAILABLE' } }) }); });
    await openMain(page);
    await settled(page, 'EMPTY_HOME'); // the session could not be read, so Main does not pretend a conversation exists
    await page.waitForFunction(() => document.querySelector('#main-home-briefing')?.dataset.state === 'error');
    assert.equal(await briefingVisible(page), true);
    for (const id of ['today', 'since', 'suggestions'] as const) assert.match(await sectionText(page, id), /Couldn't load your briefing/);
    assert.equal(await page.locator('.main-briefing-row').count(), 0);
    fail = false;
    await page.click('#main-briefing-retry');
    await page.waitForFunction(() => document.querySelector('#main-home-briefing')?.dataset.state === 'ready');
    assert.equal(await page.locator('#main-briefing-retry').isHidden(), true);
    await ctx.close();
  });

  it('suggestions are real controls: they put text in the Main box without overwriting a draft or executing anything', async () => {
    const user = h.user('briefing_suggest');
    const ctx = await h.newContext('desktop', user, 'en');
    const page = await ctx.newPage();
    await page.route('**/api/v1/personal/home', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      const home = body.data || body;
      home.suggestions = [{ id: 'sug_1', kind: 'FOLLOW_UP', title: '내일 회의 자료 준비하기', reason: 'You have a meeting tomorrow.', sourceRefs: [], action: { type: 'PREPARE', label: 'Prepare', requiresApproval: true }, generatedAt: new Date().toISOString() }];
      await route.fulfill({ response, contentType: 'application/json', body: JSON.stringify(body.data ? { ...body, data: home } : home) });
    });
    const posts: string[] = [];
    page.on('request', (request) => { if (request.method() === 'POST') posts.push(request.url()); });
    await openMain(page);
    await settled(page, 'EMPTY_HOME');
    await page.waitForSelector('.main-briefing-suggestion');
    assert.match(await sectionText(page, 'suggestions'), /Approval required/);
    await page.fill('#main-surface-input', '내 초안');
    const postsBefore = posts.length;
    await page.click('.main-briefing-suggestion');
    assert.equal(await page.locator('#main-surface-input').inputValue(), '내 초안\n내일 회의 자료 준비하기');
    assert.equal(await briefingVisible(page), true);
    assert.equal(posts.length, postsBefore); // selecting a suggestion executes nothing
    await ctx.close();
  });

  it('desktop viewports: no overflow at 1440 and 1100 wide, three columns then readable stacking', async () => {
    const user = h.user('briefing_viewport');
    const ctx = await h.newContext('desktop', user, 'en');
    const page = await ctx.newPage();
    await openMain(page);
    await settled(page, 'EMPTY_HOME');
    await page.waitForFunction(() => document.querySelector('#main-home-briefing')?.dataset.state === 'ready');
    for (const width of [1440, 1100, 900]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - window.innerWidth)), 0, `overflow at ${width}`);
      const boxes = await page.locator('.main-briefing-card').evaluateAll((cards: any[]) => cards.map((card) => { const r = card.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width }; }));
      assert.equal(boxes.length, 3);
      if (width >= 1100) assert.ok(Math.abs(boxes[0].y - boxes[1].y) < 2 && Math.abs(boxes[1].y - boxes[2].y) < 2, `three columns at ${width}`);
      else assert.ok(boxes[1].y > boxes[0].y && boxes[2].y > boxes[1].y, `stacked at ${width}`);
    }
    await ctx.close();
  });
});

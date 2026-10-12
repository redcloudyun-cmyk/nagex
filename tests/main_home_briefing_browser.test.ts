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
    assert.deepEqual(await page.locator('.main-briefing-card h2').allTextContents(), ['Today', 'To-do', 'Since Yesterday', 'Suggestions']);
    await page.waitForFunction(() => document.querySelector('#main-home-briefing')?.dataset.state === 'ready');

    // real data: the recent artifact is listed, the 4-day-old one is not
    const since = await sectionText(page, 'since');
    assert.match(since, /Quarterly plan v2/);
    assert.doesNotMatch(since, /Ancient report/);
    // truthful states: no calendar is connected in the harness, so Today says so instead of inventing events
    assert.match(await sectionText(page, 'today'), /Google Calendar isn't available on this server/);
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
    assert.deepEqual(await page.locator('.main-briefing-card h2').allTextContents(), ['오늘', '할 일', '어제 이후', '제안']);
    assert.match(await sectionText(page, 'since'), /분기 계획서/);
    assert.match(await sectionText(page, 'today'), /이 서버에서는 구글 캘린더를 사용할 수 없습니다/);
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

  it('greeting: real profile name, EN/KR, local time of day, and a neutral avatar only when there is no name', async () => {
    const cases = [
      { locale: 'en' as const, hour: 9, name: 'Ada Lovelace', text: 'Good morning, Ada Lovelace', initial: 'A' },
      { locale: 'en' as const, hour: 14, name: 'Ada Lovelace', text: 'Good afternoon, Ada Lovelace', initial: 'A' },
      { locale: 'en' as const, hour: 20, name: 'Ada Lovelace', text: 'Good evening, Ada Lovelace', initial: 'A' },
      { locale: 'ko' as const, hour: 9, name: '김서연', text: '좋은 아침입니다, 김서연님', initial: '김' },
      { locale: 'ko' as const, hour: 14, name: '김서연', text: '좋은 오후입니다, 김서연님', initial: '김' },
      { locale: 'ko' as const, hour: 20, name: '김서연', text: '좋은 저녁입니다, 김서연님', initial: '김' },
    ];
    for (const c of cases) {
      const user = h.user(`greet_${c.locale}_${c.hour}`);
      h.setDisplayName(user, c.name);
      if (c.locale === 'ko') h.setLocale(user, 'ko');
      const ctx = await h.newContext('desktop', user, c.locale);
      const page = await ctx.newPage();
      await page.clock.setFixedTime(new Date(2026, 9, 12, c.hour, 30));
      await openMain(page);
      await page.waitForFunction((expected: string) => document.querySelector('#main-greeting')?.innerText === expected, c.text);
      assert.equal(await page.locator('#main-greeting-sub').innerText(), c.locale === 'ko' ? '오늘은 무엇을 이루고 싶으신가요?' : 'What would you like to accomplish today?');
      assert.doesNotMatch(await page.locator('body').innerText(), /redcloudyun/);
      await ctx.close();
    }
  });

  it('greeting fallback: a placeholder name or a failing profile source gives a time-of-day greeting only, never a fabricated name', async () => {
    // placeholder display name stored for accounts without a real one
    const placeholder = h.user('greet_placeholder');
    h.setDisplayName(placeholder, 'User');
    const ctxA = await h.newContext('desktop', placeholder, 'en');
    const pageA = await ctxA.newPage();
    await pageA.clock.setFixedTime(new Date(2026, 9, 12, 9, 30));
    await openMain(pageA);
    await pageA.waitForFunction(() => document.querySelector('#main-home-briefing')?.dataset.state === 'ready');
    assert.equal(await pageA.locator('#main-greeting').innerText(), 'Good morning');
    assert.doesNotMatch(await pageA.locator('body').innerText(), /redcloudyun/);
    await ctxA.close();

    // the profile source (personal home) failing: same safe fallback, KR wording
    const failing = h.user('greet_failing');
    h.setLocale(failing, 'ko');
    const ctxB = await h.newContext('desktop', failing, 'ko');
    const pageB = await ctxB.newPage();
    await pageB.route('**/api/v1/personal/home', async (route) => { await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'HOME_UNAVAILABLE' } }) }); });
    await pageB.clock.setFixedTime(new Date(2026, 9, 12, 20, 30));
    await openMain(pageB);
    await pageB.waitForFunction(() => document.querySelector('#main-home-briefing')?.dataset.state === 'error');
    assert.equal(await pageB.locator('#main-greeting').innerText(), '좋은 저녁입니다');
    assert.doesNotMatch(await pageB.locator('body').innerText(), /redcloudyun/);
    await ctxB.close();
  });

  // A fixed application-generated briefing payload: fixed wording must follow the locale, embedded user content must not.
  async function stubGeneratedBriefing(page: Page): Promise<void> {
    await page.route('**/api/v1/personal/home', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      const home = body.data || body;
      home.today = { ...(home.today || {}), meetings: [
        { id: 'm1', title: 'Research', startsAt: iso(HOUR) },
        { id: 'm2', title: 'Untitled Meeting', startsAt: iso(2 * HOUR) },
      ] };
      home.needsAttention = [{ id: 'a1', type: 'APPROVAL', title: 'Approval Required: gmail.send_email', summary: 'Action requires human confirmation', state: 'Needs approval', createdAt: iso(-HOUR) }];
      home.recentResults = [
        { id: 'r1', type: 'DAILY_BRIEF', title: 'Daily Brief generated', summary: '', state: 'Completed', createdAt: iso(-HOUR), sourceId: 'act_1' },
        { id: 'r2', type: 'TASK', title: 'Created task "Pay rent"', summary: '', state: 'Completed', createdAt: iso(-2 * HOUR), sourceId: 'act_2' },
        { id: 'r3', type: 'DOCUMENT', title: 'Quarterly plan v2', summary: '', state: 'Completed', createdAt: iso(-3 * HOUR), sourceId: 'act_3' },
      ];
      home.suggestions = [{ id: 'sug_1', kind: 'MEETING_PREP', title: 'Prepare for Budget review', reason: 'Your meeting starts in 15 minutes and I found 2 related items.', sourceRefs: [], action: { type: 'PREPARE', label: 'Prepare', requiresApproval: false }, generatedAt: new Date().toISOString() }];
      home.sourceStatus = { ...(home.sourceStatus || {}), calendar: 'CONNECTED', activity: 'OK' };
      await route.fulfill({ response, contentType: 'application/json', body: JSON.stringify(body.data ? { ...body, data: home } : home) });
    });
  }

  it('localization KR: composer chrome, modes, voice status and generated briefing wording are Korean; user content is untouched', async () => {
    const user = h.user('l10n_ko');
    h.setLocale(user, 'ko');
    const ctx = await h.newContext('desktop', user, 'ko');
    const page = await ctx.newPage();
    await stubGeneratedBriefing(page);
    await openMain(page);
    await settled(page, 'EMPTY_HOME');
    await page.waitForFunction(() => document.querySelector('#main-home-briefing')?.dataset.state === 'ready');

    assert.equal((await page.locator('#main-attach').innerText()).trim(), '첨부');
    assert.equal((await page.locator('#main-web-toggle').innerText()).trim(), '웹');
    assert.equal((await page.locator('#main-data-toggle').innerText()).trim(), '내 데이터');
    assert.equal((await page.locator('#main-plan-toggle').innerText()).trim(), '실행 전에 계획 보기');
    assert.equal((await page.locator('#main-voice').innerText()).trim(), '음성');
    assert.equal((await page.locator('#main-voice-status').innerText()).trim(), '대기 중');
    assert.match((await page.locator('#main-surface-input').getAttribute('placeholder')) || '', /조사|제작|계획|실행/);
    assert.deepEqual((await page.locator('.main-mode-chip').allInnerTexts()).map((s) => s.trim()), ['질문', '리서치', '문서', '계획', '이미지', '슬라이드', '영상', '코드', '더보기']);
    assert.equal((await page.locator('#main-send').getAttribute('aria-label')), '요청 보내기');
    // app-shell chrome that is visible on the Main screen
    assert.match((await page.locator('#btn-header-search').innerText()).trim(), /검색/);
    assert.equal((await page.locator('#btn-header-quickwake span').innerText()).trim(), '빠른 호출');

    const today = await sectionText(page, 'today');
    assert.match(today, /승인 필요: 이메일 보내기/);
    assert.match(today, /제목 없는 일정/);
    assert.match(today, /Research/); // a user's own meeting title is never translated
    const since = await sectionText(page, 'since');
    assert.match(since, /데일리 브리프가 생성되었습니다/);
    assert.match(since, /작업 "Pay rent"을\(를\) 만들었습니다/);
    assert.match(since, /Quarterly plan v2/);
    const suggestions = await sectionText(page, 'suggestions');
    assert.match(suggestions, /Budget review 준비하기/);
    assert.match(suggestions, /일정이 15분 뒤에 시작되며 관련 항목 2개를 찾았습니다/);

    const visible = await page.locator('#nagex-main-surface').innerText();
    assert.doesNotMatch(visible, /Approval Required|Daily Brief|Untitled Meeting|Show plan before actions|My data|Small steps every day/);
    assert.doesNotMatch(visible, /mainText\.|mainPattern\.|mainBriefing\./);
    await ctx.close();
  });

  it('localization EN: the same payload keeps its English wording, and switching language flips Main without a reload', async () => {
    const user = h.user('l10n_en');
    const ctx = await h.newContext('desktop', user, 'en');
    const page = await ctx.newPage();
    await stubGeneratedBriefing(page);
    await openMain(page);
    await settled(page, 'EMPTY_HOME');
    await page.waitForFunction(() => document.querySelector('#main-home-briefing')?.dataset.state === 'ready');

    assert.equal((await page.locator('#main-attach').innerText()).trim(), 'Attach');
    assert.equal((await page.locator('#main-voice-status').innerText()).trim(), 'Idle');
    assert.deepEqual((await page.locator('.main-mode-chip').allInnerTexts()).map((s) => s.trim()), ['Ask', 'Research', 'Document', 'Plan', 'Image', 'Slides', 'Video', 'Code', 'More']);
    assert.match(await sectionText(page, 'today'), /Approval Required: Send email/);
    assert.match(await sectionText(page, 'since'), /Daily Brief generated/);
    assert.match(await sectionText(page, 'suggestions'), /Your meeting starts in 15 minutes and I found 2 related items\./);

    await page.evaluate(() => window.NAGEX_I18N.setLocale('ko'));
    await page.waitForFunction(() => document.querySelector('#main-attach')?.textContent?.trim() === '첨부');
    assert.deepEqual((await page.locator('.main-mode-chip').allInnerTexts()).map((s) => s.trim()), ['질문', '리서치', '문서', '계획', '이미지', '슬라이드', '영상', '코드', '더보기']);
    assert.equal((await page.locator('#main-voice-status').innerText()).trim(), '대기 중');
    assert.match(await sectionText(page, 'since'), /데일리 브리프가 생성되었습니다/);
    await page.evaluate(() => window.NAGEX_I18N.setLocale('en'));
    await page.waitForFunction(() => document.querySelector('#main-attach')?.textContent?.trim() === 'Attach');
    assert.match(await sectionText(page, 'since'), /Daily Brief generated/);
    await ctx.close();
  });

  // The Today card must say WHY calendar events are missing. Each state is forced through the personal-home payload.
  const calendarConnection = (state: string, reason: string | null, extra: Record<string, unknown> = {}) => ({
    provider: 'google_calendar', state, reason, retryable: false, scopes: [], missingScopes: [], connectPath: null, verifiedAt: null, message: '', ...extra,
  });

  async function stubCalendarState(page: Page, connection: Record<string, unknown>, counter?: { n: number }): Promise<void> {
    await page.route('**/api/v1/personal/home', async (route) => {
      if (counter) counter.n += 1;
      const response = await route.fetch();
      const body = await response.json();
      const home = body.data || body;
      home.calendarConnection = connection;
      home.today = { ...(home.today || {}), meetings: [] };
      home.sourceStatus = { ...(home.sourceStatus || {}), calendar: connection.state === 'CONNECTED' ? 'CONNECTED' : 'UNAVAILABLE' };
      await route.fulfill({ response, contentType: 'application/json', body: JSON.stringify(body.data ? { ...body, data: home } : home) });
    });
  }

  it('calendar states: Today explains each connection state truthfully, in EN and KR, with a working action only where one can help', async () => {
    const connectPath = '/api/v1/oauth/google/start';
    const cases = [
      { state: 'NOT_CONNECTED', reason: 'NO_CONNECTION', extra: { connectPath }, en: /Google Calendar isn't connected/, ko: /구글 캘린더가 연결되어 있지 않아/, action: 'connect', enLabel: 'Connect Google Calendar', koLabel: '구글 캘린더 연결' },
      { state: 'CONNECTING', reason: 'AUTHORIZATION_PENDING', extra: {}, en: /Finishing Google Calendar authorization/, ko: /인증을 마무리하는 중/, action: 'refresh', enLabel: 'Check again', koLabel: '다시 확인' },
      { state: 'REAUTH_REQUIRED', reason: 'TOKEN_REVOKED', extra: { connectPath }, en: /expired or was revoked/, ko: /만료되었거나 취소되었습니다/, action: 'connect', enLabel: 'Reconnect Google Calendar', koLabel: '구글 캘린더 다시 연결' },
      { state: 'REAUTH_REQUIRED', reason: 'MISSING_SCOPE', extra: { connectPath }, en: /wasn't fully granted/, ko: /모두 허용되지 않았습니다/, action: 'connect', enLabel: 'Reconnect Google Calendar', koLabel: '구글 캘린더 다시 연결' },
      { state: 'ERROR', reason: 'PROVIDER_TIMEOUT', extra: { retryable: true }, en: /did not respond in time/, ko: /제시간에 응답하지 않았습니다/, action: 'refresh', enLabel: 'Try again', koLabel: '다시 시도' },
      { state: 'ERROR', reason: 'PROVIDER_ERROR', extra: { retryable: true }, en: /returned an error/, ko: /오류가 반환되었습니다/, action: 'refresh', enLabel: 'Try again', koLabel: '다시 시도' },
      { state: 'ERROR', reason: 'PROVIDER_API_DISABLED', extra: { retryable: false }, en: /API is not enabled/, ko: /API가 켜져 있지 않습니다/, action: null, enLabel: '', koLabel: '' },
      { state: 'UNAVAILABLE', reason: 'OAUTH_NOT_CONFIGURED', extra: {}, en: /isn't available on this server/, ko: /사용할 수 없습니다/, action: null, enLabel: '', koLabel: '' },
    ];
    for (const locale of ['en', 'ko'] as const) {
      for (const c of cases) {
        const user = h.user(`cal_${locale}_${c.state}_${c.reason}`.toLowerCase());
        if (locale === 'ko') h.setLocale(user, 'ko');
        const ctx = await h.newContext('desktop', user, locale);
        const page = await ctx.newPage();
        await stubCalendarState(page, calendarConnection(c.state, c.reason, c.extra));
        await openMain(page);
        await settled(page, 'EMPTY_HOME');
        await page.waitForFunction(() => document.querySelector('#main-home-briefing')?.dataset.state === 'ready');
        const today = await sectionText(page, 'today');
        assert.match(today, locale === 'en' ? c.en : c.ko, `${locale} ${c.state}/${c.reason}`);
        assert.doesNotMatch(today, /Nothing scheduled|예정된 일정이나/, `${c.state}: never claims an empty day when the calendar is unreadable`);
        const buttons = await page.locator('#main-briefing-today .main-calendar-action').allInnerTexts();
        assert.deepEqual(buttons.map((b) => b.trim()), c.action ? [locale === 'en' ? c.enLabel : c.koLabel] : [], `${locale} ${c.state}/${c.reason} action`);
        assert.doesNotMatch(await page.locator('#nagex-main-surface').innerText(), /mainBriefing\.|[A-Z]+_[A-Z_]+/, 'no raw keys or reason codes');
        await ctx.close();
      }
    }
  });

  it('calendar actions are real: Connect starts the Google OAuth route, Try again re-reads the briefing, and nothing else is clickable', async () => {
    const user = h.user('cal_actions');
    const ctx = await h.newContext('desktop', user, 'en');
    const page = await ctx.newPage();
    const counter = { n: 0 };
    await stubCalendarState(page, calendarConnection('NOT_CONNECTED', 'NO_CONNECTION', { connectPath: '/api/v1/oauth/google/start' }), counter);
    await openMain(page);
    await settled(page, 'EMPTY_HOME');
    await page.waitForSelector('#main-briefing-today .main-calendar-action');
    const [request] = await Promise.all([
      page.waitForRequest((r) => r.url().includes('/api/v1/oauth/google/start'), { timeout: 15000 }),
      page.click('#main-briefing-today .main-calendar-action'),
    ]);
    assert.equal(new URL(request.url()).pathname, '/api/v1/oauth/google/start');
    await ctx.close();

    const ctx2 = await h.newContext('desktop', h.user('cal_actions_retry'), 'en');
    const page2 = await ctx2.newPage();
    const counter2 = { n: 0 };
    await stubCalendarState(page2, calendarConnection('ERROR', 'PROVIDER_TIMEOUT', { retryable: true }), counter2);
    await openMain(page2);
    await settled(page2, 'EMPTY_HOME');
    await page2.waitForSelector('#main-briefing-today .main-calendar-action');
    const before = counter2.n;
    await page2.click('#main-briefing-today .main-calendar-action');
    await page2.waitForFunction(() => document.querySelector('#main-home-briefing')?.dataset.state === 'ready');
    await page2.waitForTimeout(300);
    assert.ok(counter2.n > before, 'Try again re-reads the briefing source');
    await ctx2.close();
  });

  it('calendar CONNECTED: the real Google events of the signed-in user reach Main; another user sees none of them', async () => {
    const { googleTokenStore } = await import('../src/integrations/google/token.store.js');
    const owner = h.user('cal_real_owner');
    const stranger = h.user('cal_real_stranger');
    const scopes = ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.events.freebusy', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly'].join(' ');
    googleTokenStore.saveForPrincipal(owner.tenantId, owner.userId, { accessToken: 'at_real_owner', refreshToken: 'rt_real_owner', expiresAt: Date.now() + 3_600_000, scope: scopes });
    const env = { id: process.env.GOOGLE_CLIENT_ID, secret: process.env.GOOGLE_CLIENT_SECRET, redirect: process.env.GOOGLE_REDIRECT_URI };
    process.env.GOOGLE_CLIENT_ID = 'cal-real-client'; process.env.GOOGLE_CLIENT_SECRET = 'cal-real-secret'; process.env.GOOGLE_REDIRECT_URI = 'https://nagex-test.agex.site/api/v1/oauth/google/callback';
    const originalFetch = globalThis.fetch;
    const tokens: Array<string | null> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith('https://www.googleapis.com/calendar/')) return originalFetch(input, init);
      tokens.push(new Headers(init?.headers).get('authorization'));
      const start = new Date(Date.now() + 10 * 60_000);
      const end = new Date(Date.now() + 20 * 60_000);
      return new Response(JSON.stringify({ items: [{ id: 'evt_real_1', summary: 'Quarterly design review', status: 'confirmed', start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() }, attendees: [{ email: 'kim@example.com' }] }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    try {
      const ownerCtx = await h.newContext('desktop', owner, 'en');
      const ownerPage = await ownerCtx.newPage();
      await openMain(ownerPage);
      await settled(ownerPage, 'EMPTY_HOME');
      await ownerPage.waitForFunction(() => document.querySelector('#main-home-briefing')?.dataset.state === 'ready');
      await ownerPage.waitForFunction(() => /Quarterly design review/.test(document.querySelector('#main-briefing-today')?.textContent || ''), undefined, { timeout: 15000 });
      assert.equal(await ownerPage.locator('#main-briefing-today .main-calendar-state').count(), 0, 'a verified CONNECTED calendar shows no warning');
      assert.ok(tokens.includes('Bearer at_real_owner'));
      await ownerCtx.close();

      const callsBefore = tokens.length;
      const strangerCtx = await h.newContext('desktop', stranger, 'en');
      const strangerPage = await strangerCtx.newPage();
      await openMain(strangerPage);
      await settled(strangerPage, 'EMPTY_HOME');
      await strangerPage.waitForFunction(() => document.querySelector('#main-home-briefing')?.dataset.state === 'ready');
      assert.doesNotMatch(await sectionText(strangerPage, 'today'), /Quarterly design review/);
      assert.equal(tokens.length, callsBefore, 'the other user never triggers a Google call with the owner\'s token');
      assert.deepEqual(tokens.filter((x) => x !== 'Bearer at_real_owner'), []);
      await strangerCtx.close();
    } finally {
      globalThis.fetch = originalFetch;
      googleTokenStore.clearForPrincipal(owner.tenantId, owner.userId);
      for (const [k, v] of [['GOOGLE_CLIENT_ID', env.id], ['GOOGLE_CLIENT_SECRET', env.secret], ['GOOGLE_REDIRECT_URI', env.redirect]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });

  it('desktop viewports: no overflow at 1440, 1100 and 900 wide; four columns, then two', async () => {
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
      assert.equal(boxes.length, 4);
      if (width >= 1200) assert.ok(boxes.every((b: any) => Math.abs(b.y - boxes[0].y) < 2), `four columns at ${width}`);
      else assert.ok(Math.abs(boxes[0].y - boxes[1].y) < 2 && Math.abs(boxes[2].y - boxes[3].y) < 2 && boxes[2].y > boxes[0].y, `two columns at ${width}`);
    }
    await ctx.close();
  });
});

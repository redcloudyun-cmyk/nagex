import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright';
import { startCanvasAskHarness, type CanvasAskHarness } from './_canvas_ask_harness.js';

declare const window: any;
declare const document: any;

// Unified Main: one adaptive workspace. Idle Home shows the briefing in the first viewport; the first prompt turns it into
// a normal conversation (question once, answer inline, composer docked at the bottom); agent work shows its real plan,
// steps and approvals inline; the briefing collapses while working and "My Day" reopens it; refresh restores the state.
// Real Chromium against the production server harness; only the AI answer / plan and, where stated, the home payload,
// approvals and conversation list are stubbed so each state can be forced.

let h: CanvasAskHarness;
before(async () => { h = await startCanvasAskHarness({ scrubProviders: true }); });
after(async () => { await h?.close(); });

const HOUR = 3_600_000;
const iso = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();

async function contextAt(width: number, height: number, label: string, locale: 'en' | 'ko' = 'en'): Promise<BrowserContext> {
  const user = h.user(label);
  if (locale === 'ko') h.setLocale(user, 'ko');
  const base = await h.newContext('desktop', user, locale);
  const ctx = await h.browser.newContext({ viewport: { width, height }, locale: locale === 'ko' ? 'ko-KR' : 'en-US' });
  await ctx.addCookies(await base.cookies());
  await base.close();
  return ctx;
}

async function stubRichHome(page: Page): Promise<void> {
  await page.route('**/api/v1/personal/home', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const home = body.data || body;
    home.today = { ...(home.today || {}), meetings: [
      { id: 'm1', title: 'Weekly sync with design', startsAt: iso(HOUR) },
      { id: 'm2', title: 'Budget review', startsAt: iso(3 * HOUR) },
    ] };
    home.needsAttention = [{ id: 'a1', type: 'APPROVAL', title: 'Approval Required: gmail.send_email', state: 'Needs approval', createdAt: iso(-HOUR) }];
    home.todo = { status: 'OK', items: [
      { id: 't1', kind: 'REMINDER', title: 'Call the client back', dueAt: iso(2 * HOUR), state: 'Due today' },
      { id: 't2', kind: 'REMINDER', title: 'Send the invoice', dueAt: iso(-HOUR), state: 'Overdue' },
      { id: 't3', kind: 'TASK', title: 'Write the quarterly report', dueAt: null, state: 'Scheduled' },
    ] };
    home.recentResults = [
      { id: 'r1', type: 'DOCUMENT', title: 'Quarterly plan v2', state: 'Completed', createdAt: iso(-2 * HOUR), sourceId: 'a1' },
      { id: 'r2', type: 'DAILY_BRIEF', title: 'Daily Brief generated', state: 'Completed', createdAt: iso(-3 * HOUR), sourceId: 'a2' },
      { id: 'r3', type: 'TASK', title: 'Created task "Pay rent"', state: 'Completed', createdAt: iso(-4 * HOUR), sourceId: 'a3' },
    ];
    home.suggestions = [{ id: 's1', kind: 'MEETING_PREP', title: 'Prepare for Budget review', reason: 'Your meeting starts in 15 minutes and I found 2 related items.', sourceRefs: [], action: { type: 'PREPARE', label: 'Prepare', requiresApproval: false }, generatedAt: new Date().toISOString() }];
    home.calendarConnection = { provider: 'google_calendar', state: 'CONNECTED', reason: null, retryable: false, scopes: [], missingScopes: [], connectPath: null, verifiedAt: new Date().toISOString(), message: '' };
    home.sourceStatus = { ...(home.sourceStatus || {}), calendar: 'CONNECTED', activity: 'OK' };
    await route.fulfill({ response, contentType: 'application/json', body: JSON.stringify(body.data ? { ...body, data: home } : home) });
  });
}

async function stubChat(page: Page, answers: string[], bodies: any[] = []): Promise<void> {
  await page.route('**/api/v1/ai/chat', async (route) => {
    bodies.push(route.request().postDataJSON());
    const message = answers[Math.min(bodies.length - 1, answers.length - 1)];
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { message, messageId: `msg_${bodies.length}` }, requestId: `req_${bodies.length}` }) });
  });
}

async function openMain(page: Page): Promise<void> {
  await page.goto(`${h.origin}/#home`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#nagex-main-surface', { timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('#main-home-briefing')?.dataset.state === 'ready' || document.querySelector('#nagex-main-surface')?.dataset.sessionState === 'CONVERSATION', undefined, { timeout: 20000 });
}

const sessionState = (page: Page) => page.evaluate(() => document.querySelector('#nagex-main-surface')?.dataset.sessionState);
async function ask(page: Page, text: string): Promise<void> {
  await page.fill('#main-surface-input', text);
  await page.press('#main-surface-input', 'Control+Enter');
}
const box = (page: Page, selector: string) => page.locator(selector).first().evaluate((el: any) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height, width: r.width }; });
const visibleInViewport = (page: Page, selector: string) => page.locator(selector).first().evaluate((el: any) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight + 0.5; });

describe('Unified Main workspace', () => {
  it('A. idle Home shows Today, To-do, Since yesterday and Suggestions in the first viewport at realistic sizes, without scrolling', async () => {
    for (const [width, height] of [[1440, 900], [1680, 900], [1920, 1080], [1366, 768]] as const) {
      const ctx = await contextAt(width, height, `unified_idle_${width}x${height}`);
      const page = await ctx.newPage();
      await stubRichHome(page);
      await openMain(page);
      assert.equal(await sessionState(page), 'EMPTY_HOME');
      // One Input: the briefing is a quiet bar, collapsed by default; opening it must fit the first viewport without scrolling
      assert.equal(await page.locator('#main-home-briefing').isVisible(), false, 'My Day is collapsed by default');
      await page.click('#main-myday-toggle');
      await page.waitForSelector('.main-briefing-card', { state: 'visible' });
      assert.deepEqual(await page.locator('.main-briefing-card h2').allTextContents(), ['Today', 'To-do', 'Since yesterday', 'Suggestions']);
      for (const id of ['today', 'todo', 'since', 'suggestions']) {
        assert.equal(await visibleInViewport(page, `[data-briefing-section="${id}"]`), true, `${id} card fully inside the ${width}x${height} viewport`);
        assert.equal(await visibleInViewport(page, `[data-briefing-section="${id}"] .main-briefing-row, [data-briefing-section="${id}"] .main-briefing-suggestion`), true, `${id}: first row visible at ${width}x${height}`);
      }
      assert.equal(await visibleInViewport(page, '#main-greeting'), true);
      const composer = await box(page, '.main-composer-card');
      assert.ok(composer.height >= 100 && composer.height <= 125, `the composer is compact at rest, about 100-120px (${Math.round(composer.height)}px) at ${width}x${height}`);
      const scroll = await page.locator('main.center-canvas').evaluate((el: any) => ({ top: el.scrollTop, overflow: el.scrollHeight - el.clientHeight }));
      assert.equal(scroll.top, 0);
      assert.ok(scroll.overflow <= 1, `idle Home needs no scrolling at ${width}x${height} (overflow ${scroll.overflow})`);
      // the real data is shown, not placeholders
      const today = await page.locator('#main-briefing-today').innerText();
      assert.match(today, /Weekly sync with design/);
      assert.match(await page.locator('#main-briefing-todo').innerText(), /Call the client back[\s\S]*Overdue/);
      await ctx.close();
    }
  });

  it('A2. the personal To-do states "unavailable" or "empty" truthfully instead of showing fake tasks', async () => {
    const ctx = await contextAt(1440, 900, 'unified_todo_states');
    const page = await ctx.newPage();
    const states: Array<{ todo: any; expect: RegExp }> = [
      { todo: { status: 'UNAVAILABLE', items: [] }, expect: /isn't available right now/ },
      { todo: { status: 'ERROR', items: [] }, expect: /I couldn't load your to-do list/ },
      { todo: { status: 'OK', items: [] }, expect: /Your to-do list is empty/ },
    ];
    for (const s of states) {
      await page.unroute('**/api/v1/personal/home').catch(() => undefined);
      await page.route('**/api/v1/personal/home', async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        const home = body.data || body;
        home.todo = s.todo;
        await route.fulfill({ response, contentType: 'application/json', body: JSON.stringify(body.data ? { ...body, data: home } : home) });
      });
      await page.goto(`${h.origin}/#home`, { waitUntil: 'domcontentloaded' });
      await page.reload();
      await page.waitForFunction(() => document.querySelector('#main-home-briefing')?.dataset.state === 'ready');
      assert.match(await page.locator('#main-briefing-todo').innerText(), s.expect);
      assert.equal(await page.locator('#main-briefing-todo .main-briefing-row').count(), 0);
    }
    await ctx.close();
  });

  it('B/C. the first prompt turns Home into a conversation: question once, answer inline, composer docked, no duplicate card', async () => {
    const ctx = await contextAt(1440, 900, 'unified_conversation');
    const page = await ctx.newPage();
    await stubRichHome(page);
    const bodies: any[] = [];
    await stubChat(page, ['Tomorrow in Seoul looks clear with a high of 22 degrees.', 'The day after is cloudy, about 19 degrees.'], bodies);
    await openMain(page);
    const question = 'What is the weather in Seoul tomorrow?';
    await ask(page, question);
    await page.waitForFunction(() => document.querySelector('.main-turn[data-kind="answer"]'), undefined, { timeout: 15000 });

    assert.equal(await sessionState(page), 'CONVERSATION');
    assert.equal(await page.locator('.main-hero-row').isVisible(), false, 'the idle greeting is hidden');
    assert.equal(await page.locator('#main-home-briefing').isVisible(), false, 'the briefing collapses while working');
    assert.equal(await page.locator('#main-conversation-bar').isVisible(), true);
    assert.equal(await page.locator('#main-surface-input').inputValue(), '', 'the composer is cleared: the question lives in the stream');
    const surface = await page.locator('#nagex-main-surface').innerText();
    assert.equal(surface.split(question).length - 1, 1, 'the question is rendered exactly once');
    assert.equal(await page.locator('.main-thread-card').count(), 1, 'there is a single conversation card');
    assert.equal(await page.locator('.main-turn').count(), 1);
    assert.match(await page.locator('.main-turn .main-work-summary').innerText(), /high of 22 degrees/);

    // the composer is docked at the bottom of the workspace, below the stream
    const thread = await box(page, '#main-thread-card');
    const composer = await box(page, '.main-composer-card');
    const canvas = await box(page, 'main.center-canvas');
    assert.ok(thread.bottom <= composer.top + 1, 'the stream is above the composer');
    assert.ok(canvas.bottom - composer.bottom < 40, `the composer sits at the bottom (gap ${Math.round(canvas.bottom - composer.bottom)}px)`);
    assert.ok(composer.bottom <= 900 + 0.5);

    // a plain answer is just the answer: no agent dashboard, no internal routing identifiers
    const turnText = await page.locator('.main-turn').innerText();
    assert.doesNotMatch(turnText, /\bASK\b|Answered|msg_|req_|Request captured|Classify intent|Intent classified|Answer prepared|PLAN|QUESTION/);
    assert.equal(await page.locator('.main-turn .main-step-list').isVisible(), false);

    // follow-up: appended, the first turn is kept
    await ask(page, 'And the day after?');
    await page.waitForFunction(() => document.querySelectorAll('.main-turn[data-kind="answer"]').length === 2, undefined, { timeout: 15000 });
    assert.equal(await page.locator('.main-turn').count(), 2);
    assert.match(await page.locator('.main-turn').nth(0).innerText(), /high of 22 degrees/);
    assert.match(await page.locator('.main-turn').nth(1).innerText(), /cloudy/);
    assert.equal(bodies.length, 2);
    assert.equal(await page.locator('#main-request-text').count(), 1, 'only the newest turn owns the element ids');
    await ctx.close();
  });

  it('D. a complex task shows its real plan, step progress and the real pending approval inline, with working controls', async () => {
    const ctx = await contextAt(1440, 900, 'unified_task');
    const page = await ctx.newPage();
    await stubRichHome(page);
    const plan = {
      goal: 'Prepare the client meeting', summary: 'Prepare the client meeting pack', reasoningSummary: 'Gather, draft, send.', suggestions: [],
      steps: [
        { step: 1, title: 'Gather the latest account notes', reasoning: 'Collect context', skill: 'research', tool: null, requiresApproval: false },
        { step: 2, title: 'Draft the summary email', reasoning: 'Write it', skill: 'drafting', tool: 'gmail.create_draft', requiresApproval: false },
        { step: 3, title: 'Send the email to the client', reasoning: 'Deliver it', skill: 'email', tool: 'gmail.send_email', requiresApproval: true },
      ],
    };
    await page.route('**/api/v1/ambient/intent', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ plan }) }));
    await page.route('**/api/v1/approvals', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ approvals: [], pending: [{ id: 'appr_task_1', approvalId: 'appr_task_1', toolId: 'gmail.send_email', action: 'Send email', status: 'PENDING', createdAt: iso(-60_000), expiresAt: iso(HOUR) }], inProgress: [], recent: [], counts: { pending: 1, inProgress: 0, recent: 0 }, total: 1 }) });
    });
    const decisions: string[] = [];
    await page.route('**/api/v1/approvals/appr_task_1/*', async (route) => {
      decisions.push(route.request().url().split('/').pop() || '');
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ approvalId: 'appr_task_1', status: 'APPROVED' }) });
    });
    await openMain(page);
    // no mode is chosen: "... and email the summary" is an action, so the words alone lead to the approval-gated plan
    await ask(page, 'Prepare the client meeting and email the summary');
    await page.waitForSelector('.main-turn[data-kind="task"] .main-approval-card', { timeout: 15000 });

    const steps = await page.locator('.main-turn[data-kind="task"] .main-step-list li > span:nth-child(2)').allTextContents();
    assert.deepEqual(steps.map((s) => s.trim()), ['Gather the latest account notes', 'Draft the summary email', 'Send the email to the client'], 'exactly the plan\'s own steps, none invented');
    assert.equal(await page.locator('.main-turn[data-kind="task"] .main-step-list').isVisible(), true);
    assert.match(await page.locator('.main-turn[data-kind="task"]').innerText(), /Approval needed before execution/);
    const card = page.locator('.main-approval-card');
    assert.match(await card.innerText(), /Send email/);
    assert.doesNotMatch(await page.locator('.main-turn').innerText(), /gmail\.send_email|gmail\.create_draft|appr_task_1/, 'no internal tool or approval ids in the ordinary UI');
    await card.locator('button.btn-primary').click();
    await page.waitForFunction(() => document.querySelector('.main-approval-card')?.getAttribute('data-decision') === 'approve');
    assert.deepEqual(decisions, ['approve']);
    assert.match(await card.innerText(), /Approved/);
    await ctx.close();
  });

  it('D2. execution evidence stays inspectable: ids are hidden in ordinary UI, shown by "Show details" and in diagnostics', async () => {
    const plan = { goal: 'g', summary: 'A plan', reasoningSummary: 'r', suggestions: [], steps: [{ step: 1, title: 'Prepare the draft', reasoning: 'x', skill: 's', tool: 'gmail.create_draft', requiresApproval: false }] };
    for (const diagnostics of [false, true]) {
      const ctx = await contextAt(1440, 900, `unified_evidence_${diagnostics}`);
      if (diagnostics) await ctx.addInitScript(() => { try { window.localStorage.setItem('nagex_main_diagnostics', '1'); } catch { /* storage unavailable */ } });
      const page = await ctx.newPage();
      await page.route('**/api/v1/ambient/intent', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ plan: { ...plan, steps: [{ ...plan.steps[0], resolvedToolId: 'gmail.create_draft' }] } }) }));
      await openMain(page);
      await ask(page, 'Prepare a draft for the client');
      await page.waitForSelector('.main-turn[data-kind="task"]', { timeout: 15000 });
      const stepText = () => page.locator('.main-turn .main-step-list').innerText();
      if (!diagnostics) {
        assert.doesNotMatch(await stepText(), /gmail\.create_draft/);
        const toggle = page.locator('.main-turn .main-turn-details');
        assert.equal(await toggle.isVisible(), true, 'real evidence exists, so it can be inspected');
        await toggle.click();
        assert.match(await stepText(), /gmail\.create_draft/);
        await toggle.click();
        assert.doesNotMatch(await stepText(), /gmail\.create_draft/);
      } else {
        assert.match(await stepText(), /gmail\.create_draft/, 'developer diagnostics show the identifiers');
      }
      await ctx.close();
    }
  });

  it('E. the briefing collapses while working and My Day reopens it without touching the conversation or the draft', async () => {
    const ctx = await contextAt(1440, 900, 'unified_myday');
    const page = await ctx.newPage();
    await stubRichHome(page);
    await stubChat(page, ['First answer.', 'Second answer.']);
    await openMain(page);
    await ask(page, 'First question');
    await page.waitForFunction(() => document.querySelector('.main-turn[data-kind="answer"]'));
    assert.equal(await page.locator('#main-home-briefing').isVisible(), false);
    await page.fill('#main-surface-input', 'a half-written follow-up');
    const toggle = page.locator('#main-myday-toggle');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('#main-home-briefing').isVisible(), true, 'My Day shows the briefing again');
    assert.deepEqual(await page.locator('.main-briefing-card h2').allTextContents(), ['Today', 'To-do', 'Since yesterday', 'Suggestions']);
    assert.match(await page.locator('#main-briefing-todo').innerText(), /Call the client back/);
    assert.equal(await page.locator('.main-turn').count(), 1, 'the conversation is untouched');
    assert.equal(await page.locator('#main-surface-input').inputValue(), 'a half-written follow-up', 'the draft is untouched');
    assert.equal(await sessionState(page), 'CONVERSATION');
    // reopened inside the viewport, and the composer is still docked below everything
    assert.equal(await visibleInViewport(page, '[data-briefing-section="today"]'), true);
    const composer = await box(page, '.main-composer-card');
    assert.ok(composer.bottom <= 900.5);
    await toggle.click();
    assert.equal(await page.locator('#main-home-briefing').isVisible(), false);
    assert.equal(await page.locator('#main-surface-input').inputValue(), 'a half-written follow-up');
    await ctx.close();
  });

  it('F. New conversation returns to the idle Home with the briefing visible', async () => {
    const ctx = await contextAt(1440, 900, 'unified_new');
    const page = await ctx.newPage();
    await stubRichHome(page);
    await stubChat(page, ['An answer.']);
    await openMain(page);
    await ask(page, 'Something to ask');
    await page.waitForFunction(() => document.querySelector('.main-turn[data-kind="answer"]'));
    await page.click('#main-myday-toggle');
    await page.click('#main-new-conversation');
    await page.waitForFunction(() => document.querySelector('#nagex-main-surface')?.dataset.sessionState === 'EMPTY_HOME');
    assert.equal(await page.locator('.main-hero-row').isVisible(), true);
    // the fresh Home is quiet: My Day is collapsed, available, and "New conversation" has nothing to start over from
    assert.equal(await page.locator('#main-home-briefing').isVisible(), false);
    assert.equal(await page.locator('#main-myday-toggle').isVisible(), true);
    assert.equal(await page.locator('#main-new-conversation').isVisible(), false);
    assert.equal(await page.locator('.main-turn').count(), 0);
    await page.click('#main-myday-toggle');
    assert.equal(await page.locator('#main-home-briefing').isVisible(), true);
    assert.equal(await visibleInViewport(page, '[data-briefing-section="today"]'), true);
    await ctx.close();
  });

  it('G. refresh restores the whole conversation and a started-fresh Home stays fresh', async () => {
    const ctx = await contextAt(1440, 900, 'unified_refresh');
    const page = await ctx.newPage();
    await stubRichHome(page);
    const t0 = Date.now();
    const messages = [
      { messageId: 'm1', role: 'USER', content: 'Plan my week', createdAt: new Date(t0 - 5 * 60_000).toISOString(), status: 'COMMITTED' },
      { messageId: 'm2', role: 'ASSISTANT', content: 'Here is a draft of your week.', createdAt: new Date(t0 - 4 * 60_000).toISOString(), status: 'COMMITTED' },
      { messageId: 'm3', role: 'USER', content: 'Move the review to Friday', createdAt: new Date(t0 - 3 * 60_000).toISOString(), status: 'COMMITTED' },
      { messageId: 'm4', role: 'ASSISTANT', content: 'Done: the review is on Friday.', createdAt: new Date(t0 - 2 * 60_000).toISOString(), status: 'COMMITTED' },
    ];
    await page.route('**/api/v1/conversations/main', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ messages }) }));
    await openMain(page);
    await page.waitForFunction(() => document.querySelector('#nagex-main-surface')?.dataset.sessionState === 'CONVERSATION');
    assert.equal(await page.locator('.main-turn').count(), 2);
    const text = await page.locator('#main-turns').innerText();
    assert.ok(text.indexOf('Plan my week') < text.indexOf('Here is a draft') && text.indexOf('Here is a draft') < text.indexOf('Move the review') && text.indexOf('Move the review') < text.indexOf('Done: the review'), 'turns are restored in order');
    assert.equal(text.split('Plan my week').length - 1, 1, 'each question once');
    assert.equal(await page.locator('#main-home-briefing').isVisible(), false);
    assert.doesNotMatch(text, /Earlier in this conversation|Answered|Restored from/);

    // reload keeps the conversation; starting fresh and reloading keeps Home fresh
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#nagex-main-surface')?.dataset.sessionState === 'CONVERSATION');
    assert.equal(await page.locator('.main-turn').count(), 2);
    await page.click('#main-new-conversation');
    await page.waitForFunction(() => document.querySelector('#nagex-main-surface')?.dataset.sessionState === 'EMPTY_HOME');
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#nagex-main-surface')?.dataset.sessionState === 'EMPTY_HOME');
    assert.equal(await page.locator('#main-home-briefing').isVisible(), false);
    await page.click('#main-myday-toggle');
    assert.equal(await page.locator('#main-home-briefing').isVisible(), true);
    assert.equal(await page.locator('.main-turn').count(), 0);
    await ctx.close();
  });

  it('H. Korean: the whole flow is localized, with no raw keys or internal identifiers', async () => {
    const ctx = await contextAt(1440, 900, 'unified_ko', 'ko');
    const page = await ctx.newPage();
    await stubRichHome(page);
    await stubChat(page, ['내일 서울은 맑고 최고 기온은 22도입니다.']);
    await openMain(page);
    assert.deepEqual(await page.locator('.main-briefing-card h2').allTextContents(), ['오늘', '할 일', '어제 이후', '추천']);
    assert.match(await page.locator('#main-briefing-todo').innerText(), /기한 지남|오늘 마감|예정됨/);
    await ask(page, '내일 서울 날씨 알려줘');
    await page.waitForFunction(() => document.querySelector('.main-turn[data-kind="answer"]'));
    assert.equal((await page.locator('#main-myday-toggle').innerText()).trim(), '오늘의 일정과 할 일');
    assert.equal((await page.locator('#main-new-conversation').innerText()).trim(), '새 대화');
    const text = await page.locator('#nagex-main-surface').innerText();
    assert.doesNotMatch(text, /mainBriefing\.|mainText\.|mainDay\.|Answered|ASK\b/);
    await page.click('#main-myday-toggle');
    assert.match(await page.locator('#main-briefing-today').innerText(), /승인 필요: 이메일 보내기/, 'tool ids become plain, localized actions');
    await ctx.close();
  });

  it('I. controls are real: nothing offered is inert, disabled modes explain why, and diagnostics-only text stays hidden', async () => {
    const ctx = await contextAt(1440, 900, 'unified_controls');
    const page = await ctx.newPage();
    await stubRichHome(page);
    await stubChat(page, ['An answer.']);
    await openMain(page);
    const disabled = await page.locator('#main-mode-row button:disabled').evaluateAll((els: any[]) => els.map((e) => ({ label: e.textContent.trim(), title: e.getAttribute('title') })));
    assert.ok(disabled.length >= 1 && disabled.every((d) => d.title && d.title.length > 10), 'disabled modes carry a truthful reason');
    await ask(page, 'Hello');
    await page.waitForFunction(() => document.querySelector('.main-turn[data-kind="answer"]'));
    for (const selector of ['#main-myday-toggle', '#main-new-conversation']) {
      const el = page.locator(selector);
      assert.equal(await el.isVisible(), true, selector);
      assert.equal(await el.isDisabled(), false, selector);
    }
    const actions = await page.locator('.main-turn .main-inline-actions button').allInnerTexts();
    assert.ok(actions.length >= 1 && actions.every((a) => a.trim().length > 0));
    await page.click('.main-turn .main-inline-actions button:has-text("Ask follow-up")');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'main-surface-input');
    await ctx.close();
  });
  // ── agent run: a plan becomes a real Task and its REAL run state is shown ──
  const PLAN = {
    goal: 'Prepare the client meeting', summary: 'Prepare the client meeting pack', reasoningSummary: 'Gather, draft, send.', suggestions: [],
    steps: [
      { step: 1, title: 'Draft the summary email', reasoning: 'Write it', skill: 'drafting', tool: 'gmail.create_draft', requiresApproval: false },
      { step: 2, title: 'Send the email to the client', reasoning: 'Deliver it', skill: 'email', tool: 'gmail.send_email', requiresApproval: true },
    ],
  };

  const SEAL = { planHash: 'f'.repeat(64), token: '1893456000000.sealed-by-the-server-for-the-test', expiresAt: new Date(Date.now() + HOUR).toISOString() };
  const RUNNABLE = { ok: true, reasons: [], capabilityId: 'gmail.send_email' };

  // the plan route is stubbed (no model in the harness); what a plan preview carries is what the real route returns: the plan, its seal, and whether Home can ask for approval
  async function planPage(label: string, preview: Record<string, unknown> = { runnable: RUNNABLE, planSeal: SEAL }): Promise<{ ctx: BrowserContext; page: Page }> {
    const ctx = await contextAt(1440, 900, label);
    const page = await ctx.newPage();
    await stubRichHome(page);
    await page.route('**/api/v1/ambient/intent', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'PLAN_PREVIEW', plan: PLAN, ...preview }) }));
    await openMain(page);
    await ask(page, 'Prepare the client meeting and email the summary');
    await page.waitForSelector('.main-turn[data-kind="task"]', { timeout: 15000 });
    return { ctx, page };
  }
  const REQUEST = '.main-turn .main-inline-actions button:has-text("Request approval to run")';

  it('D3. "Request approval to run" sends the reviewed plan, shows the exact proposal and WAITING approval with nothing done, and reports a tool response (not a verified outcome) after approval', async () => {
    const { ctx, page } = await planPage('unified_run_flow');
    const posts: string[] = [];
    const bodies: any[] = [];
    let runsPolled = 0;
    page.on('request', (r) => { if (r.method() === 'POST') posts.push(new URL(r.url()).pathname); });
    const decisions: string[] = [];
    await page.route('**/api/v1/tasks/from-reviewed-plan', async (route) => {
      bodies.push(route.request().postDataJSON());
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        state: 'APPROVAL_REQUIRED', taskId: 'task_run_1', runId: 'run_1', planHash: SEAL.planHash,
        run: { runId: 'run_1', taskId: 'task_run_1', status: 'WAITING_APPROVAL', startedAt: iso(-1000), completedAt: null, errorCode: null, result: null },
        proposal: { capabilityId: 'gmail.send_email', arguments: [{ name: 'to', value: 'client@example.com' }, { name: 'subject', value: 'Meeting summary' }], approval: { approvalId: 'appr_run_1', status: 'PENDING', expiresAt: iso(HOUR) } },
      }) });
    });
    await page.route('**/api/v1/tasks/task_run_1/runs', async (route) => {
      runsPolled += 1;
      const done = decisions.length > 0;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ total: 1, runs: [done
        ? { runId: 'run_1', taskId: 'task_run_1', status: 'SUCCEEDED', startedAt: iso(-5000), completedAt: iso(0), errorCode: null, result: { kind: 'STEP_EXECUTION', steps: [{ step: 1, capabilityId: 'gmail.send_email', status: 'EXECUTED', result: { text: 'Provider accepted the message.' } }] } }
        : { runId: 'run_1', taskId: 'task_run_1', status: 'WAITING_APPROVAL', startedAt: iso(-5000), completedAt: null, errorCode: null, result: null }] }) });
    });
    await page.route('**/api/v1/approvals', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const pending = decisions.length ? [] : [{ id: 'appr_run_1', approvalId: 'appr_run_1', toolId: 'gmail.send_email', action: 'Send email', status: 'PENDING', createdAt: iso(-1000), expiresAt: iso(HOUR) }];
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ approvals: pending, pending, inProgress: [], recent: [], counts: { pending: pending.length, inProgress: 0, recent: 0 }, total: pending.length }) });
    });
    await page.route('**/api/v1/approvals/appr_run_1/*', async (route) => { decisions.push(route.request().url().split('/').pop() || ''); await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ approvalId: 'appr_run_1', status: 'APPROVED' }) }); });

    // before the click nothing was requested; the button says what it does
    assert.equal(await page.locator('.main-turn .main-inline-actions button:has-text("Run this plan")').count(), 0, 'no button claims to run it');
    assert.deepEqual(posts.filter((p) => /tasks|approvals/.test(p)), []);
    await page.click(REQUEST);
    await page.waitForSelector('.main-run-block[data-run-state="WAITING_APPROVAL"]', { timeout: 15000 });
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].planSeal.token, SEAL.token, 'the seal of the plan that was shown travels with it');
    assert.equal(bodies[0].plan.steps.length, 2);
    assert.deepEqual(posts.filter((p) => /\/api\/v1\/tasks/.test(p)), ['/api/v1/tasks/from-reviewed-plan'], 'no separate task creation or run call: one reviewed-plan request');
    const waiting = await page.locator('.main-run-block').innerText();
    assert.match(waiting, /Waiting for your approval - nothing has been done yet/);
    assert.match(waiting, /It will only happen if you approve below/);
    assert.match(waiting, /You are asked to approve: Send email/);
    assert.match(waiting, /to\s+client@example\.com/);
    assert.match(waiting, /subject\s+Meeting summary/);
    assert.doesNotMatch(waiting, /gmail\.send_email|appr_run_1|task_run_1|run_1/, 'no internal ids in the ordinary UI');
    // the real pending approval is right there, in the same session; nothing is decided for the person
    await page.waitForSelector('.main-approval-card');
    assert.deepEqual(decisions, []);
    await page.locator('.main-approval-card button.btn-primary').click();
    await page.waitForSelector('.main-run-block[data-run-state="TOOL_RESPONDED"]', { timeout: 20000 });
    assert.deepEqual(decisions, ['approve']);
    const done = await page.locator('.main-run-block').innerText();
    assert.match(done, /Tool responded/);
    assert.match(done, /has not independently checked the result/);
    assert.match(done, /Step 1 - Send email/);
    assert.match(done, /Provider accepted the message\./);
    assert.doesNotMatch(done, /Completed|The plan finished/, 'a provider response is not reported as a completed, verified outcome');
    assert.ok(runsPolled >= 1);
    await ctx.close();
  });

  it('D4. a refused or failed request leaves the plan reviewable with the reason; a declined approval reads "Not run"; Cancel stops a waiting run through the real endpoint', async () => {
    // the REAL server: a seal it did not issue is refused (403) and nothing is started
    const failed = await planPage('unified_run_failed');
    await failed.page.click(REQUEST);
    await failed.page.waitForSelector('.main-run-block[data-run-state="FAILED"]', { timeout: 30000 });
    const text = await failed.page.locator('.main-run-block').innerText();
    assert.match(text, /couldn't confirm that this is the plan you were shown, so nothing was started/);
    assert.equal(await failed.page.locator('.main-run-steps li.done').count(), 0, 'nothing is shown as done that did not run');
    assert.doesNotMatch(text, /task_|run_|[A-Z_]{8,}/, 'no internal ids or codes');
    assert.equal(await failed.page.locator(REQUEST).isVisible(), true, 'the plan stays reviewable and the request can be tried again');
    await failed.ctx.close();

    // a plan Home cannot take to approval is a preview with the reason, and has no request button at all
    const preview = await planPage('unified_run_preview_only', { runnable: { ok: false, reasons: ['PLAN_NOT_SINGLE_STEP'], capabilityId: null }, planSeal: SEAL });
    assert.equal(await preview.page.locator(REQUEST).count(), 0);
    assert.match(await preview.page.locator('.main-turn').innerText(), /This is a preview only: From Home, NAgex sends one step at a time for approval/);
    await preview.ctx.close();

    // a declined approval: the run ends "Not run - you declined"
    const declined = await planPage('unified_run_declined');
    await declined.page.route('**/api/v1/tasks/from-reviewed-plan', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: 'APPROVAL_REQUIRED', taskId: 'task_dec_1', runId: 'run_d', planHash: SEAL.planHash, run: { runId: 'run_d', taskId: 'task_dec_1', status: 'WAITING_APPROVAL', startedAt: iso(-1000), completedAt: null, errorCode: null, result: null }, proposal: { capabilityId: 'gmail.send_email', arguments: [{ name: 'to', value: 'a@example.com' }], approval: { approvalId: 'appr_dec_1', status: 'PENDING', expiresAt: iso(HOUR) } } }) }));
    let rejected = false;
    await declined.page.route('**/api/v1/tasks/task_dec_1/runs', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ total: 1, runs: [rejected ? { runId: 'run_d', taskId: 'task_dec_1', status: 'FAILED', startedAt: iso(-3000), completedAt: iso(0), errorCode: 'APPROVAL_REJECTED', result: null } : { runId: 'run_d', taskId: 'task_dec_1', status: 'WAITING_APPROVAL', startedAt: iso(-3000), completedAt: null, errorCode: null, result: null }] }) }));
    await declined.page.route('**/api/v1/approvals', (route) => route.request().method() !== 'GET' ? route.continue() : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ approvals: [], pending: rejected ? [] : [{ id: 'appr_dec_1', approvalId: 'appr_dec_1', toolId: 'gmail.send_email', action: 'Send email', status: 'PENDING', createdAt: iso(-1000), expiresAt: iso(HOUR) }], inProgress: [], recent: [], counts: { pending: 1, inProgress: 0, recent: 0 }, total: 1 }) }));
    await declined.page.route('**/api/v1/approvals/appr_dec_1/*', async (route) => { rejected = true; await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ approvalId: 'appr_dec_1', status: 'REJECTED' }) }); });
    await declined.page.click(REQUEST);
    await declined.page.waitForSelector('.main-approval-card');
    await declined.page.locator('.main-approval-card button.btn-secondary').click();
    await declined.page.waitForSelector('.main-run-block[data-run-state="DECLINED"]', { timeout: 20000 });
    const declinedText = await declined.page.locator('.main-run-block').innerText();
    assert.match(declinedText, /Not run - you declined/);
    assert.match(declinedText, /nothing was done/);
    await declined.ctx.close();

    const { ctx, page } = await planPage('unified_run_cancel');
    const cancels: string[] = [];
    await page.route('**/api/v1/tasks/from-reviewed-plan', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: 'APPROVAL_REQUIRED', taskId: 'task_cancel_1', runId: 'run_c', planHash: SEAL.planHash, run: { runId: 'run_c', taskId: 'task_cancel_1', status: 'WAITING_APPROVAL', startedAt: iso(-1000), completedAt: null, errorCode: null, result: null }, proposal: { capabilityId: 'gmail.send_email', arguments: [], approval: null } }) }));
    await page.route('**/api/v1/tasks/task_cancel_1/runs', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ total: 0, runs: [] }) }));
    await page.route('**/api/v1/tasks/task_cancel_1/cancel', async (route) => { cancels.push('cancel'); await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ taskId: 'task_cancel_1', status: 'CANCELLED' }) }); });
    await page.route('**/api/v1/approvals', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ approvals: [], pending: [], inProgress: [], recent: [], counts: { pending: 0, inProgress: 0, recent: 0 }, total: 0 }) }));
    await page.click(REQUEST);
    await page.waitForSelector('.main-run-block[data-run-state="WAITING_APPROVAL"] .main-run-cancel:not([hidden])', { timeout: 15000 });
    await page.click('.main-run-cancel');
    await page.waitForSelector('.main-run-block[data-run-state="CANCELLED"]', { timeout: 10000 });
    assert.deepEqual(cancels, ['cancel']);
    assert.match(await page.locator('.main-run-block').innerText(), /Cancelled/);
    assert.equal(await page.locator('.main-run-cancel').isVisible(), false, 'nothing left to cancel');
    await ctx.close();
  });

  it('A3. answers render safe Markdown (headings, lists, tables, code, links) and never interpret raw HTML or javascript: links', async () => {
    const ctx = await contextAt(1440, 900, 'unified_markdown');
    const page = await ctx.newPage();
    await stubRichHome(page);
    const fence = '```';
    const markdown = [
      '## Weekly plan', '',
      'Here is **bold**, *italic* and `inline code` with a [link](https://example.com/docs).', '',
      '- first item', '- second item', '',
      '1. one', '2. two', '',
      '| Day | Task |', '|---|---|', '| Mon | Review |', '| Tue | Ship |', '',
      `${fence}ts`, 'const a = "<b>x</b>";', fence, '',
      '<script>window.__xss=1</script>',
      '<img src=x onerror="window.__xss=2">',
      '[bad](javascript:window.__xss=3)',
    ].join('\n');
    await stubChat(page, [markdown]);
    await openMain(page);
    await ask(page, 'Give me a plan');
    await page.waitForSelector('.main-turn[data-kind="answer"] .main-work-summary h4', { timeout: 15000 });
    const summary = page.locator('.main-turn .main-work-summary');
    assert.equal((await summary.locator('h4').innerText()).trim(), 'Weekly plan');
    assert.equal((await summary.locator('strong').first().innerText()).trim(), 'bold');
    assert.equal((await summary.locator('em').first().innerText()).trim(), 'italic');
    assert.equal((await summary.locator('p code').first().innerText()).trim(), 'inline code');
    const link = summary.locator('a[href="https://example.com/docs"]');
    assert.equal(await link.count(), 1);
    assert.equal(await link.getAttribute('target'), '_blank');
    assert.match((await link.getAttribute('rel')) || '', /noopener/);
    assert.equal(await summary.locator('ul li').count(), 2);
    assert.equal(await summary.locator('ol li').count(), 2);
    assert.equal(await summary.locator('table th').count(), 2);
    assert.equal(await summary.locator('table td').count(), 4);
    assert.equal(await summary.locator('.main-md-code pre code').innerText(), 'const a = "<b>x</b>";', 'code is shown literally, never interpreted');
    assert.equal(await summary.locator('.main-md-copy').count(), 1);
    // untrusted markup stays inert text
    const text = await summary.innerText();
    assert.match(text, /<script>window\.__xss=1<\/script>/);
    assert.equal(await summary.locator('script, img, iframe, object, embed, style').count(), 0);
    assert.equal(await summary.locator('a[href^="javascript:" i]').count(), 0);
    assert.equal(await page.evaluate(() => (window as any).__xss), undefined);
    // the answer is still one turn, and the question is plain text (never Markdown)
    assert.equal(await page.locator('.main-turn').count(), 1);
    await ctx.close();
  });
});

// An advice-only answer (ADVISORY_RESPONSE) is shown as an answer: no plan, no steps, no Run button, no approvals; and it says nothing was done.
describe('Advisory answers in Main', () => {
  const ADVICE = {
    status: 'ADVISORY_RESPONSE', executable: false, message: 'No actions were taken. This is advice only.',
    advice: { goal: 'Be ready for tomorrow', summary: 'Tomorrow\'s review centers on the approval flow; lead with the status and decide the next milestone.', reasoningSummary: 'r', suggestions: ['Open the review by stating where the approval flow stands today.', 'Agree on one owner and a date for the next action.'] },
    provider: 'nebius', model: 'nvidia/Nemotron-3_5-Lightning', latencyMs: 12000, requestId: 'req_adv_1',
  };

  for (const locale of ['en', 'ko'] as const) {
    it(`E1. ${locale}: advice is rendered as an answer with its suggestions and "no actions were taken"; there is nothing to run or approve`, async () => {
      const ctx = await contextAt(1440, 900, `unified_advice_${locale}`, locale);
      const page = await ctx.newPage();
      const requests: string[] = [];
      page.on('request', (r) => { const p = new URL(r.url()).pathname; if (/\/api\/v1\/(tasks|approvals|plans\/resolve)/.test(p) && r.method() !== 'GET') requests.push(`${r.method()} ${p}`); });
      await stubRichHome(page);
      await page.route('**/api/v1/ambient/intent', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ADVICE) }));
      await openMain(page);
      await ask(page, 'Prepare a concise briefing for tomorrow\'s meeting and suggest the next action');
      await page.waitForSelector('.main-turn[data-kind="answer"]', { timeout: 15000 });
      const text = await page.locator('.main-turn').innerText();
      assert.match(text, /approval flow/);
      assert.match(text, locale === 'en' ? /Open the review by stating where the approval flow stands today\./ : /Open the review/);
      assert.match(text, locale === 'en' ? /No actions were taken\. This is advice only\./ : /실행한 작업은 없어요\. 조언만 드려요\./);
      assert.match(text, locale === 'en' ? /Suggested next moves/ : /다음에 해볼 일/);
      assert.equal(await page.locator('.main-turn .main-inline-actions button:has-text("Request approval to run")').count(), 0, 'no request-approval button for advice');
      assert.equal(await page.locator('.main-turn .main-step-list li').count(), 0, 'advice is not shown as steps');
      assert.equal(await page.locator('.main-turn .main-inline-approvals .main-approval, .main-turn .main-run-block').count(), 0);
      assert.deepEqual(requests, [], 'nothing was created, resolved or approved');
      await ctx.close();
    });
  }
});

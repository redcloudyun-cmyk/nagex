// D-11 One Input, Any Outcome - real Chromium against the production server harness (real route-input, real auth, real front end).
// Only the paths BEHIND the routing decision are stubbed (chat / research / creations / plan), so each test can prove WHICH existing path a plain Korean or English
// request reached - and that nothing consequential happened by itself. No model is called; the real Nemotron runs are in the certification report.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright';
import { startCanvasAskHarness, type CanvasAskHarness } from './_canvas_ask_harness.js';

declare const window: any;
declare const document: any;

let h: CanvasAskHarness;
before(async () => { h = await startCanvasAskHarness({ scrubProviders: true }); });
after(async () => { await h?.close(); });

async function contextAt(width: number, height: number, label: string, locale: 'en' | 'ko' = 'en'): Promise<BrowserContext> {
  const user = h.user(label);
  if (locale === 'ko') h.setLocale(user, 'ko');
  const base = await h.newContext('desktop', user, locale);
  const mobile = width < 600;
  const ctx = await h.browser.newContext({ viewport: { width, height }, locale: locale === 'ko' ? 'ko-KR' : 'en-US', ...(mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  await ctx.addCookies(await base.cookies());
  await ctx.addInitScript((l: string) => { try { localStorage.setItem('nagex_locale', l); } catch { /* storage unavailable */ } }, locale);
  await base.close();
  return ctx;
}

interface Calls { all: string[]; bodies: Record<string, any[]> }

const PLAN = {
  goal: 'g', summary: 'Plan: create the meeting after approval', reasoningSummary: 'r', suggestions: [],
  steps: [
    { step: 1, title: 'Confirm the missing time and attendees', reasoning: 'details missing', skill: 'skill.scheduling', tool: 'google_calendar.create_event', requiresApproval: true, necessity: 'REQUIRED' },
  ],
};
const ADVICE = {
  status: 'ADVISORY_RESPONSE', executable: false, message: 'No actions were taken. This is advice only.',
  advice: { goal: 'g', summary: 'Open with the status and agree the next milestone.', reasoningSummary: 'r', suggestions: ['Open the review by stating where the approval flow stands today.', 'Ask the design lead which open item blocks the milestone.'] },
  provider: 'nebius', model: 'nvidia/Nemotron-3_5-Lightning', latencyMs: 9000, requestId: 'req_adv',
};
const RESEARCH_OK = {
  query: 'q', freshness: 'RECENT', category: 'GENERAL', answer: 'AI adoption is growing fast [src_1]; investment rose again [src_2].', evidencePackId: 'evp_1',
  sources: [{ sourceId: 'src_1', title: 'AI Adoption Survey', url: 'https://example.com/survey', retrievedAt: new Date().toISOString(), freshnessStatus: 'FRESH' }, { sourceId: 'src_2', title: 'Investment Report', url: 'https://example.com/invest', retrievedAt: new Date().toISOString(), freshnessStatus: 'FRESH' }],
};

const REPORT_OK = {
  query: 'q', status: 'SUCCESS', runId: 'run_000000000000000000000001', documentId: 'doc_000000000000000000000001', artifactId: 'art_000000000000000000000001', title: 'AI 보고서', summary: 's',
  openTarget: '/api/v1/creations/documents/doc_000000000000000000000001', downloadTarget: '/api/v1/creations/documents/doc_000000000000000000000001/download', provenanceTarget: '/api/v1/research/runs/run_000000000000000000000001', provider: 'custom_http',
  sources: [{ sourceId: 'S1', title: 'AI Adoption Survey', publisher: 'example.com', url: 'https://example.com/survey', retrievedAt: new Date().toISOString(), basis: 'FULL_TEXT' }],
  stats: { candidates: 4, retrieved: 2, cited: 1, claimsVerified: 2, claimsRejected: 1, paragraphsDropped: 0 },
  steps: [{ step: 'PLAN', status: 'DONE' }, { step: 'SEARCH', status: 'DONE' }, { step: 'RETRIEVE', status: 'DONE' }, { step: 'EXTRACT', status: 'DONE' }, { step: 'COMPOSE', status: 'DONE' }, { step: 'PUBLISH', status: 'DONE' }],
};

type Backends = { intent?: any; research?: any; report?: any; documentStatus?: number };

// every backend the routing decision can select; nothing outside the list is answered, and every POST is recorded
async function stubBackends(page: Page, backends: Backends = {}): Promise<Calls> {
  const calls: Calls = { all: [], bodies: {} };
  page.on('request', (r) => { if (r.method() !== 'GET') { const p = new URL(r.url()).pathname; calls.all.push(`${r.method()} ${p}`); } });
  const record = (name: string, route: any) => { (calls.bodies[name] ||= []).push(route.request().postDataJSON()); };
  await page.route('**/api/v1/ai/chat', (route) => { record('chat', route); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { message: '답변입니다.', messageId: 'm_chat' }, requestId: 'r_chat' }) }); });
  await page.route('**/api/v1/ambient/intent', (route) => { record('intent', route); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(backends.intent ?? { plan: PLAN }) }); });
  await page.route('**/api/v1/research/reports', (route) => { record('report', route); return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(backends.report ?? REPORT_OK) }); });
  await page.route('**/api/v1/research', (route) => { record('research', route); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(backends.research ?? RESEARCH_OK) }); });
  await page.route('**/api/v1/creations/documents', (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    record('document', route);
    if (backends.documentStatus && backends.documentStatus >= 400) return route.fulfill({ status: backends.documentStatus, contentType: 'application/json', body: JSON.stringify({ error: 'UNAVAILABLE', message: 'Document creation is unavailable.' }) });
    return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ creationId: 'doc_1', documentId: 'doc_1', artifactId: 'art_doc_1', title: 'AI 보고서', content: '본문', format: 'MARKDOWN', openTarget: '/api/v1/creations/documents/doc_1' }) });
  });
  await page.route('**/api/v1/creations/presentations', (route) => { if (route.request().method() !== 'POST') return route.continue(); record('presentation', route); return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'NO_MODEL_PROVIDER_CONFIGURED' }) }); });
  await page.route('**/api/v1/creations/generate', (route) => { record('image', route); return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'NO_CREATION_PROVIDER_AVAILABLE' }) }); });
  await page.route('**/api/v1/workspace/capture', (route) => { record('capture', route); return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ captureId: 'cap_1' }) }); });
  return calls;
}

async function openMain(page: Page): Promise<void> {
  await page.goto(`${h.origin}/#home`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#main-surface-input', { timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('#nagex-main-surface')?.dataset.sessionState === 'EMPTY_HOME', undefined, { timeout: 20000 });
}

async function ask(page: Page, text: string): Promise<void> {
  await page.fill('#main-surface-input', text);
  await page.click('#main-send');
}

// the thread settles when the last turn is no longer pending
async function settle(page: Page): Promise<string> {
  await page.waitForFunction(() => { const turns = document.querySelectorAll('.main-turn'); const last = turns[turns.length - 1] as any; return Boolean(last) && last.getAttribute('data-kind') !== 'pending'; }, undefined, { timeout: 20000 });
  return page.evaluate(() => { const turns = document.querySelectorAll('.main-turn'); return ((turns[turns.length - 1] as any).innerText as string).replace(/\s+/g, ' ').trim(); });
}

const posts = (calls: Calls) => calls.all.filter((c) => c.startsWith('POST'));
const CONSEQUENTIAL = /\/api\/v1\/(tasks|approvals|executions|gmail|calendar|google|messages|plans)/;

// Korean and English requests, each with the path it must reach and what must NOT happen
const TABLE: Array<{ id: string; locale: 'en' | 'ko'; text: string; reaches: 'chat' | 'intent' | 'research' | 'document' | 'presentation' | 'image' | 'none'; shows: RegExp; advice?: boolean }> = [
  { id: 'A-ko advice', locale: 'ko', text: '내일 회의를 어떻게 준비하면 좋을까?', reaches: 'intent', shows: /조언만 드려요/, advice: true },
  { id: 'A-en advice', locale: 'en', text: "How should I prepare for tomorrow's meeting?", reaches: 'intent', shows: /advice only/i, advice: true },
  { id: 'B-ko action', locale: 'ko', text: '내일 오전 10시에 프로젝트 리뷰 회의를 잡아줘', reaches: 'intent', shows: /Plan: create the meeting after approval/ },
  { id: 'B-en action', locale: 'en', text: 'Schedule a project review meeting tomorrow at 10 AM', reaches: 'intent', shows: /Plan: create the meeting after approval/ },
  { id: 'C-ko research', locale: 'ko', text: '최근 AI 동향을 조사해서 출처와 함께 알려줘', reaches: 'research', shows: /AI Adoption Survey/ },
  { id: 'C-en research', locale: 'en', text: 'Research the latest AI trends and cite sources', reaches: 'research', shows: /AI Adoption Survey/ },
  { id: 'D-ko document', locale: 'ko', text: '이번 회의 내용을 한 페이지 보고서로 작성해줘', reaches: 'document', shows: /AI 보고서|문서를 만들었어요/ },
  { id: 'D-en document', locale: 'en', text: 'Write a one-page report on this meeting', reaches: 'document', shows: /AI 보고서|Document created/ },
  { id: 'E-ko slides', locale: 'ko', text: '로드맵을 10장 슬라이드로 만들어줘', reaches: 'presentation', shows: /발표 자료를 만들지 못했어요/ },
  { id: 'E-en slides', locale: 'en', text: 'Create a 10 slide deck about our roadmap', reaches: 'presentation', shows: /Presentation could not be created/ },
  { id: 'F-ko image', locale: 'ko', text: '일출의 산 풍경 이미지를 만들어줘', reaches: 'image', shows: /이미지를 만들 수 없어요|이미지 서비스/ },
  { id: 'F-en image', locale: 'en', text: 'Generate an image of a mountain at sunrise', reaches: 'image', shows: /Image generation is unavailable|no image service/ },
  { id: 'G-ko video', locale: 'ko', text: '30초 홍보영상 만들어줘', reaches: 'none', shows: /영상 만들기는 아직 지원하지 않아요/ },
  { id: 'G-en video', locale: 'en', text: 'Make a 30 second promo video', reaches: 'none', shows: /Video creation isn't available yet/ },
  { id: 'G-ko code', locale: 'ko', text: '웹사이트 코드 작성해서 실행해줘', reaches: 'none', shows: /앱 만들기·실행은 아직 지원하지 않아요/ },
  { id: 'G-en code', locale: 'en', text: 'Build a website and run it', reaches: 'none', shows: /Building or running an app isn't available yet/ },
  { id: 'I-ko mixed', locale: 'ko', text: '설명해줘 그리고 이메일로 보내줘', reaches: 'intent', shows: /Plan: create the meeting after approval/ },
  { id: 'J-ko delete', locale: 'ko', text: '이 문서를 지워줘', reaches: 'intent', shows: /Plan: create the meeting after approval/ },
  { id: 'J-en delete', locale: 'en', text: 'Delete this document', reaches: 'intent', shows: /Plan: create the meeting after approval/ },
  { id: 'K-ko draft', locale: 'ko', text: '보내지 말고 이메일 초안만 작성해줘', reaches: 'chat', shows: /답변입니다/ },
  { id: 'K-en draft', locale: 'en', text: 'Do not send it, just draft the email', reaches: 'chat', shows: /답변입니다/ },
  { id: 'L-ko vague', locale: 'ko', text: '그거 해줘', reaches: 'none', shows: /한 가지만 알려주세요/ },
  { id: 'L-en vague', locale: 'en', text: 'help', reaches: 'none', shows: /One quick question/ },
  { id: 'F2-ko topicless image', locale: 'ko', text: '이런 이미지를 만들어줘', reaches: 'none', shows: /어떤 이미지를 원하세요/ },
  { id: 'Q-en question', locale: 'en', text: 'How do I send an email in NAgex?', reaches: 'chat', shows: /답변입니다/ },
];

describe('One Input: a plain Korean or English request reaches the existing path that serves it, and nothing runs by itself', () => {
  for (const row of TABLE) {
    it(`${row.id}: ${row.text}`, async () => {
      const ctx = await contextAt(1440, 900, `oi_${row.id.replace(/\W+/g, '_')}`, row.locale);
      const page = await ctx.newPage();
      const calls = await stubBackends(page, row.advice ? { intent: ADVICE } : {});
      await openMain(page);
      await ask(page, row.text);
      const turn = await settle(page);
      assert.match(turn, row.shows, `${row.id}: ${turn}`);
      const reached = Object.keys(calls.bodies);
      if (row.reaches === 'none') assert.deepEqual(reached, [], `${row.id}: no backend path may be called`);
      else assert.ok(reached.includes(row.reaches), `${row.id}: expected ${row.reaches}, reached ${JSON.stringify(reached)}`);
      // the routing decision selected ONE path; the other creation / answer paths stay untouched
      if (row.reaches !== 'none') assert.deepEqual(reached.filter((p) => p !== row.reaches && p !== 'capture'), [], `${row.id}: only ${row.reaches} may be called`);
      // nothing consequential happened: no task, approval, execution or send was created from a request
      assert.deepEqual(posts(calls).filter((c) => CONSEQUENTIAL.test(c)), [], `${row.id}: nothing consequential was created or approved`);
      assert.equal(await page.locator('.main-turn .main-run-block').count(), 0, 'no run was started');
      assert.doesNotMatch(await page.locator('body').innerText(), /mainRoute\.|mainText\.|mainBriefing\.|undefined|\[object/, 'no raw keys');
      await ctx.close();
    });
  }
});

describe('One Input: the optional shortcut and approval boundaries', () => {
  it('a shortcut biases a plain request once, but can never turn an action into something else or make an unsupported kind supported', async () => {
    const ctx = await contextAt(1440, 900, 'oi_shortcut_bounds', 'ko');
    const page = await ctx.newPage();
    const calls = await stubBackends(page);
    await openMain(page);
    // Document shortcut + "delete this document": still an approval-gated plan, never a document
    await page.click('#main-shortcut-toggle');
    await page.click('[data-main-mode="DOCUMENT"]');
    await ask(page, '이 문서를 지워줘');
    await settle(page);
    assert.deepEqual(Object.keys(calls.bodies), ['intent']);
    assert.deepEqual(posts(calls).filter((c) => CONSEQUENTIAL.test(c)), []);
    // Image shortcut + a video request: still "not available", no image call
    await page.click('#main-shortcut-toggle');
    await page.click('[data-main-mode="IMAGE"]');
    await ask(page, '홍보 영상 만들어줘');
    const turn = await settle(page);
    assert.match(turn, /영상 만들기는 아직 지원하지 않아요/);
    assert.equal(Object.keys(calls.bodies).includes('image'), false);
    await ctx.close();
  });

  it('an action is only a plan: the approval-required step is shown, nothing is sent, and no run starts until the person asks', async () => {
    const ctx = await contextAt(1440, 900, 'oi_action_gate', 'ko');
    const page = await ctx.newPage();
    const calls = await stubBackends(page);
    await openMain(page);
    await ask(page, '알렉스에게 보고서가 준비됐다고 메일을 보내줘');
    const turn = await settle(page);
    assert.match(turn, /Plan: create the meeting after approval/);
    assert.match(turn, /필요한 승인은 그대로 필수이며/, 'the approval boundary is stated with the plan');
    assert.deepEqual(Object.keys(calls.bodies), ['intent']);
    assert.deepEqual(posts(calls).filter((c) => CONSEQUENTIAL.test(c)), [], 'no task, approval or send before the person acts');
    await ctx.close();
  });

  it('a plan that Home cannot take to approval has no run button and says why; a plan-only run is never called completed', async () => {
    const ctx = await contextAt(1440, 900, 'oi_run_truth', 'en');
    const page = await ctx.newPage();
    const calls = await stubBackends(page);
    await openMain(page);
    await ask(page, 'Schedule a project review meeting tomorrow at 10 AM');
    const turn = await settle(page);
    // the stubbed plan route returns a plan without a seal or a runnable verdict: the screen offers nothing to run and says it is a preview
    assert.equal(await page.locator('.main-turn .main-inline-actions button:has-text("Request approval to run")').count(), 0);
    assert.equal(await page.locator('.main-turn .main-inline-actions button:has-text("Run this plan")').count(), 0, 'nothing claims to run the plan');
    assert.match(turn, /This is a preview only:/);
    assert.deepEqual(posts(calls).filter((c) => CONSEQUENTIAL.test(c)), []);
    await ctx.close();
  });
});

describe('One Input: research, then a report - a real compound, or a truthful stop', () => {
  for (const locale of ['ko', 'en'] as const) {
    it(`${locale}: one research-report request (search, retrieve, verify, compose happen on the server), in the request language, with no model-written document request`, async () => {
      const ctx = await contextAt(1440, 900, `oi_compound_${locale}`, locale === 'ko' ? 'en' : 'ko'); // the screen language differs on purpose: the REQUEST decides
      const page = await ctx.newPage();
      const calls = await stubBackends(page);
      await openMain(page);
      await ask(page, locale === 'ko' ? 'AI 동향을 조사해서 보고서로 만들어줘' : 'Research the AI market and turn it into a report');
      await page.waitForSelector('#main-result-panel:not([hidden])', { timeout: 20000 });
      const order = calls.all.filter((c) => /research|creations\/documents/.test(c));
      assert.deepEqual(order, ['POST /api/v1/research/reports'], 'one request - the server searches, retrieves, verifies and composes the report');
      const report = calls.bodies.report[0];
      assert.equal(report.locale, locale, 'the report follows the language of the request, not the screen');
      assert.match(report.query, locale === 'ko' ? /AI 동향/ : /AI market/, 'the question travels as the person wrote it');
      assert.equal(Object.keys(calls.bodies).includes('document'), false, 'the client never asks a model to write the report text');
      assert.equal(await page.locator('#main-result-kind').textContent(), 'DOC');
      assert.equal(await page.locator('#main-result-sources').isEnabled(), true, 'the Sources tab is available for a research report');
      assert.deepEqual(posts(calls).filter((c) => CONSEQUENTIAL.test(c)), []);
      await ctx.close();
    });
  }

  it('when research finds no verified source the report is NOT written and the person is told which step stopped', async () => {
    const ctx = await contextAt(1440, 900, 'oi_compound_stop', 'en');
    const page = await ctx.newPage();
    const calls = await stubBackends(page, { report: { query: 'q', status: 'UNAVAILABLE', code: 'SEARCH_UNAVAILABLE', message: 'Live web search is not configured, so no research was performed and no report was written.', provider: 'custom_http', steps: [{ step: 'SEARCH', status: 'FAILED', detail: 'No web search provider is configured.' }] } });
    await openMain(page);
    await ask(page, 'Research the AI market and turn it into a report');
    const turn = await settle(page);
    assert.match(turn, /Research is not available/i);
    assert.match(turn, /no research was performed and no report was written/i);
    assert.equal(Object.keys(calls.bodies).includes('document'), false, 'no unsourced report');
    assert.equal(await page.locator('#main-result-panel').isHidden(), true);
    await ctx.close();
  });

  it('a plain research answer lists its real sources as links, and "Create report" is a next step the person confirms', async () => {
    const ctx = await contextAt(1440, 900, 'oi_research_sources', 'en');
    const page = await ctx.newPage();
    const calls = await stubBackends(page);
    await openMain(page);
    await ask(page, 'Research the latest AI trends and cite sources');
    await settle(page);
    const links = await page.locator('.main-turn a[href^="https://example.com/"]').evaluateAll((els: any[]) => els.map((e) => ({ href: e.href, rel: e.rel })));
    assert.deepEqual(links.map((l) => l.href), ['https://example.com/survey', 'https://example.com/invest']);
    assert.ok(links.every((l) => /noopener/.test(l.rel)));
    assert.equal(Object.keys(calls.bodies).includes('document'), false, 'the report is not written until the person asks');
    await page.click('.main-turn .main-inline-actions button:has-text("Create report")');
    await page.waitForSelector('#main-result-panel:not([hidden])', { timeout: 20000 });
    assert.match(calls.bodies.document[0].prompt, /ONLY from these verified research findings/);
    await ctx.close();
  });

  it('"make slides from this" uses the previous answer as the source; with nothing to refer to it asks instead of inventing a topic', async () => {
    const ctx = await contextAt(1440, 900, 'oi_context_ref', 'ko');
    const page = await ctx.newPage();
    const calls = await stubBackends(page);
    await openMain(page);
    await ask(page, '이 주제로 10장 슬라이드 만들어줘');
    const asked = await settle(page);
    assert.match(asked, /슬라이드 주제와 대략적인 장수를 알려주세요/);
    assert.equal(Object.keys(calls.bodies).includes('presentation'), false, 'nothing is created for a topic that does not exist');
    await ask(page, 'AI 시장 현황이 뭐야');
    await page.waitForFunction(() => document.querySelectorAll('.main-turn[data-kind="answer"]').length >= 1, undefined, { timeout: 15000 });
    await ask(page, '이 주제로 10장 슬라이드 만들어줘');
    await page.waitForFunction(() => document.querySelectorAll('.main-turn').length >= 3, undefined, { timeout: 15000 });
    await settle(page);
    assert.equal(calls.bodies.presentation?.length, 1);
    assert.match(calls.bodies.presentation[0].prompt, /답변입니다/, 'the previous answer travels as the source material');
    assert.equal(calls.bodies.presentation[0].locale, 'ko');
    await ctx.close();
  });
});

describe('One Input: compact composer, optional shortcuts, collapsed My Day (EN/KR at 1440, 430, 390, 360)', () => {
  const SIZES: Array<[number, number]> = [[1440, 900], [430, 932], [390, 844], [360, 740]];
  for (const locale of ['en', 'ko'] as const) {
    for (const [width, height] of SIZES) {
      it(`${locale} ${width}px: compact at rest, no overflow, 44px touch targets on phones, the + menu is keyboard-usable, My Day is collapsed by default`, async () => {
        const ctx = await contextAt(width, height, `oi_layout_${locale}_${width}`, locale);
        const page = await ctx.newPage();
        await stubBackends(page);
        await openMain(page);
        const overflow = () => page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - window.innerWidth));
        assert.equal(await overflow(), 0, 'no horizontal overflow');

        // compact at rest: desktop about 100-120px; phones just have to be short and fit
        const card = await page.locator('.main-composer-card').boundingBox();
        assert.ok(card);
        if (width >= 861) assert.ok(card.height >= 100 && card.height <= 125, `desktop composer rests at about 100-120px (${card.height})`);
        else assert.ok(card.height <= 260, `phone composer stays short (${card.height})`);
        assert.ok(card.x >= 0 && card.x + card.width <= width + 0.5, 'the composer fits the viewport');

        // no mode chips on the top level; the optional shortcuts live under "+"
        assert.equal(await page.locator('#main-mode-row').isVisible(), false);
        const toggle = page.locator('#main-shortcut-toggle');
        assert.equal(await toggle.getAttribute('aria-haspopup'), 'menu');
        assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
        assert.ok((await toggle.getAttribute('aria-label') || '').length > 3, 'the + button has an accessible name');

        // growing: focus opens the box up, and long text grows it further without clipping
        await page.click('#main-surface-input');
        const focused = await page.locator('.main-composer-card').boundingBox();
        assert.ok(focused && focused.height >= card.height, 'the box does not shrink on focus');
        await page.fill('#main-surface-input', (locale === 'ko' ? '긴 요청입니다. ' : 'A long request. ').repeat(width >= 861 ? 30 : 8));
        const grown = await page.locator('#main-surface-input').evaluate((el: any) => ({ height: el.getBoundingClientRect().height, clipped: el.scrollHeight > el.clientHeight + 2 }));
        assert.ok(grown.height > 60 && !grown.clipped, `long text grows the box without clipping (${grown.height})`);
        await page.fill('#main-surface-input', '');

        // keyboard: Enter on "+" opens the menu with focus inside, arrows move, Escape closes and returns focus
        await toggle.focus();
        await page.keyboard.press('Enter');
        assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
        assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-main-mode')), 'RESEARCH');
        await page.keyboard.press('ArrowDown');
        assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-main-mode')), 'DOCUMENT');
        const menu = await page.locator('#main-mode-row').boundingBox();
        assert.ok(menu && menu.x >= -0.5 && menu.x + menu.width <= width + 0.5, `the menu stays inside the viewport horizontally (${menu?.x}..${menu ? menu.x + menu.width : 0})`);
        for (const mode of ['VIDEO', 'CODE']) {
          assert.equal(await page.locator(`[data-main-mode="${mode}"]`).isDisabled(), true, `${mode} is disabled`);
          assert.ok(((await page.locator(`[data-main-mode="${mode}"]`).getAttribute('title')) || '').length > 10, `${mode} explains why`);
        }
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#main-mode-row').isVisible(), false);
        assert.equal(await page.evaluate(() => document.activeElement?.id), 'main-shortcut-toggle');
        // a click elsewhere closes it too
        await page.click('#main-shortcut-toggle');
        await page.click('#main-greeting');
        assert.equal(await page.locator('#main-mode-row').isVisible(), false);

        // My Day: a quiet bar, collapsed until opened
        const day = page.locator('#main-myday-toggle');
        assert.equal(await day.getAttribute('aria-expanded'), 'false');
        assert.equal(await page.locator('#main-home-briefing').isVisible(), false);
        await day.click();
        assert.equal(await day.getAttribute('aria-expanded'), 'true');
        assert.equal(await page.locator('#main-home-briefing').isVisible(), true);
        assert.equal(await overflow(), 0, 'no overflow with My Day open');
        await day.click();
        assert.equal(await page.locator('#main-home-briefing').isVisible(), false);

        // phones: every control in the composer and the My Day bar is at least 44px high
        if (width < 600) {
          const small = await page.evaluate(() => {
            const targets = ['#main-shortcut-toggle', '#main-attach', '#main-web-toggle', '#main-data-toggle', '#main-mic', '#main-voice', '#main-plan-toggle', '#main-send', '#main-myday-toggle'];
            return targets.map((s) => { const r = document.querySelector(s)?.getBoundingClientRect(); return { s, h: r ? Math.round(r.height) : -1, w: r ? Math.round(r.width) : -1 }; }).filter((t) => t.h < 44 || t.w < 44);
          });
          assert.deepEqual(small, [], 'touch targets of at least 44px');
        }
        assert.doesNotMatch(await page.locator('body').innerText(), /mainRoute\.|mainText\.|mainBriefing\./);
        await ctx.close();
      });
    }
  }
});

describe('One Input: Korean wording - the Vault is "보관함", follow-up and save are separate spaced buttons', () => {
  it('ko: "이어서 질문" and "보관함에 저장" are two distinct accessible buttons with room between them (no "Vault에 저장")', async () => {
    for (const width of [1440, 390, 360]) {
      const ctx = await contextAt(width, width > 600 ? 900 : 740, `oi_ko_buttons_${width}`, 'ko');
      const page = await ctx.newPage();
      await stubBackends(page);
      await openMain(page);
      await ask(page, '안녕');
      await page.waitForSelector('.main-turn[data-kind="answer"]');
      const buttons = await page.locator('.main-turn .main-inline-actions button').evaluateAll((els: any[]) => els.map((e) => { const r = e.getBoundingClientRect(); return { text: e.textContent.trim(), left: r.left, right: r.right, top: r.top, bottom: r.bottom, h: r.height, w: r.width }; }));
      assert.deepEqual(buttons.map((b) => b.text), ['이어서 질문', '보관함에 저장']);
      const [follow, save] = buttons;
      const sameRow = Math.abs(follow.top - save.top) < 4;
      if (sameRow) assert.ok(save.left - follow.right >= 8, `buttons are at least 8px apart (${save.left - follow.right}px) at ${width}px`);
      else assert.ok(save.top - follow.bottom >= 8, `stacked buttons keep 8px between them (${save.top - follow.bottom}px) at ${width}px`);
      if (width < 600) assert.ok(follow.h >= 44 - 0.5 && save.h >= 44 - 0.5, 'phone touch targets');
      const visible = await page.locator('body').innerText();
      assert.doesNotMatch(visible, /Vault에|Vault 열기/);
      await ctx.close();
    }
    const en = await contextAt(1440, 900, 'oi_en_save', 'en');
    const page = await en.newPage();
    await stubBackends(page);
    await openMain(page);
    await ask(page, 'hello');
    await page.waitForSelector('.main-turn[data-kind="answer"]');
    assert.deepEqual(await page.locator('.main-turn .main-inline-actions button').allInnerTexts(), ['Ask follow-up', 'Save to Vault']);
    await en.close();
  });
});

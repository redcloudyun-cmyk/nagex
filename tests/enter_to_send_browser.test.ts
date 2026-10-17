// Enter-to-send + AI trust notice + one 960px column, in REAL Chromium against the production server (real route-input, real auth, real front end).
// Only the paths BEHIND the routing decision are stubbed (chat / plan), so each test proves WHICH existing path a keystroke reached and that nothing consequential happened by itself.
// No model is called.
//   - Enter sends through the very same handler as the Send button; Shift+Enter is a new line; Enter that confirms a Korean IME composition sends nothing;
//     an empty or blank box sends nothing; a held / repeated Enter sends once; a request in flight is not sent twice; a failed request keeps the person's words;
//     an action request reached by Enter is still only a plan preview (no approval bypass).
//   - the AI trust notice sits directly under the box in every state and size, once (never per answer), in the language of the screen, with nothing to dismiss;
//     the conversation body and the box share one centred column of at most 960px; on phones the notice clears the bottom navigation.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright';
import { startCanvasAskHarness, type CanvasAskHarness } from './_canvas_ask_harness.js';

declare const window: any;
declare const document: any;
declare const KeyboardEvent: any;
declare const CompositionEvent: any;
declare function getComputedStyle(element: any): any;

let h: CanvasAskHarness;
before(async () => { h = await startCanvasAskHarness({ scrubProviders: true }); });
after(async () => { await h?.close(); });

const NOTICE = {
  ko: 'AI의 답변과 실행에는 오류가 있을 수 있습니다. 중요한 결정과 결과는 직접 확인하세요.',
  en: 'AI responses and actions may contain errors. Review important decisions and results.',
} as const;

async function contextAt(width: number, height: number, label: string, locale: 'en' | 'ko' = 'en', touch = false): Promise<BrowserContext> {
  const user = h.user(label);
  if (locale === 'ko') h.setLocale(user, 'ko');
  const base = await h.newContext('desktop', user, locale);
  const ctx = await h.browser.newContext({ viewport: { width, height }, locale: locale === 'ko' ? 'ko-KR' : 'en-US', ...(touch ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  await ctx.addCookies(await base.cookies());
  await ctx.addInitScript((l: string) => { try { localStorage.setItem('nagex_locale', l); } catch { /* storage unavailable */ } }, locale);
  await base.close();
  return ctx;
}

interface Calls { posts: string[]; chat: any[]; intent: any[] }
interface Stub { chatDelayMs?: number; chatFails?: boolean; intent?: any }

const PLAN = {
  goal: 'g', summary: 'Plan: create the meeting after approval', reasoningSummary: 'r', suggestions: [],
  steps: [{ step: 1, title: 'Create the meeting', reasoning: 'asked', skill: 'skill.scheduling', tool: 'google_calendar.create_event', requiresApproval: true, necessity: 'REQUIRED' }],
};

async function stub(page: Page, options: Stub = {}): Promise<Calls> {
  const calls: Calls = { posts: [], chat: [], intent: [] };
  page.on('request', (r) => { if (r.method() !== 'GET') calls.posts.push(`${r.method()} ${new URL(r.url()).pathname}`); });
  await page.route('**/api/v1/ai/chat', async (route) => {
    calls.chat.push(route.request().postDataJSON());
    if (options.chatDelayMs) await new Promise((r) => setTimeout(r, options.chatDelayMs));
    if (options.chatFails) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'ALL_MODEL_PROVIDERS_FAILED', message: 'The model could not answer.' } }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { message: '답변입니다.', messageId: 'm_chat' }, requestId: 'req_x' }) });
  });
  await page.route('**/api/v1/ambient/intent', (route) => { calls.intent.push(route.request().postDataJSON()); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(options.intent ?? { plan: PLAN }) }); });
  return calls;
}

async function openMain(page: Page): Promise<void> {
  await page.goto(`${h.origin}/#home`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#main-surface-input', { timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('#nagex-main-surface')?.dataset.sessionState === 'EMPTY_HOME', undefined, { timeout: 20000 });
}

const settled = (page: Page, count: number) => page.waitForFunction((n: number) => {
  const turns = document.querySelectorAll('.main-turn');
  const last = turns[turns.length - 1] as any;
  return turns.length >= n && Boolean(last) && last.getAttribute('data-kind') !== 'pending' && !(document.getElementById('main-send') as any).disabled;
}, count, { timeout: 20000 });

const chatCount = (calls: Calls) => calls.chat.length;
const inputValue = (page: Page) => page.inputValue('#main-surface-input');

describe('Enter sends, Shift+Enter is a new line', () => {
  for (const [locale, text] of [['en', 'What can NAgex do for me today?'], ['ko', '오늘 NAgex가 나를 위해 무엇을 할 수 있어?']] as const) {
    it(`${locale}: Enter sends once through the normal path and clears the box; the answer and the turn are the same as with the Send button`, async () => {
      const ctx = await contextAt(1280, 800, `enter_${locale}`, locale);
      const page = await ctx.newPage();
      const calls = await stub(page);
      await openMain(page);

      await page.fill('#main-surface-input', text);
      await page.press('#main-surface-input', 'Enter');
      await settled(page, 1);
      assert.equal(chatCount(calls), 1);
      assert.equal(calls.chat[0].message, text);
      assert.equal(await inputValue(page), '', 'the sent request left the box');
      const viaEnter = (await page.locator('.main-turn').last().innerText()).replace(/\s+/g, ' ');

      // the same words through the Send button: the same requests, the same turn
      await page.fill('#main-surface-input', text);
      await page.click('#main-send');
      await settled(page, 2);
      assert.equal(chatCount(calls), 2);
      assert.deepEqual(Object.keys(calls.chat[1]).sort(), Object.keys(calls.chat[0]).sort(), 'same request shape');
      assert.equal(calls.chat[1].message, calls.chat[0].message);
      assert.deepEqual(calls.posts.filter((p) => !p.includes('route-input') && !p.includes('ai/chat')).length, calls.posts.length - 4, 'only the routing call and the answer call per request');
      const viaButton = (await page.locator('.main-turn').last().innerText()).replace(/\s+/g, ' ');
      assert.equal(viaButton, viaEnter, 'Enter and the button produce the same turn');
      await ctx.close();
    });
  }

  it('Shift+Enter is a new line and sends nothing; the multi-line text is sent as one request', async () => {
    const ctx = await contextAt(1280, 800, 'enter_shift');
    const page = await ctx.newPage();
    const calls = await stub(page);
    await openMain(page);
    await page.click('#main-surface-input');
    await page.keyboard.type('first line');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('second line');
    assert.equal(chatCount(calls), 0);
    assert.equal(await inputValue(page), 'first line\nsecond line');
    await page.keyboard.press('Enter');
    await settled(page, 1);
    assert.equal(calls.chat.length, 1);
    assert.equal(calls.chat[0].message, 'first line\nsecond line');
    await ctx.close();
  });

  // "Shift+Enter does nothing" was reported on the real service. Main is a <textarea>; this pins that the line break really appears - at the caret, repeatedly, around Korean text, in an
  // empty box - and that the box grows and then scrolls inside itself. (The other boxes are covered in composer_enter_browser.test.ts.)
  it('Shift+Enter inserts a line break AT THE CARET (mid-text, repeated, around Korean text, in an empty box), sends nothing, and the box grows then scrolls', async () => {
    const ctx = await contextAt(1280, 800, 'enter_shift_caret', 'ko');
    const page = await ctx.newPage();
    const calls = await stub(page);
    await openMain(page);
    await page.click('#main-surface-input');
    await page.keyboard.type('abcdef');
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Shift+Enter');
    assert.equal(await inputValue(page), 'abc\ndef', 'a line break exactly at the caret');
    await page.keyboard.press('Shift+Enter');
    assert.equal(await inputValue(page), 'abc\n\ndef', 'consecutive line breaks');
    // Korean text: committed through the IME, then Shift+Enter, then more text
    await page.fill('#main-surface-input', '');
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Input.insertText', { text: '안녕하세요' });
    await page.waitForTimeout(250);
    await page.keyboard.press('Shift+Enter');
    await cdp.send('Input.insertText', { text: '두번째 줄' });
    assert.equal(await inputValue(page), '안녕하세요\n두번째 줄', 'a line break between Korean lines, text intact');
    // growth, then an inner scroll at the limit
    const before = await page.evaluate(() => (document.getElementById('main-surface-input') as any).getBoundingClientRect().height);
    for (let i = 0; i < 14; i++) { await page.keyboard.press('Shift+Enter'); await page.keyboard.type(`row ${i}`); }
    const grown = await page.evaluate(() => { const el: any = document.getElementById('main-surface-input'); return { height: el.getBoundingClientRect().height, scrollable: el.scrollHeight > el.clientHeight }; });
    assert.ok(grown.height > before, `the box grew (${before} -> ${grown.height})`);
    assert.ok(grown.height <= 240, `the box stops growing at its limit (${grown.height})`);
    assert.ok(grown.scrollable, 'past the limit the text scrolls inside the box');
    assert.equal(chatCount(calls), 0, 'none of it was sent');
    // an empty box: Shift+Enter gives a line break, still nothing to send
    await page.fill('#main-surface-input', '');
    await page.keyboard.press('Shift+Enter');
    assert.equal(await inputValue(page), '\n');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    assert.equal(chatCount(calls), 0, 'a box holding only a line break is empty: nothing is sent');
    await ctx.close();
  });

  it('an empty or blank box sends nothing and adds no line; Ctrl+Enter still sends', async () => {
    const ctx = await contextAt(1280, 800, 'enter_blank');
    const page = await ctx.newPage();
    const calls = await stub(page);
    await openMain(page);
    await page.click('#main-surface-input');
    await page.keyboard.press('Enter');
    assert.equal(await inputValue(page), '', 'Enter in an empty box does not add a line');
    await page.keyboard.type('   ');
    await page.keyboard.press('Enter');
    assert.equal(await inputValue(page), '   ', 'blanks stay as typed and are not sent');
    await page.waitForTimeout(500);
    assert.equal(calls.posts.length, 0, 'nothing was requested');
    await page.keyboard.type('hello');
    await page.keyboard.press('Control+Enter');
    await settled(page, 1);
    assert.equal(chatCount(calls), 1);
    await ctx.close();
  });
});

describe('Korean IME and duplicate submission', () => {
  it('Enter that confirms a Korean composition sends nothing; the next Enter sends the confirmed text', async () => {
    const ctx = await contextAt(1280, 800, 'enter_ime', 'ko');
    const page = await ctx.newPage();
    const calls = await stub(page);
    await openMain(page);
    await page.click('#main-surface-input');
    const cdp = await ctx.newCDPSession(page);
    // a real IME composition inside Chromium: the syllable is still being composed when Enter arrives
    await cdp.send('Input.imeSetComposition', { text: '안녕하세', selectionStart: 4, selectionEnd: 4 });
    const composing = await page.evaluate(() => (document.getElementById('main-surface-input') as any).value);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    assert.equal(calls.posts.length, 0, `Enter during composition must not send (value while composing: ${JSON.stringify(composing)})`);
    await cdp.send('Input.insertText', { text: '안녕하세요' });
    await page.waitForTimeout(150);
    assert.equal(calls.posts.length, 0, 'committing the composition sends nothing');
    // (the synthetic key the test driver sends inserts its own line break, which a real IME's confirming Enter never does - hence trim)
    assert.equal((await inputValue(page)).trim(), '안녕하세요');
    await page.keyboard.press('Enter');
    await settled(page, 1);
    assert.equal(chatCount(calls), 1);
    assert.equal(calls.chat[0].message, '안녕하세요');
    await ctx.close();
  });

  it('the keyboard signals browsers use for a composing Enter (isComposing, keyCode 229, compositionend first) never send; a plain Enter right after does', async () => {
    const ctx = await contextAt(1280, 800, 'enter_ime_signals', 'ko');
    const page = await ctx.newPage();
    const calls = await stub(page);
    await openMain(page);
    await page.fill('#main-surface-input', '한글 입력');
    const fire = (init: any, before?: string) => page.evaluate(({ init, before }: { init: any; before?: string }) => {
      const el = document.getElementById('main-surface-input');
      if (before) el.dispatchEvent(new CompositionEvent(before));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init }));
    }, { init, before });
    await fire({ isComposing: true });
    await fire({ keyCode: 229 });
    await fire({}, 'compositionstart');          // composition in progress, key reported as a plain Enter
    await page.waitForTimeout(300);
    assert.equal(calls.posts.length, 0, 'no composing Enter sent anything');
    await page.evaluate(() => { document.getElementById('main-surface-input').dispatchEvent(new CompositionEvent('compositionend')); });
    await fire({});                              // Safari: compositionend fires first, the confirming Enter follows at once
    await page.waitForTimeout(300);
    assert.equal(calls.posts.length, 0, 'the Enter that follows compositionend immediately is the confirming one');
    await page.waitForTimeout(150);
    await fire({});                              // a deliberate Enter later
    await settled(page, 1);
    assert.equal(chatCount(calls), 1);
    await ctx.close();
  });

  it('five quick Enters send once; Enter pressed while the request is in flight is not a second request and says why; a held key does not repeat', async () => {
    const ctx = await contextAt(1280, 800, 'enter_dupe');
    const page = await ctx.newPage();
    const calls = await stub(page, { chatDelayMs: 1500 });
    await openMain(page);
    await page.fill('#main-surface-input', 'What can NAgex do for me today?');
    for (let i = 0; i < 5; i += 1) await page.press('#main-surface-input', 'Enter');
    await page.waitForTimeout(300);
    assert.equal(chatCount(calls), 1, 'one request');
    // a new line of text typed while the first is still running: Enter does not start a second one
    await page.fill('#main-surface-input', 'And what about tomorrow?');
    await page.press('#main-surface-input', 'Enter');
    assert.equal(chatCount(calls), 1, 'still one request in flight');
    assert.equal(await inputValue(page), 'And what about tomorrow?', 'what was typed stays');
    assert.match(await page.locator('#main-composer-notice').innerText(), /still working on your last request/);
    await settled(page, 1);
    assert.equal(await page.locator('#main-composer-notice').isHidden(), true, 'the waiting note goes away when the request ends');
    // key auto-repeat
    await page.evaluate(() => { const el = document.getElementById('main-surface-input'); el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true, cancelable: true })); });
    await page.waitForTimeout(200);
    assert.equal(chatCount(calls), 1, 'a repeated keydown is ignored');
    // and sending it deliberately works
    await page.press('#main-surface-input', 'Enter');
    await settled(page, 2);
    assert.equal(chatCount(calls), 2);
    await ctx.close();
  });
});

describe('failure and approval', () => {
  it('a request that could not be answered keeps the person\'s words in the box and says so', async () => {
    const ctx = await contextAt(1280, 800, 'enter_fail', 'ko');
    const page = await ctx.newPage();
    const calls = await stub(page, { chatFails: true });
    await openMain(page);
    await page.fill('#main-surface-input', '오늘 NAgex가 나를 위해 무엇을 할 수 있어?');
    await page.press('#main-surface-input', 'Enter');
    await settled(page, 1);
    assert.equal(chatCount(calls), 1);
    assert.equal(await inputValue(page), '오늘 NAgex가 나를 위해 무엇을 할 수 있어?', 'the request is back in the box');
    assert.match(await page.locator('.main-turn').last().innerText(), /답변|사용할 수 없|오류|실패/);
    // text typed meanwhile is never overwritten by the restored request
    await page.fill('#main-surface-input', '');
    await ctx.close();
  });

  it('an action request sent with Enter is only a plan preview: no approval, no run, nothing consequential is called', async () => {
    const ctx = await contextAt(1280, 800, 'enter_approval');
    const page = await ctx.newPage();
    const calls = await stub(page);
    await openMain(page);
    await page.fill('#main-surface-input', 'Schedule a project review meeting tomorrow at 10 AM');
    await page.press('#main-surface-input', 'Enter');
    await settled(page, 1);
    assert.equal(calls.intent.length, 1, 'it went to the planner like a click would');
    assert.match(await page.locator('.main-turn').last().innerText(), /Plan: create the meeting after approval/);
    const consequential = calls.posts.filter((p) => /\/api\/v1\/(tasks|approvals|executions|gmail|calendar|google|messages|plans)/.test(p));
    assert.deepEqual(consequential, [], 'nothing was approved or executed by a keystroke');
    await ctx.close();
  });
});

describe('the AI trust notice and the 960px column', () => {
  for (const locale of ['ko', 'en'] as const) {
    for (const [width, height] of [[1280, 800], [1920, 1080]] as const) {
      it(`${locale} ${width}px: the notice is the canonical copy, centred under the box, small and grey, once; the stream and the box are one column of at most 960px`, async () => {
        const ctx = await contextAt(width, height, `trust_${locale}_${width}`, locale);
        const page = await ctx.newPage();
        const calls = await stub(page);
        await openMain(page);

        const notice = page.locator('#main-trust-notice');
        assert.equal(await notice.count(), 1);
        assert.equal((await notice.innerText()).trim(), NOTICE[locale], 'idle: exact canonical copy');
        const idle = await page.evaluate(() => {
          const n = document.getElementById('main-trust-notice') as any; const c = document.querySelector('.main-composer-card') as any;
          const nr = n.getBoundingClientRect(); const cr = c.getBoundingClientRect(); const st = getComputedStyle(n);
          return { nTop: nr.top, cBottom: cr.bottom, nCenter: nr.left + nr.width / 2, cCenter: cr.left + cr.width / 2, size: parseFloat(st.fontSize), align: st.textAlign, color: st.color, display: st.display, visibility: st.visibility, cWidth: cr.width };
        });
        assert.ok(idle.nTop >= idle.cBottom - 1 && idle.nTop - idle.cBottom < 32, `directly under the box (${idle.nTop - idle.cBottom}px)`);
        assert.ok(Math.abs(idle.nCenter - idle.cCenter) <= 2, 'centred on the box');
        assert.ok(idle.size <= 13, `small (${idle.size}px)`);
        assert.equal(idle.align, 'center');
        const [r, g, b] = idle.color.match(/\d+/g)!.map(Number);
        assert.ok(Math.abs(r - g) < 40 && Math.abs(g - b) < 40 && r > 70 && r < 175, `grey (${idle.color})`);
        assert.ok(idle.cWidth <= 960.5, `the box is at most 960px wide (${idle.cWidth})`);

        // three answers later: still ONE notice (never repeated per answer), under the box, same copy
        for (let i = 1; i <= 3; i += 1) { await page.fill('#main-surface-input', `question ${i}`); await page.press('#main-surface-input', 'Enter'); await settled(page, i); }
        assert.equal(await page.locator('#main-trust-notice').count(), 1);
        assert.equal(await page.locator('.main-turn #main-trust-notice, .main-turn .main-trust-notice').count(), 0, 'not inside any answer');
        const talking = await page.evaluate(() => {
          const n = (document.getElementById('main-trust-notice') as any).getBoundingClientRect(); const c = (document.querySelector('.main-composer-card') as any).getBoundingClientRect();
          const t = (document.getElementById('main-thread-card') as any).getBoundingClientRect(); const turn = (document.querySelector('.main-turn') as any).getBoundingClientRect();
          return { nTop: n.top, cBottom: c.bottom, nCenter: n.left + n.width / 2, cCenter: c.left + c.width / 2, tLeft: t.left, tRight: t.right, cLeft: c.left, cRight: c.right, tCenter: t.left + t.width / 2, turnRight: turn.right, w: c.width, nVisible: n.height > 0 };
        });
        assert.ok(talking.nVisible);
        assert.ok(talking.nTop >= talking.cBottom - 1 && talking.nTop - talking.cBottom < 32, 'conversation: directly under the box');
        assert.ok(Math.abs(talking.nCenter - talking.cCenter) <= 2);
        assert.ok(Math.abs(talking.tLeft - talking.cLeft) <= 1 && Math.abs(talking.tRight - talking.cRight) <= 1, `stream and box share the same column (${talking.tLeft}-${talking.tRight} vs ${talking.cLeft}-${talking.cRight})`);
        assert.ok(Math.abs(talking.tCenter - talking.cCenter) <= 1, 'one centre axis');
        assert.ok(talking.w <= 960.5, `at most 960px (${talking.w})`);
        if (width >= 1920) assert.ok(talking.w >= 900, `on a wide screen the column is the full 960px (${talking.w})`);
        assert.equal(calls.chat.length, 3);
        await ctx.close();
      });
    }
  }

  it('the notice is there while a request is running and after it failed, cannot be dismissed, follows the language switch and survives a new conversation', async () => {
    const ctx = await contextAt(1280, 800, 'trust_states', 'en');
    const page = await ctx.newPage();
    const calls = await stub(page, { chatDelayMs: 1200 });
    await openMain(page);
    await page.fill('#main-surface-input', 'working?');
    await page.press('#main-surface-input', 'Enter');
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#main-send').isDisabled(), true, 'a request is running');
    assert.equal(await page.locator('#main-trust-notice').isVisible(), true, 'visible while the answer is being made');
    await settled(page, 1);
    assert.equal(await page.locator('#main-trust-notice').isVisible(), true, 'visible when done');
    assert.equal(await page.locator('.main-trust-notice button, #main-trust-notice button, #main-trust-notice [role="button"]').count(), 0, 'nothing to click away');

    // the language switch the screen already has
    await page.click('#btn-lang-toggle');
    await page.waitForFunction((t: string) => document.getElementById('main-trust-notice')?.textContent?.trim() === t, NOTICE.ko, { timeout: 5000 });
    await page.click('#btn-lang-toggle');
    await page.waitForFunction((t: string) => document.getElementById('main-trust-notice')?.textContent?.trim() === t, NOTICE.en, { timeout: 5000 });

    // a new conversation does not remove it
    if (await page.locator('#main-new-conversation').isVisible()) await page.click('#main-new-conversation');
    assert.equal(await page.locator('#main-trust-notice').isVisible(), true);

    // after a failed request
    const failing = await contextAt(1280, 800, 'trust_failed', 'ko');
    const p2 = await failing.newPage();
    await stub(p2, { chatFails: true });
    await openMain(p2);
    await p2.fill('#main-surface-input', '실패해 보자');
    await p2.press('#main-surface-input', 'Enter');
    await settled(p2, 1);
    assert.equal((await p2.locator('#main-trust-notice').innerText()).trim(), NOTICE.ko);
    assert.equal(calls.chat.length, 1);
    await failing.close();
    await ctx.close();
  });
});

describe('phones: 360 / 390 / 430px', () => {
  for (const width of [360, 390, 430]) {
    it(`${width}px: no overflow, the notice is under the box and clear of the bottom navigation, Enter on the on-screen keyboard is a new line and the Send button sends`, async () => {
      const ctx = await contextAt(width, 800, `trust_phone_${width}`, width === 390 ? 'ko' : 'en', true);
      const page = await ctx.newPage();
      const calls = await stub(page);
      await openMain(page);
      assert.equal(await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - window.innerWidth)), 0, 'no horizontal overflow');
      const copy = width === 390 ? NOTICE.ko : NOTICE.en;
      assert.equal((await page.locator('#main-trust-notice').innerText()).trim(), copy);
      assert.equal(await page.locator('#main-surface-input').getAttribute('enterkeyhint'), 'enter');

      // the on-screen keyboard's Enter key: a new line, never a send (the Send button sends)
      await page.click('#main-surface-input');
      await page.keyboard.type('line one');
      await page.keyboard.press('Enter');
      await page.keyboard.type('line two');
      assert.equal(calls.posts.length, 0, 'Enter did not send on a touch-first device');
      assert.equal(await inputValue(page), 'line one\nline two');
      await page.tap('#main-send');
      await settled(page, 1);
      assert.equal(calls.chat.length, 1);
      assert.equal(calls.chat[0].message, 'line one\nline two');

      // the notice stays under the box and above the fixed navigation when the page is scrolled to its end
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(200);
      const geometry = await page.evaluate(() => {
        const n = (document.getElementById('main-trust-notice') as any).getBoundingClientRect(); const c = (document.querySelector('.main-composer-card') as any).getBoundingClientRect();
        const nav = document.querySelector('.mobile-bottom-nav') as any; const nr = nav && getComputedStyle(nav).display !== 'none' ? nav.getBoundingClientRect() : null;
        return { nTop: n.top, nBottom: n.bottom, nLeft: n.left, nRight: n.right, cBottom: c.bottom, navTop: nr ? nr.top : null, vw: window.innerWidth, overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth) };
      });
      assert.ok(geometry.nTop >= geometry.cBottom - 1, 'under the box');
      assert.ok(geometry.nLeft >= 0 && geometry.nRight <= geometry.vw + 0.5, 'inside the screen');
      if (geometry.navTop !== null) assert.ok(geometry.nBottom <= geometry.navTop + 0.5, `clear of the bottom navigation (${geometry.nBottom} <= ${geometry.navTop})`);
      assert.equal(geometry.overflow, 0);
      await ctx.close();
    });
  }
});

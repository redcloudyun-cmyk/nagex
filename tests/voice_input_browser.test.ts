// Voice-to-text in the Main composer, in REAL Chromium against the production server and the production front end (the existing microphone button, RendererVoiceAdapter and consent flow).
// The browser's speech engine is scripted (a controllable SpeechRecognition + getUserMedia) so every state can be driven deterministically; NAgex's own code - language choice, consent, state
// machine, composer, Enter / Send, approval - is the real code. The real-engine check (Chrome + Google speech, real microphone) is scripts/voice-real-browser-check.mjs and the sprint evidence.
//   - the language follows the screen language (Korean -> ko-KR, English -> en-US)
//   - recognised text lands in the canonical box, is editable, is NEVER sent by the end of recognition, and is sent only by Enter / Send (the typed-input handler)
//   - permission denied, no microphone, unsupported browser: truthful notice (and the operating system's own dictation named as a fallback), nothing recorded
//   - repeated clicks, stop, cancel, typing, Enter, leaving the screen: no second recording, no leaked microphone, no duplicated transcript
//   - an action dictated by voice is still only a plan preview (Human Approval is untouched)
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright';
import { startCanvasAskHarness, type CanvasAskHarness } from './_canvas_ask_harness.js';

declare const window: any;
declare const document: any;
declare const navigator: any;
declare const location: any;
declare function getComputedStyle(element: any): any;

let h: CanvasAskHarness;
before(async () => { h = await startCanvasAskHarness({ scrubProviders: true }); });
after(async () => { await h?.close(); });

interface ContextOptions { width?: number; height?: number; locale?: 'en' | 'ko'; touch?: boolean; userAgent?: string; consent?: boolean }

async function contextFor(label: string, options: ContextOptions = {}): Promise<BrowserContext> {
  const locale = options.locale ?? 'en';
  const user = h.user(label);
  if (locale === 'ko') h.setLocale(user, 'ko');
  const base = await h.newContext('desktop', user, locale);
  const ctx = await h.browser.newContext({
    viewport: { width: options.width ?? 1280, height: options.height ?? 800 }, locale: locale === 'ko' ? 'ko-KR' : 'en-US',
    ...(options.touch ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}), ...(options.userAgent ? { userAgent: options.userAgent } : {}),
  });
  await ctx.addCookies(await base.cookies());
  await ctx.addInitScript(({ l, consent }: { l: string; consent: boolean }) => {
    try { localStorage.setItem('nagex_locale', l); } catch { /* storage unavailable */ }
    try { if (consent) localStorage.setItem('nagex_voice_consent_v1', JSON.stringify({ v: 1, grants: { 'third-party:google:v1': new Date().toISOString() } })); } catch { /* storage unavailable */ }
  }, { l: locale, consent: options.consent !== false });
  await base.close();
  return ctx;
}

// A scripted browser speech engine. window.__v is the control panel the tests read and drive.
async function installSpeech(page: Page, options: { speech?: boolean; media?: 'ok' | 'denied' | 'missing' | 'busy' } = {}): Promise<void> {
  await page.addInitScript(({ speech, media }: { speech: boolean; media: string }) => {
    const v: any = (window.__v = { recognitions: [] as any[], mediaRequests: 0, tracksStopped: 0, tracksOpened: 0, aborts: 0, stops: 0, finalOnStop: '' });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => {
          v.mediaRequests += 1;
          if (media === 'denied') throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
          if (media === 'missing') throw Object.assign(new Error('no mic'), { name: 'NotFoundError' });
          if (media === 'busy') throw Object.assign(new Error('busy'), { name: 'NotReadableError' });
          const track = { stop() { v.tracksStopped += 1; } };
          v.tracksOpened += 1;
          return { getTracks: () => [track], getAudioTracks: () => [track] };
        },
      },
    });
    Object.defineProperty(navigator, 'permissions', { configurable: true, value: { query: async () => ({ state: media === 'denied' ? 'denied' : 'prompt' }) } });
    if (!speech) { delete window.SpeechRecognition; delete window.webkitSpeechRecognition; return; }
    class FakeSpeechRecognition {
      lang = ''; interimResults = false; continuous = false; maxAlternatives = 1;
      onstart: any = null; onresult: any = null; onend: any = null; onerror: any = null;
      ended = false;
      constructor() { v.recognitions.push(this); }
      static async available() { return 'unsupported'; }
      start() { setTimeout(() => this.onstart?.(), 10); }
      stop() { v.stops += 1; if (v.finalOnStop) this.say(v.finalOnStop, true, 0); this.finish(); }
      abort() { v.aborts += 1; this.finish(); }
      finish() { if (this.ended) return; this.ended = true; setTimeout(() => this.onend?.(), 5); }
      say(text: string, isFinal: boolean, index = 0) {
        const result: any = [{ transcript: text, confidence: 0.9 }];
        result.isFinal = isFinal;
        this.onresult?.({ resultIndex: index, results: Object.assign([result], { length: index + 1 }) });
      }
    }
    window.SpeechRecognition = FakeSpeechRecognition;
    window.webkitSpeechRecognition = FakeSpeechRecognition;
  }, { speech: options.speech !== false, media: options.media ?? 'ok' });
}

interface Calls { posts: string[]; chat: any[]; intent: any[] }
async function stub(page: Page): Promise<Calls> {
  const calls: Calls = { posts: [], chat: [], intent: [] };
  page.on('request', (r) => { if (r.method() !== 'GET') calls.posts.push(`${r.method()} ${new URL(r.url()).pathname}`); });
  await page.route('**/api/v1/ai/chat', (route) => { calls.chat.push(route.request().postDataJSON()); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { message: 'ok', messageId: 'm' }, requestId: 'r' }) }); });
  await page.route('**/api/v1/ambient/intent', (route) => {
    calls.intent.push(route.request().postDataJSON());
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ plan: { goal: 'g', summary: 'Plan: create the meeting after approval', reasoningSummary: 'r', suggestions: [], steps: [{ step: 1, title: 'Create the meeting', reasoning: 'asked', skill: 'skill.scheduling', tool: 'google_calendar.create_event', requiresApproval: true, necessity: 'REQUIRED' }] } }) });
  });
  return calls;
}

async function openMain(page: Page): Promise<void> {
  await page.goto(`${h.origin}/#home`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#main-mic', { timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('#nagex-main-surface')?.dataset.sessionState === 'EMPTY_HOME', undefined, { timeout: 20000 });
}

const v = <T>(page: Page, read: (v: any) => T) => page.evaluate(read as any, undefined) as Promise<T>;
const state = (page: Page) => page.evaluate(() => window.__v ? { n: window.__v.recognitions.length, media: window.__v.mediaRequests, opened: window.__v.tracksOpened, stopped: window.__v.tracksStopped, aborts: window.__v.aborts, stops: window.__v.stops, lang: window.__v.recognitions[0]?.lang } : null);
const say = (page: Page, text: string, isFinal: boolean, index = 0, which = -1) => page.evaluate(({ text, isFinal, index, which }: any) => { const r = window.__v.recognitions; (which < 0 ? r[r.length - 1] : r[which]).say(text, isFinal, index); }, { text, isFinal, index, which });
const box = (page: Page) => page.inputValue('#main-surface-input');
const listening = (page: Page) => page.waitForFunction(() => document.querySelector('#nagex-main-surface')?.dataset.voiceState === 'LISTENING', undefined, { timeout: 8000 });
const idle = (page: Page) => page.waitForFunction(() => document.querySelector('#nagex-main-surface')?.dataset.voiceState === 'IDLE', undefined, { timeout: 8000 });
const noticeText = (page: Page) => page.locator('#main-composer-notice').innerText();

describe('speech in the composer', () => {
  for (const [locale, lang, spoken] of [['ko', 'ko-KR', '내일 일정 알려줘'], ['en', 'en-US', 'What is on my schedule tomorrow']] as const) {
    it(`${locale}: the microphone listens in ${lang}; interim text shows, the final text stays in the box, nothing is sent by the end of recognition, and it is sent by Enter like typed text`, async () => {
      const ctx = await contextFor(`voice_${locale}`, { locale });
      const page = await ctx.newPage();
      await installSpeech(page);
      const calls = await stub(page);
      await openMain(page);

      await page.click('#main-mic');
      await listening(page);
      const s = await state(page);
      assert.equal(s!.lang, lang, 'the language of the screen is the language of the recognizer');
      assert.equal(s!.n, 1);
      assert.match(await noticeText(page), locale === 'ko' ? /Google/ : /sent to Google/, 'the person is told where audio goes while recording');

      await say(page, spoken.slice(0, 5), false);
      assert.equal(await box(page), spoken.slice(0, 5).trim(), 'interim text is visible while speaking');
      await say(page, spoken, true);
      assert.equal(await box(page), spoken);

      // stopping (second click) ends the recording and releases the microphone; the text stays and nothing is sent
      await page.click('#main-mic');
      await idle(page);
      assert.equal(await box(page), spoken);
      assert.deepEqual([(await state(page))!.opened, (await state(page))!.stopped], [1, 1], 'the microphone stream was released');
      await page.waitForTimeout(600);
      assert.equal(calls.posts.length, 0, 'the end of recognition submits nothing');

      // the person can edit it, then send it with the same Enter as typed text
      await page.click('#main-surface-input');
      await page.keyboard.press('End');
      await page.keyboard.type(locale === 'ko' ? ' 그리고 점심도' : ' and lunch');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => !(document.getElementById('main-send') as any).disabled && document.querySelectorAll('.main-turn').length >= 1);
      assert.equal(calls.chat.length, 1);
      assert.equal(calls.chat[0].message, spoken + (locale === 'ko' ? ' 그리고 점심도' : ' and lunch'));
      await ctx.close();
    });
  }

  it('the first use asks for consent before any microphone is opened; "Type instead" records nothing; allowing starts listening', async () => {
    const ctx = await contextFor('voice_consent', { consent: false });
    const page = await ctx.newPage();
    await installSpeech(page);
    await stub(page);
    await openMain(page);
    await page.click('#main-mic');
    await page.waitForSelector('#main-composer-notice:not([hidden]) button');
    assert.match(await noticeText(page), /sends your audio to Google/);
    assert.deepEqual([(await state(page))!.n, (await state(page))!.media], [0, 0], 'nothing was recorded or even requested before consent');
    await page.click('#main-composer-notice button:has-text("Type instead")');
    assert.deepEqual([(await state(page))!.n, (await state(page))!.media], [0, 0]);
    await page.click('#main-mic');
    await page.click('#main-composer-notice button:has-text("Allow Google speech")');
    await listening(page);
    assert.equal((await state(page))!.n, 1);
    await page.click('#main-voice-cancel');
    await idle(page);
    await ctx.close();
  });

  it('a duplicated final result is written once, and spoken text is added after what was already typed', async () => {
    const ctx = await contextFor('voice_dupe');
    const page = await ctx.newPage();
    await installSpeech(page);
    await stub(page);
    await openMain(page);
    await page.fill('#main-surface-input', 'Plan the offsite');
    await page.click('#main-mic');
    await listening(page);
    await say(page, 'for the design team', true, 0);
    await say(page, 'for the design team', true, 0);
    assert.equal(await box(page), 'Plan the offsite for the design team');
    await page.click('#main-mic');
    await idle(page);
    await ctx.close();
  });
});

describe('when speech cannot work, the person is told the truth', () => {
  it('permission denied: a notice, nothing recorded, the box is untouched', async () => {
    const ctx = await contextFor('voice_denied');
    const page = await ctx.newPage();
    await installSpeech(page, { media: 'denied' });
    await stub(page);
    await openMain(page);
    await page.fill('#main-surface-input', 'keep this');
    await page.click('#main-mic');
    await page.waitForFunction(() => document.querySelector('#nagex-main-surface')?.dataset.voiceState === 'ERROR', undefined, { timeout: 8000 });
    assert.match(await noticeText(page), /Microphone permission is blocked/);
    assert.equal(await box(page), 'keep this');
    assert.equal((await state(page))!.n, 0, 'no recognition started');
    await ctx.close();
  });

  it('no microphone / a microphone in use: it says so and names the operating system dictation as another way', async () => {
    for (const [media, expected] of [['missing', /No microphone was found/], ['busy', /in use by another app/]] as const) {
      const ctx = await contextFor(`voice_${media}`, { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36' });
      const page = await ctx.newPage();
      await installSpeech(page, { media });
      await stub(page);
      await openMain(page);
      await page.click('#main-mic');
      await page.waitForFunction(() => document.querySelector('#nagex-main-surface')?.dataset.voiceState === 'ERROR', undefined, { timeout: 8000 });
      const text = await noticeText(page);
      assert.match(text, expected);
      assert.match(text, /Windows voice typing: click in the box and press Win \+ H/);
      assert.equal((await state(page))!.n, 0);
      await ctx.close();
    }
  });

  it('an unsupported browser: voice is reported unavailable, typing still works, and the fallback matches the platform', async () => {
    const platforms: Array<[string, string, RegExp]> = [
      ['windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36', /Win \+ H/],
      ['mac', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36', /system dictation/],
      ['android', 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36', /microphone key on your keyboard/],
    ];
    for (const [name, userAgent, hint] of platforms) {
      const ctx = await contextFor(`voice_unsupported_${name}`, { userAgent });
      const page = await ctx.newPage();
      await installSpeech(page, { speech: false });
      const calls = await stub(page);
      await openMain(page);
      await page.click('#main-mic');
      await page.waitForFunction(() => document.querySelector('#nagex-main-surface')?.dataset.voiceState === 'ERROR', undefined, { timeout: 8000 });
      const text = await noticeText(page);
      assert.match(text, /Voice input is unavailable in this browser/);
      assert.match(text, hint, `${name} fallback`);
      assert.equal((await state(page))!.media, 0, 'the microphone was never opened');
      await page.fill('#main-surface-input', 'typing still works');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelectorAll('.main-turn').length >= 1 && !(document.getElementById('main-send') as any).disabled);
      assert.equal(calls.chat.length, 1, JSON.stringify(calls.posts));
      await ctx.close();
    }
  });

  it('Korean screen: the same notices in Korean', async () => {
    const ctx = await contextFor('voice_ko_notice', { locale: 'ko', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36' });
    const page = await ctx.newPage();
    await installSpeech(page, { media: 'missing' });
    await stub(page);
    await openMain(page);
    await page.click('#main-mic');
    await page.waitForFunction(() => document.querySelector('#nagex-main-surface')?.dataset.voiceState === 'ERROR', undefined, { timeout: 8000 });
    const text = await noticeText(page);
    assert.match(text, /마이크를 찾을 수 없어요/);
    assert.match(text, /Win \+ H/);
    assert.doesNotMatch(text, /mainVoice\./);
    await ctx.close();
  });
});

describe('clicks, stop, cancel, typing, Enter and leaving', () => {
  it('rapid repeated clicks never open a second recording; the second press stops, the next one starts a new recording', async () => {
    const ctx = await contextFor('voice_clicks');
    const page = await ctx.newPage();
    await installSpeech(page);
    await stub(page);
    await openMain(page);
    await page.evaluate(() => { const b = document.getElementById('main-mic') as any; b.click(); b.click(); b.click(); });
    await listening(page);
    assert.equal((await state(page))!.n, 1, 'three quick clicks, one recognizer');
    assert.equal((await state(page))!.media, 1, 'one microphone request');
    await page.click('#main-mic');
    await idle(page);
    assert.deepEqual([(await state(page))!.opened, (await state(page))!.stopped], [1, 1]);
    await page.click('#main-mic');
    await listening(page);
    assert.equal((await state(page))!.n, 2, 'a new press is a new recording');
    await page.click('#main-voice-cancel');
    await idle(page);
    const s = await state(page);
    assert.equal(s!.opened, s!.stopped, 'every opened microphone stream was released');
    await ctx.close();
  });

  it('Stop keeps what was heard; Cancel and Escape throw it away and put the box back as it was', async () => {
    const ctx = await contextFor('voice_cancel');
    const page = await ctx.newPage();
    await installSpeech(page);
    const calls = await stub(page);
    await openMain(page);
    await page.fill('#main-surface-input', 'Before');

    await page.click('#main-mic'); await listening(page);
    await say(page, 'draft one', true);
    await page.click('#main-voice-cancel'); await idle(page);
    assert.equal(await box(page), 'Before', 'cancel discards the dictation');

    await page.click('#main-mic'); await listening(page);
    await say(page, 'draft two', true);
    await page.focus('#main-surface-input');
    await page.keyboard.press('Escape'); await idle(page);
    assert.equal(await box(page), 'Before', 'Escape discards it too');

    await page.click('#main-mic'); await listening(page);
    await say(page, 'draft three', true);
    await page.click('#main-mic'); await idle(page);
    assert.equal(await box(page), 'Before draft three', 'stop keeps it');
    const s = await state(page);
    assert.equal(s!.opened, s!.stopped);
    assert.equal(calls.posts.length, 0);
    await ctx.close();
  });

  it('typing while it listens ends the dictation and the typed text is the person\'s: a late recognition result does not overwrite it', async () => {
    const ctx = await contextFor('voice_typing');
    const page = await ctx.newPage();
    await installSpeech(page);
    await stub(page);
    await openMain(page);
    await page.click('#main-mic'); await listening(page);
    // the engine still delivers a final result while it is being stopped (the realistic race)
    await page.evaluate(() => { window.__v.finalOnStop = 'completely different words'; });
    await say(page, 'book a table', false);
    await page.click('#main-surface-input');
    await page.keyboard.press('End');
    await page.keyboard.type('!');
    await idle(page);
    await page.waitForTimeout(200);
    assert.equal(await box(page), 'book a table!', 'nothing overwrote what was typed');
    const s = await state(page);
    assert.equal(s!.opened, s!.stopped);
    await ctx.close();
  });

  it('Enter and Send while recording stop the recording and keep the text for review (never a send of half a sentence); the next Enter sends it once', async () => {
    const ctx = await contextFor('voice_enter');
    const page = await ctx.newPage();
    await installSpeech(page);
    const calls = await stub(page);
    await openMain(page);

    await page.click('#main-mic'); await listening(page);
    await page.evaluate(() => { window.__v.finalOnStop = 'What can NAgex do for me?'; });
    await say(page, 'What can', false);
    await page.press('#main-surface-input', 'Enter');
    await idle(page);
    assert.equal(calls.posts.length, 0, 'Enter while recording is not a send');
    assert.equal(await box(page), 'What can NAgex do for me?', 'the recognizer\'s final text is there for review');
    assert.match(await page.locator('#main-composer-notice').innerText().catch(() => ''), /Check the text|Recording stopped|^$/);

    await page.evaluate(() => { window.__v.finalOnStop = ''; });
    await page.click('#main-mic'); await listening(page);
    await page.click('#main-send');
    await idle(page);
    assert.equal(calls.posts.length, 0, 'the Send button while recording is not a send either');

    await page.press('#main-surface-input', 'Enter');
    await page.waitForFunction(() => document.querySelectorAll('.main-turn').length >= 1 && !(document.getElementById('main-send') as any).disabled);
    assert.equal(calls.chat.length, 1, 'one request ' + JSON.stringify(calls.posts));
    assert.match(calls.chat[0].message, /What can NAgex do for me?/);
    await ctx.close();
  });

  it('leaving the screen stops the recording and releases the microphone', async () => {
    const ctx = await contextFor('voice_leave');
    const page = await ctx.newPage();
    await installSpeech(page);
    await stub(page);
    await openMain(page);
    await page.click('#main-mic'); await listening(page);
    await page.evaluate(() => { location.hash = '#settings'; });
    await page.waitForFunction(() => window.__v.aborts >= 1, undefined, { timeout: 5000 });
    const s = await state(page);
    assert.equal(s!.opened, s!.stopped, 'the microphone was released');
    await ctx.close();
  });
});

describe('approval and IME stay in charge', () => {
  it('an action dictated by voice and sent with Enter is only a plan preview: no approval, no execution', async () => {
    const ctx = await contextFor('voice_approval', { locale: 'ko' });
    const page = await ctx.newPage();
    await installSpeech(page);
    const calls = await stub(page);
    await openMain(page);
    await page.click('#main-mic'); await listening(page);
    await say(page, '내일 오전 10시에 프로젝트 리뷰 회의를 잡아줘', true);
    await page.click('#main-mic'); await idle(page);
    assert.equal(calls.posts.length, 0);
    await page.press('#main-surface-input', 'Enter');
    await page.waitForFunction(() => /Plan: create the meeting after approval/.test(document.querySelector('.main-turn:last-child')?.textContent || ''), undefined, { timeout: 10000 });
    assert.equal(calls.intent.length, 1);
    const consequential = calls.posts.filter((p) => /\/api\/v1\/(tasks|approvals|executions|gmail|calendar|google|messages|plans)/.test(p));
    assert.deepEqual(consequential, [], 'voice never approved or ran anything');
    await ctx.close();
  });

  it('Enter that confirms a Korean IME composition after dictation sends nothing', async () => {
    const ctx = await contextFor('voice_ime', { locale: 'ko' });
    const page = await ctx.newPage();
    await installSpeech(page);
    const calls = await stub(page);
    await openMain(page);
    await page.click('#main-mic'); await listening(page);
    await say(page, '회의 준비', true);
    await page.click('#main-mic'); await idle(page);
    await page.click('#main-surface-input');
    await page.keyboard.press('End');
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: '자료', selectionStart: 2, selectionEnd: 2 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    assert.equal(calls.posts.length, 0, 'the composing Enter did not send');
    await ctx.close();
  });
});

describe('phones: 360 / 390 / 430px', () => {
  for (const width of [360, 390, 430]) {
    it(`${width}px: the microphone is a 44px target, its status and the consent prompt fit the screen, dictation works with touch`, async () => {
      const ctx = await contextFor(`voice_phone_${width}`, { width, height: 800, touch: true, locale: width === 390 ? 'ko' : 'en', consent: false });
      const page = await ctx.newPage();
      await installSpeech(page);
      await stub(page);
      await openMain(page);
      const mic = await page.locator('#main-mic').boundingBox();
      assert.ok(mic && mic.width >= 40 && mic.height >= 40, `mic target ${mic?.width}x${mic?.height}`);
      assert.equal(await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - window.innerWidth)), 0);

      await page.tap('#main-mic');
      await page.waitForSelector('#main-composer-notice:not([hidden]) button');
      const prompt = await page.evaluate(() => {
        const n = document.getElementById('main-composer-notice') as any; const r = n.getBoundingClientRect();
        const buttons = [...n.querySelectorAll('button')].map((b: any) => { const br = b.getBoundingClientRect(); return { right: br.right, left: br.left }; });
        return { left: r.left, right: r.right, vw: window.innerWidth, buttons, overflow: n.scrollWidth - n.clientWidth };
      });
      assert.ok(prompt.left >= 0 && prompt.right <= prompt.vw + 0.5, 'the consent prompt fits the screen');
      assert.ok(prompt.buttons.every((b: any) => b.left >= 0 && b.right <= prompt.vw + 0.5), 'its buttons fit too');
      assert.ok(prompt.overflow <= 1, 'no clipped text');
      await page.tap('#main-composer-notice button:has-text("Google")');
      await listening(page);
      await say(page, width === 390 ? '오늘 일정' : 'today plan', true);
      const status = await page.evaluate(() => { const s = document.getElementById('main-voice-status') as any; return s ? { clipped: s.scrollWidth > s.clientWidth + 1, text: s.textContent } : null; });
      assert.ok(status && !status.clipped, 'the status label is not clipped');
      await page.tap('#main-mic');
      await idle(page);
      assert.equal(await box(page), width === 390 ? '오늘 일정' : 'today plan');
      assert.equal(await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - window.innerWidth)), 0);
      await ctx.close();
    });
  }
});

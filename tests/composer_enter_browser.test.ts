// Enter sends, Shift+Enter does not, and the Enter that merely CONFIRMS a Korean IME syllable never sends - on EVERY message box, in REAL Chromium against the production server.
// Main's composer was fixed on 2026-10-16 (enter_to_send_browser.test.ts); the other boxes (the ambient "Ask" sheet, Canvas Ask, Quick Wake) still sent on the confirming Enter
// (a truncated message) and Quick Wake ran a second copy of the send logic. They now share public/composer-keys.js. A real IME composition is driven through the Chrome DevTools protocol
// (Input.imeSetComposition / Input.insertText), not simulated key events. Only the model is absent (providers are scrubbed): what is counted is the request each keystroke really causes.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright';
import { startCanvasAskHarness, type CanvasAskHarness } from './_canvas_ask_harness.js';

declare const document: any;
declare function getComputedStyle(element: any): any;

let h: CanvasAskHarness;
before(async () => { h = await startCanvasAskHarness({ scrubProviders: true }); });
after(async () => { await h?.close(); });

const COMPOSING = '안녕하세';
const COMMITTED = '안녕하세요';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Surface {
  name: string;
  kind: 'desktop' | 'mobile';
  input: string;
  send: string;
  /** opens the surface and returns once the box can be typed into */
  open(page: Page): Promise<void>;
  /** the box is empty again after a send */
  clearsOnSend: boolean;
  /** a multi-line box: Shift+Enter inserts a line break at the caret. false = a deliberate one-line field (policy decision recorded in the canonical UX document) */
  multiline: boolean;
  /** the request path a send ends up at (to count sends) */
  submitPath: string;
}

const AMBIENT: Surface = {
  name: 'ambient Ask sheet', kind: 'desktop', input: '#ambient-prompt-input', send: '#btn-ambient-run', clearsOnSend: true, multiline: true, submitPath: '/api/v1/ambient/intent',
  async open(page) {
    // the sheet opens with Alt+N (the header search button now opens the live search instead)
    await page.goto(`${h.origin}/#home`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#main-surface-input', { timeout: 20000 });
    await page.waitForTimeout(500);
    await page.keyboard.press('Alt+N');
    await page.waitForSelector('#ambient-prompt-input', { state: 'visible', timeout: 20000 });
  },
};
const QUICK_WAKE: Surface = {
  name: 'Quick Wake', kind: 'desktop', input: '#qw-composer-input', send: '#qw-btn-send', clearsOnSend: true, multiline: true, submitPath: '/api/v1/workspace/route-input',
  async open(page) {
    await page.goto(`${h.origin}/quickwake`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#qw-composer-input', { state: 'visible', timeout: 20000 });
  },
};
function canvasAsk(): Surface {
  return {
    name: 'Canvas Ask', kind: 'desktop', input: '#canvas-ask-input', send: '#view-canvas .canvas-ask-submit', clearsOnSend: false, multiline: false, submitPath: '/api/v1/artifacts/:id/ask',
    async open(page) {
      const owner = (page as any).__owner as ReturnType<CanvasAskHarness['user']>;
      const seeded = h.seedDocument(owner, { title: 'Launch plan', content: '# Launch plan\n\nThe launch codename is PELICAN-7314.\n' });
      await page.goto(`${h.origin}/#canvas/${seeded.artifactId}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#canvas-ask-input', { state: 'visible', timeout: 20000 });
    },
  };
}

async function fresh(surface: Surface, label: string): Promise<{ ctx: BrowserContext; page: Page; posts: string[]; bodies: string[] }> {
  const user = h.user(label);
  const ctx = await h.newContext(surface.kind, user);
  const page = await ctx.newPage();
  (page as any).__owner = user;
  await surface.open(page);
  await page.waitForTimeout(600);
  const posts: string[] = [];
  const bodies: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'GET') return;
    posts.push(`${r.method()} ${new URL(r.url()).pathname.replace(/art_[0-9a-f]+/g, ':id')}`);
    bodies.push(r.postData() ?? '');
  });
  return { ctx, page, posts, bodies };
}

/** waits until requests were made and no new one arrived for a moment (a send is a short chain of requests) */
async function settle(posts: string[]): Promise<void> {
  const started = Date.now();
  let last = -1;
  let stableSince = Date.now();
  while (Date.now() - started < 15000) {
    if (posts.length !== last) { last = posts.length; stableSince = Date.now(); }
    else if (posts.length > 0 && Date.now() - stableSince >= 800) return;
    await sleep(100);
  }
}

// (the legacy phone Home bar #mh-command-input is not exercised: with Main loaded activeNativeTab() is null for Home on a phone, so initCommandBar() never runs and the bar has no handler at all - see the debt record)
for (const make of [() => AMBIENT, () => QUICK_WAKE, canvasAsk]) {
  const sample = make();
  describe(`${sample.name}: Enter, Shift+Enter and the Korean IME`, () => {
    it('the Enter that confirms a Korean composition sends nothing; the next Enter sends the confirmed text exactly once', async () => {
      const surface = make();
      const { ctx, page, posts, bodies } = await fresh(surface, `ime_${surface.name}`);
      await page.focus(surface.input);
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('Input.imeSetComposition', { text: COMPOSING, selectionStart: 4, selectionEnd: 4 });
      await page.keyboard.press('Enter');                       // the key that confirms the syllable being composed
      await page.waitForTimeout(500);
      assert.deepEqual(posts, [], `Enter during a composition must not send (box: ${JSON.stringify(await page.inputValue(surface.input))})`);
      await cdp.send('Input.insertText', { text: COMMITTED });  // the composition is committed
      await page.waitForTimeout(200);
      assert.deepEqual(posts, [], 'committing the composition sends nothing');
      assert.equal((await page.inputValue(surface.input)).trim(), COMMITTED);
      await page.keyboard.press('Enter');                       // a deliberate Enter after the composition is confirmed
      await settle(posts);
      assert.ok(posts.length > 0, 'Enter after a confirmed composition sends');
      assert.ok(bodies.some((b) => b.includes(COMMITTED)), `the full confirmed text was sent (${bodies.map((b) => b.slice(0, 80)).join(' | ')})`);
      assert.equal(bodies.some((b) => b.includes(`"${COMPOSING}"`)), false, 'the truncated, still-composing text was never sent');
      if (surface.clearsOnSend) assert.equal(await page.inputValue(surface.input), '', 'the box is emptied by the send');
      await ctx.close();
    });

    it('Enter and the Send button cause the very same requests (one submit logic)', async () => {
      const surface = make();
      const viaEnter = await fresh(surface, `same_enter_${surface.name}`);
      await viaEnter.page.fill(surface.input, COMMITTED);
      await viaEnter.page.focus(surface.input);
      await viaEnter.page.keyboard.press('Enter');
      await settle(viaEnter.posts);
      const viaButton = await fresh(surface, `same_button_${surface.name}`);
      await viaButton.page.fill(surface.input, COMMITTED);
      await viaButton.page.click(surface.send);
      await settle(viaButton.posts);
      assert.ok(viaEnter.posts.length > 0 && viaButton.posts.length > 0, 'both sent');
      assert.deepEqual(viaEnter.posts, viaButton.posts, 'the same requests, in the same order');
      await viaEnter.ctx.close();
      await viaButton.ctx.close();
    });

    it('an empty box sends nothing - on Enter, and on Shift+Enter followed by Enter', async () => {
      const surface = make();
      const { ctx, page, posts } = await fresh(surface, `empty_${surface.name}`);
      await page.focus(surface.input);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(500);
      assert.deepEqual(posts, [], 'Enter on an empty box sends nothing');
      await page.keyboard.press('Shift+Enter');
      await page.keyboard.press('Enter');          // a box holding only a line break is still empty
      await page.waitForTimeout(500);
      assert.deepEqual(posts, [], 'Shift+Enter on an empty box, then Enter, sends nothing');
      await ctx.close();
    });

    if (sample.multiline) {
      // The failure this pins: Shift+Enter "did nothing" in the box (no send, no line break). The earlier assertion here only required that nothing was SENT and the text stayed - which a box
      // that ignores Shift+Enter satisfies. It now requires the line break itself, at the caret, repeatedly, kept in what is sent.
      it('Shift+Enter inserts a line break AT THE CARET (repeatedly), sends nothing, grows the box, and Enter then sends the whole multi-line text', async () => {
        const surface = make();
        const { ctx, page, posts, bodies } = await fresh(surface, `shift_${surface.name}`);
        await page.focus(surface.input);
        await page.keyboard.type('abcdef');
        for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft');     // the caret sits between "abc" and "def"
        const before = await page.evaluate((sel: string) => (document.querySelector(sel) as any).getBoundingClientRect().height, surface.input);
        await page.keyboard.press('Shift+Enter');
        assert.equal(await page.inputValue(surface.input), 'abc\ndef', 'Shift+Enter inserted a line break exactly at the caret');
        await page.keyboard.press('Shift+Enter');
        assert.equal(await page.inputValue(surface.input), 'abc\n\ndef', 'a second Shift+Enter gives a second, consecutive line break');
        await page.waitForTimeout(500);
        assert.deepEqual(posts, [], 'Shift+Enter sent nothing');
        // the box grows with its lines and, past its limit, scrolls inside itself
        await page.keyboard.press('Control+End');
        for (let i = 0; i < 12; i++) { await page.keyboard.press('Shift+Enter'); await page.keyboard.type(`row${i}`); }
        const grown = await page.evaluate((sel: string) => { const el: any = document.querySelector(sel); const r = el.getBoundingClientRect(); return { height: r.height, scrollable: el.scrollHeight > el.clientHeight, overflowY: getComputedStyle(el).overflowY }; }, surface.input);
        assert.ok(grown.height > before, `the box grew (${before} -> ${grown.height})`);
        assert.ok(grown.height <= 240, `the box stops growing at its limit (${grown.height})`);
        assert.ok(grown.scrollable && /auto|scroll/.test(grown.overflowY), 'past the limit the text scrolls inside the box');
        await page.fill(surface.input, 'abc\n\ndef');                           // the multi-line text, set up again for the send
        await page.focus(surface.input);
        await page.keyboard.press('Control+End');
        await page.keyboard.press('Enter');
        await settle(posts);
        assert.ok(bodies.some((b) => b.includes('abc\\n\\ndef')), `Enter sent the whole multi-line text with its line breaks (${bodies.map((b) => b.slice(0, 100)).join(' | ')})`);
        await ctx.close();
      });

      it('five quick Enters send once', async () => {
        const surface = make();
        const { ctx, page, posts } = await fresh(surface, `quick_${surface.name}`);
        await page.fill(surface.input, COMMITTED);
        await page.focus(surface.input);
        for (let i = 0; i < 5; i++) await page.keyboard.press('Enter');
        await settle(posts);
        assert.equal(posts.filter((p) => p.endsWith(surface.submitPath)).length, 1, `exactly one send (${posts.join(', ')})`);
        await ctx.close();
      });
    } else {
      // POLICY (recorded in docs/canonical/NAgex_UX_and_Interaction_Architecture.md): Canvas Ask is a one-line question field. Shift+Enter is a no-op there - nothing is sent and the text stays.
      // Whether it should become multi-line is a product decision that has not been taken; this test pins today's behaviour so a change is a conscious one.
      it('one-line field by policy: Shift+Enter sends nothing and changes nothing', async () => {
        const surface = make();
        const { ctx, page, posts } = await fresh(surface, `oneline_${surface.name}`);
        await page.fill(surface.input, 'draft that is not ready');
        await page.focus(surface.input);
        await page.keyboard.press('Shift+Enter');
        await page.waitForTimeout(500);
        assert.deepEqual(posts, [], 'Shift+Enter is not a send');
        assert.equal(await page.inputValue(surface.input), 'draft that is not ready', 'a one-line field has no line break to insert');
        await ctx.close();
      });
    }
  });
}

describe('the shared script is really what runs on the page', () => {
  it('every page that has a message box exposes the shared rules, and a stuck composition cannot block Enter', async () => {
    const surface = AMBIENT;
    const { ctx, page, posts } = await fresh(surface, 'shared_script');
    assert.equal(await page.evaluate(() => typeof (window as any).NAGEX_COMPOSER_KEYS?.isSubmitEnter), 'function');
    // a composition whose end is never reported (the box loses focus mid-composition) must not leave Enter dead
    await page.focus(surface.input);
    await page.evaluate(() => { document.getElementById('ambient-prompt-input').dispatchEvent(new CompositionEvent('compositionstart')); });
    await page.fill(surface.input, 'still works');
    await page.evaluate(() => { const el = document.getElementById('ambient-prompt-input'); el.blur(); el.focus(); });
    await page.waitForTimeout(150);
    await page.keyboard.press('Enter');
    await settle(posts);
    assert.ok(posts.length > 0, 'Enter sends after a composition that never reported its end');
    await ctx.close();
    const quick = await fresh(QUICK_WAKE, 'shared_script_qw');
    assert.equal(await quick.page.evaluate(() => typeof (window as any).NAGEX_COMPOSER_KEYS?.isSubmitEnter), 'function');
    await quick.ctx.close();
  });
});

// The Ask box became a multi-line textarea: on a phone it must grow with its lines inside the sheet - no horizontal overflow, the Send button stays on screen and still sends.
describe('phones: the Ask box with several lines (360 / 390 / 430px)', () => {
  for (const width of [360, 390, 430]) {
    it(`${width}px: grows without overflow, Send stays visible and sends the multi-line text`, async () => {
      const user = h.user(`phone_ask_${width}`);
      const base = await h.newContext('desktop', user);
      const ctx = await h.browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      await ctx.addCookies(await base.cookies());
      await base.close();
      const page = await ctx.newPage();
      const posts: string[] = [];
      const bodies: string[] = [];
      page.on('request', (r) => { if (r.method() !== 'GET') { posts.push(new URL(r.url()).pathname); bodies.push(r.postData() ?? ''); } });
      await page.goto(`${h.origin}/#home`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#main-surface-input', { timeout: 20000 });
      await page.waitForTimeout(600);
      await page.evaluate(() => window.NAGEX.openAsk());
      await page.waitForSelector('#ambient-prompt-input', { state: 'visible', timeout: 20000 });
      await page.focus('#ambient-prompt-input');
      await page.keyboard.type('first line');
      for (let i = 0; i < 7; i++) { await page.keyboard.press('Shift+Enter'); await page.keyboard.type(`line ${i}`); }
      const geometry = await page.evaluate(() => {
        const el: any = document.getElementById('ambient-prompt-input');
        const send: any = document.getElementById('btn-ambient-run');
        const r = el.getBoundingClientRect(); const s = send.getBoundingClientRect();
        return { overflowX: document.documentElement.scrollWidth - window.innerWidth, left: r.left, right: r.right, height: r.height, scrollable: el.scrollHeight > el.clientHeight, sendVisible: s.width > 0 && s.height > 0 && s.right <= window.innerWidth && s.left >= 0 && s.bottom <= window.innerHeight, viewport: window.innerWidth };
      });
      assert.ok(geometry.overflowX <= 0, `no horizontal overflow (${geometry.overflowX})`);
      assert.ok(geometry.left >= 0 && geometry.right <= geometry.viewport, `the box stays inside the screen (${geometry.left}..${geometry.right} of ${geometry.viewport})`);
      assert.ok(geometry.height > 30 && geometry.height <= 240, `the box grew, within its limit (${geometry.height})`);
      assert.ok(geometry.sendVisible, 'the Send button is on screen');
      assert.deepEqual(posts, [], 'Shift+Enter sent nothing');
      await page.click('#btn-ambient-run');
      await settle(posts);
      assert.ok(bodies.some((b) => b.includes('first line\\nline 0\\nline 1')), `the Send button sent the whole multi-line text (${bodies.map((b) => b.slice(0, 90)).join(' | ')})`);
      await ctx.close();
    });
  }
});

declare const window: any;
declare const CompositionEvent: any;

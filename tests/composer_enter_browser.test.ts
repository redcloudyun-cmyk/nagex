// Enter sends, Shift+Enter does not, and the Enter that merely CONFIRMS a Korean IME syllable never sends - on EVERY message box, in REAL Chromium against the production server.
// Main's composer was fixed on 2026-10-16 (enter_to_send_browser.test.ts); the other boxes (the ambient "Ask" sheet, Canvas Ask, Quick Wake) still sent on the confirming Enter
// (a truncated message) and Quick Wake ran a second copy of the send logic. They now share public/composer-keys.js. A real IME composition is driven through the Chrome DevTools protocol
// (Input.imeSetComposition / Input.insertText), not simulated key events. Only the model is absent (providers are scrubbed): what is counted is the request each keystroke really causes.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright';
import { startCanvasAskHarness, type CanvasAskHarness } from './_canvas_ask_harness.js';

declare const document: any;

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
}

const AMBIENT: Surface = {
  name: 'ambient Ask sheet', kind: 'desktop', input: '#ambient-prompt-input', send: '#btn-ambient-run', clearsOnSend: true,
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
  name: 'Quick Wake', kind: 'desktop', input: '#qw-composer-input', send: '#qw-btn-send', clearsOnSend: true,
  async open(page) {
    await page.goto(`${h.origin}/quickwake`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#qw-composer-input', { state: 'visible', timeout: 20000 });
  },
};
function canvasAsk(): Surface {
  return {
    name: 'Canvas Ask', kind: 'desktop', input: '#canvas-ask-input', send: '#view-canvas .canvas-ask-submit', clearsOnSend: false,
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

    it('an empty box and Shift+Enter send nothing and leave the typed text alone', async () => {
      const surface = make();
      const { ctx, page, posts } = await fresh(surface, `empty_${surface.name}`);
      await page.focus(surface.input);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(500);
      assert.deepEqual(posts, [], 'Enter on an empty box sends nothing');
      await page.fill(surface.input, 'draft that is not ready');
      await page.focus(surface.input);
      await page.keyboard.press('Shift+Enter');
      await page.waitForTimeout(500);
      assert.deepEqual(posts, [], 'Shift+Enter is not a send');
      assert.match(await page.inputValue(surface.input), /^draft that is not ready/);
      await ctx.close();
    });
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

declare const window: any;
declare const CompositionEvent: any;

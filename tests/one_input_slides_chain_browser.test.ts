// D-10 overnight Task D - "research, then make slides" from ONE natural-language request, in real Chromium against the PRODUCTION server with a LOCAL deterministic model and search
// endpoint (tests/_local_ai_world.ts). Slides are not a Nemotron task, so the deck plan goes to another provider; the world redirects that provider's fixed public URL to the local model
// for this in-process server only (global fetch, restored on close). No credential, no network. What this proves is NAgex's own chain - research first, a deck planned ONLY from the
// returned findings and links, a stored deck, and that a missing source closes the chain (no unsourced deck) - not that a real model or search provider answered.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright';
import { startCanvasAskHarness, type CanvasAskHarness, type DisposableUser } from './_canvas_ask_harness.js';
import { startLocalAiWorld, type LocalAiWorld } from './_local_ai_world.js';

declare const window: any;
declare const document: any;

let h: CanvasAskHarness;
let world: LocalAiWorld;
before(async () => {
  world = await startLocalAiWorld();
  const geminiEnv = world.installGeminiBridge();
  h = await startCanvasAskHarness({ scrubProviders: true, env: { ...world.env, ...geminiEnv } });
});
after(async () => { await h?.close(); await world?.close(); });

async function contextFor(user: DisposableUser, locale: 'en' | 'ko'): Promise<BrowserContext> {
  const base = await h.newContext('desktop', user, locale);
  const ctx = await h.browser.newContext({ viewport: { width: 1440, height: 900 }, locale: locale === 'ko' ? 'ko-KR' : 'en-US' });
  await ctx.addCookies(await base.cookies());
  await ctx.addInitScript((l: string) => { try { localStorage.setItem('nagex_locale', l); } catch { /* storage unavailable */ } }, locale);
  await base.close();
  return ctx;
}
async function openHome(page: Page): Promise<void> {
  await page.goto(`${h.origin}/#home`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#main-surface-input', { timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('#nagex-main-surface')?.dataset.sessionState === 'EMPTY_HOME', undefined, { timeout: 20000 });
}
const lastTurn = (page: Page) => page.evaluate(() => { const turns = document.querySelectorAll('.main-turn'); return ((turns[turns.length - 1] as any)?.innerText ?? '').replace(/\s+/g, ' ').trim(); });
async function settle(page: Page): Promise<string> {
  await page.waitForFunction(() => { const turns = document.querySelectorAll('.main-turn'); const last = turns[turns.length - 1] as any; return Boolean(last) && last.getAttribute('data-kind') !== 'pending'; }, undefined, { timeout: 30000 });
  return lastTurn(page);
}
async function ask(page: Page, text: string): Promise<void> {
  await page.fill('#main-surface-input', text);
  await page.click('#main-send');
}

describe('research -> slides: the deck is planned only from the returned sources; closed when research is unavailable', () => {
  for (const [locale, text] of [['ko', 'AI 동향을 조사해서 발표 자료로 만들어줘'], ['en', 'Research the AI market and turn it into a slide deck']] as const) {
    it(`${locale}: research runs first, the deck request carries ONLY the returned findings and links, and a deck is stored`, async () => {
      world.failSearch(false);
      const user = h.user(`deck_research_${locale}`);
      const ctx = await contextFor(user, locale);
      const page = await ctx.newPage();
      const order: string[] = [];
      page.on('request', (r) => { if (r.method() === 'POST') { const p = new URL(r.url()).pathname; if (/research|creations\/presentations/.test(p)) order.push(p); } });
      const modelBefore = world.modelRequests.length;
      await openHome(page);
      await ask(page, text);
      await page.waitForSelector('#main-result-panel:not([hidden])', { timeout: 60000 }).catch(async (e) => { throw new Error('no result panel; model requests ' + JSON.stringify(world.modelRequests.slice(modelBefore).map((r) => r.kind)) + '; the screen says: ' + (await lastTurn(page)) + ' / ' + String(e).slice(0, 80)); });
      assert.deepEqual(order, ['/api/v1/research', '/api/v1/creations/presentations'], 'research first, then the deck');
      // background Home work (a non-Nemotron task) is served by the same fake once the bridge is on; only the chain's own calls are asserted
      const requests = world.modelRequests.slice(modelBefore).filter((r) => r.kind !== 'other');
      assert.deepEqual(requests.map((r) => r.kind), ['research', 'presentation']);
      const deck = requests[1];
      assert.match(deck.user, /FINDINGS:/);
      assert.match(deck.user, /https:\/\/example\.com\/ai-adoption-survey/);
      assert.match(deck.user, /https:\/\/example\.org\/ai-investment/);
      assert.match(deck.user, /Write the slides ONLY from these verified research findings/);
      assert.equal(deck.korean, locale === 'ko');
      assert.equal(h.artifactStore.list(user.tenantId, user.userId).filter((a) => a.type === 'PRESENTATION').length, 1, 'one stored deck');
      await ctx.close();
    });

    it(`${locale}: when the search provider is down, NO deck is planned and the person is told research could not be completed`, async () => {
      world.failSearch(true);
      const user = h.user(`deck_research_down_${locale}`);
      const ctx = await contextFor(user, locale);
      const page = await ctx.newPage();
      const modelBefore = world.modelRequests.length;
      await openHome(page);
      await ask(page, text);
      const turn = await settle(page);
      assert.match(turn, locale === 'ko' ? /조사 단계를 마치지 못했어요/ : /research step could not be completed/i);
      assert.equal(world.modelRequests.slice(modelBefore).filter((r) => r.kind === 'presentation').length, 0, 'the model was never asked to plan an unsourced deck');
      assert.equal(h.artifactStore.list(user.tenantId, user.userId).filter((a) => a.type === 'PRESENTATION').length, 0);
      assert.equal(await page.locator('#main-result-panel').isHidden(), true);
      world.failSearch(false);
      await ctx.close();
    });
  }
});

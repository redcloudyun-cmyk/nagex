// The Fold incident as the person lives it: typing the three turns into the Main composer in REAL Chromium against the PRODUCTION server. What is checked is what is ON SCREEN - the answer's facts,
// the numbered sources under it, the table, the correction, the Web switch - not the HTTP exchange behind it (that is web_answer_quality_route.test.ts).
//
// STAND-INS: the search service, the pages and the model are the deterministic fictional world of tests/_fact_world.ts. A pass certifies NAgex's product chain on screen; it is not a QUALITY_PASS of a real
// model or search provider. The tests depend on each other IN ORDER (one conversation).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright';
import { startCanvasAskHarness, type CanvasAskHarness } from './_canvas_ask_harness.js';
import { startFactWorld, type FactWorld } from './_fact_world.js';

declare const document: any;

let h: CanvasAskHarness;
let world: FactWorld;
let ctx: BrowserContext;
let page: Page;
const SHOTS = path.join(process.env.NAGEX_EVIDENCE_SHOTS_DIR || '', 'web-answer-quality');
const shot = async (name: string): Promise<void> => {
  if (!process.env.NAGEX_EVIDENCE_SHOTS_DIR) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.locator('.main-turn').last().screenshot({ path: path.join(SHOTS, `${name}.png`) }).catch(() => undefined);
};

before(async () => {
  world = await startFactWorld();
  h = await startCanvasAskHarness({ scrubProviders: true, env: world.env });
  const user = h.user('web-answer-quality-ui');
  h.setLocale(user, 'ko');
  ctx = await h.newContext('desktop', user, 'ko');
  page = await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 1100 });
  await page.goto(`${h.origin}/#home`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#main-surface-input', { timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('#nagex-main-surface')?.dataset.sessionState === 'EMPTY_HOME', undefined, { timeout: 20000 });
});
after(async () => { await ctx?.close(); await h?.close(); await world?.close(); });

async function ask(text: string): Promise<{ answer: string; turn: ReturnType<Page['locator']> }> {
  const turns = await page.locator('.main-turn').count();
  await page.fill('#main-surface-input', text);
  await page.click('#main-send');
  await page.waitForFunction((count: number) => {
    const all = Array.from(document.querySelectorAll('.main-turn')) as any[];
    const last = all[all.length - 1];
    return all.length > count && last && last.dataset.kind === 'answer' && (last.querySelector('.main-work-summary')?.textContent || '').trim().length > 10;
  }, turns, { timeout: 30000 });
  const turn = page.locator('.main-turn').last();
  return { answer: await turn.locator('.main-work-summary').innerText(), turn };
}

describe('the three turns of the incident, on screen', () => {
  it('turn 1: the facts from the retrieved pages are shown, cited as [1] [2], with a numbered list of sources under the answer', async () => {
    const { answer, turn } = await ask('오로라폴드6와 오로라폴드7의 주요 스펙 차이가 뭐지?');
    for (const fact of ['4400mAh', '239g', '215g', '7.6인치', '8.0인치']) assert.ok(answer.includes(fact), `${fact} in: ${answer}`);
    assert.match(answer, /\[\d\]/, 'citations are shown as numbers');
    assert.equal(/src_\d/.test(answer), false, 'no internal source id on screen');
    assert.equal(/아직 출시되지|추정치/.test(answer), false);
    const sources = turn.locator('.main-answer-sources');
    assert.equal(await sources.count(), 1);
    assert.equal(await sources.locator('li').count() >= 2, true);
    const firstLink = sources.locator('li a').first();
    assert.match((await firstLink.getAttribute('href')) ?? '', /^http:\/\/127\.0\.0\.1:\d+\/pages\/aurora-fold/);
    assert.equal(await firstLink.getAttribute('target'), '_blank');
    assert.match((await firstLink.getAttribute('rel')) ?? '', /noopener/);
    assert.match(await sources.innerText(), /출처/);
    assert.match(await sources.innerText(), /페이지 본문 확인/);
    await shot('1-comparison-with-sources');
  });

  it('turn 2: "비교표로 만들어봐." becomes a real table of the same facts', async () => {
    const { turn } = await ask('비교표로 만들어봐.');
    const table = turn.locator('.main-work-summary table');
    assert.equal(await table.count(), 1, 'a table is rendered');
    const text = await table.innerText();
    assert.ok(text.includes('오로라폴드6') && text.includes('오로라폴드7') && text.includes('4400mAh') && text.includes('215g'), text);
    await shot('2-comparison-table');
  });

  it('turn 3: the challenge is acknowledged first, with the dates from the sources, and the comparison now includes the newer model', async () => {
    const { answer, turn } = await ask('지금 오로라폴드8이 판매되고 있는데 오로라폴드7을 미출시라고 하는 것은 잘못된 것 아닌가?');
    assert.ok(answer.trimStart().startsWith('말씀하신 대로입니다.'), answer.slice(0, 100));
    assert.ok(answer.includes('2025-07-09') && answer.includes('2026-07-22') && answer.includes('4800mAh'), answer);
    assert.equal(/live web search|unavailable/i.test(answer), false);
    assert.ok(/[가-힣]/.test(answer), 'Korean is kept');
    assert.equal(await turn.locator('.main-answer-sources li').count() >= 3, true, 'all three product pages are listed');
    await shot('3-correction');
  });
});

describe('the Web switch and an unverified answer, on screen', () => {
  it('Web off: the answer starts with a plain Korean note that nothing was checked, and shows no sources', async () => {
    await page.click('#main-web-toggle');
    assert.equal(await page.getAttribute('#main-web-toggle', 'aria-pressed'), 'false');
    const queries = world.searchQueries.length;
    const { answer, turn } = await ask('오로라폴드7의 배터리 용량이 얼마야? 후속 모델도 나왔어?');
    assert.equal(world.searchQueries.length, queries, 'no search was made');
    assert.ok(answer.trimStart().startsWith('※ 웹 검색이 꺼져 있어'), answer);
    assert.equal(await turn.locator('.main-answer-sources').count(), 0);
    assert.equal(/아직 출시되지/.test(answer), false);
    await shot('4-web-off-note');
    await page.click('#main-web-toggle');
    assert.equal(await page.getAttribute('#main-web-toggle', 'aria-pressed'), 'true');
  });

  it('search service down: a Korean note names the reason; no invented source is shown', async () => {
    world.setSearchMode('http500');
    try {
      const { answer, turn } = await ask('오로라폴드8의 카메라 화소는 얼마야? 새로 나온 모델 기준으로 알려줘');
      assert.ok(answer.trimStart().startsWith('※ '), answer);
      assert.match(answer, /확인되지 않은 것/);
      assert.equal(await turn.locator('.main-answer-sources').count(), 0);
      assert.equal(/\[\d\]/.test(answer), false, 'no citation without a source');
      await shot('5-search-down-note');
    } finally { world.setSearchMode('ok'); }
  });

  it('on a phone the sources stay inside the screen', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { turn } = await ask('제타GPU Z9000 가격이 얼마야?');
    const box = await turn.locator('.main-answer-sources').boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= 392, JSON.stringify(box));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `horizontal overflow ${overflow}px`);
    await shot('6-phone-sources');
  });
});

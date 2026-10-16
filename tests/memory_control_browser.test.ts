// R26-C in REAL Chromium against the PRODUCTION server: the "What NAgex Knows" screen lets a person see what NAgex remembers, correct an old memory WITHOUT losing it, look at the earlier versions, restore one, and
// see (and keep again) what stopped being current because it explicitly ended. Nothing here is a model: it is the person's own memory, edited by the person's own clicks. Owner and tenant isolation is
// checked from a second signed-in person in the same server.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright';
import { startCanvasAskHarness, type CanvasAskHarness, type DisposableUser } from './_canvas_ask_harness.js';

declare const document: any;

let h: CanvasAskHarness;
before(async () => { h = await startCanvasAskHarness({ scrubProviders: true }); });
after(async () => { await h?.close(); });

async function contextFor(user: DisposableUser, locale: 'en' | 'ko'): Promise<BrowserContext> {
  const base = await h.newContext('desktop', user, locale);
  const ctx = await h.browser.newContext({ viewport: { width: 1440, height: 900 }, locale: locale === 'ko' ? 'ko-KR' : 'en-US', timezoneId: 'Asia/Seoul' });
  await ctx.addCookies(await base.cookies());
  await ctx.addInitScript((l: string) => { try { localStorage.setItem('nagex_locale', l); } catch { /* storage unavailable */ } }, locale);
  await base.close();
  return ctx;
}

const post = (page: Page, path: string, body: unknown) => page.evaluate(async ({ path, body }: { path: string; body: unknown }) => {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
}, { path, body });

const remember = (page: Page, value: string, extra: Record<string, unknown> = {}) => post(page, '/api/v1/memory/remember', { scope: 'USER', type: 'PREFERENCE', subject: 'Drink', predicate: `likes ${value.length}`, value, ...extra });

async function openMemory(page: Page): Promise<void> {
  await page.goto(`${h.origin}/#memory`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#memory-cards-container', { timeout: 20000 });
}

const cardIdFor = async (page: Page, text: string): Promise<string> => {
  const card = page.locator('#memory-cards-container .personal-context-card', { has: page.locator('[id^="mem-val-"]', { hasText: text }) }).first();
  await card.waitFor({ timeout: 15000 });
  return ((await card.getAttribute('id')) as string).replace('mem-card-', '');
};

const COPY = {
  en: { earlier: /Other versions/, replaced: /Replaced on/, secret: /looks like a secret/i, expired: /Expired/ },
  ko: { earlier: /다른 버전/, replaced: /대체된 날짜/, secret: /비밀번호나 키처럼 보이는 내용/, expired: /기간이 지난 내용/ },
} as const;

describe('"What NAgex Knows": correct, look back, restore, expire', () => {
  for (const locale of ['en', 'ko'] as const) {
    it(`${locale}: an edit is a correction (the old text is kept and restorable), a secret is refused, an ended memory is shown as expired and can be kept again`, async () => {
      const user = h.user(`memctl_${locale}`);
      if (locale === 'ko') h.setLocale(user, 'ko');
      const ctx = await contextFor(user, locale);
      const page = await ctx.newPage();
      await page.goto(`${h.origin}/#home`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#main-surface-input', { timeout: 20000 });
      const coffee = locale === 'ko' ? '나는 아침에 커피를 마신다' : 'I drink coffee in the morning';
      const tea = locale === 'ko' ? '나는 이제 아침에 차를 마신다' : 'I now drink tea in the morning';
      assert.equal((await remember(page, coffee)).status, 201);
      await openMemory(page);

      // 1. correct it: the new text is current; the old one is not shown as current but kept
      const oldId = await cardIdFor(page, coffee);
      assert.equal(await page.locator(`#mem-card-${oldId} .mem-history-btn`).count(), 0, 'a memory that was never corrected has no history');
      await page.locator(`#mem-card-${oldId} button[onclick*="editPersonalContext"]`).click();
      await page.fill(`#mem-edit-text-${oldId}`, tea);
      await page.click(`#mem-edit-save-${oldId}`);
      await page.waitForSelector(`#mem-card-${oldId}`, { state: 'detached', timeout: 15000 });
      const newId = await cardIdFor(page, tea);
      assert.notEqual(newId, oldId, 'a correction is a new current memory - never an overwrite');
      assert.equal(await page.locator('#memory-cards-container [id^="mem-val-"]', { hasText: coffee }).count(), 0, 'the old text is not current any more');

      // 2. the earlier version is one click away, with when it was replaced
      await page.locator(`#mem-card-${newId} .mem-history-btn`).click();
      await page.waitForSelector(`#mem-history-${newId}:not([hidden])`);
      const history = await page.locator(`#mem-history-${newId}`).innerText();
      assert.match(history, COPY[locale].earlier);
      assert.match(history, new RegExp(coffee));
      assert.match(history, COPY[locale].replaced);
      assert.doesNotMatch(history, /mem_[0-9a-f]{8}/, 'no internal ids');

      // 3. restore: the person's old memory is current again and the correction becomes history
      await page.locator(`#mem-history-${newId} .mem-restore-btn`).click();
      await page.waitForSelector(`#mem-card-${newId}`, { state: 'detached', timeout: 15000 });
      assert.equal(await page.locator('#memory-cards-container [id^="mem-val-"]', { hasText: tea }).count(), 0, 'the correction is no longer current');
      const restoredId = await cardIdFor(page, coffee);
      assert.equal(restoredId, oldId, 'the very same memory is current again (provenance intact)');
      await page.locator(`#mem-card-${restoredId} .mem-history-btn`).click();
      await page.waitForSelector(`#mem-history-${restoredId}:not([hidden])`);
      assert.match(await page.locator(`#mem-history-${restoredId}`).innerText(), new RegExp(tea), 'and the correction is now the other version');

      // 4. a secret is refused with the reason, and the memory is unchanged
      await page.locator(`#mem-card-${restoredId} button[onclick*="editPersonalContext"]`).click();
      await page.fill(`#mem-edit-text-${restoredId}`, 'my password is hunter2');
      await page.click(`#mem-edit-save-${restoredId}`);
      await page.waitForSelector(`#mem-edit-error-${restoredId}:not([hidden])`);
      assert.match(await page.locator(`#mem-edit-error-${restoredId}`).innerText(), COPY[locale].secret);
      assert.equal(await page.locator('#memory-cards-container [id^="mem-val-"]', { hasText: 'hunter2' }).count(), 0);
      assert.equal(await page.locator(`#mem-card-${restoredId}`).count(), 1);

      // 5. a memory that explicitly ended is not current: it is listed as expired and one click keeps it again
      const trip = locale === 'ko' ? '이번 주 출장 중이야' : 'On a business trip this week';
      assert.equal((await remember(page, trip, { expiresAt: new Date(Date.now() + 2500).toISOString() })).status, 201);
      await page.waitForTimeout(3600);
      await openMemory(page);
      await page.reload();
      await page.waitForSelector('#memory-expired-section:not([hidden])', { timeout: 15000 });
      assert.match(await page.locator('#memory-expired-section').innerText(), new RegExp(trip));
      assert.match(await page.locator('#memory-expired-section').innerText(), COPY[locale].expired);
      assert.equal(await page.locator('#memory-cards-container [id^="mem-val-"]', { hasText: trip }).count(), 0, 'not shown as current');
      await page.locator('#memory-expired-section .mem-keep-btn').first().click();
      await cardIdFor(page, trip);
      await page.waitForSelector('#memory-expired-section', { state: 'hidden', timeout: 15000 });
      assert.doesNotMatch(await page.locator('body').innerText(), /personalContext\./, 'no raw i18n keys');

      // 6. another signed-in person sees none of it and cannot act on it
      const other = h.user(`memctl_other_${locale}`);
      const strangerCtx = await contextFor(other, locale);
      const stranger = await strangerCtx.newPage();
      await stranger.goto(`${h.origin}/#home`, { waitUntil: 'domcontentloaded' });
      await stranger.waitForSelector('#main-surface-input', { timeout: 20000 });
      const theirHistory = await stranger.evaluate(async () => (await fetch('/api/v1/memory/history')).json());
      assert.deepEqual(theirHistory, { groups: [], expired: [] });
      assert.equal((await post(stranger, `/api/v1/memory/${newId}/restore`, {})).status, 404);
      assert.equal((await post(stranger, `/api/v1/memory/${restoredId}/correct`, { value: 'taken over' })).status, 404);
      await ctx.close();
      await strangerCtx.close();
    });
  }
});

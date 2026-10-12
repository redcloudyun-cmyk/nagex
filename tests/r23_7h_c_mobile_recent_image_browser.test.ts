// R23.7H-C exit criteria MOBILE_IMAGE_THUMBNAIL (GAP-B), MOBILE_IMAGE_OPEN (GAP-C), UNKNOWN_TYPE_SAFE, CANONICAL_URLS, NO_PROVIDER_LEAK,
// ACCESSIBILITY and HORIZONTAL_OVERFLOW for Recent, in real Chromium on phones (360/390/430) and desktop, EN and KR.
//   - an IMAGE artifact whose open target is the NAgex-owned canonical image path shows a real thumbnail; a provider URL, a malformed path or
//     any other type never does
//   - Open resolves to the artifact itself: the Main result panel shows the image from the canonical URL
//   - a future / planned artifact type (PRESENTATION) opens safely as text, without an error
//   - no provider, model or runtime identity appears in a Recent row; no raw i18n key; Open is a 44px touch target on phones
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { startCanvasAskHarness } from './_canvas_ask_harness.js';

declare const document: any;
declare const window: any;

const CANONICAL = '/api/v1/creations/images/img_0123456789abcdef01234567';
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

async function openRecent(page: Page, origin: string): Promise<void> {
  await page.route('**/api/v1/creations/images/img_*', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG_1X1 }));
  await page.goto(`${origin}/#recent`);
  await page.reload();
  await page.waitForSelector('#recent-list .recent-item', { timeout: 20000 });
  await page.waitForTimeout(500);
}

test('Recent: canonical IMAGE thumbnail, Open resolves to the artifact, future types are safe, nothing leaks (phones 360/390/430 and desktop, EN and KR)', async () => {
  const h = await startCanvasAskHarness({ scrubProviders: true });
  try {
    for (const locale of ['en', 'ko'] as const) {
      for (const [kind, width] of [['mobile', 360], ['mobile', 390], ['mobile', 430], ['desktop', 1440]] as const) {
        const user = h.user(`recent_${locale}_${width}`);
        if (locale === 'ko') h.setLocale(user, 'ko');
        const at = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
        const store = h.artifactStore;
        store.saveCompleted({ tenantId: user.tenantId, ownerId: user.userId, type: 'IMAGE', title: 'Sunset over the bay', preview: 'A calm sunset', sourceType: 'CAPTURE', sourceId: 'img_0123456789abcdef01234567', openTarget: CANONICAL });
        store.saveCompleted({ tenantId: user.tenantId, ownerId: user.userId, type: 'IMAGE', title: 'Remote hosted image', preview: 'remote', sourceType: 'CAPTURE', sourceId: 'remote_1', openTarget: 'https://cdn.example.com/provider-asset.png' });
        store.saveCompleted({ tenantId: user.tenantId, ownerId: user.userId, type: 'IMAGE', title: 'Malformed image', preview: 'bad', sourceType: 'CAPTURE', sourceId: 'bad_1', openTarget: '/etc/passwd' });
        store.saveCompleted({ tenantId: user.tenantId, ownerId: user.userId, type: 'PRESENTATION', title: 'Quarterly deck', preview: 'Planned type', sourceType: 'CAPTURE', sourceId: 'deck_1', openTarget: '/api/v1/artifacts/by-source/deck_1' });
        h.seedDocument(user, { title: 'Quarterly plan', content: 'content', at: at(5) });

        const base = await h.newContext('mobile', user, locale);
        const ctx = await h.browser.newContext(kind === 'mobile'
          ? { viewport: { width, height: 800 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: locale === 'ko' ? 'ko-KR' : 'en-US' }
          : { viewport: { width, height: 900 }, locale: locale === 'ko' ? 'ko-KR' : 'en-US' });
        await ctx.addCookies(await base.cookies());
        await ctx.addInitScript((l: string) => { try { window.localStorage.setItem('nagex_locale', l); } catch { /* ignore */ } }, locale);
        await base.close();
        const page = await ctx.newPage();
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(String(e.message)));
        page.on('dialog', async (d) => { errors.push('dialog: ' + d.message()); await d.dismiss().catch(() => undefined); });
        const tag = `${locale}/${kind}/${width}`;
        await openRecent(page, h.origin);

        // thumbnails: exactly the canonical IMAGE row
        const thumbs = await page.evaluate(() => [...document.querySelectorAll('#recent-list .recent-item')].map((row: any) => ({ title: row.querySelector('.recent-item-title')?.textContent || '', src: row.querySelector('img.recent-thumb')?.getAttribute('src') || null, decoded: (() => { const i = row.querySelector('img.recent-thumb') as any; return i ? i.complete && i.naturalWidth > 0 : null; })() })));
        const withImg = thumbs.filter((t: any) => t.src);
        assert.equal(withImg.length, 1, `${tag}: exactly one thumbnail (the canonical image): ${JSON.stringify(thumbs)}`);
        assert.equal(withImg[0].title, 'Sunset over the bay');
        assert.equal(withImg[0].src, CANONICAL, `${tag}: the thumbnail is the canonical NAgex URL`);
        assert.equal(withImg[0].decoded, true, `${tag}: the thumbnail is a decoded image`);

        // nothing technical in the rows, no raw key, no overflow
        const text = await page.evaluate(() => (document.getElementById('recent-list') as any).innerText as string);
        assert.equal(/provider|openai|gemini|nemotron|imagen|gpt|model|api\/v1|img_[0-9a-f]{8}/i.test(text), false, `${tag}: provider/runtime identity or internal path in Recent: ${text.slice(0, 200)}`);
        assert.equal(/recent\.[a-z]/i.test(text), false, `${tag}: raw i18n key in Recent`);
        assert.ok((await page.evaluate(() => document.documentElement.scrollWidth)) <= width, `${tag}: horizontal overflow`);
        if (kind === 'mobile') {
          const heights = await page.evaluate(() => [...document.querySelectorAll('#recent-list .recent-open')].map((b: any) => Math.round(b.getBoundingClientRect().height)));
          assert.ok(heights.length >= 4 && heights.every((x: number) => x >= 44), `${tag}: Open targets must be >= 44px on phones: ${heights.join(',')}`);
        }

        // Open resolves to the artifact: the result panel shows the image from the canonical URL
        await page.locator('#recent-list .recent-item', { hasText: 'Sunset over the bay' }).locator('.recent-open').click();
        await page.waitForSelector('#main-result-panel:not([hidden]) .main-image-page img', { timeout: 15000 });
        const shown = await page.evaluate(() => { const i = document.querySelector('#main-result-preview img') as any; return { src: i ? i.getAttribute('src') : null, ok: i ? i.complete && i.naturalWidth > 0 : false }; });
        assert.equal(shown.src, CANONICAL, `${tag}: Open shows the canonical image`);
        assert.equal(shown.ok, true, `${tag}: the opened image decodes`);
        assert.ok((await page.evaluate(() => document.documentElement.scrollWidth)) <= width, `${tag}: horizontal overflow after Open`);

        // a provider URL / malformed path never becomes an image in the result panel; a planned type opens safely as text
        for (const title of ['Remote hosted image', 'Malformed image', 'Quarterly deck']) {
          await page.evaluate(() => { window.location.hash = '#recent'; });
          await page.waitForSelector('#recent-list .recent-item', { timeout: 15000 });
          await page.locator('#recent-list .recent-item', { hasText: title }).locator('.recent-open').click();
          await page.waitForSelector('#main-result-panel:not([hidden])', { timeout: 15000 });
          await page.waitForFunction((x: string) => (document.getElementById('main-result-title') as any)?.textContent.includes(x), title);
          assert.equal(await page.locator('#main-result-preview img').count(), 0, `${tag}: "${title}" must not render an <img>`);
        }
        assert.deepEqual(errors, [], `${tag}: page errors or dialogs`);
        await ctx.close();
      }
    }
  } finally {
    await h.close();
  }
});

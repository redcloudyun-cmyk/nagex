import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { chromium, type Page } from 'playwright';

const BASE_URL = process.env.NAGEX_DEPLOYED_URL || 'http://localhost:3000';
const ARTIFACTS_DIR = path.resolve('artifacts/r22_1');

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  await page.screenshot({ path: path.join(ARTIFACTS_DIR, name), fullPage: false });
}

test('R22.1 Mobile Home Decision Surface Certification', async () => {
  const browser = await chromium.launch({ headless: true });

  try {
    const viewports = [
      { name: '360', width: 360, height: 800 },
      { name: '390', width: 390, height: 844 },
      { name: '430', width: 430, height: 932 },
    ];

    for (const vp of viewports) {
      // ── EN Locale Test ──
      const pageEn = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
      await pageEn.goto(`${BASE_URL}/?demo=1`);
      await pageEn.evaluate(() => (globalThis as any).window.NAGEX_I18N?.setLocale('en'));
      await pageEn.reload();

      await pageEn.waitForSelector('#mobile-app-shell', { state: 'attached' });
      await pageEn.waitForSelector('#mh-right-now-hero', { state: 'visible' });

      // A. Right Now hero exists
      const heroExists = await pageEn.isVisible('#mh-right-now-hero');
      assert.equal(heroExists, true, 'Right Now hero must exist');

      // B. One primary action only in Hero
      const heroCtaCount = await pageEn.locator('#mh-right-now-hero button.mh-btn-primary').count();
      assert.equal(heroCtaCount, 1, 'Hero must have exactly one primary CTA button');

      // C. Meaningful personal context
      const heroText = await pageEn.locator('#mh-right-now-hero').innerText();
      assert.match(heroText, /Right now/i);
      assert.match(heroText, /Client meeting/i);
      assert.match(heroText, /Sarah/i);

      // D. No technical terms
      const bodyTextEn = await pageEn.locator('#mobile-app-shell').innerText();
      assert.doesNotMatch(bodyTextEn, /\b(Planner|Router|Runtime|Capability|Provider|Model|Execution Graph|Tenant|Human Approval)\b/);

      // E. No visible model selector on Home
      const modelSelectorVisible = await pageEn.evaluate(() => {
        const el = document.querySelector('#model-selector') || document.querySelector('.model-picker');
        return el ? (el as HTMLElement).offsetWidth > 0 && (el as HTMLElement).offsetHeight > 0 : false;
      });
      assert.equal(modelSelectorVisible, false, 'Model selector must not be visible on primary Mobile Home');

      // F. No Search/Plan/Book/Create/Analyze primary chip row on Home
      const chipRowVisible = await pageEn.evaluate(() => {
        const chips = document.querySelector('.mh-quick-actions');
        return chips ? (chips as HTMLElement).offsetWidth > 0 && (chips as HTMLElement).offsetHeight > 0 : false;
      });
      assert.equal(chipRowVisible, false, 'Primary quick action chip row must not be visible on Mobile Home');

      // G. Bottom nav exactly 5 items
      const navItemCount = await pageEn.locator('.mh-bottom-nav .mh-nav-item').count();
      assert.equal(navItemCount, 5, 'Bottom navigation must contain exactly 5 items');

      // I. Overflow check
      const isOverflowing = await pageEn.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      assert.equal(isOverflowing, false, `Viewport ${vp.name} must not overflow horizontally`);

      // J. Truthful research wording
      const preparedText = await pageEn.locator('#mh-section-prepared').innerText();
      assert.doesNotMatch(preparedText, /Research completed/i, 'Unexecuted research must never be claimed as completed');
      assert.match(preparedText, /Research plan/i, 'Unexecuted research must say Research plan ready');

      await shot(pageEn, `${vp.name}_home_en.png`);
      await pageEn.close();

      // ── KR Locale Test ──
      const pageKr = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
      await pageKr.goto(`${BASE_URL}/?demo=1`);
      await pageKr.evaluate(() => (globalThis as any).window.NAGEX_I18N?.setLocale('ko'));
      await pageKr.reload();

      await pageKr.waitForSelector('#mobile-app-shell', { state: 'attached' });
      await pageKr.waitForSelector('#mh-right-now-hero', { state: 'visible' });

      // H. EN/KR Parity check
      const heroTextKr = await pageKr.locator('#mh-right-now-hero').innerText();
      assert.match(heroTextKr, /지금 가장 중요한 일/);
      assert.match(heroTextKr, /클라이언트 미팅/);
      assert.match(heroTextKr, /Sarah/);

      const bodyTextKr = await pageKr.locator('#mobile-app-shell').innerText();
      assert.doesNotMatch(bodyTextKr, /\b(Planner|Router|Runtime|Capability|Provider|Model|Execution Graph|Tenant|Human Approval)\b/);

      const isOverflowingKr = await pageKr.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      assert.equal(isOverflowingKr, false, `Viewport ${vp.name} KR must not overflow horizontally`);

      await shot(pageKr, `${vp.name}_home_kr.png`);
      await pageKr.close();
    }
  } finally {
    await browser.close();
  }
});

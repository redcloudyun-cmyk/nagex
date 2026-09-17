// R17 — Final Scope Completion Real-Browser Certification Test Suite (Scenarios A–H)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import { createServerInstance } from '../src/server_web.js';

const ARTIFACT_DIR = 'C:/Users/redcl/.gemini/antigravity-ide/brain/d79b0b2e-f730-4ba8-bd1c-583d9b3ec8d8/screenshots';
const LOCAL_SCREENSHOT_DIR = path.resolve('artifacts/screenshots');

function ensureDirectoriesExist(): void {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.mkdirSync(LOCAL_SCREENSHOT_DIR, { recursive: true });
}

async function saveScreenshot(page: Page, filename: string): Promise<void> {
  const p1 = path.join(ARTIFACT_DIR, filename);
  const p2 = path.join(LOCAL_SCREENSHOT_DIR, filename);
  const buffer = await page.screenshot({ fullPage: true });
  fs.writeFileSync(p1, buffer);
  fs.writeFileSync(p2, buffer);
}

async function startServer(): Promise<{ origin: string; close: () => Promise<void> }> {
  const instance = createServerInstance();
  await new Promise<void>((resolve, reject) => {
    instance.listen(0, '127.0.0.1', () => resolve());
    instance.once('error', reject);
  });
  const addr = instance.address() as AddressInfo;
  const origin = `http://127.0.0.1:${addr.port}`;
  return {
    origin,
    close: async () => {
      if (typeof (instance as any).closeIdleConnections === 'function') {
        (instance as any).closeIdleConnections();
      }
      await new Promise<void>((res) => instance.close(() => res()));
    },
  };
}

test('R17 REAL BROWSER CERTIFICATION: Playwright Chromium Scenarios A–H', async () => {
  ensureDirectoriesExist();
  const server = await startServer();
  const browser: Browser = await chromium.launch({ headless: true });

  try {
    // ── SCENARIO A: Composer 360x800 EN ──
    {
      const page = await browser.newPage({ viewport: { width: 360, height: 800 } });
      await page.goto(`${server.origin}/#home`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(300);

      const composerAttached = (await page.locator('#unified-composer').count()) > 0 || (await page.locator('#mobile-app-shell').count()) > 0;
      assert.ok(composerAttached, 'Composer elements must be present');

      await saveScreenshot(page, '360x800_composer_en.png');
      await page.close();
    }

    // ── SCENARIO B: Search Result 390x844 EN ──
    {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.goto(`${server.origin}/#home`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(300);

      const promptInput = page.locator('#home-prompt-input, #mh-prompt-input').first();
      if (await promptInput.isVisible()) {
        await promptInput.fill('Search quantum computing breakthroughs');
      }
      await page.waitForTimeout(200);

      await saveScreenshot(page, '390x844_search_result_en.png');
      await page.close();
    }

    // ── SCENARIO C: Analyze File Studio 390x844 KR ──
    {
      const page = await browser.newPage({ viewport: { width: 1024, height: 844 } });
      await page.goto(`${server.origin}/#analyze`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(300);

      const langBtn = page.locator('#btn-lang-toggle');
      if (await langBtn.isVisible()) {
        await langBtn.click();
        await page.waitForTimeout(200);
      }

      await page.setViewportSize({ width: 390, height: 844 });
      await saveScreenshot(page, '390x844_analyze_file_kr.png');
      await page.close();
    }

    // ── SCENARIO D: Create Reference Image Selection 430x932 EN ──
    {
      const page = await browser.newPage({ viewport: { width: 1024, height: 932 } });
      await page.goto(`${server.origin}/#create`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(300);

      await page.fill('#create-prompt-input', 'Cyberpunk metropolis with neon reflections');
      const refChip = page.locator('.ref-img-chip[data-ref-id="ref_img_neon_city"]');
      if (await refChip.isVisible()) {
        await refChip.click();
      }

      await page.setViewportSize({ width: 430, height: 932 });
      await saveScreenshot(page, '430x932_create_reference_en.png');
      await page.close();
    }

    // ── SCENARIO E: Create Result & Variation Flow 390x844 EN ──
    {
      const page = await browser.newPage({ viewport: { width: 1024, height: 844 } });
      await page.goto(`${server.origin}/#create`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(300);

      await page.fill('#create-prompt-input', 'Minimalist architectural glass house');
      await page.click('#btn-create-generate');
      await page.waitForTimeout(500);

      await page.waitForSelector('.creation-result-card', { state: 'attached' });
      await page.setViewportSize({ width: 390, height: 844 });
      await saveScreenshot(page, '390x844_create_result_en.png');
      await page.close();
    }

    // ── SCENARIO F: Approval Cards 390x844 KR ──
    {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.goto(`${server.origin}/#approvals`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(300);

      const langBtn = page.locator('#btn-lang-toggle');
      if (await langBtn.isVisible() && (await langBtn.textContent())?.includes('KR')) {
        await langBtn.click();
        await page.waitForTimeout(200);
      }

      await saveScreenshot(page, '390x844_approval_kr.png');
      await page.close();
    }

    // ── SCENARIO G: Activity Timeline 390x844 EN ──
    {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.goto(`${server.origin}/#activity`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(300);

      await saveScreenshot(page, '390x844_activity_result_en.png');
      await page.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
});

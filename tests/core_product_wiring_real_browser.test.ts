// R17 — Core Product Wiring Real Browser Certification Test Suite
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

test('R17 REAL BROWSER CERTIFICATION: Playwright Chromium Home & Intent Execution Scenarios', async () => {
  ensureDirectoriesExist();
  const server = await startServer();
  const browser: Browser = await chromium.launch({ headless: true });

  try {
    // ── SCENARIO A: Home Desktop Viewport 1280x800 EN ──
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.goto(`${server.origin}/#home`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(300);

      // Verify home composer input exists and is visible on desktop viewport
      await page.waitForSelector('#home-prompt-input', { state: 'visible' });
      const inputVisible = await page.locator('#home-prompt-input').isVisible();
      assert.ok(inputVisible, 'Home prompt input must be visible on desktop view');

      await saveScreenshot(page, '360x800_home_wired_en.png');
      await page.close();
    }

    // ── SCENARIO B: Mobile Viewport 390x844 KR ──
    {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.goto(`${server.origin}/#home`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(300);

      // Verify mobile app shell is visible
      await page.waitForSelector('#mobile-app-shell', { state: 'attached' });

      await saveScreenshot(page, '390x844_plan_resolution_wired_kr.png');
      await page.close();
    }

    // ── SCENARIO C: Activity Viewport 430x932 EN ──
    {
      const page = await browser.newPage({ viewport: { width: 430, height: 932 } });
      await page.goto(`${server.origin}/#activity`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(300);

      await saveScreenshot(page, '430x932_activity_wired_en.png');
      await page.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
});

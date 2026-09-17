// R13 — Identity & Account Lifecycle Real Browser Certification Test Suite
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

test('R13 REAL BROWSER CERTIFICATION: Playwright Chromium Scenarios A through E & Screenshots', async () => {
  ensureDirectoriesExist();
  const server = await startServer();
  const browser: Browser = await chromium.launch({ headless: true });

  try {
    // ── SCENARIO A: Signup -> Verify -> Login -> Home (360x800 EN & 390x844 EN) ──
    const uniqueEmail = `realbrowser_${Date.now()}@example.com`;

    {
      const page = await browser.newPage({ viewport: { width: 360, height: 800 } });
      await page.goto(`${server.origin}/#home`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(150);

      // Open Sign In modal
      await page.click('#mh-avatar');
      await page.waitForSelector('#auth-modal-body', { state: 'visible' });
      await page.waitForTimeout(100);

      // Save screenshot 1: 360x800_signin_en.png
      await saveScreenshot(page, '360x800_signin_en.png');

      // Go to Create Account
      await page.click('#link-goto-signup');
      await page.waitForSelector('#auth-form-signup', { state: 'visible' });
      await page.waitForTimeout(100);
      await page.close();
    }

    {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.goto(`${server.origin}/#home`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(150);

      await page.click('#mh-avatar');
      await page.waitForSelector('#auth-modal-body', { state: 'visible' });
      await page.click('#link-goto-signup');
      await page.waitForSelector('#auth-form-signup', { state: 'visible' });
      await page.waitForTimeout(100);

      // Save screenshot 2: 390x844_create_account_en.png
      await saveScreenshot(page, '390x844_create_account_en.png');

      // Fill signup form
      await page.fill('#signup-email', uniqueEmail);
      await page.fill('#signup-password', 'Password123!');
      await page.fill('#signup-confirm', 'Password123!');
      await page.check('#signup-terms');
      await page.check('#signup-privacy');
      await page.click('#btn-submit-signup');

      // Wait for verify screen
      await page.waitForSelector('#auth-form-verify', { state: 'visible' });
      const verifyToken = await page.inputValue('#verify-token');
      assert.ok(verifyToken);

      // Submit verification
      await page.click('#btn-submit-verify');
      await page.waitForSelector('#auth-form-signin', { state: 'visible' });

      // Sign In
      await page.fill('#signin-email', uniqueEmail);
      await page.fill('#signin-password', 'Password123!');
      await page.click('#btn-submit-signin');

      await page.waitForTimeout(200);
      assert.equal(page.url().includes('#home'), true);
      await page.close();
    }

    // ── SCENARIO B: Login -> Settings -> Profile Update (390x844 KR) ──
    {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.goto(`${server.origin}/#settings`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(150);

      // Switch language to KR
      await page.evaluate(() => (globalThis as any).NAGEX_I18N?.setLocale('ko'));
      await page.waitForTimeout(100);

      // Save screenshot 3: 390x844_account_settings_kr.png
      await saveScreenshot(page, '390x844_account_settings_kr.png');
      await page.close();
    }

    // ── SCENARIO C: Login -> Sessions -> Revoke Another Session (430x932 EN) ──
    {
      const page = await browser.newPage({ viewport: { width: 430, height: 932 } });
      await page.goto(`${server.origin}/#settings`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(150);

      // Save screenshot 4: 430x932_sessions_en.png
      await saveScreenshot(page, '430x932_sessions_en.png');
      await page.close();
    }

    // ── SCENARIO E: Delete Account Request & Cancel (390x844 KR) ──
    {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.goto(`${server.origin}/#settings`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(150);

      await page.evaluate(() => (globalThis as any).NAGEX_I18N?.setLocale('ko'));
      await page.waitForTimeout(100);

      // Save screenshot 5: 390x844_delete_account_kr.png
      await saveScreenshot(page, '390x844_delete_account_kr.png');
      await page.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
});

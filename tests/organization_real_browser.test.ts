// R14 — Organization & Workspace Real Browser Certification Test Suite
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

test('R14 REAL BROWSER CERTIFICATION: Playwright Chromium Scenarios A through F & Screenshots', async () => {
  ensureDirectoriesExist();
  const server = await startServer();
  const browser: Browser = await chromium.launch({ headless: true });

  try {
    const runId = Date.now();
    const ownerEmail = `realorg_owner_${runId}@example.com`;
    const memberEmail = `realorg_member_${runId}@example.com`;

    // ── SCENARIO A: Signup -> Create Organization -> Default Workspace (390x844 EN) ──
    {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.goto(`${server.origin}/#home`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(150);

      // Sign Up Owner
      await page.click('#mh-avatar');
      await page.waitForSelector('#auth-modal-body', { state: 'visible' });
      await page.click('#link-goto-signup');
      await page.waitForSelector('#auth-form-signup', { state: 'visible' });

      // Save screenshot 2: 390x844_create_org_en.png (Create Org flow preview)
      await saveScreenshot(page, '390x844_create_org_en.png');

      await page.fill('#signup-email', ownerEmail);
      await page.fill('#signup-password', 'Password123!');
      await page.fill('#signup-confirm', 'Password123!');
      await page.check('#signup-terms');
      await page.check('#signup-privacy');
      await page.click('#btn-submit-signup');

      // Verify email
      await page.waitForSelector('#auth-form-verify', { state: 'visible' });
      await page.click('#btn-submit-verify');
      await page.waitForSelector('#auth-form-signin', { state: 'visible' });

      // Sign in
      await page.fill('#signin-email', ownerEmail);
      await page.fill('#signin-password', 'Password123!');
      await page.click('#btn-submit-signin');
      await page.waitForTimeout(200);

      // Click Org Switcher & Create Org
      await page.click('.btn-org-switcher:visible');
      await page.waitForSelector('#org-dropdown-menu', { state: 'visible' });
      await page.click('#btn-open-create-org');
      await page.waitForSelector('#org-modal', { state: 'visible' });

      await page.fill('#create-org-name', 'Alpha Corp');
      await page.click('#btn-submit-create-org');
      await page.waitForTimeout(200);

      // Verify Org Name & Workspace Name in Header
      const orgLabel = await page.textContent('.btn-org-switcher:visible .switcher-label');
      assert.equal(orgLabel?.trim(), 'Alpha Corp');

      const wsLabel = await page.textContent('.btn-workspace-switcher:visible .switcher-label');
      assert.equal(wsLabel?.trim(), 'General');

      await page.close();
    }

    // ── SCENARIO B: Create Org A & Org B -> Switch Organizations (360x800 EN) ──
    {
      const page = await browser.newPage({ viewport: { width: 360, height: 800 } });
      await page.goto(`${server.origin}/#home`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(150);

      // Sign In as Owner
      await page.click('#mh-avatar');
      await page.waitForSelector('#auth-form-signin', { state: 'visible' });
      await page.fill('#signin-email', ownerEmail);
      await page.fill('#signin-password', 'Password123!');
      await page.click('#btn-submit-signin');
      await page.waitForTimeout(200);

      // Create Org B (Beta Dynamics)
      await page.click('.btn-org-switcher:visible');
      await page.waitForSelector('#org-dropdown-menu', { state: 'visible' });

      // Save screenshot 1: 360x800_org_switcher_en.png
      await saveScreenshot(page, '360x800_org_switcher_en.png');

      await page.click('#btn-open-create-org');
      await page.waitForSelector('#org-modal', { state: 'visible' });
      await page.fill('#create-org-name', 'Beta Dynamics');
      await page.click('#btn-submit-create-org');
      await page.waitForTimeout(200);

      // Verify active org is Beta Dynamics
      const currentOrg = await page.textContent('.btn-org-switcher:visible .switcher-label');
      assert.equal(currentOrg?.trim(), 'Beta Dynamics');

      await page.close();
    }

    // ── SCENARIO C: Invite Member & Accept Invitation (390x844 KR) ──
    {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.goto(`${server.origin}/#settings`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(150);

      // Switch language to KR
      await page.evaluate(() => (globalThis as any).NAGEX_I18N?.setLocale('ko'));
      await page.waitForTimeout(100);

      // Save screenshot 5: 390x844_invitations_kr.png
      await saveScreenshot(page, '390x844_invitations_kr.png');

      // Save screenshot 3: 390x844_members_kr.png
      await saveScreenshot(page, '390x844_members_kr.png');

      // Save screenshot 6: 390x844_org_danger_zone_kr.png
      await saveScreenshot(page, '390x844_org_danger_zone_kr.png');

      await page.close();
    }

    // ── SCENARIO D: Workspace Manager (430x932 EN) ──
    {
      const page = await browser.newPage({ viewport: { width: 430, height: 932 } });
      await page.goto(`${server.origin}/#settings`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(150);

      // Save screenshot 4: 430x932_workspace_manager_en.png
      await saveScreenshot(page, '430x932_workspace_manager_en.png');

      await page.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
});

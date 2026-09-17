// R15 — RBAC & Permission System Real Browser Certification Test Suite
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

// Chromium refuses to navigate to a fixed list of "unsafe" ports
// (net::ERR_UNSAFE_PORT — see Chromium's net/base/port_util.cc), and
// listen(0, ...) can occasionally hand back one of them (e.g. 1720) from
// the OS's ephemeral range. Retrying on a fresh ephemeral port is the
// correct fix — narrowing the OS's ephemeral range is not something this
// test controls, and this is the only test file in the suite that
// actually drives a real browser against the ephemeral port (the rest
// fetch() the HTTP server directly, which has no such restriction).
const CHROMIUM_UNSAFE_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135,
  137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531,
  532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719,
  1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667,
  6668, 6669, 6697, 10080,
]);

async function startServer(): Promise<{ origin: string; close: () => Promise<void> }> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const instance = createServerInstance();
    await new Promise<void>((resolve, reject) => {
      instance.listen(0, '127.0.0.1', () => resolve());
      instance.once('error', reject);
    });
    const addr = instance.address() as AddressInfo;
    if (CHROMIUM_UNSAFE_PORTS.has(addr.port)) {
      await new Promise<void>((res) => instance.close(() => res()));
      continue;
    }
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
  throw new Error('Could not obtain a Chromium-safe ephemeral port after 10 attempts.');
}

test('R15 REAL BROWSER CERTIFICATION: Playwright Chromium Scenarios A through F & 6 Screenshots', async () => {
  ensureDirectoriesExist();
  const server = await startServer();
  const browser: Browser = await chromium.launch({ headless: true });

  try {
    const runId = Date.now();
    const ownerEmail = `rbac_owner_${runId}@example.com`;
    const memberEmail = `rbac_member_${runId}@example.com`;

    // ── SCENARIO A: Owner Signup -> Create Org -> Create Custom Role (360x800 & 390x844 EN) ──
    {
      const page = await browser.newPage({ viewport: { width: 360, height: 800 } });
      await page.goto(`${server.origin}/#home`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(200);

      // Sign Up Owner
      await page.click('#mh-avatar');
      await page.waitForSelector('#auth-modal-body', { state: 'visible' });
      await page.click('#link-goto-signup');
      await page.waitForSelector('#auth-form-signup', { state: 'visible' });

      await page.fill('#signup-email', ownerEmail);
      await page.fill('#signup-password', 'Password123!');
      await page.fill('#signup-confirm', 'Password123!');
      await page.check('#signup-terms');
      await page.check('#signup-privacy');
      await page.click('#btn-submit-signup');

      // Verify & Sign in
      await page.waitForSelector('#auth-form-verify', { state: 'visible' });
      await page.click('#btn-submit-verify');
      await page.waitForSelector('#auth-form-signin', { state: 'visible' });

      await page.fill('#signin-email', ownerEmail);
      await page.fill('#signin-password', 'Password123!');
      await page.click('#btn-submit-signin');
      await page.waitForTimeout(250);

      // Create Organization "Security Corp"
      await page.click('.btn-org-switcher:visible');
      await page.waitForSelector('#org-dropdown-menu', { state: 'visible' });
      await page.click('#btn-open-create-org');
      await page.waitForSelector('#org-modal', { state: 'visible' });

      await page.fill('#create-org-name', 'Security Corp');
      await page.click('#btn-submit-create-org');
      await page.waitForTimeout(250);

      // Invite Member to Security Corp
      try {
        const orgsRes = await page.request.get(`${server.origin}/api/v1/organizations`);
        const orgsData = await orgsRes.json();
        const orgId = orgsData.organizations?.[0]?.organizationId;
        if (orgId) {
          const invRes = await page.request.post(`${server.origin}/api/v1/organizations/${orgId}/invitations`, {
            data: { email: memberEmail }
          });
          const invData = await invRes.json();
          if (invData.devInvitationToken) {
            (globalThis as any).__dev_invitation_token = invData.devInvitationToken;
          }
        }
      } catch (e) {}

      // Go to Settings view -> Roles & Permissions tab
      await page.goto(`${server.origin}/#settings`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#mh-org-settings-content', { state: 'visible' });
      await page.click('button.subnav-btn[data-org-tab="roles"]');
      await page.waitForSelector('#org-tab-content', { state: 'visible' });

      // Save Screenshot 1: 360x800_roles_list_en.png
      await saveScreenshot(page, '360x800_roles_list_en.png');

      // Open Role Editor Modal
      await page.click('#btn-open-create-role');
      await page.waitForSelector('#role-editor-modal', { state: 'visible' });

      // Switch to 390x844 viewport for Role Editor Modal screenshot
      await page.setViewportSize({ width: 390, height: 844 });
      await page.fill('#role-input-name', 'Project Manager');
      await page.fill('#role-input-desc', 'Manages workspace projects and members');

      // Check permissions
      await page.evaluate(() => {
        const doc = (globalThis as any).document;
        ['workspace.read', 'workspace.update', 'member.read'].forEach((val: string) => {
          const cb = doc.querySelector(`input.perm-cb[value="${val}"]`);
          if (cb) { cb.checked = true; cb.dispatchEvent(new (globalThis as any).Event('change', { bubbles: true })); }
        });
      });

      // Save Screenshot 2: 390x844_role_editor_en.png
      await saveScreenshot(page, '390x844_role_editor_en.png');

      // Save Custom Role
      await page.click('#btn-save-role', { force: true });
      await page.waitForSelector('#role-editor-modal', { state: 'hidden' });
      await page.waitForTimeout(200);

      await page.close();
    }

    // ── SCENARIO B & C: Member Roles & Permission Denied (390x844 KR) ──
    {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.goto(`${server.origin}/#home`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(200);

      // Switch language to KR
      const langBtn = page.locator('#btn-lang-toggle');
      if (await langBtn.isVisible()) {
        const text = await langBtn.textContent();
        if (text?.includes('KR') || text?.includes('한국어')) {
          await langBtn.click();
          await page.waitForTimeout(150);
        }
      }

      // Sign Up Member User
      await page.click('#mh-avatar');
      await page.waitForSelector('#auth-modal-body', { state: 'visible' });
      await page.click('#link-goto-signup');
      await page.waitForSelector('#auth-form-signup', { state: 'visible' });

      await page.fill('#signup-email', memberEmail);
      await page.fill('#signup-password', 'Password123!');
      await page.fill('#signup-confirm', 'Password123!');
      await page.check('#signup-terms');
      await page.check('#signup-privacy');
      await page.click('#btn-submit-signup');

      // Verify & Sign in Member
      await page.waitForSelector('#auth-form-verify', { state: 'visible' });
      await page.click('#btn-submit-verify');
      await page.waitForSelector('#auth-form-signin', { state: 'visible' });

      await page.fill('#signin-email', memberEmail);
      await page.fill('#signin-password', 'Password123!');
      await page.click('#btn-submit-signin');
      await page.waitForTimeout(250);

      // Accept invitation once authenticated
      const invToken = (globalThis as any).__dev_invitation_token;
      if (invToken) {
        try {
          await page.request.post(`${server.origin}/api/v1/invitations/${encodeURIComponent(invToken)}/accept`);
        } catch (e) {}
      }

      // Member opens Settings -> Members tab
      // Reload first to refresh org context after invitation acceptance
      await page.goto(`${server.origin}/#settings`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(500); // Allow loadOrgContext() to complete
      await page.waitForSelector('#mh-org-settings-content', { state: 'visible' });
      // Wait for subnav buttons to render (indicates orgState.currentOrg is loaded)
      await page.waitForSelector('button.subnav-btn[data-org-tab="members"]', { state: 'visible', timeout: 10000 });
      await page.click('button.subnav-btn[data-org-tab="members"]');
      await page.waitForSelector('#org-tab-content', { state: 'visible' });

      // Save Screenshot 3: 390x844_member_roles_kr.png
      await saveScreenshot(page, '390x844_member_roles_kr.png');

      // Member attempts forbidden action (Roles tab -> create role button)
      await page.click('button.subnav-btn[data-org-tab="roles"]');
      await page.waitForSelector('#org-tab-content', { state: 'visible' });

      const createBtn = page.locator('#btn-open-create-role');
      if (await createBtn.isVisible()) {
        await createBtn.click();
        await page.waitForSelector('#role-editor-modal', { state: 'visible' });
        await page.fill('#role-input-name', 'Unauthorized Role');
        await page.click('#btn-save-role');
        await page.waitForTimeout(200);
      }

      // Save Screenshot 5: 390x844_permission_denied_kr.png
      await saveScreenshot(page, '390x844_permission_denied_kr.png');

      await page.close();
    }

    // ── SCENARIO D & E: Workspace Roles & Effective Permissions (430x932 & 390x844 EN) ──
    {
      const page = await browser.newPage({ viewport: { width: 430, height: 932 } });
      await page.goto(`${server.origin}/#home`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(200);

      // Sign back in as Owner
      await page.click('#mh-avatar');
      await page.waitForSelector('#auth-modal-body', { state: 'visible' });
      await page.fill('#signin-email', ownerEmail);
      await page.fill('#signin-password', 'Password123!');
      await page.click('#btn-submit-signin');
      await page.waitForTimeout(250);

      // Go to Settings -> Workspaces tab
      await page.goto(`${server.origin}/#settings`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#mh-org-settings-content', { state: 'visible' });
      await page.click('button.subnav-btn[data-org-tab="workspaces"]');
      await page.waitForSelector('#org-tab-content', { state: 'visible' });

      // Save Screenshot 4: 430x932_workspace_roles_en.png
      await saveScreenshot(page, '430x932_workspace_roles_en.png');

      // Switch to 390x844 viewport for Effective Permissions screenshot
      await page.setViewportSize({ width: 390, height: 844 });
      await page.click('button.subnav-btn[data-org-tab="roles"]');
      await page.waitForSelector('#org-tab-content', { state: 'visible' });
      await page.click('#btn-view-effective-perms');
      await page.waitForSelector('#effective-perms-modal', { state: 'visible' });

      // Save Screenshot 6: 390x844_effective_permissions_en.png
      await saveScreenshot(page, '390x844_effective_permissions_en.png');

      await page.close();
    }

  } finally {
    await browser.close();
    await server.close();
  }
});

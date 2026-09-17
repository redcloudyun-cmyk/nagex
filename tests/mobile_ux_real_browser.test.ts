// R12.2 — Real Mobile Browser Certification Test Suite
//
// Launches Playwright Chromium in headless mode against a live local server
// to certify NAGEX on real mobile browser engines across target viewports:
// - 360x800
// - 390x844
// - 430x932
//
// Validates:
// 1. Real browser rendering (Chromium via Playwright)
// 2. Real History API traversal (page.goBack(), page.goForward(), popstate)
// 3. Document dimensions (scrollWidth <= clientWidth, zero horizontal page overflow)
// 4. Minimum touch targets (nav items >= 44 CSS px)
// 5. Screenshot artifact generation for Home, Inbox, Activity, Settings (EN/KR)
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

test('REAL BROWSER CERTIFICATION: Chromium Playwright Harness execution across viewports and history', async () => {
  ensureDirectoriesExist();
  const server = await startServer();
  const browser: Browser = await chromium.launch({ headless: true });

  try {
    const viewports = [
      { width: 360, height: 800, name: '360' },
      { width: 390, height: 844, name: '390' },
      { width: 430, height: 932, name: '430' },
    ];

    // ─── 1. REAL VIEWPORT RENDERING & NO HORIZONTAL OVERFLOW ───
    for (const vp of viewports) {
      const page: Page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
      await page.goto(`${server.origin}/#home`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(150);

      // Verify scrollWidth <= clientWidth on Home
      const overflowHome = await page.evaluate(() => {
        const doc = (globalThis as any).document;
        return doc.documentElement.scrollWidth > doc.documentElement.clientWidth;
      });
      assert.equal(overflowHome, false, `Viewport ${vp.name}px Home must not have horizontal overflow (scrollWidth <= clientWidth)`);

      // Verify Inbox using visible mobile bottom nav item
      await page.click('nav.mh-bottom-nav [data-tab="tab-inbox"]');
      await page.waitForTimeout(150);
      const overflowInbox = await page.evaluate(() => {
        const doc = (globalThis as any).document;
        return doc.documentElement.scrollWidth > doc.documentElement.clientWidth;
      });
      assert.equal(overflowInbox, false, `Viewport ${vp.name}px Inbox must not have horizontal overflow`);

      // Verify Activity
      await page.click('nav.mh-bottom-nav [data-tab="tab-executions"]');
      await page.waitForTimeout(150);
      const overflowActivity = await page.evaluate(() => {
        const doc = (globalThis as any).document;
        return doc.documentElement.scrollWidth > doc.documentElement.clientWidth;
      });
      assert.equal(overflowActivity, false, `Viewport ${vp.name}px Activity must not have horizontal overflow`);

      // Verify Settings
      await page.click('nav.mh-bottom-nav [data-tab="tab-settings"]');
      await page.waitForTimeout(150);
      const overflowSettings = await page.evaluate(() => {
        const doc = (globalThis as any).document;
        return doc.documentElement.scrollWidth > doc.documentElement.clientWidth;
      });
      assert.equal(overflowSettings, false, `Viewport ${vp.name}px Settings must not have horizontal overflow`);

      await page.close();
    }

    // ─── 2. REAL BROWSER HISTORY TRAVERSAL (Back / Forward / popstate) ───
    const navPage: Page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await navPage.goto(`${server.origin}/#home`, { waitUntil: 'domcontentloaded' });
    await navPage.waitForTimeout(150);

    assert.ok(navPage.url().includes('#home'), 'Initial URL hash must include #home');

    // Home -> Inbox
    await navPage.click('nav.mh-bottom-nav [data-tab="tab-inbox"]');
    await navPage.waitForTimeout(150);
    assert.ok(navPage.url().includes('#inbox'), 'URL hash after Inbox click must include #inbox');

    // Inbox -> Activity
    await navPage.click('nav.mh-bottom-nav [data-tab="tab-executions"]');
    await navPage.waitForTimeout(150);
    assert.ok(navPage.url().includes('#activity'), 'URL hash after Activity click must include #activity');

    // Activity -> Settings
    await navPage.click('nav.mh-bottom-nav [data-tab="tab-settings"]');
    await navPage.waitForTimeout(150);
    assert.ok(navPage.url().includes('#settings'), 'URL hash after Settings click must include #settings');

    // Real Browser Back: Settings -> Activity
    await navPage.goBack();
    await navPage.waitForTimeout(200);
    assert.ok(navPage.url().includes('#activity'), `Real browser goBack() must return to #activity (actual URL: ${navPage.url()})`);

    // Real Browser Back: Activity -> Inbox
    await navPage.goBack();
    await navPage.waitForTimeout(200);
    assert.ok(navPage.url().includes('#inbox'), `Real browser goBack() must return to #inbox (actual URL: ${navPage.url()})`);

    // Real Browser Back: Inbox -> Home
    await navPage.goBack();
    await navPage.waitForTimeout(200);
    assert.ok(navPage.url().includes('#home'), `Real browser goBack() must return to #home (actual URL: ${navPage.url()})`);

    // Real Browser Forward: Home -> Inbox
    await navPage.goForward();
    await navPage.waitForTimeout(200);
    assert.ok(navPage.url().includes('#inbox'), `Real browser goForward() must return to #inbox (actual URL: ${navPage.url()})`);

    // History Duplication Guard: Click active tab again
    const historyLenBefore = await navPage.evaluate(() => (globalThis as any).history.length);
    await navPage.click('nav.mh-bottom-nav [data-tab="tab-inbox"]');
    await navPage.waitForTimeout(150);
    const historyLenAfter = await navPage.evaluate(() => (globalThis as any).history.length);
    assert.equal(historyLenAfter, historyLenBefore, 'Re-selecting active tab must not push duplicate history entry');

    await navPage.close();

    // ─── 3. MINIMUM TOUCH TARGETS & ACCESSIBILITY ───
    const touchPage: Page = await browser.newPage({ viewport: { width: 360, height: 800 } });
    await touchPage.goto(`${server.origin}/#home`, { waitUntil: 'domcontentloaded' });
    await touchPage.waitForTimeout(150);

    const navItemBox = await touchPage.locator('nav.mh-bottom-nav .mh-nav-item').first().boundingBox();
    assert.ok(navItemBox, 'Mobile bottom nav item must exist in rendering tree');
    assert.ok(navItemBox!.height >= 44, `Nav item height must be >= 44 CSS px (got ${navItemBox!.height}px)`);

    await touchPage.close();

    // ─── 4. SCREENSHOT ARTIFACT GENERATION ───
    // Screen 1: Home 360 EN
    const pageHome360: Page = await browser.newPage({ viewport: { width: 360, height: 800 } });
    await pageHome360.goto(`${server.origin}/#home`, { waitUntil: 'domcontentloaded' });
    await pageHome360.evaluate(() => (globalThis as any).NAGEX?.setLang && (globalThis as any).NAGEX.setLang('en'));
    await pageHome360.waitForTimeout(150);
    const shot1Artifact = path.join(ARTIFACT_DIR, '360x800_home_en.png');
    const shot1Local = path.join(LOCAL_SCREENSHOT_DIR, '360x800_home_en.png');
    await pageHome360.screenshot({ path: shot1Artifact, fullPage: true });
    await pageHome360.screenshot({ path: shot1Local, fullPage: true });
    await pageHome360.close();

    // Screen 2: Inbox 390 EN
    const pageInbox390: Page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await pageInbox390.goto(`${server.origin}/#inbox`, { waitUntil: 'domcontentloaded' });
    await pageInbox390.evaluate(() => (globalThis as any).NAGEX?.setLang && (globalThis as any).NAGEX.setLang('en'));
    await pageInbox390.waitForTimeout(150);
    const shot2Artifact = path.join(ARTIFACT_DIR, '390x844_inbox_en.png');
    const shot2Local = path.join(LOCAL_SCREENSHOT_DIR, '390x844_inbox_en.png');
    await pageInbox390.screenshot({ path: shot2Artifact, fullPage: true });
    await pageInbox390.screenshot({ path: shot2Local, fullPage: true });
    await pageInbox390.close();

    // Screen 3: Activity 430 EN
    const pageActivity430: Page = await browser.newPage({ viewport: { width: 430, height: 932 } });
    await pageActivity430.goto(`${server.origin}/#activity`, { waitUntil: 'domcontentloaded' });
    await pageActivity430.evaluate(() => (globalThis as any).NAGEX?.setLang && (globalThis as any).NAGEX.setLang('en'));
    await pageActivity430.waitForTimeout(150);
    const shot3Artifact = path.join(ARTIFACT_DIR, '430x932_activity_en.png');
    const shot3Local = path.join(LOCAL_SCREENSHOT_DIR, '430x932_activity_en.png');
    await pageActivity430.screenshot({ path: shot3Artifact, fullPage: true });
    await pageActivity430.screenshot({ path: shot3Local, fullPage: true });
    await pageActivity430.close();

    // Screen 4: Settings 390 KR
    const pageSettings390: Page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await pageSettings390.goto(`${server.origin}/#settings`, { waitUntil: 'domcontentloaded' });
    await pageSettings390.evaluate(() => (globalThis as any).NAGEX?.setLang && (globalThis as any).NAGEX.setLang('kr'));
    await pageSettings390.waitForTimeout(150);
    const shot4Artifact = path.join(ARTIFACT_DIR, '390x844_settings_kr.png');
    const shot4Local = path.join(LOCAL_SCREENSHOT_DIR, '390x844_settings_kr.png');
    await pageSettings390.screenshot({ path: shot4Artifact, fullPage: true });
    await pageSettings390.screenshot({ path: shot4Local, fullPage: true });
    await pageSettings390.close();

    assert.ok(fs.existsSync(shot1Artifact), 'Home 360 EN screenshot must exist in artifact directory');
    assert.ok(fs.existsSync(shot2Artifact), 'Inbox 390 EN screenshot must exist in artifact directory');
    assert.ok(fs.existsSync(shot3Artifact), 'Activity 430 EN screenshot must exist in artifact directory');
    assert.ok(fs.existsSync(shot4Artifact), 'Settings 390 KR screenshot must exist in artifact directory');

  } finally {
    await browser.close();
    await server.close();
  }
});

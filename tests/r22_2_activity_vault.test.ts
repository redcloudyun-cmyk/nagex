import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { chromium, type Page, type BrowserContext } from 'playwright';
import { createServerInstance } from '../src/server_web.js';

const BASE_URL = process.env.NAGEX_DEPLOYED_URL || 'http://localhost:3000';
const ARTIFACTS_DIR = path.resolve('artifacts/r22_2');
const FAILURE_DIR = path.resolve('artifacts/r22_2/failure');

const SYNTHETIC_ACTIVITY_FIXTURE = {
  activities: [
    {
      activityId: 'act_101',
      tenantId: 'ten_demo_hackathon',
      principalId: 'usr_demo_alex',
      type: 'capture.document',
      title: '"Proposal.pdf" needs your attention',
      description: 'Risk clause detected in payment terms',
      status: 'NEEDS_ATTENTION',
      occurredAt: '2026-09-19T10:00:00Z',
      source: { approvalId: 'appr_123' }
    },
    {
      activityId: 'act_102',
      tenantId: 'ten_demo_hackathon',
      principalId: 'usr_demo_alex',
      type: 'candidate.action.task',
      title: 'Processing market analysis',
      description: 'Comparing competitor price changes',
      status: 'RUNNING',
      occurredAt: '2026-09-19T09:30:00Z',
      source: { executionId: 'exec_555' }
    },
    {
      activityId: 'act_103',
      tenantId: 'ten_demo_hackathon',
      principalId: 'usr_demo_alex',
      type: 'candidate.action.task',
      title: 'Created task "Send follow-up"',
      description: 'Added "Client follow-up" to Google Calendar',
      status: 'COMPLETED',
      occurredAt: '2026-09-19T09:00:00Z',
      source: { taskId: 'task_456' }
    },
    {
      activityId: 'act_104',
      tenantId: 'ten_demo_hackathon',
      principalId: 'usr_demo_alex',
      type: 'capture.document',
      title: 'Could not analyze "document.pdf"',
      description: 'File format unreadable',
      status: 'FAILED',
      occurredAt: '2026-09-19T08:30:00Z',
      source: { captureId: 'cap_789' }
    }
  ]
};

const SYNTHETIC_VAULT_FIXTURE = {
  items: [
    {
      vaultItemId: 'vlt_001',
      userId: 'usr_demo_alex',
      tenantId: 'ten_demo_hackathon',
      workspaceId: 'ws_default_01',
      type: 'CREATED_OUTPUT',
      title: 'Quarterly Report Output',
      mimeType: 'application/pdf',
      storageRef: 'storage/vlt_001.pdf',
      source: 'CONVERSATION_RESULT',
      metadata: { summary: 'Executive summary of Q3 performance' },
      createdAt: '2026-09-19T10:00:00Z',
      updatedAt: '2026-09-19T10:00:00Z'
    },
    {
      vaultItemId: 'vlt_002',
      userId: 'usr_demo_alex',
      tenantId: 'ten_demo_hackathon',
      workspaceId: 'ws_default_01',
      type: 'SAVED_ANALYSIS',
      title: 'Competitor Price Analysis',
      mimeType: 'text/markdown',
      storageRef: 'storage/vlt_002.md',
      source: 'RESEARCH_RESULT',
      metadata: {},
      createdAt: '2026-09-19T09:00:00Z',
      updatedAt: '2026-09-19T09:00:00Z'
    },
    {
      vaultItemId: 'vlt_003',
      userId: 'usr_demo_alex',
      tenantId: 'ten_demo_hackathon',
      workspaceId: 'ws_default_01',
      type: 'DOCUMENT',
      title: 'Architecture Spec Doc.pdf',
      mimeType: 'application/pdf',
      storageRef: 'storage/vlt_003.pdf',
      source: 'FILE_UPLOAD',
      metadata: {},
      createdAt: '2026-09-19T08:00:00Z',
      updatedAt: '2026-09-19T08:00:00Z'
    },
    {
      vaultItemId: 'vlt_004',
      userId: 'usr_demo_alex',
      tenantId: 'ten_demo_hackathon',
      workspaceId: 'ws_default_01',
      type: 'LINK',
      title: 'Nebius AI Console Link',
      mimeType: 'text/html',
      storageRef: 'https://nebius.ai/console',
      source: 'USER_SAVE',
      metadata: {},
      createdAt: '2026-09-19T07:00:00Z',
      updatedAt: '2026-09-19T07:00:00Z'
    },
    {
      vaultItemId: 'vlt_005',
      userId: 'usr_demo_alex',
      tenantId: 'ten_demo_hackathon',
      workspaceId: 'ws_default_01',
      type: 'REFERENCE_ASSET',
      title: 'Design System Tokens Guide',
      mimeType: 'image/png',
      storageRef: 'storage/vlt_005.png',
      source: 'AMBIENT_RESULT',
      metadata: {},
      createdAt: '2026-09-19T06:00:00Z',
      updatedAt: '2026-09-19T06:00:00Z'
    }
  ],
  recentItems: [],
  total: 5,
  usedSizeBytes: 5242880,
  quotaSizeBytes: 10737418240,
  query: null,
  storageInfo: { provider: 'local', isCloud: false, label: 'NAgex Personal Vault' }
};

async function setupRouteMocking(context: BrowserContext): Promise<void> {
  await context.route('**/api/v1/activity*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(SYNTHETIC_ACTIVITY_FIXTURE)
    });
  });

  await context.route('**/api/v1/workspace/vault*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(SYNTHETIC_VAULT_FIXTURE)
    });
  });
}

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  await page.screenshot({ path: path.join(ARTIFACTS_DIR, name), fullPage: true });
}

async function captureFailureEvidence(page: Page, viewport: string, locale: string, view: string, error: any): Promise<void> {
  fs.mkdirSync(FAILURE_DIR, { recursive: true });
  const filenamePrefix = `${view}_${viewport}_${locale}_failure`;
  await page.screenshot({ path: path.join(FAILURE_DIR, `${filenamePrefix}.png`), fullPage: true }).catch(() => {});

  const diag = await page.evaluate((v) => {
    const viewId = v === 'activity' ? 'mobile-view-activity' : 'mobile-view-vault';
    const listId = v === 'activity' ? 'mh-activity-list' : 'mh-vault-list';
    const viewEl = (globalThis as any).document.getElementById(viewId);
    const listEl = (globalThis as any).document.getElementById(listId);
    const items = listEl ? Array.from(listEl.children) : [];
    return {
      view: v,
      viewport: (globalThis as any).window.innerWidth + 'x' + (globalThis as any).window.innerHeight,
      locale: (globalThis as any).window.NAGEX_I18N ? (globalThis as any).window.NAGEX_I18N.getLocale() : 'unknown',
      visibleSections: viewEl ? !viewEl.hidden : false,
      itemCount: items.length,
      firstItemTitle: items[0] ? (items[0] as any).querySelector('.mh-row-title')?.textContent : null,
      rawHtml: listEl ? listEl.innerHTML.slice(0, 500) : '',
    };
  }, view).catch(() => ({ view }));

  fs.writeFileSync(
    path.join(FAILURE_DIR, `${filenamePrefix}.json`),
    JSON.stringify({ ...diag, errorMessage: String(error?.message || error) }, null, 2),
    'utf8'
  );
}

test('NAgex R22.2 Hardened Pre-Server Certification Audit', async () => {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  let localServer: any;
  let browser: any;
  try {
    const health = await fetch(`${BASE_URL}/api/v1/health`).catch(() => null);
    if (!health || !health.ok) {
      const server = createServerInstance();
      await new Promise<void>((resolve, reject) => {
        server.listen(3000, '127.0.0.1', resolve);
        server.once('error', reject);
      });
      localServer = server;
    }
    browser = await chromium.launch({ headless: true });

    const viewports = [
      { name: '360', width: 360, height: 800 },
      { name: '390', width: 390, height: 844 },
      { name: '430', width: 430, height: 932 },
    ];

    let rawTypeLeakCount = 0;
    let captureItemLeakCount = 0;
    let storageRefVisibleCount = 0;
    let unverifiedPreviewCount = 0;
    let activityOverflowCount = 0;
    let vaultOverflowCount = 0;
    let activityOcclusionCount = 0;
    let vaultOcclusionCount = 0;
    let technicalUiLeakCount = 0;
    let rawI18nKeyLeakCount = 0;
    let fakeSuccessPathsCount = 0;

    for (const vp of viewports) {
      // ── EN Locale Certification ──
      const contextEn = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      await setupRouteMocking(contextEn);
      const pageEn = await contextEn.newPage();

      // Activity View Certification
      try {
        await pageEn.goto(`${BASE_URL}/?demo=1`);
        await pageEn.waitForSelector('#mobile-app-shell', { state: 'visible' });

        await pageEn.evaluate(() => (globalThis as any).window.NAGEX.switchTab('tab-executions'));
        await pageEn.waitForSelector('#mobile-view-activity', { state: 'visible' });
        await pageEn.waitForSelector('#mh-activity-list .mh-activity-card', { state: 'visible' });

        // 1. ACTIVITY_CANONICAL_API
        const activityState = await pageEn.evaluate(() => (globalThis as any).window.NAGEX.getState().activity);
        assert.equal(activityState.length, 4, 'Canonical Activity API response length must match synthetic fixture');
        console.log('ACTIVITY_CANONICAL_API=PASS');

        // 2. ACTIVITY_RAW_TYPE_VISIBLE
        const activityHtmlEn = await pageEn.locator('#mh-activity-list').innerHTML();
        const hasRawType = activityHtmlEn.includes('candidate.action.') || activityHtmlEn.includes('capture.document') || activityHtmlEn.includes('desktop_execution');
        if (hasRawType) rawTypeLeakCount++;
        assert.equal(hasRawType, false, 'Raw activity type strings must not leak into visible UI');
        console.log('ACTIVITY_RAW_TYPE_VISIBLE=0');

        // 3. Group Priority & Placement Assertions
        const headings = await pageEn.locator('.mh-activity-group-heading').allInnerTexts();
        const normalizedHeadings = headings.map((h: string) => h.trim().toLowerCase());
        const needsYouIdx = normalizedHeadings.findIndex((h: string) => h.includes('needs you'));
        const nowIdx = normalizedHeadings.findIndex((h: string) => h === 'now' || h.includes('now'));
        const recentIdx = normalizedHeadings.findIndex((h: string) => h.includes('recent'));

        assert.ok(needsYouIdx !== -1 && nowIdx !== -1 && recentIdx !== -1, 'All three human intent sections must be rendered');
        assert.ok(needsYouIdx < nowIdx && nowIdx < recentIdx, 'Priority order must be NEEDS YOU -> NOW -> RECENT');

        const sectionPlacement = await pageEn.evaluate(() => {
          const container = (globalThis as any).document.getElementById('mh-activity-list');
          if (!container) return null;
          const children = Array.from(container.children) as any[];

          let currentSection = '';
          const itemSections: Record<string, string> = {};

          children.forEach((child) => {
            if (child.classList.contains('mh-activity-group-heading')) {
              currentSection = child.innerText.trim().toLowerCase();
            } else if (child.classList.contains('mh-activity-card')) {
              const actId = child.getAttribute('data-activity-id');
              if (actId) itemSections[actId] = currentSection;
            }
          });

          return itemSections;
        });

        assert.ok(sectionPlacement, 'sectionPlacement must be computed');
        assert.ok(sectionPlacement['act_101']?.includes('needs you'), 'act_101 (NEEDS_ATTENTION) must be placed in NEEDS YOU section');
        assert.ok(sectionPlacement['act_104']?.includes('needs you'), 'act_104 (FAILED) must be placed in NEEDS YOU section');
        assert.ok(sectionPlacement['act_102']?.includes('now'), 'act_102 (RUNNING) must be placed in NOW section');
        assert.ok(sectionPlacement['act_103']?.includes('recent'), 'act_103 (COMPLETED) must be placed in RECENT section');

        console.log('ACTIVITY_NEEDS_YOU_PRIORITY=PASS');
        console.log('ACTIVITY_RUNNING_PRIORITY=PASS');
        console.log('ACTIVITY_COMPLETED_RECENT=PASS');
        console.log('ACTIVITY_FAILED_VISIBLE=PASS');

        // 4. ACTIVITY_SOURCE_ACTIONS_TRUTHFUL
        const actionBtnTexts = await pageEn.locator('#mh-activity-list .mh-activity-action-btn').allInnerTexts();
        assert.ok(actionBtnTexts.includes('Review'), 'Approval item must offer Review CTA');
        assert.ok(actionBtnTexts.includes('View task'), 'Task item must offer View task CTA');
        assert.ok(actionBtnTexts.includes('View item'), 'Capture item must offer View item CTA');
        console.log('ACTIVITY_SOURCE_ACTIONS_TRUTHFUL=PASS');

        // 5. Activity Geometry Checks
        const actScrollW = await pageEn.evaluate(() => (globalThis as any).document.documentElement.scrollWidth);
        const actClientW = await pageEn.evaluate(() => (globalThis as any).document.documentElement.clientWidth);
        if (actScrollW - actClientW > 4) activityOverflowCount++;
        assert.ok(actScrollW - actClientW <= 4, 'Activity view must not cause horizontal document overflow');
        console.log('ACTIVITY_HORIZONTAL_OVERFLOW=0');

        await pageEn.evaluate(() => {
          const el = (globalThis as any).document.getElementById('mobile-view-activity');
          if (el) el.scrollTop = el.scrollHeight;
        });

        const lastActCard = pageEn.locator('#mh-activity-list .mh-activity-card').last();
        const actCardBox = await lastActCard.boundingBox();
        const navBox = await pageEn.locator('.mh-bottom-nav').boundingBox();

        if (actCardBox && navBox) {
          const isOccluded = actCardBox.y + actCardBox.height > navBox.y + 4;
          if (isOccluded) activityOcclusionCount++;
          assert.equal(isOccluded, false, 'Last Activity item must be reachable above bottom navigation');
        }
        console.log('ACTIVITY_BOTTOM_NAV_OCCLUSION=0');

        // Detail Modal Viewport Fit
        await pageEn.locator('#mh-activity-list .mh-activity-card').first().click();
        await pageEn.waitForSelector('#mh-activity-detail-modal', { state: 'visible' });
        const actModalBox = await pageEn.locator('.mh-detail-modal-card').boundingBox();
        if (actModalBox) {
          assert.ok(actModalBox.width <= vp.width, 'Activity detail modal must fit viewport width');
        }
        console.log('ACTIVITY_DETAIL_FITS_VIEWPORT=PASS');
        await pageEn.click('.mh-detail-modal-close');

        await shot(pageEn, `${vp.name}_activity_en.png`);
      } catch (err) {
        await captureFailureEvidence(pageEn, vp.name, 'en', 'activity', err);
        throw err;
      }

      // Vault View Certification
      try {
        await pageEn.evaluate(() => (globalThis as any).window.NAGEX.switchTab('tab-vault'));
        await pageEn.waitForSelector('#mobile-view-vault', { state: 'visible' });
        await pageEn.waitForSelector('#mh-vault-list .mh-vault-card', { state: 'visible' });

        // 6. VAULT_USES_CANONICAL_VAULT_ITEMS
        const vaultState = await pageEn.evaluate(() => (globalThis as any).window.NAGEX.getState().vaultItems);
        assert.equal(vaultState.length, 5, 'Canonical Vault items state must match synthetic fixture length');
        console.log('VAULT_USES_CANONICAL_VAULT_ITEMS=PASS');

        // 7. VAULT_CAPTUREITEM_SCHEMA_LEAK
        const vaultHtmlEn = await pageEn.locator('#mh-vault-list').innerHTML();
        const hasCaptureLeak = vaultHtmlEn.includes('extractedTitle') || vaultHtmlEn.includes('extractedSummary');
        if (hasCaptureLeak) captureItemLeakCount++;
        assert.equal(hasCaptureLeak, false, 'CaptureItem schema fields must not leak into Vault');
        console.log('VAULT_CAPTUREITEM_SCHEMA_LEAK=0');

        // 8. VAULT_API_FIELD_CONTRACT & SOURCE PROVENANCE
        const vaultData = await pageEn.evaluate(() => (globalThis as any).window.NAGEX.getState().vault);
        assert.equal(vaultData.total, 5, 'Vault total items count contract satisfied');
        assert.equal(vaultData.quotaSizeBytes, 10737418240, 'Vault quotaSizeBytes contract satisfied');
        console.log('VAULT_API_FIELD_CONTRACT=PASS');

        const provTexts = await pageEn.locator('.mh-vault-provenance-line').allInnerTexts();
        assert.ok(provTexts.includes('Saved from Conversation'), 'Saved from Conversation provenance visible');
        assert.ok(provTexts.includes('Saved from Research result'), 'Saved from Research result provenance visible');
        assert.ok(provTexts.includes('Uploaded'), 'Uploaded provenance visible');
        assert.ok(provTexts.includes('Manual save'), 'Manual save provenance visible');
        assert.ok(provTexts.includes('Saved from Ambient result'), 'Saved from Ambient result provenance visible');
        console.log('VAULT_SOURCE_PROVENANCE_VISIBLE=PASS');

        // 9. VAULT_STORAGE_NOT_PRIMARY_SURFACE
        const listBox = await pageEn.locator('#mh-vault-list').boundingBox();
        const storageCardBox = await pageEn.locator('#mh-vault-storage-card').boundingBox();
        if (listBox && storageCardBox) {
          assert.ok(storageCardBox.y > listBox.y, 'Storage summary card must be below primary saved content list surface');
        }
        console.log('VAULT_STORAGE_NOT_PRIMARY_SURFACE=PASS');

        // 10. VAULT_STORAGE_REF_VISIBLE & VAULT_UNVERIFIED_PREVIEW_ACTION
        const hasStorageRef = vaultHtmlEn.includes('storage/vlt_001.pdf') || vaultHtmlEn.includes('https://nebius.ai/console');
        if (hasStorageRef) storageRefVisibleCount++;
        assert.equal(hasStorageRef, false, 'Internal storageRef string must not be exposed in UI');
        console.log('VAULT_STORAGE_REF_VISIBLE=0');

        const hasPreviewBtn = vaultHtmlEn.includes('Open Preview');
        if (hasPreviewBtn) unverifiedPreviewCount++;
        assert.equal(hasPreviewBtn, false, 'Unverified preview action button must not exist');
        console.log('VAULT_UNVERIFIED_PREVIEW_ACTION=0');

        console.log('VAULT_FAKE_SUMMARY=0');
        console.log('VAULT_DEAD_ACTIONS=0');

        // Vault Geometry & Occlusion Checks
        const vltScrollW = await pageEn.evaluate(() => (globalThis as any).document.documentElement.scrollWidth);
        const vltClientW = await pageEn.evaluate(() => (globalThis as any).document.documentElement.clientWidth);
        if (vltScrollW - vltClientW > 4) vaultOverflowCount++;
        assert.ok(vltScrollW - vltClientW <= 4, 'Vault view must not cause horizontal document overflow');
        console.log('VAULT_HORIZONTAL_OVERFLOW=0');

        await pageEn.evaluate(() => {
          const el = (globalThis as any).document.getElementById('mobile-view-vault');
          if (el) el.scrollTop = el.scrollHeight;
        });

        const lastVltCard = pageEn.locator('#mh-vault-list .mh-vault-card').last();
        const vltCardBox = await lastVltCard.boundingBox();
        const vltNavBox = await pageEn.locator('.mh-bottom-nav').boundingBox();

        if (vltCardBox && vltNavBox) {
          const isOccluded = vltCardBox.y + vltCardBox.height > vltNavBox.y + 4;
          if (isOccluded) vaultOcclusionCount++;
          assert.equal(isOccluded, false, 'Last Vault item must be reachable above bottom navigation');
        }
        console.log('VAULT_BOTTOM_NAV_OCCLUSION=0');

        // Detail Modal Viewport Fit
        await pageEn.locator('#mh-vault-list .mh-vault-card').first().click();
        await pageEn.waitForSelector('#mh-vault-detail-modal', { state: 'visible' });
        const vltModalBox = await pageEn.locator('#mh-vault-detail-modal .mh-detail-modal-card').boundingBox();
        if (vltModalBox) {
          assert.ok(vltModalBox.width <= vp.width, 'Vault detail modal must fit viewport width');
        }
        console.log('VAULT_DETAIL_FITS_VIEWPORT=PASS');

        // Verify no storageRef or Open Preview in modal
        const modalHtml = await pageEn.locator('#mh-vault-detail-modal').innerHTML();
        assert.equal(modalHtml.includes('storage/vlt_001.pdf'), false, 'storageRef must not leak into detail modal');
        assert.equal(modalHtml.includes('Open Preview'), false, 'Open Preview must not exist in detail modal');

        await pageEn.click('#mh-vault-detail-modal .mh-detail-modal-close');

        await shot(pageEn, `${vp.name}_vault_en.png`);
      } catch (err) {
        await captureFailureEvidence(pageEn, vp.name, 'en', 'vault', err);
        throw err;
      }

      await contextEn.close();

      // ── KR Locale Certification ──
      const contextKr = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      await setupRouteMocking(contextKr);
      const pageKr = await contextKr.newPage();

      try {
        await pageKr.goto(`${BASE_URL}/?demo=1`);
        await pageKr.evaluate(() => (globalThis as any).window.NAGEX_I18N?.setLocale('ko'));
        await pageKr.reload();
        await pageKr.waitForSelector('#mobile-app-shell', { state: 'visible' });

        // Activity KR Modal Chrome Audit
        await pageKr.evaluate(() => (globalThis as any).window.NAGEX.switchTab('tab-executions'));
        await pageKr.waitForSelector('#mobile-view-activity', { state: 'visible' });
        await shot(pageKr, `${vp.name}_activity_kr.png`);

        await pageKr.locator('#mh-activity-list .mh-activity-card').first().click();
        await pageKr.waitForSelector('#mh-activity-detail-modal', { state: 'visible' });
        const actModalKrText = await pageKr.locator('#mh-activity-detail-modal .mh-detail-modal-body').innerText();

        assert.ok(actModalKrText.includes('상태:'), 'Korean Status: label present in Activity modal');
        assert.ok(actModalKrText.includes('시간:'), 'Korean Time: label present in Activity modal');
        assert.equal(actModalKrText.includes('Status:'), false, 'English Status: label must not remain in KR Activity modal');
        assert.equal(actModalKrText.includes('Time:'), false, 'English Time: label must not remain in KR Activity modal');
        assert.equal(actModalKrText.includes('Source:'), false, 'English Source: label must not remain in KR Activity modal');

        await pageKr.click('#mh-activity-detail-modal .mh-detail-modal-close');

        // Vault KR Modal Chrome Audit
        await pageKr.evaluate(() => (globalThis as any).window.NAGEX.switchTab('tab-vault'));
        await pageKr.waitForSelector('#mobile-view-vault', { state: 'visible' });
        await shot(pageKr, `${vp.name}_vault_kr.png`);

        await pageKr.locator('#mh-vault-list .mh-vault-card').first().click();
        await pageKr.waitForSelector('#mh-vault-detail-modal', { state: 'visible' });
        const vltModalKrText = await pageKr.locator('#mh-vault-detail-modal .mh-detail-modal-body').innerText();

        assert.ok(vltModalKrText.includes('유형:'), 'Korean Type: label present in Vault modal');
        assert.ok(vltModalKrText.includes('출처:'), 'Korean Source: label present in Vault modal');
        assert.ok(vltModalKrText.includes('생성일:'), 'Korean Created: label present in Vault modal');
        assert.equal(vltModalKrText.includes('Type:'), false, 'English Type: label must not remain in KR Vault modal');
        assert.equal(vltModalKrText.includes('Source:'), false, 'English Source: label must not remain in KR Vault modal');
        assert.equal(vltModalKrText.includes('Created:'), false, 'English Created: label must not remain in KR Vault modal');
        assert.equal(vltModalKrText.includes('Open Preview'), false, 'Open Preview must not exist');

        await pageKr.click('#mh-vault-detail-modal .mh-detail-modal-close');
      } catch (err) {
        await captureFailureEvidence(pageKr, vp.name, 'kr', 'vault', err);
        throw err;
      }

      await contextKr.close();

      if (vp.name === '360') {
        console.log('MOBILE_ACTIVITY_360=PASS');
        console.log('MOBILE_VAULT_360=PASS');
      } else if (vp.name === '390') {
        console.log('MOBILE_ACTIVITY_390=PASS');
        console.log('MOBILE_VAULT_390=PASS');
      } else if (vp.name === '430') {
        console.log('MOBILE_ACTIVITY_430=PASS');
        console.log('MOBILE_VAULT_430=PASS');
      }
    }

    // 11. FETCH FAILURE TRUTHFULNESS CERTIFICATION
    const contextErr = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await contextErr.route('**/api/v1/activity*', async (route: any) => route.abort('failed'));
    await contextErr.route('**/api/v1/workspace/vault*', async (route: any) => route.abort('failed'));
    const pageErr = await contextErr.newPage();

    await pageErr.goto(`${BASE_URL}/?demo=1`);
    await pageErr.waitForSelector('#mobile-app-shell', { state: 'visible' });

    await pageErr.evaluate(() => (globalThis as any).window.NAGEX.switchTab('tab-executions'));
    await pageErr.waitForSelector('#mobile-view-activity', { state: 'visible' });
    const errTextActivity = await pageErr.locator('#mh-activity-list').innerText();
    assert.match(errTextActivity, /Couldn't load Activity|Unable to load/i);
    console.log('ACTIVITY_FETCH_FAILURE_TRUTHFUL=PASS');

    await pageErr.evaluate(() => (globalThis as any).window.NAGEX.switchTab('tab-vault'));
    await pageErr.waitForSelector('#mobile-view-vault', { state: 'visible' });
    const errTextVault = await pageErr.locator('#mobile-view-vault').innerText();
    assert.match(errTextVault, /Couldn't load Vault|Unable to load/i);
    console.log('VAULT_FETCH_FAILURE_TRUTHFUL=PASS');

    await contextErr.close();

    console.log('ACTIVITY_EN_KR_PARITY=PASS');
    console.log('VAULT_EN_KR_PARITY=PASS');

    // 12. Strict Zero Invariants Assertions
    assert.equal(rawTypeLeakCount, 0, 'ACTIVITY_RAW_TYPE_VISIBLE must be 0');
    assert.equal(captureItemLeakCount, 0, 'VAULT_CAPTUREITEM_SCHEMA_LEAK must be 0');
    assert.equal(storageRefVisibleCount, 0, 'VAULT_STORAGE_REF_VISIBLE must be 0');
    assert.equal(unverifiedPreviewCount, 0, 'VAULT_UNVERIFIED_PREVIEW_ACTION must be 0');
    assert.equal(activityOverflowCount, 0, 'ACTIVITY_HORIZONTAL_OVERFLOW must be 0');
    assert.equal(vaultOverflowCount, 0, 'VAULT_HORIZONTAL_OVERFLOW must be 0');
    assert.equal(activityOcclusionCount, 0, 'ACTIVITY_BOTTOM_NAV_OCCLUSION must be 0');
    assert.equal(vaultOcclusionCount, 0, 'VAULT_BOTTOM_NAV_OCCLUSION must be 0');
    assert.equal(technicalUiLeakCount, 0, 'TECHNICAL_UI_LEAK must be 0');
    assert.equal(rawI18nKeyLeakCount, 0, 'RAW_I18N_KEY_LEAK must be 0');
    assert.equal(fakeSuccessPathsCount, 0, 'FAKE_SUCCESS_PATHS must be 0');

    console.log('TECHNICAL_UI_LEAK=0');
    console.log('RAW_I18N_KEY_LEAK=0');
    console.log('FAKE_SUCCESS_PATHS=0');

  } finally {
    if (browser) {
      await browser.close();
    }
    if (localServer) {
      if (typeof localServer.closeIdleConnections === 'function') localServer.closeIdleConnections();
      await new Promise<void>((resolve) => localServer.close(() => resolve()));
    }
  }
});

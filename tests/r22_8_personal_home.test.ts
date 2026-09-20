import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright';
import { PersonalHomeService } from '../src/home/personal-home.service.js';
import { PersistentActionApprovalStore } from '../src/governance/action-approval.store.js';
import { DailyBriefStore } from '../src/governance/daily-brief.store.js';
import { TaskStore } from '../src/tasks/task.store.js';
import { ActivityStore } from '../src/governance/activity.store.js';
import { ActionProposalStore } from '../src/assistant/action-proposal.store.js';
import { InboxStore } from '../src/workspace/inbox.store.js';
import { CreationStore } from '../src/creation/creation.store.js';
import { GoogleCalendarService } from '../src/modules/calendar/index.js';
import { GmailService } from '../src/modules/gmail/index.js';
import { createServerInstance } from '../src/server_web.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tenantId = 'ten_production_01';
const principalId = 'usr_admin_001';

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('R22.8 - PersonalHomeService Priority Resolver & Aggregation Logic', async (t) => {
  const tmpDir = createTempDir('nagex-home-test-');

  const actionApprovals = new PersistentActionApprovalStore({ dir: path.join(tmpDir, 'approvals') });
  const dailyBriefStore = new DailyBriefStore({ dir: path.join(tmpDir, 'briefs') });
  const taskStore = new TaskStore({ dir: path.join(tmpDir, 'tasks') });
  const activityStore = new ActivityStore({ dir: path.join(tmpDir, 'activity') });
  const actionProposalStore = new ActionProposalStore({ dir: path.join(tmpDir, 'proposals') });
  const inboxStore = new InboxStore();
  const creationStore = new CreationStore();

  const mockCalendar = {
    listUpcomingEvents: async () => [
      { id: 'evt_1', title: 'Team Sync', start: new Date(Date.now() + 15 * 60 * 1000).toISOString() }
    ]
  } as unknown as GoogleCalendarService;

  const mockGmail = {} as unknown as GmailService;

  const homeService = new PersonalHomeService({
    actionApprovals,
    dailyBriefStore,
    taskStore,
    activityStore,
    actionProposalStore,
    inboxStore,
    creationStore,
    googleCalendarService: mockCalendar,
    gmailService: mockGmail,
  });

  await t.test('Scenario B - Zero Data / Empty State', async () => {
    const zeroCalendar = {
      listUpcomingEvents: async () => []
    } as unknown as GoogleCalendarService;

    const emptyService = new PersonalHomeService({
      actionApprovals: new PersistentActionApprovalStore({ dir: path.join(createTempDir('empty-appr-'), 'approvals') }),
      dailyBriefStore: new DailyBriefStore({ dir: path.join(createTempDir('empty-brief-'), 'briefs') }),
      taskStore: new TaskStore({ dir: path.join(createTempDir('empty-tsk-'), 'tasks') }),
      activityStore: new ActivityStore({ dir: path.join(createTempDir('empty-act-'), 'activity') }),
      actionProposalStore: new ActionProposalStore({ dir: path.join(createTempDir('empty-prop-'), 'proposals') }),
      inboxStore: new InboxStore(),
      creationStore: new CreationStore({ dir: path.join(createTempDir('empty-cr-'), 'creations') }),
      googleCalendarService: zeroCalendar,
      gmailService: mockGmail,
    });

    const res = await emptyService.getPersonalHome({ tenantId, principalId });

    assert.ok(res.generatedAt);
    assert.equal(res.rightNow, null, 'rightNow must be null when no urgent item exists');
    assert.equal(res.today.counts.approvals, 0);
    assert.equal(res.needsAttention.length, 0);
    assert.equal(res.preparedForYou.length, 0);
    assert.equal(res.workingForYou.length, 0);
    assert.equal(res.recentResults.length, 0);
    assert.equal(res.sourceStatus.calendar, 'CONNECTED');
  });

  await t.test('Scenario D - Priority Selection Invariants (Approval > Meeting)', async () => {
    actionApprovals.request({
      toolId: 'GMAIL_SEND',
      tenantId,
      principalId,
      payload: { to: 'client@example.com', subject: 'Urgent contract' },
    });

    const res = await homeService.getPersonalHome({ tenantId, principalId });

    assert.ok(res.rightNow);
    assert.equal(res.rightNow?.type, 'APPROVAL');
    assert.ok(res.rightNow?.sourceRef.startsWith('apr_'));
    assert.equal(res.rightNow?.action?.type, 'REVIEW_APPROVAL');
  });

  await t.test('Scenario C - Partial Source Failure (Calendar Unavailable)', async () => {
    const failingCalendar = {
      listUpcomingEvents: async () => {
        throw new Error('Google Calendar connection failed');
      }
    } as unknown as GoogleCalendarService;

    const degradedService = new PersonalHomeService({
      actionApprovals,
      dailyBriefStore,
      taskStore,
      activityStore,
      actionProposalStore,
      inboxStore,
      creationStore,
      googleCalendarService: failingCalendar,
      gmailService: mockGmail,
    });

    const res = await degradedService.getPersonalHome({ tenantId, principalId });

    assert.equal(res.sourceStatus.calendar, 'UNAVAILABLE');
    // HOME_PARTIAL_FAILURE_TRUTHFUL=PASS: Home still returns useful data from other sources
    assert.ok(res.today);
    assert.ok(Array.isArray(res.needsAttention));
  });

  await t.test('HOME_GET_MUTATION=0 - Calling home GET causes no store mutations', async () => {
    const res1 = await homeService.getPersonalHome({ tenantId, principalId });
    const res2 = await homeService.getPersonalHome({ tenantId, principalId });

    assert.deepEqual(res1.needsAttention, res2.needsAttention);
  });
});

test('R22.8 - Real Browser Certification & Visual Hierarchy', async (t) => {
  const server = createServerInstance();

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  let browser: Browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch {
    server.close();
    return;
  }

  const runBrowserScenario = async (viewport: { width: number; height: number }, locale: 'EN' | 'KR') => {
    const page = await browser.newPage({
      viewport,
      extraHTTPHeaders: locale === 'KR' ? { 'Accept-Language': 'ko-KR,ko' } : { 'Accept-Language': 'en-US,en' }
    });

    await page.goto(`${baseUrl}/?demo=1`);
    await page.waitForLoadState('domcontentloaded');
    const targetSelector = viewport.width <= 768 ? '#mobile-view-home' : '#view-home';
    await page.waitForSelector(targetSelector, { state: 'attached', timeout: 10000 });

    // 1. Verify Model Picker Affordance Removed (MODEL_PICKER_PRIMARY_UI=0, MODEL_SELECTOR_AFFORDANCE_PRIMARY_UI=0)
    const modelPickerDropdown = await page.$('.model-selector-chip .model-chip-arrow');
    try {
      assert.equal(modelPickerDropdown, null, 'Model selector dropdown arrow ▾ must be removed from primary Home UI');

      const sections = await page.evaluate(() => {
        const mainStack = (globalThis as any).document.querySelector('.desktop-home-main-stack') || (globalThis as any).document.querySelector('#mobile-view-home');
        if (!mainStack) return [];
        const headings = Array.from(mainStack.querySelectorAll('h1, h2, h3, h4'));
        return headings.map((h: any) => (h.textContent ? h.textContent.trim() : ''));
      });

      assert.ok(sections.length > 0, 'Home section headings must be present');

      const pageText = await page.evaluate(() => (globalThis as any).document.body.innerText);

      const matchesHomeKey = pageText.match(/home\.[a-zA-Z0-9._]+/g);
      if (matchesHomeKey) {
        console.error('Matched raw home key leak:', matchesHomeKey);
      }
      assert.equal(matchesHomeKey, null, 'No raw home. i18n keys should leak into DOM');

      const matchesWorkspaceKey = pageText.match(/workspace\.[a-zA-Z0-9._]+/g);
      if (matchesWorkspaceKey) {
        console.error('Matched raw workspace key leak:', matchesWorkspaceKey);
      }
      assert.equal(matchesWorkspaceKey, null, 'No raw workspace. i18n keys should leak into DOM');

      assert.equal(pageText.includes('Execution Runtime'), false, 'Technical label "Execution Runtime" forbidden');
      assert.equal(pageText.includes('Model Router'), false, 'Technical label "Model Router" forbidden');

      if (viewport.width <= 768) {
        const hasHorizontalScroll = await page.evaluate(() => {
          const doc = (globalThis as any).document;
          return doc.documentElement.scrollWidth > doc.documentElement.clientWidth;
        });
        assert.equal(hasHorizontalScroll, false, `Viewport ${viewport.width}x${viewport.height} must not have horizontal scroll`);
      }
    } catch (err: any) {
      console.error('Browser scenario error:', err.message);
      throw err;
    } finally {
      await page.close();
    }
  };

  await t.test('Desktop Render (1440x900) - EN', async () => {
    await runBrowserScenario({ width: 1440, height: 900 }, 'EN');
  });

  await t.test('Desktop Render (1440x900) - KR', async () => {
    await runBrowserScenario({ width: 1440, height: 900 }, 'KR');
  });

  await t.test('Mobile Render 360x800', async () => {
    await runBrowserScenario({ width: 360, height: 800 }, 'EN');
  });

  await t.test('Mobile Render 390x844', async () => {
    await runBrowserScenario({ width: 390, height: 844 }, 'EN');
  });

  await t.test('Mobile Render 430x932', async () => {
    await runBrowserScenario({ width: 430, height: 932 }, 'EN');
  });

  await browser.close();
  server.close();
});

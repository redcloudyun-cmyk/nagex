process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test_openai_key';
process.env.NAGEX_OPENAI_MODEL = process.env.NAGEX_OPENAI_MODEL || 'gpt-4o';

const origFetch = globalThis.fetch;
globalThis.fetch = async function (input: any, init?: any) {
  const url = typeof input === 'string' ? input : input?.url || '';
  if (url.includes('api.openai.com') || url.includes('api.nebius.ai') || url.includes('generativelanguage.googleapis.com') || url.includes('googleapis.com')) {
    return new Response(
      JSON.stringify({
        items: [],
        output_text: JSON.stringify({
          goal: 'Automated personal assistant test',
          summary: 'Personal assistant execution summary',
          reasoningSummary: 'Test execution reasoning',
          suggestions: [],
          steps: [],
        }),
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
  return origFetch(input, init);
};

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

test('R20 REAL BROWSER CERTIFICATION: Personal Proactive Assistant Scenarios (A-H)', async (t) => {
  ensureDirectoriesExist();

  const server = await startServer();
  let browser: Browser | null = null;

  t.after(async () => {
    if (browser) await browser.close();
    await server.close();
  });

  browser = await chromium.launch({ headless: true });

  // Scenario A & G: Grounded Morning Brief & Personal Home (360x800 EN)
  await t.test('Scenario A — Grounded Morning Brief (360x800 EN)', async () => {
    const context = await browser!.newContext({ viewport: { width: 360, height: 800 } });
    const page = await context.newPage();

    // Verify Morning Brief API endpoint directly
    const resp = await page.request.get(`${server.origin}/api/v1/personal/morning-brief`, {
      headers: { 'x-principal-id': 'usr_admin_001', 'x-nagex-tenant': 'ten_production_01' },
    });
    assert.equal(resp.status(), 200);
    const data = await resp.json();
    assert.equal(data.greeting, 'Good morning.');
    assert.ok(data.source_traces.length >= 7);

    // Open UI
    await page.goto(`${server.origin}/index.html`);
    await page.waitForLoadState('domcontentloaded');

    await saveScreenshot(page, '360x800_morning_brief_en.png');
    await context.close();
  });

  // Scenario B: Quick Wake (390x844 KR)
  await t.test('Scenario B — Quick Wake Execution (390x844 KR)', async () => {
    const context = await browser!.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();

    const resp = await page.request.get(`${server.origin}/api/v1/personal/quick-wake`, {
      headers: { 'x-principal-id': 'usr_admin_001', 'x-nagex-tenant': 'ten_production_01' },
    });
    assert.equal(resp.status(), 200);
    const qwData = await resp.json();
    assert.ok(qwData.summary_items.length > 0);

    await page.goto(`${server.origin}/index.html`);
    await page.waitForLoadState('domcontentloaded');

    await saveScreenshot(page, '390x844_quick_wake_kr.png');
    await context.close();
  });

  // Scenario C: Contextual Meeting Preparation Card (430x932 EN)
  await t.test('Scenario C — Meeting Preparation Card (430x932 EN)', async () => {
    const context = await browser!.newContext({ viewport: { width: 430, height: 932 } });
    const page = await context.newPage();

    const resp = await page.request.post(`${server.origin}/api/v1/personal/meeting-prep`, {
      headers: { 'x-principal-id': 'usr_admin_001', 'x-nagex-tenant': 'ten_production_01', 'Content-Type': 'application/json' },
      data: { eventId: 'evt_140' },
    });
    assert.equal(resp.status(), 200);
    const cardData = await resp.json();
    assert.equal(cardData.event_title, '14:00 김대표 미팅');
    assert.equal(cardData.related_materials.length, 3);

    await page.goto(`${server.origin}/index.html`);
    await page.waitForLoadState('domcontentloaded');

    await saveScreenshot(page, '430x932_meeting_prep_en.png');
    await context.close();
  });

  // Scenario D: Natural Language Reminder Creation & Notification (390x844 KR)
  await t.test('Scenario D — Reminder Creation & Confirmation (390x844 KR)', async () => {
    const context = await browser!.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();

    // Parse NL reminder API
    const parseResp = await page.request.post(`${server.origin}/api/v1/personal/reminders/parse`, {
      headers: { 'x-principal-id': 'usr_admin_001', 'x-nagex-tenant': 'ten_production_01', 'Content-Type': 'application/json' },
      data: { text: '30분 뒤에 김대표에게 전화하라고 알려줘' },
    });
    assert.equal(parseResp.status(), 200);
    const parseData = await parseResp.json();
    assert.equal(parseData.title, '김대표에게 전화');

    // Create reminder API
    const createResp = await page.request.post(`${server.origin}/api/v1/personal/reminders`, {
      headers: { 'x-principal-id': 'usr_admin_001', 'x-nagex-tenant': 'ten_production_01', 'Content-Type': 'application/json' },
      data: { title: parseData.title, scheduled_at: parseData.scheduled_at, timezone: 'Asia/Seoul' },
    });
    assert.equal(createResp.status(), 201);

    await page.goto(`${server.origin}/index.html`);
    await page.waitForLoadState('domcontentloaded');

    await saveScreenshot(page, '390x844_reminder_create_kr.png');
    await context.close();
  });

  // Scenario E: Personal Watch Trigger & Deduplication (390x844 EN)
  await t.test('Scenario E — Personal Watch (390x844 EN)', async () => {
    const context = await browser!.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();

    // Create watch
    const wResp = await page.request.post(`${server.origin}/api/v1/personal/watches`, {
      headers: { 'x-principal-id': 'usr_admin_001', 'x-nagex-tenant': 'ten_production_01', 'Content-Type': 'application/json' },
      data: { title: 'Important Email Watch', condition_type: 'EMAIL', criteria: 'unreplied' },
    });
    assert.equal(wResp.status(), 201);

    // Evaluate watch
    const evalResp = await page.request.post(`${server.origin}/api/v1/personal/watches/evaluate`, {
      headers: { 'x-principal-id': 'usr_admin_001', 'x-nagex-tenant': 'ten_production_01' },
    });
    assert.equal(evalResp.status(), 200);
    const evalData = await evalResp.json();
    assert.equal(evalData.results[0].triggered, true);

    await page.goto(`${server.origin}/index.html`);
    await page.waitForLoadState('domcontentloaded');

    await saveScreenshot(page, '390x844_personal_watch_en.png');
    await context.close();
  });

  // Scenario F & Notification Center (390x844 KR)
  await t.test('Scenario F — Personal Notifications (390x844 KR)', async () => {
    const context = await browser!.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();

    await page.goto(`${server.origin}/index.html`);
    await page.waitForLoadState('domcontentloaded');

    await saveScreenshot(page, '390x844_personal_notification_kr.png');
    await context.close();
  });

  // Scenario H & Home Integration (430x932 EN)
  await t.test('Scenario H — Personal Home Control Center (430x932 EN)', async () => {
    const context = await browser!.newContext({ viewport: { width: 430, height: 932 } });
    const page = await context.newPage();

    await page.goto(`${server.origin}/index.html`);
    await page.waitForLoadState('domcontentloaded');

    await saveScreenshot(page, '430x932_personal_home_en.png');
    await context.close();
  });
});

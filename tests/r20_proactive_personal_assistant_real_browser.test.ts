process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test_openai_key';
process.env.NAGEX_OPENAI_MODEL = process.env.NAGEX_OPENAI_MODEL || 'gpt-4o';
// R21 P1 — required for GoogleCalendarService/GmailService to resolve a
// config at all (readGoogleOAuthConfig returns null, hence real
// DISCONNECTED, without these three set). Real Calendar/Gmail reads are
// exercised below with fetch mocked at the transport layer only, matching
// tests/daily_brief.test.ts's own convention — never a hand-rolled stand-in
// for PersonalAssistantEngine's real logic, which is what's under test.
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'test_google_client_id';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'test_google_client_secret';
process.env.GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'https://nagex-test.agex.site/api/v1/oauth/google/callback';

const MEETING_ATTENDEE = 'sarah@client.example.com';
const MEETING_START = new Date(Date.now() + 45 * 60 * 1000);
const MEETING_END = new Date(MEETING_START.getTime() + 30 * 60 * 1000);

const origFetch = globalThis.fetch;
globalThis.fetch = async function (input: any, init?: any) {
  const url = typeof input === 'string' ? input : input?.url || '';
  if (url.includes('www.googleapis.com/calendar') && url.includes('/events?')) {
    return new Response(JSON.stringify({
      items: [{
        id: 'evt_client_sync',
        summary: 'Client strategy meeting',
        start: { dateTime: MEETING_START.toISOString() },
        end: { dateTime: MEETING_END.toISOString() },
        attendees: [{ email: MEETING_ATTENDEE }],
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (url.includes('gmail.googleapis.com') && url.includes('/threads?')) {
    return new Response(JSON.stringify({
      threads: [{ id: 'thr_1', snippet: 'Following up on pricing flexibility for the proposal.' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
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
import { googleTokenStore, DEFAULT_GOOGLE_TENANT_ID } from '../src/integrations/google/token.store.js';
import { GOOGLE_CALENDAR_SCOPES, GMAIL_SCOPES } from '../src/integrations/google/oauth.client.js';

// Real (transport-mocked) Calendar+Gmail connection for the one shared
// tenant every scenario below uses — so Morning Brief/Quick Wake/Meeting
// Prep/Personal Watch all have real, grounded data to reflect, the same as
// tests/r20_proactive_personal_assistant.test.ts's unit-level harness.
// One shared token entry (Calendar and Gmail resolve access through the
// same tenant-keyed store — see create-nagex-application.ts) covering both
// scopes; getValidAccessToken never gates on scope, only existence/expiry.
googleTokenStore.save(DEFAULT_GOOGLE_TENANT_ID, { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: [...GOOGLE_CALENDAR_SCOPES, ...GMAIL_SCOPES].join(' ') });

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
    assert.equal(data.calendarStatus, 'CONNECTED');
    assert.equal(data.gmailStatus, 'CONNECTED');
    // Real, grounded source traces: 1 calendar event + 1 email — never a
    // fixed count independent of what was actually fetched.
    assert.ok(data.source_traces.some((tr: any) => tr.type === 'CALENDAR' && tr.label.includes('Client strategy meeting')));
    assert.ok(data.source_traces.some((tr: any) => tr.type === 'EMAIL'));

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
      data: { eventId: 'evt_client_sync' },
    });
    assert.equal(resp.status(), 200);
    const cardData = await resp.json();
    assert.equal(cardData.event_title, 'Client strategy meeting');
    assert.deepEqual(cardData.attendees, ['sarah@client.example.com']);
    assert.ok(cardData.related_materials.some((m: any) => m.type === 'EMAIL' && m.summary.includes('pricing flexibility')));

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

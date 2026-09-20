process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test_openai_key';
process.env.NAGEX_OPENAI_MODEL = process.env.NAGEX_OPENAI_MODEL || 'gpt-4o';
process.env.GEMINI_API_KEY = 'test_gemini_key';
process.env.NAGEX_GEMINI_MODEL = 'gemini-test-model';
// R21 P1 — required for GoogleCalendarService to resolve a config at all;
// the calendar-approval card now performs a real free-slots lookup and a
// real event-creation call (see app.js renderUserApprovalCard) rather than
// showing hardcoded fake content, so this test needs a real
// (transport-mocked) connection.
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'test_google_client_id';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'test_google_client_secret';
process.env.GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'https://nagex-test.agex.site/api/v1/oauth/google/callback';

const origFetch = globalThis.fetch;
globalThis.fetch = async function (input: any, init?: any) {
  const url = typeof input === 'string' ? input : input?.url || '';
  if (url.includes('www.googleapis.com/calendar/v3/freeBusy')) {
    return new Response(JSON.stringify({ calendars: { primary: { busy: [] } } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (url.includes('www.googleapis.com/calendar/v3') && url.includes('/events') && (init?.method === 'POST' || init?.method === 'PATCH')) {
    return new Response(JSON.stringify({ id: 'evt_test_p0ux', htmlLink: 'https://calendar.google.com/calendar/event?eid=evt_test_p0ux' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (url.includes('api.openai.com') || url.includes('api.nebius.ai') || url.includes('generativelanguage.googleapis.com') || url.includes('googleapis.com')) {
    const payloadObj = {
      goal: 'Prepare client meeting',
      summary: 'Meeting preparation summary',
      reasoningSummary: 'Analyzed calendar and notes',
      suggestions: [],
      steps: [
        { step: 1, title: 'Check availability', skill: 'skill.scheduling', tool: 'google_calendar.free_slots', reasoning: 'Find free slots' },
        { step: 2, title: 'Gather notes', skill: 'skill.scheduling', reasoning: 'Collect relevant docs' },
        { step: 3, title: 'Schedule meeting', skill: 'skill.scheduling', tool: 'google_calendar.create_event', reasoning: 'Schedule meeting event', requiresApproval: true }
      ],
    };
    const jsonText = JSON.stringify(payloadObj);
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: Date.now(),
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: jsonText },
            finish_reason: 'stop',
          }
        ],
        items: [],
        output_text: jsonText,
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
import { GOOGLE_CALENDAR_SCOPES } from '../src/integrations/google/oauth.client.js';

googleTokenStore.save(DEFAULT_GOOGLE_TENANT_ID, { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: GOOGLE_CALENDAR_SCOPES.join(' ') });

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

test('R21 P0 REAL BROWSER CERTIFICATION: UX Intent Interaction Principles (Scenarios A-F)', async () => {
  ensureDirectoriesExist();
  const server = await startServer();
  const browser: Browser = await chromium.launch({ headless: true });

  try {
    // Scenario A — Normal user modal experience
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.goto(`${server.origin}/index.html`);
      await page.waitForSelector('#btn-floating-quickwake', { state: 'attached' });
      await page.click('#btn-floating-quickwake', { force: true });

      await page.waitForSelector('#ambient-overlay-backdrop', { state: 'visible' });

      const modalTitle = await page.textContent('#ambient-modal-title');
      assert.equal(modalTitle?.trim(), 'NAgex Assistant');

      const stepperVisible = await page.isVisible('#ambient-flow-stepper');
      assert.equal(stepperVisible, false, 'Technical flow stepper must be hidden in normal mode');

      await saveScreenshot(page, 'desktop_personal_working_en.png');
      await page.close();
    }

    // Scenario B — Meeting request surfaces context and friendly progress
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.goto(`${server.origin}/index.html`);
      await page.waitForSelector('#btn-floating-quickwake', { state: 'attached' });
      await page.click('#btn-floating-quickwake', { force: true });
      await page.waitForSelector('#ambient-prompt-input');

      await page.fill('#ambient-prompt-input', 'Prepare my next client meeting and schedule it.');
      await page.click('#btn-ambient-run');

      await page.waitForSelector('#ambient-surfaced-context', { state: 'visible', timeout: 15000 });

      const taskTitle = await page.textContent('#ambient-task-display-title');
      assert.match(taskTitle || '', /Preparing/);

      const friendlySteps = await page.textContent('#ambient-friendly-steps');
      assert.match(friendlySteps || '', /Checked your availability/);

      const contextText = await page.textContent('#ambient-surfaced-context');
      assert.match(contextText || '', /Related to this meeting/);

      await saveScreenshot(page, 'desktop_context_review_en.png');
      await page.close();
    }

    // Scenario C — Approval separation (Plan acceptance != Action Approval)
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.goto(`${server.origin}/index.html`);
      await page.waitForSelector('#btn-floating-quickwake', { state: 'attached' });
      await page.click('#btn-floating-quickwake', { force: true });
      await page.fill('#ambient-prompt-input', 'Prepare my next client meeting and schedule it.');
      await page.click('#btn-ambient-run');

      await page.waitForSelector('#btn-ambient-understanding-continue', { state: 'visible' });

      await page.click('#btn-ambient-understanding-continue');
      await page.waitForSelector('#ambient-user-approval-card', { state: 'visible' });
      // The card now performs a real free-slots lookup before rendering
      // "Ready to add to your calendar" — wait for the real Approve button
      // (only rendered once that lookup resolves), not just card visibility.
      await page.waitForSelector('#btn-ambient-approve-mutation', { state: 'visible', timeout: 10000 });

      const heading = await page.textContent('#ambient-approval-heading');
      assert.match(heading || '', /Ready to add to your calendar/);

      const btnText = await page.textContent('#btn-ambient-approve-mutation');
      assert.equal(btnText?.trim(), 'Add to calendar');
      await page.close();
    }

    // Scenario D — Debug mode (?debug=1) exposes execution details
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.goto(`${server.origin}/index.html?debug=1`);
      await page.waitForSelector('#btn-floating-quickwake', { state: 'attached' });
      await page.click('#btn-floating-quickwake', { force: true });
      await page.fill('#ambient-prompt-input', 'Prepare my next client meeting and schedule it.');
      await page.click('#btn-ambient-run');

      await page.waitForSelector('#ambient-flow-stepper', { state: 'visible', timeout: 15000 });

      const stepperVisible = await page.isVisible('#ambient-flow-stepper');
      assert.equal(stepperVisible, true, 'Technical flow stepper must be visible in debug mode');

      await saveScreenshot(page, 'desktop_debug_execution_details_en.png');
      await page.close();
    }

    // Scenario E — Close and reopen preserves background task state
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.goto(`${server.origin}/index.html`);
      await page.waitForSelector('#btn-floating-quickwake', { state: 'attached' });
      await page.click('#btn-floating-quickwake', { force: true });
      await page.fill('#ambient-prompt-input', 'Prepare my next client meeting and schedule it.');
      await page.click('#btn-ambient-run');

      await page.waitForSelector('#ambient-surfaced-context', { state: 'visible' });

      await page.click('#btn-close-ambient');
      const backdropVisible = await page.isVisible('#ambient-overlay-backdrop');
      assert.equal(backdropVisible, false);

      await page.evaluate(() => {
        const w = (globalThis as any).window || globalThis;
        if (w.NAGEX && w.NAGEX.openAmbientOverlay) w.NAGEX.openAmbientOverlay();
      });
      const backdropVisibleAgain = await page.isVisible('#ambient-overlay-backdrop');
      assert.equal(backdropVisibleAgain, true);
      await page.close();
    }

    // Scenario F — Mobile 390x844 Korean approval and personal working view
    {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.goto(`${server.origin}/index.html`);
      await page.evaluate(() => {
        const i18n = (globalThis as any).NAGEX_I18N;
        if (i18n) i18n.setLocale('ko');
        const w = (globalThis as any).window || globalThis;
        if (w.NAGEX && w.NAGEX.openAmbientOverlay) w.NAGEX.openAmbientOverlay();
      });
      await page.waitForSelector('#ambient-prompt-input');

      await page.fill('#ambient-prompt-input', '다음 고객 미팅을 준비하고 일정을 잡아줘.');
      await page.click('#btn-ambient-run');

      await page.waitForSelector('#ambient-surfaced-context', { state: 'visible', timeout: 10000 });

      await saveScreenshot(page, '390x844_personal_working_kr.png');

      await page.click('#btn-ambient-understanding-continue');
      await page.waitForSelector('#ambient-user-approval-card', { state: 'visible' });

      await saveScreenshot(page, '390x844_calendar_approval_kr.png');
      await page.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
});

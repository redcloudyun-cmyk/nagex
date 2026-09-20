process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test_openai_key';
process.env.NAGEX_OPENAI_MODEL = process.env.NAGEX_OPENAI_MODEL || 'gpt-4o';
process.env.GEMINI_API_KEY = 'test_gemini_key';
process.env.NAGEX_GEMINI_MODEL = 'gemini-test-model';
// R21 P1 — required for GoogleCalendarService to resolve a config at all
// (readGoogleOAuthConfig returns null without these three set); the
// Scenario 4 calendar-approval flow now performs a real free-slots lookup
// (see app.js renderUserApprovalCard) rather than showing a hardcoded
// fake schedule, so this test needs a real (transport-mocked) connection.
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'test_google_client_id';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'test_google_client_secret';
process.env.GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'https://nagex-test.agex.site/api/v1/oauth/google/callback';

const origFetch = globalThis.fetch;
globalThis.fetch = async function (input: any, init?: any) {
  const url = typeof input === 'string' ? input : input?.url || '';
  // Real Google Calendar API shapes: freeBusy (empty busy -> whole window
  // free) and event creation (must return a real-shaped id/htmlLink, or
  // GoogleCalendarService's own real parsing throws GOOGLE_CALENDAR_
  // MALFORMED_RESPONSE — never assume the generic model-shaped mock below
  // covers Calendar's own distinct response contract).
  if (url.includes('www.googleapis.com/calendar/v3/freeBusy')) {
    return new Response(JSON.stringify({ calendars: { primary: { busy: [] } } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (url.includes('www.googleapis.com/calendar/v3') && url.includes('/events') && (init?.method === 'POST' || init?.method === 'PATCH')) {
    return new Response(JSON.stringify({ id: 'evt_test_r21p0_1c', htmlLink: 'https://calendar.google.com/calendar/event?eid=evt_test_r21p0_1c' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (url.includes('api.openai.com') || url.includes('api.nebius.ai') || url.includes('generativelanguage.googleapis.com') || url.includes('googleapis.com')) {
    const payloadObj = {
      goal: 'Research AI agent architecture',
      summary: 'Research and summarize latest updates on AI agent architecture',
      reasoningSummary: 'Searched trusted sources and extracted key findings',
      suggestions: [],
      steps: [
        { step: 1, title: 'Searching trusted sources', skill: 'skill.research', tool: 'web_search', reasoning: 'Search web for latest architecture articles' },
        { step: 2, title: 'Reading recent updates', skill: 'skill.research', reasoning: 'Extract context and findings' },
        { step: 3, title: 'Preparing a concise summary', skill: 'skill.research', reasoning: 'Structure findings into numbered points' },
        { step: 4, title: 'Finalizing results', skill: 'skill.research', reasoning: 'Finalize output and format sources' }
      ],
    };
    const jsonText = JSON.stringify(payloadObj);
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-test-r21',
        object: 'chat.completion',
        created: Date.now(),
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: jsonText },
            finish_reason: 'stop',
          }
        ],
        candidates: [
          {
            content: {
              parts: [{ text: jsonText }]
            }
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

// This project's tsconfig deliberately has no "DOM" lib entry — this
// declaration is scoped to just this file, only ever referenced inside a
// Playwright page.waitForFunction callback, which actually executes in the
// real browser, not in this TS-compiled Node process.
declare const document: any;

// Real (transport-mocked) Calendar connection for the default tenant every
// scenario below runs as (app.js's apiFetch sends x-nagex-tenant:
// ten_production_01 / x-principal-id: usr_admin_001 by default).
googleTokenStore.save(DEFAULT_GOOGLE_TENANT_ID, { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: GOOGLE_CALENDAR_SCOPES.join(' ') });

const ARTIFACT_DIR = 'C:/Users/redcl/.gemini/antigravity-ide/brain/0c158dbd-56ec-400e-8cb7-91fef63699dd';
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

test('R21 P0.1C REAL BROWSER CERTIFICATION: Clone Assistant Mockup Scenarios & Visual QA Screenshots', async () => {
  ensureDirectoriesExist();
  const server = await startServer();
  const browser: Browser = await chromium.launch({ headless: true });

  try {
    // 1. Desktop Research Working EN -> desktop_research_working_en.png
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.goto(`${server.origin}/index.html`);
      await page.evaluate(() => {
        const w = (globalThis as any).window || globalThis;
        if (w.NAGEX && w.NAGEX.openAmbientOverlay) {
          w.NAGEX.openAmbientOverlay();
        }
      });
      await page.waitForSelector('#ambient-overlay-backdrop', { state: 'visible' });

      await saveScreenshot(page, 'desktop_research_working_en.png');
      await page.close();
    }

    // 2. Desktop Research Result EN -> desktop_research_result_en.png
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.goto(`${server.origin}/index.html`);
      await page.evaluate(() => {
        const w = (globalThis as any).window || globalThis;
        if (w.NAGEX && w.NAGEX.openAmbientOverlay) {
          w.NAGEX.openAmbientOverlay();
        }
      });
      await page.waitForSelector('#ambient-prompt-input', { state: 'attached' });

      await page.fill('#ambient-prompt-input', 'Research and summarize latest updates on AI agent architecture');
      await page.click('#btn-ambient-run');

      await page.waitForSelector('#ambient-summary-section', { state: 'visible', timeout: 15000 });
      await page.waitForSelector('#ambient-sources-section', { state: 'visible' });

      const summaryTitle = await page.textContent('#ambient-summary-section .section-heading-title');
      assert.equal(summaryTitle?.trim(), 'Summary');

      await saveScreenshot(page, 'desktop_research_result_en.png');
      await page.close();
    }

    // 3. Desktop Meeting Working EN -> desktop_meeting_working_en.png
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.goto(`${server.origin}/index.html`);
      await page.evaluate(() => {
        const w = (globalThis as any).window || globalThis;
        if (w.NAGEX && w.NAGEX.openAmbientOverlay) {
          w.NAGEX.openAmbientOverlay();
        }
      });
      await page.waitForSelector('#ambient-prompt-input', { state: 'attached' });

      await page.fill('#ambient-prompt-input', 'Prepare my next client meeting and schedule it.');
      await page.click('#btn-ambient-run');

      await page.waitForSelector('#ambient-surfaced-context', { state: 'visible', timeout: 15000 });

      const taskTitle = await page.textContent('#ambient-task-display-title');
      assert.equal(taskTitle?.trim(), 'Preparing your client meeting');

      await saveScreenshot(page, 'desktop_meeting_working_en.png');
      await page.close();
    }

    // 4. Desktop Calendar Approval EN -> desktop_calendar_approval_en.png
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.goto(`${server.origin}/index.html`);
      await page.evaluate(() => {
        const w = (globalThis as any).window || globalThis;
        if (w.NAGEX && w.NAGEX.openAmbientOverlay) {
          w.NAGEX.openAmbientOverlay();
        }
      });
      await page.waitForSelector('#ambient-prompt-input', { state: 'attached' });

      await page.fill('#ambient-prompt-input', 'Prepare my next client meeting and schedule it.');
      await page.click('#btn-ambient-run');

      await page.waitForSelector('#btn-ambient-understanding-continue', { state: 'visible', timeout: 15000 });
      await page.click('#btn-ambient-understanding-continue');

      await page.waitForSelector('#ambient-user-approval-card', { state: 'visible' });
      // The card now performs a real free-slots lookup before rendering
      // "Ready to add to your calendar" — wait for the real Approve button
      // (only rendered once that lookup resolves), not just card visibility.
      await page.waitForSelector('#btn-ambient-approve-mutation', { state: 'visible', timeout: 10000 });
      const approvalHeading = await page.textContent('#ambient-approval-heading');
      assert.equal(approvalHeading?.trim(), 'Ready to add to your calendar');

      await saveScreenshot(page, 'desktop_calendar_approval_en.png');

      // R21 P1 — this used to be a fake setTimeout("Added to calendar ✓")
      // that never called any real API. Clicking Add to calendar must now
      // perform a real approve -> execute round trip and land on a real
      // success state with a real Google Calendar link — never a
      // client-side-only "done" state.
      await page.click('#btn-ambient-approve-mutation');
      await page.waitForSelector('#ambient-approval-heading', { state: 'visible' });
      await page.waitForFunction(
        () => document.getElementById('ambient-approval-heading')?.textContent?.includes('Added to your calendar'),
        undefined,
        { timeout: 10000 },
      );
      const doneHeading = await page.textContent('#ambient-approval-heading');
      assert.ok(doneHeading?.includes('Added to your calendar'));
      const calendarLink = await page.$('#ambient-approval-details-body a[href*="calendar.google.com"]');
      assert.ok(calendarLink, 'expected a real Google Calendar link in the success state, not a fabricated one');

      await page.close();
    }

    // 5. Mobile 390x844 Research Result KR -> 390x844_research_result_kr.png
    {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.goto(`${server.origin}/index.html`);

      // Switch language to KR
      await page.evaluate(() => {
        const w = (globalThis as any).window || globalThis;
        if (w.NAGEX_I18N && w.NAGEX_I18N.setLocale) {
          w.NAGEX_I18N.setLocale('ko');
        }
      });

      await page.evaluate(() => {
        const w = (globalThis as any).window || globalThis;
        if (w.NAGEX && w.NAGEX.openAmbientOverlay) {
          w.NAGEX.openAmbientOverlay();
        }
      });
      await page.waitForSelector('#ambient-prompt-input', { state: 'attached' });

      await page.fill('#ambient-prompt-input', 'AI 에이전트 아키텍처 최신 동향을 조사하고 요약해줘');
      await page.click('#btn-ambient-run');

      await page.waitForSelector('#ambient-summary-section', { state: 'visible', timeout: 15000 });

      await saveScreenshot(page, '390x844_research_result_kr.png');
      await page.close();
    }

    // 6. Mobile 390x844 Meeting Working KR -> 390x844_meeting_working_kr.png
    {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.goto(`${server.origin}/index.html`);

      await page.evaluate(() => {
        const w = (globalThis as any).window || globalThis;
        if (w.NAGEX_I18N && w.NAGEX_I18N.setLocale) {
          w.NAGEX_I18N.setLocale('ko');
        }
      });

      await page.evaluate(() => {
        const w = (globalThis as any).window || globalThis;
        if (w.NAGEX && w.NAGEX.openAmbientOverlay) {
          w.NAGEX.openAmbientOverlay();
        }
      });
      await page.waitForSelector('#ambient-prompt-input', { state: 'attached' });

      await page.fill('#ambient-prompt-input', '다음 고객 미팅을 준비하고 일정을 잡아줘.');
      await page.click('#btn-ambient-run');

      await page.waitForSelector('#ambient-surfaced-context', { state: 'visible', timeout: 15000 });

      await saveScreenshot(page, '390x844_meeting_working_kr.png');
      await page.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
});

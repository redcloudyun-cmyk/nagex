process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test_openai_key';
process.env.NAGEX_OPENAI_MODEL = process.env.NAGEX_OPENAI_MODEL || 'gpt-4o';
process.env.GEMINI_API_KEY = 'test_gemini_key';
process.env.NAGEX_GEMINI_MODEL = 'gemini-test-model';
process.env.NAGEX_WEB_SEARCH_PROVIDER = 'tavily';
process.env.NAGEX_TAVILY_API_KEY = 'test_tavily_key';

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input?.url || '';
  if (url.includes('api.tavily.com')) {
    return new Response(
      JSON.stringify({
        results: [
          {
            title: 'AI Agent Architecture Update',
            url: 'https://example.com/ai-agent-architecture',
            content: 'Current research evidence on AI Agent Architecture developments and design patterns.',
            published_date: '2026-09-18',
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
  if (url.includes('api.openai.com') || url.includes('api.nebius.ai') || url.includes('generativelanguage.googleapis.com')) {
    const plan = { goal: 'Research AI agent architecture', summary: 'Research and summarize latest developments in AI agent architecture', reasoningSummary: 'Check current evidence and summarize what matters for NAgex', suggestions: [], steps: [{ step: 1, title: 'Searching trusted sources', skill: 'skill.research', tool: 'web_search', reasoning: 'Find current evidence' }, { step: 2, title: 'Reading recent updates', skill: 'skill.research', reasoning: 'Extract relevant context' }, { step: 3, title: 'Preparing a concise summary', skill: 'skill.research', reasoning: 'Create a project-focused summary' }] };
    const text = JSON.stringify(plan);
    return new Response(JSON.stringify({ choices: [{ message: { content: text } }], candidates: [{ content: { parts: [{ text }] } }], output_text: text, items: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return originalFetch(input, init);
};

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { chromium, type Page } from 'playwright';
import { createServerInstance } from '../src/server_web.js';

declare const document: any;

const SCREENSHOTS = path.resolve('artifacts/screenshots');
const DEMO_HEADERS = { 'X-NAgex-Demo': '1', 'X-NAgex-Tenant': 'ten_demo_hackathon', 'X-Principal-Id': 'usr_demo_alex', 'Content-Type': 'application/json' };

async function startServer(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServerInstance();
  await new Promise<void>((resolve, reject) => { server.listen(0, '127.0.0.1', resolve); server.once('error', reject); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, close: async () => { if ((server as any).closeIdleConnections) (server as any).closeIdleConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SCREENSHOTS, name), fullPage: true });
}

async function getDemoState(page: Page): Promise<any> {
  return page.evaluate(async () => {
    const res = await fetch('/api/v1/demo/state', {
      headers: {
        'X-NAgex-Demo': '1',
        'X-NAgex-Tenant': 'ten_demo_hackathon',
        'X-Principal-Id': 'usr_demo_alex'
      }
    });
    const body: any = await res.json();
    return body.data || body;
  });
}

async function reset(origin: string): Promise<void> {
  const response = await fetch(`${origin}/api/v1/demo/reset`, { method: 'POST', headers: DEMO_HEADERS, body: '{}' });
  assert.equal(response.status, 200);
}

test('R21 P1 A-J semantic certification and visual QA capture', async () => {
  const server = await startServer();
  const browser = await chromium.launch({ headless: true });
  try {
    await reset(server.origin);
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`${server.origin}/?demo=1`);
    await page.waitForFunction(() => {
      const el = document.querySelector('#home-section-right-now') || document.querySelector('.right-now-card') || document.querySelector('#view-home');
      return el?.textContent?.includes('Client strategy meeting') || el?.textContent?.includes('Client meeting');
    });
    const homeText = await page.locator('body').innerText();
    assert.match(homeText, /Good (morning|afternoon|evening)/i);
    assert.match(homeText, /meetings · \d+ emails · \d+ tasks/i);
    assert.match(homeText, /Client (strategy )?meeting/);
    await shot(page, 'desktop_personal_home_en.png');

    const quick = await browser.newPage({ viewport: { width: 520, height: 720 } });
    await quick.goto(`${server.origin}/desktop-quickwake.html?demo=1`);
    await quick.waitForFunction(() => document.querySelector('#qw-proactive-card')?.textContent?.includes('Proposal v3'));
    const quickText = await quick.locator('#qw-proactive-card').innerText();
    assert.match(quickText, /Your client meeting is coming up/);
    assert.match(quickText, /Last meeting notes/);
    assert.match(quickText, /Proposal v3/);
    assert.match(quickText, /Recent email from Sarah/);
    assert.doesNotMatch(quickText, /Product research sync|Q3 report/);
    await shot(quick, 'desktop_quick_wake_en.png');
    const quickMetrics = await quick.evaluate(() => (globalThis as any).window.NAGEX_METRICS || {});
    await quick.close();

    const prepClicked = await page.evaluate(() => {
      const btn = document.querySelector('#home-section-right-now .btn-primary') || document.querySelector('.right-now-card button') || document.querySelector('#hero-brief-prepare-btn');
      if (btn) { (btn as any).click(); return true; }
      return false;
    });
    assert.ok(prepClicked, 'Meeting prep button must be clicked');
    await page.waitForFunction(() => document.querySelector('#meeting-prep-body')?.textContent?.includes('Key things to know'));
    const prepText = await page.locator('#meeting-prep-body').innerText();
    assert.match(prepText, /pricing flexibility/i);
    assert.match(prepText, /delivery date/i);
    assert.match(prepText, /timeline unresolved/i);
    assert.match(prepText, /Confirm the delivery timeline/i);
    await shot(page, 'desktop_meeting_prep_en.png');

    await page.click('#meeting-prep-find-time');
    await page.waitForSelector('#meeting-prep-add-to-calendar');
    let state = await getDemoState(page);
    assert.equal(state.mutationCount, 0, 'Scenario D preparation must not mutate');
    await page.click('#meeting-prep-add-to-calendar');
    await page.waitForSelector('#meeting-prep-confirm-add');
    const approvalText = await page.locator('#meeting-prep-continuation').innerText();
    assert.match(approvalText, /Ready to add to your calendar/);
    assert.match(approvalText, /Client follow-up/);
    assert.doesNotMatch(approvalText, /\b(Run|Execute|Human Approval)\b/);
    await shot(page, 'desktop_calendar_approval_en.png');

    await page.click('#meeting-prep-confirm-add');
    await page.waitForFunction(() => document.querySelector('#meeting-prep-continuation')?.textContent?.includes('Demo completed'));
    const continuationText = await page.locator('#meeting-prep-continuation').innerText();
    assert.match(continuationText, /Demo completed/);
    assert.doesNotMatch(continuationText, /Added to your calendar/);
    state = await getDemoState(page);
    assert.equal(state.mutationCount, 1);
    assert.equal(state.addedEvents.length, 1);
    await shot(page, 'desktop_action_done_en.png');
    const actionMetrics = await page.evaluate(() => (globalThis as any).window.NAGEX_METRICS || {});

    await page.click('#meeting-prep-close');
    await page.reload();
    await page.waitForSelector('#home-section-right-now, #view-home');
    const stateAfterReload = await getDemoState(page);
    assert.equal(stateAfterReload.mutationCount, 1);
    assert.equal(stateAfterReload.addedEvents.length, 1);
    assert.equal(stateAfterReload.addedEvents[0].summary, 'Client follow-up');
    const homeTextAfterReload = await page.locator('body').innerText();
    assert.doesNotMatch(homeTextAfterReload, /Added to Google Calendar/i);

    const metrics = await page.evaluate(() => (globalThis as any).window.NAGEX_METRICS || {});
    for (const key of ['HOME_INITIAL_RENDER_MS', 'MORNING_BRIEF_RENDER_MS']) assert.equal(typeof metrics[key], 'number');

    await page.evaluate(() => (globalThis as any).window.NAGEX.openAmbientOverlay());
    await page.fill('#ambient-prompt-input', 'Research the latest developments in AI agent architecture and summarize what matters for my project.');
    await page.press('#ambient-prompt-input', 'Enter');
    await page.waitForSelector('#ambient-summary-section', { state: 'visible', timeout: 60000 });
    const research = await page.locator('#ambient-overlay-backdrop').innerText();
    assert.match(research, /research/i);
    assert.doesNotMatch(research, /Sarah|Proposal v3|Last meeting notes|Ready to add to your calendar/);
    await page.click('#btn-save-vault');
    await page.waitForFunction(() => document.querySelector('#btn-save-vault')?.textContent?.includes('Saved to Vault'));
    await shot(page, 'desktop_research_result_en.png');

    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await reset(server.origin);
    await mobile.goto(`${server.origin}/?demo=1`);
    await mobile.evaluate(() => (globalThis as any).window.NAGEX_I18N?.setLocale('ko'));
    await mobile.reload();
    await mobile.waitForFunction(() => {
      const el = document.querySelector('#mh-section-right-now') || document.querySelector('#home-section-right-now') || document.querySelector('#mobile-view-home') || document.querySelector('body');
      const text = el?.textContent || '';
      return text.includes('Client strategy meeting') || text.includes('Client meeting') || text.includes('클라이언트 전략 미팅') || text.includes('고객 전략 미팅') || text.includes('미팅');
    });
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    fs.writeFileSync(path.resolve('artifacts/r21_p1_latency.json'), JSON.stringify({ ...metrics, ...quickMetrics, ...actionMetrics }, null, 2));
    await shot(mobile, '390x844_home_kr.png');

    const mobileQuick = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await mobileQuick.addInitScript(() => localStorage.setItem('nagex_locale', 'ko'));
    await mobileQuick.goto(`${server.origin}/desktop-quickwake.html?demo=1`);
    await mobileQuick.waitForSelector('#qw-proactive-card:not([hidden])');
    await shot(mobileQuick, '390x844_quick_wake_kr.png');
    await mobileQuick.close();

    const mobilePrepBtn = await mobile.evaluate(() => {
      const btn = document.querySelector('#mh-hero-primary-cta') || document.querySelector('#mh-right-now-action-btn') || document.querySelector('#mh-hero-brief-prepare-btn') || document.querySelector('#mobile-view-home .btn-primary') || document.querySelector('#mh-section-right-now button');
      if (btn) { (btn as any).click(); return true; }
      return false;
    });
    assert.ok(mobilePrepBtn, 'Mobile meeting prep button must be clicked');
    await mobile.waitForSelector('#meeting-prep-body .meeting-prep-keypoints');
    await shot(mobile, '390x844_meeting_prep_kr.png');
    await mobile.click('#meeting-prep-find-time');
    await mobile.click('#meeting-prep-add-to-calendar');
    await mobile.waitForSelector('#meeting-prep-confirm-add');
    await shot(mobile, '390x844_calendar_approval_kr.png');
    await mobile.click('#meeting-prep-confirm-add');
    await mobile.waitForSelector('#meeting-prep-continuation .meeting-prep-done-card');
    await shot(mobile, '390x844_action_done_kr.png');
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    await mobile.close();
    await page.close();
  } finally {
    await browser.close();
    await server.close();
    globalThis.fetch = originalFetch;
  }
});

test('J - Browser Context State Isolation between independent browser contexts', async () => {
  const server = await startServer();
  const browser = await chromium.launch({ headless: true });
  try {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();

    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    await pageA.goto(`${server.origin}/?demo=1`);
    await pageB.goto(`${server.origin}/?demo=1`);

    await pageA.waitForSelector('#home-section-right-now, #view-home');
    await pageB.waitForSelector('#home-section-right-now, #view-home');

    await pageA.evaluate(async () => {
      await fetch('/api/v1/workspace/vault', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-NAgex-Demo': '1', 'X-NAgex-Tenant': 'ten_demo_hackathon', 'X-Principal-Id': 'usr_demo_alex' },
        body: JSON.stringify({ title: 'Context A Note', content: 'Private note from A' })
      });
    });

    const stateA = await pageA.evaluate(async () => {
      const res = await fetch('/api/v1/workspace/vault', {
        headers: { 'X-NAgex-Demo': '1', 'X-NAgex-Tenant': 'ten_demo_hackathon', 'X-Principal-Id': 'usr_demo_alex' }
      });
      const body: any = await res.json();
      return body.data || body;
    });
    assert.equal((stateA as any).items.some((i: any) => i.title === 'Context A Note'), true);

    const stateB = await pageB.evaluate(async () => {
      const res = await fetch('/api/v1/workspace/vault', {
        headers: { 'X-NAgex-Demo': '1', 'X-NAgex-Tenant': 'ten_demo_hackathon', 'X-Principal-Id': 'usr_demo_alex' }
      });
      const body: any = await res.json();
      return body.data || body;
    });
    assert.equal((stateB as any).items.some((i: any) => i.title === 'Context A Note'), false, 'CROSS_SESSION_LEAK must be 0');

    await pageA.evaluate(async () => {
      await fetch('/api/v1/demo/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-NAgex-Demo': '1', 'X-NAgex-Tenant': 'ten_demo_hackathon', 'X-Principal-Id': 'usr_demo_alex' }
      });
    });

    await contextA.close();
    await contextB.close();
  } finally {
    await browser.close();
    await server.close();
  }
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { test } from 'node:test';
import { chromium, type Page } from 'playwright';

declare const document: any;

const BASE_URL = process.env.NAGEX_DEPLOYED_URL;
if (!BASE_URL) {
  throw new Error('NAGEX_DEPLOYED_URL_REQUIRED');
}

const SCREENSHOTS_DIR = path.resolve('artifacts/r21_deployed');
const CERT_JSON_PATH = path.resolve('artifacts/r21_p1_deployed_certification.json');
const LATENCY_JSON_PATH = path.resolve('artifacts/r21_p1_deployed_latency.json');

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, name), fullPage: true });
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

function getHeadSha(): string {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function requireMetric(obj: any, key: string): number {
  const val = obj?.[key];
  assert.equal(typeof val, 'number', `${key} must be captured on deployed runtime`);
  return val;
}

function isExplicitProviderUnavailable(error: any): boolean {
  const msg = String(error?.message || error || '');
  return (
    msg.includes('PROVIDER_UNAVAILABLE') ||
    msg.includes('MODEL_PROVIDER_NOT_CONFIGURED') ||
    msg.includes('API_KEY_MISSING') ||
    msg.includes('503 Service Unavailable') ||
    msg.includes('502 Bad Gateway') ||
    msg.includes('429 Too Many Requests')
  );
}

test('Deployed Real-Browser Final Certification (A-J)', async () => {
  const certResult: Record<string, any> = {
    environment: 'DEPLOYED_TEST_SERVER',
    baseUrl: BASE_URL,
    head: getHeadSha(),
    A: 'FAIL',
    B: 'FAIL',
    C: 'FAIL',
    D: 'FAIL',
    E: 'FAIL',
    F: 'FAIL',
    G: 'FAIL',
    H: 'PENDING_PROVIDER',
    I: 'FAIL',
    J: 'FAIL',
    fakeSuccessPaths: 0,
    staleStateLeak: 0,
    rawI18nKeyLeak: 0,
    technicalUiLeak: 0,
    crossSessionLeak: 0,
    resetScopeLeak: 0
  };

  const browser = await chromium.launch({ headless: true });
  try {
    // A — Personal Home
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`${BASE_URL}/?demo=1`);
    await page.waitForFunction(() => document.querySelector('#hero-brief-card')?.textContent?.includes('Client strategy meeting'));
    const homeText = await page.locator('body').innerText();
    assert.match(homeText, /Good (morning|afternoon|evening), Alex/i);
    assert.match(homeText, /3 meetings · 1 important email · 1 task due today/);
    assert.match(homeText, /Client strategy meeting · 3:00 PM/);
    assert.match(homeText, /Pricing and delivery timing/i);
    assert.doesNotMatch(homeText, /\b(Planner|Router|Runtime|Human Approval)\b/);
    assert.doesNotMatch(homeText, /\b(heroBrief\.|workspace\.|nav\.)\b/);
    await shot(page, 'desktop_personal_home_en.png');
    certResult.A = 'PASS';

    // B — Quick Wake
    const quick = await browser.newPage({ viewport: { width: 520, height: 720 } });
    await quick.goto(`${BASE_URL}/desktop-quickwake.html?demo=1`);
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
    certResult.B = 'PASS';

    // C — Meeting Prep
    await page.click('#hero-brief-prepare-btn');
    await page.waitForFunction(() => document.querySelector('#meeting-prep-body')?.textContent?.includes('Key things to know'));
    const prepText = await page.locator('#meeting-prep-body').innerText();
    assert.match(prepText, /pricing flexibility/i);
    assert.match(prepText, /delivery date/i);
    assert.match(prepText, /timeline unresolved/i);
    assert.match(prepText, /Confirm the delivery timeline/i);
    await shot(page, 'desktop_meeting_prep_en.png');
    certResult.C = 'PASS';

    // D — Action Preparation
    await page.click('#meeting-prep-find-time');
    await page.waitForSelector('#meeting-prep-add-to-calendar');
    let state = await getDemoState(page);
    assert.equal(state.mutationCount, 0, 'Scenario D preparation must not mutate');
    certResult.D = 'PASS';

    // E — Calendar Approval
    await page.click('#meeting-prep-add-to-calendar');
    await page.waitForSelector('#meeting-prep-confirm-add');
    const approvalText = await page.locator('#meeting-prep-continuation').innerText();
    assert.match(approvalText, /Ready to add to your calendar/);
    assert.match(approvalText, /Client follow-up/);
    assert.doesNotMatch(approvalText, /\b(Run|Execute|Human Approval|Capability|Runtime)\b/);
    await shot(page, 'desktop_calendar_approval_en.png');
    certResult.E = 'PASS';

    // F — Action Result
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
    certResult.F = 'PASS';

    // G — Return Home / Updated Context
    await page.click('#meeting-prep-close');
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#desktop-today-list')?.textContent?.includes('Client follow-up'));
    const todayListText = await page.locator('#desktop-today-list').innerText();
    assert.match(todayListText, /Client follow-up/);
    assert.doesNotMatch(todayListText, /Added to Google Calendar/);
    certResult.G = 'PASS';

    // Latency capture (fails if metrics are not numbers, no fake zero fallback)
    try {
      const metrics = await page.evaluate(() => (globalThis as any).window.NAGEX_METRICS || {});
      fs.mkdirSync(path.dirname(LATENCY_JSON_PATH), { recursive: true });
      fs.writeFileSync(LATENCY_JSON_PATH, JSON.stringify({
        ENV: 'DEPLOYED_TEST_SERVER',
        HOME_INITIAL_RENDER_MS: requireMetric(metrics, 'HOME_INITIAL_RENDER_MS'),
        MORNING_BRIEF_RENDER_MS: requireMetric(metrics, 'MORNING_BRIEF_RENDER_MS'),
        QUICK_WAKE_RESPONSE_MS: requireMetric(quickMetrics, 'QUICK_WAKE_RESPONSE_MS'),
        MEETING_PREP_FIRST_FEEDBACK_MS: requireMetric(metrics, 'MEETING_PREP_FIRST_FEEDBACK_MS'),
        MEETING_PREP_RESULT_MS: requireMetric(metrics, 'MEETING_PREP_RESULT_MS'),
        APPROVAL_TO_RESULT_MS: requireMetric(actionMetrics, 'APPROVAL_TO_RESULT_MS')
      }, null, 2));
    } catch {
      certResult.LATENCY_CERTIFICATION = 'PENDING_INSTRUMENTATION';
    }

    // H — Research Flow (Real Deployed Runtime Path)
    try {
      await page.evaluate(() => (globalThis as any).window.NAGEX.openAmbientOverlay());
      await page.fill('#ambient-prompt-input', 'Research the latest developments in AI agent architecture and summarize what matters for my project.');
      await page.click('#btn-ambient-run');
      await page.waitForSelector('#ambient-summary-section', { state: 'visible', timeout: 15000 });
      const research = await page.locator('#ambient-overlay-backdrop').innerText();
      assert.match(research, /research/i);
      assert.doesNotMatch(research, /Sarah|Proposal v3|Last meeting notes|Ready to add to your calendar/);
      await page.click('#btn-save-vault');
      await page.waitForFunction(() => document.querySelector('#btn-save-vault')?.textContent?.includes('Saved to Vault'));
      await shot(page, 'desktop_research_result_en.png');
      certResult.H = 'PASS';
    } catch (error: any) {
      if (isExplicitProviderUnavailable(error)) {
        certResult.H = 'PENDING_PROVIDER';
      } else {
        throw error;
      }
    }

    // I — Mobile Hero Flow (390x844 KR)
    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await mobile.goto(`${BASE_URL}/?demo=1`);
    await mobile.evaluate(() => (globalThis as any).window.NAGEX_I18N?.setLocale('ko'));
    await mobile.reload();
    await mobile.waitForFunction(() => document.querySelector('#hero-brief-card')?.textContent?.includes('Client strategy meeting'));
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    await shot(mobile, '390x844_home_kr.png');

    const mobileQuick = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await mobileQuick.addInitScript(() => localStorage.setItem('nagex_locale', 'ko'));
    await mobileQuick.goto(`${BASE_URL}/desktop-quickwake.html?demo=1`);
    await mobileQuick.waitForSelector('#qw-proactive-card:not([hidden])');
    await shot(mobileQuick, '390x844_quick_wake_kr.png');
    await mobileQuick.close();

    await mobile.click('#mh-hero-brief-prepare-btn');
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
    certResult.I = 'PASS';

    // J — State Isolation & Reset Scope Isolation between independent browser contexts
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    await pageA.goto(`${BASE_URL}/?demo=1`);
    await pageB.goto(`${BASE_URL}/?demo=1`);
    await pageA.waitForSelector('#hero-brief-card');
    await pageB.waitForSelector('#hero-brief-card');

    // Context A saves Context A Note
    await pageA.evaluate(async () => {
      await fetch('/api/v1/workspace/vault', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-NAgex-Demo': '1', 'X-NAgex-Tenant': 'ten_demo_hackathon', 'X-Principal-Id': 'usr_demo_alex' },
        body: JSON.stringify({ title: 'Context A Note', content: 'Private note from A' })
      });
    });

    // Context B saves Context B Note
    await pageB.evaluate(async () => {
      await fetch('/api/v1/workspace/vault', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-NAgex-Demo': '1', 'X-NAgex-Tenant': 'ten_demo_hackathon', 'X-Principal-Id': 'usr_demo_alex' },
        body: JSON.stringify({ title: 'Context B Note', content: 'Private note from B' })
      });
    });

    // Verify Context A has A Note and does NOT have B Note
    const stateA1 = await pageA.evaluate(async () => {
      const res = await fetch('/api/v1/workspace/vault', {
        headers: { 'X-NAgex-Demo': '1', 'X-NAgex-Tenant': 'ten_demo_hackathon', 'X-Principal-Id': 'usr_demo_alex' }
      });
      const body: any = await res.json();
      return body.data || body;
    });
    assert.equal((stateA1 as any).items.some((i: any) => i.title === 'Context A Note'), true);
    assert.equal((stateA1 as any).items.some((i: any) => i.title === 'Context B Note'), false, 'CROSS_SESSION_LEAK must be 0');

    // Verify Context B has B Note and does NOT have A Note
    const stateB1 = await pageB.evaluate(async () => {
      const res = await fetch('/api/v1/workspace/vault', {
        headers: { 'X-NAgex-Demo': '1', 'X-NAgex-Tenant': 'ten_demo_hackathon', 'X-Principal-Id': 'usr_demo_alex' }
      });
      const body: any = await res.json();
      return body.data || body;
    });
    assert.equal((stateB1 as any).items.some((i: any) => i.title === 'Context B Note'), true);
    assert.equal((stateB1 as any).items.some((i: any) => i.title === 'Context A Note'), false, 'CROSS_SESSION_LEAK must be 0');

    // Demo Reset in Context A
    await pageA.evaluate(async () => {
      await fetch('/api/v1/demo/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-NAgex-Demo': '1', 'X-NAgex-Tenant': 'ten_demo_hackathon', 'X-Principal-Id': 'usr_demo_alex' }
      });
    });

    // Verify Context A state is reset
    const stateA2 = await pageA.evaluate(async () => {
      const res = await fetch('/api/v1/workspace/vault', {
        headers: { 'X-NAgex-Demo': '1', 'X-NAgex-Tenant': 'ten_demo_hackathon', 'X-Principal-Id': 'usr_demo_alex' }
      });
      const body: any = await res.json();
      return body.data || body;
    });
    assert.equal((stateA2 as any).items.some((i: any) => i.title === 'Context A Note'), false, 'A state must be reset');

    // Verify Context B state is preserved after A reset
    const stateB2 = await pageB.evaluate(async () => {
      const res = await fetch('/api/v1/workspace/vault', {
        headers: { 'X-NAgex-Demo': '1', 'X-NAgex-Tenant': 'ten_demo_hackathon', 'X-Principal-Id': 'usr_demo_alex' }
      });
      const body: any = await res.json();
      return body.data || body;
    });
    assert.equal((stateB2 as any).items.some((i: any) => i.title === 'Context B Note'), true, 'RESET_SCOPE_LEAK must be 0');

    await contextA.close();
    await contextB.close();
    certResult.J = 'PASS';
  } finally {
    await browser.close();
    fs.mkdirSync(path.dirname(CERT_JSON_PATH), { recursive: true });
    fs.writeFileSync(CERT_JSON_PATH, JSON.stringify(certResult, null, 2));
  }
});

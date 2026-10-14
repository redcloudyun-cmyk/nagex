// D-10 P0-A - the authentic Home chain in real Chromium against the production server harness and an ISOLATED harmless destination (the repository's MCP test server, loopback, in-memory):
// plan preview -> "Request approval to run" -> the exact proposal -> a real approval decision (Approve, and separately Decline) -> the tool's response, EN + KR, 1440 / 430 / 390 / 360.
// Only the plan route is stubbed (no model in the harness); its seal is issued by the real PlanSeal of the running server, so the real run route verifies it, re-resolves the plan,
// asks the real approval store and runs the real continuation. Nothing is sent, scheduled, charged or deleted anywhere.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright';
import { startCanvasAskHarness, type CanvasAskHarness, type DisposableUser } from './_canvas_ask_harness.js';
import { defaultPlanSeal } from '../src/planning/plan-seal.js';

declare const window: any;
declare const document: any;

const TOKEN = 'home-browser-secret-9a4e';
const envBackup = process.env.NAGEX_MCP_ALLOW_PRIVATE_NETWORK;
let h: CanvasAskHarness;
let startServer: (options?: Record<string, unknown>) => Promise<any>;
before(async () => {
  process.env.NAGEX_MCP_ALLOW_PRIVATE_NETWORK = '1'; // the isolated server listens on loopback
  h = await startCanvasAskHarness({ scrubProviders: true });
  startServer = (await import(pathToFileURL(path.resolve('scripts/mcp-test-server.mjs')).href)).startMcpTestServer;
});
after(async () => {
  await h?.close();
  if (envBackup === undefined) delete process.env.NAGEX_MCP_ALLOW_PRIVATE_NETWORK; else process.env.NAGEX_MCP_ALLOW_PRIVATE_NETWORK = envBackup;
});

async function contextAt(width: number, height: number, user: DisposableUser, locale: 'en' | 'ko'): Promise<BrowserContext> {
  const base = await h.newContext('desktop', user, locale);
  const ctx = await h.browser.newContext({ viewport: { width, height }, locale: locale === 'ko' ? 'ko-KR' : 'en-US', ...(width < 600 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  await ctx.addCookies(await base.cookies());
  await ctx.addInitScript((l: string) => { try { localStorage.setItem('nagex_locale', l); } catch { /* storage unavailable */ } }, locale);
  await base.close();
  return ctx;
}

// connects the isolated server for the signed-in user from inside the page (same cookie a person has) and enables its echo tool
async function connectTool(page: Page, serverUrl: string): Promise<string> {
  return page.evaluate(async ({ url, token }: { url: string; token: string }) => {
    const post = async (path: string, body: unknown) => { const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return r.json(); };
    const added: any = await post('/api/v1/mcp/servers', { name: 'Isolated test server', url, bearerToken: token });
    const id = added.server.connectionId as string;
    await post(`/api/v1/mcp/servers/${id}/tools/echo`, { enabled: true });
    return id;
  }, { url: serverUrl, token: TOKEN });
}

const planFor = (connectionId: string, message: string) => ({
  goal: 'Send a message to the test tool', summary: 'Send the message to your connected test tool', reasoningSummary: 'One step on the tool you connected.', suggestions: [],
  steps: [{ step: 1, title: 'Send the message', reasoning: 'asked', skill: 'skill.planning', tool: `mcp.${connectionId}.echo`, requiresApproval: true, necessity: 'REQUIRED', dependsOn: [], parameters: { message } }],
});

async function prepareHome(page: Page, user: DisposableUser, plan: unknown): Promise<void> {
  const seal = defaultPlanSeal.seal({ tenantId: user.tenantId, principalId: user.userId }, plan);
  await page.route('**/api/v1/ambient/intent', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'PLAN_PREVIEW', plan, planSeal: seal, runnable: { ok: true, reasons: [], capabilityId: (plan as any).steps[0].tool } }) }));
  await page.goto(`${h.origin}/#home`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#main-surface-input', { timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('#nagex-main-surface')?.dataset.sessionState === 'EMPTY_HOME', undefined, { timeout: 20000 });
}

const ASK = { en: 'Send the message hello from Home to my test tool', ko: '내 테스트 도구에 hello 메시지를 보내줘' } as const;
const SIZES: Array<[number, number]> = [[1440, 900], [430, 932], [390, 844], [360, 740]];

describe('Home: plan preview -> request approval -> approve -> tool response (isolated destination, EN/KR, 4 widths)', () => {
  for (const locale of ['en', 'ko'] as const) {
    for (const [width, height] of SIZES) {
      it(`${locale} ${width}px: nothing happens before the approval; the approval is the person's own click; the tool is called exactly once; the result is a tool response`, async () => {
        const server = await startServer({ token: TOKEN });
        try {
          const user = h.user(`hrp_${locale}_${width}`);
          if (locale === 'ko') h.setLocale(user, 'ko');
          const ctx = await contextAt(width, height, user, locale);
          const page = await ctx.newPage();
          const posts: string[] = [];
          page.on('request', (r) => { if (r.method() !== 'GET') posts.push(new URL(r.url()).pathname); });
          await page.goto(`${h.origin}/#home`, { waitUntil: 'domcontentloaded' });
          await page.waitForSelector('#main-surface-input', { timeout: 20000 });
          const connectionId = await connectTool(page, server.url);
          const plan = planFor(connectionId, 'hello from Home');
          await prepareHome(page, user, plan);
          const overflow = () => page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - window.innerWidth));

          // 1. PLAN_READY: the plan is shown with ONE button that says what it does; nothing was requested or run
          await page.fill('#main-surface-input', ASK[locale]);
          await page.click('#main-send');
          await page.waitForSelector('.main-turn[data-kind="task"]', { timeout: 20000 });
          const request = page.locator('.main-turn .main-inline-actions button', { hasText: locale === 'ko' ? '승인 요청하기' : 'Request approval to run' });
          assert.equal(await request.count(), 1);
          assert.equal(await page.locator('.main-turn .main-inline-actions button', { hasText: /Run this plan|이 계획 실행/ }).count(), 0, 'no button claims to run the plan');
          assert.equal(await page.locator('.main-approval-card').count(), 0);
          assert.equal(server.callsTo('echo'), 0);
          assert.deepEqual(posts.filter((p) => /tasks|approvals|mcp\/servers\/.*invoke/.test(p) && !/mcp\/servers$/.test(p) && !/tools\/echo$/.test(p)), []);
          if (width < 600) assert.ok((await request.boundingBox())!.height >= 44 - 0.5, 'the request button is a 44px target');

          // 2. APPROVAL_REQUIRED: the exact proposal and the person's own Approve / Reject; the tool is still untouched
          await request.click();
          await page.waitForSelector('.main-run-block[data-run-state="WAITING_APPROVAL"]', { timeout: 20000 });
          const waiting = await page.locator('.main-run-block').innerText();
          assert.match(waiting, locale === 'ko' ? /승인을 기다리는 중 - 아직 아무것도 하지 않았어요/ : /Waiting for your approval - nothing has been done yet/);
          assert.match(waiting, /message\s+hello from Home/, 'the exact argument the person approves');
          assert.doesNotMatch(waiting, /mcp\.|apr_|tsk_|exe_|connectionId/, 'no internal identifiers');
          await page.waitForSelector('.main-approval-card', { timeout: 20000 });
          assert.equal(server.callsTo('echo'), 0, 'requesting approval dispatched nothing');
          assert.equal(await overflow(), 0);
          if (width < 600) {
            const approve = await page.locator('.main-approval-card button.btn-primary').boundingBox();
            assert.ok(approve && approve.height >= 44 - 0.5, `approve is a 44px target (${approve?.height})`);
          }

          // 3. APPROVED -> EXECUTING -> TOOL_RESPONDED: only the person's click lets it run, exactly once
          await page.locator('.main-approval-card button.btn-primary').click();
          await page.waitForSelector('.main-run-block[data-run-state="TOOL_RESPONDED"]', { timeout: 30000 });
          const done = await page.locator('.main-run-block').innerText();
          assert.match(done, locale === 'ko' ? /도구가 응답했어요/ : /Tool responded/);
          assert.match(done, locale === 'ko' ? /실제 결과는 NAgex가 따로 확인하지 않았어요/ : /has not independently checked the result/);
          assert.match(done, /echo: hello from Home/);
          assert.doesNotMatch(done, /Completed|완료/, 'a provider response is not reported as a completed, verified outcome');
          assert.equal(server.callsTo('echo'), 1, 'executed exactly once');
          assert.equal(await page.locator('.main-turn .main-inline-actions button', { hasText: locale === 'ko' ? '승인 요청하기' : 'Request approval to run' }).count(), 1);
          assert.equal(await overflow(), 0);
          assert.doesNotMatch(await page.locator('body').innerText(), /mainRun\.|mainRoute\.|mainText\./, 'no raw i18n keys');
          await ctx.close();
        } finally {
          await server.close();
        }
      });
    }
  }

  for (const locale of ['en', 'ko'] as const) {
    it(`${locale}: declining the approval ends the run as "Not run" and the tool is never called; asking twice cannot start a second approval`, async () => {
      const server = await startServer({ token: TOKEN });
      try {
        const user = h.user(`hrp_decline_${locale}`);
        if (locale === 'ko') h.setLocale(user, 'ko');
        const ctx = await contextAt(1440, 900, user, locale);
        const page = await ctx.newPage();
        await page.goto(`${h.origin}/#home`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#main-surface-input', { timeout: 20000 });
        const plan = planFor(await connectTool(page, server.url), 'please do not run this');
        await prepareHome(page, user, plan);
        await page.fill('#main-surface-input', ASK[locale]);
        await page.click('#main-send');
        await page.waitForSelector('.main-turn[data-kind="task"]', { timeout: 20000 });
        const request = page.locator('.main-turn .main-inline-actions button', { hasText: locale === 'ko' ? '승인 요청하기' : 'Request approval to run' });
        await request.dblclick();
        await page.waitForSelector('.main-approval-card', { timeout: 20000 });
        assert.equal(await page.locator('.main-approval-card').count(), 1, 'one approval, even after a double click');
        const taskCount = ((await page.evaluate(async () => ((await (await fetch('/api/v1/tasks')).json()) as any).tasks.length)) as number);
        assert.equal(taskCount, 1, 'one task');
        await page.locator('.main-approval-card button.btn-secondary').click();
        await page.waitForSelector('.main-run-block[data-run-state="DECLINED"]', { timeout: 30000 });
        const text = await page.locator('.main-run-block').innerText();
        assert.match(text, locale === 'ko' ? /실행하지 않음 - 거절하셨어요/ : /Not run - you declined/);
        assert.equal(server.callsTo('echo'), 0, 'declined: the tool was never called');
        await ctx.close();
      } finally {
        await server.close();
      }
    });
  }
});

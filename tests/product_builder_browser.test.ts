// AI Product Builder through the whole product, in REAL Chromium against the PRODUCTION server: the person types "build me a customer management website ..." in Main; NAgex plans it, and the person decides
// at four gates - the PLAN, the DESIGN (with generated pictures), the BUILD and the DEPLOYMENT. Between the gates NAgex builds the site in an isolated workspace, tests it in an isolated browser, shows a sandboxed
// preview and - only after the last approval - deploys it and opens the address to check it.
//
// What is real: the production server and composition root, routes, the Approval Authority, the persistent project state, the Model Gateway call path, the Google image adapter (HTTP), the isolated Playwright
// tester, the sandboxed preview route, the deploy verifier, the Vercel adapter (HTTP), and the Main UI in Chromium.
// What is a STAND-IN (this file proves NAgex's chain, not a vendor's service): the model (tests/_local_ai_world.ts answers the planner / designer / engine prompts with a fixed customer-management site),
// the image endpoint (answers a tiny PNG, or a quota error), and the hosting service (a local server that follows the documented shape of Vercel's deployment API and serves the files it was given).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright';
import { startCanvasAskHarness, type CanvasAskHarness, type DisposableUser } from './_canvas_ask_harness.js';
import { startLocalAiWorld, type LocalAiWorld } from './_local_ai_world.js';
import { SITE_REQUEST_EN, SITE_REQUEST_KO, brokenProductSiteAnswer, productSiteAnswer } from './_product_site_fixture.js';

declare const document: any;
declare const window: any;

const VERCEL_TOKEN = 'e2e-vercel-token-not-a-secret-0123456789';

interface HostingStandIn { url: string; origin: string; deployments: Array<{ authorization: string | undefined; body: any }>; close(): Promise<void> }

/** A local server that speaks the documented shape of Vercel's deployment API, and serves the deployed files at its own address. */
async function startHostingStandIn(): Promise<HostingStandIn> {
  const files = new Map<string, Buffer>();
  const deployments: HostingStandIn['deployments'] = [];
  let origin = '';
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://stand-in');
    const json = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/v13/deployments' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        if (req.headers.authorization !== `Bearer ${VERCEL_TOKEN}`) return json(401, { error: { code: 'forbidden', message: 'Not authorized' } });
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        deployments.push({ authorization: req.headers.authorization, body });
        files.clear();
        for (const f of body.files) files.set(f.file, Buffer.from(f.data, f.encoding === 'base64' ? 'base64' : 'utf8'));
        json(200, { id: 'dpl_e2e_1', url: 'e2e-site-abc123.vercel.app', alias: [origin.replace('http://', '')], readyState: 'QUEUED' });
      });
      return;
    }
    if (url.pathname.startsWith('/v13/deployments/') && req.method === 'GET') return json(200, { id: 'dpl_e2e_1', url: 'e2e-site-abc123.vercel.app', alias: [origin.replace('http://', '')], readyState: 'READY' });
    // the deployed site
    const rel = url.pathname.replace(/^\/+/, '') || 'index.html';
    const data = files.get(rel);
    if (!data) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': rel.endsWith('.html') ? 'text/html; charset=utf-8' : rel.endsWith('.js') ? 'text/javascript' : 'text/css' });
    res.end(data);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url: origin, origin, deployments, close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); }) };
}

let h: CanvasAskHarness;
let world: LocalAiWorld;
let hosting: HostingStandIn;

before(async () => {
  world = await startLocalAiWorld();
  hosting = await startHostingStandIn();
  h = await startCanvasAskHarness({
    scrubProviders: true,
    env: {
      ...world.env,
      // the image endpoint is the local world (the Google image adapter's own HTTP path); the hosting account is the local stand-in
      NAGEX_GOOGLE_API_KEY: 'local-fake-image-key-not-a-secret',
      NAGEX_IMAGE_GOOGLE_BASE_URL: world.env.NAGEX_NEBIUS_BASE_URL.replace(/\/v1$/, '/v1beta'),
      NAGEX_VERCEL_TOKEN: VERCEL_TOKEN,
      NAGEX_VERCEL_API_BASE: hosting.url,
    },
  });
});
after(async () => {
  await h?.close();
  await world?.close();
  await hosting?.close();
});

async function contextFor(label: string, locale: 'en' | 'ko', width = 1280): Promise<{ ctx: BrowserContext; user: DisposableUser }> {
  const user = h.user(label);
  if (locale === 'ko') h.setLocale(user, 'ko');
  const base = await h.newContext('desktop', user, locale);
  const ctx = await h.browser.newContext({ viewport: { width, height: width < 600 ? 844 : 900 }, locale: locale === 'ko' ? 'ko-KR' : 'en-US', ...(width < 600 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  await ctx.addCookies(await base.cookies());
  await ctx.addInitScript((l: string) => { try { localStorage.setItem('nagex_locale', l); } catch { /* storage unavailable */ } }, locale);
  await base.close();
  return { ctx, user };
}

async function openHome(page: Page): Promise<void> {
  await page.goto(`${h.origin}/#home`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#main-surface-input', { timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('#nagex-main-surface')?.dataset.sessionState === 'EMPTY_HOME', undefined, { timeout: 20000 });
}
const ask = async (page: Page, text: string) => { await page.fill('#main-surface-input', text); await page.click('#main-send'); };
const card = (page: Page) => page.locator('.main-pb-block').last();
const cardText = (page: Page) => card(page).innerText();

async function projects(ctx: BrowserContext): Promise<any[]> {
  return (await (await ctx.request.get(`${h.origin}/api/v1/product-builder/projects`)).json()).projects ?? [];
}

async function waitProject(page: Page, state: string, timeout = 90000): Promise<void> {
  try {
    await page.waitForFunction((s: string) => { const b = document.querySelectorAll('.main-pb-block'); return b.length > 0 && b[b.length - 1].getAttribute('data-task-state') === s; }, state, { timeout });
  } catch (error) {
    let where = '';
    try {
      const list = await projects(page.context());
      const cards = await page.evaluate(() => (Array.from(document.querySelectorAll('.main-pb-block')) as any[]).map((b) => `${b.getAttribute('data-task-state')}: ${String(b.innerText).replace(/\s+/g, ' ').slice(0, 300)}`));
      where = ` | WAITED_FOR=${state} SERVER=${JSON.stringify(list.map((p) => ({ state: p.state, blocker: p.blocker, failure: p.failure, deploy: p.deploy && { url: p.deploy.url, verification: p.deploy.verification }, test: p.test && p.test.checks.filter((c: any) => !c.passed), history: p.history.slice(-5).map((e: any) => e.event) })))} CARDS=${JSON.stringify(cards)} WORLD=${JSON.stringify(world.productBuilderCalls())}`;
    } catch (inner) { where = ` | (no diagnostics: ${inner instanceof Error ? inner.message : String(inner)})`; }
    throw new Error(`${error instanceof Error ? error.message : String(error)}${where}`);
  }
}

// NAGEX_PRODUCT_BUILDER_SHOTS_DIR=<dir> keeps a picture of the card at each decision (for the evidence document); without it nothing is written
const SHOTS_DIR = process.env.NAGEX_PRODUCT_BUILDER_SHOTS_DIR ? path.resolve(process.env.NAGEX_PRODUCT_BUILDER_SHOTS_DIR) : null;
async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS_DIR) return;
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  // a viewport taller than the card, so the page's own sticky header and composer cannot cover it in the picture
  const original = page.viewportSize() ?? { width: 1280, height: 900 };
  const box = await card(page).boundingBox();
  await page.setViewportSize({ width: original.width, height: Math.max(original.height, Math.ceil((box?.height ?? 0) + 900)) });
  await page.waitForTimeout(300);
  await card(page).scrollIntoViewIfNeeded();
  await card(page).screenshot({ path: path.join(SHOTS_DIR, `${name}.png`) });
  await page.setViewportSize(original);
}
const approve = (page: Page, gate: 'PLAN' | 'DESIGN' | 'BUILD' | 'DEPLOY') => page.click(`.main-pb-block .main-pb-decision[data-gate="${gate}"] .main-pb-approve`);
const NO_TECHNICAL_TEXT = /mainProduct\.|PRODUCT_|IMAGE_QUOTA|PROVIDER_|undefined|\[object|NaN|pbp_[0-9a-f]{6}|nagex-build/;
const noSidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

describe('build a customer management website: four gates, each decided by the person', () => {
  it('en: plan -> [approve] -> pictures + design -> [approve] -> build plan -> [approve] -> built and tested -> sandboxed preview -> deployment target -> [approve] -> deployed and verified', { timeout: 300000 }, async () => {
    world.setProductBuilder({ engine: null, images: 'ok' });
    const before = world.productBuilderCalls();
    const { ctx } = await contextFor('pb_en_full', 'en');
    const page = await ctx.newPage();
    await openHome(page);
    await ask(page, SITE_REQUEST_EN);

    // ---- Gate 1: the plan. Nothing else has happened: no picture was asked for, no code written, nothing deployed
    await page.waitForSelector('.main-pb-block', { timeout: 30000 });
    await waitProject(page, 'PLAN_PENDING_APPROVAL');
    let text = await cardText(page);
    assert.match(text, /customer management website/i);
    assert.match(text, /Customer records/);
    assert.match(text, /Not included/);
    assert.match(text, /A server or database/);
    assert.match(text, /asks google for 3 visual mockups/i, 'what approving sets going is stated, with the provider');
    assert.doesNotMatch(text, NO_TECHNICAL_TEXT);
    assert.deepEqual(world.productBuilderCalls(), before, 'no picture requested, no file written before the plan is approved');
    await shot(page, '1-plan-gate');
    assert.equal(hosting.deployments.length, 0);
    await approve(page, 'PLAN');

    // ---- Gate 2: real pictures + the design
    await waitProject(page, 'DESIGN_PENDING_APPROVAL');
    text = await cardText(page);
    assert.equal(await page.locator('.main-pb-block .main-pb-mockup img').count(), 3);
    await page.waitForFunction(() => Array.from(document.querySelectorAll('.main-pb-mockup img')).every((i: any) => i.complete && i.naturalWidth > 0), undefined, { timeout: 15000 });
    assert.match(text, /Visual mockups/);
    assert.match(text, /Layout/);
    assert.match(text, /summary cards/);
    assert.doesNotMatch(text, NO_TECHNICAL_TEXT);
    assert.equal(world.productBuilderCalls().images - before.images, 3);
    assert.equal(world.productBuilderCalls().engine - before.engine, 0, 'still no code');
    await shot(page, '2-design-gate');
    await approve(page, 'DESIGN');

    // ---- Gate 3: the build plan freezes the scope
    await waitProject(page, 'BUILD_PLAN_PENDING_APPROVAL');
    text = await cardText(page);
    assert.match(text, /Built by/);
    assert.match(text, /one-shot static-site generator/i);
    assert.match(text, /Static HTML, CSS and JavaScript/);
    assert.match(text, /Searching by name narrows the list/);
    assert.match(text, /Approving lets NAgex/);
    assert.match(text, /run generated commands or install anything on this computer/);
    assert.match(text, /Fixed for this approval: plan v1, design v1, build plan v1/);
    assert.equal(world.productBuilderCalls().engine - before.engine, 0, 'still no code before the build is approved');
    await shot(page, '3-build-gate');
    await approve(page, 'BUILD');

    // ---- built in the isolated workspace, tested in the isolated browser, preview ready - and NOTHING is online
    await waitProject(page, 'PREVIEW_READY', 120000);
    text = await cardText(page);
    assert.equal(world.productBuilderCalls().engine - before.engine, 1);
    assert.match(text, /all passed/);
    assert.match(text, /The customer table is shown/);
    assert.match(text, /Searching by name narrows the list/);
    assert.match(text, /No sideways scrolling at 390px/);
    assert.equal(await page.locator('.main-pb-block .main-pb-shot img').count(), 3);
    assert.equal(hosting.deployments.length, 0, 'nothing is deployed before the deployment is approved');
    await shot(page, '4-preview-ready');

    // the sandboxed preview: the site works, and it has NO access to NAgex
    await page.click('.main-pb-open-preview');
    await page.waitForSelector('iframe.main-pb-preview', { timeout: 15000 });
    await page.waitForFunction(() => (window as any).frames.length > 0, undefined, { timeout: 15000 });
    const frame = page.frames().find((f) => f.url().includes('/api/v1/product-builder/preview/'));
    assert.ok(frame, 'the preview frame loaded from the signed preview path');
    await frame!.waitForSelector('#customer-table', { timeout: 15000 });
    assert.match(await frame!.innerText('body'), /Hanbit Trading/);
    await frame!.fill('#search', 'han');
    await frame!.waitForFunction("!document.body.innerText.includes('Daon Studio')", undefined, { timeout: 5000 });
    assert.match(await frame!.innerText('body'), /Hanbit Trading/);
    const reach = await frame!.evaluate("(() => { const out = {}; try { out.parent = String(window.parent.document.title); } catch (e) { out.parent = 'BLOCKED:' + e.name; } try { out.cookie = String(document.cookie); } catch (e) { out.cookie = 'BLOCKED:' + e.name; } try { out.storage = String(window.localStorage.length); } catch (e) { out.storage = 'BLOCKED:' + e.name; } return out; })()") as Record<string, string>;
    assert.match(reach.parent, /^BLOCKED:SecurityError/, 'the preview cannot read the NAgex page');
    assert.match(reach.cookie, /^BLOCKED:SecurityError/, 'the preview cannot read cookies');
    assert.match(reach.storage, /^BLOCKED:SecurityError/, 'the preview has no access to NAgex storage');

    // ---- Gate 4: asking to put it online shows exactly where, and sends nothing
    assert.equal(await page.locator('.main-pb-appname').count(), 1);
    await page.fill('.main-pb-appname', 'customer-hub');
    await page.click('.main-pb-deploy-request');
    await waitProject(page, 'DEPLOY_PENDING_APPROVAL');
    text = await cardText(page);
    assert.match(text, /Vercel/);
    assert.match(text, /customer-hub/);
    assert.match(text, /Anyone who has the address/);
    assert.match(text, /NAgex does not control or limit it/);
    assert.match(text, /How to undo/);
    assert.match(text, /3 files - exactly the tested preview/);
    assert.equal(hosting.deployments.length, 0, 'asking to deploy deploys nothing');
    await shot(page, '5-deploy-gate');
    await approve(page, 'DEPLOY');

    await waitProject(page, 'DEPLOYED_VERIFIED', 120000);
    text = await cardText(page);
    assert.match(text, /Online - and checked at its address/);
    assert.match(text, /Checked just now: the address answers \(HTTP 200\)/);
    await shot(page, '6-deployed-verified');
    const link = await page.locator('.main-pb-url').getAttribute('href');
    assert.equal(link, `${hosting.origin}/`);
    assert.equal(hosting.deployments.length, 1, 'exactly one deployment was sent');
    assert.equal(hosting.deployments[0].authorization, `Bearer ${VERCEL_TOKEN}`);
    assert.equal(hosting.deployments[0].body.name, 'customer-hub');
    assert.equal(hosting.deployments[0].body.target, 'production');
    assert.deepEqual(hosting.deployments[0].body.files.map((f: any) => f.file).sort(), ['css/site.css', 'index.html', 'js/app.js']);
    const served = await (await fetch(link!)).text();
    assert.match(served, /<meta name="nagex-build" content="nagex-build-/, 'the deployed copy carries the marker NAgex stamped');
    assert.doesNotMatch(await page.content(), new RegExp(VERCEL_TOKEN), 'the token is nowhere in the page');

    // ---- the record behind the card: four gates passed, each approval used exactly once, history in order
    const [project] = await projects(ctx);
    assert.equal(project.state, 'DEPLOYED_VERIFIED');
    assert.deepEqual(project.passedGates.map((g: any) => g.gate), ['PLAN', 'DESIGN', 'BUILD', 'DEPLOY']);
    for (const gate of ['PLAN', 'DESIGN', 'BUILD', 'DEPLOY']) assert.equal(project.gates[gate].status, 'CONSUMED', `${gate} approval was used exactly once`);
    assert.equal(project.deploy.verification.markerFound, true);
    assert.equal(project.deploy.verification.smokePassed, true);
    const events = project.history.map((e: any) => e.event);
    for (const [a, b] of [['PLAN_GATE_PASSED', 'MOCKUPS_AND_DESIGN_READY'], ['DESIGN_GATE_PASSED', 'BUILD_PLAN_DRAFTED'], ['BUILD_GATE_PASSED', 'IMPLEMENTED'], ['DEPLOY_REQUESTED', 'DEPLOY_GATE_PASSED'], ['DEPLOY_GATE_PASSED', 'DEPLOYMENT_VERIFIED']]) {
      assert.ok(events.indexOf(a) >= 0 && events.indexOf(b) > events.indexOf(a), `${a} before ${b}`);
    }
    await ctx.close();
  });

  it('ko: the same journey reads in Korean - states, the plan, the consequences and the decisions - and nothing overflows on a phone', { timeout: 240000 }, async () => {
    world.setProductBuilder({ engine: null, images: 'ok' });
    const engineAtStart = world.productBuilderCalls().engine;
    const { ctx } = await contextFor('pb_ko', 'ko', 390);
    const page = await ctx.newPage();
    await openHome(page);
    await ask(page, SITE_REQUEST_KO);
    await waitProject(page, 'PLAN_PENDING_APPROVAL');
    let text = await cardText(page);
    assert.match(text, /계획이 준비됐어요 - 승인을 기다리는 중/);
    assert.match(text, /고객 관리 웹사이트/);
    assert.match(text, /google에 이 계획의 시안 그림 3장을 요청해요/);
    assert.match(text, /포함하지 않는 것/);
    assert.match(text, /계획 승인/);
    assert.match(text, /수정 요청/);
    assert.doesNotMatch(text, NO_TECHNICAL_TEXT);
    assert.equal(await noSidewaysScroll(page), true, 'the plan card fits a 390 px phone');
    await shot(page, '7-ko-phone-plan-gate');
    await approve(page, 'PLAN');
    await waitProject(page, 'DESIGN_PENDING_APPROVAL');
    text = await cardText(page);
    assert.match(text, /시안 그림/);
    assert.match(text, /디자인 승인/);
    assert.doesNotMatch(text, NO_TECHNICAL_TEXT);
    assert.equal(await noSidewaysScroll(page), true, 'the design card fits a phone');
    // declining changes nothing and says so; the person can still ask for changes
    await page.click('.main-pb-block .main-pb-decision[data-gate="DESIGN"] .main-pb-decline');
    await page.waitForSelector('.main-pb-declined', { timeout: 15000 });
    assert.match(await cardText(page), /거절하셨어요/);
    assert.equal(world.productBuilderCalls().engine, engineAtStart, 'declining built nothing');
    await ctx.close();
  });

  it('a refresh brings the unfinished project back at the same step, and the decision still works', { timeout: 240000 }, async () => {
    world.setProductBuilder({ engine: null, images: 'ok' });
    const { ctx } = await contextFor('pb_refresh', 'en');
    const page = await ctx.newPage();
    await openHome(page);
    await ask(page, SITE_REQUEST_EN);
    await waitProject(page, 'PLAN_PENDING_APPROVAL');
    const [before] = await projects(ctx);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.main-pb-block', { timeout: 30000 });
    await waitProject(page, 'PLAN_PENDING_APPROVAL', 30000);
    assert.equal(await page.locator('.main-pb-block').count(), 1);
    assert.match(await cardText(page), /customer management website/i);
    assert.equal((await projects(ctx)).length, 1, 'the refresh did not start a second project');
    await approve(page, 'PLAN');
    await waitProject(page, 'DESIGN_PENDING_APPROVAL');
    assert.equal((await projects(ctx))[0].projectId, before.projectId);
    // a finished (cancelled) project is not brought back
    await page.click('.main-pb-block .main-pb-decision[data-gate="DESIGN"] .main-pb-change');
    await ctx.request.post(`${h.origin}/api/v1/product-builder/projects/${before.projectId}/cancel`, { data: {} });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#main-surface-input', { timeout: 20000 });
    await page.waitForTimeout(1500);
    assert.equal(await page.locator('.main-pb-block').count(), 0, 'a cancelled project does not come back');
    await ctx.close();
  });

  it('a change request makes a NEW version that needs a NEW approval (the plan can be changed again from the build plan)', { timeout: 240000 }, async () => {
    world.setProductBuilder({ engine: null, images: 'ok' });
    const { ctx } = await contextFor('pb_revise', 'en');
    const page = await ctx.newPage();
    await openHome(page);
    await ask(page, SITE_REQUEST_EN);
    await waitProject(page, 'PLAN_PENDING_APPROVAL');
    const [first] = await projects(ctx);
    await page.click('.main-pb-decision[data-gate="PLAN"] .main-pb-change');
    await page.fill('.main-pb-decision[data-gate="PLAN"] .main-pb-change-input', 'add an invoices page');
    await page.click('.main-pb-decision[data-gate="PLAN"] .main-pb-send-changes');
    await page.waitForFunction((v: number) => /Version 2/.test(document.querySelector('.main-pb-block')?.innerText ?? ''), 1, { timeout: 30000 });
    const [second] = await projects(ctx);
    assert.equal(second.plan.version, 2);
    assert.notEqual(second.gates.PLAN.approvalId, first.gates.PLAN.approvalId, 'a new approval for the new version');
    assert.equal(second.gates.PLAN.status, 'PENDING');
    // the first approval can no longer be used by anyone
    const stale = await ctx.request.post(`${h.origin}/api/v1/approvals/${first.gates.PLAN.approvalId}/approve`, { data: {} });
    assert.ok(stale.status() >= 400, `the superseded approval is dead (HTTP ${stale.status()})`);
    assert.equal((await projects(ctx))[0].state, 'PLAN_PENDING_APPROVAL');
    // approving version 2 moves on
    await approve(page, 'PLAN');
    await waitProject(page, 'DESIGN_PENDING_APPROVAL');
    assert.equal((await projects(ctx))[0].passedGates[0].version, 2);
    await ctx.close();
  });
});

describe('what cannot be done stops at the right gate with the reason', () => {
  it('image quota: the project is BLOCKED after the plan is approved, with the provider\'s reason, no pictures, no code - and continues when the quota is back', { timeout: 240000 }, async () => {
    world.setProductBuilder({ engine: null, images: 'quota' });
    const before = world.productBuilderCalls();
    const { ctx } = await contextFor('pb_quota', 'en');
    const page = await ctx.newPage();
    await openHome(page);
    await ask(page, SITE_REQUEST_EN);
    await waitProject(page, 'PLAN_PENDING_APPROVAL');
    await approve(page, 'PLAN');
    await waitProject(page, 'BLOCKED');
    const text = await cardText(page);
    assert.match(text, /The image service has no quota left for pictures/);
    await shot(page, '8-blocked-image-quota');
    assert.match(text, /Stopped - something is needed first/);
    assert.equal(await page.locator('.main-pb-block .main-pb-mockup').count(), 0, 'no picture was invented');
    assert.equal(world.productBuilderCalls().images - before.images, 1, 'the series stopped at the first failure');
    assert.equal(world.productBuilderCalls().engine - before.engine, 0);
    const [blocked] = await projects(ctx);
    assert.deepEqual([blocked.blocker.code, blocked.blocker.need, blocked.blocker.blockedAt], ['IMAGE_QUOTA_EXCEEDED', 'QUOTA', 'MOCKUP_GENERATING']);
    assert.equal(await page.locator('.main-pb-use-provider').count(), 0, 'there is no other authorized provider to offer');

    world.setProductBuilder({ images: 'ok' });
    await page.click('.main-pb-resolve');
    await waitProject(page, 'DESIGN_PENDING_APPROVAL');
    assert.equal(await page.locator('.main-pb-block .main-pb-mockup img').count(), 3);
    assert.equal(world.productBuilderCalls().engine - before.engine, 0);
    await ctx.close();
  });

  it('a product that fails its own checks is sent back with what failed; the repaired one is previewed (one repair, then it passes)', { timeout: 300000 }, async () => {
    const before = world.productBuilderCalls();
    // the first engine answer of THIS journey is the broken site; the repair gets the good one
    world.setProductBuilder({ engine: (_user, attempt) => (attempt - before.engine === 1 ? brokenProductSiteAnswer() : productSiteAnswer()), images: 'ok' });
    const { ctx } = await contextFor('pb_repair', 'en');
    const page = await ctx.newPage();
    await openHome(page);
    await ask(page, SITE_REQUEST_EN);
    await waitProject(page, 'PLAN_PENDING_APPROVAL');
    await approve(page, 'PLAN');
    await waitProject(page, 'DESIGN_PENDING_APPROVAL');
    await approve(page, 'DESIGN');
    await waitProject(page, 'BUILD_PLAN_PENDING_APPROVAL');
    await approve(page, 'BUILD');
    await waitProject(page, 'PREVIEW_READY', 180000);
    assert.equal(world.productBuilderCalls().engine - before.engine, 2, 'built, failed its checks, repaired');
    const [project] = await projects(ctx);
    const events = project.history.map((e: any) => e.event);
    assert.ok(events.includes('TESTS_FAILED_REPAIRING'));
    assert.equal(project.test.passed, true);
    assert.equal(project.repairAttempts, 1);
    // the second engine prompt carried what failed and the previous files
    const prompts = world.modelRequests.filter((r) => r.kind === 'product-engine').slice(-2);
    assert.match(prompts[1].user, /WHAT FAILED/);
    assert.match(prompts[1].user, /Searching by name narrows the list/);
    assert.match(prompts[1].user, /PREVIOUS ATTEMPT/);
    await ctx.close();
  });
});

describe('ownership and the sandbox: someone else\'s project is as absent as one that never existed', () => {
  it('another person can read, decide, preview or fetch nothing of it; the signed preview link is the only way in, and it is sandboxed', { timeout: 240000 }, async () => {
    world.setProductBuilder({ engine: null, images: 'ok' });
    const { ctx } = await contextFor('pb_owner', 'en');
    const page = await ctx.newPage();
    await openHome(page);
    await ask(page, SITE_REQUEST_EN);
    await waitProject(page, 'PLAN_PENDING_APPROVAL');
    await approve(page, 'PLAN');
    await waitProject(page, 'DESIGN_PENDING_APPROVAL');
    await approve(page, 'DESIGN');
    await waitProject(page, 'BUILD_PLAN_PENDING_APPROVAL');
    await approve(page, 'BUILD');
    await waitProject(page, 'PREVIEW_READY', 120000);
    const [mine] = await projects(ctx);
    const base = `${h.origin}/api/v1/product-builder/projects/${mine.projectId}`;

    const { ctx: other } = await contextFor('pb_stranger', 'en');
    const get = async (c: BrowserContext, url: string, method: 'get' | 'post' = 'get') => (method === 'get' ? c.request.get(url) : c.request.post(url, { data: {} })).then((r) => r.status());
    assert.equal(await get(ctx, base), 200);
    for (const [url, method] of [
      [base, 'get'], [`${base}/mockups/${mine.mockups.items[0].fileName}`, 'get'], [`${base}/screenshots/${mine.test.screenshots[0].url.split('/').pop()}`, 'get'],
      [`${base}/preview-link`, 'post'], [`${base}/gates/DEPLOY/approve`, 'post'], [`${base}/gates/PLAN/revise`, 'post'], [`${base}/deploy-request`, 'post'], [`${base}/resolve`, 'post'], [`${base}/cancel`, 'post'],
    ] as Array<[string, 'get' | 'post']>) {
      assert.equal(await get(other, url, method), 404, `${method.toUpperCase()} ${url.replace(h.origin, '')} is a 404 for someone else`);
    }
    assert.deepEqual(await projects(other), [], 'the stranger sees no projects');
    assert.equal(await get(ctx, `${base}/mockups/${mine.mockups.items[0].fileName}`), 200, 'the owner can see her own pictures');
    assert.equal((await projects(ctx))[0].state, 'PREVIEW_READY', 'nothing happened to the project');

    // anonymous: refused before any handler
    assert.equal((await fetch(`${h.origin}/api/v1/product-builder/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request: SITE_REQUEST_EN }) })).status, 401);
    assert.equal((await fetch(`${h.origin}/api/v1/product-builder/projects`)).status, 401);

    // the signed link: works without a session (the sandboxed frame sends none), is sandboxed, and cannot be forged or walked out of
    const link = await (await ctx.request.post(`${base}/preview-link`, { data: {} })).json();
    assert.match(link.url, /^\/api\/v1\/product-builder\/preview\/[^/]+\/$/);
    const served = await fetch(`${h.origin}${link.url}`);
    assert.equal(served.status, 200);
    const csp = served.headers.get('content-security-policy') ?? '';
    assert.match(csp, /^sandbox allow-scripts allow-forms;/);
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /frame-ancestors 'self'/);
    assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
    assert.match(await served.text(), /Customer Hub/);
    assert.equal((await fetch(`${h.origin}${link.url}js/app.js`)).status, 200);
    assert.match((await fetch(`${h.origin}${link.url}js/app.js`)).headers.get('content-type') ?? '', /javascript/);
    const token = link.url.split('/')[5];
    const forged = `${token.slice(0, -2)}${token.endsWith('AA') ? 'BB' : 'AA'}`;
    assert.equal((await fetch(`${h.origin}/api/v1/product-builder/preview/${forged}/`)).status, 404, 'a tampered link shows nothing');
    assert.equal((await fetch(`${h.origin}/api/v1/product-builder/preview/not-a-token/`)).status, 404);
    for (const walk of ['..%2f..%2f..%2fpackage.json', '%2e%2e%2f%2e%2e%2fpackage.json', '..%5c..%5cpackage.json', '.env', 'index.html%00.js']) {
      assert.equal((await fetch(`${h.origin}${link.url}${walk}`)).status, 404, `${walk} is a 404`);
    }
    // only GET / HEAD are public on the preview path; anything else needs a session like every other route
    assert.equal((await fetch(`${h.origin}${link.url}`, { method: 'POST', body: '{}' })).status, 401);
    await other.close();
    await ctx.close();
  });
});

// Goal-driven adaptive execution through the WHOLE product, in REAL Chromium against the PRODUCTION server: "Generate a website mockup for the approved customer management product" when the first image
// provider's quota is gone. The real Google image adapter gets a real quota answer (HTTP 429 RESOURCE_EXHAUSTED) and is classified; the other registered image routes are discovered from the real
// registry (OpenAI and the local GPU endpoint are not configured and are filtered out with a reason; NVIDIA NIM is configured); the person approves the new route through the Approval Authority; the real
// NVIDIA NIM adapter speaks its real wire to a local stand-in, its bytes are verified, stored and shown, and the project reaches the design decision. The ledger remembers the exhausted account, so the
// next project does not start by calling it.
//
// STAND-INS (this file certifies NAgex's chain, not a vendor's service): the Google and NVIDIA image endpoints are local servers (tests/_local_ai_world.ts) and the model is the local deterministic one.
// No real image provider, key or money is involved. The tests in this file depend on each other IN ORDER: the exhausted account stays out for the cool-down within the server's life.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright';
import { startCanvasAskHarness, type CanvasAskHarness, type DisposableUser } from './_canvas_ask_harness.js';
import { startLocalAiWorld, type LocalAiWorld } from './_local_ai_world.js';
import { SITE_REQUEST_EN, SITE_REQUEST_KO } from './_product_site_fixture.js';

declare const document: any;
declare const window: any;

let h: CanvasAskHarness;
let world: LocalAiWorld;

before(async () => {
  world = await startLocalAiWorld();
  const modelBase = world.env.NAGEX_NEBIUS_BASE_URL.replace(/\/v1$/, '');
  h = await startCanvasAskHarness({
    scrubProviders: true,
    env: {
      ...world.env,
      // image routes: Google (the primary, its endpoint is the local world) and NVIDIA NIM (its real wire, to the local world); OpenAI and the local GPU endpoint stay unconfigured on purpose
      NAGEX_GOOGLE_API_KEY: 'local-fake-image-key-not-a-secret',
      NAGEX_IMAGE_GOOGLE_BASE_URL: `${modelBase}/v1beta`,
      NAGEX_NIM_API_KEY: 'local-fake-nim-key-not-a-secret',
      NAGEX_NIM_IMAGE_ENDPOINT: `${modelBase}/nim/v1/genai/flux`,
    },
  });
});
after(async () => { await h?.close(); await world?.close(); });

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
const projects = async (ctx: BrowserContext): Promise<any[]> => (await (await ctx.request.get(`${h.origin}/api/v1/product-builder/projects`)).json()).projects ?? [];
const approve = (page: Page, gate: 'PLAN' | 'DESIGN') => page.click(`.main-pb-block .main-pb-decision[data-gate="${gate}"] .main-pb-approve`);
async function waitProject(page: Page, state: string, timeout = 60000): Promise<void> {
  try {
    await page.waitForFunction((s: string) => { const b = document.querySelectorAll('.main-pb-block'); return b.length > 0 && b[b.length - 1].getAttribute('data-task-state') === s; }, state, { timeout });
  } catch (error) {
    const list = await projects(page.context()).catch(() => []);
    throw new Error(`${error instanceof Error ? error.message : String(error)} | WAITED_FOR=${state} SERVER=${JSON.stringify(list.map((p: any) => ({ state: p.state, blocker: p.blocker, recovery: p.recovery && { class: p.recovery.failureClass, decision: p.recovery.decision, options: p.recovery.options.map((o: any) => o.providerId) }, history: p.routeHistory?.map((a: any) => `${a.provider}:${a.outcome}`) })))} WORLD=${JSON.stringify(world.productBuilderCalls())}`);
  }
}
const SHOTS_DIR = process.env.NAGEX_PRODUCT_BUILDER_SHOTS_DIR ? path.resolve(process.env.NAGEX_PRODUCT_BUILDER_SHOTS_DIR) : null;
async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS_DIR) return;
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  const original = page.viewportSize() ?? { width: 1280, height: 900 };
  const box = await card(page).boundingBox();
  await page.setViewportSize({ width: original.width, height: Math.max(original.height, Math.ceil((box?.height ?? 0) + 900)) });
  await page.waitForTimeout(300);
  await card(page).scrollIntoViewIfNeeded();
  await card(page).screenshot({ path: path.join(SHOTS_DIR, `${name}.png`) });
  await page.setViewportSize(original);
}
const NO_TECHNICAL_TEXT = /mainProduct\.|PRODUCT_|IMAGE_QUOTA|PROVIDER_|QUOTA_EXHAUSTED|NEW_THIRD_PARTY|COST_UNKNOWN|undefined|\[object|NaN|pbp_[0-9a-f]{6}|adaptive\.|routeId|IMAGE_GENERATION:/;

describe('the first image provider has no quota: the goal goes on', () => {
  it('en: classified, the other routes discovered and filtered, the person approves the new one, the bytes are verified, the project reaches the design decision', { timeout: 240000 }, async () => {
    world.setProductBuilder({ engine: null, images: 'quota', nim: 'ok' });
    const before = world.productBuilderCalls();
    const { ctx } = await contextFor('adp_en', 'en');
    const page = await ctx.newPage();
    await openHome(page);
    await ask(page, SITE_REQUEST_EN);
    await waitProject(page, 'PLAN_PENDING_APPROVAL');
    assert.match(await cardText(page), /asks google for 3 visual mockups/i, 'the plan gate names the route that will be tried first');
    await approve(page, 'PLAN');

    // PROVIDER_FAILURE_CLASSIFICATION, ALTERNATIVE_DISCOVERY, ELIGIBILITY_FILTERING: read from the real registry
    await waitProject(page, 'BLOCKED');
    const text = await cardText(page);
    assert.match(text, /The image service has no quota left for pictures/);
    assert.match(text, /The service has no quota left\./, 'the normalized class in plain words');
    assert.match(text, /Another service can make the pictures\. It changes something for you, so it only happens if you approve it/);
    assert.match(text, /NVIDIA/);
    assert.match(text, /A different company would receive your plan's description/);
    assert.match(text, /Its price is not known/);
    assert.match(text, /Ordered by NAgex's own rules/);
    assert.match(text, /What was tried \(1\)/);
    assert.doesNotMatch(text, NO_TECHNICAL_TEXT);
    assert.equal(await page.locator('.main-pb-block .main-pb-use-route').count(), 1, 'exactly one route is eligible: NVIDIA');
    await shot(page, '9-adaptive-route-decision');
    const [blocked] = await projects(ctx);
    assert.equal(blocked.recovery.failureClass, 'QUOTA_EXHAUSTED');
    assert.deepEqual(blocked.recovery.options.map((o: any) => o.providerId), ['nvidia-nim'], 'OpenAI and the local GPU are not configured and are not offered');
    assert.deepEqual(world.productBuilderCalls().nim - before.nim, 0, 'nothing was sent to the other company before the person approved');
    assert.equal(world.productBuilderCalls().images - before.images, 1, 'the exhausted account was called once');
    assert.equal(blocked.mockups, null);

    // COST_REAPPROVAL: the person approves THIS route with THESE terms
    await page.click('.main-pb-block .main-pb-use-route');
    await waitProject(page, 'DESIGN_PENDING_APPROVAL');
    assert.equal(world.productBuilderCalls().nim - before.nim, 3);
    await page.waitForFunction(() => Array.from(document.querySelectorAll('.main-pb-mockup img')).every((i: any) => i.complete && i.naturalWidth > 0), undefined, { timeout: 15000 });
    const done = await cardText(page);
    assert.match(done, /What was tried \(3\)/);
    assert.doesNotMatch(done, NO_TECHNICAL_TEXT);
    await shot(page, '10-adaptive-design-after-switch');

    // ROUTE_HISTORY + GOAL_VERIFICATION, from the record behind the card
    const [project] = await projects(ctx);
    assert.deepEqual(project.routeHistory.map((a: any) => [a.provider, a.outcome, a.failureClass]), [['google', 'FAILED', 'QUOTA_EXHAUSTED'], ['nvidia-nim', 'APPROVED', null], ['nvidia-nim', 'SUCCEEDED', null]]);
    assert.deepEqual(project.routeHistory[0].materialChanges.slice().sort(), ['COST_UNKNOWN', 'NEW_THIRD_PARTY_RECEIVES_DATA']);
    assert.ok(project.mockups.items.every((m: any) => m.providerId === 'nvidia-nim' && m.mimeType === 'image/png' && m.width === 480 && m.height === 300 && /^[0-9a-f]{64}$/.test(m.sha256) && m.bytes > 100));
    const approval = await (await ctx.request.get(`${h.origin}/api/v1/approvals/${project.routeHistory[1].approvalId}`)).json();
    assert.deepEqual([approval.toolId ?? approval.approval?.toolId, approval.status ?? approval.approval?.status], ['adaptive.route.switch', 'CONSUMED']);
    const served = await ctx.request.get(`${h.origin}${project.mockups.items[0].url}`);
    assert.equal(served.status(), 200);
    assert.match(served.headers()['content-type'], /image\/png/);
    assert.deepEqual([...(await served.body()).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'the served bytes ARE a PNG');
    await ctx.close();
  });

  it('en: the next project does not start by calling the account that just said no - it names the route that is usable, and the plan gate says so', { timeout: 240000 }, async () => {
    world.setProductBuilder({ engine: null, images: 'quota', nim: 'ok' });
    const before = world.productBuilderCalls();
    const { ctx } = await contextFor('adp_next', 'en');
    const page = await ctx.newPage();
    await openHome(page);
    await ask(page, SITE_REQUEST_EN);
    await waitProject(page, 'PLAN_PENDING_APPROVAL');
    assert.match(await cardText(page), /asks nvidia-nim for 3 visual mockups/i);
    await approve(page, 'PLAN');
    await waitProject(page, 'DESIGN_PENDING_APPROVAL');
    assert.equal(world.productBuilderCalls().images - before.images, 0, 'the exhausted account was not called again');
    assert.equal(world.productBuilderCalls().nim - before.nim, 3);
    const [project] = await projects(ctx);
    assert.deepEqual(project.routeHistory.map((a: any) => [a.provider, a.outcome]), [['nvidia-nim', 'SUCCEEDED']]);
    await ctx.close();
  });

  it('en: a "200" that is not an image is a failure of the goal; with nothing else eligible the project says exactly what is missing, keeps its place, and continues when the route is fixed', { timeout: 240000 }, async () => {
    world.setProductBuilder({ engine: null, images: 'quota', nim: 'not-an-image' });
    const before = world.productBuilderCalls();
    const { ctx } = await contextFor('adp_bad', 'en');
    const page = await ctx.newPage();
    await openHome(page);
    await ask(page, SITE_REQUEST_EN);
    await waitProject(page, 'PLAN_PENDING_APPROVAL');
    await approve(page, 'PLAN');
    await waitProject(page, 'BLOCKED');
    const text = await cardText(page);
    assert.match(text, /returned something that is not a usable image, so it was not kept/);
    assert.match(text, /No other image service can be used right now/);
    assert.match(text, /Google: out of quota recently/);
    assert.match(text, /OpenAI: not set up/);
    assert.match(text, /a local image service: not set up/);
    assert.doesNotMatch(text, /not set up, unavailable/);
    assert.match(text, /Nothing is lost/);
    assert.doesNotMatch(text, NO_TECHNICAL_TEXT);
    assert.equal(await page.locator('.main-pb-block .main-pb-use-route').count(), 0);
    await shot(page, '11-adaptive-nothing-eligible');
    const [stopped] = await projects(ctx);
    assert.deepEqual([stopped.recovery.failureClass, stopped.recovery.decision, stopped.recovery.abortReason], ['VERIFICATION_FAILED', 'ABORT', 'NO_AUTHORIZED_ROUTE']);
    assert.equal(stopped.mockups, null, 'the error page was not stored as a mockup');
    assert.equal(world.productBuilderCalls().nim - before.nim, 1, 'a chargeable result that failed verification was not repeated');

    // fixed: the same route works again
    world.setProductBuilder({ nim: 'ok' });
    await page.click('.main-pb-block .main-pb-resolve');
    await waitProject(page, 'DESIGN_PENDING_APPROVAL');
    const [resumed] = await projects(ctx);
    assert.equal(resumed.mockups.items.length, 3);
    assert.deepEqual(resumed.routeHistory.map((a: any) => [a.provider, a.outcome]), [['nvidia-nim', 'FAILED'], ['nvidia-nim', 'SUCCEEDED']]);
    await ctx.close();
  });

  it('ko: the same decision reads in Korean and fits a phone', { timeout: 240000 }, async () => {
    world.setProductBuilder({ engine: null, images: 'quota', nim: 'down' });
    const { ctx } = await contextFor('adp_ko', 'ko', 390);
    const page = await ctx.newPage();
    await openHome(page);
    await ask(page, SITE_REQUEST_KO);
    await waitProject(page, 'PLAN_PENDING_APPROVAL');
    await approve(page, 'PLAN');
    await waitProject(page, 'BLOCKED');
    const text = await cardText(page);
    assert.match(text, /멈췄어요 - 먼저 필요한 것이 있어요/);
    assert.match(text, /지금 쓸 수 있는 다른 이미지 서비스가 없어요/);
    assert.match(text, /Google: 최근 사용 한도 소진/);
    assert.match(text, /시도한 내용/);
    assert.doesNotMatch(text, NO_TECHNICAL_TEXT);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, 'the decision card fits a 390 px phone');
    await ctx.close();
  });
});

describe('who may decide, and what is shown', () => {
  it('nobody else can choose a route for someone\'s project or read its history; the card shows no prompt text and no internal id', { timeout: 240000 }, async () => {
    world.setProductBuilder({ engine: null, images: 'quota', nim: 'down' });
    const { ctx } = await contextFor('adp_owner', 'en');
    const page = await ctx.newPage();
    await openHome(page);
    await ask(page, SITE_REQUEST_EN);
    await waitProject(page, 'PLAN_PENDING_APPROVAL');
    await approve(page, 'PLAN');
    await waitProject(page, 'BLOCKED');
    const [mine] = await projects(ctx);
    const { ctx: stranger } = await contextFor('adp_stranger', 'en');
    const base = `${h.origin}/api/v1/product-builder/projects/${mine.projectId}`;
    const resolveByStranger = await stranger.request.post(`${base}/resolve`, { data: { mockupProviderId: 'nvidia-nim' } });
    assert.equal(resolveByStranger.status(), 404);
    assert.equal((await stranger.request.get(base)).status(), 404);
    assert.equal((await projects(stranger)).length, 0);
    assert.equal((await projects(ctx))[0].state, 'BLOCKED', 'nothing happened to the project');
    // the proposal and the history hold ids, classes and short NAgex-written reasons - never the person's request
    const wire = JSON.stringify({ recovery: mine.recovery, routeHistory: mine.routeHistory });
    assert.ok(!wire.includes('customer management') && !wire.includes('Build me'), 'no prompt text in the recovery or the history');
    await stranger.close();
    await ctx.close();
  });
});

// D-10 overnight Task B - the document journey from ONE natural-language request, in real Chromium against the PRODUCTION server, with a LOCAL deterministic model and search endpoint
// (tests/_local_ai_world.ts: loopback only, no credential, no network). No mode is chosen: route-input decides; the real providers / router / AiService / creation runtime / DocumentStore /
// ArtifactStore / Recent / Open run unchanged. What this proves is NAgex's own chain: routing, request language, source-only report, persistence, reopen after a fresh browser, ownership,
// and that a failure never reads as "created". It does NOT prove a real model answered: the real Nemotron document run is scripts/document-roundtrip-live-cert.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright';
import { startCanvasAskHarness, type CanvasAskHarness, type DisposableUser } from './_canvas_ask_harness.js';
import { startLocalAiWorld, type LocalAiWorld } from './_local_ai_world.js';

declare const window: any;
declare const document: any;

let h: CanvasAskHarness;
let world: LocalAiWorld;
before(async () => {
  world = await startLocalAiWorld();
  h = await startCanvasAskHarness({ scrubProviders: true, env: world.env });
});
after(async () => { await h?.close(); await world?.close(); });

const documentFiles = () => { const dir = process.env.NAGEX_DOCUMENTS_DIR!; return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length : 0; };
const artifactFiles = () => { const dir = process.env.NAGEX_ARTIFACTS_DIR!; return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length : 0; };

async function contextFor(user: DisposableUser, locale: 'en' | 'ko', width = 1440, height = 900): Promise<BrowserContext> {
  const base = await h.newContext('desktop', user, locale);
  const ctx = await h.browser.newContext({ viewport: { width, height }, locale: locale === 'ko' ? 'ko-KR' : 'en-US', ...(width < 600 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  await ctx.addCookies(await base.cookies());
  await ctx.addInitScript((l: string) => { try { localStorage.setItem('nagex_locale', l); } catch { /* storage unavailable */ } }, locale);
  await base.close();
  return ctx;
}
async function openHome(page: Page): Promise<void> {
  await page.goto(`${h.origin}/#home`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#main-surface-input', { timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('#nagex-main-surface')?.dataset.sessionState === 'EMPTY_HOME', undefined, { timeout: 20000 });
}
const lastTurn = (page: Page) => page.evaluate(() => { const turns = document.querySelectorAll('.main-turn'); return ((turns[turns.length - 1] as any)?.innerText ?? '').replace(/\s+/g, ' ').trim(); });
async function settle(page: Page): Promise<string> {
  await page.waitForFunction(() => { const turns = document.querySelectorAll('.main-turn'); const last = turns[turns.length - 1] as any; return Boolean(last) && last.getAttribute('data-kind') !== 'pending'; }, undefined, { timeout: 30000 });
  return lastTurn(page);
}
async function ask(page: Page, text: string): Promise<void> {
  await page.fill('#main-surface-input', text);
  await page.click('#main-send');
}
const docRequests = () => world.modelRequests.filter((r) => r.kind === 'document');

describe('One Input -> a real stored document, reopened by a fresh browser, owner only', () => {
  for (const [locale, text, titlePattern, bodyPattern] of [
    ['ko', '다음 주 제품 출시 회의를 위한 한 페이지 보고서를 작성해줘. 주제는 승인 기반 실행이야.', /회의 보고서/, /요청 내용: 다음 주 제품 출시 회의를 위한 한 페이지 보고서/],
    ['en', "Write a one-page report for next week's launch meeting about approval-based execution.", /Meeting report/, /Request: Write a one-page report for next week's launch meeting/],
  ] as const) {
    it(`${locale}: no mode selected -> document created in the request language, saved, listed in Recent, and opened again from a brand-new browser; another user sees nothing`, async () => {
      const user = h.user(`doc_chain_${locale}`);
      const ctx = await contextFor(user, locale === 'ko' ? 'en' : 'ko'); // the SCREEN language differs on purpose: the request decides
      const page = await ctx.newPage();
      const posts: string[] = [];
      page.on('request', (r) => { if (r.method() === 'POST') posts.push(new URL(r.url()).pathname); });
      await openHome(page);
      const docsBefore = documentFiles();
      const modelBefore = docRequests().length;
      await ask(page, text);
      await page.waitForSelector('#main-result-panel:not([hidden])', { timeout: 30000 });
      // routed by its words: route-input, then ONLY the document route; no chat, no plan, no research
      assert.ok(posts.includes('/api/v1/workspace/route-input'));
      assert.ok(posts.includes('/api/v1/creations/documents'));
      assert.deepEqual(posts.filter((p) => /ai\/chat|ambient\/intent|research|tasks|approvals/.test(p)), []);
      assert.equal(await page.locator('#main-result-kind').textContent(), 'DOC');
      assert.match(await page.locator('#main-result-title').innerText(), titlePattern);
      assert.match(await page.locator('#main-result-preview').innerText(), bodyPattern);
      // the model was asked once, in the request's language, with the person's own words
      const sent = docRequests().slice(modelBefore);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].korean, locale === 'ko', 'the document prompt carries the language of the request, not of the screen');
      // really stored
      assert.equal(documentFiles(), docsBefore + 1);
      const stored = h.artifactStore.list(user.tenantId, user.userId).filter((a) => a.type === 'DOCUMENT');
      assert.equal(stored.length, 1);
      await ctx.close();

      // a BRAND-NEW browser (no state of the first one): Recent lists it, Open shows the same text
      const fresh = await contextFor(user, locale);
      const page2 = await fresh.newPage();
      await page2.goto(`${h.origin}/#recent`, { waitUntil: 'domcontentloaded' });
      await page2.waitForSelector('.recent-item', { timeout: 20000 });
      assert.match(await page2.locator('.recent-item-title').first().innerText(), titlePattern);
      assert.doesNotMatch(await page2.locator('#recent-list').innerText(), /art_|doc_|artifactId/, 'no internal ids');
      await page2.locator('.recent-item').first().locator('.recent-open').click();
      await page2.waitForSelector('#main-result-panel:not([hidden])', { timeout: 20000 });
      assert.match(await page2.locator('#main-result-preview').innerText(), bodyPattern);
      await fresh.close();

      // another signed-in person: nothing in Recent, and the document is not reachable by id
      const other = h.user(`doc_chain_other_${locale}`);
      const strangerCtx = await contextFor(other, locale);
      const page3 = await strangerCtx.newPage();
      await page3.goto(`${h.origin}/#recent`, { waitUntil: 'domcontentloaded' });
      await page3.waitForSelector('#recent-list', { timeout: 20000 });
      await page3.waitForFunction(() => /Nothing created yet|아직 만든 것이 없어요|아직/.test(document.querySelector('#recent-list')?.textContent || ''), undefined, { timeout: 15000 });
      assert.equal(await page3.locator('.recent-item').count(), 0);
      const documentId = stored[0].sourceId;
      const status = await page3.evaluate(async (id: string) => (await fetch(`/api/v1/creations/documents/${encodeURIComponent(id)}`)).status, documentId);
      assert.ok(status === 404 || status === 403, `another person gets ${status}`);
      await strangerCtx.close();
    });
  }

  it('a failing model never reads as "created": nothing is stored, no result panel, a plain failure with a way back', async () => {
    const user = h.user('doc_chain_fail');
    const ctx = await contextFor(user, 'en');
    const page = await ctx.newPage();
    await openHome(page);
    for (const mode of ['http500', 'not-json', 'empty-content'] as const) {
      world.failDocuments(mode);
      const docs = documentFiles();
      const arts = artifactFiles();
      await ask(page, 'Write a one-page report on our launch plan');
      const turn = await settle(page);
      assert.match(turn, /Document could not be created/i, `${mode}: ${turn}`);
      assert.doesNotMatch(turn, /Document created/);
      assert.equal(await page.locator('#main-result-panel').isHidden(), true, `${mode}: no result is shown`);
      assert.equal(documentFiles(), docs, `${mode}: no document was stored`);
      assert.equal(artifactFiles(), arts, `${mode}: no artifact was stored`);
      assert.equal(h.artifactStore.list(user.tenantId, user.userId).length, 0, `${mode}: nothing in Recent`);
      await page.click('.main-turn .main-inline-actions button:has-text("Try again")');
      await page.fill('#main-surface-input', '');
    }
    world.failDocuments('off');
    await ctx.close();
  });

  it('a double click creates ONE document (the second submit is ignored while the first is working)', async () => {
    const user = h.user('doc_chain_double');
    const ctx = await contextFor(user, 'en');
    const page = await ctx.newPage();
    await openHome(page);
    const before = docRequests().length;
    await page.fill('#main-surface-input', 'Write a one-page report on the Q3 plan');
    await page.dblclick('#main-send');
    await page.waitForSelector('#main-result-panel:not([hidden])', { timeout: 30000 });
    await page.waitForTimeout(500);
    assert.equal(docRequests().length - before, 1, 'one model request');
    assert.equal(h.artifactStore.list(user.tenantId, user.userId).filter((a) => a.type === 'DOCUMENT').length, 1, 'one stored document');
    await ctx.close();
  });
});

describe('research -> report: searched, retrieved, verified and composed by NAgex; closed when research is unavailable', () => {
  for (const [locale, text] of [['ko', 'AI 동향을 조사해서 보고서로 만들어줘'], ['en', 'Research the AI market and turn it into a report']] as const) {
    it(`${locale}: one server-side run - the model proposes, NAgex keeps only what the retrieved pages support, and the stored report lists exactly those sources`, async () => {
      world.failSearch(false);
      world.useLocalPages(true);
      const user = h.user(`doc_research_${locale}`);
      const ctx = await contextFor(user, locale);
      const page = await ctx.newPage();
      const order: string[] = [];
      page.on('request', (r) => { if (r.method() === 'POST') { const p = new URL(r.url()).pathname; if (/research|creations\/documents/.test(p)) order.push(p); } });
      const queriesBefore = world.searchQueries.length;
      const modelBefore = world.modelRequests.length;
      await openHome(page);
      await ask(page, text);
      await page.waitForSelector('#main-result-panel:not([hidden])', { timeout: 60000 });
      assert.deepEqual(order, ['/api/v1/research/reports'], 'one request: the report is searched, retrieved, verified and composed on the server');
      assert.ok(world.searchQueries.length > queriesBefore, 'the search endpoint was really asked');
      const requests = world.modelRequests.slice(modelBefore);
      assert.deepEqual(requests.map((r) => r.kind), ['research-plan', 'research-extract', 'research-report'], 'the model proposes searches, claims and a draft - it never writes the document');
      assert.equal(requests.filter((r) => r.kind === 'document').length, 0, 'no model-written report');
      assert.equal(requests[1].korean, locale === 'ko');
      assert.match(requests[2].user, /Adoption of AI assistants grew sharply/, 'the draft is written from verified claims');
      assert.doesNotMatch(requests[2].user, /replaced its staff|Every company replaced/, 'the claim the page does not support never reached the draft');
      const preview = await page.locator('#main-result-preview').innerText();
      assert.match(preview, /Adoption of AI assistants grew sharply among knowledge workers/);
      assert.match(preview, /Investment in AI tools increased by 18% in 2025/);
      assert.doesNotMatch(preview, /replaced (its|their) (entire )?staff/);
      assert.match(preview, /\[1\]/, 'citation markers are in the text');
      const links = await page.locator('#main-result-preview a').evaluateAll((els: any[]) => els.map((e) => e.href));
      assert.deepEqual([...links].sort(), [world.pageUrl('ai-adoption-survey'), world.pageUrl('ai-investment')].sort(), 'the source list links exactly the pages that were retrieved');
      assert.equal(h.artifactStore.list(user.tenantId, user.userId).filter((a) => a.type === 'DOCUMENT').length, 1);
      await ctx.close();
      world.useLocalPages(false);
    });

    it(`${locale}: the Sources tab shows where each source came from and what was refused; the report reopens from Recent in a new browser with its provenance; another person cannot read the run`, async () => {
      world.failSearch(false);
      world.useLocalPages(true);
      const user = h.user(`doc_research_prov_${locale}`);
      const ctx = await contextFor(user, locale);
      const page = await ctx.newPage();
      await openHome(page);
      await ask(page, text);
      await page.waitForSelector('#main-result-panel:not([hidden])', { timeout: 60000 });
      assert.equal(await page.locator('#main-result-sources').isEnabled(), true, 'a research report has a Sources tab');
      await page.click('#main-result-sources');
      await page.waitForFunction(() => document.querySelectorAll('#main-result-preview .main-research-sources li').length >= 2, undefined, { timeout: 15000 });
      const sources = await page.locator('#main-result-preview').innerText();
      assert.match(sources, locale === 'ko' ? /보고서에서 인용함/ : /Cited in the report/);
      assert.match(sources, locale === 'ko' ? /원문 전체 확인/ : /Full page read/);
      assert.match(sources, locale === 'ko' ? /확인/ : /Retrieved/);
      assert.match(sources, locale === 'ko' ? /제외한 진술은 (\d+)건/ : /(\d+) were refused/);
      assert.doesNotMatch(sources, /run_[0-9a-f]{24}|doc_[0-9a-f]{24}|art_[0-9a-f]{24}|S\d+\b/, 'no internal ids');
      const sourceLinks = await page.locator('#main-result-preview .main-research-sources a').evaluateAll((els: any[]) => els.map((e) => ({ href: e.href, rel: e.rel, target: e.target })));
      assert.ok(sourceLinks.length >= 2 && sourceLinks.every((l) => /noopener/.test(l.rel) && l.target === '_blank'));
      await page.click('#main-result-preview-tab');
      assert.match(await page.locator('#main-result-preview').innerText(), /Adoption of AI assistants/, 'back to the report');
      const runId = await page.locator('#main-result-sources').getAttribute('data-run');
      assert.match(String(runId), /^run_[0-9a-f]{24}$/);
      await ctx.close();

      const fresh = await contextFor(user, locale);
      const page2 = await fresh.newPage();
      await page2.goto(`${h.origin}/#recent`, { waitUntil: 'domcontentloaded' });
      await page2.waitForSelector('.recent-item', { timeout: 20000 });
      await page2.locator('.recent-item').first().locator('.recent-open').click();
      await page2.waitForSelector('#main-result-panel:not([hidden])', { timeout: 20000 });
      await page2.waitForFunction(() => !(document.getElementById('main-result-sources') as any)?.disabled, undefined, { timeout: 10000 });
      assert.match(await page2.locator('#main-result-preview').innerText(), /Adoption of AI assistants grew sharply/);
      assert.equal(await page2.locator('#main-result-preview h3, #main-result-preview h4').count() >= 2, true, 'the report is shown as formatted text, not as raw Markdown');
      assert.doesNotMatch(await page2.locator('#main-result-preview').innerText(), /(^|\n)#{1,3} /);
      await fresh.close();

      const other = h.user(`doc_research_prov_other_${locale}`);
      const strangerCtx = await contextFor(other, locale);
      const page3 = await strangerCtx.newPage();
      await page3.goto(`${h.origin}/#recent`, { waitUntil: 'domcontentloaded' });
      await page3.waitForSelector('#recent-list', { timeout: 20000 });
      const status = await page3.evaluate(async (id: string) => (await fetch(`/api/v1/research/runs/${id}`)).status, String(runId));
      assert.equal(status, 404, 'another person cannot read the provenance of this report');
      await strangerCtx.close();
      world.useLocalPages(false);
    });

    it(`${locale}: when the search provider is down, NO report is written and the person is told research could not be completed`, async () => {
      world.failSearch(true);
      const user = h.user(`doc_research_down_${locale}`);
      const ctx = await contextFor(user, locale);
      const page = await ctx.newPage();
      const modelBefore = world.modelRequests.length;
      const docs = documentFiles();
      await openHome(page);
      await ask(page, text);
      const turn = await settle(page);
      assert.match(turn, locale === 'ko' ? /검색이 동작하지 않았어요/ : /The search did not work/i);
      assert.match(turn, locale === 'ko' ? /보고서를 만들지 않았어요/ : /no report was written/i);
      const after = world.modelRequests.slice(modelBefore).map((r) => r.kind);
      assert.equal(after.includes('document') || after.includes('research-extract') || after.includes('research-report'), false, 'the model was never asked to extract from nothing or to write an unsourced report');
      assert.equal(documentFiles(), docs);
      assert.equal(await page.locator('#main-result-panel').isHidden(), true);
      world.failSearch(false);
      await ctx.close();
    });
  }
});

describe('research -> image: no research is run or implied; the person is told the image is made from the description', () => {
  for (const [locale, text, note] of [['ko', '서울 야경을 조사해서 이미지로 만들어줘', /이미지는 설명한 내용으로 만들어요/], ['en', 'Research the Seoul skyline and generate an image of it', /Images are made from your description/]] as const) {
    it(`${locale}: only the image route is called, the search endpoint is never asked, and the screen says so`, async () => {
      world.failSearch(false);
      const user = h.user(`img_research_${locale}`);
      const ctx = await contextFor(user, locale);
      const page = await ctx.newPage();
      const posts: string[] = [];
      page.on('request', (r) => { if (r.method() === 'POST') posts.push(new URL(r.url()).pathname); });
      const queriesBefore = world.searchQueries.length;
      await openHome(page);
      await ask(page, text);
      const turn = await settle(page);
      assert.equal(posts.includes('/api/v1/research'), false, 'research was not run');
      assert.ok(posts.includes('/api/v1/creations/generate'), 'the image route was used');
      assert.equal(world.searchQueries.length, queriesBefore, 'the search provider was never asked');
      assert.match(turn, note);
      assert.doesNotMatch(turn, /Research, then|조사 후/, 'the route label does not promise a research step');
      await ctx.close();
    });
  }
});

describe('storage that cannot persist is reported, never "created"', () => {
  it('a document store that fails to save makes the creation FAIL with no artifact (code path, not a screen claim)', async () => {
    const { DocumentExecutor } = await import('../src/creation/executors/document-executor.js');
    const { DocumentStore } = await import('../src/creation/document.store.js');
    const { ArtifactStore } = await import('../src/artifacts/artifact.store.js');
    const { CreationRuntime } = await import('../src/creation/creation-runtime.js');
    const os = await import('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-offline-store-'));
    const artifacts = new ArtifactStore({ dir: path.join(dir, 'artifacts') });
    const failing = new DocumentStore({ dir: path.join(dir, 'documents') });
    (failing as any).save = () => { throw new Error('disk offline'); };
    const ai: any = { documentSynthesis: async () => ({ data: { title: 'T', summary: 'S', content: '# T\n\nbody body body body body body body body body body body body body body body body' }, provider: 'nebius', model: 'm', latencyMs: 1, requestId: 'r' }) };
    const runtime = new CreationRuntime([new DocumentExecutor({ aiService: ai, documentStore: failing, artifactStore: artifacts })]);
    let outcome: any;
    try { outcome = await runtime.create({ creationKind: 'DOCUMENT', prompt: 'x', options: { locale: 'en' }, tenantId: 't', ownerId: 'u', requestId: 'req_offline' } as any); } catch (error) { outcome = { status: 'THREW', error }; }
    assert.notEqual(outcome.status, 'SUCCESS', 'a failed save is never reported as success');
    assert.equal(artifacts.list('t', 'u').length, 0, 'and no artifact points at a document that was not stored');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

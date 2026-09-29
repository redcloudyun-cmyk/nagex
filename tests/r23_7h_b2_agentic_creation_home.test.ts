import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { ArtifactStore } from '../src/artifacts/artifact.store.js';
import { PersonalHomeService } from '../src/home/personal-home.service.js';
import { handleResearchRoutes } from '../src/http/routes/research.routes.js';
import { handleWorkspaceRoutes } from '../src/http/routes/workspace.routes.js';
import { createServerInstance } from '../src/server_web.js';

const tempDir = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), name));

test('R23.7H-B2 contract: only Research/Analyze and truthful durable artifacts reach PersonalHomeResponse', async () => {
  const store = new ArtifactStore({ dir: tempDir('nagex-b2-artifacts-'), now: () => '2026-09-29T12:00:00.000Z' });
  const research = store.saveCompleted({ tenantId: 't', ownerId: 'u', type: 'RESEARCH', title: 'Verified market', preview: 'Grounded result', sourceType: 'RESEARCH_RESULT', sourceId: 'ev_1', openTarget: '/research/ev_1' });
  const duplicate = store.saveCompleted({ tenantId: 't', ownerId: 'u', type: 'RESEARCH', title: 'Verified market', preview: 'Updated grounded result', sourceType: 'RESEARCH_RESULT', sourceId: 'ev_1', openTarget: '/research/ev_1' });
  store.saveCompleted({ tenantId: 't', ownerId: 'u', type: 'ANALYSIS', title: 'Contract.pdf', preview: 'Three grounded clauses', sourceType: 'CAPTURE', sourceId: 'cap_1', openTarget: '#inbox/cap_1' });
  assert.equal(research.artifactId, duplicate.artifactId, 'stable source identity deduplicates retries');

  const home = await new PersonalHomeService({ artifactStore: store }).getPersonalHome({ tenantId: 't', principalId: 'u' });
  assert.deepEqual(home.creationActions.map((item) => item.id), ['RESEARCH', 'ANALYZE']);
  assert.equal(home.recentCreations.length, 2);
  assert.deepEqual(new Set(home.recentCreations.map((item) => item.type)), new Set(['RESEARCH', 'ANALYSIS']));
  assert.equal(home.recentCreations.every((item) => item.state === 'Completed'), true);
  assert.equal(JSON.stringify(home).match(/SLIDES|VIDEO|TEXT_TO_IMAGE|generic report/gi), null);

  const isolated = await new PersonalHomeService({ artifactStore: { list: () => { throw new Error('history unavailable'); } } as any }).getPersonalHome({ tenantId: 't', principalId: 'u' });
  assert.equal(isolated.recentCreations.length, 0);
  assert.equal(isolated.creationActions.length, 2, 'history failure does not remove entry actions or blank Home');
});

test('R23.7H-B2 research persists only a real successful synthesized result', async () => {
  const store = new ArtifactStore({ dir: tempDir('nagex-b2-research-') });
  const evidence = { evidencePackId: 'ev_real', query: 'verified topic', generatedAt: new Date().toISOString(), freshnessRequirement: 'REQUIRED', category: 'NEWS', status: 'SUCCESS', sources: [{ sourceId: 's1', title: 'Source', url: 'https://example.com', retrievedAt: new Date().toISOString(), freshnessStatus: 'CURRENT' }] };
  const result = await handleResearchRoutes('POST', '/api/v1/research', { query: 'verified topic' }, { 'x-nagex-tenant': 't', 'x-principal-id': 'u' }, {}, {
    artifactStore: store,
    evidencePackService: { buildEvidencePack: async () => evidence } as any,
    aiService: { research: async () => ({ data: { answer: 'Verified synthesis' } }) } as any,
    modelErrorResult: () => ({ status: 500, data: {} }),
  });
  assert.equal(result?.status, 200);
  assert.equal(store.list('t', 'u').length, 1);
  assert.equal(store.list('t', 'u')[0].type, 'RESEARCH');

  const unavailable = new ArtifactStore({ dir: tempDir('nagex-b2-research-fail-') });
  await handleResearchRoutes('POST', '/api/v1/research', { query: 'missing topic' }, { 'x-nagex-tenant': 't', 'x-principal-id': 'u' }, {}, {
    artifactStore: unavailable,
    evidencePackService: { buildEvidencePack: async () => ({ ...evidence, status: 'UNAVAILABLE', sources: [] }) } as any,
    aiService: { research: async () => { throw new Error('must not run'); } } as any,
    modelErrorResult: () => ({ status: 500, data: {} }),
  });
  assert.equal(unavailable.list('t', 'u').length, 0, 'unavailable research never becomes a completed creation');
});

test('R23.7H-B2 canonical upload persists completed analysis but never failed processing', async () => {
  const store = new ArtifactStore({ dir: tempDir('nagex-b2-analysis-') });
  const baseItem = { captureId: 'cap_real', ownerId: 'u', tenantId: 't', type: 'FILE', content: 'file', status: 'READY', source: 'WEB', metadata: { extractedTitle: 'Real.pdf', extractedSummary: 'Grounded analysis' }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await handleWorkspaceRoutes('POST', '/api/v1/workspace/upload', { filename: 'Real.pdf', mimeType: 'application/pdf', base64: Buffer.from('real bytes').toString('base64') }, { 'x-nagex-tenant': 't', 'x-principal-id': 'u' }, {}, { artifactStore: store, quickCaptureService: { uploadBinaryObject: async () => baseItem } as any });
  assert.equal(store.list('t', 'u').length, 1);
  assert.equal(store.list('t', 'u')[0].type, 'ANALYSIS');

  await handleWorkspaceRoutes('POST', '/api/v1/workspace/upload', { filename: 'Failed.pdf', mimeType: 'application/pdf', base64: Buffer.from('bad bytes').toString('base64') }, { 'x-nagex-tenant': 't', 'x-principal-id': 'u' }, {}, { artifactStore: store, quickCaptureService: { uploadBinaryObject: async () => ({ ...baseItem, captureId: 'cap_failed', status: 'FAILED', metadata: { errorCode: 'MODEL_FAILED' } }) } as any });
  assert.equal(store.list('t', 'u').length, 1, 'failed analysis never becomes a completed creation');
});

test('R23.7H-B2 real-browser matrix: shared actions, populated Recent Creations, EN/KR, accessibility and overflow', async (t) => {
  const server = createServerInstance();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const browser = await chromium.launch({ headless: true, args: [`--explicitly-allowed-ports=${port}`] });
  const evidenceDir = path.join(process.cwd(), 'artifacts', 'r23.7h-b2');
  fs.mkdirSync(evidenceDir, { recursive: true });
  const homeFixture = { generatedAt: new Date().toISOString(), rightNow: null, today: { meetings: [] }, needsAttention: [], preparedForYou: [], workingForYou: [], recentResults: [], sourceStatus: { calendar: 'CONNECTED' }, creationActions: [
    { id: 'RESEARCH', title: 'Research', description: 'Find, verify, and synthesize information.', action: { type: 'START_RESEARCH', label: 'Start research' } },
    { id: 'ANALYZE', title: 'Analyze', description: 'Understand supported documents and files.', action: { type: 'START_ANALYSIS', label: 'Choose a file' } },
  ], recentCreations: [
    { id: 'art_r', type: 'RESEARCH', title: 'Verified market', summary: 'Grounded research result', sourceType: 'ACTIVITY', sourceId: 'art_r', state: 'Completed', action: { type: 'OPEN_ARTIFACT', label: 'Open', targetUrl: '/api/v1/artifacts/art_r' } },
    { id: 'art_a', type: 'ANALYSIS', title: 'Contract.pdf', summary: 'Grounded file analysis', sourceType: 'ACTIVITY', sourceId: 'art_a', state: 'Completed', action: { type: 'OPEN_ARTIFACT', label: 'Open', targetUrl: '/api/v1/artifacts/art_a' } },
  ] };

  const run = async (width: number, height: number, locale: 'en' | 'ko') => {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.addInitScript((value) => localStorage.setItem('nagex_locale', value), locale);
    await page.route('**/api/v1/personal/home', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(homeFixture) }));
    await page.goto(`http://127.0.0.1:${port}/?demo=1`);
    const root = width <= 768 ? '#mobile-view-home' : '#view-home';
    await page.waitForFunction((selector) => (globalThis as any).document.querySelectorAll(`${selector} [data-home-section]`).length >= 7, root);
    const state = await page.evaluate((selector) => {
      const doc = (globalThis as any).document;
      const actions = [...doc.querySelectorAll(`${selector} [data-creation-action]`)].map((el: any) => el.dataset.creationAction);
      const text = doc.querySelector(selector)?.innerText || '';
      const unnamed = [...doc.querySelectorAll(`${selector} button`)].filter((el: any) => !(el.textContent || el.getAttribute('aria-label') || '').trim()).length;
      return { actions, text, unnamed, overflow: doc.documentElement.scrollWidth > doc.documentElement.clientWidth };
    }, root);
    assert.deepEqual(state.actions, ['RESEARCH', 'ANALYZE']);
    assert.doesNotMatch(state.text, /Slides|Video|Image generation|Write document|Report generator/i);
    assert.match(state.text, locale === 'ko' ? /NAgex로 만들기/ : /Create with NAgex/);
    assert.match(state.text, locale === 'ko' ? /최근 생성 결과/ : /Recent Creations/);
    assert.equal(state.unnamed, 0);
    assert.equal(state.overflow, false);
    await page.screenshot({ path: path.join(evidenceDir, `${width <= 768 ? 'mobile' : 'desktop'}-${width}-${locale}.png`), fullPage: true });
    await page.close();
  };
  await t.test('Desktop EN', () => run(1440, 900, 'en'));
  await t.test('Desktop KR', () => run(1440, 900, 'ko'));
  for (const locale of ['en', 'ko'] as const) for (const [width, height] of [[360, 800], [390, 844], [430, 932]] as const) await t.test(`Mobile ${width} ${locale}`, () => run(width, height, locale));
  await browser.close();
  server.close();
});

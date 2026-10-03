// R23.7C-C — Canonical Desktop Creation History.
//
// Fixes the sole remaining R23.7C-C closure blocker identified by the
// closure audit: GET /api/v1/creations read only CreationStore, so a real
// IMAGE creation (which is never written to CreationStore — it lives only
// in ImageStore, thinly projected into ArtifactStore for cross-domain
// surfaces like Personal Home) could never appear in the Studio's own
// #create-history-list, even though the exact same panel just generated
// it. See imageRecordToCreationListItem() in creation.routes.ts: it
// projects the real ImageRecord (never ArtifactStore's lossy preview,
// which embeds the provider id and would leak it into consumer UI) into
// the same response shape the frontend already expects from a
// CreationRecord — no new store, no dual-write, ImageStore remains the
// single source of truth for image domain data.
//
// No real provider call — the same deterministic fake image provider
// used by r23_7c_c_canonical_image_serving.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { ImageExecutor } from '../src/creation/executors/image-executor.js';
import { ImageStore } from '../src/creation/image.store.js';
import { ArtifactStore } from '../src/artifacts/artifact.store.js';
import { CreationProviderRouter } from '../src/creation/providers/creation-provider-router.js';
import type { ImageProviderPort, ImageProviderCapabilities } from '../src/creation/providers/creation-provider.types.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { CreationStore } from '../src/creation/creation.store.js';
import { CreationService } from '../src/creation/creation.service.js';
import { handleCreationRoutes } from '../src/http/routes/creation.routes.js';
import { SessionStore } from '../src/sessions/session.store.js';
import { authAs, authAsWith, ensureTestAccount } from './_s1_session_auth.js';
import { canonicalizeRequestHeaders } from '../src/http/request-identity.js';
import { IdentityStore } from '../src/identity/identity.store.js';

declare const document: any;

const KNOWN_IMAGE_BYTES = Buffer.from('deterministic-known-png-bytes-for-r23-7c-c-history');
const tempDir = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), name));

function createFakeProvider(): ImageProviderPort {
  const caps: ImageProviderCapabilities = {
    textToImage: true, imageToImage: true, editingInpainting: true, referenceImageConditioning: true,
    transparentBackground: true, textRendering: true, supportedAspectRatios: ['1:1'], maxReferenceImages: 3,
  };
  return {
    providerId: 'fake-openai',
    getStatus: () => 'AVAILABLE',
    getCapabilities: () => caps,
    generateImage: async () => ({
      status: 'COMPLETED',
      output: { imageBuffer: KNOWN_IMAGE_BYTES, mimeType: 'image/png', temporaryUrl: 'https://fake-provider.com/temp/image.png' },
      metadata: { providerId: 'fake-openai', createdAt: new Date().toISOString() },
    }),
  };
}

function setup() {
  const imageStore = new ImageStore({ metaDir: tempDir('nagex-history-images-'), bytesDir: tempDir('nagex-history-image-bytes-') });
  const artifactStore = new ArtifactStore({ dir: tempDir('nagex-history-artifacts-') });
  const providerRouter = new CreationProviderRouter();
  const auditLogger = new AuditLogger();
  providerRouter.registerImageProvider(createFakeProvider());
  const imageExecutor = new ImageExecutor({ imageStore, artifactStore, providerRouter, auditLogger });
  const creationStore = new CreationStore({ dir: tempDir('nagex-history-creations-') });
  const creationService = new CreationService(creationStore, auditLogger);
  const sessionStore = new SessionStore({ dir: tempDir('nagex-history-sessions-') });
  const identityStore = new IdentityStore({ dir: tempDir('nagex-history-accounts-') });
  return { imageStore, artifactStore, imageExecutor, creationService, sessionStore, identityStore };
}

async function generateImage(deps: ReturnType<typeof setup>, headers: Record<string, string>, prompt = 'History fix test image') {
  return handleCreationRoutes('POST', '/api/v1/creations/generate', { prompt, type: 'IMAGE' }, headers, {}, {
    creationService: deps.creationService, imageExecutor: deps.imageExecutor, imageStore: deps.imageStore, sessionStore: deps.sessionStore,
  });
}

async function generateText(deps: ReturnType<typeof setup>, headers: Record<string, string>) {
  return handleCreationRoutes('POST', '/api/v1/creations/generate', { prompt: 'History fix test text creation' }, headers, {}, {
    creationService: deps.creationService, imageExecutor: deps.imageExecutor, imageStore: deps.imageStore, sessionStore: deps.sessionStore,
  });
}

async function list(deps: ReturnType<typeof setup>, headers: Record<string, string>) {
  return handleCreationRoutes('GET', '/api/v1/creations', null, headers, {}, {
    creationService: deps.creationService, imageExecutor: deps.imageExecutor, imageStore: deps.imageStore, sessionStore: deps.sessionStore,
  });
}

async function getGeneric(deps: ReturnType<typeof setup>, creationId: string, headers: Record<string, string>) {
  return handleCreationRoutes('GET', `/api/v1/creations/${creationId}`, null, headers, {}, {
    creationService: deps.creationService, imageExecutor: deps.imageExecutor, imageStore: deps.imageStore, sessionStore: deps.sessionStore,
  });
}

async function postVariation(deps: ReturnType<typeof setup>, creationId: string, headers: Record<string, string>) {
  return handleCreationRoutes('POST', `/api/v1/creations/${creationId}/variation`, { promptModifier: 'add sparkles' }, headers, {}, {
    creationService: deps.creationService, imageExecutor: deps.imageExecutor, imageStore: deps.imageStore, sessionStore: deps.sessionStore,
  });
}

test('A. a completed IMAGE creation appears in GET /api/v1/creations for its owner', async () => {
  const deps = setup();
  const headers = authAs('ten_a', 'usr_a');
  const created = await generateImage(deps, headers);
  const imageId = (created!.data as any).creationId as string;

  const listed = await list(deps, headers);
  const item = (listed!.data as any).creations.find((c: any) => c.creationId === imageId);
  assert.ok(item, 'the real image must appear in the history list');
  assert.equal(item.type, 'IMAGE');
  assert.equal(item.status, 'COMPLETED');
});

test('B. the canonical image/open URL is preserved in the history item', async () => {
  const deps = setup();
  const headers = authAs('ten_b', 'usr_b');
  const created = await generateImage(deps, headers);
  const imageId = (created!.data as any).creationId as string;
  const canonicalUrl = (created!.data as any).imageUrl as string;

  const listed = await list(deps, headers);
  const item = (listed!.data as any).creations.find((c: any) => c.creationId === imageId);
  assert.equal(item.imageUrl, canonicalUrl);
  assert.equal(item.outputAssetUrl, canonicalUrl);
  assert.match(canonicalUrl, /^\/api\/v1\/creations\/images\/img_[0-9a-f]{24}$/, 'must be the real canonical relative path, never a provider URL');
});

test('C. wrong tenant cannot see the image in history', async () => {
  const deps = setup();
  const created = await generateImage(deps, authAs('ten_c', 'usr_c'));
  const imageId = (created!.data as any).creationId as string;

  const listed = await list(deps, authAs('ten_victim', 'usr_c'));
  assert.equal((listed!.data as any).creations.some((c: any) => c.creationId === imageId), false);
});

test('D. wrong principal cannot see the image in history', async () => {
  const deps = setup();
  const created = await generateImage(deps, authAs('ten_d', 'usr_d'));
  const imageId = (created!.data as any).creationId as string;

  const listed = await list(deps, authAs('ten_d', 'usr_victim'));
  assert.equal((listed!.data as any).creations.some((c: any) => c.creationId === imageId), false);
});

test('E. a valid session cannot be overridden by spoofed identity headers on the history list', async () => {
  const deps = setup();
  const created = await generateImage(deps, authAs('ten_e', 'usr_e'));
  const imageId = (created!.data as any).creationId as string;

  // S1: identity headers are discarded; the verified caller is the session, so the list is the owner's.
  const spoofed = await list(deps, authAsWith('ten_e', 'usr_e', { 'x-nagex-tenant': 'ten_victim', 'x-principal-id': 'usr_victim' }));
  assert.ok((spoofed!.data as any).creations.some((c: any) => c.creationId === imageId), 'session identity must govern the list, not the spoofed headers');
});

test('F. existing CreationStore (non-image) history remains visible alongside images', async () => {
  const deps = setup();
  const headers = authAs('ten_f', 'usr_f');
  const textCreated = await generateText(deps, headers);
  const imageCreated = await generateImage(deps, headers);
  const textId = (textCreated!.data as any).creationId as string;
  const imageId = (imageCreated!.data as any).creationId as string;

  const listed = await list(deps, headers);
  const ids = (listed!.data as any).creations.map((c: any) => c.creationId);
  assert.ok(ids.includes(textId), 'legacy text creation must remain visible');
  assert.ok(ids.includes(imageId), 'real image creation must be visible');
});

test('G. no duplicate representation of the same creation across the merged list (id namespaces never overlap)', async () => {
  const deps = setup();
  const headers = authAs('ten_g', 'usr_g');
  await generateText(deps, headers);
  await generateImage(deps, headers);
  await generateImage(deps, headers, 'second image');

  const listed = await list(deps, headers);
  const ids = (listed!.data as any).creations.map((c: any) => c.creationId);
  assert.equal(new Set(ids).size, ids.length, 'every creationId in the merged list must be unique');
});

test('H. ordering remains deterministic (newest-first) across mixed text and image creations', async () => {
  const deps = setup();
  const headers = authAs('ten_h', 'usr_h');
  const first = await generateText(deps, headers);
  await new Promise((r) => setTimeout(r, 5));
  const second = await generateImage(deps, headers);
  await new Promise((r) => setTimeout(r, 5));
  const third = await generateText(deps, headers);

  const listed = await list(deps, headers);
  const ids = (listed!.data as any).creations.map((c: any) => c.creationId);
  const firstId = (first!.data as any).creationId;
  const secondId = (second!.data as any).creationId;
  const thirdId = (third!.data as any).creationId;
  const positions = [firstId, secondId, thirdId].map((id) => ids.indexOf(id));
  assert.ok(positions[2] < positions[1] && positions[1] < positions[0], 'newest-first ordering must hold across mixed store types');
});

test('J. a variation-created image appears in history with its parent lineage intact', async () => {
  const deps = setup();
  const headers = authAs('ten_j', 'usr_j');
  const original = await generateImage(deps, headers);
  const originalId = (original!.data as any).creationId as string;

  const variation = await postVariation(deps, originalId, headers);
  assert.equal(variation!.status, 201);
  const variationId = (variation!.data as any).creationId as string;

  const listed = await list(deps, headers);
  const ids = (listed!.data as any).creations.map((c: any) => c.creationId);
  assert.ok(ids.includes(originalId), 'original image must remain in history');
  assert.ok(ids.includes(variationId), 'variation must appear in history');

  // Opening the variation via the generic GET (what clicking the history
  // card's "Open" does) must resolve through the canonical image path.
  const opened = await getGeneric(deps, variationId, headers);
  assert.equal(opened!.status, 200);
  assert.match((opened!.data as any).creation.imageUrl, /^\/api\/v1\/creations\/images\/img_[0-9a-f]{24}$/);
});

// A minimal static+creation-routes-only HTTP server, deliberately NOT the
// full createServerInstance() app — that wires the real OpenAIImageAdapter
// (create-nagex-application.ts:521), which would attempt a genuine paid
// call the moment an API key happens to be present in the environment.
// This server serves only public/index.html and public/app.js (for real
// browser/DOM behavior) plus handleCreationRoutes bound to the SAME
// deterministic fake provider used by every other test in this file, so
// there is no code path by which this test can ever reach a real provider,
// regardless of local/CI environment variables.
function createHistoryTestServer(deps: ReturnType<typeof setup>): http.Server {
  const publicDir = path.resolve('public');
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = url.pathname === '/' ? '/index.html' : url.pathname;

    if (pathname.startsWith('/api/v1/creations')) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
      // S1: do what the real server does — derive identity from the session cookie, never from a header.
      const result = await handleCreationRoutes(req.method || 'GET', pathname, body, canonicalizeRequestHeaders(headers, { sessionStore: deps.sessionStore, identityStore: deps.identityStore }), Object.fromEntries(url.searchParams), {
        creationService: deps.creationService, imageExecutor: deps.imageExecutor, imageStore: deps.imageStore, sessionStore: deps.sessionStore,
      });
      if (!result) { res.writeHead(404).end(); return; }
      res.writeHead(result.status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result.data));
      return;
    }

    const filePath = path.join(publicDir, pathname);
    if (!filePath.startsWith(publicDir) || !fs.existsSync(filePath)) { res.writeHead(404).end(); return; }
    const contentType = filePath.endsWith('.js') ? 'application/javascript' : filePath.endsWith('.html') ? 'text/html' : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(fs.readFileSync(filePath));
  });
}

test('I. the desktop history renderer accepts and renders the real (unmocked) canonical image URL as an actual <img>', async () => {
  const deps = setup();
  const server = createHistoryTestServer(deps);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const browser = await chromium.launch({ headless: true, args: [`--explicitly-allowed-ports=${port}`] });
  try {
    ensureTestAccount('usr_i', deps.identityStore);
    const signedIn = deps.sessionStore.createAuthSession('ten_i', 'usr_i', 'MAIN');
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addCookies([{ name: 'nagex_session', value: signedIn.sessionId, url: `http://127.0.0.1:${port}` }]);
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForSelector('.home-discover-chip[data-action="discover-create"]', { state: 'visible' });
    await page.click('.home-discover-chip[data-action="discover-create"]');
    await page.waitForSelector('#create-prompt-input', { state: 'visible' });
    await page.fill('#create-prompt-input', 'end to end history render test');
    await page.click('#btn-create-generate');
    await page.waitForSelector('#create-result-slot .creation-result-card', { state: 'attached' });

    // loadCreationHistory() runs automatically after generation via the
    // real, unmocked GET /api/v1/creations — the fix under test — served
    // by handleCreationRoutes bound to the deterministic fake provider.
    await page.waitForFunction(() => document.querySelector('#create-history-list img') !== null, { timeout: 15000 });
    const historyImgSrc = await page.evaluate(() => document.querySelector('#create-history-list img')?.getAttribute('src') || null);
    assert.ok(historyImgSrc && /^\/api\/v1\/creations\/images\/img_[0-9a-f]{24}$/.test(historyImgSrc), 'history card must render a real <img> pointed at the canonical image URL');
    await page.close();
  } finally {
    await browser.close();
    server.close();
  }
});

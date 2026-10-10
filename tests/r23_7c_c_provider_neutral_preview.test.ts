// R23.7C-C — Provider-Neutral Artifact Preview.
//
// Fixes a confirmed TECHNICAL_UI_LEAK found while closing the desktop
// history blocker: ImageExecutor's ArtifactStore.saveCompleted() call
// embedded the provider adapter id directly in `preview`
// (`Image generated via ${providerId} (...)`), and that field flows
// unmodified through PersonalHomeService (summary: artifact.preview) into
// personal-home-view.js's rendered Recent Creations card
// (`<p>${esc(item.context)}</p>`) on both desktop and mobile, in both
// locales — a real, reachable leak of internal provider identity into
// ordinary consumer UI after any successful image generation.
//
// Provider identity is preserved exactly where it already correctly
// belongs: ImageRecord.providerExecutionMetadata (technical/audit data),
// never touched by this fix.
//
// No real provider call — the same deterministic fake image provider used
// throughout the R23.7C-C test suite.
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
import { PersonalHomeService } from '../src/home/personal-home.service.js';
import { handlePersonalHomeRoutes } from '../src/http/routes/personal-home.routes.js';
import { handleCreationRoutes } from '../src/http/routes/creation.routes.js';
import { CreationStore } from '../src/creation/creation.store.js';
import { CreationService } from '../src/creation/creation.service.js';
import { SessionStore } from '../src/sessions/session.store.js';
import { authAs, canonicalizeForTestServer, sessionCookie } from './_s1_session_auth.js';

declare const document: any;

const KNOWN_IMAGE_BYTES = Buffer.from('deterministic-known-png-bytes-for-r23-7c-c-preview');
const tempDir = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), name));

// Every providerId currently in tree, plus a deliberately provider-shaped
// fake id, so the assertion generalizes beyond "openai" specifically.
const PROVIDER_IDENTITY_TERMS = ['openai', 'google', 'nvidia', 'nvidia-nim', 'local', 'fake-openai'];

function assertNoProviderIdentity(text: string, where: string) {
  const lower = text.toLowerCase();
  for (const term of PROVIDER_IDENTITY_TERMS) {
    assert.equal(lower.includes(term), false, `${where} must not contain provider identity term "${term}": ${JSON.stringify(text)}`);
  }
}

function createFakeProvider(providerId = 'fake-openai'): ImageProviderPort {
  const caps: ImageProviderCapabilities = {
    textToImage: true, imageToImage: true, editingInpainting: true, referenceImageConditioning: true,
    transparentBackground: true, textRendering: true, supportedAspectRatios: ['1:1'], maxReferenceImages: 3,
  };
  return {
    providerId,
    getStatus: () => 'AVAILABLE',
    getCapabilities: () => caps,
    generateImage: async () => ({
      status: 'COMPLETED',
      output: { imageBuffer: KNOWN_IMAGE_BYTES, mimeType: 'image/png', temporaryUrl: 'https://fake-provider.com/temp/image.png' },
      metadata: { providerId, createdAt: new Date().toISOString() },
    }),
  };
}

function setup(providerId = 'fake-openai') {
  const imageStore = new ImageStore({ metaDir: tempDir('nagex-preview-images-'), bytesDir: tempDir('nagex-preview-image-bytes-') });
  const artifactStore = new ArtifactStore({ dir: tempDir('nagex-preview-artifacts-') });
  const providerRouter = new CreationProviderRouter();
  const auditLogger = new AuditLogger();
  providerRouter.registerImageProvider(createFakeProvider(providerId));
  const imageExecutor = new ImageExecutor({ imageStore, artifactStore, providerRouter, auditLogger });
  return { imageStore, artifactStore, imageExecutor, auditLogger };
}

async function generateOne(deps: ReturnType<typeof setup>, tenantId: string, ownerId: string) {
  return deps.imageExecutor.execute({
    creationKind: 'IMAGE',
    prompt: 'Provider-neutral preview test image',
    tenantId,
    ownerId,
    requestId: `req_preview_${Date.now()}`,
  });
}

test('A. a completed image artifact preview does not contain any provider/model identity', async () => {
  const deps = setup();
  const result = await generateOne(deps, 'ten_a', 'usr_a');
  assert.equal(result.status, 'SUCCESS');
  const artifact = deps.artifactStore.get(result.artifactId!, 'ten_a', 'usr_a');
  assert.ok(artifact);
  assertNoProviderIdentity(artifact!.preview, 'ArtifactRecord.preview');
});

test('B. provider identity remains available in ImageRecord.providerExecutionMetadata (audit surface preserved)', async () => {
  const deps = setup('fake-openai');
  const result = await generateOne(deps, 'ten_b', 'usr_b');
  const imageRecord = deps.imageStore.get(result.creationId, 'ten_b', 'usr_b');
  assert.ok(imageRecord);
  assert.equal(imageRecord!.providerExecutionMetadata.providerId, 'fake-openai', 'audit metadata must still carry the real provider id');
});

test('C. PersonalHomeService cannot surface provider identity through the image artifact summary', async () => {
  const deps = setup();
  await generateOne(deps, 'ten_c', 'usr_c');
  const service = new PersonalHomeService({ artifactStore: deps.artifactStore } as any);
  const home = await service.getPersonalHome({ tenantId: 'ten_c', principalId: 'usr_c' });
  const imageItem = home.recentCreations.find((item: any) => item.type === 'IMAGE');
  assert.ok(imageItem, 'the image must still appear in Recent Creations');
  assertNoProviderIdentity(imageItem!.summary || '', 'HomeItem.summary');
});

test('F. existing image creation/history behavior is unchanged by the preview fix', async () => {
  const imageStore = new ImageStore({ metaDir: tempDir('nagex-preview-hist-images-'), bytesDir: tempDir('nagex-preview-hist-bytes-') });
  const artifactStore = new ArtifactStore({ dir: tempDir('nagex-preview-hist-artifacts-') });
  const providerRouter = new CreationProviderRouter();
  const auditLogger = new AuditLogger();
  providerRouter.registerImageProvider(createFakeProvider());
  const imageExecutor = new ImageExecutor({ imageStore, artifactStore, providerRouter, auditLogger });
  const creationStore = new CreationStore({ dir: tempDir('nagex-preview-hist-creations-') });
  const creationService = new CreationService(creationStore, auditLogger);
  const sessionStore = new SessionStore({ dir: tempDir('nagex-preview-hist-sessions-') });
  const headers = authAs('ten_f', 'usr_f');
  const deps = { creationService, imageExecutor, imageStore, sessionStore };

  const created = await handleCreationRoutes('POST', '/api/v1/creations/generate', { prompt: 'regression check', type: 'IMAGE' }, headers, {}, deps);
  assert.equal(created!.status, 201);
  const imageUrl = (created!.data as any).imageUrl as string;
  assert.match(imageUrl, /^\/api\/v1\/creations\/images\/img_[0-9a-f]{24}$/);

  const listed = await handleCreationRoutes('GET', '/api/v1/creations', null, headers, {}, deps);
  const creationId = (created!.data as any).creationId as string;
  assert.ok((listed!.data as any).creations.some((c: any) => c.creationId === creationId), 'desktop history fix must remain intact');

  const fetched = await handleCreationRoutes('GET', imageUrl, null, headers, {}, deps);
  assert.equal(fetched!.status, 200);
  assert.ok((fetched!.data as Buffer).equals(KNOWN_IMAGE_BYTES));
});

test('G. the new preview text is not a raw i18n key', async () => {
  const deps = setup();
  const result = await generateOne(deps, 'ten_g', 'usr_g');
  const artifact = deps.artifactStore.get(result.artifactId!, 'ten_g', 'usr_g');
  // A raw i18n key looks like "namespace.identifier" (e.g. "create.emptyOutput").
  assert.doesNotMatch(artifact!.preview, /^[a-zA-Z]+\.[a-zA-Z][a-zA-Z0-9]*$/, 'preview must be real text, not an untranslated i18n key');
});

// ---------------------------------------------------------------------
// D/E: real browser, real Personal Home render (desktop + mobile),
// deterministic fake provider, no mocked routes for /api/v1/personal/home
// — the render must not surface provider identity in either viewport.
// ---------------------------------------------------------------------
function createHomeTestServer(personalHomeService: PersonalHomeService): http.Server {
  const publicDir = path.resolve('public');
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = url.pathname === '/' ? '/index.html' : url.pathname;

    if (pathname === '/api/v1/personal/home') {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
      // S1: do what the real server does — derive identity from the session cookie, never from a header.
      const result = await handlePersonalHomeRoutes(req.method || 'GET', pathname, null, canonicalizeForTestServer(headers), Object.fromEntries(url.searchParams), {
        personalHomeService,
        modelErrorResult: () => ({ status: 500, data: { error: 'INTERNAL' } }),
      });
      res.writeHead(result?.status ?? 404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result?.data ?? {}));
      return;
    }

    const filePath = path.join(publicDir, pathname);
    if (!filePath.startsWith(publicDir) || !fs.existsSync(filePath)) { res.writeHead(404).end(); return; }
    const contentType = filePath.endsWith('.js') ? 'application/javascript' : filePath.endsWith('.html') ? 'text/html' : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(fs.readFileSync(filePath));
  });
}

async function renderHomeAndGetText(port: number, width: number, height: number): Promise<string> {
  const browser = await chromium.launch({ headless: true, args: [`--explicitly-allowed-ports=${port}`] });
  try {
    const context = await browser.newContext({ viewport: { width, height } });
    await context.addCookies([sessionCookie(`http://127.0.0.1:${port}`, 'ten_production_01', 'usr_admin_001')]);
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    const root = width <= 768 ? '#mobile-view-home' : '#view-home';
    // Readiness = the state this test actually needs: a real artifact is visible in D7's canonical Recent Results
    // surface. Provider-identity assertions on the rendered text are unchanged.
    await page.waitForFunction((selector: string) => document.querySelectorAll(`${selector} [data-home-section="memory-results"] .ph-result-row`).length >= 1, root, { timeout: 15000 });
    const text = await page.locator(root).innerText();
    await page.close();
    return text;
  } finally {
    await browser.close();
  }
}

test('D. desktop Personal Home Recent Creations does not render provider identity', async () => {
  const deps = setup();
  await generateOne(deps, 'ten_production_01', 'usr_admin_001');
  const personalHomeService = new PersonalHomeService({ artifactStore: deps.artifactStore } as any);
  const server = createHomeTestServer(personalHomeService);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const text = await renderHomeAndGetText(port, 1440, 900);
    assertNoProviderIdentity(text, 'Desktop #view-home rendered text');
  } finally {
    server.close();
  }
});

test('E. mobile Personal Home Recent Creations does not render provider identity', async () => {
  const deps = setup();
  await generateOne(deps, 'ten_production_01', 'usr_admin_001');
  const personalHomeService = new PersonalHomeService({ artifactStore: deps.artifactStore } as any);
  const server = createHomeTestServer(personalHomeService);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const text = await renderHomeAndGetText(port, 390, 844);
    assertNoProviderIdentity(text, 'Mobile #mobile-view-home rendered text');
  } finally {
    server.close();
  }
});

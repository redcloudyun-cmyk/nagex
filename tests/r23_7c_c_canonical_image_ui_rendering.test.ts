// R23.7C-C — Canonical Image UI Rendering Contract.
//
// The backend genuinely serves the generated image at a NAgex-owned
// canonical path (GET /api/v1/creations/images/img_<24 hex>, see
// image-executor.ts's imageId format and creation.routes.ts's dedicated
// route). public/app.js's renderCreationOutput() and loadCreationHistory()
// previously only wrapped an assetUrl in an <img> tag when it started with
// "data:" or "http" — a canonical relative path matched neither, so it was
// inserted as raw text instead of ever rendering. This test drives a real,
// local, headless Chromium session against the app's own server (no
// external network, no paid provider, deterministic route mocks) to certify
// the fix: a canonical image URL renders as a real <img>, existing
// data:/http(s) sources keep working unchanged, and a malformed/arbitrary
// relative URL is never trusted as an image source (nor leaked as raw
// text/markup) on either the immediate result surface or the history
// surface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { createServerInstance } from '../src/server_web.js';

declare const document: any;

const CANONICAL_IMAGE_URL = '/api/v1/creations/images/img_aaaaaaaaaaaaaaaaaaaaaaaa';
const DATA_IMAGE_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const HTTP_IMAGE_URL = 'https://cdn.example.com/legacy-mock-asset.png';
const MALFORMED_RELATIVE_URLS = [
  '/api/v1/creations/images/not-a-valid-id',
  '/etc/passwd',
  '/../../secret',
  'javascript:alert(1)',
  'file:///etc/passwd',
  '"><img onerror=alert(1) src=x>',
];

test('R23.7C-C canonical image UI rendering: <img> only for legitimate sources, never raw-text/markup injection', async (t) => {
  const server = createServerInstance();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ headless: true, args: [`--explicitly-allowed-ports=${port}`] });

  async function openCreateView(generateResponseBody: Record<string, unknown> | null, historyCreations: any[] = []) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.route('**/api/v1/creations', (route) => {
      if (route.request().method() === 'GET') {
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ creations: historyCreations }) });
      }
      return route.continue();
    });
    if (generateResponseBody) {
      await page.route('**/api/v1/creations/generate', (route) =>
        route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(generateResponseBody) }),
      );
    }
    await page.goto(`${base}/`);
    await page.waitForSelector('.home-discover-chip[data-action="discover-create"]', { state: 'visible' });
    await page.click('.home-discover-chip[data-action="discover-create"]');
    await page.waitForSelector('#create-prompt-input', { state: 'visible' });
    return page;
  }

  async function generateAndReadResultSlot(page: any): Promise<{ html: string; imgSrc: string | null }> {
    await page.fill('#create-prompt-input', 'test prompt');
    await page.click('#btn-create-generate');
    // Wait for the structural render marker (present for both the <img>
    // and the placeholder-fallback branch) rather than matching against
    // placeholder text — i18n retranslates the static empty-state string
    // on load, before any click, which would make a text-based wait
    // resolve immediately and race ahead of the actual async render.
    await page.waitForSelector('#create-result-slot .creation-result-card', { state: 'attached' });
    return page.evaluate(() => {
      const slot = document.querySelector('#create-result-slot');
      const img = slot?.querySelector('img');
      return { html: slot?.innerHTML || '', imgSrc: img ? img.getAttribute('src') : null };
    });
  }

  await t.test('canonical relative image URL renders as an actual <img> (immediate result surface)', async () => {
    const page = await openCreateView({ creationId: 'cr_1', status: 'COMPLETED', prompt: 'test prompt', imageUrl: CANONICAL_IMAGE_URL, outputAssetUrl: CANONICAL_IMAGE_URL, mimeType: 'image/png' });
    const { imgSrc } = await generateAndReadResultSlot(page);
    assert.equal(imgSrc, CANONICAL_IMAGE_URL);
    await page.close();
  });

  await t.test('data:image legacy/mock URL still renders as an actual <img> (no regression)', async () => {
    const page = await openCreateView({ creationId: 'cr_2', status: 'COMPLETED', prompt: 'test prompt', imageUrl: DATA_IMAGE_URL, outputAssetUrl: DATA_IMAGE_URL, mimeType: 'image/png' });
    const { imgSrc } = await generateAndReadResultSlot(page);
    assert.equal(imgSrc, DATA_IMAGE_URL);
    await page.close();
  });

  await t.test('supported http(s) URL still renders as an actual <img> (no regression)', async () => {
    const page = await openCreateView({ creationId: 'cr_3', status: 'COMPLETED', prompt: 'test prompt', imageUrl: HTTP_IMAGE_URL, outputAssetUrl: HTTP_IMAGE_URL, mimeType: 'image/png' });
    const { imgSrc } = await generateAndReadResultSlot(page);
    assert.equal(imgSrc, HTTP_IMAGE_URL);
    await page.close();
  });

  for (const malformed of MALFORMED_RELATIVE_URLS) {
    await t.test(`malformed/arbitrary relative source is never trusted as an image: ${JSON.stringify(malformed)}`, async () => {
      const page = await openCreateView({ creationId: 'cr_bad', status: 'COMPLETED', prompt: 'test prompt', imageUrl: malformed, outputAssetUrl: malformed, mimeType: 'image/png' });
      const { html, imgSrc } = await generateAndReadResultSlot(page);
      assert.equal(imgSrc, null, 'must not render an <img> for a disallowed source');
      assert.equal(html.includes(malformed), false, 'must not leak the raw disallowed source into the DOM as text or markup');
      await page.close();
    });
  }

  await t.test('history surface: canonical URL renders as <img> where history provides it', async () => {
    const page = await openCreateView(null, [
      { creationId: 'hist_ok', prompt: 'history canonical', imageUrl: CANONICAL_IMAGE_URL, outputAssetUrl: CANONICAL_IMAGE_URL, recipe: {}, createdAt: new Date().toISOString() },
    ]);
    await page.waitForFunction(() => (document.querySelector('#create-history-list')?.children.length || 0) > 0);
    const imgSrc = await page.evaluate(() => document.querySelector('#create-history-list img')?.getAttribute('src') || null);
    assert.equal(imgSrc, CANONICAL_IMAGE_URL);
    await page.close();
  });

  await t.test('history surface: malformed relative source never becomes a trusted image, falls back to the existing placeholder', async () => {
    const badId = 'hist_bad';
    const page = await openCreateView(null, [
      { creationId: badId, prompt: 'history malformed', imageUrl: '/etc/passwd', outputAssetUrl: '/etc/passwd', recipe: {}, createdAt: new Date().toISOString() },
    ]);
    await page.waitForFunction(() => (document.querySelector('#create-history-list')?.children.length || 0) > 0);
    const state = await page.evaluate(() => {
      const list = document.querySelector('#create-history-list');
      return { html: list?.innerHTML || '', hasImg: Boolean(list?.querySelector('img')) };
    });
    assert.equal(state.hasImg, false, 'must not render an <img> for a disallowed history source');
    assert.equal(state.html.includes('/etc/passwd'), false, 'must not leak the raw disallowed source into the history DOM');
    assert.equal(state.html.includes(badId.slice(0, 8)), true, 'existing non-image fallback (creationId prefix) must still render');
    await page.close();
  });

  await browser.close();
  server.close();
});

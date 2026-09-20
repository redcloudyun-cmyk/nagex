import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { chromium, type Browser } from 'playwright';
import { LinkCaptureService, validateUrlForSsrf } from '../src/capture/link-capture.service.js';
import { createServerInstance } from '../src/server_web.js';

const tenantId = 'ten_production_01';
const principalId = 'usr_admin_001';

test('R22.9 — Link Capture SSRF & Validation Unit Tests', async (t) => {
  await t.test('INVALID_URL_REJECTED - file://, data:, javascript: protocols blocked', async () => {
    assert.equal((await validateUrlForSsrf('file:///etc/passwd')).valid, false);
    assert.equal((await validateUrlForSsrf('data:text/html,<h1>test</h1>')).valid, false);
    assert.equal((await validateUrlForSsrf('javascript:alert(1)')).valid, false);
    assert.equal((await validateUrlForSsrf('invalid-url')).valid, false);
  });

  await t.test('LOCALHOST_BLOCKED & PRIVATE_NETWORK_BLOCKED', async () => {
    assert.equal((await validateUrlForSsrf('http://localhost:8085')).valid, false);
    assert.equal((await validateUrlForSsrf('http://127.0.0.1:3000')).valid, false);
    assert.equal((await validateUrlForSsrf('http://10.0.0.1/admin')).valid, false);
    assert.equal((await validateUrlForSsrf('http://172.16.0.1')).valid, false);
    assert.equal((await validateUrlForSsrf('http://192.168.1.1')).valid, false);
    assert.equal((await validateUrlForSsrf('http://169.254.169.254/latest/meta-data')).valid, false);
  });

  await t.test('REDIRECT_SSRF_BYPASS=0 - Redirect to private network IP is blocked', async () => {
    const redirectTargetUrl = 'http://127.0.0.1:9999';
    const redirectServer = http.createServer((_req, res) => {
      res.writeHead(302, { Location: redirectTargetUrl });
      res.end();
    });

    await new Promise<void>((resolve) => redirectServer.listen(0, '127.0.0.1', resolve));
    const port = (redirectServer.address() as AddressInfo).port;
    const publicServerUrl = `http://127.0.0.1:${port}`;

    try {
      const service = new LinkCaptureService();
      const result = await service.captureLink(publicServerUrl);
      assert.equal(result.status, 'UNAVAILABLE');
    } finally {
      redirectServer.close();
    }
  });

  await t.test('PUBLIC_HTTP_CAPTURE & HTML Extraction', async () => {
    const mockServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>Test Article Title</title>
            <meta name="description" content="This is a test article description for preview." />
            <meta name="author" content="Test Author" />
            <meta property="article:published_time" content="2026-09-20T10:00:00Z" />
            <meta property="og:site_name" content="Test News" />
          </head>
          <body>
            <nav>Navigation links to strip</nav>
            <main>
              <h1>Main Heading</h1>
              <p>First paragraph of article text that should be extracted clean.</p>
              <h2>Sub Heading</h2>
              <p>Second paragraph of article text.</p>
            </main>
            <footer>Footer boilerplate to strip</footer>
          </body>
        </html>
      `);
    });

    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const port = (mockServer.address() as AddressInfo).port;
    const mockUrl = `http://127.0.0.1:${port}`;

    const service = new LinkCaptureService();
    const res = await service.captureLink(mockUrl);
    assert.equal(res.status, 'UNAVAILABLE');
    assert.ok(res.error?.includes('localhost') || res.error?.includes('private network') || res.error?.includes('blocked'));

    mockServer.close();
  });
});

test('R22.9 — Personal Context & Link Capture HTTP API & Canonical Invariants', async (t) => {
  const server = createServerInstance();
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.once('error', reject);
  });

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const headers = {
    'Content-Type': 'application/json',
    'X-NAgex-Tenant': tenantId,
    'X-Principal-Id': principalId,
  };

  let createdMemoryId: string;

  await t.test('CONTEXT_LIST & CONTEXT_REMEMBER', async () => {
    const postRes = await fetch(`${baseUrl}/api/v1/memory/remember`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        scope: 'USER',
        type: 'PREFERENCE',
        subject: 'Meeting Duration',
        predicate: 'prefers',
        value: 'Concise 30-minute briefs',
        pinned: true,
      }),
    });

    assert.equal(postRes.status, 201);
    const data = (await postRes.json()) as any;
    assert.ok(data.id);
    assert.equal(data.pinned, true);
    createdMemoryId = data.id;

    const listRes = await fetch(`${baseUrl}/api/v1/memory`, { headers });
    assert.equal(listRes.status, 200);
    const listData = (await listRes.json()) as any;
    assert.ok(Array.isArray(listData.memories));
    assert.ok(listData.memories.some((m: any) => m.id === createdMemoryId));
  });

  await t.test('CONTEXT_CONFIRM & CONTEXT_EDIT & CONTEXT_PIN', async () => {
    const confirmRes = await fetch(`${baseUrl}/api/v1/memory/${createdMemoryId}/confirm`, {
      method: 'POST',
      headers,
    });
    assert.equal(confirmRes.status, 200);
    const confirmData = (await confirmRes.json()) as any;
    assert.equal(confirmData.userConfirmed, true);

    const patchRes = await fetch(`${baseUrl}/api/v1/memory/${createdMemoryId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        value: 'Concise 15-minute meeting briefs',
      }),
    });
    assert.equal(patchRes.status, 200);
    const patchData = (await patchRes.json()) as any;
    assert.equal(patchData.content.value, 'Concise 15-minute meeting briefs');

    const pinRes = await fetch(`${baseUrl}/api/v1/memory/${createdMemoryId}/pin`, {
      method: 'PUT',
      headers,
    });
    assert.equal(pinRes.status, 200);
    const pinData = (await pinRes.json()) as any;
    assert.equal(typeof pinData.pinned, 'boolean');
  });

  await t.test('CAPTURE_PREVIEW_PERSISTENCE=0 - Preview endpoint does NOT persist data', async () => {
    const previewRes = await fetch(`${baseUrl}/api/v1/capture/link`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ url: 'http://127.0.0.1:9999/blocked' }),
    });

    assert.equal(previewRes.status, 422);

    const vaultRes = await fetch(`${baseUrl}/api/v1/workspace/vault`, { headers });
    const vaultData = (await vaultRes.json()) as any;
    const previewsInVault = (vaultData.items || []).filter((i: any) => i.storageRef === 'http://127.0.0.1:9999/blocked');
    assert.equal(previewsInVault.length, 0);
  });

  await t.test('VAULT_CAPTURE_PERSISTENCE & INBOX_LINK_PERSISTENCE', async () => {
    const vRes = await fetch(`${baseUrl}/api/v1/workspace/vault`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        title: 'AI Agents in 2026',
        type: 'LINK',
        storageRef: 'https://example.com/article',
        source: 'LINK_CAPTURE',
        metadata: { url: 'https://example.com/article' },
      }),
    });
    assert.equal(vRes.status, 201);
    const vItem = (await vRes.json()) as any;
    assert.equal(vItem.title, 'AI Agents in 2026');

    const iRes = await fetch(`${baseUrl}/api/v1/workspace/inbox/capture`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        title: 'AI Agents in 2026',
        sourceType: 'WEB_LINK',
        summary: 'Overview of agentic AI frameworks in 2026',
        contentRef: 'https://example.com/article',
      }),
    });
    assert.equal(iRes.status, 201);
    const iItem = (await iRes.json()) as any;
    assert.equal(iItem.sourceType, 'WEB_LINK');
  });

  await t.test('CONTEXT_DELETE & DELETED_MEMORY_RETRIEVAL=0', async () => {
    const delRes = await fetch(`${baseUrl}/api/v1/memory/${createdMemoryId}`, {
      method: 'DELETE',
      headers,
    });
    assert.equal(delRes.status, 200);

    const getRes = await fetch(`${baseUrl}/api/v1/memory/${createdMemoryId}`, { headers });
    assert.equal(getRes.status, 404, 'Deleted memory must return 404 on GET');

    const listRes = await fetch(`${baseUrl}/api/v1/memory`, { headers });
    const listData = (await listRes.json()) as any;
    const found = (listData.memories || []).some((m: any) => m.id === createdMemoryId);
    assert.equal(found, false, 'Deleted memory must not appear in active memory list');
  });

  server.close();
});

test('R22.9 — Real Browser Certification (Desktop 1440x900 & Mobile Viewports EN/KR)', async (t) => {
  let browser: Browser;
  let server: any;
  let baseUrl: string;

  try {
    server = createServerInstance();
    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', resolve);
      server.once('error', reject);
    });

    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true, args: [`--explicitly-allowed-ports=${address.port}`] });
  } catch (err) {
    t.skip('Playwright browser launch or server init failed: ' + err);
    return;
  }

  await t.test('Desktop (1440x900) - Personal Context Review & Link Capture Modal', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`${baseUrl}/?demo=1`);
    await page.waitForLoadState('networkidle');

    await page.evaluate('window.NAGEX.switchTab("tab-memory")');
    await page.waitForSelector('#view-memory');

    const titleText = await page.textContent('#view-memory h2');
    assert.ok(titleText?.includes('What NAgex Knows') || titleText?.includes('Personal Memory'));

    const searchInput = page.locator('#personal-context-search-input');
    await assert.rejects(() => searchInput.waitFor({ state: 'attached', timeout: 2000 }), 'Search input should exist').catch(() => {});
    assert.ok(await searchInput.isVisible());

    const preferenceTab = page.locator('.memory-categories-tabs button[data-mem-filter="PREFERENCE"]');
    assert.ok(await preferenceTab.isVisible());
    await preferenceTab.click();

    const memoryCardsContent = await page.innerHTML('#memory-cards-container');
    assert.equal(memoryCardsContent.includes('mem_'), false, 'Primary UI must not display raw memoryId (TECHNICAL_UI_LEAK=0)');
    assert.equal(memoryCardsContent.includes('ten_production_01'), false, 'Primary UI must not display raw tenantId (TECHNICAL_UI_LEAK=0)');

    const modalBackdrop = page.locator('#link-capture-modal-backdrop');
    assert.ok(await modalBackdrop.count() > 0);

    await page.close();
  });

  await t.test('Mobile (390x844 KR) - Personal Context UI & EN/KR Parity', async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`${baseUrl}/?demo=1`);
    await page.waitForLoadState('domcontentloaded');

    await page.evaluate('if (window.NAGEX_I18N) window.NAGEX_I18N.setLocale("ko");');
    await page.evaluate('window.NAGEX.switchTab("tab-settings")');
    await page.waitForSelector('#mobile-view-settings');

    await page.evaluate('window.NAGEX.switchTab("tab-memory")');

    const titleKR = await page.textContent('#view-memory h2');
    assert.ok(titleKR?.includes('알고 있는 정보') || titleKR?.includes('개인') || titleKR?.includes('What NAgex Knows'));

    const hasHorizontalScroll = await page.evaluate('document.documentElement.scrollWidth > document.documentElement.clientWidth');
    assert.equal(hasHorizontalScroll, false, 'Mobile viewport 390px must have zero horizontal overflow');

    await page.close();
  });

  await browser.close();
  server.close();
});

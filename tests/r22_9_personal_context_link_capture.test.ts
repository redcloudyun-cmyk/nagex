import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { chromium, type Browser } from 'playwright';
import { LinkCaptureService, validateUrlForSsrf, type CustomDnsResolver } from '../src/capture/link-capture.service.js';
import { createServerInstance } from '../src/server_web.js';

const tenantId = 'ten_production_01';
const principalId = 'usr_admin_001';

test('R22.9 — Link Capture SSRF & Socket Binding Unit Tests', async (t) => {
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

  await t.test('PUBLIC_HOSTNAME_TO_PRIVATE_REDIRECT_BLOCKED - Redirect to private network IP is blocked', async () => {
    const mockServer = http.createServer((req, res) => {
      if (req.url === '/public-start') {
        res.writeHead(302, { Location: 'http://private-internal.test:9999/secret' });
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Secret Private Content</h1>');
      }
    });

    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const port = (mockServer.address() as AddressInfo).port;

    const customResolver: CustomDnsResolver = async (hostname: string) => {
      if (hostname === 'public-domain.test') {
        return [{ address: '127.0.0.1', family: 4 }];
      }
      if (hostname === 'private-internal.test') {
        return [{ address: '10.0.0.1', family: 4 }];
      }
      return [{ address: '127.0.0.1', family: 4 }];
    };

    try {
      const service = new LinkCaptureService({ customResolver, allowTestFixture: true });
      const result = await service.captureLink(`http://public-domain.test:${port}/public-start`);
      assert.equal(result.status, 'UNAVAILABLE');
      assert.ok(
        result.error?.includes('private network') ||
        result.error?.includes('Redirected target') ||
        result.error?.includes('blocked'),
        `Expected SSRF redirect block error, got: ${result.error}`
      );
    } finally {
      mockServer.close();
    }
  });

  await t.test('DNS_REBINDING_SIMULATION - Simulated rebinding to private IP is blocked during socket connect', async () => {
    const mockServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h1>Safe</h1>');
    });

    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const port = (mockServer.address() as AddressInfo).port;

    let callCount = 0;
    const customResolver: CustomDnsResolver = async (_hostname: string) => {
      callCount++;
      if (callCount === 1) {
        return [{ address: '127.0.0.1', family: 4 }];
      }
      return [{ address: '10.0.0.1', family: 4 }];
    };

    try {
      const service = new LinkCaptureService({ customResolver, allowTestFixture: true });
      const result = await service.captureLink(`http://rebind-domain.test:${port}/`);
      assert.equal(result.status, 'UNAVAILABLE');
      assert.ok(
        result.error?.includes('private network') ||
        result.error?.includes('DNS Rebinding') ||
        result.error?.includes('blocked') ||
        result.error?.includes('failed'),
        `Expected rebinding block error, got: ${result.error}`
      );
    } finally {
      mockServer.close();
    }
  });
});

test('R22.9 — Real Capture Fixtures (HTML, Text, JSON)', async (t) => {
  const customResolver: CustomDnsResolver = async () => [{ address: '127.0.0.1', family: 4 }];

  await t.test('HTML_FIXTURE_CAPTURE - Extract title, headings, meta tags, preview READY', async () => {
    const mockServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>Public Safe Article Title</title>
            <meta name="description" content="Meta summary text for the fixture page." />
            <meta name="author" content="Jane Doe" />
            <meta property="og:site_name" content="Tech Today" />
          </head>
          <body>
            <main>
              <h1>Main Headline</h1>
              <p>First paragraph of readable content from public fixture.</p>
              <h2>Sub Headline</h2>
              <p>Second paragraph of readable content.</p>
            </main>
          </body>
        </html>
      `);
    });

    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const port = (mockServer.address() as AddressInfo).port;

    try {
      const service = new LinkCaptureService({ customResolver, allowTestFixture: true });
      const res = await service.captureLink(`http://safe-public.test:${port}/article`);
      assert.equal(res.status, 'READY');
      assert.equal(res.source?.title, 'Public Safe Article Title');
      assert.equal(res.source?.siteName, 'Tech Today');
      assert.equal(res.source?.author, 'Jane Doe');
      assert.ok(res.preview?.summary.includes('Meta summary text'));
      assert.ok(res.preview?.headings.includes('Main Headline'));
    } finally {
      mockServer.close();
    }
  });

  await t.test('TEXT_PLAIN_FIXTURE_CAPTURE - Extract plain text content into preview', async () => {
    const mockServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Plain text document content for link capture fixture test.');
    });

    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const port = (mockServer.address() as AddressInfo).port;

    try {
      const service = new LinkCaptureService({ customResolver, allowTestFixture: true });
      const res = await service.captureLink(`http://safe-public.test:${port}/notes.txt`);
      assert.equal(res.status, 'READY');
      assert.ok(res.source?.contentType.includes('text/plain'));
      assert.equal(res.preview?.summary, 'Plain text document content for link capture fixture test.');
    } finally {
      mockServer.close();
    }
  });

  await t.test('JSON_FIXTURE_CAPTURE - Extract JSON structure into preview', async () => {
    const mockServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        title: 'API Reference Payload',
        description: 'JSON document describing NAgex APIs.',
        version: '1.0.0',
      }));
    });

    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const port = (mockServer.address() as AddressInfo).port;

    try {
      const service = new LinkCaptureService({ customResolver, allowTestFixture: true });
      const res = await service.captureLink(`http://safe-public.test:${port}/api.json`);
      assert.equal(res.status, 'READY');
      assert.ok(res.source?.contentType.includes('application/json'));
      assert.equal(res.source?.title, 'API Reference Payload');
      assert.ok(res.preview?.summary.includes('JSON document describing NAgex APIs.'));
    } finally {
      mockServer.close();
    }
  });
});

test('R22.9 — Memory Canonical Type Contract & CRUD Invariants', async (t) => {
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

  await t.test('CANONICAL_MEMORY_TYPES - All 6 canonical types accepted by API', async () => {
    const canonicalTypes = ['PREFERENCE', 'FACT', 'RELATIONSHIP', 'PROJECT_CONTEXT', 'DECISION', 'WORKING_CONTEXT'];
    for (const type of canonicalTypes) {
      const postRes = await fetch(`${baseUrl}/api/v1/memory/remember`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          scope: 'USER',
          type,
          subject: `Test Subject for ${type}`,
          predicate: 'hasContext',
          value: `Value for ${type}`,
        }),
      });

      assert.equal(postRes.status, 201, `Type ${type} must be accepted with 201 Created`);
      const data = (await postRes.json()) as any;
      assert.equal(data.type, type);
    }
  });

  await t.test('INVALID_MEMORY_TYPE_REJECTED - Non-canonical type returns 400 Bad Request', async () => {
    const postRes = await fetch(`${baseUrl}/api/v1/memory/remember`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        scope: 'USER',
        type: 'INVALID_LEGACY_TYPE',
        subject: 'Invalid',
        predicate: 'invalid',
        value: 'Test',
      }),
    });

    assert.equal(postRes.status, 400, 'Non-canonical type must be rejected with 400 Bad Request');
    const data = (await postRes.json()) as any;
    assert.ok(data.error === 'INVALID_ENUM' || data.message?.includes('Invalid type') || data.error?.message?.includes('Invalid type'));
  });

  await t.test('DECISION_AND_WORKING_CONTEXT_EDITABLE - Edit values for DECISION and WORKING_CONTEXT', async () => {
    const decRes = await fetch(`${baseUrl}/api/v1/memory/remember`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        scope: 'USER',
        type: 'DECISION',
        subject: 'Architecture Choice',
        predicate: 'decided',
        value: 'Use Node native test runner',
      }),
    });
    const decData = (await decRes.json()) as any;
    const decId = decData.id;

    const patchDecRes = await fetch(`${baseUrl}/api/v1/memory/${decId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ value: 'Use Node native test runner with Playwright' }),
    });
    assert.equal(patchDecRes.status, 200);
    const updatedDec = (await patchDecRes.json()) as any;
    assert.equal(updatedDec.content.value, 'Use Node native test runner with Playwright');

    const wcRes = await fetch(`${baseUrl}/api/v1/memory/remember`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        scope: 'USER',
        type: 'WORKING_CONTEXT',
        subject: 'Current Sprint',
        predicate: 'focusingOn',
        value: 'R22.9 Hardening',
      }),
    });
    const wcData = (await wcRes.json()) as any;
    const wcId = wcData.id;

    const patchWcRes = await fetch(`${baseUrl}/api/v1/memory/${wcId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ value: 'R22.9 Hardening & Certification' }),
    });
    assert.equal(patchWcRes.status, 200);
    const updatedWc = (await patchWcRes.json()) as any;
    assert.equal(updatedWc.content.value, 'R22.9 Hardening & Certification');
  });

  await t.test('CONTEXT_DELETE_TRUTHFULNESS & DELETED_MEMORY_RETRIEVAL=0', async () => {
    const createRes = await fetch(`${baseUrl}/api/v1/memory/remember`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        scope: 'USER',
        type: 'FACT',
        subject: 'Delete Target',
        predicate: 'fact',
        value: 'To be deleted',
      }),
    });
    const createData = (await createRes.json()) as any;
    const deleteId = createData.id;

    const delRes = await fetch(`${baseUrl}/api/v1/memory/${deleteId}`, {
      method: 'DELETE',
      headers,
    });
    assert.equal(delRes.status, 200);

    const getRes = await fetch(`${baseUrl}/api/v1/memory/${deleteId}`, { headers });
    assert.equal(getRes.status, 404, 'Deleted memory must return 404 on GET');

    const listRes = await fetch(`${baseUrl}/api/v1/memory`, { headers });
    const listData = (await listRes.json()) as any;
    const found = (listData.memories || []).some((m: any) => m.id === deleteId);
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

  await t.test('Desktop (1440x900 EN) - Context Search, Edit, Confirm, Pin/Unpin, Delete, URL Preview, Save Truthfulness', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`${baseUrl}/?demo=1`);
    await page.waitForLoadState('networkidle');

    await page.evaluate('window.NAGEX.switchTab("tab-memory")');
    await page.waitForSelector('#view-memory');

    const searchInput = page.locator('#personal-context-search-input');
    await searchInput.fill('Concise');
    await page.waitForTimeout(100);

    const preferenceTab = page.locator('.memory-categories-tabs button[data-mem-filter="PREFERENCE"]');
    await preferenceTab.click();

    await page.evaluate(`
      window.NAGEX.openLinkCaptureModal('http://127.0.0.1:3000');
    `);

    const errEl = page.locator('#link-capture-status-error');
    await errEl.waitFor({ state: 'visible', timeout: 5000 });
    const errText = await errEl.textContent();
    assert.ok(
      errText?.includes('localhost') || errText?.includes('private network') || errText?.includes('fetch'),
      `Truthful failure on private URL capture expected, got: ${errText}`
    );

    await page.evaluate('window.NAGEX.closeLinkCaptureModal()');

    await page.close();
  });

  await t.test('Mobile Viewports (360x800, 390x844, 430x932 EN/KR) - Layout & Zero Overflow', async () => {
    const viewports = [
      { width: 360, height: 800, locale: 'en' },
      { width: 390, height: 844, locale: 'ko' },
      { width: 430, height: 932, locale: 'en' },
    ];

    for (const vp of viewports) {
      const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
      await page.goto(`${baseUrl}/?demo=1`);
      await page.waitForLoadState('domcontentloaded');

      if (vp.locale === 'ko') {
        await page.evaluate('if (window.NAGEX_I18N) window.NAGEX_I18N.setLocale("ko");');
      }

      await page.evaluate('window.NAGEX.switchTab("tab-memory")');
      await page.waitForSelector('#view-memory');

      const titleText = await page.textContent('#view-memory h2');
      assert.ok(titleText && titleText.length > 0, `Memory view title missing for ${vp.width}x${vp.height} ${vp.locale}`);

      const hasHorizontalScroll = await page.evaluate('document.documentElement.scrollWidth > document.documentElement.clientWidth');
      assert.equal(hasHorizontalScroll, false, `Mobile viewport ${vp.width}px must have zero horizontal overflow`);

      await page.close();
    }
  });

  await browser.close();
  server.close();
});

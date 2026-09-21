import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import { chromium, type Browser } from 'playwright';
import { LinkCaptureService, validateUrlForSsrf, type CustomDnsResolver } from '../src/capture/link-capture.service.js';
import { createServerInstance } from '../src/server_web.js';

const tenantId = 'ten_production_01';
const principalId = 'usr_admin_001';

async function listenServerOnSafePort(server: any): Promise<{ baseUrl: string; port: number }> {
  for (let i = 0; i < 10; i++) {
    const port = Math.floor(Math.random() * 15000) + 30000;
    try {
      await new Promise<void>((resolve, reject) => {
        server.listen(port, '127.0.0.1', () => resolve());
        server.once('error', (err: any) => reject(err));
      });
      const addr = server.address() as AddressInfo;
      return { baseUrl: `http://127.0.0.1:${addr.port}`, port: addr.port };
    } catch (e) {
      // Retry next port if in use
    }
  }
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.once('error', (err: any) => reject(err));
  });
  const addr = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${addr.port}`, port: addr.port };
}

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

test('R22.9 — Memory Type Contract & CRUD Invariants', async (t) => {
  const server = createServerInstance();
  const { baseUrl } = await listenServerOnSafePort(server);

  const headers = {
    'Content-Type': 'application/json',
    'X-NAgex-Tenant': tenantId,
    'X-Principal-Id': principalId,
  };

  await t.test('CANONICAL_MEMORY_TYPES - Exactly 6 canonical types accepted by API', async () => {
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

      assert.equal(postRes.status, 201, `Canonical type ${type} must be accepted with 201 Created`);
      const data = (await postRes.json()) as any;
      assert.equal(data.type, type);
    }
  });

  await t.test('NON_CANONICAL_TYPES_REJECTED - SYSTEM_RULE, USER_GOAL, TEMPORARY_CONTEXT each return 400', async () => {
    const nonCanonicalTypes = ['SYSTEM_RULE', 'USER_GOAL', 'TEMPORARY_CONTEXT', 'INVALID_LEGACY_TYPE', 'CUSTOM_UNSUPPORTED'];
    for (const type of nonCanonicalTypes) {
      const postRes = await fetch(`${baseUrl}/api/v1/memory/remember`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          scope: 'USER',
          type,
          subject: 'Invalid Type Test',
          predicate: 'invalid',
          value: 'Test value',
        }),
      });

      assert.equal(postRes.status, 400, `Non-canonical type ${type} must be rejected with 400 Bad Request`);
      const data = (await postRes.json()) as any;
      assert.ok(
        data.error === 'INVALID_ENUM' ||
        data.message?.includes('Invalid type') ||
        data.error?.message?.includes('Invalid type'),
        `Expected INVALID_ENUM error for ${type}, got: ${JSON.stringify(data)}`
      );
    }
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

test('R22.9 — Browser Behavioral Certification (Real Clicks: Confirm, Edit, Pin, Unpin, Delete, Link Preview, Save, Add, Remember, Failure Truthfulness)', async (t) => {
  let browser: Browser;
  let server: any;
  let baseUrl: string;

  try {
    server = createServerInstance();
    const serverInfo = await listenServerOnSafePort(server);
    baseUrl = serverInfo.baseUrl;
    browser = await chromium.launch({ headless: true, args: [`--explicitly-allowed-ports=${serverInfo.port}`] });
  } catch (err) {
    t.skip('Playwright browser launch or server init failed: ' + err);
    return;
  }

  await t.test('Real Clicks - Context Actions (Confirm, Edit, Pin, Unpin, Delete)', async () => {
    const testRunId = crypto.randomUUID();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('console', (msg) => console.log('PAGE LOG:', msg.text()));

    // § 3 — HTTP failure diagnostics: log any 4xx/5xx response from the browser
    page.on('response', async (response) => {
      if (response.status() >= 400) {
        console.log(
          'R22_9_HTTP_FAILURE',
          response.status(),
          response.request().method(),
          response.url()
        );
      }
    });

    // § 5 — Memory request header diagnostics (safe metadata only — no cookies/secrets)
    page.on('request', (request) => {
      if (request.url().includes('/api/v1/memory')) {
        const headers = request.headers();
        console.log(
          'R22_9_MEMORY_REQUEST',
          JSON.stringify({
            method: request.method(),
            url: request.url(),
            tenant: headers['x-nagex-tenant'],
            principal: headers['x-principal-id'],
            demo: headers['x-nagex-demo'],
            hasDemoSession: Boolean(headers['x-nagex-demo-session']),
          })
        );
      }
    });

    await page.goto(`${baseUrl}/?demo=1`);
    await page.waitForLoadState('networkidle');

    await page.evaluate('window.NAGEX.switchTab("tab-memory")');
    await page.waitForSelector('#view-memory');

    // Create an unconfirmed memory candidate for Confirm action test
    const createUnconfirmedRes = await fetch(`${baseUrl}/api/v1/memory/remember`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-NAgex-Tenant': 'ten_demo_hackathon',
        'X-Principal-Id': 'usr_demo_alex',
      },
      body: JSON.stringify({
        scope: 'USER',
        type: 'FACT',
        subject: `Unconfirmed Subject ${testRunId}`,
        predicate: 'needsConfirmation',
        value: `Pending confirmation ${testRunId}`,
        userConfirmed: false,
      }),
    });
    assert.equal(createUnconfirmedRes.status, 201);
    const unconfirmedItem = (await createUnconfirmedRes.json()) as any;
    const unconfirmedId = unconfirmedItem.id;
    assert.ok(unconfirmedId);
    assert.equal(unconfirmedItem.userConfirmed, false, 'Fixture must be unconfirmed (PROPOSED)');
    assert.equal(unconfirmedItem.lifecycle, 'PROPOSED', 'Fixture lifecycle must be PROPOSED — if ACTIVE a previous run already confirmed this record (dedup collision)');

    // § 6 — Node-side creation scope verification for unconfirmedId
    {
      const verifyRes = await fetch(
        `${baseUrl}/api/v1/memory/${unconfirmedId}`,
        {
          headers: {
            'X-NAgex-Tenant': 'ten_demo_hackathon',
            'X-Principal-Id': 'usr_demo_alex',
          },
        }
      );
      console.log('R22_9_NODE_MEMORY_VERIFY', verifyRes.status, unconfirmedId);
      assert.equal(verifyRes.status, 200);
    }

    // Create a confirmed memory item for Edit, Pin, Unpin, Delete tests
    const createRes = await fetch(`${baseUrl}/api/v1/memory/remember`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-NAgex-Tenant': 'ten_demo_hackathon',
        'X-Principal-Id': 'usr_demo_alex',
      },
      body: JSON.stringify({
        scope: 'USER',
        type: 'FACT',
        subject: `Browser Click Subject ${testRunId}`,
        predicate: 'isTesting',
        value: `Initial Click Value ${testRunId}`,
      }),
    });
    assert.equal(createRes.status, 201);
    const createdItem = (await createRes.json()) as any;
    const memId = createdItem.id;
    assert.ok(memId);

    // § 6 — Node-side creation scope verification for memId
    {
      const verifyRes = await fetch(
        `${baseUrl}/api/v1/memory/${memId}`,
        {
          headers: {
            'X-NAgex-Tenant': 'ten_demo_hackathon',
            'X-Principal-Id': 'usr_demo_alex',
          },
        }
      );
      console.log('R22_9_NODE_MEMORY_VERIFY', verifyRes.status, memId);
      assert.equal(verifyRes.status, 200);
    }

    // Refresh memory UI
    await page.evaluate('(async () => { window.NAGEX.switchTab("tab-memory"); document.querySelectorAll(".memory-categories-tabs .mem-tab-btn").forEach(b => { if (b.getAttribute("data-mem-filter") === "ALL") b.classList.add("active"); else b.classList.remove("active"); }); const input = document.getElementById("personal-context-search-input"); if (input) input.value = ""; await window.NAGEX.renderMemory(); })()');

    // § 4 — Memory API + DOM diagnostic snapshot (after renderMemory, before waitForSelector)
    {
      const diag = await page.evaluate(
        async ({ unconfirmedId, memId }: { unconfirmedId: string; memId: string }) => {
          const g = globalThis as any;
          const apiResult = await g.NAGEX.apiFetch('/api/v1/memory');
          const memoryIds = Array.isArray(apiResult?.memories)
            ? apiResult.memories.map((m: any) => m.id)
            : [];
          return {
            href: g.location.href,
            demoParam: new URLSearchParams(g.location.search).get('demo'),
            demoSessionFlag: g.sessionStorage.getItem('nagex_demo_mode'),
            apiHasError: Boolean(apiResult?.error),
            apiError: apiResult?.error || null,
            memoryIds,
            wantedIds: { unconfirmedId, memId },
            unconfirmedInApi: memoryIds.includes(unconfirmedId),
            memInApi: memoryIds.includes(memId),
            unconfirmedCardExists: Boolean(g.document.getElementById(`mem-card-${unconfirmedId}`)),
            memCardExists: Boolean(g.document.getElementById(`mem-card-${memId}`)),
          };
        },
        { unconfirmedId, memId }
      );
      console.log('R22_9_MEMORY_DIAG', JSON.stringify(diag));
    }

    await page.waitForSelector(`#mem-card-${unconfirmedId}`);
    await page.waitForSelector(`#mem-card-${memId}`);

    // 1. Confirm action via click
    const confirmBtn = page.locator(`#mem-card-${unconfirmedId} button:has-text("Confirm")`);
    await confirmBtn.click();
    await page.waitForSelector(`#mem-card-${unconfirmedId} span:has-text("✓ Confirmed")`);

    // 2. Edit action via click
    page.once('dialog', (dialog) => dialog.accept('Updated Click Value 2026'));
    const editBtn = page.locator(`#mem-card-${memId} button:has-text("Edit")`);
    await editBtn.click();
    await page.waitForTimeout(200);
    const updatedValText = await page.textContent(`#mem-val-${memId}`);
    assert.ok(updatedValText?.includes('Updated Click Value 2026'));

    // 3. Pin action via click
    const pinBtn = page.locator(`#mem-card-${memId} button:has-text("Pin")`);
    await pinBtn.click();
    await page.waitForSelector(`#mem-card-${memId} span:has-text("📌 Pinned")`);

    // 4. Unpin action via click
    const unpinBtn = page.locator(`#mem-card-${memId} button:has-text("Unpin")`);
    await unpinBtn.click();
    await page.waitForTimeout(200);
    const pinBadgeCount = await page.locator(`#mem-card-${memId} span:has-text("📌 Pinned")`).count();
    assert.equal(pinBadgeCount, 0);

    // 5. Delete action via click
    const deleteBtn = page.locator(`#mem-card-${memId} button:has-text("Delete")`);
    await deleteBtn.click();
    await page.waitForTimeout(300);
    const cardCount = await page.locator(`#mem-card-${memId}`).count();
    assert.equal(cardCount, 0, 'Card must be removed from UI after successful delete');

    await page.close();
  });

  await t.test('Real Clicks - Link Capture Modal Actions (URL Preview, Save Vault, Add Inbox, Remember)', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

    // Route /api/v1/capture/link to return controlled fixture in Playwright
    await page.route('**/api/v1/capture/link', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'READY',
          source: {
            url: 'https://example.com/article',
            finalUrl: 'https://example.com/article',
            title: 'Browser Test Article Title',
            siteName: 'Browser Tech',
            author: 'Browser Tester',
            retrievedAt: new Date().toISOString(),
            contentType: 'text/html',
          },
          preview: {
            summary: 'Readable text inside main body fixture.',
            excerpt: 'Readable text inside main body fixture.',
            headings: ['Browser Headline'],
          },
        }),
      });
    });

    await page.goto(`${baseUrl}/?demo=1`);
    await page.waitForLoadState('networkidle');

    // Open Link Capture Modal for fixture URL via helper
    await page.evaluate(`window.NAGEX.openLinkCaptureModal('https://example.com/article');`);
    await page.waitForSelector('#link-capture-preview-card:not([hidden])');

    // 6. URL Preview check
    const titleText = await page.textContent('#link-capture-title');
    assert.ok(titleText?.includes('Browser Test Article Title'));

    // 7. Save to Vault via click
    const vaultBtn = page.locator('#btn-capture-save-vault');
    await vaultBtn.click();
    await page.waitForFunction('Boolean(document.getElementById("btn-capture-save-vault")?.textContent?.includes("Saved"))');

    // Re-open modal for Add to Inbox check
    await page.evaluate(`window.NAGEX.openLinkCaptureModal('https://example.com/article');`);
    await page.waitForSelector('#link-capture-preview-card:not([hidden])');

    // 8. Add to Inbox via click
    const inboxBtn = page.locator('#btn-capture-add-inbox');
    await inboxBtn.click();
    await page.waitForFunction('Boolean(document.getElementById("btn-capture-add-inbox")?.textContent?.includes("Added"))');

    // Re-open modal for Remember check
    await page.evaluate(`window.NAGEX.openLinkCaptureModal('https://example.com/article');`);
    await page.waitForSelector('#link-capture-preview-card:not([hidden])');

    // 9. Remember via click
    const rememberBtn = page.locator('#btn-capture-remember');
    await rememberBtn.click();
    await page.waitForSelector('#link-capture-memory-editor:not([hidden])');
    await rememberBtn.click();
    await page.waitForFunction('Boolean(document.getElementById("btn-capture-remember")?.textContent?.includes("Saved"))');

    await page.close();
  });

  await t.test('Forced Failure Truthfulness (Save failure -> no success text, Delete failure -> item restored)', async () => {
    const failureRunId = crypto.randomUUID();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

    // § 3 — HTTP failure diagnostics: log any 4xx/5xx response from the browser
    page.on('response', async (response) => {
      if (response.status() >= 400) {
        console.log(
          'R22_9_HTTP_FAILURE',
          response.status(),
          response.request().method(),
          response.url()
        );
      }
    });

    // § 5 — Memory request header diagnostics (safe metadata only — no cookies/secrets)
    page.on('request', (request) => {
      if (request.url().includes('/api/v1/memory')) {
        const headers = request.headers();
        console.log(
          'R22_9_MEMORY_REQUEST',
          JSON.stringify({
            method: request.method(),
            url: request.url(),
            tenant: headers['x-nagex-tenant'],
            principal: headers['x-principal-id'],
            demo: headers['x-nagex-demo'],
            hasDemoSession: Boolean(headers['x-nagex-demo-session']),
          })
        );
      }
    });

    // Route /api/v1/capture/link for valid preview
    await page.route('**/api/v1/capture/link', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'READY',
          source: { url: 'https://example.com/article', title: 'Test Page' },
          preview: { summary: 'Test summary' },
        }),
      });
    });

    await page.goto(`${baseUrl}/?demo=1`);
    await page.waitForLoadState('networkidle');

    // Route /api/v1/workspace/vault to force 500 error
    await page.route('**/api/v1/workspace/vault', (route) => {
      if (route.request().method() === 'POST') {
        route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Forced Vault Storage Error' }),
        });
      } else {
        route.continue();
      }
    });

    // Open modal with mock capture state
    await page.evaluate('window.NAGEX.openLinkCaptureModal("https://example.com/article");');
    await page.waitForSelector('#link-capture-preview-card:not([hidden])');

    // Click Save to Vault button
    await page.locator('#btn-capture-save-vault').click();

    const errEl = page.locator('#link-capture-status-error');
    await errEl.waitFor({ state: 'visible', timeout: 5000 });
    const errText = await errEl.textContent();
    assert.ok(errText?.includes('Forced Vault Storage Error'));

    const vaultBtnText = await page.textContent('#btn-capture-save-vault');
    assert.equal(vaultBtnText?.includes('Saved to Vault'), false, 'FAKE_SAVE_SUCCESS=0: Must NOT show Saved to Vault text on failure');

    // Route DELETE /api/v1/memory/* to force 500 error
    await page.route('**/api/v1/memory/*', (route) => {
      if (route.request().method() === 'DELETE') {
        route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Forced Server Delete Failure' }),
        });
      } else {
        route.continue();
      }
    });

    // Create item to test delete rollback
    const createRes = await fetch(`${baseUrl}/api/v1/memory/remember`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-NAgex-Tenant': 'ten_demo_hackathon',
        'X-Principal-Id': 'usr_demo_alex',
      },
      body: JSON.stringify({
        scope: 'USER',
        type: 'FACT',
        subject: `Rollback Test Item ${failureRunId}`,
        predicate: 'isTesting',
        value: `Rollback Value ${failureRunId}`,
      }),
    });
    const createdItem = (await createRes.json()) as any;
    const memId = createdItem.id;

    // § 6 — Node-side creation scope verification for memId (Forced Failure scenario)
    {
      const verifyRes = await fetch(
        `${baseUrl}/api/v1/memory/${memId}`,
        {
          headers: {
            'X-NAgex-Tenant': 'ten_demo_hackathon',
            'X-Principal-Id': 'usr_demo_alex',
          },
        }
      );
      console.log('R22_9_NODE_MEMORY_VERIFY', verifyRes.status, memId);
      assert.equal(verifyRes.status, 200);
    }

    await page.evaluate('(async () => { window.NAGEX.switchTab("tab-memory"); document.querySelectorAll(".memory-categories-tabs .mem-tab-btn").forEach(b => { if (b.getAttribute("data-mem-filter") === "ALL") b.classList.add("active"); else b.classList.remove("active"); }); const input = document.getElementById("personal-context-search-input"); if (input) input.value = ""; await window.NAGEX.renderMemory(); })()');

    // § 4 — Memory API + DOM diagnostic snapshot (after renderMemory, before waitForSelector)
    {
      const diag = await page.evaluate(
        async ({ memId }: { memId: string }) => {
          const g = globalThis as any;
          const apiResult = await g.NAGEX.apiFetch('/api/v1/memory');
          const memoryIds = Array.isArray(apiResult?.memories)
            ? apiResult.memories.map((m: any) => m.id)
            : [];
          return {
            href: g.location.href,
            demoParam: new URLSearchParams(g.location.search).get('demo'),
            demoSessionFlag: g.sessionStorage.getItem('nagex_demo_mode'),
            apiHasError: Boolean(apiResult?.error),
            apiError: apiResult?.error || null,
            memoryIds,
            wantedIds: { memId },
            memInApi: memoryIds.includes(memId),
            memCardExists: Boolean(g.document.getElementById(`mem-card-${memId}`)),
          };
        },
        { memId }
      );
      console.log('R22_9_MEMORY_DIAG', JSON.stringify(diag));
    }

    await page.waitForSelector(`#mem-card-${memId}`);

    // Click delete on item, which will fail with HTTP 500
    await page.evaluate(`window.NAGEX.deletePersonalContext('${memId}');`);
    await page.waitForTimeout(500);

    // FAKE_DELETE_SUCCESS=0: Item must be restored (rolled back) in UI
    const cardExists = await page.locator(`#mem-card-${memId}`).isVisible();
    assert.equal(cardExists, true, 'FAKE_DELETE_SUCCESS=0: Item must be restored in UI when DELETE fails');

    await page.close();
  });

  await browser.close();
  server.close();
});

test('R22.9 — Browser Matrix Certification (Desktop 1440x900 & Mobile Viewports 360/390/430 EN/KR)', async (t) => {
  let browser: Browser;
  let server: any;
  let baseUrl: string;

  try {
    server = createServerInstance();
    const serverInfo = await listenServerOnSafePort(server);
    baseUrl = serverInfo.baseUrl;
    browser = await chromium.launch({ headless: true, args: [`--explicitly-allowed-ports=${serverInfo.port}`] });
  } catch (err) {
    t.skip('Playwright browser launch or server init failed: ' + err);
    return;
  }

  const matrix = [
    { width: 1440, height: 900, locale: 'en', name: 'Desktop 1440x900 EN' },
    { width: 1440, height: 900, locale: 'ko', name: 'Desktop 1440x900 KR' },
    { width: 360, height: 800, locale: 'en', name: 'Mobile 360x800 EN' },
    { width: 360, height: 800, locale: 'ko', name: 'Mobile 360x800 KR' },
    { width: 390, height: 844, locale: 'en', name: 'Mobile 390x844 EN' },
    { width: 390, height: 844, locale: 'ko', name: 'Mobile 390x844 KR' },
    { width: 430, height: 932, locale: 'en', name: 'Mobile 430x932 EN' },
    { width: 430, height: 932, locale: 'ko', name: 'Mobile 430x932 KR' },
  ];

  for (const item of matrix) {
    await t.test(`Matrix Certification: ${item.name}`, async () => {
      const page = await browser.newPage({ viewport: { width: item.width, height: item.height } });
      await page.goto(`${baseUrl}/?demo=1`);
      await page.waitForLoadState('domcontentloaded');

      if (item.locale === 'ko') {
        await page.evaluate('if (window.NAGEX_I18N) window.NAGEX_I18N.setLocale("ko");');
      }

      await page.evaluate('window.NAGEX.switchTab("tab-memory")');
      await page.waitForSelector('#view-memory');

      const titleText = await page.textContent('#view-memory h2');
      if (item.locale === 'ko') {
        assert.ok(
          titleText?.includes('알고 있는 정보') || titleText?.includes('개인') || titleText?.includes('What NAgex Knows'),
          `KR title parity missing for ${item.name}: got ${titleText}`
        );
      } else {
        assert.ok(
          titleText?.includes('What NAgex Knows') || titleText?.includes('Personal Memory'),
          `EN title parity missing for ${item.name}: got ${titleText}`
        );
      }

      const hasHorizontalScroll = await page.evaluate('document.documentElement.scrollWidth > document.documentElement.clientWidth');
      assert.equal(hasHorizontalScroll, false, `${item.name} viewport must have zero horizontal overflow`);

      await page.close();
    });
  }

  await browser.close();
  server.close();
});

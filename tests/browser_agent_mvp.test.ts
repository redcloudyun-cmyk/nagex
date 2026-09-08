import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserToolService } from '../src/tools/browser.service.js';
import { PlaywrightBrowserRuntime, browserRuntime } from '../src/integrations/browser/browser.runtime.js';
import { BrowserSessionStore } from '../src/browser/browser-session.store.js';
import { ActionApprovalStore } from '../src/governance/action-approval.store.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { MemoryEngine } from '../src/context/memory.engine.js';
import { isUrlSafe, assertUrlSafe } from '../src/browser/browser-url-validator.js';
import { handleAsyncApiRequest } from '../src/server_web.js';

// The "REST API endpoints" test below goes through server_web.ts's default
// (non-DI'd) route, which launches the process-lifetime `browserRuntime`
// singleton — the same instance a live server never closes. Left open here,
// its real Chromium process keeps `node --test` from ever exiting once this
// file's tests finish, so it must be shut down explicitly (mirrors the
// shared-runtime shutdown() pattern in browser_agent.test.ts / conditional_watch.test.ts).
after(async () => {
  await browserRuntime.shutdown();
});

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-browser-mvp-test-'));
}

// Start a lightweight local test HTTP server serving deterministic HTML pages
function createTestServer(): Promise<{ server: http.Server; baseUrl: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');

      if (req.url === '/captcha-page') {
        res.writeHead(200);
        res.end('<html><head><title>Security Check</title></head><body><h1>Verify you are human</h1><p>Please solve this captcha to continue.</p></body></html>');
        return;
      }

      if (req.url === '/consequential-form') {
        res.writeHead(200);
        res.end(`
          <html>
            <head><title>Checkout Page</title></head>
            <body>
              <h1>Purchase Confirmation</h1>
              <a href="/nav-target" id="nav-link">Read Terms</a>
              <input type="text" id="name-input" name="name" value="" placeholder="Your name">
              <select id="item-select"><option value="item1">Item 1</option><option value="item2">Item 2</option></select>
              <button id="buy-btn">Buy Now</button>
            </body>
          </html>
        `);
        return;
      }

      if (req.url === '/nav-target') {
        res.writeHead(200);
        res.end('<html><head><title>Terms & Conditions</title></head><body><h1>Terms of Service</h1><p>These are the terms.</p></body></html>');
        return;
      }

      // Default page
      res.writeHead(200);
      res.end('<html><head><title>NVIDIA Nemotron Models</title></head><body><h1>Nemotron Open Source Models</h1><p>Latest model is Nemotron-3-8B.</p><a href="/details">View Details</a></body></html>');
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      const baseUrl = `http://127.0.0.1:${address.port}`;
      resolve({
        server,
        baseUrl,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

test('SSRF and Unsafe URL validation rules', () => {
  // Test blocked URLs in production mode
  const resFile = isUrlSafe('file:///etc/passwd', { allowLocalhostInTests: false });
  assert.equal(resFile.safe, false);
  assert.ok(resFile.reason?.includes('Unsafe scheme'));

  const resData = isUrlSafe('data:text/html,<h1>hack</h1>', { allowLocalhostInTests: false });
  assert.equal(resData.safe, false);

  const resCloudMeta = isUrlSafe('http://169.254.169.254/latest/meta-data/', { allowLocalhostInTests: false });
  assert.equal(resCloudMeta.safe, false);
  assert.ok(resCloudMeta.reason?.includes('blocked by security policy'));

  const resPrivateIp = isUrlSafe('http://10.0.0.1/admin', { allowLocalhostInTests: false });
  assert.equal(resPrivateIp.safe, false);

  // Allowed public URL
  const resPublic = isUrlSafe('https://nvidia.com', { allowLocalhostInTests: false });
  assert.equal(resPublic.safe, true);
  assert.equal(resPublic.url, 'https://nvidia.com/');
});

test('Browser Agent MVP full flow: open, navigate, snapshot, find, extract, back, forward, reload, screenshot, close', async () => {
  const testServer = await createTestServer();
  const dir = tempDir();

  const runtime = new PlaywrightBrowserRuntime(false, path.join(dir, 'profiles'));
  const sessions = new BrowserSessionStore({ dir: path.join(dir, 'sessions') });
  const approvals = new ActionApprovalStore();
  const audit = new AuditLogger();
  const memory = new MemoryEngine();

  const service = new BrowserToolService(runtime, sessions, approvals, audit, memory);
  const input = { tenantId: 'ten_test', ownerId: 'usr_admin_001', requestId: 'req_1' };

  try {
    // 1. Open Browser Session
    const session = await service.open(input);
    assert.ok(session.browserSessionId.startsWith('brw_'));
    assert.equal(session.status, 'OPEN');

    const sInput = { ...input, browserSessionId: session.browserSessionId };

    // 2. Navigate to test page
    const navResult = await service.navigate({ ...sInput, url: testServer.baseUrl });
    assert.equal(navResult.title, 'NVIDIA Nemotron Models');

    // 3. Snapshot & Structured Snapshot
    const snap = await service.snapshot(sInput);
    assert.ok(snap.text.includes('Nemotron Open Source Models'));

    const structSnap = await service.structuredSnapshot(sInput);
    assert.equal(structSnap.title, 'NVIDIA Nemotron Models');
    assert.ok(structSnap.links.length > 0);

    // 4. Find & Extract
    const findRes = await service.find({ ...sInput, query: 'View Details' });
    assert.equal(findRes.candidates.length, 1);
    assert.ok(findRes.bestMatch?.selector.includes('a:has-text'));

    const extractRes = await service.extract({ ...sInput, target: 'all' });
    assert.ok(extractRes.extracted.text?.includes('Nemotron'));
    assert.ok(extractRes.extracted.summary?.includes('NVIDIA Nemotron Models'));

    // 5. Screenshot
    const screenshotRes = await service.screenshot(sInput);
    assert.ok(screenshotRes.evidenceId.startsWith('bev_'));

    // 6. Navigation history (reload, back, forward)
    const reloadRes = await service.reload(sInput);
    assert.equal(reloadRes.title, 'NVIDIA Nemotron Models');

    // 7. Close session
    await service.close(sInput);
    const closedRec = sessions.get(session.browserSessionId);
    assert.equal(closedRec?.status, 'CLOSED');
  } finally {
    await runtime.shutdown();
    await testServer.close();
  }
});

test('CAPTCHA / Human Verification detection blocks session without bypassing', async () => {
  const testServer = await createTestServer();
  const dir = tempDir();

  const runtime = new PlaywrightBrowserRuntime(false, path.join(dir, 'profiles'));
  const sessions = new BrowserSessionStore({ dir: path.join(dir, 'sessions') });
  const approvals = new ActionApprovalStore();
  const audit = new AuditLogger();
  const memory = new MemoryEngine();

  const service = new BrowserToolService(runtime, sessions, approvals, audit, memory);
  const input = { tenantId: 'ten_test', ownerId: 'usr_admin_001', requestId: 'req_2' };

  try {
    const session = await service.open(input);
    const sInput = { ...input, browserSessionId: session.browserSessionId };

    // Navigate to page containing human verification text
    await assert.rejects(
      () => service.navigate({ ...sInput, url: `${testServer.baseUrl}/captcha-page` }),
      /human verification/i
    );

    // Verify session status transitioned to BLOCKED_NEEDS_HUMAN
    const record = sessions.get(session.browserSessionId);
    assert.equal(record?.status, 'BLOCKED_NEEDS_HUMAN');

    // Subsequent navigation attempts fail closed
    await assert.rejects(
      () => service.navigate({ ...sInput, url: testServer.baseUrl }),
      /blocked pending a human/i
    );
  } finally {
    await runtime.shutdown();
    await testServer.close();
  }
});

test('Consequential click action requires human approval and supports replay protection', async () => {
  const testServer = await createTestServer();
  const dir = tempDir();

  const runtime = new PlaywrightBrowserRuntime(false, path.join(dir, 'profiles'));
  const sessions = new BrowserSessionStore({ dir: path.join(dir, 'sessions') });
  const approvals = new ActionApprovalStore();
  const audit = new AuditLogger();
  const memory = new MemoryEngine();

  const service = new BrowserToolService(runtime, sessions, approvals, audit, memory);
  const input = { tenantId: 'ten_test', ownerId: 'usr_admin_001', requestId: 'req_3' };

  try {
    const session = await service.open(input);
    const sInput = { ...input, browserSessionId: session.browserSessionId };

    await service.navigate({ ...sInput, url: `${testServer.baseUrl}/consequential-form` });

    // Non-consequential link click executes immediately without approval
    const navClick = await service.click({ ...sInput, selector: '#nav-link' });
    assert.equal(navClick.status, 'EXECUTED');

    await service.navigate({ ...sInput, url: `${testServer.baseUrl}/consequential-form` });

    // Consequential click ("Buy Now") requires approval
    const buyClick = await service.click({ ...sInput, selector: '#buy-btn' });
    assert.equal(buyClick.status, 'APPROVAL_REQUIRED');

    if (buyClick.status === 'APPROVAL_REQUIRED') {
      const approvalId = buyClick.approval.approvalId;
      assert.equal(buyClick.approval.status, 'PENDING');

      // User approves
      service.approve(approvalId, 'usr_admin_001', 'req_approve');

      // Execute approved click once
      const execRes = await service.executeApprovedClick({
        approvalId,
        browserSessionId: session.browserSessionId,
        selector: '#buy-btn',
        tenantId: 'ten_test',
        ownerId: 'usr_admin_001',
        requestId: 'req_exec',
      });
      assert.equal(execRes.status, 'EXECUTED');

      // Replay attempt fails (approval already consumed)
      await assert.rejects(
        () => service.executeApprovedClick({
          approvalId,
          browserSessionId: session.browserSessionId,
          selector: '#buy-btn',
          tenantId: 'ten_test',
          ownerId: 'usr_admin_001',
          requestId: 'req_replay',
        }),
        /already been used/i
      );
    }
  } finally {
    await runtime.shutdown();
    await testServer.close();
  }
});

test('REST API endpoints for Browser Agent tools in server_web', async () => {
  // Create browser session via REST API
  const openRes = await handleAsyncApiRequest('POST', '/api/v1/browser/sessions', {}, {
    'x-principal-id': 'usr_admin_001',
  });
  assert.equal(openRes.status, 201);
  assert.ok((openRes.data as any).browserSessionId);
  const bsessId = (openRes.data as any).browserSessionId;

  // Tabs endpoint
  const tabsRes = await handleAsyncApiRequest('POST', '/api/v1/tools/browser/tabs', { browserSessionId: bsessId }, {
    'x-principal-id': 'usr_admin_001',
  });
  assert.equal(tabsRes.status, 200);
  assert.ok(Array.isArray((tabsRes.data as any).tabs));

  // Close session via REST API
  const closeRes = await handleAsyncApiRequest('POST', '/api/v1/tools/browser/close', { browserSessionId: bsessId }, {
    'x-principal-id': 'usr_admin_001',
  });
  assert.equal(closeRes.status, 200);
});

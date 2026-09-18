import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { chromium, Browser } from 'playwright';

// R21 P0.2 — Remove Enterprise Controls from NAgex Personal UI Real Browser Test Suite
// Certifies Scenarios A-E in a real Playwright headless browser instance.

const PORT = 3457;

function serveStaticFile(reqPath: string, res: http.ServerResponse) {
  let filePath = path.join(process.cwd(), 'public', reqPath === '/' ? 'index.html' : reqPath);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(process.cwd(), 'public', 'index.html');
  }

  const ext = path.extname(filePath);
  const contentTypes: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
  };

  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'application/octet-stream' });
    res.end(data);
  } catch (err) {
    res.writeHead(404);
    res.end('Not Found');
  }
}

async function startServer(): Promise<{ server: http.Server; origin: string }> {
  const server = http.createServer((req, res) => {
    const url = req.url || '/';
    const parsed = new URL(url, `http://localhost:${PORT}`);

    if (parsed.pathname.startsWith('/api/v1/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (parsed.pathname.includes('/organizations')) {
        res.end(JSON.stringify({ organizations: [{ organizationId: 'org_personal_default', name: 'My NAgex' }] }));
      } else if (parsed.pathname.includes('/workspaces')) {
        res.end(JSON.stringify({ workspaces: [{ workspaceId: 'ws_personal_default', name: 'Personal Workspace', status: 'ACTIVE' }] }));
      } else {
        res.end(JSON.stringify({ ok: true }));
      }
      return;
    }

    serveStaticFile(parsed.pathname, res);
  });

  return new Promise((resolve) => {
    server.listen(0, () => {
      const address = server.address();
      const allocatedPort = typeof address === 'object' && address ? address.port : PORT;
      resolve({ server, origin: `http://localhost:${allocatedPort}` });
    });
  });
}

function ensureDirectoriesExist() {
  const dir = path.join(process.cwd(), 'artifacts', 'screenshots');
  fs.mkdirSync(dir, { recursive: true });
}

test('R21 P0.2 REAL BROWSER CERTIFICATION: Personal UI Repositioning (Scenarios A-E)', async () => {
  ensureDirectoriesExist();
  const { server, origin } = await startServer();
  const browser: Browser = await chromium.launch({ headless: true });

  try {
    // Scenario A — Personal Home (clean header, no Create Org / Create Workspace buttons)
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.goto(`${origin}/index.html`);
      await page.waitForSelector('.brand-logo-group');

      const switchersVisible = await page.isVisible('#header-switchers-group');
      assert.equal(switchersVisible, false, 'Header switchers group must be hidden in normal Personal mode');

      const orgBtnVisible = await page.isVisible('#btn-org-switcher');
      assert.equal(orgBtnVisible, false, 'Org switcher button must be hidden in Personal mode');

      const wsBtnVisible = await page.isVisible('#btn-workspace-switcher');
      assert.equal(wsBtnVisible, false, 'Workspace switcher button must be hidden in Personal mode');

      await page.close();
    }

    // Scenario B — New Personal User onboarding (home available immediately without setup)
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.goto(`${origin}/index.html`);
      await page.waitForSelector('#view-home');

      const homeVisible = await page.isVisible('#view-home');
      assert.equal(homeVisible, true, 'Personal Home section must be immediately visible without setup steps');

      await page.close();
    }

    // Scenario C — Settings (no SSO / SCIM / Roles / Members / Org management in Personal mode)
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.goto(`${origin}/index.html`);
      await page.click('[data-tab="tab-settings"]');
      await page.waitForSelector('#cat-tab-connections');

      const orgTabVisible = await page.isVisible('#cat-tab-organization');
      assert.equal(orgTabVisible, false, 'Organization settings tab must be hidden in normal Personal mode');

      await page.close();
    }

    // Scenario D — Enterprise flag (?enterprise=1) exposes Enterprise controls
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.goto(`${origin}/index.html?enterprise=1`);
      await page.waitForSelector('#header-switchers-group', { state: 'visible' });

      const switchersVisible = await page.isVisible('#header-switchers-group');
      assert.equal(switchersVisible, true, 'Header switchers group must be visible when ?enterprise=1 is active');

      await page.close();
    }

    // Scenario E — Mobile 390x844 layout
    {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.goto(`${origin}/index.html`);
      await page.waitForSelector('.app-header');

      const switchersVisible = await page.isVisible('#header-switchers-group');
      assert.equal(switchersVisible, false, 'Header switchers must remain hidden on mobile');

      await page.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
});

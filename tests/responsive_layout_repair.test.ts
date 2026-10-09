import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';

const VIEWPORTS = [
  [1920, 1080],
  [1600, 900],
  [1440, 900],
  [1366, 768],
  [1280, 720],
  [1200, 800],
  [1024, 768],
  [900, 900],
  [768, 1024],
  [430, 932],
  [390, 844],
  [360, 800],
] as const;

function contentType(filePath: string): string {
  if (filePath.endsWith('.css')) return 'text/css';
  if (filePath.endsWith('.js')) return 'application/javascript';
  if (filePath.endsWith('.png')) return 'image/png';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  return 'text/html';
}

async function withPublicServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const root = path.join(process.cwd(), 'public');
  const server = http.createServer((req, res) => {
    const urlPath = req.url?.split('?')[0] || '/';
    const safePath = path.normalize(urlPath === '/' ? '/index.html' : urlPath).replace(/^(\.\.[/\\])+/, '');
    const filePath = path.join(root, safePath);
    if (!filePath.startsWith(root) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': contentType(filePath) });
    res.end(fs.readFileSync(filePath));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('responsive layout repair keeps Home usable without global horizontal overflow', async () => {
  await withPublicServer(async (baseUrl) => {
    const browser = await chromium.launch({ headless: true });
    try {
      for (const [width, height] of VIEWPORTS) {
        const page = await browser.newPage({ viewport: { width, height } });
        await page.route('**/api/v1/personal/home', (route) => route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            generatedAt: new Date().toISOString(),
            needsAttention: [{ id: 'apr_responsive', type: 'APPROVAL', title: 'Approve responsive check', summary: 'Sample Client', state: 'Needs approval' }],
            workingForYou: [{ id: 'wrk_responsive', type: 'TASK', title: 'Verify layout', summary: 'Responsive certification', state: 'Verifying', executionStatus: 'VERIFYING' }],
            recentResults: [],
            recentCreations: [],
            preparedForYou: [],
            memoryContext: [],
          }),
        }));
        await page.goto(baseUrl, { waitUntil: 'networkidle' });
        await page.waitForTimeout(250);
        const result = await page.evaluate(() => {
          const doc = (globalThis as any).document;
          const win = globalThis as any;
          const rect = (selector: string) => {
            const el = doc.querySelector(selector);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { width: r.width, right: r.right, left: r.left, display: win.getComputedStyle(el).display };
          };
          const desktop = win.innerWidth > 768;
          const mobileShell = rect('#mobile-app-shell');
          const home = rect('#view-home');
          const composer = rect('#unified-composer');
          const sidebar = rect('.sidebar-left');
          const rail = rect('#home-section-needs-approval');
          const overflow = doc.documentElement.scrollWidth > doc.documentElement.clientWidth + 2;
          return {
            overflow,
            desktop,
            mobileVisible: mobileShell ? mobileShell.display !== 'none' && mobileShell.width > 0 : false,
            homeWidth: home?.width || 0,
            composerWidth: composer?.width || 0,
            sidebarWidth: sidebar?.width || 0,
            railWidth: rail?.width || 0,
          };
        });
        assert.equal(result.overflow, false, `${width}x${height} must not create global horizontal overflow`);
        if (result.desktop) {
          assert.ok(result.homeWidth >= Math.min(600, width * 0.65), `${width}x${height} Home remains readable`);
          assert.ok(result.composerWidth >= Math.min(360, width * 0.45), `${width}x${height} composer remains usable`);
          assert.ok(result.sidebarWidth <= 160, `${width}x${height} sidebar is bounded/collapsed`);
          assert.ok(result.railWidth >= Math.min(320, width * 0.45), `${width}x${height} execution rail remains usable`);
        } else {
          assert.equal(result.mobileVisible, true, `${width}x${height} mobile shell is active`);
        }
        await page.close();
      }
    } finally {
      await browser.close();
    }
  });
});

test('responsive CSS contains canonical grid, clamp, and wrapping safeguards', () => {
  const css = fs.readFileSync(path.join(process.cwd(), 'public', 'desktop', 'desktop-home.css'), 'utf8');
  assert.match(css, /grid-template-columns:\s*72px minmax\(0,\s*1fr\)/);
  assert.match(css, /grid-template-columns:\s*149px minmax\(0,\s*1fr\)/);
  assert.match(css, /font-size:\s*clamp\(/);
  assert.match(css, /overflow-wrap:\s*anywhere/);
});

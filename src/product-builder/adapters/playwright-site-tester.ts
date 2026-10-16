// The isolated test run of a generated site: a headless Chromium that can reach ONLY the product itself.
//
// Isolation, stated precisely (and what is not claimed):
//   - the generated files are never executed by Node. They are served as static bytes from a loopback port that exists for the length of one run, and run only inside Chromium's own renderer sandbox;
//   - every request the page makes to any other origin is aborted and counted (the built-in "no external requests" check fails when any happened); service workers, downloads and permissions are off;
//   - a fresh browser and context per run, nothing persisted; the run is bounded in time.
//   This is a browser-level boundary, not an operating-system sandbox. That is enough for static pages, and it is exactly why this module never runs generated server code.
//
// The same tester checks a DEPLOYED address (source = url): the allowed origin is then that address only.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import { isBrowserRuntimeAvailableSync } from '../../modules/browser/index.js';
import { checkWorkspacePath, contentTypeFor } from '../product-workspace.js';
import type { SiteTesterPort } from '../product-builder.ports.js';
import type { SiteCheck, TestCheckResult, TestReport } from '../product-builder.types.js';

export class SiteTesterUnavailableError extends Error {
  public readonly code = 'SITE_TESTER_UNAVAILABLE';
}

const RUN_TIMEOUT_MS = 90_000;
const PAGE_TIMEOUT_MS = 15_000;
const CHECK_WAIT_MS = 4_000;
const MAX_CONSOLE_ERRORS = 8;

interface StaticServer { origin: string; close(): Promise<void> }

/** Serves one directory read-only on a loopback port. Paths are re-validated with the workspace rules; nothing outside the directory is reachable. */
export async function serveDirectory(dir: string): Promise<StaticServer> {
  const root = path.resolve(dir);
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    let rel = decodeURIComponent((req.url ?? '/').split('?')[0].split('#')[0]).replace(/^\/+/, '');
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const checked = checkWorkspacePath(rel);
    const target = checked.ok ? path.resolve(path.join(root, ...checked.normalized.split('/'))) : null;
    if (!target || !target.startsWith(root + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'); return; }
    res.writeHead(200, { 'content-type': contentTypeFor(rel), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    if (req.method === 'HEAD') res.end(); else res.end(fs.readFileSync(target));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  const port = (server.address() as AddressInfo).port;
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); }) };
}

function result(id: string, description: string, passed: boolean, detail: string): TestCheckResult {
  return { id, description, passed, detail: detail.slice(0, 300) };
}

// WHY an element or a text did not show: absent from the page, or present but hidden when the page first loads (behind a tab, a menu, another view). The reason is what lets a repair fix the cause.
async function whyNotVisible(page: Page, selector: string): Promise<string> {
  try {
    const found = await page.locator(selector).count();
    return found === 0 ? `nothing on the page matches ${selector}` : `${selector} exists but is not visible when the page first loads (is it behind a tab, a menu or another view? checks look at the page before anything is clicked)`;
  } catch {
    return `${selector} is not a usable selector`;
  }
}

async function runPlanCheck(page: Page, url: string, check: SiteCheck): Promise<TestCheckResult> {
  try {
    await page.goto(url, { waitUntil: 'load', timeout: PAGE_TIMEOUT_MS });
    if (check.kind === 'ELEMENT_PRESENT') {
      try {
        await page.locator(check.selector).first().waitFor({ state: 'visible', timeout: CHECK_WAIT_MS });
      } catch {
        return result(check.id, check.description, false, await whyNotVisible(page, check.selector));
      }
      return result(check.id, check.description, true, `${check.selector} is visible`);
    }
    if (check.kind === 'TEXT_PRESENT') {
      try {
        await page.waitForFunction((t) => (((globalThis as any).document.body?.innerText ?? '') as string).includes(t), check.text, { timeout: CHECK_WAIT_MS });
      } catch {
        const inPage = await page.evaluate((t) => (((globalThis as any).document.body?.textContent ?? '') as string).includes(t), check.text).catch(() => false);
        return result(check.id, check.description, false, inPage ? 'the text is in the page but hidden when the page first loads (behind a tab, a menu or another view?)' : 'the text does not appear anywhere on the page');
      }
      return result(check.id, check.description, true, 'the text is visible');
    }
    const input = page.locator(check.inputSelector).first();
    try {
      await input.waitFor({ state: 'visible', timeout: CHECK_WAIT_MS });
    } catch {
      return result(check.id, check.description, false, `the search field: ${await whyNotVisible(page, check.inputSelector)}`);
    }
    await input.fill('');
    const before = await page.evaluate(() => ((globalThis as any).document.body?.innerText ?? '') as string);
    if (!before.includes(check.expectText)) return result(check.id, check.description, false, `the sample record ${JSON.stringify(check.expectText)} is not shown before searching`);
    await input.fill(check.query);
    try {
      await page.waitForFunction(([expectText, hideText]) => {
        const t = ((globalThis as any).document.body?.innerText ?? '') as string;
        return t.includes(expectText as string) && (!hideText || !t.includes(hideText as string));
      }, [check.expectText, check.hideText ?? ''] as [string, string], { timeout: CHECK_WAIT_MS });
    } catch {
      const after = await page.evaluate(() => ((globalThis as any).document.body?.innerText ?? '') as string).catch(() => '');
      const keeps = after.includes(check.expectText);
      const hides = !check.hideText || !after.includes(check.hideText);
      return result(check.id, check.description, false, `after typing ${JSON.stringify(check.query)}: ${JSON.stringify(check.expectText)} is ${keeps ? 'still shown' : 'NOT shown'}${check.hideText ? ` and ${JSON.stringify(check.hideText)} is ${hides ? 'hidden' : 'STILL shown (the list did not narrow)'}` : ''}`);
    }
    return result(check.id, check.description, true, `searching ${JSON.stringify(check.query)} keeps ${JSON.stringify(check.expectText)}${check.hideText ? ` and hides ${JSON.stringify(check.hideText)}` : ''}`);
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] : 'check failed';
    return result(check.id, check.description, false, /Timeout/i.test(message) ? 'it did not hold within a few seconds' : message);
  }
}

export class PlaywrightSiteTester implements SiteTesterPort {
  public readonly isolation = 'headless Chromium; network limited to the product\'s own origin; no service workers; generated files are served as static bytes and never run by Node';

  public available(): boolean {
    return isBrowserRuntimeAvailableSync();
  }

  public async run(input: { source: { dir: string } | { url: string }; checks: SiteCheck[]; widths: number[]; screenshotsDir: string | null }): Promise<TestReport> {
    if (!this.available()) throw new SiteTesterUnavailableError('The isolated browser (Chromium) is not installed here.');
    const widths = input.widths.length > 0 ? input.widths : [1280, 768, 390];
    let server: StaticServer | null = null;
    let browser: Browser | null = null;
    const timer = setTimeout(() => { void browser?.close().catch(() => undefined); }, RUN_TIMEOUT_MS);
    try {
      const url = 'dir' in input.source ? (server = await serveDirectory(input.source.dir)).origin + '/' : input.source.url;
      const origin = new URL(url).origin;
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ viewport: { width: widths[0], height: 900 }, serviceWorkers: 'block', acceptDownloads: false, permissions: [], javaScriptEnabled: true });
      let blocked = 0;
      const blockedHosts = new Set<string>();
      await context.route('**/*', (route) => {
        const requestUrl = route.request().url();
        if (/^(data|blob|about):/i.test(requestUrl)) return route.continue();
        let ok = false;
        try { ok = new URL(requestUrl).origin === origin; } catch { ok = false; }
        if (ok) return route.continue();
        blocked += 1;
        try { blockedHosts.add(new URL(requestUrl).host); } catch { /* unparsable */ }
        return route.abort('blockedbyclient');
      });
      const page = await context.newPage();
      page.setDefaultTimeout(PAGE_TIMEOUT_MS);
      const consoleErrors: string[] = [];
      const note = (text: string) => { if (consoleErrors.length < MAX_CONSOLE_ERRORS) consoleErrors.push(text.replace(/\s+/g, ' ').slice(0, 200)); };
      page.on('console', (message) => { if (message.type() === 'error') note(message.text()); });
      page.on('pageerror', (error) => note(`Uncaught: ${error.message}`));

      const checks: TestCheckResult[] = [];
      const screenshots: TestReport['screenshots'] = [];
      let loaded = false;
      let status: number | null = null;
      try {
        const response = await page.goto(url, { waitUntil: 'load', timeout: PAGE_TIMEOUT_MS });
        status = response?.status() ?? null;
        loaded = Boolean(response && response.ok());
      } catch (error) {
        checks.push(result('builtin.loads', 'The page opens', false, error instanceof Error ? error.message.split('\n')[0] : 'it did not open'));
      }
      if (loaded) {
        const title = (await page.title()).trim();
        checks.push(result('builtin.loads', 'The page opens', title.length > 0, title.length > 0 ? `opened (HTTP ${status}) with the title ${JSON.stringify(title.slice(0, 60))}` : 'the page has no <title>'));
        for (const width of widths) {
          await page.setViewportSize({ width, height: 900 });
          await page.goto(url, { waitUntil: 'load', timeout: PAGE_TIMEOUT_MS });
          await page.waitForTimeout(150);
          const dims = await page.evaluate(() => { const el = (globalThis as any).document.documentElement; return { scroll: el.scrollWidth as number, client: el.clientWidth as number }; });
          const fits = dims.scroll <= dims.client + 1;
          checks.push(result(`builtin.no-sideways-scroll-${width}`, `No sideways scrolling at ${width}px`, fits, fits ? 'fits the width' : `the page is ${dims.scroll}px wide in a ${dims.client}px window`));
          if (input.screenshotsDir) {
            try {
              fs.mkdirSync(input.screenshotsDir, { recursive: true, mode: 0o700 });
              const fileName = `shot-${width}.png`;
              fs.writeFileSync(path.join(input.screenshotsDir, fileName), await page.screenshot({ fullPage: false }));
              screenshots.push({ width, fileName });
            } catch { /* a missing picture does not decide the result */ }
          }
        }
        await page.setViewportSize({ width: Math.max(...widths), height: 900 });
        for (const check of input.checks) checks.push(await runPlanCheck(page, url, check));
      }
      checks.push(result('builtin.no-console-errors', 'No errors in the browser console', consoleErrors.length === 0, consoleErrors.length === 0 ? 'none' : consoleErrors.slice(0, 3).join(' | ')));
      checks.push(result('builtin.no-external-requests', 'Makes no request to any other address', blocked === 0, blocked === 0 ? 'none' : `${blocked} request(s) to ${[...blockedHosts].slice(0, 3).join(', ')} were blocked`));
      await context.close();
      return { ranAt: new Date().toISOString(), passed: checks.length > 0 && checks.every((c) => c.passed), checks, screenshots, consoleErrors, blockedRequests: blocked };
    } finally {
      clearTimeout(timer);
      try { await browser?.close(); } catch { /* already closed */ }
      try { await server?.close(); } catch { /* already closed */ }
    }
  }
}

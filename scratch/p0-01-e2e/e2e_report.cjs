// Real UI journey (local isolated server, real model): prompt -> creation -> result panel -> refresh -> relogin -> revise -> download. Records every API call.
const { chromium } = require('F:/nxprod/node_modules/playwright');
const fs = require('fs');
const [,, COOKIE, PROMPT_FILE, OUT, STEP] = process.argv;
const prompt = fs.readFileSync(PROMPT_FILE, 'utf8').trim();
const calls = [];
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const [n, v] = COOKIE.split('=');
  await ctx.addCookies([{ name: n, value: v, domain: '127.0.0.1', path: '/' }]);
  const page = await ctx.newPage();
  page.on('response', async (r) => {
    const u = new URL(r.url());
    if (!u.pathname.startsWith('/api/')) return;
    if (/\/(notifications|health|sessions\/main|personal\/home|settings|daily-brief|connections|brief)/.test(u.pathname)) return;
    let note = '';
    try { const t = await r.text(); note = t.length > 140 ? t.slice(0, 140).replace(/\s+/g, ' ') + '…' : t.replace(/\s+/g, ' '); } catch { /* body unavailable */ }
    calls.push({ method: r.request().method(), path: u.pathname, status: r.status(), note });
  });
  await page.goto('http://127.0.0.1:8191/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.fill('#main-surface-input', prompt);
  await page.click('#main-send');
  const t0 = Date.now();
  await page.waitForFunction(() => /Document created|Presentation created|Unavailable|Error|Completed|Plan ready/.test(document.body.innerText), null, { timeout: 120000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const tail = async () => (await page.evaluate(() => document.body.innerText)).split('\n').filter((l) => l.trim());
  const lines = await tail();
  const idx = lines.map((l) => l.trim()).lastIndexOf(prompt);
  console.log('ELAPSED_MS', Date.now() - t0);
  console.log('UI_AFTER_SEND:', lines.slice(Math.max(0, idx)).join(' | ').slice(0, 1800));
  console.log('RESULT_BUTTONS:', JSON.stringify(await page.evaluate(() => ['main-result-download', 'main-result-open', 'main-result-revise'].map((id) => { const e = document.getElementById(id); return e ? id + ':' + (e.disabled ? 'disabled' : 'enabled') : id + ':absent'; }))));
  await page.screenshot({ path: OUT + '/e2e_' + STEP + '_after_send.png' });
  console.log('API_CALLS:'); for (const c of calls) console.log(' ', c.method, c.path, c.status, c.note);
  fs.writeFileSync(OUT + '/e2e_' + STEP + '_calls.json', JSON.stringify(calls, null, 1));
  await browser.close();
})();

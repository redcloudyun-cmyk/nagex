// P0-01 real user journey (UI): create 3-page report -> download -> revise -> download -> refresh -> Recent -> Open -> new browser context -> Recent. Real model, isolated local server.
const { chromium } = require('F:/nxprod/node_modules/playwright');
const fs = require('fs');
const [,, COOKIE, PROMPT_FILE, REVISE_FILE, OUT, TAG] = process.argv;
const prompt = fs.readFileSync(PROMPT_FILE, 'utf8').trim();
const revise = fs.readFileSync(REVISE_FILE, 'utf8').trim();
const log = (k, v) => console.log(k + ': ' + (typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 1200));
const tailAfter = async (page, marker) => { const lines = (await page.evaluate(() => document.body.innerText)).split('\n').filter((l) => l.trim()); const i = lines.map((l) => l.trim()).lastIndexOf(marker); return lines.slice(Math.max(0, i)).join(' | '); };
(async () => {
  const browser = await chromium.launch({ headless: true });
  const mk = async () => { const c = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true }); const [n, v] = COOKIE.split('='); await c.addCookies([{ name: n, value: v, domain: '127.0.0.1', path: '/' }]); return c; };
  const ctx = await mk();
  const page = await ctx.newPage();
  const api = [];
  page.on('response', (r) => { const u = new URL(r.url()); if (/creations|artifacts|route-input|ambient/.test(u.pathname)) api.push(r.request().method() + ' ' + u.pathname.replace(/doc_[0-9a-f]{24}/, 'doc_*').replace(/art_[0-9a-f]{24}/, 'art_*') + ' ' + r.status()); });
  const download = async (label) => {
    const state = await page.evaluate(() => { const d = document.getElementById('main-result-download'); return d ? { disabled: d.disabled, text: d.innerText } : null; });
    if (!state || state.disabled) { log(label + '_DOWNLOAD', 'button disabled/absent ' + JSON.stringify(state)); return null; }
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.click('#main-result-download')]);
    const file = `${OUT}/${TAG}_${label}.docx`;
    await dl.saveAs(file);
    log(label + '_DOWNLOAD', { suggested: dl.suggestedFilename(), bytes: fs.statSync(file).size, file });
    return file;
  };
  await page.goto('http://127.0.0.1:8191/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.fill('#main-surface-input', prompt);
  await page.click('#main-send');
  const t0 = Date.now();
  await page.waitForFunction(() => /Document created|Unavailable|Error/.test(document.body.innerText), null, { timeout: 180000 }).catch(() => {});
  await page.waitForTimeout(2500);
  log('1_ELAPSED_MS', Date.now() - t0);
  log('1_CREATE_UI', (await tailAfter(page, prompt)).slice(0, 330));
  const meta1 = await page.evaluate(() => (document.getElementById('main-result-meta') || {}).textContent);
  const title1 = await page.evaluate(() => (document.getElementById('main-result-title') || {}).textContent);
  const chars1 = await page.evaluate(() => ((document.getElementById('main-result-preview') || {}).innerText || '').length);
  log('1_META', meta1); log('1_TITLE', title1); log('1_PREVIEW_CHARS', chars1);
  await page.screenshot({ path: `${OUT}/${TAG}_1_created.png` });
  const f1 = await download('1');

  await page.click('#main-result-revise');
  await page.waitForTimeout(800);
  await page.fill('#main-surface-input', revise);
  await page.click('#main-send');
  await page.waitForFunction(() => /Document revised|Revision failed|Unavailable|Error/.test(document.body.innerText), null, { timeout: 180000 }).catch(() => {});
  await page.waitForTimeout(2500);
  log('2_REVISE_UI', (await tailAfter(page, revise)).slice(0, 330));
  const chars2 = await page.evaluate(() => ((document.getElementById('main-result-preview') || {}).innerText || '').length);
  log('2_PREVIEW_CHARS_AFTER_REVISION', chars2);
  await page.screenshot({ path: `${OUT}/${TAG}_2_revised.png` });
  const f2 = await download('2');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  await page.getByText(/^Recent$/).first().click().catch(() => {});
  await page.waitForTimeout(2500);
  const recentText = (await page.evaluate(() => document.body.innerText)).replace(/\n+/g, ' | ');
  log('3_RECENT_HAS_TITLE', recentText.includes(String(title1).slice(0, 12)));
  const openBtn = page.getByRole('button', { name: /^Open$/ }).first();
  if (await openBtn.count()) { await openBtn.click().catch(() => {}); await page.waitForTimeout(3500); }
  const opened = (await page.evaluate(() => document.body.innerText)).replace(/\n+/g, ' | ');
  log('3_OPENED_FROM_RECENT_SHOWS_BODY', /서론|결론|제언/.test(opened));
  log('3_OPENED_SNIPPET', opened.slice(-500));
  await page.screenshot({ path: `${OUT}/${TAG}_3_opened.png` });

  const ctx2 = await mk();
  const p2 = await ctx2.newPage();
  await p2.goto('http://127.0.0.1:8191/', { waitUntil: 'domcontentloaded' });
  await p2.waitForTimeout(3000);
  await p2.getByText(/^Recent$/).first().click().catch(() => {});
  await p2.waitForTimeout(2500);
  log('4_NEW_CONTEXT_RECENT_HAS_TITLE', (await p2.evaluate(() => document.body.innerText)).includes(String(title1).slice(0, 12)));
  log('FILES', { first: f1, revised: f2 });
  log('API_CALLS', api);
  await browser.close();
})();

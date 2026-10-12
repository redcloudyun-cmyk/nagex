// Signed-out probe of the DEPLOYED site: which font files the browser really fetches and which platform fonts render (no credentials needed).
const { chromium } = require('playwright');
const fs = require('node:fs');
(async () => {
  const out = {}; const browser = await chromium.launch({ channel: 'chrome' });
  for (const locale of ['en', 'ko']) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: locale === 'ko' ? 'ko-KR' : 'en-US' });
    await ctx.addInitScript((l) => { try { localStorage.setItem('nagex_locale', l); } catch {} }, locale);
    const page = await ctx.newPage(); const reqs = [];
    page.on('response', (r) => { if (/fonts\.(googleapis|gstatic)\.com/.test(r.url())) reqs.push(r.status()); });
    await page.goto('https://nagex-test.agex.site/', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(2500);
    const cdp = await ctx.newCDPSession(page); await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
    const doc = await cdp.send('DOM.getDocument', { depth: 0 }); const n = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'h1, h2, .app-wrapper, body' });
    const pf = await cdp.send('CSS.getPlatformFontsForNode', { nodeId: n.nodeId });
    out[locale] = { lang: await page.evaluate(() => document.documentElement.lang), fontUi: await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--nagex-font-ui').slice(0, 80)), fontRequests: reqs.length, nonOk: reqs.filter((s) => s >= 400).length, platformFonts: pf.fonts.map((f) => `${f.familyName}${f.isCustomFont ? '*' : ''}:${f.glyphCount}`), facesLoaded: await page.evaluate(() => [...document.fonts].filter((f) => f.status === 'loaded').length) };
    await page.screenshot({ path: `F:/nxm/artifacts/design-gate/deployed-signedout-${locale}.png` });
    await ctx.close();
  }
  await browser.close(); console.log(JSON.stringify(out, null, 1));
  fs.writeFileSync('F:/nxm/artifacts/design-gate/deployed-signedout-probe.json', JSON.stringify(out, null, 2));
})();

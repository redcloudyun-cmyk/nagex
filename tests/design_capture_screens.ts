// Design evidence tool (not part of the gates): screenshots + measured metrics of the remaining Desktop screens (Recent, Workspace, Knowledge,
// Activity, Settings tabs) in EN and KR at 1440x900, with a little real data seeded through the product APIs.
//   DESIGN_LABEL=before|after DESIGN_OUT=<dir> node --require ./dist/tests/_setup.js --test dist/tests/design_capture_screens.js
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { startCanvasAskHarness } from './_canvas_ask_harness.js';

declare const document: any;
declare const window: any;
declare const getComputedStyle: any;

const LABEL = process.env.DESIGN_LABEL || 'before';
const OUT = process.env.DESIGN_OUT || path.join(process.cwd(), 'artifacts', 'design-v2');
const SCREENS: Array<[string, string]> = [['recent', '#recent'], ['workspace', '#inbox'], ['knowledge', '#knowledge'], ['activity', '#activity'], ['settings-account', '#settings/account'], ['settings-personalization', '#settings/personalization'], ['settings-privacy', '#settings/privacy']];

it('screens capture', async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const h = await startCanvasAskHarness({ scrubProviders: true });
  const all: Record<string, unknown> = {};
  for (const locale of ['en', 'ko'] as const) {
    const user = h.user(`scr_${locale}`);
    if (locale === 'ko') h.setLocale(user, 'ko');
    for (const [title, minutes] of [['Quarterly plan v2', 180], ['Launch checklist', 60], ['Trip itinerary', 1500]] as const) h.seedDocument(user, { title, content: `${title} body`, at: new Date(Date.now() - minutes * 60_000).toISOString() });
    const base = await h.newContext('desktop', user, locale);
    const ctx = await h.browser.newContext({ viewport: { width: 1440, height: 900 }, locale: locale === 'ko' ? 'ko-KR' : 'en-US' });
    await ctx.addCookies(await base.cookies());
    await ctx.addInitScript((l: string) => { try { localStorage.setItem('nagex_locale', l); } catch { /* ignore */ } }, locale);
    await base.close();
    const page = await ctx.newPage();
    await page.request.post(`${h.origin}/api/v1/knowledge`, { data: { title: 'Brand guidelines', content: 'Colors and tone of voice.', mimeType: 'text/plain' } });
    await page.request.post(`${h.origin}/api/v1/workspace/vault`, { data: { title: 'Passport scan', type: 'DOCUMENT', mimeType: 'text/plain', storageRef: 'cap-vault', contentText: 'x' } });
    await page.request.post(`${h.origin}/api/v1/workspace/notes`, { data: { text: 'Remember to renew the passport before March.' } }).catch(() => undefined);
    for (const [name, hash] of SCREENS) {
      await page.goto(`${h.origin}/${hash}`);
      await page.reload();
      await page.waitForTimeout(1800);
      await page.screenshot({ path: path.join(OUT, `${LABEL}-${name}-${locale}.png`) });
      all[`${name}-${locale}`] = await page.evaluate(() => {
        const vw = window.innerWidth; const vh = window.innerHeight;
        let chars = 0; let heavy = 0; let inView = 0; const sizes = new Map<number, number>();
        const walker = document.createTreeWalker(document.body, 4);
        while (walker.nextNode()) {
          const node: any = walker.currentNode; const text = (node.textContent || '').trim(); if (!text) continue;
          const el = node.parentElement; if (!el || ['SCRIPT', 'STYLE'].includes(el.tagName)) continue;
          const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
          const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none') continue;
          chars += text.length; if ((parseInt(cs.fontWeight, 10) || 400) >= 700) heavy += text.length;
          if (r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw) inView += text.length;
          const size = Math.round(parseFloat(cs.fontSize)); sizes.set(size, (sizes.get(size) || 0) + text.length);
        }
        return { visibleChars: chars, charsInInitialViewport: inView, heavyTextPercent: chars ? Math.round((heavy / chars) * 1000) / 10 : 0, sizes: Object.fromEntries([...sizes.entries()].sort((a, b) => a[0] - b[0])) };
      });
    }
    await ctx.close();
  }
  fs.writeFileSync(path.join(OUT, `${LABEL}-screens-metrics.json`), JSON.stringify(all, null, 2));
  await h.close();
});

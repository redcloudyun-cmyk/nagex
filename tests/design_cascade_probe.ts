// Design evidence tool (not part of the gates): lists, for key Desktop elements, which stylesheet rules actually win for typography,
// size and elevation properties (the cascade audit behind Design System V2). Uses the DevTools protocol.
//   DESIGN_OUT=<file.json> node --require ./dist/tests/_setup.js --test dist/tests/design_cascade_probe.js
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { startCanvasAskHarness } from './_canvas_ask_harness.js';

const PROPS = ['font-size', 'font-weight', 'font-family', 'padding', 'min-height', 'height', 'box-shadow', 'background-image', 'border-radius', 'letter-spacing', 'line-height'];
const TARGETS: Array<[string, string, string]> = [
  ['home', 'greeting', '#main-greeting'],
  ['home', 'composer-mode-tab', '.main-composer-card .main-mode-btn, .main-composer-card [data-mode]'],
  ['home', 'briefing-card', '.main-briefing-card'],
  ['home', 'briefing-card-title', '.main-briefing-card h2'],
  ['shell', 'sidebar-nav-link', '.nav-menu .nav-link'],
  ['shell', 'header-search', '.global-search, #global-search, header input'],
  ['settings', 'page-title', '#view-settings h2, #view-settings .view-title'],
  ['settings', 'category-tab', '#cat-tab-connections'],
  ['connections', 'card', '.nagex-conn-card'],
  ['connections', 'card-title', '.nagex-conn-card-title h4'],
];

it('cascade probe', async () => {
  const h = await startCanvasAskHarness({ scrubProviders: true });
  const user = h.user('probe_cascade');
  const base = await h.newContext('desktop', user, 'en');
  const ctx = await h.browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addCookies(await base.cookies());
  await base.close();
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  const sheets = new Map<string, string>();
  cdp.on('CSS.styleSheetAdded', (e: any) => sheets.set(e.header.styleSheetId, e.header.sourceURL || '(inline)'));
  await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
  const report: Record<string, unknown> = {};
  for (const [screen, hash] of [['home', '#home'], ['settings', '#settings/connections']] as const) {
    await page.goto(`${h.origin}/${hash}`);
    await page.reload();
    await page.waitForTimeout(2500);
    const doc: any = await cdp.send('DOM.getDocument', { depth: 0 });
    for (const [group, name, selector] of TARGETS) {
      if (group !== screen && group !== 'shell' && !(screen === 'settings' && (group === 'connections' || group === 'settings'))) continue;
      for (const sel of selector.split(',').map((s) => s.trim())) {
        const found: any = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: sel }).catch(() => ({ nodeId: 0 }));
        if (!found.nodeId) continue;
        const matched: any = await cdp.send('CSS.getMatchedStylesForNode', { nodeId: found.nodeId });
        const winners: Record<string, string> = {};
        for (const m of matched.matchedCSSRules || []) {
          const file = path.basename(sheets.get(m.rule.style.styleSheetId) || '(inline)').split('?')[0];
          for (const p of m.rule.style.cssProperties || []) {
            if (!PROPS.includes(p.name) && !PROPS.some((x) => p.name.startsWith(x + '-'))) continue;
            winners[p.name] = `${p.value}${p.important ? ' !important' : ''}  <= ${m.rule.selectorList.text.slice(0, 70)} [${file}]`;
          }
        }
        report[`${screen}:${name}`] = { selector: sel, winners };
        break;
      }
    }
  }
  const out = process.env.DESIGN_OUT || path.join(process.cwd(), 'artifacts', 'design-v2', 'cascade-before.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  await h.close();
});

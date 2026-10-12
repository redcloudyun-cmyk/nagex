// Composes before|after side-by-side PNGs from artifacts/design-gate (evidence tool, not a test gate).
//   node tests/design_gate_compose.cjs <srcDir> <dstDir>   (uses the installed Chrome through playwright)
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const src = process.argv[2]; const dst = process.argv[3];
fs.mkdirSync(dst, { recursive: true });
const names = fs.readdirSync(src).filter((f) => f.startsWith('before-gate-') && f.endsWith('.png')).map((f) => f.replace('before-gate-', '').replace('.png', ''));
(async () => {
  const browser = await chromium.launch({ channel: process.env.NAGEX_TEST_BROWSER_CHANNEL || undefined });
  let n = 0;
  for (const name of names) {
    const b = path.join(src, `before-gate-${name}.png`); const a = path.join(src, `after-gate-${name}.png`);
    if (!fs.existsSync(a)) continue;
    const uri = (p) => 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
    const dim = (p) => { const buf = fs.readFileSync(p); return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }; };
    const d = dim(b);
    const page = await browser.newPage({ viewport: { width: d.w * 2 + 30, height: d.h + 44 } });
    await page.setContent(`<body style="margin:0;background:#222;font:600 20px Segoe UI,sans-serif;color:#fff"><div style="display:flex;gap:30px"><div><div style="height:44px;line-height:44px;padding-left:12px">BEFORE (bcfd548) — ${name}</div><img src="${uri(b)}" width="${d.w}" height="${d.h}"></div><div><div style="height:44px;line-height:44px;padding-left:12px">AFTER (bc54999) — ${name}</div><img src="${uri(a)}" width="${d.w}" height="${d.h}"></div></div></body>`);
    await page.screenshot({ path: path.join(dst, `sbs-${name}.png`) });
    await page.close(); n += 1;
  }
  await browser.close();
  console.log('composites', n);
})();

// PptxGenJS 4.0.1 build of the SAME deck.json. Two variants:
//   plain    - mirrors the baseline look (white, title + bullets) to compare engines on equal design
//   designed - the design a NAgex template would use (accent bar, number, footer, Korean-first fonts)
// Usage: node build_pptxgenjs.cjs <variant> <out.pptx>      (run from a folder where `pptxgenjs` resolves; see README)
const fs = require('fs');
const path = require('path');
const PptxGenJS = require(process.env.PPTXGENJS_PATH || 'pptxgenjs');
const deck = JSON.parse(fs.readFileSync(path.join(__dirname, 'deck.json'), 'utf8'));
const variant = process.argv[2] || 'plain';
const out = process.argv[3];
const FONT = 'Malgun Gothic';

function build() {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'NAGEX_16x9', width: 13.333, height: 7.5 });
  pptx.layout = 'NAGEX_16x9';
  pptx.title = deck.title;
  pptx.author = 'NAgex';
  pptx.theme = { headFontFace: FONT, bodyFontFace: FONT };
  const designed = variant === 'designed';

  pptx.defineSlideMaster({
    title: 'TITLE_SLIDE',
    background: { color: designed ? '0F172A' : 'FFFFFF' },
    objects: designed ? [{ rect: { x: 0, y: 0, w: 0.35, h: 7.5, fill: { color: '2563EB' } } }] : [],
  });
  pptx.defineSlideMaster({
    title: 'CONTENT',
    background: { color: 'FFFFFF' },
    objects: designed
      ? [
          { rect: { x: 0, y: 0, w: 0.25, h: 7.5, fill: { color: '2563EB' } } },
          { line: { x: 0.9, y: 1.55, w: 11.5, h: 0, line: { color: 'E2E8F0', width: 1 } } },
          { text: { text: 'NAgex', options: { x: 0.9, y: 6.95, w: 3, h: 0.3, fontFace: FONT, fontSize: 11, color: '94A3B8' } } },
        ]
      : [],
    slideNumber: designed ? { x: 12.2, y: 6.95, w: 0.6, h: 0.3, fontFace: FONT, fontSize: 11, color: '94A3B8', align: 'right' } : undefined,
  });

  // cover
  const cover = pptx.addSlide({ masterName: 'TITLE_SLIDE' });
  cover.addText(deck.title, designed
    ? { x: 1.0, y: 2.3, w: 11.3, h: 1.6, fontFace: FONT, fontSize: 40, bold: true, color: 'FFFFFF', valign: 'bottom', fit: 'shrink' }
    : { x: 1.67, y: 1.8, w: 10, h: 2.4, fontFace: FONT, fontSize: 40, bold: true, color: '1F2937', valign: 'bottom', fit: 'shrink' });
  if (deck.subtitle) cover.addText(deck.subtitle, designed
    ? { x: 1.0, y: 4.1, w: 11.3, h: 1.0, fontFace: FONT, fontSize: 22, color: '93C5FD', valign: 'top', fit: 'shrink' }
    : { x: 1.67, y: 4.3, w: 10, h: 1.4, fontFace: FONT, fontSize: 24, color: '374151', valign: 'top', fit: 'shrink' });

  // content
  for (const slide of deck.slides) {
    const s = pptx.addSlide({ masterName: 'CONTENT' });
    const titleLen = [...slide.title].length;
    const titleSize = titleLen > 40 ? 26 : titleLen > 28 ? 30 : 34;
    s.addText(slide.title, designed
      ? { x: 0.9, y: 0.35, w: 11.5, h: 1.1, fontFace: FONT, fontSize: titleSize, bold: true, color: '0F172A', valign: 'middle', fit: 'shrink' }
      : { x: 0.92, y: 0.4, w: 11.5, h: 1.45, fontFace: FONT, fontSize: 40, bold: true, color: '1F2937', valign: 'middle', fit: 'shrink' });
    const paras = slide.bullets.map((text) => ({ text, options: { bullet: designed ? { characterCode: '25CF' } : true, breakLine: true } }));
    const lines = slide.bullets.reduce((n, b) => n + Math.max(1, Math.ceil([...b].length / (designed ? 44 : 36))), 0);
    const bodySize = lines > 9 ? 18 : lines > 7 ? 20 : designed ? 24 : 24;
    s.addText(paras, designed
      ? { x: 0.9, y: 1.85, w: 11.5, h: 4.8, fontFace: FONT, fontSize: bodySize, color: '1F2937', valign: 'top', paraSpaceAfter: 14, fit: 'shrink' }
      : { x: 0.92, y: 2.0, w: 11.5, h: 4.76, fontFace: FONT, fontSize: bodySize, color: '1F2937', valign: 'top', paraSpaceAfter: 8, fit: 'shrink' });
    if (designed) s.addNotes(`${slide.title}\n` + slide.bullets.map((b) => `- ${b}`).join('\n'));
  }
  return pptx;
}

(async () => {
  const pptx = build();
  const buf = await pptx.write({ outputType: 'nodebuffer', compression: true });
  fs.writeFileSync(out, buf);
  const N = 30; const t0 = process.hrtime.bigint();
  let last;
  for (let i = 0; i < N; i += 1) last = await build().write({ outputType: 'nodebuffer', compression: true });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  console.log(JSON.stringify({ impl: 'pptxgenjs-4.0.1', variant, bytes: last.length, msPerBuild: Math.round(ms * 100) / 100 }));
})();

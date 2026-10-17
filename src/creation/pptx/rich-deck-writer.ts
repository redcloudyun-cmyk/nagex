// The presentation writer for decks with more than bullets: a 16:9 deck built with the open-source PptxGenJS library (MIT) - real slide masters with title / body placeholders (outline view and screen
// readers work), NATIVE charts (editable in PowerPoint, with their data), tables, pictures with alt text, speaker notes, key-figure cards, quotes and section breaks. NAgex decides the structure and the
// font sizes; the library writes the OOXML. NAgex owns none of the chart / table / picture XML, which is the point of using it.
//
// What stays NAgex's: what a slide may contain (rich-deck.types.ts, checked before this runs), which pictures may be embedded (only PNG / JPEG recognised from their bytes), and a font size per text
// block that FITS (text-fit.ts) - PowerPoint would only shrink text when it is edited. Measured in real PowerPoint with scripts/office-render.ps1 (docs/evidence/NAGEX_OUTCOME_QUALITY_20261017.md).
import PptxGenJS from 'pptxgenjs';
import { imageSize } from '../image-size.js';
import { isNumericCell } from '../docx/docx-writer.js';
import { fitParagraphs, textUnits, wrappedLines } from './text-fit.js';
import { buildZip, readZip } from './zip-writer.js';
import type { DeckBuildReport, RichChart, RichDeck, RichSlide, RichTable, SlideBuildFact } from './rich-deck.types.js';

export const RICH_PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

// ── theme (the colours and fonts of the NAgex template) ────────────────────────────────────────────────────────────────────────────────────────
const COLOR = { ink: '1F2937', navy: '0F172A', blue: '0A56F7', purple: '5B4BD5', green: '0B7A43', amber: 'F5A623', red: 'B3261E', gray: '64748B', light: 'F3F6FC', line: 'E2E8F0', pale: '93C5FD' } as const;
const PALETTE = [COLOR.blue, COLOR.purple, COLOR.green, COLOR.amber, COLOR.red, COLOR.gray];
const FONT = { ko: 'Malgun Gothic', en: 'Calibri' } as const;

// ── geometry in inches (13.333 x 7.5, LAYOUT_WIDE = 16:9) ──────────────────────────────────────────────────────────────────────────────────────
const X = 0.7;
const W = 11.93;
const TITLE = { y: 0.38, h: 1.02 };
const BODY = { y: 1.7, h: 4.85 };
const pt = (inches: number) => inches * 72;

const MASTER_CONTENT = 'NAGEX_CONTENT';
const MASTER_COVER = 'NAGEX_COVER';

/** A slide the writer cannot draw truthfully. Never produced for a plan the checks accepted; thrown instead of drawing something wrong or dropping content in silence. */
export class RichDeckError extends Error {
  constructor(public readonly code: 'RICH_DECK_CHART_INVALID' | 'RICH_DECK_TABLE_INVALID' | 'RICH_DECK_IMAGE_UNSUPPORTED' | 'RICH_DECK_EMPTY', message: string) { super(message); this.name = 'RichDeckError'; }
}

function assertChart(chart: RichChart): void {
  const ok = chart.categories.length >= 1 && chart.series.length >= 1 && chart.series.every((series) => series.values.length === chart.categories.length && series.values.every((v) => Number.isFinite(v)))
    && (chart.type !== 'PIE' || (chart.series.length === 1 && chart.series[0].values.every((v) => v >= 0) && chart.series[0].values.some((v) => v > 0)));
  if (!ok) throw new RichDeckError('RICH_DECK_CHART_INVALID', 'A chart needs at least one category, series with one finite value per category (a pie: one series of non-negative values).');
}
function assertTable(table: RichTable): void {
  if (table.headers.length < 1 || table.rows.length < 1 || table.rows.some((row) => row.length > table.headers.length)) throw new RichDeckError('RICH_DECK_TABLE_INVALID', 'A table needs a header row, at least one row, and no row longer than the header.');
}

interface BuildState { pptx: PptxGenJS; face: string; lang: string; facts: SlideBuildFact[]; charts: number; tables: number; images: number; notes: number }

function defineMasters(pptx: PptxGenJS, face: string, lang: string): void {
  pptx.defineSlideMaster({
    title: MASTER_CONTENT,
    background: { color: 'FFFFFF' },
    objects: [
      { rect: { x: 0, y: 0, w: 0.25, h: 7.5, fill: { color: COLOR.blue } } },
      { line: { x: X, y: 1.47, w: W, h: 0, line: { color: COLOR.line, width: 1 } } },
      { text: { text: 'NAgex', options: { x: X, y: 6.95, w: 3, h: 0.3, fontSize: 10, color: COLOR.gray, fontFace: face, lang } } },
      { placeholder: { options: { name: 'title', type: 'title', x: X, y: TITLE.y, w: W, h: TITLE.h, fontSize: 30, bold: true, color: COLOR.ink, fontFace: face, align: 'left', valign: 'middle', margin: 0, lang }, text: '' } },
      { placeholder: { options: { name: 'body', type: 'body', x: X, y: BODY.y, w: W, h: BODY.h, fontSize: 24, color: COLOR.ink, fontFace: face, align: 'left', valign: 'top', margin: 0, lang }, text: '' } },
    ],
    slideNumber: { x: 11.9, y: 6.95, w: 0.73, h: 0.3, fontSize: 10, color: COLOR.gray, fontFace: face, align: 'right' },
  });
  pptx.defineSlideMaster({
    title: MASTER_COVER,
    background: { color: COLOR.navy },
    objects: [
      { rect: { x: 0, y: 0, w: 0.25, h: 7.5, fill: { color: COLOR.blue } } },
      { placeholder: { options: { name: 'title', type: 'title', x: 0.9, y: 2.0, w: 11.5, h: 2.2, fontSize: 44, bold: true, color: 'FFFFFF', fontFace: face, align: 'left', valign: 'bottom', margin: 0, lang }, text: '' } },
      { placeholder: { options: { name: 'subtitle', type: 'body', x: 0.9, y: 4.45, w: 11.5, h: 1.2, fontSize: 22, color: COLOR.pale, fontFace: face, align: 'left', valign: 'top', margin: 0, lang }, text: '' } },
    ],
  });
}

function slideTitle(state: BuildState, slide: PptxGenJS.Slide, text: string): number {
  const fit = fitParagraphs([text], { widthPt: pt(W), heightPt: pt(TITLE.h) - 6, maxPt: 30, minPt: 18, lineHeight: 1.15 });
  slide.addText(sized(text, fit.sizePt, state.face, state.lang, COLOR.ink, true), { placeholder: 'title', align: 'left', fit: 'none' });
  return fit.sizePt;
}

// the size is set on EVERY run: for a placeholder the library lets the master's size win over the option of the whole text (measured: a 19 pt choice came out as the master's 24 pt)
const bulletRuns = (items: string[], lang: string, sizePt: number, face: string, color: string = COLOR.ink) => items.map((text, i) => ({ text, options: { bullet: { indent: 22 }, breakLine: i < items.length - 1, paraSpaceAfter: 10, color, lang, fontSize: sizePt, fontFace: face } }));
// a single run with an explicit size (titles, subtitles)
const sized = (text: string, sizePt: number, face: string, lang: string, color: string, bold = false): PptxGenJS.TextProps[] => [{ text, options: { fontSize: sizePt, bold, color, fontFace: face, lang } }];

function addBulletsBox(state: BuildState, slide: PptxGenJS.Slide, items: string[], box: { x: number; y: number; w: number; h: number }, max: number, min: number, placeholder?: 'body'): { sizePt: number; fits: boolean } {
  const fit = fitParagraphs(items, { widthPt: pt(box.w) - 26, heightPt: pt(box.h), maxPt: max, minPt: min, lineHeight: 1.25, gapPt: 10 });
  const options: PptxGenJS.TextPropsOptions = { fontSize: fit.sizePt, fontFace: state.face, align: 'left', valign: 'top', fit: 'none', margin: 0 };
  if (placeholder) (options as { placeholder?: string }).placeholder = placeholder;
  else Object.assign(options, { x: box.x, y: box.y, w: box.w, h: box.h });
  slide.addText(bulletRuns(items, state.lang, fit.sizePt, state.face) as PptxGenJS.TextProps[], options);
  return { sizePt: fit.sizePt, fits: fit.fits };
}

// bullets in pages: as many as fit at the smallest readable size (16 pt), at least one per page
function splitBullets(items: string[], widthPt: number, heightPt: number): string[][] {
  const pages: string[][] = [];
  let current: string[] = [];
  for (const item of items) {
    const candidate = [...current, item];
    if (current.length > 0 && !fitParagraphs(candidate, { widthPt, heightPt, maxPt: 16, minPt: 16, lineHeight: 1.25, gapPt: 10 }).fits) { pages.push(current); current = [item]; } else current = candidate;
  }
  if (current.length) pages.push(current);
  return pages.length ? pages : [items];
}

// ── charts ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function chartAlt(chart: RichChart, locale: 'en' | 'ko'): string {
  const kind = chart.type === 'BAR' ? (locale === 'ko' ? '막대 차트' : 'Bar chart') : chart.type === 'LINE' ? (locale === 'ko' ? '꺾은선 차트' : 'Line chart') : (locale === 'ko' ? '원형 차트' : 'Pie chart');
  const points = chart.series.map((s) => `${s.name}: ${chart.categories.map((c, i) => `${c} ${s.values[i]}${chart.unit ?? ''}`).join(', ')}`).join('; ');
  return `${kind}. ${points}`.slice(0, 500);
}

function addChart(state: BuildState, slide: PptxGenJS.Slide, chart: RichChart, box: { x: number; y: number; w: number; h: number }, locale: 'en' | 'ko'): void {
  const { pptx } = state;
  const data = chart.series.map((s) => ({ name: s.name, labels: chart.categories, values: s.values }));
  const decimals = chart.series.some((s) => s.values.some((v) => !Number.isInteger(v)));
  // the unit travels with the number (45분, 73%), in the number format of the labels and the axis - an axis title for it rendered as a stray rotated glyph
  const unit = (chart.unit ?? '').trim().replace(/["\\]/g, '').slice(0, 6);
  const base = decimals ? '#,##0.0#' : '#,##0';
  // a currency symbol stands in front of the amount ($18,000), any other unit follows it (45분, 73%, 12,000원)
  const numberFormat = !unit ? base : /^[$€£¥₩]$/.test(unit) ? `"${unit}"${base}` : `${base}"${unit}"`;
  const common: Record<string, unknown> = {
    ...box,
    chartColors: Array.from({ length: chart.type === 'PIE' ? chart.categories.length : chart.series.length }, (_, i) => PALETTE[i % PALETTE.length]),
    showLegend: chart.type === 'PIE' || chart.series.length > 1,
    legendPos: chart.type === 'PIE' ? 'r' : 'b',
    legendFontSize: 12,
    legendFontFace: state.face,
    legendColor: COLOR.ink,
    dataLabelFontSize: 12,
    dataLabelFontFace: state.face,
    dataLabelColor: COLOR.ink,
    dataLabelFormatCode: numberFormat,
    altText: chartAlt(chart, locale),
    objectName: 'Chart',
  };
  if (chart.type === 'PIE') {
    // PowerPoint's percentage label formats a FRACTION: 0% is the code for it (a unit code here printed 55 % as "1%")
    slide.addChart(pptx.ChartType.pie, data.slice(0, 1), { ...common, dataLabelFormatCode: '0%', showPercent: true, showValue: false, dataLabelPosition: 'bestFit', showTitle: false } as PptxGenJS.IChartOpts);
    return;
  }
  const axis: Record<string, unknown> = {
    catAxisLabelFontSize: 12, catAxisLabelFontFace: state.face, catAxisLabelColor: COLOR.ink,
    valAxisLabelFontSize: 12, valAxisLabelFontFace: state.face, valAxisLabelColor: COLOR.gray,
    valAxisLabelFormatCode: numberFormat, valGridLine: { color: COLOR.line, size: 0.75 }, catGridLine: { style: 'none' },
    showValue: chart.categories.length <= 8 || chart.series.length === 1,
    showTitle: false,
  };
  // a bar's LENGTH is the value: an automatic axis that starts at 66% makes 73% against 72% look like a big gap (measured in real PowerPoint) - bars always start at zero
  if (chart.type === 'BAR') slide.addChart(pptx.ChartType.bar, data, { ...common, ...axis, barDir: 'col', barGapWidthPct: 60, dataLabelPosition: 'outEnd', valAxisMinVal: Math.min(0, ...chart.series.flatMap((s) => s.values)) } as PptxGenJS.IChartOpts);
  else slide.addChart(pptx.ChartType.line, data, { ...common, ...axis, lineSize: 3, lineDataSymbolSize: 8, dataLabelPosition: 't' } as PptxGenJS.IChartOpts);
}

// ── tables ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// table rows: never thinner than ROW_MIN inches, and the smallest text a table uses is the smallest the evaluation accepts as readable (12 pt) - a table that does not fit at 12 pt is split, not shrunk
const ROW_MIN = 0.38;
const ROW_SLACK = 1.04;
const TABLE_MIN_PT = 12;
interface TablePlan { sizePt: number; colW: number[]; align: Array<'left' | 'right'>; pages: Array<{ rows: string[][]; heights: number[] }> }

function planTable(table: RichTable, availableH: number, lastPageH: number = availableH): TablePlan {
  const columns = table.headers.length;
  const weights = Array.from({ length: columns }, (_, c) => Math.min(30, Math.max(4, Math.ceil(Math.max(textUnits(table.headers[c] ?? ''), ...table.rows.map((r) => textUnits(r[c] ?? '')))))));
  const total = weights.reduce((a, b) => a + b, 0);
  const minW = 0.9;
  let colW = weights.map((w) => Math.max(minW, (W * w) / total));
  const scale = W / colW.reduce((a, b) => a + b, 0);
  colW = colW.map((w) => Math.round(w * scale * 1000) / 1000);
  const align = Array.from({ length: columns }, (_, c) => (table.rows.length > 0 && table.rows.every((r) => !(r[c] ?? '').trim() || isNumericCell(r[c])) && table.rows.some((r) => (r[c] ?? '').trim()) ? 'right' : 'left')) as Array<'left' | 'right'>;
  const rowHeights = (rows: string[][], size: number): number[] => rows.map((row) => {
    const lines = Math.max(1, ...row.map((cell, c) => wrappedLines(cell ?? '', size, pt(colW[c]) - 14)));
    return Math.max(ROW_MIN, (lines * size * 1.2 + 12) / 72) * ROW_SLACK; // 12 pt of cell padding; a little for what the estimate cannot know
  });
  const header = [table.headers];
  for (let size = 16; size >= TABLE_MIN_PT; size -= 1) {
    const heights = rowHeights([...header, ...table.rows], size);
    if (heights.reduce((a, b) => a + b, 0) <= lastPageH) return { sizePt: size, colW, align, pages: [{ rows: table.rows, heights: heights.slice(1) }] };
  }
  // does not fit on one slide even at 11 pt: split the body rows over slides, the header row repeats on each
  const size = TABLE_MIN_PT;
  const all = rowHeights([...header, ...table.rows], size);
  const headerH = all[0];
  const pages: TablePlan['pages'] = [];
  let current: { rows: string[][]; heights: number[] } = { rows: [], heights: [] };
  let used = headerH;
  table.rows.forEach((row, i) => {
    const h = all[i + 1];
    if (current.rows.length > 0 && used + h > availableH) { pages.push(current); current = { rows: [], heights: [] }; used = headerH; }
    current.rows.push(row); current.heights.push(h); used += h;
  });
  if (current.rows.length) pages.push(current);
  // the last page also carries the takeaway: move rows from its end to a new page until it fits the shorter space
  const last = pages[pages.length - 1];
  while (last.rows.length > 1 && headerH + last.heights.reduce((a, b) => a + b, 0) > lastPageH) {
    const row = last.rows.pop() as string[]; const h = last.heights.pop() as number;
    if (pages.length === 0 || pages[pages.length - 1] === last) pages.push({ rows: [row], heights: [h] });
    else pages[pages.length - 1].rows.unshift(row), pages[pages.length - 1].heights.unshift(h);
  }
  return { sizePt: size, colW, align, pages };
}

function addTable(state: BuildState, slide: PptxGenJS.Slide, table: RichTable, plan: TablePlan, page: { rows: string[][]; heights: number[] }, y: number): void {
  const header = table.headers.map((text, c) => ({ text, options: { bold: true, color: 'FFFFFF', fill: { color: COLOR.navy }, align: (plan.align[c] === 'right' ? 'right' : 'left') as 'left' | 'right', valign: 'middle' as const } }));
  const body = page.rows.map((row, r) => table.headers.map((_, c) => ({ text: row[c] ?? '', options: { color: COLOR.ink, fill: { color: r % 2 === 1 ? COLOR.light : 'FFFFFF' }, align: plan.align[c], valign: 'middle' as const } })));
  slide.addTable([header, ...body] as PptxGenJS.TableRow[], {
    x: X, y, w: W, colW: plan.colW, rowH: [Math.max(ROW_MIN, (plan.sizePt * 1.2 + 12) / 72) * ROW_SLACK, ...page.heights],
    fontSize: plan.sizePt, fontFace: state.face, border: { type: 'solid', color: COLOR.line, pt: 0.75 }, margin: [4, 7, 4, 7], autoPage: false,
  } as PptxGenJS.TableProps);
}

// ── the deck ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function addNotes(state: BuildState, slide: PptxGenJS.Slide, notes?: string): boolean {
  const text = (notes ?? '').trim();
  if (!text) return false;
  slide.addNotes(text);
  state.notes += 1;
  return true;
}

function contentSlide(state: BuildState, title: string): { slide: PptxGenJS.Slide; titlePt: number } {
  const slide = state.pptx.addSlide({ masterName: MASTER_CONTENT });
  return { slide, titlePt: slideTitle(state, slide, title) };
}

function renderSlide(state: BuildState, def: RichSlide, locale: 'en' | 'ko'): void {
  const index = state.facts.length + 1;
  const note = (fact: Omit<SlideBuildFact, 'index' | 'hasNotes'>, slide: PptxGenJS.Slide) => state.facts.push({ index, hasNotes: addNotes(state, slide, def.notes), ...fact });

  if (def.layout === 'SECTION') {
    const slide = state.pptx.addSlide({ masterName: MASTER_COVER });
    const fit = fitParagraphs([def.title], { widthPt: pt(11.5), heightPt: pt(2.2) - 4, maxPt: 44, minPt: 28, lineHeight: 1.15 });
    slide.addText(sized(def.title, fit.sizePt, state.face, state.lang, 'FFFFFF', true), { placeholder: 'title', align: 'left', fit: 'none' });
    if (def.subtitle) slide.addText(sized(def.subtitle, 22, state.face, state.lang, COLOR.pale), { placeholder: 'subtitle', align: 'left', fit: 'none' });
    note({ layout: 'SECTION', title: def.title, fontPt: fit.sizePt, tightFit: !fit.fits }, slide);
    return;
  }

  if (def.layout === 'BULLETS') {
    // bullets that do not fit at the smallest readable size continue on the next slide (never overflow, never hidden)
    const pages = splitBullets(def.bullets, pt(W) - 26, pt(BODY.h));
    pages.forEach((items, p) => {
      const titleText = pages.length > 1 ? `${def.title} (${p + 1}/${pages.length})` : def.title;
      const { slide } = contentSlide(state, titleText);
      const fitted = addBulletsBox(state, slide, items, { x: X, y: BODY.y, w: W, h: BODY.h }, 24, 16, 'body');
      state.facts.push({ index: state.facts.length + 1, layout: 'BULLETS', title: titleText, fontPt: fitted.sizePt, tightFit: !fitted.fits || undefined, continuation: p > 0 || undefined, hasNotes: p === 0 ? addNotes(state, slide, def.notes) : false });
    });
    return;
  }

  if (def.layout === 'CHART') {
    assertChart(def.chart);
    const { slide } = contentSlide(state, def.title);
    const hasTakeaway = def.bullets.length > 0;
    const chartBox = hasTakeaway ? { x: X, y: BODY.y, w: 7.7, h: BODY.h - 0.4 } : { x: X, y: BODY.y, w: W, h: BODY.h - 0.4 };
    addChart(state, slide, def.chart, chartBox, locale);
    state.charts += 1;
    let fontPt: number | undefined; let tight = false;
    if (hasTakeaway) { const fitted = addBulletsBox(state, slide, def.bullets, { x: 8.7, y: BODY.y + 0.2, w: 3.93, h: BODY.h - 0.8 }, 20, 12); fontPt = fitted.sizePt; tight = !fitted.fits; }
    if (def.chart.sourceNote) slide.addText(def.chart.sourceNote, { x: X, y: 6.5, w: W, h: 0.35, fontSize: 12, color: COLOR.gray, italic: true, fontFace: state.face, lang: state.lang, valign: 'middle', margin: 0, fit: 'none' });
    note({ layout: 'CHART', title: def.title, fontPt, tightFit: tight }, slide);
    return;
  }

  if (def.layout === 'METRICS') {
    const { slide } = contentSlide(state, def.title);
    const n = def.metrics.length;
    const gap = 0.3;
    const cardW = (W - gap * (n - 1)) / n;
    def.metrics.forEach((metric, i) => {
      const valueFit = fitParagraphs([metric.value], { widthPt: pt(cardW) - 24, heightPt: 70, maxPt: 48, minPt: 24, lineHeight: 1.1 });
      const runs: PptxGenJS.TextProps[] = [
        { text: metric.value, options: { fontSize: valueFit.sizePt, bold: true, color: COLOR.blue, breakLine: true, fontFace: state.face, lang: state.lang } },
        { text: metric.label, options: { fontSize: 18, bold: true, color: COLOR.ink, breakLine: Boolean(metric.note), fontFace: state.face, lang: state.lang } },
        ...(metric.note ? [{ text: metric.note, options: { fontSize: 13, color: COLOR.gray, fontFace: state.face, lang: state.lang } }] : []),
      ];
      slide.addText(runs, { x: X + i * (cardW + gap), y: BODY.y + 0.2, w: cardW, h: 2.6, shape: state.pptx.ShapeType.roundRect, rectRadius: 0.08, fill: { color: COLOR.light }, line: { color: COLOR.line, width: 1 }, align: 'center', valign: 'middle', margin: 12, fit: 'none' } as PptxGenJS.TextPropsOptions);
    });
    let fontPt: number | undefined; let tight = false;
    if (def.bullets.length) { const fitted = addBulletsBox(state, slide, def.bullets, { x: X, y: 4.85, w: W, h: 1.7 }, 20, 12); fontPt = fitted.sizePt; tight = !fitted.fits; }
    note({ layout: 'METRICS', title: def.title, fontPt, tightFit: tight }, slide);
    return;
  }

  if (def.layout === 'TABLE') {
    assertTable(def.table);
    const hasTakeaway = def.bullets.length > 0;
    // the takeaways need room under the LAST part of the table: how much is estimated at a readable 16 pt, and the table is planned to leave it
    const takeaway = hasTakeaway ? fitParagraphs(def.bullets, { widthPt: pt(W) - 26, heightPt: pt(2.2), maxPt: 16, minPt: 16, lineHeight: 1.25, gapPt: 10 }) : null;
    const reserve = takeaway ? takeaway.heightPt / 72 + 0.45 : 0;
    const plan = planTable(def.table, 4.8, 4.8 - reserve);
    plan.pages.forEach((page, p) => {
      const last = p === plan.pages.length - 1;
      const titleText = plan.pages.length > 1 ? `${def.title} (${p + 1}/${plan.pages.length})` : def.title;
      const { slide } = contentSlide(state, titleText);
      addTable(state, slide, def.table, plan, page, BODY.y + 0.05);
      state.tables += 1;
      let tight = false;
      if (last && hasTakeaway) {
        // right under the table (estimated height + a gap), down to just above the footer
        const tableBottom = BODY.y + 0.05 + Math.max(ROW_MIN, (plan.sizePt * 1.2 + 12) / 72) * ROW_SLACK + page.heights.reduce((a, b) => a + b, 0);
        const y = Math.min(tableBottom + 0.3, 6.85 - (takeaway?.heightPt ?? 36) / 72);
        const fitted = addBulletsBox(state, slide, def.bullets, { x: X, y, w: W, h: Math.max(0.5, 6.85 - y) }, 18, 12);
        tight = !fitted.fits;
      }
      const fact: SlideBuildFact = { index: state.facts.length + 1, layout: 'TABLE', title: titleText, fontPt: plan.sizePt, tightFit: tight || undefined, continuation: p > 0 || undefined, hasNotes: addNotes(state, slide, def.notes) };
      state.facts.push(fact);
    });
    return;
  }

  if (def.layout === 'IMAGE') {
    const { slide } = contentSlide(state, def.title);
    const info = imageSize(def.image.bytes);
    if (!info) throw new RichDeckError('RICH_DECK_IMAGE_UNSUPPORTED', 'Only PNG and JPEG pictures can be placed on a slide.');
    {
      const box = { x: X, y: BODY.y, w: 6.4, h: def.image.caption ? 4.35 : 4.85 };
      const scale = Math.min(box.w / info.width, box.h / info.height);
      const w = info.width * scale; const h = info.height * scale;
      slide.addImage({ data: `image/${info.extension};base64,${def.image.bytes.toString('base64')}`, x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h, altText: def.image.alt, objectName: 'Picture' } as PptxGenJS.ImageProps);
      state.images += 1;
      if (def.image.caption) slide.addText(def.image.caption, { x: box.x, y: box.y + box.h + 0.05, w: box.w, h: 0.4, fontSize: 12, italic: true, color: COLOR.gray, align: 'center', fontFace: state.face, lang: state.lang, valign: 'middle', margin: 0, fit: 'none' });
    }
    const fitted = addBulletsBox(state, slide, def.bullets, { x: 7.4, y: BODY.y + 0.1, w: 5.23, h: BODY.h - 0.2 }, 22, 12);
    note({ layout: 'IMAGE', title: def.title, fontPt: fitted.sizePt, tightFit: !fitted.fits }, slide);
    return;
  }

  // QUOTE
  const { slide } = contentSlide(state, def.title);
  const fit = fitParagraphs([def.quote], { widthPt: pt(11.1), heightPt: pt(3.2), maxPt: 36, minPt: 20, lineHeight: 1.25 });
  slide.addText(`“${def.quote}”`, { x: 1.1, y: 1.8, w: 11.1, h: 3.2, fontSize: fit.sizePt, italic: true, color: COLOR.ink, align: 'center', valign: 'middle', fontFace: state.face, lang: state.lang, margin: 0, fit: 'none' });
  if (def.attribution) slide.addText(`— ${def.attribution}`, { x: 1.1, y: 5.15, w: 11.1, h: 0.5, fontSize: 18, color: COLOR.gray, align: 'center', fontFace: state.face, lang: state.lang, margin: 0, fit: 'none' });
  note({ layout: 'QUOTE', title: def.title, fontPt: fit.sizePt, tightFit: !fit.fits }, slide);
}

export interface RichDeckResult { buffer: Buffer; report: DeckBuildReport }

// The library lists a content type for slide masters it never writes (a deck with two masters names slideMaster2 and slideMaster3 in [Content_Types].xml and ships only slideMaster1). PowerPoint
// tolerates it; a package that names a part that is not there is not conformant. The dangling entries - and nothing else - are removed; every other byte of every part is kept.
export function removeDanglingContentTypes(buffer: Buffer): Buffer {
  const entries = readZip(buffer).filter((entry) => !entry.name.endsWith('/'));
  const types = entries.find((entry) => entry.name === '[Content_Types].xml');
  if (!types) return buffer;
  const present = new Set(entries.map((entry) => entry.name));
  const xml = types.data.toString('utf8');
  const tidy = xml.replace(/<Override [^>]*PartName="([^"]+)"[^>]*\/>/g, (whole, part: string) => (present.has(part.replace(/^\//, '')) ? whole : ''));
  if (tidy === xml) return buffer;
  return buildZip(entries.map((entry) => (entry === types ? { ...entry, data: Buffer.from(tidy, 'utf8') } : entry)));
}

/** Builds the .pptx. Throws only for a programming error; a plan the checks accepted always builds. */
export async function buildRichDeck(deck: RichDeck): Promise<RichDeckResult> {
  if (!deck.title.trim()) throw new RichDeckError('RICH_DECK_EMPTY', 'A deck needs a title.');
  const locale = deck.locale === 'ko' ? 'ko' : 'en';
  const face = FONT[locale];
  const lang = locale === 'ko' ? 'ko-KR' : 'en-US';
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = deck.title;
  pptx.author = 'NAgex';
  pptx.company = 'NAgex';
  pptx.subject = deck.subtitle ?? '';
  pptx.theme = { headFontFace: face, bodyFontFace: face };
  defineMasters(pptx, face, lang);
  const state: BuildState = { pptx, face, lang, facts: [], charts: 0, tables: 0, images: 0, notes: 0 };

  const cover = pptx.addSlide({ masterName: MASTER_COVER });
  const coverFit = fitParagraphs([deck.title], { widthPt: pt(11.5), heightPt: pt(2.2) - 4, maxPt: 44, minPt: 26, lineHeight: 1.15 });
  cover.addText(sized(deck.title, coverFit.sizePt, face, lang, 'FFFFFF', true), { placeholder: 'title', align: 'left', fit: 'none' });
  if (deck.subtitle) cover.addText(sized(deck.subtitle, 22, face, lang, COLOR.pale), { placeholder: 'subtitle', align: 'left', fit: 'none' });
  const sources = (deck.sources ?? []).map((source) => source.trim()).filter(Boolean).slice(0, 12);
  const coverNotes = sources.length > 0 && !deck.sourcesSlide ? `${locale === 'ko' ? '이 자료의 근거' : 'Made from'}: ${sources.join('; ')}` : '';
  if (coverNotes) { cover.addNotes(coverNotes); state.notes += 1; }
  state.facts.push({ index: 1, layout: 'COVER', title: deck.title, fontPt: coverFit.sizePt, tightFit: !coverFit.fits || undefined, hasNotes: Boolean(coverNotes) });

  for (const slide of deck.slides) renderSlide(state, slide, locale);

  if (deck.sourcesSlide && sources.length > 0) {
    const { slide } = contentSlide(state, locale === 'ko' ? '참고 자료' : 'Sources');
    const items = sources;
    const fit = fitParagraphs(items, { widthPt: pt(W) - 26, heightPt: pt(BODY.h), maxPt: 20, minPt: 12, lineHeight: 1.25, gapPt: 8 });
    slide.addText(items.map((text, i) => ({ text, options: { bullet: { type: 'number' as const }, breakLine: i < items.length - 1, paraSpaceAfter: 8, color: COLOR.ink, lang, fontSize: fit.sizePt, fontFace: face } })) as PptxGenJS.TextProps[], { placeholder: 'body', valign: 'top', fit: 'none', margin: 0 } as PptxGenJS.TextPropsOptions);
    state.facts.push({ index: state.facts.length + 1, layout: 'SOURCES', title: locale === 'ko' ? '참고 자료' : 'Sources', fontPt: fit.sizePt, tightFit: !fit.fits || undefined, hasNotes: false });
  }

  const output = await pptx.write({ outputType: 'nodebuffer' });
  const written = Buffer.isBuffer(output) ? output : Buffer.from(output as ArrayBuffer);
  const buffer = removeDanglingContentTypes(written);
  return { buffer, report: { slideCount: state.facts.length, slides: state.facts, charts: state.charts, tables: state.tables, images: state.images, notes: state.notes } };
}

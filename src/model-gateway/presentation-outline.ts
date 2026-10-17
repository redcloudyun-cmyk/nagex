// A deck outline as the model returns it, normalized and bounded before anything is built from it.
// The model decides content; NAgex decides what is acceptable: slide count, bullets per slide and text lengths are enforced here, control
// characters are removed, and an outline without at least two real content slides is rejected instead of being padded with invented text.
//
// A slide may ask for a LAYOUT beyond bullets - a chart, key figures, a table, a picture beside text, a quote, a section break - and carries speaker notes. Each is parsed strictly; a visual that does not
// parse (a chart whose values do not match its categories, a table row longer than its header) is DEMOTED to a bullet slide when it has takeaways and dropped when it has nothing else - never repaired by
// guessing. Every demotion is recorded on the outline (`demotions`) so the person is told. Whether the NUMBERS of a visual are traceable to what the person gave is a separate check (creation/pptx/number-grounding.ts).
import { NagexError } from '../common/errors.js';
import { saysNothingYet } from '../creation/placeholder-text.js';

export type OutlineLayout = 'BULLETS' | 'CHART' | 'METRICS' | 'TABLE' | 'IMAGE' | 'QUOTE' | 'SECTION';
const LAYOUTS: ReadonlySet<string> = new Set<OutlineLayout>(['BULLETS', 'CHART', 'METRICS', 'TABLE', 'IMAGE', 'QUOTE', 'SECTION']);

export interface OutlineChart {
  type: 'BAR' | 'LINE' | 'PIE';
  categories: string[];
  series: Array<{ name: string; values: number[] }>;
  unit?: string;
  sourceNote?: string;
}
export interface OutlineMetric { label: string; value: string; note?: string }
export interface OutlineTable { headers: string[]; rows: string[][] }
export interface OutlineImage {
  /** one of the references the person's own pictures were offered under ("image_1"); resolved to bytes by the executor, never a URL */
  ref: string;
  alt: string;
  caption?: string;
}

export interface PresentationOutlineSlide {
  title: string;
  /** the bullets of a text slide, or the takeaway(s) of a visual one */
  bullets: string[];
  /** absent = BULLETS (decks stored before layouts existed) */
  layout?: OutlineLayout;
  chart?: OutlineChart;
  metrics?: OutlineMetric[];
  table?: OutlineTable;
  image?: OutlineImage;
  quote?: string;
  attribution?: string;
  subtitle?: string;
  /** what the presenter says; never printed on the slide */
  notes?: string;
}

export type OutlineDemotionCode = 'CHART_INVALID' | 'METRICS_INVALID' | 'TABLE_INVALID' | 'IMAGE_INVALID' | 'QUOTE_INVALID' | 'UNGROUNDED_NUMBERS' | 'IMAGE_NOT_AVAILABLE' | 'PLACEHOLDER_ONLY';
export interface OutlineDemotion {
  /** 1-based position among the content slides of the finished outline (a dropped slide is not counted) */
  slide: number;
  layout: OutlineLayout;
  code: OutlineDemotionCode;
}

export interface PresentationOutline {
  title: string;
  subtitle: string;
  slides: PresentationOutlineSlide[];
  /** what was asked for but not delivered as asked, and why - shown to the person */
  demotions?: OutlineDemotion[];
}

export const OUTLINE_LIMITS = {
  minContentSlides: 2,
  maxContentSlides: 14,
  maxBulletsPerSlide: 6,
  maxTitleChars: 120,
  maxSubtitleChars: 200,
  maxBulletChars: 220,
  // a visual slide shares its space with the visual: at most three short takeaways
  maxTakeawaysPerVisual: 3,
  maxTakeawayChars: 100,
  maxNotesChars: 600,
  chart: { minCategories: 2, maxCategories: 12, maxSeries: 4, maxLabelChars: 24, maxSeriesNameChars: 30, maxUnitChars: 6, maxSourceNoteChars: 120 },
  metrics: { min: 2, max: 4, maxLabelChars: 24, maxValueChars: 14, maxNoteChars: 40 },
  table: { minColumns: 2, maxColumns: 6, maxRows: 24, maxHeaderChars: 20, maxCellChars: 60 },
  image: { maxRefChars: 40, maxAltChars: 160, maxCaptionChars: 100 },
  quote: { maxChars: 200, maxAttributionChars: 60 },
  section: { maxSubtitleChars: 120 },
} as const;

function clean(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

// a number as the model may write it: 45, "45", "1,200", "73%", "12.5"
export function parseLooseNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.replace(/[,\s%]/g, '');
  return /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : null;
}

function parseChart(raw: unknown): OutlineChart | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const limits = OUTLINE_LIMITS.chart;
  const type = String(record.type ?? '').trim().toUpperCase();
  if (type !== 'BAR' && type !== 'LINE' && type !== 'PIE') return null;
  const categories = (Array.isArray(record.categories) ? record.categories : []).map((c) => clean(typeof c === 'number' ? String(c) : c, limits.maxLabelChars));
  if (categories.length < limits.minCategories || categories.length > limits.maxCategories || categories.some((c) => !c)) return null;
  const rawSeries = Array.isArray(record.series) ? record.series : [];
  if (rawSeries.length < 1 || rawSeries.length > limits.maxSeries) return null;
  const series: OutlineChart['series'] = [];
  for (const [i, item] of rawSeries.entries()) {
    if (!item || typeof item !== 'object') return null;
    const entry = item as Record<string, unknown>;
    const values = (Array.isArray(entry.values) ? entry.values : []).map(parseLooseNumber);
    if (values.length !== categories.length || values.some((v) => v === null || Math.abs(v) > 1e12)) return null;
    series.push({ name: clean(entry.name, limits.maxSeriesNameChars) || `${i + 1}`, values: values as number[] });
  }
  if (type === 'PIE' && (series.length !== 1 || series[0].values.some((v) => v < 0) || !series[0].values.some((v) => v > 0))) return null;
  const unit = clean(record.unit, limits.maxUnitChars).replace(/["\\]/g, '');
  const sourceNote = clean(record.sourceNote, limits.maxSourceNoteChars);
  return { type, categories, series, ...(unit ? { unit } : {}), ...(sourceNote ? { sourceNote } : {}) };
}

function parseMetrics(raw: unknown): OutlineMetric[] | null {
  const limits = OUTLINE_LIMITS.metrics;
  if (!Array.isArray(raw)) return null;
  const metrics: OutlineMetric[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null;
    const entry = item as Record<string, unknown>;
    const label = clean(entry.label, limits.maxLabelChars);
    const value = clean(typeof entry.value === 'number' ? String(entry.value) : entry.value, limits.maxValueChars);
    if (!label || !value) return null;
    const note = clean(entry.note, limits.maxNoteChars);
    metrics.push({ label, value, ...(note ? { note } : {}) });
  }
  return metrics.length >= limits.min && metrics.length <= limits.max ? metrics : null;
}

function parseTable(raw: unknown): OutlineTable | null {
  const limits = OUTLINE_LIMITS.table;
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const headers = (Array.isArray(record.headers) ? record.headers : []).map((h) => clean(typeof h === 'number' ? String(h) : h, limits.maxHeaderChars));
  if (headers.length < limits.minColumns || headers.length > limits.maxColumns || headers.some((h) => !h)) return null;
  const rawRows = Array.isArray(record.rows) ? record.rows : [];
  if (rawRows.length < 1 || rawRows.length > limits.maxRows) return null;
  const rows: string[][] = [];
  for (const row of rawRows) {
    if (!Array.isArray(row) || row.length > headers.length) return null; // a longer row would lose a cell: the table is refused, not trimmed
    const cells = row.map((cell) => clean(typeof cell === 'number' ? String(cell) : cell, limits.maxCellChars));
    while (cells.length < headers.length) cells.push('');
    if (cells.every((c) => !c)) return null;
    rows.push(cells);
  }
  return { headers, rows };
}

function parseImage(raw: unknown, fallbackAlt: string): OutlineImage | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const limits = OUTLINE_LIMITS.image;
  const ref = clean(record.ref, limits.maxRefChars);
  if (!ref || !/^[A-Za-z0-9_-]+$/.test(ref)) return null;
  const alt = clean(record.alt, limits.maxAltChars) || fallbackAlt;
  const caption = clean(record.caption, limits.maxCaptionChars);
  return { ref, alt, ...(caption ? { caption } : {}) };
}

// `contentSlides`: the person named the size of the deck (see creation/slide-count.ts). Slides beyond it are cut (the first ones are kept - never padded, never reordered) and a deck of exactly that
// size is acceptable even when it is smaller than the usual minimum of two content slides.
export function normalizePresentationOutline(parsed: Record<string, unknown>, requestId: string, options: { contentSlides?: number } = {}): PresentationOutline {
  const limit = options.contentSlides ? Math.min(options.contentSlides, OUTLINE_LIMITS.maxContentSlides) : OUTLINE_LIMITS.maxContentSlides;
  const minimum = options.contentSlides ? Math.min(options.contentSlides, OUTLINE_LIMITS.minContentSlides) : OUTLINE_LIMITS.minContentSlides;
  const title = clean(parsed.title, OUTLINE_LIMITS.maxTitleChars);
  if (!title) {
    throw new NagexError({ code: 'INVALID_MODEL_RESPONSE', category: 'PROVIDER', message: 'The model response is missing the deck title.', request_id: requestId });
  }
  const rawSlides = Array.isArray(parsed.slides) ? parsed.slides : [];
  const slides: PresentationOutlineSlide[] = [];
  const demotions: OutlineDemotion[] = [];
  for (const raw of rawSlides) {
    if (!raw || typeof raw !== 'object') continue;
    const record = raw as Record<string, unknown>;
    const slideTitle = clean(record.title, OUTLINE_LIMITS.maxTitleChars);
    if (!slideTitle) continue;
    const requested = String(record.layout ?? '').trim().toUpperCase();
    const layout: OutlineLayout = LAYOUTS.has(requested) ? (requested as OutlineLayout) : 'BULLETS';
    const visual = layout === 'CHART' || layout === 'METRICS' || layout === 'TABLE' || layout === 'IMAGE';
    const maxBullets = visual ? OUTLINE_LIMITS.maxTakeawaysPerVisual : OUTLINE_LIMITS.maxBulletsPerSlide;
    const maxChars = visual ? OUTLINE_LIMITS.maxTakeawayChars : OUTLINE_LIMITS.maxBulletChars;
    const bullets = (Array.isArray(record.bullets) ? record.bullets : []).map((bullet) => clean(bullet, maxChars)).filter((bullet) => bullet.length > 0).slice(0, maxBullets);
    const notes = clean(record.notes, OUTLINE_LIMITS.maxNotesChars);
    const withNotes = notes ? { notes } : {};
    const demote = (code: OutlineDemotionCode) => {
      // a visual that did not parse becomes a bullet slide when it has something to say, and is dropped when it has nothing else - the position is the one it will have
      if (bullets.length === 0) return;
      demotions.push({ slide: slides.length + 1, layout, code });
      slides.push({ title: slideTitle, bullets, ...withNotes });
    };

    if (layout === 'SECTION') {
      const subtitle = clean(record.subtitle, OUTLINE_LIMITS.section.maxSubtitleChars);
      slides.push({ title: slideTitle, bullets: [], layout: 'SECTION', ...(subtitle ? { subtitle } : {}), ...withNotes });
    } else if (layout === 'QUOTE') {
      const quote = clean(record.quote, OUTLINE_LIMITS.quote.maxChars);
      if (!quote) { demote('QUOTE_INVALID'); } else {
        const attribution = clean(record.attribution, OUTLINE_LIMITS.quote.maxAttributionChars);
        slides.push({ title: slideTitle, bullets, layout: 'QUOTE', quote, ...(attribution ? { attribution } : {}), ...withNotes });
      }
    } else if (layout === 'CHART') {
      const chart = parseChart(record.chart);
      if (!chart || bullets.length === 0) { demote('CHART_INVALID'); } else slides.push({ title: slideTitle, bullets, layout: 'CHART', chart, ...withNotes });
    } else if (layout === 'METRICS') {
      const metrics = parseMetrics(record.metrics);
      if (!metrics || bullets.length === 0) { demote('METRICS_INVALID'); } else slides.push({ title: slideTitle, bullets, layout: 'METRICS', metrics, ...withNotes });
    } else if (layout === 'TABLE') {
      const table = parseTable(record.table);
      if (!table || bullets.length === 0) { demote('TABLE_INVALID'); } else slides.push({ title: slideTitle, bullets, layout: 'TABLE', table, ...withNotes });
    } else if (layout === 'IMAGE') {
      const image = parseImage(record.image, slideTitle);
      if (!image || bullets.length === 0) { demote('IMAGE_INVALID'); } else slides.push({ title: slideTitle, bullets, layout: 'IMAGE', image, ...withNotes });
    } else {
      if (bullets.length === 0) continue; // a slide without a title or without any content is dropped, never invented
      // a slide whose every line only says that information is missing ("withheld", "[TBD]") has nothing to show: it is left out, and the person is told which one
      if (saysNothingYet(bullets)) { demotions.push({ slide: slides.length + 1, layout: 'BULLETS', code: 'PLACEHOLDER_ONLY' }); continue; }
      slides.push({ title: slideTitle, bullets, ...withNotes });
    }
    if (slides.length >= limit) break;
  }
  if (slides.filter((slide) => slide.layout !== 'SECTION').length < minimum) {
    throw new NagexError({ code: 'EMPTY_GENERATION', category: 'PROVIDER', message: 'The model did not return enough usable slides for a presentation.', request_id: requestId });
  }
  return { title, subtitle: clean(parsed.subtitle, OUTLINE_LIMITS.maxSubtitleChars), slides, ...(demotions.length ? { demotions } : {}) };
}

const layoutOf = (slide: PresentationOutlineSlide): OutlineLayout => slide.layout ?? 'BULLETS';
const cell = (text: string) => text.replace(/\|/g, '\\|');

/** Markdown preview of an outline (what the Main result panel and the artifact preview show). A plain deck reads exactly as it always did; a visual slide prints its data as text. */
export function outlineToMarkdown(outline: PresentationOutline): string {
  const lines = [`# ${outline.title}`];
  if (outline.subtitle) lines.push('', `_${outline.subtitle}_`);
  outline.slides.forEach((slide, index) => {
    lines.push('', `## ${index + 1}. ${slide.title}`);
    const layout = layoutOf(slide);
    if (layout === 'SECTION' && slide.subtitle) lines.push(`_${slide.subtitle}_`);
    if (layout === 'QUOTE' && slide.quote) lines.push(`> “${slide.quote}”${slide.attribution ? ` — ${slide.attribution}` : ''}`);
    if (layout === 'CHART' && slide.chart) {
      const chart = slide.chart;
      const kind = chart.type === 'BAR' ? 'bar' : chart.type === 'LINE' ? 'line' : 'pie';
      lines.push(`_Chart (${kind}${chart.unit ? `, ${chart.unit}` : ''})_`, '', `| | ${chart.series.map((s) => cell(s.name)).join(' | ')} |`, `| --- | ${chart.series.map(() => '---').join(' | ')} |`, ...chart.categories.map((c, i) => `| ${cell(c)} | ${chart.series.map((s) => s.values[i]).join(' | ')} |`), '');
      if (chart.sourceNote) lines.push(`_${chart.sourceNote}_`);
    }
    if (layout === 'METRICS' && slide.metrics) lines.push(slide.metrics.map((m) => `**${m.value}** ${m.label}${m.note ? ` (${m.note})` : ''}`).join(' · '), '');
    if (layout === 'TABLE' && slide.table) lines.push(`| ${slide.table.headers.map(cell).join(' | ')} |`, `| ${slide.table.headers.map(() => '---').join(' | ')} |`, ...slide.table.rows.map((r) => `| ${r.map(cell).join(' | ')} |`), '');
    if (layout === 'IMAGE' && slide.image) lines.push(`_Picture: ${slide.image.alt}${slide.image.caption ? ` — ${slide.image.caption}` : ''}_`, '');
    lines.push(...slide.bullets.map((bullet) => `- ${bullet}`));
    if (slide.notes) lines.push('', `_Notes: ${slide.notes}_`);
  });
  return lines.join('\n');
}

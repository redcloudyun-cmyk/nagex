// Are the NUMBERS of a chart, a table or a key-figure card the person's, or invented? A deck with an invented number is worse than a deck without a chart: it looks like evidence.
//
// The rule is mechanical and conservative: every figure a visual states - a chart value, a numeric table cell, a number in a key-figure value - must appear, as the same number, in what the person gave
// NAgex (the request, the instructions, the source documents, their remembered context). A slide whose numbers are not all found is DEMOTED to its takeaways (text) and the demotion is recorded; the
// deck is never padded with a plausible figure. Labels (a category named "1분기", a column header) are not figures and are not checked. It cannot tell that a figure is attached to the right thing -
// only that it is not out of thin air; the person reviews the deck, and the evidence says so.
import { isNumericCell } from '../docx/docx-writer.js';
import type { OutlineDemotion, PresentationOutline, PresentationOutlineSlide } from '../../model-gateway/presentation-outline.js';

const NUMBER_TOKEN = /\d[\d,]*(?:\.\d+)?/g;

/** 1,200 -> "1200"; 12.50 -> "12.5"; 007 -> "7". The comparison is on the number, not on how it was written. */
function canonical(token: string): string | null {
  const value = Number(token.replace(/,/g, ''));
  return Number.isFinite(value) ? String(value) : null;
}

export function numbersIn(text: string): string[] {
  const out: string[] = [];
  for (const match of String(text).matchAll(NUMBER_TOKEN)) { const c = canonical(match[0]); if (c !== null) out.push(c); }
  return out;
}

export function groundingCorpus(...texts: Array<string | undefined | null>): Set<string> {
  const known = new Set<string>();
  for (const text of texts) for (const n of numbersIn(text ?? '')) known.add(n);
  return known;
}

const allKnown = (numbers: string[], known: Set<string>): boolean => numbers.every((n) => known.has(n));

/** The figures a slide states (chart values, numeric table cells, numbers in key-figure values), as canonical strings. */
export function statedFigures(slide: PresentationOutlineSlide): string[] {
  const figures: string[] = [];
  if (slide.chart) for (const series of slide.chart.series) for (const v of series.values) { const c = canonical(String(v)); if (c !== null) figures.push(c); }
  if (slide.metrics) for (const metric of slide.metrics) figures.push(...numbersIn(metric.value));
  if (slide.table) for (const row of slide.table.rows) for (const value of row) if (isNumericCell(value)) figures.push(...numbersIn(value));
  return figures;
}

export interface GroundingResult { outline: PresentationOutline; demotions: OutlineDemotion[] }

/**
 * Demotes every visual slide whose figures are not all in the corpus. A slide that states no figure (a picture, a quote, a table of words) is untouched.
 * Returns a new outline; the input is not changed.
 */
export function groundOutline(outline: PresentationOutline, known: Set<string>): GroundingResult {
  const demotions: OutlineDemotion[] = [];
  const slides = outline.slides.map((slide, index): PresentationOutlineSlide => {
    const layout = slide.layout ?? 'BULLETS';
    if (layout !== 'CHART' && layout !== 'METRICS' && layout !== 'TABLE') return slide;
    if (allKnown(statedFigures(slide), known)) return slide;
    demotions.push({ slide: index + 1, layout, code: 'UNGROUNDED_NUMBERS' });
    const { chart: _chart, metrics: _metrics, table: _table, layout: _layout, ...rest } = slide;
    return rest;
  });
  return { outline: { ...outline, slides, ...(demotions.length || outline.demotions?.length ? { demotions: [...(outline.demotions ?? []), ...demotions] } : {}) }, demotions };
}

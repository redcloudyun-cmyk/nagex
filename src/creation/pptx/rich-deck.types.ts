// What a deck is, once the model has planned it and NAgex has checked the plan: slides with a LAYOUT (bullets, a native chart, key figures, a table, a picture beside text, a quote, a section break),
// a takeaway on every visual slide, speaker notes, and the sources the deck rests on. This is the input of the rich deck writer (rich-deck-writer.ts); it carries no provider detail and no HTML.

export type RichChartKind = 'BAR' | 'LINE' | 'PIE';

export interface RichChart {
  type: RichChartKind;
  categories: string[];
  /** one or more series; every series has exactly one value per category */
  series: Array<{ name: string; values: number[] }>;
  /** shown with the values ("%", "원", "명"): informational only, never converted */
  unit?: string;
  /** where the numbers come from, shown small under the chart ("출처: 2026년 3분기 운영 보고서") */
  sourceNote?: string;
}

export interface RichMetric { label: string; value: string; note?: string }
export interface RichTable { headers: string[]; rows: string[][] }
export interface RichImage {
  bytes: Buffer;
  alt: string;
  caption?: string;
}

interface SlideBase {
  title: string;
  /** the takeaway(s) of a visual slide, or the bullets of a text slide. Every slide has at least one line of text beside its visual, so the deck reads without the picture. */
  bullets: string[];
  /** what the presenter says; never shown on the slide */
  notes?: string;
}

export type RichSlide =
  | (SlideBase & { layout: 'BULLETS' })
  | (SlideBase & { layout: 'CHART'; chart: RichChart })
  | (SlideBase & { layout: 'METRICS'; metrics: RichMetric[] })
  | (SlideBase & { layout: 'TABLE'; table: RichTable })
  | (SlideBase & { layout: 'IMAGE'; image: RichImage })
  | (SlideBase & { layout: 'QUOTE'; quote: string; attribution?: string })
  | (SlideBase & { layout: 'SECTION'; subtitle?: string });

export interface RichDeck {
  title: string;
  subtitle?: string;
  locale: 'en' | 'ko';
  slides: RichSlide[];
  /** titles (or addresses) of what the deck was made from. Listed on the cover's speaker notes; on a closing slide only when `sourcesSlide` is set (a closing slide is one more slide than was asked for). */
  sources?: string[];
  sourcesSlide?: boolean;
}

/** Facts about what the writer did, per slide - for the result, the audit trail and the quality evaluation. Nothing here is a claim about how the deck looks. */
export interface SlideBuildFact {
  index: number;
  layout: RichSlide['layout'] | 'COVER' | 'SOURCES';
  title: string;
  /** the font size chosen for the main text, when the writer chose one */
  fontPt?: number;
  /** the estimate said the text does not fit even at the smallest size: the slide needs shortening (the text is never hidden) */
  tightFit?: boolean;
  /** this slide continues the previous one (a long table is split across slides, the header row repeats) */
  continuation?: boolean;
  hasNotes: boolean;
}
export interface DeckBuildReport {
  slideCount: number;
  slides: SlideBuildFact[];
  charts: number;
  tables: number;
  images: number;
  notes: number;
}

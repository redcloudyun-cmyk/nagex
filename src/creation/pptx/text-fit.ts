// Choosing a font size so that text FITS its box. PowerPoint applies <a:normAutofit/> only when the text is edited, so a freshly opened deck would show overflow: the writer picks the size itself, from
// an estimate of how the text wraps (measured against real PowerPoint in docs/evidence/NAGEX_PPTX_RENDER_EVIDENCE_20261013.md and NAGEX_OUTCOME_QUALITY_20261017.md). It is an estimate from
// character widths, not a font-metrics layout - which is why the real-application check (scripts/office-render.ps1) reads BoundHeight back from PowerPoint.

/** Width of one character in units of the font size: full-width (Hangul, CJK, emoji) ~1.0, other characters ~0.55, a space ~0.3. */
export function textUnits(text: string): number {
  let units = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    const wide = (c >= 0x1100 && c <= 0x11ff) || (c >= 0x2e80 && c <= 0xd7ff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef) || c >= 0x1f300;
    units += wide ? 1 : c === 32 ? 0.3 : 0.55;
  }
  return units;
}

export const wrappedLines = (text: string, sizePt: number, widthPt: number): number => Math.max(1, Math.ceil((textUnits(text) * sizePt) / Math.max(1, widthPt)));

export interface FitOptions {
  widthPt: number;
  heightPt: number;
  maxPt: number;
  minPt: number;
  /** line height as a multiple of the font size (default 1.2) */
  lineHeight?: number;
  /** space between paragraphs, in points (default 0) */
  gapPt?: number;
}
export interface FitResult {
  sizePt: number;
  /** false when even the smallest size does not fit: the caller must shorten, split or say so - the text is never hidden here */
  fits: boolean;
  /** the estimated height of the text at sizePt */
  heightPt: number;
  lines: number;
}

export function textHeight(paragraphs: string[], sizePt: number, widthPt: number, lineHeight = 1.2, gapPt = 0): { heightPt: number; lines: number } {
  const lines = paragraphs.reduce((sum, text) => sum + wrappedLines(text, sizePt, widthPt), 0);
  return { lines, heightPt: lines * sizePt * lineHeight + Math.max(0, paragraphs.length - 1) * gapPt };
}

/** The largest whole-point size in [minPt, maxPt] at which the paragraphs fit the box. */
export function fitParagraphs(paragraphs: string[], options: FitOptions): FitResult {
  const lineHeight = options.lineHeight ?? 1.2;
  const gap = options.gapPt ?? 0;
  for (let size = Math.floor(options.maxPt); size >= Math.ceil(options.minPt); size -= 1) {
    const { heightPt, lines } = textHeight(paragraphs, size, options.widthPt, lineHeight, gap);
    if (heightPt <= options.heightPt) return { sizePt: size, fits: true, heightPt, lines };
  }
  const { heightPt, lines } = textHeight(paragraphs, options.minPt, options.widthPt, lineHeight, gap);
  return { sizePt: options.minPt, fits: false, heightPt, lines };
}

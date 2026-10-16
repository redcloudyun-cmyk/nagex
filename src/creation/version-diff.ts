// What changed between two versions of a document or a deck - computed by NAgex from the stored text, never by a model and never by guessing.
//   - a document is compared line by line (longest common subsequence), so a paragraph added in the middle is ONE addition and not "everything after it changed"; unchanged stretches are folded;
//   - a deck is compared slide by slide: slides are matched by their titles first (so a slide added in the middle is one added slide, the others stay "unchanged"), then bullets are compared inside a pair.
// Pure and deterministic. Inputs that are too large to compare line by line are reported as such, never silently truncated.
import type { PresentationOutlineSlide } from '../model-gateway/presentation-outline.js';

export type DiffKind = 'same' | 'added' | 'removed';

export interface DiffLine {
  kind: DiffKind;
  text: string;
}

export interface DocumentDiff {
  /** the compared lines, long unchanged stretches folded into one `fold` marker */
  lines: Array<DiffLine | { kind: 'fold'; hidden: number }>;
  stats: { added: number; removed: number; unchanged: number };
  identical: boolean;
  /** true when the texts were too large to compare line by line (stats only) */
  tooLarge: boolean;
}

const MAX_CELLS = 4_000_000;
const CONTEXT_LINES = 2;

const normalize = (text: string): string[] => String(text).replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+$/g, ''));

/** Line diff of two Markdown / plain texts. */
export function diffText(before: string, after: string): DocumentDiff {
  const a = normalize(before);
  const b = normalize(after);
  const identical = a.length === b.length && a.every((line, i) => line === b[i]);
  if (identical) return { lines: [{ kind: 'fold', hidden: a.length }], stats: { added: 0, removed: 0, unchanged: a.length }, identical: true, tooLarge: false };
  if (a.length * b.length > MAX_CELLS) {
    return { lines: [], stats: { added: b.length, removed: a.length, unchanged: 0 }, identical: false, tooLarge: true };
  }
  // longest common subsequence table, rolled back into an edit script
  const rows = a.length + 1;
  const cols = b.length + 1;
  const lcs = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i * cols + j] = a[i] === b[j] ? lcs[(i + 1) * cols + j + 1] + 1 : Math.max(lcs[(i + 1) * cols + j], lcs[i * cols + j + 1]);
    }
  }
  const script: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { script.push({ kind: 'same', text: a[i] }); i += 1; j += 1; }
    else if (lcs[(i + 1) * cols + j] >= lcs[i * cols + j + 1]) { script.push({ kind: 'removed', text: a[i] }); i += 1; }
    else { script.push({ kind: 'added', text: b[j] }); j += 1; }
  }
  while (i < a.length) { script.push({ kind: 'removed', text: a[i] }); i += 1; }
  while (j < b.length) { script.push({ kind: 'added', text: b[j] }); j += 1; }

  const stats = { added: 0, removed: 0, unchanged: 0 };
  for (const line of script) { if (line.kind === 'added') stats.added += 1; else if (line.kind === 'removed') stats.removed += 1; else stats.unchanged += 1; }

  // fold long unchanged stretches, keeping a little context around each change
  const keep = new Array<boolean>(script.length).fill(false);
  script.forEach((line, index) => {
    if (line.kind === 'same') return;
    for (let k = Math.max(0, index - CONTEXT_LINES); k <= Math.min(script.length - 1, index + CONTEXT_LINES); k += 1) keep[k] = true;
  });
  const lines: DocumentDiff['lines'] = [];
  for (let index = 0; index < script.length; index += 1) {
    if (keep[index]) { lines.push(script[index]); continue; }
    let end = index;
    while (end < script.length && !keep[end]) end += 1;
    lines.push({ kind: 'fold', hidden: end - index });
    index = end - 1;
  }
  return { lines, stats, identical: false, tooLarge: false };
}

// ---- decks -----------------------------------------------------------------------------------------------------------------------------------------------------

export type SlideChange = 'unchanged' | 'changed' | 'added' | 'removed';

export interface SlideDiff {
  change: SlideChange;
  /** position in the older / newer deck (1-based, content slides; the title slide is not counted) */
  fromIndex?: number;
  toIndex?: number;
  fromTitle?: string;
  toTitle?: string;
  bullets: Array<{ kind: DiffKind; text: string }>;
}

export interface DeckDiff {
  slides: SlideDiff[];
  stats: { added: number; removed: number; changed: number; unchanged: number };
  titleChanged: { from: string; to: string } | null;
  identical: boolean;
}

const key = (slide: PresentationOutlineSlide): string => String(slide.title || '').replace(/\s+/g, ' ').trim().toLowerCase();

function bulletDiff(a: string[], b: string[]): SlideDiff['bullets'] {
  const out: SlideDiff['bullets'] = [];
  const after = new Set(b);
  const before = new Set(a);
  for (const text of a) out.push({ kind: after.has(text) ? 'same' : 'removed', text });
  for (const text of b) if (!before.has(text)) out.push({ kind: 'added', text });
  return out;
}

export function diffDecks(before: { title: string; slides: PresentationOutlineSlide[] }, after: { title: string; slides: PresentationOutlineSlide[] }): DeckDiff {
  const a = before.slides;
  const b = after.slides;
  // slides are matched by title with a longest common subsequence: one slide inserted in the middle is one added slide
  const rows = a.length + 1;
  const cols = b.length + 1;
  const lcs = new Uint16Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i * cols + j] = key(a[i]) === key(b[j]) ? lcs[(i + 1) * cols + j + 1] + 1 : Math.max(lcs[(i + 1) * cols + j], lcs[i * cols + j + 1]);
    }
  }
  const slides: SlideDiff[] = [];
  let i = 0;
  let j = 0;
  const pairBullets = (x: PresentationOutlineSlide, y: PresentationOutlineSlide) => bulletDiff(x.bullets ?? [], y.bullets ?? []);
  while (i < a.length && j < b.length) {
    if (key(a[i]) === key(b[j])) {
      const bullets = pairBullets(a[i], b[j]);
      const changed = bullets.some((bl) => bl.kind !== 'same');
      slides.push({ change: changed ? 'changed' : 'unchanged', fromIndex: i + 1, toIndex: j + 1, fromTitle: a[i].title, toTitle: b[j].title, bullets });
      i += 1; j += 1;
    } else if (lcs[(i + 1) * cols + j] >= lcs[i * cols + j + 1]) {
      slides.push({ change: 'removed', fromIndex: i + 1, fromTitle: a[i].title, bullets: (a[i].bullets ?? []).map((text) => ({ kind: 'removed' as const, text })) });
      i += 1;
    } else {
      slides.push({ change: 'added', toIndex: j + 1, toTitle: b[j].title, bullets: (b[j].bullets ?? []).map((text) => ({ kind: 'added' as const, text })) });
      j += 1;
    }
  }
  while (i < a.length) { slides.push({ change: 'removed', fromIndex: i + 1, fromTitle: a[i].title, bullets: (a[i].bullets ?? []).map((text) => ({ kind: 'removed' as const, text })) }); i += 1; }
  while (j < b.length) { slides.push({ change: 'added', toIndex: j + 1, toTitle: b[j].title, bullets: (b[j].bullets ?? []).map((text) => ({ kind: 'added' as const, text })) }); j += 1; }
  const stats = { added: 0, removed: 0, changed: 0, unchanged: 0 };
  for (const s of slides) stats[s.change] += 1;
  const titleChanged = before.title.trim() !== after.title.trim() ? { from: before.title, to: after.title } : null;
  return { slides, stats, titleChanged, identical: !titleChanged && stats.added === 0 && stats.removed === 0 && stats.changed === 0 };
}

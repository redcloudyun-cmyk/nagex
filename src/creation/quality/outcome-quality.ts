// Outcome Quality for office files: is the .docx / .pptx NAgex produced actually GOOD, judged by facts and not by the fact that a file exists?
//
// Three separate answers, never merged:
//   TECHNICAL  - the file is a valid package and (when measured) opens in the real application. "A file exists" is not quality.
//   QUALITY    - automated checks of structure, accuracy, layout, accessibility and editability. All of them are facts about the file or measurements from the real application. A QUALITY PASS
//                here is NOT a claim that the content is good prose or that a person would like the design: that is human review (reported separately, never faked).
//   GOAL       - not decided here. Whether the person's goal was met is the person's call; this report only says what a reviewer should look at.
//
// Every check is PASS, FAIL or NOT_RUN. A check that needs the real application (scripts/office-render.ps1) is NOT_RUN without its measurements - never silently PASS. Numbers are held to the same rule as
// the product: a figure that states something (a percentage, an amount, a count with a unit) must be one the person gave; a figure from nowhere is a FAIL, whoever wrote it.
import { readZip } from '../pptx/zip-writer.js';
import { groundingCorpus, numbersIn } from '../pptx/number-grounding.js';
import { placeholdersIn } from '../placeholder-text.js';

export { placeholdersIn };

export type CheckStatus = 'PASS' | 'FAIL' | 'NOT_RUN';

/** a verdict over several checks: PASS only when every one ran and passed; PARTIAL when the ones that ran passed but some could not run; FAIL when any failed */
export type Verdict = 'PASS' | 'PARTIAL' | 'FAIL' | 'NOT_RUN';
export interface QualityCheck { id: string; kind: 'TECHNICAL' | 'QUALITY'; status: CheckStatus; detail: string }
export interface QualityReport {
  artifact: 'DOCX' | 'PPTX' | 'IMAGE' | 'VIDEO';
  technical: Verdict;
  quality: Verdict;
  checks: QualityCheck[];
  stats: Record<string, number | string>;
}

/** What the person gave and expects back. Everything is optional: a check without its expectation is not run. */
export interface Expectation {
  /** all the text the person supplied (request, data, source documents): the only place a stated figure may come from */
  corpus: string;
  /** facts that must be present, each by a distinctive string (a number with its unit, a name) */
  requiredFacts?: Array<{ id: string; text: string }>;
  /** a chart the deck must contain, with its exact data */
  charts?: Array<{ categories: string[]; values: number[] }>;
  /** at least this many pictures / native charts must be in the file (a request that asked for them) */
  minPictures?: number;
  minCharts?: number;
  /** the smallest share of content slides that carry speaker notes (default 0.8) */
  minNotesShare?: number;
  /** a slide with more words than this is too dense to read from a distance (default 90) */
  maxWordsPerSlide?: number;
  /** how many pages / slides are acceptable (inclusive) */
  pages?: { min: number; max: number };
}

// ── what real Word / PowerPoint measured (scripts/office-render.ps1 -> facts.json) ───────────────────────────────────────────────────────────────
export interface WordFacts {
  opened: boolean; renderedBy?: string; compatibilityMode?: number; pages?: number;
  page?: { textWidthPt?: number };
  footer?: { pageNumberFields?: number };
  tables?: Array<{ fitsTextWidth: boolean; headingRowRepeats: boolean }>;
  inlineShapes?: Array<{ fitsTextWidth: boolean; altText: string }>;
  fonts?: Record<string, number>;
  outline?: Array<{ level: number; text: string }>;
  editRoundTrip?: { saved?: boolean; reopened?: boolean; editSurvived?: boolean };
  problems?: string[];
}
export interface PowerPointShapeFacts {
  name: string; type: number; insideSlide: boolean; hasText?: boolean; text?: string; minFontPt?: number; maxFontPt?: number; textOverflows?: boolean;
  fontNames?: string[]; isPicture?: boolean; altText?: string; hasChart?: boolean;
  chart?: { series: Array<{ name: string; values: number[]; categories: string[] }> }; table?: { cells: string[] };
}
export interface PowerPointFacts {
  opened: boolean; renderedBy?: string; slideCount?: number; slideSize?: { ratio: number };
  slides?: Array<{ index: number; title: string; notes: string; shapes: PowerPointShapeFacts[] }>;
  editRoundTrip?: { saved?: boolean; reopened?: boolean; editSurvived?: boolean };
  problems?: string[];
}

// ── helpers ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const normalize = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** balanced, properly nested tags - enough to catch an unescaped character or a forgotten close tag */
export function isWellFormed(xml: string): boolean {
  const stack: string[] = [];
  for (const m of xml.replace(/<\?xml[^>]*\?>/, '').replace(/<!--[\s\S]*?-->/g, '').matchAll(/<(\/?)([A-Za-z][\w:.-]*)([^<>]*?)(\/?)>/g)) {
    const [, closing, tag, , selfClosing] = m;
    if (selfClosing) continue;
    if (closing) { if (stack.pop() !== tag) return false; } else stack.push(tag);
  }
  return stack.length === 0;
}

function packageProblems(bytes: Buffer): { problems: string[]; names: string[]; parts: Map<string, Buffer> } {
  const problems: string[] = [];
  let entries: ReturnType<typeof readZip> = [];
  try { entries = readZip(bytes); } catch (error) { return { problems: [`not a readable zip: ${(error as Error).message}`], names: [], parts: new Map() }; }
  const parts = new Map(entries.map((e) => [e.name, e.data] as const));
  const names = entries.map((e) => e.name);
  for (const name of names) {
    if (/\.(xml|rels)$/.test(name) && !name.endsWith('/')) {
      const xml = parts.get(name)!.toString('utf8');
      if (!isWellFormed(xml)) problems.push(`${name} is not well-formed XML`);
    }
  }
  const types = parts.get('[Content_Types].xml')?.toString('utf8') ?? '';
  if (!types) problems.push('[Content_Types].xml is missing');
  for (const override of types.matchAll(/PartName="([^"]+)"/g)) if (!parts.has(override[1].replace(/^\//, ''))) problems.push(`content type for a missing part: ${override[1]}`);
  // every internal relationship target exists
  for (const name of names.filter((n) => n.endsWith('.rels'))) {
    const base = name.replace(/_rels\/[^/]*\.rels$/, ''); // the folder of the part the relationships belong to ('' for the package root)
    for (const rel of (parts.get(name)!.toString('utf8')).matchAll(/<Relationship [^>]*>/g)) {
      if (/TargetMode="External"/.test(rel[0])) continue;
      const target = /Target="([^"]+)"/.exec(rel[0])?.[1];
      if (!target) continue;
      const resolved = target.startsWith('/') ? target.slice(1) : normalizePath(base + target);
      if (!parts.has(resolved)) problems.push(`${name}: relationship target missing: ${target}`);
    }
  }
  return { problems, names, parts };
}
function normalizePath(path: string): string {
  const out: string[] = [];
  for (const segment of path.split('/')) { if (segment === '..') out.pop(); else if (segment && segment !== '.') out.push(segment); }
  return out.join('/');
}

// a figure that STATES something: a percentage, an amount, a count with a unit, a large plain number. Ordinals ("3단계"), years and list numbers are not statistics.
const UNIT = '%|원|만원|억|조|명|건|분|시간|일|주|개월|달러|배|위|점|kg|km|GB|MB|ms|초';
const STAT_LIKE = new RegExp(`(\\d[\\d,]*(?:\\.\\d+)?)\\s?(?:${UNIT})`, 'g');
export function statLikeNumbers(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(STAT_LIKE)) { const n = numbersIn(match[1]); if (n[0]) found.add(n[0]); }
  for (const token of numbersIn(text)) { const value = Number(token); if (value >= 10000 && !(value >= 1900 && value <= 2100)) found.add(token); }
  return [...found];
}

const check = (id: string, kind: QualityCheck['kind'], status: CheckStatus, detail: string): QualityCheck => ({ id, kind, status, detail });
function verdict(checks: QualityCheck[], kind: QualityCheck['kind']): Verdict {
  const own = checks.filter((c) => c.kind === kind);
  if (own.some((c) => c.status === 'FAIL')) return 'FAIL';
  if (own.length > 0 && own.every((c) => c.status === 'NOT_RUN')) return 'NOT_RUN';
  return own.some((c) => c.status === 'NOT_RUN') ? 'PARTIAL' : 'PASS';
}

function factChecks(text: string, expectation: Expectation): QualityCheck[] {
  const haystack = normalize(text);
  const checks: QualityCheck[] = [];
  const placeholders = placeholdersIn(text);
  checks.push(check('NO_PLACEHOLDER_TEXT', 'QUALITY', placeholders.length ? 'FAIL' : 'PASS', placeholders.length ? `says that content is missing: ${placeholders.slice(0, 6).join(' | ')}` : 'no placeholder or "withheld" text'));
  const missing = (expectation.requiredFacts ?? []).filter((f) => !haystack.includes(normalize(f.text)));
  if (expectation.requiredFacts?.length) checks.push(check('REQUIRED_FACTS_PRESENT', 'QUALITY', missing.length ? 'FAIL' : 'PASS', missing.length ? `missing: ${missing.map((f) => f.id).join(', ')}` : `${expectation.requiredFacts.length} of ${expectation.requiredFacts.length} present`));
  const known = groundingCorpus(expectation.corpus);
  const invented = statLikeNumbers(text).filter((n) => !known.has(n));
  checks.push(check('NO_INVENTED_FIGURES', 'QUALITY', invented.length ? 'FAIL' : 'PASS', invented.length ? `figures not in what the person gave: ${invented.slice(0, 12).join(', ')}` : 'every stated figure is in what the person gave'));
  return checks;
}

// ── DOCX ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export function docxText(parts: Map<string, Buffer>): string {
  const xml = parts.get('word/document.xml')?.toString('utf8') ?? '';
  return decode(xml.replace(/<\/w:p>/g, '\n').replace(/<w:tab\/>/g, ' ').replace(/<[^>]+>/g, ''));
}

export function evaluateDocx(bytes: Buffer, expectation: Expectation, word?: WordFacts): QualityReport {
  const checks: QualityCheck[] = [];
  const pkg = packageProblems(bytes);
  checks.push(check('PACKAGE_VALID', 'TECHNICAL', pkg.problems.length || !pkg.parts.has('word/document.xml') ? 'FAIL' : 'PASS', pkg.problems.slice(0, 5).join('; ') || 'zip, XML, content types and relationships are consistent'));
  const doc = pkg.parts.get('word/document.xml')?.toString('utf8') ?? '';
  const text = docxText(pkg.parts);
  const headings = [...doc.matchAll(/<w:pStyle w:val="Heading(\d)"\/>/g)].map((m) => Number(m[1]));
  const words = text.split(/\s+/).filter(Boolean).length;

  // structure
  checks.push(check('HAS_TITLE', 'QUALITY', /<w:pStyle w:val="Title"\/>/.test(doc) ? 'PASS' : 'FAIL', 'a Title paragraph'));
  const skips = headings.filter((level, i) => i > 0 && level > headings[i - 1] + 1);
  checks.push(check('HEADINGS_ARE_REAL_AND_ORDERED', 'QUALITY', words > 250 && headings.length === 0 ? 'FAIL' : skips.length ? 'FAIL' : 'PASS', words > 250 && headings.length === 0 ? `${words} words and no heading styles` : skips.length ? `a heading level is skipped ${skips.length}x` : `${headings.length} real heading(s), no skipped level`));
  const tables = (doc.match(/<w:tbl>/g) ?? []).length;
  const headerRows = (doc.match(/<w:tblHeader\/>/g) ?? []).length;
  checks.push(check('TABLES_HAVE_HEADER_ROWS', 'QUALITY', tables === 0 ? 'PASS' : headerRows >= tables ? 'PASS' : 'FAIL', `${tables} table(s), ${headerRows} header row(s)`));
  const pictures = (doc.match(/<w:drawing>/g) ?? []).length;
  const withAlt = [...doc.matchAll(/<wp:docPr [^>]*descr="([^"]*)"/g)].filter((m) => m[1].trim()).length;
  checks.push(check('PICTURES_HAVE_ALT_TEXT', 'QUALITY', pictures === 0 ? 'PASS' : withAlt >= pictures ? 'PASS' : 'FAIL', `${pictures} picture(s), ${withAlt} with alt text`));
  const unavailable = (text.match(/그림을 표시할 수 없습니다|Picture unavailable/g) ?? []).length;
  if (expectation.minPictures) checks.push(check('PICTURES_PRESENT', 'QUALITY', pictures >= expectation.minPictures ? 'PASS' : 'FAIL', `${pictures} picture(s) in the file, ${expectation.minPictures} expected`));
  checks.push(check('NO_MISSING_PICTURES', 'QUALITY', unavailable ? 'FAIL' : 'PASS', unavailable ? `${unavailable} picture(s) could not be shown` : 'every referenced picture is in the file'));
  checks.push(check('FOOTER_PAGE_NUMBERS', 'QUALITY', pkg.parts.get('word/footer1.xml')?.toString('utf8').includes('NUMPAGES') ? 'PASS' : 'FAIL', 'page / pages field in the footer'));
  checks.push(check('MODERN_COMPATIBILITY_SETTING', 'QUALITY', /compatibilityMode"[^>]*w:val="15"/.test(pkg.parts.get('word/settings.xml')?.toString('utf8') ?? '') ? 'PASS' : 'FAIL', 'compatibility mode 15 declared'));
  checks.push(...factChecks(text, expectation));

  // what real Word measured
  if (!word) {
    for (const id of ['OPENS_IN_WORD', 'NOT_COMPATIBILITY_MODE', 'PAGE_COUNT_IN_RANGE', 'TABLES_FIT_THE_PAGE', 'PICTURES_FIT_THE_PAGE', 'FOOTER_FIELDS_LIVE', 'FONTS_CONSISTENT', 'EDIT_AND_SAVE_SURVIVES']) checks.push(check(id, id === 'OPENS_IN_WORD' ? 'TECHNICAL' : 'QUALITY', 'NOT_RUN', 'needs Microsoft Word (scripts/office-render.ps1)'));
  } else {
    checks.push(check('OPENS_IN_WORD', 'TECHNICAL', word.opened && !(word.problems ?? []).length ? 'PASS' : 'FAIL', `${word.renderedBy ?? 'Word'}${(word.problems ?? []).length ? `: ${(word.problems ?? []).join('; ')}` : ''}`));
    checks.push(check('NOT_COMPATIBILITY_MODE', 'QUALITY', (word.compatibilityMode ?? 0) >= 15 ? 'PASS' : 'FAIL', `compatibility mode ${word.compatibilityMode}`));
    if (expectation.pages) checks.push(check('PAGE_COUNT_IN_RANGE', 'QUALITY', (word.pages ?? 0) >= expectation.pages.min && (word.pages ?? 0) <= expectation.pages.max ? 'PASS' : 'FAIL', `${word.pages} page(s), expected ${expectation.pages.min}-${expectation.pages.max}`));
    else checks.push(check('PAGE_COUNT_IN_RANGE', 'QUALITY', 'NOT_RUN', 'no page range was expected'));
    const badTables = (word.tables ?? []).filter((t) => !t.fitsTextWidth).length;
    checks.push(check('TABLES_FIT_THE_PAGE', 'QUALITY', badTables ? 'FAIL' : 'PASS', `${(word.tables ?? []).length} table(s), ${badTables} wider than the text`));
    const badPics = (word.inlineShapes ?? []).filter((p) => !p.fitsTextWidth).length;
    checks.push(check('PICTURES_FIT_THE_PAGE', 'QUALITY', badPics ? 'FAIL' : 'PASS', `${(word.inlineShapes ?? []).length} picture(s), ${badPics} wider than the text`));
    checks.push(check('FOOTER_FIELDS_LIVE', 'QUALITY', (word.footer?.pageNumberFields ?? 0) >= 2 ? 'PASS' : 'FAIL', `${word.footer?.pageNumberFields ?? 0} field(s) in the footer`));
    const fonts = Object.keys(word.fonts ?? {});
    checks.push(check('FONTS_CONSISTENT', 'QUALITY', fonts.length <= 3 ? 'PASS' : 'FAIL', `${fonts.length} font family(ies): ${fonts.join(', ')}`));
    const edit = word.editRoundTrip;
    checks.push(check('EDIT_AND_SAVE_SURVIVES', 'QUALITY', edit?.saved && edit.reopened && edit.editSurvived ? 'PASS' : 'FAIL', 'opened for editing, a paragraph added, saved, reopened, the edit read back'));
  }
  return { artifact: 'DOCX', technical: verdict(checks, 'TECHNICAL'), quality: verdict(checks, 'QUALITY'), checks, stats: { words, headings: headings.length, tables, pictures, pages: word?.pages ?? 'not measured' } };
}

// ── PPTX ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function pptxTexts(parts: Map<string, Buffer>, names: string[]): { slideText: string[]; notes: string[]; all: string } {
  const slideNames = names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => Number(/(\d+)/.exec(a)![1]) - Number(/(\d+)/.exec(b)![1]));
  const text = (xml: string) => decode([...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join(' '));
  const slideText = slideNames.map((n) => text(parts.get(n)!.toString('utf8')));
  // a notes page also holds the slide image and the slide number: only the body placeholder is what the presenter wrote
  const notesBody = (xml: string) => text([...xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].map((m) => m[0]).filter((shape) => /<p:ph[^>]*type="body"/.test(shape.replace(/\s+/g, ' '))).join(' ')).trim();
  const notes = names.filter((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n)).map((n) => notesBody(parts.get(n)!.toString('utf8'))).filter(Boolean);
  const charts = names.filter((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n)).map((n) => decode([...parts.get(n)!.toString('utf8').matchAll(/<c:v>([^<]*)<\/c:v>/g)].map((m) => m[1]).join(' ')));
  return { slideText, notes, all: [...slideText, ...notes, ...charts].join('\n') };
}

export function evaluatePptx(bytes: Buffer, expectation: Expectation, ppt?: PowerPointFacts): QualityReport {
  const checks: QualityCheck[] = [];
  const pkg = packageProblems(bytes);
  checks.push(check('PACKAGE_VALID', 'TECHNICAL', pkg.problems.length || !pkg.parts.has('ppt/presentation.xml') ? 'FAIL' : 'PASS', pkg.problems.slice(0, 5).join('; ') || 'zip, XML, content types and relationships are consistent'));
  const presentation = pkg.parts.get('ppt/presentation.xml')?.toString('utf8') ?? '';
  const slideNames = pkg.names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => Number(/(\d+)/.exec(a)![1]) - Number(/(\d+)/.exec(b)![1]));
  const texts = pptxTexts(pkg.parts, pkg.names);
  checks.push(check('SIXTEEN_BY_NINE', 'QUALITY', /<p:sldSz cx="12192000" cy="6858000"/.test(presentation) ? 'PASS' : 'FAIL', 'slide size 12192000 x 6858000 EMU'));
  const untitled = slideNames.filter((n) => !/<p:ph [^>]*type="(title|ctrTitle)"/.test(pkg.parts.get(n)!.toString('utf8')) && !/<p:ph\s[^>]*type="title"/.test(pkg.parts.get(n)!.toString('utf8').replace(/\s+/g, ' ')));
  checks.push(check('EVERY_SLIDE_HAS_A_TITLE_PLACEHOLDER', 'QUALITY', untitled.length ? 'FAIL' : 'PASS', untitled.length ? `${untitled.length} slide(s) without a title placeholder` : `${slideNames.length} slide(s), each titled (outline view and screen readers work)`));
  const chartParts = pkg.names.filter((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n));
  const workbooks = pkg.names.filter((n) => /^ppt\/embeddings\/.+\.xlsx$/.test(n));
  // a bar's length is its value: an axis that does not start at zero (or is left automatic) exaggerates differences
  const barAxes = chartParts.map((n) => pkg.parts.get(n)!.toString('utf8')).filter((xml) => /<c:barChart>/.test(xml)).map((xml) => /<c:valAx>[\s\S]*?<c:min val="(-?[\d.]+)"/.exec(xml)?.[1] ?? null);
  const badBars = barAxes.filter((min) => min === null || Number(min) > 0).length;
  checks.push(check('BAR_CHARTS_START_AT_ZERO', 'QUALITY', badBars ? 'FAIL' : 'PASS', barAxes.length ? `${barAxes.length} bar chart(s), ${badBars} without an explicit zero baseline` : 'no bar chart'));
  checks.push(check('CHARTS_ARE_NATIVE_WITH_DATA', 'QUALITY', chartParts.length === 0 ? 'PASS' : workbooks.length >= chartParts.length ? 'PASS' : 'FAIL', `${chartParts.length} chart(s), ${workbooks.length} embedded workbook(s)`));
  const pictureFrames = slideNames.map((n) => pkg.parts.get(n)!.toString('utf8')).flatMap((xml) => [...xml.matchAll(/<p:pic>[\s\S]*?<\/p:pic>/g)].map((m) => m[0]));
  if (expectation.minPictures) checks.push(check('PICTURES_PRESENT', 'QUALITY', pictureFrames.length >= expectation.minPictures ? 'PASS' : 'FAIL', `${pictureFrames.length} picture(s) in the file, ${expectation.minPictures} expected`));
  if (expectation.minCharts) checks.push(check('CHARTS_PRESENT', 'QUALITY', chartParts.length >= expectation.minCharts ? 'PASS' : 'FAIL', `${chartParts.length} native chart(s) in the file, ${expectation.minCharts} expected`));
  const missingAlt = pictureFrames.filter((frame) => !/descr="[^"]+"/.test(frame)).length;
  checks.push(check('PICTURES_HAVE_ALT_TEXT', 'QUALITY', missingAlt ? 'FAIL' : 'PASS', `${pictureFrames.length} picture(s), ${missingAlt} without alt text`));
  const share = expectation.minNotesShare ?? 0.8;
  const contentSlides = Math.max(1, slideNames.length - 1);
  const notesCount = texts.notes.length;
  checks.push(check('SPEAKER_NOTES_PRESENT', 'QUALITY', notesCount / contentSlides >= share ? 'PASS' : 'FAIL', `${notesCount} note(s) for ${contentSlides} content slide(s) (at least ${Math.round(share * 100)}%)`));
  const maxWords = expectation.maxWordsPerSlide ?? 90;
  const dense = texts.slideText.map((t, i) => ({ i: i + 1, words: t.split(/\s+/).filter(Boolean).length })).filter((s) => s.words > maxWords);
  checks.push(check('SLIDES_ARE_NOT_WALLS_OF_TEXT', 'QUALITY', dense.length ? 'FAIL' : 'PASS', dense.length ? `slides over ${maxWords} words: ${dense.map((d) => `${d.i} (${d.words})`).join(', ')}` : `no slide over ${maxWords} words`));
  checks.push(...factChecks(texts.all, expectation));
  if (expectation.pages) checks.push(check('SLIDE_COUNT_IN_RANGE', 'QUALITY', slideNames.length >= expectation.pages.min && slideNames.length <= expectation.pages.max ? 'PASS' : 'FAIL', `${slideNames.length} slide(s), expected ${expectation.pages.min}-${expectation.pages.max}`));

  // what real PowerPoint measured
  const NOT_RUN_IDS = ['OPENS_IN_POWERPOINT', 'NO_TEXT_OVERFLOW', 'EVERYTHING_INSIDE_THE_SLIDE', 'READABLE_FONT_SIZES', 'FONTS_CONSISTENT', 'CHART_DATA_AS_EXPECTED', 'EDIT_AND_SAVE_SURVIVES'];
  if (!ppt) {
    for (const id of NOT_RUN_IDS) checks.push(check(id, id === 'OPENS_IN_POWERPOINT' ? 'TECHNICAL' : 'QUALITY', 'NOT_RUN', 'needs Microsoft PowerPoint (scripts/office-render.ps1)'));
  } else {
    const slides = ppt.slides ?? [];
    const shapes = slides.flatMap((s) => s.shapes.map((shape) => ({ slide: s.index, ...shape })));
    checks.push(check('OPENS_IN_POWERPOINT', 'TECHNICAL', ppt.opened && !(ppt.problems ?? []).length ? 'PASS' : 'FAIL', `${ppt.renderedBy ?? 'PowerPoint'}${(ppt.problems ?? []).length ? `: ${(ppt.problems ?? []).join('; ')}` : ''}`));
    const overflow = shapes.filter((s) => s.textOverflows);
    checks.push(check('NO_TEXT_OVERFLOW', 'QUALITY', overflow.length ? 'FAIL' : 'PASS', overflow.length ? `text taller than its box on slide(s) ${[...new Set(overflow.map((s) => s.slide))].join(', ')}` : 'no text taller than its box (BoundHeight read back from PowerPoint)'));
    const outside = shapes.filter((s) => !s.insideSlide);
    checks.push(check('EVERYTHING_INSIDE_THE_SLIDE', 'QUALITY', outside.length ? 'FAIL' : 'PASS', outside.length ? `outside the slide: ${outside.map((s) => `${s.slide}:${s.name}`).join(', ')}` : 'every shape within the 16:9 slide'));
    // the page-number placeholder is 10 pt by design; the body must be readable
    const small = shapes.filter((s) => s.hasText && !/Slide Number|^Text 1$/.test(s.name) && (s.minFontPt ?? 99) < 12 && !/NAgex/.test(s.text ?? ''));
    checks.push(check('READABLE_FONT_SIZES', 'QUALITY', small.length ? 'FAIL' : 'PASS', small.length ? `under 12 pt: ${small.map((s) => `${s.slide}:${s.name}(${s.minFontPt})`).join(', ')}` : 'no text under 12 pt (page numbers and the brand mark aside)'));
    const families = new Set(shapes.flatMap((s) => s.fontNames ?? []).filter(Boolean));
    checks.push(check('FONTS_CONSISTENT', 'QUALITY', families.size <= 3 ? 'PASS' : 'FAIL', `${families.size} font family(ies): ${[...families].join(', ')}`));
    if (expectation.charts?.length) {
      const drawn = shapes.filter((s) => s.hasChart && s.chart).map((s) => s.chart!.series);
      const unmatched = expectation.charts.filter((want) => !drawn.some((series) => series.some((s) => s.values.length === want.values.length && s.values.every((v, i) => Math.abs(v - want.values[i]) < 1e-9) && s.categories.map(normalize).join('|') === want.categories.map(normalize).join('|'))));
      checks.push(check('CHART_DATA_AS_EXPECTED', 'QUALITY', unmatched.length ? 'FAIL' : 'PASS', unmatched.length ? `${unmatched.length} expected chart(s) not found with exactly this data` : `${expectation.charts.length} chart(s) read back from PowerPoint match the data the person gave`));
    } else checks.push(check('CHART_DATA_AS_EXPECTED', 'QUALITY', 'NOT_RUN', 'no chart data was expected'));
    const edit = ppt.editRoundTrip;
    checks.push(check('EDIT_AND_SAVE_SURVIVES', 'QUALITY', edit?.saved && edit.reopened && edit.editSurvived ? 'PASS' : 'FAIL', 'opened, the first text edited, saved as a copy, reopened, the edit read back'));
  }
  return { artifact: 'PPTX', technical: verdict(checks, 'TECHNICAL'), quality: verdict(checks, 'QUALITY'), checks, stats: { slides: slideNames.length, charts: chartParts.length, pictures: pictureFrames.length, notes: notesCount, words: texts.slideText.join(' ').split(/\s+/).filter(Boolean).length } };
}

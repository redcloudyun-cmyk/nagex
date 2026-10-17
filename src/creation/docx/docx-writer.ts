// Builds a standards-based WordprocessingML (.docx) package from the Markdown NAgex already stores for a document: title, headings, paragraphs, bullet and numbered lists, bold / italic, links,
// tables (column alignment, content-based widths, repeating header row), pictures (alt text + caption), quotes. Real heading / list / caption / table styles (so Word's navigation pane, outline and
// style gallery work), Korean-capable fonts, a settings part that opens the file in Word's current mode (not Compatibility Mode), page layout (paper, orientation, margins) and a header / footer with
// page numbers. No third-party dependency - the same approach as pptx-writer.ts, whose zip container it reuses. Pure and deterministic: the same input always yields the same bytes except for the
// package timestamp.
//
// Measured in real Microsoft Word (scripts/office-render.ps1, docs/evidence/NAGEX_OUTCOME_QUALITY_20261017.md): before this version the file opened in Compatibility Mode, ignored the Markdown column
// alignment, had no page numbers and no pictures.
import { buildZip, type ZipEntry } from '../pptx/zip-writer.js';
import { xmlText } from '../pptx/pptx-writer.js';
import { imageSize } from '../image-size.js';

export { imageSize };

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const NS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const WORD_COMPAT = 'http://schemas.microsoft.com/office/word';

export interface DocxImage {
  bytes: Buffer;
  /** informational; the real type is read from the bytes (a PNG or a JPEG), never trusted from here */
  mimeType?: string;
}

export interface DocxLayout {
  paper?: 'A4' | 'LETTER';
  orientation?: 'portrait' | 'landscape';
  /** all four margins, in millimetres (default 20) */
  marginMm?: number;
}

export interface DocxInput {
  title: string;
  markdown: string;
  locale: 'en' | 'ko';
  layout?: DocxLayout;
  /** "1 / 3" in the footer of every page (default true) */
  pageNumbers?: boolean;
  /** the title, small, on every page but the first (default true) */
  runningHeader?: boolean;
  /** resolves the address of a Markdown picture - ![alt](ref "caption") - to its bytes. Return null when the picture is not available to this reader: the document then says so in place. */
  resolveImage?: (ref: string) => DocxImage | null;
  /** the package timestamp (tests pin it) */
  now?: Date;
}

// ── page geometry ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
interface Geometry { pageW: number; pageH: number; margin: number; textW: number; textH: number; landscape: boolean }
const MM_TO_TWIPS = 56.6929;
export function pageGeometry(layout: DocxLayout = {}): Geometry {
  const [w, h] = layout.paper === 'LETTER' ? [12240, 15840] : [11906, 16838];
  const landscape = layout.orientation === 'landscape';
  const pageW = landscape ? h : w;
  const pageH = landscape ? w : h;
  const mm = Number.isFinite(layout.marginMm) ? Math.min(40, Math.max(10, layout.marginMm as number)) : 20;
  const margin = Math.round(mm * MM_TO_TWIPS);
  return { pageW, pageH, margin, textW: pageW - 2 * margin, textH: pageH - 2 * margin, landscape };
}

// ── what a build collects while it walks the Markdown ──────────────────────────────────────────────────────────────────────────────────────────
interface Relationship { id: string; type: string; target: string; external?: boolean }
interface Media { name: string; bytes: Buffer; extension: 'png' | 'jpeg' }
interface BuildContext {
  locale: 'en' | 'ko';
  geometry: Geometry;
  relationships: Relationship[];
  media: Media[];
  nextRel: number;
  nextDrawingId: number;
  resolveImage?: (ref: string) => DocxImage | null;
}
const FIXED_RELATIONSHIPS = 6; // rId1 styles, rId2 numbering, rId3 settings, rId4 header, rId5 footer, rId6 the empty first-page header
function newContext(input: { locale: 'en' | 'ko'; layout?: DocxLayout; resolveImage?: DocxInput['resolveImage'] }): BuildContext {
  return { locale: input.locale, geometry: pageGeometry(input.layout), relationships: [], media: [], nextRel: FIXED_RELATIONSHIPS + 1, nextDrawingId: 1, resolveImage: input.resolveImage };
}
function addRelationship(ctx: BuildContext, type: string, target: string, external = false): string {
  const existing = ctx.relationships.find((r) => r.type === type && r.target === target && Boolean(r.external) === external);
  if (existing) return existing.id;
  const id = `rId${ctx.nextRel++}`;
  ctx.relationships.push({ id, type, target, external });
  return id;
}

type Run = { text: string; bold?: boolean; italic?: boolean; code?: boolean; href?: string };

// A bare http(s) address is literal text - never reinterpreted as emphasis (an underscore in a path stays an underscore) - and a real, clickable hyperlink. Trailing punctuation is not part of it.
const URL_PATTERN = /https?:\/\/[^\s<>"'`]*[^\s<>"'`.,;:!?)\]}]/g;
function parseInline(text: string): Run[] {
  const runs: Run[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const index = match.index ?? 0;
    if (index > last) runs.push(...parseEmphasis(text.slice(last, index)));
    runs.push({ text: match[0], href: match[0] });
    last = index + match[0].length;
  }
  if (last < text.length) runs.push(...parseEmphasis(text.slice(last)));
  return runs.length ? runs : [{ text: '' }];
}

// **bold**, *italic* / _italic_, `code`. Anything else is literal text; unmatched markers stay as written.
function parseEmphasis(text: string): Run[] {
  const runs: Run[] = [];
  const pattern = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\s][^*\n]*\*|_[^_\s][^_\n]*_)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const token = match[0];
    const index = match.index ?? 0;
    if (index > last) runs.push({ text: text.slice(last, index) });
    if (token.startsWith('**')) runs.push({ text: token.slice(2, -2), bold: true });
    else if (token.startsWith('`')) runs.push({ text: token.slice(1, -1), code: true });
    else runs.push({ text: token.slice(1, -1), italic: true });
    last = index + token.length;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  return runs.length ? runs : [{ text: '' }];
}

function runXml(run: Run, ctx: BuildContext): string {
  if (run.href) {
    const id = addRelationship(ctx, `${REL}/hyperlink`, run.href, true);
    return `<w:hyperlink r:id="${id}" w:history="1"><w:r><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr><w:t xml:space="preserve">${xmlText(run.text)}</w:t></w:r></w:hyperlink>`;
  }
  // CT_RPr child order: rFonts, b, i, ..., shd
  const props = `${run.code ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="D2Coding"/>' : ''}${run.bold ? '<w:b/>' : ''}${run.italic ? '<w:i/>' : ''}${run.code ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>' : ''}`;
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${xmlText(run.text)}</w:t></w:r>`;
}

function paragraph(ctx: BuildContext, text: string, options: { style?: string; numId?: number; indentLeft?: number; keepNext?: boolean; jc?: 'left' | 'center' | 'right' } = {}): string {
  const pPr = [
    options.style ? `<w:pStyle w:val="${options.style}"/>` : '',
    options.keepNext ? '<w:keepNext/>' : '',
    options.numId ? `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${options.numId}"/></w:numPr>` : '',
    options.indentLeft ? `<w:ind w:left="${options.indentLeft}"/>` : '',
    options.jc ? `<w:jc w:val="${options.jc}"/>` : '',
  ].join('');
  // a line break inside a paragraph stays a line break (NAgex's own view shows it as one; a memo header "To: / From: / Date:" must not run together on one line)
  const body = text.split('\n').map((line) => parseInline(line).map((r) => runXml(r, ctx)).join('')).join('<w:r><w:br/></w:r>');
  return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${body}</w:p>`;
}

// "Decision Memo: 12-Week Pilot" and "Decision Memo: 12-Week Pilot Recommendation" are the same title said twice: one contains the other, or nearly all of the words are shared
export function isSameTitle(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/[*_`#]/g, '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const x = norm(a); const y = norm(b);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const xs = new Set(x.split(' ')); const ys = new Set(y.split(' '));
  const shared = [...xs].filter((w) => ys.has(w)).length;
  return shared / Math.min(xs.size, ys.size) >= 0.8;
}

// ── tables ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
type Align = 'left' | 'center' | 'right';
// width of a character in units of the body font size: full-width (Hangul, CJK) 1.0, others 0.55 - only used to share the table width between columns
function textUnits(text: string): number {
  let units = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    units += (c >= 0x1100 && c <= 0x11ff) || (c >= 0x2e80 && c <= 0xd7ff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef) ? 1 : c === 32 ? 0.3 : 0.55;
  }
  return units;
}
// "73%", "12,000원", "45분", "₩1,200", "-3.5" - a number with at most a short unit. A column whose every body cell is like this reads better flush right.
const NUMERIC_CELL = /^[-+−]?[₩$€£¥]?\d[\d,]*(\.\d+)?\s?(%|[가-힣A-Za-z]{0,4})$/;
export function isNumericCell(text: string): boolean { return NUMERIC_CELL.test(text.replace(/\*+/g, '').trim()); }

function columnAlignments(rows: string[][], markers: Array<Align | null>, columns: number): Align[] {
  return Array.from({ length: columns }, (_, c) => {
    if (markers[c]) return markers[c] as Align;
    const body = rows.slice(1).map((r) => (r[c] ?? '').trim()).filter(Boolean);
    return body.length > 0 && body.every(isNumericCell) ? 'right' : 'left';
  });
}

function columnWidths(rows: string[][], columns: number, total: number): number[] {
  const weights = Array.from({ length: columns }, (_, c) => Math.min(28, Math.max(3, ...rows.map((r) => Math.ceil(textUnits(String(r[c] ?? '').replace(/\*+/g, ''))))))) as number[];
  const sum = weights.reduce((a, b) => a + b, 0);
  const min = Math.min(900, Math.floor(total / columns));
  const widths = weights.map((w) => Math.max(min, Math.floor((total * w) / sum)));
  // the grid must add up to the text width exactly: the widest column absorbs the difference
  const diff = total - widths.reduce((a, b) => a + b, 0);
  const widest = widths.indexOf(Math.max(...widths));
  widths[widest] += diff;
  return widths;
}

function tableXml(ctx: BuildContext, rows: string[][], markers: Array<Align | null>): string {
  const columns = Math.max(...rows.map((r) => r.length));
  const total = ctx.geometry.textW;
  const widths = columnWidths(rows, columns, total);
  const aligns = columnAlignments(rows, markers, columns);
  const border = (side: string) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`;
  const cell = (text: string, column: number, header: boolean) =>
    `<w:tc><w:tcPr><w:tcW w:w="${widths[column]}" w:type="dxa"/>${header ? '<w:shd w:val="clear" w:color="auto" w:fill="EAF0FB"/>' : ''}<w:vAlign w:val="center"/></w:tcPr><w:p><w:pPr><w:spacing w:before="40" w:after="40"/><w:jc w:val="${header && aligns[column] === 'left' ? 'left' : aligns[column]}"/></w:pPr>${parseInline(text).map((r) => runXml(header ? { ...r, bold: true } : r, ctx)).join('')}</w:p></w:tc>`;
  const body = rows.map((row, i) => {
    const cells = Array.from({ length: columns }, (_, c) => cell(row[c] ?? '', c, i === 0)).join('');
    return `<w:tr><w:trPr><w:cantSplit/>${i === 0 ? '<w:tblHeader/>' : ''}</w:trPr>${cells}</w:tr>`;
  }).join('');
  return `<w:tbl><w:tblPr><w:tblStyle w:val="NAgexTable"/><w:tblW w:w="${total}" w:type="dxa"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('')}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr><w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${body}</w:tbl><w:p/>`;
}

const splitRow = (line: string): string[] => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const isTableSeparator = (line: string): boolean => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes('-');
const alignmentMarkers = (line: string): Array<Align | null> => splitRow(line).map((cell) => (/^:-+:$/.test(cell) ? 'center' : /^-+:$/.test(cell) ? 'right' : /^:-+$/.test(cell) ? 'left' : null));

// ── pictures ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const EMU_PER_PX = 9525; // 96 dpi
const EMU_PER_TWIP = 635;
function pictureXml(ctx: BuildContext, ref: string, alt: string, caption: string): string {
  const unavailable = (why: string) => `<w:p><w:r><w:rPr><w:i/><w:color w:val="595959"/></w:rPr><w:t xml:space="preserve">${xmlText(`[${ctx.locale === 'ko' ? '그림을 표시할 수 없습니다' : 'Picture unavailable'}: ${alt || why}]`)}</w:t></w:r></w:p>`;
  let image: DocxImage | null = null;
  try { image = ctx.resolveImage ? ctx.resolveImage(ref) : null; } catch { image = null; }
  if (!image || !image.bytes || image.bytes.length === 0) return unavailable(ref);
  const size = imageSize(image.bytes);
  if (!size) return unavailable(ref);
  // natural size at 96 dpi, scaled DOWN (never up) to the text width and to 60% of the text height, aspect ratio kept
  const maxW = ctx.geometry.textW * EMU_PER_TWIP;
  const maxH = Math.floor(ctx.geometry.textH * EMU_PER_TWIP * 0.6);
  const scale = Math.min(1, maxW / (size.width * EMU_PER_PX), maxH / (size.height * EMU_PER_PX));
  const cx = Math.max(1, Math.round(size.width * EMU_PER_PX * scale));
  const cy = Math.max(1, Math.round(size.height * EMU_PER_PX * scale));
  const name = `media/image${ctx.media.length + 1}.${size.extension === 'jpeg' ? 'jpg' : 'png'}`;
  ctx.media.push({ name, bytes: image.bytes, extension: size.extension });
  const rId = addRelationship(ctx, `${REL}/image`, name);
  const id = ctx.nextDrawingId++;
  const description = xmlText(alt || caption || '');
  const drawing = `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Picture ${id}" descr="${description}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="${NS_A}" noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic xmlns:a="${NS_A}"><a:graphicData uri="${NS_PIC}"><pic:pic xmlns:pic="${NS_PIC}"><pic:nvPicPr><pic:cNvPr id="${id}" name="Picture ${id}" descr="${description}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`;
  const picture = `<w:p><w:pPr>${caption ? '<w:keepNext/>' : ''}<w:spacing w:before="120" w:after="${caption ? 40 : 160}"/><w:jc w:val="center"/></w:pPr><w:r>${drawing}</w:r></w:p>`;
  return picture + (caption ? paragraph(ctx, caption, { style: 'Caption' }) : '');
}

// ── the body ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const IMAGE_LINE = /^!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"([^"]*)")?\s*\)\s*$/;

function bodyXml(ctx: BuildContext, markdown: string, documentTitle: string): string {
  const lines = String(markdown).replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let numberedRun = 0; // restarts the numbering for every separate numbered list
  let i = 0;
  let skippedDuplicateTitle = false;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) { i += 1; continue; }
    const heading = /^(#{1,6})\s+(.*?)\s*#*$/.exec(trimmed);
    if (heading) {
      const level = heading[1].length;
      // a leading "# Title" that repeats the document title is already the Title paragraph
      if (level === 1 && !skippedDuplicateTitle && out.length === 0 && isSameTitle(heading[2], documentTitle)) { skippedDuplicateTitle = true; i += 1; continue; }
      out.push(paragraph(ctx, heading[2].replace(/\*\*/g, ''), { style: `Heading${Math.min(level, 4)}`, keepNext: true }));
      numberedRun = 0;
      i += 1;
      continue;
    }
    const picture = IMAGE_LINE.exec(trimmed);
    if (picture) {
      out.push(pictureXml(ctx, picture[2], picture[1].trim(), (picture[3] ?? '').trim()));
      numberedRun = 0;
      i += 1;
      continue;
    }
    if (/^\|/.test(trimmed) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const markers = alignmentMarkers(lines[i + 1]);
      const rows = [splitRow(trimmed)];
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(splitRow(lines[i])); i += 1; }
      out.push(tableXml(ctx, rows, markers));
      numberedRun = 0;
      continue;
    }
    if (/^[-*•]\s+/.test(trimmed)) {
      out.push(paragraph(ctx, trimmed.replace(/^[-*•]\s+/, ''), { style: 'ListBullet', numId: 1 }));
      i += 1;
      continue;
    }
    const numbered = /^(\d{1,3})[.)]\s+(.*)$/.exec(trimmed);
    if (numbered) {
      if (numberedRun === 0) numberedRun = 2 + out.filter((x) => x.includes('w:numId w:val="')).length; // a fresh list instance for each run of numbered items
      out.push(paragraph(ctx, numbered[2], { style: 'ListNumber', numId: Math.min(numberedRun, 60) }));
      i += 1;
      continue;
    }
    if (/^>\s?/.test(trimmed)) {
      out.push(paragraph(ctx, trimmed.replace(/^>\s?/, ''), { style: 'Quote' }));
      i += 1;
      continue;
    }
    if (/^([-*_])\1{2,}$/.test(trimmed.replace(/\s/g, ''))) {
      out.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BFBFBF"/></w:pBdr></w:pPr></w:p>');
      i += 1;
      continue;
    }
    // a paragraph: consecutive plain lines join into one
    const parts = [trimmed];
    i += 1;
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|[-*•]\s|\d{1,3}[.)]\s|>\s?|\||!\[)/.test(lines[i].trim())) { parts.push(lines[i].trim()); i += 1; }
    out.push(paragraph(ctx, parts.join('\n')));
    numberedRun = 0;
  }
  return out.join('');
}

/** The body XML of a Markdown text (no package around it). Pictures are not available here: each shows its "unavailable" line. */
export function markdownToBodyXml(markdown: string, documentTitle: string): string {
  return bodyXml(newContext({ locale: 'en' }), markdown, documentTitle);
}

// ── styles, numbering, settings, header, footer ───────────────────────────────────────────────────────────────────────────────────────────
function styles(locale: 'en' | 'ko'): string {
  const lang = locale === 'ko' ? 'ko-KR' : 'en-US';
  const fonts = '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Malgun Gothic" w:cs="Calibri"/>';
  const heading = (id: string, name: string, size: number, color: string, before: number) =>
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${before}" w:after="80"/><w:outlineLvl w:val="${Number(id.slice(-1)) - 1}"/></w:pPr><w:rPr><w:b/><w:color w:val="${color}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;
  const border = (side: string) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`;
  return `${XML_HEAD}<w:styles xmlns:w="${NS_W}"><w:docDefaults><w:rPrDefault><w:rPr>${fonts}<w:sz w:val="20"/><w:szCs w:val="20"/><w:lang w:val="${lang}" w:eastAsia="${lang}" w:bidi="ar-SA"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="100" w:line="312" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>`
    + `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>`
    + `<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style>`
    + `<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>`
    + `<w:style w:type="table" w:styleId="NAgexTable"><w:name w:val="NAgex Table"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="59"/><w:tblPr><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('')}</w:tblBorders><w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>`
    + `<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="10"/><w:qFormat/><w:pPr><w:spacing w:before="0" w:after="240"/></w:pPr><w:rPr><w:b/><w:color w:val="1F3864"/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style>`
    + heading('Heading1', 'heading 1', 28, '1F3864', 280) + heading('Heading2', 'heading 2', 24, '2F5496', 220) + heading('Heading3', 'heading 3', 22, '2F5496', 160) + heading('Heading4', 'heading 4', 20, '404040', 120)
    + `<w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="60"/></w:pPr></w:style>`
    + `<w:style w:type="paragraph" w:styleId="ListNumber"><w:name w:val="List Number"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="60"/></w:pPr></w:style>`
    + `<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="567"/></w:pPr><w:rPr><w:i/><w:color w:val="595959"/></w:rPr></w:style>`
    + `<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="35"/><w:qFormat/><w:pPr><w:spacing w:before="40" w:after="160"/><w:jc w:val="center"/></w:pPr><w:rPr><w:i/><w:color w:val="595959"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>`
    + `<w:style w:type="paragraph" w:styleId="Header"><w:name w:val="header"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="99"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:color w:val="7F7F7F"/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr></w:style>`
    + `<w:style w:type="paragraph" w:styleId="Footer"><w:name w:val="footer"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="99"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:color w:val="7F7F7F"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>`
    + `</w:styles>`;
}

// numId 1 = bullets; numId 2..61 = independent decimal lists (each separate numbered list restarts at 1)
function numbering(): string {
  const bullet = `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="567" w:hanging="283"/></w:pPr></w:lvl></w:abstractNum>`;
  const decimal = `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="567" w:hanging="340"/></w:pPr></w:lvl></w:abstractNum>`;
  const nums = ['<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'];
  for (let n = 2; n <= 61; n += 1) nums.push(`<w:num w:numId="${n}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`);
  return `${XML_HEAD}<w:numbering xmlns:w="${NS_W}">${bullet}${decimal}${nums.join('')}</w:numbering>`;
}

// compatibilityMode 15 = Word 2013 and later: without it Word opens the file in "Compatibility Mode" (Word 2007 layout rules, a label in the title bar)
function settings(locale: 'en' | 'ko'): string {
  const compat = (name: string, value: number) => `<w:compatSetting w:name="${name}" w:uri="${WORD_COMPAT}" w:val="${value}"/>`;
  return `${XML_HEAD}<w:settings xmlns:w="${NS_W}"><w:zoom w:percent="100"/><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/><w:compat>${compat('compatibilityMode', 15)}${compat('overrideTableStyleFontSizeAndJustification', 1)}${compat('enableOpenTypeFeatures', 1)}${compat('doNotFlipMirrorIndents', 1)}${compat('differentiateMultirowTableHeaders', 1)}</w:compat><w:themeFontLang w:val="${locale === 'ko' ? 'ko-KR' : 'en-US'}" w:eastAsia="ko-KR"/></w:settings>`;
}

const field = (instruction: string, placeholder: string) =>
  `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ${instruction} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>${placeholder}</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`;
const footerXml = () => `${XML_HEAD}<w:ftr xmlns:w="${NS_W}" xmlns:r="${NS_R}"><w:p><w:pPr><w:pStyle w:val="Footer"/><w:jc w:val="center"/></w:pPr>${field('PAGE', '1')}<w:r><w:t xml:space="preserve"> / </w:t></w:r>${field('NUMPAGES', '1')}</w:p></w:ftr>`;
const headerXml = (title: string) => `${XML_HEAD}<w:hdr xmlns:w="${NS_W}" xmlns:r="${NS_R}"><w:p><w:pPr><w:pStyle w:val="Header"/><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="4" w:color="D9D9D9"/></w:pBdr><w:jc w:val="right"/></w:pPr><w:r><w:t xml:space="preserve">${xmlText(title)}</w:t></w:r></w:p></w:hdr>`;
const emptyHeaderXml = () => `${XML_HEAD}<w:hdr xmlns:w="${NS_W}" xmlns:r="${NS_R}"><w:p><w:pPr><w:pStyle w:val="Header"/></w:pPr></w:p></w:hdr>`;

// ── the package ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export function buildDocx(input: DocxInput): Buffer {
  const title = (input.title || '').trim() || (input.locale === 'ko' ? '문서' : 'Document');
  const ctx = newContext(input);
  const pageNumbers = input.pageNumbers !== false;
  const runningHeader = input.runningHeader !== false;
  const body = `${paragraph(ctx, title, { style: 'Title' })}${bodyXml(ctx, input.markdown, title)}`;
  const g = ctx.geometry;
  const headerRefs = runningHeader ? '<w:headerReference w:type="default" r:id="rId4"/><w:headerReference w:type="first" r:id="rId6"/>' : '';
  const footerRefs = pageNumbers ? '<w:footerReference w:type="default" r:id="rId5"/><w:footerReference w:type="first" r:id="rId5"/>' : '';
  const sectPr = `<w:sectPr>${headerRefs}${footerRefs}<w:pgSz w:w="${g.pageW}" w:h="${g.pageH}"${g.landscape ? ' w:orient="landscape"' : ''}/><w:pgMar w:top="${g.margin}" w:right="${g.margin}" w:bottom="${g.margin}" w:left="${g.margin}" w:header="567" w:footer="567" w:gutter="0"/>${runningHeader ? '<w:titlePg/>' : ''}</w:sectPr>`;
  const document = `${XML_HEAD}<w:document xmlns:w="${NS_W}" xmlns:r="${NS_R}" xmlns:wp="${NS_WP}"><w:body>${body}${sectPr}</w:body></w:document>`;
  const now = (input.now ?? new Date()).toISOString().replace(/\.\d+Z$/, 'Z');

  // relationship ids: 1-3 fixed parts, 4 header, 5 footer, 6 the empty first-page header, then hyperlinks and pictures in the order they were met
  const fixed: Relationship[] = [
    { id: 'rId1', type: `${REL}/styles`, target: 'styles.xml' },
    { id: 'rId2', type: `${REL}/numbering`, target: 'numbering.xml' },
    { id: 'rId3', type: `${REL}/settings`, target: 'settings.xml' },
    ...(runningHeader ? [{ id: 'rId4', type: `${REL}/header`, target: 'header1.xml' }, { id: 'rId6', type: `${REL}/header`, target: 'header2.xml' }] : []),
    ...(pageNumbers ? [{ id: 'rId5', type: `${REL}/footer`, target: 'footer1.xml' }] : []),
  ];
  const relXml = [...fixed, ...ctx.relationships].map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${xmlText(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`).join('');
  const override = (part: string, type: string) => `<Override PartName="${part}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${type}+xml"/>`;
  const extensions = new Set(ctx.media.map((m) => m.extension));
  const contentTypes = `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${extensions.has('png') ? '<Default Extension="png" ContentType="image/png"/>' : ''}${extensions.has('jpeg') ? '<Default Extension="jpg" ContentType="image/jpeg"/>' : ''}<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${override('/word/styles.xml', 'styles')}${override('/word/numbering.xml', 'numbering')}${override('/word/settings.xml', 'settings')}${runningHeader ? `${override('/word/header1.xml', 'header')}${override('/word/header2.xml', 'header')}` : ''}${pageNumbers ? override('/word/footer1.xml', 'footer') : ''}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(`${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/></Relationships>`, 'utf8') },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(`${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relXml}</Relationships>`, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(document, 'utf8') },
    { name: 'word/styles.xml', data: Buffer.from(styles(input.locale), 'utf8') },
    { name: 'word/numbering.xml', data: Buffer.from(numbering(), 'utf8') },
    { name: 'word/settings.xml', data: Buffer.from(settings(input.locale), 'utf8') },
    ...(runningHeader ? [{ name: 'word/header1.xml', data: Buffer.from(headerXml(title), 'utf8') }, { name: 'word/header2.xml', data: Buffer.from(emptyHeaderXml(), 'utf8') }] : []),
    ...(pageNumbers ? [{ name: 'word/footer1.xml', data: Buffer.from(footerXml(), 'utf8') }] : []),
    ...ctx.media.map((m) => ({ name: `word/${m.name}`, data: m.bytes })),
    { name: 'docProps/core.xml', data: Buffer.from(`${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlText(title)}</dc:title><dc:creator>NAgex</dc:creator><dc:language>${input.locale === 'ko' ? 'ko-KR' : 'en-US'}</dc:language><cp:lastModifiedBy>NAgex</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`, 'utf8') },
    { name: 'docProps/app.xml', data: Buffer.from(`${XML_HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>NAgex</Application></Properties>`, 'utf8') },
  ];
  return buildZip(entries, input.now);
}

/** A readable, header-safe download name: the document title with path and control characters removed. */
export function docxFileName(title: string): string {
  const base = String(title).replace(/[\u0000-\u001f\u007f"\\/:*?<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'document';
  return `${base}.docx`;
}

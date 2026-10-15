// Builds a standards-based WordprocessingML (.docx) package from the Markdown NAgex already stores for a document: title, headings, paragraphs, bullet and numbered lists, bold / italic,
// pipe tables, quotes. A4, real heading / list styles (so Word's navigation pane and outline work), Korean-capable fonts. No third-party dependency - the same approach as pptx-writer.ts, whose
// zip container it reuses. Pure and deterministic: the same document always yields the same bytes except for the package timestamp.
import { buildZip, type ZipEntry } from '../pptx/zip-writer.js';
import { xmlText } from '../pptx/pptx-writer.js';

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const NS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

export interface DocxInput {
  title: string;
  markdown: string;
  locale: 'en' | 'ko';
}

type Run = { text: string; bold?: boolean; italic?: boolean; code?: boolean };

// **bold**, *italic* / _italic_, `code`. Anything else is literal text; unmatched markers stay as written.
function parseInline(text: string): Run[] {
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

function runXml(run: Run): string {
  // CT_RPr child order: rFonts, b, i, ..., shd
  const props = `${run.code ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="D2Coding"/>' : ''}${run.bold ? '<w:b/>' : ''}${run.italic ? '<w:i/>' : ''}${run.code ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>' : ''}`;
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${xmlText(run.text)}</w:t></w:r>`;
}

function paragraph(text: string, options: { style?: string; numId?: number; indentLeft?: number; keepNext?: boolean } = {}): string {
  const pPr = [
    options.style ? `<w:pStyle w:val="${options.style}"/>` : '',
    options.keepNext ? '<w:keepNext/>' : '',
    options.numId ? `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${options.numId}"/></w:numPr>` : '',
    options.indentLeft ? `<w:ind w:left="${options.indentLeft}"/>` : '',
  ].join('');
  return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${parseInline(text).map(runXml).join('')}</w:p>`;
}

function tableXml(rows: string[][]): string {
  const columns = Math.max(...rows.map((r) => r.length));
  const width = Math.floor(9638 / columns);
  const border = (side: string) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`;
  const cell = (text: string, header: boolean) =>
    `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${header ? '<w:shd w:val="clear" w:color="auto" w:fill="EAF0FB"/>' : ''}</w:tcPr><w:p><w:pPr><w:spacing w:before="40" w:after="40"/></w:pPr>${parseInline(text).map((r) => runXml(header ? { ...r, bold: true } : r)).join('')}</w:p></w:tc>`;
  const body = rows.map((row, i) => {
    const cells = Array.from({ length: columns }, (_, c) => cell(row[c] ?? '', i === 0)).join('');
    return `<w:tr>${i === 0 ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${cells}</w:tr>`;
  }).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="9638" w:type="dxa"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('')}</w:tblBorders><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>${Array.from({ length: columns }, () => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>${body}</w:tbl><w:p/>`;
}

const splitRow = (line: string): string[] => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const isTableSeparator = (line: string): boolean => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes('-');

export function markdownToBodyXml(markdown: string, documentTitle: string): string {
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
      if (level === 1 && !skippedDuplicateTitle && out.length === 0 && heading[2].replace(/\*+/g, '').trim() === documentTitle.trim()) { skippedDuplicateTitle = true; i += 1; continue; }
      out.push(paragraph(heading[2].replace(/\*\*/g, ''), { style: `Heading${Math.min(level, 4)}`, keepNext: true }));
      numberedRun = 0;
      i += 1;
      continue;
    }
    if (/^\|/.test(trimmed) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const rows = [splitRow(trimmed)];
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(splitRow(lines[i])); i += 1; }
      out.push(tableXml(rows));
      numberedRun = 0;
      continue;
    }
    if (/^[-*•]\s+/.test(trimmed)) {
      out.push(paragraph(trimmed.replace(/^[-*•]\s+/, ''), { style: 'ListBullet', numId: 1 }));
      i += 1;
      continue;
    }
    const numbered = /^(\d{1,3})[.)]\s+(.*)$/.exec(trimmed);
    if (numbered) {
      if (numberedRun === 0) numberedRun = 2 + out.filter((x) => x.includes('w:numId w:val="')).length; // a fresh list instance for each run of numbered items
      out.push(paragraph(numbered[2], { style: 'ListNumber', numId: Math.min(numberedRun, 60) }));
      i += 1;
      continue;
    }
    if (/^>\s?/.test(trimmed)) {
      out.push(paragraph(trimmed.replace(/^>\s?/, ''), { style: 'Quote' }));
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
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|[-*•]\s|\d{1,3}[.)]\s|>\s?|\|)/.test(lines[i].trim())) { parts.push(lines[i].trim()); i += 1; }
    out.push(paragraph(parts.join(' ')));
    numberedRun = 0;
  }
  return out.join('');
}

function styles(locale: 'en' | 'ko'): string {
  const lang = locale === 'ko' ? 'ko-KR' : 'en-US';
  const fonts = '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Malgun Gothic" w:cs="Calibri"/>';
  const heading = (id: string, name: string, size: number, color: string, before: number) =>
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${before}" w:after="80"/><w:outlineLvl w:val="${Number(id.slice(-1)) - 1}"/></w:pPr><w:rPr><w:b/><w:color w:val="${color}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;
  return `${XML_HEAD}<w:styles xmlns:w="${NS_W}"><w:docDefaults><w:rPrDefault><w:rPr>${fonts}<w:sz w:val="20"/><w:szCs w:val="20"/><w:lang w:val="${lang}" w:eastAsia="${lang}" w:bidi="ar-SA"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="100" w:line="312" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>`
    + `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>`
    + `<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="10"/><w:qFormat/><w:pPr><w:spacing w:before="0" w:after="240"/></w:pPr><w:rPr><w:b/><w:color w:val="1F3864"/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style>`
    + heading('Heading1', 'heading 1', 28, '1F3864', 280) + heading('Heading2', 'heading 2', 24, '2F5496', 220) + heading('Heading3', 'heading 3', 22, '2F5496', 160) + heading('Heading4', 'heading 4', 20, '404040', 120)
    + `<w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="60"/></w:pPr></w:style>`
    + `<w:style w:type="paragraph" w:styleId="ListNumber"><w:name w:val="List Number"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="60"/></w:pPr></w:style>`
    + `<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="567"/></w:pPr><w:rPr><w:i/><w:color w:val="595959"/></w:rPr></w:style>`
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

export function buildDocx(input: DocxInput): Buffer {
  const title = (input.title || '').trim() || (input.locale === 'ko' ? '문서' : 'Document');
  const body = `${paragraph(title, { style: 'Title' })}${markdownToBodyXml(input.markdown, title)}`;
  const document = `${XML_HEAD}<w:document xmlns:w="${NS_W}" xmlns:r="${NS_R}"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: Buffer.from(`${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(`${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`, 'utf8') },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(`${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/styles" Target="styles.xml"/><Relationship Id="rId2" Type="${REL}/numbering" Target="numbering.xml"/></Relationships>`, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(document, 'utf8') },
    { name: 'word/styles.xml', data: Buffer.from(styles(input.locale), 'utf8') },
    { name: 'word/numbering.xml', data: Buffer.from(numbering(), 'utf8') },
    { name: 'docProps/core.xml', data: Buffer.from(`${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlText(title)}</dc:title><dc:creator>NAgex</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created></cp:coreProperties>`, 'utf8') },
  ];
  return buildZip(entries);
}

/** A readable, header-safe download name: the document title with path and control characters removed. */
export function docxFileName(title: string): string {
  const base = String(title).replace(/[\u0000-\u001f\u007f"\\/:*?<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'document';
  return `${base}.docx`;
}

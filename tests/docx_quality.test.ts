// Outcome Quality (C1) - what real Microsoft Word showed was wrong with the .docx NAgex produced, and what the file now says.
//
// Measured in Word 16 with scripts/office-render.ps1 (docs/evidence/NAGEX_OUTCOME_QUALITY_20261017.md): the previous file opened in Compatibility Mode, ignored the Markdown column alignment, had no
// page numbers and no pictures. These assertions pin the package facts that fix each (deterministic, no Office needed); the pages Word actually drew are in the evidence folder.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildDocx, imageSize, isNumericCell, pageGeometry } from '../src/creation/docx/docx-writer.js';
import { readZip } from '../src/creation/pptx/zip-writer.js';
import { jpegHeader, makeBarsPng, makePng } from './_png.js';

// a tiny well-formedness check: balanced, properly nested tags (self-closing allowed)
function assertWellFormed(xml: string, name: string): void {
  const stack: string[] = [];
  for (const m of xml.replace(/<\?xml[^>]*\?>/, '').matchAll(/<(\/?)([A-Za-z][\w:.-]*)([^<>]*?)(\/?)>/g)) {
    const [, closing, tag, , selfClosing] = m;
    if (selfClosing) continue;
    if (closing) assert.equal(stack.pop(), tag, `${name}: unbalanced </${tag}>`);
    else stack.push(tag);
  }
  assert.deepEqual(stack, [], `${name}: unclosed tags`);
}

type Input = Parameters<typeof buildDocx>[0];
const parts = (input: Partial<Input> = {}) => {
  const entries = readZip(buildDocx({ title: '보고서', markdown: '## 가\n\n본문', locale: 'ko', ...input }));
  return { entries, names: entries.map((e) => e.name), text: (name: string) => entries.find((e) => e.name === name)?.data.toString('utf8') ?? '' };
};

describe('what Word needs to open the file as a current document', () => {
  const pinned = { now: new Date('2026-10-17T00:00:00Z') };
  const p = parts(pinned);
  it('has a settings part that sets compatibility mode 15 (not Word 2007 "Compatibility Mode")', () => {
    assert.match(p.text('word/settings.xml'), /w:name="compatibilityMode"[^>]*w:val="15"/);
    assert.match(p.text('[Content_Types].xml'), /\/word\/settings\.xml/);
    assert.match(p.text('word/_rels/document.xml.rels'), /Target="settings\.xml"/);
    assertWellFormed(p.text('word/settings.xml'), 'settings');
  });
  it('declares the table, caption, header and footer styles it uses', () => {
    for (const id of ['NAgexTable', 'TableNormal', 'Caption', 'Header', 'Footer']) assert.match(p.text('word/styles.xml'), new RegExp(`w:styleId="${id}"`), id);
  });
  it('carries the language, author and times in the document properties', () => {
    const core = p.text('docProps/core.xml');
    assert.match(core, /<dc:language>ko-KR<\/dc:language>/);
    assert.match(core, /<dcterms:modified[^>]*>2026-10-17T00:00:00Z</);
    assert.ok(p.names.includes('docProps/app.xml'));
  });
  it('is byte-for-byte the same for the same input (no hidden clock but the pinned one)', () => {
    assert.equal(buildDocx({ title: '보고서', markdown: '## 가\n\n본문', locale: 'ko', ...pinned }).equals(buildDocx({ title: '보고서', markdown: '## 가\n\n본문', locale: 'ko', ...pinned })), true);
  });
});

describe('page layout, header and page numbers', () => {
  it('puts "page / pages" fields in the footer of every page and the title in a running header (not on the first page)', () => {
    const p = parts();
    assert.match(p.text('word/footer1.xml'), /instrText[^>]*> PAGE <\/w:instrText>/);
    assert.match(p.text('word/footer1.xml'), /instrText[^>]*> NUMPAGES <\/w:instrText>/);
    assert.match(p.text('word/header1.xml'), /보고서/);
    assert.equal(/보고서/.test(p.text('word/header2.xml')), false, 'the first-page header is empty: the title is already on the page');
    const doc = p.text('word/document.xml');
    assert.match(doc, /<w:titlePg\/>/);
    assert.match(doc, /<w:footerReference w:type="first"/);
    for (const name of ['word/header1.xml', 'word/header2.xml', 'word/footer1.xml']) assertWellFormed(p.text(name), name);
  });
  it('can leave the header and the page numbers out', () => {
    const p = parts({ pageNumbers: false, runningHeader: false });
    assert.equal(p.names.some((n) => /header|footer/.test(n)), false);
    assert.doesNotMatch(p.text('word/document.xml'), /headerReference|footerReference|titlePg/);
  });
  it('lays out A4 or Letter, portrait or landscape, with the margin asked for (bounded to 10-40 mm)', () => {
    assert.deepEqual({ ...pageGeometry({}) }, { pageW: 11906, pageH: 16838, margin: 1134, textW: 9638, textH: 14570, landscape: false });
    const landscape = pageGeometry({ paper: 'LETTER', orientation: 'landscape', marginMm: 15 });
    assert.equal(landscape.pageW, 15840); assert.equal(landscape.pageH, 12240); assert.equal(landscape.landscape, true);
    assert.equal(pageGeometry({ marginMm: 500 }).margin, Math.round(40 * 56.6929), 'a margin cannot swallow the page');
    assert.equal(pageGeometry({ marginMm: 1 }).margin, Math.round(10 * 56.6929));
    assert.match(parts({ layout: { paper: 'LETTER', orientation: 'landscape' } }).text('word/document.xml'), /<w:pgSz w:w="15840" w:h="12240" w:orient="landscape"\/>/);
  });
});

describe('tables', () => {
  const doc = (md: string, layout?: Input['layout']) => parts({ markdown: md, layout }).text('word/document.xml');
  const MD = '| 항목 | 값 | 비율 | 메모 |\n| :--- | :---: | ---: | --- |\n| 회의 | 45분 | 73% | 자세한 설명이 들어간 아주 긴 메모 칸입니다 |\n| 일정 | 5분 | 83% | 짧음 |';
  it('honours the Markdown column alignment (:--- left, :---: centre, ---: right)', () => {
    const jcs = [...doc(MD).matchAll(/<w:p><w:pPr><w:spacing w:before="40" w:after="40"\/><w:jc w:val="(\w+)"\/>/g)].map((m) => m[1]);
    assert.deepEqual(jcs.slice(0, 4), ['left', 'center', 'right', 'left'], 'header row');
    assert.deepEqual(jcs.slice(4, 8), ['left', 'center', 'right', 'left'], 'first body row');
  });
  it('right-aligns a column of numbers even when the Markdown did not say so, and leaves text columns left', () => {
    const jcs = [...doc('| 이름 | 금액 |\n| --- | --- |\n| 가 | 12,000원 |\n| 나 | 6,000원 |').matchAll(/<w:jc w:val="(\w+)"\/>/g)].map((m) => m[1]);
    assert.deepEqual(jcs, ['left', 'right', 'left', 'right', 'left', 'right']);
    for (const numeric of ['73%', '12,000원', '₩1,200', '-3.5', '45분']) assert.equal(isNumericCell(numeric), true, numeric);
    for (const text of ['낮음', '2026-10-17 시작', '']) assert.equal(isNumericCell(text), false, text);
  });
  it('shares the text width between the columns by their content, and the grid adds up to the text width exactly', () => {
    for (const layout of [undefined, { orientation: 'landscape' as const }, { paper: 'LETTER' as const, marginMm: 30 }]) {
      const xml = doc(MD, layout);
      const grid = [...xml.match(/<w:tblGrid>(.*?)<\/w:tblGrid>/)![1].matchAll(/w:w="(\d+)"/g)].map((m) => Number(m[1]));
      const g = pageGeometry(layout);
      assert.equal(grid.reduce((a, b) => a + b, 0), g.textW);
      assert.ok(grid[3] > grid[1], 'the long memo column is wider than the short value column');
      assert.ok(Math.min(...grid) >= 700, 'no column is squeezed to nothing');
      assert.match(xml, new RegExp(`<w:tblW w:w="${g.textW}" w:type="dxa"/>`));
    }
  });
  it('keeps rows whole across pages, repeats the header row, and uses the table style', () => {
    const xml = doc(MD);
    assert.equal((xml.match(/<w:cantSplit\/>/g) ?? []).length, 3);
    assert.equal((xml.match(/<w:tblHeader\/>/g) ?? []).length, 1);
    assert.match(xml, /<w:tblStyle w:val="NAgexTable"\/>/);
  });
});

describe('pictures', () => {
  const png = makeBarsPng(1200, 600, [0.4, 0.8, 0.6]);
  const build = (md: string, extra: Partial<Input> = {}) => parts({ markdown: md, title: 'T', resolveImage: (ref) => (ref === 'img://ok' ? { bytes: png } : null), ...extra });
  it('embeds a picture the reader may see: a media part, its content type and relationship, alt text, a caption, an aspect ratio that is kept', () => {
    const p = build('![분기별 막대그래프](img://ok "그림 1. 분기별 변화")');
    const media = p.entries.find((e) => e.name === 'word/media/image1.png');
    assert.ok(media && media.data.equals(png), 'the bytes are stored unchanged');
    assert.match(p.text('[Content_Types].xml'), /Extension="png" ContentType="image\/png"/);
    assert.match(p.text('word/_rels/document.xml.rels'), /Type="[^"]*\/image" Target="media\/image1\.png"/);
    const xml = p.text('word/document.xml');
    assert.match(xml, /descr="분기별 막대그래프"/, 'alt text for screen readers');
    assert.match(xml, /<w:pStyle w:val="Caption"\/>[\s\S]*?그림 1\. 분기별 변화/);
    const extent = /<wp:extent cx="(\d+)" cy="(\d+)"/.exec(xml)!;
    assert.ok(Math.abs(Number(extent[1]) / Number(extent[2]) - 2) < 0.01, '1200x600 stays 2:1');
    assert.ok(Number(extent[1]) <= pageGeometry({}).textW * 635, 'never wider than the text');
    assertWellFormed(xml, 'document');
  });
  it('shows a small picture at its natural size and scales a large or tall one down to fit', () => {
    const xml = (bytes: Buffer) => parts({ title: 'T', markdown: '![a](img://x)', locale: 'en', resolveImage: () => ({ bytes }) }).text('word/document.xml');
    assert.match(xml(makePng(96, 48)), /<wp:extent cx="914400" cy="457200"\/>/, '96x48 px at 96 dpi = 1 x 0.5 inch');
    const tall = /<wp:extent cx="(\d+)" cy="(\d+)"/.exec(xml(makePng(400, 4000)))!;
    assert.ok(Number(tall[2]) <= pageGeometry({}).textH * 635 * 0.6 + 1, 'a tall picture never takes more than 60% of the page height');
    assert.ok(Math.abs(Number(tall[1]) / Number(tall[2]) - 0.1) < 0.005, 'and keeps its shape');
  });
  it('says so in place when a picture is not available (unknown, unreadable, not a PNG/JPEG, or the store fails) - never dropped silently, never a crash', () => {
    const p = build('![없는 그림](img://missing)\n\n![가짜](img://fake)', { resolveImage: (ref) => (ref === 'img://fake' ? { bytes: Buffer.from('not an image at all, just text bytes') } : null) });
    const xml = p.text('word/document.xml');
    assert.match(xml, /그림을 표시할 수 없습니다: 없는 그림/);
    assert.match(xml, /그림을 표시할 수 없습니다: 가짜/);
    assert.equal(/<w:drawing>/.test(xml), false);
    assert.match(parts({ title: 'T', locale: 'en', markdown: '![x](img://boom)', resolveImage: () => { throw new Error('store failure'); } }).text('word/document.xml'), /Picture unavailable: x/);
    assert.match(parts({ title: 'T', locale: 'en', markdown: '![x](img://ok)' }).text('word/document.xml'), /Picture unavailable/, 'no resolver, no picture');
  });
  it('reads PNG and JPEG sizes from the bytes and nothing else (a lying mime type does not matter)', () => {
    assert.deepEqual(imageSize(makePng(30, 20)), { width: 30, height: 20, extension: 'png' });
    assert.deepEqual(imageSize(jpegHeader(640, 480)), { width: 640, height: 480, extension: 'jpeg' });
    assert.equal(imageSize(Buffer.from('GIF89a....')), null);
    assert.equal(imageSize(Buffer.alloc(0)), null);
    const lied = parts({ title: 'T', locale: 'en', markdown: '![x](img://x)', resolveImage: () => ({ bytes: makePng(8, 8), mimeType: 'image/gif' }) });
    assert.ok(lied.names.includes('word/media/image1.png'), 'stored as what the bytes are');
  });
  it('a picture does not disturb the rest of the document: relationship ids stay unique, hyperlinks and tables keep working', () => {
    const p = build('- 가\n\n![a](img://ok)\n\nhttps://example.org/x\n\n| a | b |\n| --- | --- |\n| 1 | 2 |');
    const rels = p.text('word/_rels/document.xml.rels');
    const ids = [...rels.matchAll(/Id="(rId\d+)"/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length, 'relationship ids are unique');
    assert.match(rels, /hyperlink" Target="https:\/\/example\.org\/x" TargetMode="External"/);
    assertWellFormed(p.text('word/document.xml'), 'document');
  });
});

// The .docx NAgex hands out for a document: a real WordprocessingML package built from the stored Markdown. These checks cover the package structure and content; opening the file in Microsoft
// Word (page count, headings, table) is part of the real-user E2E, not of this unit test.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildDocx, docxFileName, markdownToBodyXml } from '../src/creation/docx/docx-writer.js';
import { readZip } from '../src/creation/pptx/zip-writer.js';

// a tiny well-formedness check: balanced, properly nested tags (self-closing allowed); good enough to catch an unescaped character or a forgotten close tag
function assertWellFormed(xml: string, name: string): void {
  const stack: string[] = [];
  for (const m of xml.replace(/<\?xml[^>]*\?>/, '').matchAll(/<(\/?)([A-Za-z][\w:.-]*)([^<>]*?)(\/?)>/g)) {
    const [, closing, tag, , selfClosing] = m;
    if (selfClosing) continue;
    if (closing) assert.equal(stack.pop(), tag, `${name}: unbalanced </${tag}>`);
    else stack.push(tag);
  }
  assert.deepEqual(stack, [], `${name}: unclosed tags`);
  assert.doesNotMatch(xml.replace(/<[^>]*>/g, ''), /[<>]/, `${name}: raw angle bracket in text`);
}

const MD = [
  '# 개인 AI 비서 보고서', '', '## 1. 서론', '최근 **개인 AI 비서**의 도입이 *빠르게* 늘고 있다.', '둘째 줄은 같은 문단이다.', '',
  '### 1.1 배경', '- 첫째 항목', '- **굵은** 항목', '', '1. 하나', '2. 둘', '', '| 구분 | 내용 & 비고 |', '| --- | --- |', '| 속도 | 2배 < 3배 |', '', '> 인용문', '', '---', '', '마지막 `code` 문단 <script>',
].join('\n');

describe('buildDocx', () => {
  const zip = buildDocx({ title: '개인 AI 비서 보고서', markdown: MD, locale: 'ko' });
  const entries = readZip(zip);
  const text = (name: string) => entries.find((e) => e.name === name)?.data.toString('utf8') ?? '';

  it('is a zip with the parts Word requires, all well-formed', () => {
    assert.equal(zip.subarray(0, 2).toString(), 'PK');
    for (const name of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/_rels/document.xml.rels', 'word/styles.xml', 'word/numbering.xml', 'docProps/core.xml']) {
      assert.ok(entries.some((e) => e.name === name), name);
      assertWellFormed(text(name), name);
    }
    assert.match(text('[Content_Types].xml'), /wordprocessingml\.document\.main\+xml/);
    assert.match(text('_rels/.rels'), /officeDocument" Target="word\/document\.xml"/);
  });
  it('keeps the Korean text, structure and formatting', () => {
    const doc = text('word/document.xml');
    assert.match(doc, /<w:pStyle w:val="Title"\/>.*?개인 AI 비서 보고서/);
    assert.equal((doc.match(/개인 AI 비서 보고서/g) ?? []).length, 1, 'the leading "# title" that repeats the title is not printed twice');
    assert.match(doc, /<w:pStyle w:val="Heading2"\/>.*?1\. 서론/);
    assert.match(doc, /<w:pStyle w:val="Heading3"\/>/);
    assert.match(doc, /<w:b\/><\/w:rPr><w:t xml:space="preserve">개인 AI 비서<\/w:t>/);
    assert.match(doc, /<w:i\/><\/w:rPr><w:t xml:space="preserve">빠르게<\/w:t>/);
    assert.equal((doc.match(/w:pStyle w:val="ListBullet"/g) ?? []).length, 2);
    assert.equal((doc.match(/w:pStyle w:val="ListNumber"/g) ?? []).length, 2);
    assert.match(doc, /<w:tbl>/);
    assert.match(doc, /<w:tblHeader\/>/);
    assert.match(doc, /내용 &amp; 비고/);
    assert.match(doc, /2배 &lt; 3배/);
    assert.match(doc, /&lt;script&gt;/, 'markup in the text is escaped, never interpreted');
    assert.match(doc, /첫째 줄|최근 /);
    assert.match(doc, /<w:pgSz w:w="11906" w:h="16838"\/>/, 'A4');
  });
  it('uses Korean-capable fonts and the right language', () => {
    assert.match(text('word/styles.xml'), /w:eastAsia="Malgun Gothic"/);
    assert.match(text('word/styles.xml'), /w:lang w:val="ko-KR"/);
    const en = readZip(buildDocx({ title: 'Report', markdown: '# Report\n\nBody', locale: 'en' })).find((e) => e.name === 'word/styles.xml')!.data.toString('utf8');
    assert.match(en, /w:lang w:val="en-US"/);
  });
  it('separate numbered lists restart, and an empty or hostile document still builds', () => {
    const body = markdownToBodyXml('1. a\n2. b\n\ntext\n\n1. c', 'T');
    const ids = [...body.matchAll(/w:numId w:val="(\d+)"/g)].map((m) => m[1]);
    assert.equal(ids.length, 3);
    assert.equal(ids[0], ids[1]);
    assert.notEqual(ids[1], ids[2]);
    assert.doesNotThrow(() => buildDocx({ title: '', markdown: '', locale: 'ko' }));
    assert.doesNotThrow(() => buildDocx({ title: 'x\u0000y', markdown: '\u0001**unclosed *x `y', locale: 'en' }));
    assertWellFormed(readZip(buildDocx({ title: 'x\u0000y', markdown: '\u0001**unclosed *x `y', locale: 'en' })).find((e) => e.name === 'word/document.xml')!.data.toString('utf8'), 'hostile');
  });
  it('download names are header-safe', () => {
    assert.equal(docxFileName('a/b:c*"d"'), 'a b c d.docx');
    assert.equal(docxFileName(''), 'document.docx');
    assert.ok(docxFileName('가'.repeat(200)).length <= 85);
  });
});

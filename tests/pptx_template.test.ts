// The look of the decks NAgex builds (found by rendering them in Microsoft PowerPoint, see scratch/pptx-eval): dark cover, accent bar, title rule, footer brand, slide numbers, and Latin text in the same
// family as the Korean text. Everything is drawn by the master / layouts and real placeholders, so the slides stay editable and a restyled theme restyles the whole deck. Structure only: the rendered
// result is verified in PowerPoint by the E2E journey.
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPptx } from '../src/creation/pptx/pptx-writer.js';
import { readZip } from '../src/creation/pptx/zip-writer.js';

const part = (zip: Buffer, name: string): string => readZip(zip).find((entry) => entry.name === name)?.data.toString('utf8') ?? '';
const deck = (locale: 'en' | 'ko') => buildPptx({ title: locale === 'ko' ? '개인 AI 비서' : 'Personal AI', subtitle: locale === 'ko' ? '도입 제안' : 'Proposal', locale, slides: [
  { title: locale === 'ko' ? '왜 지금인가' : 'Why now', bullets: ['A', 'B', 'C'] }, { title: 'Second', bullets: ['D'] }, { title: 'Third', bullets: ['E', 'F'] }] });

function assertWellFormed(xml: string, name: string): void {
  const stack: string[] = [];
  for (const m of xml.replace(/<\?xml[^>]*\?>/, '').matchAll(/<(\/?)([A-Za-z][\w:.-]*)([^<>]*?)(\/?)>/g)) {
    const [, closing, tag, , self] = m;
    if (self) continue;
    if (closing) assert.equal(stack.pop(), tag, `${name}: unbalanced </${tag}>`); else stack.push(tag);
  }
  assert.deepEqual(stack, [], `${name}: unclosed tags`);
}

test('A. every part of a deck with the template is well-formed and shape ids are unique in each tree', () => {
  for (const locale of ['ko', 'en'] as const) {
    const zip = deck(locale);
    for (const entry of readZip(zip)) {
      if (!entry.name.endsWith('.xml') && !entry.name.endsWith('.rels')) continue;
      const xml = entry.data.toString('utf8');
      assertWellFormed(xml, entry.name);
      if (/^ppt\/(slides|slideLayouts|slideMasters)\/[^/]+\.xml$/.test(entry.name)) {
        const ids = [...xml.matchAll(/<p:cNvPr id="(\d+)"/g)].map((m) => m[1]);
        assert.equal(new Set(ids).size, ids.length, `${entry.name}: duplicate shape id in ${ids.join(',')}`);
      }
    }
  }
});

test('B. theme fonts: Korean decks use one family for Latin and Korean text, English decks keep Calibri with a Korean fallback', () => {
  const ko = part(deck('ko'), 'ppt/theme/theme1.xml');
  assert.match(ko, /<a:majorFont><a:latin typeface="Malgun Gothic"\/><a:ea typeface="Malgun Gothic"\/>/);
  assert.match(ko, /<a:minorFont><a:latin typeface="Malgun Gothic"\/><a:ea typeface="Malgun Gothic"\/>/);
  const en = part(deck('en'), 'ppt/theme/theme1.xml');
  assert.match(en, /<a:minorFont><a:latin typeface="Calibri"\/><a:ea typeface="Malgun Gothic"\/>/);
});

test('C. master and layouts carry the design: accent bar, dark cover, title rule, footer brand and a slide-number placeholder', () => {
  const zip = deck('ko');
  const master = part(zip, 'ppt/slideMasters/slideMaster1.xml');
  assert.match(master, /name="Accent Bar"[\s\S]*?<a:schemeClr val="accent1"\/>/);
  assert.match(master, /<p:ph type="sldNum" sz="quarter" idx="12"\/>/);
  const cover = part(zip, 'ppt/slideLayouts/slideLayout1.xml');
  assert.match(cover, /<p:bg><p:bgPr><a:solidFill><a:srgbClr val="0F172A"\/>/);
  assert.match(cover, /type="ctrTitle"[\s\S]*?<a:srgbClr val="FFFFFF"\/>/);
  assert.doesNotMatch(cover, /Footer Brand|sldNum/, 'the cover has no footer or number');
  const content = part(zip, 'ppt/slideLayouts/slideLayout2.xml');
  assert.match(content, /name="Title Rule"/);
  assert.match(content, /name="Footer Brand"[\s\S]*?<a:t>NAgex<\/a:t>/);
  assert.match(content, /<p:ph type="sldNum" sz="quarter" idx="12"\/>/);
});

test('D. content slides show their own number through a slidenum field; the cover does not; titles and bodies stay real placeholders', () => {
  const zip = deck('ko');
  assert.doesNotMatch(part(zip, 'ppt/slides/slide1.xml'), /sldNum/);
  for (let n = 2; n <= 4; n += 1) {
    const xml = part(zip, `ppt/slides/slide${n}.xml`);
    assert.equal((xml.match(/<p:ph type="sldNum"/g) ?? []).length, 1, `slide ${n}`);
    assert.match(xml, new RegExp(`type="slidenum"><a:rPr lang="en-US" dirty="0"/><a:t>${n}</a:t>`), `slide ${n} shows ${n}`);
    assert.match(xml, /<p:ph type="title"\/>/);
    assert.match(xml, /<p:ph idx="1"\/>/);
  }
});

test('E. bullets use the accent colour from the theme and the paragraph gap used for fitting is the one the master declares', () => {
  const master = part(deck('en'), 'ppt/slideMasters/slideMaster1.xml');
  assert.match(master, /<a:buClr><a:schemeClr val="accent1"\/><\/a:buClr>/);
  assert.match(master, /<a:lvl1pPr[^>]*>(?:(?!<\/a:lvl1pPr>)[\s\S])*?<a:spcBef><a:spcPts val="1200"\/>/);
});

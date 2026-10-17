// The evaluator that decides whether a produced .docx / .pptx is GOOD - and, as important, that it cannot be fooled into saying so:
//   * a file that merely exists is not quality: a broken package, a missing part or a lying relationship is a TECHNICAL FAIL;
//   * a figure that states something (a percentage, an amount, a count with a unit) must be one the person gave - an invented one fails the file, whoever wrote it;
//   * what only real Word / PowerPoint can tell (opens, overflow, bounds, charts read back, edit and save) is NOT_RUN without its measurements and the verdict is PARTIAL, never PASS;
//   * measurements from the real application override a pleasant-looking file: overflow, a shape outside the slide, tiny text, chart data that differs, an edit that did not survive are each FAIL.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildDocx } from '../src/creation/docx/docx-writer.js';
import { buildRichDeck } from '../src/creation/pptx/rich-deck-writer.js';
import type { RichSlide } from '../src/creation/pptx/rich-deck.types.js';
import { buildZip, readZip } from '../src/creation/pptx/zip-writer.js';
import { evaluateDocx, evaluatePptx, isWellFormed, statLikeNumbers, type Expectation, type PowerPointFacts, type QualityReport, type WordFacts } from '../src/creation/quality/outcome-quality.js';
import { makePng } from './_png.js';

const status = (report: QualityReport, id: string) => report.checks.find((c) => c.id === id)?.status;
const detail = (report: QualityReport, id: string) => report.checks.find((c) => c.id === id)?.detail ?? '';
const CORPUS = '3분기 처리 시간은 1분기 45분, 2분기 32분, 3분기 20분이었습니다. 월 비용은 12,000원, 절감률은 73%입니다. 2026년 기준.';

describe('which figures count', () => {
  it('a figure that states something is checked; ordinals, years, list numbers and steps are not statistics', () => {
    assert.deepEqual(statLikeNumbers('절감 73%, 비용 12,000원, 45분, 3.5배'), ['73', '12000', '45', '3.5']);
    assert.deepEqual(statLikeNumbers('3단계 계획, 2026년, 1. 서론, 제2장, 2~3주'), ['3']); // "2~3주" -> the 3 (a duration with a unit)
    assert.deepEqual(statLikeNumbers('주문 번호 123456 처리'), ['123456'], 'a large plain number states something');
    assert.deepEqual(statLikeNumbers('1999년과 2030년'), []);
  });
});

describe('DOCX', () => {
  const doc = (markdown: string) => buildDocx({ title: '운영 보고서', markdown, locale: 'ko' });
  const GOOD = '## 1. 요약\n\n처리 시간은 1분기 45분에서 3분기 20분으로 줄었고, 절감률은 73%입니다.\n\n## 2. 비용\n\n| 항목 | 값 |\n| --- | --- |\n| 월 비용 | 12,000원 |\n';
  const expectation: Expectation = { corpus: CORPUS, requiredFacts: [{ id: 'saving', text: '73%' }, { id: 'cost', text: '12,000원' }] };

  it('a good document passes every check that can run from the file, and the ones that need Word are NOT_RUN - so the verdict is PARTIAL, not PASS', () => {
    const report = evaluateDocx(doc(GOOD), expectation);
    for (const id of ['PACKAGE_VALID', 'HAS_TITLE', 'HEADINGS_ARE_REAL_AND_ORDERED', 'TABLES_HAVE_HEADER_ROWS', 'PICTURES_HAVE_ALT_TEXT', 'NO_MISSING_PICTURES', 'FOOTER_PAGE_NUMBERS', 'MODERN_COMPATIBILITY_SETTING', 'REQUIRED_FACTS_PRESENT', 'NO_INVENTED_FIGURES']) assert.equal(status(report, id), 'PASS', `${id}: ${detail(report, id)}`);
    for (const id of ['OPENS_IN_WORD', 'NOT_COMPATIBILITY_MODE', 'TABLES_FIT_THE_PAGE', 'EDIT_AND_SAVE_SURVIVES']) assert.equal(status(report, id), 'NOT_RUN', id);
    assert.equal(report.technical, 'PARTIAL');
    assert.equal(report.quality, 'PARTIAL');
  });

  it('an invented figure fails the file; a required fact that is missing fails the file', () => {
    const invented = evaluateDocx(doc(GOOD.replace('73%', '87%')), expectation);
    assert.equal(status(invented, 'NO_INVENTED_FIGURES'), 'FAIL');
    assert.match(detail(invented, 'NO_INVENTED_FIGURES'), /87/);
    assert.equal(status(invented, 'REQUIRED_FACTS_PRESENT'), 'FAIL');
    assert.match(detail(invented, 'REQUIRED_FACTS_PRESENT'), /saving/);
    assert.equal(invented.quality, 'FAIL');
    const plainNumbers = evaluateDocx(doc('## 1. 단계\n\n3단계로 진행합니다. 2026년 계획입니다. 월 비용은 12,000원, 절감률은 73%입니다.'), expectation);
    assert.equal(status(plainNumbers, 'NO_INVENTED_FIGURES'), 'PASS', detail(plainNumbers, 'NO_INVENTED_FIGURES'));
  });

  it('structure: a skipped heading level fails, so does a long text with no headings; a table without a header row fails', () => {
    assert.equal(status(evaluateDocx(doc('## 가\n\n#### 나\n\n본문'), { corpus: '' }), 'HEADINGS_ARE_REAL_AND_ORDERED'), 'FAIL');
    assert.equal(status(evaluateDocx(doc('## 가\n\n### 나\n\n본문'), { corpus: '' }), 'HEADINGS_ARE_REAL_AND_ORDERED'), 'PASS');
    assert.equal(status(evaluateDocx(doc('단어 '.repeat(400)), { corpus: '' }), 'HEADINGS_ARE_REAL_AND_ORDERED'), 'FAIL');
    const noHeader = readZip(doc('| a | b |\n| --- | --- |\n| 1 | 2 |')).map((e) => (e.name === 'word/document.xml' ? { ...e, data: Buffer.from(e.data.toString('utf8').replace('<w:tblHeader/>', ''), 'utf8') } : e));
    assert.equal(status(evaluateDocx(buildZip(noHeader), { corpus: '' }), 'TABLES_HAVE_HEADER_ROWS'), 'FAIL');
  });

  it('pictures: a picture without alt text fails, and a picture that could not be shown fails', () => {
    const withPicture = buildDocx({ title: 'T', markdown: '![](img://a)', locale: 'ko', resolveImage: () => ({ bytes: makePng(40, 20) }) });
    assert.equal(status(evaluateDocx(withPicture, { corpus: '' }), 'PICTURES_HAVE_ALT_TEXT'), 'FAIL', 'no description, no alt text');
    const described = buildDocx({ title: 'T', markdown: '![설명](img://a)', locale: 'ko', resolveImage: () => ({ bytes: makePng(40, 20) }) });
    assert.equal(status(evaluateDocx(described, { corpus: '' }), 'PICTURES_HAVE_ALT_TEXT'), 'PASS');
    const missing = buildDocx({ title: 'T', markdown: '![설명](img://a)', locale: 'ko', resolveImage: () => null });
    assert.equal(status(evaluateDocx(missing, { corpus: '' }), 'NO_MISSING_PICTURES'), 'FAIL');
  });

  it('a broken package is a TECHNICAL fail: not a zip, a part that is not well-formed XML, a relationship to a part that is not there', () => {
    assert.equal(evaluateDocx(Buffer.from('this is not a docx'), { corpus: '' }).technical, 'FAIL');
    const parts = readZip(doc(GOOD));
    const broken = buildZip(parts.map((e) => (e.name === 'word/styles.xml' ? { ...e, data: Buffer.from('<w:styles><w:style></w:styles>') } : e)));
    const brokenReport = evaluateDocx(broken, { corpus: '' });
    assert.equal(status(brokenReport, 'PACKAGE_VALID'), 'FAIL');
    assert.match(detail(brokenReport, 'PACKAGE_VALID'), /styles\.xml is not well-formed/);
    const lying = buildZip(parts.filter((e) => e.name !== 'word/numbering.xml'));
    assert.match(detail(evaluateDocx(lying, { corpus: '' }), 'PACKAGE_VALID'), /numbering/);
    assert.equal(isWellFormed('<a><b/></a>'), true); assert.equal(isWellFormed('<a><b></a>'), false);
  });

  it('what real Word measured decides: Compatibility Mode, a table wider than the text, a picture wider than the text, no live page fields, an edit that did not survive - each FAIL; all good PASS', () => {
    const good: WordFacts = { opened: true, renderedBy: 'Microsoft Word 16.0', compatibilityMode: 15, pages: 2, footer: { pageNumberFields: 2 }, tables: [{ fitsTextWidth: true, headingRowRepeats: true }], inlineShapes: [], fonts: { '맑은 고딕': 50 }, editRoundTrip: { saved: true, reopened: true, editSurvived: true }, problems: [] };
    const ok = evaluateDocx(doc(GOOD), { ...expectation, pages: { min: 1, max: 3 } }, good);
    assert.equal(ok.technical, 'PASS'); assert.equal(ok.quality, 'PASS', ok.checks.filter((c) => c.status !== 'PASS').map((c) => `${c.id}:${c.detail}`).join(' | '));
    const cases: Array<[string, Partial<WordFacts>]> = [
      ['NOT_COMPATIBILITY_MODE', { compatibilityMode: 12 }], ['TABLES_FIT_THE_PAGE', { tables: [{ fitsTextWidth: false, headingRowRepeats: true }] }],
      ['PICTURES_FIT_THE_PAGE', { inlineShapes: [{ fitsTextWidth: false, altText: 'x' }] }], ['FOOTER_FIELDS_LIVE', { footer: { pageNumberFields: 0 } }],
      ['EDIT_AND_SAVE_SURVIVES', { editRoundTrip: { saved: true, reopened: true, editSurvived: false } }], ['PAGE_COUNT_IN_RANGE', { pages: 9 }],
      ['FONTS_CONSISTENT', { fonts: { a: 1, b: 1, c: 1, d: 1 } }],
    ];
    for (const [id, change] of cases) assert.equal(status(evaluateDocx(doc(GOOD), { ...expectation, pages: { min: 1, max: 3 } }, { ...good, ...change }), id), 'FAIL', id);
    assert.equal(evaluateDocx(doc(GOOD), expectation, { ...good, opened: false, problems: ['RENDER_FAILED'] }).technical, 'FAIL');
  });
});

describe('PPTX', () => {
  const bullets = (title: string, items: string[], notes?: string): RichSlide => ({ layout: 'BULLETS', title, bullets: items, notes });
  const chartSlide: RichSlide = { layout: 'CHART', title: '처리 시간이 줄었다', bullets: ['꾸준한 감소'], notes: '막대를 설명합니다', chart: { type: 'BAR', categories: ['1분기', '2분기', '3분기'], series: [{ name: '시간', values: [45, 32, 20] }], unit: '분' } };
  const expectation: Expectation = { corpus: CORPUS, charts: [{ categories: ['1분기', '2분기', '3분기'], values: [45, 32, 20] }], requiredFacts: [{ id: 'saving', text: '73%' }] };
  const build = async (slides: RichSlide[]) => (await buildRichDeck({ title: '운영 보고', locale: 'ko', slides })).buffer;
  const GOOD_SLIDES = [bullets('요약: 절감률은 73%입니다', ['처리 시간이 줄었습니다'], '결론부터 말합니다'), chartSlide];

  const facts = (over: Partial<PowerPointFacts> = {}): PowerPointFacts => ({
    opened: true, renderedBy: 'Microsoft PowerPoint 16.0', slideCount: 3, slideSize: { ratio: 1.7778 }, problems: [],
    slides: [
      { index: 1, title: '운영 보고', notes: '', shapes: [{ name: 'Title 1', type: 14, insideSlide: true, hasText: true, minFontPt: 44, maxFontPt: 44, fontNames: ['Malgun Gothic'], textOverflows: false }] },
      { index: 2, title: '요약', notes: 'n', shapes: [{ name: 'Text 3', type: 14, insideSlide: true, hasText: true, minFontPt: 24, maxFontPt: 24, fontNames: ['Malgun Gothic'], textOverflows: false }, { name: 'Slide Number Placeholder 0', type: 14, insideSlide: true, hasText: true, minFontPt: 10, maxFontPt: 10, fontNames: ['Malgun Gothic'], textOverflows: false }] },
      { index: 3, title: '추이', notes: 'n', shapes: [{ name: 'Chart', type: 3, insideSlide: true, hasChart: true, chart: { series: [{ name: '시간', values: [45, 32, 20], categories: ['1분기', '2분기', '3분기'] }] } }] },
    ],
    editRoundTrip: { saved: true, reopened: true, editSurvived: true }, ...over,
  });

  it('a good deck passes every file-level check; the ones that need PowerPoint are NOT_RUN and the verdict is PARTIAL', async () => {
    const report = evaluatePptx(await build(GOOD_SLIDES), expectation);
    for (const id of ['PACKAGE_VALID', 'SIXTEEN_BY_NINE', 'EVERY_SLIDE_HAS_A_TITLE_PLACEHOLDER', 'CHARTS_ARE_NATIVE_WITH_DATA', 'PICTURES_HAVE_ALT_TEXT', 'SPEAKER_NOTES_PRESENT', 'SLIDES_ARE_NOT_WALLS_OF_TEXT', 'REQUIRED_FACTS_PRESENT', 'NO_INVENTED_FIGURES']) assert.equal(status(report, id), 'PASS', `${id}: ${detail(report, id)}`);
    for (const id of ['OPENS_IN_POWERPOINT', 'NO_TEXT_OVERFLOW', 'EVERYTHING_INSIDE_THE_SLIDE', 'CHART_DATA_AS_EXPECTED', 'EDIT_AND_SAVE_SURVIVES']) assert.equal(status(report, id), 'NOT_RUN', id);
    assert.deepEqual([report.technical, report.quality], ['PARTIAL', 'PARTIAL']);
  });

  it('with PowerPoint\'s measurements and nothing wrong, the deck passes everything', async () => {
    const report = evaluatePptx(await build(GOOD_SLIDES), expectation, facts());
    assert.deepEqual([report.technical, report.quality], ['PASS', 'PASS'], report.checks.filter((c) => c.status !== 'PASS').map((c) => `${c.id}:${c.detail}`).join(' | '));
  });

  it('what PowerPoint measured decides: overflow, a shape outside the slide, text under 12 pt, chart data that is not the person\'s data, an edit that did not survive - each FAIL', async () => {
    const deck = await build(GOOD_SLIDES);
    const slide = (i: number, patch: Record<string, unknown>) => { const f = facts(); (f.slides![i].shapes[0] as unknown as Record<string, unknown>) && Object.assign(f.slides![i].shapes[0], patch); return f; };
    assert.equal(status(evaluatePptx(deck, expectation, slide(1, { textOverflows: true })), 'NO_TEXT_OVERFLOW'), 'FAIL');
    assert.equal(status(evaluatePptx(deck, expectation, slide(1, { insideSlide: false })), 'EVERYTHING_INSIDE_THE_SLIDE'), 'FAIL');
    assert.equal(status(evaluatePptx(deck, expectation, slide(1, { minFontPt: 9 })), 'READABLE_FONT_SIZES'), 'FAIL');
    assert.equal(status(evaluatePptx(deck, expectation, facts({ editRoundTrip: { saved: true, reopened: true, editSurvived: false } })), 'EDIT_AND_SAVE_SURVIVES'), 'FAIL');
    assert.equal(status(evaluatePptx(deck, expectation, slide(2, { chart: { series: [{ name: 's', values: [45, 32, 21], categories: ['1분기', '2분기', '3분기'] }] } })), 'CHART_DATA_AS_EXPECTED'), 'FAIL', 'one value differs');
    assert.equal(status(evaluatePptx(deck, expectation, slide(2, { chart: { series: [{ name: 's', values: [45, 32, 20], categories: ['가', '나', '다'] }] } })), 'CHART_DATA_AS_EXPECTED'), 'FAIL', 'the categories differ');
    assert.equal(status(evaluatePptx(deck, expectation, facts({ opened: false, problems: ['RENDER_FAILED: x'] })), 'OPENS_IN_POWERPOINT'), 'FAIL');
  });

  it('file-level: an invented figure, a wall of text, missing notes, a wrong slide size and a missing title placeholder each fail', async () => {
    assert.equal(status(evaluatePptx(await build([bullets('요약: 절감률은 87%입니다', ['x'], 'n'), chartSlide]), expectation), 'NO_INVENTED_FIGURES'), 'FAIL');
    const wall = await build([bullets('긴 슬라이드', Array.from({ length: 6 }, () => '단어 '.repeat(30)), 'n'), chartSlide]);
    assert.equal(status(evaluatePptx(wall, { corpus: CORPUS }), 'SLIDES_ARE_NOT_WALLS_OF_TEXT'), 'FAIL');
    assert.equal(status(evaluatePptx(await build([bullets('a', ['b']), bullets('c', ['d'])]), { corpus: '' }), 'SPEAKER_NOTES_PRESENT'), 'FAIL');
    const parts = readZip(await build(GOOD_SLIDES));
    const square = buildZip(parts.map((e) => (e.name === 'ppt/presentation.xml' ? { ...e, data: Buffer.from(e.data.toString('utf8').replace('cx="12192000" cy="6858000"', 'cx="9144000" cy="6858000"'), 'utf8') } : e)));
    assert.equal(status(evaluatePptx(square, { corpus: '' }), 'SIXTEEN_BY_NINE'), 'FAIL');
    const untitled = buildZip(parts.map((e) => (e.name === 'ppt/slides/slide2.xml' ? { ...e, data: Buffer.from(e.data.toString('utf8').replace(/type="title"/g, 'type="body"'), 'utf8') } : e)));
    assert.equal(status(evaluatePptx(untitled, { corpus: '' }), 'EVERY_SLIDE_HAS_A_TITLE_PLACEHOLDER'), 'FAIL');
    assert.equal(evaluatePptx(Buffer.from('nope'), { corpus: '' }).technical, 'FAIL');
  });

  it('slide count in range; picture without alt text fails (a picture the writer placed always has it)', async () => {
    const deck = await build(GOOD_SLIDES);
    assert.equal(status(evaluatePptx(deck, { corpus: '', pages: { min: 3, max: 3 } }), 'SLIDE_COUNT_IN_RANGE'), 'PASS');
    assert.equal(status(evaluatePptx(deck, { corpus: '', pages: { min: 5, max: 8 } }), 'SLIDE_COUNT_IN_RANGE'), 'FAIL');
    const withPicture = await build([...GOOD_SLIDES, { layout: 'IMAGE', title: '화면', bullets: ['설명'], image: { bytes: makePng(40, 20), alt: '예시', caption: '그림' }, notes: 'n' }]);
    assert.equal(status(evaluatePptx(withPicture, { corpus: '' }), 'PICTURES_HAVE_ALT_TEXT'), 'PASS');
    const stripped = buildZip(readZip(withPicture).map((e) => (e.name === 'ppt/slides/slide4.xml' ? { ...e, data: Buffer.from(e.data.toString('utf8').replace(/descr="[^"]*"/g, 'descr=""'), 'utf8') } : e)));
    assert.equal(status(evaluatePptx(stripped, { corpus: '' }), 'PICTURES_HAVE_ALT_TEXT'), 'FAIL');
  });
});

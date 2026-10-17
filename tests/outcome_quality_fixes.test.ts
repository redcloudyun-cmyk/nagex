// Defects found by READING what real Word and PowerPoint drew for the first real run (docs/evidence/NAGEX_OUTCOME_QUALITY_20261017.md), each pinned so it cannot come back:
//   * a bar chart on an automatic axis starting at 66% made 73% against 72% look like a big gap - bars start at zero, and the evaluator fails a bar chart that does not;
//   * "30,000$" - a currency symbol stands in front of the amount, other units follow it;
//   * a memo header (To / From / Date on separate lines in NAgex's own view) ran together on one line in Word - a line break in a paragraph stays a line break;
//   * the title printed twice - the document title and a first heading that restates it.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildDocx, isSameTitle, markdownToBodyXml } from '../src/creation/docx/docx-writer.js';
import { buildRichDeck } from '../src/creation/pptx/rich-deck-writer.js';
import type { RichSlide } from '../src/creation/pptx/rich-deck.types.js';
import { buildZip, readZip } from '../src/creation/pptx/zip-writer.js';
import { evaluatePptx, placeholdersIn } from '../src/creation/quality/outcome-quality.js';
import { normalizePresentationOutline } from '../src/model-gateway/presentation-outline.js';
import { demotionNotices } from '../src/creation/executors/presentation-executor.js';

const chartDeck = async (chart: Extract<RichSlide, { layout: 'CHART' }>['chart']) => (await buildRichDeck({ title: 't', locale: 'ko', slides: [{ layout: 'CHART', title: 'c', bullets: ['k'], notes: 'n', chart }] })).buffer;
const chartXml = (zip: Buffer) => readZip(zip).filter((e) => /^ppt\/charts\/chart\d+\.xml$/.test(e.name)).map((e) => e.data.toString('utf8')).at(-1) ?? '';
const status = (zip: Buffer, id: string) => evaluatePptx(zip, { corpus: '' }).checks.find((c) => c.id === id)?.status;

describe('charts tell the truth about size', () => {
  it('a bar chart starts at zero - explicitly, not left to the application\'s automatic axis', async () => {
    const xml = chartXml(await chartDeck({ type: 'BAR', categories: ['가', '나', '다'], series: [{ name: 's', values: [73, 72, 83] }], unit: '%' }));
    assert.match(xml, /<c:valAx>[\s\S]*?<c:min val="0"\/>/);
  });
  it('a bar chart with negative values starts at the lowest value instead (a bar cannot be cut off)', async () => {
    const xml = chartXml(await chartDeck({ type: 'BAR', categories: ['가', '나'], series: [{ name: 's', values: [-5, 10] }] }));
    assert.match(xml, /<c:valAx>[\s\S]*?<c:min val="-5"\/>/);
  });
  it('a currency symbol goes in front of the amount, any other unit after it', async () => {
    const dollars = chartXml(await chartDeck({ type: 'BAR', categories: ['A', 'B'], series: [{ name: 'cost', values: [18000, 9500] }], unit: '$' }));
    assert.match(dollars, /formatCode="&quot;\$&quot;#,##0"/);
    assert.equal(/formatCode="#,##0&quot;\$&quot;"/.test(dollars), false);
    assert.match(chartXml(await chartDeck({ type: 'BAR', categories: ['A', 'B'], series: [{ name: 's', values: [45, 32] }], unit: '분' })), /formatCode="#,##0&quot;분&quot;"/);
    assert.match(chartXml(await chartDeck({ type: 'BAR', categories: ['A', 'B'], series: [{ name: 's', values: [12000, 9000] }], unit: '원' })), /formatCode="#,##0&quot;원&quot;"/);
  });
  it('the evaluator fails a bar chart whose axis is automatic or does not start at zero, and passes one that does', async () => {
    const good = await chartDeck({ type: 'BAR', categories: ['가', '나'], series: [{ name: 's', values: [73, 72] }] });
    assert.equal(status(good, 'BAR_CHARTS_START_AT_ZERO'), 'PASS');
    const tamper = (replace: (xml: string) => string) => buildZip(readZip(good).map((e) => (/^ppt\/charts\/chart\d+\.xml$/.test(e.name) ? { ...e, data: Buffer.from(replace(e.data.toString('utf8')), 'utf8') } : e)));
    assert.equal(status(tamper((xml) => xml.replace(/<c:min val="0"\/>/g, '')), 'BAR_CHARTS_START_AT_ZERO'), 'FAIL', 'automatic axis');
    assert.equal(status(tamper((xml) => xml.replace(/<c:min val="0"\/>/g, '<c:min val="66"/>')), 'BAR_CHARTS_START_AT_ZERO'), 'FAIL', 'axis from 66');
    const line = await chartDeck({ type: 'LINE', categories: ['가', '나'], series: [{ name: 's', values: [73, 72] }] });
    assert.equal(status(line, 'BAR_CHARTS_START_AT_ZERO'), 'PASS', 'no bar chart, nothing to check');
  });
});

describe('a document reads in Word as it reads in NAgex', () => {
  it('lines of one paragraph stay lines: a memo header does not run together', () => {
    const xml = markdownToBodyXml('**To:** 팀\n**From:** 운영\n**Date:** 오늘\n\n다음 문단', 'T');
    assert.equal((xml.match(/<w:br\/>/g) ?? []).length, 2);
    assert.equal((xml.match(/<w:p>/g) ?? []).length, 2, 'two paragraphs: the header block and the next one');
  });
  it('the same title said twice is printed once: contained, or nearly the same words; a different heading is kept', () => {
    assert.equal(isSameTitle('Decision Memo: 12-Week Working-Model Pilot', 'Decision Memo: 12-Week Working-Model Pilot Recommendation'), true);
    assert.equal(isSameTitle('2026년 3분기 운영 보고서', '2026년 3분기 운영 보고서'), true);
    assert.equal(isSameTitle('**운영 보고서**', '운영 보고서'), true);
    assert.equal(isSameTitle('분기 운영 보고서 요약', '요약: 분기 운영 보고서'), true);
    assert.equal(isSameTitle('개요', '2026년 3분기 운영 보고서'), false);
    assert.equal(isSameTitle('', 'x'), false);
    const doc = (md: string) => readZip(buildDocx({ title: 'Decision Memo: Pilot Recommendation', markdown: md, locale: 'en' })).find((e) => e.name === 'word/document.xml')!.data.toString('utf8');
    assert.equal((doc('# Decision Memo: Pilot\n\n## 1. Summary\n\nText').match(/Decision Memo: Pilot/g) ?? []).length, 1, 'title once');
    assert.equal((doc('# Background\n\nText').match(/Background/g) ?? []).length, 1, 'a different first heading is kept');
  });
});

describe('what counts as "content is missing"', () => {
  it('finds placeholders and "withheld" sections in Korean and English, and leaves ordinary text alone', () => {
    for (const text of ['*(입력 필요: 추가 자료가 없습니다)*', '작성을 유보합니다', '해당 항목에 대한 추가 자료가 제공되지 않아', '[To Be Provided]', 'to be determined', 'TBD', 'Lorem ipsum dolor', '[Insert name]', '추후 작성 예정']) assert.ok(placeholdersIn(text).length > 0, text);
    for (const text of ['승인 거절률은 4.2%입니다', 'The pilot runs 12 weeks.', '비용을 확인해야 합니다', 'We will provide the report on Friday.']) assert.deepEqual(placeholdersIn(text), [], text);
  });
});

describe('a slide that only says information is missing never reaches the file', () => {
  const plan = (slides: unknown[]) => normalizePresentationOutline({ title: '보고', slides }, 'r');
  it('is left out, at the position it would have had, and recorded - while a slide with real lines (even next to a placeholder line) stays', () => {
    const outline = plan([
      { title: '요약', bullets: ['처리 시간이 줄었습니다'] },
      { title: '위험과 대응', bullets: ['해당 항목에 대한 추가 자료가 제공되지 않아 작성을 유보합니다.', '추가적인 정보가 확보되는 대로 보완될 예정입니다.'] },
      { title: '비용', bullets: ['월 비용은 12,000원입니다', '[TBD]'] },
      { title: 'Next quarter', bullets: ['To be provided', 'TBD'] },
      { title: '결론', bullets: ['효과가 컸습니다'] },
    ]);
    assert.deepEqual(outline.slides.map((slide) => slide.title), ['요약', '비용', '결론']);
    assert.deepEqual(outline.demotions, [{ slide: 2, layout: 'BULLETS', code: 'PLACEHOLDER_ONLY' }, { slide: 3, layout: 'BULLETS', code: 'PLACEHOLDER_ONLY' }]);
  });
  it('the person is told in their language', () => {
    assert.deepEqual(demotionNotices([{ slide: 5, layout: 'BULLETS', code: 'PLACEHOLDER_ONLY' }], 'ko'), ['5번 슬라이드의 슬라이드: 채울 내용이 없어 뺐어요.']);
    assert.deepEqual(demotionNotices([{ slide: 5, layout: 'BULLETS', code: 'PLACEHOLDER_ONLY' }], 'en'), ['Slide 5 (slide): there was nothing to put on it, so it was left out.']);
  });
  it('ordinary words are not placeholders: a developer\'s "placeholder" or "TODO" slide is untouched', () => {
    const outline = plan([{ title: '입력 컴포넌트', bullets: ['placeholder 속성은 힌트를 보여준다', 'TODO 목록 예시'] }, { title: '다음', bullets: ['TODO 항목을 정리한다'] }]);
    assert.equal(outline.slides.length, 2);
    assert.equal(outline.demotions, undefined);
  });
});

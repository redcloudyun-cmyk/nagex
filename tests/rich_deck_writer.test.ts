// Outcome Quality (C2) - the deck writer for decks with more than bullets (PptxGenJS under NAgex's own structure and font-fit rules).
//
// Deterministic package checks: what is in the file (placeholders, native charts WITH their data, tables, pictures with alt text, notes, sources), that text fits by construction (a font size per block,
// bullets that do not fit continue on the next slide, a long table splits with its header repeated) and that the writer refuses what it cannot draw truthfully. What real PowerPoint DREW is certified
// separately with scripts/office-render.ps1 (docs/evidence/NAGEX_OUTCOME_QUALITY_20261017.md); this suite needs no Office.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildRichDeck, RichDeckError } from '../src/creation/pptx/rich-deck-writer.js';
import type { RichDeck, RichSlide } from '../src/creation/pptx/rich-deck.types.js';
import { readZip } from '../src/creation/pptx/zip-writer.js';
import { xmlText } from '../src/creation/pptx/pptx-writer.js';
import { makeBarsPng, makePng } from './_png.js';

const part = (zip: Buffer, name: string): string => readZip(zip).find((e) => e.name === name)?.data.toString('utf8') ?? '';
const names = (zip: Buffer): string[] => readZip(zip).map((e) => e.name);
const chartPart = (zip: Buffer, index = 0): string => part(zip, names(zip).filter((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n)).sort()[index] ?? '');
const slideParts = (zip: Buffer): string[] => names(zip).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => Number(/(\d+)/.exec(a)![1]) - Number(/(\d+)/.exec(b)![1]));
const sizes = (xml: string): number[] => [...xml.matchAll(/<a:rPr[^>]* sz="(\d+)"/g)].map((m) => Number(m[1]) / 100);

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

const base = (slides: RichSlide[], extra: Partial<RichDeck> = {}): RichDeck => ({ title: '분기 보고', subtitle: '3분기', locale: 'ko', slides, ...extra });
const bullets = (title: string, items: string[], notes?: string): RichSlide => ({ layout: 'BULLETS', title, bullets: items, notes });

describe('the package', () => {
  it('is a 16:9 deck with a cover, the slides asked for and the NAgex masters; the report counts what was built', async () => {
    const { buffer, report } = await buildRichDeck(base([bullets('요약', ['하나', '둘']), bullets('결론', ['셋'])]));
    assert.equal(buffer.subarray(0, 2).toString(), 'PK');
    assert.match(part(buffer, 'ppt/presentation.xml'), /<p:sldSz cx="12192000" cy="6858000"/);
    assert.equal(slideParts(buffer).length, 3);
    assert.equal(report.slideCount, 3);
    assert.deepEqual(report.slides.map((s) => s.layout), ['COVER', 'BULLETS', 'BULLETS']);
    const layouts = names(buffer).filter((n) => /slideLayouts\/slideLayout\d+\.xml$/.test(n)).map((n) => part(buffer, n)).join('');
    assert.match(layouts, /name="NAGEX_CONTENT"/);
    assert.match(layouts, /name="NAGEX_COVER"/);
    for (const name of slideParts(buffer)) assertWellFormed(part(buffer, name), name);
    assert.match(part(buffer, 'docProps/core.xml'), /<dc:title>분기 보고<\/dc:title>/);
    assert.match(part(buffer, 'docProps/core.xml'), /NAgex/);
  });

  it('puts every title and the text of a bullet slide in real placeholders (outline view and screen readers work), in order', async () => {
    const { buffer } = await buildRichDeck(base([bullets('첫 슬라이드', ['가', '나']), bullets('둘째 슬라이드', ['다'])]));
    const [cover, first, second] = slideParts(buffer).map((n) => part(buffer, n));
    assert.match(cover, /type="title"[\s\S]*분기 보고/);
    assert.match(cover, /type="subtitle"|type="body"[\s\S]*3분기/);
    for (const [xml, title] of [[first, '첫 슬라이드'], [second, '둘째 슬라이드']] as const) {
      assert.match(xml, /<p:ph[^>]*type="title"/);
      assert.match(xml, /<p:ph[^>]*type="body"/);
      assert.match(xml, new RegExp(`<a:t>${title}</a:t>`));
    }
    assert.equal((first.match(/<a:buChar/g) ?? []).length, 2, 'real bullets, not typed characters');
  });

  it('carries speaker notes (and only the notes that were written)', async () => {
    const { buffer, report } = await buildRichDeck(base([bullets('요약', ['하나'], '이 슬라이드에서는 결론부터 말합니다.'), bullets('결론', ['둘'])]));
    assert.equal(report.notes, 1);
    assert.equal(report.slides.find((s) => s.title === '요약')?.hasNotes, true);
    assert.equal(report.slides.find((s) => s.title === '결론')?.hasNotes, false);
    assert.ok(names(buffer).some((n) => /notesSlides\/notesSlide\d+\.xml$/.test(n) && part(buffer, n).includes('이 슬라이드에서는 결론부터 말합니다.')));
  });

  it('records what the deck was made from in the cover\'s speaker notes - NOT as an extra slide (a person who named the number of slides gets exactly that many) - and on a closing slide only when asked', async () => {
    const sources = ['2026년 3분기 운영 보고서', 'https://example.org/report'];
    const quiet = await buildRichDeck(base([bullets('요약', ['하나']), bullets('결론', ['둘'])], { sources }));
    assert.equal(slideParts(quiet.buffer).length, 3, 'cover + two slides: no closing slide');
    assert.equal(quiet.report.slides[0].hasNotes, true);
    assert.ok(names(quiet.buffer).some((n) => /notesSlides\/notesSlide\d+\.xml$/.test(n) && part(quiet.buffer, n).includes('2026년 3분기 운영 보고서; https://example.org/report')));
    const closing = await buildRichDeck(base([bullets('요약', ['하나']), bullets('결론', ['둘'])], { sources, sourcesSlide: true }));
    assert.equal(slideParts(closing.buffer).length, 4);
    const last = slideParts(closing.buffer).map((n) => part(closing.buffer, n)).at(-1)!;
    assert.match(last, /참고 자료/);
    assert.match(last, /2026년 3분기 운영 보고서/);
    assert.match(last, /https:\/\/example\.org\/report/);
    assert.equal(closing.report.slides.at(-1)?.layout, 'SOURCES');
    assert.equal(closing.report.slides[0].hasNotes, false, 'the sources are on the slide, not also in the notes');
  });

  it('hostile text is escaped, never interpreted: markup, ampersands, control characters', async () => {
    const hostile = `<script>alert(1)</script> & "x" \u0001\u0007 ]]>`;
    const { buffer } = await buildRichDeck(base([bullets(hostile, [hostile], hostile)], { title: hostile, subtitle: hostile }));
    for (const name of slideParts(buffer)) { assertWellFormed(part(buffer, name), name); assert.equal(part(buffer, name).includes('<script>'), false, name); }
    assert.match(part(buffer, slideParts(buffer)[1]), /&lt;script&gt;/);
  });
});

describe('native charts', () => {
  const chartDeck = (chart: Extract<RichSlide, { layout: 'CHART' }>['chart'], takeaways: string[] = ['요점']): RichDeck => base([{ layout: 'CHART', title: '추이', chart, bullets: takeaways }]);
  const values = (xml: string): number[][] => [...xml.matchAll(/<c:val>[\s\S]*?<\/c:val>/g)].map((m) => [...m[0].matchAll(/<c:v>([^<]*)<\/c:v>/g)].map((v) => Number(v[1])));
  const categories = (xml: string): string[] => [...(/<c:cat>[\s\S]*?<\/c:cat>/.exec(xml)?.[0] ?? '').matchAll(/<c:v>([^<]*)<\/c:v>/g)].map((m) => m[1]);

  it('a bar chart is a real chart part with its data in an embedded workbook (editable in PowerPoint), one colour for one series, the unit in the labels, alt text on the frame', async () => {
    const { buffer, report } = await buildRichDeck(chartDeck({ type: 'BAR', categories: ['1분기', '2분기', '3분기'], series: [{ name: '처리 시간', values: [45, 32, 20] }], unit: '분', sourceNote: '출처: 운영 보고서' }));
    const chart = chartPart(buffer);
    assert.match(chart, /<c:barChart>/);
    assert.deepEqual(categories(chart), ['1분기', '2분기', '3분기']);
    assert.deepEqual(values(chart), [[45, 32, 20]]);
    assert.equal((chart.match(/<c:ser>/g) ?? []).length, 1);
    assert.equal(/<c:dPt>/.test(chart), false, 'one series is one colour, not a colour per bar');
    assert.match(chart, /formatCode="#,##0&quot;분&quot;"/);
    assert.ok(names(buffer).some((n) => /ppt\/embeddings\/.*\.xlsx$/.test(n)), 'the data travels with the chart');
    assert.match(part(buffer, 'ppt/slides/slide2.xml'), /name="Chart" descr="막대 차트\. 처리 시간: 1분기 45분, 2분기 32분, 3분기 20분"/);
    assert.match(part(buffer, 'ppt/slides/slide2.xml'), /출처: 운영 보고서/);
    assert.equal(report.charts, 1);
  });

  it('a line chart with two series has a legend and both series\' values; a pie shows percentages of the whole', async () => {
    const line = await buildRichDeck(chartDeck({ type: 'LINE', categories: ['1월', '2월', '3월'], series: [{ name: '자동화율', values: [20, 35, 48] }, { name: '만족도', values: [62, 70, 74] }], unit: '%' }));
    const lineXml = chartPart(line.buffer);
    assert.match(lineXml, /<c:lineChart>/);
    assert.deepEqual(values(lineXml), [[20, 35, 48], [62, 70, 74]]);
    assert.match(lineXml, /<c:legend>/);
    assert.match(lineXml, /formatCode="#,##0&quot;%&quot;"/);
    const pie = await buildRichDeck(chartDeck({ type: 'PIE', categories: ['모델', '저장소', '운영'], series: [{ name: '비용', values: [55, 25, 20] }] }));
    const pieXml = chartPart(pie.buffer);
    assert.match(pieXml, /<c:pieChart>/);
    assert.deepEqual(values(pieXml), [[55, 25, 20]]);
    assert.match(pieXml, /<c:showPercent val="1"\/>/);
    assert.match(pieXml, /formatCode="0%"/, 'the percentage label formats a fraction (a unit code printed 55 as "1%" in real PowerPoint)');
    assert.equal(/<c:showVal val="1"\/>/.test(pieXml), false);
  });

  it('a chart slide keeps its takeaway beside the chart, and a chart without one takes the full width', async () => {
    const chart = { type: 'BAR' as const, categories: ['가', '나'], series: [{ name: 's', values: [1, 2] }] };
    const withTakeaway = part((await buildRichDeck(chartDeck(chart, ['핵심 한 줄']))).buffer, 'ppt/slides/slide2.xml');
    assert.match(withTakeaway, /핵심 한 줄/);
    const frame = (xml: string) => Number(/<p:graphicFrame>[\s\S]*?<a:ext cx="(\d+)"/.exec(xml)![1]);
    const without = part((await buildRichDeck(chartDeck(chart, []))).buffer, 'ppt/slides/slide2.xml');
    assert.ok(frame(without) > frame(withTakeaway) * 1.3, 'the chart widens when there is nothing beside it');
  });

  it('refuses a chart it cannot draw truthfully: values that do not match the categories, no data, a pie of two series or negative values', async () => {
    const bad = [
      { type: 'BAR' as const, categories: ['가', '나'], series: [{ name: 's', values: [1] }] },
      { type: 'BAR' as const, categories: [], series: [{ name: 's', values: [] }] },
      { type: 'BAR' as const, categories: ['가'], series: [{ name: 's', values: [Number.NaN] }] },
      { type: 'PIE' as const, categories: ['가', '나'], series: [{ name: 'a', values: [1, 2] }, { name: 'b', values: [3, 4] }] },
      { type: 'PIE' as const, categories: ['가', '나'], series: [{ name: 'a', values: [-1, 2] }] },
    ];
    for (const chart of bad) await assert.rejects(() => buildRichDeck(chartDeck(chart)), (e: unknown) => e instanceof RichDeckError && e.code === 'RICH_DECK_CHART_INVALID');
  });
});

describe('tables', () => {
  const table = (rows: string[][], takeaways: string[] = ['요점']): RichDeck => base([{ layout: 'TABLE', title: '비교', table: { headers: ['업무', '시간', '비율', '비고'], rows }, bullets: takeaways }]);
  const cellTexts = (xml: string): string[] => [...xml.matchAll(/<a:tc>[\s\S]*?<\/a:tc>/g)].map((m) => [...m[0].matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((t) => t[1]).join(''));

  it('a short table is one native table: a navy header row, numbers flush right, text flush left', async () => {
    const { buffer, report } = await buildRichDeck(table([['회의', '45분', '73%', '일정 연동'], ['보고서', '3시간', '72%', '출처 검증']]));
    const xml = part(buffer, 'ppt/slides/slide2.xml');
    assert.match(xml, /<a:tbl>/);
    assert.deepEqual(cellTexts(xml).slice(0, 4), ['업무', '시간', '비율', '비고']);
    assert.equal((xml.match(/<a:tr /g) ?? []).length, 3);
    assert.match(xml, /<a:srgbClr val="0F172A"\/>/, 'header fill');
    const aligns = [...xml.matchAll(/<a:tc>[\s\S]*?<a:pPr[^>]*algn="(\w)"/g)].map((m) => m[1]);
    assert.deepEqual(aligns.slice(4, 8), ['l', 'r', 'r', 'l'], 'first body row: text, number, number, text');
    assert.equal(report.tables, 1);
  });

  it('a long table is split over slides, the header row repeats, every row appears once and in order, and the takeaway is on the last slide', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => [`항목 ${i + 1}`, `${i + 1}건`, `${i + 1}%`, '정상']);
    const { buffer, report } = await buildRichDeck(table(rows, ['표 전체에 대한 한 줄']));
    const tableSlides = slideParts(buffer).map((n) => part(buffer, n)).filter((x) => x.includes('<a:tbl>'));
    assert.ok(tableSlides.length >= 2, `split over ${tableSlides.length} slides`);
    const seen: string[] = [];
    tableSlides.forEach((xml, i) => {
      const texts = cellTexts(xml);
      assert.deepEqual(texts.slice(0, 4), ['업무', '시간', '비율', '비고'], `header on slide ${i + 1}`);
      for (let r = 4; r < texts.length; r += 4) seen.push(texts[r]);
      assert.equal(xml.includes('표 전체에 대한 한 줄'), i === tableSlides.length - 1, 'the takeaway only on the last');
    });
    assert.deepEqual(seen, rows.map((r) => r[0]));
    const facts = report.slides.filter((s) => s.layout === 'TABLE');
    assert.equal(facts.length, tableSlides.length);
    assert.deepEqual(facts.map((f) => f.continuation === true), facts.map((_, i) => i > 0));
    assert.match(facts[0].title, new RegExp(`\\(1/${facts.length}\\)$`));
    assert.equal(report.tables, tableSlides.length);
  });

  it('refuses a table without a header or rows, or with a row longer than the header', async () => {
    for (const bad of [{ headers: [], rows: [['a']] }, { headers: ['a'], rows: [] }, { headers: ['a'], rows: [['x', 'y']] }]) {
      await assert.rejects(() => buildRichDeck(base([{ layout: 'TABLE', title: 't', table: bad, bullets: [] }])), (e: unknown) => e instanceof RichDeckError && e.code === 'RICH_DECK_TABLE_INVALID');
    }
  });
});

describe('text that fits', () => {
  it('short text keeps the master size; longer text gets a smaller size chosen to fit - set on the runs, where PowerPoint reads it', async () => {
    const { buffer } = await buildRichDeck(base([bullets('짧은', ['하나', '둘']), bullets('긴', Array.from({ length: 6 }, (_, i) => `여섯 개 중 ${i + 1}번째 항목은 한 줄을 넘길 정도로 길게 작성하여 글자 크기가 줄어드는지 확인합니다 ${'가나다라'.repeat(4)}`))]));
    const [, short, long] = slideParts(buffer).map((n) => part(buffer, n));
    assert.deepEqual([...new Set(sizes(short).filter((s) => s !== 30))], [24]);
    const body = [...new Set(sizes(long).filter((s) => s !== 30))];
    assert.ok(body.every((s) => s >= 16 && s < 24), `shrunk but readable: ${body}`);
  });

  it('bullets that do not fit even at 16 pt continue on the next slide - nothing overflows, nothing is hidden, and the report says so', async () => {
    const heavy = Array.from({ length: 6 }, (_, i) => `${i + 1}. ${'아주 긴 문장입니다 '.repeat(14)}`.trim());
    const { buffer, report } = await buildRichDeck(base([bullets('긴 목록', heavy, '발표자 메모')]));
    const facts = report.slides.filter((s) => s.layout === 'BULLETS');
    assert.ok(facts.length >= 2, 'continued');
    assert.deepEqual(facts.map((f) => f.continuation === true), facts.map((_, i) => i > 0));
    assert.ok(facts.every((f) => !f.tightFit && (f.fontPt ?? 0) >= 16));
    assert.match(facts[0].title, /\(1\/\d+\)$/);
    const text = slideParts(buffer).map((n) => part(buffer, n)).join('');
    for (let i = 1; i <= 6; i += 1) assert.equal(text.includes(`${i}. 아주 긴 문장입니다`), true, `bullet ${i} is somewhere`);
    assert.equal(facts[0].hasNotes && !facts[1].hasNotes, true, 'the notes belong to the first slide only');
  });

  it('a long title shrinks between 18 and 30 pt and never below', async () => {
    const { report } = await buildRichDeck(base([bullets('아주 긴 제목이 들어간 슬라이드는 제목이 두 줄까지 줄어들어도 본문과 겹치지 않아야 합니다 — 길이 시험', ['x'])]));
    const fact = report.slides[1];
    assert.ok(fact.fontPt !== undefined);
    const title = part((await buildRichDeck(base([bullets('아주 긴 제목이 들어간 슬라이드는 제목이 두 줄까지 줄어들어도 본문과 겹치지 않아야 합니다 — 길이 시험', ['x'])]))).buffer, 'ppt/slides/slide2.xml');
    const titleSize = sizes(title)[0];
    assert.ok(titleSize >= 18 && titleSize < 30, `title ${titleSize} pt`);
  });
});

describe('pictures, key figures, quotes and sections', () => {
  it('a picture is placed with its alt text and caption, aspect ratio kept, inside its box; anything but PNG/JPEG is refused', async () => {
    const png = makeBarsPng(1200, 600, [0.4, 0.8]);
    const { buffer, report } = await buildRichDeck(base([{ layout: 'IMAGE', title: '화면', image: { bytes: png, alt: '막대 그래프 예시', caption: '그림 1' }, bullets: ['설명'] }]));
    const media = names(buffer).filter((n) => /^ppt\/media\/[^/]+\.(png|jpe?g)$/.test(n));
    assert.equal(media.length, 1);
    assert.equal(readZip(buffer).find((e) => e.name === media[0])!.data.equals(png), true);
    const xml = part(buffer, 'ppt/slides/slide2.xml');
    assert.match(xml, /<p:pic>[\s\S]*descr="막대 그래프 예시"/);
    const ext = /<p:pic>[\s\S]*?<a:ext cx="(\d+)" cy="(\d+)"/.exec(xml)!;
    assert.ok(Math.abs(Number(ext[1]) / Number(ext[2]) - 2) < 0.02, '2:1 stays 2:1');
    assert.match(xml, /그림 1/);
    assert.equal(report.images, 1);
    for (const bytes of [Buffer.from('GIF89a......'), Buffer.alloc(0), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')]) {
      await assert.rejects(() => buildRichDeck(base([{ layout: 'IMAGE', title: 't', image: { bytes, alt: 'x' }, bullets: ['y'] }])), (e: unknown) => e instanceof RichDeckError && e.code === 'RICH_DECK_IMAGE_UNSUPPORTED');
    }
  });

  it('key figures sit in cards (value, label, note), a quote is centred with its attribution, a section break uses the cover look', async () => {
    const { buffer, report } = await buildRichDeck(base([
      { layout: 'METRICS', title: '핵심', metrics: [{ label: '시간 절감', value: '73%', note: '회의 준비' }, { label: '월 비용', value: '12,000원' }], bullets: ['요점'] },
      { layout: 'QUOTE', title: '원칙', quote: '모델은 추론하고, NAgex는 실행한다.', attribution: 'NAgex', bullets: [] },
      { layout: 'SECTION', title: '다음 단계', subtitle: '확장' , bullets: [] },
    ]));
    const [, metrics, quote, section] = slideParts(buffer).map((n) => part(buffer, n));
    for (const text of ['73%', '시간 절감', '회의 준비', '12,000원', '월 비용']) assert.ok(metrics.includes(text), text);
    assert.equal((metrics.match(/prst="roundRect"/g) ?? []).length, 2, 'one card per figure');
    assert.match(quote, /“모델은 추론하고, NAgex는 실행한다\.”/);
    assert.match(quote, /— NAgex/);
    assert.match(section, /다음 단계/);
    assert.deepEqual(report.slides.map((s) => s.layout), ['COVER', 'METRICS', 'QUOTE', 'SECTION']);
    // a section break is on the cover master (dark), not the white content master
    assert.match(part(buffer, 'ppt/slides/_rels/slide4.xml.rels'), /slideLayout\d+\.xml/);
  });

  it('refuses a deck without a title', async () => {
    await assert.rejects(() => buildRichDeck({ title: '  ', locale: 'en', slides: [] }), (e: unknown) => e instanceof RichDeckError && e.code === 'RICH_DECK_EMPTY');
  });

  it('English decks use Calibri and the English language tag', async () => {
    const { buffer } = await buildRichDeck({ title: 'Quarterly review', locale: 'en', slides: [bullets('Summary', ['One', 'Two'])] });
    const xml = part(buffer, 'ppt/slides/slide2.xml');
    assert.match(xml, /lang="en-US"/);
    assert.match(xml, /typeface="Calibri"/);
    assert.equal(xml.includes('Malgun'), false);
    assert.equal(xmlText('a&b'), 'a&amp;b');
  });
});

describe('the same plan twice', () => {
  it('builds the same slides (same layouts, titles, sizes, counts) - only the package timestamp may differ', async () => {
    const deck = base([bullets('요약', ['하나', '둘'], '메모'), { layout: 'CHART', title: '추이', chart: { type: 'BAR', categories: ['가', '나'], series: [{ name: 's', values: [1, 2] }] }, bullets: ['요점'] }]);
    const a = await buildRichDeck(deck); const b = await buildRichDeck(deck);
    assert.deepEqual(a.report, b.report);
    assert.deepEqual(slideParts(a.buffer).map((n) => part(a.buffer, n)), slideParts(b.buffer).map((n) => part(b.buffer, n)));
    assert.equal(makePng(2, 2).length > 0, true);
  });
});

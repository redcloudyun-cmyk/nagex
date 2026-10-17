// Outcome Quality (C2) - the path from "make a deck" to a file with charts, key figures, tables, pictures and notes - and the rules that keep it honest:
//   * the plan is checked strictly: a visual that does not parse is demoted to text (and said so), never repaired by guessing;
//   * the NUMBERS of a visual must be the person's (request, instructions, source documents, memory): an invented figure never reaches a chart;
//   * pictures are the person's own, owner-checked, PNG/JPEG, and reach the model only as references;
//   * a person who named the number of slides gets exactly that many; what the file contains beyond bullets is reported as facts.
// The model is a deterministic stand-in; the plan checks, stores, router, executor and file writer are the real code.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { NagexError } from '../src/common/errors.js';
import { normalizePresentationOutline, outlineToMarkdown, parseLooseNumber, type PresentationOutline } from '../src/model-gateway/presentation-outline.js';
import { groundingCorpus, groundOutline, numbersIn } from '../src/creation/pptx/number-grounding.js';
import { demotionNotices, PresentationExecutor } from '../src/creation/executors/presentation-executor.js';
import { PresentationStore } from '../src/creation/presentation.store.js';
import { CreationProviderRouter } from '../src/creation/providers/creation-provider-router.js';
import { LocalPptxPresentationAdapter } from '../src/creation/providers/adapters/local-pptx-adapter.js';
import { CreationRuntime } from '../src/creation/creation-runtime.js';
import { ArtifactStore } from '../src/artifacts/artifact.store.js';
import { DocumentStore } from '../src/creation/document.store.js';
import { ImageStore } from '../src/creation/image.store.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { readZip } from '../src/creation/pptx/zip-writer.js';
import { makeBarsPng } from './_png.js';

const tempDir = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), name));
const T = 'ten_rich'; const U = 'usr_rich';

// ── the plan ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('the plan: layouts are parsed strictly', () => {
  const plan = (slides: unknown[], extra: Record<string, unknown> = {}) => normalizePresentationOutline({ title: '분기 보고', slides, ...extra }, 'r1');
  const text = (title: string) => ({ title, bullets: ['요점'] });

  it('keeps a valid chart, key figures, a table, a picture reference, a quote, a section and the notes - numbers written loosely ("1,200", "73%") become numbers', () => {
    const outline = plan([
      { layout: 'chart', title: '추이', bullets: ['감소'], notes: '막대를 설명합니다', chart: { type: 'bar', categories: ['1분기', '2분기'], series: [{ name: '시간', values: ['45', '1,200'] }], unit: '분' } },
      { layout: 'METRICS', title: '핵심', bullets: ['요점'], metrics: [{ label: '절감', value: 73, note: '준비' }, { label: '비용', value: '12,000원' }] },
      { layout: 'TABLE', title: '비교', bullets: ['요점'], table: { headers: ['업무', '시간'], rows: [['회의', '45분'], ['보고서']] } },
      { layout: 'IMAGE', title: '화면', bullets: ['설명'], image: { ref: 'image_1', alt: '예시', caption: '그림 1' } },
      { layout: 'QUOTE', title: '원칙', quote: '문장', attribution: '누구', bullets: [] },
      { layout: 'SECTION', title: '다음', subtitle: '확장' },
      text('마무리'),
    ]);
    const [chart, metrics, table, image, quote, section] = outline.slides;
    assert.equal(chart.layout, 'CHART');
    assert.deepEqual(chart.chart!.series[0].values, [45, 1200]);
    assert.equal(chart.notes, '막대를 설명합니다');
    assert.deepEqual(metrics.metrics, [{ label: '절감', value: '73', note: '준비' }, { label: '비용', value: '12,000원' }]);
    assert.deepEqual(table.table!.rows[1], ['보고서', ''], 'a short row is padded, not rejected');
    assert.deepEqual(image.image, { ref: 'image_1', alt: '예시', caption: '그림 1' });
    assert.equal(quote.quote, '문장'); assert.equal(quote.attribution, '누구');
    assert.deepEqual([section.layout, section.subtitle, section.bullets], ['SECTION', '확장', []]);
    assert.equal(outline.demotions, undefined);
  });

  it('a visual that does not parse becomes a bullet slide at its own position and is RECORDED; with nothing to say it is dropped; it is never repaired by guessing', () => {
    const outline = plan([
      text('하나'),
      { layout: 'CHART', title: '값이 모자란 차트', bullets: ['요점'], chart: { type: 'BAR', categories: ['가', '나'], series: [{ name: 's', values: [1] }] } },
      { layout: 'CHART', title: '파이 두 계열', bullets: ['요점'], chart: { type: 'PIE', categories: ['가', '나'], series: [{ name: 'a', values: [1, 2] }, { name: 'b', values: [3, 4] }] } },
      { layout: 'TABLE', title: '긴 행', bullets: ['요점'], table: { headers: ['a', 'b'], rows: [['1', '2', '3']] } },
      { layout: 'METRICS', title: '하나뿐', bullets: ['요점'], metrics: [{ label: 'x', value: '1' }] },
      { layout: 'QUOTE', title: '인용 없음', bullets: ['요점'] },
      { layout: 'IMAGE', title: '참조 없음', bullets: ['요점'], image: { ref: 'http://evil.example/x.png' } },
      { layout: 'CHART', title: '말할 것이 없는 차트', chart: { type: 'BAR', categories: ['가'], series: [] } },
    ]);
    assert.deepEqual(outline.slides.map((s) => [s.title, s.layout]), [['하나', undefined], ['값이 모자란 차트', undefined], ['파이 두 계열', undefined], ['긴 행', undefined], ['하나뿐', undefined], ['인용 없음', undefined], ['참조 없음', undefined]]);
    assert.deepEqual(outline.demotions, [
      { slide: 2, layout: 'CHART', code: 'CHART_INVALID' }, { slide: 3, layout: 'CHART', code: 'CHART_INVALID' }, { slide: 4, layout: 'TABLE', code: 'TABLE_INVALID' },
      { slide: 5, layout: 'METRICS', code: 'METRICS_INVALID' }, { slide: 6, layout: 'QUOTE', code: 'QUOTE_INVALID' }, { slide: 7, layout: 'IMAGE', code: 'IMAGE_INVALID' },
    ]);
    for (const slide of outline.slides) assert.equal('chart' in slide || 'table' in slide || 'metrics' in slide || 'image' in slide, false);
  });

  it('bounds what a slide may carry: three short takeaways on a visual, six bullets on a text slide, notes cut, unknown layouts are plain bullets, section/quote need no bullets', () => {
    const long = 'x'.repeat(300);
    const outline = plan([
      { layout: 'CHART', title: 'c', bullets: [long, 'b', 'c', 'd', 'e'], notes: long.repeat(5), chart: { type: 'LINE', categories: ['a', 'b'], series: [{ name: 's', values: [1, 2] }] } },
      { layout: 'WHATEVER', title: 'u', bullets: Array.from({ length: 9 }, (_, i) => `b${i}`) },
    ]);
    assert.equal(outline.slides[0].bullets.length, 3);
    assert.ok(outline.slides[0].bullets[0].length <= 100);
    assert.ok((outline.slides[0].notes ?? '').length <= 600);
    assert.equal(outline.slides[1].layout, undefined);
    assert.equal(outline.slides[1].bullets.length, 6);
  });

  it('a section break is a slide but not "content": a deck of one real slide and a divider is still too thin; a plain deck is exactly as before', () => {
    assert.throws(() => plan([text('하나'), { layout: 'SECTION', title: '구분' }]), (e: unknown) => e instanceof NagexError && e.code === 'EMPTY_GENERATION');
    const plain = plan([text('하나'), text('둘')]);
    assert.deepEqual(plain.slides, [{ title: '하나', bullets: ['요점'] }, { title: '둘', bullets: ['요점'] }]);
    assert.equal('demotions' in plain, false);
    assert.equal(outlineToMarkdown(plain), '# 분기 보고\n\n## 1. 하나\n- 요점\n\n## 2. 둘\n- 요점');
  });

  it('reads loose numbers and refuses what is not a number', () => {
    assert.equal(parseLooseNumber('1,200'), 1200); assert.equal(parseLooseNumber('73%'), 73); assert.equal(parseLooseNumber(' -3.5 '), -3.5); assert.equal(parseLooseNumber(7), 7);
    for (const bad of ['', 'abc', '12abc', null, undefined, Number.NaN, Number.POSITIVE_INFINITY, {}]) assert.equal(parseLooseNumber(bad), null, String(bad));
  });

  it('the preview prints a visual\'s data as text - the content reads without the picture', () => {
    const outline = plan([
      { layout: 'CHART', title: '추이', bullets: ['감소'], chart: { type: 'BAR', categories: ['1분기', '2분기'], series: [{ name: '시간', values: [45, 32] }], unit: '분', sourceNote: '출처: 보고서' } },
      { layout: 'TABLE', title: '비교', bullets: ['요점'], table: { headers: ['업무', '시간'], rows: [['회의|준비', '45분']] } },
      { layout: 'METRICS', title: '핵심', bullets: ['요점'], metrics: [{ label: '절감', value: '73%', note: '준비' }, { label: '비용', value: '1' }] },
      { layout: 'QUOTE', title: '원칙', quote: '문장', attribution: '누구', bullets: [], notes: '메모' },
    ]);
    const md = outlineToMarkdown(outline);
    assert.match(md, /\| 1분기 \| 45 \|/);
    assert.match(md, /_Chart \(bar, 분\)_/);
    assert.match(md, /\| 회의\\\|준비 \| 45분 \|/, 'a pipe inside a cell is escaped');
    assert.match(md, /\*\*73%\*\* 절감 \(준비\)/);
    assert.match(md, /> “문장” — 누구/);
    assert.match(md, /_Notes: 메모_/);
  });
});

// ── the figures ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('the figures of a visual must be the person\'s', () => {
  const deck = (...slides: Array<Record<string, unknown>>): PresentationOutline => normalizePresentationOutline({ title: 'T', slides: [{ title: 'a', bullets: ['x'] }, ...slides] }, 'r');
  const chart = (values: number[], extra: Record<string, unknown> = {}) => ({ layout: 'CHART', title: '추이', bullets: ['요점'], chart: { type: 'BAR', categories: ['가', '나', '다'], series: [{ name: 's', values }] }, ...extra });

  it('compares numbers, not spellings: 1,200 = 1200, 12.50 = 12.5, 007 = 7, and every number in a text is collected', () => {
    assert.deepEqual(numbersIn('매출 1,200원, 증가율 12.50%, 코드 007'), ['1200', '12.5', '7']);
    assert.deepEqual(numbersIn('숫자 없음'), []);
    assert.equal(groundingCorpus('1,200', undefined, null, '3.0').has('3'), true);
  });

  it('keeps a chart whose every value is in what the person gave, demotes one with a single invented value, and records it', () => {
    const known = groundingCorpus('분기별 처리 시간은 45, 32, 20분이었습니다.');
    const kept = groundOutline(deck(chart([45, 32, 20])), known);
    assert.equal(kept.outline.slides[1].layout, 'CHART');
    assert.deepEqual(kept.demotions, []);
    const demoted = groundOutline(deck(chart([45, 32, 21])), known);
    assert.equal(demoted.outline.slides[1].layout, undefined);
    assert.equal('chart' in demoted.outline.slides[1], false);
    assert.deepEqual(demoted.outline.slides[1].bullets, ['요점'], 'the takeaways stay');
    assert.deepEqual(demoted.demotions, [{ slide: 2, layout: 'CHART', code: 'UNGROUNDED_NUMBERS' }]);
    assert.deepEqual(demoted.outline.demotions, demoted.demotions);
  });

  it('a number the model COMPUTED (a sum, a difference, a rounding) is not the person\'s - it is demoted too', () => {
    const known = groundingCorpus('1분기 100, 2분기 150');
    assert.equal(groundOutline(deck(chart([100, 150, 250])), known).demotions.length, 1, 'the total was not given');
    assert.equal(groundOutline(deck(chart([100, 150, 125])), known).demotions.length, 1, 'neither was the average');
  });

  it('key figures and numeric table cells are checked the same way; labels and words are not figures', () => {
    const known = groundingCorpus('절감 73%, 비용 12,000원');
    const metrics = (value: string) => ({ layout: 'METRICS', title: '핵심', bullets: ['요점'], metrics: [{ label: '절감', value }, { label: '비용', value: '12,000원' }] });
    assert.equal(groundOutline(deck(metrics('73%')), known).demotions.length, 0);
    assert.equal(groundOutline(deck(metrics('74%')), known).demotions.length, 1);
    const table = (cell: string) => ({ layout: 'TABLE', title: '비교', bullets: ['요점'], table: { headers: ['항목', '값'], rows: [['1분기 매출', cell], ['비고', '확인 필요']] } });
    assert.equal(groundOutline(deck(table('73%')), known).demotions.length, 0, '"1분기" is a label, not a figure');
    assert.equal(groundOutline(deck(table('99%')), known).demotions.length, 1);
    const words = { layout: 'TABLE', title: '비교', bullets: ['요점'], table: { headers: ['항목', '설명'], rows: [['가', '좋음'], ['나', '보통']] } };
    assert.equal(groundOutline(deck(words), groundingCorpus('')).demotions.length, 0, 'a table of words states no figure');
  });

  it('slides that state no figure are untouched, and the input outline is never changed', () => {
    const input = deck({ layout: 'QUOTE', title: 'q', quote: '인용', bullets: [] }, chart([9, 9, 9]));
    const before = JSON.stringify(input);
    const result = groundOutline(input, groundingCorpus(''));
    assert.equal(JSON.stringify(input), before);
    assert.equal(result.outline.slides[1].layout, 'QUOTE');
    assert.equal(result.demotions.length, 1);
  });

  it('says it in the person\'s language: which slide, which visual, why', () => {
    const demotions = [{ slide: 2, layout: 'CHART' as const, code: 'UNGROUNDED_NUMBERS' as const }, { slide: 4, layout: 'IMAGE' as const, code: 'IMAGE_NOT_AVAILABLE' as const }, { slide: 5, layout: 'TABLE' as const, code: 'TABLE_INVALID' as const }];
    assert.deepEqual(demotionNotices(demotions, 'ko'), ['2번 슬라이드의 차트: 수치가 요청이나 자료에 없어 글로 바꿨어요.', '4번 슬라이드의 그림: 사용할 수 있는 그림이 없어 글로 바꿨어요.', '5번 슬라이드의 표: 형식이 맞지 않아 글로 바꿨어요.']);
    assert.match(demotionNotices(demotions, 'en')[0], /^Slide 2 \(chart\): its figures are not in your request or sources/);
  });
});

// ── the executor ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function rig(raw: (input: any) => Record<string, unknown>, opts: { withImageStore?: boolean } = {}) {
  const seen: any[] = [];
  const aiService: any = { presentationOutline: async (input: any) => { seen.push(input); return { data: normalizePresentationOutline(raw(input), input.requestId ?? 'r', { contentSlides: input.contentSlides }), provider: 'stand-in', model: 'm', latencyMs: 1, requestId: input.requestId }; } };
  const presentationStore = new PresentationStore({ metaDir: tempDir('rp-meta-'), bytesDir: tempDir('rp-bytes-') });
  const artifactStore = new ArtifactStore({ dir: tempDir('rp-art-') });
  const documentStore = new DocumentStore({ dir: tempDir('rp-doc-') });
  const imageStore = new ImageStore({ metaDir: tempDir('rp-img-meta-'), bytesDir: tempDir('rp-img-bytes-') });
  const providerRouter = new CreationProviderRouter();
  providerRouter.registerPresentationProvider(new LocalPptxPresentationAdapter());
  const auditLogger = new AuditLogger();
  const executor = new PresentationExecutor({ aiService, presentationStore, providerRouter, artifactStore, documentStore, ...(opts.withImageStore === false ? {} : { imageStore }), auditLogger });
  const runtime = new CreationRuntime([executor]);
  return { seen, runtime, executor, presentationStore, artifactStore, documentStore, imageStore };
}
const request = { creationKind: 'PRESENTATION' as const, tenantId: T, ownerId: U, requestId: 'req_rich' };
const parts = (bytes: Buffer, pattern: RegExp) => readZip(bytes).filter((e) => pattern.test(e.name));
const chartSlide = (values: number[]) => ({ layout: 'CHART', title: '처리 시간이 줄었다', bullets: ['꾸준한 감소'], notes: '막대를 설명합니다.', chart: { type: 'BAR', categories: ['1분기', '2분기', '3분기'], series: [{ name: '분', values }], unit: '분', sourceNote: '출처: 운영 보고서' } });

describe('the executor: a deck whose visuals are the person\'s', () => {
  it('a chart whose numbers are in the request becomes a NATIVE chart; the result says what the deck contains, and the stored deck keeps its data', async () => {
    const rt = rig(() => ({ title: '운영 보고', slides: [{ title: '요약', bullets: ['시간이 줄었다'], notes: '결론부터' }, chartSlide([45, 32, 20])] }));
    const result = await rt.runtime.create({ ...request, prompt: '운영 보고 발표자료를 만들어줘. 처리 시간은 1분기 45분, 2분기 32분, 3분기 20분이었어.', options: { locale: 'ko' } });
    assert.equal(result.status, 'SUCCESS', String(result.errorMessage));
    const record = rt.presentationStore.get(result.creationId, T, U)!;
    const bytes = rt.presentationStore.getBinary(record.binaryStoragePath)!;
    assert.equal(parts(bytes, /^ppt\/charts\/chart\d+\.xml$/).length, 1);
    assert.ok(parts(bytes, /\.xlsx$/).length >= 1, 'the chart\'s data travels with it');
    assert.deepEqual(result.metadata!.visuals, { charts: 1, tables: 0, images: 0, speakerNotes: 2 });
    assert.equal('demotions' in result.metadata!, false);
    assert.equal(record.slides[1].chart!.series[0].values.join(','), '45,32,20');
    assert.equal(record.slides[1].notes, '막대를 설명합니다.');
    assert.match(result.content, /\| 1분기 \| 45 \|/);
  });

  it('a chart with an invented number is NOT drawn: the slide is its takeaways, the person is told which slide and why, nothing about it is in the file', async () => {
    const rt = rig(() => ({ title: '운영 보고', slides: [{ title: '요약', bullets: ['시간이 줄었다'] }, chartSlide([45, 32, 21])] }));
    const result = await rt.runtime.create({ ...request, prompt: '운영 보고 발표자료. 처리 시간은 1분기 45분, 2분기 32분, 3분기 20분이었어.', options: { locale: 'ko' } });
    assert.equal(result.status, 'SUCCESS');
    const record = rt.presentationStore.get(result.creationId, T, U)!;
    const bytes = rt.presentationStore.getBinary(record.binaryStoragePath)!;
    assert.equal(parts(bytes, /^ppt\/(charts\/(_rels\/)?[^/]+\.(xml|rels)|embeddings\/[^/]+)$/).length, 0, 'no chart part and no embedded workbook at all (only the empty folders every package has)');
    assert.deepEqual(result.metadata!.demotions, [{ slide: 2, layout: 'CHART', code: 'UNGROUNDED_NUMBERS' }]);
    assert.deepEqual(result.metadata!.notices, ['2번 슬라이드의 차트: 수치가 요청이나 자료에 없어 글로 바꿨어요.']);
    assert.match(result.content, /> ※ 2번 슬라이드의 차트: 수치가 요청이나 자료에 없어 글로 바꿨어요\./);
    assert.equal('chart' in record.slides[1], false);
    assert.equal(JSON.stringify(record.slides).includes('"21"') || JSON.stringify(record.slides).includes(',21'), false, 'the invented figure is not stored either');
    assert.equal(readZip(bytes).some((e) => e.data.includes(Buffer.from('>21<'))), false);
  });

  it('figures from the person\'s own SOURCE DOCUMENT ground a chart, and the exact slide count asked for is kept (the source titles go to the cover notes, not to an extra slide)', async () => {
    const rt = rig(() => ({ title: '보고', slides: [{ title: '요약', bullets: ['a'] }, chartSlide([45, 32, 20]), { title: '결론', bullets: ['b'] }] }));
    const now = new Date().toISOString();
    rt.documentStore.save({ documentId: 'doc_src', tenantId: T, ownerId: U, title: '2026년 운영 보고서', summary: 's', content: '처리 시간: 45분, 32분, 20분', documentKind: 'REPORT', locale: 'ko', format: 'MARKDOWN', sourceRefs: [], createdAt: now, updatedAt: now } as never);
    const art = rt.artifactStore.saveCompleted({ tenantId: T, ownerId: U, type: 'DOCUMENT', title: '2026년 운영 보고서', preview: 's', sourceType: 'CAPTURE', sourceId: 'doc_src', openTarget: '/x' });
    const result = await rt.runtime.create({ ...request, prompt: '운영 보고서로 4장짜리 발표자료를 만들어줘', sourceRefs: [{ type: 'ARTIFACT', id: art.artifactId }], options: { locale: 'ko' } });
    assert.equal(result.status, 'SUCCESS', String(result.errorMessage));
    const bytes = rt.presentationStore.getBinary(rt.presentationStore.get(result.creationId, T, U)!.binaryStoragePath)!;
    assert.equal(parts(bytes, /^ppt\/slides\/slide\d+\.xml$/).length, 4, 'cover + 3 slides = "4장"');
    assert.equal(parts(bytes, /^ppt\/charts\/chart\d+\.xml$/).length, 1, 'grounded in the document');
    const notes = parts(bytes, /notesSlides\/notesSlide\d+\.xml$/).map((e) => e.data.toString('utf8')).join('');
    assert.match(notes, /2026년 운영 보고서/, 'recorded in the cover notes');
  });

  it('a revision may keep the figures of the deck it revises', async () => {
    let step = 0;
    const rt = rig(() => ({ title: '운영 보고', slides: [{ title: '요약', bullets: ['a'] }, step++ === 0 ? chartSlide([45, 32, 20]) : { ...chartSlide([45, 32, 20]), title: '수정된 제목' }] }));
    const first = await rt.runtime.create({ ...request, prompt: '운영 보고. 처리 시간은 45분, 32분, 20분이었어.', options: { locale: 'ko' } });
    assert.equal(first.status, 'SUCCESS');
    const revised = await rt.executor.executeRevision({ parentPresentationId: first.creationId, instruction: '제목을 다듬어줘', tenantId: T, ownerId: U, requestId: 'req_rev', locale: 'ko' });
    assert.equal(revised.status, 'SUCCESS', String(revised.errorMessage));
    assert.equal(revised.metadata!.demotions, undefined, 'the figures were the person\'s when the deck was made and still are');
    assert.deepEqual((revised.metadata as any).visuals.charts, 1);
  });

  it('a plain deck (no layouts, no notes) keeps exactly the keys it always had', async () => {
    const rt = rig(() => ({ title: '계획', slides: [{ title: '목표', bullets: ['a'] }, { title: '일정', bullets: ['b'] }] }));
    const result = await rt.runtime.create({ ...request, prompt: '계획 발표자료', options: { locale: 'ko' } });
    assert.deepEqual(Object.keys(result.metadata!).sort(), ['byteLength', 'downloadTarget', 'slideCount']);
  });
});

describe('the executor: pictures are the person\'s own and arrive by reference', () => {
  const png = makeBarsPng(1200, 600, [0.5, 0.9, 0.7]);
  const seedImage = (rt: ReturnType<typeof rig>, owner: string, bytes: Buffer, mime = 'image/png', title = '막대그래프') => {
    const imageId = `img_${crypto_hex(owner + title)}`;
    const now = new Date().toISOString();
    rt.imageStore.save({ imageId, tenantId: T, ownerId: owner, title, prompt: title, aspectRatio: '2:1', mimeType: mime, width: 1200, height: 600, binaryStoragePath: rt.imageStore.saveBinary(imageId, bytes, mime), revisionIndex: 1, sourceRefs: [], providerExecutionMetadata: { providerId: 'fixture', createdAt: now } as never, createdAt: now, updatedAt: now });
    return rt.artifactStore.saveCompleted({ tenantId: T, ownerId: owner, type: 'IMAGE', title, preview: title, sourceType: 'CAPTURE', sourceId: imageId, openTarget: `/api/v1/creations/images/${imageId}` });
  };
  function crypto_hex(seed: string): string { let h = 0; for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h.toString(16).padStart(8, '0').repeat(3); }
  const imageSlide = (ref: string) => ({ layout: 'IMAGE', title: '화면', bullets: ['설명'], image: { ref, alt: '막대그래프 예시', caption: '그림 1' } });

  it('the planner is OFFERED the person\'s image under a reference (never an id or a URL); the slide that uses it carries its bytes into the file; the stored deck keeps only the reference', async () => {
    const rt = rig(() => ({ title: '화면 소개', slides: [{ title: '개요', bullets: ['a'] }, imageSlide('image_1')] }));
    const art = seedImage(rt, U, png);
    const result = await rt.runtime.create({ ...request, prompt: '이 그림으로 발표자료를 만들어줘', sourceRefs: [{ type: 'ARTIFACT', id: art.artifactId }], options: { locale: 'ko' } });
    assert.equal(result.status, 'SUCCESS', String(result.errorMessage));
    assert.deepEqual(rt.seen[0].images, [{ ref: 'image_1', title: '막대그래프' }]);
    assert.equal(JSON.stringify(rt.seen[0].images).includes('img_'), false, 'the model never sees a store id');
    const record = rt.presentationStore.get(result.creationId, T, U)!;
    const bytes = rt.presentationStore.getBinary(record.binaryStoragePath)!;
    const media = parts(bytes, /^ppt\/media\/[^/]+\.png$/);
    assert.equal(media.length, 1);
    assert.equal(media[0].data.equals(png), true);
    assert.deepEqual((result.metadata as any).visuals, { charts: 0, tables: 0, images: 1, speakerNotes: 0 });
    assert.deepEqual(record.slides[1].image, { ref: 'image_1', alt: '막대그래프 예시', caption: '그림 1' });
    assert.equal(JSON.stringify(record).includes(png.subarray(0, 24).toString('base64')), false, 'no picture bytes in the stored record');
  });

  it('a reference the planner was NOT offered (or a made-up one) is not drawn: the slide is text and the person is told', async () => {
    const rt = rig(() => ({ title: '화면 소개', slides: [{ title: '개요', bullets: ['a'] }, imageSlide('image_9')] }));
    const art = seedImage(rt, U, png);
    const result = await rt.runtime.create({ ...request, prompt: '그림으로 발표자료', sourceRefs: [{ type: 'ARTIFACT', id: art.artifactId }], options: { locale: 'ko' } });
    assert.equal(result.status, 'SUCCESS');
    assert.deepEqual(result.metadata!.demotions, [{ slide: 2, layout: 'IMAGE', code: 'IMAGE_NOT_AVAILABLE' }]);
    assert.equal(parts(rt.presentationStore.getBinary(rt.presentationStore.get(result.creationId, T, U)!.binaryStoragePath)!, /^ppt\/media\/[^/]+\.png$/).length, 0);
    const noPictures = rig(() => ({ title: '화면 소개', slides: [{ title: '개요', bullets: ['a'] }, imageSlide('image_1')] }));
    const none = await noPictures.runtime.create({ ...request, prompt: '발표자료', options: { locale: 'ko' } });
    assert.equal(none.metadata!.demotions && (none.metadata!.demotions as any[])[0].code, 'IMAGE_NOT_AVAILABLE');
    assert.deepEqual(noPictures.seen[0].images, [], 'no picture was offered');
  });

  it('someone else\'s image is refused like any foreign reference; an image that is not a PNG/JPEG, or an unavailable image store, offers nothing', async () => {
    const rt = rig(() => ({ title: 'x', slides: [{ title: 'a', bullets: ['a'] }, { title: 'b', bullets: ['b'] }] }));
    const theirs = seedImage(rt, 'usr_other', png, 'image/png', '남의 그림');
    const foreign = await rt.runtime.create({ ...request, prompt: '발표자료', sourceRefs: [{ type: 'ARTIFACT', id: theirs.artifactId }] });
    assert.equal(foreign.status, 'FAILED');
    assert.equal(foreign.errorCode, 'UNAUTHORIZED_REFERENCE');
    assert.equal(rt.seen.length, 0, 'the model was never asked');

    const gif = seedImage(rt, U, Buffer.from('GIF89a-not-a-png-or-jpeg-just-bytes-here'), 'image/gif', 'GIF');
    const ok = await rt.runtime.create({ ...request, prompt: '발표자료', sourceRefs: [{ type: 'ARTIFACT', id: gif.artifactId }] });
    assert.equal(ok.status, 'SUCCESS');
    assert.deepEqual(rt.seen[0].images, [], 'a GIF is never offered');

    const bare = rig(() => ({ title: 'x', slides: [{ title: 'a', bullets: ['a'] }, { title: 'b', bullets: ['b'] }] }), { withImageStore: false });
    const mine = seedImage(rig(() => ({})), U, png);
    const noStore = await bare.runtime.create({ ...request, prompt: '발표자료', sourceRefs: [{ type: 'ARTIFACT', id: mine.artifactId }] });
    assert.equal(noStore.status === 'SUCCESS' || noStore.errorCode === 'UNAUTHORIZED_REFERENCE', true);
  });
});

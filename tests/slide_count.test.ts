// "8장짜리 발표자료" produced 9 slides in a real run: the model read 8 as the number of CONTENT slides and the writer added the title slide. The number the person names is the TOTAL (title slide
// included) unless they say otherwise; the model is told an exact number of content slides, extra slides it returns are cut, and the finished file has the number that was asked for.
// Fake provider endpoint: this proves the parsing, the prompt and the control flow - the real-model run is part of the sprint E2E.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { requestedSlideCount, slideCountInstruction } from '../src/creation/slide-count.js';
import { normalizePresentationOutline } from '../src/model-gateway/presentation-outline.js';
import { AiService } from '../src/model-gateway/ai-service.js';
import { GeminiProvider } from '../src/model-gateway/providers.js';
import { UnifiedModelRouter } from '../src/model-gateway/unified-model-router.js';
import { PresentationExecutor } from '../src/creation/executors/presentation-executor.js';
import { PresentationStore } from '../src/creation/presentation.store.js';
import { CreationProviderRouter } from '../src/creation/providers/creation-provider-router.js';
import { LocalPptxPresentationAdapter } from '../src/creation/providers/adapters/local-pptx-adapter.js';
import { CreationRuntime } from '../src/creation/creation-runtime.js';
import { readZip } from '../src/creation/pptx/zip-writer.js';

test('A. the number the person names is the total, title slide included - and only the person\'s own request is read', () => {
  const n = (text: string) => requestedSlideCount(text);
  assert.deepEqual(n('개인 AI 비서가 직장인의 업무를 어떻게 바꾸는지 8장짜리 발표자료를 만들어줘'), { requested: 8, includesCover: true, contentSlides: 7, totalSlides: 8, clamped: false });
  assert.equal(n('5장 발표자료 만들어줘')?.contentSlides, 4);
  assert.equal(n('발표자료 5 슬라이드로')?.totalSlides, 5);
  assert.equal(n('다섯 장짜리 발표자료')?.totalSlides, 5);
  assert.equal(n('여덟 장으로 만들어줘')?.totalSlides, 8);
  assert.equal(n('Make a 6-slide deck about onboarding')?.totalSlides, 6);
  assert.equal(n('a deck of 5 slides')?.contentSlides, 4);
  // "excluding the cover" / "8 content slides": then the number counts content slides only
  assert.deepEqual(n('표지 제외 8장짜리 발표자료'), { requested: 8, includesCover: false, contentSlides: 8, totalSlides: 9, clamped: false });
  assert.equal(n('Create 8 content slides about risk')?.totalSlides, 9);
  assert.equal(n('6 slides, excluding the cover')?.contentSlides, 6);
  // not a slide count: things, months, minutes, years, items; a number inside appended source material
  for (const text of ['5가지 방법을 소개하는 발표자료', '3개월 계획 발표자료', '10분 발표자료를 만들어줘', '2026년 전략 발표자료', '발표자료를 만들어줘', '']) assert.equal(n(text), null, text);
  assert.equal(n('발표자료를 만들어줘\n\nSource material (the previous answer in this conversation):\n지난 보고서는 12장이었다'), null);
  assert.equal(n('발표자료를 만들어줘 ONLY from these verified research findings\n\nFINDINGS:\n9 slides'), null);
});

test('B. a deck is never smaller than one content slide or larger than the outline maximum; a reduced request is recorded', () => {
  assert.deepEqual(requestedSlideCount('2장 발표자료'), { requested: 2, includesCover: true, contentSlides: 1, totalSlides: 2, clamped: false });
  assert.equal(requestedSlideCount('1장 발표자료')?.contentSlides, 1);
  const big = requestedSlideCount('40장 발표자료')!;
  assert.equal(big.contentSlides, 14);
  assert.equal(big.totalSlides, 15);
  assert.equal(big.clamped, true);
});

test('C. normalisation: extra slides are cut (the first ones are kept), nothing is padded, and a one-slide deck is acceptable only when it was asked for', () => {
  const slides = (count: number) => Array.from({ length: count }, (_, i) => ({ title: `S${i + 1}`, bullets: [`point ${i + 1}`] }));
  const parsed = (count: number) => ({ title: 'T', subtitle: '', slides: slides(count) });
  assert.equal(normalizePresentationOutline(parsed(9), 'r', { contentSlides: 7 }).slides.length, 7);
  assert.deepEqual(normalizePresentationOutline(parsed(9), 'r', { contentSlides: 7 }).slides.map((s) => s.title), ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7']);
  assert.equal(normalizePresentationOutline(parsed(5), 'r', { contentSlides: 7 }).slides.length, 5, 'fewer than asked: never padded with invented slides');
  assert.equal(normalizePresentationOutline(parsed(9), 'r').slides.length, 9, 'without a named size nothing changes');
  assert.throws(() => normalizePresentationOutline(parsed(1), 'r'), /not return enough usable slides/);
  assert.equal(normalizePresentationOutline(parsed(3), 'r', { contentSlides: 1 }).slides.length, 1);
  assert.throws(() => normalizePresentationOutline(parsed(0), 'r', { contentSlides: 1 }), /not return enough usable slides/);
});

const reply = (content: string) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: content }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } }), { status: 200 });
const deckJson = (count: number) => JSON.stringify({ title: '개인 AI 비서', subtitle: '도입 제안', slides: Array.from({ length: count }, (_, i) => ({ title: `슬라이드 ${i + 1}`, bullets: ['첫째', '둘째'] })) });
function service(answer: string, seen: string[]): AiService {
  const provider = new GeminiProvider({ apiKey: 'k', model: 'gemini-test', fetchFn: (async (_u: any, init: any) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    seen.push(String(body.systemInstruction?.parts?.[0]?.text ?? ''));
    return reply(answer);
  }) as typeof fetch });
  return new AiService(new UnifiedModelRouter([provider], { info: () => {}, warn: () => {} }));
}

test('D. the planning prompt carries the exact number of content slides; without a named size it keeps the usual range', async () => {
  const seen: string[] = [];
  const out = await service(deckJson(9), seen).presentationOutline({ prompt: '8장짜리 발표자료', locale: 'ko', contentSlides: 7, requestId: 'r1' });
  assert.ok(seen[0].includes(slideCountInstruction(7)));
  assert.match(seen[0], /EXACTLY 7 content slides/);
  assert.equal(out.data.slides.length, 7, 'a model that returns 9 still yields the 7 that were asked for');
  const plain: string[] = [];
  await service(deckJson(6), plain).presentationOutline({ prompt: '발표자료', locale: 'ko', requestId: 'r2' });
  assert.match(plain[0], /Use 4 to 10 content slides/);
  assert.doesNotMatch(plain[0], /EXACTLY/);
});

function makeExecutor(answerCount: number) {
  const presentationStore = new PresentationStore({ metaDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sc-meta-')), bytesDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sc-bytes-')) });
  const providerRouter = new CreationProviderRouter();
  providerRouter.registerPresentationProvider(new LocalPptxPresentationAdapter());
  const executor = new PresentationExecutor({ aiService: service(deckJson(answerCount), []), presentationStore, providerRouter });
  return { presentationStore, runtime: new CreationRuntime([executor]) };
}

test('E. end to end through the executor and the real writer: 5 and 8 requested slides give files with 5 and 8 slides, and the record says what was asked', async () => {
  for (const [text, total, modelReturns] of [['5장짜리 발표자료를 만들어줘', 5, 8], ['8장짜리 발표자료를 만들어줘', 8, 9], ['표지 제외 6장 발표자료', 7, 6]] as const) {
    const { presentationStore, runtime } = makeExecutor(modelReturns);
    const result = await runtime.create({ creationKind: 'PRESENTATION', prompt: text, options: { locale: 'ko' }, tenantId: 'ten_sc', ownerId: 'usr_sc', requestId: `req_${total}` });
    assert.equal(result.status, 'SUCCESS', text);
    const record = presentationStore.get(result.creationId, 'ten_sc', 'usr_sc')!;
    const bytes = presentationStore.getBinary(record.binaryStoragePath)!;
    const slideParts = readZip(bytes).filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name));
    assert.equal(slideParts.length, total, `${text}: slides in the file`);
    assert.equal((result.metadata as any).requestedSlideCount, total);
    assert.equal((result.metadata as any).slideCount, total - 1);
  }
});

test('F. a request without a named size is unchanged and says nothing about a requested size', async () => {
  const { runtime } = makeExecutor(6);
  const result = await runtime.create({ creationKind: 'PRESENTATION', prompt: '발표자료를 만들어줘', options: { locale: 'ko' }, tenantId: 'ten_sc', ownerId: 'usr_sc', requestId: 'req_plain' });
  assert.equal(result.status, 'SUCCESS');
  assert.deepEqual(Object.keys(result.metadata as object).sort(), ['byteLength', 'downloadTarget', 'slideCount'], 'the result metadata keeps exactly its old keys');
});

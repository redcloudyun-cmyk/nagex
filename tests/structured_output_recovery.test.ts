// A Gemini answer to a document revision was once rejected as invalid JSON and, because Gemini was not the preferred provider, the request failed on that single answer. This file pins the recovery:
// intact-but-damaged answers are repaired without changing a value, a rejected answer is asked for again (bounded, pure model calls only), an exhausted retry fails truthfully, a revision is never
// stored twice, and the page count of a revision is read from the person's instruction only. Fake provider endpoint: the shapes below are sanitized, deterministic stand-ins for what a model can
// return - they prove the recovery logic, not the model; the real-model Korean DOCX revision run is part of the sprint E2E.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { parseStructuredJson } from '../src/model-gateway/structured-json.js';
import { AiService } from '../src/model-gateway/ai-service.js';
import { GeminiProvider } from '../src/model-gateway/providers.js';
import { UnifiedModelRouter } from '../src/model-gateway/unified-model-router.js';
import { DocumentExecutor } from '../src/creation/executors/document-executor.js';
import { DocumentStore } from '../src/creation/document.store.js';
import type { DocumentRecord } from '../src/creation/creation-runtime.types.js';

const intended = { title: '개인 AI 비서 도입 보고서', summary: '요약 문장입니다.', content: '## 결론\n\n첫째 문단.\n\n| 항목 | 값 |\n|---|---|\n| 비용 | "낮음" |\n\n- 항목 {중괄호} 포함\n' };

describe('parseStructuredJson repairs what is intact and refuses what is not', () => {
  const ok = (text: string) => { const r = parseStructuredJson(text); assert.equal(r.ok, true, text.slice(0, 60)); return r as Extract<ReturnType<typeof parseStructuredJson>, { ok: true }>; };
  const bad = (text: string) => { const r = parseStructuredJson(text); assert.equal(r.ok, false, text.slice(0, 60)); return (r as Extract<ReturnType<typeof parseStructuredJson>, { ok: false }>).failure; };

  it('strict JSON passes untouched', () => {
    const r = ok(JSON.stringify(intended));
    assert.deepEqual(r.value, intended);
    assert.deepEqual(r.repairs, []);
  });

  it('a code fence, text around the object, raw line breaks / tabs inside strings and a trailing comma are repaired - and every value stays exactly what the model wrote', () => {
    const strict = JSON.stringify(intended);
    assert.deepEqual(ok('```json\n' + strict + '\n```').repairs, ['CODE_FENCE']);
    assert.deepEqual(ok('다음은 결과입니다:\n' + strict + '\n이상입니다.').repairs, ['SURROUNDING_TEXT']);
    // the same object, but the string values contain raw line breaks and tabs instead of \n and \t (the typical "unterminated string" failure of a long markdown answer)
    const rawBreaks = '{"title":"' + intended.title + '","summary":"' + intended.summary + '","content":"' + intended.content.replace(/"/g, '\\"') + '"}';
    const raw = ok(rawBreaks);
    assert.deepEqual(raw.repairs, ['RAW_CONTROL_CHARACTER']);
    assert.deepEqual(raw.value, intended);
    assert.deepEqual(ok('{"a":"x\ty","b":[1,2,],}').value, { a: 'x\ty', b: [1, 2] });
    const both = ok('```json\n{"title":"t","summary":"s","content":"줄1\n줄2",}\n```');
    assert.deepEqual(both.value, { title: 't', summary: 's', content: '줄1\n줄2' });
    assert.deepEqual(both.repairs, ['CODE_FENCE', 'RAW_CONTROL_CHARACTER', 'TRAILING_COMMA']);
  });

  it('braces, quotes and commas inside string values do not confuse the repair', () => {
    const r = ok('앞말 {"content":"a } b { c \\" d, ]","n":1}');
    assert.deepEqual(r.value, { content: 'a } b { c " d, ]', n: 1 });
  });

  it('a cut-off answer is never completed; a list, a bare value, prose and nothing are refused with a fixed reason', () => {
    const strict = JSON.stringify(intended);
    assert.equal(bad(strict.slice(0, strict.length - 40)), 'TRUNCATED');
    assert.equal(bad('{"title":"t","content":"문장이 끊기'), 'TRUNCATED');
    assert.equal(bad('{"title":"t","summary":"s",'), 'TRUNCATED');
    assert.equal(bad('[{"title":"t"}]'), 'NOT_OBJECT');
    assert.equal(bad('[{"title":"t"},]'), 'NOT_OBJECT');
    assert.equal(bad('"just a string"'), 'NOT_OBJECT');
    assert.equal(bad('42'), 'NOT_OBJECT');
    assert.equal(bad('죄송합니다. 요청을 처리할 수 없습니다.'), 'NOT_JSON');
    assert.equal(bad('{not json at all}'), 'NOT_JSON');
    assert.equal(bad('   '), 'EMPTY');
    assert.equal(bad(''), 'EMPTY');
  });
});

// ---- the real GeminiProvider and router behind a scripted endpoint ----

type Scripted = { text: string; finishReason?: string } | { status: number };
interface Stack { service: AiService; calls: () => number; systems: string[]; logs: Array<{ event: string; fields: Record<string, unknown> }> }

function stack(script: Scripted[], gate?: Promise<void>): Stack {
  let n = 0;
  const systems: string[] = [];
  const logs: Stack['logs'] = [];
  const provider = new GeminiProvider({
    apiKey: 'k', model: 'gemini-test',
    fetchFn: (async (_u: any, init: any) => {
      if (gate) await gate;
      const body = JSON.parse(String(init?.body ?? '{}'));
      systems.push(String(body.systemInstruction?.parts?.[0]?.text ?? ''));
      const step = script[Math.min(n++, script.length - 1)];
      if ('status' in step) return new Response('{}', { status: step.status });
      return new Response(JSON.stringify({ candidates: [{ finishReason: step.finishReason ?? 'STOP', content: { parts: [{ text: step.text }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } }), { status: 200 });
    }) as typeof fetch,
  });
  const router = new UnifiedModelRouter([provider], { info: (event, fields) => logs.push({ event, fields }), warn: (event, fields) => logs.push({ event, fields }) });
  return { service: new AiService(router), calls: () => n, systems, logs };
}

const good = JSON.stringify({ title: '수정본', summary: '요약', content: '## 결론\n\n보강된 결론입니다.' });
const cutOff = good.slice(0, good.length - 25);
const request = { prompt: '보고서를 보강해줘', locale: 'ko' as const, requestId: 'req_sor' };

describe('a rejected structured answer is asked for again - bounded, and truthfully failed when it stays bad', () => {
  it('the incident: the only configured provider (not "preferred") returns a cut-off answer first - the second call recovers it', async () => {
    const s = stack([{ text: cutOff, finishReason: 'MAX_TOKENS' }, { text: good }]);
    const out = await s.service.documentSynthesis(request);
    assert.equal(out.data.title, '수정본');
    assert.equal(s.calls(), 2);
    const retry = s.logs.find((l) => l.event === 'model_validation_retry')!;
    assert.equal(retry.fields.provider, 'gemini');
    assert.equal(retry.fields.structuredFailure, 'TRUNCATED');
    assert.equal(retry.fields.finishReason, 'MAX_TOKENS');
    assert.equal(retry.fields.rejection, 'INVALID_MODEL_RESPONSE');
    // content-free telemetry: nothing of the answer or the prompt is logged
    assert.doesNotMatch(JSON.stringify(s.logs), /보강된 결론|보고서를 보강/);
    assert.equal(s.logs.find((l) => l.event === 'model_request_succeeded')!.fields.attempts, 2);
  });

  it('a damaged-but-intact answer needs no second call at all', async () => {
    const s = stack([{ text: '```json\n{"title":"수정본","summary":"요약","content":"줄1\n줄2",}\n```' }]);
    const out = await s.service.documentSynthesis(request);
    assert.equal(out.data.content, '줄1\n줄2');
    assert.equal(s.calls(), 1);
    assert.equal(s.logs.some((l) => l.event === 'model_validation_retry'), false);
  });

  it('a missing field is rejected and retried the same way', async () => {
    const s = stack([{ text: '{"title":"t","summary":"s"}' }, { text: good }]);
    assert.equal((await s.service.documentSynthesis(request)).data.title, '수정본');
    assert.equal(s.calls(), 2);
  });

  it('retries are bounded: two bad answers fail with the provider failure (never a fabricated document), after exactly two calls', async () => {
    const s = stack([{ text: cutOff }, { text: 'not json' }, { text: good }]);
    await assert.rejects(() => s.service.documentSynthesis(request), (e: any) => e.code === 'ALL_MODEL_PROVIDERS_FAILED' && e.details.failures[0].code === 'INVALID_MODEL_RESPONSE');
    assert.equal(s.calls(), 2, 'one original call and one retry - the third (good) answer is never reached');
  });

  it('transport failures are not validation retries: a 429 or 500 is one call and a truthful failure', async () => {
    for (const status of [429, 500]) {
      const s = stack([{ status }, { text: good }]);
      await assert.rejects(() => s.service.documentSynthesis(request), (e: any) => e.code === 'ALL_MODEL_PROVIDERS_FAILED');
      assert.equal(s.calls(), 1, `status ${status}`);
    }
  });

  it('the presentation outline is recovered the same way', async () => {
    const deck = JSON.stringify({ title: '덱', subtitle: '', slides: [{ title: 'A', bullets: ['a'] }, { title: 'B', bullets: ['b'] }] });
    const s = stack([{ text: deck.slice(0, 30) }, { text: deck }]);
    const out = await s.service.presentationOutline({ prompt: '발표자료', locale: 'ko', requestId: 'req_deck' });
    assert.equal(out.data.slides.length, 2);
    assert.equal(s.calls(), 2);
  });

  it('a caller that did not opt in keeps the old policy: one call on a non-preferred provider', async () => {
    const s = stack([{ text: 'not json' }, { text: good }]);
    const router: UnifiedModelRouter = (s.service as any).router;
    await assert.rejects(() => router.generate({ mode: 'auto', jsonMode: true, messages: [{ role: 'user', content: 'p' }], routingContext: { taskKind: 'DAILY_BRIEF', requiresJson: true, requestId: 'r' }, validate: (t) => { JSON.parse(t); } }));
    assert.equal(s.calls(), 1);
  });
});

// ---- the revision path: nothing stored twice, one owner at a time, the length read from the instruction ----

function parentDoc(over: Partial<DocumentRecord> = {}): DocumentRecord {
  const now = new Date().toISOString();
  return { documentId: 'doc_' + 'a'.repeat(24), tenantId: 'ten_a', ownerId: 'usr_a', title: '원본 보고서', summary: '요약', content: '## 서론\n\n자세한 내용은 3페이지 표를 참고하세요. 결론은 짧다.', documentKind: 'REPORT', locale: 'ko', format: 'MARKDOWN', sourceRefs: [], revisionIndex: 1, createdAt: now, updatedAt: now, ...over };
}
function revisionStack(script: Scripted[]) {
  const s = stack(script);
  const store = new DocumentStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'sor-docs-')) });
  const executor = new DocumentExecutor({ aiService: s.service, documentStore: store });
  const parent = parentDoc();
  store.save(parent);
  const revise = (instruction: string, who = { tenantId: 'ten_a', ownerId: 'usr_a' }, requestId = `req_${Math.random().toString(16).slice(2)}`) =>
    executor.executeRevision({ parentDocumentId: parent.documentId, instruction, ...who, requestId, locale: 'ko' });
  return { s, store, parent, revise };
}

describe('document revision with a recovered or exhausted structured answer', () => {
  it('a recovered revision is stored exactly once, linked to its parent', async () => {
    const { s, store, parent, revise } = revisionStack([{ text: cutOff, finishReason: 'MAX_TOKENS' }, { text: good }]);
    const result = await revise('결론을 더 구체적으로 보강해줘');
    assert.equal(result.status, 'SUCCESS');
    assert.equal(s.calls(), 2);
    const all = store.getRevisions(parent.documentId, 'ten_a', 'usr_a');
    assert.equal(all.length, 2, 'the parent and ONE revision');
    const revision = all.find((d) => d.documentId !== parent.documentId)!;
    assert.equal(revision.revisionIndex, 2);
    assert.equal(revision.parentDocumentId, parent.documentId);
    assert.equal(revision.content, '## 결론\n\n보강된 결론입니다.');
  });

  it('an exhausted retry fails truthfully and stores nothing', async () => {
    const { store, parent, revise } = revisionStack([{ text: cutOff }, { text: cutOff }]);
    const result = await revise('결론을 더 구체적으로 보강해줘');
    assert.equal(result.status, 'FAILED');
    assert.equal(result.errorCode, 'ALL_MODEL_PROVIDERS_FAILED');
    assert.equal(result.creationId, '');
    assert.equal(store.list('ten_a', 'usr_a').length, 1, 'only the parent exists - no partial or empty revision');
    assert.equal(store.getRevisions(parent.documentId, 'ten_a', 'usr_a').length, 1);
  });

  it('the same revision asked twice while one is in flight is written once (one model call, one document, the same result)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const s = stack([{ text: good }], gate);
    const store = new DocumentStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'sor-docs-')) });
    const executor = new DocumentExecutor({ aiService: s.service, documentStore: store });
    const parent = parentDoc();
    store.save(parent);
    const ask = (instruction: string, ownerId = 'usr_a', requestId = Math.random().toString(16)) => executor.executeRevision({ parentDocumentId: parent.documentId, instruction, tenantId: 'ten_a', ownerId, requestId, locale: 'ko' });
    const first = ask('결론을 보강해줘');
    const second = ask('결론을 보강해줘');
    const other = ask('서론을 보강해줘');
    const stranger = ask('결론을 보강해줘', 'usr_b');
    release();
    const [a, b, c, d] = await Promise.all([first, second, other, stranger]);
    assert.equal(a.status, 'SUCCESS');
    assert.equal(b.creationId, a.creationId, 'the duplicate joined the first revision');
    assert.equal(c.status, 'SUCCESS');
    assert.notEqual(c.creationId, a.creationId, 'a different instruction is a different revision');
    assert.equal(d.status, 'FAILED', "another owner cannot revise (or join) someone else's document");
    assert.equal(d.errorCode, 'DOCUMENT_NOT_FOUND');
    assert.equal(s.calls(), 2, 'one model call for the shared revision, one for the other instruction');
    assert.equal(store.getRevisions(parent.documentId, 'ten_a', 'usr_a').length, 3, 'the parent and two revisions');
    assert.equal(store.list('ten_a', 'usr_b').length, 0);
    // settled: asking the same thing again later is a new, deliberate revision
    const again = await ask('결론을 보강해줘');
    assert.equal(again.status, 'SUCCESS');
    assert.notEqual(again.creationId, a.creationId);
  });

  it('a failed revision does not poison the next attempt', async () => {
    const { store, parent, revise } = revisionStack([{ text: 'x' }, { text: 'y' }, { text: good }]);
    assert.equal((await revise('보강해줘')).status, 'FAILED');
    assert.equal((await revise('보강해줘')).status, 'SUCCESS');
    assert.equal(store.getRevisions(parent.documentId, 'ten_a', 'usr_a').length, 2);
  });

  it("a page count is read from the instruction only - a number in the existing document's own text is not a request", async () => {
    const plain = revisionStack([{ text: good }]);
    await plain.revise('결론을 더 구체적으로 보강해줘');
    assert.doesNotMatch(plain.s.systems[0], /분량: 요청한 분량/, 'the existing document mentions "3페이지" but the person asked for no length');
    const sized = revisionStack([{ text: good }]);
    await sized.revise('3쪽 분량으로 늘려줘');
    assert.match(sized.s.systems[0], /분량: 요청한 분량은 A4 약 3쪽/);
  });

  it('a first-time document request still reads its page count from the whole prompt', async () => {
    const s = stack([{ text: good }]);
    await s.service.documentSynthesis({ prompt: '3쪽 분량의 보고서를 작성해줘', locale: 'ko', requestId: 'req_len' });
    assert.match(s.systems[0], /분량: 요청한 분량은 A4 약 3쪽/);
  });
});

describe('Gemini reports why it stopped', () => {
  it('finishReason is carried in the response meta (content-free)', async () => {
    const s = stack([{ text: good, finishReason: 'STOP' }]);
    await s.service.documentSynthesis(request);
    assert.equal(s.logs.find((l) => l.event === 'model_request_succeeded')!.fields.finishReason, 'STOP');
  });
});

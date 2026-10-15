// "AI 산업의 보고서" -> "이 보고서로 발표자료 8장" -> "핵심 결론을 한 장 추가하고 전체를 다시 구성해줘". Found on 2de10ce with the real UI and model: the second request was answered with a clarifying question
// ("what is the presentation about?") although the report was on screen and the topic was in the request, and the third fell through to a chat answer - there was no way to revise a deck at all.
// This file pins the continuation: the deck is built from the person's own document, a revision is a NEW deck that leaves the original untouched, the size follows from the words by NAgex's arithmetic,
// and ownership, tenancy and single-submission hold. Fake model endpoint and the real writer / stores; the real-model UI journey and the PowerPoint check are part of the sprint evidence.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { revisionSlideTarget } from '../src/creation/slide-revision.js';
import { decideRouting, isDeckEditRequest } from '../src/workspace/input-router.js';
import { AiService } from '../src/model-gateway/ai-service.js';
import { GeminiProvider } from '../src/model-gateway/providers.js';
import { UnifiedModelRouter } from '../src/model-gateway/unified-model-router.js';
import { PresentationExecutor } from '../src/creation/executors/presentation-executor.js';
import { PresentationStore, type PresentationRecord } from '../src/creation/presentation.store.js';
import { DocumentStore } from '../src/creation/document.store.js';
import { ArtifactStore } from '../src/artifacts/artifact.store.js';
import { CreationProviderRouter } from '../src/creation/providers/creation-provider-router.js';
import { LocalPptxPresentationAdapter } from '../src/creation/providers/adapters/local-pptx-adapter.js';
import { CreationRuntime } from '../src/creation/creation-runtime.js';
import { readZip } from '../src/creation/pptx/zip-writer.js';
import { handlePresentationCreationRoutes } from '../src/http/routes/presentation-creation.routes.js';
import { authAs } from './_s1_session_auth.js';

describe('the size of a revised deck follows from the words (pure)', () => {
  it('"한 장 추가" adds to what the deck has; "삭제" takes away; a named size sets the total; nothing about size forces nothing', () => {
    assert.deepEqual(revisionSlideTarget('핵심 결론을 한 장 추가하고 전체를 다시 구성해줘', 7), { contentSlides: 8, basis: 'ADD' });
    assert.deepEqual(revisionSlideTarget('두 장 더 추가해줘', 5), { contentSlides: 7, basis: 'ADD' });
    assert.deepEqual(revisionSlideTarget('Add one more slide about risks', 4), { contentSlides: 5, basis: 'ADD' });
    assert.deepEqual(revisionSlideTarget('add 2 slides', 4), { contentSlides: 6, basis: 'ADD' });
    assert.deepEqual(revisionSlideTarget('마지막 한 장 삭제해줘', 6), { contentSlides: 5, basis: 'REMOVE' });
    assert.deepEqual(revisionSlideTarget('remove two slides', 6), { contentSlides: 4, basis: 'REMOVE' });
    assert.deepEqual(revisionSlideTarget('6장으로 줄여줘', 9), { contentSlides: 5, basis: 'NAMED_SIZE' });
    assert.deepEqual(revisionSlideTarget('Make it 5 slides', 9), { contentSlides: 4, basis: 'NAMED_SIZE' });
    assert.equal(revisionSlideTarget('톤을 더 간결하게 바꿔줘', 7), null);
  });
  it('it stays inside what a deck can be, and a number in appended source material is not an instruction', () => {
    assert.equal(revisionSlideTarget('열 장 추가해줘', 13)!.contentSlides, 14);
    assert.equal(revisionSlideTarget('한 장 삭제', 1)!.contentSlides, 1);
    assert.equal(revisionSlideTarget('스무 장 추가해줘', 5), null, 'a change in size with a number NAgex cannot read is never taken for "make it N slides"');
    assert.equal(revisionSlideTarget('톤만 바꿔줘\n\nSource material: 12장 분량의 지난 보고서', 7), null);
  });
});

describe('routing knows what is on screen', () => {
  const route = (text: string, options: Parameters<typeof decideRouting>[1] = {}) => decideRouting(text, options);

  it('the incident: "이 보고서로 발표자료 8장" with a document just made is a deck from THAT document, not a question', () => {
    const d = route('이 보고서로 발표자료 8장을 만들어줘.', { activeArtifact: 'DOCUMENT', sourceDocument: true });
    assert.deepEqual([d.kind, d.targetArtifactType, d.ambiguity.level], ['CREATE_ARTIFACT', 'PRESENTATION', 'NONE']);
    assert.ok(d.reasonCodes.includes('SOURCE_ACTIVE_DOCUMENT'));
    const english = route('make a 6-slide deck from the report', { sourceDocument: true });
    assert.ok(english.reasonCodes.includes('SOURCE_ACTIVE_DOCUMENT'));
    // with no document to point at, the same words still ask - nothing is invented
    const none = route('이 보고서로 발표자료 8장을 만들어줘.');
    assert.deepEqual([none.ambiguity.reason, none.reasonCodes.includes('SOURCE_ACTIVE_DOCUMENT')], ['MISSING_TOPIC', false]);
    // a deck with no reference to a document is not assumed to come from it
    assert.equal(route('발표자료 8장 만들어줘', { sourceDocument: true }).reasonCodes.includes('SOURCE_ACTIVE_DOCUMENT'), false);
  });

  it('with a deck open, an instruction to change it is a revision of that deck - not an action, not a chat answer', () => {
    for (const text of ['핵심 결론을 한 장 추가하고 전체를 다시 구성해줘.', '마지막 슬라이드를 삭제해줘', '제목을 더 간결하게 바꿔줘 발표자료', 'Add a conclusion slide and restructure the whole deck', 'shorten the whole deck']) {
      const d = route(text, { activeArtifact: 'PRESENTATION' });
      assert.deepEqual([d.kind, d.targetArtifactType, d.reasonCodes.includes('REVISE_ACTIVE_ARTIFACT')], ['CREATE_ARTIFACT', 'PRESENTATION', true], text);
    }
    const without = route('핵심 결론을 한 장 추가하고 전체를 다시 구성해줘.');
    assert.equal(without.reasonCodes.includes('REVISE_ACTIVE_ARTIFACT'), false, 'no deck open: nothing to revise');
    assert.equal(route('핵심 결론을 한 장 추가하고 전체를 다시 구성해줘.', { activeArtifact: 'DOCUMENT' }).reasonCodes.includes('REVISE_ACTIVE_ARTIFACT'), false, 'a document is open, not a deck');
  });

  it('a request that leaves NAgex, a question, another artifact, or a brand-new deck is never taken for an edit of the open deck', () => {
    const deck = { activeArtifact: 'PRESENTATION' as const };
    assert.equal(route('이 발표자료를 팀에게 이메일로 보내줘', deck).kind, 'ACTION_PLAN');
    assert.equal(route('내일 오후 2시에 회의 잡아줘', deck).kind, 'ACTION_PLAN');
    assert.equal(route('send the deck to Alex', deck).kind, 'ACTION_PLAN');
    for (const text of ['이 발표자료 몇 장이야?', 'what is the conclusion slide about?', '보고서를 한 장 추가해줘', '새로운 발표자료 5장 만들어줘', 'create a brand new deck']) {
      assert.equal(route(text, deck).reasonCodes.includes('REVISE_ACTIVE_ARTIFACT'), false, text);
    }
    assert.equal(isDeckEditRequest('슬라이드 한 장 추가'), true);
    assert.equal(isDeckEditRequest('안녕하세요'), false);
  });

  it('a negated request ("don\'t change the deck") is not a revision', () => {
    assert.equal(route('발표자료는 수정하지 말고 그대로 둬줘', { activeArtifact: 'PRESENTATION' }).reasonCodes.includes('REVISE_ACTIVE_ARTIFACT'), false);
  });
});

// ---- the executor, with a scripted model ----

function scriptedService(answers: Array<(system: string, user: string) => string>, seen: Array<{ system: string; user: string }>): AiService {
  let n = 0;
  const provider = new GeminiProvider({
    apiKey: 'k', model: 'gemini-test',
    fetchFn: (async (_u: any, init: any) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      const system = String(body.systemInstruction?.parts?.[0]?.text ?? '');
      const user = String(body.contents?.[0]?.parts?.[0]?.text ?? '');
      seen.push({ system, user });
      const text = answers[Math.min(n++, answers.length - 1)](system, user);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } }), { status: 200 });
    }) as typeof fetch,
  });
  return new AiService(new UnifiedModelRouter([provider], { info: () => {}, warn: () => {} }));
}
const deckJson = (count: number, title = '개인 AI 비서 도입') => JSON.stringify({ title, subtitle: '제안', slides: Array.from({ length: count }, (_, i) => ({ title: `슬라이드 ${i + 1}`, bullets: ['첫째', '둘째'] })) });
const slideParts = (bytes: Buffer) => readZip(bytes).filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name)).length;

function rig(answers: Array<(system: string, user: string) => string>) {
  const seen: Array<{ system: string; user: string }> = [];
  const dir = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), `nagex_cc_${p}_`));
  const presentationStore = new PresentationStore({ metaDir: dir('meta'), bytesDir: dir('bytes') });
  const documentStore = new DocumentStore({ dir: dir('docs') });
  const artifactStore = new ArtifactStore({ dir: dir('art') });
  const providerRouter = new CreationProviderRouter();
  providerRouter.registerPresentationProvider(new LocalPptxPresentationAdapter());
  const executor = new PresentationExecutor({ aiService: scriptedService(answers, seen), presentationStore, providerRouter, artifactStore, documentStore });
  const runtime = new CreationRuntime([executor]);
  const saveDocument = (tenantId: string, ownerId: string, content = '# AI 산업 보고서\n\n핵심 결론: 데이터가 경쟁력이다.') => {
    const documentId = `doc_${'a'.repeat(23)}${Math.floor(Math.random() * 9)}`;
    documentStore.save({ documentId, tenantId, ownerId, title: 'AI 산업 보고서', summary: 's', content, documentKind: 'REPORT', locale: 'ko', format: 'MARKDOWN', sourceRefs: [], revisionIndex: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as any);
    return artifactStore.saveCompleted({ tenantId, ownerId, type: 'DOCUMENT', title: 'AI 산업 보고서', preview: 'p', sourceType: 'CAPTURE', sourceId: documentId, openTarget: `/api/v1/creations/documents/${documentId}` });
  };
  const create = (prompt: string, tenantId: string, ownerId: string, sourceArtifactIds: string[] = []) =>
    runtime.create({ creationKind: 'PRESENTATION', prompt, sourceRefs: sourceArtifactIds.map((id) => ({ type: 'ARTIFACT' as const, id })), options: { locale: 'ko' }, tenantId, ownerId, requestId: `req_${Math.random().toString(16).slice(2)}` });
  return { seen, presentationStore, documentStore, artifactStore, executor, runtime, saveDocument, create };
}
const T = 'ten_cc';
const U = 'usr_cc';

describe('a deck from the person\'s own document', () => {
  it('the document\'s content reaches the model, and the file has exactly the slides that were asked for', async () => {
    const r = rig([() => deckJson(7)]);
    const doc = r.saveDocument(T, U);
    const result = await r.create('이 보고서로 발표자료 8장을 만들어줘', T, U, [doc.artifactId]);
    assert.equal(result.status, 'SUCCESS');
    assert.match(r.seen[0].system, /핵심 결론: 데이터가 경쟁력이다/, 'the document is the source');
    const record = r.presentationStore.get(result.creationId, T, U)!;
    assert.equal(slideParts(r.presentationStore.getBinary(record.binaryStoragePath)!), 8);
    assert.deepEqual(record.sourceRefs, [{ type: 'ARTIFACT', id: doc.artifactId }], 'the deck remembers where it came from');
  });

  it('someone else\'s document, or one that does not exist, is refused before the model is called', async () => {
    const r = rig([() => deckJson(7)]);
    const theirs = r.saveDocument(T, 'usr_other');
    const foreign = await r.create('이 보고서로 발표자료 8장을 만들어줘', T, U, [theirs.artifactId]);
    assert.deepEqual([foreign.status, foreign.errorCode], ['FAILED', 'UNAUTHORIZED_REFERENCE']);
    const otherTenant = r.saveDocument('ten_other', U);
    assert.equal((await r.create('x 발표자료', T, U, [otherTenant.artifactId])).errorCode, 'UNAUTHORIZED_REFERENCE');
    assert.equal((await r.create('x 발표자료', T, U, ['art_000000000000000000000000'])).errorCode, 'UNAUTHORIZED_REFERENCE');
    assert.equal(r.seen.length, 0);
  });
});

describe('revising a deck', () => {
  it('the incident: "한 장 추가하고 전체를 다시 구성" gives a NEW deck with one more content slide; the original and its file are untouched; the revision points back', async () => {
    const r = rig([() => deckJson(7, '원본'), (_s, user) => { assert.match(user, /핵심 결론을 한 장 추가하고 전체를 다시 구성해줘/); assert.match(user, /슬라이드 1/); return deckJson(8, '재구성본'); }]);
    const original = await r.create('발표자료 8장 만들어줘', T, U);
    const before = r.presentationStore.get(original.creationId, T, U)!;
    const beforeBytes = r.presentationStore.getBinary(before.binaryStoragePath)!;

    const revised = await r.executor.executeRevision({ parentPresentationId: original.creationId, instruction: '핵심 결론을 한 장 추가하고 전체를 다시 구성해줘', tenantId: T, ownerId: U, requestId: 'req_rev', locale: 'ko' });
    assert.equal(revised.status, 'SUCCESS');
    assert.notEqual(revised.creationId, original.creationId);
    const record = r.presentationStore.get(revised.creationId, T, U)!;
    assert.deepEqual([record.title, record.revisionIndex, record.parentPresentationId, record.revisedFromPresentationId], ['재구성본', 2, original.creationId, original.creationId]);
    assert.equal(slideParts(r.presentationStore.getBinary(record.binaryStoragePath)!), 9, '8 slides + one more');
    assert.equal((revised.metadata as any).requestedSlideCount, 9);
    assert.equal((revised.metadata as any).revisedFrom, original.creationId);
    // the original is exactly as it was
    const after = r.presentationStore.get(original.creationId, T, U)!;
    assert.equal(after.title, '원본');
    assert.equal(after.slides.length, 7);
    assert.ok(r.presentationStore.getBinary(after.binaryStoragePath)!.equals(beforeBytes));
    // both are listed, each with its own artifact
    assert.equal(r.presentationStore.list(T, U).length, 2);
    assert.notEqual(record.artifactId, after.artifactId);
  });

  it('a revision of a revision keeps pointing at the first deck of the family and counts up', async () => {
    const r = rig([() => deckJson(7), () => deckJson(8), () => deckJson(7)]);
    const a = await r.create('발표자료 8장', T, U);
    const b = await r.executor.executeRevision({ parentPresentationId: a.creationId, instruction: '한 장 추가', tenantId: T, ownerId: U, requestId: 'r1', locale: 'ko' });
    const c = await r.executor.executeRevision({ parentPresentationId: b.creationId, instruction: '한 장 삭제', tenantId: T, ownerId: U, requestId: 'r2', locale: 'ko' });
    const rc = r.presentationStore.get(c.creationId, T, U)!;
    assert.deepEqual([rc.revisionIndex, rc.parentPresentationId, rc.revisedFromPresentationId], [3, a.creationId, b.creationId]);
    assert.equal(slideParts(r.presentationStore.getBinary(rc.binaryStoragePath)!), 8, '9 total after adding, then one removed');
  });

  it('an instruction with no size words forces no count; a model that returns more than a named size is cut to it', async () => {
    const r = rig([() => deckJson(6), () => deckJson(5), () => deckJson(9)]);
    const a = await r.create('발표자료', T, U);
    const free = await r.executor.executeRevision({ parentPresentationId: a.creationId, instruction: '톤을 더 간결하게 바꿔줘', tenantId: T, ownerId: U, requestId: 'r1', locale: 'ko' });
    assert.equal((free.metadata as any).requestedSlideCount, undefined);
    assert.equal(r.presentationStore.get(free.creationId, T, U)!.slides.length, 5);
    const sized = await r.executor.executeRevision({ parentPresentationId: a.creationId, instruction: '6장으로 줄여줘', tenantId: T, ownerId: U, requestId: 'r2', locale: 'ko' });
    assert.equal(slideParts(r.presentationStore.getBinary(r.presentationStore.get(sized.creationId, T, U)!.binaryStoragePath)!), 6);
  });

  it('ownership: another owner, another tenant, an unknown or malformed id are all "not found" and the model is never called', async () => {
    const r = rig([() => deckJson(7)]);
    const mine = await r.create('발표자료', T, U);
    const calls = r.seen.length;
    for (const [tenantId, ownerId, id] of [[T, 'usr_other', mine.creationId], ['ten_other', U, mine.creationId], [T, U, 'pres_000000000000000000000000'], [T, U, '../etc/passwd']] as const) {
      const result = await r.executor.executeRevision({ parentPresentationId: id, instruction: '한 장 추가', tenantId, ownerId, requestId: 'r', locale: 'ko' });
      assert.deepEqual([result.status, result.errorCode], ['FAILED', 'PRESENTATION_NOT_FOUND'], `${tenantId}/${ownerId}/${id}`);
    }
    assert.equal(r.seen.length, calls);
    assert.equal(r.presentationStore.list(T, U).length, 1);
    assert.equal(r.presentationStore.list(T, 'usr_other').length, 0);
  });

  it('a model failure is a failure: nothing is stored, the original stays; an empty instruction is refused', async () => {
    const r = rig([() => deckJson(7), () => 'not json', () => 'still not json']);
    const a = await r.create('발표자료', T, U);
    const failed = await r.executor.executeRevision({ parentPresentationId: a.creationId, instruction: '한 장 추가', tenantId: T, ownerId: U, requestId: 'r1', locale: 'ko' });
    assert.equal(failed.status, 'FAILED');
    assert.equal(r.presentationStore.list(T, U).length, 1, 'no partial deck');
    assert.equal((await r.executor.executeRevision({ parentPresentationId: a.creationId, instruction: '   ', tenantId: T, ownerId: U, requestId: 'r2', locale: 'ko' })).errorCode, 'INVALID_PROMPT');
  });

  it('the same revision asked twice at once is written once', async () => {
    const r = rig([() => deckJson(7), () => deckJson(8)]);
    const a = await r.create('발표자료', T, U);
    const calls = r.seen.length;
    const ask = () => r.executor.executeRevision({ parentPresentationId: a.creationId, instruction: '한 장 추가', tenantId: T, ownerId: U, requestId: `r_${Math.random()}`, locale: 'ko' });
    const [x, y] = await Promise.all([ask(), ask()]);
    assert.equal(x.creationId, y.creationId);
    assert.equal(r.seen.length, calls + 1, 'one model call');
    assert.equal(r.presentationStore.list(T, U).length, 2);
  });

  it('the revision still works when the deck\'s source document is gone, and it keeps the reference', async () => {
    const r = rig([() => deckJson(7), () => deckJson(8)]);
    const doc = r.saveDocument(T, U);
    const a = await r.create('이 보고서로 발표자료', T, U, [doc.artifactId]);
    const record = r.presentationStore.get(a.creationId, T, U)!;
    r.presentationStore.save({ ...record, sourceRefs: [{ type: 'ARTIFACT', id: 'art_000000000000000000000000' }] } as PresentationRecord);
    const revised = await r.executor.executeRevision({ parentPresentationId: a.creationId, instruction: '한 장 추가', tenantId: T, ownerId: U, requestId: 'r', locale: 'ko' });
    assert.equal(revised.status, 'SUCCESS');
  });
});

describe('the revision route', () => {
  async function call(r: ReturnType<typeof rig>, pathname: string, body: Record<string, unknown> | null, who = { tenantId: T, principalId: U }) {
    return handlePresentationCreationRoutes('POST', pathname, body as any, authAs(who.tenantId, who.principalId), {}, { creationRuntime: r.runtime, presentationStore: r.presentationStore, presentationExecutor: r.executor }) as Promise<any>;
  }
  it('creates a revised deck (201), validates the instruction (400), hides other people\'s decks (404), and the viewer reports the family', async () => {
    const r = rig([() => deckJson(7), () => deckJson(8)]);
    const a = await r.create('발표자료', T, U);
    const base = `/api/v1/creations/presentations/${a.creationId}/revisions`;
    assert.equal((await call(r, base, { instruction: '   ' })).status, 400);
    assert.equal((await call(r, base, { instruction: '한 장 추가' }, { tenantId: T, principalId: 'usr_other' })).status, 404);
    assert.equal((await call(r, '/api/v1/creations/presentations/not-a-deck/revisions', { instruction: '한 장 추가' })).status, 404);
    const ok = await call(r, base, { instruction: '한 장 추가' });
    assert.equal(ok.status, 201);
    const viewer = await handlePresentationCreationRoutes('GET', `/api/v1/creations/presentations/${ok.data.creationId}`, null as any, authAs(T, U), {}, { creationRuntime: r.runtime, presentationStore: r.presentationStore }) as any;
    assert.deepEqual([viewer.data.presentation.revisionIndex, viewer.data.presentation.parentPresentationId], [2, a.creationId]);
    const download = await handlePresentationCreationRoutes('GET', `/api/v1/creations/presentations/${ok.data.creationId}/download`, null as any, authAs(T, U), {}, { creationRuntime: r.runtime, presentationStore: r.presentationStore }) as any;
    assert.equal(slideParts(download.data), 9);
  });
  it('without the executor wired the route says so instead of pretending', async () => {
    const r = rig([() => deckJson(7)]);
    const a = await r.create('발표자료', T, U);
    const res = await handlePresentationCreationRoutes('POST', `/api/v1/creations/presentations/${a.creationId}/revisions`, { instruction: '한 장 추가' } as any, authAs(T, U), {}, { creationRuntime: r.runtime, presentationStore: r.presentationStore }) as any;
    assert.equal(res.status, 503);
  });
});

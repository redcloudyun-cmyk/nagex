// Phase 1 STEP 4 — Real PDF Understanding.
//
// Exercises CaptureProcessor's FILE/PDF path end-to-end: real pdfjs-dist
// extraction over genuine PDF fixtures (tests/_pdf_fixtures.ts, never a
// hand-built %PDF-/BT/Tj string), real bounded chunking with deterministic
// chunk identity, and a real AiService/UnifiedModelRouter call per chunk
// (HTTP layer mocked, same pattern as text_understanding.test.ts /
// url_understanding.test.ts) — never the offline heuristic fallback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CaptureStore } from '../src/workspace/capture.store.js';
import { QuickCaptureService } from '../src/workspace/quick-capture.service.js';
import { TaskStore } from '../src/tasks/task.store.js';
import { MemoryEngine } from '../src/context/memory.engine.js';
import { AiService, type TextUnderstandingResult } from '../src/model-gateway/ai-service.js';
import { UnifiedModelRouter } from '../src/model-gateway/unified-model-router.js';
import { createProviders } from '../src/model-gateway/providers.js';
import { generateTextPdf, generateBlankPdf, generateCorruptPdf } from './_pdf_fixtures.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-pdf-understanding-'));
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function fullResult(payload: Partial<TextUnderstandingResult> & { title: string; summary: string }): TextUnderstandingResult {
  return {
    contentType: 'note', topics: [], entities: [], dates: [], actionItems: [],
    taskCandidates: [], calendarCandidates: [], memoryCandidates: [], knowledgeCandidates: [],
    ...payload,
  };
}

// A single fixed response for every model call — fine for the small,
// non-chunked (single AiService.understand() call) PDF path.
function buildMockAiService(payload: Partial<TextUnderstandingResult> & { title: string; summary: string }): AiService {
  const full = fullResult(payload);
  const providers = createProviders(
    { OPENAI_API_KEY: 'test-key', NAGEX_OPENAI_MODEL: 'test-pdf-model' },
    async () => jsonResponse({ output_text: JSON.stringify(full) }),
  );
  return new AiService(new UnifiedModelRouter(providers, { info: () => {}, warn: () => {} }));
}

// A poison AiService that throws if the model is ever actually called —
// proves understanding is never attempted on a failed/zero-text extraction.
function buildPoisonAiService(): AiService {
  const providers = createProviders(
    { OPENAI_API_KEY: 'test-key', NAGEX_OPENAI_MODEL: 'test-pdf-model' },
    async () => { throw new Error('AiService must not be called for this capture.'); },
  );
  return new AiService(new UnifiedModelRouter(providers, { info: () => {}, warn: () => {} }));
}

const MEETING_MARKER = 'MEETING_TIME_MARKER';
const ACTION_MARKER = 'ACTION_ITEM_MARKER';

// A chunk-aware AiService: each per-chunk call (analyzeLargeDocument calls
// the model once per chunk with ONLY that chunk's real text) gets a response
// grounded in whatever marker is actually present in that chunk's text —
// this is what makes candidate sourceRefs genuinely traceable to a real
// chunk rather than a guessed "first few chunks" reference.
function buildChunkAwareAiService(): AiService {
  const providers = createProviders(
    { OPENAI_API_KEY: 'test-key', NAGEX_OPENAI_MODEL: 'test-pdf-model' },
    async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body));
      const messages = body.input as Array<{ role: string; content: string }>;
      const userContent = messages.find((m) => m.role === 'user')?.content || '';

      let result: TextUnderstandingResult;
      if (userContent.includes(MEETING_MARKER)) {
        result = fullResult({
          title: 'Design sync scheduled', summary: 'The team will meet tomorrow at 3 PM to discuss the roadmap.',
          topics: ['Calendar'],
          dates: [{ text: 'tomorrow at 3 PM', normalized: null, confidence: 0.8 }],
          calendarCandidates: [{ title: 'Design sync', startCandidate: new Date(Date.now() + 86400000).toISOString(), confidence: 0.9 }],
        });
      } else if (userContent.includes(ACTION_MARKER)) {
        result = fullResult({
          title: 'Budget report review needed', summary: 'The budget report must be reviewed and finalized by Friday.',
          topics: ['Finance'],
          actionItems: [{ text: 'Review and finalize the budget report', confidence: 0.85 }],
          taskCandidates: [{ title: 'Finalize budget report', description: 'Due Friday', priorityCandidate: 'MEDIUM', confidence: 0.9 }],
        });
      } else if (/\[chk_/.test(userContent)) {
        // The top-level synthesis call — its input is the concatenation of
        // per-chunk summaries (each prefixed "[chunkId Page N]: ..."), never
        // raw chunk text, so its own candidates are discarded by
        // analyzeLargeDocument() and only used for title/summary/topics.
        result = fullResult({ title: 'Quarterly Planning Document', summary: 'A multi-topic planning document covering distributed systems background, a scheduled meeting, and a budget action item.' });
      } else {
        result = fullResult({ title: 'Background', summary: 'General background content about distributed systems and consensus protocols.', topics: ['Distributed Systems'] });
      }
      return jsonResponse({ output_text: JSON.stringify(result) });
    },
  );
  return new AiService(new UnifiedModelRouter(providers, { info: () => {}, warn: () => {} }));
}

function buildHarness(aiService?: AiService, extra?: { taskStore?: TaskStore; memoryEngine?: MemoryEngine }) {
  const dir = tempDir();
  const store = new CaptureStore(path.join(dir, 'captures'));
  const service = new QuickCaptureService(store, undefined, extra?.taskStore, extra?.memoryEngine, undefined, aiService);
  return { store, service };
}

const FILLER = 'This background section discusses distributed systems and consensus protocols in general terms. ';

test('1. Valid small PDF: real extraction + real model-backed understanding (single-call path)', async () => {
  const aiService = buildMockAiService({ title: 'Project Notes', summary: 'Notes about the NAgex project architecture.' });
  const { service } = buildHarness(aiService);
  const pdf = await generateTextPdf(['NAgex project architecture notes.']);

  const item = await service.uploadBinaryObject({
    ownerId: 'usr_pdf_01', tenantId: 'ten_pdf', type: 'FILE', filename: 'notes.pdf', mimeType: 'application/pdf', data: pdf, source: 'WEB',
  });

  assert.equal(item.status, 'READY');
  assert.equal(item.metadata.extractionMethod, 'pdfjs-dist');
  assert.equal(item.metadata.hasText, true);
  assert.ok((item.metadata.extractedCharacters || 0) > 0);
  assert.equal(item.metadata.extractedSummary, 'Notes about the NAgex project architecture.');
});

test('2. Multi-page PDF: truthful, real page count from the parser', async () => {
  const aiService = buildMockAiService({ title: 'Two Page Doc', summary: 'A short two-page document.' });
  const { service } = buildHarness(aiService);
  const pdf = await generateTextPdf(['Page one content.', 'Page two content.', 'Page three content.']);

  const item = await service.uploadBinaryObject({
    ownerId: 'usr_pdf_02', tenantId: 'ten_pdf', type: 'FILE', filename: 'threepager.pdf', mimeType: 'application/pdf', data: pdf, source: 'WEB',
  });

  assert.equal(item.status, 'READY');
  assert.equal(item.metadata.pageCount, 3);
});

test('3. Large PDF: chunking activates with multiple stable, deterministic chunkIds', async () => {
  const aiService = buildChunkAwareAiService();
  const { service } = buildHarness(aiService);
  const pdf = await generateTextPdf([
    FILLER.repeat(5),
    `${MEETING_MARKER}: The team will meet tomorrow at 3 PM to discuss the roadmap.`,
    `${ACTION_MARKER}: Please review and finalize the budget report by Friday.`,
  ]);

  const item = await service.uploadBinaryObject({
    ownerId: 'usr_pdf_03', tenantId: 'ten_pdf', type: 'FILE', filename: 'quarterly.pdf', mimeType: 'application/pdf', data: pdf, source: 'WEB',
  });

  const chunks = item.metadata.chunks || [];
  assert.ok(chunks.length >= 3, `expected >= 3 chunks, got ${chunks.length}`);
  const ids = chunks.map((c) => c.chunkId);
  assert.equal(new Set(ids).size, ids.length, 'chunkIds must be unique');
  for (const c of chunks) {
    assert.ok(c.chunkId.startsWith('chk_'));
    assert.ok(c.chunkId.includes(item.captureId), 'chunkId must be derived from captureId (Phase 1 STEP 4 item G)');
  }
});

test('4. Final synthesis is grounded in the real chunk results, not fabricated top-level content', async () => {
  const aiService = buildChunkAwareAiService();
  const { service } = buildHarness(aiService);
  const pdf = await generateTextPdf([
    FILLER.repeat(5),
    `${MEETING_MARKER}: The team will meet tomorrow at 3 PM to discuss the roadmap.`,
    `${ACTION_MARKER}: Please review and finalize the budget report by Friday.`,
  ]);

  const item = await service.uploadBinaryObject({
    ownerId: 'usr_pdf_04', tenantId: 'ten_pdf', type: 'FILE', filename: 'quarterly2.pdf', mimeType: 'application/pdf', data: pdf, source: 'WEB',
  });

  assert.equal(item.metadata.extractedTitle, 'quarterly2.pdf');
  assert.equal(item.metadata.extractedSummary, 'A multi-topic planning document covering distributed systems background, a scheduled meeting, and a budget action item.');
  // Dates/actionItems are merged from the real per-chunk grounded facts, not
  // from the summary-of-summaries synthesis call.
  assert.ok((item.metadata.dates || []).some((d) => d.text === 'tomorrow at 3 PM'));
  assert.ok((item.metadata.actionItems || []).some((a) => a.text.includes('budget report')));
});

test('5. Candidate sourceRefs correspond to real, existing chunks (chunk provenance)', async () => {
  const aiService = buildChunkAwareAiService();
  const { service } = buildHarness(aiService);
  const pdf = await generateTextPdf([
    FILLER.repeat(5),
    `${MEETING_MARKER}: The team will meet tomorrow at 3 PM to discuss the roadmap.`,
    `${ACTION_MARKER}: Please review and finalize the budget report by Friday.`,
  ]);

  const item = await service.uploadBinaryObject({
    ownerId: 'usr_pdf_05', tenantId: 'ten_pdf', type: 'FILE', filename: 'quarterly3.pdf', mimeType: 'application/pdf', data: pdf, source: 'WEB',
  });

  const chunkIds = new Set((item.metadata.chunks || []).map((c) => c.chunkId));
  const candidates = item.metadata.candidates || [];
  assert.ok(candidates.length >= 2);
  for (const cand of candidates) {
    assert.ok(cand.sourceRefs.length > 0, `candidate ${cand.title} has no sourceRefs`);
    assert.ok(cand.sourceRefs[0].chunkId && chunkIds.has(cand.sourceRefs[0].chunkId), 'sourceRef chunkId must reference a real chunk that was actually part of this document');
  }
});

test('6. An explicit action item produces a PROPOSED TaskCandidate grounded to its real source chunk', async () => {
  const aiService = buildChunkAwareAiService();
  const { service } = buildHarness(aiService);
  const pdf = await generateTextPdf([
    FILLER.repeat(5),
    `${MEETING_MARKER}: The team will meet tomorrow at 3 PM to discuss the roadmap.`,
    `${ACTION_MARKER}: Please review and finalize the budget report by Friday.`,
  ]);

  const item = await service.uploadBinaryObject({
    ownerId: 'usr_pdf_06', tenantId: 'ten_pdf', type: 'FILE', filename: 'quarterly4.pdf', mimeType: 'application/pdf', data: pdf, source: 'WEB',
  });

  const taskCand = (item.metadata.candidates || []).find((c) => c.type === 'TASK');
  assert.ok(taskCand, 'expected a TASK candidate');
  assert.equal(taskCand!.title, 'Finalize budget report');
  // Page 3 is the one containing ACTION_MARKER (pages are 1-indexed).
  assert.equal(taskCand!.sourceRefs[0].pageNumber, 3);
  assert.equal(item.status, 'NEEDS_REVIEW');
});

test('7. An explicit date/time produces a PROPOSED CalendarCandidate grounded to its real source chunk', async () => {
  const aiService = buildChunkAwareAiService();
  const { service } = buildHarness(aiService);
  const pdf = await generateTextPdf([
    FILLER.repeat(5),
    `${MEETING_MARKER}: The team will meet tomorrow at 3 PM to discuss the roadmap.`,
    `${ACTION_MARKER}: Please review and finalize the budget report by Friday.`,
  ]);

  const item = await service.uploadBinaryObject({
    ownerId: 'usr_pdf_07', tenantId: 'ten_pdf', type: 'FILE', filename: 'quarterly5.pdf', mimeType: 'application/pdf', data: pdf, source: 'WEB',
  });

  const calCand = (item.metadata.candidates || []).find((c) => c.type === 'CALENDAR');
  assert.ok(calCand, 'expected a CALENDAR candidate');
  assert.equal(calCand!.title, 'Design sync');
  // Page 2 is the one containing MEETING_MARKER.
  assert.equal(calCand!.sourceRefs[0].pageNumber, 2);
});

test('8. A purely informational PDF produces no fake candidate', async () => {
  const aiService = buildMockAiService({ title: 'Weather report archive', summary: 'A historical record of weather observations.' });
  const { service } = buildHarness(aiService);
  const pdf = await generateTextPdf(['A historical record of weather observations from last month.']);

  const item = await service.uploadBinaryObject({
    ownerId: 'usr_pdf_08', tenantId: 'ten_pdf', type: 'FILE', filename: 'weather.pdf', mimeType: 'application/pdf', data: pdf, source: 'WEB',
  });

  assert.equal(item.status, 'READY');
  assert.equal((item.metadata.candidates || []).length, 0);
});

test('9. A scanned/zero-text PDF becomes NEEDS_REVIEW/OCR_REQUIRED — never a fabricated summary, model never called', async () => {
  const aiService = buildPoisonAiService();
  const { service } = buildHarness(aiService);
  const pdf = await generateBlankPdf();

  const item = await service.uploadBinaryObject({
    ownerId: 'usr_pdf_09', tenantId: 'ten_pdf', type: 'FILE', filename: 'scanned.pdf', mimeType: 'application/pdf', data: pdf, source: 'WEB',
  });

  assert.equal(item.status, 'NEEDS_REVIEW');
  assert.equal(item.metadata.errorCode, 'OCR_REQUIRED');
  assert.equal(item.metadata.hasText, false);
  assert.equal(item.metadata.extractedCharacters, 0);
  assert.ok(!item.metadata.extractedSummary?.toLowerCase().includes('weather'));
});

test('10. A corrupt PDF (truncated bytes, no valid trailer/xref) fails — real parser rejects it, model never called', async () => {
  const aiService = buildPoisonAiService();
  const { service } = buildHarness(aiService);
  const pdf = await generateCorruptPdf();

  const item = await service.uploadBinaryObject({
    ownerId: 'usr_pdf_10', tenantId: 'ten_pdf', type: 'FILE', filename: 'corrupt.pdf', mimeType: 'application/pdf', data: pdf, source: 'WEB',
  });

  assert.equal(item.status, 'FAILED');
  assert.equal(item.metadata.errorCode, 'PDF_EXTRACTION_FAILED');
});

test('11. A zero-byte PDF is refused outright — never processed as READY', async () => {
  const aiService = buildPoisonAiService();
  const { service } = buildHarness(aiService);

  await assert.rejects(
    () => service.uploadBinaryObject({
      ownerId: 'usr_pdf_11', tenantId: 'ten_pdf', type: 'FILE', filename: 'empty.pdf', mimeType: 'application/pdf', data: Buffer.alloc(0), source: 'WEB',
    }),
    /ZERO_BYTE_PAYLOAD/,
  );
});

test('12. Invalid JSON from one provider triggers real fallback to the next provider', async () => {
  const validPayload = fullResult({ title: 'Fallback-sourced PDF understanding', summary: 'Understood via the fallback provider.' });
  const fetchFn: typeof fetch = async (url) => String(url).includes('openai.com')
    ? jsonResponse({ output_text: 'this is not JSON at all' })
    : jsonResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify(validPayload) }] } }] });
  const providers = createProviders({ OPENAI_API_KEY: 'a', NAGEX_OPENAI_MODEL: 'oa', GEMINI_API_KEY: 'g', NAGEX_GEMINI_MODEL: 'gm' }, fetchFn);
  const aiService = new AiService(new UnifiedModelRouter(providers, { info: () => {}, warn: () => {} }));
  const { service } = buildHarness(aiService);
  const pdf = await generateTextPdf(['Short document content for provider fallback testing.']);

  const item = await service.uploadBinaryObject({
    ownerId: 'usr_pdf_12', tenantId: 'ten_pdf', type: 'FILE', filename: 'fallback.pdf', mimeType: 'application/pdf', data: pdf, source: 'WEB',
  });

  assert.equal(item.status, 'READY');
  assert.equal(item.metadata.extractedSummary, 'Understood via the fallback provider.');
  assert.equal(item.metadata.modelProvider, 'gemini');
});

test('13. When every provider fails, the PDF capture becomes FAILED — never a fake READY', async () => {
  const allFail = new AiService(new UnifiedModelRouter(
    createProviders({ OPENAI_API_KEY: 'a', NAGEX_OPENAI_MODEL: 'oa' }, async () => jsonResponse({ error: 'server error' }, 500)),
    { info: () => {}, warn: () => {} },
  ));
  const { service } = buildHarness(allFail);
  const pdf = await generateTextPdf(['Content that will never be understood because every provider fails.']);

  const item = await service.uploadBinaryObject({
    ownerId: 'usr_pdf_13', tenantId: 'ten_pdf', type: 'FILE', filename: 'allfail.pdf', mimeType: 'application/pdf', data: pdf, source: 'WEB',
  });

  assert.equal(item.status, 'FAILED');
  assert.equal(item.metadata.errorCode, 'ALL_MODEL_PROVIDERS_FAILED');
});

test('14. Retrying the same PDF does not duplicate a candidate the user already decided on', async () => {
  const aiService = buildMockAiService({
    title: 'Follow-up reminder', summary: 'A note about following up.',
    taskCandidates: [{ title: 'Follow up with client', confidence: 0.9 }],
  });
  const { service, store } = buildHarness(aiService);
  const pdf = await generateTextPdf(['Remember to follow up with the client next week.']);

  const item = await service.uploadBinaryObject({
    ownerId: 'usr_pdf_14', tenantId: 'ten_pdf', type: 'FILE', filename: 'followup.pdf', mimeType: 'application/pdf', data: pdf, source: 'WEB',
  });
  const candidateId = (item.metadata.candidates || [])[0].candidateId;
  assert.ok(candidateId);

  await service.actionCandidate({ captureId: item.captureId, candidateId, action: 'ACCEPT', ownerId: 'usr_pdf_14', tenantId: 'ten_pdf' });
  assert.equal(store.getCapture(item.captureId)?.metadata.candidates?.[0].status, 'ACCEPTED');

  const retried = await service.retryCapture(item.captureId, 'usr_pdf_14');
  const finalCandidates = retried?.metadata.candidates || [];
  assert.equal(finalCandidates.length, 1);
  assert.equal(finalCandidates[0].status, 'ACCEPTED');
  // Retrying unchanged bytes must also keep chunk identity stable.
  assert.deepEqual(retried?.metadata.chunks?.map((c) => c.chunkId), item.metadata.chunks?.map((c) => c.chunkId));
});

test('15. Different PDF bytes get a different contentHash and independent understanding', async () => {
  const aiService = buildMockAiService({ title: 'Generic', summary: 'Generic content.' });
  const { service } = buildHarness(aiService);
  const pdfA = await generateTextPdf(['First document with unique content A.']);
  const pdfB = await generateTextPdf(['Second, entirely different document with content B.']);

  const itemA = await service.uploadBinaryObject({
    ownerId: 'usr_pdf_15', tenantId: 'ten_pdf', type: 'FILE', filename: 'a.pdf', mimeType: 'application/pdf', data: pdfA, source: 'WEB',
  });
  const itemB = await service.uploadBinaryObject({
    ownerId: 'usr_pdf_15', tenantId: 'ten_pdf', type: 'FILE', filename: 'b.pdf', mimeType: 'application/pdf', data: pdfB, source: 'WEB',
  });

  assert.notEqual(itemA.metadata.contentHash, itemB.metadata.contentHash);
  assert.equal(itemA.status, 'READY');
  assert.equal(itemB.status, 'READY');
});

test('16. Understanding generation never itself creates a Task, Calendar event, Memory record, or Knowledge entry', async () => {
  const taskStore = new TaskStore({ dir: tempDir() });
  const memoryEngine = new MemoryEngine();
  const aiService = buildMockAiService({
    title: 'Multi-candidate PDF', summary: 'A document implying a task and a preference.',
    taskCandidates: [{ title: 'Do the thing', confidence: 0.9 }],
    memoryCandidates: [{ statement: 'User prefers PDF summaries.', memoryType: 'PREFERENCE', confidence: 0.9 }],
  });
  const { service } = buildHarness(aiService, { taskStore, memoryEngine });
  const pdf = await generateTextPdf(['A document implying a task and a preference.']);

  const item = await service.uploadBinaryObject({
    ownerId: 'usr_pdf_16', tenantId: 'ten_pdf', type: 'FILE', filename: 'multi.pdf', mimeType: 'application/pdf', data: pdf, source: 'WEB',
  });

  assert.equal((item.metadata.candidates || []).length, 2);
  assert.equal(taskStore.list('usr_pdf_16').length, 0);
  assert.equal(memoryEngine.getActiveMemories('USER', 'usr_pdf_16').length, 0);
});

test('17. Provider/model provenance is recorded truthfully on the PDF capture', async () => {
  const aiService = buildMockAiService({ title: 'Provenance check', summary: 'Checking provenance metadata.' });
  const { service } = buildHarness(aiService);
  const pdf = await generateTextPdf(['Content used to check provenance metadata recording.']);

  const item = await service.uploadBinaryObject({
    ownerId: 'usr_pdf_17', tenantId: 'ten_pdf', type: 'FILE', filename: 'provenance.pdf', mimeType: 'application/pdf', data: pdf, source: 'WEB',
  });

  assert.equal(item.metadata.modelProvider, 'openai');
  assert.equal(item.metadata.modelName, 'test-pdf-model');
  assert.ok(item.metadata.modelRequestId);
  assert.equal(typeof item.metadata.modelLatencyMs, 'number');
});

test('18. A real PDF fixture is used, and a hand-built fake %PDF-/BT/Tj string is correctly rejected by the real parser', async () => {
  const aiService = buildPoisonAiService();
  const { service } = buildHarness(aiService);
  const realPdf = await generateTextPdf(['Genuine content produced by a real PDF library.']);
  assert.ok(realPdf.subarray(0, 5).toString('ascii') === '%PDF-');

  // The kind of hand-built fixture STEP 1-3 tests used before real parsing
  // was wired in — a real parser must reject it (no valid xref/trailer),
  // proving pdf-extractor.ts is no longer the old regex-only extractor.
  const fakePdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< >>\nendobj\nBT\n(This is not a real PDF.) Tj\nET\n%%EOF');
  const item = await service.uploadBinaryObject({
    ownerId: 'usr_pdf_18', tenantId: 'ten_pdf', type: 'FILE', filename: 'fake.pdf', mimeType: 'application/pdf', data: fakePdf, source: 'WEB',
  });

  assert.equal(item.status, 'FAILED');
  assert.equal(item.metadata.errorCode, 'PDF_EXTRACTION_FAILED');
});

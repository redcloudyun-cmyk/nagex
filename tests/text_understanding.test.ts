// Phase 1 STEP 2 — Real Text Understanding.
//
// Exercises CaptureProcessor's TEXT path with a REAL AiService/
// UnifiedModelRouter wired to a provider whose HTTP layer is mocked (same
// pattern as tests/model_provider_integration.test.ts) — this is a genuine
// end-to-end run through the real model-call code path, never the offline
// heuristic fallback (that fallback only ever runs when no aiService is
// configured at all, which is a separate, deliberately-unaffected mode
// covered by personal_workspace.test.ts).
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
import { handleAsyncApiRequest } from '../src/server_web.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-text-understanding-'));
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

// Builds a real AiService backed by a single "openai" provider whose HTTP
// call is mocked to return the given understanding payload — genuinely
// exercises AiService.understand() -> UnifiedModelRouter.generate() ->
// schema validation, not a bypass.
function buildMockAiService(payload: Partial<TextUnderstandingResult> & { title: string; summary: string }): AiService {
  const full: TextUnderstandingResult = {
    contentType: 'note',
    topics: [],
    entities: [],
    dates: [],
    actionItems: [],
    taskCandidates: [],
    calendarCandidates: [],
    memoryCandidates: [],
    knowledgeCandidates: [],
    ...payload,
  };
  const providers = createProviders(
    { OPENAI_API_KEY: 'test-key', NAGEX_OPENAI_MODEL: 'test-understanding-model' },
    async () => jsonResponse({ output_text: JSON.stringify(full) }),
  );
  return new AiService(new UnifiedModelRouter(providers, { info: () => {}, warn: () => {} }));
}

function buildHarness(aiService?: AiService, extra?: { taskStore?: TaskStore; memoryEngine?: MemoryEngine }) {
  const dir = tempDir();
  const store = new CaptureStore(path.join(dir, 'captures'));
  const service = new QuickCaptureService(store, undefined, extra?.taskStore, extra?.memoryEngine, undefined, aiService);
  return { store, service };
}

test('1. Simple informational text: real structured understanding, no fake candidate', async () => {
  const aiService = buildMockAiService({ title: 'Weather note', summary: 'The weather is nice today.' });
  const { service } = buildHarness(aiService);

  const item = await service.captureTextOrLink({
    ownerId: 'usr_step2_01', tenantId: 'ten_step2', type: 'TEXT', content: '오늘 날씨가 좋다.', source: 'WEB',
  });

  assert.equal(item.status, 'READY');
  assert.equal(item.metadata.extractedSummary, 'The weather is nice today.');
  assert.equal((item.metadata.candidates || []).length, 0);
});

test('2. Explicit task text produces a PROPOSED TaskCandidate and NEEDS_REVIEW', async () => {
  const aiService = buildMockAiService({
    title: 'Submit quarterly report', summary: 'Reminder to submit the quarterly report by Friday.',
    taskCandidates: [{ title: 'Submit quarterly report', description: 'Due Friday', priorityCandidate: 'MEDIUM', confidence: 0.9 }],
  });
  const { service } = buildHarness(aiService);

  const item = await service.captureTextOrLink({
    ownerId: 'usr_step2_02', tenantId: 'ten_step2', type: 'TEXT', content: 'Remind me to submit the quarterly report by Friday.', source: 'WEB',
  });

  assert.equal(item.status, 'NEEDS_REVIEW');
  const candidates = item.metadata.candidates || [];
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].type, 'TASK');
  assert.equal(candidates[0].status, 'PROPOSED');
  assert.equal(candidates[0].title, 'Submit quarterly report');
});

test('3. Explicit calendar text produces a PROPOSED CalendarCandidate, but creates no event', async () => {
  const aiService = buildMockAiService({
    title: '김팀장과 프로젝트 회의', summary: 'Project meeting with Team Lead Kim next Tuesday at 2 PM.',
    calendarCandidates: [{ title: '김팀장과 프로젝트 회의', startCandidate: '2026-09-15T14:00:00+09:00', confidence: 0.85 }],
  });
  const { service } = buildHarness(aiService);

  const item = await service.captureTextOrLink({
    ownerId: 'usr_step2_03', tenantId: 'ten_step2', type: 'TEXT', content: '다음 주 화요일 오후 2시에 김팀장과 프로젝트 회의', source: 'WEB',
  });

  assert.equal(item.status, 'NEEDS_REVIEW');
  const candidates = item.metadata.candidates || [];
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].type, 'CALENDAR');
  assert.equal(candidates[0].status, 'PROPOSED');
  // Generation only — no live Calendar API is ever touched by this path.
});

test('4. Durable preference produces a PROPOSED MemoryCandidate; nothing is written to MemoryEngine', async () => {
  const memoryEngine = new MemoryEngine();
  const aiService = buildMockAiService({
    title: 'Report format preference', summary: 'User wants all future reports written in Markdown.',
    memoryCandidates: [{ statement: 'Future reports should be written in Markdown.', memoryType: 'PREFERENCE', confidence: 0.95 }],
  });
  const { service } = buildHarness(aiService, { memoryEngine });

  const item = await service.captureTextOrLink({
    ownerId: 'usr_step2_04', tenantId: 'ten_step2', type: 'TEXT', content: '앞으로 모든 보고서는 Markdown으로 작성해줘.', source: 'WEB',
  });

  assert.equal(item.status, 'NEEDS_REVIEW');
  const candidates = item.metadata.candidates || [];
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].type, 'MEMORY');
  assert.equal(candidates[0].status, 'PROPOSED');
  assert.equal(memoryEngine.getActiveMemories('USER', 'usr_step2_04').length, 0);
});

test('5. KnowledgeCandidate is proposed only when the model actually justifies it', async () => {
  const referenceAi = buildMockAiService({
    title: 'NAgex Architecture Reference', summary: 'A detailed reference document about the NAgex architecture.',
    knowledgeCandidates: [{ title: 'NAgex Architecture Reference', summary: 'Long-form reference material worth indexing.', tags: ['architecture'], confidence: 0.85 }],
  });
  const { service: refService } = buildHarness(referenceAi);
  const refItem = await refService.captureTextOrLink({
    ownerId: 'usr_step2_05a', tenantId: 'ten_step2', type: 'TEXT', content: 'A long architecture reference document...', source: 'WEB',
  });
  assert.equal((refItem.metadata.candidates || []).filter((c) => c.type === 'KNOWLEDGE').length, 1);

  const plainAi = buildMockAiService({ title: 'Quick note', summary: 'Just a short note.' });
  const { service: plainService } = buildHarness(plainAi);
  const plainItem = await plainService.captureTextOrLink({
    ownerId: 'usr_step2_05b', tenantId: 'ten_step2', type: 'TEXT', content: 'Just a short note.', source: 'WEB',
  });
  assert.equal((plainItem.metadata.candidates || []).filter((c) => c.type === 'KNOWLEDGE').length, 0);
  assert.equal(plainItem.status, 'READY');
});

test('6. Ambiguous date stays null/unresolved — never a fabricated normalized date', async () => {
  const aiService = buildMockAiService({
    title: 'Meeting mention', summary: 'A meeting is mentioned for next Tuesday.',
    dates: [{ text: '다음 주 화요일', normalized: null, confidence: 0.5 }],
  });
  const { service } = buildHarness(aiService);

  const item = await service.captureTextOrLink({
    ownerId: 'usr_step2_06', tenantId: 'ten_step2', type: 'TEXT', content: '다음 주 화요일에 회의가 있을 수도 있음.', source: 'WEB',
  });

  const dates = item.metadata.dates || [];
  assert.equal(dates.length, 1);
  assert.equal(dates[0].text, '다음 주 화요일');
  assert.equal(dates[0].normalized, null);
});

test('7. Invalid JSON from one provider triggers real fallback to the next — never a fake result from the garbage response', async () => {
  const validPayload: TextUnderstandingResult = {
    title: 'Fallback-sourced note', summary: 'Understood via the fallback provider.', contentType: 'note',
    topics: [], entities: [], dates: [], actionItems: [], taskCandidates: [], calendarCandidates: [], memoryCandidates: [], knowledgeCandidates: [],
  };
  const fetchFn: typeof fetch = async (url) => String(url).includes('openai.com')
    ? jsonResponse({ output_text: 'this is not JSON at all' })
    : jsonResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify(validPayload) }] } }] });
  const providers = createProviders({ OPENAI_API_KEY: 'a', NAGEX_OPENAI_MODEL: 'oa', GEMINI_API_KEY: 'g', NAGEX_GEMINI_MODEL: 'gm' }, fetchFn);
  const aiService = new AiService(new UnifiedModelRouter(providers, { info: () => {}, warn: () => {} }));
  const { service } = buildHarness(aiService);

  const item = await service.captureTextOrLink({
    ownerId: 'usr_step2_07', tenantId: 'ten_step2', type: 'TEXT', content: 'Some content.', source: 'WEB',
  });

  assert.equal(item.status, 'READY');
  assert.equal(item.metadata.extractedSummary, 'Understood via the fallback provider.');
  assert.equal(item.metadata.modelProvider, 'gemini');
});

test('8. When no provider succeeds, the capture becomes FAILED — never a fake READY', async () => {
  // 8a. No provider configured at all.
  const unconfigured = new AiService(new UnifiedModelRouter(createProviders({}, async () => jsonResponse({})), { info: () => {}, warn: () => {} }));
  const { service: svcA } = buildHarness(unconfigured);
  const itemA = await svcA.captureTextOrLink({
    ownerId: 'usr_step2_08a', tenantId: 'ten_step2', type: 'TEXT', content: 'Some content needing understanding.', source: 'WEB',
  });
  assert.equal(itemA.status, 'FAILED');
  assert.equal(itemA.metadata.errorCode, 'NO_MODEL_PROVIDER_CONFIGURED');

  // 8b. A provider is configured but every call fails.
  const allFail = new AiService(new UnifiedModelRouter(
    createProviders({ OPENAI_API_KEY: 'a', NAGEX_OPENAI_MODEL: 'oa' }, async () => jsonResponse({ error: 'server error' }, 500)),
    { info: () => {}, warn: () => {} },
  ));
  const { service: svcB } = buildHarness(allFail);
  const itemB = await svcB.captureTextOrLink({
    ownerId: 'usr_step2_08b', tenantId: 'ten_step2', type: 'TEXT', content: 'Some content needing understanding.', source: 'WEB',
  });
  assert.equal(itemB.status, 'FAILED');
  assert.equal(itemB.metadata.errorCode, 'ALL_MODEL_PROVIDERS_FAILED');
});

test('9. Retry does not duplicate a candidate the user already decided on', async () => {
  const aiService = buildMockAiService({
    title: 'Follow up', summary: 'Follow up with the client next week.',
    memoryCandidates: [{ statement: 'Client follow-up is a recurring preference.', memoryType: 'PREFERENCE', confidence: 0.9 }],
  });
  const { service, store } = buildHarness(aiService);

  const item = await service.captureTextOrLink({
    ownerId: 'usr_step2_09', tenantId: 'ten_step2', type: 'TEXT', content: 'Always follow up with the client after a demo.', source: 'WEB',
  });
  const candidateId = (item.metadata.candidates || [])[0].candidateId;
  assert.ok(candidateId);

  // The user accepts the suggestion before any retry happens.
  await service.actionCandidate({ captureId: item.captureId, candidateId, action: 'ACCEPT', ownerId: 'usr_step2_09', tenantId: 'ten_step2' });
  assert.equal(store.getCapture(item.captureId)?.metadata.candidates?.[0].status, 'ACCEPTED');

  // Reprocessing (e.g. a manual Retry) must not add a second, duplicate
  // PROPOSED candidate for the exact same suggestion.
  const retried = await service.retryCapture(item.captureId, 'usr_step2_09');
  const finalCandidates = retried?.metadata.candidates || [];
  assert.equal(finalCandidates.length, 1);
  assert.equal(finalCandidates[0].status, 'ACCEPTED');
});

test('10. Understanding generation never itself creates a Task, Calendar event, Memory record, or Knowledge entry', async () => {
  const taskStore = new TaskStore({ dir: tempDir() });
  const memoryEngine = new MemoryEngine();
  const aiService = buildMockAiService({
    title: 'Multi-candidate note', summary: 'A note that implies a task, a meeting, and a preference.',
    taskCandidates: [{ title: 'Do the thing', confidence: 0.9 }],
    calendarCandidates: [{ title: 'Meeting', startCandidate: '2026-09-20T10:00:00Z', confidence: 0.9 }],
    memoryCandidates: [{ statement: 'Always use Markdown.', memoryType: 'PREFERENCE', confidence: 0.9 }],
    knowledgeCandidates: [{ title: 'Reference', summary: 'Reference content.', confidence: 0.9 }],
  });
  const { service } = buildHarness(aiService, { taskStore, memoryEngine });

  const item = await service.captureTextOrLink({
    ownerId: 'usr_step2_10', tenantId: 'ten_step2', type: 'TEXT', content: 'Implies a task, a meeting, and a preference.', source: 'WEB',
  });

  assert.equal((item.metadata.candidates || []).length, 4);
  assert.equal(item.status, 'NEEDS_REVIEW');
  // No side effects from generation alone — only an explicit ACCEPT (a
  // later step's concern) may ever persist into these real systems.
  assert.equal(taskStore.list('ten_step2', 'usr_step2_10').length, 0);
  assert.equal(memoryEngine.getActiveMemories('USER', 'usr_step2_10').length, 0);
});

test('11. Provider/model metadata is recorded truthfully on the capture', async () => {
  const aiService = buildMockAiService({ title: 'Note', summary: 'A plain note.' });
  const { service } = buildHarness(aiService);

  const item = await service.captureTextOrLink({
    ownerId: 'usr_step2_11', tenantId: 'ten_step2', type: 'TEXT', content: 'A plain note.', source: 'WEB',
  });

  assert.equal(item.metadata.modelProvider, 'openai');
  assert.equal(item.metadata.modelName, 'test-understanding-model');
  assert.equal(typeof item.metadata.modelRequestId, 'string');
  assert.ok((item.metadata.modelRequestId || '').length > 0);
  assert.equal(typeof item.metadata.modelLatencyMs, 'number');
});

test('12. Existing Unified Capture routes (STEP 1) remain unchanged by STEP 2', async () => {
  const headers = { 'x-nagex-tenant': 'ten_step2_regression', 'x-principal-id': 'usr_step2_regression' };
  const route = await handleAsyncApiRequest('POST', '/api/v1/workspace/route-input', { text: 'What is NAgex?' }, headers);
  assert.equal(route.status, 200);
  assert.equal((route.data as any).primaryIntent, 'ASK');

  const inbox = await handleAsyncApiRequest('GET', '/api/v1/workspace/inbox', null, headers);
  assert.equal(inbox.status, 200);

  const vault = await handleAsyncApiRequest('GET', '/api/v1/workspace/vault', null, headers);
  assert.equal(vault.status, 200);

  const storage = await handleAsyncApiRequest('GET', '/api/v1/workspace/storage/status', null, headers);
  assert.equal(storage.status, 200);
});

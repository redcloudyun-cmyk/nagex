// Phase 1 STEP 5 — Canonical Candidate Model.
//
// A Candidate means: "NAgex believes this may be useful, but the user has
// not yet accepted it." This suite verifies the durable CandidateStore
// (persistence, isolation, idempotent upsert, source-change supersession,
// lifecycle transitions), that CaptureProcessor's real Understanding output
// (TEXT/URL/PDF) upserts into it with real traceable sourceRefs, that
// ACCEPT/REJECT never execute anything (item J — the central STEP 5
// guarantee), and that the new /api/v1/candidates API and Inbox surface
// consume this canonical state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { URL } from 'node:url';
import { CaptureStore } from '../src/workspace/capture.store.js';
import { QuickCaptureService } from '../src/workspace/quick-capture.service.js';
import { CandidateStore } from '../src/workspace/candidate.store.js';
import { TaskStore } from '../src/tasks/task.store.js';
import { MemoryEngine } from '../src/context/memory.engine.js';
import { KnowledgeEngine } from '../src/context/knowledge.engine.js';
import { ActionApprovalStore } from '../src/governance/action-approval.store.js';
import { NagexError } from '../src/common/errors.js';
import { AiService, type TextUnderstandingResult } from '../src/model-gateway/ai-service.js';
import { UnifiedModelRouter } from '../src/model-gateway/unified-model-router.js';
import { createProviders } from '../src/model-gateway/providers.js';
import { generateTextPdf } from './_pdf_fixtures.js';
import { server, candidateStore as productionCandidateStore, handleAsyncApiRequest } from '../src/server_web.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-candidate-model-'));
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

function buildMockAiService(payload: Partial<TextUnderstandingResult> & { title: string; summary: string }): AiService {
  const full = fullResult(payload);
  const providers = createProviders(
    { OPENAI_API_KEY: 'test-key', NAGEX_OPENAI_MODEL: 'test-candidate-model' },
    async () => jsonResponse({ output_text: JSON.stringify(full) }),
  );
  return new AiService(new UnifiedModelRouter(providers, { info: () => {}, warn: () => {} }));
}

// Poison dependencies (item J): each throws if a mutating method is ever
// invoked, so ACCEPT executing anything is a hard, loud test failure rather
// than a passive "still zero rows" check that could miss an attempted call.
class PoisonTaskStore extends TaskStore {
  public create(): never { throw new Error('TaskStore.create must never be called by candidate accept (STEP 5, item J)'); }
}
class PoisonMemoryEngine extends MemoryEngine {
  public proposeMemory(): never { throw new Error('MemoryEngine.proposeMemory must never be called by candidate accept (STEP 5, item J)'); }
}
class PoisonKnowledgeEngine extends KnowledgeEngine {
  public addDocument(): never { throw new Error('KnowledgeEngine.addDocument must never be called by candidate accept (STEP 5, item J)'); }
}
class PoisonApprovalStore extends ActionApprovalStore {
  public request(): never { throw new Error('ActionApprovalStore.request must never be called by candidate accept (STEP 5, item J)'); }
}

function buildHarness(aiService?: AiService, opts?: { poisoned?: boolean }) {
  const dir = tempDir();
  const store = new CaptureStore(path.join(dir, 'captures'));
  const candidateStore = new CandidateStore({ dir: path.join(dir, 'candidates') });
  const taskStore = opts?.poisoned ? new PoisonTaskStore({ dir: path.join(dir, 'tasks') }) : new TaskStore({ dir: path.join(dir, 'tasks') });
  const memoryEngine = opts?.poisoned ? new PoisonMemoryEngine() : new MemoryEngine();
  const knowledgeEngine = opts?.poisoned ? new PoisonKnowledgeEngine() : new KnowledgeEngine();
  const actionApprovals = opts?.poisoned ? new PoisonApprovalStore() : new ActionApprovalStore();
  const service = new QuickCaptureService(store, undefined, taskStore, memoryEngine, knowledgeEngine, aiService, undefined, undefined, actionApprovals, candidateStore);
  return { store, service, candidateStore, taskStore, memoryEngine, knowledgeEngine, actionApprovals, dir };
}

// ─── 1-3, 21-22: CandidateStore core (create/get/list, persistence,
// isolation, restart stability, fail-closed on corruption) ───

test('1. CandidateStore: create (upsert) / get / list', () => {
  const dir = tempDir();
  const store = new CandidateStore({ dir });
  const record = store.upsert({
    tenantId: 'ten_a', principalId: 'usr_a', captureId: 'cap_1', contentHash: 'h1',
    sourceRefs: ['capture:cap_1'], confidence: 0.9, title: 'Do the thing',
    type: 'TASK', payload: { name: 'Do the thing', objective: 'Because reasons' },
  });
  assert.ok(record.candidateId.startsWith('cand_'));
  assert.equal(store.get(record.candidateId)?.candidateId, record.candidateId);
  assert.equal(store.list('usr_a', 'ten_a').length, 1);
});

test('2 / 21. Candidate persistence and stable IDs across a restart (fresh CandidateStore instance, same dir)', () => {
  const dir = tempDir();
  const first = new CandidateStore({ dir });
  const record = first.upsert({
    tenantId: 'ten_a', principalId: 'usr_a', captureId: 'cap_1', contentHash: 'h1',
    sourceRefs: ['capture:cap_1'], title: 'Restart check',
    type: 'MEMORY', payload: { statement: 'User prefers dark mode.' },
  });

  const second = new CandidateStore({ dir });
  const reloaded = second.get(record.candidateId);
  assert.ok(reloaded);
  assert.equal(reloaded!.candidateId, record.candidateId);
  assert.equal(reloaded!.status, 'PROPOSED');
  assert.equal((reloaded!.payload as { statement: string }).statement, 'User prefers dark mode.');
});

test('3. Tenant/principal isolation: list() and accept() never cross tenant/principal boundaries', () => {
  const dir = tempDir();
  const store = new CandidateStore({ dir });
  const a = store.upsert({
    tenantId: 'ten_a', principalId: 'usr_a', captureId: 'cap_a', sourceRefs: ['capture:cap_a'],
    title: 'A', type: 'TASK', payload: { name: 'A' },
  });
  store.upsert({
    tenantId: 'ten_b', principalId: 'usr_b', captureId: 'cap_b', sourceRefs: ['capture:cap_b'],
    title: 'B', type: 'TASK', payload: { name: 'B' },
  });

  assert.equal(store.list('usr_a', 'ten_a').length, 1);
  assert.equal(store.list('usr_a', 'ten_a')[0].candidateId, a.candidateId);
  // Same principal id, wrong tenant: never returned.
  assert.equal(store.list('usr_a', 'ten_b').length, 0);
  // Right id, wrong tenant/principal on a mutating call: fails closed as NOT_FOUND.
  assert.throws(() => store.accept(a.candidateId, 'ten_b', 'usr_a'), (err: unknown) => err instanceof NagexError && err.code === 'CANDIDATE_NOT_FOUND');
  assert.throws(() => store.accept(a.candidateId, 'ten_a', 'usr_b'), (err: unknown) => err instanceof NagexError && err.code === 'CANDIDATE_NOT_FOUND');
});

test('22. A corrupted candidate record file fails closed (skipped, not trusted) without breaking the rest of the store', () => {
  const dir = tempDir();
  const seedStore = new CandidateStore({ dir });
  const good = seedStore.upsert({
    tenantId: 'ten_a', principalId: 'usr_a', captureId: 'cap_1', sourceRefs: ['capture:cap_1'],
    title: 'Valid record', type: 'TASK', payload: { name: 'Valid record' },
  });

  fs.writeFileSync(path.join(dir, 'cand_corrupt.json'), '{ this is not valid JSON', { encoding: 'utf8' });
  fs.writeFileSync(path.join(dir, 'cand_incomplete.json'), JSON.stringify({ candidateId: 'cand_incomplete', type: 'TASK' }), { encoding: 'utf8' });

  const reloaded = new CandidateStore({ dir });
  assert.equal(reloaded.get(good.candidateId)?.candidateId, good.candidateId);
  assert.equal(reloaded.get('cand_corrupt'), undefined);
  assert.equal(reloaded.get('cand_incomplete'), undefined);
  assert.equal(reloaded.list('usr_a', 'ten_a').length, 1);
});

// ─── 4-7: typed payloads per candidate type ───

test('4. TASK candidate payload shape', () => {
  const store = new CandidateStore({ dir: tempDir() });
  const record = store.upsert({
    tenantId: 't', principalId: 'p', captureId: 'c', sourceRefs: ['capture:c'],
    title: 'Submit report', type: 'TASK', payload: { name: 'Submit report', objective: 'Quarterly report', dueAt: '2026-10-01T00:00:00.000Z' },
  });
  assert.equal(record.type, 'TASK');
  assert.deepEqual(record.payload, { name: 'Submit report', objective: 'Quarterly report', dueAt: '2026-10-01T00:00:00.000Z' });
});

test('5. CALENDAR candidate payload shape', () => {
  const store = new CandidateStore({ dir: tempDir() });
  const record = store.upsert({
    tenantId: 't', principalId: 'p', captureId: 'c', sourceRefs: ['capture:c'],
    title: 'Design sync', type: 'CALENDAR',
    payload: { summary: 'Design sync', start: '2026-10-02T15:00:00.000Z', end: '2026-10-02T15:30:00.000Z', timezone: 'Asia/Seoul', attendees: [] },
  });
  assert.equal(record.type, 'CALENDAR');
  assert.equal((record.payload as { summary: string }).summary, 'Design sync');
});

test('6. MEMORY candidate payload shape', () => {
  const store = new CandidateStore({ dir: tempDir() });
  const record = store.upsert({
    tenantId: 't', principalId: 'p', captureId: 'c', sourceRefs: ['capture:c'],
    title: 'Remember preference', type: 'MEMORY',
    payload: { statement: 'User prefers Markdown.', category: 'PREFERENCE' },
  });
  assert.equal(record.type, 'MEMORY');
  assert.equal((record.payload as { statement: string }).statement, 'User prefers Markdown.');
});

test('7. KNOWLEDGE candidate payload shape', () => {
  const store = new CandidateStore({ dir: tempDir() });
  const record = store.upsert({
    tenantId: 't', principalId: 'p', captureId: 'cap_9', sourceRefs: ['capture:cap_9'],
    title: 'Reference doc', type: 'KNOWLEDGE',
    payload: { title: 'Reference doc', summary: 'A useful reference.', sourceCaptureId: 'cap_9' },
  });
  assert.equal(record.type, 'KNOWLEDGE');
  assert.equal((record.payload as { sourceCaptureId: string }).sourceCaptureId, 'cap_9');
});

// ─── 8-9: idempotent upsert + source-change supersession ───

test('8. Same understanding retried does not append a duplicate canonical candidate', async () => {
  const aiService = buildMockAiService({
    title: 'Follow up', summary: 'Follow up with the client.',
    taskCandidates: [{ title: 'Follow up with client', confidence: 0.9 }],
  });
  const { service, candidateStore } = buildHarness(aiService);

  const item = await service.captureTextOrLink({ ownerId: 'usr_1', tenantId: 'ten_1', type: 'TEXT', content: 'Follow up with the client after the demo.', source: 'WEB' });
  const firstIds = candidateStore.listByCapture(item.captureId, 'usr_1', 'ten_1').map((c) => c.candidateId);
  assert.equal(firstIds.length, 1);

  const retried = await service.retryCapture(item.captureId, 'usr_1');
  assert.ok(retried);
  const secondIds = candidateStore.listByCapture(item.captureId, 'usr_1', 'ten_1').map((c) => c.candidateId);
  assert.deepEqual(secondIds, firstIds, 'retry with unchanged content must reuse the same canonical candidateId, never mint a duplicate');
});

test('9. Changed contentHash: old PROPOSED candidate becomes EXPIRED, a new PROPOSED candidate is permitted', () => {
  const store = new CandidateStore({ dir: tempDir() });
  const original = store.upsert({
    tenantId: 't', principalId: 'p', captureId: 'cap_5', contentHash: 'hash_v1', sourceRefs: ['capture:cap_5'],
    title: 'Old suggestion', type: 'TASK', payload: { name: 'Old suggestion' },
  });
  assert.equal(original.status, 'PROPOSED');

  store.expireStaleForCapture('cap_5', 't', 'p', 'hash_v2');
  const afterExpiry = store.get(original.candidateId)!;
  assert.equal(afterExpiry.status, 'EXPIRED');

  const fresh = store.upsert({
    tenantId: 't', principalId: 'p', captureId: 'cap_5', contentHash: 'hash_v2', sourceRefs: ['capture:cap_5'],
    title: 'New suggestion', type: 'TASK', payload: { name: 'New suggestion' },
  });
  assert.equal(fresh.status, 'PROPOSED');
  assert.notEqual(fresh.candidateId, original.candidateId);

  // Decided (non-PROPOSED) history is never silently expired by a content change.
  const decidedDir = tempDir();
  const decidedStore = new CandidateStore({ dir: decidedDir });
  const decided = decidedStore.upsert({
    tenantId: 't', principalId: 'p', captureId: 'cap_6', contentHash: 'hash_v1', sourceRefs: ['capture:cap_6'],
    title: 'Accepted already', type: 'TASK', payload: { name: 'Accepted already' },
  });
  decidedStore.accept(decided.candidateId, 't', 'p');
  decidedStore.expireStaleForCapture('cap_6', 't', 'p', 'hash_v2');
  assert.equal(decidedStore.get(decided.candidateId)!.status, 'ACCEPTED');
});

// ─── 10-13: lifecycle transitions ───

test('10. PROPOSED -> ACCEPTED transition', () => {
  const store = new CandidateStore({ dir: tempDir() });
  const record = store.upsert({ tenantId: 't', principalId: 'p', captureId: 'c', sourceRefs: ['capture:c'], title: 'X', type: 'TASK', payload: { name: 'X' } });
  const accepted = store.accept(record.candidateId, 't', 'p');
  assert.equal(accepted.status, 'ACCEPTED');
  assert.ok(accepted.reviewedAt);
  assert.equal(accepted.review?.decision, 'ACCEPT');
});

test('11. PROPOSED -> REJECTED transition', () => {
  const store = new CandidateStore({ dir: tempDir() });
  const record = store.upsert({ tenantId: 't', principalId: 'p', captureId: 'c', sourceRefs: ['capture:c'], title: 'X', type: 'TASK', payload: { name: 'X' } });
  const rejected = store.reject(record.candidateId, 't', 'p');
  assert.equal(rejected.status, 'REJECTED');
  assert.ok(rejected.reviewedAt);
  assert.equal(rejected.review?.decision, 'REJECT');
});

test('12. PROPOSED -> EXPIRED transition', () => {
  const store = new CandidateStore({ dir: tempDir() });
  const record = store.upsert({ tenantId: 't', principalId: 'p', captureId: 'c', sourceRefs: ['capture:c'], title: 'X', type: 'TASK', payload: { name: 'X' } });
  const expired = store.expire(record.candidateId, 't', 'p');
  assert.equal(expired.status, 'EXPIRED');
});

test('13. Illegal transitions fail closed (ACCEPTED/REJECTED/EXPIRED cannot transition again)', () => {
  const store = new CandidateStore({ dir: tempDir() });
  const a = store.upsert({ tenantId: 't', principalId: 'p', captureId: 'c', sourceRefs: ['capture:c'], title: 'A', type: 'TASK', payload: { name: 'A' } });
  store.accept(a.candidateId, 't', 'p');
  assert.throws(() => store.accept(a.candidateId, 't', 'p'), (err: unknown) => err instanceof NagexError && err.code === 'CANDIDATE_ILLEGAL_TRANSITION');
  assert.throws(() => store.reject(a.candidateId, 't', 'p'), (err: unknown) => err instanceof NagexError && err.code === 'CANDIDATE_ILLEGAL_TRANSITION');

  const b = store.upsert({ tenantId: 't', principalId: 'p', captureId: 'c2', sourceRefs: ['capture:c2'], title: 'B', type: 'TASK', payload: { name: 'B' } });
  store.reject(b.candidateId, 't', 'p');
  assert.throws(() => store.accept(b.candidateId, 't', 'p'), (err: unknown) => err instanceof NagexError && err.code === 'CANDIDATE_ILLEGAL_TRANSITION');

  const c = store.upsert({ tenantId: 't', principalId: 'p', captureId: 'c3', sourceRefs: ['capture:c3'], title: 'C', type: 'TASK', payload: { name: 'C' } });
  store.expire(c.candidateId, 't', 'p');
  assert.throws(() => store.accept(c.candidateId, 't', 'p'), (err: unknown) => err instanceof NagexError && err.code === 'CANDIDATE_ILLEGAL_TRANSITION');
});

// ─── 14-17: ACCEPT never executes (the central STEP 5 guarantee) ───

test('14-17. Accepting a TASK/CALENDAR/MEMORY/KNOWLEDGE candidate never creates a Task, requests a Calendar approval, writes Memory, or indexes Knowledge', async () => {
  const aiService = buildMockAiService({
    title: 'Multi-candidate note', summary: 'Implies a task, a meeting, a preference, and a reference.',
    taskCandidates: [{ title: 'Do the thing', confidence: 0.9 }],
    calendarCandidates: [{ title: 'Team sync', startCandidate: '2026-10-05T10:00:00.000Z', confidence: 0.9 }],
    memoryCandidates: [{ statement: 'Always use Markdown.', memoryType: 'PREFERENCE', confidence: 0.9 }],
    knowledgeCandidates: [{ title: 'Reference', summary: 'Reference content.', confidence: 0.9 }],
  });
  const { service, candidateStore, taskStore, memoryEngine, knowledgeEngine, actionApprovals } = buildHarness(aiService, { poisoned: true });

  const item = await service.captureTextOrLink({ ownerId: 'usr_2', tenantId: 'ten_2', type: 'TEXT', content: 'Implies a task, a meeting, a preference, and a reference.', source: 'WEB' });
  const candidates = candidateStore.listByCapture(item.captureId, 'usr_2', 'ten_2');
  assert.equal(candidates.length, 4);

  for (const c of candidates) {
    const accepted = service.acceptCandidate(c.candidateId, 'usr_2', 'ten_2');
    assert.equal(accepted.status, 'ACCEPTED');
  }

  // If any accept had executed anything, the poisoned dependency above would
  // have thrown synchronously during acceptCandidate() and failed this test
  // already. These are an additional, passive confirmation.
  assert.equal(taskStore.list('ten_2', 'usr_2').length, 0);
  assert.equal(memoryEngine.getActiveMemories('USER', 'ten_2', 'usr_2').length, 0);
  assert.equal(knowledgeEngine.retrieveCandidates('', ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED']).length, 0);
  void actionApprovals; // present only to prove the poisoned instance was wired and never threw
});

// ─── 18: rejected candidate does not reappear ───

test('18. A rejected candidate does not reappear as a new duplicate on unchanged retry', async () => {
  const aiService = buildMockAiService({
    title: 'Reminder', summary: 'A reminder note.',
    taskCandidates: [{ title: 'Reminder task', confidence: 0.9 }],
  });
  const { service, candidateStore } = buildHarness(aiService);

  const item = await service.captureTextOrLink({ ownerId: 'usr_3', tenantId: 'ten_3', type: 'TEXT', content: 'Reminder task content.', source: 'WEB' });
  const [before] = candidateStore.listByCapture(item.captureId, 'usr_3', 'ten_3');
  service.rejectCandidate(before.candidateId, 'usr_3', 'ten_3');

  await service.retryCapture(item.captureId, 'usr_3');
  const after = candidateStore.listByCapture(item.captureId, 'usr_3', 'ten_3');
  assert.equal(after.length, 1);
  assert.equal(after[0].candidateId, before.candidateId);
  assert.equal(after[0].status, 'REJECTED');
});

// ─── 19-20: source traceability ───

test('19. sourceRefs are preserved and never fabricated for a TEXT capture (capture-level traceability)', async () => {
  const aiService = buildMockAiService({
    title: 'Traceable note', summary: 'A note with a task.',
    taskCandidates: [{ title: 'Traceable task', confidence: 0.9 }],
  });
  const { service, candidateStore } = buildHarness(aiService);

  const item = await service.captureTextOrLink({ ownerId: 'usr_4', tenantId: 'ten_4', type: 'TEXT', content: 'Traceable task content.', source: 'WEB' });
  const [candidate] = candidateStore.listByCapture(item.captureId, 'usr_4', 'ten_4');
  assert.deepEqual(candidate.sourceRefs, [`capture:${item.captureId}`]);
  assert.equal(candidate.contentHash, item.metadata.contentHash);
});

test('20. For a PDF capture, canonical candidate sourceRefs reference real ProcessingChunk ids', async () => {
  const aiService = buildMockAiService({
    title: 'Chunked PDF', summary: 'A PDF understood via a single call.',
    taskCandidates: [{ title: 'Review the report', confidence: 0.9 }],
  });
  const { service, candidateStore } = buildHarness(aiService);
  const pdf = await generateTextPdf(['Please review the report before Friday.']);

  const item = await service.uploadBinaryObject({ ownerId: 'usr_5', tenantId: 'ten_5', type: 'FILE', filename: 'report.pdf', mimeType: 'application/pdf', data: pdf, source: 'WEB' });
  assert.equal(item.status, 'NEEDS_REVIEW');

  const [candidate] = candidateStore.listByCapture(item.captureId, 'usr_5', 'ten_5');
  assert.ok(candidate, 'expected a canonical candidate for the PDF capture');
  const realChunkIds = new Set((item.metadata.chunks || []).map((c) => c.chunkId));
  assert.ok(realChunkIds.size > 0);
  for (const ref of candidate.sourceRefs) {
    assert.ok(realChunkIds.has(ref), `sourceRef ${ref} must be a real chunk id from this PDF`);
  }
});

// ─── 23: API list/get/accept/reject ───

test('23. GET /api/v1/candidates, GET /:id, POST /:id/accept, POST /:id/reject work against the real server singleton', async () => {
  // The production CandidateStore persists to real disk state, so this test
  // uses a fresh, run-unique tenant/capture identity — a fixed one would
  // collide with a PROPOSED-turned-ACCEPTED record left behind by a
  // previous test run (upsert() correctly refuses to resurrect decided
  // history, which is exactly the behavior a stale fixed id would trip on).
  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const tenantId = `ten_candidate_api_${runId}`;
  const ownerId = `usr_candidate_api_${runId}`;
  const headers = { 'x-nagex-tenant': tenantId, 'x-principal-id': ownerId };
  const seeded = productionCandidateStore.upsert({
    tenantId, principalId: ownerId, captureId: `cap_api_seed_${runId}`,
    sourceRefs: [`capture:cap_api_seed_${runId}`], title: 'API-seeded suggestion', confidence: 0.77,
    type: 'TASK', payload: { name: 'API-seeded suggestion' },
  });

  const listRes = await handleAsyncApiRequest('GET', '/api/v1/candidates', null, headers);
  assert.equal(listRes.status, 200);
  const listed = (listRes.data as { candidates: Array<{ candidateId: string }> }).candidates;
  assert.ok(listed.some((c) => c.candidateId === seeded.candidateId));

  const getRes = await handleAsyncApiRequest('GET', `/api/v1/candidates/${seeded.candidateId}`, null, headers);
  assert.equal(getRes.status, 200);
  assert.equal((getRes.data as { status: string }).status, 'PROPOSED');

  const acceptRes = await handleAsyncApiRequest('POST', `/api/v1/candidates/${seeded.candidateId}/accept`, {}, headers);
  assert.equal(acceptRes.status, 200);
  assert.equal((acceptRes.data as { status: string }).status, 'ACCEPTED');

  // Illegal transition (already ACCEPTED) surfaces as a 409, not a silent success.
  const rejectAfterAcceptRes = await handleAsyncApiRequest('POST', `/api/v1/candidates/${seeded.candidateId}/reject`, {}, headers);
  assert.equal(rejectAfterAcceptRes.status, 409);

  const seeded2 = productionCandidateStore.upsert({
    tenantId, principalId: ownerId, captureId: `cap_api_seed2_${runId}`,
    sourceRefs: [`capture:cap_api_seed2_${runId}`], title: 'Second suggestion',
    type: 'TASK', payload: { name: 'Second suggestion' },
  });
  const rejectRes = await handleAsyncApiRequest('POST', `/api/v1/candidates/${seeded2.candidateId}/reject`, {}, headers);
  assert.equal(rejectRes.status, 200);
  assert.equal((rejectRes.data as { status: string }).status, 'REJECTED');

  const notFoundRes = await handleAsyncApiRequest('GET', '/api/v1/candidates/cand_does_not_exist', null, headers);
  assert.equal(notFoundRes.status, 404);
});

// ─── 24: Inbox consumes canonical CandidateStore state ───

async function withServer(run: (origin: string) => Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test('24. The served Inbox page has a canonical-candidate container wired to GET /api/v1/candidates, and that endpoint truthfully reflects CandidateStore', async () => {
  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const tenantId = `ten_inbox_proof_${runId}`;
  const ownerId = `usr_inbox_proof_${runId}`;
  const seeded = productionCandidateStore.upsert({
    tenantId, principalId: ownerId, captureId: `cap_inbox_seed_${runId}`,
    sourceRefs: [`capture:cap_inbox_seed_${runId}`], title: 'Inbox-visible suggestion',
    type: 'TASK', payload: { name: 'Inbox-visible suggestion' },
  });

  await withServer(async (origin) => {
    const html = await (await fetch(`${origin}/`)).text();
    assert.match(html, /id="inbox-candidates-list"/);

    const appJs = await (await fetch(`${origin}/app.js`)).text();
    assert.match(appJs, /\/api\/v1\/candidates/);
    // Phase 1 STEP 6 renamed/expanded this into the full Review queue
    // renderer (Accept/Modify/Reject wired to the canonical API below).
    assert.match(appJs, /renderCandidateReviewQueue/);

    const apiRes = await fetch(`${origin}/api/v1/candidates`, {
      headers: { 'x-nagex-tenant': tenantId, 'x-principal-id': ownerId },
    });
    const apiData = (await apiRes.json()) as { candidates: Array<{ candidateId: string; status: string }> };
    assert.ok(apiData.candidates.some((c) => c.candidateId === seeded.candidateId && c.status === 'PROPOSED'));
  });
});

// ─── 25: existing understanding tests remain green is verified by the
// regression run (item S) — see the STEP 5 report, not a test in this file.

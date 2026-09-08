// Phase 1 STEP 6 — Candidate Review.
//
// Review is not execution: Accept/Modify/Reject only ever change a
// CandidateRecord's own status/payload — they never create a Task, request
// a Calendar approval, write Memory, or index Knowledge. CandidateStore/API
// is the single source of truth for review state; this suite also verifies
// (via the served app.js source, following the same pattern
// tests/navigation_redefinition.test.ts and tests/candidate_model.test.ts
// already use for frontend wiring — there is no DOM/browser execution
// harness in this repo) that the Review UI never drives its state from the
// legacy embedded metadata.candidates array.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import type { AddressInfo } from 'node:net';
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
import { server, candidateStore as productionCandidateStore, handleAsyncApiRequest } from '../src/server_web.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-candidate-review-'));
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
    { OPENAI_API_KEY: 'test-key', NAGEX_OPENAI_MODEL: 'test-review-model' },
    async () => jsonResponse({ output_text: JSON.stringify(full) }),
  );
  return new AiService(new UnifiedModelRouter(providers, { info: () => {}, warn: () => {} }));
}

class PoisonTaskStore extends TaskStore {
  public create(): never { throw new Error('TaskStore.create must never be called by candidate accept (STEP 6, item A/E)'); }
}
class PoisonMemoryEngine extends MemoryEngine {
  public proposeMemory(): never { throw new Error('MemoryEngine.proposeMemory must never be called by candidate accept (STEP 6, item A/E)'); }
}
class PoisonKnowledgeEngine extends KnowledgeEngine {
  public addDocument(): never { throw new Error('KnowledgeEngine.addDocument must never be called by candidate accept (STEP 6, item A/E)'); }
}
class PoisonApprovalStore extends ActionApprovalStore {
  public request(): never { throw new Error('ActionApprovalStore.request must never be called by candidate accept (STEP 6, item A/E)'); }
}

function buildHarness(aiService?: AiService) {
  const dir = tempDir();
  const store = new CaptureStore(path.join(dir, 'captures'));
  const candidateStore = new CandidateStore({ dir: path.join(dir, 'candidates') });
  const taskStore = new PoisonTaskStore({ dir: path.join(dir, 'tasks') });
  const memoryEngine = new PoisonMemoryEngine();
  const knowledgeEngine = new PoisonKnowledgeEngine();
  const actionApprovals = new PoisonApprovalStore();
  const service = new QuickCaptureService(store, undefined, taskStore, memoryEngine, knowledgeEngine, aiService, undefined, undefined, actionApprovals, candidateStore);
  return { store, service, candidateStore, dir };
}

async function withServer(run: (origin: string) => Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function uniqueIdentity(label: string): { tenantId: string; ownerId: string } {
  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return { tenantId: `ten_${label}_${runId}`, ownerId: `usr_${label}_${runId}` };
}

// ─── 1: Inbox loads canonical candidates ───

test('1. Inbox loading fetches real canonical candidates via GET /api/v1/candidates', async () => {
  const { tenantId, ownerId } = uniqueIdentity('review01');
  const headers = { 'x-nagex-tenant': tenantId, 'x-principal-id': ownerId };
  const seeded = productionCandidateStore.upsert({
    tenantId, principalId: ownerId, captureId: 'cap_review_1',
    sourceRefs: ['capture:cap_review_1'], title: 'Inbox review target',
    type: 'TASK', payload: { name: 'Inbox review target' },
  });

  const inboxRes = await handleAsyncApiRequest('GET', '/api/v1/workspace/inbox', null, headers);
  assert.equal(inboxRes.status, 200);
  const candRes = await handleAsyncApiRequest('GET', '/api/v1/candidates', null, headers);
  assert.equal(candRes.status, 200);
  const candidates = (candRes.data as { candidates: Array<{ candidateId: string }> }).candidates;
  assert.ok(candidates.some((c) => c.candidateId === seeded.candidateId));
});

// ─── 2: PROPOSED candidate shows Accept/Modify/Reject (source-level, item C) ───

test('2. The served Review card renderer wires Accept/Modify/Reject only for PROPOSED candidates', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();
    const cardFnMatch = appJs.match(/function renderCandidateReviewCard[\s\S]*?\n  }\n/);
    assert.ok(cardFnMatch, 'renderCandidateReviewCard function not found in served app.js');
    const body = cardFnMatch![0];
    assert.match(body, /acceptCandidate/);
    assert.match(body, /startModifyCandidate/);
    assert.match(body, /rejectCandidate/);
    // Actions are gated behind a PROPOSED check, not unconditionally shown.
    assert.match(body, /candidate\.status === 'PROPOSED'/);
  });
});

// ─── 3-9: Accept / Reject lifecycle via the real API ───

test('3. POST /api/v1/candidates/:id/accept transitions PROPOSED -> ACCEPTED', async () => {
  const { tenantId, ownerId } = uniqueIdentity('review03');
  const headers = { 'x-nagex-tenant': tenantId, 'x-principal-id': ownerId };
  const seeded = productionCandidateStore.upsert({
    tenantId, principalId: ownerId, captureId: 'cap_review_3', sourceRefs: ['capture:cap_review_3'],
    title: 'Accept me', type: 'TASK', payload: { name: 'Accept me' },
  });
  const res = await handleAsyncApiRequest('POST', `/api/v1/candidates/${seeded.candidateId}/accept`, {}, headers);
  assert.equal(res.status, 200);
  assert.equal((res.data as { status: string }).status, 'ACCEPTED');
});

test('4-7. Accepting each candidate type never creates a Task, requests a Calendar approval, writes Memory, or indexes Knowledge', async () => {
  const aiService = buildMockAiService({
    title: 'Multi-candidate note', summary: 'Implies a task, a meeting, a preference, and a reference.',
    taskCandidates: [{ title: 'Do the thing', confidence: 0.9 }],
    calendarCandidates: [{ title: 'Team sync', startCandidate: '2026-11-05T10:00:00.000Z', confidence: 0.9 }],
    memoryCandidates: [{ statement: 'Always use Markdown.', memoryType: 'PREFERENCE', confidence: 0.9 }],
    knowledgeCandidates: [{ title: 'Reference', summary: 'Reference content.', confidence: 0.9 }],
  });
  const { service, candidateStore } = buildHarness(aiService);

  const item = await service.captureTextOrLink({ ownerId: 'usr_r47', tenantId: 'ten_r47', type: 'TEXT', content: 'Implies a task, a meeting, a preference, and a reference.', source: 'WEB' });
  const candidates = candidateStore.listByCapture(item.captureId, 'usr_r47', 'ten_r47');
  assert.equal(candidates.length, 4);

  // If accepting ANY of these had executed anything, the poisoned
  // dependencies wired into buildHarness() would have thrown synchronously
  // and failed this test already — this is not a passive count check.
  for (const c of candidates) {
    const accepted = service.acceptCandidate(c.candidateId, 'usr_r47', 'ten_r47');
    assert.equal(accepted.status, 'ACCEPTED');
  }
});

test('8-9. POST .../reject transitions PROPOSED -> REJECTED, and it stays REJECTED after a fresh GET (refresh)', async () => {
  const { tenantId, ownerId } = uniqueIdentity('review89');
  const headers = { 'x-nagex-tenant': tenantId, 'x-principal-id': ownerId };
  const seeded = productionCandidateStore.upsert({
    tenantId, principalId: ownerId, captureId: 'cap_review_89', sourceRefs: ['capture:cap_review_89'],
    title: 'Reject me', type: 'TASK', payload: { name: 'Reject me' },
  });
  const rejectRes = await handleAsyncApiRequest('POST', `/api/v1/candidates/${seeded.candidateId}/reject`, {}, headers);
  assert.equal(rejectRes.status, 200);
  assert.equal((rejectRes.data as { status: string }).status, 'REJECTED');

  const refreshed = await handleAsyncApiRequest('GET', `/api/v1/candidates/${seeded.candidateId}`, null, headers);
  assert.equal(refreshed.status, 200);
  assert.equal((refreshed.data as { status: string }).status, 'REJECTED');
});

// ─── 10-13: Modify per type ───

test('10. Modify a TASK candidate', async () => {
  const { tenantId, ownerId } = uniqueIdentity('review10');
  const headers = { 'x-nagex-tenant': tenantId, 'x-principal-id': ownerId };
  const seeded = productionCandidateStore.upsert({
    tenantId, principalId: ownerId, captureId: 'cap_10', sourceRefs: ['capture:cap_10'],
    title: 'Original name', type: 'TASK', payload: { name: 'Original name' },
  });
  const res = await handleAsyncApiRequest('PATCH', `/api/v1/candidates/${seeded.candidateId}`, {
    title: 'Renamed task', payload: { name: 'Renamed task', objective: 'Finish the report', dueAt: '2026-11-01T09:00:00.000Z' },
  }, headers);
  assert.equal(res.status, 200);
  const record = res.data as { title: string; payload: { name: string; objective: string; dueAt: string }; review?: { modified?: boolean } };
  assert.equal(record.title, 'Renamed task');
  assert.equal(record.payload.name, 'Renamed task');
  assert.equal(record.payload.objective, 'Finish the report');
  assert.equal(record.review?.modified, true);
});

test('11. Modify a CALENDAR candidate', async () => {
  const { tenantId, ownerId } = uniqueIdentity('review11');
  const headers = { 'x-nagex-tenant': tenantId, 'x-principal-id': ownerId };
  const seeded = productionCandidateStore.upsert({
    tenantId, principalId: ownerId, captureId: 'cap_11', sourceRefs: ['capture:cap_11'],
    title: 'Sync', type: 'CALENDAR', payload: { summary: 'Sync', start: null, end: null },
  });
  const res = await handleAsyncApiRequest('PATCH', `/api/v1/candidates/${seeded.candidateId}`, {
    payload: { summary: 'Design sync', start: '2026-11-02T09:00:00.000Z', end: '2026-11-02T09:30:00.000Z', timezone: 'Asia/Seoul', attendees: ['a@nagex.dev', 'b@nagex.dev'] },
  }, headers);
  assert.equal(res.status, 200);
  const record = res.data as { payload: { summary: string; timezone: string; attendees: string[] } };
  assert.equal(record.payload.summary, 'Design sync');
  assert.equal(record.payload.timezone, 'Asia/Seoul');
  assert.deepEqual(record.payload.attendees, ['a@nagex.dev', 'b@nagex.dev']);
});

test('12. Modify a MEMORY candidate', async () => {
  const { tenantId, ownerId } = uniqueIdentity('review12');
  const headers = { 'x-nagex-tenant': tenantId, 'x-principal-id': ownerId };
  const seeded = productionCandidateStore.upsert({
    tenantId, principalId: ownerId, captureId: 'cap_12', sourceRefs: ['capture:cap_12'],
    title: 'Remember: old', type: 'MEMORY', payload: { statement: 'Old statement.' },
  });
  const res = await handleAsyncApiRequest('PATCH', `/api/v1/candidates/${seeded.candidateId}`, {
    payload: { statement: 'User prefers dark mode.', category: 'PREFERENCE' },
  }, headers);
  assert.equal(res.status, 200);
  const record = res.data as { payload: { statement: string; category: string } };
  assert.equal(record.payload.statement, 'User prefers dark mode.');
  assert.equal(record.payload.category, 'PREFERENCE');
});

test('13. Modify a KNOWLEDGE candidate', async () => {
  const { tenantId, ownerId } = uniqueIdentity('review13');
  const headers = { 'x-nagex-tenant': tenantId, 'x-principal-id': ownerId };
  const seeded = productionCandidateStore.upsert({
    tenantId, principalId: ownerId, captureId: 'cap_13', sourceRefs: ['capture:cap_13'],
    title: 'Ref', type: 'KNOWLEDGE', payload: { title: 'Ref', sourceCaptureId: 'cap_13' },
  });
  const res = await handleAsyncApiRequest('PATCH', `/api/v1/candidates/${seeded.candidateId}`, {
    payload: { title: 'Nebius Token Factory reference', summary: 'How to authenticate.' },
  }, headers);
  assert.equal(res.status, 200);
  const record = res.data as { payload: { title: string; summary: string; sourceCaptureId: string } };
  assert.equal(record.payload.title, 'Nebius Token Factory reference');
  assert.equal(record.payload.summary, 'How to authenticate.');
  // sourceCaptureId is never modifiable, even though it lives in payload.
  assert.equal(record.payload.sourceCaptureId, 'cap_13');
});

// ─── 14-16: validation, decided/expired guards ───

test('14. Invalid modifications are rejected — blank name, bad datetime, bad timezone, malformed email, blank statement, blank title', async () => {
  const { tenantId, ownerId } = uniqueIdentity('review14');
  const headers = { 'x-nagex-tenant': tenantId, 'x-principal-id': ownerId };

  const task = productionCandidateStore.upsert({ tenantId, principalId: ownerId, captureId: 'cap_14a', sourceRefs: ['capture:cap_14a'], title: 'T', type: 'TASK', payload: { name: 'T' } });
  const blankName = await handleAsyncApiRequest('PATCH', `/api/v1/candidates/${task.candidateId}`, { payload: { name: '   ' } }, headers);
  assert.equal(blankName.status, 400);

  const cal = productionCandidateStore.upsert({ tenantId, principalId: ownerId, captureId: 'cap_14b', sourceRefs: ['capture:cap_14b'], title: 'C', type: 'CALENDAR', payload: { summary: 'C' } });
  const badDate = await handleAsyncApiRequest('PATCH', `/api/v1/candidates/${cal.candidateId}`, { payload: { start: 'not-a-date' } }, headers);
  assert.equal(badDate.status, 400);

  const cal2 = productionCandidateStore.upsert({ tenantId, principalId: ownerId, captureId: 'cap_14c', sourceRefs: ['capture:cap_14c'], title: 'C2', type: 'CALENDAR', payload: { summary: 'C2' } });
  const badTz = await handleAsyncApiRequest('PATCH', `/api/v1/candidates/${cal2.candidateId}`, { payload: { timezone: 'Not/ARealZone' } }, headers);
  assert.equal(badTz.status, 400);

  const cal3 = productionCandidateStore.upsert({ tenantId, principalId: ownerId, captureId: 'cap_14d', sourceRefs: ['capture:cap_14d'], title: 'C3', type: 'CALENDAR', payload: { summary: 'C3' } });
  const badEmail = await handleAsyncApiRequest('PATCH', `/api/v1/candidates/${cal3.candidateId}`, { payload: { attendees: ['not-an-email'] } }, headers);
  assert.equal(badEmail.status, 400);

  const mem = productionCandidateStore.upsert({ tenantId, principalId: ownerId, captureId: 'cap_14e', sourceRefs: ['capture:cap_14e'], title: 'M', type: 'MEMORY', payload: { statement: 'x' } });
  const blankStatement = await handleAsyncApiRequest('PATCH', `/api/v1/candidates/${mem.candidateId}`, { payload: { statement: '  ' } }, headers);
  assert.equal(blankStatement.status, 400);

  const know = productionCandidateStore.upsert({ tenantId, principalId: ownerId, captureId: 'cap_14f', sourceRefs: ['capture:cap_14f'], title: 'K', type: 'KNOWLEDGE', payload: { title: 'K', sourceCaptureId: 'cap_14f' } });
  const blankTitle = await handleAsyncApiRequest('PATCH', `/api/v1/candidates/${know.candidateId}`, { payload: { title: '' } }, headers);
  assert.equal(blankTitle.status, 400);
});

test('15. A decided (ACCEPTED) candidate cannot be modified', async () => {
  const { tenantId, ownerId } = uniqueIdentity('review15');
  const headers = { 'x-nagex-tenant': tenantId, 'x-principal-id': ownerId };
  const seeded = productionCandidateStore.upsert({ tenantId, principalId: ownerId, captureId: 'cap_15', sourceRefs: ['capture:cap_15'], title: 'D', type: 'TASK', payload: { name: 'D' } });
  await handleAsyncApiRequest('POST', `/api/v1/candidates/${seeded.candidateId}/accept`, {}, headers);
  const res = await handleAsyncApiRequest('PATCH', `/api/v1/candidates/${seeded.candidateId}`, { payload: { name: 'Changed after accept' } }, headers);
  assert.equal(res.status, 409);
});

test('16. An EXPIRED candidate cannot be modified or accepted', () => {
  const { service, candidateStore } = buildHarness();
  const seeded = candidateStore.upsert({
    tenantId: 't16', principalId: 'p16', captureId: 'cap_16', contentHash: 'h1', sourceRefs: ['capture:cap_16'],
    title: 'E', type: 'TASK', payload: { name: 'E' },
  });
  candidateStore.expireStaleForCapture('cap_16', 't16', 'p16', 'h2');
  assert.equal(candidateStore.get(seeded.candidateId)!.status, 'EXPIRED');

  assert.throws(() => service.modifyCandidate(seeded.candidateId, 'p16', 't16', { payload: { name: 'X' } }),
    (err: unknown) => err instanceof NagexError && err.code === 'CANDIDATE_NOT_MODIFIABLE');
  assert.throws(() => service.acceptCandidate(seeded.candidateId, 'p16', 't16'),
    (err: unknown) => err instanceof NagexError && err.code === 'CANDIDATE_ILLEGAL_TRANSITION');
});

// ─── 17-18: identity/traceability preserved across Modify ───

test('17-18. candidateId, captureId, contentHash, and sourceRefs are preserved after modification', async () => {
  const { tenantId, ownerId } = uniqueIdentity('review1718');
  const headers = { 'x-nagex-tenant': tenantId, 'x-principal-id': ownerId };
  const seeded = productionCandidateStore.upsert({
    tenantId, principalId: ownerId, captureId: 'cap_1718', contentHash: 'hash_fixed', sourceRefs: ['chk_abc_0', 'chk_abc_1'],
    title: 'Preserve me', type: 'TASK', payload: { name: 'Preserve me' },
  });
  const res = await handleAsyncApiRequest('PATCH', `/api/v1/candidates/${seeded.candidateId}`, { payload: { name: 'Preserved, renamed' } }, headers);
  assert.equal(res.status, 200);
  const record = res.data as { candidateId: string; captureId: string; contentHash: string; sourceRefs: string[] };
  assert.equal(record.candidateId, seeded.candidateId);
  assert.equal(record.captureId, 'cap_1718');
  assert.equal(record.contentHash, 'hash_fixed');
  assert.deepEqual(record.sourceRefs, ['chk_abc_0', 'chk_abc_1']);
});

// ─── 19: stale/concurrent transition ───

test('19. Accepting an already-decided candidate returns a conflict, and a subsequent GET reflects the real current state', async () => {
  const { tenantId, ownerId } = uniqueIdentity('review19');
  const headers = { 'x-nagex-tenant': tenantId, 'x-principal-id': ownerId };
  const seeded = productionCandidateStore.upsert({ tenantId, principalId: ownerId, captureId: 'cap_19', sourceRefs: ['capture:cap_19'], title: 'S', type: 'TASK', payload: { name: 'S' } });

  const first = await handleAsyncApiRequest('POST', `/api/v1/candidates/${seeded.candidateId}/accept`, {}, headers);
  assert.equal(first.status, 200);
  assert.equal((first.data as { status: string }).status, 'ACCEPTED');

  // Simulates a second, now-stale session trying to accept the same
  // candidate concurrently.
  const second = await handleAsyncApiRequest('POST', `/api/v1/candidates/${seeded.candidateId}/accept`, {}, headers);
  assert.equal(second.status, 409);

  const current = await handleAsyncApiRequest('GET', `/api/v1/candidates/${seeded.candidateId}`, null, headers);
  assert.equal(current.status, 200);
  assert.equal((current.data as { status: string }).status, 'ACCEPTED');
});

// ─── 20-22, 24: Inbox ordering, Home cap, embedded-array independence,
// keyboard/modal safety — verified against the served app.js source, the
// same technique tests/navigation_redefinition.test.ts already uses for
// frontend structure, since this repo has no DOM/browser execution harness.

test('20. Inbox review queue sorts PROPOSED candidates before resolved ones, newest first', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();
    const fnMatch = appJs.match(/async function renderCandidateReviewQueue[\s\S]*?\n  }\n/);
    assert.ok(fnMatch, 'renderCandidateReviewQueue not found');
    const body = fnMatch![0];
    assert.match(body, /status === 'PROPOSED'/);
    assert.match(body, /byRecency/);
    // The default visible set is PROPOSED-only unless the resolved toggle is on.
    assert.match(body, /candidatesShowResolved \? \[\.\.\.proposed, \.\.\.resolved\] : proposed/);
  });
});

test('21. Home "Needs your attention" caps at 2 unresolved items shared with Action Approvals', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();
    const sectionMatch = appJs.match(/\/\/ 2\. Needs your attention[\s\S]*?\n    }\n/);
    assert.ok(sectionMatch, 'Needs your attention section not found');
    const body = sectionMatch![0];
    assert.match(body, /proposedCandidates = \(state\.candidates \|\| \[\]\)\.filter\(\(c\) => c\.status === 'PROPOSED'\)/);
    // Phase 1 STEP 8 combined this with FAILED-action/NEEDS_HUMAN sources
    // into one fairly-pooled list, capped once at the end (item C).
    assert.match(body, /attentionItems = \[/);
    assert.match(body, /\]\.slice\(0, 2\)/);
  });
});

test('22. No candidate-review code path reads capture.metadata.candidates[] to drive UI status/actions', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();
    const reviewSectionStart = appJs.indexOf('Phase 1 STEP 6 — Candidate Review');
    assert.ok(reviewSectionStart > 0, 'STEP 6 Candidate Review section marker not found');
    const reviewSection = appJs.slice(reviewSectionStart, appJs.indexOf('window.NAGEX.rejectCandidate = async', reviewSectionStart) + 500);
    // Strip comments before checking for real code references — the
    // section documents in prose that it must not read the embedded array.
    const codeOnly = reviewSection.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    assert.doesNotMatch(codeOnly, /metadata\??\.\??candidates\b/);
  });
});

test('23. New STEP 6 review i18n strings resolve in both EN and KR', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'public', 'i18n.js'), 'utf8');
  const documentStub = { documentElement: {} as Record<string, unknown>, title: '', querySelectorAll: () => [] as unknown[] };
  const storage: Record<string, string> = {};
  const localStorageStub = {
    getItem: (key: string) => (Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null),
    setItem: (key: string, value: string) => { storage[key] = value; },
  };
  const sandbox: Record<string, unknown> = { document: documentStub, localStorage: localStorageStub };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'i18n.js' });
  const i18n = (sandbox.window as Record<string, unknown>).NAGEX_I18N as { t: (k: string) => string; setLocale: (l: string) => void };

  const keys = [
    'workspace.candidateStatusProposed', 'workspace.candidateStatusAccepted', 'workspace.candidateStatusRejected',
    'workspace.candidateStatusExpired', 'workspace.candidateModify', 'workspace.candidateSave', 'workspace.candidateCancel',
    'workspace.candidateSourceChanged', 'workspace.needsReview',
  ];
  for (const key of keys) {
    assert.notEqual(i18n.t(key), key, `EN translation missing for ${key}`);
  }
  i18n.setLocale('ko');
  for (const key of keys) {
    assert.notEqual(i18n.t(key), key, `KR translation missing for ${key}`);
  }
  assert.equal(i18n.t('workspace.candidateStatusProposed'), '제안됨');
  assert.equal(i18n.t('workspace.candidateSourceChanged'), '원본 내용이 변경됨');
});

test('24. Escape in the Modify form cancels without saving; Cancel never calls a mutating API', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();
    assert.match(appJs, /CAND_ESC = \(id\) => `if\(event\.key==='Escape'\)/);
    assert.match(appJs, /cancelModifyCandidate\('\$\{id\}'\)/);

    const cancelFnMatch = appJs.match(/window\.NAGEX\.cancelModifyCandidate = \(candidateId\) => \{[\s\S]*?\};/);
    assert.ok(cancelFnMatch, 'cancelModifyCandidate handler not found');
    const body = cancelFnMatch![0];
    assert.doesNotMatch(body, /apiFetch/);
    assert.match(body, /candidateEditState = null/);
  });
});

// 25. Existing CandidateStore tests remain green — verified by the
// regression run (item T), not a test in this file.

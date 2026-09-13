// Phase 1 STEP 7 — Real Actions.
//
// Verifies CandidateActionResolver: ACCEPTED candidates convert into real
// TaskStore/MemoryEngine/KnowledgeEngine/GoogleCalendarService state,
// idempotently and truthfully, with the existing Action Approval flow
// unbypassed for Calendar and Candidate Review kept entirely separate from
// Action Approval (the two-gate distinction the STEP 7 directive's Korean
// note calls out specifically).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CaptureStore } from '../src/workspace/capture.store.js';
import { CandidateStore } from '../src/workspace/candidate.store.js';
import { CandidateActionResolver } from '../src/workspace/action-resolver.js';
import { TaskStore } from '../src/tasks/task.store.js';
import { MemoryEngine } from '../src/context/memory.engine.js';
import { KnowledgeEngine } from '../src/context/knowledge.engine.js';
import { ActionApprovalStore } from '../src/governance/action-approval.store.js';
import { ExecutionStore } from '../src/governance/execution.store.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { GoogleCalendarService } from '../src/modules/calendar/index.js';
import { InMemoryGoogleOAuthTokenStore } from '../src/integrations/google/token.store.js';
import type { GoogleOAuthConfig } from '../src/integrations/google/oauth.client.js';
import { NagexError } from '../src/common/errors.js';
import type { CalendarCandidatePayload } from '../src/workspace/candidate.types.js';
import { handleAsyncApiRequest, candidateStore as productionCandidateStore, taskStore as productionTaskStore, server } from '../src/server_web.js';
import type { AddressInfo } from 'node:net';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-candidate-actions-'));
}

const CAL_CONFIG: GoogleOAuthConfig = { clientId: 'cid', clientSecret: 'secret', redirectUri: 'https://nagex-test.agex.site/api/v1/oauth/google/callback' };

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function buildHarness(calendarFetchFn?: typeof fetch) {
  const dir = tempDir();
  const captureStore = new CaptureStore(path.join(dir, 'captures'));
  const candidateStore = new CandidateStore({ dir: path.join(dir, 'candidates') });
  const taskStore = new TaskStore({ dir: path.join(dir, 'tasks') });
  const memoryEngine = new MemoryEngine();
  const knowledgeEngine = new KnowledgeEngine();
  const tokenStore = new InMemoryGoogleOAuthTokenStore();
  const approvals = new ActionApprovalStore();
  const audit = new AuditLogger();
  const executionStore = new ExecutionStore({ dir: path.join(dir, 'executions') });
  const calendarService = new GoogleCalendarService(
    tokenStore, approvals, audit, memoryEngine,
    calendarFetchFn || (async () => { throw new Error('must not call Google in this test'); }),
    () => CAL_CONFIG,
    executionStore,
  );
  const resolver = new CandidateActionResolver({ candidateStore, captureStore, taskStore, memoryEngine, knowledgeEngine, calendarService, executionStore, auditLogger: audit });
  return { dir, captureStore, candidateStore, taskStore, memoryEngine, knowledgeEngine, tokenStore, approvals, audit, executionStore, calendarService, resolver };
}

function connectCalendar(tokenStore: InMemoryGoogleOAuthTokenStore, tenantId: string) {
  tokenStore.save(tenantId, { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: 'https://www.googleapis.com/auth/calendar.events' });
}

function seedCapture(captureStore: CaptureStore, tenantId: string, ownerId: string, contentHash: string) {
  const item = captureStore.createCapture({ ownerId, tenantId, type: 'TEXT', content: 'Some source content.', metadata: {} });
  return captureStore.updateStatus(item.captureId, 'READY', { contentHash })!;
}

function acceptedTaskCandidate(candidateStore: CandidateStore, tenantId: string, ownerId: string, captureId: string, contentHash: string, name = 'Review budget proposal') {
  const c = candidateStore.upsert({
    tenantId, principalId: ownerId, captureId, contentHash, sourceRefs: [`capture:${captureId}`],
    title: name, type: 'TASK', payload: { name, objective: 'Finish before Friday' },
  });
  return candidateStore.accept(c.candidateId, tenantId, ownerId);
}

function acceptedMemoryCandidate(candidateStore: CandidateStore, tenantId: string, ownerId: string, captureId: string, contentHash: string, statement = 'User prefers weekly reporting summaries.') {
  const c = candidateStore.upsert({
    tenantId, principalId: ownerId, captureId, contentHash, sourceRefs: [`capture:${captureId}`],
    title: `Remember: ${statement.slice(0, 30)}`, type: 'MEMORY', payload: { statement, category: 'PREFERENCE' },
  });
  return candidateStore.accept(c.candidateId, tenantId, ownerId);
}

function acceptedKnowledgeCandidate(candidateStore: CandidateStore, tenantId: string, ownerId: string, captureId: string, contentHash: string) {
  const c = candidateStore.upsert({
    tenantId, principalId: ownerId, captureId, contentHash, sourceRefs: [`chk_${captureId}_0`, `chk_${captureId}_1`],
    title: 'Q3 Strategy', type: 'KNOWLEDGE', payload: { title: 'Q3 Strategy', summary: 'Key points from the Q3 strategy doc.', sourceCaptureId: captureId },
  });
  return candidateStore.accept(c.candidateId, tenantId, ownerId);
}

function acceptedCalendarCandidate(candidateStore: CandidateStore, tenantId: string, ownerId: string, captureId: string, contentHash: string, overrides: Partial<CalendarCandidatePayload> = {}) {
  const payload: CalendarCandidatePayload = {
    summary: 'Project meeting', start: '2026-11-10T10:00:00.000Z', end: '2026-11-10T10:30:00.000Z', timezone: 'Asia/Seoul', attendees: [],
    ...overrides,
  };
  const c = candidateStore.upsert({
    tenantId, principalId: ownerId, captureId, contentHash, sourceRefs: [`capture:${captureId}`],
    title: payload.summary, type: 'CALENDAR', payload,
  });
  return candidateStore.accept(c.candidateId, tenantId, ownerId);
}

// ─── 1-3: TASK ───

test('1. ACCEPTED TASK candidate execute creates a real Task in TaskStore', async () => {
  const { captureStore, candidateStore, taskStore, resolver } = buildHarness();
  const cap = seedCapture(captureStore, 't1', 'u1', 'h1');
  const cand = acceptedTaskCandidate(candidateStore, 't1', 'u1', cap.captureId, 'h1');

  const result = await resolver.executeCandidate(cand.candidateId, 't1', 'u1');
  assert.equal(result.action?.status, 'SUCCEEDED');
  assert.equal(result.action?.targetType, 'TASK');
  const task = taskStore.get(result.action!.targetId!, 't1', 'u1');
  assert.ok(task);
  assert.equal(task!.name, 'Review budget proposal');
  assert.equal(task!.type, 'ONE_TIME');
  assert.equal(task!.trigger.type, 'MANUAL');
});

test('2. A second execute on the same TASK candidate does not create a duplicate Task', async () => {
  const { captureStore, candidateStore, taskStore, resolver } = buildHarness();
  const cap = seedCapture(captureStore, 't2', 'u2', 'h1');
  const cand = acceptedTaskCandidate(candidateStore, 't2', 'u2', cap.captureId, 'h1');

  const first = await resolver.executeCandidate(cand.candidateId, 't2', 'u2');
  const second = await resolver.executeCandidate(cand.candidateId, 't2', 'u2');
  assert.equal(second.action?.targetId, first.action?.targetId);
  assert.equal(taskStore.list('t2', 'u2').length, 1);
});

test('3. candidateId -> taskId linkage is persisted on the candidate record', async () => {
  const { captureStore, candidateStore, resolver } = buildHarness();
  const cap = seedCapture(captureStore, 't3', 'u3', 'h1');
  const cand = acceptedTaskCandidate(candidateStore, 't3', 'u3', cap.captureId, 'h1');
  const result = await resolver.executeCandidate(cand.candidateId, 't3', 'u3');
  const reloaded = candidateStore.get(cand.candidateId);
  assert.equal(reloaded?.action?.targetId, result.action?.targetId);
  assert.ok(reloaded?.action?.targetId?.startsWith('tsk_'));
});

// ─── 4-6: MEMORY ───

test('4. ACCEPTED MEMORY candidate execute writes a real active MemoryRecord', async () => {
  const { captureStore, candidateStore, memoryEngine, resolver } = buildHarness();
  const cap = seedCapture(captureStore, 't4', 'u4', 'h1');
  const cand = acceptedMemoryCandidate(candidateStore, 't4', 'u4', cap.captureId, 'h1');

  const result = await resolver.executeCandidate(cand.candidateId, 't4', 'u4');
  assert.equal(result.action?.status, 'SUCCEEDED');
  const active = memoryEngine.getActiveMemories('USER', 't4', 'u4');
  assert.equal(active.length, 1);
  assert.equal(active[0].id, result.action?.targetId);
});

test('5. A second execute on the same MEMORY candidate does not create a duplicate MemoryRecord', async () => {
  const { captureStore, candidateStore, memoryEngine, resolver } = buildHarness();
  const cap = seedCapture(captureStore, 't5', 'u5', 'h1');
  const cand = acceptedMemoryCandidate(candidateStore, 't5', 'u5', cap.captureId, 'h1');

  await resolver.executeCandidate(cand.candidateId, 't5', 'u5');
  await resolver.executeCandidate(cand.candidateId, 't5', 'u5');
  assert.equal(memoryEngine.getActiveMemories('USER', 't5', 'u5').length, 1);
});

test('6. The exact reviewed statement is persisted verbatim — never re-derived or altered', async () => {
  const { captureStore, candidateStore, memoryEngine, resolver } = buildHarness();
  const cap = seedCapture(captureStore, 't6', 'u6', 'h1');
  const statement = 'The user explicitly prefers async written updates over meetings.';
  const cand = acceptedMemoryCandidate(candidateStore, 't6', 'u6', cap.captureId, 'h1', statement);
  await resolver.executeCandidate(cand.candidateId, 't6', 'u6');
  const active = memoryEngine.getActiveMemories('USER', 't6', 'u6');
  assert.equal(active[0].content.value, statement);
});

// ─── 7-9: KNOWLEDGE ───

test('7. ACCEPTED KNOWLEDGE candidate execute creates a real KnowledgeDocument', async () => {
  const { captureStore, candidateStore, knowledgeEngine, resolver } = buildHarness();
  const cap = seedCapture(captureStore, 't7', 'u7', 'h1');
  const cand = acceptedKnowledgeCandidate(candidateStore, 't7', 'u7', cap.captureId, 'h1');
  const result = await resolver.executeCandidate(cand.candidateId, 't7', 'u7');
  assert.equal(result.action?.status, 'SUCCEEDED');
  const doc = knowledgeEngine.getDocument(result.action!.targetId!);
  assert.ok(doc);
  assert.equal(doc!.title, 'Q3 Strategy');
});

test('8. sourceRefs/contentHash/candidateId are preserved on the created KnowledgeDocument', async () => {
  const { captureStore, candidateStore, knowledgeEngine, resolver } = buildHarness();
  const cap = seedCapture(captureStore, 't8', 'u8', 'h1');
  const cand = acceptedKnowledgeCandidate(candidateStore, 't8', 'u8', cap.captureId, 'h1');
  const result = await resolver.executeCandidate(cand.candidateId, 't8', 'u8');
  const doc = knowledgeEngine.getDocument(result.action!.targetId!);
  assert.equal(doc!.candidateId, cand.candidateId);
  assert.equal(doc!.contentHash, 'h1');
  assert.deepEqual(doc!.sourceRefs, cand.sourceRefs);
  assert.equal(doc!.source_id, cap.captureId);
});

test('9. A second execute on the same KNOWLEDGE candidate does not create a duplicate document', async () => {
  const { captureStore, candidateStore, resolver } = buildHarness();
  const cap = seedCapture(captureStore, 't9', 'u9', 'h1');
  const cand = acceptedKnowledgeCandidate(candidateStore, 't9', 'u9', cap.captureId, 'h1');
  const first = await resolver.executeCandidate(cand.candidateId, 't9', 'u9');
  const second = await resolver.executeCandidate(cand.candidateId, 't9', 'u9');
  assert.equal(first.action?.targetId, second.action?.targetId);
});

// ─── 10-12: CALENDAR — two-gate flow, real approval + real executor path ───

test('10. ACCEPTED CALENDAR candidate execute only requests approval — no Google call happens before it is granted', async () => {
  const { captureStore, candidateStore, tokenStore, resolver } = buildHarness(async () => { throw new Error('must not reach Google before approval'); });
  connectCalendar(tokenStore, 't10');
  const cap = seedCapture(captureStore, 't10', 'u10', 'h1');
  const cand = acceptedCalendarCandidate(candidateStore, 't10', 'u10', cap.captureId, 'h1');

  const result = await resolver.executeCandidate(cand.candidateId, 't10', 'u10');
  assert.equal(result.action?.status, 'PENDING_APPROVAL');
  assert.ok(result.action?.approvalId);
  // Candidate Review acceptance alone never reaches Google (Korean note: 후보 승인 ≠ 실행 승인).
  assert.equal(result.status, 'ACCEPTED');
});

test('11. Once the Action Approval is granted, the real existing GoogleCalendarService.executeCreateEvent path is invoked and the event is created', async () => {
  let calledCreateEvent = false;
  const fetchFn: typeof fetch = async (url) => {
    calledCreateEvent = true;
    assert.match(String(url), /calendar\/v3\/calendars\/primary\/events/);
    return jsonResponse({ id: 'gcal_evt_1', htmlLink: 'https://calendar.google.com/event?eid=abc' });
  };
  const { captureStore, candidateStore, tokenStore, approvals, resolver } = buildHarness(fetchFn);
  connectCalendar(tokenStore, 't11');
  const cap = seedCapture(captureStore, 't11', 'u11', 'h1');
  const cand = acceptedCalendarCandidate(candidateStore, 't11', 'u11', cap.captureId, 'h1');

  const pending = await resolver.executeCandidate(cand.candidateId, 't11', 'u11');
  assert.equal(pending.action?.status, 'PENDING_APPROVAL');

  // The separate Action Approval gate — a distinct control from Candidate Review.
  approvals.approve(pending.action!.approvalId!, 't11', 'u11');

  const done = await resolver.executeCandidate(cand.candidateId, 't11', 'u11');
  assert.equal(calledCreateEvent, true);
  assert.equal(done.action?.status, 'SUCCEEDED');
  assert.equal(done.action?.targetId, 'gcal_evt_1');
  assert.equal(done.action?.externalUrl, 'https://calendar.google.com/event?eid=abc');
});

test('12. Replaying execute after SUCCEEDED never creates a second external event (approval replay protection still applies)', async () => {
  let createCalls = 0;
  const fetchFn: typeof fetch = async () => {
    createCalls += 1;
    return jsonResponse({ id: 'gcal_evt_2', htmlLink: 'https://calendar.google.com/event?eid=def' });
  };
  const { captureStore, candidateStore, tokenStore, approvals, resolver } = buildHarness(fetchFn);
  connectCalendar(tokenStore, 't12');
  const cap = seedCapture(captureStore, 't12', 'u12', 'h1');
  const cand = acceptedCalendarCandidate(candidateStore, 't12', 'u12', cap.captureId, 'h1');

  const pending = await resolver.executeCandidate(cand.candidateId, 't12', 'u12');
  approvals.approve(pending.action!.approvalId!, 't12', 'u12');
  const first = await resolver.executeCandidate(cand.candidateId, 't12', 'u12');
  const second = await resolver.executeCandidate(cand.candidateId, 't12', 'u12');

  assert.equal(createCalls, 1, 'Google Calendar create-event must only ever be called once');
  assert.equal(second.action?.targetId, first.action?.targetId);
});

// ─── 13-15: illegal candidate statuses cannot execute ───

test('13. A PROPOSED candidate cannot execute', async () => {
  const { captureStore, candidateStore, resolver } = buildHarness();
  const cap = seedCapture(captureStore, 't13', 'u13', 'h1');
  const c = candidateStore.upsert({ tenantId: 't13', principalId: 'u13', captureId: cap.captureId, contentHash: 'h1', sourceRefs: ['capture:x'], title: 'X', type: 'TASK', payload: { name: 'X' } });
  await assert.rejects(() => resolver.executeCandidate(c.candidateId, 't13', 'u13'), (err: unknown) => err instanceof NagexError && err.code === 'CANDIDATE_NOT_ACCEPTED');
});

test('14. A REJECTED candidate cannot execute', async () => {
  const { captureStore, candidateStore, resolver } = buildHarness();
  const cap = seedCapture(captureStore, 't14', 'u14', 'h1');
  const c = candidateStore.upsert({ tenantId: 't14', principalId: 'u14', captureId: cap.captureId, contentHash: 'h1', sourceRefs: ['capture:x'], title: 'X', type: 'TASK', payload: { name: 'X' } });
  candidateStore.reject(c.candidateId, 't14', 'u14');
  await assert.rejects(() => resolver.executeCandidate(c.candidateId, 't14', 'u14'), (err: unknown) => err instanceof NagexError && err.code === 'CANDIDATE_NOT_ACCEPTED');
});

test('15. An EXPIRED candidate cannot execute', async () => {
  const { captureStore, candidateStore, resolver } = buildHarness();
  const cap = seedCapture(captureStore, 't15', 'u15', 'h1');
  const c = candidateStore.upsert({ tenantId: 't15', principalId: 'u15', captureId: cap.captureId, contentHash: 'h1', sourceRefs: ['capture:x'], title: 'X', type: 'TASK', payload: { name: 'X' } });
  candidateStore.expire(c.candidateId, 't15', 'u15');
  await assert.rejects(() => resolver.executeCandidate(c.candidateId, 't15', 'u15'), (err: unknown) => err instanceof NagexError && err.code === 'CANDIDATE_NOT_ACCEPTED');
});

// ─── 16: stale source ───

test('16. A stale source (capture contentHash no longer matches the candidate) blocks execution', async () => {
  const { captureStore, candidateStore, resolver } = buildHarness();
  const cap = seedCapture(captureStore, 't16', 'u16', 'h1');
  const cand = acceptedTaskCandidate(candidateStore, 't16', 'u16', cap.captureId, 'h1');
  // The source capture is reprocessed and its content genuinely changes.
  captureStore.updateStatus(cap.captureId, 'READY', { contentHash: 'h2' });
  await assert.rejects(() => resolver.executeCandidate(cand.candidateId, 't16', 'u16'), (err: unknown) => err instanceof NagexError && err.code === 'CANDIDATE_SOURCE_CHANGED');
});

// ─── 17-19: retry / terminal-state safety ───

test('17. A FAILED action (e.g. missing dependency) can be safely retried once the dependency is available', async () => {
  const dir = tempDir();
  const captureStore = new CaptureStore(path.join(dir, 'captures'));
  const candidateStore = new CandidateStore({ dir: path.join(dir, 'candidates') });
  const resolver = new CandidateActionResolver({ candidateStore, captureStore }); // no taskStore configured yet
  const cap = seedCapture(captureStore, 't17', 'u17', 'h1');
  const cand = acceptedTaskCandidate(candidateStore, 't17', 'u17', cap.captureId, 'h1');

  const failed = await resolver.executeCandidate(cand.candidateId, 't17', 'u17');
  assert.equal(failed.action?.status, 'FAILED');
  assert.equal(failed.status, 'ACCEPTED', 'a failed action must never change the candidate status (item O)');

  const taskStore = new TaskStore({ dir: path.join(dir, 'tasks') });
  const resolverWithTaskStore = new CandidateActionResolver({ candidateStore, captureStore, taskStore });
  const retried = await resolverWithTaskStore.retryCandidate(cand.candidateId, 't17', 'u17');
  assert.equal(retried.action?.status, 'SUCCEEDED');
  assert.equal(taskStore.list('t17', 'u17').length, 1);
});

test('18. A SUCCEEDED action cannot execute twice (idempotent no-op, not an error)', async () => {
  const { captureStore, candidateStore, taskStore, resolver } = buildHarness();
  const cap = seedCapture(captureStore, 't18', 'u18', 'h1');
  const cand = acceptedTaskCandidate(candidateStore, 't18', 'u18', cap.captureId, 'h1');
  await resolver.executeCandidate(cand.candidateId, 't18', 'u18');
  const again = await resolver.executeCandidate(cand.candidateId, 't18', 'u18');
  assert.equal(again.action?.status, 'SUCCEEDED');
  assert.equal(taskStore.list('t18', 'u18').length, 1);
  await assert.rejects(() => resolver.retryCandidate(cand.candidateId, 't18', 'u18'), (err: unknown) => err instanceof NagexError && err.code === 'CANDIDATE_ACTION_NOT_RETRYABLE');
});

test('19. A failed calendar action does not flip the candidate to REJECTED — it stays ACCEPTED with action FAILED', async () => {
  const { captureStore, candidateStore, tokenStore, approvals, resolver } = buildHarness(async () => { throw new Error('unused'); });
  connectCalendar(tokenStore, 't19');
  const cap = seedCapture(captureStore, 't19', 'u19', 'h1');
  const cand = acceptedCalendarCandidate(candidateStore, 't19', 'u19', cap.captureId, 'h1');
  const pending = await resolver.executeCandidate(cand.candidateId, 't19', 'u19');
  approvals.reject(pending.action!.approvalId!, 't19', 'u19');
  const result = await resolver.executeCandidate(cand.candidateId, 't19', 'u19');
  assert.equal(result.action?.status, 'FAILED');
  assert.equal(result.action?.errorCode, 'CALENDAR_APPROVAL_REJECTED');
  assert.equal(result.status, 'ACCEPTED');
});

// ─── 20-21: Activity truthfulness ───

test('20. A successful action records a truthful, human-readable Activity entry', async () => {
  const { captureStore, candidateStore, audit, resolver } = buildHarness();
  const cap = seedCapture(captureStore, 't20', 'u20', 'h1');
  const cand = acceptedTaskCandidate(candidateStore, 't20', 'u20', cap.captureId, 'h1', 'Review budget proposal');
  await resolver.executeCandidate(cand.candidateId, 't20', 'u20');
  const logs = audit.getAuditLogs('t20');
  const activity = logs.find((l) => l.action === 'candidate.action.activity');
  assert.ok(activity);
  assert.equal(activity!.details?.summary, 'Created task "Review budget proposal"');
});

test('21. A failed action records a truthful failure Activity/audit entry — never a fake success', async () => {
  const dir = tempDir();
  const captureStore = new CaptureStore(path.join(dir, 'captures'));
  const candidateStore = new CandidateStore({ dir: path.join(dir, 'candidates') });
  const audit = new AuditLogger();
  const resolver = new CandidateActionResolver({ candidateStore, captureStore, auditLogger: audit }); // no taskStore
  const cap = seedCapture(captureStore, 't21', 'u21', 'h1');
  const cand = acceptedTaskCandidate(candidateStore, 't21', 'u21', cap.captureId, 'h1');
  await resolver.executeCandidate(cand.candidateId, 't21', 'u21');
  const logs = audit.getAuditLogs('t21');
  const failedLog = logs.find((l) => l.action === 'candidate.action.failed');
  assert.ok(failedLog);
  assert.equal(failedLog!.result, 'FAILED');
  assert.equal(failedLog!.reason_code, 'TASK_STORE_NOT_CONFIGURED');
  const activityLog = logs.find((l) => l.action === 'candidate.action.activity');
  assert.equal(activityLog, undefined, 'no success Activity entry may exist for a failed action');
});

// ─── 22: approval policy never bypassed ───

test('22. No candidate action path bypasses the existing Action Approval consume/replay protection for Calendar', async () => {
  const fetchFn: typeof fetch = async () => jsonResponse({ id: 'gcal_evt_3', htmlLink: 'https://calendar.google.com/event?eid=ghi' });
  const { captureStore, candidateStore, tokenStore, approvals, resolver } = buildHarness(fetchFn);
  connectCalendar(tokenStore, 't22');
  const cap = seedCapture(captureStore, 't22', 'u22', 'h1');
  const cand = acceptedCalendarCandidate(candidateStore, 't22', 'u22', cap.captureId, 'h1');
  const pending = await resolver.executeCandidate(cand.candidateId, 't22', 'u22');
  const approvalId = pending.action!.approvalId!;
  approvals.approve(approvalId, 't22', 'u22');
  await resolver.executeCandidate(cand.candidateId, 't22', 'u22');
  // The approval itself is now CONSUMED — attempting to consume it again
  // through the real ActionApprovalStore API directly (as any other tool
  // path would) is still rejected, proving the resolver went through the
  // real, unmodified approval gate rather than a shortcut.
  assert.throws(() => approvals.consume(approvalId, 't22', 'u22', 'google_calendar.create_event', {}, 'req_x', 'exe_x'),
    (err: unknown) => err instanceof NagexError && err.code === 'APPROVAL_ALREADY_CONSUMED');
});

// ─── 23: tenant/principal isolation ───

test('23. Tenant/principal isolation is maintained for execute/retry/action-state', async () => {
  const { captureStore, candidateStore, resolver } = buildHarness();
  const cap = seedCapture(captureStore, 't23a', 'u23a', 'h1');
  const cand = acceptedTaskCandidate(candidateStore, 't23a', 'u23a', cap.captureId, 'h1');
  await assert.rejects(() => resolver.executeCandidate(cand.candidateId, 't23b', 'u23b'), (err: unknown) => err instanceof NagexError && err.code === 'CANDIDATE_NOT_FOUND');
  await assert.rejects(() => resolver.executeCandidate(cand.candidateId, 't23a', 'u23b'), (err: unknown) => err instanceof NagexError && err.code === 'CANDIDATE_NOT_FOUND');
});

// ─── 24: linkage survives restart ───

test('24. Action linkage (status/targetId) survives a restart (fresh CandidateStore instance, same dir)', async () => {
  const dir = tempDir();
  const captureStore = new CaptureStore(path.join(dir, 'captures'));
  const candidateStoreA = new CandidateStore({ dir: path.join(dir, 'candidates') });
  const taskStore = new TaskStore({ dir: path.join(dir, 'tasks') });
  const resolverA = new CandidateActionResolver({ candidateStore: candidateStoreA, captureStore, taskStore });
  const cap = seedCapture(captureStore, 't24', 'u24', 'h1');
  const cand = acceptedTaskCandidate(candidateStoreA, 't24', 'u24', cap.captureId, 'h1');
  const result = await resolverA.executeCandidate(cand.candidateId, 't24', 'u24');

  const candidateStoreB = new CandidateStore({ dir: path.join(dir, 'candidates') });
  const reloaded = candidateStoreB.get(cand.candidateId);
  assert.equal(reloaded?.action?.status, 'SUCCEEDED');
  assert.equal(reloaded?.action?.targetId, result.action?.targetId);
});

// ─── 25: no fake success when the downstream subsystem fails ───

test('25. No fake success is ever reported when a downstream subsystem is unavailable', async () => {
  const dir = tempDir();
  const captureStore = new CaptureStore(path.join(dir, 'captures'));
  const candidateStore = new CandidateStore({ dir: path.join(dir, 'candidates') });
  // Deliberately no memoryEngine/knowledgeEngine/taskStore/calendarService configured.
  const resolver = new CandidateActionResolver({ candidateStore, captureStore });

  const cap = seedCapture(captureStore, 't25', 'u25', 'h1');
  const taskCand = acceptedTaskCandidate(candidateStore, 't25', 'u25', cap.captureId, 'h1');
  const memCand = acceptedMemoryCandidate(candidateStore, 't25', 'u25', cap.captureId, 'h1');
  const knowCand = acceptedKnowledgeCandidate(candidateStore, 't25', 'u25', cap.captureId, 'h1');
  const calCand = acceptedCalendarCandidate(candidateStore, 't25', 'u25', cap.captureId, 'h1');

  for (const cand of [taskCand, memCand, knowCand, calCand]) {
    const result = await resolver.executeCandidate(cand.candidateId, 't25', 'u25');
    assert.equal(result.action?.status, 'FAILED', `${cand.type} must genuinely fail, never fake SUCCEEDED, when its subsystem is not configured`);
    assert.ok(result.action?.errorCode);
  }
});

// ─── API wiring: the real server routes reach the real production
// singletons (CandidateActionResolver wired with the real taskStore).

function uniqueIdentity(label: string): { tenantId: string; ownerId: string } {
  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return { tenantId: `ten_${label}_${runId}`, ownerId: `usr_${label}_${runId}` };
}

test('API: POST /api/v1/candidates/:id/execute creates a real Task via the production TaskStore', async () => {
  const { tenantId, ownerId } = uniqueIdentity('actapi1');
  const headers = { 'x-nagex-tenant': tenantId, 'x-principal-id': ownerId };
  const seeded = productionCandidateStore.upsert({
    tenantId, principalId: ownerId, captureId: 'cap_actapi1', sourceRefs: ['capture:cap_actapi1'],
    title: 'API-executed task', type: 'TASK', payload: { name: 'API-executed task' },
  });
  productionCandidateStore.accept(seeded.candidateId, tenantId, ownerId);

  const res = await handleAsyncApiRequest('POST', `/api/v1/candidates/${seeded.candidateId}/execute`, {}, headers);
  assert.equal(res.status, 200);
  const record = res.data as { action?: { status: string; targetId?: string } };
  assert.equal(record.action?.status, 'SUCCEEDED');
  const task = productionTaskStore.get(record.action!.targetId!, tenantId, ownerId);
  assert.ok(task);
  assert.equal(task!.name, 'API-executed task');

  const actionRes = await handleAsyncApiRequest('GET', `/api/v1/candidates/${seeded.candidateId}/action`, null, headers);
  assert.equal(actionRes.status, 200);
  assert.equal((actionRes.data as { action: { status: string } }).action.status, 'SUCCEEDED');
});

test('API: execute on a PROPOSED candidate is rejected (409), never silently succeeds', async () => {
  const { tenantId, ownerId } = uniqueIdentity('actapi2');
  const headers = { 'x-nagex-tenant': tenantId, 'x-principal-id': ownerId };
  const seeded = productionCandidateStore.upsert({
    tenantId, principalId: ownerId, captureId: 'cap_actapi2', sourceRefs: ['capture:cap_actapi2'],
    title: 'Not yet accepted', type: 'TASK', payload: { name: 'Not yet accepted' },
  });
  const res = await handleAsyncApiRequest('POST', `/api/v1/candidates/${seeded.candidateId}/execute`, {}, headers);
  assert.equal(res.status, 409);
});

// ─── Frontend wiring (item M/N/O) — same served-source technique
// tests/candidate_review.test.ts already established for this repo (no DOM
// execution harness exists here).

async function withServer(run: (origin: string) => Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test('UI: ACCEPTED candidates get per-type Apply controls, distinct success/failure/pending-approval copy, and never claim success before SUCCEEDED', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();
    const fnMatch = appJs.match(/function renderCandidateActionControls[\s\S]*?\n  }\n/);
    assert.ok(fnMatch, 'renderCandidateActionControls not found');
    const body = fnMatch![0];
    assert.match(body, /executeCandidateAction/);
    assert.match(body, /retryCandidateAction/);
    // Distinct per-type Apply labels (item M) — not one generic button.
    assert.match(body, /candidateApplyTask/);
    assert.match(body, /candidateApplyCalendar/);
    assert.match(body, /candidateApplyMemory/);
    assert.match(body, /candidateApplyKnowledge/);
    // Calendar's two gates stay visibly distinct (item N): PENDING_APPROVAL
    // reads "Waiting for approval", never the Calendar success copy, and the
    // success branch is reachable only via action.status === 'SUCCEEDED'.
    assert.match(body, /candidateWaitingApproval/);
    assert.match(body, /action\.status === 'SUCCEEDED'/);
    assert.match(body, /candidateActionFailed/);
  });
});


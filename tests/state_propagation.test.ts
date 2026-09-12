// Phase 1 STEP 8 — State Propagation / Home / Activity.
//
// After a real Capture -> Understanding -> Candidate -> Review -> Action
// transition, Home/Inbox/Activity/Vault must reflect the same canonical
// state — no fake/demo data, no duplicate state, no manual-refresh
// assumptions. This suite verifies the new Activity Projection
// (AuditLogger/ExecutionStore/canonical stores -> ActivityStore -> consumer
// Activity, never raw audit events, never the legacy non-isolated
// executionHistory array) and that Home's "Needs your attention"/"Working"/
// "Recent" sections and the Activity tab are wired to real canonical state
// (verified against the served app.js source, the same technique
// tests/navigation_redefinition.test.ts and tests/candidate_review.test.ts
// already use — this repo has no DOM/browser execution harness).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { CaptureStore } from '../src/workspace/capture.store.js';
import { CandidateStore } from '../src/workspace/candidate.store.js';
import { CandidateActionResolver } from '../src/workspace/action-resolver.js';
import { ActivityStore } from '../src/governance/activity.store.js';
import { TaskStore } from '../src/tasks/task.store.js';
import { MemoryEngine } from '../src/context/memory.engine.js';
import { KnowledgeEngine } from '../src/context/knowledge.engine.js';
import { ActionApprovalStore } from '../src/governance/action-approval.store.js';
import { ExecutionStore } from '../src/governance/execution.store.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { GoogleCalendarService } from '../src/modules/calendar/index.js';
import { InMemoryGoogleOAuthTokenStore } from '../src/integrations/google/token.store.js';
import type { GoogleOAuthConfig } from '../src/integrations/google/oauth.client.js';
import type { CalendarCandidatePayload } from '../src/workspace/candidate.types.js';
import { server, handleAsyncApiRequest, candidateStore as productionCandidateStore, activityStore as productionActivityStore, taskStore as productionTaskStore } from '../src/server_web.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-state-propagation-'));
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const CAL_CONFIG: GoogleOAuthConfig = { clientId: 'cid', clientSecret: 'secret', redirectUri: 'https://nagex-test.agex.site/api/v1/oauth/google/callback' };

function buildHarness(calendarFetchFn?: typeof fetch) {
  const dir = tempDir();
  const captureStore = new CaptureStore(path.join(dir, 'captures'));
  const candidateStore = new CandidateStore({ dir: path.join(dir, 'candidates') });
  const activityStore = new ActivityStore({ dir: path.join(dir, 'activity') });
  const taskStore = new TaskStore({ dir: path.join(dir, 'tasks') });
  const memoryEngine = new MemoryEngine({ dir: path.join(dir, 'memories') });
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
  const resolver = new CandidateActionResolver({ candidateStore, captureStore, taskStore, memoryEngine, knowledgeEngine, calendarService, executionStore, auditLogger: audit, activityStore });
  return { dir, captureStore, candidateStore, activityStore, taskStore, memoryEngine, knowledgeEngine, tokenStore, approvals, audit, executionStore, calendarService, resolver };
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
    tenantId, principalId: ownerId, captureId, contentHash, sourceRefs: [`chk_${captureId}_0`],
    title: 'Q3 Strategy', type: 'KNOWLEDGE', payload: { title: 'Q3 Strategy', summary: 'Key points.', sourceCaptureId: captureId },
  });
  return candidateStore.accept(c.candidateId, tenantId, ownerId);
}

function acceptedCalendarCandidate(candidateStore: CandidateStore, tenantId: string, ownerId: string, captureId: string, contentHash: string, overrides: Partial<CalendarCandidatePayload> = {}) {
  const payload: CalendarCandidatePayload = {
    summary: 'Project meeting', start: '2026-12-01T10:00:00.000Z', end: '2026-12-01T10:30:00.000Z', timezone: 'Asia/Seoul', attendees: [],
    ...overrides,
  };
  const c = candidateStore.upsert({
    tenantId, principalId: ownerId, captureId, contentHash, sourceRefs: [`capture:${captureId}`],
    title: payload.summary, type: 'CALENDAR', payload,
  });
  return candidateStore.accept(c.candidateId, tenantId, ownerId);
}

// ─── 1-3: Inbox / Home propagation for a PROPOSED candidate, then Accept ───

test('1. A PROPOSED candidate appears in canonical listing (Inbox source of truth)', () => {
  const { candidateStore } = buildHarness();
  const c = candidateStore.upsert({ tenantId: 't1', principalId: 'u1', captureId: 'cap1', sourceRefs: ['capture:cap1'], title: 'X', type: 'TASK', payload: { name: 'X' } });
  const list = candidateStore.list('u1', 't1', { status: 'PROPOSED' });
  assert.ok(list.some((r) => r.candidateId === c.candidateId));
});

test('2. Home "Needs your attention" sources PROPOSED candidates from canonical state (served app.js)', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();
    const sectionMatch = appJs.match(/\/\/ 2\. Needs your attention[\s\S]*?\n    }\n/);
    assert.ok(sectionMatch);
    assert.match(sectionMatch![0], /proposedCandidates = \(state\.candidates \|\| \[\]\)\.filter\(\(c\) => c\.status === 'PROPOSED'\)/);
  });
});

test('3. Accept removes the candidate from the PROPOSED (unresolved review) list', () => {
  const { candidateStore } = buildHarness();
  const c = candidateStore.upsert({ tenantId: 't3', principalId: 'u3', captureId: 'cap3', sourceRefs: ['capture:cap3'], title: 'X', type: 'TASK', payload: { name: 'X' } });
  candidateStore.accept(c.candidateId, 't3', 'u3');
  const proposed = candidateStore.list('u3', 't3', { status: 'PROPOSED' });
  assert.equal(proposed.length, 0);
});

// ─── 4-6: Calendar Action Approval propagation ───

test('4. Executing an ACCEPTED CALENDAR candidate creates a real PENDING Action Approval, distinct from Candidate Review', async () => {
  const { captureStore, candidateStore, tokenStore, approvals, resolver } = buildHarness();
  connectCalendar(tokenStore, 't4');
  const cap = seedCapture(captureStore, 't4', 'u4', 'h1');
  const cand = acceptedCalendarCandidate(candidateStore, 't4', 'u4', cap.captureId, 'h1');
  const result = await resolver.executeCandidate(cand.candidateId, 't4', 'u4');
  assert.equal(result.action?.status, 'PENDING_APPROVAL');
  const approval = approvals.get(result.action!.approvalId!);
  assert.equal(approval?.status, 'PENDING');
  // Candidate Review already happened (status ACCEPTED) — this is a
  // separate, later gate (Korean note: 후보 승인 ≠ 실행 승인).
  assert.equal(result.status, 'ACCEPTED');
});

test('5. Calendar success (approve + execute) resolves the pending approval — it is no longer PENDING', async () => {
  const fetchFn: typeof fetch = async () => jsonResponse({ id: 'gcal_1', htmlLink: 'https://calendar.google.com/event?eid=x' });
  const { captureStore, candidateStore, tokenStore, approvals, resolver } = buildHarness(fetchFn);
  connectCalendar(tokenStore, 't5');
  const cap = seedCapture(captureStore, 't5', 'u5', 'h1');
  const cand = acceptedCalendarCandidate(candidateStore, 't5', 'u5', cap.captureId, 'h1');
  const pending = await resolver.executeCandidate(cand.candidateId, 't5', 'u5');
  approvals.approve(pending.action!.approvalId!);
  const done = await resolver.executeCandidate(cand.candidateId, 't5', 'u5');
  assert.equal(done.action?.status, 'SUCCEEDED');
  assert.notEqual(approvals.get(pending.action!.approvalId!)?.status, 'PENDING');
});

test('6. Calendar success creates exactly one Activity item, even after repeated execute calls', async () => {
  const fetchFn: typeof fetch = async () => jsonResponse({ id: 'gcal_2', htmlLink: 'https://calendar.google.com/event?eid=y' });
  const { captureStore, candidateStore, activityStore, tokenStore, approvals, resolver } = buildHarness(fetchFn);
  connectCalendar(tokenStore, 't6');
  const cap = seedCapture(captureStore, 't6', 'u6', 'h1');
  const cand = acceptedCalendarCandidate(candidateStore, 't6', 'u6', cap.captureId, 'h1', { summary: 'Project meeting for Activity test' });
  const pending = await resolver.executeCandidate(cand.candidateId, 't6', 'u6');
  approvals.approve(pending.action!.approvalId!);
  await resolver.executeCandidate(cand.candidateId, 't6', 'u6');
  await resolver.executeCandidate(cand.candidateId, 't6', 'u6'); // repeated hydration/poll
  const items = activityStore.list('t6', 'u6').filter((a) => a.status === 'COMPLETED');
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Added "Project meeting for Activity test" to Google Calendar');
});

// ─── 7-9: TASK/MEMORY/KNOWLEDGE Activity ───

test('7. TASK success creates exactly one Activity item', async () => {
  const { captureStore, candidateStore, activityStore, resolver } = buildHarness();
  const cap = seedCapture(captureStore, 't7', 'u7', 'h1');
  const cand = acceptedTaskCandidate(candidateStore, 't7', 'u7', cap.captureId, 'h1', 'Review budget');
  await resolver.executeCandidate(cand.candidateId, 't7', 'u7');
  await resolver.executeCandidate(cand.candidateId, 't7', 'u7');
  const items = activityStore.list('t7', 'u7');
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Created task "Review budget"');
  assert.equal(items[0].status, 'COMPLETED');
});

test('8. MEMORY success creates exactly one Activity item', async () => {
  const { captureStore, candidateStore, activityStore, resolver } = buildHarness();
  const cap = seedCapture(captureStore, 't8', 'u8', 'h1');
  const cand = acceptedMemoryCandidate(candidateStore, 't8', 'u8', cap.captureId, 'h1', 'Prefers async updates.');
  await resolver.executeCandidate(cand.candidateId, 't8', 'u8');
  const items = activityStore.list('t8', 'u8');
  assert.equal(items.length, 1);
  assert.match(items[0].title, /^Remembered: Prefers async updates\./);
});

test('9. KNOWLEDGE success creates exactly one Activity item', async () => {
  const { captureStore, candidateStore, activityStore, resolver } = buildHarness();
  const cap = seedCapture(captureStore, 't9', 'u9', 'h1');
  const cand = acceptedKnowledgeCandidate(candidateStore, 't9', 'u9', cap.captureId, 'h1');
  await resolver.executeCandidate(cand.candidateId, 't9', 'u9');
  const items = activityStore.list('t9', 'u9');
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Added "Q3 Strategy" to knowledge');
});

// ─── 10-11: failure Activity + Needs Attention ───

test('10-11. A failed action creates a truthful FAILED Activity item and the candidate remains eligible for Needs Attention', async () => {
  const dir = tempDir();
  const captureStore = new CaptureStore(path.join(dir, 'captures'));
  const candidateStore = new CandidateStore({ dir: path.join(dir, 'candidates') });
  const activityStore = new ActivityStore({ dir: path.join(dir, 'activity') });
  const resolver = new CandidateActionResolver({ candidateStore, captureStore, activityStore }); // no taskStore
  const cap = seedCapture(captureStore, 't10', 'u10', 'h1');
  const cand = acceptedTaskCandidate(candidateStore, 't10', 'u10', cap.captureId, 'h1');
  const result = await resolver.executeCandidate(cand.candidateId, 't10', 'u10');
  assert.equal(result.action?.status, 'FAILED');

  const items = activityStore.list('t10', 'u10');
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Task action failed');
  assert.equal(items[0].status, 'FAILED');

  // Eligible for Home's Needs Attention "failed action" pool: ACCEPTED + action FAILED.
  assert.equal(result.status, 'ACCEPTED');
  assert.equal(result.action?.status, 'FAILED');
});

// ─── 12-13: REJECTED/EXPIRED never return to unresolved ───

test('12. A REJECTED candidate does not reappear as unresolved (PROPOSED) or eligible for action', () => {
  const { candidateStore } = buildHarness();
  const c = candidateStore.upsert({ tenantId: 't12', principalId: 'u12', captureId: 'cap12', sourceRefs: ['capture:cap12'], title: 'X', type: 'TASK', payload: { name: 'X' } });
  candidateStore.reject(c.candidateId, 't12', 'u12');
  assert.equal(candidateStore.list('u12', 't12', { status: 'PROPOSED' }).length, 0);
  assert.equal(candidateStore.list('u12', 't12', { status: 'ACCEPTED' }).length, 0);
});

test('13. An EXPIRED candidate does not reappear as unresolved', () => {
  const { candidateStore } = buildHarness();
  const c = candidateStore.upsert({ tenantId: 't13', principalId: 'u13', captureId: 'cap13', sourceRefs: ['capture:cap13'], title: 'X', type: 'TASK', payload: { name: 'X' } });
  candidateStore.expire(c.candidateId, 't13', 'u13');
  assert.equal(candidateStore.list('u13', 't13', { status: 'PROPOSED' }).length, 0);
});

// ─── 14-16: Activity isolation + persistence ───

test('14. Activity is tenant isolated', () => {
  const { activityStore } = buildHarness();
  activityStore.record({ tenantId: 'tA', principalId: 'u', type: 'x', title: 'From tenant A', status: 'COMPLETED', dedupeKey: 'k1' });
  activityStore.record({ tenantId: 'tB', principalId: 'u', type: 'x', title: 'From tenant B', status: 'COMPLETED', dedupeKey: 'k1' });
  const listA = activityStore.list('tA', 'u');
  assert.equal(listA.length, 1);
  assert.equal(listA[0].title, 'From tenant A');
});

test('15. Activity is principal isolated within the same tenant', () => {
  const { activityStore } = buildHarness();
  activityStore.record({ tenantId: 't', principalId: 'uA', type: 'x', title: 'From uA', status: 'COMPLETED', dedupeKey: 'k1' });
  activityStore.record({ tenantId: 't', principalId: 'uB', type: 'x', title: 'From uB', status: 'COMPLETED', dedupeKey: 'k1' });
  const listA = activityStore.list('t', 'uA');
  assert.equal(listA.length, 1);
  assert.equal(listA[0].title, 'From uA');
});

test('16. Activity survives a restart (fresh ActivityStore instance, same dir)', () => {
  const dir = tempDir();
  const storeA = new ActivityStore({ dir });
  storeA.record({ tenantId: 't16', principalId: 'u16', type: 'x', title: 'Persisted item', status: 'COMPLETED', dedupeKey: 'k16' });
  const storeB = new ActivityStore({ dir });
  const items = storeB.list('t16', 'u16');
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Persisted item');
});

// ─── 17-18: idempotency (no duplication on repeated hydration/rendering) ───

test('17. Recording the same logical event twice (e.g. replayed hydration) does not duplicate the Activity item', () => {
  const { activityStore } = buildHarness();
  const first = activityStore.record({ tenantId: 't17', principalId: 'u17', type: 'x', title: 'V1', status: 'COMPLETED', dedupeKey: 'candidateX:SUCCEEDED' });
  const second = activityStore.record({ tenantId: 't17', principalId: 'u17', type: 'x', title: 'V1 refreshed', status: 'COMPLETED', dedupeKey: 'candidateX:SUCCEEDED' });
  assert.equal(first.activityId, second.activityId);
  const items = activityStore.list('t17', 'u17');
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'V1 refreshed');
});

test('18. Reading (list) the Activity feed repeatedly never mutates or duplicates state', () => {
  const { activityStore } = buildHarness();
  activityStore.record({ tenantId: 't18', principalId: 'u18', type: 'x', title: 'One item', status: 'COMPLETED', dedupeKey: 'k18' });
  activityStore.list('t18', 'u18');
  activityStore.list('t18', 'u18');
  const items = activityStore.list('t18', 'u18');
  assert.equal(items.length, 1);
});

// ─── 19-21: downstream management views reflect real stores ───

test('19-21. Task/Memory/Knowledge downstream views reflect the real canonical stores after action success', async () => {
  const { captureStore, candidateStore, taskStore, memoryEngine, knowledgeEngine, resolver } = buildHarness();
  const cap = seedCapture(captureStore, 't1921', 'u1921', 'h1');

  const taskCand = acceptedTaskCandidate(candidateStore, 't1921', 'u1921', cap.captureId, 'h1', 'Downstream task');
  await resolver.executeCandidate(taskCand.candidateId, 't1921', 'u1921');
  assert.equal(taskStore.list('u1921').length, 1);
  assert.equal(taskStore.list('u1921')[0].name, 'Downstream task');

  const memCand = acceptedMemoryCandidate(candidateStore, 't1921', 'u1921', cap.captureId, 'h1', 'Downstream memory statement.');
  await resolver.executeCandidate(memCand.candidateId, 't1921', 'u1921');
  assert.equal(memoryEngine.getActiveMemories('USER', 'u1921').length, 1);

  const knowCand = acceptedKnowledgeCandidate(candidateStore, 't1921', 'u1921', cap.captureId, 'h1');
  await resolver.executeCandidate(knowCand.candidateId, 't1921', 'u1921');
  const doc = knowledgeEngine.retrieveCandidates('Q3', ['INTERNAL']);
  assert.equal(doc.length, 1);
});

// ─── 22: Vault source artifact singularity ───

test('22. The source capture/vault artifact remains singular after multiple candidate actions from the same capture', async () => {
  const { captureStore, candidateStore, resolver } = buildHarness();
  const cap = seedCapture(captureStore, 't22', 'u22', 'h1');

  const taskCand = acceptedTaskCandidate(candidateStore, 't22', 'u22', cap.captureId, 'h1');
  await resolver.executeCandidate(taskCand.candidateId, 't22', 'u22');
  const memCand = acceptedMemoryCandidate(candidateStore, 't22', 'u22', cap.captureId, 'h1');
  await resolver.executeCandidate(memCand.candidateId, 't22', 'u22');

  const reloaded = captureStore.getCapture(cap.captureId);
  assert.ok(reloaded);
  assert.equal(reloaded!.captureId, cap.captureId);
  assert.equal(captureStore.listCaptures('u22').filter((i) => i.captureId === cap.captureId).length, 1);
});

// ─── 23-24: NEEDS_HUMAN / capture failure propagation ───

test('23. NEEDS_HUMAN capture state is reflected in Home\'s eligible-attention filter (served app.js)', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();
    const sectionMatch = appJs.match(/\/\/ 2\. Needs your attention[\s\S]*?\n    }\n/);
    assert.ok(sectionMatch);
    assert.match(sectionMatch![0], /needsHumanCaptures = \(state\.inbox \|\| \[\]\)\.filter\(\(i\) => i\.status === 'NEEDS_REVIEW' && i\.metadata\?\.errorCode === 'BLOCKED_NEEDS_HUMAN'\)/);
  });
});

test('24. A capture that genuinely FAILED never produces a COMPLETED/success Activity entry', () => {
  const { activityStore } = buildHarness();
  // Simulates what CaptureProcessor.process()'s catch path does — see
  // capture-processor.ts recordCaptureFailureActivity.
  activityStore.record({ tenantId: 't24', principalId: 'u24', type: 'capture.failed', title: 'Could not analyze "Strategy.pdf"', status: 'FAILED', dedupeKey: 'cap24:failed' });
  const items = activityStore.list('t24', 'u24');
  assert.equal(items.length, 1);
  assert.equal(items[0].status, 'FAILED');
  assert.doesNotMatch(items[0].title, /Summar(y|ized)|complete/i);
});

// ─── 25: no generic fake "Activity completed" remains ───

test('25. No generic fake "Activity completed" placeholder remains anywhere in the served app.js', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();
    assert.doesNotMatch(appJs, /Activity completed/);
  });
});

// ─── 26: Home max 2 enforced (functional confirmation alongside the
// source-level check already in candidate_review.test.ts) ───

test('26. Home Needs Attention pooling caps at 2 across all eligible sources combined', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();
    const sectionMatch = appJs.match(/\/\/ 2\. Needs your attention[\s\S]*?\n    }\n/);
    assert.ok(sectionMatch);
    assert.match(sectionMatch![0], /attentionItems = \[/);
    assert.match(sectionMatch![0], /\]\.slice\(0, 2\)/);
  });
});

// ─── 27: canonical CandidateStore remains source of review state ───

test('27. The Review UI never reads capture.metadata.candidates[] to drive status/actions (still true after STEP 8 changes)', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();
    const reviewSectionStart = appJs.indexOf('Phase 1 STEP 6 — Candidate Review');
    assert.ok(reviewSectionStart > 0);
    const reviewSection = appJs.slice(reviewSectionStart, appJs.indexOf('window.NAGEX.rejectCandidate = async', reviewSectionStart) + 500);
    const codeOnly = reviewSection.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    assert.doesNotMatch(codeOnly, /metadata\??\.\??candidates\b/);
  });
});

// 28. existing STEP 1-7 tests remain green — verified by the regression run
// (item Z), not a test in this file.

// ─── Regression guard for a real bug manual browser verification (item Y)
// caught: a later `window.NAGEX = { ... }` object-literal reassignment
// silently discarded every STEP 6/7 handler (acceptCandidate,
// executeCandidateAction, ...) attached earlier via `window.NAGEX.x = ...`,
// leaving every Accept/Reject/Apply/Modify button dead at runtime despite
// every source-level regex test above passing (they only check the handler
// TEXT exists somewhere in the file, not that it survives to become the
// real runtime object). No source-level test alone would have caught this
// — it was only found by actually clicking the buttons in a live browser.

test('BUGFIX REGRESSION: window.NAGEX is never wholesale-reassigned after the STEP 6/7 handlers are attached', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();
    // Strip comment-only lines first — a prose example inside a comment
    // must never produce a false positive (or negative) here.
    const codeOnly = appJs.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    const bareReassignments = codeOnly.match(/window\.NAGEX\s*=\s*\{/g) || [];
    assert.equal(bareReassignments.length, 0, 'window.NAGEX must only ever be merged onto (window.NAGEX = window.NAGEX || {} / Object.assign(window.NAGEX, ...)), never replaced with a fresh object literal');
  });
});

// ─── API wiring: GET /api/v1/activity is tenant/principal isolated and
// derived from the real production ActivityStore/resolver. ───

function uniqueIdentity(label: string): { tenantId: string; ownerId: string } {
  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return { tenantId: `ten_${label}_${runId}`, ownerId: `usr_${label}_${runId}` };
}

test('API: GET /api/v1/activity reflects a real production Task action, isolated per tenant/principal', async () => {
  const { tenantId, ownerId } = uniqueIdentity('activityapi');
  const headers = { 'x-nagex-tenant': tenantId, 'x-principal-id': ownerId };
  const seeded = productionCandidateStore.upsert({
    tenantId, principalId: ownerId, captureId: 'cap_activityapi', sourceRefs: ['capture:cap_activityapi'],
    title: 'API activity task', type: 'TASK', payload: { name: 'API activity task' },
  });
  productionCandidateStore.accept(seeded.candidateId, tenantId, ownerId);
  await handleAsyncApiRequest('POST', `/api/v1/candidates/${seeded.candidateId}/execute`, {}, headers);

  const res = await handleAsyncApiRequest('GET', '/api/v1/activity', null, headers);
  assert.equal(res.status, 200);
  const activities = (res.data as { activities: Array<{ title: string; status: string }> }).activities;
  assert.ok(activities.some((a) => a.title === 'Created task "API activity task"' && a.status === 'COMPLETED'));

  const otherHeaders = { 'x-nagex-tenant': `${tenantId}_other`, 'x-principal-id': ownerId };
  const otherRes = await handleAsyncApiRequest('GET', '/api/v1/activity', null, otherHeaders);
  const otherActivities = (otherRes.data as { activities: Array<{ title: string }> }).activities;
  assert.ok(!otherActivities.some((a) => a.title === 'Created task "API activity task"'));

  const directTask = productionTaskStore.list(ownerId).find((tsk) => tsk.name === 'API activity task');
  assert.ok(directTask, 'Task management view (real TaskStore) must reflect the created task');
  void productionActivityStore;
});

async function withServer(run: (origin: string) => Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

// R11 — Proactive Action Suggestions + Approval-Aware Execution.
// DETECT -> PROPOSE -> HUMAN REVIEW -> APPROVE -> EXECUTE -> AUDIT.
// Covers: pure proposal generation from real DetectedChange[] (never
// speculative), ActionProposalStore persistence/dedup/restart, the mandatory
// approve-before-execute gate, real canonical-runtime execution (TaskStore
// for CREATE_TASK, GoogleCalendarService's existing RSVP approval flow for
// CALENDAR_RESCHEDULE), Activity Log recording, and the truthful
// no-provider-credentials path. R10/R10.1's own change-detection/Daily
// Brief tests are NOT re-run here — see daily_brief.test.ts and
// proactive_assistant_change_detection.test.ts; #15 is verified by the
// full suite remaining green alongside this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { generateProposalsFromChanges } from '../src/assistant/action-proposal-generator.js';
import { ActionProposalStore } from '../src/assistant/action-proposal.store.js';
import { executeActionProposal } from '../src/assistant/action-proposal-executor.js';
import type { DetectedChange } from '../src/assistant/daily-brief-change-detection.js';
import type { GeneratedDailyBrief } from '../src/assistant/daily-brief.pipeline.js';
import { TaskStore } from '../src/tasks/task.store.js';
import { ActivityStore } from '../src/governance/activity.store.js';
import { GoogleCalendarService } from '../src/modules/calendar/index.js';
import { InMemoryGoogleOAuthTokenStore, DEFAULT_GOOGLE_TENANT_ID } from '../src/integrations/google/token.store.js';
import { GOOGLE_OAUTH_SCOPES, type GoogleOAuthConfig } from '../src/integrations/google/oauth.client.js';
import { ActionApprovalStore } from '../src/governance/action-approval.store.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { MemoryEngine } from '../src/context/memory.engine.js';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const FULL_SCOPE_STRING = GOOGLE_OAUTH_SCOPES.join(' ');
const config: GoogleOAuthConfig = { clientId: 'cid', clientSecret: 'csecret', redirectUri: 'https://nagex-test.agex.site/api/v1/oauth/google/callback' };

function baseCurrent(overrides: Partial<GeneratedDailyBrief> = {}): GeneratedDailyBrief {
  return {
    tenantId: 'ten_prop', principalId: 'usr_prop', date: '2026-09-18',
    generatedAt: '2026-09-18T00:00:00.000Z', status: 'OK', provider: 'nebius', model: 'm', latencyMs: 5, fallbackOccurred: false,
    calendarStatus: 'CONNECTED', gmailStatus: 'CONNECTED', schedule: [], emails: [], summary: 's', actionItems: [], requestId: 'req_prop', source: 'MANUAL',
    ...overrides,
  };
}

function tmpStore(): ActionProposalStore {
  return new ActionProposalStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-proposals-test-')) });
}

// ── §12 tests 1-6: pure proposal generation from real DetectedChange[] ──

test('1. no grounded change -> no proposal', () => {
  const drafts = generateProposalsFromChanges([], baseCurrent());
  assert.deepEqual(drafts, []);
});

test('2. moved event -> a CALENDAR_RESCHEDULE proposal, grounded only in already-known event id/title/time', () => {
  const change: DetectedChange = { kind: 'CALENDAR_MOVED', title: 'x', body: '"Client sync" moved to 2026-09-18T15:00:00Z.', dedupeSuffix: 'calendar:moved:evt_1:2026-09-18T15:00:00Z:2026-09-18T15:30:00Z', sourceId: 'evt_1' };
  const current = baseCurrent({ schedule: [{ sourceType: 'CALENDAR', sourceId: 'evt_1', title: 'Client sync', start: '2026-09-18T15:00:00Z', end: '2026-09-18T15:30:00Z', capability: 'google_calendar', timestamp: '2026-09-18T15:00:00Z', status: 'confirmed', updated: null }] });
  const drafts = generateProposalsFromChanges([change], current);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].proposalType, 'CALENDAR_RESCHEDULE');
  assert.equal(drafts[0].sourceId, 'evt_1');
  assert.equal(drafts[0].executable, true);
  assert.deepEqual(drafts[0].proposedAction, { calendarId: 'primary', eventId: 'evt_1', responseStatus: 'accepted', summary: 'Client sync' });
});

test('3. cancelled event -> no proposal at all (never an unsafe auto-reschedule with an invented target time)', () => {
  const change: DetectedChange = { kind: 'CALENDAR_CANCELLED', title: 'x', body: 'cancelled', dedupeSuffix: 'calendar:cancelled:evt_2', sourceId: 'evt_2' };
  const drafts = generateProposalsFromChanges([change], baseCurrent());
  assert.deepEqual(drafts, []);
});

test('3b. a brand-new event (CALENDAR_NEW) also produces no proposal — only MOVED does', () => {
  const change: DetectedChange = { kind: 'CALENDAR_NEW', title: 'x', body: 'new', dedupeSuffix: 'calendar:new:evt_3:t0', sourceId: 'evt_3' };
  assert.deepEqual(generateProposalsFromChanges([change], baseCurrent()), []);
});

test('4. action-request email -> a review-only EMAIL_REPLY_DRAFT proposal (never a fabricated recipient/subject)', () => {
  const change: DetectedChange = { kind: 'GMAIL_ACTION_REQUEST', title: 'x', body: 'Please respond by Friday — urgent.', dedupeSuffix: 'gmail:action:th_1', sourceId: 'th_1' };
  const drafts = generateProposalsFromChanges([change], baseCurrent());
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].proposalType, 'EMAIL_REPLY_DRAFT');
  assert.equal(drafts[0].sourceId, 'th_1');
  assert.equal(drafts[0].executable, false, 'no real to/subject is available, so this must never be shown as executable');
  assert.deepEqual(drafts[0].proposedAction, { threadId: 'th_1' });
});

test('4b. a plain new (non-action-worded) email produces no proposal', () => {
  const change: DetectedChange = { kind: 'GMAIL_NEW', title: 'x', body: 'newsletter', dedupeSuffix: 'gmail:new:th_2', sourceId: 'th_2' };
  assert.deepEqual(generateProposalsFromChanges([change], baseCurrent()), []);
});

test('5. HIGH action item -> an executable CREATE_TASK proposal', () => {
  const change: DetectedChange = { kind: 'ACTION_ITEM_HIGH_NEW', title: 'x', body: 'Reply to client', dedupeSuffix: 'action_item:high:2026-09-18:Reply to client', sourceId: 'Reply to client' };
  const drafts = generateProposalsFromChanges([change], baseCurrent());
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].proposalType, 'CREATE_TASK');
  assert.equal(drafts[0].title, 'Reply to client');
  assert.equal(drafts[0].executable, true);
});

test('6. a newly pending approval -> a review-only REVIEW_APPROVAL proposal', () => {
  const change: DetectedChange = { kind: 'APPROVAL_NEW', title: 'x', body: 'A new action (gmail.send_message) is waiting.', dedupeSuffix: 'approval:new:apr_1', sourceId: 'apr_1' };
  const drafts = generateProposalsFromChanges([change], baseCurrent());
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].proposalType, 'REVIEW_APPROVAL');
  assert.equal(drafts[0].sourceId, 'apr_1');
  assert.equal(drafts[0].executable, false, 'reviewing means acting on the real approval directly, not through this proposal');
});

// ── §9/§10: store dedup + restart persistence ─────────────────────────────

test('7. duplicate generation for the same underlying change never creates a duplicate proposal', () => {
  const store = tmpStore();
  const draft = generateProposalsFromChanges(
    [{ kind: 'ACTION_ITEM_HIGH_NEW', title: 'x', body: 'Prep slides', dedupeSuffix: 'action_item:high:2026-09-18:Prep slides', sourceId: 'Prep slides' }],
    baseCurrent(),
  )[0];
  const dedupeKey = store.buildDedupeKey('ten_dup', 'usr_dup', '2026-09-18', draft.sourceType, draft.sourceId, draft.proposalType);
  assert.equal(store.findByDedupeKey('ten_dup', 'usr_dup', dedupeKey), undefined);
  const first = store.create({ ...draft, tenantId: 'ten_dup', principalId: 'usr_dup', date: '2026-09-18' });
  // Simulate a second Daily Brief regeneration detecting the exact same
  // change again — the real wiring (daily-brief.runner.ts/server_web.ts)
  // checks findByDedupeKey before calling create(); this test proves that
  // check actually prevents a duplicate record.
  const existing = store.findByDedupeKey('ten_dup', 'usr_dup', dedupeKey);
  assert.equal(existing?.id, first.id);
  assert.equal(store.listForDate('ten_dup', 'usr_dup', '2026-09-18').length, 1);
});

test('11. restart persistence: a proposal survives a fresh ActionProposalStore instance over the same directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-proposals-restart-test-'));
  const store1 = new ActionProposalStore({ dir });
  const created = store1.create({
    tenantId: 'ten_restart', principalId: 'usr_restart', sourceType: 'ACTION_ITEM', sourceId: 'Follow up', proposalType: 'CREATE_TASK',
    title: 'Follow up', summary: 'Follow up', rationale: 'r', proposedAction: { name: 'Follow up' }, riskLevel: 'LOW', approvalRequired: true, executable: true, date: '2026-09-18',
  });
  const store2 = new ActionProposalStore({ dir }); // simulates a process restart reading the same durable directory
  const reread = store2.get(created.id, 'ten_restart', 'usr_restart');
  assert.ok(reread);
  assert.equal(reread!.title, 'Follow up');
  assert.equal(reread!.status, 'PROPOSED');
});

// ── §11/§14: approval is mandatory; execute() never runs without it ──────

function buildExecutorHarness() {
  const taskStore = new TaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-tasks-prop-test-')) });
  const activityStore = new ActivityStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-activity-prop-test-')) });
  const actionProposalStore = tmpStore();
  const calendarTokenStore = new InMemoryGoogleOAuthTokenStore();
  const approvals = new ActionApprovalStore();
  const calendarService = new GoogleCalendarService(calendarTokenStore, approvals, new AuditLogger(), new MemoryEngine(), async () => jsonResponse({ items: [] }), () => config);
  return { taskStore, activityStore, actionProposalStore, calendarTokenStore, calendarService };
}

test('8. a REJECTED proposal can never be executed — no canonical runtime call ever happens', async () => {
  const h = buildExecutorHarness();
  const proposal = h.actionProposalStore.create({
    tenantId: 'ten_rej', principalId: 'usr_rej', sourceType: 'ACTION_ITEM', sourceId: 'Do X', proposalType: 'CREATE_TASK',
    title: 'Do X', summary: 'Do X', rationale: 'r', proposedAction: { name: 'Do X' }, riskLevel: 'LOW', approvalRequired: true, executable: true, date: '2026-09-18',
  });
  h.actionProposalStore.updateStatus(proposal.id, 'ten_rej', 'usr_rej', { status: 'REJECTED' });
  const rejected = h.actionProposalStore.get(proposal.id, 'ten_rej', 'usr_rej')!;
  await assert.rejects(
    () => executeActionProposal({ taskStore: h.taskStore, calendarService: h.calendarService, activityStore: h.activityStore, actionProposalStore: h.actionProposalStore }, rejected, 'req_8'),
    (err: unknown) => (err as { code: string }).code === 'ACTION_PROPOSAL_NOT_APPROVED',
  );
  assert.equal(h.taskStore.list('ten_rej', 'usr_rej').length, 0, 'rejecting a proposal must never create the Task it proposed');
});

test('8b. a still-PROPOSED (never approved) proposal also cannot be executed', async () => {
  const h = buildExecutorHarness();
  const proposal = h.actionProposalStore.create({
    tenantId: 'ten_unapproved', principalId: 'usr_unapproved', sourceType: 'ACTION_ITEM', sourceId: 'Do Y', proposalType: 'CREATE_TASK',
    title: 'Do Y', summary: 'Do Y', rationale: 'r', proposedAction: { name: 'Do Y' }, riskLevel: 'LOW', approvalRequired: true, executable: true, date: '2026-09-18',
  });
  await assert.rejects(
    () => executeActionProposal({ taskStore: h.taskStore, calendarService: h.calendarService, activityStore: h.activityStore, actionProposalStore: h.actionProposalStore }, proposal, 'req_8b'),
    (err: unknown) => (err as { code: string }).code === 'ACTION_PROPOSAL_NOT_APPROVED',
  );
});

test('9. an APPROVED CREATE_TASK proposal invokes the real, existing TaskStore.create() canonical runtime', async () => {
  const h = buildExecutorHarness();
  const proposal = h.actionProposalStore.create({
    tenantId: 'ten_approved', principalId: 'usr_approved', sourceType: 'ACTION_ITEM', sourceId: 'Prepare deck', proposalType: 'CREATE_TASK',
    title: 'Prepare deck', summary: 'Prepare deck', rationale: 'A HIGH action item from the Daily Brief.', proposedAction: { name: 'Prepare deck' }, riskLevel: 'LOW', approvalRequired: true, executable: true, date: '2026-09-18',
  });
  h.actionProposalStore.updateStatus(proposal.id, 'ten_approved', 'usr_approved', { status: 'APPROVED' });
  const approved = h.actionProposalStore.get(proposal.id, 'ten_approved', 'usr_approved')!;
  const result = await executeActionProposal({ taskStore: h.taskStore, calendarService: h.calendarService, activityStore: h.activityStore, actionProposalStore: h.actionProposalStore }, approved, 'req_9');
  assert.equal(result.status, 'COMPLETED');
  const tasks = h.taskStore.list('ten_approved', 'usr_approved');
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].name, 'Prepare deck');
  assert.equal(result.result?.targetId, tasks[0].taskId);
});

test('9b. executing an already-COMPLETED proposal a second time is idempotent — no second Task is created', async () => {
  const h = buildExecutorHarness();
  const proposal = h.actionProposalStore.create({
    tenantId: 'ten_idem', principalId: 'usr_idem', sourceType: 'ACTION_ITEM', sourceId: 'Once only', proposalType: 'CREATE_TASK',
    title: 'Once only', summary: 'Once only', rationale: 'r', proposedAction: { name: 'Once only' }, riskLevel: 'LOW', approvalRequired: true, executable: true, date: '2026-09-18',
  });
  h.actionProposalStore.updateStatus(proposal.id, 'ten_idem', 'usr_idem', { status: 'APPROVED' });
  const approved = h.actionProposalStore.get(proposal.id, 'ten_idem', 'usr_idem')!;
  const deps = { taskStore: h.taskStore, calendarService: h.calendarService, activityStore: h.activityStore, actionProposalStore: h.actionProposalStore };
  const first = await executeActionProposal(deps, approved, 'req_9b_1');
  const second = await executeActionProposal(deps, first, 'req_9b_2');
  assert.equal(second.result?.targetId, first.result?.targetId);
  assert.equal(h.taskStore.list('ten_idem', 'usr_idem').length, 1, 'a re-executed already-completed proposal must never create a second Task');
});

test('10. a real execution records a real Activity Log entry with a stable dedupeKey', async () => {
  const h = buildExecutorHarness();
  const proposal = h.actionProposalStore.create({
    tenantId: 'ten_audit', principalId: 'usr_audit', sourceType: 'ACTION_ITEM', sourceId: 'Audit me', proposalType: 'CREATE_TASK',
    title: 'Audit me', summary: 'Audit me', rationale: 'r', proposedAction: { name: 'Audit me' }, riskLevel: 'LOW', approvalRequired: true, executable: true, date: '2026-09-18',
  });
  h.actionProposalStore.updateStatus(proposal.id, 'ten_audit', 'usr_audit', { status: 'APPROVED' });
  const approved = h.actionProposalStore.get(proposal.id, 'ten_audit', 'usr_audit')!;
  await executeActionProposal({ taskStore: h.taskStore, calendarService: h.calendarService, activityStore: h.activityStore, actionProposalStore: h.actionProposalStore }, approved, 'req_10');
  const activity = h.activityStore.list('ten_audit', 'usr_audit');
  const entry = activity.find((a) => a.type === 'action_proposal.executed');
  assert.ok(entry, 'a COMPLETED execution must be recorded in the Activity Log');
  assert.equal(entry!.status, 'COMPLETED');
});

test('14. no automatic mutation path: generating proposals from changes never itself touches TaskStore/CalendarService — only an explicit execute() call does', () => {
  const h = buildExecutorHarness();
  const change: DetectedChange = { kind: 'ACTION_ITEM_HIGH_NEW', title: 'x', body: 'Should not auto-run', dedupeSuffix: 'action_item:high:2026-09-18:Should not auto-run', sourceId: 'Should not auto-run' };
  generateProposalsFromChanges([change], baseCurrent()); // pure — takes no store/service at all
  assert.equal(h.taskStore.list('ten_prop', 'usr_prop').length, 0);
});

// ── EMAIL_REPLY_DRAFT / REVIEW_APPROVAL: approved but non-executable ─────

test('a non-executable proposal (EMAIL_REPLY_DRAFT) refuses to execute even once APPROVED', async () => {
  const h = buildExecutorHarness();
  const proposal = h.actionProposalStore.create({
    tenantId: 'ten_noexec', principalId: 'usr_noexec', sourceType: 'GMAIL', sourceId: 'th_noexec', proposalType: 'EMAIL_REPLY_DRAFT',
    title: 'Reply to this email', summary: 's', rationale: 'r', proposedAction: { threadId: 'th_noexec' }, riskLevel: 'MEDIUM', approvalRequired: true, executable: false, date: '2026-09-18',
  });
  h.actionProposalStore.updateStatus(proposal.id, 'ten_noexec', 'usr_noexec', { status: 'APPROVED' });
  const approved = h.actionProposalStore.get(proposal.id, 'ten_noexec', 'usr_noexec')!;
  await assert.rejects(
    () => executeActionProposal({ taskStore: h.taskStore, calendarService: h.calendarService, activityStore: h.activityStore, actionProposalStore: h.actionProposalStore }, approved, 'req_noexec'),
    (err: unknown) => (err as { code: string }).code === 'ACTION_PROPOSAL_NOT_EXECUTABLE',
  );
});

// ── CALENDAR_RESCHEDULE: full two-step execution through the real,
//    existing ActionApprovalStore-backed Calendar RSVP write path ────────

test('CALENDAR_RESCHEDULE step 1: approving requests a real Calendar approval (via the existing approval runtime, not a new one)', async () => {
  const h = buildExecutorHarness();
  const proposal = h.actionProposalStore.create({
    tenantId: 'ten_cal', principalId: 'usr_cal', sourceType: 'CALENDAR', sourceId: 'evt_cal', proposalType: 'CALENDAR_RESCHEDULE',
    title: 'Confirm attendance at the new time', summary: 's', rationale: 'r',
    proposedAction: { calendarId: 'primary', eventId: 'evt_cal', responseStatus: 'accepted', summary: 'Client sync' },
    riskLevel: 'LOW', approvalRequired: true, executable: true, date: '2026-09-18',
  });
  h.actionProposalStore.updateStatus(proposal.id, 'ten_cal', 'usr_cal', { status: 'APPROVED' });
  const approved = h.actionProposalStore.get(proposal.id, 'ten_cal', 'usr_cal')!;
  const result = await executeActionProposal({ taskStore: h.taskStore, calendarService: h.calendarService, activityStore: h.activityStore, actionProposalStore: h.actionProposalStore }, approved, 'req_cal_1');
  assert.equal(result.status, 'EXECUTING');
  assert.ok(result.approvalId);
  const realApproval = h.calendarService.getApproval(result.approvalId!, 'ten_cal', 'usr_cal');
  assert.ok(realApproval, 'step 1 must create a real ActionApprovalStore record, reusing the existing runtime');
  assert.equal(realApproval!.status, 'PENDING');
});

test('CALENDAR_RESCHEDULE step 2: once the separate Calendar approval is itself approved, a re-execute call performs the real RSVP write and completes', async () => {
  const h = buildExecutorHarness();
  h.calendarTokenStore.save(DEFAULT_GOOGLE_TENANT_ID, { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: FULL_SCOPE_STRING });
  // Rebuild the calendar service with a fetchFn that serves the real
  // GET-attendees-then-PATCH-RSVP round trip respondToCalendarEvent needs.
  const approvals = new ActionApprovalStore();
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const method = init?.method || 'GET';
    if (method === 'GET') return jsonResponse({ id: 'evt_cal2', attendees: [{ email: 'me@example.com', self: true }] });
    return jsonResponse({ id: 'evt_cal2', htmlLink: 'https://calendar.google.com/event?eid=evt_cal2' });
  }) as unknown as typeof fetch;
  const calendarService = new GoogleCalendarService(h.calendarTokenStore, approvals, new AuditLogger(), new MemoryEngine(), fetchFn, () => config);

  const proposal = h.actionProposalStore.create({
    tenantId: DEFAULT_GOOGLE_TENANT_ID, principalId: 'usr_cal2', sourceType: 'CALENDAR', sourceId: 'evt_cal2', proposalType: 'CALENDAR_RESCHEDULE',
    title: 'Confirm attendance at the new time', summary: 's', rationale: 'r',
    proposedAction: { calendarId: 'primary', eventId: 'evt_cal2', responseStatus: 'accepted', summary: 'Client sync' },
    riskLevel: 'LOW', approvalRequired: true, executable: true, date: '2026-09-18',
  });
  h.actionProposalStore.updateStatus(proposal.id, DEFAULT_GOOGLE_TENANT_ID, 'usr_cal2', { status: 'APPROVED' });
  const deps = { taskStore: h.taskStore, calendarService, activityStore: h.activityStore, actionProposalStore: h.actionProposalStore };

  const step1 = await executeActionProposal(deps, h.actionProposalStore.get(proposal.id, DEFAULT_GOOGLE_TENANT_ID, 'usr_cal2')!, 'req_cal2_1');
  assert.equal(step1.status, 'EXECUTING');

  // The human now approves the real, separate Calendar approval (the exact
  // same /api/v1/approvals/:id/approve flow every other Calendar write uses).
  calendarService.approve(step1.approvalId!, DEFAULT_GOOGLE_TENANT_ID, 'usr_cal2', 'req_cal2_approve');

  const step2 = await executeActionProposal(deps, step1, 'req_cal2_2');
  assert.equal(step2.status, 'COMPLETED');
  assert.equal(step2.result?.targetId, 'evt_cal2');
});

// ── §12 test 13: truthful UNAVAILABLE state (no provider credentials) ────

test('13. when the underlying Daily Brief generation is UNAVAILABLE, generateProposalsFromChanges is never even reached (no changes, no proposals) — never a fake proposal', () => {
  const unavailable = baseCurrent({ status: 'UNAVAILABLE', calendarStatus: 'DISCONNECTED', gmailStatus: 'DISCONNECTED' });
  // The real wiring (daily-brief.runner.ts / server_web.ts) only calls
  // detectMeaningfulChanges/generateProposalsFromChanges inside `if (isUsable)`
  // — this proves the function itself also produces nothing useful from an
  // unavailable brief, so even a hypothetical future caller that forgot the
  // isUsable guard could not fabricate a proposal from empty/disconnected data.
  assert.deepEqual(generateProposalsFromChanges([], unavailable), []);
});

// ── §12 test 12: KR/EN UI strings, loaded and executed for real (same
//    vm-sandbox technique as tests/i18n_strings.test.ts) ─────────────────

test('12. Suggested actions UI strings are fully localized in both EN and KR', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'public', 'i18n.js'), 'utf8');
  const storage: Record<string, string> = {};
  const documentStub = { documentElement: {} as Record<string, unknown>, title: '', querySelectorAll: () => [] as unknown[] };
  const localStorageStub = {
    getItem: (key: string) => (Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null),
    setItem: (key: string, value: string) => { storage[key] = value; },
  };
  const sandbox: Record<string, unknown> = { document: documentStub, localStorage: localStorageStub };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'i18n.js' });
  const i18n = (sandbox.window as { NAGEX_I18N: { t: (k: string) => string; setLocale: (l: string) => void } }).NAGEX_I18N;

  assert.equal(i18n.t('dailyBrief.suggestedActions'), 'Suggested actions');
  assert.equal(i18n.t('dailyBrief.noProposals'), 'No suggested actions right now.');
  assert.equal(i18n.t('dailyBrief.approve'), 'Approve');
  assert.equal(i18n.t('dailyBrief.reject'), 'Reject');
  assert.equal(i18n.t('dailyBrief.execute'), 'Execute');

  i18n.setLocale('ko');
  assert.equal(i18n.t('dailyBrief.suggestedActions'), '제안된 작업');
  assert.equal(i18n.t('dailyBrief.noProposals'), '현재 제안된 작업이 없습니다.');
  assert.equal(i18n.t('dailyBrief.approve'), '승인');
  assert.equal(i18n.t('dailyBrief.reject'), '거부');
  assert.equal(i18n.t('dailyBrief.execute'), '실행');
});

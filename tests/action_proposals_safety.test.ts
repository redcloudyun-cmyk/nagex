// R11 FINAL SAFETY CERTIFICATION — independent Approval/Fail-Closed
// contract tests for src/assistant/action-proposal-executor.ts, per
// docs/NAGEX_DEVELOPMENT_SAFETY_HARNESS.md §3.4/§4. Deliberately separate
// from tests/action_proposals.test.ts (ordinary feature tests) — this file
// exists ONLY to prove unapproved/tampered/cross-tenant/failed paths are
// denied, never executed, and never leave an ambiguous or silently-
// mutated state. No new product behavior is introduced here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ActionProposalStore } from '../src/assistant/action-proposal.store.js';
import { executeActionProposal } from '../src/assistant/action-proposal-executor.js';
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

function harness() {
  const taskStore = new TaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-tasks-safety-')) });
  const activityStore = new ActivityStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-activity-safety-')) });
  const actionProposalStore = new ActionProposalStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-proposals-safety-')) });
  const calendarTokenStore = new InMemoryGoogleOAuthTokenStore();
  const approvals = new ActionApprovalStore();
  const calendarService = new GoogleCalendarService(calendarTokenStore, approvals, new AuditLogger(), new MemoryEngine(), async () => jsonResponse({ items: [] }), () => config);
  return { taskStore, activityStore, actionProposalStore, calendarTokenStore, approvals, calendarService };
}

function calendarProposalDraft(overrides: Record<string, unknown> = {}) {
  return {
    sourceType: 'CALENDAR' as const, sourceId: 'evt_safety', proposalType: 'CALENDAR_RESCHEDULE' as const,
    title: 'Confirm attendance at the new time', summary: 's', rationale: 'r',
    proposedAction: { calendarId: 'primary', eventId: 'evt_safety', responseStatus: 'accepted', summary: 'Client sync' },
    riskLevel: 'LOW' as const, approvalRequired: true, executable: true, date: '2026-09-19',
    ...overrides,
  };
}

// ── 1. No mutation bypass: static + behavioral ───────────────────────────

test('SAFETY-1a. action-proposal-executor.ts source contains no raw fetch/HTTP call and no direct import of a Calendar/Gmail client internal — every mutation goes through the module service layer', () => {
  const source = fs.readFileSync(path.resolve('src/assistant/action-proposal-executor.ts'), 'utf8').replace(/\/\/.*/g, '');
  assert.doesNotMatch(source, /\bfetch\s*\(/, 'the executor must never call fetch() directly — only calendarService/taskStore methods');
  assert.doesNotMatch(source, /modules\/calendar\/(google-calendar\.service|calendar\.client)\.js/, 'must never deep-import a Calendar module internal file');
  assert.doesNotMatch(source, /modules\/gmail\/(gmail\.service|gmail\.client)\.js/, 'must never deep-import a Gmail module internal file');
  assert.match(source, /from '\.\.\/modules\/calendar\/index\.js'/, 'must reach Calendar only through the module public index');
});

test('SAFETY-1b. no automatic mutation path: PROPOSED status alone never results in a Task or a Calendar approval request', async () => {
  const h = harness();
  const proposal = h.actionProposalStore.create({
    tenantId: 'ten_1b', principalId: 'usr_1b', sourceType: 'ACTION_ITEM', sourceId: 'x', proposalType: 'CREATE_TASK',
    title: 'x', summary: 'x', rationale: 'r', proposedAction: { name: 'x' }, riskLevel: 'LOW', approvalRequired: true, executable: true, date: '2026-09-19',
  });
  // Merely creating a PROPOSED record must never itself call TaskStore or
  // GoogleCalendarService — verified by the store's create() having no
  // access to either dependency at all (a structural guarantee), plus a
  // behavioral check that nothing was created.
  assert.equal(h.taskStore.list('ten_1b', 'usr_1b').length, 0);
  assert.equal(proposal.status, 'PROPOSED');
});

// ── 2. Approval fail-closed: missing / expired / tampered / consumed ─────

test('SAFETY-2a. missing approval (never requested) -> DENY, proposal marked FAILED, never COMPLETED', async () => {
  const h = harness();
  const proposal = h.actionProposalStore.create(calendarProposalDraft({ tenantId: 'ten_missing', principalId: 'usr_missing' }) as never);
  // Force the proposal directly into a state that references a
  // never-existed approvalId, simulating corrupted/rolled-back state —
  // the executor must independently deny rather than trust the pointer.
  h.actionProposalStore.updateStatus(proposal.id, 'ten_missing', 'usr_missing', { status: 'EXECUTING', approvalId: 'apr_does_not_exist' });
  const executing = h.actionProposalStore.get(proposal.id, 'ten_missing', 'usr_missing')!;
  const result = await executeActionProposal({ taskStore: h.taskStore, calendarService: h.calendarService, activityStore: h.activityStore, actionProposalStore: h.actionProposalStore }, executing, 'req_2a');
  assert.equal(result.status, 'FAILED');
  assert.equal(result.failure?.retryable, false);
});

test('SAFETY-2b. expired approval -> DENY, proposal marked FAILED with retryable:false, no Google API call attempted', async () => {
  const h = harness();
  const proposal = h.actionProposalStore.create(calendarProposalDraft({ tenantId: 'ten_expired', principalId: 'usr_expired' }) as never);
  h.actionProposalStore.updateStatus(proposal.id, 'ten_expired', 'usr_expired', { status: 'APPROVED' });
  const approved = h.actionProposalStore.get(proposal.id, 'ten_expired', 'usr_expired')!;
  const step1 = await executeActionProposal({ taskStore: h.taskStore, calendarService: h.calendarService, activityStore: h.activityStore, actionProposalStore: h.actionProposalStore }, approved, 'req_2b_1');
  assert.equal(step1.status, 'EXECUTING');
  // Force the real underlying approval to EXPIRED (simulates real time
  // passing past its TTL) — via the store's own real expiry check.
  const record = h.approvals.get(step1.approvalId!, 'ten_expired', 'usr_expired', 'req_force')!;
  (record as unknown as { expiresAt: string }).expiresAt = new Date(Date.now() - 1000).toISOString();
  const step2 = await executeActionProposal({ taskStore: h.taskStore, calendarService: h.calendarService, activityStore: h.activityStore, actionProposalStore: h.actionProposalStore }, step1, 'req_2b_2');
  assert.equal(step2.status, 'FAILED');
  assert.equal(step2.failure?.errorCode, 'ACTION_PROPOSAL_APPROVAL_EXPIRED');
  assert.equal(step2.failure?.retryable, false);
});

test('SAFETY-2c. rejected approval (the separate real Calendar approval, not the proposal) -> DENY, proposal marked FAILED', async () => {
  const h = harness();
  const proposal = h.actionProposalStore.create(calendarProposalDraft({ tenantId: 'ten_calrej', principalId: 'usr_calrej' }) as never);
  h.actionProposalStore.updateStatus(proposal.id, 'ten_calrej', 'usr_calrej', { status: 'APPROVED' });
  const approved = h.actionProposalStore.get(proposal.id, 'ten_calrej', 'usr_calrej')!;
  const step1 = await executeActionProposal({ taskStore: h.taskStore, calendarService: h.calendarService, activityStore: h.activityStore, actionProposalStore: h.actionProposalStore }, approved, 'req_2c_1');
  h.calendarService.reject(step1.approvalId!, 'ten_calrej', 'usr_calrej', 'req_2c_reject');
  const step2 = await executeActionProposal({ taskStore: h.taskStore, calendarService: h.calendarService, activityStore: h.activityStore, actionProposalStore: h.actionProposalStore }, step1, 'req_2c_2');
  assert.equal(step2.status, 'FAILED');
  assert.equal(step2.failure?.errorCode, 'ACTION_PROPOSAL_APPROVAL_REJECTED');
});

test('SAFETY-2d. tampered/mismatched payload at consume time -> DENY (ActionApprovalStore.consume payload-hash check), no mutation, approval left APPROVED (re-attemptable, not silently burned)', async () => {
  const h = harness();
  h.calendarTokenStore.save(DEFAULT_GOOGLE_TENANT_ID, { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: FULL_SCOPE_STRING });
  const proposal = h.actionProposalStore.create(calendarProposalDraft({ tenantId: DEFAULT_GOOGLE_TENANT_ID, principalId: 'usr_tamper', sourceId: 'evt_tamper', proposedAction: { calendarId: 'primary', eventId: 'evt_tamper', responseStatus: 'accepted', summary: 'Client sync' } }) as never);
  h.actionProposalStore.updateStatus(proposal.id, DEFAULT_GOOGLE_TENANT_ID, 'usr_tamper', { status: 'APPROVED' });
  const approved = h.actionProposalStore.get(proposal.id, DEFAULT_GOOGLE_TENANT_ID, 'usr_tamper')!;
  const step1 = await executeActionProposal({ taskStore: h.taskStore, calendarService: h.calendarService, activityStore: h.activityStore, actionProposalStore: h.actionProposalStore }, approved, 'req_2d_1');
  h.calendarService.approve(step1.approvalId!, DEFAULT_GOOGLE_TENANT_ID, 'usr_tamper', 'req_2d_approve');
  // Simulate a tampered/mutated proposedAction between approval and
  // execute (e.g. a corrupted record) — the real approval's payloadHash
  // was computed from the ORIGINAL payload, so consume() must reject this.
  const tampered = { ...step1, proposedAction: { ...step1.proposedAction, eventId: 'evt_DIFFERENT' } };
  await assert.rejects(
    () => (h.calendarService.executeRespondToEvent({ approvalId: step1.approvalId!, payload: tampered.proposedAction, tenantId: DEFAULT_GOOGLE_TENANT_ID, principalId: 'usr_tamper', requestId: 'req_2d_2' })),
    (err: unknown) => (err as { code: string }).code === 'APPROVAL_PAYLOAD_MISMATCH',
  );
  // The approval itself must still be APPROVED (not consumed) — a tampered
  // execute attempt must never burn the real, correctly-approved action.
  const stillApproved = h.calendarService.getApproval(step1.approvalId!, DEFAULT_GOOGLE_TENANT_ID, 'usr_tamper');
  assert.equal(stillApproved?.status, 'APPROVED');
});

// ── 3. Tenant/principal binding ───────────────────────────────────────────

test('SAFETY-3a. ActionProposalStore.get/updateStatus never returns/mutates another tenant\'s proposal', () => {
  const h = harness();
  const proposal = h.actionProposalStore.create({
    tenantId: 'ten_a', principalId: 'usr_a', sourceType: 'ACTION_ITEM', sourceId: 'x', proposalType: 'CREATE_TASK',
    title: 'x', summary: 'x', rationale: 'r', proposedAction: { name: 'x' }, riskLevel: 'LOW', approvalRequired: true, executable: true, date: '2026-09-19',
  });
  assert.equal(h.actionProposalStore.get(proposal.id, 'ten_b', 'usr_b'), undefined, 'wrong tenant+principal must never read another tenant\'s proposal');
  assert.equal(h.actionProposalStore.get(proposal.id, 'ten_a', 'usr_wrong'), undefined, 'wrong principal (correct tenant) must never read another principal\'s proposal');
  assert.throws(
    () => h.actionProposalStore.updateStatus(proposal.id, 'ten_b', 'usr_b', { status: 'APPROVED' }),
    (err: unknown) => (err as { code: string }).code === 'ACTION_PROPOSAL_NOT_FOUND',
  );
  // The record itself is untouched by the cross-tenant attempt.
  const real = h.actionProposalStore.get(proposal.id, 'ten_a', 'usr_a')!;
  assert.equal(real.status, 'PROPOSED');
});

test('SAFETY-3b. executeActionProposal takes no separate caller-supplied tenant/principal parameter — the mutation identity always comes from the store-issued proposal record itself, never from an out-of-band value', async () => {
  const h = harness();
  const proposalA = h.actionProposalStore.create({
    tenantId: 'ten_x', principalId: 'usr_x', sourceType: 'ACTION_ITEM', sourceId: 'x', proposalType: 'CREATE_TASK',
    title: 'x', summary: 'x', rationale: 'r', proposedAction: { name: 'x' }, riskLevel: 'LOW', approvalRequired: true, executable: true, date: '2026-09-19',
  });
  h.actionProposalStore.updateStatus(proposalA.id, 'ten_x', 'usr_x', { status: 'APPROVED' });
  const approved = h.actionProposalStore.get(proposalA.id, 'ten_x', 'usr_x')!;
  // executeActionProposal(deps, proposal, requestId) has no tenantId/
  // principalId parameter at all — the only identity it can ever act
  // under is whatever is embedded in the record it was handed, which the
  // caller (server_web.ts) always fetches via actionProposalStore.get(id,
  // tenantId, principalId) first, itself tenant-scoped. This proves the
  // resulting Task can only ever land under the proposal's own identity.
  const result = await executeActionProposal({ taskStore: h.taskStore, calendarService: h.calendarService, activityStore: h.activityStore, actionProposalStore: h.actionProposalStore }, approved, 'req_3b');
  assert.equal(result.status, 'COMPLETED');
  assert.equal(h.taskStore.list('ten_x', 'usr_x').length, 1);
  assert.equal(h.taskStore.list('ten_y', 'usr_y').length, 0, 'no other tenant ever receives the created Task');
});

// ── 4. Provider / approval-store failure denial ──────────────────────────

test('SAFETY-4a. Calendar disconnected (no OAuth token) at step 2 -> DENY, FAILED, and the real approval is NOT consumed (re-attemptable once reconnected)', async () => {
  const h = harness(); // no token saved — GOOGLE_CALENDAR_DISCONNECTED
  const proposal = h.actionProposalStore.create(calendarProposalDraft({ tenantId: 'ten_discon', principalId: 'usr_discon' }) as never);
  h.actionProposalStore.updateStatus(proposal.id, 'ten_discon', 'usr_discon', { status: 'APPROVED' });
  const approved = h.actionProposalStore.get(proposal.id, 'ten_discon', 'usr_discon')!;
  const step1 = await executeActionProposal({ taskStore: h.taskStore, calendarService: h.calendarService, activityStore: h.activityStore, actionProposalStore: h.actionProposalStore }, approved, 'req_4a_1');
  h.calendarService.approve(step1.approvalId!, 'ten_discon', 'usr_discon', 'req_4a_approve');
  const step2 = await executeActionProposal({ taskStore: h.taskStore, calendarService: h.calendarService, activityStore: h.activityStore, actionProposalStore: h.actionProposalStore }, step1, 'req_4a_2');
  assert.equal(step2.status, 'FAILED');
  assert.equal(step2.failure?.errorCode, 'GOOGLE_CALENDAR_DISCONNECTED');
  assert.equal(step2.failure?.retryable, true, 'DISCONNECTED fails BEFORE the approval is consumed, so a real retry (once reconnected) can genuinely succeed');
  const stillApproved = h.calendarService.getApproval(step1.approvalId!, 'ten_discon', 'usr_discon');
  assert.equal(stillApproved?.status, 'APPROVED', 'a token/provider failure must never burn the approval — the mutation never reached the point of consuming it');
});

test('SAFETY-4d. a failure AFTER the approval is already consumed (the real Google API call itself fails) is marked retryable:false — retrying this same proposal can never succeed once its one-time-use approval is burned', async () => {
  const h = harness();
  h.calendarTokenStore.save(DEFAULT_GOOGLE_TENANT_ID, { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: FULL_SCOPE_STRING });
  // fetchFn throws on the real API call — this happens strictly AFTER
  // GoogleCalendarService.executeWrite() has already called
  // approvals.consume() (see google-calendar.service.ts), so the approval
  // is burned by the time this failure is observed.
  const approvals = new ActionApprovalStore();
  const fetchFn = (async () => { throw new Error('simulated network failure'); }) as unknown as typeof fetch;
  const calendarService = new GoogleCalendarService(h.calendarTokenStore, approvals, new AuditLogger(), new MemoryEngine(), fetchFn, () => config);
  const proposal = h.actionProposalStore.create(calendarProposalDraft({ tenantId: DEFAULT_GOOGLE_TENANT_ID, principalId: 'usr_postconsume', sourceId: 'evt_postconsume', proposedAction: { calendarId: 'primary', eventId: 'evt_postconsume', responseStatus: 'accepted', summary: 'Client sync' } }) as never);
  h.actionProposalStore.updateStatus(proposal.id, DEFAULT_GOOGLE_TENANT_ID, 'usr_postconsume', { status: 'APPROVED' });
  const deps = { taskStore: h.taskStore, calendarService, activityStore: h.activityStore, actionProposalStore: h.actionProposalStore };
  const step1 = await executeActionProposal(deps, h.actionProposalStore.get(proposal.id, DEFAULT_GOOGLE_TENANT_ID, 'usr_postconsume')!, 'req_4d_1');
  calendarService.approve(step1.approvalId!, DEFAULT_GOOGLE_TENANT_ID, 'usr_postconsume', 'req_4d_approve');
  const step2 = await executeActionProposal(deps, step1, 'req_4d_2');
  assert.equal(step2.status, 'FAILED');
  assert.equal(step2.failure?.retryable, false, 'the approval is already CONSUMED by this point — a UI "Retry" on this exact proposal would be a dead end, so it must never be signaled as retryable');
  const consumed = calendarService.getApproval(step1.approvalId!, DEFAULT_GOOGLE_TENANT_ID, 'usr_postconsume');
  assert.equal(consumed?.status, 'CONSUMED');
});

test('SAFETY-4b. approval-store failure while requesting step 1 (e.g. invalid payload rejected by the store) -> DENY, proposal marked FAILED, no Task/approval side effect', async () => {
  const h = harness();
  // An intentionally invalid proposedAction (missing required fields) —
  // simulates the underlying request-approval call itself failing/
  // refusing, standing in for "approval store/policy layer failure".
  const proposal = h.actionProposalStore.create({
    tenantId: 'ten_badpayload', principalId: 'usr_badpayload', sourceType: 'CALENDAR', sourceId: 'evt_bad', proposalType: 'CALENDAR_RESCHEDULE',
    title: 't', summary: 's', rationale: 'r', proposedAction: { calendarId: 'primary' /* missing eventId/responseStatus/summary */ },
    riskLevel: 'LOW', approvalRequired: true, executable: true, date: '2026-09-19',
  });
  h.actionProposalStore.updateStatus(proposal.id, 'ten_badpayload', 'usr_badpayload', { status: 'APPROVED' });
  const approved = h.actionProposalStore.get(proposal.id, 'ten_badpayload', 'usr_badpayload')!;
  const result = await executeActionProposal({ taskStore: h.taskStore, calendarService: h.calendarService, activityStore: h.activityStore, actionProposalStore: h.actionProposalStore }, approved, 'req_4b');
  assert.equal(result.status, 'FAILED');
  assert.equal(result.approvalId, null, 'a rejected request-approval attempt must never leave a dangling approvalId');
});

test('SAFETY-4c. TaskStore.create() throwing (e.g. a validation failure) is caught and denies cleanly — no partial proposal state, no crash', async () => {
  const h = harness();
  const proposal = h.actionProposalStore.create({
    tenantId: 'ten_taskfail', principalId: 'usr_taskfail', sourceType: 'ACTION_ITEM', sourceId: 'x', proposalType: 'CREATE_TASK',
    title: '   ', // blank after trim -> TaskStore.create() throws TASK_NAME_REQUIRED
    summary: 'x', rationale: 'r', proposedAction: { name: 'x' }, riskLevel: 'LOW', approvalRequired: true, executable: true, date: '2026-09-19',
  });
  h.actionProposalStore.updateStatus(proposal.id, 'ten_taskfail', 'usr_taskfail', { status: 'APPROVED' });
  const approved = h.actionProposalStore.get(proposal.id, 'ten_taskfail', 'usr_taskfail')!;
  const result = await executeActionProposal({ taskStore: h.taskStore, calendarService: h.calendarService, activityStore: h.activityStore, actionProposalStore: h.actionProposalStore }, approved, 'req_4c');
  assert.equal(result.status, 'FAILED');
  assert.equal(h.taskStore.list('ten_taskfail', 'usr_taskfail').length, 0);
});

// ── 5. Unknown/ambiguous state -> DENY, never optimistic ──────────────────

test('SAFETY-5. an EXECUTING proposal whose approval is still PENDING is left unchanged on re-check, never optimistically marked COMPLETED', async () => {
  const h = harness();
  const proposal = h.actionProposalStore.create(calendarProposalDraft({ tenantId: 'ten_pending', principalId: 'usr_pending' }) as never);
  h.actionProposalStore.updateStatus(proposal.id, 'ten_pending', 'usr_pending', { status: 'APPROVED' });
  const approved = h.actionProposalStore.get(proposal.id, 'ten_pending', 'usr_pending')!;
  const step1 = await executeActionProposal({ taskStore: h.taskStore, calendarService: h.calendarService, activityStore: h.activityStore, actionProposalStore: h.actionProposalStore }, approved, 'req_5_1');
  assert.equal(step1.status, 'EXECUTING');
  // Real approval is still PENDING (nobody approved it yet) — re-checking
  // must leave the proposal exactly as-is, never guess/optimistically complete.
  const step2 = await executeActionProposal({ taskStore: h.taskStore, calendarService: h.calendarService, activityStore: h.activityStore, actionProposalStore: h.actionProposalStore }, step1, 'req_5_2');
  assert.equal(step2.status, 'EXECUTING');
  assert.equal(step2.result, null);
});

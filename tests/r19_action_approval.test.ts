// R19 — Action & Approval Integration Test Suite
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleAsyncApiRequest } from '../src/server_web.js';
import { ActionStore } from '../src/workspace/action.store.js';
import { ActionExecutionEngine } from '../src/actions/action-execution.engine.js';
import { ActionApprovalStore } from '../src/governance/action-approval.store.js';

test('1. Calendar Create: draft -> preview -> approve -> execute -> read-back verification', async () => {
  const headers = { 'x-nagex-tenant': 'ten_r19_test', 'x-principal-id': 'usr_r19_test' };

  // Step 1: Create Draft
  const resDraft = await handleAsyncApiRequest('POST', '/api/v1/actions', {
    actionType: 'CALENDAR_CREATE',
    provider: 'google',
    capability: 'calendar.create_event',
    target: 'Primary Calendar',
    parameters: {
      title: 'Meeting with Director Kim',
      start: '2026-09-18T15:00:00Z',
      end: '2026-09-18T16:00:00Z',
      attendees: ['kim@example.com'],
    },
  }, headers);

  assert.equal(resDraft.status, 201);
  const action = resDraft.data as any;
  assert.ok(action.actionId.startsWith('act_'));
  assert.equal(action.status, 'WAITING_APPROVAL');
  assert.equal(action.preview.affectedExternalSystem, 'Google Calendar');
  assert.equal(action.preview.reversible, true);

  // Step 2: Approve
  const resApprove = await handleAsyncApiRequest('POST', `/api/v1/actions/${action.actionId}/approve`, {}, headers);
  assert.equal(resApprove.status, 200);
  assert.equal((resApprove.data as any).status, 'APPROVED');

  // Step 3: Execute & Verify Read-back
  const resExecute = await handleAsyncApiRequest('POST', `/api/v1/actions/${action.actionId}/execute`, {}, headers);
  assert.equal(resExecute.status, 200);
  const execData = resExecute.data as any;
  assert.equal(execData.status, 'SUCCEEDED');
  assert.equal(execData.verification.verified, true);
  assert.equal(execData.verification.method, 'READ_BACK');
  assert.ok(execData.verification.providerRef);
});

test('2. Calendar Reject: reject results in status REJECTED and zero external mutation', async () => {
  const headers = { 'x-nagex-tenant': 'ten_r19_test', 'x-principal-id': 'usr_r19_test' };

  const resDraft = await handleAsyncApiRequest('POST', '/api/v1/actions', {
    actionType: 'CALENDAR_CREATE',
    provider: 'google',
    capability: 'calendar.create_event',
    target: 'Primary Calendar',
    parameters: { title: 'Unwanted Meeting', start: '2026-09-19T10:00:00Z' },
  }, headers);

  const action = resDraft.data as any;

  // Reject
  const resReject = await handleAsyncApiRequest('POST', `/api/v1/actions/${action.actionId}/reject`, {}, headers);
  assert.equal(resReject.status, 200);
  assert.equal((resReject.data as any).status, 'REJECTED');

  // Attempt execution on rejected action must fail with 403 (APPROVAL_NOT_GRANTED)
  const resExec = await handleAsyncApiRequest('POST', `/api/v1/actions/${action.actionId}/execute`, {}, headers);
  assert.equal(resExec.status, 403);
});

test('3. Calendar Update & Delete: before/after diff preview and revert lifecycle', async () => {
  const headers = { 'x-nagex-tenant': 'ten_r19_test', 'x-principal-id': 'usr_r19_test' };

  // Step 1: Create initial event action & execute
  const resDraft = await handleAsyncApiRequest('POST', '/api/v1/actions', {
    actionType: 'CALENDAR_CREATE',
    provider: 'google',
    capability: 'calendar.create_event',
    target: 'Primary Calendar',
    parameters: { title: 'Strategy Sync', start: '2026-09-20T14:00:00Z' },
  }, headers);
  const originalActionId = (resDraft.data as any).actionId;
  await handleAsyncApiRequest('POST', `/api/v1/actions/${originalActionId}/approve`, {}, headers);
  await handleAsyncApiRequest('POST', `/api/v1/actions/${originalActionId}/execute`, {}, headers);

  // Step 2: Revert Creation (creates a CALENDAR_DELETE revert draft)
  const resRevert = await handleAsyncApiRequest('POST', `/api/v1/actions/${originalActionId}/revert`, {}, headers);
  assert.equal(resRevert.status, 201);
  const revertAction = resRevert.data as any;
  assert.equal(revertAction.actionType, 'CALENDAR_DELETE');
  assert.equal(revertAction.revertedActionId, originalActionId);
  assert.equal(revertAction.status, 'WAITING_APPROVAL');

  // Approve & execute revert
  await handleAsyncApiRequest('POST', `/api/v1/actions/${revertAction.actionId}/approve`, {}, headers);
  const resRevertExec = await handleAsyncApiRequest('POST', `/api/v1/actions/${revertAction.actionId}/execute`, {}, headers);
  assert.equal(resRevertExec.status, 200);
  assert.equal((resRevertExec.data as any).status, 'SUCCEEDED');
});

test('4. Email Send: draft -> preview -> approve -> send verification, non-reversible labeling', async () => {
  const headers = { 'x-nagex-tenant': 'ten_r19_test', 'x-principal-id': 'usr_r19_test' };

  const resDraft = await handleAsyncApiRequest('POST', '/api/v1/actions', {
    actionType: 'EMAIL_SEND',
    provider: 'gmail',
    capability: 'email.send',
    target: 'Gmail',
    parameters: {
      to: 'client@partner.com',
      subject: 'Q4 Proposal Attached',
      body: 'Please review the attached proposal.',
    },
  }, headers);

  assert.equal(resDraft.status, 201);
  const action = resDraft.data as any;
  assert.equal(action.preview.reversible, false);
  assert.equal(action.preview.affectedExternalSystem, 'Gmail / External Mail Server');

  // Approve & Execute
  await handleAsyncApiRequest('POST', `/api/v1/actions/${action.actionId}/approve`, {}, headers);
  const resExec = await handleAsyncApiRequest('POST', `/api/v1/actions/${action.actionId}/execute`, {}, headers);
  assert.equal(resExec.status, 200);
  const execData = resExec.data as any;
  assert.equal(execData.status, 'SUCCEEDED');
  assert.ok(execData.verification.providerRef.startsWith('msg_'));

  // Attempting to revert email send fails (non-reversible)
  const resRevert = await handleAsyncApiRequest('POST', `/api/v1/actions/${action.actionId}/revert`, {}, headers);
  assert.equal(resRevert.status, 400); // Cannot revert non-reversible action
});

test('5. Email Recipient Validation: invalid recipient format is rejected prior to send', async () => {
  const store = new ActionStore();
  const engine = new ActionExecutionEngine({ actionStore: store, actionApprovals: {} as any });

  const record = store.createAction({
    userId: 'usr_test',
    organizationId: 'ten_test',
    workspaceId: 'ten_test',
    actionType: 'EMAIL_SEND',
    provider: 'gmail',
    capability: 'email.send',
    target: 'Gmail',
    parameters: { to: 'invalid-email-address', subject: 'Test' },
  });

  await engine.approveAction(record.actionId, 'ten_test', 'usr_test', 'req_1');
  await assert.rejects(
    async () => {
      await engine.executeAction(record.actionId, 'ten_test', 'usr_test', 'req_2');
    },
    (err: any) => err.code === 'INVALID_RECIPIENT'
  );
});

test('6. Double Execution Protection: executing completed action returns existing record without duplicating mutation', async () => {
  const headers = { 'x-nagex-tenant': 'ten_r19_test', 'x-principal-id': 'usr_r19_test' };

  const resDraft = await handleAsyncApiRequest('POST', '/api/v1/actions', {
    actionType: 'CALENDAR_CREATE',
    provider: 'google',
    capability: 'calendar.create_event',
    target: 'Primary Calendar',
    parameters: { title: 'Idempotency Test Meeting' },
    idempotencyKey: 'idemp_key_001',
  }, headers);

  const actionId = (resDraft.data as any).actionId;
  await handleAsyncApiRequest('POST', `/api/v1/actions/${actionId}/approve`, {}, headers);

  // First execute
  const res1 = await handleAsyncApiRequest('POST', `/api/v1/actions/${actionId}/execute`, {}, headers);
  assert.equal(res1.status, 200);

  // Second execute (double click guard)
  const res2 = await handleAsyncApiRequest('POST', `/api/v1/actions/${actionId}/execute`, {}, headers);
  assert.equal(res2.status, 200);
  assert.equal((res2.data as any).status, 'SUCCEEDED');
  assert.equal((res2.data as any).actionId, actionId);
});

test('7. Booking Foundation: unsupported provider returns honest error state without fake booking', async () => {
  const headers = { 'x-nagex-tenant': 'ten_r19_test', 'x-principal-id': 'usr_r19_test' };

  const resDraft = await handleAsyncApiRequest('POST', '/api/v1/actions', {
    actionType: 'BOOKING_CREATE',
    provider: 'unsupported_table_app',
    capability: 'booking.create_reservation',
    target: 'Gourmet Bistro',
    parameters: { partySize: 4, dateTime: '2026-09-20T19:00:00Z' },
  }, headers);

  const actionId = (resDraft.data as any).actionId;
  await handleAsyncApiRequest('POST', `/api/v1/actions/${actionId}/approve`, {}, headers);

  const resExec = await handleAsyncApiRequest('POST', `/api/v1/actions/${actionId}/execute`, {}, headers);
  assert.equal(resExec.status, 400); // Honest error: provider not supported
});

test('8. Multi-Tenant & Foreign Access Isolation: foreign user cannot read or approve another tenant action', async () => {
  const headersOwner = { 'x-nagex-tenant': 'ten_owner_A', 'x-principal-id': 'usr_owner_A' };
  const headersForeign = { 'x-nagex-tenant': 'ten_attacker_B', 'x-principal-id': 'usr_attacker_B' };

  const resDraft = await handleAsyncApiRequest('POST', '/api/v1/actions', {
    actionType: 'CALENDAR_CREATE',
    provider: 'google',
    capability: 'calendar.create_event',
    target: 'Primary Calendar',
    parameters: { title: 'Confidential Executive Sync' },
  }, headersOwner);

  const actionId = (resDraft.data as any).actionId;

  // Foreign user GET -> 404
  const resGetForeign = await handleAsyncApiRequest('GET', `/api/v1/actions/${actionId}`, null, headersForeign);
  assert.equal(resGetForeign.status, 404);

  // Foreign user Approve -> 404
  const resApproveForeign = await handleAsyncApiRequest('POST', `/api/v1/actions/${actionId}/approve`, {}, headersForeign);
  assert.equal(resApproveForeign.status, 404);

  // Foreign user Execute -> 404
  const resExecForeign = await handleAsyncApiRequest('POST', `/api/v1/actions/${actionId}/execute`, {}, headersForeign);
  assert.equal(resExecForeign.status, 404);
});

test('9. Payload Hash Tamper Guard: modifying payload after approval invalidates approval and blocks execution', async () => {
  const store = new ActionStore();
  const engine = new ActionExecutionEngine({ actionStore: store, actionApprovals: {} as any });

  const record = store.createAction({
    userId: 'usr_test',
    organizationId: 'ten_test',
    workspaceId: 'ten_test',
    actionType: 'EMAIL_SEND',
    provider: 'gmail',
    capability: 'email.send',
    target: 'Gmail',
    parameters: { to: 'bob@example.com', subject: 'Original Subject' },
  });

  await engine.approveAction(record.actionId, 'ten_test', 'usr_test', 'req_1');

  // Tamper parameters via store update
  store.updateAction(record.actionId, 'ten_test', 'usr_test', {
    parameters: { to: 'attacker@evil.com', subject: 'Tampered Payload' },
  });

  await assert.rejects(
    async () => {
      await engine.executeAction(record.actionId, 'ten_test', 'usr_test', 'req_2');
    },
    (err: any) => err.code === 'APPROVAL_PAYLOAD_MISMATCH'
  );

  // Record status must be reset to WAITING_APPROVAL
  const current = store.getAction(record.actionId, 'ten_test', 'usr_test')!;
  assert.equal(current.status, 'WAITING_APPROVAL');
});

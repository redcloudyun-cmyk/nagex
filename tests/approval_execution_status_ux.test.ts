import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActionApprovalStore } from '../src/governance/action-approval.store.js';
import { DevicePendingCommandStore } from '../src/device-agent/device-pending-command.store.js';
import { DeviceCommandStatusStore } from '../src/device-agent/device-command-status.store.js';
import { handleApprovalsRoutes } from '../src/http/routes/approvals.routes.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-approval-status-'));
}

function deps(actionApprovals: ActionApprovalStore, devicePendingCommandStore = new DevicePendingCommandStore({ dir: tmp() }), deviceCommandStatusStore = new DeviceCommandStatusStore({ dir: tmp() })) {
  return {
    googleCalendarService: {} as any,
    gmailService: {} as any,
    actionApprovals,
    devicePendingCommandStore,
    deviceCommandStatusStore,
    auditLogger: {} as any,
    taskContinuationCoordinator: {} as any,
    tenantId: 'ten',
    principal: { id: 'usr', type: 'user' as const },
    modelErrorResult: (error: unknown) => ({ status: 500, data: { error } }),
  };
}

function list(actionApprovals: ActionApprovalStore, commands?: DevicePendingCommandStore, statuses?: DeviceCommandStatusStore) {
  return handleApprovalsRoutes('GET', '/api/v1/approvals', {}, {}, {}, deps(actionApprovals, commands, statuses))!.data as any;
}

test('approval disappearance cannot imply success: approved records remain visible outside Pending', () => {
  const approvals = new ActionApprovalStore();
  const approval = approvals.request({ toolId: 'KAKAOTALK_ACCESSIBILITY_DRAFT', tenantId: 'ten', principalId: 'usr', payload: { draftId: 'kdr_1' } });
  approvals.approve(approval.approvalId, 'ten', 'usr');

  const result = list(approvals);

  assert.equal(result.counts.pending, 0);
  assert.equal(result.counts.inProgress, 1);
  assert.equal(result.inProgress[0].approvalId, approval.approvalId);
  assert.equal(result.inProgress[0].executionStatus.stage, 'APPROVED');
  assert.equal(result.inProgress[0].executionStatus.verifiedOutcome, false);
});

test('Pending(0) may coexist with In Progress(1) after command creation', () => {
  const approvals = new ActionApprovalStore();
  const commands = new DevicePendingCommandStore({ dir: tmp() });
  const approval = approvals.request({ toolId: 'KAKAOTALK_ACCESSIBILITY_DRAFT', tenantId: 'ten', principalId: 'usr', payload: { draftId: 'kdr_1' } });
  approvals.approve(approval.approvalId, 'ten', 'usr');
  approvals.consume(approval.approvalId, 'ten', 'usr', 'KAKAOTALK_ACCESSIBILITY_DRAFT', { draftId: 'kdr_1' }, 'req', 'exec_1');
  const command = commands.enqueue('dev_1', 'ten', 'usr', 'ACCESSIBILITY_EXECUTE_PLAN', null, { executionId: 'exec_1' });

  const result = list(approvals, commands);

  assert.equal(result.counts.pending, 0);
  assert.equal(result.counts.inProgress, 1);
  assert.equal(result.inProgress[0].executionStatus.stage, 'COMMAND_CREATED');
  assert.equal(result.inProgress[0].executionStatus.commandId, command.commandId);
  assert.equal(result.inProgress[0].executionStatus.delivered, false);
  assert.equal(result.inProgress[0].executionStatus.claimed, false);
});

test('execution failure or cancellation remains visible in Recent with truthful message send state', () => {
  const approvals = new ActionApprovalStore();
  const approval = approvals.request({ toolId: 'KAKAOTALK_ACCESSIBILITY_DRAFT', tenantId: 'ten', principalId: 'usr', payload: { draftId: 'kdr_1' } });
  approvals.reject(approval.approvalId, 'ten', 'usr');

  const result = list(approvals);

  assert.equal(result.counts.recent, 1);
  assert.equal(result.recent[0].executionStatus.stage, 'CANCELLED');
  assert.equal(result.recent[0].executionStatus.messageTyped, false);
  assert.equal(result.recent[0].executionStatus.sendExecuted, false);
  assert.equal(result.recent[0].executionStatus.messageSentVerified, false);
});

test('verified success requires explicit outcome evidence and is never inferred from command state', () => {
  const approvals = new ActionApprovalStore();
  const commands = new DevicePendingCommandStore({ dir: tmp() });
  const approval = approvals.request({ toolId: 'KAKAOTALK_ACCESSIBILITY_DRAFT', tenantId: 'ten', principalId: 'usr', payload: { draftId: 'kdr_1' } });
  approvals.approve(approval.approvalId, 'ten', 'usr');
  approvals.consume(approval.approvalId, 'ten', 'usr', 'KAKAOTALK_ACCESSIBILITY_DRAFT', { draftId: 'kdr_1' }, 'req', 'exec_1');
  commands.enqueue('dev_1', 'ten', 'usr', 'ACCESSIBILITY_EXECUTE_PLAN', null, { executionId: 'exec_1' });

  const result = list(approvals, commands);

  assert.equal(result.inProgress[0].executionStatus.commandCreated, true);
  assert.equal(result.inProgress[0].executionStatus.actionCompleted, false);
  assert.equal(result.inProgress[0].executionStatus.verifiedOutcome, false);
});

test('completed command without R2H verification evidence projects no verified outcome and preserves raw audit', () => {
  const approvals = new ActionApprovalStore();
  const commands = new DevicePendingCommandStore({ dir: tmp() });
  const statuses = new DeviceCommandStatusStore({ dir: tmp() });
  const approval = approvals.request({ toolId: 'KAKAOTALK_ACCESSIBILITY_DRAFT', tenantId: 'ten', principalId: 'usr', payload: { draftId: 'kdr_1' } });
  approvals.approve(approval.approvalId, 'ten', 'usr');
  approvals.consume(approval.approvalId, 'ten', 'usr', 'KAKAOTALK_ACCESSIBILITY_DRAFT', { draftId: 'kdr_1' }, 'req', 'exec_legacy');
  const command = commands.enqueue('dev_1', 'ten', 'usr', 'ACCESSIBILITY_EXECUTE_PLAN', null, { executionId: 'exec_legacy' });
  statuses.markDelivered(command.commandId, 'ten', 'usr', 'dev_1', 'exec_legacy');
  statuses.report(command.commandId, 'ten', 'usr', 'dev_1', 'CLAIMED');
  statuses.report(command.commandId, 'ten', 'usr', 'dev_1', 'EXECUTING');
  statuses.report(command.commandId, 'ten', 'usr', 'dev_1', 'COMPLETED', 'KAKAO_DIRECT_TARGET_CLICKED');

  const result = list(approvals, commands, statuses);
  const projected = result.recent[0].executionStatus;
  const raw = statuses.get(command.commandId)!;

  assert.equal(result.counts.inProgress, 0);
  assert.equal(result.counts.recent, 1);
  assert.equal(projected.stage, 'COMMAND_REPORTED_COMPLETED');
  assert.equal(projected.commandState, 'COMPLETED');
  assert.equal(projected.commandReportedCompleted, true);
  assert.equal(projected.targetVerified, false);
  assert.equal(projected.verifiedOutcome, false);
  assert.equal(projected.verificationReason, 'COMPLETION_NOT_VERIFIED');
  assert.equal(raw.stage, 'COMPLETED');
  assert.equal(raw.resultCode, 'KAKAO_DIRECT_TARGET_CLICKED');
});

test('R2H mismatch or click-only completion never projects target verified', () => {
  const approvals = new ActionApprovalStore();
  const commands = new DevicePendingCommandStore({ dir: tmp() });
  const statuses = new DeviceCommandStatusStore({ dir: tmp() });
  const approval = approvals.request({ toolId: 'KAKAOTALK_ACCESSIBILITY_DRAFT', tenantId: 'ten', principalId: 'usr', payload: { draftId: 'kdr_1' } });
  approvals.approve(approval.approvalId, 'ten', 'usr');
  approvals.consume(approval.approvalId, 'ten', 'usr', 'KAKAOTALK_ACCESSIBILITY_DRAFT', { draftId: 'kdr_1' }, 'req', 'exec_mismatch');
  const command = commands.enqueue('dev_1', 'ten', 'usr', 'ACCESSIBILITY_EXECUTE_PLAN', null, { executionId: 'exec_mismatch' });
  statuses.report(command.commandId, 'ten', 'usr', 'dev_1', 'FAILED', 'R2H_IDENTITY_MISMATCH');

  const result = list(approvals, commands, statuses);

  assert.equal(result.counts.inProgress, 0);
  assert.equal(result.recent[0].executionStatus.stage, 'FAILED');
  assert.equal(result.recent[0].executionStatus.targetVerified, false);
  assert.equal(result.recent[0].executionStatus.verifiedOutcome, false);
});

test('exact R2H target verification is the only completed verified outcome', () => {
  const approvals = new ActionApprovalStore();
  const commands = new DevicePendingCommandStore({ dir: tmp() });
  const statuses = new DeviceCommandStatusStore({ dir: tmp() });
  const approval = approvals.request({ toolId: 'KAKAOTALK_ACCESSIBILITY_DRAFT', tenantId: 'ten', principalId: 'usr', payload: { draftId: 'kdr_1' } });
  approvals.approve(approval.approvalId, 'ten', 'usr');
  approvals.consume(approval.approvalId, 'ten', 'usr', 'KAKAOTALK_ACCESSIBILITY_DRAFT', { draftId: 'kdr_1' }, 'req', 'exec_verified');
  const command = commands.enqueue('dev_1', 'ten', 'usr', 'ACCESSIBILITY_EXECUTE_PLAN', null, { executionId: 'exec_verified' });
  statuses.report(command.commandId, 'ten', 'usr', 'dev_1', 'COMPLETED', 'TARGET_VERIFIED');

  const result = list(approvals, commands, statuses);
  const projected = result.recent[0].executionStatus;

  assert.equal(result.counts.inProgress, 0);
  assert.equal(projected.stage, 'TARGET_VERIFIED');
  assert.equal(projected.targetVerified, true);
  assert.equal(projected.verifiedOutcome, true);
  assert.equal(projected.verificationReason, 'R2H_IDENTITY_MATCH');
});

test('SENT_VERIFIED is the only completed message-sent projection', () => {
  const approvals = new ActionApprovalStore();
  const commands = new DevicePendingCommandStore({ dir: tmp() });
  const statuses = new DeviceCommandStatusStore({ dir: tmp() });
  const approval = approvals.request({ toolId: 'KAKAOTALK_ACCESSIBILITY_SEND', tenantId: 'ten', principalId: 'usr', payload: { draftId: 'kdr_1' } });
  approvals.approve(approval.approvalId, 'ten', 'usr');
  approvals.consume(approval.approvalId, 'ten', 'usr', 'KAKAOTALK_ACCESSIBILITY_SEND', { draftId: 'kdr_1' }, 'req', 'exec_sent');
  const command = commands.enqueue('dev_1', 'ten', 'usr', 'ACCESSIBILITY_EXECUTE_PLAN', null, { executionId: 'exec_sent' });
  statuses.report(command.commandId, 'ten', 'usr', 'dev_1', 'COMPLETED', 'SENT_VERIFIED');

  const result = list(approvals, commands, statuses);
  const projected = result.recent[0].executionStatus;

  assert.equal(projected.stage, 'SENT_VERIFIED');
  assert.equal(projected.targetVerified, false);
  assert.equal(projected.sendExecuted, true);
  assert.equal(projected.messageSentVerified, true);
  assert.equal(projected.verifiedOutcome, true);
  assert.equal(projected.verificationReason, 'POST_SEND_OUTCOME_VERIFIED');
});

test('execution thread correlation groups retries by canonical draft id', () => {
  const approvals = new ActionApprovalStore();
  const approval = approvals.request({ toolId: 'KAKAOTALK_ACCESSIBILITY_DRAFT', tenantId: 'ten', principalId: 'usr', payload: { draftId: 'kdr_thread' } });
  approvals.approve(approval.approvalId, 'ten', 'usr');

  const result = list(approvals);

  assert.equal(result.inProgress[0].executionStatus.executionThreadId, 'kdr_thread');
});

test('temporary foreground mismatch remains waiting for precondition, not terminal failed', () => {
  const approvals = new ActionApprovalStore();
  const commands = new DevicePendingCommandStore({ dir: tmp() });
  const statuses = new DeviceCommandStatusStore({ dir: tmp() });
  const approval = approvals.request({ toolId: 'KAKAOTALK_ACCESSIBILITY_DRAFT', tenantId: 'ten', principalId: 'usr', payload: { draftId: 'kdr_1' } });
  approvals.approve(approval.approvalId, 'ten', 'usr');
  approvals.consume(approval.approvalId, 'ten', 'usr', 'KAKAOTALK_ACCESSIBILITY_DRAFT', { draftId: 'kdr_1' }, 'req', 'exec_1');
  const command = commands.enqueue('dev_1', 'ten', 'usr', 'ACCESSIBILITY_EXECUTE_PLAN', null, { executionId: 'exec_1' });
  statuses.markDelivered(command.commandId, 'ten', 'usr', 'dev_1', 'exec_1');
  statuses.report(command.commandId, 'ten', 'usr', 'dev_1', 'CLAIMED');
  statuses.report(command.commandId, 'ten', 'usr', 'dev_1', 'WAITING_FOR_PRECONDITION', 'WAITING_FOR_PRECONDITION');

  const result = list(approvals, commands, statuses);

  assert.equal(result.counts.inProgress, 1);
  assert.equal(result.inProgress[0].executionStatus.stage, 'WAITING_FOR_PRECONDITION');
  assert.equal(result.inProgress[0].executionStatus.delivered, true);
  assert.equal(result.inProgress[0].executionStatus.claimed, true);
  assert.equal(result.inProgress[0].executionStatus.verifiedOutcome, false);
  assert.equal(result.inProgress[0].executionStatus.messageSentVerified, false);
});

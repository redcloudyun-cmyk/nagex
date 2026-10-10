import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ActionApprovalStore, hashCanonicalPayload } from '../src/governance/action-approval.store.js';
import { DeviceIdentityStore } from '../src/device-agent/device-identity.store.js';
import { DevicePendingCommandStore } from '../src/device-agent/device-pending-command.store.js';
import { DeviceCommandService } from '../src/device-agent/device-command.service.js';
import { RecipientRefStore } from '../src/mobile/recipient-ref.store.js';
import { MobileAccessibilityApprovalService, KAKAOTALK_ACCESSIBILITY_DRAFT_TOOL_ID, KAKAOTALK_ACCESSIBILITY_SEND_TOOL_ID, mobileAccessibilityDraftPayload } from '../src/mobile/mobile-accessibility-approval.service.js';
import { handleApprovalsRoutes } from '../src/http/routes/approvals.routes.js';
import { handleApiRequest } from '../src/server_web.js';

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-r2d-')); }
function sha256(text: string): string { return crypto.createHash('sha256').update(text, 'utf8').digest('hex'); }
function expectCode(fn: () => unknown, code: string) { assert.throws(fn, (error: unknown) => (error as { code?: string }).code === code); }

function harness(patch: Record<string, unknown> = {}) {
  const now = Date.now();
  const devices = new DeviceIdentityStore({ dir: path.join(tmp(), 'devices') });
  const recipients = new RecipientRefStore({ dir: path.join(tmp(), 'recipients') });
  const approvals = new ActionApprovalStore(() => now);
  const pending = new DevicePendingCommandStore({ dir: path.join(tmp(), 'pending') });
  const device = devices.enroll({ tenantId: 'ten', ownerId: 'usr', publicKey: 'pub', agentVersion: 'android-r2d', capabilityInventory: ['permission:ACCESSIBILITY_SERVICE:ENABLED'] });
  const recipient = recipients.mintOrReuse({ tenantId: 'ten', ownerId: 'usr', deviceId: device.deviceId, androidContactId: 'contact_sarah', displayName: 'Sarah' });
  const message = 'Harmless certification draft.';
  const approvedTextHash = sha256(message);
  const messageHash = hashCanonicalPayload({ message });
  const service = new MobileAccessibilityApprovalService(devices, recipients, approvals);
  const input = {
    tenantId: 'ten',
    principalId: 'usr',
    requestId: 'req_r2d',
    deviceId: device.deviceId,
    recipientRef: recipient.recipientRef,
    targetPackage: 'com.kakao.talk',
    targetAppVersion: '26.8.2',
    route: 'ANDROID_ACCESSIBILITY',
    approvedTextHash,
    messageHash,
    displayName: 'Sarah',
    actionType: KAKAOTALK_ACCESSIBILITY_DRAFT_TOOL_ID,
    ...patch,
  };
  return { now, devices, recipients, approvals, pending, device, recipient, message, approvedTextHash, messageHash, service, input };
}

function deps(h = harness()) {
  return {
    googleCalendarService: {} as any,
    gmailService: {} as any,
    actionApprovals: h.approvals,
    mobileAccessibilityApprovalService: h.service,
    auditLogger: {} as any,
    taskContinuationCoordinator: { onApproved: async () => {}, onRejected: () => {} } as any,
    tenantId: 'ten',
    principal: { type: 'user' as const, id: 'usr' },
    modelErrorResult: (error: unknown) => ({ status: 400, data: { error: (error as { code?: string }).code ?? 'UNKNOWN' } }),
  };
}

test('M4C-R2D valid draft approval binds device, recipient, message hash, route, app version, and action type', () => {
  const h = harness();
  const approval = h.service.requestDraftApproval(h.input);
  assert.equal(approval.toolId, KAKAOTALK_ACCESSIBILITY_DRAFT_TOOL_ID);
  assert.equal(approval.status, 'PENDING');
  assert.equal(approval.canonicalPayload.deviceId, h.device.deviceId);
  assert.equal(approval.canonicalPayload.recipientRef, h.recipient.recipientRef);
  assert.equal(approval.canonicalPayload.approvedTextHash, h.approvedTextHash);
  assert.equal(approval.canonicalPayload.messageHash, h.messageHash);
  assert.equal(approval.canonicalPayload.executionRoute, 'ANDROID_ACCESSIBILITY');
  assert.equal(approval.canonicalPayload.actionType, KAKAOTALK_ACCESSIBILITY_DRAFT_TOOL_ID);
});

test('M4C-R2D unauthenticated create is rejected by canonical HTTP boundary', () => {
  const res = handleApiRequest('POST', '/api/v1/approvals', { toolId: KAKAOTALK_ACCESSIBILITY_DRAFT_TOOL_ID, payload: {} }, {});
  assert.equal(res.status, 401);
});

const invalidCases: Array<[string, Record<string, unknown>, string]> = [
  ['wrong tenant rejected', { tenantId: 'other' }, 'DEVICE_NOT_FOUND'],
  ['wrong user rejected', { principalId: 'other' }, 'DEVICE_NOT_FOUND'],
  ['wrong device rejected', { deviceId: 'dev_other' }, 'DEVICE_NOT_FOUND'],
  ['wrong recipient rejected', { recipientRef: 'rcp_other' }, 'MOBILE_RECIPIENT_NOT_FOUND'],
  ['wrong message hash rejected', { approvedTextHash: 'not-a-hash' }, 'MESSAGE_HASH_REQUIRED'],
  ['wrong route rejected', { route: 'APP_LINK' }, 'ROUTE_UNSUPPORTED'],
  ['wrong package rejected', { targetPackage: 'com.other' }, 'APP_NOT_ALLOWLISTED'],
  ['wrong version rejected', { targetAppVersion: '99.0.0' }, 'APP_VERSION_UNSUPPORTED'],
  ['send approval creation unavailable', { actionType: KAKAOTALK_ACCESSIBILITY_SEND_TOOL_ID }, 'MOBILE_ACCESSIBILITY_ACTION_UNSUPPORTED'],
];

for (const [name, patch, code] of invalidCases) {
  test(`M4C-R2D ${name}`, () => {
    const h = harness(patch);
    expectCode(() => h.service.requestDraftApproval(h.input), code);
  });
}

test('M4C-R2D /api/v1/approvals creates only the typed mobile draft approval and existing approve route approves it', () => {
  const h = harness();
  const created = handleApprovalsRoutes('POST', '/api/v1/approvals', { toolId: KAKAOTALK_ACCESSIBILITY_DRAFT_TOOL_ID, payload: h.input }, {}, {}, deps(h));
  assert.equal(created?.status, 201);
  const approvalId = (created?.data as { approvalId: string }).approvalId;
  const approved = handleApprovalsRoutes('POST', `/api/v1/approvals/${approvalId}/approve`, {}, {}, {}, deps(h));
  assert.equal(approved?.status, 200);
  assert.equal((approved?.data as { status: string }).status, 'APPROVED');
});

test('M4C-R2D draft approval is accepted by enqueue exactly once; stale reuse is rejected', () => {
  const h = harness();
  const approval = h.service.requestDraftApproval(h.input);
  h.approvals.approve(approval.approvalId, 'ten', 'usr');
  const commandService = new DeviceCommandService(h.devices, h.pending, h.approvals, () => h.now);
  const enqueueInput = {
    tenantId: 'ten',
    principalId: 'usr',
    requestId: 'req_enqueue',
    deviceId: h.device.deviceId,
    approvalRef: approval.approvalId,
    recipientRef: h.recipient.recipientRef,
    targetPackage: 'com.kakao.talk',
    targetAppVersion: '26.8.2',
    route: 'ANDROID_ACCESSIBILITY',
    planId: 'plan_r2d',
    approvedPayloadHash: h.approvedTextHash,
    approvedText: h.message,
    messageHash: h.messageHash,
    displayName: 'Sarah',
    expiresAt: new Date(h.now + 60_000).toISOString(),
    steps: [
      { stepId: 's1', action: 'OPEN_APP', screenContract: 'chat-list', semanticTarget: 'kakao_app' },
      { stepId: 's2', action: 'VERIFY_RECIPIENT', screenContract: 'conversation', semanticTarget: 'Sarah' },
      { stepId: 's3', action: 'TYPE_APPROVED_TEXT', screenContract: 'composer', semanticTarget: 'message_input' },
    ],
  };
  const queued = commandService.enqueueAccessibilityPlan(enqueueInput);
  assert.equal(queued.status, 'QUEUED');
  h.pending.dequeueNext(h.device.deviceId, 'ten', 'usr');
  expectCode(() => commandService.enqueueAccessibilityPlan({ ...enqueueInput, planId: 'plan_r2d_reuse' }), 'APPROVAL_ALREADY_CONSUMED');
});

test('M4C-R2D approval mutation requires reapproval for recipient/message/route drift and send plan is rejected', () => {
  const h = harness();
  const approval = h.service.requestDraftApproval(h.input);
  h.approvals.approve(approval.approvalId, 'ten', 'usr');
  const commandService = new DeviceCommandService(h.devices, h.pending, h.approvals, () => h.now);
  const base = {
    tenantId: 'ten',
    principalId: 'usr',
    requestId: 'req_drift',
    deviceId: h.device.deviceId,
    approvalRef: approval.approvalId,
    recipientRef: h.recipient.recipientRef,
    targetPackage: 'com.kakao.talk',
    targetAppVersion: '26.8.2',
    route: 'ANDROID_ACCESSIBILITY',
    planId: 'plan_drift',
    approvedPayloadHash: h.approvedTextHash,
    approvedText: h.message,
    messageHash: h.messageHash,
    displayName: 'Sarah',
    expiresAt: new Date(h.now + 60_000).toISOString(),
    steps: [{ stepId: 's1', action: 'PRESS_SEND', screenContract: 'composer', semanticTarget: 'send' }],
  };
  expectCode(() => commandService.enqueueAccessibilityPlan(base), 'ACCESSIBILITY_ACTION_NOT_ALLOWED');
  expectCode(() => commandService.enqueueAccessibilityPlan({ ...base, steps: [{ stepId: 's1', action: 'OPEN_APP', screenContract: 'chat-list', semanticTarget: 'kakao_app' }], recipientRef: 'rcp_other' }), 'APPROVAL_PAYLOAD_MISMATCH');
  expectCode(() => commandService.enqueueAccessibilityPlan({ ...base, steps: [{ stepId: 's1', action: 'OPEN_APP', screenContract: 'chat-list', semanticTarget: 'kakao_app' }], route: 'APP_LINK' }), 'ROUTE_MUTATION_REAPPROVAL_REQUIRED');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ActionApprovalStore } from '../src/governance/action-approval.store.js';
import { DeviceAgentTransportEndpoint } from '../src/device-agent/device-agent-transport-endpoint.service.js';
import { DeviceConnectionStatusStore } from '../src/device-agent/device-connection-status.store.js';
import { DesktopExecutionSessionStore } from '../src/device-agent/desktop-execution-session.store.js';
import { DeviceIdentityStore } from '../src/device-agent/device-identity.store.js';
import { DevicePendingCommandStore } from '../src/device-agent/device-pending-command.store.js';
import { DeviceTransportSecurity } from '../src/device-agent/device-transport-security.js';
import { handleDeviceAgentRoutes } from '../src/http/routes/device-agent.routes.js';
import { ConversationTargetStore } from '../src/mobile/conversation-target.store.js';
import { KakaoAccessibilityDraftStore } from '../src/mobile/kakao-accessibility-draft.store.js';
import { KakaoAccessibilityApprovalService, KAKAOTALK_ACCESSIBILITY_DRAFT_TOOL_ID, KAKAOTALK_ACCESSIBILITY_SEND_TOOL_ID } from '../src/mobile/kakaotalk-accessibility-approval.service.js';
import { RecipientRefStore } from '../src/mobile/recipient-ref.store.js';
import { SessionStore } from '../src/sessions/session.store.js';
import { NagexError } from '../src/common/errors.js';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-r2g-bind-'));
}

function harness() {
  const approvals = new ActionApprovalStore();
  const recipientRefs = new RecipientRefStore({ dir: tmp() });
  const conversationTargets = new ConversationTargetStore({ dir: tmp(), now: () => '2026-10-08T00:00:00.000Z' });
  const deviceIdentityStore = new DeviceIdentityStore({ dir: tmp() });
  const drafts = new KakaoAccessibilityDraftStore({ deviceIdentityStore, recipientRefStore: recipientRefs, conversationTargetStore: conversationTargets }, { dir: tmp(), now: () => '2026-10-08T00:00:00.000Z' });
  const service = new KakaoAccessibilityApprovalService(approvals, recipientRefs, conversationTargets, drafts);
  const devicePendingCommandStore = new DevicePendingCommandStore({ dir: tmp() });
  const sessionStore = new SessionStore({ dir: tmp(), now: () => '2026-10-08T00:00:00.000Z' });
  const deviceAgentTransportEndpoint = new DeviceAgentTransportEndpoint(
    new DeviceTransportSecurity(deviceIdentityStore),
    deviceIdentityStore,
    new DeviceConnectionStatusStore({ dir: tmp() }),
    new DesktopExecutionSessionStore({ dir: tmp() }),
    devicePendingCommandStore,
  );
  const session = sessionStore.createAuthSession('ten', 'usr');
  const device = deviceIdentityStore.enroll({
    tenantId: 'ten',
    ownerId: 'usr',
    publicKey: 'PK',
    agentVersion: 'android',
    capabilityInventory: ['permission:ACCESSIBILITY_SERVICE:ENABLED'],
  });
  const recipient = recipientRefs.mintOrReuse({ tenantId: 'ten', ownerId: 'usr', deviceId: device.deviceId, androidContactId: 'android_1', displayName: '조민형 (Blue Dia/Mini)' });
  const conversation = conversationTargets.mintOrReuse({
    tenantId: 'ten',
    ownerId: 'usr',
    deviceId: device.deviceId,
    provider: 'KAKAOTALK',
    targetType: 'DIRECT',
    recipientRef: recipient.recipientRef,
    providerDisplayName: '조민형 (Blue Dia/Mini)',
    conversationTitle: '조민형 (Blue Dia/Mini)',
    participantHints: ['조민형'],
  });
  const draft = drafts.create({ tenantId: 'ten', ownerId: 'usr', deviceId: device.deviceId, recipientRef: recipient.recipientRef, conversationRef: conversation.conversationRef, provider: 'KAKAOTALK', route: 'ANDROID_ACCESSIBILITY', expectedProviderDisplayName: conversation.providerDisplayName, message: 'message', requestId: 'req_draft' });
  return { approvals, recipientRefs, conversationTargets, drafts, service, deviceIdentityStore, devicePendingCommandStore, sessionStore, deviceAgentTransportEndpoint, session, device, recipient, conversation, draft };
}

function input(h: ReturnType<typeof harness>, overrides: Record<string, unknown> = {}) {
  return {
    tenantId: 'ten',
    ownerId: 'usr',
    draftId: h.draft.draftId,
    deviceId: h.device.deviceId,
    recipientRef: h.recipient.recipientRef,
    conversationRef: h.conversation.conversationRef,
    messageHash: h.draft.messageHash,
    expectedProviderDisplayName: '조민형 (Blue Dia/Mini)',
    requestId: 'req_bind',
    ...overrides,
  };
}

async function enqueue(h: ReturnType<typeof harness>, approvalId: string, overrides: Record<string, unknown> = {}) {
  return handleDeviceAgentRoutes('POST', '/api/v1/device-agent/accessibility-plans', {
    deviceId: h.device.deviceId,
    recipientRef: h.recipient.recipientRef,
    draftId: h.draft.draftId,
    approvalId,
    messageHash: h.draft.messageHash,
    provider: 'KAKAOTALK',
    route: 'ANDROID_ACCESSIBILITY',
    conversationRef: h.conversation.conversationRef,
    expectedProviderDisplayName: '조민형 (Blue Dia/Mini)',
    ...overrides,
  }, { authorization: `Bearer ${h.session.sessionId}` }, {}, {
    deviceAgentTransportEndpoint: h.deviceAgentTransportEndpoint,
    deviceIdentityStore: h.deviceIdentityStore,
    devicePendingCommandStore: h.devicePendingCommandStore,
    kakaoAccessibilityApprovalService: h.service,
    sessionStore: h.sessionStore,
  });
}

function approve(h: ReturnType<typeof harness>) {
  const record = h.service.requestDraftApproval(input(h));
  h.approvals.approve(record.approvalId, 'ten', 'usr', 'req_approve');
  return record;
}

test('M4C-R2G-BIND valid DIRECT binding allows approval request and enqueue', async () => {
  const h = harness();
  const record = approve(h);
  assert.equal(record.toolId, KAKAOTALK_ACCESSIBILITY_DRAFT_TOOL_ID);
  assert.equal(record.canonicalPayload.draftId, h.draft.draftId);
  assert.equal(record.canonicalPayload.conversationRef, h.conversation.conversationRef);
  assert.equal(record.canonicalPayload.expectedProviderDisplayName, '조민형 (Blue Dia/Mini)');
  const result = await enqueue(h, record.approvalId);
  assert.equal(result?.status, 202);
  const command = (result?.data as any).command;
  assert.equal(command.data.conversationRef, h.conversation.conversationRef);
  assert.equal(command.data.expectedProviderDisplayName, '조민형 (Blue Dia/Mini)');
  assert.equal(h.approvals.get(record.approvalId, 'ten', 'usr')?.status, 'CONSUMED');
});

test('M4C-R2G-BIND wrong conversationRef owner/device is rejected', () => {
  const h = harness();
  const other = h.conversationTargets.mintOrReuse({
    tenantId: 'ten',
    ownerId: 'usr',
    deviceId: 'other_device',
    provider: 'KAKAOTALK',
    targetType: 'DIRECT',
    recipientRef: h.recipient.recipientRef,
    providerDisplayName: '조민형 (Blue Dia/Mini)',
    conversationTitle: '조민형 (Blue Dia/Mini)',
    participantHints: [],
  });
  assert.throws(() => h.service.requestDraftApproval(input(h, { conversationRef: other.conversationRef })), (err: unknown) => err instanceof NagexError && err.code === 'CONVERSATION_TARGET_NOT_FOUND');
});

test('M4C-R2G-BIND conversation recipientRef mismatch is rejected', () => {
  const h = harness();
  const otherRecipient = h.recipientRefs.mintOrReuse({ tenantId: 'ten', ownerId: 'usr', deviceId: h.device.deviceId, androidContactId: 'android_2', displayName: 'Other' });
  const mismatch = h.conversationTargets.mintOrReuse({ tenantId: 'ten', ownerId: 'usr', deviceId: h.device.deviceId, provider: 'KAKAOTALK', targetType: 'DIRECT', recipientRef: otherRecipient.recipientRef, providerDisplayName: '조민형 (Blue Dia/Mini)', conversationTitle: '조민형 (Blue Dia/Mini)', participantHints: [] });
  assert.throws(() => h.service.requestDraftApproval(input(h, { conversationRef: mismatch.conversationRef })), (err: unknown) => err instanceof NagexError && err.code === 'CONVERSATION_RECIPIENT_MISMATCH');
});

test('M4C-R2G-BIND non-DIRECT targets are rejected for person-directed flow', () => {
  for (const targetType of ['GROUP', 'OPEN_CHAT', 'CHANNEL', 'UNKNOWN'] as const) {
    const h = harness();
    const target = h.conversationTargets.mintOrReuse({ tenantId: 'ten', ownerId: 'usr', deviceId: h.device.deviceId, provider: 'KAKAOTALK', targetType, providerDisplayName: '조민형 (Blue Dia/Mini)', conversationTitle: `${targetType} room`, participantHints: [] });
    assert.throws(() => h.service.requestDraftApproval(input(h, { conversationRef: target.conversationRef })), (err: unknown) => err instanceof NagexError && err.code === 'CONVERSATION_TARGET_NOT_DIRECT');
  }
});

test('M4C-R2G-BIND expectedProviderDisplayName drift requires fresh approval', async () => {
  const h = harness();
  const record = approve(h);
  await assert.rejects(() => enqueue(h, record.approvalId, { expectedProviderDisplayName: '조민형 (Changed)' }), (err: unknown) => err instanceof NagexError && err.code === 'CONVERSATION_PROVIDER_DISPLAY_NAME_MISMATCH');
  assert.equal(h.approvals.get(record.approvalId, 'ten', 'usr')?.status, 'APPROVED');
});

test('M4C-R2G-BIND conversationRef drift requires fresh approval', async () => {
  const h = harness();
  const record = approve(h);
  const changed = h.conversationTargets.mintOrReuse({ tenantId: 'ten', ownerId: 'usr', deviceId: h.device.deviceId, provider: 'KAKAOTALK', targetType: 'DIRECT', recipientRef: h.recipient.recipientRef, providerDisplayName: '조민형 (Blue Dia/Mini)', conversationTitle: 'Changed', participantHints: [] });
  await assert.rejects(() => enqueue(h, record.approvalId, { conversationRef: changed.conversationRef }), (err: unknown) => err instanceof NagexError && err.code === 'KAKAO_ACCESSIBILITY_DRAFT_BINDING_MISMATCH');
  assert.equal(h.approvals.get(record.approvalId, 'ten', 'usr')?.status, 'APPROVED');
});

test('M4C-R2G-BIND messageHash drift requires fresh approval', async () => {
  const h = harness();
  const record = approve(h);
  await assert.rejects(() => enqueue(h, record.approvalId, { messageHash: 'sha256:changed' }), (err: unknown) => err instanceof NagexError && err.code === 'KAKAO_ACCESSIBILITY_DRAFT_BINDING_MISMATCH');
});

test('M4C-R2G-BIND legacy approval without new binding fields is unusable', async () => {
  const h = harness();
  const legacy = h.approvals.request({ toolId: KAKAOTALK_ACCESSIBILITY_DRAFT_TOOL_ID, tenantId: 'ten', principalId: 'usr', payload: { deviceId: h.device.deviceId, recipientRef: h.recipient.recipientRef, messageHash: h.draft.messageHash } });
  h.approvals.approve(legacy.approvalId, 'ten', 'usr', 'req_approve');
  await assert.rejects(() => enqueue(h, legacy.approvalId), (err: unknown) => err instanceof NagexError && err.code === 'APPROVAL_PAYLOAD_MISMATCH');
});

test('M4C-R2I-R2J SEND enqueue requires separate approval but does not consume before dispatch', async () => {
  const h = harness();
  const sendApproval = h.service.requestSendApproval(input(h));
  assert.equal(sendApproval.toolId, KAKAOTALK_ACCESSIBILITY_SEND_TOOL_ID);
  h.approvals.approve(sendApproval.approvalId, 'ten', 'usr', 'req_send_approve');
  const result = await handleDeviceAgentRoutes('POST', '/api/v1/device-agent/accessibility-send-plans', {
    deviceId: h.device.deviceId,
    recipientRef: h.recipient.recipientRef,
    draftId: h.draft.draftId,
    approvalId: sendApproval.approvalId,
    message: h.draft.message,
    messageHash: h.draft.messageHash,
    provider: 'KAKAOTALK',
    route: 'ANDROID_ACCESSIBILITY',
    conversationRef: h.conversation.conversationRef,
    expectedProviderDisplayName: h.conversation.providerDisplayName,
  }, { authorization: `Bearer ${h.session.sessionId}` }, {}, {
    deviceAgentTransportEndpoint: h.deviceAgentTransportEndpoint,
    deviceIdentityStore: h.deviceIdentityStore,
    devicePendingCommandStore: h.devicePendingCommandStore,
    kakaoAccessibilityApprovalService: h.service,
    sessionStore: h.sessionStore,
  });
  assert.equal(result?.status, 202);
  const command = (result?.data as any).command;
  assert.equal(command.data.action, 'SEND_MESSAGE');
  assert.equal(command.data.steps[0].action, 'KAKAOTALK_GOVERNED_SEND');
  assert.equal(h.approvals.get(sendApproval.approvalId, 'ten', 'usr')?.status, 'APPROVED');
  const retry = await handleDeviceAgentRoutes('POST', '/api/v1/device-agent/accessibility-send-plans', {
    deviceId: h.device.deviceId,
    recipientRef: h.recipient.recipientRef,
    draftId: h.draft.draftId,
    approvalId: sendApproval.approvalId,
    message: h.draft.message,
    messageHash: h.draft.messageHash,
    provider: 'KAKAOTALK',
    route: 'ANDROID_ACCESSIBILITY',
    conversationRef: h.conversation.conversationRef,
    expectedProviderDisplayName: h.conversation.providerDisplayName,
  }, { authorization: `Bearer ${h.session.sessionId}` }, {}, {
    deviceAgentTransportEndpoint: h.deviceAgentTransportEndpoint,
    deviceIdentityStore: h.deviceIdentityStore,
    devicePendingCommandStore: h.devicePendingCommandStore,
    kakaoAccessibilityApprovalService: h.service,
    sessionStore: h.sessionStore,
  });
  assert.equal(retry?.status, 202);
  assert.equal(h.approvals.get(sendApproval.approvalId, 'ten', 'usr')?.status, 'APPROVED');
});

test('M4C-R2I-R2J SEND approval consumes exactly once only at explicit dispatch boundary', () => {
  const h = harness();
  const sendApproval = h.service.requestSendApproval(input(h));
  h.approvals.approve(sendApproval.approvalId, 'ten', 'usr', 'req_send_approve');
  h.service.assertSendApprovalExecutable(sendApproval.approvalId, input(h));
  assert.equal(h.approvals.get(sendApproval.approvalId, 'ten', 'usr')?.status, 'APPROVED');
  h.service.consumeSendApproval(sendApproval.approvalId, input(h), 'exec_send_dispatch');
  assert.equal(h.approvals.get(sendApproval.approvalId, 'ten', 'usr')?.status, 'CONSUMED');
  assert.throws(() => h.service.consumeSendApproval(sendApproval.approvalId, input(h), 'exec_send_replay'), (err: unknown) => err instanceof NagexError && err.code === 'APPROVAL_ALREADY_CONSUMED');
});

test('M4C-R2G-BIND no coordinate path introduced', () => {
  const route = fs.readFileSync('src/http/routes/device-agent.routes.ts', 'utf8');
  const service = fs.readFileSync('mobile-android/app/src/main/java/com/nagex/mobile/NagexAccessibilityExecutionService.kt', 'utf8');
  assert.match(route, /accessibility-send-plans/);
  assert.match(route, /assertSendApprovalExecutable/);
  assert.match(service, /KAKAOTALK_GOVERNED_SEND/);
  assert.doesNotMatch(service, /dispatchGesture|GestureDescription|RAW_TAP|input tap/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateResourceId } from '../src/common/utils.js';
import { NagexError } from '../src/common/errors.js';
import { ActionApprovalStore } from '../src/governance/action-approval.store.js';
import { DeviceIdentityStore } from '../src/device-agent/device-identity.store.js';
import { ConversationTargetStore } from '../src/mobile/conversation-target.store.js';
import { KakaoAccessibilityDraftStore } from '../src/mobile/kakao-accessibility-draft.store.js';
import { buildKakaoAccessibilityMessageHash } from '../src/mobile/kakao-accessibility-draft.types.js';
import { KakaoAccessibilityApprovalService, KAKAOTALK_ACCESSIBILITY_DRAFT_TOOL_ID } from '../src/mobile/kakaotalk-accessibility-approval.service.js';
import { MobileMessageRunService } from '../src/mobile/mobile-message-run.service.js';
import { MobileMessageRunStore } from '../src/mobile/mobile-message-run.store.js';
import { RecipientRefStore } from '../src/mobile/recipient-ref.store.js';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-kdr-'));
}

function harness() {
  const deviceIdentityStore = new DeviceIdentityStore({ dir: tmp(), now: () => '2026-10-08T00:00:00.000Z' });
  const recipientRefStore = new RecipientRefStore({ dir: tmp(), now: () => '2026-10-08T00:00:00.000Z' });
  const conversationTargetStore = new ConversationTargetStore({ dir: tmp(), now: () => '2026-10-08T00:00:00.000Z' });
  const drafts = new KakaoAccessibilityDraftStore({ deviceIdentityStore, recipientRefStore, conversationTargetStore }, { dir: tmp(), now: () => '2026-10-08T00:00:00.000Z' });
  const approvals = new ActionApprovalStore();
  const approvalService = new KakaoAccessibilityApprovalService(approvals, recipientRefStore, conversationTargetStore, drafts);
  const device = deviceIdentityStore.enroll({ tenantId: 'ten', ownerId: 'usr', publicKey: 'PK', agentVersion: 'android', capabilityInventory: ['permission:ACCESSIBILITY_SERVICE:ENABLED'] });
  const recipient = recipientRefStore.mintOrReuse({ tenantId: 'ten', ownerId: 'usr', deviceId: device.deviceId, androidContactId: 'contact_1', displayName: 'target' });
  const conversation = conversationTargetStore.mintOrReuse({ tenantId: 'ten', ownerId: 'usr', deviceId: device.deviceId, provider: 'KAKAOTALK', targetType: 'DIRECT', recipientRef: recipient.recipientRef, providerDisplayName: 'target', conversationTitle: 'target', participantHints: [] });
  const base = { tenantId: 'ten', ownerId: 'usr', deviceId: device.deviceId, recipientRef: recipient.recipientRef, conversationRef: conversation.conversationRef, provider: 'KAKAOTALK' as const, route: 'ANDROID_ACCESSIBILITY' as const, expectedProviderDisplayName: 'target', message: 'hello', requestId: 'req' };
  return { deviceIdentityStore, recipientRefStore, conversationTargetStore, drafts, approvals, approvalService, device, recipient, conversation, base };
}

function expectCode(fn: () => unknown, code: string) {
  assert.throws(fn, (err: unknown) => err instanceof NagexError && err.code === code);
}

test('M4C-R2G-DRAFT server generates kdr_* and caller cannot provide draftId', () => {
  const h = harness();
  const draft = h.drafts.create({ ...h.base, draftId: 'caller_supplied' } as unknown as typeof h.base);
  assert.match(draft.draftId, /^kdr_[a-f0-9]{16}$/);
  assert.notEqual(draft.draftId, 'caller_supplied');
  assert.match(generateResourceId('kdr'), /^kdr_[a-f0-9]{16}$/);
});

test('M4C-R2G-DRAFT tenant owner and device isolation', () => {
  const h = harness();
  const draft = h.drafts.create(h.base);
  assert.equal(h.drafts.getOwned(draft.draftId, 'other', 'usr'), null);
  assert.equal(h.drafts.getOwned(draft.draftId, 'ten', 'other'), null);
  expectCode(() => h.drafts.create({ ...h.base, deviceId: 'dev_other' }), 'KAKAO_ACCESSIBILITY_DRAFT_DEVICE_INVALID');
});

test('M4C-R2G-DRAFT rejects recipient mismatch conversation mismatch and non-DIRECT targets', () => {
  const h = harness();
  const otherRecipient = h.recipientRefStore.mintOrReuse({ tenantId: 'ten', ownerId: 'usr', deviceId: h.device.deviceId, androidContactId: 'contact_2', displayName: 'other' });
  expectCode(() => h.drafts.create({ ...h.base, recipientRef: otherRecipient.recipientRef }), 'KAKAO_ACCESSIBILITY_DRAFT_RECIPIENT_MISMATCH');
  const otherConversation = h.conversationTargetStore.mintOrReuse({ tenantId: 'ten', ownerId: 'usr', deviceId: h.device.deviceId, provider: 'KAKAOTALK', targetType: 'DIRECT', recipientRef: otherRecipient.recipientRef, providerDisplayName: 'target', conversationTitle: 'target', participantHints: [] });
  expectCode(() => h.drafts.create({ ...h.base, conversationRef: otherConversation.conversationRef }), 'KAKAO_ACCESSIBILITY_DRAFT_RECIPIENT_MISMATCH');
  const group = h.conversationTargetStore.mintOrReuse({ tenantId: 'ten', ownerId: 'usr', deviceId: h.device.deviceId, provider: 'KAKAOTALK', targetType: 'GROUP', providerDisplayName: 'target', conversationTitle: 'group', participantHints: [] });
  expectCode(() => h.drafts.create({ ...h.base, conversationRef: group.conversationRef }), 'KAKAO_ACCESSIBILITY_DRAFT_CONVERSATION_NOT_DIRECT');
});

test('M4C-R2G-DRAFT exact messageHash persists and message changes create separate drafts', () => {
  const h = harness();
  const message = '안녕하세요. NAgex 카카오톡 연동 테스트 중입니다. 메시지 작성 기능 확인을 위한 테스트 문구입니다.';
  const first = h.drafts.create({ ...h.base, message });
  assert.equal(first.messageHash, 'sha256:5b81a36553531ff9db2dd25ddbbea1aa370ef84757c3cd88c06678954460a018');
  assert.equal(first.messageHash, buildKakaoAccessibilityMessageHash(message));
  const second = h.drafts.create({ ...h.base, message: `${message} 변경` });
  assert.notEqual(second.draftId, first.draftId);
  assert.notEqual(second.messageHash, first.messageHash);
});

test('M4C-R2G-DRAFT approved mutation cannot silently retain approval', () => {
  const h = harness();
  const draft = h.drafts.create(h.base);
  const approval = h.approvalService.requestDraftApproval({ ...h.base, draftId: draft.draftId, messageHash: draft.messageHash });
  h.approvals.approve(approval.approvalId, 'ten', 'usr', 'req_approve');
  h.approvals.consume(approval.approvalId, 'ten', 'usr', KAKAOTALK_ACCESSIBILITY_DRAFT_TOOL_ID, approval.canonicalPayload, 'req_consume', 'exe_1');
  h.drafts.markApproved(draft.draftId, 'ten', 'usr', approval.approvalId, 'req_mark');
  expectCode(() => h.drafts.supersede(draft.draftId, 'ten', 'usr', 'req_mutate'), 'KAKAO_ACCESSIBILITY_DRAFT_APPROVED_IMMUTABLE');
});

test('M4C-R2G-DRAFT approved immutable draft can request fresh approval without changing bindings', () => {
  const h = harness();
  const draft = h.drafts.create(h.base);
  const first = h.approvalService.requestDraftApproval({ ...h.base, draftId: draft.draftId, messageHash: draft.messageHash });
  h.approvals.approve(first.approvalId, 'ten', 'usr', 'req_approve');
  h.approvals.consume(first.approvalId, 'ten', 'usr', KAKAOTALK_ACCESSIBILITY_DRAFT_TOOL_ID, first.canonicalPayload, 'req_consume', 'exe_1');
  h.drafts.markApproved(draft.draftId, 'ten', 'usr', first.approvalId, 'req_mark');

  const second = h.approvalService.requestDraftApproval({ ...h.base, draftId: draft.draftId, messageHash: draft.messageHash });
  const updated = h.drafts.getOwned(draft.draftId, 'ten', 'usr');

  assert.notEqual(second.approvalId, first.approvalId);
  assert.equal(updated?.status, 'APPROVAL_REQUIRED');
  assert.equal(updated?.approvalId, second.approvalId);
  assert.equal(updated?.messageHash, draft.messageHash);
  assert.equal(updated?.conversationRef, draft.conversationRef);
});

test('M4C-R2G-DRAFT approval payload includes draftId and draftId drift causes mismatch', () => {
  const h = harness();
  const draft = h.drafts.create(h.base);
  const other = h.drafts.create({ ...h.base, message: 'other' });
  const approval = h.approvalService.requestDraftApproval({ ...h.base, draftId: draft.draftId, messageHash: draft.messageHash });
  assert.equal(approval.canonicalPayload.draftId, draft.draftId);
  h.approvals.approve(approval.approvalId, 'ten', 'usr', 'req_approve');
  assert.throws(
    () => h.approvalService.consumeDraftApproval(approval.approvalId, { ...h.base, draftId: other.draftId, messageHash: other.messageHash }, 'exe_1'),
    (err: unknown) => err instanceof NagexError && err.code === 'APPROVAL_PAYLOAD_MISMATCH',
  );
});

test('M4C-R2G-DRAFT legacy approval without draftId is rejected for R2G', () => {
  const h = harness();
  const draft = h.drafts.create(h.base);
  const legacy = h.approvals.request({ toolId: KAKAOTALK_ACCESSIBILITY_DRAFT_TOOL_ID, tenantId: 'ten', principalId: 'usr', payload: { deviceId: h.device.deviceId, recipientRef: h.recipient.recipientRef, conversationRef: h.conversation.conversationRef, messageHash: draft.messageHash, expectedProviderDisplayName: 'target', provider: 'KAKAOTALK', route: 'ANDROID_ACCESSIBILITY' } });
  h.approvals.approve(legacy.approvalId, 'ten', 'usr', 'req_approve');
  assert.throws(
    () => h.approvalService.consumeDraftApproval(legacy.approvalId, { ...h.base, draftId: draft.draftId, messageHash: draft.messageHash }, 'exe_1'),
    (err: unknown) => err instanceof NagexError && err.code === 'APPROVAL_PAYLOAD_MISMATCH',
  );
});

test('M4C-R2G-DRAFT SMS mobile-message flow unchanged and Kakao SEND remains separate approval path', () => {
  const h = harness();
  const sms = new MobileMessageRunService(new MobileMessageRunStore({ dir: tmp(), now: () => '2026-10-08T00:00:00.000Z' }), h.recipientRefStore, h.approvals);
  const run = sms.createDraft({ tenantId: 'ten', ownerId: 'usr', deviceId: h.device.deviceId, requestId: 'req_sms', recipientRef: h.recipient.recipientRef, message: 'sms' });
  assert.equal(run.channel, 'SMS');
  assert.equal(run.executionRoute, 'ANDROID_SMS_MANAGER');
  const route = fs.readFileSync('src/http/routes/device-agent.routes.ts', 'utf8');
  assert.match(route, /accessibility-send-plans/);
  assert.doesNotMatch(route, /PRESS_SEND|REQUEST_SEND_APPROVAL/);
});

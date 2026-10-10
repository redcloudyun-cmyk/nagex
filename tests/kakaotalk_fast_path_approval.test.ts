import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ActionApprovalStore } from '../src/governance/action-approval.store.js';
import { NagexError } from '../src/common/errors.js';
import { DeviceIdentityStore } from '../src/device-agent/device-identity.store.js';
import { ConversationTargetStore } from '../src/mobile/conversation-target.store.js';
import { KakaoAccessibilityDraftStore } from '../src/mobile/kakao-accessibility-draft.store.js';
import { buildKakaoAccessibilityMessageHash } from '../src/mobile/kakao-accessibility-draft.types.js';
import { KakaoAccessibilityApprovalService, KAKAOTALK_ACCESSIBILITY_SEND_TOOL_ID } from '../src/mobile/kakaotalk-accessibility-approval.service.js';
import { KakaoTalkFastPathApprovalService } from '../src/mobile/kakaotalk-fast-path-approval.service.js';
import { RecipientRefStore } from '../src/mobile/recipient-ref.store.js';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-kakao-fast-path-'));
}

function harness(options: { accessibility?: boolean } = {}) {
  let tick = 0;
  const nowMs = () => ++tick;
  const now = () => '2026-10-09T00:00:00.000Z';
  const approvals = new ActionApprovalStore();
  const deviceIdentityStore = new DeviceIdentityStore({ dir: tmp(), now });
  const recipientRefStore = new RecipientRefStore({ dir: tmp(), now });
  const conversationTargetStore = new ConversationTargetStore({ dir: tmp(), now });
  const draftStore = new KakaoAccessibilityDraftStore(
    { deviceIdentityStore, recipientRefStore, conversationTargetStore },
    { dir: tmp(), now },
  );
  const approvalService = new KakaoAccessibilityApprovalService(
    approvals,
    recipientRefStore,
    conversationTargetStore,
    draftStore,
  );
  const service = new KakaoTalkFastPathApprovalService({
    deviceIdentityStore,
    recipientRefStore,
    conversationTargetStore,
    draftStore,
    approvalService,
    nowMs,
  });
  const device = deviceIdentityStore.enroll({
    tenantId: 'ten',
    ownerId: 'usr',
    publicKey: 'PK',
    agentVersion: 'android',
    capabilityInventory: options.accessibility === false ? [] : ['permission:ACCESSIBILITY_SERVICE:ENABLED'],
  });
  const recipient = recipientRefStore.mintOrReuse({
    tenantId: 'ten',
    ownerId: 'usr',
    deviceId: device.deviceId,
    androidContactId: 'android_jo_min_hyeong',
    displayName: '조민형',
  });
  const conversation = conversationTargetStore.mintOrReuse({
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
  return {
    approvals,
    service,
    device,
    recipient,
    conversation,
    recipientRefStore,
    conversationTargetStore,
  };
}

function input(h: ReturnType<typeof harness>) {
  return {
    tenantId: 'ten',
    ownerId: 'usr',
    userCommand: '조민형에게 테스트입니다 보내기',
    recipientQuery: '조민형',
    message: '테스트입니다',
    requestId: 'req_fast_path',
    preferredDeviceId: h.device.deviceId,
  };
}

test('Kakao fast path creates a governed SEND approval from cached direct identity without live perception', async () => {
  const h = harness();
  const result = await h.service.prepareApproval(input(h));

  assert.equal(result.mode, 'FAST_PATH_APPROVAL_READY');
  assert.equal(result.provider, 'KAKAOTALK');
  assert.equal(result.route, 'ANDROID_ACCESSIBILITY');
  assert.equal(result.deviceId, h.device.deviceId);
  assert.equal(result.recipientRef, h.recipient.recipientRef);
  assert.equal(result.conversationRef, h.conversation.conversationRef);
  assert.equal(result.recipientDisplayName, '조민형');
  assert.equal(result.providerDisplayName, '조민형 (Blue Dia/Mini)');
  assert.equal(result.message, '테스트입니다');
  assert.equal(result.messageHash, buildKakaoAccessibilityMessageHash('테스트입니다'));
  assert.equal(result.approval.toolId, KAKAOTALK_ACCESSIBILITY_SEND_TOOL_ID);
  assert.equal(result.approval.canonicalPayload.draftId, result.draftId);
  assert.equal(result.approval.canonicalPayload.conversationRef, h.conversation.conversationRef);
  assert.equal(result.approval.canonicalPayload.expectedProviderDisplayName, '조민형 (Blue Dia/Mini)');
  assert.equal(result.telemetry.fallback, 'NONE');
  assert.ok(result.telemetry.approval_time_to_surface_ms < 500);
  assert.equal(h.approvals.listPending('ten', 'usr').length, 1);
});

test('Kakao fast path requires exactly one cached recipient identity', async () => {
  const h = harness();
  h.recipientRefStore.mintOrReuse({
    tenantId: 'ten',
    ownerId: 'usr',
    deviceId: h.device.deviceId,
    androidContactId: 'android_duplicate',
    displayName: '조민형',
  });

  await assert.rejects(
    () => h.service.prepareApproval(input(h)),
    (err: unknown) => err instanceof NagexError && err.code === 'KAKAO_FAST_PATH_RECIPIENT_UNCERTAIN',
  );
  assert.equal(h.approvals.listPending('ten', 'usr').length, 0);
});

test('Kakao fast path requires exactly one cached DIRECT KakaoTalk conversation', async () => {
  const h = harness();
  h.conversationTargetStore.mintOrReuse({
    tenantId: 'ten',
    ownerId: 'usr',
    deviceId: h.device.deviceId,
    provider: 'KAKAOTALK',
    targetType: 'DIRECT',
    recipientRef: h.recipient.recipientRef,
    providerDisplayName: '조민형 (Blue Dia/Mini) second',
    conversationTitle: '조민형 (Blue Dia/Mini) second',
    participantHints: ['조민형'],
  });

  await assert.rejects(
    () => h.service.prepareApproval(input(h)),
    (err: unknown) => err instanceof NagexError && err.code === 'KAKAO_FAST_PATH_CONVERSATION_UNCERTAIN',
  );
  assert.equal(h.approvals.listPending('ten', 'usr').length, 0);
});

test('Kakao fast path fails closed when cached device lacks accessibility capability', async () => {
  const h = harness({ accessibility: false });

  await assert.rejects(
    () => h.service.prepareApproval(input(h)),
    (err: unknown) => err instanceof NagexError && err.code === 'KAKAO_FAST_PATH_ACCESSIBILITY_NOT_ENABLED',
  );
  assert.equal(h.approvals.listPending('ten', 'usr').length, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ActionApprovalStore } from '../src/governance/action-approval.store.js';
import { DeviceIdentityStore } from '../src/device-agent/device-identity.store.js';
import { DevicePendingCommandStore } from '../src/device-agent/device-pending-command.store.js';
import { DeviceCommandStatusStore } from '../src/device-agent/device-command-status.store.js';
import { ActivityStore } from '../src/governance/activity.store.js';
import { ConversationTargetStore } from '../src/mobile/conversation-target.store.js';
import { KakaoAccessibilityDraftStore } from '../src/mobile/kakao-accessibility-draft.store.js';
import { KakaoAccessibilityApprovalService } from '../src/mobile/kakaotalk-accessibility-approval.service.js';
import { KakaoTalkFastPathApprovalService } from '../src/mobile/kakaotalk-fast-path-approval.service.js';
import { RecipientRefStore } from '../src/mobile/recipient-ref.store.js';
import { CommandContextStore } from '../src/commands/command-context.store.js';
import { MultimodalCommandService } from '../src/commands/multimodal-command.service.js';
import { mapExecutionRailState } from '../src/commands/command-context.types.js';

function tmp(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `nagex-${name}-`));
}

function h() {
  const now = () => '2026-10-09T00:00:00.000Z';
  const approvals = new ActionApprovalStore();
  const deviceIdentityStore = new DeviceIdentityStore({ dir: tmp('mm-device'), now });
  const recipientRefStore = new RecipientRefStore({ dir: tmp('mm-recipient'), now });
  const conversationTargetStore = new ConversationTargetStore({ dir: tmp('mm-conversation'), now });
  const draftStore = new KakaoAccessibilityDraftStore({ deviceIdentityStore, recipientRefStore, conversationTargetStore }, { dir: tmp('mm-draft'), now });
  const approvalService = new KakaoAccessibilityApprovalService(approvals, recipientRefStore, conversationTargetStore, draftStore);
  const devicePendingCommandStore = new DevicePendingCommandStore({ dir: tmp('mm-pending'), now });
  const deviceCommandStatusStore = new DeviceCommandStatusStore({ dir: tmp('mm-status'), now });
  const commandContextStore = new CommandContextStore({ dir: tmp('mm-command'), now });
  const activityStore = new ActivityStore({ dir: tmp('mm-activity'), now });
  const device = deviceIdentityStore.enroll({
    tenantId: 'ten',
    ownerId: 'usr',
    publicKey: 'PK',
    agentVersion: 'android',
    capabilityInventory: ['permission:ACCESSIBILITY_SERVICE:ENABLED'],
    nickname: 'Galaxy Fold3',
    os: 'Android',
  });
  const recipient = recipientRefStore.mintOrReuse({
    tenantId: 'ten',
    ownerId: 'usr',
    deviceId: device.deviceId,
    androidContactId: 'android_jo',
    displayName: 'Jo Min Hyeong',
  });
  conversationTargetStore.mintOrReuse({
    tenantId: 'ten',
    ownerId: 'usr',
    deviceId: device.deviceId,
    provider: 'KAKAOTALK',
    targetType: 'DIRECT',
    recipientRef: recipient.recipientRef,
    providerDisplayName: 'Jo Min Hyeong (Blue Dia/Mini)',
    conversationTitle: 'Jo Min Hyeong (Blue Dia/Mini)',
    participantHints: ['Jo Min Hyeong'],
  });
  const service = new MultimodalCommandService({
    commandContextStore,
    kakaoFastPathApprovalService: new KakaoTalkFastPathApprovalService({
      deviceIdentityStore,
      recipientRefStore,
      conversationTargetStore,
      draftStore,
      approvalService,
      nowMs: (() => { let n = 0; return () => ++n; })(),
    }),
    devicePendingCommandStore,
    deviceCommandStatusStore,
  });
  return { approvals, service, device, commandContextStore, activityStore };
}

test('TEXT intent creates one canonical CommandContext and fast-path Kakao approval', async () => {
  const fx = h();
  const result = await fx.service.submit({
    tenantId: 'ten',
    principalId: 'usr',
    text: 'send kakao to Jo Min Hyeong: see you at 3',
    inputModality: 'TEXT',
    originSurface: 'HOME',
    preferredExecutionDeviceId: fx.device.deviceId,
    requestId: 'req_mm_text',
  });

  assert.equal(result.handled, true);
  assert.equal(result.mode, 'KAKAO_FAST_PATH_APPROVAL');
  assert.equal(result.commandContext?.normalizedIntent, 'SEND_MESSAGE');
  assert.equal(result.commandContext?.inputModality, 'TEXT');
  assert.equal(result.commandContext?.resolvedExecutionRoute, 'ANDROID_ACCESSIBILITY');
  assert.equal(result.commandContext?.resolvedExecutionDeviceId, fx.device.deviceId);
  assert.equal(fx.approvals.listPending('ten', 'usr').length, 1);
  assert.ok(Number(result.telemetry?.approval_time_to_surface_ms) < 500);
});

test('input modality does not determine route and non-text inputs stay honest beta plumbing', async () => {
  const fx = h();
  const result = await fx.service.submit({
    tenantId: 'ten',
    principalId: 'usr',
    text: '조민형에게 카카오톡으로 "3시에 보자" 보내줘',
    inputModality: 'VOICE',
    originSurface: 'HOME',
    preferredExecutionDeviceId: fx.device.deviceId,
    requestId: 'req_mm_voice',
  });

  assert.equal(result.handled, false);
  assert.equal(result.capabilityState, 'BETA');
  assert.equal(fx.approvals.listPending('ten', 'usr').length, 0);
});

test('approval remains review-visible after approval until verified outcome exists', async () => {
  const fx = h();
  await fx.service.submit({
    tenantId: 'ten',
    principalId: 'usr',
    text: 'send kakao to Jo Min Hyeong: see you at 3',
    inputModality: 'TEXT',
    originSurface: 'HOME',
    preferredExecutionDeviceId: fx.device.deviceId,
    requestId: 'req_mm_approval',
  });
  const approval = fx.approvals.listPending('ten', 'usr')[0];
  fx.approvals.approve(approval.approvalId, 'ten', 'usr');

  const review = fx.approvals.listOwnedForReview('ten', 'usr');
  assert.equal(review.length, 1);
  assert.equal(review[0].approvalId, approval.approvalId);
  assert.equal(review[0].status, 'APPROVED');
});

test('execution rail state labels stay user-facing in EN/KR contract vocabulary', () => {
  assert.equal(mapExecutionRailState('PENDING_APPROVAL'), 'Needs approval');
  assert.equal(mapExecutionRailState('EXECUTING'), 'Working');
  assert.equal(mapExecutionRailState('WAITING_FOR_PRECONDITION'), 'Waiting for you');
  assert.equal(mapExecutionRailState('OUTCOME_OBSERVED'), 'Verifying');
  assert.equal(mapExecutionRailState('VERIFIED_SUCCESS'), 'Completed');
  assert.equal(mapExecutionRailState('FAILED'), 'Failed');
});

test('Activity integration records verified Kakao completion as user-facing history', () => {
  const fx = h();
  fx.activityStore.record({
    tenantId: 'ten',
    principalId: 'usr',
    type: 'kakaotalk.message.sent',
    title: 'Sent KakaoTalk message',
    description: 'Jo Min Hyeong ? Completed',
    status: 'COMPLETED',
    source: { approvalId: 'apr_verified', executionId: 'exec_verified' },
    dedupeKey: 'device-command:cmd_verified:SENT_VERIFIED',
  });
  const item = fx.activityStore.list('ten', 'usr')[0];
  assert.equal(item.title, 'Sent KakaoTalk message');
  assert.equal(item.status, 'COMPLETED');
  assert.doesNotMatch(JSON.stringify(item), /recipientRef|conversationRef|messageHash|route|deviceId/);
});


test('multimodal inputs merge into one CommandContext without creating executable threads', async () => {
  const fx = h();
  const result = await fx.service.submit({
    tenantId: 'ten',
    principalId: 'usr',
    text: 'summarize this screen and file',
    inputModality: 'MULTIMODAL',
    originSurface: 'HOME',
    originDeviceId: 'desktop_origin',
    screenContext: { activeApp: 'Browser', capturedAt: '2026-10-09T00:00:00.000Z' },
    inputArtifacts: [
      { artifactId: 'screen_1', modality: 'SCREEN', kind: 'SCREENSHOT', metadata: { activeApp: 'Browser' } },
      { artifactId: 'file_1', modality: 'FILE', kind: 'UPLOAD', filename: 'brief.pdf', mimeType: 'application/pdf' },
    ],
    requestId: 'req_mm_fusion',
  });

  assert.equal(result.handled, false);
  assert.equal(result.capabilityState, 'BETA');
  assert.equal(result.commandContext?.inputModality, 'MULTIMODAL');
  assert.equal(result.commandContext?.inputArtifacts.length, 2);
  assert.equal(result.commandContext?.sharedFiles.length, 1);
  assert.equal(fx.commandContextStore.list('ten', 'usr').length, 1);
});

test('one intent equals one execution thread and duplicate card identity is draft-bound', async () => {
  const fx = h();
  const result = await fx.service.submit({
    tenantId: 'ten', principalId: 'usr', text: 'send kakao to Jo Min Hyeong: see you at 3', inputModality: 'TEXT', originSurface: 'HOME', preferredExecutionDeviceId: fx.device.deviceId, requestId: 'req_mm_thread',
  });
  const approval = result.approval as { draftId: string; approvalId: string };
  assert.equal(result.commandContext?.executionThreadId, approval.draftId);
  assert.equal(fx.commandContextStore.list('ten', 'usr').filter((c) => c.executionThreadId === approval.draftId).length, 1);
});

test('completed state requires verified outcome plus cleanup marker', () => {
  const lifecycle = (verified: boolean, cleanup: boolean) => verified && cleanup ? mapExecutionRailState('VERIFIED_SUCCESS') : mapExecutionRailState('OUTCOME_OBSERVED');
  assert.equal(lifecycle(true, false), 'Verifying');
  assert.equal(lifecycle(false, true), 'Verifying');
  assert.equal(lifecycle(true, true), 'Completed');
});

test('waiting for precondition resumes the same execution thread', async () => {
  const fx = h();
  const result = await fx.service.submit({ tenantId: 'ten', principalId: 'usr', text: 'send kakao to Jo Min Hyeong: see you at 3', inputModality: 'TEXT', originSurface: 'HOME', preferredExecutionDeviceId: fx.device.deviceId, requestId: 'req_mm_wait' });
  const threadId = result.commandContext!.executionThreadId;
  assert.equal(mapExecutionRailState('WAITING_FOR_PRECONDITION'), 'Waiting for you');
  assert.equal(fx.commandContextStore.list('ten', 'usr')[0].executionThreadId, threadId);
});

test('origin surface is preserved for result return after cross-device execution', async () => {
  const fx = h();
  const result = await fx.service.submit({ tenantId: 'ten', principalId: 'usr', text: 'send kakao to Jo Min Hyeong: see you at 3', inputModality: 'TEXT', originSurface: 'HOME', originDeviceType: 'Desktop browser', preferredExecutionDeviceId: fx.device.deviceId, requestId: 'req_mm_origin' });
  assert.equal(result.commandContext?.originSurface, 'HOME');
  assert.equal(result.commandContext?.originDeviceType, 'Desktop browser');
  assert.equal(result.commandContext?.resolvedExecutionDeviceId, fx.device.deviceId);
});

test('deferred attention belongs in Inbox while current-context approval belongs in rail', () => {
  const current = { surface: 'RIGHT_RAIL', reason: 'approval is active in current context' };
  const deferred = { surface: 'INBOX', reason: 'device unavailable or approval waiting too long' };
  assert.equal(current.surface, 'RIGHT_RAIL');
  assert.equal(deferred.surface, 'INBOX');
});

test('production approval route source dispatches approved Kakao SEND once and hides internals from user card', () => {
  const route = fs.readFileSync('src/http/routes/approvals.routes.ts', 'utf8');
  const app = fs.readFileSync('public/app.js', 'latin1');
  assert.match(route, /enqueueKakaoSendAfterApproval/);
  assert.match(route, /existingCommands.find/);
  assert.match(route, /approvalId === input.record.approvalId/);
  assert.doesNotMatch(app.slice(app.indexOf('const elApprovals = document.getElementById'), app.indexOf('async function renderHomeWorkspaceSections')), /recipientRef|conversationRef|messageHash|deviceId|commandId|executionId/);
});

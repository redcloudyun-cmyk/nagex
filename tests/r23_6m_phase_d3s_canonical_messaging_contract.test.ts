import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { hashCanonicalPayload } from '../src/governance/action-approval.store.js';
import { MessagingCapabilityRegistry, assertRuntimeMessagingEvidence } from '../src/messaging/messaging-capability-registry.js';
import type { MessagingExecutionCapability, MessagingExecutionEvidence } from '../src/messaging/messaging-execution-contract.types.js';
import { buildSmsCanonicalApprovalBinding, mapSmsCanonicalResult, mapSmsExecutionTarget, SMS_CANONICAL_CAPABILITY } from '../src/messaging/sms-canonical-mapping.js';
import type { MobileMessageRunRecord } from '../src/mobile/mobile-message.types.js';

function run(status: MobileMessageRunRecord['status'], overrides: Partial<MobileMessageRunRecord> = {}): MobileMessageRunRecord {
  return { runId: 'mmr_1', tenantId: 'ten', ownerId: 'usr', deviceId: 'dev', requestId: 'req', recipientRef: 'rcp_1', channel: 'SMS', message: 'exact', executionRoute: 'ANDROID_SMS_MANAGER', status, failureReason: null, approvalId: 'apr_1', executionId: status === 'DRAFT_CREATED' ? null : 'exe_1', deliveryConfirmed: status === 'DELIVERY_CONFIRMED', createdAt: '2026-09-28T00:00:00.000Z', updatedAt: '2026-09-28T00:01:00.000Z', ...overrides };
}

test('D3S A-D. SMS maps to the canonical Android autonomous capability and immutable target', () => {
  assert.equal(SMS_CANONICAL_CAPABILITY.channel, 'SMS'); assert.equal(SMS_CANONICAL_CAPABILITY.environment, 'ANDROID');
  assert.equal(SMS_CANONICAL_CAPABILITY.executionRoute, 'ANDROID_SMS_MANAGER'); assert.equal(SMS_CANONICAL_CAPABILITY.executionMode, 'AUTONOMOUS_VERIFIED');
  assert.equal(SMS_CANONICAL_CAPABILITY.provider, 'DEVICE_NATIVE');
  const target = mapSmsExecutionTarget(run('DRAFT_CREATED'));
  assert.equal(target.addressRef, 'rcp_1'); assert.equal(target.deviceId, 'dev'); assert.equal(Object.isFrozen(target), true);
});

test('D3S E/F. canonical binding adds resolved plan dimensions without changing the SMS run state machine', () => {
  assert.deepEqual(buildSmsCanonicalApprovalBinding(run('APPROVED')), { canonicalAction: 'SEND_MESSAGE', recipientRef: 'rcp_1', message: 'exact', channel: 'SMS', environment: 'ANDROID', provider: 'DEVICE_NATIVE', executionRoute: 'ANDROID_SMS_MANAGER', deviceId: 'dev' });
  const stateSource = fs.readFileSync('src/mobile/mobile-message-run.state.ts', 'utf8');
  assert.match(stateSource, /DRAFT_CREATED/); assert.match(stateSource, /SEND_ATTEMPTED/); assert.match(stateSource, /SENT_CONFIRMED/); assert.match(stateSource, /DELIVERY_CONFIRMED/);
  assert.doesNotMatch(stateSource, /PROVIDER_ACCEPTED|READ_CONFIRMED/);
});

test('D3S G-I. canonical results have no generic SENT and preserve provider, delivery, and read distinctions', () => {
  const contract = fs.readFileSync('src/messaging/messaging-execution-contract.types.ts', 'utf8'); assert.doesNotMatch(contract, /\|\s*'SENT'/);
  const accepted = mapSmsCanonicalResult(run('SENT_CONFIRMED')); const delivered = mapSmsCanonicalResult(run('DELIVERY_CONFIRMED'));
  assert.equal(accepted.status, 'PROVIDER_ACCEPTED'); assert.notEqual(accepted.status, 'DELIVERY_CONFIRMED');
  assert.equal(delivered.status, 'DELIVERY_CONFIRMED'); assert.notEqual(delivered.status, 'READ_CONFIRMED');
  assert.equal(delivered.evidence.some((item) => item.evidenceType === 'READ_RECEIPT'), false);
});

test('D3S J-L. environment, provider, and route are material approval dimensions', () => {
  const binding = buildSmsCanonicalApprovalBinding(run('APPROVED')); const approvedHash = hashCanonicalPayload(binding as unknown as Record<string, unknown>);
  for (const drift of [{ environment: 'SERVER' }, { provider: 'GOOGLE' }, { executionRoute: 'GMAIL_API' }]) assert.notEqual(hashCanonicalPayload({ ...binding, ...drift }), approvedHash);
});

test('D3S M. executable registry contains SMS only and rejects disabled KakaoTalk', () => {
  const registry = new MessagingCapabilityRegistry(); registry.register(SMS_CANONICAL_CAPABILITY);
  const kakao: MessagingExecutionCapability = { ...SMS_CANONICAL_CAPABILITY, capabilityId: 'messaging.kakao.android_share', channel: 'KAKAOTALK', provider: 'KAKAO', executionRoute: 'KAKAOTALK_SHARE', executionMode: 'HUMAN_HANDOFF', requiresHumanCompletion: true, supportsAutonomousExecution: false, availabilityStatus: 'DISABLED', unavailableReason: 'MEMO_CHAT_COMPONENT_BLOCKED' };
  assert.throws(() => registry.register(kakao), /not executable/i);
  assert.deepEqual(registry.list().map((item) => item.capabilityId), ['messaging.sms.android_sms_manager']);
  assert.doesNotMatch(fs.readFileSync('src/app/create-nagex-application.ts', 'utf8'), /messagingAdapterRegistry\.register\(new KakaoTalkHandoffAdapter/);
});

test('D3S N. synthetic Slack-like success cannot become canonical execution evidence', () => {
  const synthetic: MessagingExecutionEvidence = { evidenceType: 'PROVIDER_API_RESPONSE', evidenceSource: 'SLACK_TEST_DOUBLE', observedAt: '2026-09-28T00:00:00.000Z', synthetic: true, providerMessageId: 'synthetic-ts' };
  assert.throws(() => assertRuntimeMessagingEvidence(synthetic), /Synthetic provider success cannot become runtime messaging evidence/);
  assert.doesNotThrow(() => assertRuntimeMessagingEvidence({ ...synthetic, synthetic: false, evidenceSource: 'SLACK_API' }));
});

test('D3S LEGACY_APPROVAL_BINDING_REQUIRES_REAPPROVAL: pre-D3S approval fails closed when executed under D3S runtime', () => {
  const { ActionApprovalStore } = require('../src/governance/action-approval.store.js');
  const { MobileMessageRunStore } = require('../src/mobile/mobile-message-run.store.js');
  const { MobileMessageRunService } = require('../src/mobile/mobile-message-run.service.js');
  const { MOBILE_SEND_SMS_TOOL_ID } = require('../src/mobile/mobile-message.types.js');
  const { NagexError } = require('../src/common/errors.js');

  const approvalStore = new ActionApprovalStore();
  const runStore = new MobileMessageRunStore();
  const recipientLookup = {
    getOwned: () => ({ recipientRef: 'rcp_legacy', displayName: 'Legacy Recipient' }),
  };
  const service = new MobileMessageRunService(runStore, recipientLookup, approvalStore);

  // A. Simulate legacy pre-D3S approval payload (missing canonicalAction, environment, provider)
  const legacyPayload = {
    recipientRef: 'rcp_legacy',
    channel: 'SMS',
    message: 'legacy message',
    deviceId: 'dev_1',
    executionRoute: 'ANDROID_SMS_MANAGER',
  };
  const legacyApproval = approvalStore.request({
    toolId: MOBILE_SEND_SMS_TOOL_ID,
    tenantId: 'ten_1',
    principalId: 'usr_1',
    payload: legacyPayload,
  });

  // User approves legacy approval
  approvalStore.approve(legacyApproval.approvalId, 'ten_1', 'usr_1', 'approver_1');

  // Create run associated with the approved legacy approval
  const run = runStore.create({
    tenantId: 'ten_1',
    ownerId: 'usr_1',
    deviceId: 'dev_1',
    requestId: 'req_legacy',
    recipientRef: 'rcp_legacy',
    message: 'legacy message',
  });
  runStore.save({ ...run, status: 'APPROVED', approvalId: legacyApproval.approvalId });

  // B & C. Runtime upgrade to D3S -> Execute attempted
  assert.throws(
    () => service.executeApproved(run.runId, 'ten_1', 'usr_1', 'dev_1', 'req_legacy'),
    (err: any) => {
      assert.ok(err instanceof NagexError);
      assert.equal(err.code, 'MOBILE_MESSAGE_PAYLOAD_DRIFT');
      return true;
    }
  );

  // Required result verification:
  // 1. Run returned to APPROVAL_REQUIRED
  const reloadedRun = runStore.getOwned(run.runId, 'ten_1', 'usr_1');
  assert.equal(reloadedRun?.status, 'APPROVAL_REQUIRED');
  // 2. Zero execution ID created on old run
  assert.equal(reloadedRun?.executionId, null);
  // 3. Old legacy approval untouched and not auto-consumed
  const legacyRecord = approvalStore.get(legacyApproval.approvalId, 'ten_1', 'usr_1');
  assert.equal(legacyRecord?.status, 'APPROVED');
  // 4. Fresh approval requested with D3S binding
  assert.notEqual(reloadedRun?.approvalId, legacyApproval.approvalId);
});

test('D3S PERSISTED_RUN_COMPATIBILITY: old run records remain readable and mapping preserves status boundaries', () => {
  const oldRun: MobileMessageRunRecord = {
    runId: 'mmr_old_1',
    tenantId: 'ten_1',
    ownerId: 'usr_1',
    deviceId: 'dev_1',
    requestId: 'req_1',
    recipientRef: 'rcp_1',
    channel: 'SMS',
    message: 'historical message',
    executionRoute: 'ANDROID_SMS_MANAGER',
    status: 'SENT_CONFIRMED',
    failureReason: null,
    approvalId: 'apr_1',
    executionId: 'exe_1',
    deliveryConfirmed: false,
    createdAt: '2026-09-27T10:00:00.000Z',
    updatedAt: '2026-09-27T10:01:00.000Z',
  };

  const canonicalResult = mapSmsCanonicalResult(oldRun);
  // Old SENT_CONFIRMED maps conservatively to PROVIDER_ACCEPTED
  assert.equal(canonicalResult.status, 'PROVIDER_ACCEPTED');
  assert.equal((canonicalResult.status as string) !== 'DELIVERY_CONFIRMED', true);
  assert.equal((canonicalResult.status as string) !== 'READ_CONFIRMED', true);
  assert.equal(canonicalResult.evidence.length, 1);
  assert.equal(canonicalResult.evidence[0].evidenceType, 'DEVICE_SEND_CALLBACK');
});


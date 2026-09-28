import type { MobileMessageRunRecord } from '../mobile/mobile-message.types.js';
import type { ExecutionTarget, MessagingApprovalBinding, MessagingExecutionCapability, MessagingExecutionEvidence, MessagingExecutionResult } from './messaging-execution-contract.types.js';
import { assertRuntimeMessagingEvidence } from './messaging-capability-registry.js';

export const SMS_CANONICAL_CAPABILITY: MessagingExecutionCapability = Object.freeze({
  capabilityId: 'messaging.sms.android_sms_manager',
  channel: 'SMS',
  environment: 'ANDROID',
  provider: 'DEVICE_NATIVE',
  executionRoute: 'ANDROID_SMS_MANAGER',
  executionMode: 'AUTONOMOUS_VERIFIED',
  recipientEnforced: true,
  messageEnforced: true,
  completionVerifiable: true,
  requiresHumanCompletion: false,
  officialApiAvailable: true,
  deviceLocalRequired: true,
  browserSessionRequired: false,
  authenticatedProviderRequired: false,
  supportsAutonomousExecution: true,
  supportsDeliveryEvidence: true,
  supportsReadEvidence: false,
  policyRisk: 'HIGH',
  availabilityStatus: 'AVAILABLE',
  certificationId: 'R23.6M-PHASE-C',
});

export function mapSmsExecutionTarget(run: MobileMessageRunRecord): ExecutionTarget {
  return Object.freeze({ targetId: run.recipientRef, tenantId: run.tenantId, ownerId: run.ownerId, channel: 'SMS', environment: 'ANDROID', provider: 'DEVICE_NATIVE', addressKind: 'OPAQUE_DEVICE_RECIPIENT_REF', addressRef: run.recipientRef, deviceId: run.deviceId });
}

export function buildSmsCanonicalApprovalBinding(run: Pick<MobileMessageRunRecord, 'recipientRef' | 'message' | 'channel' | 'deviceId' | 'executionRoute'>): MessagingApprovalBinding {
  return { canonicalAction: 'SEND_MESSAGE', recipientRef: run.recipientRef, message: run.message, channel: run.channel, environment: 'ANDROID', provider: 'DEVICE_NATIVE', executionRoute: run.executionRoute, deviceId: run.deviceId };
}

function evidence(run: MobileMessageRunRecord, item: Omit<MessagingExecutionEvidence, 'observedAt' | 'synthetic'>): MessagingExecutionEvidence {
  const value: MessagingExecutionEvidence = { ...item, observedAt: run.updatedAt, synthetic: false };
  assertRuntimeMessagingEvidence(value);
  return value;
}

export function mapSmsCanonicalResult(run: MobileMessageRunRecord): MessagingExecutionResult {
  const target = mapSmsExecutionTarget(run);
  const base = { executionId: run.executionId, route: run.executionRoute, environment: 'ANDROID' as const, provider: 'DEVICE_NATIVE', channel: run.channel, targetId: target.targetId, startedAt: run.createdAt, updatedAt: run.updatedAt };
  switch (run.status) {
    case 'SEND_ATTEMPTED':
      return { ...base, status: 'EXECUTION_STARTED', evidence: [evidence(run, { evidenceType: 'NO_CONFIRMATION_AVAILABLE', evidenceSource: 'ANDROID_SMS_MANAGER' })], retryDisposition: 'DO_NOT_RETRY' };
    case 'SENT_CONFIRMED':
      return { ...base, status: 'PROVIDER_ACCEPTED', evidence: [evidence(run, { evidenceType: 'DEVICE_SEND_CALLBACK', evidenceSource: 'ANDROID_SMS_SENT_BROADCAST', providerStatus: 'SENT_CONFIRMED' })] };
    case 'DELIVERY_CONFIRMED':
      return { ...base, status: 'DELIVERY_CONFIRMED', evidence: [evidence(run, { evidenceType: 'DEVICE_SEND_CALLBACK', evidenceSource: 'ANDROID_SMS_SENT_BROADCAST', providerStatus: 'SENT_CONFIRMED' }), evidence(run, { evidenceType: 'DELIVERY_RECEIPT', evidenceSource: 'ANDROID_SMS_DELIVERED_BROADCAST', providerStatus: 'DELIVERY_CONFIRMED' })] };
    case 'FAILED':
    case 'BLOCKED':
      return { ...base, status: 'FAILED', evidence: [], failureCode: run.failureReason ?? 'SMS_BLOCKED', retryDisposition: 'DO_NOT_RETRY' };
    default:
      return { ...base, status: 'ACTION_ACCEPTED', evidence: [] };
  }
}

// R23.6M Phase C — one complete real SMS execution flow.
//
// The server NEVER holds a phone number, at any point in this state
// machine — only recipientRef (Phase B3's opaque, tenant/owner/device-
// scoped reference). recipientRef -> local Android contactId -> phone
// number resolution happens exclusively on the device, at execution time,
// mirroring the same privacy boundary Phase B3 established for contact
// resolution.
export type MobileMessageChannel = 'SMS';

// The only real execution route Phase C implements. Deliberately not the
// generic device-control vocabulary (ANDROID_INTENT/APP_UI_AUTOMATION/etc
// from the wider R23.6M design doc) — this names exactly what happens:
// the device's own SmsManager API, nothing else.
export type MobileMessageExecutionRoute = 'ANDROID_SMS_MANAGER';

export type MobileMessageRunStatus =
  | 'DRAFT_CREATED'
  | 'APPROVAL_REQUIRED'
  | 'APPROVED'
  | 'SEND_ATTEMPTED'
  | 'SENT_CONFIRMED'
  | 'DELIVERY_CONFIRMED'
  | 'FAILED'
  | 'BLOCKED';

export type MobileMessageFailureReason =
  | 'RECIPIENT_INVALID'
  | 'APPROVAL_REJECTED'
  | 'APPROVAL_EXPIRED'
  | 'PAYLOAD_DRIFT'
  | 'DEVICE_MISMATCH'
  | 'SEND_FAILED'
  | 'SEND_STATUS_UNKNOWN';

export interface MobileMessageRunRecord {
  runId: string;
  tenantId: string;
  ownerId: string;
  deviceId: string;
  requestId: string;

  recipientRef: string;
  channel: MobileMessageChannel;
  message: string;
  executionRoute: MobileMessageExecutionRoute;

  status: MobileMessageRunStatus;
  failureReason: MobileMessageFailureReason | null;

  approvalId: string | null;
  executionId: string | null;
  // Set only once a device-reported terminal/near-terminal send result has
  // been recorded — never inferred from EXECUTE alone (invoking the API is
  // not the same as a confirmed send).
  deliveryConfirmed: boolean;

  createdAt: string;
  updatedAt: string;
}

export function isMobileMessageRunRecord(value: unknown): value is MobileMessageRunRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.runId === 'string'
    && typeof v.tenantId === 'string'
    && typeof v.ownerId === 'string'
    && typeof v.deviceId === 'string'
    && typeof v.requestId === 'string'
    && typeof v.recipientRef === 'string'
    && v.channel === 'SMS'
    && typeof v.message === 'string'
    && v.executionRoute === 'ANDROID_SMS_MANAGER'
    && typeof v.status === 'string'
    && (v.approvalId === null || typeof v.approvalId === 'string')
    && (v.executionId === null || typeof v.executionId === 'string')
    && typeof v.deliveryConfirmed === 'boolean'
    && typeof v.createdAt === 'string'
    && typeof v.updatedAt === 'string';
}

// The exact fields bound into the approval payload — recipientRef,
// channel, message, deviceId, executionRoute. Any change to any one of
// these after approval must cause the next execute attempt to fail
// payload-hash comparison (ActionApprovalStore.consume()), not be
// silently accepted.
export interface MobileMessageApprovalPayload {
  recipientRef: string;
  channel: MobileMessageChannel;
  message: string;
  deviceId: string;
  executionRoute: MobileMessageExecutionRoute;
}

export function buildApprovalPayload(run: Pick<MobileMessageRunRecord, 'recipientRef' | 'channel' | 'message' | 'deviceId' | 'executionRoute'>): MobileMessageApprovalPayload {
  return {
    recipientRef: run.recipientRef,
    channel: run.channel,
    message: run.message,
    deviceId: run.deviceId,
    executionRoute: run.executionRoute,
  };
}

export const MOBILE_SEND_SMS_TOOL_ID = 'mobile.send_sms';

// Device-reported real result of attempting SmsManager.sendTextMessage() —
// never fabricated from the fact that the API call itself did not throw.
export type MobileMessageSendResult = 'SENT_CONFIRMED' | 'SEND_FAILED' | 'SEND_STATUS_UNKNOWN';

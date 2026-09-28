import type { ExecutionRoute, MessagingChannel, MessagingRouteCapabilities } from './send-message-action.types.js';

export type MessagingHandoffStatus = 'READY' | 'APPROVAL_REQUIRED' | 'APPROVED' | 'HANDOFF_STARTED' | 'NEEDS_HUMAN' | 'FAILED' | 'UNAVAILABLE';

export interface MessagingHandoffRun {
  runId: string;
  tenantId: string;
  ownerId: string;
  deviceId: string;
  requestId: string;
  intendedRecipientRef: string;
  channel: MessagingChannel;
  message: string;
  executionRoute: ExecutionRoute;
  routeCapabilities: MessagingRouteCapabilities;
  status: MessagingHandoffStatus;
  failureReason: string | null;
  approvalId: string | null;
  executionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MessagingHandoffApprovalPayload {
  intendedRecipientRef: string;
  channel: MessagingChannel;
  message: string;
  deviceId: string;
  executionRoute: ExecutionRoute;
}

export function buildMessagingHandoffApprovalPayload(run: MessagingHandoffRun): MessagingHandoffApprovalPayload {
  return { intendedRecipientRef: run.intendedRecipientRef, channel: run.channel, message: run.message, deviceId: run.deviceId, executionRoute: run.executionRoute };
}

export function isMessagingHandoffRun(value: unknown): value is MessagingHandoffRun {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.runId === 'string' && typeof v.tenantId === 'string' && typeof v.ownerId === 'string'
    && typeof v.deviceId === 'string' && typeof v.requestId === 'string' && typeof v.intendedRecipientRef === 'string'
    && (v.channel === 'SMS' || v.channel === 'KAKAOTALK') && typeof v.message === 'string'
    && (v.executionRoute === 'KAKAOTALK_SHARE' || v.executionRoute === 'KAKAOTALK_MANUAL')
    && typeof v.routeCapabilities === 'object' && typeof v.status === 'string'
    && (v.approvalId === null || typeof v.approvalId === 'string')
    && (v.executionId === null || typeof v.executionId === 'string');
}

export const KAKAOTALK_HANDOFF_TOOL_ID = 'messaging.kakaotalk_handoff';

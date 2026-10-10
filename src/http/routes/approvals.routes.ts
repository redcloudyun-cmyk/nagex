// R10.2-D Increment 4 — Approval lifecycle routes, extracted verbatim from
// server_web.ts's handleApiRequest (sync). Approval record state (PENDING/
// APPROVED/REJECTED) is a separate concept from permission to execute a
// provider mutation: approve/reject here only ever update the approval
// record and fire the Task-continuation hook — they never themselves call
// a Gmail/Calendar client. The actual provider write still requires the
// separate /api/v1/tools/gmail/* or /api/v1/tools/google-calendar/*
// endpoint to be called afterward with the now-approved approvalId, which
// GoogleCapabilityExecutionPipeline (R10.2-B) re-validates end to end
// (ownership, expiry, toolId binding, payload/hash binding, one-time
// consumption) — this module reimplements none of that, it only proxies to
// GoogleCalendarService/GmailService's own approve()/reject()/getApproval()
// methods, which already are that same canonical pipeline's front door.
//
// R12.1 Increment 2.5 (DEBT-0006 closure) — GET /api/v1/approvals used to
// return a hardcoded, permanently-seeded array of 2 fictional demo
// approval records, never real Calendar/Gmail approval state. That array
// is removed entirely. The real, tenant/principal-scoped "list pending
// approvals" primitive (ActionApprovalStore.listPending — already used by
// Daily Brief's own "Needs Your Approval" section) is now this endpoint's
// only data source. Production default: no fictional approvals can ever
// be returned.
import type { PrincipalReference } from '../../common/types.js';
import type { AuditLogger } from '../../governance/audit.logger.js';
import type { TaskContinuationCoordinator } from '../../tasks/task-continuation.coordinator.js';
import type { GoogleCalendarService } from '../../modules/calendar/index.js';
import type { GmailService } from '../../modules/gmail/index.js';
import type { ActionApprovalStore, ActionApprovalRecord } from '../../governance/action-approval.store.js';
import {
  GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID,
  GOOGLE_CALENDAR_UPDATE_EVENT_TOOL_ID,
  GOOGLE_CALENDAR_CANCEL_EVENT_TOOL_ID,
  GOOGLE_CALENDAR_RESPOND_EVENT_TOOL_ID,
} from '../../modules/calendar/index.js';
import {
  GMAIL_SEND_EMAIL_TOOL_ID,
  GMAIL_REPLY_TOOL_ID,
  GMAIL_CREATE_DRAFT_TOOL_ID,
} from '../../modules/gmail/index.js';
import {
  ANDROID_ACCESSIBILITY_ROUTE,
  KAKAOTALK_ACCESSIBILITY_DRAFT_TOOL_ID,
  KAKAOTALK_ACCESSIBILITY_SEND_TOOL_ID,
  KAKAOTALK_PROVIDER,
  SEND_KAKAO_DIRECT_MESSAGE_ACTION,
  type KakaoAccessibilityApprovalService,
} from '../../mobile/kakaotalk-accessibility-approval.service.js';
import type { DevicePendingCommandStore } from '../../device-agent/device-pending-command.store.js';
import type { DevicePendingCommand } from '../../device-agent/device-agent-protocol.js';
import type { DeviceCommandStatusRecord, DeviceCommandStatusStore } from '../../device-agent/device-command-status.store.js';
import { NagexError } from '../../common/errors.js';
import type { ApiResult, SyncRouteRegistrar } from '../http-types.js';

// Human-readable action label derived only from the record's own toolId —
// never from a hardcoded demo string. Unknown/future toolIds fall back to
// a still-honest generic label rather than guessing.
const TOOL_ID_ACTION_LABELS: Record<string, string> = {
  [GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID]: 'Create Google Calendar event',
  [GOOGLE_CALENDAR_UPDATE_EVENT_TOOL_ID]: 'Update Google Calendar event',
  [GOOGLE_CALENDAR_CANCEL_EVENT_TOOL_ID]: 'Cancel Google Calendar event',
  [GOOGLE_CALENDAR_RESPOND_EVENT_TOOL_ID]: 'Respond to Google Calendar event',
  [GMAIL_SEND_EMAIL_TOOL_ID]: 'Send Gmail message',
  [GMAIL_REPLY_TOOL_ID]: 'Reply to Gmail message',
  [GMAIL_CREATE_DRAFT_TOOL_ID]: 'Create Gmail draft',
  [KAKAOTALK_ACCESSIBILITY_DRAFT_TOOL_ID]: 'Prepare KakaoTalk draft',
  [KAKAOTALK_ACCESSIBILITY_SEND_TOOL_ID]: 'Send KakaoTalk message',
};

function humanActionLabelForToolId(toolId: string): string {
  return TOOL_ID_ACTION_LABELS[toolId] || 'Approval required';
}

function resourceIdForRecord(record: ActionApprovalRecord): string {
  const payload = record.canonicalPayload || {};
  const candidate = (payload.summary || payload.subject || payload.title || payload.to) as unknown;
  return typeof candidate === 'string' && candidate.trim() ? candidate : record.toolId;
}

// Maps a real ActionApprovalRecord to the shape Home/Inbox/mobile already
// render (id/approvalId/toolId/action/resource/status/timestamps) — no
// frontend rendering change required, only the data source underneath it.
function toApprovalSummary(record: ActionApprovalRecord, kakaoAccessibilityApprovalService?: KakaoAccessibilityApprovalService, pendingCommands: DevicePendingCommand[] = [], commandStatuses: DeviceCommandStatusRecord[] = []): Record<string, unknown> {
  const command = pendingCommands.find((candidate) => {
    const data = candidate.data as Record<string, unknown>;
    return data.executionId === record.executionId || data.approvalId === record.approvalId;
  });
  const statusRecord = commandStatuses.find((candidate) => candidate.executionId === record.executionId || candidate.commandId === command?.commandId);
  const executionStatus = buildExecutionStatus(record, command, statusRecord);
  const summary: Record<string, unknown> = {
    id: record.approvalId,
    approvalId: record.approvalId,
    toolId: record.toolId,
    action: humanActionLabelForToolId(record.toolId),
    resource: { id: resourceIdForRecord(record) },
    status: record.status,
    executionStatus,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  };
  const kakaoDetails = kakaoAccessibilityApprovalService?.describeApprovalForHuman(record);
  if (kakaoDetails) summary.kakaoAccessibility = kakaoDetails;
  return summary;
}

function buildExecutionStatus(record: ActionApprovalRecord, command?: DevicePendingCommand, statusRecord?: DeviceCommandStatusRecord): Record<string, unknown> {
  const commandCreated = Boolean(record.executionId || command);
  const payload = record.canonicalPayload ?? {};
  const executionThreadId = typeof payload.draftId === 'string' && payload.draftId.trim()
    ? payload.draftId
    : record.approvalId;
  const targetVerified = statusRecord?.stage === 'COMPLETED' && statusRecord.resultCode === 'TARGET_VERIFIED';
  const messageSentVerified = statusRecord?.stage === 'COMPLETED' && statusRecord.resultCode === 'SENT_VERIFIED';
  const verifiedOutcome = targetVerified || messageSentVerified;
  const commandReportedCompleted = statusRecord?.stage === 'COMPLETED';
  const stage = statusRecord?.stage === 'DELIVERED'
      ? 'DELIVERED'
    : statusRecord?.stage === 'CLAIMED'
      ? 'CLAIMED'
      : statusRecord?.stage === 'WAITING_FOR_PRECONDITION'
        ? 'WAITING_FOR_PRECONDITION'
      : statusRecord?.stage === 'EXECUTING'
        ? 'EXECUTING'
        : statusRecord?.stage === 'COMPLETED'
          ? messageSentVerified ? 'SENT_VERIFIED' : targetVerified ? 'TARGET_VERIFIED' : 'COMMAND_REPORTED_COMPLETED'
          : statusRecord?.stage === 'FAILED'
            ? 'FAILED'
            : record.status === 'PENDING'
    ? 'AWAITING_APPROVAL'
    : record.status === 'REJECTED'
      ? 'CANCELLED'
      : record.status === 'EXPIRED'
        ? 'CANCELLED'
        : commandCreated
          ? 'COMMAND_CREATED'
          : record.status === 'APPROVED'
            ? 'APPROVED'
            : 'FAILED';
  const blocker = statusRecord?.stage === 'FAILED'
    ? (statusRecord.resultCode ?? 'Device command failed.')
    : statusRecord?.stage === 'WAITING_FOR_PRECONDITION'
      ? (statusRecord.resultCode ?? 'Waiting for the required app screen before executing.')
    : commandReportedCompleted && !verifiedOutcome
      ? 'COMPLETION_NOT_VERIFIED'
    : statusRecord && statusRecord.stage !== 'COMPLETED'
      ? null
      : record.status === 'CONSUMED' && command
    ? 'Command is queued and waiting for the Android device-agent to receive it.'
    : record.status === 'APPROVED'
      ? 'Approved action is waiting for command creation.'
      : record.status === 'CONSUMED'
        ? 'Approval was consumed; no verified completion evidence is available yet.'
        : record.status === 'EXPIRED'
          ? 'Approval expired before execution completed.'
          : record.status === 'REJECTED'
            ? 'Approval was rejected.'
            : null;
  return {
    stage,
    executionThreadId,
    approvalState: record.status === 'PENDING' ? 'AWAITING_APPROVAL' : record.status,
    commandCreated,
    commandId: command?.commandId ?? statusRecord?.commandId ?? null,
    commandState: statusRecord?.stage ?? (command ? 'QUEUED' : commandCreated ? 'CREATED_NOT_OBSERVED_PENDING' : 'NOT_CREATED'),
    delivered: Boolean(statusRecord?.deliveredAt),
    claimed: Boolean(statusRecord?.claimedAt),
    executing: statusRecord?.stage === 'EXECUTING',
    commandReportedCompleted,
    targetVerified,
    actionCompleted: verifiedOutcome,
    verifiedOutcome,
    messageTyped: false,
    readyToSend: false,
    sendExecuted: messageSentVerified,
    messageSentVerified,
    blocker,
    verificationReason: commandReportedCompleted && !verifiedOutcome ? 'COMPLETION_NOT_VERIFIED' : (messageSentVerified ? 'POST_SEND_OUTCOME_VERIFIED' : targetVerified ? 'R2H_IDENTITY_MATCH' : null),
    nextAction: blocker ? 'Resolve the blocker before treating this action as executed.' : null,
  };
}

function enqueueKakaoSendAfterApproval(input: {
  record: ActionApprovalRecord;
  kakaoAccessibilityApprovalService?: KakaoAccessibilityApprovalService;
  devicePendingCommandStore?: DevicePendingCommandStore;
  deviceCommandStatusStore?: DeviceCommandStatusStore;
  existingCommands: DevicePendingCommand[];
}): DevicePendingCommand | null {
  if (input.record.toolId !== KAKAOTALK_ACCESSIBILITY_SEND_TOOL_ID) return null;
  if (!input.kakaoAccessibilityApprovalService || !input.devicePendingCommandStore) return null;
  const details = input.kakaoAccessibilityApprovalService.describeApprovalForHuman(input.record);
  if (!details || !details.message) return null;
  const existing = input.existingCommands.find((command) => {
    const data = command.data as Record<string, unknown>;
    return data.approvalId === input.record.approvalId || data.draftId === details.draftId;
  });
  if (existing) return existing;
  const executionId = input.record.executionId ?? `kakao_exec_${Date.now()}`;
  const command = input.devicePendingCommandStore.enqueue(details.deviceId, input.record.tenantId, input.record.principalId, 'ACCESSIBILITY_EXECUTE_PLAN', null, {
    planId: `aplan_${input.record.approvalId}`,
    executionId,
    packageName: 'com.kakao.talk',
    targetPackage: 'com.kakao.talk',
    provider: KAKAOTALK_PROVIDER,
    route: ANDROID_ACCESSIBILITY_ROUTE,
    action: SEND_KAKAO_DIRECT_MESSAGE_ACTION,
    draftId: details.draftId,
    recipientRef: details.recipientRef,
    approvalId: input.record.approvalId,
    message: details.message,
    messageHash: details.messageHash,
    conversationRef: details.conversationRef,
    expectedProviderDisplayName: details.expectedProviderDisplayName,
    steps: [{ action: 'KAKAOTALK_GOVERNED_SEND', expectedProviderDisplayName: details.expectedProviderDisplayName, conversationRef: details.conversationRef, messageHash: details.messageHash }],
    requiresForeground: true,
    requiresUserPresence: true,
  });
  input.deviceCommandStatusStore?.markQueued({
    commandId: command.commandId,
    tenantId: input.record.tenantId,
    ownerId: input.record.principalId,
    deviceId: details.deviceId,
    executionId,
  });
  return command;
}

export interface ApprovalsRouteDeps {
  googleCalendarService: GoogleCalendarService;
  gmailService: GmailService;
  actionApprovals: ActionApprovalStore;
  kakaoAccessibilityApprovalService?: KakaoAccessibilityApprovalService;
  devicePendingCommandStore?: DevicePendingCommandStore;
  deviceCommandStatusStore?: DeviceCommandStatusStore;
  auditLogger: AuditLogger;
  taskContinuationCoordinator: TaskContinuationCoordinator;
  tenantId: string;
  principal: PrincipalReference;
  modelErrorResult: (error: unknown) => ApiResult;
}

export const handleApprovalsRoutes: SyncRouteRegistrar<ApprovalsRouteDeps> = (method, pathname, body, _headers, _query, deps): ApiResult | undefined => {
  const { googleCalendarService, gmailService, actionApprovals, kakaoAccessibilityApprovalService, devicePendingCommandStore, deviceCommandStatusStore, taskContinuationCoordinator, tenantId, principal, modelErrorResult } = deps;

  if (pathname === '/api/v1/approvals' && method === 'GET') {
    // Fail closed (R12.1 Increment 2.5 §8): a thrown error here must
    // surface as a real error response, never silently degrade into an
    // empty-looking 200 that the frontend could mistake for "zero pending
    // approvals". listPending() is a synchronous in-memory read and does
    // not normally throw, but this keeps the contract explicit rather than
    // relying on that being true forever.
    try {
      const requestId = `req_appr_list_${Date.now()}`;
      const pendingCommands = devicePendingCommandStore?.listForOwner(tenantId, principal.id) ?? [];
      const commandStatuses = deviceCommandStatusStore?.listForOwner(tenantId, principal.id) ?? [];
      const reviewRecords = actionApprovals.listOwnedForReview(tenantId, principal.id, requestId);
      const approvals = reviewRecords.map((record) => toApprovalSummary(record, kakaoAccessibilityApprovalService, pendingCommands, commandStatuses));
      const pending = approvals.filter((record) => record.status === 'PENDING');
      const inProgress = approvals.filter((record) => {
        const stage = (record.executionStatus as Record<string, unknown> | undefined)?.stage;
        return stage === 'APPROVED' || stage === 'COMMAND_CREATED' || stage === 'DELIVERED' || stage === 'CLAIMED' || stage === 'WAITING_FOR_PRECONDITION' || stage === 'EXECUTING';
      });
      const recent = approvals.filter((record) => !pending.includes(record) && !inProgress.includes(record));
      return { status: 200, data: { approvals, pending, inProgress, recent, total: approvals.length, counts: { pending: pending.length, inProgress: inProgress.length, recent: recent.length } } };
    } catch (error) {
      return modelErrorResult(error);
    }
  }

  if (pathname === '/api/v1/approvals' && method === 'POST') {
    const requestId = `req_appr_${Date.now()}`;
    const toolId = typeof body?.toolId === 'string' ? body.toolId : '';
    try {
      if (toolId === GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID) {
        const record = googleCalendarService.requestCreateEventApproval({ tenantId, principalId: principal.id, payload: body?.payload, requestId });
        return { status: 201, data: record };
      }
      if (toolId === GOOGLE_CALENDAR_UPDATE_EVENT_TOOL_ID) {
        const record = googleCalendarService.requestUpdateEventApproval({ tenantId, principalId: principal.id, payload: body?.payload, requestId });
        return { status: 201, data: record };
      }
      if (toolId === GOOGLE_CALENDAR_CANCEL_EVENT_TOOL_ID) {
        const record = googleCalendarService.requestCancelEventApproval({ tenantId, principalId: principal.id, payload: body?.payload, requestId });
        return { status: 201, data: record };
      }
      if (toolId === GOOGLE_CALENDAR_RESPOND_EVENT_TOOL_ID) {
        const record = googleCalendarService.requestRespondToEventApproval({ tenantId, principalId: principal.id, payload: body?.payload, requestId });
        return { status: 201, data: record };
      }
      if (toolId === GMAIL_SEND_EMAIL_TOOL_ID || toolId === GMAIL_REPLY_TOOL_ID || toolId === GMAIL_CREATE_DRAFT_TOOL_ID) {
        const record = gmailService.requestApproval({ toolId, tenantId, principalId: principal.id, payload: body?.payload, requestId });
        return { status: 201, data: record };
      }
      if (toolId === KAKAOTALK_ACCESSIBILITY_DRAFT_TOOL_ID || toolId === KAKAOTALK_ACCESSIBILITY_SEND_TOOL_ID) {
        if (!kakaoAccessibilityApprovalService) {
          throw new NagexError({ code: 'KAKAOTALK_APPROVAL_SERVICE_UNAVAILABLE', category: 'INTERNAL', message: 'KakaoTalk accessibility approval service is not configured.', request_id: requestId });
        }
        const payload = body?.payload as Record<string, unknown> | undefined;
        if (!payload || typeof payload !== 'object') throw new NagexError({ code: 'KAKAOTALK_APPROVAL_PAYLOAD_REQUIRED', category: 'VALIDATION', message: 'KakaoTalk accessibility approval payload is required.', request_id: requestId });
          const input = {
            tenantId,
            ownerId: principal.id,
            draftId: typeof payload.draftId === 'string' ? payload.draftId : '',
            deviceId: typeof payload.deviceId === 'string' ? payload.deviceId : '',
            recipientRef: typeof payload.recipientRef === 'string' ? payload.recipientRef : '',
            conversationRef: typeof payload.conversationRef === 'string' ? payload.conversationRef : '',
            messageHash: typeof payload.messageHash === 'string' ? payload.messageHash : '',
            expectedProviderDisplayName: typeof payload.expectedProviderDisplayName === 'string' ? payload.expectedProviderDisplayName : '',
            requestId,
          };
          const record = toolId === KAKAOTALK_ACCESSIBILITY_SEND_TOOL_ID
            ? kakaoAccessibilityApprovalService.requestSendApproval(input)
            : kakaoAccessibilityApprovalService.requestDraftApproval(input);
        return { status: 201, data: record };
      }
      throw new NagexError({ code: 'UNSUPPORTED_APPROVAL_TOOL', category: 'VALIDATION', message: `No approval-gated execution is registered for toolId "${toolId}".`, request_id: requestId });
    } catch (error) {
      return modelErrorResult(error);
    }
  }

  if (pathname.startsWith('/api/v1/approvals/') && pathname !== '/api/v1/approvals/calendar-event' && method === 'GET') {
    const apprId = pathname.slice('/api/v1/approvals/'.length);
    const record = googleCalendarService.getApproval(apprId, tenantId, principal.id) ?? actionApprovals.get(apprId, tenantId, principal.id);
    if (!record) {
      return { status: 404, data: { error: 'APPROVAL_NOT_FOUND', message: `Approval ${apprId} was not found.` } };
    }
    return { status: 200, data: record };
  }

  if (pathname === '/api/v1/approvals/calendar-event' && method === 'POST') {
    const requestId = `req_appr_${Date.now()}`;
    try {
      const record = googleCalendarService.requestCreateEventApproval({ tenantId, principalId: principal.id, payload: body?.payload, requestId });
      return { status: 201, data: record };
    } catch (error) {
      return modelErrorResult(error);
    }
  }

  if (pathname.startsWith('/api/v1/approvals/') && (pathname.endsWith('/approve') || pathname.endsWith('/reject')) && method === 'POST') {
    const isApprove = pathname.endsWith('/approve');
    const suffix = isApprove ? '/approve' : '/reject';
    const apprId = pathname.slice('/api/v1/approvals/'.length, pathname.length - suffix.length);
    const requestId = `req_appr_${Date.now()}`;
    try {
      const existing = actionApprovals.get(apprId, tenantId, principal.id, requestId);
      const useGenericApprovalStore = existing?.toolId === KAKAOTALK_ACCESSIBILITY_DRAFT_TOOL_ID || existing?.toolId === KAKAOTALK_ACCESSIBILITY_SEND_TOOL_ID;
      const record = useGenericApprovalStore
        ? (isApprove ? actionApprovals.approve(apprId, tenantId, principal.id, requestId) : actionApprovals.reject(apprId, tenantId, principal.id, requestId))
        : (isApprove ? googleCalendarService.approve(apprId, tenantId, principal.id, requestId) : googleCalendarService.reject(apprId, tenantId, principal.id, requestId));
      if (isApprove) enqueueKakaoSendAfterApproval({ record, kakaoAccessibilityApprovalService, devicePendingCommandStore, deviceCommandStatusStore, existingCommands: devicePendingCommandStore?.listForOwner(tenantId, principal.id) ?? [] });
      // P02 — fire-and-forget: this route is synchronous and its response
      // must not change (still 200 with the approval record) whether or
      // not a Task continuation exists for this approvalId. A genuine
      // no-op for every non-Task-originated approval.
      if (isApprove) taskContinuationCoordinator.onApproved(apprId).catch(() => {});
      else taskContinuationCoordinator.onRejected(apprId);
      return { status: 200, data: record };
    } catch (error) {
      return modelErrorResult(error);
    }
  }

  if (pathname.startsWith('/api/v1/approvals/') && method === 'POST') {
    const apprId = pathname.replace('/api/v1/approvals/', '').replace('/action', '');
    const action = (body?.action as string) || 'APPROVE';

    // Real, hash-verified action approvals (e.g. Google Calendar
    // create-event requests) — the only approval source this endpoint has
    // ever needed; the legacy demo-array branch that used to sit here was
    // removed in R12.1 Increment 2.5 (DEBT-0006 closure).
    const requestId = `req_appr_${Date.now()}`;
    try {
      const existing = actionApprovals.get(apprId, tenantId, principal.id, requestId);
      const useGenericApprovalStore = existing?.toolId === KAKAOTALK_ACCESSIBILITY_DRAFT_TOOL_ID || existing?.toolId === KAKAOTALK_ACCESSIBILITY_SEND_TOOL_ID;
      const record = useGenericApprovalStore
        ? (action === 'APPROVE' ? actionApprovals.approve(apprId, tenantId, principal.id, requestId) : actionApprovals.reject(apprId, tenantId, principal.id, requestId))
        : (action === 'APPROVE' ? googleCalendarService.approve(apprId, tenantId, principal.id, requestId) : googleCalendarService.reject(apprId, tenantId, principal.id, requestId));
      if (action === 'APPROVE') enqueueKakaoSendAfterApproval({ record, kakaoAccessibilityApprovalService, devicePendingCommandStore, deviceCommandStatusStore, existingCommands: devicePendingCommandStore?.listForOwner(tenantId, principal.id) ?? [] });
      if (action === 'APPROVE') taskContinuationCoordinator.onApproved(apprId).catch(() => {});
      else taskContinuationCoordinator.onRejected(apprId);
      return { status: 200, data: record };
    } catch (error) {
      return modelErrorResult(error);
    }
  }

  return undefined;
};

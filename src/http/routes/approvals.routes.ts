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
function toApprovalSummary(record: ActionApprovalRecord): Record<string, unknown> {
  return {
    id: record.approvalId,
    approvalId: record.approvalId,
    toolId: record.toolId,
    action: humanActionLabelForToolId(record.toolId),
    resource: { id: resourceIdForRecord(record) },
    status: record.status,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  };
}

export interface ApprovalsRouteDeps {
  googleCalendarService: GoogleCalendarService;
  gmailService: GmailService;
  actionApprovals: ActionApprovalStore;
  auditLogger: AuditLogger;
  taskContinuationCoordinator: TaskContinuationCoordinator;
  tenantId: string;
  principal: PrincipalReference;
  modelErrorResult: (error: unknown) => ApiResult;
}

export const handleApprovalsRoutes: SyncRouteRegistrar<ApprovalsRouteDeps> = (method, pathname, body, _headers, _query, deps): ApiResult | undefined => {
  const { googleCalendarService, gmailService, actionApprovals, taskContinuationCoordinator, tenantId, principal, modelErrorResult } = deps;

  if (pathname === '/api/v1/approvals' && method === 'GET') {
    // Fail closed (R12.1 Increment 2.5 §8): a thrown error here must
    // surface as a real error response, never silently degrade into an
    // empty-looking 200 that the frontend could mistake for "zero pending
    // approvals". listPending() is a synchronous in-memory read and does
    // not normally throw, but this keeps the contract explicit rather than
    // relying on that being true forever.
    try {
      const requestId = `req_appr_list_${Date.now()}`;
      const pending = actionApprovals.listPending(tenantId, principal.id, requestId);
      const approvals = pending.map(toApprovalSummary);
      return { status: 200, data: { approvals, total: approvals.length } };
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
      throw new NagexError({ code: 'UNSUPPORTED_APPROVAL_TOOL', category: 'VALIDATION', message: `No approval-gated execution is registered for toolId "${toolId}".`, request_id: requestId });
    } catch (error) {
      return modelErrorResult(error);
    }
  }

  if (pathname.startsWith('/api/v1/approvals/') && pathname !== '/api/v1/approvals/calendar-event' && method === 'GET') {
    const apprId = pathname.slice('/api/v1/approvals/'.length);
    const record = googleCalendarService.getApproval(apprId, tenantId, principal.id);
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
      const record = isApprove
        ? googleCalendarService.approve(apprId, tenantId, principal.id, requestId)
        : googleCalendarService.reject(apprId, tenantId, principal.id, requestId);
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
      const record = action === 'APPROVE'
        ? googleCalendarService.approve(apprId, tenantId, principal.id, requestId)
        : googleCalendarService.reject(apprId, tenantId, principal.id, requestId);
      if (action === 'APPROVE') taskContinuationCoordinator.onApproved(apprId).catch(() => {});
      else taskContinuationCoordinator.onRejected(apprId);
      return { status: 200, data: record };
    } catch (error) {
      return modelErrorResult(error);
    }
  }

  return undefined;
};

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
// approvalQueue is the legacy demo/seed approval list (2 real entries),
// moved here since grep confirmed it has no other consumer — the real,
// hash-verified action approvals (Calendar/Gmail) never touch this array,
// they live entirely in GoogleCalendarService/PersistentActionApprovalStore.
import type { PrincipalReference } from '../../common/types.js';
import type { AuditLogger } from '../../governance/audit.logger.js';
import type { TaskContinuationCoordinator } from '../../tasks/task-continuation.coordinator.js';
import type { GoogleCalendarService } from '../../modules/calendar/index.js';
import type { GmailService } from '../../modules/gmail/index.js';
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

const approvalQueue: Array<{
  id: string;
  action: string;
  tool: string;
  event_name: string;
  event_time: string;
  recipient: string;
  subject: string;
  impact: string;
  data_involved: string[];
  why: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  requested_at: string;
  plan_id?: string;
}> = [
  {
    id: 'appr_gcal_sync',
    action: 'Create Google Calendar event',
    tool: 'Google Calendar',
    event_name: 'Product Strategy Sync',
    event_time: 'Tue, Apr 29, 2025 11:00 AM – 12:00 PM (1 hour)',
    recipient: 'Sarah Kim, James Park, Alex Chen (3 guests)',
    subject: 'Product Strategy Sync',
    impact: 'Adds a calendar event and sends invitations to 3 people.',
    data_involved: ['Your Google Calendar', 'guest emails', 'meeting title and agenda'],
    why: 'You asked me to schedule a follow-up meeting after the product review.',
    status: 'PENDING',
    requested_at: new Date(Date.now() - 120000).toISOString(),
    plan_id: 'plan_acme_meeting',
  },
  {
    id: 'appr_stakeholder_email',
    action: 'Get stakeholder review',
    tool: 'Gmail',
    event_name: 'Acme QBR Deck Review',
    event_time: 'Apr 29, 5:00 PM',
    recipient: 'stakeholders@acme.corp',
    subject: 'QBR Presentation Draft Review',
    impact: 'Dispatches external review email with presentation draft to 4 stakeholders.',
    data_involved: ['Acme-QBR-Deck-Draft.pdf', 'stakeholder emails'],
    why: 'Step 5 of plan "Prepare Client Meeting" requires approval before dispatch.',
    status: 'PENDING',
    requested_at: new Date(Date.now() - 300000).toISOString(),
    plan_id: 'plan_acme_meeting',
  },
];

export interface ApprovalsRouteDeps {
  googleCalendarService: GoogleCalendarService;
  gmailService: GmailService;
  auditLogger: AuditLogger;
  taskContinuationCoordinator: TaskContinuationCoordinator;
  tenantId: string;
  principal: PrincipalReference;
  modelErrorResult: (error: unknown) => ApiResult;
}

export const handleApprovalsRoutes: SyncRouteRegistrar<ApprovalsRouteDeps> = (method, pathname, body, _headers, _query, deps): ApiResult | undefined => {
  const { googleCalendarService, gmailService, auditLogger, taskContinuationCoordinator, tenantId, principal, modelErrorResult } = deps;

  if (pathname === '/api/v1/approvals' && method === 'GET') {
    return { status: 200, data: { approvals: approvalQueue, total: approvalQueue.length } };
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
    const item = approvalQueue.find((a) => a.id === apprId);
    if (item) {
      item.status = action === 'APPROVE' ? 'APPROVED' : 'REJECTED';
      auditLogger.logEvent({
        actor: principal,
        tenant_id: tenantId,
        action: action === 'APPROVE' ? 'approval:granted' : 'approval:rejected',
        resource: { type: 'Approval', id: apprId },
        result: 'SUCCESS',
        request_id: `req_appr_${Date.now()}`,
      });
      return { status: 200, data: item };
    }

    // Not a legacy demo approval — try the real, hash-verified action approvals
    // (e.g. Google Calendar create-event requests) sharing this same endpoint.
    const requestId = `req_appr_${Date.now()}`;
    try {
      const record = action === 'APPROVE'
        ? googleCalendarService.approve(apprId, tenantId, principal.id, requestId)
        : googleCalendarService.reject(apprId, tenantId, principal.id, requestId);
      // P02 — same fire-and-forget continuation hook as the /approve
      // /reject route above; this legacy /action endpoint shares the same
      // underlying approval store, so a Task continuation may equally be
      // waiting on an approvalId granted/rejected through this path.
      if (action === 'APPROVE') taskContinuationCoordinator.onApproved(apprId).catch(() => {});
      else taskContinuationCoordinator.onRejected(apprId);
      return { status: 200, data: record };
    } catch (error) {
      return modelErrorResult(error);
    }
  }

  return undefined;
};

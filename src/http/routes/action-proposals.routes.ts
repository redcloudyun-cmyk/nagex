// R10.2-D — R11's Action Proposal routes, extracted verbatim from
// server_web.ts. DETECT -> PROPOSE -> HUMAN REVIEW -> APPROVE -> EXECUTE ->
// AUDIT. Deliberately kept as ONE domain module (not split further) since
// list/approve/reject/execute are one small, tightly-related lifecycle.
// Mutation safety unchanged (R10.2-D §10): approve()/reject() only ever
// flip ActionProposalStore status; execute() is a separate, explicit call
// that delegates to action-proposal-executor.ts's executeActionProposal(),
// the exact same canonical execution path R11 built and R10.2-D does not
// touch — this route module never calls a Calendar/Gmail/Task mutation
// directly, only through that one existing function.
import crypto from 'node:crypto';
import { NagexError } from '../../common/errors.js';
import { DEFAULT_GOOGLE_TENANT_ID } from '../../integrations/google/token.store.js';
import { dailyBriefDateKey } from '../../governance/daily-brief.store.js';
import { executeActionProposal } from '../../assistant/action-proposal-executor.js';
import type { ActionProposalStore } from '../../assistant/action-proposal.store.js';
import type { TaskStore } from '../../tasks/task.store.js';
import type { GoogleCalendarService } from '../../modules/calendar/index.js';
import type { ActivityStore } from '../../governance/activity.store.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';

function getHeaderValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export interface ActionProposalsRouteDeps {
  actionProposalStore: ActionProposalStore;
  taskStore: TaskStore;
  calendarService: GoogleCalendarService;
  activityStore: ActivityStore;
}

export const handleActionProposalsRoutes: AsyncRouteRegistrar<ActionProposalsRouteDeps> = async (method, pathname, _body, headers, query, deps): Promise<ApiResult | undefined> => {
  const { actionProposalStore, taskStore, calendarService, activityStore } = deps;

  if (pathname === '/api/v1/action-proposals' && method === 'GET') {
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const date = typeof query.date === 'string' && query.date ? query.date : dailyBriefDateKey();
    return { status: 200, data: { proposals: actionProposalStore.listForDate(tenantId, principalId, date) } };
  }

  if (pathname.startsWith('/api/v1/action-proposals/') && (pathname.endsWith('/approve') || pathname.endsWith('/reject') || pathname.endsWith('/execute')) && method === 'POST') {
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_proposal_${crypto.randomUUID()}`;
    const action = pathname.endsWith('/approve') ? 'approve' : pathname.endsWith('/reject') ? 'reject' : 'execute';
    const proposalId = pathname.slice('/api/v1/action-proposals/'.length, pathname.length - `/${action}`.length);
    const proposal = actionProposalStore.get(proposalId, tenantId, principalId);
    if (!proposal) {
      throw new NagexError({ code: 'ACTION_PROPOSAL_NOT_FOUND', category: 'NOT_FOUND', message: `Action proposal ${proposalId} was not found.`, request_id: requestId });
    }

    if (action === 'approve') {
      if (proposal.status !== 'PROPOSED') {
        throw new NagexError({ code: 'ACTION_PROPOSAL_NOT_PENDING', category: 'CONFLICT', message: `Action proposal ${proposalId} is ${proposal.status}, not PROPOSED.`, request_id: requestId });
      }
      const updated = actionProposalStore.updateStatus(proposalId, tenantId, principalId, { status: 'APPROVED' }, requestId);
      return { status: 200, data: updated };
    }
    if (action === 'reject') {
      if (proposal.status !== 'PROPOSED') {
        throw new NagexError({ code: 'ACTION_PROPOSAL_NOT_PENDING', category: 'CONFLICT', message: `Action proposal ${proposalId} is ${proposal.status}, not PROPOSED.`, request_id: requestId });
      }
      // §14 — a rejected proposal must never be executable afterward;
      // there is no path from REJECTED to /execute (execute() itself
      // also independently refuses anything but APPROVED/EXECUTING).
      const updated = actionProposalStore.updateStatus(proposalId, tenantId, principalId, { status: 'REJECTED' }, requestId);
      return { status: 200, data: updated };
    }
    // action === 'execute' — an explicit, human-triggered call only; the
    // executor itself independently refuses to run for anything other
    // than an already-APPROVED (or in-progress EXECUTING) proposal.
    const executed = await executeActionProposal(
      { taskStore, calendarService, activityStore, actionProposalStore },
      proposal,
      requestId,
    );
    return { status: 200, data: executed };
  }

  return undefined;
};

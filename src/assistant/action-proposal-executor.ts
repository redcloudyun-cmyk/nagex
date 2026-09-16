// R11 — turns an APPROVED ActionProposal into a real effect through
// EXISTING canonical runtime only (never a side-effect implementation of
// its own): TaskStore.create() for CREATE_TASK, and GoogleCalendarService's
// already-built approval-gated RSVP write (requestRespondToEventApproval /
// executeRespondToEvent) for CALENDAR_RESCHEDULE — the exact same
// ActionApprovalStore-backed request/consume/execute path every other
// Calendar write in this codebase uses. Idempotent and safely re-callable,
// mirroring CandidateActionResolver.executeCalendar()'s own two-step
// "request approval, then later execute once approved" pattern (§11:
// failure never loses proposal state; a retry is always an explicit new
// call, never automatic).
import { NagexError } from '../common/errors.js';
import type { TaskStore } from '../tasks/task.store.js';
import type { GoogleCalendarService } from '../modules/calendar/index.js';
import type { ActivityStore } from '../governance/activity.store.js';
import type { ActionProposalRecord, ActionProposalStore } from './action-proposal.store.js';

export interface ActionProposalExecutorDeps {
  taskStore: TaskStore;
  calendarService: GoogleCalendarService;
  activityStore: ActivityStore;
  actionProposalStore: ActionProposalStore;
}

function recordExecutionActivity(
  activityStore: ActivityStore,
  proposal: ActionProposalRecord,
  status: 'COMPLETED' | 'FAILED',
  title: string,
): void {
  activityStore.record({
    tenantId: proposal.tenantId,
    principalId: proposal.principalId,
    type: status === 'COMPLETED' ? 'action_proposal.executed' : 'action_proposal.execution_failed',
    title,
    status,
    dedupeKey: `action_proposal:${proposal.id}:${status}`,
  });
}

// §11 — a uniform, safe error shape: never leaks raw provider internals,
// always says whether a human retry is worth trying again.
function toFailure(error: unknown): { errorCode: string; message: string; retryable: boolean } {
  if (error instanceof NagexError) {
    const retryable = error.category === 'PROVIDER' || error.category === 'TIMEOUT' || error.category === 'RATE_LIMIT';
    return { errorCode: error.code, message: error.message, retryable };
  }
  return { errorCode: 'ACTION_PROPOSAL_EXECUTION_FAILED', message: 'The action could not be completed.', retryable: false };
}

// §14 — the ONLY function in this codebase allowed to actually execute an
// ActionProposal's effect, and it refuses to run unless the proposal has
// already been explicitly, humanly APPROVED (or is already mid-execution,
// for a safe idempotent re-check) — there is no automatic/background path
// that ever calls this.
export async function executeActionProposal(
  deps: ActionProposalExecutorDeps,
  proposal: ActionProposalRecord,
  requestId: string,
): Promise<ActionProposalRecord> {
  const { taskStore, calendarService, activityStore, actionProposalStore } = deps;

  // A re-call on an already-COMPLETED proposal (e.g. the UI calling
  // execute() again after a page reload) is a safe no-op, exactly like
  // CandidateActionResolver.executeCandidate()'s own "SUCCEEDED returns
  // unchanged" idempotency — never a re-execution, never an error.
  if (proposal.status === 'COMPLETED') return proposal;

  if (proposal.status !== 'APPROVED' && proposal.status !== 'EXECUTING') {
    throw new NagexError({
      code: 'ACTION_PROPOSAL_NOT_APPROVED',
      category: 'CONFLICT',
      message: `Action proposal ${proposal.id} is ${proposal.status}, not APPROVED — it cannot be executed.`,
      request_id: requestId,
    });
  }
  if (!proposal.executable) {
    throw new NagexError({
      code: 'ACTION_PROPOSAL_NOT_EXECUTABLE',
      category: 'VALIDATION',
      message: `Action proposal ${proposal.id} (${proposal.proposalType}) has no real execution path — review only.`,
      request_id: requestId,
    });
  }

  if (proposal.proposalType === 'CREATE_TASK') {
    // Idempotent: a proposal already linked to a real Task is never
    // re-created, even if execute is called twice.
    if (proposal.result?.targetId) return proposal;
    try {
      const task = taskStore.create({
        tenantId: proposal.tenantId,
        ownerId: proposal.principalId,
        name: proposal.title,
        objective: proposal.rationale,
        type: 'ONE_TIME',
        trigger: { type: 'MANUAL' },
        approvalPolicy: 'READ_ONLY_AUTO',
      });
      const updated = actionProposalStore.updateStatus(proposal.id, proposal.tenantId, proposal.principalId, {
        status: 'COMPLETED',
        result: { targetId: task.taskId },
      }, requestId);
      recordExecutionActivity(activityStore, updated, 'COMPLETED', `Created Task "${task.name}" from a Daily Brief suggestion`);
      return updated;
    } catch (error) {
      const failure = toFailure(error);
      const updated = actionProposalStore.updateStatus(proposal.id, proposal.tenantId, proposal.principalId, {
        status: 'FAILED',
        failure: { ...failure, failedAt: new Date().toISOString() },
      }, requestId);
      recordExecutionActivity(activityStore, updated, 'FAILED', `Failed to create Task from a Daily Brief suggestion`);
      return updated;
    }
  }

  if (proposal.proposalType === 'CALENDAR_RESCHEDULE') {
    if (!proposal.approvalId) {
      // Step 1: request the real, existing Calendar RSVP approval — this
      // proposal now waits on that separate, already-built approval flow
      // (it will surface in the normal Approvals/"Needs Approval" list).
      try {
        const approval = calendarService.requestRespondToEventApproval({
          tenantId: proposal.tenantId,
          principalId: proposal.principalId,
          payload: proposal.proposedAction,
          requestId,
        });
        return actionProposalStore.updateStatus(proposal.id, proposal.tenantId, proposal.principalId, {
          status: 'EXECUTING',
          approvalId: approval.approvalId,
        }, requestId);
      } catch (error) {
        const failure = toFailure(error);
        const updated = actionProposalStore.updateStatus(proposal.id, proposal.tenantId, proposal.principalId, {
          status: 'FAILED',
          failure: { ...failure, failedAt: new Date().toISOString() },
        }, requestId);
        recordExecutionActivity(activityStore, updated, 'FAILED', 'Failed to request Calendar approval for a Daily Brief suggestion');
        return updated;
      }
    }

    // Step 2 (idempotent re-check): only proceeds once the SEPARATE real
    // Calendar approval has itself been approved by the human — never
    // guessed, never bypassed.
    const approval = calendarService.getApproval(proposal.approvalId, proposal.tenantId, proposal.principalId);
    if (!approval) {
      const updated = actionProposalStore.updateStatus(proposal.id, proposal.tenantId, proposal.principalId, {
        status: 'FAILED',
        failure: { errorCode: 'ACTION_PROPOSAL_APPROVAL_MISSING', message: 'The linked approval no longer exists.', failedAt: new Date().toISOString(), retryable: false },
      }, requestId);
      recordExecutionActivity(activityStore, updated, 'FAILED', 'Calendar approval for a Daily Brief suggestion is missing');
      return updated;
    }
    if (approval.status === 'REJECTED' || approval.status === 'EXPIRED') {
      const updated = actionProposalStore.updateStatus(proposal.id, proposal.tenantId, proposal.principalId, {
        status: 'FAILED',
        failure: { errorCode: `ACTION_PROPOSAL_APPROVAL_${approval.status}`, message: `The Calendar approval was ${approval.status.toLowerCase()}.`, failedAt: new Date().toISOString(), retryable: false },
      }, requestId);
      recordExecutionActivity(activityStore, updated, 'FAILED', `Calendar approval for a Daily Brief suggestion was ${approval.status.toLowerCase()}`);
      return updated;
    }
    if (approval.status === 'PENDING') {
      // Still waiting on the human to approve the Calendar RSVP itself —
      // not a failure, just not done yet. No change.
      return proposal;
    }
    // approval.status === 'APPROVED' (or already CONSUMED from a prior,
    // successful call — executeRespondToEvent below is what would have
    // consumed it, so CONSUMED here means step 2 already succeeded once).
    if (approval.status === 'CONSUMED') return proposal;

    try {
      const result = await calendarService.executeRespondToEvent({
        approvalId: proposal.approvalId,
        payload: proposal.proposedAction,
        tenantId: proposal.tenantId,
        principalId: proposal.principalId,
        requestId,
      });
      const updated = actionProposalStore.updateStatus(proposal.id, proposal.tenantId, proposal.principalId, {
        status: 'COMPLETED',
        result: { targetId: result.externalId, externalUrl: result.externalUrl },
      }, requestId);
      recordExecutionActivity(activityStore, updated, 'COMPLETED', 'Confirmed attendance for a moved calendar event');
      return updated;
    } catch (error) {
      const failure = toFailure(error);
      // §11 — GoogleCalendarService.executeRespondToEvent() consumes the
      // real ActionApprovalStore approval BEFORE calling the Google API
      // (see google-calendar.service.ts's executeWrite): the one case that
      // fails BEFORE consuming is GOOGLE_CALENDAR_DISCONNECTED (missing
      // token), so the approval is still APPROVED and a later re-execute
      // can genuinely retry. Any other failure reaching this catch means
      // the approval is already CONSUMED — retrying this same proposal can
      // never succeed (a fresh proposal/approval would be required), so
      // `retryable` must never claim otherwise here even if the error's
      // own category would normally suggest a transient retry.
      const retryable = failure.errorCode === 'GOOGLE_CALENDAR_DISCONNECTED';
      const updated = actionProposalStore.updateStatus(proposal.id, proposal.tenantId, proposal.principalId, {
        status: 'FAILED',
        failure: { ...failure, retryable, failedAt: new Date().toISOString() },
      }, requestId);
      recordExecutionActivity(activityStore, updated, 'FAILED', 'Failed to confirm attendance for a moved calendar event');
      return updated;
    }
  }

  throw new NagexError({ code: 'ACTION_PROPOSAL_TYPE_NOT_EXECUTABLE', category: 'VALIDATION', message: `${proposal.proposalType} has no execution path.`, request_id: requestId });
}

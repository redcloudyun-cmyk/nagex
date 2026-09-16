// R11 — turns real DetectedChange[] (R10.1) into grounded ActionProposal
// drafts. Pure and synchronous: no network, no store writes, no AI call —
// every field comes only from data already fetched for the current Daily
// Brief generation (§3). Deliberately conservative: several DetectedChange
// kinds intentionally produce NO proposal (see inline notes) rather than a
// speculative or unsafe one — most importantly, a cancelled event never
// produces an auto-reschedule proposal (§12 test 3).
import type { DetectedChange } from './daily-brief-change-detection.js';
import type { GeneratedDailyBrief } from './daily-brief.pipeline.js';
import type { CreateActionProposalInput } from './action-proposal.store.js';

export type ActionProposalDraft = Omit<CreateActionProposalInput, 'tenantId' | 'principalId' | 'date'>;

const ACTION_REQUEST_SNIPPET_LIMIT = 160;

export function generateProposalsFromChanges(changes: DetectedChange[], current: GeneratedDailyBrief): ActionProposalDraft[] {
  const drafts: ActionProposalDraft[] = [];

  for (const change of changes) {
    switch (change.kind) {
      case 'CALENDAR_MOVED': {
        // Grounded, safe "reschedule" action: the event's new time is
        // already real (Google Calendar is the source of truth — nothing
        // is invented here), so the only genuinely groundable mutation is
        // re-confirming attendance at the NEW time via the calendar's
        // existing RSVP write path — never inventing a different new time.
        const event = current.schedule.find((e) => e.sourceId === change.sourceId);
        if (!event) break;
        drafts.push({
          sourceType: 'CALENDAR',
          sourceId: event.sourceId,
          proposalType: 'CALENDAR_RESCHEDULE',
          title: 'Confirm attendance at the new time',
          summary: `"${event.title}" moved to ${event.start}.`,
          rationale: change.body,
          proposedAction: { calendarId: 'primary', eventId: event.sourceId, responseStatus: 'accepted', summary: event.title },
          riskLevel: 'LOW',
          approvalRequired: true,
          executable: true,
        });
        break;
      }
      // CALENDAR_NEW / CALENDAR_CANCELLED: intentionally no proposal.
      // A cancellation has no grounded target time to reschedule TO —
      // proposing one would mean inventing a time, which §3 forbids
      // outright, and §12 test 3 requires this to never happen.
      case 'GMAIL_ACTION_REQUEST': {
        drafts.push({
          sourceType: 'GMAIL',
          sourceId: change.sourceId,
          proposalType: 'EMAIL_REPLY_DRAFT',
          title: 'Reply to this email',
          summary: change.body.slice(0, ACTION_REQUEST_SNIPPET_LIMIT),
          rationale: 'This email looks like it needs a response (deadline/action wording detected in the real snippet).',
          proposedAction: { threadId: change.sourceId },
          riskLevel: 'MEDIUM',
          approvalRequired: true,
          // No real recipient/subject is available from this codebase's
          // Gmail integration (search results are snippet+threadId only —
          // see daily-brief.pipeline.ts) — composing a real draft would
          // require inventing `to`/`subject`, which §3 forbids. Review-only.
          executable: false,
        });
        break;
      }
      // GMAIL_NEW (not action-worded): intentionally no proposal — too
      // generic to justify a reply-draft suggestion without fabricating
      // urgency that the real snippet doesn't actually convey.
      case 'APPROVAL_NEW': {
        drafts.push({
          sourceType: 'APPROVAL',
          sourceId: change.sourceId,
          proposalType: 'REVIEW_APPROVAL',
          title: 'Review a new pending approval',
          summary: change.body,
          rationale: 'A new action is waiting for your approval since the last brief.',
          proposedAction: { approvalId: change.sourceId },
          riskLevel: 'MEDIUM',
          approvalRequired: true,
          // Nothing for this proposal itself to execute — reviewing means
          // acting on the real ActionApprovalStore record directly via the
          // existing Approvals flow, not through this proposal.
          executable: false,
        });
        break;
      }
      case 'ACTION_ITEM_HIGH_NEW': {
        drafts.push({
          sourceType: 'ACTION_ITEM',
          sourceId: change.sourceId,
          proposalType: 'CREATE_TASK',
          title: change.body,
          summary: change.body,
          rationale: 'A new high-priority recommended action was identified in your Daily Brief.',
          proposedAction: { name: change.body },
          riskLevel: 'LOW',
          approvalRequired: true,
          executable: true,
        });
        break;
      }
      default:
        break;
    }
  }

  return drafts;
}

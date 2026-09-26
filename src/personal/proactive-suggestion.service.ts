// R23.3 — Canonical Proactive Suggestions.
//
// The ONE suggestion pipeline (PROACTIVE_SUGGESTION_PIPELINE_COUNT=1).
// This service never queries Calendar, Gmail, Tasks, Reminders, Captures,
// Vault, Memory, or Approvals directly — it only reads the already-built
// CurrentPersonalContext snapshot (R23.1) and RightNowIntelligence ranking
// (R23.2). Every surface that wants proactive suggestions — Personal Home,
// Morning Brief, Quick Wake, Meeting Prep, demo or real — calls this same
// service over the same snapshot; none of them may compute their own
// eligibility/priority/reason logic (UI_PRIORITY_LOGIC=0,
// UI_RELEVANCE_LOGIC=0, DEMO_PROACTIVE_PARALLEL_PATH=0).
//
// Eligibility (per R23.3 §6) requires all four, or the suggestion is
// simply not produced (FABRICATED_SUGGESTION=0, SUGGESTION_WITHOUT_SOURCE=0,
// SUGGESTION_WITHOUT_REASON=0):
//   1. a real trigger already present in the snapshot
//   2. a real source (sourceRefs always point at a real record)
//   3. an explicit, deterministic eligibility rule (never a model decision)
//   4. a known next action (action.type is always concrete)
//
// Every action is PREPARATION, never execution
// (SUGGESTION_CLICK_CONSEQUENTIAL_MUTATION=0, PROACTIVE_AUTO_MUTATION=0,
// PROACTIVE_AUTO_SEND=0, PROACTIVE_AUTO_APPROVAL=0) — action.requiresApproval
// only ever describes whether the already-existing canonical approval
// system gates the underlying action; this service never invents a second
// approval mechanism.
import type {
  ContextSourceType,
  CurrentPersonalContext,
} from './current-personal-context.service.js';
import type { RightNowIntelligence } from './right-now-intelligence.service.js';

export type ProactiveSuggestionKind =
  | 'MEETING_PREP'
  | 'REPLY_PREP'
  | 'REVIEW_APPROVAL'
  | 'REVIEW_INBOX'
  | 'REMINDER'
  | 'TASK_CONTINUE';

export interface ProactiveSuggestionSourceRef {
  type: ContextSourceType;
  id: string;
  // Real, already-known display text for this source (e.g. an email
  // snippet or a Vault item's own title) — never invented here, only ever
  // copied from the same context field the source itself carries. Omitted
  // when the snapshot has no natural short label for that source type.
  label?: string;
}

export interface ProactiveSuggestion {
  id: string;
  kind: ProactiveSuggestionKind;
  title: string;
  reason: string;
  sourceRefs: ProactiveSuggestionSourceRef[];
  // The real timestamp the suggestion is grounded in (an event's start
  // time, a reminder's scheduled time, an approval's createdAt) — never a
  // computed/opaque score, and omitted when no single timestamp is the
  // natural anchor for that kind.
  relevantAt?: string;
  action: {
    type: string;
    label: string;
    requiresApproval: boolean;
  };
  generatedAt: string;
}

function formatEventTimePhrase(startsAtMs: number, endsAtMs: number, nowMs: number): string {
  if (startsAtMs <= nowMs && nowMs <= endsAtMs) return 'is in progress now';
  const minutes = Math.max(0, Math.round((startsAtMs - nowMs) / 60000));
  return `starts in ${minutes} minute${minutes === 1 ? '' : 's'}`;
}

// A stable, deterministic id — never random — so the same real trigger
// always produces the same suggestion id across calls (needed for
// deterministic-ordering tests and for the UI to key on).
function suggestionId(kind: ProactiveSuggestionKind, primarySourceId: string): string {
  return `sug_${kind.toLowerCase()}_${primarySourceId}`;
}

export class ProactiveSuggestionService {
  // context: the R23.1 snapshot (for relatedContext access — sourceRefs a
  // suggestion needs but that RightNowIntelligence itself does not carry
  // forward). intel: the already-ranked R23.2 output (for which meeting is
  // primary/upcoming, and the already-grounded needsAttention list) — this
  // service never re-ranks anything itself, it only decides eligibility
  // and composes the suggestion text/action from what intel already found.
  public evaluate(context: CurrentPersonalContext, intel: Pick<RightNowIntelligence, 'needsAttention'>): ProactiveSuggestion[] {
    const generatedAt = context.generatedAt;
    const nowMs = new Date(generatedAt).getTime();
    const suggestions: ProactiveSuggestion[] = [];

    // ── A. Meeting Preparation — eligible only when a real event exists
    // AND at least one grounded supporting item (Gmail/Vault) was actually
    // found for it. No supporting context -> no suggestion (R23.3 §7A). ──
    const nextEvent = context.rightNow.nextEvent;
    const hasSupportingMaterial = context.relatedContext.emails.length > 0 || context.relatedContext.vaultItems.length > 0;
    if (nextEvent && hasSupportingMaterial) {
      const startsAtMs = new Date(nextEvent.startsAt).getTime();
      const endsAtMs = new Date(nextEvent.endsAt).getTime();
      const materialCount = context.relatedContext.emails.length + context.relatedContext.vaultItems.length;
      suggestions.push({
        id: suggestionId('MEETING_PREP', nextEvent.id),
        kind: 'MEETING_PREP',
        title: `Prepare for ${nextEvent.title}`,
        reason: `Your meeting ${formatEventTimePhrase(startsAtMs, endsAtMs, nowMs)} and I found ${materialCount} related item${materialCount === 1 ? '' : 's'}.`,
        sourceRefs: [
          { type: 'CALENDAR', id: nextEvent.id },
          ...context.relatedContext.emails.map((e) => ({ type: 'GMAIL' as const, id: e.threadId, label: e.snippet.slice(0, 60) })),
          ...context.relatedContext.vaultItems.map((v) => ({ type: 'VAULT' as const, id: v.id, label: v.title })),
        ],
        relevantAt: nextEvent.startsAt,
        action: { type: 'MEETING_PREP', label: 'Prepare', requiresApproval: false },
        generatedAt,
      });
    }

    // ── B. Reply Preparation — eligible when a real related email exists
    // (the same grounded Gmail thread Meeting Prep already found — never a
    // separate inbox query). The "person" is the thread's own real sender
    // text, never a hardcoded name. ──
    for (const email of context.relatedContext.emails) {
      suggestions.push({
        id: suggestionId('REPLY_PREP', email.threadId),
        kind: 'REPLY_PREP',
        title: 'Draft a reply',
        reason: `A related message says: "${email.snippet.slice(0, 80)}"`,
        sourceRefs: [{ type: 'GMAIL', id: email.threadId, label: email.snippet.slice(0, 60) }],
        action: { type: 'EMAIL_DRAFT', label: 'Draft reply', requiresApproval: false },
        generatedAt,
      });
    }

    // ── C. Approval Review — eligible for every real pending consequential
    // approval. Never claims execution happened. ──
    for (const approval of context.rightNow.pendingApprovals) {
      suggestions.push({
        id: suggestionId('REVIEW_APPROVAL', approval.id),
        kind: 'REVIEW_APPROVAL',
        title: 'Review before sending',
        reason: `NAgex prepared an action (${approval.toolId}) that needs your approval.`,
        sourceRefs: [{ type: 'APPROVAL', id: approval.id }],
        relevantAt: approval.createdAt,
        action: { type: 'REVIEW_APPROVAL', label: 'Review', requiresApproval: true },
        generatedAt,
      });
    }

    // ── D. Inbox Review — NEEDS_REVIEW and retryable FAILED only, sourced
    // from R23.1's own needsAttention (which already excludes ARCHIVED/
    // ACTIONED — never re-derived here). ──
    for (const attn of intel.needsAttention) {
      if (attn.kind !== 'NEEDS_REVIEW_CAPTURE') continue;
      suggestions.push({
        id: suggestionId('REVIEW_INBOX', attn.sourceRef.id),
        kind: 'REVIEW_INBOX',
        title: 'Review item',
        reason: attn.reason,
        sourceRefs: [{ type: 'INBOX', id: attn.sourceRef.id }],
        action: { type: 'REVIEW_CAPTURE', label: 'Review', requiresApproval: false },
        generatedAt,
      });
    }

    // ── E-1. Reminder follow-up — a real user-created reminder due today
    // is an explicit factual basis (R23.3 §7E); never inferred from text. ──
    for (const reminder of context.rightNow.reminders) {
      suggestions.push({
        id: suggestionId('REMINDER', reminder.id),
        kind: 'REMINDER',
        title: `Follow up: ${reminder.title}`,
        reason: `You set a reminder for this.`,
        sourceRefs: [{ type: 'REMINDER', id: reminder.id }],
        relevantAt: reminder.scheduledAt,
        action: { type: 'VIEW_REMINDER', label: 'View', requiresApproval: false },
        generatedAt,
      });
    }

    // ── E-2. Task continuation — R23.3 v1.1 §8.6: RUNNING (a real,
    // explicit factual basis for "continue what's in progress") and
    // WAITING/FAILED (sourced from R23.1's own already-grounded
    // BLOCKED_TASK needsAttention, never re-derived) both produce a real
    // continuation action. COMPLETED/CANCELLED/EXPIRED tasks never do.
    // FOLLOW_UP proper (an explicit due/follow-up state on a Task) is not
    // implemented in R23.3: TaskRecord carries no such field today, and
    // inferring one from a task's name/objective text would violate "do
    // not infer relationship obligations merely from text" — left for a
    // future schema addition. ──
    for (const task of context.rightNow.activeTasks) {
      suggestions.push({
        id: suggestionId('TASK_CONTINUE', task.id),
        kind: 'TASK_CONTINUE',
        title: `Continue: ${task.name}`,
        reason: 'This task is currently running.',
        sourceRefs: [{ type: 'TASK', id: task.id }],
        relevantAt: task.updatedAt,
        action: { type: 'VIEW_TASK', label: 'View', requiresApproval: false },
        generatedAt,
      });
    }
    for (const attn of intel.needsAttention) {
      if (attn.kind !== 'BLOCKED_TASK') continue;
      suggestions.push({
        id: suggestionId('TASK_CONTINUE', attn.sourceRef.id),
        kind: 'TASK_CONTINUE',
        title: `Continue: ${attn.title}`,
        reason: attn.reason,
        sourceRefs: [{ type: 'TASK', id: attn.sourceRef.id }],
        action: { type: 'VIEW_TASK', label: 'View', requiresApproval: false },
        generatedAt,
      });
    }

    return suggestions;
  }
}

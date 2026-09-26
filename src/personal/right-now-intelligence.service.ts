// R23.2 — Right Now / Today Intelligence.
//
// This is NOT a second aggregation layer. It never queries Calendar,
// Gmail, TaskStore, Memory, Vault, Inbox, Reminder, or Approval stores —
// every fact it surfaces is read from the single CurrentPersonalContext
// snapshot R23.1 already built (CURRENT_CONTEXT_PIPELINE_COUNT=1). This
// service's only job is deterministic, explainable prioritization of that
// snapshot (RIGHT_NOW_INTELLIGENCE_PIPELINE_COUNT=1) — no model call, no
// opaque score, no fabricated urgency (FABRICATED_URGENCY=0): every
// priority class and reason string is derived from a real timestamp or
// real status already present in the snapshot.
//
// Where R23.1's own needsAttention already computed the correct grounded
// reason for a kind of item (pending approval, blocked/failed task,
// needs-review or failed-retryable capture), this service reuses that
// text verbatim rather than re-deriving it (see PENDING_APPROVAL/
// BLOCKED_TASK/NEEDS_REVIEW_CAPTURE handling below) — "do not redo
// association logic" (R23.2 §9). Meetings, reminders, and RUNNING/ACTIVE
// tasks are not covered by R23.1's needsAttention (it is intentionally
// scoped to only the *next* event within its own attention window, and
// only WAITING/FAILED task states) — for those, this service computes its
// own deterministic priority class and reason directly from the
// snapshot's `today`/`rightNow` sections, which is exactly R23.2's job.
import type {
  ContextAttentionItem,
  ContextSourceTrace,
  ContextSourceType,
  CurrentPersonalContext,
  CurrentPersonalContextService,
} from './current-personal-context.service.js';
import { ProactiveSuggestionService, type ProactiveSuggestion } from './proactive-suggestion.service.js';

// Priority classes are explicit and ordered — never an opaque numeric
// score. 0 = P0 Immediate, 1 = P1 Soon, 2 = P2 Needs attention today.
// P3 (supporting context — related email/Vault/Memory) never competes in
// this pool at all: it can only ever back a suggestion, never outrank the
// event/task/reminder it supports (R23.2 §6).
export type PriorityClass = 'P0' | 'P1' | 'P2';
const PRIORITY_RANK: Record<PriorityClass, number> = { P0: 0, P1: 1, P2: 2 };

// The near-term window used for both meetings and reminders — a single,
// explicit, configurable constant rather than a per-kind magic number.
const NEAR_TERM_WINDOW_MS = 60 * 60 * 1000;

// Tie-break #3 (after priority class, then relevant timestamp): an
// explicit canonical source-type ordering, never accidental insertion
// order (R23.2 §18).
const CANONICAL_SOURCE_TYPE_ORDER: ContextSourceType[] = ['REMINDER', 'CALENDAR', 'TASK', 'APPROVAL', 'INBOX', 'GMAIL', 'VAULT', 'MEMORY'];

export type RightNowItemKind = 'MEETING' | 'REMINDER' | 'TASK' | 'APPROVAL' | 'INBOX';

export interface RightNowSourceRef {
  type: ContextSourceType;
  id: string;
}

export interface RightNowItem {
  kind: RightNowItemKind;
  title: string;
  reason: string;
  priorityClass: PriorityClass;
  timestamp: string;
  sourceRef: RightNowSourceRef;
}

export interface TodayItem {
  kind: RightNowItemKind;
  title: string;
  reason: string;
  timestamp: string;
  sourceRef: RightNowSourceRef;
}

// R23.3 — suggestions are no longer built inline here. They are the
// canonical ProactiveSuggestionService's own output type, reused verbatim
// (PROACTIVE_SUGGESTION_PIPELINE_COUNT=1) — re-exported for callers that
// only imported this module for the suggestion shape previously.
export type { ProactiveSuggestion as PreparedSuggestion, ProactiveSuggestionKind as SuggestionKind } from './proactive-suggestion.service.js';

export interface RightNowIntelligence {
  generatedAt: string;
  primary: RightNowItem | null;
  upcoming: RightNowItem[];
  today: TodayItem[];
  needsAttention: ContextAttentionItem[];
  suggestions: ProactiveSuggestion[];
  sourceTraces: ContextSourceTrace[];
}

export interface BuildRightNowParams {
  tenantId: string;
  userId: string;
  now?: Date;
  requestId?: string;
}

function pluralMinutes(n: number): string {
  return `${n} minute${n === 1 ? '' : 's'}`;
}

// A real time delta only — never a subjective word like "urgent"/
// "critical"/"important" (FABRICATED_URGENCY=0).
function formatEventReason(startsAtMs: number, endsAtMs: number, nowMs: number): string {
  if (startsAtMs <= nowMs && nowMs <= endsAtMs) return 'In progress now';
  const minutes = Math.round((startsAtMs - nowMs) / 60000);
  return `Starts in ${pluralMinutes(Math.max(minutes, 0))}`;
}

function classifyEvent(startsAtMs: number, endsAtMs: number, nowMs: number): PriorityClass {
  if (startsAtMs <= nowMs && nowMs <= endsAtMs) return 'P0';
  const deltaMs = startsAtMs - nowMs;
  if (deltaMs <= NEAR_TERM_WINDOW_MS) return 'P1';
  return 'P2';
}

function formatReminderReason(scheduledAtMs: number, nowMs: number): string {
  const deltaMs = scheduledAtMs - nowMs;
  const minutes = Math.abs(Math.round(deltaMs / 60000));
  if (deltaMs <= 0) return minutes === 0 ? 'Due now' : `Overdue by ${pluralMinutes(minutes)}`;
  return `Due in ${pluralMinutes(minutes)}`;
}

function classifyReminder(scheduledAtMs: number, nowMs: number): PriorityClass {
  const deltaMs = scheduledAtMs - nowMs;
  if (deltaMs <= 0) return 'P0';
  if (deltaMs <= NEAR_TERM_WINDOW_MS) return 'P1';
  return 'P2';
}

interface Candidate extends RightNowItem {}

function compareCandidates(a: Candidate, b: Candidate): number {
  const rankDiff = PRIORITY_RANK[a.priorityClass] - PRIORITY_RANK[b.priorityClass];
  if (rankDiff !== 0) return rankDiff;
  const ta = new Date(a.timestamp).getTime();
  const tb = new Date(b.timestamp).getTime();
  if (ta !== tb) return ta - tb;
  const oa = CANONICAL_SOURCE_TYPE_ORDER.indexOf(a.sourceRef.type);
  const ob = CANONICAL_SOURCE_TYPE_ORDER.indexOf(b.sourceRef.type);
  if (oa !== ob) return oa - ob;
  if (a.sourceRef.id < b.sourceRef.id) return -1;
  if (a.sourceRef.id > b.sourceRef.id) return 1;
  return 0;
}

export class RightNowIntelligenceService {
  // ProactiveSuggestionService is stateless (no store deps of its own), so
  // a default instance is always safe when the caller doesn't share one —
  // still the exact same class/logic either way (never a parallel path).
  private readonly proactiveSuggestionService: ProactiveSuggestionService;

  constructor(private readonly deps: { currentPersonalContextService?: CurrentPersonalContextService; proactiveSuggestionService?: ProactiveSuggestionService } = {}) {
    this.proactiveSuggestionService = deps.proactiveSuggestionService ?? new ProactiveSuggestionService();
  }

  // Fetches the canonical context snapshot exactly once, then delegates to
  // the pure evaluate() — never a second, parallel context build
  // (RIGHT_NOW_INTELLIGENCE_PIPELINE_COUNT=1).
  async buildRightNow(params: BuildRightNowParams): Promise<RightNowIntelligence> {
    if (!this.deps.currentPersonalContextService) {
      throw new Error('RightNowIntelligenceService.buildRightNow requires currentPersonalContextService');
    }
    const context = await this.deps.currentPersonalContextService.buildCurrentContext(params);
    return this.evaluate(context);
  }

  // Pure, deterministic: same context snapshot (same generatedAt) always
  // produces the same ordering (RIGHT_NOW_DETERMINISTIC=1). The snapshot's
  // own generatedAt is treated as "now" for all ranking so that a single
  // buildRightNow() call is internally consistent even if wall-clock time
  // advances while this function runs.
  evaluate(context: CurrentPersonalContext): RightNowIntelligence {
    const nowMs = new Date(context.generatedAt).getTime();
    const candidates: Candidate[] = [];

    // ── Meetings: every event today, not just the nearest one ──
    for (const e of context.today.events) {
      const startsAtMs = new Date(e.startsAt).getTime();
      const endsAtMs = new Date(e.endsAt).getTime();
      candidates.push({
        kind: 'MEETING',
        title: e.title,
        reason: formatEventReason(startsAtMs, endsAtMs, nowMs),
        priorityClass: classifyEvent(startsAtMs, endsAtMs, nowMs),
        timestamp: e.startsAt,
        sourceRef: { type: 'CALENDAR', id: e.id },
      });
    }

    // ── Reminders: R23.1's needsAttention has no REMINDER kind at all —
    // this is the only place reminder urgency is computed. ──
    for (const r of context.rightNow.reminders) {
      const scheduledAtMs = new Date(r.scheduledAt).getTime();
      candidates.push({
        kind: 'REMINDER',
        title: r.title,
        reason: formatReminderReason(scheduledAtMs, nowMs),
        priorityClass: classifyReminder(scheduledAtMs, nowMs),
        timestamp: r.scheduledAt,
        sourceRef: { type: 'REMINDER', id: r.id },
      });
    }

    // ── Tasks: RUNNING (P0) and plain ACTIVE (P2) are not represented in
    // needsAttention at all; WAITING/FAILED reuse needsAttention's own
    // already-grounded reason text (see the BLOCKED_TASK loop below) so
    // this loop only covers RUNNING/ACTIVE, never duplicating those. ──
    for (const t of context.rightNow.activeTasks) {
      candidates.push({
        kind: 'TASK',
        title: t.name,
        reason: 'Task is currently running',
        priorityClass: 'P0',
        timestamp: t.updatedAt,
        sourceRef: { type: 'TASK', id: t.id },
      });
    }
    for (const t of context.today.tasks) {
      if (t.status !== 'ACTIVE') continue;
      candidates.push({
        kind: 'TASK',
        title: t.name,
        reason: 'Active today',
        priorityClass: 'P2',
        timestamp: t.updatedAt,
        sourceRef: { type: 'TASK', id: t.id },
      });
    }

    // ── Approvals, blocked tasks, and inbox review/retry items: sourced
    // directly from R23.1's own needsAttention, whose reason text is
    // already correct and grounded — never re-derived (R23.2 §9). A small
    // lookup back into the same snapshot's today/rightNow sections
    // recovers each item's real timestamp for ordering, since
    // ContextAttentionItem itself carries no timestamp. ──
    const approvalById = new Map(context.rightNow.pendingApprovals.map((a) => [a.id, a]));
    const taskById = new Map(context.today.tasks.map((t) => [t.id, t]));
    const inboxById = new Map(context.today.importantInbox.map((i) => [i.id, i]));

    // R23.3 v1.1 §10 — "do not make every approval P0": the canonical
    // schema (ActionApprovalRecord/TaskRecord) has no field linking a
    // specific approval to the specific task/action it blocks, so this
    // never claims a precise causal link (the reason text below is
    // unchanged either way — only the ranking differs). The one real,
    // already-tracked correlated signal available is a WAITING task
    // (TaskStore's own documented semantics: a WAITING task is "waiting
    // for something", most commonly an in-flight approval — see
    // TaskStore.recordRunOutcome's own comment). When at least one task is
    // genuinely WAITING, every pending approval is treated as P0
    // ("plausibly blocking"); with no WAITING task at all, an approval is
    // always the routine P2 case. This is a disclosed heuristic over real
    // correlated facts, never a fabricated urgency label.
    const hasWaitingTask = context.today.tasks.some((t) => t.status === 'WAITING');

    for (const attn of context.needsAttention) {
      if (attn.kind === 'PENDING_APPROVAL') {
        const source = approvalById.get(attn.sourceRef.id);
        candidates.push({
          kind: 'APPROVAL',
          title: attn.title,
          reason: attn.reason,
          priorityClass: hasWaitingTask ? 'P0' : 'P2',
          // Falls back to the snapshot's own generatedAt only when the
          // approval record itself is unavailable in this snapshot (should
          // not happen in practice — pendingApprovals is the source
          // needsAttention was built from) — never a fabricated past/future
          // time, and never used to change the reason text itself.
          timestamp: source?.createdAt ?? context.generatedAt,
          sourceRef: { type: 'APPROVAL', id: attn.sourceRef.id },
        });
      } else if (attn.kind === 'BLOCKED_TASK') {
        const source = taskById.get(attn.sourceRef.id);
        candidates.push({
          kind: 'TASK',
          title: attn.title,
          reason: attn.reason,
          priorityClass: 'P2',
          timestamp: source?.updatedAt ?? context.generatedAt,
          sourceRef: { type: 'TASK', id: attn.sourceRef.id },
        });
      } else if (attn.kind === 'NEEDS_REVIEW_CAPTURE') {
        const source = inboxById.get(attn.sourceRef.id);
        candidates.push({
          kind: 'INBOX',
          title: attn.title,
          reason: attn.reason,
          priorityClass: 'P2',
          // A failed-retryable capture is not present in today.importantInbox
          // (that list is NEEDS_REVIEW only), so no createdAt is available
          // for it anywhere in the read-only snapshot — the fallback below
          // only affects tie-break ordering, never the (already-grounded)
          // reason text.
          timestamp: source?.createdAt ?? context.generatedAt,
          sourceRef: { type: 'INBOX', id: attn.sourceRef.id },
        });
      }
      // UPCOMING_MEETING is intentionally skipped here — meetings are
      // already fully covered (all of them, not just the next one) by the
      // events loop above, sourced from context.today.events directly.
    }

    const sorted = [...candidates].sort(compareCandidates);
    const primary = sorted.length > 0 ? sorted[0] : null;
    const upcoming = primary ? sorted.slice(1) : [];

    const today: TodayItem[] = candidates
      .map(({ kind, title, reason, timestamp, sourceRef }) => ({ kind, title, reason, timestamp, sourceRef }))
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
        || a.sourceRef.id.localeCompare(b.sourceRef.id));

    // ── Suggestions: delegated entirely to the canonical
    // ProactiveSuggestionService (R23.3) — this class never builds its own
    // suggestion list (PROACTIVE_SUGGESTION_PIPELINE_COUNT=1). needsAttention
    // is passed as-is; it was already computed above in this same call, no
    // second context fetch. ──
    const suggestions = this.proactiveSuggestionService.evaluate(context, { needsAttention: context.needsAttention });

    return {
      generatedAt: context.generatedAt,
      primary,
      upcoming,
      today,
      needsAttention: context.needsAttention,
      suggestions,
      sourceTraces: context.sourceTraces,
    };
  }
}

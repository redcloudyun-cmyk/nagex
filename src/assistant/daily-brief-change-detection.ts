// R10.1 — Daily Brief change detection. Compares the metadata already
// fetched for the CURRENT generation against the PREVIOUS persisted brief
// for the same day (or nothing, on the day's first generation) and reports
// only genuinely meaningful differences — never a full Calendar/Gmail
// re-fetch, never a raw message-body diff, never a notification for a
// cosmetic/irrelevant metadata change. Pure and synchronous: no network,
// no store writes, so it is trivially unit-testable and trivially reused by
// both the manual HTTP path and the scheduled DailyBriefTaskRunner path
// (never two separate change-detection implementations).
import type { DailyBriefRecord } from '../governance/daily-brief.store.js';
import type { GeneratedDailyBrief } from './daily-brief.pipeline.js';
import type { NotificationEngine } from '../notifications/notification.engine.js';

export type DetectedChangeKind =
  | 'CALENDAR_NEW'
  | 'CALENDAR_MOVED'
  | 'CALENDAR_CANCELLED'
  | 'GMAIL_NEW'
  | 'GMAIL_ACTION_REQUEST'
  | 'APPROVAL_NEW'
  | 'ACTION_ITEM_HIGH_NEW';

export interface DetectedChange {
  kind: DetectedChangeKind;
  title: string;
  body: string;
  // Stable per logical change (same event/thread/approval + same new
  // value) — the caller turns this into a dedupeKey so re-detecting the
  // identical change (e.g. two near-simultaneous generations comparing
  // against the same stale "previous") never produces two notifications.
  dedupeSuffix: string;
}

// A grounded, keyword-based heuristic over the real snippet text already
// fetched for the brief — never a second AI call just to classify urgency.
const ACTION_REQUEST_KEYWORDS = [
  'deadline', 'due by', 'due date', 'asap', 'urgent', 'action required',
  'please respond', 'respond by', 'review needed', 'needs your approval',
  'approve', 'time-sensitive', 'expires',
];

function looksLikeActionRequest(snippet: string): boolean {
  const lower = snippet.toLowerCase();
  return ACTION_REQUEST_KEYWORDS.some((kw) => lower.includes(kw));
}

export interface PendingApprovalForDiff {
  approvalId: string;
  toolId: string;
  createdAt: string;
}

export function detectMeaningfulChanges(input: {
  previous: DailyBriefRecord | null;
  current: GeneratedDailyBrief;
  // Approvals created strictly after `previous.generatedAt` — the caller
  // computes this (it already has real, local access to the Approval
  // store; no extra fetch is introduced here), so this module stays pure.
  newApprovalsSincePrevious?: PendingApprovalForDiff[];
}): DetectedChange[] {
  const { previous, current, newApprovalsSincePrevious } = input;

  // Day's first generation: nothing to compare against, so nothing is
  // "new" relative to a baseline that doesn't exist — reporting every item
  // as a change here would flood the user the moment automation is first
  // turned on. This is the intended, documented behavior, not a gap.
  if (!previous) return [];

  const changes: DetectedChange[] = [];
  const dateKey = current.date;

  // ── Calendar ────────────────────────────────────────────────────────
  if (previous.calendarStatus === 'CONNECTED' && current.calendarStatus === 'CONNECTED') {
    const prevById = new Map(previous.schedule.map((e) => [e.sourceId, e]));
    const currById = new Map(current.schedule.map((e) => [e.sourceId, e]));

    for (const [id, ev] of currById) {
      const prevEv = prevById.get(id);
      if (!prevEv) {
        changes.push({
          kind: 'CALENDAR_NEW',
          title: 'New event on your calendar',
          body: `"${ev.title}" was added to today's schedule.`,
          dedupeSuffix: `calendar:new:${id}:${ev.start}`,
        });
      } else if (prevEv.start !== ev.start || prevEv.end !== ev.end) {
        changes.push({
          kind: 'CALENDAR_MOVED',
          title: 'A meeting time changed',
          body: `"${ev.title}" moved to ${ev.start}.`,
          dedupeSuffix: `calendar:moved:${id}:${ev.start}:${ev.end}`,
        });
      }
    }
    for (const [id, ev] of prevById) {
      const stillThere = currById.has(id);
      const explicitlyCancelled = ev.status === 'cancelled';
      if (!stillThere || explicitlyCancelled) {
        changes.push({
          kind: 'CALENDAR_CANCELLED',
          title: 'An event was cancelled',
          body: `"${ev.title}" is no longer on today's schedule.`,
          dedupeSuffix: `calendar:cancelled:${id}`,
        });
      }
    }
  }

  // ── Gmail ───────────────────────────────────────────────────────────
  if (previous.gmailStatus === 'CONNECTED' && current.gmailStatus === 'CONNECTED') {
    const prevIds = new Set(previous.emails.map((e) => e.sourceId));
    for (const email of current.emails) {
      if (prevIds.has(email.sourceId)) continue;
      if (looksLikeActionRequest(email.snippet)) {
        changes.push({
          kind: 'GMAIL_ACTION_REQUEST',
          title: 'Email needs your attention',
          body: email.snippet.slice(0, 160),
          dedupeSuffix: `gmail:action:${email.sourceId}`,
        });
      } else {
        changes.push({
          kind: 'GMAIL_NEW',
          title: 'New important email',
          body: email.snippet.slice(0, 160),
          dedupeSuffix: `gmail:new:${email.sourceId}`,
        });
      }
    }
  }

  // ── Newly proposed approvals since the last brief ──────────────────
  for (const approval of newApprovalsSincePrevious ?? []) {
    changes.push({
      kind: 'APPROVAL_NEW',
      title: 'New approval needed',
      body: `A new action (${approval.toolId}) is waiting for your approval.`,
      dedupeSuffix: `approval:new:${approval.approvalId}`,
    });
  }

  // ── New high-priority recommended action ────────────────────────────
  const prevHighTitles = new Set(previous.actionItems.filter((a) => a.priority === 'HIGH').map((a) => a.title));
  for (const item of current.actionItems) {
    if (item.priority === 'HIGH' && !prevHighTitles.has(item.title)) {
      changes.push({
        kind: 'ACTION_ITEM_HIGH_NEW',
        title: 'New high-priority action',
        body: item.title,
        dedupeSuffix: `action_item:high:${dateKey}:${item.title}`,
      });
    }
  }

  return changes;
}

// Shared by both real entry points (manual HTTP refresh and the scheduled
// DailyBriefTaskRunner) so there is exactly one place that turns a
// DetectedChange into a real IMPORTANT_CHANGE notification — never two
// separate notify implementations. dedupeKey is scoped by tenant/principal/
// date/change-signature, so NotificationEngine's own existing
// dedupe-by-(tenantId,principalId,dedupeKey) is what actually prevents a
// duplicate notification for the same logical change (§2 "duplicate change
// → deduped" is enforced here, not reimplemented).
export async function dispatchDetectedChanges(
  notificationEngine: NotificationEngine | undefined,
  tenantId: string,
  principalId: string,
  date: string,
  changes: DetectedChange[],
  requestId: string,
): Promise<void> {
  if (!notificationEngine || changes.length === 0) return;
  for (const change of changes) {
    try {
      await notificationEngine.dispatch({
        tenantId,
        principalId,
        type: 'IMPORTANT_CHANGE',
        title: change.title,
        body: change.body,
        metadata: { kind: change.kind, date },
        requestId,
        dedupeKey: `important_change:${tenantId}:${principalId}:${date}:${change.dedupeSuffix}`,
      });
    } catch (err) {
      console.error(JSON.stringify({ event: 'nagex_important_change_notification_failed', tenantId, principalId, kind: change.kind, error: err instanceof Error ? err.message : String(err) }));
    }
  }
}

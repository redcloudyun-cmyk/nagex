// R23.1 — Personal Context Aggregation.
//
// The single canonical "what is happening around the user now" aggregator.
// Read/aggregate only — never mutates any source system, never calls a
// model/provider, never persists a parallel store. Every surfaced item
// carries a sourceTrace back to the real canonical record it came from; an
// item that cannot be sourced never appears (no fabricated context).
//
// This is the ONE aggregation pipeline for Calendar/Task/Approval/Reminder/
// Inbox/Vault/Memory context (CONTEXT_AGGREGATION_PIPELINE_COUNT=1) —
// PersonalHomeService (R22.8) consumes this service for those sources
// rather than re-querying them itself. Note this is a different, broader
// service than the existing `PersonalContextService` (src/context/
// personal-context.service.ts), which is narrowly the R22.3 memory-
// relevance gate — this service *uses* that one for its own memory section
// rather than duplicating its (already-hardened) relevance logic.
import type { UpcomingCalendarEvent } from '../modules/calendar/index.js';
import type { TaskStore, TaskRecord, TaskStatus } from '../tasks/task.store.js';
import type { PersonalReminderStore, PersonalReminder } from './personal-reminder.store.js';
import type { ActionApprovalStore, ActionApprovalRecord } from '../governance/action-approval.store.js';
import type { CaptureStore } from '../workspace/capture.store.js';
import type { CaptureItem } from '../workspace/workspace.types.js';
import type { VaultStore } from '../workspace/vault.store.js';
import type { VaultItem } from '../workspace/vault.types.js';
import type { MemoryRecord } from '../context/memory.engine.js';
import type { PersonalContextService } from '../context/personal-context.service.js';

export type ContextSourceType = 'CALENDAR' | 'GMAIL' | 'TASK' | 'REMINDER' | 'APPROVAL' | 'INBOX' | 'VAULT' | 'MEMORY';

// R23.2D — narrow structural interfaces instead of the concrete
// GoogleCalendarService/GmailService classes. This service's own logic
// never changes based on which implementation is behind these — only the
// composition root decides, per tenant, whether a real provider or the
// canonical demo seed source answers a call (DEMO_PARALLEL_INTELLIGENCE_
// PIPELINE=0: one aggregation pipeline, one set of ranking rules, for both).
// The real GoogleCalendarService/GmailService classes already satisfy
// these structurally — no cast needed at any real call site.
export interface CalendarEventsSource {
  listUpcomingEvents(input: {
    tenantId: string;
    calendarId?: string;
    timeMin: string;
    timeMax: string;
    maxResults?: number;
    requestId: string;
  }): Promise<UpcomingCalendarEvent[]>;
}

export interface GmailSearchSource {
  search(input: { tenantId: string; query: string; requestId: string }): Promise<{
    threads: Array<{ threadId: string; snippet: string; historyId: string | null }>;
  }>;
}

export interface ContextSourceTrace {
  type: ContextSourceType;
  sourceId: string;
  title: string;
  observedAt: string;
}

export interface ContextEvent {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  attendees: string[];
  sourceTrace: ContextSourceTrace;
}

export interface ContextTask {
  id: string;
  name: string;
  objective: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  sourceTrace: ContextSourceTrace;
}

export interface ContextReminder {
  id: string;
  title: string;
  scheduledAt: string;
  sourceTrace: ContextSourceTrace;
}

export interface ContextApproval {
  id: string;
  toolId: string;
  createdAt: string;
  sourceTrace: ContextSourceTrace;
}

export interface ContextInboxItem {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  sourceTrace: ContextSourceTrace;
}

export interface ContextEmail {
  threadId: string;
  snippet: string;
  relatedToEventId: string;
  sourceTrace: ContextSourceTrace;
}

export interface ContextVaultItem {
  id: string;
  title: string;
  type: string;
  relatedToEventId: string;
  sourceTrace: ContextSourceTrace;
}

export interface ContextMemory {
  id: string;
  subject: string;
  predicate: string;
  value: unknown;
  sourceTrace: ContextSourceTrace;
}

export interface ContextAttentionItem {
  kind: 'UPCOMING_MEETING' | 'PENDING_APPROVAL' | 'BLOCKED_TASK' | 'NEEDS_REVIEW_CAPTURE';
  title: string;
  reason: string;
  sourceRef: { type: ContextSourceType; id: string };
}

// 'UNAVAILABLE' = source not configured/connected (no dependency wired —
// e.g. the user hasn't connected Google, or this deployment omits a store).
// 'ERROR' = source is configured but the live call itself failed. Both are
// degraded-but-truthful states distinct from 'OK'; callers that only need a
// binary connected/not-connected view (e.g. PersonalHomeService) may still
// collapse ERROR into UNAVAILABLE, but the two are never conflated here.
export type SourceAvailability = 'OK' | 'UNAVAILABLE' | 'ERROR';

export interface ContextSourceStatus {
  calendar: SourceAvailability;
  gmail: SourceAvailability;
  tasks: SourceAvailability;
  reminders: SourceAvailability;
  approvals: SourceAvailability;
  inbox: SourceAvailability;
  vault: SourceAvailability;
  memory: SourceAvailability;
}

export interface CurrentPersonalContext {
  generatedAt: string;
  rightNow: {
    nextEvent: ContextEvent | null;
    activeTasks: ContextTask[];
    reminders: ContextReminder[];
    pendingApprovals: ContextApproval[];
  };
  today: {
    events: ContextEvent[];
    tasks: ContextTask[];
    importantInbox: ContextInboxItem[];
  };
  relatedContext: {
    emails: ContextEmail[];
    vaultItems: ContextVaultItem[];
    memories: ContextMemory[];
  };
  needsAttention: ContextAttentionItem[];
  sourceTraces: ContextSourceTrace[];
  sourceStatus: ContextSourceStatus;
}

export interface BuildCurrentContextParams {
  tenantId: string;
  userId: string;
  now?: Date;
  requestId?: string;
}

// Only these task states are ever "current" for R23.1's purposes. COMPLETED/
// CANCELLED/EXPIRED/DRAFT/PAUSED are deliberately excluded from today.tasks
// — a task in one of those states is not "currently relevant" by the
// canonical TaskStore lifecycle, and this list is never reinterpreted.
// FAILED is included because a failed task is exactly the kind of thing
// that needs the user's attention today (see needsAttention below).
const TODAY_RELEVANT_TASK_STATES = new Set<TaskStatus>(['ACTIVE', 'RUNNING', 'WAITING', 'FAILED']);

// Minutes-until-start threshold for an "UPCOMING_MEETING" needs-attention
// entry — an explicit, grounded fact (a real time delta), never a
// subjective/AI urgency label.
const UPCOMING_MEETING_ATTENTION_WINDOW_MS = 60 * 60 * 1000;

export class CurrentPersonalContextService {
  constructor(
    private readonly deps: {
      googleCalendarService?: CalendarEventsSource;
      gmailService?: GmailSearchSource;
      taskStore?: TaskStore;
      personalReminderStore?: PersonalReminderStore;
      actionApprovals?: ActionApprovalStore;
      captureStore?: CaptureStore;
      vaultStore?: VaultStore;
      personalContextService?: PersonalContextService;
    }
  ) {}

  public async buildCurrentContext(params: BuildCurrentContextParams): Promise<CurrentPersonalContext> {
    const { tenantId, userId } = params;
    const now = params.now ?? new Date();
    const requestId = params.requestId ?? `req_ctx_${Date.now()}`;
    const sourceTraces: ContextSourceTrace[] = [];
    const sourceStatus: ContextSourceStatus = {
      calendar: 'OK', gmail: 'OK', tasks: 'OK', reminders: 'OK', approvals: 'OK', inbox: 'OK', vault: 'OK', memory: 'OK',
    };

    // ── Calendar: today's events, ongoing/nearest-upcoming first, past excluded ──
    let todaysEvents: ContextEvent[] = [];
    if (this.deps.googleCalendarService) {
      try {
        const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0).toISOString();
        const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).toISOString();
        const events = await this.deps.googleCalendarService.listUpcomingEvents({
          tenantId, timeMin: dayStart, timeMax: dayEnd, maxResults: 20, requestId,
        });
        todaysEvents = (events || [])
          // A past event (already ended) must never appear as current/upcoming.
          .filter((e) => new Date(e.end).getTime() >= now.getTime())
          .map((e) => ({
            id: e.id,
            title: e.title,
            startsAt: e.start,
            endsAt: e.end,
            attendees: e.attendees || [],
            sourceTrace: { type: 'CALENDAR' as const, sourceId: e.id, title: e.title, observedAt: now.toISOString() },
          }))
          .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
      } catch {
        sourceStatus.calendar = 'ERROR';
        todaysEvents = [];
      }
    } else {
      sourceStatus.calendar = 'UNAVAILABLE';
    }
    for (const e of todaysEvents) sourceTraces.push(e.sourceTrace);
    // Prefer an ongoing event (already started, not yet ended) over the
    // nearest upcoming one; both were already filtered to "not yet ended".
    const nextEvent = todaysEvents.length > 0 ? todaysEvents[0] : null;

    // ── Tasks: explicit inclusion only, canonical TaskStore lifecycle unchanged ──
    let allTasks: TaskRecord[] = [];
    if (this.deps.taskStore) {
      try {
        allTasks = this.deps.taskStore.list(tenantId, userId);
      } catch {
        sourceStatus.tasks = 'ERROR';
        allTasks = [];
      }
    } else {
      sourceStatus.tasks = 'UNAVAILABLE';
    }
    const todaysTasks: ContextTask[] = allTasks
      .filter((t) => TODAY_RELEVANT_TASK_STATES.has(t.status))
      .map((t) => ({
        id: t.taskId,
        name: t.name,
        objective: t.objective,
        status: t.status,
        createdAt: t.createdAt,
        updatedAt: t.lastRunAt || t.createdAt,
        sourceTrace: { type: 'TASK' as const, sourceId: t.taskId, title: t.name, observedAt: now.toISOString() },
      }));
    for (const t of todaysTasks) sourceTraces.push(t.sourceTrace);
    // "Active right now" = genuinely executing, not merely scheduled/waiting.
    const activeTasks = todaysTasks.filter((t) => t.status === 'RUNNING');

    // ── Reminders: active/non-expired, relevant to today only ──
    let activeReminders: PersonalReminder[] = [];
    if (this.deps.personalReminderStore) {
      try {
        activeReminders = this.deps.personalReminderStore.listReminders(tenantId, userId, 'ACTIVE');
      } catch {
        sourceStatus.reminders = 'ERROR';
        activeReminders = [];
      }
    } else {
      sourceStatus.reminders = 'UNAVAILABLE';
    }
    const dayEndMs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime();
    const todaysReminders: ContextReminder[] = activeReminders
      .filter((r) => new Date(r.scheduled_at).getTime() <= dayEndMs)
      .map((r) => ({
        id: r.reminder_id,
        title: r.title,
        scheduledAt: r.scheduled_at,
        sourceTrace: { type: 'REMINDER' as const, sourceId: r.reminder_id, title: r.title, observedAt: now.toISOString() },
      }))
      .sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime());
    for (const r of todaysReminders) sourceTraces.push(r.sourceTrace);

    // ── Approvals: only real pending approvals, never fabricated urgency ──
    let pendingApprovalRecords: ActionApprovalRecord[] = [];
    if (this.deps.actionApprovals) {
      try {
        pendingApprovalRecords = this.deps.actionApprovals.listPending(tenantId, userId);
      } catch {
        sourceStatus.approvals = 'ERROR';
        pendingApprovalRecords = [];
      }
    } else {
      sourceStatus.approvals = 'UNAVAILABLE';
    }
    const pendingApprovals: ContextApproval[] = pendingApprovalRecords.map((a) => ({
      id: a.approvalId,
      toolId: a.toolId,
      createdAt: a.createdAt,
      sourceTrace: { type: 'APPROVAL' as const, sourceId: a.approvalId, title: a.toolId, observedAt: now.toISOString() },
    }));
    for (const a of pendingApprovals) sourceTraces.push(a.sourceTrace);

    // ── Inbox: canonical Capture pipeline, only genuinely attention-worthy status ──
    let allCaptures: CaptureItem[] = [];
    if (this.deps.captureStore) {
      try {
        allCaptures = this.deps.captureStore.listCaptures(tenantId, userId);
      } catch {
        sourceStatus.inbox = 'ERROR';
        allCaptures = [];
      }
    } else {
      sourceStatus.inbox = 'UNAVAILABLE';
    }
    // Never resurrect ARCHIVED/ACTIONED content as "needs attention" —
    // NEEDS_REVIEW is the canonical genuinely-requires-review status.
    const importantInbox: ContextInboxItem[] = allCaptures
      .filter((c) => c.status === 'NEEDS_REVIEW')
      .map((c) => ({
        id: c.captureId,
        title: c.metadata?.extractedTitle || c.content || 'Capture needs review',
        status: c.status,
        createdAt: c.createdAt,
        sourceTrace: { type: 'INBOX' as const, sourceId: c.captureId, title: c.metadata?.extractedTitle || c.content || 'Capture needs review', observedAt: now.toISOString() },
      }));
    for (const i of importantInbox) sourceTraces.push(i.sourceTrace);
    // Failed, retryable captures also need attention, distinct from NEEDS_REVIEW.
    const failedRetryableCaptures = allCaptures.filter((c) => c.status === 'FAILED' && c.metadata?.retryable !== false);

    // ── Related context: deterministic grounding off the nearest event only,
    // mirroring the established, already-tested PersonalAssistantEngine
    // meeting-prep pattern (attendee email -> Gmail thread, attendee/title
    // name hint -> Vault item), never broad semantic guessing. ──
    const emails: ContextEmail[] = [];
    const vaultItems: ContextVaultItem[] = [];

    if (nextEvent) {
      if (this.deps.gmailService && nextEvent.attendees.length > 0) {
        try {
          const attendeeQuery = nextEvent.attendees.map((a) => `from:${a} OR to:${a}`).join(' OR ');
          const result = await this.deps.gmailService.search({ tenantId, query: attendeeQuery, requestId });
          for (const thread of result.threads.slice(0, 5)) {
            emails.push({
              threadId: thread.threadId,
              snippet: thread.snippet,
              relatedToEventId: nextEvent.id,
              sourceTrace: { type: 'GMAIL' as const, sourceId: thread.threadId, title: thread.snippet.slice(0, 80), observedAt: now.toISOString() },
            });
          }
        } catch {
          sourceStatus.gmail = 'ERROR';
        }
      } else if (!this.deps.gmailService) {
        sourceStatus.gmail = 'UNAVAILABLE';
      }
      for (const e of emails) sourceTraces.push(e.sourceTrace);

      if (this.deps.vaultStore) {
        try {
          const nameHint = nextEvent.attendees[0]?.split('@')[0] || nextEvent.title;
          const results: VaultItem[] = this.deps.vaultStore.searchItems(tenantId, userId, nameHint);
          for (const item of results.slice(0, 5)) {
            vaultItems.push({
              id: item.vaultItemId,
              title: item.title,
              type: item.type,
              relatedToEventId: nextEvent.id,
              sourceTrace: { type: 'VAULT' as const, sourceId: item.vaultItemId, title: item.title, observedAt: now.toISOString() },
            });
          }
        } catch {
          sourceStatus.vault = 'ERROR';
        }
      } else {
        sourceStatus.vault = 'UNAVAILABLE';
      }
      for (const v of vaultItems) sourceTraces.push(v.sourceTrace);
    } else {
      if (!this.deps.gmailService) sourceStatus.gmail = 'UNAVAILABLE';
      if (!this.deps.vaultStore) sourceStatus.vault = 'UNAVAILABLE';
    }

    // ── Memory: routed entirely through the existing, hardened R22.3
    // relevance gate (ACTIVE only, tenant/user scoped, deleted/CONFLICTED
    // excluded, S2-unconfirmed excluded, pin alone cannot create
    // relevance) — never a second, parallel relevance implementation.
    // The deterministic "prompt" is built purely from real today-context
    // titles, satisfying "event title/attendee <-> Memory" grounding
    // without any model call.
    const memories: ContextMemory[] = [];
    if (this.deps.personalContextService) {
      try {
        const contextPromptParts = [
          ...todaysEvents.map((e) => e.title),
          ...nextEvent ? nextEvent.attendees : [],
          ...todaysTasks.map((t) => t.name),
          ...todaysReminders.map((r) => r.title),
        ].filter(Boolean);
        if (contextPromptParts.length > 0) {
          const relevant: MemoryRecord[] = this.deps.personalContextService.getRelevantMemories(
            tenantId, userId, contextPromptParts.join(' '), undefined, 5,
          );
          for (const mem of relevant) {
            memories.push({
              id: mem.id,
              subject: mem.content.subject,
              predicate: mem.content.predicate,
              value: mem.content.value,
              sourceTrace: { type: 'MEMORY' as const, sourceId: mem.id, title: mem.content.subject, observedAt: now.toISOString() },
            });
          }
        }
      } catch {
        sourceStatus.memory = 'ERROR';
      }
    } else {
      sourceStatus.memory = 'UNAVAILABLE';
    }
    for (const m of memories) sourceTraces.push(m.sourceTrace);

    // ── Needs Attention: normalized, fact-grounded only, no AI urgency score ──
    const needsAttention: ContextAttentionItem[] = [];
    if (nextEvent) {
      const minutesUntil = Math.round((new Date(nextEvent.startsAt).getTime() - now.getTime()) / 60000);
      const hasStarted = new Date(nextEvent.startsAt).getTime() <= now.getTime();
      if (hasStarted || minutesUntil <= UPCOMING_MEETING_ATTENTION_WINDOW_MS / 60000) {
        needsAttention.push({
          kind: 'UPCOMING_MEETING',
          title: nextEvent.title,
          reason: hasStarted ? 'In progress now' : `Starts in ${minutesUntil} minute${minutesUntil === 1 ? '' : 's'}`,
          sourceRef: { type: 'CALENDAR', id: nextEvent.id },
        });
      }
    }
    for (const a of pendingApprovals) {
      needsAttention.push({
        kind: 'PENDING_APPROVAL',
        title: a.toolId,
        reason: 'Requires your approval',
        sourceRef: { type: 'APPROVAL', id: a.id },
      });
    }
    for (const t of todaysTasks) {
      if (t.status === 'WAITING' || t.status === 'FAILED') {
        needsAttention.push({
          kind: 'BLOCKED_TASK',
          title: t.name,
          reason: t.status === 'WAITING' ? 'Waiting on your input' : 'Task failed',
          sourceRef: { type: 'TASK', id: t.id },
        });
      }
    }
    for (const c of failedRetryableCaptures) {
      needsAttention.push({
        kind: 'NEEDS_REVIEW_CAPTURE',
        title: c.metadata?.extractedTitle || c.content || 'Capture failed',
        reason: 'Capture failed and can be retried',
        sourceRef: { type: 'INBOX', id: c.captureId },
      });
    }
    for (const i of importantInbox) {
      needsAttention.push({
        kind: 'NEEDS_REVIEW_CAPTURE',
        title: i.title,
        reason: 'Needs your review',
        sourceRef: { type: 'INBOX', id: i.id },
      });
    }

    return {
      generatedAt: now.toISOString(),
      rightNow: {
        nextEvent,
        activeTasks,
        reminders: todaysReminders,
        pendingApprovals,
      },
      today: {
        events: todaysEvents,
        tasks: todaysTasks,
        importantInbox,
      },
      relatedContext: {
        emails,
        vaultItems,
        memories,
      },
      needsAttention,
      sourceTraces,
      sourceStatus,
    };
  }
}

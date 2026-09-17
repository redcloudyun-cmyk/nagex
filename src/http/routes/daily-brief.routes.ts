// R10.2-D Increment 5 — Daily Brief / Proactive Assistant automation
// routes, extracted verbatim from server_web.ts's handleAsyncApiRequest.
// Generation itself lives entirely in
// src/assistant/daily-brief.pipeline.ts's generateDailyBriefOnce(),
// shared with the scheduled automation path (DailyBriefTaskRunner) — this
// module never reimplements generation, change detection, or scheduling;
// it only translates HTTP <-> those existing services. The Proactive
// Assistant schedule is modeled as a real Task (RECURRING + SCHEDULE
// trigger, automationKind:'DAILY_BRIEF'), reusing TaskStore/TaskScheduler
// wholesale — no second persistence layer, no parallel scheduler.
import crypto from 'node:crypto';
import { NagexError } from '../../common/errors.js';
import { DEFAULT_GOOGLE_TENANT_ID } from '../../integrations/google/token.store.js';
import type { AiService } from '../../model-gateway/ai-service.js';
import type { GoogleCalendarService } from '../../modules/calendar/index.js';
import type { GmailService } from '../../modules/gmail/index.js';
import { dailyBriefDateKey, type DailyBriefRecord, type DailyBriefStore } from '../../governance/daily-brief.store.js';
import { generateDailyBriefOnce } from '../../assistant/daily-brief.pipeline.js';
import { detectMeaningfulChanges, dispatchDetectedChanges } from '../../assistant/daily-brief-change-detection.js';
import { generateProposalsFromChanges } from '../../assistant/action-proposal-generator.js';
import type { ActionProposalStore } from '../../assistant/action-proposal.store.js';
import type { PersistentActionApprovalStore } from '../../governance/action-approval.store.js';
import type { ActivityStore } from '../../governance/activity.store.js';
import type { NotificationEngine } from '../../notifications/notification.engine.js';
import { TaskStore, type TaskTrigger, type TaskRecord } from '../../tasks/task.store.js';
import { computeNextRunAt } from '../../tasks/task.scheduler.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';

function getHeaderValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

// R9 — freshness window (§6): a persisted brief older than this is
// reported with freshness:'STALE' on read, never silently treated as
// current.
const DAILY_BRIEF_STALE_MS = 60 * 60 * 1000;

function computeBriefFreshness(generatedAt: string): 'FRESH' | 'STALE' {
  return Date.now() - Date.parse(generatedAt) > DAILY_BRIEF_STALE_MS ? 'STALE' : 'FRESH';
}

function safeListPendingApprovals(actionApprovals: PersistentActionApprovalStore, tenantId: string, principalId: string, requestId: string) {
  try {
    return actionApprovals.listPending(tenantId, principalId, requestId);
  } catch {
    return [] as ReturnType<typeof actionApprovals.listPending>;
  }
}

// §8 item traceability + freshness + lastRefreshAttempt truthfulness — the
// single real response shape both the GET-serves-persisted path and the
// explicit-refresh path return, so a client never has to special-case one
// vs the other.
function buildBriefResponse(
  record: Omit<DailyBriefRecord, 'briefId'>,
  approvals: ReturnType<PersistentActionApprovalStore['listPending']>,
  wasExplicitRefresh: boolean,
  lastRefreshAttempt: { attemptedAt: string; status: string; requestId: string } | null,
  proposals: ReturnType<ActionProposalStore['listForDate']> = [],
  changeCount = 0,
) {
  return {
    date: record.date,
    generatedAt: record.generatedAt,
    // R10.1 §3 — which real entry point produced THIS specific record
    // (SCHEDULED vs MANUAL); was previously computed and stored but never
    // actually surfaced on this response, so Home's proactive-state line
    // could never truthfully detect a scheduled generation. Fixed here.
    source: record.source ?? null,
    freshness: computeBriefFreshness(record.generatedAt),
    wasExplicitRefresh,
    lastRefreshAttempt,
    requestId: record.requestId,
    status: record.status,
    calendarStatus: record.calendarStatus,
    gmailStatus: record.gmailStatus,
    schedule: record.schedule,
    emails: record.emails,
    // §8/§5 — real, live-refetched pending approvals every single read
    // (never persisted alongside the rest of the brief, so a consumed/
    // rejected approval is reflected immediately on the very next read —
    // §8's "Consumed는 Brief에도 즉시 반영" — without needing a refresh).
    approvals: approvals.map((a) => ({ sourceType: 'APPROVAL' as const, sourceId: a.approvalId, toolId: a.toolId, status: a.status, createdAt: a.createdAt, capability: a.toolId })),
    summary: record.summary,
    actionItems: record.actionItems,
    provider: record.provider,
    model: record.model,
    latencyMs: record.latencyMs,
    fallbackOccurred: record.fallbackOccurred,
    // R11 §7/§8 — real counts only, never inferred: sourced directly from
    // persisted ActionProposalStore records for this exact date, never a
    // separate notification per proposal.
    proposalCount: proposals.length,
    proposalIds: proposals.map((p: { id: string }) => p.id),
    // R11 §7 — real count of persisted IMPORTANT_CHANGE notifications for
    // this exact brief date, never estimated/inferred.
    changeCount,
  };
}

// R10 — Proactive Assistant config serialization. Derives a friendly
// {enabled, localTime, timezone, weekdays, notifyOnComplete, nextRunAt,
// lastRunAt, lastRunStatus} shape straight from the one real underlying
// Task record (automationKind:'DAILY_BRIEF') — no second source of truth,
// no fabricated default beyond "no schedule configured yet" when none
// exists.
function serializeProactiveConfig(task: TaskRecord | undefined) {
  if (!task) {
    return { enabled: false, localTime: null, timezone: null, weekdays: [] as number[], notifyOnComplete: true, nextRunAt: null, lastRunAt: null, lastRunStatus: null, taskStatus: null as TaskRecord['status'] | null };
  }
  const cronParts = (task.trigger.schedule || '').trim().split(/\s+/);
  const localTime = cronParts.length === 5 ? `${cronParts[1].padStart(2, '0')}:${cronParts[0].padStart(2, '0')}` : null;
  const weekdays = cronParts.length === 5 ? cronParts[4].split(',').map(Number).filter((n) => Number.isInteger(n)) : [];
  return {
    // RUNNING still counts as "the automation is on" (it's mid-run, not
    // paused) — Home's proactive-state line (§3) uses the separate
    // `taskStatus` field below to tell "on and idle" apart from "on and
    // generating right now", rather than this route ever reporting a
    // currently-executing automation as disabled.
    enabled: task.status === 'ACTIVE' || task.status === 'RUNNING',
    localTime,
    timezone: task.trigger.timezone ?? null,
    weekdays,
    notifyOnComplete: task.notifyOnComplete !== false,
    nextRunAt: task.nextRunAt,
    lastRunAt: task.lastRunAt,
    lastRunStatus: task.lastRunStatus,
    taskStatus: task.status,
  };
}

export interface DailyBriefRouteDeps {
  service: AiService;
  calendarService: GoogleCalendarService;
  gmailApiService: GmailService;
  dailyBriefStore: DailyBriefStore;
  actionProposalStore: ActionProposalStore;
  actionApprovals: PersistentActionApprovalStore;
  activityStore: ActivityStore;
  notificationEngine: NotificationEngine;
  taskStore: TaskStore;
}

export const handleDailyBriefRoutes: AsyncRouteRegistrar<DailyBriefRouteDeps> = async (method, pathname, body, headers, query, deps): Promise<ApiResult | undefined> => {
  const { service, calendarService, gmailApiService, dailyBriefStore, actionProposalStore, actionApprovals, activityStore, notificationEngine, taskStore } = deps;

  // R8/R9/R10 — Personal Daily Brief. Combines real Calendar + Gmail +
  // Tasks + Activity + model reasoning into one read-only synthesis,
  // persisted as a durable, date-scoped record (dailyBriefStore). Never
  // executes anything itself (§5): a consequential action the model
  // recommends still has to go through the real Approval flow via its own
  // normal entry point, never created or auto-approved here.
  if ((pathname === '/api/v1/daily-brief' && method === 'GET') || (pathname === '/api/v1/daily-brief/refresh' && method === 'POST')) {
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_brief_${crypto.randomUUID()}`;
    const isExplicitRefresh = pathname === '/api/v1/daily-brief/refresh';
    const today = dailyBriefDateKey();

    const existing = dailyBriefStore.getForDate(tenantId, principalId, today);

    // R9 §2 — a plain GET never regenerates once today already has a
    // persisted brief; only an explicit refresh (or today's very first
    // request) triggers real Calendar/Gmail/model calls.
    if (existing && !isExplicitRefresh) {
      const approvals = safeListPendingApprovals(actionApprovals, tenantId, principalId, requestId);
      const proposals = actionProposalStore.listForDate(tenantId, principalId, today);
      const changeCount = countImportantChangesForDate(notificationEngine, tenantId, principalId, today);
      return { status: 200, data: buildBriefResponse(existing, approvals, false, null, proposals, changeCount) };
    }

    const generated = await generateDailyBriefOnce(
      { calendarService, gmailApiService, aiService: service, taskStore, activityStore },
      tenantId, principalId, requestId, isExplicitRefresh, 'MANUAL',
    );

    // R9 §2 — a failed refresh must never overwrite (or be reported as)
    // the last known good brief; the previous persisted record — if any
    // — keeps serving as "today's brief" for both reads and the UI's own
    // freshness label, and the failed attempt is reported separately as
    // a truthful lastRefreshAttempt instead.
    const isUsable = generated.status !== 'UNAVAILABLE';
    if (isUsable) {
      dailyBriefStore.save(generated);

      // R10.1 §1/§2 — a real manual refresh is exactly as valid a
      // change-detection trigger as a scheduled run; `existing` (already
      // fetched above, pre-overwrite) is the real "last brief" baseline.
      const newApprovalsSincePrevious = existing
        ? actionApprovals.listPending(tenantId, principalId, requestId)
            .filter((a) => a.createdAt > existing.generatedAt)
            .map((a) => ({ approvalId: a.approvalId, toolId: a.toolId, createdAt: a.createdAt }))
        : [];
      const changes = detectMeaningfulChanges({ previous: existing, current: generated, newApprovalsSincePrevious });
      await dispatchDetectedChanges(notificationEngine, tenantId, principalId, generated.date, changes, requestId);

      // R11 — grounded, reviewable proposals from the same real changes,
      // deduped per §9 so a re-refresh of the same day never creates a
      // duplicate PROPOSED proposal for the same underlying change.
      for (const draft of generateProposalsFromChanges(changes, generated)) {
        const dedupeKey = actionProposalStore.buildDedupeKey(tenantId, principalId, generated.date, draft.sourceType, draft.sourceId, draft.proposalType);
        if (!actionProposalStore.findByDedupeKey(tenantId, principalId, dedupeKey)) {
          actionProposalStore.create({ ...draft, tenantId, principalId, date: generated.date });
        }
      }
    }
    const current = isUsable ? generated : (existing ?? generated);
    const approvals = safeListPendingApprovals(actionApprovals, tenantId, principalId, requestId);
    const proposals = actionProposalStore.listForDate(tenantId, principalId, current.date);
    const changeCount = countImportantChangesForDate(notificationEngine, tenantId, principalId, current.date);
    const lastRefreshAttempt = !isUsable && existing
      ? { attemptedAt: generated.generatedAt, status: generated.status, requestId: generated.requestId }
      : null;
    return {
      status: 200,
      data: buildBriefResponse(current, approvals, isExplicitRefresh, lastRefreshAttempt, proposals, changeCount),
    };
  }

  // R9 §4 — Daily Brief history: real persisted per-date records only,
  // read-only (never triggers generation). Today's own entry, if already
  // generated, is included like any other date.
  if (pathname === '/api/v1/daily-brief/history' && method === 'GET') {
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const limitRaw = Number(query.days);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 30) : 7;
    const history = dailyBriefStore.listHistory(tenantId, principalId, limit);
    return { status: 200, data: { history: history.map((r) => ({ ...r, freshness: computeBriefFreshness(r.generatedAt) })) } };
  }

  // R10 — Proactive Assistant settings: the Daily Brief automation
  // schedule is modeled as a real Task (type RECURRING with a SCHEDULE
  // trigger — cron string + IANA timezone), reusing TaskStore/
  // TaskScheduler/computeNextRunAt wholesale (R10 §2's own instruction:
  // reuse the existing scheduler, never build a parallel one).
  // automationKind:'DAILY_BRIEF' is how CompositeTaskRunner routes it to
  // DailyBriefTaskRunner instead of the generic plan/execute runner. This
  // route is a thin, friendlier read/upsert shape over that one
  // underlying Task — never a second persistence layer.
  if (pathname === '/api/v1/proactive-assistant/config' && (method === 'GET' || method === 'PUT')) {
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_proactive_${crypto.randomUUID()}`;

    const findExisting = () => taskStore.list(tenantId, principalId).find((t) => t.automationKind === 'DAILY_BRIEF');

    if (method === 'GET') {
      const task = findExisting();
      return { status: 200, data: serializeProactiveConfig(task) };
    }

    // PUT — upsert. enabled/localTime/timezone/weekdays/notifyOnComplete
    // are the only real, user-controllable fields (R10 §3); nothing here
    // ever defaults to enabled=true (R10 §26) — a brand-new config
    // always starts from whatever `enabled` the caller explicitly sent.
    const enabled = body?.enabled === true;
    const localTime = typeof body?.localTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(body.localTime) ? body.localTime : null;
    const timezone = typeof body?.timezone === 'string' && body.timezone.trim() ? body.timezone.trim() : null;
    const weekdays = Array.isArray(body?.weekdays) ? body.weekdays.filter((d: unknown): d is number => typeof d === 'number' && d >= 0 && d <= 6) : null;
    const notifyOnComplete = body?.notifyOnComplete !== false;

    if (!localTime || !timezone || !weekdays || weekdays.length === 0) {
      throw new NagexError({ code: 'PROACTIVE_ASSISTANT_CONFIG_INVALID', category: 'VALIDATION', message: 'localTime (HH:MM), timezone (IANA), and at least one weekday are required.', request_id: requestId });
    }
    // Real IANA timezone validation — fails closed rather than silently
    // falling back to UTC or the server's own local zone (R10 §5/§26).
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    } catch {
      throw new NagexError({ code: 'PROACTIVE_ASSISTANT_CONFIG_INVALID', category: 'VALIDATION', message: `"${timezone}" is not a real IANA timezone.`, request_id: requestId });
    }

    const [hh, mm] = localTime.split(':');
    const cron = `${Number(mm)} ${Number(hh)} * * ${weekdays.slice().sort().join(',')}`;

    const trigger: TaskTrigger = { type: 'SCHEDULE', schedule: cron, timezone };
    let task = findExisting();
    if (!task) {
      // A freshly created RECURRING task starts ACTIVE (TaskStore.create's
      // own real default) regardless of the requested `enabled` — paused
      // immediately below if the caller asked for disabled, never the
      // other way around, so "enabled" is never silently true.
      task = taskStore.create({
        tenantId, ownerId: principalId,
        name: 'Daily Brief',
        objective: 'Automatically generate the daily personal brief (Calendar + Gmail + Tasks summary).',
        type: 'RECURRING',
        trigger,
        approvalPolicy: 'READ_ONLY_AUTO',
        automationKind: 'DAILY_BRIEF',
        notifyOnComplete,
        nextRunAt: null,
      });
    }

    const nextRunAt = enabled ? computeNextRunAt(trigger, new Date()) : null;
    task = taskStore.update(task.taskId, tenantId, principalId, {
      trigger, notifyOnComplete, nextRunAt: nextRunAt ? nextRunAt.toISOString() : null,
    }, requestId);
    if (enabled && task.status === 'PAUSED') task = taskStore.resume(task.taskId, tenantId, principalId, requestId);
    if (!enabled && task.status === 'ACTIVE') task = taskStore.pause(task.taskId, tenantId, principalId, requestId);

    return { status: 200, data: serializeProactiveConfig(task) };
  }

  return undefined;
};

// R11 §7 — real, persisted count only (never inferred): how many
// IMPORTANT_CHANGE notifications were actually dispatched for this exact
// brief date, read straight from the same NotificationStore/Engine every
// other notification already goes through.
function countImportantChangesForDate(notificationEngine: NotificationEngine, tenantId: string, principalId: string, date: string): number {
  return notificationEngine.list(tenantId, principalId, 200)
    .filter((n) => n.type === 'IMPORTANT_CHANGE' && (n.metadata as { date?: string } | undefined)?.date === date)
    .length;
}

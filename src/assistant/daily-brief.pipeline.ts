// R10 — the one real Daily Brief generation pipeline, shared by the manual
// HTTP path (GET/POST /api/v1/daily-brief[/refresh] in server_web.ts) and
// the scheduled/automatic path (DailyBriefTaskRunner). Extracted out of
// server_web.ts specifically so R10 never builds "a second brief
// generator" — directive §7's explicit instruction — both entry points
// call this exact function, with the exact same real Calendar/Gmail/Task
// reads, the exact same AiService.brief() call, and the exact same
// activity-event naming.
import { NagexError } from '../common/errors.js';
import type { GoogleCalendarService } from '../modules/calendar/index.js';
import type { GmailService } from '../modules/gmail/index.js';
import type { AiService, BriefActionItem } from '../model-gateway/ai-service.js';
import type { TaskStore } from '../tasks/task.store.js';
import type { ActivityStore } from '../governance/activity.store.js';
import { dailyBriefDateKey, type DailyBriefRecord } from '../governance/daily-brief.store.js';

export interface DailyBriefPipelineDeps {
  calendarService: GoogleCalendarService;
  gmailApiService: GmailService;
  aiService: AiService;
  taskStore: TaskStore;
  activityStore: ActivityStore;
}

export type GeneratedDailyBrief = Omit<DailyBriefRecord, 'briefId'>;

// R9/R10 §17 — single-flight guard keyed by tenantId::principalId. Module-
// level and shared by both the manual refresh path and the scheduled
// runner, so "manual refresh + scheduled run at the same moment" (R10 §17)
// share this exact same in-flight promise instead of racing two real
// Calendar/Gmail/model round-trips.
const dailyBriefGenerationInFlight = new Map<string, Promise<GeneratedDailyBrief>>();

// isSourceRefresh only affects which Activity event gets recorded
// alongside the real started/completed lifecycle events (daily_brief.refreshed) —
// it never changes what's fetched or generated. `source` (R10.1) records
// which real entry point triggered this generation — the scheduled
// Proactive Assistant automation, or a real user action — purely for
// truthful Home-UI display (§3); it never changes what's fetched either.
export async function generateDailyBriefOnce(
  deps: DailyBriefPipelineDeps,
  tenantId: string,
  principalId: string,
  requestId: string,
  isSourceRefresh: boolean,
  source: 'SCHEDULED' | 'MANUAL' = 'MANUAL',
): Promise<GeneratedDailyBrief> {
  const guardKey = `${tenantId}::${principalId}`;
  const today = dailyBriefDateKey();

  let inFlight = dailyBriefGenerationInFlight.get(guardKey);
  if (inFlight) return inFlight;

  inFlight = (async (): Promise<GeneratedDailyBrief> => {
    const { calendarService, gmailApiService, aiService, taskStore, activityStore } = deps;

    activityStore.record({
      tenantId, principalId, type: 'daily_brief.started', title: 'Daily Brief generation started', status: 'RUNNING',
      dedupeKey: `daily_brief:${requestId}:started`,
    });

    // Calendar — today's window only. DISCONNECTED (Google never
    // connected) is reported distinctly from ERROR (a real failure) so the
    // UI can tell the two apart, matching My Space's own convention.
    let schedule: Awaited<ReturnType<typeof calendarService.listUpcomingEvents>> = [];
    let calendarStatus: 'CONNECTED' | 'DISCONNECTED' | 'ERROR' = 'CONNECTED';
    try {
      const now = new Date();
      const endOfDay = new Date(now);
      endOfDay.setHours(23, 59, 59, 999);
      schedule = await calendarService.listUpcomingEvents({ tenantId, timeMin: now.toISOString(), timeMax: endOfDay.toISOString(), maxResults: 20, requestId });
    } catch (error) {
      schedule = [];
      calendarStatus = error instanceof NagexError && error.code === 'GOOGLE_CALENDAR_DISCONNECTED' ? 'DISCONNECTED' : 'ERROR';
    }
    if (calendarStatus === 'CONNECTED') {
      activityStore.record({ tenantId, principalId, type: 'daily_brief.source_calendar_completed', title: 'Daily Brief: calendar read', status: 'COMPLETED', dedupeKey: `daily_brief:${requestId}:calendar` });
    }

    // Gmail — real unread-recent search only; gmail.client.ts's real
    // message shape is snippet-only (no subject/from/date exist anywhere
    // in this codebase's Gmail integration today), so that is exactly and
    // only what gets shown — never a fabricated subject line.
    let emails: Array<{ threadId: string; snippet: string; historyId: string | null }> = [];
    let gmailStatus: 'CONNECTED' | 'DISCONNECTED' | 'ERROR' = 'CONNECTED';
    try {
      const result = await gmailApiService.search({ tenantId, query: 'is:unread newer_than:3d', requestId });
      emails = result.threads.slice(0, 10);
    } catch (error) {
      emails = [];
      gmailStatus = error instanceof NagexError && error.code === 'GMAIL_DISCONNECTED' ? 'DISCONNECTED' : 'ERROR';
    }
    if (gmailStatus === 'CONNECTED') {
      activityStore.record({ tenantId, principalId, type: 'daily_brief.source_gmail_completed', title: 'Daily Brief: Gmail read', status: 'COMPLETED', dedupeKey: `daily_brief:${requestId}:gmail` });
    }

    let tasks: ReturnType<typeof taskStore.list> = [];
    try {
      tasks = taskStore.list(tenantId, principalId).filter((t) => t.status === 'ACTIVE' || t.status === 'RUNNING');
    } catch {
      tasks = [];
    }

    const scheduleDigest = schedule.map((e) => `- ${e.title} (${e.start} - ${e.end})`).join('\n');
    const emailsDigest = emails.map((e) => `- ${e.snippet}`).join('\n');
    const tasksDigest = tasks.map((t) => `- ${t.name} (${t.status})`).join('\n');

    let summary: string | null = null;
    let actionItems: BriefActionItem[] = [];
    let provider: string | null = null;
    let modelName: string | null = null;
    let latencyMs: number | null = null;
    let fallbackOccurred = false;
    let briefStatus: 'OK' | 'PARTIAL' | 'UNAVAILABLE';

    try {
      const result = await aiService.brief({ scheduleDigest, emailsDigest, tasksDigest, mode: 'auto', requestId });
      summary = result.data.summary;
      actionItems = result.data.actionItems;
      provider = result.provider;
      modelName = result.model;
      latencyMs = result.latencyMs;
      const routing = aiService.activeProviderSummary();
      fallbackOccurred = Boolean(routing.activeProvider) && routing.activeProvider !== provider;
      briefStatus = calendarStatus === 'CONNECTED' && gmailStatus === 'CONNECTED' ? 'OK' : 'PARTIAL';
    } catch {
      // Every provider failed (or none configured): never wrap the raw
      // calendar/gmail/task data already gathered above in a fake summary.
      briefStatus = 'UNAVAILABLE';
    }

    const eventType = briefStatus === 'UNAVAILABLE' ? 'daily_brief.failed' : briefStatus === 'PARTIAL' ? 'daily_brief.partial' : 'daily_brief.generated';
    activityStore.record({
      tenantId, principalId,
      type: eventType,
      title: briefStatus === 'UNAVAILABLE' ? 'Daily Brief generation failed' : briefStatus === 'PARTIAL' ? 'Daily Brief generated (partial)' : 'Daily Brief generated',
      status: briefStatus === 'UNAVAILABLE' ? 'FAILED' : 'COMPLETED',
      dedupeKey: `daily_brief:${requestId}:${eventType}`,
      source: { executionId: requestId },
    });
    if (isSourceRefresh) {
      activityStore.record({
        tenantId, principalId, type: 'daily_brief.refreshed', title: 'Daily Brief refreshed',
        status: briefStatus === 'UNAVAILABLE' ? 'FAILED' : 'COMPLETED',
        dedupeKey: `daily_brief:${requestId}:refreshed`,
      });
    }

    return {
      tenantId, principalId, date: today,
      generatedAt: new Date().toISOString(),
      status: briefStatus,
      provider, model: modelName, latencyMs, fallbackOccurred,
      calendarStatus, gmailStatus,
      schedule: schedule.map((e) => ({ sourceType: 'CALENDAR' as const, sourceId: e.id, title: e.title, start: e.start, end: e.end, capability: 'google_calendar', timestamp: e.start, status: e.status, updated: e.updated })),
      emails: emails.map((e) => ({ sourceType: 'GMAIL' as const, sourceId: e.threadId, snippet: e.snippet, capability: 'gmail', timestamp: null as string | null, historyId: e.historyId })),
      summary, actionItems, requestId, source,
    };
  })().finally(() => dailyBriefGenerationInFlight.delete(guardKey));

  dailyBriefGenerationInFlight.set(guardKey, inFlight);
  return inFlight;
}

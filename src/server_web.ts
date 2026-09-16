import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { handleHealthRoutes, type HealthRouteDeps } from './http/routes/health.routes.js';

// ─── NAgex Core Engine Imports ───
import { NagexError } from './common/errors.js';
import type { TenantContext, PrincipalReference } from './common/types.js';
import { AiService, parseRoutingMode, type PlanPreview, type BriefActionItem } from './model-gateway/ai-service.js';
import { dailyBriefDateKey, type DailyBriefRecord } from './governance/daily-brief.store.js';
import { generateDailyBriefOnce } from './assistant/daily-brief.pipeline.js';
import { detectMeaningfulChanges, dispatchDetectedChanges } from './assistant/daily-brief-change-detection.js';
import { generateProposalsFromChanges } from './assistant/action-proposal-generator.js';
import { handleActionProposalsRoutes, type ActionProposalsRouteDeps } from './http/routes/action-proposals.routes.js';
import { handleMemoryRoutes } from './http/routes/memory.routes.js';
import { handleModulesRoutes } from './http/routes/modules.routes.js';
import { handleCatalogRoutes } from './http/routes/catalog.routes.js';
import { handleSettingsRoutes } from './http/routes/settings.routes.js';
import { handleNotificationsRoutes } from './http/routes/notifications.routes.js';
import { handleTasksRoutes, handleTasksRunRoutes } from './http/routes/tasks.routes.js';
import { handleAutomationsRoutes, handleAutomationsRunRoutes } from './http/routes/automations.routes.js';
import { handleWorkspaceRoutes } from './http/routes/workspace.routes.js';
import { handleGmailRoutes } from './http/routes/gmail.routes.js';
import { handleCalendarRoutes } from './http/routes/calendar.routes.js';
import { handleApprovalsRoutes } from './http/routes/approvals.routes.js';
import { handleBrowserRoutes } from './http/routes/browser.routes.js';
import { handleGoogleOAuthStartRoutes, handleGoogleOAuthCallbackRoutes } from './http/routes/google-oauth.routes.js';
import { handleTelegramRoutes } from './http/routes/telegram.routes.js';
import { handleSlackRoutes } from './http/routes/slack.routes.js';
import { handleDesktopRoutes } from './http/routes/desktop.routes.js';
import { handleGovernanceRoutes, executionHistory } from './http/routes/governance.routes.js';
import type { GoogleCalendarService } from './modules/calendar/index.js';
import type { GmailService } from './modules/gmail/index.js';
import { BrowserToolService, browserRuntime } from './modules/browser/index.js';
import { DEFAULT_GOOGLE_TENANT_ID } from './integrations/google/token.store.js';
import type { ConversationStore } from './conversations/conversation.store.js';
import type { ConversationContextService } from './conversations/conversation-context.service.js';
import type { TaskTrigger, TaskRecord } from './tasks/task.store.js';
import { computeNextRunAt } from './tasks/task.scheduler.js';
import type { TelegramService } from './integrations/telegram/telegram.service.js';
import { SafetyEngine } from './governance/safety.engine.js';
import { PersistentSafetyStore } from './governance/safety.store.js';
import type { SlackService } from './integrations/slack/slack.service.js';
import { NotificationEngine } from './notifications/notification.engine.js';
import { createNagexApplication } from './app/create-nagex-application.js';

const PORT = Number(process.env.PORT || 8085);
const PUBLIC_DIR = path.join(process.cwd(), 'public');
const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
  Expires: '0',
} as const;
const MUTABLE_FRONTEND_FILES = new Set(['index.html', 'style.css', 'app.js', 'i18n.js', 'plan-resolution-view.js', 'calendar-approval-view.js', 'calendar-intent-extraction.js', 'calendar-payload-validation.js', 'gmail-approval-view.js', 'gmail-intent-extraction.js', 'browser-approval-view.js', 'browser-intent-extraction.js', 'modal-behavior.js', 'timeline-dedupe.js', 'single-flight-guard.js', 'legal.js', 'privacy.html', 'terms.html', 'desktop-quickwake.html', 'desktop-quickwake.css', 'desktop-quickwake.js', 'shared/tokens.css', 'shared/components.css', 'desktop/desktop-home.css', 'desktop/desktop-home.js', 'mobile/mobile-home.css', 'mobile/mobile-home.js', 'mobile/mobile-inbox.css', 'mobile/mobile-inbox.js', 'mobile/mobile-activity.css', 'mobile/mobile-activity.js', 'mobile/mobile-vault.css', 'mobile/mobile-vault.js', 'mobile/mobile-settings.css', 'mobile/mobile-settings.js']);
const VERSIONED_HTML_FILES = new Set(['index.html', 'privacy.html', 'terms.html', 'desktop-quickwake.html']);
const CLEAN_URL_ALIASES: Record<string, string> = { '/privacy': 'privacy.html', '/terms': 'terms.html', '/quickwake': 'desktop-quickwake.html' };
const BUILD_VERSION_PLACEHOLDER = '__NAGEX_BUILD_VERSION__';

function createBuildVersion(): string {
  const hash = crypto.createHash('sha256');
  for (const filename of ['style.css', 'i18n.js', 'plan-resolution-view.js', 'calendar-approval-view.js', 'calendar-intent-extraction.js', 'calendar-payload-validation.js', 'gmail-approval-view.js', 'gmail-intent-extraction.js', 'browser-approval-view.js', 'browser-intent-extraction.js', 'modal-behavior.js', 'timeline-dedupe.js', 'single-flight-guard.js', 'legal.js', 'app.js', 'shared/tokens.css', 'shared/components.css', 'desktop/desktop-home.css', 'desktop/desktop-home.js', 'mobile/mobile-home.css', 'mobile/mobile-home.js', 'mobile/mobile-inbox.css', 'mobile/mobile-inbox.js', 'mobile/mobile-activity.css', 'mobile/mobile-activity.js', 'mobile/mobile-vault.css', 'mobile/mobile-vault.js', 'mobile/mobile-settings.css', 'mobile/mobile-settings.js']) {
    hash.update(filename);
    hash.update(fs.readFileSync(path.join(PUBLIC_DIR, filename)));
  }
  return hash.digest('hex').slice(0, 12);
}

export const FRONTEND_BUILD_VERSION = createBuildVersion();

// ─── MIME Types ───
const mimeTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

// ─── Composition Root ───
// Phase 01 — application-level production object construction lives in
// createNagexApplication() (src/app/create-nagex-application.ts) now, not
// here. This is the exact same construction, at the exact same module-load
// timing (called synchronously, once, right here) — only the "where" moved.
const app = createNagexApplication();
const {
  pdp,
  runtime,
  auditLogger,
  billing,
  creditEngine,
  memoryEngine,
  aiService,
  planResolver,
  googleCalendarService,
  gmailService,
  browserService,
  taskRunner,
  taskContinuations,
  taskContinuationCoordinator,
  durableTaskRunState,
  durableTaskRuntime,
  getRelevantMemories,
  pinnedMemories,
  lifecycle,
} = app;
export const {
  actionApprovals,
  executionStore,
  moduleRegistry,
  moduleStateStore,
  moduleService,
  capabilityBroker,
  sessionStore,
  conversationStore,
  conversationContextService,
  taskStore,
  taskRunStore,
  telegramIdentityStore,
  telegramBotClient,
  telegramService,
  slackIdentityStore,
  slackClient,
  slackService,
  desktopRuntimeEngine,
  notificationStore,
  notificationEngine,
  taskScheduler,
  knowledgeEngine,
  storageProvider,
  candidateStore,
  activityStore,
  dailyBriefStore,
  actionProposalStore,
  candidateActionResolver,
  quickCaptureService,
  inputRouter,
  workflowDefinitionStore,
  workflowDefinitionService,
  deviceAgentTransportEndpoint,
  deviceIdentityStore,
} = app;

// A real (not fake) background scheduler loop — only runs when this module
// is the actual running server, never when imported by tests. Phase 02:
// the interval handle itself is now a lifecycle-managed resource (started
// and explicitly cleared via app.lifecycle) instead of an unmanaged
// .unref()'d timer — see the single require.main === module entrypoint
// block below, which registers this alongside the HTTP server and
// browserRuntime.
const TASK_SCHEDULER_TICK_MS = Number(process.env.NAGEX_TASK_SCHEDULER_INTERVAL_MS) || 30_000;

// R10.2-D Increment 4 — pendingGoogleOAuthState/INITIAL_CREDIT_GRANT/
// ensureTenantSeeded/MANAGED_AI_COST_BREAKDOWN/SUBSCRIPTION_INFO moved to
// src/http/routes/google-oauth.routes.ts and governance.routes.ts (each
// with its only remaining consumers).

// Personal AI seed memory (mem1-4) + pinnedMemories moved into
// createNagexApplication() — see app.pinnedMemories, destructured above —
// since getRelevantMemories/pinnedMemories are genuine construction-time
// dependencies of taskRunner/telegramService/slackService there, not
// merely seed-time artifacts.

// Seed Plans (Exact match for Mockup Image 4)
// R10.2-D — planRegistry moved to src/http/routes/catalog.routes.ts (its
// only consumer, GET /api/v1/plans).

// R9/R10 — Personal Daily Brief. dailyBriefStore persists one durable
// record per (tenantId, principalId, date) — see
// src/governance/daily-brief.store.ts. Generation itself (including the
// real single-flight in-flight guard — R10 §17: a manual refresh and a
// scheduled automation run for the same tenant+principal now structurally
// share it) lives in src/assistant/daily-brief.pipeline.ts's
// generateDailyBriefOnce(), imported below. DAILY_BRIEF_STALE_MS is the
// freshness window (§6) — a persisted brief older than this is reported
// with freshness:'STALE' on read, never silently treated as current.
const DAILY_BRIEF_STALE_MS = 60 * 60 * 1000;

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

// R11 §7 — real, persisted count only (never inferred): how many
// IMPORTANT_CHANGE notifications were actually dispatched for this exact
// brief date, read straight from the same NotificationStore/Engine every
// other notification already goes through.
function countImportantChangesForDate(tenantId: string, principalId: string, date: string): number {
  return notificationEngine.list(tenantId, principalId, 200)
    .filter((n) => n.type === 'IMPORTANT_CHANGE' && (n.metadata as { date?: string } | undefined)?.date === date)
    .length;
}

function computeBriefFreshness(generatedAt: string): 'FRESH' | 'STALE' {
  return Date.now() - Date.parse(generatedAt) > DAILY_BRIEF_STALE_MS ? 'STALE' : 'FRESH';
}

function safeListPendingApprovals(tenantId: string, principalId: string, requestId: string) {
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
  approvals: ReturnType<typeof actionApprovals.listPending>,
  wasExplicitRefresh: boolean,
  lastRefreshAttempt: { attemptedAt: string; status: string; requestId: string } | null,
  proposals: ReturnType<typeof actionProposalStore.listForDate> = [],
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

// R10.2-D Increment 4 — approvalQueue moved to
// src/http/routes/approvals.routes.ts; executionHistory moved to
// src/http/routes/governance.routes.ts (imported above — health.routes.ts
// still legitimately needs its length for executionCount, below).
// quickWakeConfig/autonomyConfig moved to src/http/routes/settings.routes.ts;
// knowledgeBase moved to src/http/routes/catalog.routes.ts (each with its
// only consumer).

// R10.2-D — health/vcs status moved to src/http/routes/health.routes.ts.
const healthRouteDeps: HealthRouteDeps = { executionCount: () => executionHistory.length };

// ─── API Router ───
function getHeaderValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

// V01a-R1 — timing-safe token comparison for the test-only fixed-plan
// injection route moved to src/http/routes/tasks.routes.ts (its only
// consumer, POST /api/v1/tasks/:id/run-with-fixed-plan).

// getRelevantMemories/MEMORY_RELEVANCE_STOPWORDS moved into
// createNagexApplication() (see app.getRelevantMemories, destructured
// above) — it is a genuine construction-time dependency of
// taskRunner/telegramService/slackService there.

type ApiResult = { status: number; data: unknown; redirectTo?: string };

const ERROR_CATEGORY_STATUS: Record<string, number> = {
  VALIDATION: 400,
  AUTHENTICATION: 401,
  AUTHORIZATION: 403,
  POLICY: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  QUOTA: 429,
  RATE_LIMIT: 429,
  TIMEOUT: 504,
  PROVIDER: 502,
  RUNTIME: 500,
  INTERNAL: 500,
};

function modelErrorResult(error: unknown): ApiResult {
  if (error instanceof NagexError) {
    const status = ERROR_CATEGORY_STATUS[error.category] ?? 502;
    return { status, data: error.toJSON() };
  }
  const requestId = `req_${crypto.randomUUID()}`;
  console.error(JSON.stringify({ event: 'ai_request_failed', requestId, code: 'INTERNAL_ERROR' }));
  return { status: 500, data: { error: { code: 'INTERNAL_ERROR', category: 'INTERNAL', message: 'AI request failed.', request_id: requestId } } };
}

export async function handleAsyncApiRequest(
  method: string,
  pathname: string,
  body: Record<string, unknown> | null,
  headers: Record<string, string | string[] | undefined> = {},
  service: AiService = aiService,
  query: Record<string, string> = {},
  calendarService: GoogleCalendarService = googleCalendarService,
  gmailApiService: GmailService = gmailService,
  browserApiService: BrowserToolService = browserService,
  telegramApiService: TelegramService = telegramService,
  slackApiService: SlackService = slackService,
  notificationApiService: NotificationEngine = notificationEngine,
  convStore: ConversationStore = conversationStore,
  convContextService: ConversationContextService = conversationContextService,
): Promise<ApiResult> {
  try {
    if (pathname === '/api/v1/providers/status' && method === 'GET') {
      // R7 §2/§3 — same real per-provider statuses() this already returned,
      // plus the active/fallback summary Settings' AI & Model section needs.
      // Never a hardcoded configured/connected value: both come straight
      // from UnifiedModelRouter's real registration-order + observed
      // per-provider state (see providers.ts's HttpModelProvider.status()).
      // R7.1: a pure read — never triggers a generation itself. The only
      // way this reflects LIVE/DEGRADED is real prior generate() traffic or
      // an explicit POST /api/v1/providers/health-check probe (below).
      return { status: 200, data: { providers: service.statuses(), ...service.activeProviderSummary() } };
    }
    if (pathname === '/api/v1/providers/health-check' && method === 'POST') {
      // R7.1 — the one real, explicit way to move a provider from
      // CONFIGURED to LIVE/DEGRADED without waiting for organic traffic:
      // a cheap, minimal, bounded probe per configured provider (each
      // already individually timeout-bounded — see providers.ts), never
      // an infinite retry, never a fabricated result.
      const providers = await service.healthCheck();
      return { status: 200, data: { providers, ...service.activeProviderSummary() } };
    }
    // Phase 2 Step 1 — Trust & Safety Layer Endpoints (TS-5, TS-6)
    if (pathname === '/api/v1/safety/evaluate' && method === 'POST') {
      const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || 'usr_default';
      const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const input = (body?.input as string) || '';
      const domain = body?.domain as string | undefined;
      const decision = await SafetyEngine.getInstance().evaluateIntent({
        input,
        domain,
        tenantId,
        userId: principalId,
      });
      return { status: 200, data: decision };
    }
    if (pathname === '/api/v1/safety/events' && method === 'GET') {
      const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || 'usr_default';
      const safetyStore = new PersistentSafetyStore();
      const events = await safetyStore.getEvents(tenantId);
      return { status: 200, data: { events, total: events.length } };
    }
    if (pathname === '/api/v1/safety/status' && method === 'GET') {
      const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || 'usr_default';
      const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const safetyStore = new PersistentSafetyStore();
      const userStatus = await safetyStore.getUserStatus(tenantId, principalId);
      return { status: 200, data: userStatus };
    }
    {
      const healthResult = handleHealthRoutes(method, pathname, body, headers, query, healthRouteDeps);
      if (healthResult) return healthResult;
    }
    if (pathname === '/api/v1/conversations/main' && method === 'GET') {
      const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
      const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const requestId = getHeaderValue(headers, 'x-request-id') || `req_conv_get_${crypto.randomUUID()}`;
      const session = sessionStore.getOrCreateMain(tenantId, principalId);
      const messages = convStore.listSession(tenantId, principalId, session.sessionId)
        .filter((m) => m.status !== 'DELETED');

      auditLogger.logEvent({
        actor: { type: 'user', id: principalId },
        tenant_id: tenantId,
        action: 'conversation.context.loaded',
        resource: { type: 'Session', id: session.sessionId },
        result: 'SUCCESS',
        request_id: requestId,
        details: { sessionId: session.sessionId, messageCount: messages.length },
      });

      return {
        status: 200,
        data: {
          session: { sessionId: session.sessionId, type: session.type },
          messages,
        },
      };
    }
    if (pathname === '/api/v1/conversations/main/messages' && method === 'POST') {
      const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
      const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const requestId = getHeaderValue(headers, 'x-request-id') || `req_conv_msg_${crypto.randomUUID()}`;
      const content = typeof body?.content === 'string' ? body.content.trim() : '';
      if (!content) {
        throw new NagexError({ code: 'INVALID_CONVERSATION_PAYLOAD', category: 'VALIDATION', message: 'content is required.', request_id: requestId });
      }
      const role = (typeof body?.role === 'string' ? body.role : 'USER') as any;
      const source = (typeof body?.source === 'string' ? body.source : 'WEB') as any;
      const session = sessionStore.getOrCreateMain(tenantId, principalId);

      const record = convStore.append({
        tenantId,
        principalId,
        sessionId: session.sessionId,
        role,
        source,
        content,
        requestId,
      });

      auditLogger.logEvent({
        actor: { type: 'user', id: principalId },
        tenant_id: tenantId,
        action: 'conversation.message.created',
        resource: { type: 'ConversationMessage', id: record.messageId },
        result: 'SUCCESS',
        request_id: requestId,
        details: { sessionId: session.sessionId, messageId: record.messageId, role: record.role, source: record.source },
      });

      return { status: 201, data: record };
    }
    if (pathname === '/api/v1/conversations/main' && method === 'DELETE') {
      const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
      const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const requestId = getHeaderValue(headers, 'x-request-id') || `req_conv_del_${crypto.randomUUID()}`;
      const session = sessionStore.getOrCreateMain(tenantId, principalId);
      const clearedCount = convStore.deleteSession(tenantId, principalId, session.sessionId);

      auditLogger.logEvent({
        actor: { type: 'user', id: principalId },
        tenant_id: tenantId,
        action: 'conversation.session.cleared',
        resource: { type: 'Session', id: session.sessionId },
        result: 'SUCCESS',
        request_id: requestId,
        details: { sessionId: session.sessionId, clearedCount },
      });

      return { status: 200, data: { clearedCount } };
    }
    if (pathname === '/api/v1/ai/chat' && method === 'POST') {
      const message = typeof body?.message === 'string' ? body.message.trim() : '';
      if (!message) throw new NagexError({ code: 'MESSAGE_REQUIRED', category: 'VALIDATION', message: 'message is required.', request_id: `req_${crypto.randomUUID()}` });
      const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
      const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const requestId = getHeaderValue(headers, 'x-request-id') || `req_chat_${crypto.randomUUID()}`;
      const session = sessionStore.getOrCreateMain(tenantId, principalId);

      // Section 6: Persist USER message BEFORE AI reasoning
      const userMsgRecord = convStore.append({
        tenantId,
        principalId,
        sessionId: session.sessionId,
        role: 'USER',
        source: 'WEB',
        content: message,
        requestId,
      });

      auditLogger.logEvent({
        actor: { type: 'user', id: principalId },
        tenant_id: tenantId,
        action: 'conversation.message.created',
        resource: { type: 'ConversationMessage', id: userMsgRecord.messageId },
        result: 'SUCCESS',
        request_id: requestId,
        details: { sessionId: session.sessionId, messageId: userMsgRecord.messageId, role: 'USER', source: 'WEB' },
      });

      const conversation = convContextService.buildContext({
        tenantId,
        principalId,
        sessionId: session.sessionId,
      });

      const result = await service.chat({
        message,
        conversation,
        mode: parseRoutingMode(body?.provider, process.env.NAGEX_MODEL_PROVIDER),
        requestId,
      });

      // Section 6: Persist ASSISTANT message AFTER successful AI response
      const assistantMsgRecord = convStore.append({
        tenantId,
        principalId,
        sessionId: session.sessionId,
        role: 'ASSISTANT',
        source: 'WEB',
        content: result.data.message,
        requestId,
      });

      auditLogger.logEvent({
        actor: { type: 'user', id: principalId },
        tenant_id: tenantId,
        action: 'conversation.message.created',
        resource: { type: 'ConversationMessage', id: assistantMsgRecord.messageId },
        result: 'SUCCESS',
        request_id: requestId,
        details: { sessionId: session.sessionId, messageId: assistantMsgRecord.messageId, role: 'ASSISTANT', source: 'WEB' },
      });

      return { status: 200, data: result };
    }
    if (pathname === '/api/v1/ambient/intent' && method === 'POST') {
      const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
      if (!prompt) throw new NagexError({ code: 'PROMPT_REQUIRED', category: 'VALIDATION', message: 'prompt is required.', request_id: `req_${crypto.randomUUID()}` });
      const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
      const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const requestId = getHeaderValue(headers, 'x-request-id') || `req_intent_${crypto.randomUUID()}`;
      const session = sessionStore.getOrCreateMain(tenantId, principalId);

      // Section 6: Persist USER message BEFORE AI reasoning
      const userMsgRecord = convStore.append({
        tenantId,
        principalId,
        sessionId: session.sessionId,
        role: 'USER',
        source: 'WEB',
        content: prompt,
        requestId,
      });

      auditLogger.logEvent({
        actor: { type: 'user', id: principalId },
        tenant_id: tenantId,
        action: 'conversation.message.created',
        resource: { type: 'ConversationMessage', id: userMsgRecord.messageId },
        result: 'SUCCESS',
        request_id: requestId,
        details: { sessionId: session.sessionId, messageId: userMsgRecord.messageId, role: 'USER', source: 'WEB' },
      });

      const conversation = convContextService.buildContext({
        tenantId,
        principalId,
        sessionId: session.sessionId,
      });

      const result = await service.plan({
        prompt,
        memories: getRelevantMemories(tenantId, principalId, prompt),
        conversation,
        mode: parseRoutingMode(body?.provider, process.env.NAGEX_MODEL_PROVIDER),
        requestId,
      });

      // Section 6: Persist ASSISTANT message AFTER successful AI generation
      const assistantContent = result.data.summary || result.data.goal || 'Plan generated.';
      const assistantMsgRecord = convStore.append({
        tenantId,
        principalId,
        sessionId: session.sessionId,
        role: 'ASSISTANT',
        source: 'WEB',
        content: assistantContent,
        requestId,
      });

      auditLogger.logEvent({
        actor: { type: 'user', id: principalId },
        tenant_id: tenantId,
        action: 'conversation.message.created',
        resource: { type: 'ConversationMessage', id: assistantMsgRecord.messageId },
        result: 'SUCCESS',
        request_id: requestId,
        details: { sessionId: session.sessionId, messageId: assistantMsgRecord.messageId, role: 'ASSISTANT', source: 'WEB' },
      });

      return { status: 200, data: { status: 'PLAN_PREVIEW', message: 'Plan generated. Review it before any tools are executed.', plan: result.data, provider: result.provider, model: result.model, latencyMs: result.latencyMs, requestId: result.requestId } };
    }
    // R10.2-D Increment 4 — Google OAuth callback/status/disconnect.
    {
      const googleOAuthResult = await handleGoogleOAuthCallbackRoutes(method, pathname, body, headers, query, { auditLogger });
      if (googleOAuthResult) return googleOAuthResult;
    }
    // R10.2-D Increment 3 — all Workspace/Capture/Candidate/Activity routes
    // (route-input, storage/status, inbox, vault, uploads, captures, items,
    // candidates, activity) now resolve through one registrar call. This
    // covers both the routes that used to sit here AND the ones that used
    // to sit further down near tools/browser (uploads/captures/items/
    // candidates/activity) — none of those pathnames collide with anything
    // in between, so consolidating the check here changes nothing
    // observable, only where the code physically lives.
    {
      const workspaceResult = await handleWorkspaceRoutes(method, pathname, body, headers, query, { quickCaptureService });
      if (workspaceResult) return workspaceResult;
    }
    if (pathname === '/api/v1/plans/resolve' && method === 'POST') {
      const candidate = body?.plan && typeof body.plan === 'object' ? body.plan : body;
      return { status: 200, data: planResolver.resolve(candidate as unknown as PlanPreview) };
    }
    // R10.2-D Increment 4 — Google Calendar mutation/read routes. Every
    // mutation still requires a pre-existing approvalId and calls
    // GoogleCalendarService.executeXxx(), built on R10.2-B's
    // GoogleCapabilityExecutionPipeline — unchanged.
    {
      const calendarResult = await handleCalendarRoutes(method, pathname, body, headers, query, { calendarService });
      if (calendarResult) return calendarResult;
    }

    // R10.2-D Increment 4 — Gmail mutation/read routes. Same approval-gated
    // GmailService.executeXxx() -> GoogleCapabilityExecutionPipeline path.
    {
      const gmailResult = await handleGmailRoutes(method, pathname, body, headers, query, { gmailApiService });
      if (gmailResult) return gmailResult;
    }

    // ── Browser Agent MVP (MASTER.md Section 14.5 item 06) ─────────────────
    {
      const browserResult = await handleBrowserRoutes(method, pathname, body, headers, query, { browserApiService });
      if (browserResult) return browserResult;
    }

    // R10.2-D Increment 3 — Task /run + test-only /run-with-fixed-plan.
    // SCHEDULER_MUTATION: drives a real TaskScheduler.runOne(), which can
    // itself reach EXTERNAL_MUTATION/APPROVAL_GATED capability execution
    // downstream (untouched by this move).
    {
      const tasksRunResult = await handleTasksRunRoutes(method, pathname, body, headers, query, {
        taskStore, taskRunStore, taskScheduler, service, aiService, planResolver, capabilityBroker,
        getRelevantMemories, taskContinuations, durableTaskRunState, auditLogger, notificationEngine, modelErrorResult,
      });
      if (tasksRunResult) return tasksRunResult;
    }

    // R10.2-D Increment 3 — Automation (WorkflowDefinition) /run.
    // SCHEDULER_MUTATION, same category as Task /run above.
    {
      const automationsRunResult = await handleAutomationsRunRoutes(method, pathname, body, headers, query, {
        workflowDefinitionService, taskStore, taskRunStore, aiService, planResolver, capabilityBroker,
        getRelevantMemories, taskContinuations, durableTaskRunState, auditLogger, notificationEngine, modelErrorResult,
      });
      if (automationsRunResult) return automationsRunResult;
    }

    // R10.2-D Increment 4 — Telegram integration (MASTER.md Section 14.5 item 10).
    {
      const telegramResult = await handleTelegramRoutes(method, pathname, body, headers, query, { telegramBotClient, telegramApiService, telegramIdentityStore, auditLogger });
      if (telegramResult) return telegramResult;
    }

    // R10.2-D Increment 4 — Slack integration (MASTER.md Section 14.5 item 11).
    {
      const slackResult = await handleSlackRoutes(method, pathname, body, headers, query, { slackClient, slackApiService, slackIdentityStore, auditLogger });
      if (slackResult) return slackResult;
    }

    // ── Notification Engine (MASTER.md Section 14.5 item 12) ──────────────
    // P04-R1 — every user-facing notification read/mutation is scoped by
    // tenantId + principalId, never principalId alone.
    {
      const notificationsResult = await handleNotificationsRoutes(method, pathname, body, headers, query, { notificationEngine: notificationApiService });
      if (notificationsResult) return notificationsResult;
    }

    // R10.2-D Increment 4 — Desktop Quick Wake Endpoints.
    {
      const desktopResult = await handleDesktopRoutes(method, pathname, body, headers, query, { desktopRuntimeEngine });
      if (desktopResult) return desktopResult;
    }

    if (pathname === '/api/v1/capabilities/execute' && method === 'POST') {
      const tenantId = (Array.isArray(headers['x-nagex-tenant']) ? headers['x-nagex-tenant'][0] : headers['x-nagex-tenant']) || 'ten_production_01';
      const principalId = (Array.isArray(headers['x-principal-id']) ? headers['x-principal-id'][0] : headers['x-principal-id']) || 'usr_admin_001';
      const headerRequestId = headers['x-request-id'] || headers['X-Request-Id'];
      const requestId = (Array.isArray(headerRequestId) ? headerRequestId[0] : headerRequestId) || `req_cap_${Date.now()}`;

      const capabilityId = typeof body?.capabilityId === 'string' ? body.capabilityId : '';
      const payload = body?.payload ?? {};
      const idempotencyKey = typeof body?.idempotencyKey === 'string' ? body.idempotencyKey : undefined;
      const sourceRaw = typeof body?.source === 'string' ? body.source : 'WEB';
      const source = ['WEB', 'QUICK_WAKE', 'TELEGRAM', 'SLACK', 'TASK', 'SYSTEM'].includes(sourceRaw)
        ? (sourceRaw as any)
        : 'WEB';

      try {
        const result = await capabilityBroker.execute({
          capabilityId,
          tenantId,
          principalId,
          requestId,
          payload,
          source,
          idempotencyKey,
        });

        if (result.status === 'EXECUTED') {
          return { status: 200, data: result };
        }
        if (result.status === 'APPROVAL_REQUIRED') {
          return { status: 202, data: result };
        }
        if (result.status === 'BLOCKED') {
          const httpStatus = result.reasonCode === 'CAPABILITY_NOT_FOUND' ? 404 : 403;
          return { status: httpStatus, data: result };
        }
        return { status: 400, data: result };
      } catch (error) {
        if (error instanceof NagexError) {
          if (error.code === 'CAPABILITY_NOT_FOUND') {
            return { status: 404, data: { error: error.code, message: error.message, request_id: requestId } };
          }
          if (error.code === 'CAPABILITY_IDEMPOTENCY_CONFLICT') {
            return { status: 409, data: { error: error.code, message: error.message, request_id: requestId } };
          }
          if (['CAPABILITY_DISABLED', 'CAPABILITY_BLOCKED_BY_SAFETY', 'CAPABILITY_POLICY_FAILED'].includes(error.code)) {
            return { status: 403, data: { error: error.code, message: error.message, request_id: requestId } };
          }
        }
        return modelErrorResult(error);
      }
    }

    // P08 — My Space Foundation. Thin, read-only composition of already-
    // frozen, already tenant/owner-scoped sources — no new store, no new
    // persistence, no provider bypass. Each section is independently
    // fault-tolerant (Section 12 of the implementation directive): a
    // failure in one (most commonly Calendar, when Google isn't connected)
    // never fails the whole response.
    if (pathname === '/api/v1/my-space' && method === 'GET') {
      const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
      const requestId = getHeaderValue(headers, 'x-request-id') || `req_myspace_${crypto.randomUUID()}`;

      let activity: ReturnType<typeof activityStore.list> = [];
      try {
        activity = activityStore.list(tenantId, ownerId, 10);
      } catch {
        activity = [];
      }

      let memory: ReturnType<typeof memoryEngine.getActiveMemories> = [];
      try {
        const scopes: Array<'USER' | 'SESSION' | 'AGENT' | 'TENANT'> = ['USER', 'SESSION', 'AGENT', 'TENANT'];
        memory = scopes
          .flatMap((scope) => memoryEngine.getActiveMemories(scope, tenantId, ownerId))
          .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
          .slice(0, 10);
      } catch {
        memory = [];
      }

      let tasks: ReturnType<typeof taskStore.list> = [];
      try {
        tasks = taskStore.list(tenantId, ownerId);
      } catch {
        tasks = [];
      }

      let workflows: Array<{ id: string; name: string; enabled: boolean; createdAt: string; updatedAt: string; lastRunStatus: 'SUCCEEDED' | 'FAILED' | null; lastRunAt: string | null }> = [];
      try {
        const workflowDefs = workflowDefinitionService.list(tenantId, ownerId);
        workflows = workflowDefs.map((wf) => {
          // Recent run state is composed, never stored: the most-recently-
          // updated owned Task instantiated from this workflow already
          // carries its own last-run outcome (P07's own traceability-only
          // field) — no new WorkflowRun store.
          const linkedTasks = tasks
            .filter((t) => t.workflowDefinitionId === wf.workflowId)
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
          const latest = linkedTasks[0];
          return {
            id: wf.workflowId,
            name: wf.name,
            enabled: wf.enabled,
            createdAt: wf.createdAt,
            updatedAt: wf.updatedAt,
            lastRunStatus: latest?.lastRunStatus ?? null,
            lastRunAt: latest?.lastRunAt ?? null,
          };
        });
      } catch {
        workflows = [];
      }

      // Calendar — DISCONNECTED is a normal, expected state (not every user
      // has connected Google Calendar), reported distinctly from a real
      // ERROR so the frontend can show "Connect Calendar" rather than a
      // generic failure; either way `calendar` itself stays a safe [].
      let calendar: Awaited<ReturnType<typeof calendarService.listUpcomingEvents>> = [];
      let calendarStatus: 'CONNECTED' | 'DISCONNECTED' | 'ERROR' = 'CONNECTED';
      try {
        const now = new Date();
        const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        calendar = await calendarService.listUpcomingEvents({
          tenantId,
          timeMin: now.toISOString(),
          timeMax: in7Days.toISOString(),
          maxResults: 5,
          requestId,
        });
      } catch (error) {
        calendar = [];
        calendarStatus = error instanceof NagexError && error.code === 'GOOGLE_CALENDAR_DISCONNECTED' ? 'DISCONNECTED' : 'ERROR';
      }

      // History = Activity + owned TaskRun ONLY (approved P08 definition —
      // never the legacy server_web `executionHistory` array, never the
      // unwired governance ExecutionStore, never runtime.engine's private
      // in-memory map). Owner isolation is structural, not a filter: only
      // taskIds already returned by the tenant+owner-scoped taskStore.list()
      // above are ever looked up — never "all TaskRuns, then filter".
      let history: Array<{ kind: 'ACTIVITY' | 'TASK_RUN'; id: string; title: string; status: string; timestamp: string }> = [];
      try {
        const activityEntries = activity.map((a) => ({ kind: 'ACTIVITY' as const, id: a.activityId, title: a.title, status: a.status, timestamp: a.occurredAt }));
        const taskRunEntries = tasks.flatMap((task) =>
          taskRunStore.listForTask(task.taskId).map((run) => ({
            kind: 'TASK_RUN' as const,
            id: run.runId,
            title: task.name,
            status: run.status,
            timestamp: run.completedAt || run.startedAt,
          })),
        );
        history = [...activityEntries, ...taskRunEntries]
          .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
          .slice(0, 15);
      } catch {
        history = [];
      }

      return {
        status: 200,
        data: { activity, memory, tasks, workflows, calendar, calendarStatus, history },
      };
    }

    // R8/R9/R10 — Personal Daily Brief. Combines real Calendar + Gmail +
    // Tasks + Activity + model reasoning into one read-only synthesis,
    // persisted as a durable, date-scoped record (dailyBriefStore). R10 —
    // generation itself now lives in
    // src/assistant/daily-brief.pipeline.ts's generateDailyBriefOnce(),
    // shared with the scheduled automation path (DailyBriefTaskRunner) so
    // there is exactly one real brief generator, not two (R10 §7). Never
    // executes anything itself (§5): a consequential action the model
    // recommends still has to go through the real Approval flow via its
    // own normal entry point, never created or auto-approved here.
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
        const approvals = safeListPendingApprovals(tenantId, principalId, requestId);
        const proposals = actionProposalStore.listForDate(tenantId, principalId, today);
        const changeCount = countImportantChangesForDate(tenantId, principalId, today);
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
      const approvals = safeListPendingApprovals(tenantId, principalId, requestId);
      const proposals = actionProposalStore.listForDate(tenantId, principalId, current.date);
      const changeCount = countImportantChangesForDate(tenantId, principalId, current.date);
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

    // R11 — Action Proposals (moved to src/http/routes/action-proposals.routes.ts,
    // R10.2-D). Deps built fresh per call — calendarService is this
    // function's own overridable param (test callers pass a fake one), so
    // it must never be captured from module scope.
    {
      const proposalsDeps: ActionProposalsRouteDeps = { actionProposalStore, taskStore, calendarService, activityStore };
      const proposalsResult = await handleActionProposalsRoutes(method, pathname, body, headers, query, proposalsDeps);
      if (proposalsResult) return proposalsResult;
    }

    // R10 — Proactive Assistant settings: the Daily Brief automation
    // schedule is modeled as a real Task (type RECURLING with a SCHEDULE
    // trigger — cron string + IANA timezone), reusing TaskStore/
    // TaskScheduler/computeNextScheduleRun wholesale (R10 §2's own
    // instruction: reuse the existing scheduler, never build a parallel
    // one). automationKind:'DAILY_BRIEF' is how CompositeTaskRunner routes
    // it to DailyBriefTaskRunner instead of the generic plan/execute
    // runner. This route is a thin, friendlier read/upsert shape over that
    // one underlying Task — never a second persistence layer.
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

    // DC3-B1 — the real outbound Local Device Agent transport endpoint.
    // Deliberately does NOT trust x-nagex-tenant/x-principal-id headers
    // the way every other route here does — a device's tenantId/ownerId
    // are only ever accepted as authenticated here because they are
    // cryptographically bound to an enrolled, ACTIVE device via
    // DeviceTransportSecurity.verify()'s real Ed25519 signature check,
    // never because a caller-controlled header said so. Never touches
    // CapabilityBroker/CapabilityRegistry — device.desktop.execute is not
    // reachable through this route at all.
    if (pathname === '/api/v1/device-agent/message' && method === 'POST') {
      const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
      const envelope = body?.envelope as any;
      const payload = body?.payload as any;
      if (!envelope || typeof envelope !== 'object' || payload === undefined) {
        throw new NagexError({ code: 'DEVICE_MESSAGE_MALFORMED', category: 'VALIDATION', message: 'A device message requires envelope and payload.', request_id: requestId });
      }
      const result = deviceAgentTransportEndpoint.handle({ envelope, payload }, requestId);
      return { status: 200, data: result };
    }

    return handleApiRequest(method, pathname, body, headers);
  } catch (error) {
    return modelErrorResult(error);
  }
}

export function handleApiRequest(
  method: string,
  pathname: string,
  body: Record<string, unknown> | null,
  headers: Record<string, string | string[] | undefined> = {}
): ApiResult {




  const headerTenant = headers['x-nagex-tenant'];
  const headerPrincipal = headers['x-principal-id'];
  const tenantId = (Array.isArray(headerTenant) ? headerTenant[0] : headerTenant) || 'ten_production_01';
  const tenantContext: TenantContext = { tenant_id: tenantId, scope_type: 'TENANT' };
  const principal: PrincipalReference = { type: 'user', id: (Array.isArray(headerPrincipal) ? headerPrincipal[0] : headerPrincipal) || 'usr_admin_001' };

  {
    const healthResult = handleHealthRoutes(method, pathname, body, headers, {}, healthRouteDeps);
    if (healthResult) return healthResult;
  }

  {
    const memoryResult = handleMemoryRoutes(method, pathname, body, headers, {}, { memoryEngine, pinnedMemories, tenantId, principal, modelErrorResult });
    if (memoryResult) return memoryResult;
  }

  {
    const modulesResult = handleModulesRoutes(method, pathname, body, headers, {}, { moduleService, pdp, auditLogger, tenantId, tenantContext, principal, modelErrorResult });
    if (modulesResult) return modulesResult;
  }

  {
    const catalogResult = handleCatalogRoutes(method, pathname, body, headers, {}, {});
    if (catalogResult) return catalogResult;
  }

  // R10.2-D Increment 4 — Approval lifecycle (list/request/get/legacy
  // calendar-event alias/approve/reject/legacy action). Approval status is
  // a separate concept from provider-mutation permission — approve/reject
  // only ever update the approval record; the canonical
  // GoogleCapabilityExecutionPipeline re-validates everything downstream.
  {
    const approvalsResult = handleApprovalsRoutes(method, pathname, body, headers, {}, { googleCalendarService, gmailService, auditLogger, taskContinuationCoordinator, tenantId, principal, modelErrorResult });
    if (approvalsResult) return approvalsResult;
  }

  // R10.2-D Increment 4 — Google OAuth start/start-url (browser-redirect
  // and JSON-URL variants). /callback, /status, /disconnect stay in
  // handleAsyncApiRequest (see handleGoogleOAuthCallbackRoutes above).
  {
    const googleOAuthStartResult = handleGoogleOAuthStartRoutes(method, pathname, body, headers, {}, {});
    if (googleOAuthStartResult) return googleOAuthStartResult;
  }

  {
    const settingsResult = handleSettingsRoutes(method, pathname, body, headers, {}, {});
    if (settingsResult) return settingsResult;
  }

  // R10.2-D Increment 4 — Governance/billing (executions, billing, audit
  // logs). executions POST is the one real ADMIN/SYSTEM mutation here
  // (PDP-authorized agent execution + credit charge).
  {
    const governanceResult = handleGovernanceRoutes(method, pathname, body, headers, {}, { pdp, runtime, auditLogger, creditEngine, tenantId, tenantContext, principal });
    if (governanceResult) return governanceResult;
  }
  // ─── MASTER.md Section 14.6 — Main Session + Tasks Foundation ───
  // NOTE: workspace/route-input, workspace/vault, workspace/inbox are handled
  // in handleAsyncApiRequest (async). They cannot appear here (sync fallback)
  // because getVaultSummary() returns a Promise that would be returned raw.


  if (pathname === '/api/v1/sessions/main' && method === 'GET') {
    const session = sessionStore.getOrCreateMain(tenantId, principal.id);
    return { status: 200, data: session };
  }

  // R10.2-D Increment 3 — Task CRUD/lifecycle (list/create/runs/pause/
  // resume/cancel/delete/patch/get). /run itself is SCHEDULER_MUTATION and
  // stays in handleAsyncApiRequest (see handleTasksRunRoutes above), since
  // it must await a real TaskScheduler.runOne().
  {
    const tasksResult = handleTasksRoutes(method, pathname, body, headers, {}, { taskStore, taskRunStore, sessionStore, auditLogger, tenantId, principal, modelErrorResult });
    if (tasksResult) return tasksResult;
  }

  // R10.2-D Increment 3 — Automation (WorkflowDefinition) CRUD. A
  // WorkflowDefinition is a reusable description/template only — never an
  // execution engine. /run itself stays in handleAsyncApiRequest (see
  // handleAutomationsRunRoutes above), since it must await the real
  // instantiate/run bridge.
  {
    const automationsResult = handleAutomationsRoutes(method, pathname, body, headers, {}, { workflowDefinitionService, tenantId, principal, modelErrorResult });
    if (automationsResult) return automationsResult;
  }

  return { status: 404, data: { error: 'ENDPOINT_NOT_FOUND', message: `${method} ${pathname}` } };
}

export function createServerInstance(): http.Server {
  return http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${PORT}`);
    const pathname = url.pathname;
    const method = (req.method || 'GET').toUpperCase();

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-NAgex-Tenant, X-Principal-Id, X-Request-Id');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'UP', service: 'NAgex Personal AI Platform API', version: '0.1.0' }));
      return;
    }

    if (pathname.startsWith('/api/')) {
      const bodyChunks: Buffer[] = [];
      req.on('data', (chunk) => bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      req.on('end', async () => {
        let parsedBody: Record<string, unknown> | null = null;
        const rawBuffer = Buffer.concat(bodyChunks);
        const contentType = (req.headers['content-type'] || '').toLowerCase();
        if (contentType.includes('application/json') || (!contentType && rawBuffer.length > 0 && (rawBuffer[0] === 0x7b || rawBuffer[0] === 0x5b))) {
          try {
            if (rawBuffer.length > 0) parsedBody = JSON.parse(rawBuffer.toString('utf8'));
          } catch {
            /* ignore */
          }
        } else if (rawBuffer.length > 0) {
          const filename = (req.headers['x-filename'] as string) || url.searchParams.get('filename') || 'upload.bin';
          parsedBody = {
            filename,
            mimeType: contentType || 'application/octet-stream',
            data: rawBuffer,
          };
        }
        const query = Object.fromEntries(url.searchParams);
        const result = await handleAsyncApiRequest(method, pathname, parsedBody, req.headers, aiService, query);
        if (result.redirectTo) {
          res.writeHead(result.status, { Location: result.redirectTo });
          res.end();
          return;
        }
        res.writeHead(result.status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result.data, null, 2));
      });
      return;
    }

    const relativePath = pathname === '/' ? 'index.html' : (CLEAN_URL_ALIASES[pathname] || pathname.replace(/^\/+/, ''));
    const filePath = path.resolve(PUBLIC_DIR, relativePath);
    if (filePath !== PUBLIC_DIR && !filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', ...NO_CACHE_HEADERS });
      res.end('Forbidden');
      return;
    }
    const extname = path.extname(filePath);
    const contentType = mimeTypes[extname] || 'application/octet-stream';

    fs.readFile(filePath, (error, content) => {
      if (error) {
        if (error.code === 'ENOENT') {
          res.writeHead(404, { 'Content-Type': 'text/html' });
          res.end('<h1>404 Not Found</h1>', 'utf-8');
        } else {
          res.writeHead(500);
          res.end(`Server Error: ${error.code}`);
        }
      } else {
        const headers: Record<string, string> = { 'Content-Type': contentType };
        if (pathname === '/' || MUTABLE_FRONTEND_FILES.has(relativePath)) {
          Object.assign(headers, NO_CACHE_HEADERS);
        }

        if (VERSIONED_HTML_FILES.has(relativePath)) {
          const versionedHtml = content
            .toString('utf8')
            .replaceAll(BUILD_VERSION_PLACEHOLDER, FRONTEND_BUILD_VERSION);
          res.writeHead(200, headers);
          res.end(versionedHtml, 'utf-8');
          return;
        }

        res.writeHead(200, headers);
        res.end(content);
      }
    });
  });
}

export const server = createServerInstance();

export async function withTestServer(run: (origin: string) => Promise<void>): Promise<void> {
  const instance = createServerInstance();
  await new Promise<void>((resolve, reject) => {
    instance.listen(0, '127.0.0.1', () => resolve());
    instance.once('error', reject);
  });
  const addr = instance.address() as import('node:net').AddressInfo;
  try {
    await run(`http://127.0.0.1:${addr.port}`);
  } finally {
    if (typeof (instance as any).closeIdleConnections === 'function') {
      (instance as any).closeIdleConnections();
    }
    await new Promise<void>((resolve) => instance.close(() => resolve()));
  }
}

// DC3-B1-R1-R1 — extracted from the require.main-only block below so an
// embedder (desktop-app.ts's Electron main process) can start the real
// server and genuinely AWAIT it actually listening, rather than relying
// on `require.main === module` (which is false when this module is
// imported as a dependency, not run directly — the real root cause of
// the Quick Wake ERR_CONNECTION_REFUSED bug: `await import('../server_web.js')`
// only evaluated this module, it never reached this block at all, so
// nothing was ever listening). Idempotent: calling this twice in one
// process throws rather than silently double-registering lifecycle hooks
// or double-binding the port.
let nagexServerStarted = false;

export async function startNagexServer(): Promise<{ server: http.Server }> {
  if (nagexServerStarted) {
    throw new Error('startNagexServer() was already called once in this process.');
  }
  nagexServerStarted = true;

  const HOST = process.env.HOST || '127.0.0.1';
  let serverInstance: http.Server;
  let schedulerIntervalHandle: NodeJS.Timeout | null = null;

  // Phase 02 — every process-lifetime resource is registered with
  // app.lifecycle instead of started/stopped by ad hoc inline code.
  // Registration order (browser-runtime, task-scheduler-interval,
  // http-server) is chosen so LifecycleManager's default reverse-order
  // stopAll() reproduces the exact, already-Linux-verified stop order this
  // block used before Phase 02: HTTP server closed and awaited first,
  // then the scheduler interval cleared, then the browser runtime shut
  // down — see the Phase 02 pre-flight report for the full rationale.
  // Forward startAll() order (scheduler before HTTP listen) also matches
  // this file's real pre-Phase-02 evaluation order.
  lifecycle.register({
    name: 'browser-runtime',
    stop: async () => {
      await browserRuntime.shutdown();
      console.log('[server_web] Browser runtime shut down cleanly.');
    },
  });

  // P03 — runs once, before the scheduler interval starts ticking any new
  // work, and resumes every run this process's previous life left
  // genuinely mid-flight (status RUNNING in DurableTaskRunStateStore — a
  // WAITING_APPROVAL run is untouched, it already has its own event-
  // triggered resume path). See durable-task-runtime.ts for the full
  // crash-window/delivery-guarantee analysis.
  lifecycle.register({
    name: 'durable-task-run-recovery',
    start: async () => {
      const { recovered, failed } = await durableTaskRuntime.recoverOnStartup();
      if (recovered > 0 || failed > 0) {
        console.log(JSON.stringify({ event: 'durable_task_run_recovery_completed', recovered, failed }));
      }
    },
    stop: () => {}, // one-time startup action — nothing to tear down
  });

  lifecycle.register({
    name: 'task-scheduler-interval',
    start: () => {
      schedulerIntervalHandle = setInterval(() => {
        taskScheduler.tick().catch((error) => {
          console.error(JSON.stringify({ event: 'task_scheduler_tick_failed', message: error instanceof Error ? error.message : String(error) }));
        });
      }, TASK_SCHEDULER_TICK_MS);
      schedulerIntervalHandle.unref();
    },
    stop: () => {
      if (schedulerIntervalHandle) clearInterval(schedulerIntervalHandle);
    },
  });

  lifecycle.register({
    name: 'http-server',
    // GATEWAY_LISTEN_ERROR_PROPAGATES — a real bind failure (e.g. the
    // port already in use) previously had no error listener at all here:
    // the promise would never resolve OR reject, hanging forever rather
    // than surfacing the failure. `once('error', reject)` is what makes a
    // real startup failure — via startNagexServer() — a caller can
    // actually catch, instead of an indefinite silent hang.
    start: () => new Promise<void>((resolve, reject) => {
      serverInstance = server.listen(PORT, HOST, () => {
        console.log(`\n═══════════════════════════════════════════════════════`);
        console.log(`  NAgex Personal AI — Unified Platform Server`);
        console.log(`  Console:  http://${HOST}:${PORT}`);
        console.log(`  API:      http://${HOST}:${PORT}/api/v1/health`);
        console.log(`  Engine:   Durable Runtime + Memory + PDP + Audit`);
        console.log(`═══════════════════════════════════════════════════════\n`);
        resolve();
      });
      serverInstance.once('error', reject);
    }),
    stop: () =>
      new Promise<void>((resolve, reject) => {
        serverInstance.close((err) => {
          if (err) {
            console.error('[server_web] HTTP shutdown error:', err);
            reject(err);
            return;
          }
          console.log('[server_web] HTTP server stopped accepting connections.');
          resolve();
        });

        if (typeof serverInstance.closeIdleConnections === 'function') {
          serverInstance.closeIdleConnections();
        }
      }),
  });

  // The real fix: genuinely AWAITED. The http-server lifecycle hook's own
  // start() only resolves once server.listen()'s callback actually fires
  // (real "now listening" confirmation, not a guess) — awaiting
  // lifecycle.startAll() here is what makes startNagexServer()'s own
  // returned promise a trustworthy readiness signal for any caller,
  // embedded or direct.
  await lifecycle.startAll();

  // Production graceful shutdown lifecycle. Playwright's own SIGTERM
  // handling (registered when the browser launches) suppresses Node's
  // default "no listeners -> exit" behavior, and without an
  // application-owned shutdown path the live HTTP server + process-lifetime
  // browserRuntime singleton stayed open indefinitely, forcing systemd to
  // SIGKILL after its 90s TimeoutStopSec. app.lifecycle.stopAll() now owns
  // the deterministic stop order and guarantees every resource's stop() is
  // attempted even if an earlier one fails (a real gap in the pre-Phase-02
  // inline version, where one throw skipped all later cleanup). Idempotent
  // via shuttingDown (systemd/an operator may send more than one signal —
  // this guard is what keeps the "Received X" log line itself to exactly
  // once; LifecycleManager.stopAll() is independently idempotent too, as
  // defense in depth for any other future caller). No process.exit() on
  // this path — systemd's own TimeoutStopSec/KillSignal remains the sole
  // final safety boundary.
  let shuttingDown = false;

  const performShutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server_web] Received ${signal}. Starting graceful shutdown...`);

    try {
      await lifecycle.stopAll();
    } catch (error) {
      console.error('[server_web] Error during shutdown:', error);
    } finally {
      console.log('[server_web] Graceful shutdown complete.');
    }
  };

  process.on('SIGTERM', () => void performShutdown('SIGTERM'));
  process.on('SIGINT', () => void performShutdown('SIGINT'));

  return { server: serverInstance! };
}

// Preserves the exact existing direct-run behavior (`node dist/src/server_web.js`,
// the real systemd/production path) unchanged — fire-and-forget at this
// call site, exactly as before; the only real difference is that
// lifecycle.startAll() is now properly awaited INSIDE startNagexServer()
// rather than fire-and-forget itself, which is strictly more correct
// sequencing, never a behavior regression for this path (nothing here
// ever depended on this expression's own promise).
if (require.main === module) {
  void startNagexServer();
}

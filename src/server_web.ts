import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { handleHealthRoutes, type HealthRouteDeps } from './http/routes/health.routes.js';

// ─── NAgex Core Engine Imports ───
import { NagexError } from './common/errors.js';
import type { TenantContext, PrincipalReference } from './common/types.js';
import { AiService } from './model-gateway/ai-service.js';
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
import { handleProvidersRoutes } from './http/routes/providers.routes.js';
import { handleSafetyRoutes } from './http/routes/safety.routes.js';
import { handleConversationRoutes, handleSessionRoutes } from './http/routes/conversation.routes.js';
import { handleDailyBriefRoutes } from './http/routes/daily-brief.routes.js';
import { handlePersonalAssistantRoutes } from './http/routes/personal-assistant.routes.js';
import { handleCapabilitiesRoutes } from './http/routes/capabilities.routes.js';
import { handleMySpaceRoutes } from './http/routes/my-space.routes.js';
import { handleDeviceAgentRoutes } from './http/routes/device-agent.routes.js';
import { handleAuthRoutes } from './http/routes/auth.routes.js';
import { handleSocialAuthRoutes } from './http/routes/social-auth.routes.js';
import { handleAccountRoutes } from './http/routes/account.routes.js';
import { handleOrganizationRoutes } from './http/routes/organization.routes.js';
import { handleRbacRoutes } from './http/routes/rbac.routes.js';
import { handleEnterpriseIdentityRoutes } from './http/routes/enterprise-identity.routes.js';
import { handleScimRoutes } from './http/routes/scim.routes.js';
import { handleCreationRoutes } from './http/routes/creation.routes.js';
import { handleInboxRoutes } from './http/routes/inbox.routes.js';
import { handleVaultRoutes } from './http/routes/vault.routes.js';
import { handleConnectionsRoutes } from './http/routes/connections.routes.js';
import { handleActionsRoutes } from './http/routes/actions.routes.js';
import type { GoogleCalendarService } from './modules/calendar/index.js';
import type { GmailService } from './modules/gmail/index.js';
import { BrowserToolService, browserRuntime } from './modules/browser/index.js';
import type { ConversationStore } from './conversations/conversation.store.js';
import type { ConversationContextService } from './conversations/conversation-context.service.js';
import type { TelegramService } from './integrations/telegram/telegram.service.js';
import type { SlackService } from './integrations/slack/slack.service.js';
import { NotificationEngine } from './notifications/notification.engine.js';
import type { IdentityStore } from './identity/identity.store.js';
import type { IdentityTokenStore } from './identity/identity.tokens.js';
import type { IdentityAuditStore } from './identity/identity.audit.js';
import type { SessionStore } from './sessions/session.store.js';
import type { OrganizationStore } from './organizations/organization.store.js';
import type { RbacStore } from './rbac/rbac.store.js';
import type { RbacService } from './rbac/rbac.service.js';
import type { EnterpriseIdentityStore } from './enterprise-identity/enterprise-identity.store.js';
import type { SsoFlowStore } from './enterprise-identity/sso-flow.store.js';
import { createNagexApplication } from './app/create-nagex-application.js';

const PORT = Number(process.env.PORT || 8085);
const PUBLIC_DIR = path.join(process.cwd(), 'public');
const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
  Expires: '0',
} as const;
const MUTABLE_FRONTEND_FILES = new Set(['index.html', 'style.css', 'app.js', 'i18n.js', 'auth-ui.js', 'org-ui.js', 'rbac-ui.js', 'enterprise-identity-ui.js', 'intent-interaction-state.js', 'plan-resolution-view.js', 'calendar-approval-view.js', 'calendar-intent-extraction.js', 'calendar-payload-validation.js', 'gmail-approval-view.js', 'gmail-intent-extraction.js', 'browser-approval-view.js', 'browser-intent-extraction.js', 'modal-behavior.js', 'timeline-dedupe.js', 'single-flight-guard.js', 'legal.js', 'daily-brief.js', 'proactive-assistant.js', 'meeting-prep-view.js', 'hero-brief.js', 'privacy.html', 'terms.html', 'desktop-quickwake.html', 'desktop-quickwake.css', 'desktop-quickwake.js', 'shared/tokens.css', 'shared/components.css', 'desktop/desktop-home.css', 'desktop/desktop-home.js', 'mobile/mobile-home.css', 'mobile/mobile-home.js', 'mobile/mobile-inbox.css', 'mobile/mobile-inbox.js', 'mobile/mobile-activity.css', 'mobile/mobile-activity.js', 'mobile/mobile-vault.css', 'mobile/mobile-vault.js', 'mobile/mobile-settings.css', 'mobile/mobile-settings.js']);
const VERSIONED_HTML_FILES = new Set(['index.html', 'privacy.html', 'terms.html', 'desktop-quickwake.html']);
const CLEAN_URL_ALIASES: Record<string, string> = { '/privacy': 'privacy.html', '/terms': 'terms.html', '/quickwake': 'desktop-quickwake.html' };
const BUILD_VERSION_PLACEHOLDER = '__NAGEX_BUILD_VERSION__';

function createBuildVersion(): string {
  const hash = crypto.createHash('sha256');
  for (const filename of ['style.css', 'i18n.js', 'auth-ui.js', 'org-ui.js', 'rbac-ui.js', 'enterprise-identity-ui.js', 'intent-interaction-state.js', 'plan-resolution-view.js', 'calendar-approval-view.js', 'calendar-intent-extraction.js', 'calendar-payload-validation.js', 'gmail-approval-view.js', 'gmail-intent-extraction.js', 'browser-approval-view.js', 'browser-intent-extraction.js', 'modal-behavior.js', 'timeline-dedupe.js', 'single-flight-guard.js', 'legal.js', 'daily-brief.js', 'proactive-assistant.js', 'meeting-prep-view.js', 'hero-brief.js', 'app.js', 'shared/tokens.css', 'shared/components.css', 'desktop/desktop-home.css', 'desktop/desktop-home.js', 'mobile/mobile-home.css', 'mobile/mobile-home.js', 'mobile/mobile-inbox.css', 'mobile/mobile-inbox.js', 'mobile/mobile-activity.css', 'mobile/mobile-activity.js', 'mobile/mobile-vault.css', 'mobile/mobile-vault.js', 'mobile/mobile-settings.css', 'mobile/mobile-settings.js']) {
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
  identityStore,
  identityTokenStore,
  identityAuditStore,
  organizationStore,
  rbacStore,
  rbacService,
  enterpriseIdentityStore,
  ssoFlowStore,
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
  creationStore,
  creationService,
  inboxStore,
  vaultStore,
  connectionStore,
  actionStore,
  actionEngine,
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

// R10.2-D Increment 5 — Daily Brief/Proactive Assistant generation,
// change-detection, and config serialization all moved to
// src/http/routes/daily-brief.routes.ts (its only consumer domain).

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
// R10.2-D Increment 5 — getHeaderValue moved into each route module as
// its own local copy (established pattern since Increment 1); no route
// body remains here that needs it.

// V01a-R1 — timing-safe token comparison for the test-only fixed-plan
// injection route moved to src/http/routes/tasks.routes.ts (its only
// consumer, POST /api/v1/tasks/:id/run-with-fixed-plan).

// getRelevantMemories/MEMORY_RELEVANCE_STOPWORDS moved into
// createNagexApplication() (see app.getRelevantMemories, destructured
// above) — it is a genuine construction-time dependency of
// taskRunner/telegramService/slackService there.

type ApiResult = { status: number; data: unknown; redirectTo?: string; headers?: Record<string, string> };

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
  customDeps?: {
    identityStore?: IdentityStore;
    identityTokenStore?: IdentityTokenStore;
    identityAuditStore?: IdentityAuditStore;
    sessionStore?: SessionStore;
    organizationStore?: OrganizationStore;
    rbacStore?: RbacStore;
    rbacService?: RbacService;
    enterpriseIdentityStore?: EnterpriseIdentityStore;
    ssoFlowStore?: SsoFlowStore;
  }
): Promise<ApiResult> {
  try {
    const demoHeader = headers['x-nagex-demo'] ?? headers['X-NAgex-Demo'];
    const demoEnabled = (Array.isArray(demoHeader) ? demoHeader[0] : demoHeader) === '1';
    if (demoEnabled) {
      let sessionCookie: string | undefined;
      const cookieHeader = headers['cookie'] ?? headers['Cookie'];
      const rawCookie = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
      if (rawCookie) {
        const match = rawCookie.match(/(?:^|;\s*)nagex_demo_session=([^;]+)/);
        if (match) sessionCookie = decodeURIComponent(match[1]);
      }
      const headerSession = headers['x-nagex-demo-session'] ?? headers['X-NAgex-Demo-Session'] ?? headers['x-demo-session'];
      const rawHeaderSession = Array.isArray(headerSession) ? headerSession[0] : headerSession;
      let effectiveSession = rawHeaderSession || sessionCookie;
      let newCookieSet = false;
      if (!effectiveSession) {
        effectiveSession = `demo_sess_${crypto.randomUUID()}`;
        newCookieSet = true;
      }
      const reqHeaders = { ...headers, 'x-nagex-demo-session': effectiveSession };
      const demoResult = app.demoScenarioService.handle(method, pathname, body, reqHeaders);
      if (demoResult) {
        if (newCookieSet) {
          demoResult.headers = {
            ...(demoResult.headers || {}),
            'Set-Cookie': `nagex_demo_session=${encodeURIComponent(effectiveSession)}; Path=/; SameSite=Lax`
          };
        }
        return demoResult;
      }
    }
    // R13 Identity & Account Lifecycle routes
    {
      const socialAuthResult = await handleSocialAuthRoutes(method, pathname, body, headers, query, { identityStore: customDeps?.identityStore ?? identityStore, socialIdentityStore: app.socialIdentityStore, sessionStore: customDeps?.sessionStore ?? sessionStore });
      if (socialAuthResult) return socialAuthResult;
    }
    {
      const authResult = await handleAuthRoutes(method, pathname, body, headers, query, {
        identityStore: customDeps?.identityStore ?? identityStore,
        identityTokenStore: customDeps?.identityTokenStore ?? identityTokenStore,
        identityAuditStore: customDeps?.identityAuditStore ?? identityAuditStore,
        sessionStore: customDeps?.sessionStore ?? sessionStore,
      });
      if (authResult) return authResult;
    }
    {
      const accountResult = await handleAccountRoutes(method, pathname, body, headers, query, {
        identityStore: customDeps?.identityStore ?? identityStore,
        identityTokenStore: customDeps?.identityTokenStore ?? identityTokenStore,
        identityAuditStore: customDeps?.identityAuditStore ?? identityAuditStore,
        sessionStore: customDeps?.sessionStore ?? sessionStore,
      });
      if (accountResult) return accountResult;
    }
    {
      const orgResult = await handleOrganizationRoutes(method, pathname, body, headers, query, {
        organizationStore: customDeps?.organizationStore ?? organizationStore,
        identityStore: customDeps?.identityStore ?? identityStore,
        identityAuditStore: customDeps?.identityAuditStore ?? identityAuditStore,
        sessionStore: customDeps?.sessionStore ?? sessionStore,
      });
      if (orgResult) return orgResult;
    }
    {
      const rbacResult = await handleRbacRoutes(method, pathname, body, headers, query, {
        rbacService: customDeps?.rbacService ?? rbacService,
        organizationStore: customDeps?.organizationStore ?? organizationStore,
        identityStore: customDeps?.identityStore ?? identityStore,
        sessionStore: customDeps?.sessionStore ?? sessionStore,
      });
      if (rbacResult) return rbacResult;
    }
    {
      // R16 — publicBaseUrl is derived per-request from the Host header
      // (never a fixed constant) since every test spins up its own
      // in-process server on an OS-assigned ephemeral port, and OIDC
      // redirect_uri / SAML ACS URL / entityId must exactly match the
      // origin the browser is actually talking to.
      const hostHeader = Array.isArray(headers['host']) ? headers['host'][0] : headers['host'];
      const publicBaseUrl = `http://${hostHeader ?? '127.0.0.1'}`;
      const enterpriseIdentityResult = await handleEnterpriseIdentityRoutes(method, pathname, body, headers, query, {
        rbacService: customDeps?.rbacService ?? rbacService,
        organizationStore: customDeps?.organizationStore ?? organizationStore,
        identityStore: customDeps?.identityStore ?? identityStore,
        sessionStore: customDeps?.sessionStore ?? sessionStore,
        rbacStore: customDeps?.rbacStore ?? rbacStore,
        enterpriseIdentityStore: customDeps?.enterpriseIdentityStore ?? enterpriseIdentityStore,
        ssoFlowStore: customDeps?.ssoFlowStore ?? ssoFlowStore,
        auditLogger,
        fetchFn: fetch,
        publicBaseUrl,
      });
      if (enterpriseIdentityResult) return enterpriseIdentityResult;

      const scimResult = await handleScimRoutes(method, pathname, body, headers, query, {
        identityStore: customDeps?.identityStore ?? identityStore,
        organizationStore: customDeps?.organizationStore ?? organizationStore,
        sessionStore: customDeps?.sessionStore ?? sessionStore,
        rbacStore: customDeps?.rbacStore ?? rbacStore,
        enterpriseIdentityStore: customDeps?.enterpriseIdentityStore ?? enterpriseIdentityStore,
        auditLogger,
      });
      if (scimResult) return scimResult;
    }

    // R10.2-D Increment 5 — Model provider status/health-check routes.
    {
      const providersResult = await handleProvidersRoutes(method, pathname, body, headers, query, { service });
      if (providersResult) return providersResult;
    }

    // R10.2-D Increment 5 — Trust & Safety Layer routes (TS-5, TS-6).
    {
      const safetyResult = await handleSafetyRoutes(method, pathname, body, headers, query, {});
      if (safetyResult) return safetyResult;
    }
    {
      const healthResult = handleHealthRoutes(method, pathname, body, headers, query, healthRouteDeps);
      if (healthResult) return healthResult;
    }
    // R10.2-D Increment 5 — Main Session / conversational core
    // (conversations/main GET/POST-messages/DELETE, ai/chat, ambient/
    // intent, plans/resolve).
    {
      const conversationResult = await handleConversationRoutes(method, pathname, body, headers, query, { service, planResolver, sessionStore, convStore, convContextService, auditLogger, getRelevantMemories });
      if (conversationResult) return conversationResult;
    }
    // R10.2-D Increment 4 — Google OAuth callback/status/disconnect.
    {
      const googleOAuthResult = await handleGoogleOAuthCallbackRoutes(method, pathname, body, headers, query, { auditLogger });
      if (googleOAuthResult) return googleOAuthResult;
    }
    // R10.2-D Increment 3 — all Workspace/Capture/Candidate/Activity routes
    // (route-input, storage/status, inbox, vault, uploads, captures, items,
    // candidates, activity) now resolve through one registrar call.
    {
      const workspaceResult = await handleWorkspaceRoutes(method, pathname, body, headers, query, { quickCaptureService });
      if (workspaceResult) return workspaceResult;
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

    // R10.2-D Increment 5 — Capability Broker execution route. Already
    // exactly the canonical execution boundary (HTTP -> CapabilityBroker.
    // execute()); this move relocates the HTTP translation only.
    {
      const capabilitiesResult = await handleCapabilitiesRoutes(method, pathname, body, headers, query, { capabilityBroker, modelErrorResult });
      if (capabilitiesResult) return capabilitiesResult;
    }

    // R10.2-D Increment 5 — My Space read-only aggregation (P08).
    {
      const mySpaceResult = await handleMySpaceRoutes(method, pathname, body, headers, query, { activityStore, memoryEngine, taskStore, taskRunStore, workflowDefinitionService, calendarService });
      if (mySpaceResult) return mySpaceResult;
    }

    // R10.2-D Increment 5 — Daily Brief generation/read/history, extracted
    // to daily-brief.routes.ts along with all its helper functions
    // (buildBriefResponse/computeBriefFreshness/safeListPendingApprovals/
    // countImportantChangesForDate) — generation itself still goes
    // through the same generateDailyBriefOnce()/detectMeaningfulChanges/
    // dispatchDetectedChanges/generateProposalsFromChanges pipeline,
    // untouched.
    {
      const dailyBriefResult = await handleDailyBriefRoutes(method, pathname, body, headers, query, { service, calendarService, gmailApiService, dailyBriefStore, actionProposalStore, actionApprovals, activityStore, notificationEngine, taskStore });
      if (dailyBriefResult) return dailyBriefResult;
    }

    {
      const personalAssistantResult = await handlePersonalAssistantRoutes(method, pathname, body, headers, query, {
        reminderStore: app.personalReminderStore,
        assistantEngine: app.personalAssistantEngine,
      });
      if (personalAssistantResult) return personalAssistantResult;
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

    // R10.2-D Increment 5 — Device Agent outbound transport route.
    {
      const deviceAgentResult = await handleDeviceAgentRoutes(method, pathname, body, headers, query, { deviceAgentTransportEndpoint });
      if (deviceAgentResult) return deviceAgentResult;
    }

    // R17 — Creation Routes (generate, variation, list, get)
    {
      const creationResult = await handleCreationRoutes(method, pathname, body, headers, query, { creationService });
      if (creationResult) return creationResult;
    }

    // R18 — Inbox Routes
    {
      const inboxResult = await handleInboxRoutes(method, pathname, body, headers, query, { inboxStore, vaultStore });
      if (inboxResult) return inboxResult;
    }

    // R18 — Vault Routes
    {
      const vaultResult = await handleVaultRoutes(method, pathname, body, headers, query, { vaultStore });
      if (vaultResult) return vaultResult;
    }

    // R18 — Connected Apps / Connections Routes
    {
      const connectionsResult = await handleConnectionsRoutes(method, pathname, body, headers, query, { connectionStore });
      if (connectionsResult) return connectionsResult;
    }

    // R19 — Action & Approval Integration Routes
    {
      const actionsResult = await handleActionsRoutes(method, pathname, body, headers, query, { actionStore, actionEngine });
      if (actionsResult) return actionsResult;
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
    const approvalsResult = handleApprovalsRoutes(method, pathname, body, headers, {}, { googleCalendarService, gmailService, actionApprovals, auditLogger, taskContinuationCoordinator, tenantId, principal, modelErrorResult });
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


  // R10.2-D Increment 5 — Main Session GET (the sync-entry-point half of
  // conversation.routes.ts; the async conversation routes are wired above).
  {
    const sessionResult = handleSessionRoutes(method, pathname, body, headers, {}, { sessionStore, tenantId, principal });
    if (sessionResult) return sessionResult;
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

export function createServerInstance(opts?: {
  identityStore?: IdentityStore;
  identityTokenStore?: IdentityTokenStore;
  identityAuditStore?: IdentityAuditStore;
  sessionStore?: SessionStore;
  organizationStore?: OrganizationStore;
  rbacStore?: RbacStore;
  rbacService?: RbacService;
}): http.Server {
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

    // R16 — SCIM 2.0 routes (/scim/v2/Users, /scim/v2/Groups) deliberately
    // live outside /api/ per the SCIM protocol convention (a SCIM client is
    // configured with a base URL, not an app-specific API prefix). Without
    // this second prefix, those routes were structurally unreachable —
    // every request fell through to the static file server and 404'd.
    if (pathname.startsWith('/api/') || pathname.startsWith('/scim/')) {
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
        const result = await handleAsyncApiRequest(
          method,
          pathname,
          parsedBody,
          req.headers,
          aiService,
          query,
          googleCalendarService,
          gmailService,
          browserService,
          telegramService,
          slackService,
          notificationEngine,
          conversationStore,
          conversationContextService,
          opts
        );
        if (result.redirectTo) {
          // R16 — found while wiring the OIDC/SAML login callbacks, which
          // are the first callers to ever combine a redirect with a
          // Set-Cookie header (e.g. Google OAuth's own redirect-only
          // callback never sets a session cookie on the redirect itself).
          // result.headers must be honored here exactly like the non-
          // redirect branch below already does, or any future redirect+
          // cookie response silently drops the cookie.
          res.writeHead(result.status, { Location: result.redirectTo, ...(result.headers || {}) });
          res.end();
          return;
        }
        const outHeaders: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' };
        if (result.headers) {
          Object.assign(outHeaders, result.headers);
        }
        res.writeHead(result.status, outHeaders);
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

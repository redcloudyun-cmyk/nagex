// Phase 01 — Composition Root Refactoring.
//
// Moves server_web.ts's inline production object construction here,
// unchanged. This is the ONLY place the main application object graph is
// built — server_web.ts calls createNagexApplication() once at its own
// module scope (the exact same timing as before: synchronous, at import
// time) and destructures what it needs from the result.
//
// Deliberately NOT touched in this phase (per the governing directive):
// - browserRuntime, browserSessionStore, googleTokenStore, captureStore,
//   canonicalSkillRegistry, canonicalToolRegistry, capabilityRegistry stay
//   separate, pre-existing module singletons — imported here the same way
//   server_web.ts already imported them, not constructed or owned here.
// - HTTP server start and the scheduler setInterval stay in server_web.ts,
//   gated behind require.main === module — this function only constructs
//   objects, it never starts the server, a browser, an interval, or an
//   external call.
import { PolicyDecisionPoint } from '../identity/pdp.js';
import { DurableRuntimeEngine } from '../runtime/runtime.engine.js';
import { AuditLogger } from '../governance/audit.logger.js';
import { BillingLedgerEngine } from '../billing/billing.ledger.js';
import { CreditEngine } from '../billing/credit.engine.js';
import { MemoryEngine, type MemoryRecord, type MemoryScope } from '../context/memory.engine.js';
import { AiService } from '../model-gateway/ai-service.js';
import { createProviders } from '../model-gateway/providers.js';
import { UnifiedModelRouter } from '../model-gateway/unified-model-router.js';
import { skillRegistry as canonicalSkillRegistry } from '../skills/skill-registry.js';
import { toolRegistry as canonicalToolRegistry } from '../tools/tool-registry.js';
import { PlanResolver } from '../planning/plan-resolver.js';
import { PersistentActionApprovalStore } from '../governance/action-approval.store.js';
import { ExecutionStore } from '../governance/execution.store.js';
import { GoogleCalendarService } from '../modules/calendar/index.js';
import { GmailService } from '../modules/gmail/index.js';
import { BrowserToolService, browserRuntime, browserSessionStore } from '../modules/browser/index.js';
import { DeviceExecutionSessionStore } from '../device-control/device-execution-session.store.js';
import { DeviceControlService } from '../device-control/device-control.service.js';
import { AstraVisualExecutionModelAdapter } from '../device-control/astra-visual-execution-model.adapter.js';
import { DeviceIdentityStore } from '../device-agent/device-identity.store.js';
import { DesktopExecutionSessionStore } from '../device-agent/desktop-execution-session.store.js';
import { DeviceTransportSecurity } from '../device-agent/device-transport-security.js';
import { DeviceConnectionStatusStore } from '../device-agent/device-connection-status.store.js';
import { DevicePendingCommandStore } from '../device-agent/device-pending-command.store.js';
import { DeviceAgentTransportEndpoint } from '../device-agent/device-agent-transport-endpoint.service.js';
import { DesktopAppAllowlist } from '../device-agent/desktop-app-allowlist.js';
import { WindowsIsolatedDesktopController } from '../device-agent/windows-isolated-desktop-controller.js';
import { DesktopActivityAdapter } from '../device-agent/desktop-activity-adapter.js';
import { DesktopControlService } from '../device-agent/desktop-control.service.js';
import { googleTokenStore } from '../integrations/google/token.store.js';
import { readGoogleOAuthConfig } from '../integrations/google/oauth.client.js';
import { SessionStore } from '../sessions/session.store.js';
import { ConversationStore } from '../conversations/conversation.store.js';
import { ConversationContextService } from '../conversations/conversation-context.service.js';
import { TaskStore } from '../tasks/task.store.js';
import { TaskRunStore } from '../tasks/task-run.store.js';
import { TaskScheduler } from '../tasks/task.scheduler.js';
import { PlanPreviewTaskRunner, ConditionalWatchTaskRunner, BackgroundTaskRunner, CompositeTaskRunner, ExecutingTaskRunner, DailyBriefTaskRunner } from '../tasks/task.runner.js';
import { TaskContinuationStore } from '../tasks/task-continuation.store.js';
import { TaskContinuationCoordinator } from '../tasks/task-continuation.coordinator.js';
import { DurableTaskRunStateStore } from '../tasks/durable-task-run-state.store.js';
import { DurableTaskRuntime } from '../tasks/durable-task-runtime.js';
import { TelegramIdentityStore } from '../integrations/telegram/telegram-identity.store.js';
import { TelegramBotClient } from '../integrations/telegram/telegram.client.js';
import { TelegramService } from '../integrations/telegram/telegram.service.js';
import { SlackIdentityStore } from '../integrations/slack/slack-identity.store.js';
import { SlackClient } from '../integrations/slack/slack.client.js';
import { SlackService } from '../integrations/slack/slack.service.js';
import { NotificationStore } from '../notifications/notification.store.js';
import { NotificationEngine } from '../notifications/notification.engine.js';
import { DesktopRuntimeEngine } from '../desktop/desktop-runtime.engine.js';
import { captureStore } from '../workspace/capture.store.js';
import { QuickCaptureService } from '../workspace/quick-capture.service.js';
import { InputRouter } from '../workspace/input-router.js';
import { CandidateStore } from '../workspace/candidate.store.js';
import { WorkflowDefinitionStore } from '../workflows/workflow-definition.store.js';
import { WorkflowDefinitionService } from '../workflows/workflow-definition.service.js';
import { CandidateActionResolver } from '../workspace/action-resolver.js';
import { ActivityStore } from '../governance/activity.store.js';
import { DailyBriefStore } from '../governance/daily-brief.store.js';
import { ActionProposalStore } from '../assistant/action-proposal.store.js';
import { createConfiguredStorageProvider } from '../storage/s3-storage.provider.js';
import { KnowledgeEngine } from '../context/knowledge.engine.js';
import { CapabilityBroker, capabilityRegistry } from '../capabilities/index.js';
import { ModuleRegistry, ModuleStateStore, ModuleService } from '../modules/index.js';
import type { NagexApplication } from './nagex-application.js';
import { IdentityStore } from '../identity/identity.store.js';
import { IdentityTokenStore } from '../identity/identity.tokens.js';
import { IdentityAuditStore } from '../identity/identity.audit.js';
import { OrganizationStore } from '../organizations/organization.store.js';
import { LifecycleManager } from './lifecycle-manager.js';

// Common words that would otherwise create spurious "relevance" matches
// (e.g. a prompt's "and" matching a completely unrelated memory's "and").
// Deliberately small/explicit, not a general stopword library — this only
// needs to keep the memory-relevance signal from tripping on noise words.
const MEMORY_RELEVANCE_STOPWORDS = new Set([
  'and', 'the', 'for', 'with', 'to', 'of', 'in', 'on', 'my', 'a', 'an', 'is', 'it', 'this', 'that',
  'are', 'was', 'were', 'be', 'been', 'will', 'can', 'you', 'your', 'me', 'we', 'our', 'they', 'them',
  'but', 'or', 'if', 'not', 'no', 'do', 'does', 'did', 'have', 'has', 'had', 'from', 'as', 'at', 'by',
]);

export function createNagexApplication(): NagexApplication {
  // ─── Boot NAgex Core Engine ───
  const identityStore = new IdentityStore();
  const identityTokenStore = new IdentityTokenStore();
  const identityAuditStore = new IdentityAuditStore();
  const organizationStore = new OrganizationStore();
  const pdp = new PolicyDecisionPoint();
  const runtime = new DurableRuntimeEngine();
  const auditLogger = new AuditLogger();
  const billing = new BillingLedgerEngine();
  const creditEngine = new CreditEngine(billing);
  const memoryEngine = new MemoryEngine();
  const aiService = new AiService(new UnifiedModelRouter(createProviders()));
  const planResolver = new PlanResolver(canonicalSkillRegistry, canonicalToolRegistry);
  const actionApprovals = new PersistentActionApprovalStore({
    onExpired: (record) => auditLogger.logEvent({
      actor: { type: 'user', id: record.principalId },
      tenant_id: record.tenantId,
      action: 'approval.expired',
      resource: { type: 'ActionApproval', id: record.approvalId },
      result: 'DENIED',
      request_id: `req_appr_expired_${Date.now()}`,
    }),
  });
  const executionStore = new ExecutionStore();
  const googleCalendarService = new GoogleCalendarService(googleTokenStore, actionApprovals, auditLogger, memoryEngine, fetch, readGoogleOAuthConfig, executionStore);
  // Gmail as the second real external service — reuses the exact same shared
  // actionApprovals/executionStore/auditLogger/memoryEngine/googleTokenStore
  // singletons as Calendar. No separate approval architecture.
  const gmailService = new GmailService(googleTokenStore, actionApprovals, auditLogger, memoryEngine, fetch, readGoogleOAuthConfig, executionStore);
  // Browser Agent MVP — the third real capability, same shared approval store.
  // browser.click's dynamic (server-decides-per-click) shape is genuinely
  // different from Gmail/Calendar's client-composes-the-full-payload-upfront
  // approvals — see browser.service.ts's click()/executeApprovedClick() split
  // — but it consumes the identical ActionApprovalStore, replay-protected the
  // same way, and GET/approve/reject need no route changes here either.
  const browserService = new BrowserToolService(browserRuntime, browserSessionStore, actionApprovals, auditLogger, memoryEngine, executionStore);
  // DC1 — durable Device Control session store, real from day one.
  const deviceExecutionSessionStore = new DeviceExecutionSessionStore();
  // DC2 — the real VisualExecutionModelPort adapter. Constructed
  // unconditionally (cheap, no I/O at construction — mirrors
  // HttpModelProvider's own pattern), but deviceControlService below is
  // only constructed when it reports configured, so
  // isProviderAvailable('DEVICE') stays truthful: unconfigured ->
  // deviceControlService stays undefined -> DEVICE genuinely unavailable,
  // never a silent fallback to the test-only FakeVisualExecutionModelAdapter.
  const astraVisualExecutionModelAdapter = new AstraVisualExecutionModelAdapter({
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.NAGEX_ASTRA_MODEL,
    auditLogger,
    // Routes through the ownership-scoped read-back (DC1-R1) — never a
    // bare evidenceId lookup.
    readScreenshot: (evidenceId, tenantId, ownerId, requestId) => browserService.readEvidenceOwned(evidenceId, tenantId, ownerId, requestId),
  });
  const deviceControlService = astraVisualExecutionModelAdapter.status().configured
    ? new DeviceControlService(deviceExecutionSessionStore, browserService, astraVisualExecutionModelAdapter)
    : undefined;
  // DC3-A — Local Device Agent identity/session/transport foundation.
  const deviceIdentityStore = new DeviceIdentityStore();
  const desktopExecutionSessionStore = new DesktopExecutionSessionStore();
  const deviceTransportSecurity = new DeviceTransportSecurity(deviceIdentityStore);
  // DC3-B1 — the real outbound transport endpoint. Deliberately has no
  // dependency on CapabilityBroker/CapabilityRegistry anywhere — this
  // wiring alone never makes device.desktop.execute appear live; only
  // "enrolled/connected/authenticated" are reachable from here.
  const deviceConnectionStatusStore = new DeviceConnectionStatusStore();
  const devicePendingCommandStore = new DevicePendingCommandStore();
  const deviceAgentTransportEndpoint = new DeviceAgentTransportEndpoint(
    deviceTransportSecurity,
    deviceIdentityStore,
    deviceConnectionStatusStore,
    desktopExecutionSessionStore,
    devicePendingCommandStore,
  );
  const moduleRegistry = new ModuleRegistry();
  const moduleStateStore = new ModuleStateStore();
  const moduleService = new ModuleService(moduleRegistry, moduleStateStore, auditLogger);

  // DC3-B2 — Isolated Windows desktop background execution. Constructed
  // unconditionally (cheap — no I/O beyond a file-existence check), but
  // desktopControlService.isReady() (checked inside isProviderAvailable())
  // stays truthful: on non-Windows, or before the native controller has
  // been built (native/windows-desktop-controller/build.ps1), 'DEVICE_DESKTOP'
  // genuinely reports unavailable rather than silently no-opping.
  const activityStore = new ActivityStore();
  const dailyBriefStore = new DailyBriefStore();
  const actionProposalStore = new ActionProposalStore();
  const desktopAppAllowlist = new DesktopAppAllowlist();
  const windowsIsolatedDesktopController = new WindowsIsolatedDesktopController();
  const desktopActivityAdapter = new DesktopActivityAdapter(activityStore);
  const desktopControlService = new DesktopControlService(
    desktopExecutionSessionStore,
    windowsIsolatedDesktopController,
    desktopAppAllowlist,
    actionApprovals,
    auditLogger,
    desktopActivityAdapter,
  );

  const capabilityBroker = new CapabilityBroker(
    googleCalendarService,
    gmailService,
    browserService,
    auditLogger,
    capabilityRegistry,
    'capabilities_idempotency',
    'NAGEX_CAPABILITIES_IDEMPOTENCY_DIR',
    moduleRegistry,
    moduleStateStore,
    deviceControlService,
    desktopControlService,
  );

  // ─── MASTER.md Section 14 — Main Session + Tasks Foundation ───
  const sessionStore = new SessionStore();
  const conversationStore = new ConversationStore();
  const conversationContextService = new ConversationContextService(conversationStore);
  const taskStore = new TaskStore();
  const taskRunStore = new TaskRunStore();

  // ─── Personal AI Seed Data (Matching Mockup Images 1 - 4) ───
  // Moved here verbatim from server_web.ts (not restructured, not cleaned
  // up — a separate refactor's job) only because getRelevantMemories/
  // pinnedMemories are genuine construction-time dependencies of
  // taskRunner/telegramService/slackService below, not merely seed-time
  // artifacts (they are also read/written for the rest of the process's
  // life by memory pin/unpin route handlers in server_web.ts, which is why
  // both are exposed on the returned NagexApplication rather than kept
  // private here).
  // Memory Tenant Isolation Correction — every hardcoded demo seed is
  // stamped with the same canonical default tenant used everywhere else in
  // this codebase (see DEFAULT_GOOGLE_TENANT_ID in
  // integrations/google/token.store.ts). Seeds are never created globally.
  const SEED_TENANT_ID = 'ten_production_01';

  function ensureSeedMemory(
    scope: MemoryScope,
    tenantId: string,
    ownerId: string,
    content: { subject: string; predicate: string; value: unknown },
  ): MemoryRecord {
    const existing = memoryEngine.findSeedMemory({
      scope,
      tenantId,
      ownerId,
      subject: content.subject,
      predicate: content.predicate,
    });
    if (existing) {
      if (existing.lifecycle !== 'ACTIVE') {
        return memoryEngine.activateMemory(existing.id, tenantId, ownerId);
      }
      return existing;
    }
    const proposed = memoryEngine.proposeMemory(scope, tenantId, ownerId, content);
    return memoryEngine.activateMemory(proposed.id, tenantId, ownerId);
  }

  const mem1 = ensureSeedMemory('USER', SEED_TENANT_ID, 'usr_admin_001', {
    subject: 'User Profile',
    predicate: 'is',
    value: 'Jane Smith (Product Strategy Lead)',
  });

  const mem2 = ensureSeedMemory('USER', SEED_TENANT_ID, 'usr_admin_001', {
    subject: 'Acme Corp Context',
    predicate: 'memory_summary',
    value: "Preparing for quarterly business review with Acme Corp focusing on product adoption, renewal potential, and Q3 roadmap.",
  });

  const mem3 = ensureSeedMemory('USER', SEED_TENANT_ID, 'usr_admin_001', {
    subject: 'Preferred Tools',
    predicate: 'channel',
    value: 'Gmail, Google Calendar, Notion, Slack',
  });

  const mem4 = ensureSeedMemory('SESSION', SEED_TENANT_ID, 'usr_admin_001', {
    subject: 'Current Focus',
    predicate: 'active_plan',
    value: 'Prepare Client Meeting & Schedule Product Strategy Sync',
  });

  const pinnedMemories = new Set<string>([mem2.id, mem3.id]);

  // Only ever surfaces memory that shares real content words with the current
  // prompt (never a memory whose only "match" is a pinned flag or a stopword):
  // a generic request must not drag in a strongly-pinned but otherwise
  // unrelated memory (e.g. a specific past client) just because it is pinned.
  // Pinning still nudges ranking among memories that are already relevant.
  function getRelevantMemories(tenantId: string, principalId: string, prompt: string): MemoryRecord[] {
    const memories = [
      ...memoryEngine.getActiveMemories('USER', tenantId, principalId),
      ...memoryEngine.getActiveMemories('SESSION', tenantId, principalId),
      ...memoryEngine.getActiveMemories('AGENT', tenantId, principalId),
      ...memoryEngine.getActiveMemories('TENANT', tenantId, principalId),
    ];
    const terms = new Set(
      prompt.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 2 && !MEMORY_RELEVANCE_STOPWORDS.has(term)),
    );
    return memories
      .map((memory) => ({ memory, score: [...terms].filter((term) => JSON.stringify(memory.content).toLowerCase().includes(term)).length }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => (b.score + (pinnedMemories.has(b.memory.id) ? 0.5 : 0)) - (a.score + (pinnedMemories.has(a.memory.id) ? 0.5 : 0)))
      .slice(0, 8)
      .map(({ memory }) => memory);
  }

  // P02 — one persisted continuation record per paused (WAITING_APPROVAL)
  // step; the resume source of truth. executingTaskRunner is kept as its
  // own local so the continuation coordinator (constructed further below,
  // once notificationEngine exists) can resume through the exact same
  // instance the app graph's taskRunner already uses.
  const taskContinuations = new TaskContinuationStore();
  // P03 — the single source of truth for resuming any run (paused or not)
  // after a process restart. ExecutingTaskRunner writes to it every step;
  // durableTaskRuntime (constructed further below) reads it once at boot.
  const durableTaskRunState = new DurableTaskRunStateStore();
  const executingTaskRunner = new ExecutingTaskRunner(aiService, planResolver, capabilityBroker, (tenantId, principalId, prompt) => getRelevantMemories(tenantId, principalId, prompt), taskContinuations, durableTaskRunState);
  // R10 — taskRunner (CompositeTaskRunner) itself is constructed further
  // below, right before taskScheduler, because DailyBriefTaskRunner needs
  // notificationEngine (for DAILY_BRIEF_READY), which is not built until
  // after the Telegram/Slack integration blocks. Nothing between here and
  // there reads taskRunner early — see the R10 comment at its real
  // construction site.

  // ─── MASTER.md Section 14 — Telegram Integration (Item 10) ───
  const telegramIdentityStore = new TelegramIdentityStore();
  const telegramBotClient = new TelegramBotClient();
  const telegramService = new TelegramService({
    botClient: telegramBotClient,
    identityStore: telegramIdentityStore,
    sessionStore,
    aiService,
    planResolver,
    getMemories: (tenantId, principalId, prompt) => getRelevantMemories(tenantId, principalId, prompt),
    auditLogger,
    conversationStore,
    conversationContextService,
  });

  // ─── MASTER.md Section 14 — Slack Integration (Item 11) ───
  const slackIdentityStore = new SlackIdentityStore();
  const slackClient = new SlackClient();
  const slackService = new SlackService({
    slackClient,
    identityStore: slackIdentityStore,
    sessionStore,
    aiService,
    planResolver,
    getMemories: (tenantId, principalId, prompt) => getRelevantMemories(tenantId, principalId, prompt),
    auditLogger,
    conversationStore,
    conversationContextService,
  });

  // ─── MASTER.md Section 14 — Desktop Quick Wake Runtime (Item 14) ───
  const desktopRuntimeEngine = new DesktopRuntimeEngine({
    sessionStore,
    taskStore,
    auditLogger,
  });

  // ─── MASTER.md Section 14 — Notification Engine (Item 12) ───
  const notificationStore = new NotificationStore();
  const notificationEngine = new NotificationEngine({
    store: notificationStore,
    telegramIdentityStore,
    telegramBotClient,
    slackIdentityStore,
    slackClient,
    desktopRuntimeEngine,
    auditLogger,
  });

  // R10 — Daily Brief automation runner: real Calendar/Gmail/AiService
  // deps (the exact same services every other real route in this app
  // uses), plus dailyBriefStore for persistence and notificationEngine for
  // the DAILY_BRIEF_READY notification. Routed to only for a RECURRING
  // task with automationKind:'DAILY_BRIEF' (see composite.runner.ts).
  const dailyBriefTaskRunner = new DailyBriefTaskRunner(
    { calendarService: googleCalendarService, gmailApiService: gmailService, aiService, taskStore, activityStore },
    dailyBriefStore,
    notificationEngine,
    actionApprovals,
    actionProposalStore,
  );
  const taskRunner = new CompositeTaskRunner(
    new PlanPreviewTaskRunner(aiService, planResolver, (tenantId, principalId, prompt) => getRelevantMemories(tenantId, principalId, prompt)),
    new ConditionalWatchTaskRunner(capabilityBroker, aiService),
    new BackgroundTaskRunner(taskStore, aiService, planResolver, (tenantId, principalId, prompt) => getRelevantMemories(tenantId, principalId, prompt)),
    executingTaskRunner,
    dailyBriefTaskRunner,
  );
  const taskScheduler = new TaskScheduler(taskStore, taskRunStore, taskRunner, auditLogger, undefined, notificationEngine);
  // P02 — resumes a paused Task run once server_web.ts's approval
  // grant/reject route reports a real approve()/reject(). Event-driven
  // (no poller): a no-op whenever the given approvalId has no associated
  // Task continuation.
  const taskContinuationCoordinator = new TaskContinuationCoordinator(taskContinuations, durableTaskRunState, executingTaskRunner, taskStore, taskRunStore, auditLogger, undefined, notificationEngine);
  // P03 — startup recovery: resumes any run this process's previous life
  // left genuinely mid-flight (see durable-task-runtime.ts). server_web.ts
  // registers recoverOnStartup() as a LifecycleManager start hook, run once
  // before the task-scheduler interval begins ticking.
  const durableTaskRuntime = new DurableTaskRuntime(durableTaskRunState, executingTaskRunner, taskStore, taskRunStore, auditLogger, undefined, notificationEngine);

  const knowledgeEngine = new KnowledgeEngine();
  const storageProvider = createConfiguredStorageProvider();
  const candidateStore = new CandidateStore();
  const candidateActionResolver = new CandidateActionResolver({
    candidateStore,
    captureStore,
    taskStore,
    memoryEngine,
    knowledgeEngine,
    calendarService: googleCalendarService,
    executionStore,
    auditLogger,
    activityStore,
  });
  const quickCaptureService = new QuickCaptureService(
    captureStore,
    storageProvider,
    taskStore,
    memoryEngine,
    knowledgeEngine,
    aiService,
    browserService,
    auditLogger,
    actionApprovals,
    candidateStore,
    candidateActionResolver,
    activityStore,
  );
  const inputRouter = new InputRouter();
  const workflowDefinitionStore = new WorkflowDefinitionStore();
  const workflowDefinitionService = new WorkflowDefinitionService({ store: workflowDefinitionStore, taskStore, planResolver, auditLogger });
  const lifecycle = new LifecycleManager();

  return {
    identityStore,
    identityTokenStore,
    identityAuditStore,
    organizationStore,
    pdp,
    runtime,
    auditLogger,
    billing,
    creditEngine,
    memoryEngine,
    aiService,
    planResolver,
    actionApprovals,
    executionStore,
    googleCalendarService,
    gmailService,
    browserService,
    moduleRegistry,
    moduleStateStore,
    moduleService,
    capabilityBroker,
    sessionStore,
    conversationStore,
    conversationContextService,
    taskStore,
    taskRunStore,
    taskRunner,
    taskScheduler,
    taskContinuations,
    taskContinuationCoordinator,
    durableTaskRunState,
    durableTaskRuntime,
    telegramIdentityStore,
    telegramBotClient,
    telegramService,
    slackIdentityStore,
    slackClient,
    slackService,
    desktopRuntimeEngine,
    notificationStore,
    notificationEngine,
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
    deviceExecutionSessionStore,
    deviceControlService,
    deviceIdentityStore,
    desktopExecutionSessionStore,
    deviceTransportSecurity,
    deviceConnectionStatusStore,
    devicePendingCommandStore,
    deviceAgentTransportEndpoint,
    lifecycle,
    getRelevantMemories,
    pinnedMemories,
  };
}

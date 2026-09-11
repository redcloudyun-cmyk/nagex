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
import { MemoryEngine, type MemoryRecord } from '../context/memory.engine.js';
import { AiService } from '../model-gateway/ai-service.js';
import { createProviders } from '../model-gateway/providers.js';
import { UnifiedModelRouter } from '../model-gateway/unified-model-router.js';
import { skillRegistry as canonicalSkillRegistry } from '../skills/skill-registry.js';
import { toolRegistry as canonicalToolRegistry } from '../tools/tool-registry.js';
import { PlanResolver } from '../planning/plan-resolver.js';
import { PersistentActionApprovalStore } from '../governance/action-approval.store.js';
import { ExecutionStore } from '../governance/execution.store.js';
import { GoogleCalendarService } from '../tools/google-calendar.service.js';
import { GmailService } from '../tools/gmail.service.js';
import { BrowserToolService, browserRuntime, browserSessionStore } from '../modules/browser/index.js';
import { googleTokenStore } from '../integrations/google/token.store.js';
import { readGoogleOAuthConfig } from '../integrations/google/oauth.client.js';
import { SessionStore } from '../sessions/session.store.js';
import { ConversationStore } from '../conversations/conversation.store.js';
import { ConversationContextService } from '../conversations/conversation-context.service.js';
import { TaskStore } from '../tasks/task.store.js';
import { TaskRunStore } from '../tasks/task-run.store.js';
import { TaskScheduler } from '../tasks/task.scheduler.js';
import { PlanPreviewTaskRunner, ConditionalWatchTaskRunner, BackgroundTaskRunner, CompositeTaskRunner } from '../tasks/task.runner.js';
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
import { CandidateActionResolver } from '../workspace/action-resolver.js';
import { ActivityStore } from '../governance/activity.store.js';
import { createConfiguredStorageProvider } from '../storage/s3-storage.provider.js';
import { KnowledgeEngine } from '../context/knowledge.engine.js';
import { CapabilityBroker, capabilityRegistry } from '../capabilities/index.js';
import type { NagexApplication } from './nagex-application.js';
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
  const capabilityBroker = new CapabilityBroker(
    googleCalendarService,
    gmailService,
    browserService,
    auditLogger,
    capabilityRegistry,
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
  const mem1 = memoryEngine.proposeMemory('USER', 'usr_admin_001', {
    subject: 'User Profile',
    predicate: 'is',
    value: 'Jane Smith (Product Strategy Lead)',
  });
  memoryEngine.activateMemory(mem1.id);

  const mem2 = memoryEngine.proposeMemory('USER', 'usr_admin_001', {
    subject: 'Acme Corp Context',
    predicate: 'memory_summary',
    value: "Preparing for quarterly business review with Acme Corp focusing on product adoption, renewal potential, and Q3 roadmap.",
  });
  memoryEngine.activateMemory(mem2.id);

  const mem3 = memoryEngine.proposeMemory('USER', 'usr_admin_001', {
    subject: 'Preferred Tools',
    predicate: 'channel',
    value: 'Gmail, Google Calendar, Notion, Slack',
  });
  memoryEngine.activateMemory(mem3.id);

  const mem4 = memoryEngine.proposeMemory('SESSION', 'usr_admin_001', {
    subject: 'Current Focus',
    predicate: 'active_plan',
    value: 'Prepare Client Meeting & Schedule Product Strategy Sync',
  });
  memoryEngine.activateMemory(mem4.id);

  const pinnedMemories = new Set<string>([mem2.id, mem3.id]);

  // Only ever surfaces memory that shares real content words with the current
  // prompt (never a memory whose only "match" is a pinned flag or a stopword):
  // a generic request must not drag in a strongly-pinned but otherwise
  // unrelated memory (e.g. a specific past client) just because it is pinned.
  // Pinning still nudges ranking among memories that are already relevant.
  function getRelevantMemories(principalId: string, prompt: string): MemoryRecord[] {
    const memories = [
      ...memoryEngine.getActiveMemories('USER', principalId),
      ...memoryEngine.getActiveMemories('SESSION', principalId),
      ...memoryEngine.getActiveMemories('AGENT', principalId),
      ...memoryEngine.getActiveMemories('TENANT', principalId),
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

  const taskRunner = new CompositeTaskRunner(
    new PlanPreviewTaskRunner(aiService, planResolver, (principalId, prompt) => getRelevantMemories(principalId, prompt)),
    new ConditionalWatchTaskRunner(capabilityBroker, aiService),
    new BackgroundTaskRunner(taskStore, aiService, planResolver, (principalId, prompt) => getRelevantMemories(principalId, prompt)),
  );

  // ─── MASTER.md Section 14 — Telegram Integration (Item 10) ───
  const telegramIdentityStore = new TelegramIdentityStore();
  const telegramBotClient = new TelegramBotClient();
  const telegramService = new TelegramService({
    botClient: telegramBotClient,
    identityStore: telegramIdentityStore,
    sessionStore,
    aiService,
    planResolver,
    getMemories: (principalId, prompt) => getRelevantMemories(principalId, prompt),
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
    getMemories: (principalId, prompt) => getRelevantMemories(principalId, prompt),
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

  const taskScheduler = new TaskScheduler(taskStore, taskRunStore, taskRunner, auditLogger, undefined, notificationEngine);

  const knowledgeEngine = new KnowledgeEngine();
  const storageProvider = createConfiguredStorageProvider();
  const candidateStore = new CandidateStore();
  const activityStore = new ActivityStore();
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
  const lifecycle = new LifecycleManager();

  return {
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
    capabilityBroker,
    sessionStore,
    conversationStore,
    conversationContextService,
    taskStore,
    taskRunStore,
    taskRunner,
    taskScheduler,
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
    candidateActionResolver,
    quickCaptureService,
    inputRouter,
    lifecycle,
    getRelevantMemories,
    pinnedMemories,
  };
}

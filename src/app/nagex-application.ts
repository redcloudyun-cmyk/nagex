// Phase 01 — Composition Root Refactoring.
//
// NagexApplication is a plain, explicit-typed application object graph — not
// a framework, not a service locator, not a generic container. Every field
// here is a production singleton `server_web.ts` already constructed inline
// before this refactor; this type only names the shape once so
// createNagexApplication() has something concrete to return and
// server_web.ts has something concrete to destructure from.
import type { PolicyDecisionPoint } from '../identity/pdp.js';
import type { DurableRuntimeEngine } from '../runtime/runtime.engine.js';
import type { AuditLogger } from '../governance/audit.logger.js';
import type { BillingLedgerEngine } from '../billing/billing.ledger.js';
import type { CreditEngine } from '../billing/credit.engine.js';
import type { MemoryEngine, MemoryRecord } from '../context/memory.engine.js';
import type { AiService } from '../model-gateway/ai-service.js';
import type { PlanResolver } from '../planning/plan-resolver.js';
import type { PersistentActionApprovalStore } from '../governance/action-approval.store.js';
import type { ExecutionStore } from '../governance/execution.store.js';
import type { GoogleCalendarService } from '../modules/calendar/index.js';
import type { GmailService } from '../modules/gmail/index.js';
import type { BrowserToolService } from '../modules/browser/index.js';
import type { CapabilityBroker } from '../capabilities/index.js';
import type { SessionStore } from '../sessions/session.store.js';
import type { ConversationStore } from '../conversations/conversation.store.js';
import type { ConversationContextService } from '../conversations/conversation-context.service.js';
import type { TaskStore } from '../tasks/task.store.js';
import type { TaskRunStore } from '../tasks/task-run.store.js';
import type { TaskScheduler } from '../tasks/task.scheduler.js';
import type { CompositeTaskRunner } from '../tasks/task.runner.js';
import type { TaskContinuationStore } from '../tasks/task-continuation.store.js';
import type { TaskContinuationCoordinator } from '../tasks/task-continuation.coordinator.js';
import type { DurableTaskRunStateStore } from '../tasks/durable-task-run-state.store.js';
import type { DurableTaskRuntime } from '../tasks/durable-task-runtime.js';
import type { TelegramIdentityStore } from '../integrations/telegram/telegram-identity.store.js';
import type { TelegramBotClient } from '../integrations/telegram/telegram.client.js';
import type { TelegramService } from '../integrations/telegram/telegram.service.js';
import type { SlackIdentityStore } from '../integrations/slack/slack-identity.store.js';
import type { SlackClient } from '../integrations/slack/slack.client.js';
import type { SlackService } from '../integrations/slack/slack.service.js';
import type { DesktopRuntimeEngine } from '../desktop/desktop-runtime.engine.js';
import type { NotificationStore } from '../notifications/notification.store.js';
import type { NotificationEngine } from '../notifications/notification.engine.js';
import type { KnowledgeEngine } from '../context/knowledge.engine.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import type { CandidateStore } from '../workspace/candidate.store.js';
import type { ActivityStore } from '../governance/activity.store.js';
import type { CandidateActionResolver } from '../workspace/action-resolver.js';
import type { QuickCaptureService } from '../workspace/quick-capture.service.js';
import type { InputRouter } from '../workspace/input-router.js';
import type { LifecycleManager } from './lifecycle-manager.js';
import type { ModuleRegistry, ModuleStateStore, ModuleService } from '../modules/index.js';
import type { WorkflowDefinitionStore } from '../workflows/workflow-definition.store.js';
import type { WorkflowDefinitionService } from '../workflows/workflow-definition.service.js';

export interface NagexApplication {
  pdp: PolicyDecisionPoint;
  runtime: DurableRuntimeEngine;
  auditLogger: AuditLogger;
  billing: BillingLedgerEngine;
  creditEngine: CreditEngine;
  memoryEngine: MemoryEngine;
  aiService: AiService;
  planResolver: PlanResolver;
  actionApprovals: PersistentActionApprovalStore;
  executionStore: ExecutionStore;
  googleCalendarService: GoogleCalendarService;
  gmailService: GmailService;
  browserService: BrowserToolService;
  moduleRegistry: ModuleRegistry;
  moduleStateStore: ModuleStateStore;
  moduleService: ModuleService;
  capabilityBroker: CapabilityBroker;
  sessionStore: SessionStore;
  conversationStore: ConversationStore;
  conversationContextService: ConversationContextService;
  taskStore: TaskStore;
  taskRunStore: TaskRunStore;
  // Not in server_web.ts's export list, but a genuine current dependency: a
  // route handler (task run-one, "test with an alternate model" path) builds
  // a throwaway TaskScheduler wrapping the same taskRunner-shaped pieces —
  // see create-nagex-application.ts's comment at its construction site.
  taskRunner: CompositeTaskRunner;
  taskScheduler: TaskScheduler;
  // P02 — the resume source of truth for a paused approval-waiting run,
  // and the event-driven orchestrator server_web.ts's approval grant/
  // reject route calls into.
  taskContinuations: TaskContinuationStore;
  taskContinuationCoordinator: TaskContinuationCoordinator;
  // P03 — the single source of truth for resuming any ExecutingTaskRunner
  // run (paused or not) after a process restart; durableTaskRuntime's
  // recoverOnStartup() is registered as a LifecycleManager start hook.
  durableTaskRunState: DurableTaskRunStateStore;
  durableTaskRuntime: DurableTaskRuntime;
  telegramIdentityStore: TelegramIdentityStore;
  telegramBotClient: TelegramBotClient;
  telegramService: TelegramService;
  slackIdentityStore: SlackIdentityStore;
  slackClient: SlackClient;
  slackService: SlackService;
  desktopRuntimeEngine: DesktopRuntimeEngine;
  notificationStore: NotificationStore;
  notificationEngine: NotificationEngine;
  knowledgeEngine: KnowledgeEngine;
  storageProvider: StorageProvider;
  candidateStore: CandidateStore;
  activityStore: ActivityStore;
  candidateActionResolver: CandidateActionResolver;
  quickCaptureService: QuickCaptureService;
  inputRouter: InputRouter;
  // P07 — reusable workflow definitions, instantiated into the existing
  // Task/Plan/Capability Broker/Approval/Durable Runtime path unchanged.
  workflowDefinitionStore: WorkflowDefinitionStore;
  workflowDefinitionService: WorkflowDefinitionService;
  // Construction-time dependency of taskRunner/telegramService/slackService
  // (each bakes it in as a closure) that is *also* live, mutable state read
  // and written by memory pin/unpin route handlers for the rest of the
  // process's life — not seed-only, so it must be the same shared instance
  // server_web.ts's route handlers read/write, not a private copy.
  getRelevantMemories: (principalId: string, prompt: string) => MemoryRecord[];
  pinnedMemories: Set<string>;
  // Phase 02 — owns start/stop for process-lifetime resources (HTTP server,
  // scheduler interval, browserRuntime). Constructed here, empty; the
  // executable entrypoint (server_web.ts) registers the actual resources,
  // since it alone knows their real start/stop implementations.
  lifecycle: LifecycleManager;
}

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

// ─── NAgex Core Engine Imports ───
import { PolicyDecisionPoint, describeDeniedDecision } from './identity/pdp.js';
import { DurableRuntimeEngine } from './runtime/runtime.engine.js';
import { AuditLogger } from './governance/audit.logger.js';
import { BillingLedgerEngine } from './billing/billing.ledger.js';
import { CreditEngine, computeCreditCost, sumBreakdownUsd, type CreditCostBreakdown } from './billing/credit.engine.js';
import { MemoryEngine, type MemoryRecord, type MemoryScope } from './context/memory.engine.js';
import { NagexError } from './common/errors.js';
import type { TenantContext, PrincipalReference } from './common/types.js';
import { AiService, parseRoutingMode, type PlanPreview } from './model-gateway/ai-service.js';
import { createProviders } from './model-gateway/providers.js';
import { UnifiedModelRouter } from './model-gateway/unified-model-router.js';
import { skillRegistry as canonicalSkillRegistry } from './skills/skill-registry.js';
import { toolRegistry as canonicalToolRegistry } from './tools/tool-registry.js';
import { PlanResolver } from './planning/plan-resolver.js';
import { PersistentActionApprovalStore } from './governance/action-approval.store.js';
import { ExecutionStore } from './governance/execution.store.js';
import {
  GoogleCalendarService,
  GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID,
  GOOGLE_CALENDAR_UPDATE_EVENT_TOOL_ID,
  GOOGLE_CALENDAR_CANCEL_EVENT_TOOL_ID,
  GOOGLE_CALENDAR_RESPOND_EVENT_TOOL_ID,
  queryFreeBusy,
  computeFreeSlots,
} from './modules/calendar/index.js';
import {
  GmailService,
  GMAIL_SEND_EMAIL_TOOL_ID,
  GMAIL_REPLY_TOOL_ID,
  GMAIL_CREATE_DRAFT_TOOL_ID,
} from './modules/gmail/index.js';
import { BrowserToolService, browserRuntime } from './modules/browser/index.js';
import { googleTokenStore, DEFAULT_GOOGLE_TENANT_ID } from './integrations/google/token.store.js';
import { buildGoogleAuthorizeUrl, exchangeGoogleAuthorizationCode, readGoogleOAuthConfig } from './integrations/google/oauth.client.js';
import { SessionStore } from './sessions/session.store.js';
import { ConversationStore } from './conversations/conversation.store.js';
import { ConversationContextService } from './conversations/conversation-context.service.js';
import { TaskStore, type TaskType, type TaskTrigger, type TaskApprovalPolicy, type TaskRecord } from './tasks/task.store.js';
import { TaskRunStore } from './tasks/task-run.store.js';
import { TaskScheduler, computeNextRunAt } from './tasks/task.scheduler.js';
import { PlanPreviewTaskRunner, ConditionalWatchTaskRunner, BackgroundTaskRunner, CompositeTaskRunner, ExecutingTaskRunner } from './tasks/task.runner.js';
import { TelegramIdentityStore } from './integrations/telegram/telegram-identity.store.js';
import { TelegramBotClient, type TelegramUpdate } from './integrations/telegram/telegram.client.js';
import { TelegramService } from './integrations/telegram/telegram.service.js';
import { SafetyEngine } from './governance/safety.engine.js';
import { PersistentSafetyStore } from './governance/safety.store.js';
import { SlackIdentityStore } from './integrations/slack/slack-identity.store.js';
import { SlackClient, type SlackEventPayload } from './integrations/slack/slack.client.js';
import { SlackService } from './integrations/slack/slack.service.js';
import { NotificationStore } from './notifications/notification.store.js';
import { NotificationEngine } from './notifications/notification.engine.js';
import { DesktopRuntimeEngine } from './desktop/desktop-runtime.engine.js';
import { captureStore } from './workspace/capture.store.js';
import { QuickCaptureService } from './workspace/quick-capture.service.js';
import { InputRouter } from './workspace/input-router.js';
import { CandidateStore } from './workspace/candidate.store.js';
import type { CandidateStatus, CandidateType } from './workspace/candidate.types.js';
import { CandidateActionResolver } from './workspace/action-resolver.js';
import { ActivityStore } from './governance/activity.store.js';
import { createConfiguredStorageProvider } from './storage/s3-storage.provider.js';
import { CapabilityBroker, capabilityRegistry } from './capabilities/index.js';
import { createNagexApplication } from './app/create-nagex-application.js';

const PORT = Number(process.env.PORT || 8085);
const PUBLIC_DIR = path.join(process.cwd(), 'public');
const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
  Expires: '0',
} as const;
const MUTABLE_FRONTEND_FILES = new Set(['index.html', 'style.css', 'app.js', 'i18n.js', 'plan-resolution-view.js', 'calendar-approval-view.js', 'calendar-intent-extraction.js', 'calendar-payload-validation.js', 'gmail-approval-view.js', 'gmail-intent-extraction.js', 'browser-approval-view.js', 'browser-intent-extraction.js', 'modal-behavior.js', 'timeline-dedupe.js', 'single-flight-guard.js', 'legal.js', 'privacy.html', 'terms.html', 'desktop-quickwake.html', 'desktop-quickwake.css', 'desktop-quickwake.js']);
const VERSIONED_HTML_FILES = new Set(['index.html', 'privacy.html', 'terms.html', 'desktop-quickwake.html']);
const CLEAN_URL_ALIASES: Record<string, string> = { '/privacy': 'privacy.html', '/terms': 'terms.html', '/quickwake': 'desktop-quickwake.html' };
const BUILD_VERSION_PLACEHOLDER = '__NAGEX_BUILD_VERSION__';

function createBuildVersion(): string {
  const hash = crypto.createHash('sha256');
  for (const filename of ['style.css', 'i18n.js', 'plan-resolution-view.js', 'calendar-approval-view.js', 'calendar-intent-extraction.js', 'calendar-payload-validation.js', 'gmail-approval-view.js', 'gmail-intent-extraction.js', 'browser-approval-view.js', 'browser-intent-extraction.js', 'modal-behavior.js', 'timeline-dedupe.js', 'single-flight-guard.js', 'legal.js', 'app.js']) {
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
  candidateActionResolver,
  quickCaptureService,
  inputRouter,
} = app;
let pendingGoogleOAuthState: string | null = null;


// A real (not fake) background scheduler loop — only runs when this module
// is the actual running server, never when imported by tests. Phase 02:
// the interval handle itself is now a lifecycle-managed resource (started
// and explicitly cleared via app.lifecycle) instead of an unmanaged
// .unref()'d timer — see the single require.main === module entrypoint
// block below, which registers this alongside the HTTP server and
// browserRuntime.
const TASK_SCHEDULER_TICK_MS = Number(process.env.NAGEX_TASK_SCHEDULER_INTERVAL_MS) || 30_000;

const INITIAL_CREDIT_GRANT = 10000;
const seededTenants = new Set<string>();
function ensureTenantSeeded(tenantId: string): void {
  if (!seededTenants.has(tenantId)) {
    creditEngine.grantCredits(tenantId, INITIAL_CREDIT_GRANT, 'Initial account seed');
    seededTenants.add(tenantId);
  }
}

const MANAGED_AI_COST_BREAKDOWN: CreditCostBreakdown = {
  llm_cost_unit: 0.04,
  rag_unit: 0.004,
  tool_unit: 0.005,
  runtime_unit: 0.011,
};

const SUBSCRIPTION_INFO = {
  plan: 'Business Pro',
  monthly_price: 120.0,
  next_renewal: '2026-09-01',
};

// Personal AI seed memory (mem1-4) + pinnedMemories moved into
// createNagexApplication() — see app.pinnedMemories, destructured above —
// since getRelevantMemories/pinnedMemories are genuine construction-time
// dependencies of taskRunner/telegramService/slackService there, not
// merely seed-time artifacts.

// Seed Plans (Exact match for Mockup Image 4)
const planRegistry: Array<{
  id: string;
  goal: string;
  description: string;
  status: string;
  tags: string[];
  progress: number;
  completed_steps: number;
  total_steps: number;
  created_at: string;
  steps: Array<{
    step: number;
    title: string;
    status: string;
    skill: string;
    tool: string;
    approval: string;
    due: string;
    result: string;
  }>;
}> = [
  {
    id: 'plan_acme_meeting',
    goal: 'Prepare Client Meeting',
    description: 'Prepare for the Acme Corp. quarterly business review meeting.',
    status: 'RUNNING',
    tags: ['Client Meeting', 'Acme Corp', '🔥 High Priority'],
    progress: 62,
    completed_steps: 5,
    total_steps: 8,
    created_at: new Date(Date.now() - 3600000).toISOString(),
    steps: [
      { step: 1, title: 'Understand meeting context', status: 'Completed', skill: 'Memory Recall', tool: 'NAgex Memory', approval: '-', due: 'Apr 28, 9:00 AM', result: 'View' },
      { step: 2, title: 'Research client and industry', status: 'Completed', skill: 'Web Research', tool: 'Perplexity', approval: '-', due: 'Apr 28, 11:00 AM', result: 'View' },
      { step: 3, title: 'Summarize key talking points', status: 'Running', skill: 'Summarization', tool: 'Notion', approval: '-', due: 'Apr 29, 9:00 AM', result: '...' },
      { step: 4, title: 'Draft meeting deck', status: 'Ready', skill: 'Content Creation', tool: 'Google Slides', approval: 'Required', due: 'Apr 29, 2:00 PM', result: '-' },
      { step: 5, title: 'Get stakeholder review', status: 'Awaiting Approval', skill: 'Communication', tool: 'Gmail', approval: 'Required', due: 'Apr 29, 5:00 PM', result: '-' },
      { step: 6, title: 'Schedule the meeting', status: 'Ready', skill: 'Scheduling', tool: 'Google Calendar', approval: '-', due: 'Apr 30, 9:00 AM', result: '-' },
      { step: 7, title: 'Prepare Q&A responses', status: 'Ready', skill: 'Analysis', tool: 'ChatGPT', approval: '-', due: 'Apr 30, 11:00 AM', result: '-' },
      { step: 8, title: 'Final review and checklist', status: 'Ready', skill: 'Project Management', tool: 'Notion', approval: '-', due: 'Apr 30, 3:00 PM', result: '-' },
    ],
  },
  {
    id: 'plan_002',
    goal: 'Weekly Competitive Market Analysis',
    description: 'Gather competitors intelligence and prepare executive deck.',
    status: 'RUNNING',
    tags: ['Market Research', 'Executive Summary'],
    progress: 33,
    completed_steps: 1,
    total_steps: 3,
    created_at: new Date(Date.now() - 1800000).toISOString(),
    steps: [
      { step: 1, title: 'Search latest market trends via Web Search', status: 'Completed', skill: 'Deep Research', tool: 'Web Search', approval: '-', due: 'Apr 29, 10:00 AM', result: 'View' },
      { step: 2, title: 'Synthesize insights into Executive Brief', status: 'Running', skill: 'Document Summary', tool: 'Browser', approval: '-', due: 'Apr 29, 2:00 PM', result: '...' },
      { step: 3, title: 'Distribute summary to Slack #executive channel', status: 'Ready', skill: 'Executive Update', tool: 'Slack', approval: 'Required', due: 'Apr 29, 4:00 PM', result: '-' },
    ],
  },
];

// Seed Approvals Queue (Exact match for Mockup Image 3)
const approvalQueue: Array<{
  id: string;
  action: string;
  tool: string;
  event_name: string;
  event_time: string;
  recipient: string;
  subject: string;
  impact: string;
  data_involved: string[];
  why: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  requested_at: string;
  plan_id?: string;
}> = [
  {
    id: 'appr_gcal_sync',
    action: 'Create Google Calendar event',
    tool: 'Google Calendar',
    event_name: 'Product Strategy Sync',
    event_time: 'Tue, Apr 29, 2025 11:00 AM – 12:00 PM (1 hour)',
    recipient: 'Sarah Kim, James Park, Alex Chen (3 guests)',
    subject: 'Product Strategy Sync',
    impact: 'Adds a calendar event and sends invitations to 3 people.',
    data_involved: ['Your Google Calendar', 'guest emails', 'meeting title and agenda'],
    why: 'You asked me to schedule a follow-up meeting after the product review.',
    status: 'PENDING',
    requested_at: new Date(Date.now() - 120000).toISOString(),
    plan_id: 'plan_acme_meeting',
  },
  {
    id: 'appr_stakeholder_email',
    action: 'Get stakeholder review',
    tool: 'Gmail',
    event_name: 'Acme QBR Deck Review',
    event_time: 'Apr 29, 5:00 PM',
    recipient: 'stakeholders@acme.corp',
    subject: 'QBR Presentation Draft Review',
    impact: 'Dispatches external review email with presentation draft to 4 stakeholders.',
    data_involved: ['Acme-QBR-Deck-Draft.pdf', 'stakeholder emails'],
    why: 'Step 5 of plan "Prepare Client Meeting" requires approval before dispatch.',
    status: 'PENDING',
    requested_at: new Date(Date.now() - 300000).toISOString(),
    plan_id: 'plan_acme_meeting',
  },
];

// In-memory Execution History
const executionHistory: Array<Record<string, unknown>> = [
  {
    execution_id: 'exec_meeting_prep_001',
    agent_id: 'agt_personal_ai',
    agent_name: 'NAgex Personal AI',
    objective: 'Prepare my next client meeting and schedule it.',
    status: 'COMPLETED',
    tenant_id: 'ten_production_01',
    created_at: new Date(Date.now() - 600000).toISOString(),
    checkpoint: 'COMPLETED',
    steps_log: [
      'Goal received: Prepare client meeting and schedule it',
      'Memory loaded: Relevant context retrieved (12 memories)',
      'Plan created: 8 steps generated by NAgex',
      'Skill selected: Meeting Preparation',
      'Tool selected: Google Calendar & Gmail',
      'Approval requested: Step 5 - Get stakeholder review',
      'Approval granted by user',
      'Tool executed: Research completed with Perplexity',
      'Result verified: Calendar event registered',
      'Memory updated: Saved meeting briefing preference',
    ],
  },
];

const quickWakeConfig = {
  floating_button: true,
  quick_settings_tile: true,
  lock_screen_shortcut: true,
  voice_wake: false,
  double_tap_shortcut: true,
  headset_button: false,
  accessibility_shortcut: false,
  fingerprint_button: { supported: false, label: 'Not supported on this device' },
};

let autonomyConfig = {
  level: 'L2',
  description: 'Level 2 — Low-risk Actions with Human Approval Gate for Consequential Operations',
};

const knowledgeBase = [
  { id: 'kb_001', name: 'Acme_QBR_Notes.pdf', classification: 'CONFIDENTIAL', size_bytes: 2516582, status: 'INDEXED', indexed_at: '2026-08-20T14:30:00Z', chunk_count: 142 },
  { id: 'kb_002', name: 'Product_Strategy_2025.docx', classification: 'INTERNAL', size_bytes: 1153433, status: 'INDEXED', indexed_at: '2026-08-19T09:15:00Z', chunk_count: 87 },
];

interface VcsFileChange { path: string; status: string; }
interface VcsCommit { hash: string; author: string; date: string; message: string; }
interface VcsStatus { available: boolean; branch: string | null; changed_files: VcsFileChange[]; commits: VcsCommit[]; error?: string; }

function getVcsStatus(): VcsStatus {
  const cwd = process.cwd();
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
    const statusRaw = execFileSync('git', ['-c', 'core.quotepath=false', 'status', '--porcelain=v1'], { cwd, encoding: 'utf8' });
    const changed_files: VcsFileChange[] = statusRaw.split('\n').filter((l) => l.trim().length > 0).map((l) => ({ status: l.slice(0, 2).trim() || '?', path: l.slice(3) }));
    const logRaw = execFileSync('git', ['log', '-20', '--pretty=format:%h%x1f%an%x1f%ad%x1f%s', '--date=iso-strict'], { cwd, encoding: 'utf8' });
    const commits: VcsCommit[] = logRaw.split('\n').filter((l) => l.trim().length > 0).map((l) => { const [hash, author, date, message] = l.split('\x1f'); return { hash, author, date, message }; });
    return { available: true, branch, changed_files, commits };
  } catch (err) {
    return { available: false, branch: null, changed_files: [], commits: [], error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── API Router ───
function getHeaderValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

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
      return { status: 200, data: { providers: service.statuses() } };
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
    if (pathname === '/api/v1/vcs/status' && method === 'GET') {
      return { status: 200, data: getVcsStatus() };
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
        memories: getRelevantMemories(principalId, prompt),
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
    if (pathname === '/api/v1/oauth/google/callback' && method === 'GET') {
      const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
      const requestId = `req_oauth_${crypto.randomUUID()}`;
      const expectedState = pendingGoogleOAuthState;
      pendingGoogleOAuthState = null; // one-time use, prevents callback replay

      if (query.error) {
        return { status: 302, data: null, redirectTo: '/?oauth=google&status=error' };
      }
      if (!query.state || !expectedState || query.state !== expectedState || !query.code) {
        return { status: 302, data: null, redirectTo: '/?oauth=google&status=error' };
      }
      const config = readGoogleOAuthConfig();
      if (!config) {
        return { status: 302, data: null, redirectTo: '/?oauth=google&status=error' };
      }
      try {
        const token = await exchangeGoogleAuthorizationCode(config, query.code, fetch, requestId);
        googleTokenStore.save(tenantId, token);
        auditLogger.logEvent({ actor: { type: 'user', id: 'usr_admin_001' }, tenant_id: tenantId, action: 'oauth:google_connected', resource: { type: 'OAuthConnection', id: 'google_calendar' }, result: 'SUCCESS', request_id: requestId });
        return { status: 302, data: null, redirectTo: '/?oauth=google&status=connected' };
      } catch {
        return { status: 302, data: null, redirectTo: '/?oauth=google&status=error' };
      }
    }
    if (pathname === '/api/v1/oauth/google/status' && method === 'GET') {
      const tid = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
      const requestId = getHeaderValue(headers, 'x-request-id') || `req_oauth_${crypto.randomUUID()}`;
      const config = readGoogleOAuthConfig();
      if (config) {
        // Touches (and transparently refreshes + persists) the token if it's
        // expired, so "connected" reflects real usability, not stale state.
        await googleTokenStore.getValidAccessToken(tid, config, fetch, requestId);
      }
      const status = googleTokenStore.getStatus(tid);
      return { status: 200, data: { configured: Boolean(config), ...status } };
    }
    if (pathname === '/api/v1/oauth/google/disconnect' && method === 'POST') {
      const tid = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
      const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const requestId = getHeaderValue(headers, 'x-request-id') || `req_oauth_${crypto.randomUUID()}`;
      await googleTokenStore.revoke(tid, fetch, requestId);
      auditLogger.logEvent({ actor: { type: 'user', id: principalId }, tenant_id: tid, action: 'oauth:google_disconnected', resource: { type: 'OAuthConnection', id: 'google_calendar' }, result: 'SUCCESS', request_id: requestId });
      return { status: 200, data: googleTokenStore.getStatus(tid) };
    }
    // NOTE: upload/capture/capture-PATCH are handled in the canonical Phase 2
    // Personal Workspace section below (~line 1131) — this is the async path,
    // so the Promise-returning summary/health routes belong here instead.
    if (pathname === '/api/v1/workspace/route-input' && method === 'POST') {
      const text = typeof body?.text === 'string' ? body.text : '';
      const hasFile = Boolean(body?.hasFile);
      const hasAudio = Boolean(body?.hasAudio);
      const mimeType = typeof body?.mimeType === 'string' ? body.mimeType : undefined;
      const classification = InputRouter.classify({ text, hasFile, hasAudio, mimeType });
      return { status: 200, data: classification };
    }
    if (pathname === '/api/v1/workspace/storage/status' && method === 'GET') {
      const status = await quickCaptureService.getStorageHealth();
      return { status: 200, data: status };
    }
    if (pathname === '/api/v1/workspace/inbox' && method === 'GET') {
      const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      return { status: 200, data: quickCaptureService.getInboxSummary(ownerId) };
    }
    if (pathname === '/api/v1/workspace/vault' && method === 'GET') {
      const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      return { status: 200, data: await quickCaptureService.getVaultSummary(ownerId) };
    }
    if (pathname === '/api/v1/plans/resolve' && method === 'POST') {
      const candidate = body?.plan && typeof body.plan === 'object' ? body.plan : body;
      return { status: 200, data: planResolver.resolve(candidate as unknown as PlanPreview) };
    }
    if (pathname === '/api/v1/tools/google-calendar/create-event' && method === 'POST') {
      const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
      const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
      const approvalId = typeof body?.approvalId === 'string' ? body.approvalId : '';
      if (!approvalId) throw new NagexError({ code: 'APPROVAL_ID_REQUIRED', category: 'VALIDATION', message: 'approvalId is required.', request_id: requestId });
      const result = await calendarService.executeCreateEvent({ approvalId, payload: body?.payload, tenantId, principalId, requestId });
      return { status: 200, data: result };
    }
    if (pathname === '/api/v1/tools/google-calendar/update-event' && method === 'POST') {
      const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
      const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
      const approvalId = typeof body?.approvalId === 'string' ? body.approvalId : '';
      if (!approvalId) throw new NagexError({ code: 'APPROVAL_ID_REQUIRED', category: 'VALIDATION', message: 'approvalId is required.', request_id: requestId });
      const result = await calendarService.executeUpdateEvent({ approvalId, payload: body?.payload, tenantId, principalId, requestId });
      return { status: 200, data: result };
    }
    if (pathname === '/api/v1/tools/google-calendar/cancel-event' && method === 'POST') {
      const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
      const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
      const approvalId = typeof body?.approvalId === 'string' ? body.approvalId : '';
      if (!approvalId) throw new NagexError({ code: 'APPROVAL_ID_REQUIRED', category: 'VALIDATION', message: 'approvalId is required.', request_id: requestId });
      const result = await calendarService.executeCancelEvent({ approvalId, payload: body?.payload, tenantId, principalId, requestId });
      return { status: 200, data: result };
    }
    if (pathname === '/api/v1/tools/google-calendar/respond-to-event' && method === 'POST') {
      const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
      const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
      const approvalId = typeof body?.approvalId === 'string' ? body.approvalId : '';
      if (!approvalId) throw new NagexError({ code: 'APPROVAL_ID_REQUIRED', category: 'VALIDATION', message: 'approvalId is required.', request_id: requestId });
      const result = await calendarService.executeRespondToEvent({ approvalId, payload: body?.payload, tenantId, principalId, requestId });
      return { status: 200, data: result };
    }
    if (pathname === '/api/v1/tools/gmail/send-email' && method === 'POST') {
      const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
      const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
      const approvalId = typeof body?.approvalId === 'string' ? body.approvalId : '';
      if (!approvalId) throw new NagexError({ code: 'APPROVAL_ID_REQUIRED', category: 'VALIDATION', message: 'approvalId is required.', request_id: requestId });
      const result = await gmailApiService.executeSendEmail({ approvalId, payload: body?.payload, tenantId, principalId, requestId });
      return { status: 200, data: result };
    }
    if (pathname === '/api/v1/tools/gmail/reply' && method === 'POST') {
      const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
      const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
      const approvalId = typeof body?.approvalId === 'string' ? body.approvalId : '';
      if (!approvalId) throw new NagexError({ code: 'APPROVAL_ID_REQUIRED', category: 'VALIDATION', message: 'approvalId is required.', request_id: requestId });
      const result = await gmailApiService.executeReply({ approvalId, payload: body?.payload, tenantId, principalId, requestId });
      return { status: 200, data: result };
    }
    if (pathname === '/api/v1/tools/gmail/create-draft' && method === 'POST') {
      const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
      const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
      const approvalId = typeof body?.approvalId === 'string' ? body.approvalId : '';
      if (!approvalId) throw new NagexError({ code: 'APPROVAL_ID_REQUIRED', category: 'VALIDATION', message: 'approvalId is required.', request_id: requestId });
      const result = await gmailApiService.executeCreateDraft({ approvalId, payload: body?.payload, tenantId, principalId, requestId });
      return { status: 200, data: result };
    }
    if (pathname === '/api/v1/tools/gmail/search' && method === 'POST') {
      const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
      const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
      const query = typeof body?.query === 'string' ? body.query : '';
      const result = await gmailApiService.search({ tenantId, query, requestId });
      return { status: 200, data: result };
    }
    if (pathname === '/api/v1/tools/gmail/read-thread' && method === 'POST') {
      const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
      const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
      const threadId = typeof body?.threadId === 'string' ? body.threadId : '';
      if (!threadId) throw new NagexError({ code: 'THREAD_ID_REQUIRED', category: 'VALIDATION', message: 'threadId is required.', request_id: requestId });
      const result = await gmailApiService.readThread({ tenantId, threadId, requestId });
      return { status: 200, data: result };
    }

    // ── Browser Agent MVP (MASTER.md Section 14.5 item 06) ─────────────────
    if (pathname === '/api/v1/browser/sessions' && method === 'POST') {
      const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
      const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
      const result = await browserApiService.open({ tenantId, ownerId, requestId });
      return { status: 201, data: result };
    }
    if (pathname === '/api/v1/tools/browser/navigate' && method === 'POST') {
      const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
      const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
      const browserSessionId = typeof body?.browserSessionId === 'string' ? body.browserSessionId : '';
      const url = typeof body?.url === 'string' ? body.url : '';
      if (!browserSessionId) throw new NagexError({ code: 'BROWSER_SESSION_ID_REQUIRED', category: 'VALIDATION', message: 'browserSessionId is required.', request_id: requestId });
      if (!url) throw new NagexError({ code: 'BROWSER_URL_REQUIRED', category: 'VALIDATION', message: 'url is required.', request_id: requestId });
      const result = await browserApiService.navigate({ tenantId, ownerId, requestId, browserSessionId, url });
      return { status: 200, data: result };
    }
    if (pathname === '/api/v1/tools/browser/tabs' && method === 'POST') {
      const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
      const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
      const browserSessionId = typeof body?.browserSessionId === 'string' ? body.browserSessionId : '';
      if (!browserSessionId) throw new NagexError({ code: 'BROWSER_SESSION_ID_REQUIRED', category: 'VALIDATION', message: 'browserSessionId is required.', request_id: requestId });
      const result = await browserApiService.tabs({ tenantId, ownerId, requestId, browserSessionId });
      return { status: 200, data: { tabs: result } };
    }
    if (pathname === '/api/v1/tools/browser/snapshot' && method === 'POST') {
      const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
      const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
      const browserSessionId = typeof body?.browserSessionId === 'string' ? body.browserSessionId : '';
      if (!browserSessionId) throw new NagexError({ code: 'BROWSER_SESSION_ID_REQUIRED', category: 'VALIDATION', message: 'browserSessionId is required.', request_id: requestId });
      const result = await browserApiService.snapshot({ tenantId, ownerId, requestId, browserSessionId });
      return { status: 200, data: result };
    }
    if (pathname === '/api/v1/tools/browser/screenshot' && method === 'POST') {
      const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
      const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
      const browserSessionId = typeof body?.browserSessionId === 'string' ? body.browserSessionId : '';
      if (!browserSessionId) throw new NagexError({ code: 'BROWSER_SESSION_ID_REQUIRED', category: 'VALIDATION', message: 'browserSessionId is required.', request_id: requestId });
      const result = await browserApiService.screenshot({ tenantId, ownerId, requestId, browserSessionId });
      return { status: 200, data: result };
    }
    if (pathname === '/api/v1/tools/browser/scroll' && method === 'POST') {
      const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
      const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
      const browserSessionId = typeof body?.browserSessionId === 'string' ? body.browserSessionId : '';
      const direction = body?.direction === 'up' ? 'up' : 'down';
      if (!browserSessionId) throw new NagexError({ code: 'BROWSER_SESSION_ID_REQUIRED', category: 'VALIDATION', message: 'browserSessionId is required.', request_id: requestId });
      await browserApiService.scroll({ tenantId, ownerId, requestId, browserSessionId, direction, amountPx: typeof body?.amountPx === 'number' ? body.amountPx : undefined });
      return { status: 200, data: { status: 'SUCCEEDED' } };
    }
    if (pathname === '/api/v1/tools/browser/wait' && method === 'POST') {
      const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
      const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
      const browserSessionId = typeof body?.browserSessionId === 'string' ? body.browserSessionId : '';
      const ms = typeof body?.ms === 'number' ? body.ms : 1000;
      if (!browserSessionId) throw new NagexError({ code: 'BROWSER_SESSION_ID_REQUIRED', category: 'VALIDATION', message: 'browserSessionId is required.', request_id: requestId });
      await browserApiService.wait({ tenantId, ownerId, requestId, browserSessionId, ms });
      return { status: 200, data: { status: 'SUCCEEDED' } };
    }
    if (pathname === '/api/v1/tools/browser/type' && method === 'POST') {
      const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
      const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
      const browserSessionId = typeof body?.browserSessionId === 'string' ? body.browserSessionId : '';
      const selector = typeof body?.selector === 'string' ? body.selector : '';
      const text = typeof body?.text === 'string' ? body.text : '';
      if (!browserSessionId || !selector) throw new NagexError({ code: 'BROWSER_SELECTOR_REQUIRED', category: 'VALIDATION', message: 'browserSessionId and selector are required.', request_id: requestId });
      await browserApiService.type({ tenantId, ownerId, requestId, browserSessionId, selector, text });
      return { status: 200, data: { status: 'SUCCEEDED' } };
    }
    if (pathname === '/api/v1/tools/browser/select' && method === 'POST') {
      const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
      const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
      const browserSessionId = typeof body?.browserSessionId === 'string' ? body.browserSessionId : '';
      const selector = typeof body?.selector === 'string' ? body.selector : '';
      const value = typeof body?.value === 'string' ? body.value : '';
      if (!browserSessionId || !selector) throw new NagexError({ code: 'BROWSER_SELECTOR_REQUIRED', category: 'VALIDATION', message: 'browserSessionId and selector are required.', request_id: requestId });
      await browserApiService.select({ tenantId, ownerId, requestId, browserSessionId, selector, value });
      return { status: 200, data: { status: 'SUCCEEDED' } };
    }
    // The one entry point a client calls to click — the server resolves the
    // real target element live and decides whether this is a harmless
    // navigation click (executes immediately) or a consequential one
    // (Submit/Buy/Pay/Delete/...), in which case it returns an
    // APPROVAL_REQUIRED result with a real ActionApprovalRecord instead of
    // executing. This is genuinely different from Gmail/Calendar's
    // "client composes payload -> POST /api/v1/approvals" shape because
    // only the live page (not the client) knows what a selector resolves
    // to — see browser.service.ts's click() for the full reasoning.
    if (pathname === '/api/v1/tools/browser/click' && method === 'POST') {
      const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
      const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
      const browserSessionId = typeof body?.browserSessionId === 'string' ? body.browserSessionId : '';
      const selector = typeof body?.selector === 'string' ? body.selector : '';
      if (!browserSessionId || !selector) throw new NagexError({ code: 'BROWSER_SELECTOR_REQUIRED', category: 'VALIDATION', message: 'browserSessionId and selector are required.', request_id: requestId });
      const result = await browserApiService.click({ tenantId, ownerId, requestId, browserSessionId, selector });
      return { status: result.status === 'APPROVAL_REQUIRED' ? 201 : 200, data: result };
    }
    // Called only after the approval returned above has been approved via
    // the existing, unchanged, tool-agnostic POST /api/v1/approvals/:id/approve.
    if (pathname === '/api/v1/tools/browser/click/execute' && method === 'POST') {
      const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
      const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
      const approvalId = typeof body?.approvalId === 'string' ? body.approvalId : '';
      const browserSessionId = typeof body?.browserSessionId === 'string' ? body.browserSessionId : '';
      const selector = typeof body?.selector === 'string' ? body.selector : '';
      if (!approvalId) throw new NagexError({ code: 'APPROVAL_ID_REQUIRED', category: 'VALIDATION', message: 'approvalId is required.', request_id: requestId });
      if (!browserSessionId || !selector) throw new NagexError({ code: 'BROWSER_SELECTOR_REQUIRED', category: 'VALIDATION', message: 'browserSessionId and selector are required.', request_id: requestId });
      const result = await browserApiService.executeApprovedClick({ approvalId, browserSessionId, selector, tenantId, ownerId, requestId });
      return { status: 200, data: result };
    }
    if (pathname === '/api/v1/tools/browser/close' && method === 'POST') {
      const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
      const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
      const browserSessionId = typeof body?.browserSessionId === 'string' ? body.browserSessionId : '';
      if (!browserSessionId) throw new NagexError({ code: 'BROWSER_SESSION_ID_REQUIRED', category: 'VALIDATION', message: 'browserSessionId is required.', request_id: requestId });
      await browserApiService.close({ tenantId, ownerId, requestId, browserSessionId });
      return { status: 200, data: { status: 'SUCCEEDED' } };
    }
    if (pathname === '/api/v1/tools/browser/find' && method === 'POST') {
      const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
      const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
      const browserSessionId = typeof body?.browserSessionId === 'string' ? body.browserSessionId : '';
      const query = typeof body?.query === 'string' ? body.query : '';
      if (!browserSessionId || !query) throw new NagexError({ code: 'BROWSER_QUERY_REQUIRED', category: 'VALIDATION', message: 'browserSessionId and query are required.', request_id: requestId });
      const result = await browserApiService.find({ tenantId, ownerId, requestId, browserSessionId, query });
      return { status: 200, data: result };
    }
    if (pathname === '/api/v1/tools/browser/extract' && method === 'POST') {
      const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
      const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
      const browserSessionId = typeof body?.browserSessionId === 'string' ? body.browserSessionId : '';
      const target = (typeof body?.target === 'string' ? body.target : 'all') as any;
      if (!browserSessionId) throw new NagexError({ code: 'BROWSER_SESSION_ID_REQUIRED', category: 'VALIDATION', message: 'browserSessionId is required.', request_id: requestId });
      const result = await browserApiService.extract({ tenantId, ownerId, requestId, browserSessionId, target });
      return { status: 200, data: result };
    }
    if (pathname === '/api/v1/tools/browser/back' && method === 'POST') {
      const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
      const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
      const browserSessionId = typeof body?.browserSessionId === 'string' ? body.browserSessionId : '';
      if (!browserSessionId) throw new NagexError({ code: 'BROWSER_SESSION_ID_REQUIRED', category: 'VALIDATION', message: 'browserSessionId is required.', request_id: requestId });
      const result = await browserApiService.back({ tenantId, ownerId, requestId, browserSessionId });
      return { status: 200, data: result };
    }
    if (pathname === '/api/v1/tools/browser/forward' && method === 'POST') {
      const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
      const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
      const browserSessionId = typeof body?.browserSessionId === 'string' ? body.browserSessionId : '';
      if (!browserSessionId) throw new NagexError({ code: 'BROWSER_SESSION_ID_REQUIRED', category: 'VALIDATION', message: 'browserSessionId is required.', request_id: requestId });
      const result = await browserApiService.forward({ tenantId, ownerId, requestId, browserSessionId });
      return { status: 200, data: result };
    }
    if (pathname === '/api/v1/tools/browser/reload' && method === 'POST') {
      const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
      const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
      const browserSessionId = typeof body?.browserSessionId === 'string' ? body.browserSessionId : '';
      if (!browserSessionId) throw new NagexError({ code: 'BROWSER_SESSION_ID_REQUIRED', category: 'VALIDATION', message: 'browserSessionId is required.', request_id: requestId });
      const result = await browserApiService.reload({ tenantId, ownerId, requestId, browserSessionId });
      return { status: 200, data: result };
    }

    if (pathname.startsWith('/api/v1/tasks/') && pathname.endsWith('/run') && method === 'POST') {
      const taskId = pathname.slice('/api/v1/tasks/'.length, pathname.length - '/run'.length);
      const requestId = getHeaderValue(headers, 'x-request-id') || `req_task_run_${crypto.randomUUID()}`;
      const task = taskStore.get(taskId);
      if (!task) return { status: 404, data: { error: { code: 'TASK_NOT_FOUND', category: 'NOT_FOUND', message: `Task ${taskId} was not found.`, request_id: requestId } } };
      // Mirrors the `calendarService` DI pattern below: the shared
      // taskScheduler singleton (built on the real aiService) is used
      // unless a test injects a different `service`, in which case a
      // throwaway scheduler wraps that same injected model so a real
      // network call is never made from a test.
      const scheduler = service === aiService ? taskScheduler : new TaskScheduler(
        taskStore,
        taskRunStore,
        new CompositeTaskRunner(
          new PlanPreviewTaskRunner(service, planResolver, (principalId, prompt) => getRelevantMemories(principalId, prompt)),
          new ConditionalWatchTaskRunner(capabilityBroker, service),
          new BackgroundTaskRunner(taskStore, service, planResolver, (principalId, prompt) => getRelevantMemories(principalId, prompt)),
          new ExecutingTaskRunner(service, planResolver, capabilityBroker, (principalId, prompt) => getRelevantMemories(principalId, prompt), taskContinuations, durableTaskRunState),
        ),
        auditLogger,
      );
      const run = await scheduler.runOne(task);
      return { status: 200, data: run };
    }

    // V01a — test-only, env-gated deterministic plan injection. Exists
    // solely so a LIVE E2E harness (scripts/nagex-task-e2e-live.sh) can
    // drive a real Task run through ExecutingTaskRunner's real step-
    // execution/durable-state/approval path without depending on the real
    // planning LLM's variable output shape. This route does not exist
    // (falls through to the ordinary 404, indistinguishable from any other
    // unmatched path) unless NAGEX_ENABLE_TEST_PLAN_INJECTION is exactly
    // '1' — re-checked on every request, never cached. It only ever
    // substitutes the planning LLM call: PlanResolver.resolve() and
    // everything downstream (step execution, durable state, approval
    // continuation, finalization) is the real, unmodified production path,
    // writing to the same real stores a normal run would.
    if (pathname.startsWith('/api/v1/tasks/') && pathname.endsWith('/run-with-fixed-plan') && method === 'POST' && process.env.NAGEX_ENABLE_TEST_PLAN_INJECTION === '1') {
      const taskId = pathname.slice('/api/v1/tasks/'.length, pathname.length - '/run-with-fixed-plan'.length);
      const requestId = getHeaderValue(headers, 'x-request-id') || `req_task_fixedplan_${crypto.randomUUID()}`;
      const task = taskStore.get(taskId);
      if (!task) return { status: 404, data: { error: { code: 'TASK_NOT_FOUND', category: 'NOT_FOUND', message: `Task ${taskId} was not found.`, request_id: requestId } } };
      const steps = Array.isArray(body?.steps) ? body.steps : [];
      if (steps.length === 0) {
        return { status: 400, data: { error: { code: 'FIXED_PLAN_STEPS_REQUIRED', category: 'VALIDATION', message: 'A non-empty steps array is required.', request_id: requestId } } };
      }
      let resolved;
      try {
        resolved = planResolver.resolve({ goal: task.objective, summary: 'V01a test-only fixed-plan injection.', reasoningSummary: 'V01a test-only fixed-plan injection.', suggestions: [], steps } as unknown as PlanPreview);
      } catch (error) {
        return modelErrorResult(error);
      }
      // A throwaway ExecutingTaskRunner wired to the exact same real
      // capabilityBroker/taskContinuations/durableTaskRunState the
      // production taskRunner uses — the instance is ephemeral, but every
      // store it writes to is the real one, so restart-recovery inspection
      // sees genuine data.
      const fixedPlanRunner = new ExecutingTaskRunner(aiService, planResolver, capabilityBroker, (principalId, prompt) => getRelevantMemories(principalId, prompt), taskContinuations, durableTaskRunState);
      const scheduler = new TaskScheduler(
        taskStore,
        taskRunStore,
        { run: (t: TaskRecord, reqId: string, runId: string) => fixedPlanRunner.runWithResolvedPlan(t, reqId, runId, resolved) },
        auditLogger,
        undefined,
        notificationEngine,
      );
      const run = await scheduler.runOne(task);
      return { status: 200, data: run };
    }

    if (pathname === '/api/v1/tools/google-calendar/free-slots' && method === 'POST') {
      const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
      const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
      const config = readGoogleOAuthConfig();
      const accessToken = config ? await googleTokenStore.getValidAccessToken(tenantId, config, fetch, requestId) : null;
      if (!accessToken) throw new NagexError({ code: 'GOOGLE_CALENDAR_DISCONNECTED', category: 'POLICY', message: 'Google Calendar is not connected.', request_id: requestId });
      const calendarId = (typeof body?.calendarId === 'string' && body.calendarId) || 'primary';
      const timeMin = typeof body?.timeMin === 'string' ? body.timeMin : new Date().toISOString();
      const timeMax = typeof body?.timeMax === 'string' ? body.timeMax : new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
      const busy = await queryFreeBusy(accessToken, { calendarId, timeMin, timeMax }, fetch, requestId);
      return { status: 200, data: { busy, freeSlots: computeFreeSlots(busy, timeMin, timeMax) } };
    }

    // ── Telegram Integration (MASTER.md Section 14.5 item 10) ─────────────
    if (pathname === '/api/v1/integrations/telegram/status' && method === 'GET') {
      return { status: 200, data: telegramBotClient.getStatus() };
    }
    if (pathname === '/api/v1/integrations/telegram/webhook' && method === 'POST') {
      const requestId = getHeaderValue(headers, 'x-request-id') || `req_tg_wh_${crypto.randomUUID()}`;
      const update = (body || {}) as unknown as TelegramUpdate;
      const result = await telegramApiService.processUpdate(update, requestId);
      return { status: 200, data: { status: 'ok', handled: result !== null, result } };
    }
    if (pathname === '/api/v1/integrations/telegram/send' && method === 'POST') {
      const requestId = getHeaderValue(headers, 'x-request-id') || `req_tg_send_${crypto.randomUUID()}`;
      const chatId = body?.chatId ? (typeof body.chatId === 'number' || typeof body.chatId === 'string' ? body.chatId : '') : '';
      const text = typeof body?.text === 'string' ? body.text.trim() : '';
      if (!chatId || !text) {
        throw new NagexError({ code: 'INVALID_TELEGRAM_SEND_PAYLOAD', category: 'VALIDATION', message: 'chatId and text are required.', request_id: requestId });
      }
      const sent = await telegramBotClient.sendMessage({ chatId, text });
      return { status: 200, data: { success: sent } };
    }
    if (pathname === '/api/v1/integrations/telegram/identity/link' && method === 'POST') {
      const requestId = getHeaderValue(headers, 'x-request-id') || `req_tg_link_${crypto.randomUUID()}`;
      const telegramUserId = String(body?.telegramUserId || '').trim();
      const principalId = typeof body?.principalId === 'string' && body.principalId.trim() ? body.principalId.trim() : (getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001');
      const tenantId = typeof body?.tenantId === 'string' && body.tenantId.trim() ? body.tenantId.trim() : (getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID);
      const username = typeof body?.username === 'string' ? body.username.trim() : undefined;

      if (!telegramUserId) {
        throw new NagexError({ code: 'TELEGRAM_USER_ID_REQUIRED', category: 'VALIDATION', message: 'telegramUserId is required.', request_id: requestId });
      }
      const record = telegramIdentityStore.link(telegramUserId, principalId, tenantId, username);
      auditLogger.logEvent({
        actor: { type: 'user', id: principalId },
        tenant_id: tenantId,
        action: 'channel:telegram_identity_linked',
        resource: { type: 'TelegramIdentityLink', id: telegramUserId },
        result: 'SUCCESS',
        request_id: requestId,
        details: { telegramUserId, principalId, tenantId, username },
      });
      return { status: 200, data: record };
    }
    if (pathname === '/api/v1/integrations/telegram/identities' && method === 'GET') {
      const identities = telegramIdentityStore.list();
      return { status: 200, data: { identities, total: identities.length } };
    }

    // ── Slack Integration (MASTER.md Section 14.5 item 11) ────────────────
    if (pathname === '/api/v1/integrations/slack/status' && method === 'GET') {
      return { status: 200, data: slackClient.getStatus() };
    }
    if (pathname === '/api/v1/integrations/slack/events' && method === 'POST') {
      const requestId = getHeaderValue(headers, 'x-request-id') || `req_slack_evt_${crypto.randomUUID()}`;
      const payload = (body || {}) as unknown as SlackEventPayload;
      if (payload.type === 'url_verification' && payload.challenge) {
        return { status: 200, data: { challenge: payload.challenge } };
      }
      const result = await slackApiService.processEvent(payload, requestId);
      return { status: 200, data: { status: 'ok', handled: result !== null, result } };
    }
    if (pathname === '/api/v1/integrations/slack/send' && method === 'POST') {
      const requestId = getHeaderValue(headers, 'x-request-id') || `req_slack_send_${crypto.randomUUID()}`;
      const channel = typeof body?.channel === 'string' ? body.channel.trim() : '';
      const text = typeof body?.text === 'string' ? body.text.trim() : '';
      const threadTs = typeof body?.threadTs === 'string' ? body.threadTs.trim() : undefined;
      if (!channel || !text) {
        throw new NagexError({ code: 'INVALID_SLACK_SEND_PAYLOAD', category: 'VALIDATION', message: 'channel and text are required.', request_id: requestId });
      }
      const sent = await slackClient.postMessage({ channel, text, threadTs });
      return { status: 200, data: { success: sent } };
    }
    if (pathname === '/api/v1/integrations/slack/identity/link' && method === 'POST') {
      const requestId = getHeaderValue(headers, 'x-request-id') || `req_slack_link_${crypto.randomUUID()}`;
      const slackUserId = String(body?.slackUserId || '').trim();
      const principalId = typeof body?.principalId === 'string' && body.principalId.trim() ? body.principalId.trim() : (getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001');
      const tenantId = typeof body?.tenantId === 'string' && body.tenantId.trim() ? body.tenantId.trim() : (getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID);
      const slackTeamId = typeof body?.slackTeamId === 'string' ? body.slackTeamId.trim() : undefined;
      const username = typeof body?.username === 'string' ? body.username.trim() : undefined;

      if (!slackUserId) {
        throw new NagexError({ code: 'SLACK_USER_ID_REQUIRED', category: 'VALIDATION', message: 'slackUserId is required.', request_id: requestId });
      }
      const record = slackIdentityStore.link(slackUserId, principalId, tenantId, slackTeamId, username);
      auditLogger.logEvent({
        actor: { type: 'user', id: principalId },
        tenant_id: tenantId,
        action: 'channel:slack_identity_linked',
        resource: { type: 'SlackIdentityLink', id: slackUserId },
        result: 'SUCCESS',
        request_id: requestId,
        details: { slackUserId, principalId, tenantId, slackTeamId, username },
      });
      return { status: 200, data: record };
    }
    if (pathname === '/api/v1/integrations/slack/identities' && method === 'GET') {
      const identities = slackIdentityStore.list();
      return { status: 200, data: { identities, total: identities.length } };
    }

    // ── Notification Engine (MASTER.md Section 14.5 item 12) ──────────────
    if (pathname === '/api/v1/notifications' && method === 'GET') {
      const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const notifications = notificationApiService.list(principalId);
      const unreadCount = notificationApiService.getUnreadCount(principalId);
      return { status: 200, data: { notifications, unreadCount, total: notifications.length } };
    }
    if (pathname === '/api/v1/notifications/read-all' && method === 'POST') {
      const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const updatedCount = notificationApiService.markAllAsRead(principalId);
      return { status: 200, data: { success: true, updatedCount } };
    }
    if (pathname.startsWith('/api/v1/notifications/') && pathname.endsWith('/read') && method === 'POST') {
      const id = pathname.slice('/api/v1/notifications/'.length, pathname.length - '/read'.length);
      const record = notificationApiService.markAsRead(id);
      if (!record) {
        return { status: 404, data: { error: { code: 'NOTIFICATION_NOT_FOUND', category: 'NOT_FOUND', message: `Notification ${id} was not found.` } } };
      }
      return { status: 200, data: record };
    }
    if (pathname === '/api/v1/notifications/dispatch' && method === 'POST') {
      const requestId = getHeaderValue(headers, 'x-request-id') || `req_notif_disp_${crypto.randomUUID()}`;
      const principalId = typeof body?.principalId === 'string' && body.principalId.trim() ? body.principalId.trim() : (getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001');
      const tenantId = typeof body?.tenantId === 'string' && body.tenantId.trim() ? body.tenantId.trim() : (getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID);
      const type = (typeof body?.type === 'string' ? body.type : 'SYSTEM_ALERT') as any;
      const title = typeof body?.title === 'string' ? body.title.trim() : 'Notification';
      const bodyText = typeof body?.body === 'string' ? body.body.trim() : '';

      if (!bodyText) {
        throw new NagexError({ code: 'NOTIFICATION_BODY_REQUIRED', category: 'VALIDATION', message: 'Notification body is required.', request_id: requestId });
      }

      const record = await notificationApiService.dispatch({
        tenantId,
        principalId,
        type,
        title,
        body: bodyText,
        metadata: body?.metadata && typeof body.metadata === 'object' ? (body.metadata as Record<string, unknown>) : undefined,
        requestId,
      });
      return { status: 201, data: record };
    }

    // ─── Desktop Quick Wake Endpoints ───
    if (pathname === '/api/v1/desktop/quickwake/status' && method === 'GET') {
      return { status: 200, data: { hotkey: desktopRuntimeEngine.getHotkey(), windowState: desktopRuntimeEngine.getWindowState(), isRunning: desktopRuntimeEngine.isRunning() } };
    }
    if (pathname === '/api/v1/desktop/quickwake/toggle' && method === 'POST') {
      const requestId = getHeaderValue(headers, 'x-request-id') || `req_hk_toggle_${crypto.randomUUID()}`;
      const state = desktopRuntimeEngine.triggerGlobalHotkey(requestId);
      return { status: 200, data: { hotkey: desktopRuntimeEngine.getHotkey(), windowState: state, isRunning: desktopRuntimeEngine.isRunning() } };
    }
    if (pathname === '/api/v1/desktop/quickwake/tray/action' && method === 'POST') {
      const requestId = getHeaderValue(headers, 'x-request-id') || `req_tray_act_${crypto.randomUUID()}`;
      const action = typeof body?.action === 'string' ? body.action.trim() : '';
      if (!action) {
        throw new NagexError({ code: 'INVALID_TRAY_ACTION', category: 'VALIDATION', message: 'Tray action string is required.', request_id: requestId });
      }
      const result = desktopRuntimeEngine.handleTrayAction(action as any, requestId);
      return { status: 200, data: result };
    }

    // ─── Personal Workspace Async API Routes ───
    if (pathname === '/api/v1/workspace/uploads/init' && method === 'POST') {
      const filename = (body?.filename as string) || 'upload.bin';
      const mimeType = (body?.mimeType as string) || 'application/octet-stream';
      const sizeBytes = Number(body?.sizeBytes || 0);
      const intent = body?.intent as any;
      const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || 'ten_production_01';
      const initResult = await quickCaptureService.initUpload({
        ownerId: principalId,
        tenantId,
        filename,
        mimeType,
        sizeBytes,
        intent,
      });
      return { status: 201, data: initResult };
    }

    if (pathname === '/api/v1/workspace/uploads/complete' && method === 'POST') {
      const captureId = (body?.captureId as string) || '';
      const objectKey = (body?.objectKey as string) || '';
      const mimeType = (body?.mimeType as string) || 'application/octet-stream';
      const checksum = (body?.checksum as string) || '';
      const sizeBytes = Number(body?.sizeBytes || 0);
      const originalFilename = (body?.originalFilename as string) || 'upload.bin';
      const rawData = body?.data ? Buffer.from(body.data as any) : undefined;
      const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || 'ten_production_01';
      const item = await quickCaptureService.completeUpload({
        captureId,
        ownerId: principalId,
        tenantId,
        objectKey,
        mimeType,
        checksum,
        sizeBytes,
        originalFilename,
        data: rawData,
      });
      return { status: 200, data: item };
    }

    if (pathname === '/api/v1/workspace/upload' && method === 'POST') {
      const filename = (body?.filename as string) || 'upload.bin';
      const mimeType = (body?.mimeType as string) || 'application/octet-stream';
      const type = (body?.type as any) || (mimeType.startsWith('audio/') ? 'AUDIO' : 'FILE');
      const source = (body?.source as any) || 'WEB';
      const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || 'ten_production_01';
      const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
      // Accept body.base64 (from frontend audio/file recorder), body.data (binary stream),
      // or body.content (plain text fallback). Reject empty payloads.
      let rawData: Buffer;
      if (typeof body?.base64 === 'string' && body.base64.length > 0) {
        rawData = Buffer.from(body.base64, 'base64');
      } else if (body?.data) {
        rawData = typeof body.data === 'string' ? Buffer.from(body.data, 'base64') : Buffer.from(body.data as any);
      } else if (typeof body?.content === 'string' && body.content.length > 0) {
        rawData = Buffer.from(body.content, 'utf8');
      } else {
        throw new NagexError({ code: 'EMPTY_FILE_PAYLOAD', category: 'VALIDATION', message: 'Binary payload data is required (base64, data, or content).', request_id: requestId });
      }
      if (rawData.length > 50 * 1024 * 1024) {
        throw new NagexError({ code: 'FILE_TOO_LARGE', category: 'VALIDATION', message: 'File size exceeds maximum allowed limit of 50 MB.', request_id: requestId });
      }
      const item = await quickCaptureService.uploadBinaryObject({
        ownerId: principalId,
        tenantId,
        type,
        filename,
        mimeType,
        data: rawData,
        source,
      });
      return { status: 201, data: item };
    }

    if ((pathname === '/api/v1/workspace/captures' || pathname === '/api/v1/workspace/capture') && method === 'POST') {
      const type = (body?.type as any) || 'TEXT';
      const content = (body?.content as string) || '';
      const source = (body?.source as any) || 'WEB';
      const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || 'ten_production_01';
      const item = await quickCaptureService.captureTextOrLink({
        ownerId: principalId,
        tenantId,
        type,
        content,
        source,
      });
      return { status: 201, data: item };
    }

    if (pathname.startsWith('/api/v1/workspace/capture/') && (method === 'PATCH' || method === 'POST')) {
      const captureId = pathname.slice('/api/v1/workspace/capture/'.length);
      const action = (body?.status as any) || (body?.action as any) || 'ACTIONED';
      const item = await quickCaptureService.actionCapture(captureId, action);
      if (!item) {
        return { status: 404, data: { error: 'ITEM_NOT_FOUND', message: `Capture item ${captureId} not found.` } };
      }
      return { status: 200, data: item };
    }

    if (pathname.startsWith('/api/v1/workspace/items/') && pathname.endsWith('/download') && method === 'GET') {
      const captureId = pathname.slice('/api/v1/workspace/items/'.length, pathname.length - '/download'.length);
      const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const downloadUrl = await quickCaptureService.getDownloadUrl(captureId, principalId);
      if (!downloadUrl) {
        return { status: 404, data: { error: 'ITEM_NOT_FOUND', message: `Capture item ${captureId} not found or no object attached.` } };
      }
      return { status: 200, data: { captureId, downloadUrl } };
    }

    if (pathname.startsWith('/api/v1/workspace/items/') && pathname.endsWith('/preview') && method === 'GET') {
      const captureId = pathname.slice('/api/v1/workspace/items/'.length, pathname.length - '/preview'.length);
      const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const previewUrl = await quickCaptureService.getPreviewUrl(captureId, principalId);
      if (!previewUrl) {
        return { status: 404, data: { error: 'ITEM_NOT_FOUND', message: `Capture item ${captureId} not found or no object attached.` } };
      }
      return { status: 200, data: { captureId, previewUrl } };
    }

    if (pathname.startsWith('/api/v1/workspace/items/') && pathname.endsWith('/action') && method === 'POST') {
      const captureId = pathname.slice('/api/v1/workspace/items/'.length, pathname.length - '/action'.length);
      const action = (body?.action as any) || 'ACTIONED';
      const item = await quickCaptureService.actionCapture(captureId, action);
      if (!item) {
        return { status: 404, data: { error: 'ITEM_NOT_FOUND', message: `Capture item ${captureId} not found.` } };
      }
      return { status: 200, data: item };
    }

    if (pathname.startsWith('/api/v1/workspace/items/') && pathname.includes('/candidates/') && pathname.endsWith('/action') && method === 'POST') {
      const parts = pathname.slice('/api/v1/workspace/items/'.length).split('/candidates/');
      const captureId = parts[0];
      const candidateId = parts[1] ? parts[1].replace(/\/action$/, '') : '';
      const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
      const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const action = body?.action === 'ACCEPT' ? 'ACCEPT' : 'REJECT';

      const updated = await quickCaptureService.actionCandidate({
        captureId,
        candidateId,
        action,
        ownerId,
        tenantId,
      });

      if (!updated) {
        return { status: 404, data: { error: 'CANDIDATE_NOT_FOUND', message: `Candidate ${candidateId} or capture ${captureId} not found.` } };
      }
      return { status: 200, data: updated };
    }

    // ─── Phase 1 STEP 5 — Canonical Candidate Model API ───
    // Accept/reject here ONLY change the candidate's own status — they never
    // create a Task, request a Calendar approval, write Memory, or index
    // Knowledge (item J). Real execution is a later, separate Action phase.
    if (pathname === '/api/v1/candidates' && method === 'GET') {
      const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
      const statusFilter = query.status as CandidateStatus | undefined;
      const typeFilter = query.type as CandidateType | undefined;
      const candidates = quickCaptureService.listCandidates(ownerId, tenantId, {
        status: statusFilter,
        type: typeFilter,
      });
      return { status: 200, data: { candidates } };
    }

    // ─── Phase 1 STEP 8 — Consumer Activity Projection ───
    // Tenant/principal-isolated, durable, human-readable (item F/H/I) —
    // never the raw AuditLogger and never the legacy non-tenant-isolated
    // executionHistory array.
    if (pathname === '/api/v1/activity' && method === 'GET') {
      const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
      const limitRaw = Number(query.limit);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;
      const activities = quickCaptureService.listActivity(ownerId, tenantId, limit);
      return { status: 200, data: { activities } };
    }

    if (pathname.startsWith('/api/v1/candidates/') && pathname.endsWith('/accept') && method === 'POST') {
      const candidateId = pathname.slice('/api/v1/candidates/'.length, pathname.length - '/accept'.length);
      const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
      const record = quickCaptureService.acceptCandidate(candidateId, ownerId, tenantId);
      return { status: 200, data: record };
    }

    if (pathname.startsWith('/api/v1/candidates/') && pathname.endsWith('/reject') && method === 'POST') {
      const candidateId = pathname.slice('/api/v1/candidates/'.length, pathname.length - '/reject'.length);
      const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
      const record = quickCaptureService.rejectCandidate(candidateId, ownerId, tenantId);
      return { status: 200, data: record };
    }

    // ─── Phase 1 STEP 7 — Real Actions ───
    // Execute/retry ONLY ever advance a candidate's own `action` sub-state —
    // Candidate Review (accept/reject above) is a separate operation from
    // Action execution, and for CALENDAR specifically this first call only
    // ever requests the existing Action Approval; the real Google write
    // still requires that approval to be separately granted via the
    // unchanged /api/v1/approvals/:id/approve endpoint.
    if (pathname.startsWith('/api/v1/candidates/') && pathname.endsWith('/execute') && method === 'POST') {
      const candidateId = pathname.slice('/api/v1/candidates/'.length, pathname.length - '/execute'.length);
      const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
      const record = await quickCaptureService.executeCandidateAction(candidateId, ownerId, tenantId);
      return { status: 200, data: record };
    }

    if (pathname.startsWith('/api/v1/candidates/') && pathname.endsWith('/retry') && method === 'POST') {
      const candidateId = pathname.slice('/api/v1/candidates/'.length, pathname.length - '/retry'.length);
      const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
      const record = await quickCaptureService.retryCandidateAction(candidateId, ownerId, tenantId);
      return { status: 200, data: record };
    }

    if (pathname.startsWith('/api/v1/candidates/') && pathname.endsWith('/action') && method === 'GET') {
      const candidateId = pathname.slice('/api/v1/candidates/'.length, pathname.length - '/action'.length);
      const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
      const action = quickCaptureService.getCandidateAction(candidateId, ownerId, tenantId);
      return { status: 200, data: { candidateId, action } };
    }

    if (pathname.startsWith('/api/v1/candidates/') && method === 'PATCH') {
      const candidateId = pathname.slice('/api/v1/candidates/'.length);
      const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
      const record = quickCaptureService.modifyCandidate(candidateId, ownerId, tenantId, {
        title: typeof body?.title === 'string' ? body.title : undefined,
        payload: (body?.payload && typeof body.payload === 'object') ? body.payload as Record<string, unknown> : undefined,
      });
      return { status: 200, data: record };
    }

    if (pathname.startsWith('/api/v1/candidates/') && method === 'GET') {
      const candidateId = pathname.slice('/api/v1/candidates/'.length);
      const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
      const record = quickCaptureService.getCandidate(candidateId, ownerId, tenantId);
      if (!record) {
        return { status: 404, data: { error: 'CANDIDATE_NOT_FOUND', message: `Candidate ${candidateId} not found.` } };
      }
      return { status: 200, data: record };
    }

    if (pathname.startsWith('/api/v1/workspace/items/') && pathname.endsWith('/retry') && method === 'POST') {
      const captureId = pathname.slice('/api/v1/workspace/items/'.length, pathname.length - '/retry'.length);
      const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const retried = await quickCaptureService.retryCapture(captureId, ownerId);
      if (!retried) {
        return { status: 404, data: { error: 'ITEM_NOT_FOUND', message: `Capture item ${captureId} not found.` } };
      }
      return { status: 200, data: retried };
    }

    if (pathname.startsWith('/api/v1/workspace/items/') && !pathname.endsWith('/download') && !pathname.endsWith('/preview') && !pathname.endsWith('/action') && !pathname.endsWith('/retry') && !pathname.includes('/candidates/') && method === 'GET') {
      const captureId = pathname.slice('/api/v1/workspace/items/'.length);
      const ownerId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const item = await quickCaptureService.getCaptureItem(captureId, ownerId);
      if (!item) {
        return { status: 404, data: { error: 'ITEM_NOT_FOUND', message: `Capture item ${captureId} not found.` } };
      }
      return { status: 200, data: item };
    }

    if (pathname.startsWith('/api/v1/workspace/items/') && method === 'DELETE') {
      const captureId = pathname.slice('/api/v1/workspace/items/'.length);
      const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const deleted = await quickCaptureService.deleteCaptureItem(captureId, principalId);
      return { status: 200, data: { success: deleted, captureId } };
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

  if (pathname === '/api/v1/health' && method === 'GET') {
    return { status: 200, data: { status: 'UP', service: 'NAgex Personal AI Platform API', version: '0.1.0', runtime_active: true, active_executions: executionHistory.length, uptime_seconds: Math.floor(process.uptime()) } };
  }

  if (pathname === '/api/v1/vcs/status' && method === 'GET') {
    return { status: 200, data: getVcsStatus() };
  }

  if (pathname === '/api/v1/memory' && method === 'GET') {
    const activeUserMems = memoryEngine.getActiveMemories('USER', principal.id);
    const activeSessionMems = memoryEngine.getActiveMemories('SESSION', principal.id);
    const activeAgentMems = memoryEngine.getActiveMemories('AGENT', principal.id);
    const activeTenantMems = memoryEngine.getActiveMemories('TENANT', principal.id);
    const allMemories = [...activeUserMems, ...activeSessionMems, ...activeAgentMems, ...activeTenantMems].map((m) => ({ ...m, pinned: pinnedMemories.has(m.id) }));
    return { status: 200, data: { memories: allMemories, total: allMemories.length } };
  }

  if (pathname === '/api/v1/memory' && method === 'POST') {
    const scope = ((body?.scope as string) || 'USER') as MemoryScope;
    const subject = (body?.subject as string) || 'General';
    const predicate = (body?.predicate as string) || 'note';
    const value = body?.value || '';
    const rec = memoryEngine.proposeMemory(scope, principal.id, { subject, predicate, value });
    memoryEngine.activateMemory(rec.id);
    if (body?.pinned) pinnedMemories.add(rec.id);
    return { status: 201, data: { ...rec, pinned: pinnedMemories.has(rec.id) } };
  }

  if (pathname.startsWith('/api/v1/memory/') && method === 'DELETE') {
    const memId = pathname.replace('/api/v1/memory/', '');
    try {
      memoryEngine.deleteMemory(memId);
    } catch (error) {
      return modelErrorResult(error);
    }
    pinnedMemories.delete(memId);
    return { status: 200, data: { success: true, deleted_id: memId } };
  }

  if (pathname.startsWith('/api/v1/memory/') && pathname.endsWith('/pin') && method === 'PUT') {
    const memId = pathname.replace('/api/v1/memory/', '').replace('/pin', '');
    if (pinnedMemories.has(memId)) pinnedMemories.delete(memId);
    else pinnedMemories.add(memId);
    return { status: 200, data: { success: true, pinned: pinnedMemories.has(memId) } };
  }

  if (pathname === '/api/v1/plans' && method === 'GET') {
    return { status: 200, data: { plans: planRegistry, total: planRegistry.length } };
  }

  if (pathname === '/api/v1/skills' && method === 'GET') {
    const skills = canonicalSkillRegistry.list();
    return { status: 200, data: { skills, total: skills.length } };
  }

  if (pathname === '/api/v1/tools' && method === 'GET') {
    const tools = canonicalToolRegistry.list();
    return { status: 200, data: { tools, total: tools.length } };
  }

  if (pathname === '/api/v1/approvals' && method === 'GET') {
    return { status: 200, data: { approvals: approvalQueue, total: approvalQueue.length } };
  }

  if (pathname === '/api/v1/approvals' && method === 'POST') {
    const requestId = `req_appr_${Date.now()}`;
    const toolId = typeof body?.toolId === 'string' ? body.toolId : '';
    try {
      if (toolId === GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID) {
        const record = googleCalendarService.requestCreateEventApproval({ tenantId, principalId: principal.id, payload: body?.payload, requestId });
        return { status: 201, data: record };
      }
      if (toolId === GOOGLE_CALENDAR_UPDATE_EVENT_TOOL_ID) {
        const record = googleCalendarService.requestUpdateEventApproval({ tenantId, principalId: principal.id, payload: body?.payload, requestId });
        return { status: 201, data: record };
      }
      if (toolId === GOOGLE_CALENDAR_CANCEL_EVENT_TOOL_ID) {
        const record = googleCalendarService.requestCancelEventApproval({ tenantId, principalId: principal.id, payload: body?.payload, requestId });
        return { status: 201, data: record };
      }
      if (toolId === GOOGLE_CALENDAR_RESPOND_EVENT_TOOL_ID) {
        const record = googleCalendarService.requestRespondToEventApproval({ tenantId, principalId: principal.id, payload: body?.payload, requestId });
        return { status: 201, data: record };
      }
      if (toolId === GMAIL_SEND_EMAIL_TOOL_ID || toolId === GMAIL_REPLY_TOOL_ID || toolId === GMAIL_CREATE_DRAFT_TOOL_ID) {
        const record = gmailService.requestApproval({ toolId, tenantId, principalId: principal.id, payload: body?.payload, requestId });
        return { status: 201, data: record };
      }
      throw new NagexError({ code: 'UNSUPPORTED_APPROVAL_TOOL', category: 'VALIDATION', message: `No approval-gated execution is registered for toolId "${toolId}".`, request_id: requestId });
    } catch (error) {
      return modelErrorResult(error);
    }
  }

  if (pathname.startsWith('/api/v1/approvals/') && pathname !== '/api/v1/approvals/calendar-event' && method === 'GET') {
    const apprId = pathname.slice('/api/v1/approvals/'.length);
    const record = googleCalendarService.getApproval(apprId);
    if (!record) {
      return { status: 404, data: { error: 'APPROVAL_NOT_FOUND', message: `Approval ${apprId} was not found.` } };
    }
    return { status: 200, data: record };
  }

  if (pathname === '/api/v1/approvals/calendar-event' && method === 'POST') {
    const requestId = `req_appr_${Date.now()}`;
    try {
      const record = googleCalendarService.requestCreateEventApproval({ tenantId, principalId: principal.id, payload: body?.payload, requestId });
      return { status: 201, data: record };
    } catch (error) {
      return modelErrorResult(error);
    }
  }

  if (pathname.startsWith('/api/v1/approvals/') && (pathname.endsWith('/approve') || pathname.endsWith('/reject')) && method === 'POST') {
    const isApprove = pathname.endsWith('/approve');
    const suffix = isApprove ? '/approve' : '/reject';
    const apprId = pathname.slice('/api/v1/approvals/'.length, pathname.length - suffix.length);
    const requestId = `req_appr_${Date.now()}`;
    try {
      const record = isApprove
        ? googleCalendarService.approve(apprId, principal.id, requestId)
        : googleCalendarService.reject(apprId, principal.id, requestId);
      // P02 — fire-and-forget: this route is synchronous and its response
      // must not change (still 200 with the approval record) whether or
      // not a Task continuation exists for this approvalId. A genuine
      // no-op for every non-Task-originated approval.
      if (isApprove) taskContinuationCoordinator.onApproved(apprId).catch(() => {});
      else taskContinuationCoordinator.onRejected(apprId);
      return { status: 200, data: record };
    } catch (error) {
      return modelErrorResult(error);
    }
  }

  if (pathname.startsWith('/api/v1/approvals/') && method === 'POST') {
    const apprId = pathname.replace('/api/v1/approvals/', '').replace('/action', '');
    const action = (body?.action as string) || 'APPROVE';
    const item = approvalQueue.find((a) => a.id === apprId);
    if (item) {
      item.status = action === 'APPROVE' ? 'APPROVED' : 'REJECTED';
      auditLogger.logEvent({
        actor: principal,
        tenant_id: tenantId,
        action: action === 'APPROVE' ? 'approval:granted' : 'approval:rejected',
        resource: { type: 'Approval', id: apprId },
        result: 'SUCCESS',
        request_id: `req_appr_${Date.now()}`,
      });
      return { status: 200, data: item };
    }

    // Not a legacy demo approval — try the real, hash-verified action approvals
    // (e.g. Google Calendar create-event requests) sharing this same endpoint.
    const requestId = `req_appr_${Date.now()}`;
    try {
      const record = action === 'APPROVE'
        ? googleCalendarService.approve(apprId, principal.id, requestId)
        : googleCalendarService.reject(apprId, principal.id, requestId);
      // P02 — same fire-and-forget continuation hook as the /approve
      // /reject route above; this legacy /action endpoint shares the same
      // underlying approval store, so a Task continuation may equally be
      // waiting on an approvalId granted/rejected through this path.
      if (action === 'APPROVE') taskContinuationCoordinator.onApproved(apprId).catch(() => {});
      else taskContinuationCoordinator.onRejected(apprId);
      return { status: 200, data: record };
    } catch (error) {
      return modelErrorResult(error);
    }
  }

  if (pathname === '/api/v1/oauth/google/start' && method === 'GET') {
    const config = readGoogleOAuthConfig();
    if (!config) {
      return { status: 503, data: { error: 'GOOGLE_OAUTH_NOT_CONFIGURED', message: 'GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI must be set.' } };
    }
    pendingGoogleOAuthState = crypto.randomUUID();
    // Real browser navigation: redirect straight to Google, never hand back
    // the authorize URL as a JSON body for this endpoint.
    return { status: 302, data: null, redirectTo: buildGoogleAuthorizeUrl(config, pendingGoogleOAuthState) };
  }

  if (pathname === '/api/v1/oauth/google/start-url' && method === 'GET') {
    const config = readGoogleOAuthConfig();
    if (!config) {
      return { status: 503, data: { error: 'GOOGLE_OAUTH_NOT_CONFIGURED', message: 'GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI must be set.' } };
    }
    pendingGoogleOAuthState = crypto.randomUUID();
    return { status: 200, data: { authorizeUrl: buildGoogleAuthorizeUrl(config, pendingGoogleOAuthState) } };
  }

  if (pathname === '/api/v1/quickwake/config' && method === 'GET') return { status: 200, data: quickWakeConfig };
  if (pathname === '/api/v1/quickwake/config' && method === 'POST') {
    if (body) Object.assign(quickWakeConfig, body);
    return { status: 200, data: quickWakeConfig };
  }

  if (pathname === '/api/v1/autonomy/config' && method === 'GET') return { status: 200, data: autonomyConfig };
  if (pathname === '/api/v1/autonomy/config' && method === 'POST') {
    if (body?.level) autonomyConfig.level = body.level as string;
    return { status: 200, data: autonomyConfig };
  }

  if (pathname === '/api/v1/executions' && method === 'POST') {
    const taskObjective = (body?.objective as string) || 'Unnamed task';
    const agentId = (body?.agent_id as string) || 'agt_personal_ai';
    const headerRequestId = headers['x-request-id'] || headers['X-Request-Id'];
    const requestId = (Array.isArray(headerRequestId) ? headerRequestId[0] : headerRequestId) || `req_${Date.now()}`;

    const decision = pdp.evaluate({ principal, tenant_context: tenantContext, action: 'agent:execute', resource_type: 'Agent', resource_id: agentId, principal_permissions: ['agent:execute'] });
    if (decision.decision !== 'ALLOW') {
      const outcome = describeDeniedDecision(decision);
      auditLogger.logEvent({ actor: principal, tenant_id: tenantId, action: 'agent:execute', resource: { type: 'Agent', id: agentId }, result: outcome.auditResult, reason_code: decision.reason_code, request_id: requestId });
      return { status: outcome.httpStatus, data: { error: outcome.errorCode, reason: decision.reason_code, request_id: requestId } };
    }

    ensureTenantSeeded(tenantId);
    try {
      creditEngine.chargeCredits(tenantId, MANAGED_AI_COST_BREAKDOWN, `pending_${requestId}`);
    } catch (err) {
      if (err instanceof NagexError && err.code === 'BILLING_INSUFFICIENT_CREDIT') {
        return { status: 402, data: { error: err.code, message: err.message, request_id: requestId } };
      }
      throw err;
    }

    const execution = runtime.createExecution(tenantContext, agentId);
    auditLogger.logEvent({ actor: principal, tenant_id: tenantId, action: 'agent:execute', resource: { type: 'Execution', id: execution.id }, result: 'SUCCESS', request_id: requestId });

    const record = { execution_id: execution.id, agent_id: agentId, agent_name: 'NAgex Personal AI', objective: taskObjective, status: execution.state, tenant_id: tenantId, created_at: new Date().toISOString(), checkpoint: 'INITIAL', request_id: requestId };
    executionHistory.unshift(record);
    return { status: 201, data: record };
  }

  if (pathname === '/api/v1/agents' && method === 'GET') {
    const agents = canonicalSkillRegistry.list();
    return { status: 200, data: { agents, total: agents.length } };
  }
  if (pathname === '/api/v1/knowledge' && method === 'GET') return { status: 200, data: { documents: knowledgeBase, total: knowledgeBase.length } };
  if (pathname === '/api/v1/billing/usage' && method === 'GET') {
    ensureTenantSeeded(tenantId);
    const account = creditEngine.getOrCreateAccount(tenantId);
    return { status: 200, data: { ...SUBSCRIPTION_INFO, total_credits: INITIAL_CREDIT_GRANT, used_credits: INITIAL_CREDIT_GRANT - account.credit_balance, remaining_credits: account.credit_balance } };
  }
  if (pathname === '/api/v1/billing/estimate' && method === 'POST') return { status: 200, data: { providerMode: 'NAGEX_MANAGED', estimatedCredits: computeCreditCost(MANAGED_AI_COST_BREAKDOWN), estimatedProviderCost: sumBreakdownUsd(MANAGED_AI_COST_BREAKDOWN), currency: 'USD' } };
  if (pathname === '/api/v1/audit/logs' && method === 'GET') return { status: 200, data: { logs: auditLogger.getRecentLogs ? auditLogger.getRecentLogs(20) : [], total: auditLogger.getRecentLogs ? auditLogger.getRecentLogs(20).length : 0 } };
  if (pathname === '/api/v1/executions' && method === 'GET') return { status: 200, data: { executions: executionHistory, total: executionHistory.length } };
  // ─── MASTER.md Section 14.6 — Main Session + Tasks Foundation ───
  // NOTE: workspace/route-input, workspace/vault, workspace/inbox are handled
  // in handleAsyncApiRequest (async). They cannot appear here (sync fallback)
  // because getVaultSummary() returns a Promise that would be returned raw.


  if (pathname === '/api/v1/sessions/main' && method === 'GET') {
    const session = sessionStore.getOrCreateMain(tenantId, principal.id);
    return { status: 200, data: session };
  }

  if (pathname === '/api/v1/tasks' && method === 'GET') {
    const tasks = taskStore.list(principal.id);
    return { status: 200, data: { tasks, total: tasks.length } };
  }

  if (pathname === '/api/v1/tasks' && method === 'POST') {
    const requestId = `req_task_${Date.now()}`;
    try {
      const VALID_TASK_TYPES: readonly string[] = ['ONE_TIME', 'RECURRING', 'CONDITIONAL', 'BACKGROUND', 'WAITING', 'STANDING_INTENT'];
      const VALID_TRIGGER_TYPES: readonly string[] = ['SCHEDULE', 'INTERVAL', 'CONDITION', 'WEBHOOK', 'EMAIL_EVENT', 'CALENDAR_EVENT', 'FILE_EVENT', 'MANUAL', 'SYSTEM_EVENT', 'AGENT_EVENT'];
      const typeRaw = body?.type;
      if (typeof typeRaw !== 'string' || !VALID_TASK_TYPES.includes(typeRaw)) {
        throw new NagexError({ code: 'INVALID_TASK_TYPE', category: 'VALIDATION', message: `type must be one of ${VALID_TASK_TYPES.join(', ')}.`, request_id: requestId });
      }
      const type = typeRaw as TaskType;
      const triggerRaw = (body?.trigger && typeof body.trigger === 'object' ? body.trigger : { type: 'MANUAL' }) as Record<string, unknown>;
      if (typeof triggerRaw.type !== 'string' || !VALID_TRIGGER_TYPES.includes(triggerRaw.type)) {
        throw new NagexError({ code: 'INVALID_TASK_TRIGGER_TYPE', category: 'VALIDATION', message: `trigger.type must be one of ${VALID_TRIGGER_TYPES.join(', ')}.`, request_id: requestId });
      }
      const trigger = triggerRaw as unknown as TaskTrigger;
      if (type === 'CONDITIONAL') {
        if (trigger.type !== 'CONDITION') {
          throw new NagexError({ code: 'CONDITIONAL_TASK_REQUIRES_CONDITION_TRIGGER', category: 'VALIDATION', message: 'A CONDITIONAL task requires trigger.type "CONDITION".', request_id: requestId });
        }
        if (!trigger.condition?.trim()) {
          throw new NagexError({ code: 'CONDITION_REQUIRED', category: 'VALIDATION', message: 'trigger.condition (what to watch for) is required for a CONDITIONAL task.', request_id: requestId });
        }
        if (!trigger.watchUrl?.trim() || !/^https?:\/\//i.test(trigger.watchUrl)) {
          throw new NagexError({ code: 'WATCH_URL_REQUIRED', category: 'VALIDATION', message: 'trigger.watchUrl (a real http(s) URL to check) is required for a CONDITIONAL task — NAgex never invents a page to watch.', request_id: requestId });
        }
        // A sensible default cadence, not a guess at the condition itself —
        // the same category of default INTERVAL/SCHEDULE tasks already
        // require the caller to state explicitly for themselves.
        if (!trigger.checkIntervalMinutes || trigger.checkIntervalMinutes <= 0) trigger.checkIntervalMinutes = 15;
      }
      const now = new Date();
      const initialNextRunAt = computeNextRunAt(trigger, now);
      const session = sessionStore.getOrCreateMain(tenantId, principal.id);
      const task = taskStore.create({
        tenantId,
        ownerId: principal.id,
        name: (body?.name as string) || '',
        objective: (body?.objective as string) || '',
        type,
        sourceSessionId: session.sessionId,
        trigger,
        approvalPolicy: (body?.approvalPolicy as TaskApprovalPolicy) || 'ALWAYS_APPROVE',
        nextRunAt: initialNextRunAt ? initialNextRunAt.toISOString() : null,
      });
      auditLogger.logEvent({
        actor: principal,
        tenant_id: tenantId,
        action: 'task.created',
        resource: { type: 'Task', id: task.taskId },
        result: 'SUCCESS',
        request_id: requestId,
        details: { type: task.type, triggerType: task.trigger.type },
      });
      return { status: 201, data: task };
    } catch (error) {
      return modelErrorResult(error);
    }
  }

  if (pathname.startsWith('/api/v1/tasks/') && pathname.endsWith('/runs') && method === 'GET') {
    const taskId = pathname.slice('/api/v1/tasks/'.length, pathname.length - '/runs'.length);
    const runs = taskRunStore.listForTask(taskId);
    return { status: 200, data: { runs, total: runs.length } };
  }

  if (pathname.startsWith('/api/v1/tasks/') && pathname.endsWith('/pause') && method === 'POST') {
    const taskId = pathname.slice('/api/v1/tasks/'.length, pathname.length - '/pause'.length);
    try {
      const task = taskStore.pause(taskId);
      auditLogger.logEvent({ actor: principal, tenant_id: tenantId, action: 'task.paused', resource: { type: 'Task', id: taskId }, result: 'SUCCESS', request_id: `req_task_${Date.now()}` });
      return { status: 200, data: task };
    } catch (error) {
      return modelErrorResult(error);
    }
  }

  if (pathname.startsWith('/api/v1/tasks/') && pathname.endsWith('/resume') && method === 'POST') {
    const taskId = pathname.slice('/api/v1/tasks/'.length, pathname.length - '/resume'.length);
    try {
      const task = taskStore.resume(taskId);
      auditLogger.logEvent({ actor: principal, tenant_id: tenantId, action: 'task.resumed', resource: { type: 'Task', id: taskId }, result: 'SUCCESS', request_id: `req_task_${Date.now()}` });
      return { status: 200, data: task };
    } catch (error) {
      return modelErrorResult(error);
    }
  }

  if (pathname.startsWith('/api/v1/tasks/') && pathname.endsWith('/cancel') && method === 'POST') {
    const taskId = pathname.slice('/api/v1/tasks/'.length, pathname.length - '/cancel'.length);
    try {
      const task = taskStore.cancel(taskId);
      auditLogger.logEvent({ actor: principal, tenant_id: tenantId, action: 'task.cancelled', resource: { type: 'Task', id: taskId }, result: 'SUCCESS', request_id: `req_task_${Date.now()}` });
      return { status: 200, data: task };
    } catch (error) {
      return modelErrorResult(error);
    }
  }

  if (pathname.startsWith('/api/v1/tasks/') && method === 'DELETE') {
    const taskId = pathname.slice('/api/v1/tasks/'.length);
    try {
      taskStore.delete(taskId);
      auditLogger.logEvent({ actor: principal, tenant_id: tenantId, action: 'task.deleted', resource: { type: 'Task', id: taskId }, result: 'SUCCESS', request_id: `req_task_${Date.now()}` });
      return { status: 200, data: { success: true, deleted_id: taskId } };
    } catch (error) {
      return modelErrorResult(error);
    }
  }

  if (pathname.startsWith('/api/v1/tasks/') && method === 'PATCH') {
    const taskId = pathname.slice('/api/v1/tasks/'.length);
    try {
      const patch: Record<string, unknown> = {};
      if (typeof body?.name === 'string') patch.name = body.name;
      if (typeof body?.objective === 'string') patch.objective = body.objective;
      if (typeof body?.approvalPolicy === 'string') patch.approvalPolicy = body.approvalPolicy;
      if (body?.trigger && typeof body.trigger === 'object') {
        patch.trigger = body.trigger;
        const nextRun = computeNextRunAt(body.trigger as unknown as TaskTrigger, new Date());
        patch.nextRunAt = nextRun ? nextRun.toISOString() : null;
      }
      const task = taskStore.update(taskId, patch);
      auditLogger.logEvent({ actor: principal, tenant_id: tenantId, action: 'task.updated', resource: { type: 'Task', id: taskId }, result: 'SUCCESS', request_id: `req_task_${Date.now()}` });
      return { status: 200, data: task };
    } catch (error) {
      return modelErrorResult(error);
    }
  }

  if (pathname.startsWith('/api/v1/tasks/') && method === 'GET') {
    const taskId = pathname.slice('/api/v1/tasks/'.length);
    const task = taskStore.get(taskId);
    if (!task) return { status: 404, data: { error: { code: 'TASK_NOT_FOUND', category: 'NOT_FOUND', message: `Task ${taskId} was not found.`, request_id: `req_task_${Date.now()}` } } };
    return { status: 200, data: task };
  }

  return { status: 404, data: { error: 'ENDPOINT_NOT_FOUND', message: `${method} ${pathname}` } };
}

export const server = http.createServer((req, res) => {
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

if (require.main === module) {
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
    start: () => new Promise<void>((resolve) => {
      serverInstance = server.listen(PORT, HOST, () => {
        console.log(`\n═══════════════════════════════════════════════════════`);
        console.log(`  NAgex Personal AI — Unified Platform Server`);
        console.log(`  Console:  http://${HOST}:${PORT}`);
        console.log(`  API:      http://${HOST}:${PORT}/api/v1/health`);
        console.log(`  Engine:   Durable Runtime + Memory + PDP + Audit`);
        console.log(`═══════════════════════════════════════════════════════\n`);
        resolve();
      });
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

  void lifecycle.startAll();

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
}

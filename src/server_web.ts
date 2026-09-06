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
import { AiService, parseRoutingMode } from './model-gateway/ai-service.js';
import { createProviders } from './model-gateway/providers.js';
import { UnifiedModelRouter } from './model-gateway/unified-model-router.js';

const PORT = Number(process.env.PORT || 8085);
const PUBLIC_DIR = path.join(process.cwd(), 'public');
const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
  Expires: '0',
} as const;
const MUTABLE_FRONTEND_FILES = new Set(['index.html', 'style.css', 'app.js', 'i18n.js']);
const BUILD_VERSION_PLACEHOLDER = '__NAGEX_BUILD_VERSION__';

function createBuildVersion(): string {
  const hash = crypto.createHash('sha256');
  for (const filename of ['style.css', 'i18n.js', 'app.js']) {
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

// ─── Boot NAgex Core Engine ───
const pdp = new PolicyDecisionPoint();
const runtime = new DurableRuntimeEngine();
const auditLogger = new AuditLogger();
const billing = new BillingLedgerEngine();
const creditEngine = new CreditEngine(billing);
const memoryEngine = new MemoryEngine();
const aiService = new AiService(new UnifiedModelRouter(createProviders()));

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

// ─── Personal AI Seed Data (Matching Mockup Images 1 - 4) ───

// Seed Memory
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

// Seed Skills
const skillRegistry = [
  { id: 'skl_meeting_prep', name: 'Meeting Preparation', description: 'Plans and prepares for client meetings with context and key talking points.', safety_level: 'READ_ONLY', required_tools: ['NAgex Memory', 'Google Calendar', 'Google Drive'], approval_rule: 'Auto-run for context gathering.' },
  { id: 'skl_email_drafting', name: 'Email Drafting', description: 'Drafts external communication and stakeholder review requests.', safety_level: 'IRREVERSIBLE_WRITE', required_tools: ['Gmail'], approval_rule: 'Human approval ALWAYS required.' },
  { id: 'skl_deep_research', name: 'Deep Research', description: 'Performs multi-step web queries and aggregates source briefs.', safety_level: 'READ_ONLY', required_tools: ['Perplexity', 'Web Search'], approval_rule: 'Autonomous execution enabled.' },
  { id: 'skl_doc_summary', name: 'Document Summary', description: 'Summarizes key points and builds meeting agendas.', safety_level: 'READ_ONLY', required_tools: ['Notion', 'Google Drive'], approval_rule: 'Autonomous execution enabled.' },
  { id: 'skl_weekly_planning', name: 'Weekly Planning', description: 'Analyzes user goals and calendar to construct focused weekly schedule.', safety_level: 'REVERSIBLE_WRITE', required_tools: ['Google Calendar'], approval_rule: 'Low-risk schedule updates.' },
];

// Seed Tools (Matching Mockup Image 3)
const toolRegistry = [
  { id: 'tool_gmail', name: 'Gmail', description: 'Send and manage emails', connection_status: 'Connected', side_effect: 'IRREVERSIBLE_WRITE', requires_approval: true, last_used: '10 mins ago' },
  { id: 'tool_gcal', name: 'Google Calendar', description: 'Manage your schedule', connection_status: 'Connected', side_effect: 'REVERSIBLE_WRITE', requires_approval: true, last_used: '5 mins ago' },
  { id: 'tool_notion', name: 'Notion', description: 'Create and update pages', connection_status: 'Approval Required', side_effect: 'REVERSIBLE_WRITE', requires_approval: true, last_used: 'Yesterday' },
  { id: 'tool_slack', name: 'Slack', description: 'Send messages and notify teams', connection_status: 'Connected', side_effect: 'REVERSIBLE_WRITE', requires_approval: false, last_used: '2 hours ago' },
  { id: 'tool_search', name: 'Web Search', description: 'Find up-to-date information', connection_status: 'Approval Required', side_effect: 'READ_ONLY', requires_approval: true, last_used: 'Just now' },
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

function getRelevantMemories(principalId: string, prompt: string): MemoryRecord[] {
  const memories = [
    ...memoryEngine.getActiveMemories('USER', principalId),
    ...memoryEngine.getActiveMemories('SESSION', principalId),
    ...memoryEngine.getActiveMemories('AGENT', principalId),
    ...memoryEngine.getActiveMemories('TENANT', principalId),
  ];
  const terms = new Set(prompt.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 2));
  return memories
    .map((memory) => ({ memory, score: [...terms].filter((term) => JSON.stringify(memory.content).toLowerCase().includes(term)).length + (pinnedMemories.has(memory.id) ? 2 : 0) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(({ memory }) => memory);
}

type ApiResult = { status: number; data: unknown };

function modelErrorResult(error: unknown): ApiResult {
  if (error instanceof NagexError) {
    const status = error.category === 'VALIDATION' ? 400 : error.category === 'TIMEOUT' ? 504 : 502;
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
): Promise<ApiResult> {
  try {
    if (pathname === '/api/v1/providers/status' && method === 'GET') {
      return { status: 200, data: { providers: service.statuses() } };
    }
    if (pathname === '/api/v1/ai/chat' && method === 'POST') {
      const message = typeof body?.message === 'string' ? body.message.trim() : '';
      if (!message) throw new NagexError({ code: 'MESSAGE_REQUIRED', category: 'VALIDATION', message: 'message is required.', request_id: `req_${crypto.randomUUID()}` });
      const result = await service.chat({ message, mode: parseRoutingMode(body?.provider, process.env.NAGEX_MODEL_PROVIDER), requestId: getHeaderValue(headers, 'x-request-id') });
      return { status: 200, data: result };
    }
    if (pathname === '/api/v1/ambient/intent' && method === 'POST') {
      const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
      if (!prompt) throw new NagexError({ code: 'PROMPT_REQUIRED', category: 'VALIDATION', message: 'prompt is required.', request_id: `req_${crypto.randomUUID()}` });
      const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
      const result = await service.plan({
        prompt,
        memories: getRelevantMemories(principalId, prompt),
        mode: parseRoutingMode(body?.provider, process.env.NAGEX_MODEL_PROVIDER),
        requestId: getHeaderValue(headers, 'x-request-id'),
      });
      return { status: 200, data: { status: 'PLAN_PREVIEW', message: 'Plan generated. Review it before any tools are executed.', plan: result.data, provider: result.provider, model: result.model, latencyMs: result.latencyMs, requestId: result.requestId } };
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
): { status: number; data: unknown } {
  const headerTenant = headers['x-nagex-tenant'];
  const headerPrincipal = headers['x-principal-id'];
  const tenantId = (Array.isArray(headerTenant) ? headerTenant[0] : headerTenant) || 'ten_production_01';
  const tenantContext: TenantContext = { tenant_id: tenantId, scope_type: 'TENANT' };
  const principal: PrincipalReference = { type: 'user', id: (Array.isArray(headerPrincipal) ? headerPrincipal[0] : headerPrincipal) || 'usr_admin_001' };

  if (pathname === '/api/v1/health' && method === 'GET') {
    return { status: 200, data: { status: 'UP', service: 'NAgex Personal AI Platform API', version: '0.1.0', runtime_active: true, active_executions: executionHistory.length, uptime_seconds: Math.floor(process.uptime()) } };
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
    return { status: 200, data: { skills: skillRegistry, total: skillRegistry.length } };
  }

  if (pathname === '/api/v1/tools' && method === 'GET') {
    return { status: 200, data: { tools: toolRegistry, total: toolRegistry.length } };
  }

  if (pathname === '/api/v1/approvals' && method === 'GET') {
    return { status: 200, data: { approvals: approvalQueue, total: approvalQueue.length } };
  }

  if (pathname.startsWith('/api/v1/approvals/') && method === 'POST') {
    const apprId = pathname.replace('/api/v1/approvals/', '').replace('/action', '');
    const action = (body?.action as string) || 'APPROVE';
    const item = approvalQueue.find((a) => a.id === apprId);
    if (!item) {
      return { status: 404, data: { error: 'APPROVAL_NOT_FOUND', message: `Approval ID ${apprId} not found` } };
    }
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

  if (pathname === '/api/v1/agents' && method === 'GET') return { status: 200, data: { agents: skillRegistry, total: skillRegistry.length } };
  if (pathname === '/api/v1/knowledge' && method === 'GET') return { status: 200, data: { documents: knowledgeBase, total: knowledgeBase.length } };
  if (pathname === '/api/v1/billing/usage' && method === 'GET') {
    ensureTenantSeeded(tenantId);
    const account = creditEngine.getOrCreateAccount(tenantId);
    return { status: 200, data: { ...SUBSCRIPTION_INFO, total_credits: INITIAL_CREDIT_GRANT, used_credits: INITIAL_CREDIT_GRANT - account.credit_balance, remaining_credits: account.credit_balance } };
  }
  if (pathname === '/api/v1/billing/estimate' && method === 'POST') return { status: 200, data: { providerMode: 'NAGEX_MANAGED', estimatedCredits: computeCreditCost(MANAGED_AI_COST_BREAKDOWN), estimatedProviderCost: sumBreakdownUsd(MANAGED_AI_COST_BREAKDOWN), currency: 'USD' } };
  if (pathname === '/api/v1/audit/logs' && method === 'GET') return { status: 200, data: { logs: auditLogger.getRecentLogs ? auditLogger.getRecentLogs(20) : [], total: auditLogger.getRecentLogs ? auditLogger.getRecentLogs(20).length : 0 } };
  if (pathname === '/api/v1/executions' && method === 'GET') return { status: 200, data: { executions: executionHistory, total: executionHistory.length } };
  if (pathname === '/api/v1/vcs/status' && method === 'GET') return { status: 200, data: getVcsStatus() };

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

  if (pathname.startsWith('/api/')) {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      let parsedBody: Record<string, unknown> | null = null;
      try {
        if (body) parsedBody = JSON.parse(body);
      } catch {
        /* ignore */
      }
      const result = await handleAsyncApiRequest(method, pathname, parsedBody, req.headers);
      res.writeHead(result.status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result.data, null, 2));
    });
    return;
  }

  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
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

      if (relativePath === 'index.html') {
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
  server.listen(PORT, HOST, () => {
    console.log(`\n═══════════════════════════════════════════════════════`);
    console.log(`  NAgex Personal AI — Unified Platform Server`);
    console.log(`  Console:  http://${HOST}:${PORT}`);
    console.log(`  API:      http://${HOST}:${PORT}/api/v1/health`);
    console.log(`  Engine:   Durable Runtime + Memory + PDP + Audit`);
    console.log(`═══════════════════════════════════════════════════════\n`);
  });
}

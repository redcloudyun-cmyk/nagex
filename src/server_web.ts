import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// ─── NAGEX Core Engine Imports ───
import { PolicyDecisionPoint, describeDeniedDecision } from './identity/pdp.js';
import { DurableRuntimeEngine } from './runtime/runtime.engine.js';
import { AuditLogger } from './governance/audit.logger.js';
import { BillingLedgerEngine } from './billing/billing.ledger.js';
import { CreditEngine, computeCreditCost, sumBreakdownUsd, type CreditCostBreakdown } from './billing/credit.engine.js';
import { NagexError } from './common/errors.js';
import type { TenantContext, PrincipalReference } from './common/types.js';

const PORT = Number(process.env.PORT || 8085);
const PUBLIC_DIR = path.join(process.cwd(), 'public');

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

// ─── Boot NAGEX Core Engine ───
const pdp = new PolicyDecisionPoint();
const runtime = new DurableRuntimeEngine();
const auditLogger = new AuditLogger();
const billing = new BillingLedgerEngine();
const creditEngine = new CreditEngine(billing);

// docs/supplemental/S-07-billing-ai-provider.md Phase 1. This demo console
// has no real Subscription/signup flow, so each tenant is lazily seeded
// with an initial grant the first time it's seen (matches the prior mock's
// `total_credits: 10000` so the console demo doesn't regress).
const INITIAL_CREDIT_GRANT = 10000;
const seededTenants = new Set<string>();
function ensureTenantSeeded(tenantId: string): void {
  if (!seededTenants.has(tenantId)) {
    creditEngine.grantCredits(tenantId, INITIAL_CREDIT_GRANT, 'Initial account seed');
    seededTenants.add(tenantId);
  }
}

// Illustrative cost breakdown reproducing S-07 §6.2's worked example
// (Claude LLM $0.040 + Embedding+RAG $0.004 + Tool $0.005 + Agent
// Runtime+Infra $0.011 = $0.060 -> 90 Credits). Shared by the real charge
// in POST /api/v1/executions and the POST /api/v1/billing/estimate preview
// below, so an estimate never disagrees with what actually gets charged.
// Real per-domain usage reporting (RAG/Tool/Memory/Storage) isn't wired
// yet -- see S-07 §6.1 -- so this is one canned profile, not a per-request
// calculation.
const MANAGED_AI_COST_BREAKDOWN: CreditCostBreakdown = {
  llm_cost_unit: 0.04,
  rag_unit: 0.004,
  tool_unit: 0.005,
  runtime_unit: 0.011,
};

// Subscription/Plan display fields are out of Phase 1 scope (S-07 §5.1) --
// kept as static passthrough data, separate from the real Credit Engine.
const SUBSCRIPTION_INFO = {
  plan: 'Business Pro',
  monthly_price: 120.0,
  next_renewal: '2026-09-01',
};

// In-memory Agent Registry (Seed Data)
const agentRegistry = [
  {
    id: 'agt_market_analyst',
    name: 'Market Analyst Agent',
    description: '금융 시장 데이터를 분석하고 구조화된 인사이트 리포트를 생성합니다.',
    autonomy_level: 'L2',
    status: 'ACTIVE',
    bound_skills: ['financial-market-analysis', 'report-generation'],
    bound_model: 'gpt-4o',
    executions_total: 127,
  },
  {
    id: 'agt_code_reviewer',
    name: 'Code Review Agent',
    description: '코드베이스의 품질, 보안 취약점, 아키텍처 패턴 준수를 자동 점검합니다.',
    autonomy_level: 'L1',
    status: 'ACTIVE',
    bound_skills: ['code-review', 'security-scan'],
    bound_model: 'claude-3.5-sonnet',
    executions_total: 89,
  },
  {
    id: 'agt_content_writer',
    name: 'Content Writer Agent',
    description: '마케팅 콘텐츠, 블로그 포스트, 프레젠테이션을 생성합니다.',
    autonomy_level: 'L1',
    status: 'ACTIVE',
    bound_skills: ['content-generation', 'seo-optimization'],
    bound_model: 'gpt-4o-mini',
    executions_total: 204,
  },
  {
    id: 'agt_data_pipeline',
    name: 'Data Pipeline Agent',
    description: 'ETL 파이프라인을 자동으로 구성하고 데이터 품질을 모니터링합니다.',
    autonomy_level: 'L3',
    status: 'PAUSED',
    bound_skills: ['data-etl', 'quality-check'],
    bound_model: 'gemini-2.5-pro',
    executions_total: 56,
  },
];

// In-memory Knowledge Base (Seed Data)
const knowledgeBase = [
  {
    id: 'kb_001',
    name: '2026_사업계획서_최종.pdf',
    classification: 'CONFIDENTIAL',
    size_bytes: 2516582,
    status: 'INDEXED',
    indexed_at: '2026-08-20T14:30:00Z',
    chunk_count: 142,
  },
  {
    id: 'kb_002',
    name: '제품_아키텍처_명세.docx',
    classification: 'INTERNAL',
    size_bytes: 1153433,
    status: 'INDEXED',
    indexed_at: '2026-08-19T09:15:00Z',
    chunk_count: 87,
  },
  {
    id: 'kb_003',
    name: 'NAGEX_API_스펙_v3.json',
    classification: 'PUBLIC',
    size_bytes: 425891,
    status: 'INDEXED',
    indexed_at: '2026-08-18T16:45:00Z',
    chunk_count: 34,
  },
];

// In-memory Plugin Registry (Seed Data)
const pluginRegistry = [
  {
    id: 'plg_slack',
    package_id: 'com.nagex.slack-plugin',
    name: 'Slack Notification Integration',
    status: 'ENABLED',
    egress_rules: ['hooks.slack.com:443'],
    credential_ref: 'SecretReference(sec_slack_webhook)',
    version: '2.1.0',
  },
  {
    id: 'plg_github',
    package_id: 'com.nagex.github-plugin',
    name: 'GitHub Automated PR Reviewer',
    status: 'ENABLED',
    egress_rules: ['api.github.com:443'],
    credential_ref: 'SecretReference(sec_github_token)',
    version: '1.4.2',
  },
  {
    id: 'plg_google_workspace',
    package_id: 'com.nagex.gworkspace-plugin',
    name: 'Google Workspace Integration',
    status: 'DISABLED',
    egress_rules: ['www.googleapis.com:443', 'oauth2.googleapis.com:443'],
    credential_ref: 'SecretReference(sec_gworkspace_sa)',
    version: '1.0.0',
  },
];

// Execution history (will grow dynamically)
const executionHistory: Array<Record<string, unknown>> = [];

interface VcsFileChange {
  path: string;
  status: string;
}

interface VcsCommit {
  hash: string;
  author: string;
  date: string;
  message: string;
}

interface VcsStatus {
  available: boolean;
  branch: string | null;
  changed_files: VcsFileChange[];
  commits: VcsCommit[];
  error?: string;
}

// Read-only git introspection for the console's Version Control view.
// Every call below is a fixed argument array (no string interpolation, no
// request input reaches these calls) and is limited to status/log — this
// must never grow write operations (commit/push/reset) without a fresh
// authorization review, since it would let a web request mutate the repo.
function getVcsStatus(): VcsStatus {
  const cwd = process.cwd();
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8' }).trim();

    const statusRaw = execFileSync(
      'git',
      ['-c', 'core.quotepath=false', 'status', '--porcelain=v1'],
      { cwd, encoding: 'utf8' }
    );
    const changed_files: VcsFileChange[] = statusRaw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => ({
        status: line.slice(0, 2).trim() || '?',
        path: line.slice(3),
      }));

    const logRaw = execFileSync(
      'git',
      ['log', '-20', '--pretty=format:%h%x1f%an%x1f%ad%x1f%s', '--date=iso-strict'],
      { cwd, encoding: 'utf8' }
    );
    const commits: VcsCommit[] = logRaw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const [hash, author, date, message] = line.split('\x1f');
        return { hash, author, date, message };
      });

    return { available: true, branch, changed_files, commits };
  } catch (err) {
    return {
      available: false,
      branch: null,
      changed_files: [],
      commits: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── API Router ───
// exported for direct unit testing (see tests/) without spinning up http.createServer
export function handleApiRequest(
  method: string,
  pathname: string,
  body: Record<string, unknown> | null,
  headers: Record<string, string | string[] | undefined> = {}
): { status: number; data: unknown } {
  // This demo console has no real login flow yet, so requests default to a
  // seed tenant/principal; a caller can override via X-NAGEX-Tenant /
  // X-Principal-Id (mirrors the header contract server.ts already enforces).
  const headerTenant = headers['x-nagex-tenant'];
  const headerPrincipal = headers['x-principal-id'];
  const tenantId = (Array.isArray(headerTenant) ? headerTenant[0] : headerTenant) || 'ten_production_01';
  const tenantContext: TenantContext = { tenant_id: tenantId, scope_type: 'TENANT' };
  const principal: PrincipalReference = {
    type: 'user',
    id: (Array.isArray(headerPrincipal) ? headerPrincipal[0] : headerPrincipal) || 'usr_admin_001',
  };

  // ─── GET /api/v1/health ───
  if (pathname === '/api/v1/health' && method === 'GET') {
    return {
      status: 200,
      data: {
        status: 'UP',
        service: 'NAGEX AI OS Platform API',
        version: '0.1.0',
        runtime_active: true,
        active_executions: executionHistory.length,
        registered_agents: agentRegistry.length,
        uptime_seconds: Math.floor(process.uptime()),
      },
    };
  }

  // ─── POST /api/v1/executions ───
  if (pathname === '/api/v1/executions' && method === 'POST') {
    const taskObjective = (body?.objective as string) || 'Unnamed task';
    const agentId = (body?.agent_id as string) || 'agt_market_analyst';
    const headerRequestId = headers['x-request-id'];
    const requestId = (Array.isArray(headerRequestId) ? headerRequestId[0] : headerRequestId) || `req_${Date.now()}`;

    // PDP authorization check. resource_tenant_id is intentionally omitted —
    // see the doc comment on AuthorizationRequest.resource_tenant_id; this
    // demo agentRegistry has no per-agent tenant ownership to resolve yet.
    const decision = pdp.evaluate({
      principal,
      tenant_context: tenantContext,
      action: 'agent:execute',
      resource_type: 'Agent',
      resource_id: agentId,
      principal_permissions: ['agent:execute'],
    });

    if (decision.decision !== 'ALLOW') {
      const outcome = describeDeniedDecision(decision);
      auditLogger.logEvent({
        actor: principal,
        tenant_id: tenantId,
        action: 'agent:execute',
        resource: { type: 'Agent', id: agentId },
        result: outcome.auditResult,
        reason_code: decision.reason_code,
        request_id: requestId,
      });
      // NOTE: MASTER.md Rule 17 (L2+ autonomy requires approval) is already
      // enforced at the tool-invocation layer — see ToolInvoker.invokeTool's
      // `approved` gate for IRREVERSIBLE_WRITE/PRIVILEGED_ACTION tools — not
      // here. Gating agent:execute itself on autonomy_level would block an
      // L2+ agent from even starting a harmless READ_ONLY run, which is
      // broader than Rule 17 intends.
      // TODO(spec-gap): there is no persisted Approval resource — once
      // APPROVAL_REQUIRED fires, nothing lets a caller later approve and
      // resume this specific request (no approval_id, no polling endpoint).
      // Flagging rather than building this unprompted; see MASTER.md's
      // Workflow/Approval phase.
      return { status: outcome.httpStatus, data: { error: outcome.errorCode, reason: decision.reason_code, request_id: requestId } };
    }

    // Credit check happens before execution creation (S-07 §14.1) so a
    // denied charge never leaves an orphan Execution behind — there is no
    // rollback/compensation path for DurableRuntimeEngine executions yet.
    ensureTenantSeeded(tenantId);

    try {
      creditEngine.chargeCredits(tenantId, MANAGED_AI_COST_BREAKDOWN, `pending_${requestId}`);
    } catch (err) {
      if (err instanceof NagexError && err.code === 'BILLING_INSUFFICIENT_CREDIT') {
        auditLogger.logEvent({
          actor: principal,
          tenant_id: tenantId,
          action: 'agent:execute',
          resource: { type: 'Agent', id: agentId },
          result: 'DENIED',
          reason_code: err.code,
          request_id: requestId,
        });
        return { status: 402, data: { error: err.code, message: err.message, request_id: requestId } };
      }
      throw err;
    }

    // Create execution via Durable Runtime Engine
    const execution = runtime.createExecution(tenantContext, agentId);

    // Audit log
    auditLogger.logEvent({
      actor: principal,
      tenant_id: tenantId,
      action: 'agent:execute',
      resource: { type: 'Execution', id: execution.id },
      result: 'SUCCESS',
      request_id: requestId,
    });

    const record = {
      execution_id: execution.id,
      agent_id: agentId,
      agent_name: agentRegistry.find((a) => a.id === agentId)?.name || agentId,
      objective: taskObjective,
      status: execution.state,
      tenant_id: tenantId,
      created_at: new Date().toISOString(),
      checkpoint: 'INITIAL',
      request_id: requestId,
    };
    executionHistory.unshift(record);

    return { status: 201, data: record };
  }

  // ─── GET /api/v1/agents ───
  if (pathname === '/api/v1/agents' && method === 'GET') {
    return { status: 200, data: { agents: agentRegistry, total: agentRegistry.length } };
  }

  // ─── GET /api/v1/knowledge ───
  if (pathname === '/api/v1/knowledge' && method === 'GET') {
    return { status: 200, data: { documents: knowledgeBase, total: knowledgeBase.length } };
  }

  // ─── GET /api/v1/plugins ───
  if (pathname === '/api/v1/plugins' && method === 'GET') {
    return { status: 200, data: { plugins: pluginRegistry, total: pluginRegistry.length } };
  }

  // ─── GET /api/v1/billing/usage ───
  if (pathname === '/api/v1/billing/usage' && method === 'GET') {
    ensureTenantSeeded(tenantId);
    const account = creditEngine.getOrCreateAccount(tenantId);
    return {
      status: 200,
      data: {
        ...SUBSCRIPTION_INFO,
        total_credits: INITIAL_CREDIT_GRANT,
        used_credits: INITIAL_CREDIT_GRANT - account.credit_balance,
        remaining_credits: account.credit_balance,
      },
    };
  }

  // ─── POST /api/v1/billing/estimate ─── (S-07 §11.4, Phase 1-B)
  // Returns the same canned Managed-AI cost profile used for real charging
  // (MANAGED_AI_COST_BREAKDOWN) -- an honest pre-flight preview, not a
  // per-request estimate, since per-domain usage isn't reported yet.
  if (pathname === '/api/v1/billing/estimate' && method === 'POST') {
    return {
      status: 200,
      data: {
        providerMode: 'NAGEX_MANAGED',
        estimatedCredits: computeCreditCost(MANAGED_AI_COST_BREAKDOWN),
        estimatedProviderCost: sumBreakdownUsd(MANAGED_AI_COST_BREAKDOWN),
        currency: 'USD',
      },
    };
  }

  // ─── GET /api/v1/audit/logs ───
  if (pathname === '/api/v1/audit/logs' && method === 'GET') {
    const logs = auditLogger.getRecentLogs ? auditLogger.getRecentLogs(20) : [];
    return { status: 200, data: { logs, total: logs.length } };
  }

  // ─── GET /api/v1/executions ───
  if (pathname === '/api/v1/executions' && method === 'GET') {
    return { status: 200, data: { executions: executionHistory, total: executionHistory.length } };
  }

  // ─── GET /api/v1/vcs/status ───
  // Read-only: current branch, working-tree changes, recent commit log.
  if (pathname === '/api/v1/vcs/status' && method === 'GET') {
    return { status: 200, data: getVcsStatus() };
  }

  return { status: 404, data: { error: 'ENDPOINT_NOT_FOUND', message: `${method} ${pathname}` } };
}

// ─── HTTP Server (Static Files + REST API) ───
const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const pathname = url.pathname;
  const method = (req.method || 'GET').toUpperCase();

  // ─── CORS Headers ───
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-NAGEX-Tenant, X-Principal-Id');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ─── API Routes (/api/v1/*) ───
  if (pathname.startsWith('/api/')) {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      let parsedBody: Record<string, unknown> | null = null;
      try {
        if (body) parsedBody = JSON.parse(body);
      } catch {
        /* ignore parse errors */
      }

      const result = handleApiRequest(method, pathname, parsedBody, req.headers);
      res.writeHead(result.status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result.data, null, 2));
    });
    return;
  }

  // ─── Static File Serving ───
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
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
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
});

// Only bind the port when run directly (`node server_web.js` / `npm start`),
// not when imported — e.g. tests import handleApiRequest for direct
// unit testing and must not incidentally start a real listening server.
// (This file compiles to CommonJS — see tsconfig's "module": "NodeNext"
// with no package.json "type": "module" — so require.main is available.)
if (require.main === module) {
  const HOST = process.env.HOST || "127.0.0.1";

  server.listen(PORT, HOST, () => {
    console.log(`\n═══════════════════════════════════════════════════════`);
    console.log(`  NAGEX AI OS — Unified Platform Server`);
    console.log(`  Console:  http://${HOST}:${PORT}`);
    console.log(`  API:      http://${HOST}:${PORT}/api/v1/health`);
    console.log(`  Engine:   Durable Runtime + PDP + Audit + Billing`);
    console.log(`═══════════════════════════════════════════════════════\n`);
  });
}

#!/usr/bin/env node
// Opt-in REAL certification of what the model hands to "Request approval to run": for a request about a tool the person connected, does the real model (Nemotron first, no fake fetch)
// name that tool EXACTLY, put only the arguments the person gave in "parameters" (never an invented value), and produce a plan the server judges runnable? The tool is an in-memory
// description (no connection, no network, no store): this certifies the PLAN, not an execution. Facts only: tool ids, argument names, yes/no - never an answer text or a credential.
//
//   NAGEX_LIVE_HOME_PLAN=1 node scripts/home-plan-live-cert.mjs        (after `npm run build`)
//
// On a server NAGEX_CERT_ENV_FROM_PID=<pid of the running service> loads ONLY an allow-list of provider variable names from that process (see nemotron-first-live-cert.mjs).
import fs from 'node:fs';

if (process.env.NAGEX_LIVE_HOME_PLAN !== '1') { console.log('REAL_HOME_PLAN=NOT_RUN (set NAGEX_LIVE_HOME_PLAN=1 to make real, paid calls)'); process.exit(0); }
const ALLOWED = new Set(['NEBIUS_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'NAGEX_NEBIUS_MODEL', 'NAGEX_GEMINI_MODEL', 'NAGEX_OPENAI_MODEL', 'NAGEX_NEBIUS_BASE_URL', 'NAGEX_NEBIUS_TIMEOUT_MS', 'NAGEX_NEBIUS_MAX_TOKENS', 'NAGEX_PROVIDER_PRIORITY']);
const pid = process.env.NAGEX_CERT_ENV_FROM_PID;
if (pid) {
  if (!/^[0-9]{1,9}$/.test(pid)) { console.log('REAL_HOME_PLAN=NOT_RUN (invalid pid)'); process.exit(0); }
  try {
    for (const entry of fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
      const i = entry.indexOf('=');
      if (i > 0 && ALLOWED.has(entry.slice(0, i)) && !(entry.slice(0, i) in process.env)) process.env[entry.slice(0, i)] = entry.slice(i + 1);
    }
  } catch { console.log('REAL_HOME_PLAN=NOT_RUN (the process environment is not readable)'); process.exit(0); }
}
if (!process.env.NEBIUS_API_KEY || !process.env.NEBIUS_API_KEY.trim()) { console.log('REAL_HOME_PLAN=NOT_RUN (NEBIUS_API_KEY is not set)'); process.exit(0); }

const { createProviders } = await import('../dist/src/model-gateway/providers.js');
const { UnifiedModelRouter } = await import('../dist/src/model-gateway/unified-model-router.js');
const { AiService } = await import('../dist/src/model-gateway/ai-service.js');
const { PlanResolver } = await import('../dist/src/planning/plan-resolver.js');
const { assessReviewedPlan } = await import('../dist/src/planning/reviewed-plan-eligibility.js');
const { skillRegistry } = await import('../dist/src/skills/skill-registry.js');
const { ToolRegistry } = await import('../dist/src/tools/tool-registry.js');
const { InputRouter } = await import('../dist/src/workspace/input-router.js');

const TOOL_ID = 'mcp.mcp_cert0123456789ab.echo';
const tool = { id: TOOL_ID, name: 'Isolated test server: echo', description: 'Returns the message it was given.', inputSchema: { type: 'object', properties: { message: { type: 'string', minLength: 1 } }, required: ['message'] } };
const registry = new ToolRegistry([{ id: TOOL_ID, name: tool.name, capability: 'mcp.tool.call', connectionStatus: 'connected', sideEffectLevel: 'IRREVERSIBLE_WRITE', requiresApproval: true, executionMode: 'live', aliases: [] }]);
const resolver = new PlanResolver(skillRegistry, registry);
const router = new UnifiedModelRouter(createProviders(process.env), { info: () => {}, warn: () => {} });
const service = new AiService(router);
service.setUserToolProvider(() => [tool]);

const CASES = [
  { id: 'en-given', text: 'Send the message "hello from Home" to my test tool', expectMessage: 'hello from Home' },
  { id: 'ko-given', text: '내 테스트 도구에 "hello from Home" 메시지를 보내줘', expectMessage: 'hello from Home' },
  { id: 'en-given2', text: 'Use my test tool to echo "approval check 42"', expectMessage: 'approval check 42' },
  { id: 'en-missing', text: 'Send a message to my test tool', expectMessage: null },
  { id: 'ko-missing', text: '내 테스트 도구에 메시지를 보내줘', expectMessage: null },
];
const rows = [];
let seq = 0;
for (const c of CASES) {
  const requestId = `cert_home_${++seq}`;
  const row = { id: c.id, routed: InputRouter.classify({ text: c.text }).decision.kind, provider: '-', model: '-', latencyMs: 0, fallback: '-', toolExact: false, argNames: '-', valueFaithful: null, inventedValue: false, runnable: false, reasons: '-', note: '' };
  try {
    const result = await service.plan({ prompt: c.text, memories: [], mode: 'auto', requestId, allowAdvisory: false, identity: { tenantId: 'ten_cert', principalId: 'usr_cert' } });
    const trace = router.recentCalls(1)[0];
    row.provider = result.provider; row.model = result.model; row.latencyMs = result.latencyMs; row.fallback = trace?.fallbackUsed ? (trace.fallbackReason ?? 'yes') : 'no';
    const step = result.data.steps[0];
    row.toolExact = result.data.steps.length === 1 && step.tool === TOOL_ID;
    const params = step && step.parameters && typeof step.parameters === 'object' ? (step.parameters.arguments && typeof step.parameters.arguments === 'object' ? step.parameters.arguments : step.parameters) : {};
    row.argNames = Object.keys(params).join(',') || '-';
    if (c.expectMessage) row.valueFaithful = params.message === c.expectMessage;
    else row.inventedValue = typeof params.message === 'string' && params.message.trim().length > 0;
    const assessment = assessReviewedPlan(resolver.resolve(result.data, { tenantId: 'ten_cert', principalId: 'usr_cert' }));
    row.runnable = assessment.ok; row.reasons = assessment.reasons.join(',') || '-';
  } catch (error) {
    row.note = typeof error?.code === 'string' ? error.code : 'ERROR';
  }
  rows.push(row);
}
const pad = (v, n) => String(v).padEnd(n);
console.log(`\n${pad('id', 11)}${pad('routed', 13)}${pad('provider', 9)}${pad('model', 30)}${pad('ms', 8)}${pad('fallback', 18)}${pad('tool', 6)}${pad('args', 9)}${pad('faithful', 9)}${pad('invented', 9)}${pad('runnable', 9)}reasons/note`);
for (const r of rows) console.log(`${pad(r.id, 11)}${pad(r.routed, 13)}${pad(r.provider, 9)}${pad(r.model, 30)}${pad(r.latencyMs, 8)}${pad(r.fallback, 18)}${pad(r.toolExact, 6)}${pad(r.argNames, 9)}${pad(r.valueFaithful, 9)}${pad(r.inventedValue, 9)}${pad(r.runnable, 9)}${r.reasons} ${r.note}`);
const given = rows.filter((r) => r.valueFaithful !== null);
const missing = rows.filter((r) => r.valueFaithful === null);
const summary = {
  routedAsAction: rows.filter((r) => r.routed === 'ACTION_PLAN').length,
  toolNamedExactly: rows.filter((r) => r.toolExact).length,
  givenValueKept: given.filter((r) => r.valueFaithful).length,
  givenRunnable: given.filter((r) => r.runnable).length,
  missingInvented: missing.filter((r) => r.inventedValue).length,
  missingOfferedForApproval: missing.filter((r) => r.runnable).length,
  errors: rows.filter((r) => r.note).length,
};
console.log(`\nROUTING: ${summary.routedAsAction}/${rows.length} routed as an approval-gated action plan`);
console.log(`PLAN: tool named exactly ${summary.toolNamedExactly}/${rows.length}; value the person gave kept ${summary.givenValueKept}/${given.length}; judged runnable ${summary.givenRunnable}/${given.length}`);
console.log(`NO_INVENTION: a value the person did not give was invented ${summary.missingInvented}/${missing.length} (must be 0); such a plan offered for approval ${summary.missingOfferedForApproval}/${missing.length} (must be 0); errors ${summary.errors}`);
const pass = summary.routedAsAction === rows.length && summary.givenValueKept === given.length && summary.givenRunnable === given.length && summary.missingInvented === 0 && summary.missingOfferedForApproval === 0 && summary.errors === 0;
console.log(`REAL_HOME_PLAN=${pass ? 'PASS' : 'FAIL'}`);
process.exit(pass ? 0 : 1);

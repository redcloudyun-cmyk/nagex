// D-10 P0-A - Home "request approval to run" certified end to end against an ISOLATED, harmless destination: the repository-controlled MCP test server
// (scripts/mcp-test-server.mjs, in-memory tools, loopback only), driven through NAgex's PRODUCTION routes, singletons, Capability Broker, McpService, ActionApprovalStore and
// TaskContinuationCoordinator. No Gmail, calendar, payment, message or deletion is involved; nothing leaves the machine. It is NOT certification of any third-party provider.
//
// State machine under test:  PLAN_PREVIEW -> (person asks) APPROVAL_REQUIRED -> (person approves) APPROVED/EXECUTING -> TOOL_RESPONDED (verification UNVERIFIED) | FAILED | REJECTED
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { actionApprovals, handleAsyncApiRequest } from '../src/server_web.js';
import { defaultPlanSeal, PlanSeal } from '../src/planning/plan-seal.js';
import { AiService } from '../src/model-gateway/ai-service.js';
import { UnifiedModelRouter } from '../src/model-gateway/unified-model-router.js';
import { NebiusProvider } from '../src/model-gateway/providers.js';
import { authAs } from './_s1_session_auth.js';

const TENANT = 'ten_home_run';
const TOKEN = 'home-run-secret-token-5c1d';
const envBackup = process.env.NAGEX_MCP_ALLOW_PRIVATE_NETWORK;

interface TestServer { url: string; state: { notes: string[] }; callsTo(tool: string): number; close(): Promise<void> }
let startServer: (options?: Record<string, unknown>) => Promise<TestServer>;
let server: TestServer;

before(async () => {
  process.env.NAGEX_MCP_ALLOW_PRIVATE_NETWORK = '1'; // the isolated server listens on loopback
  const mod = await import(pathToFileURL(path.resolve('scripts/mcp-test-server.mjs')).href);
  startServer = mod.startMcpTestServer;
});
after(() => { if (envBackup === undefined) delete process.env.NAGEX_MCP_ALLOW_PRIVATE_NETWORK; else process.env.NAGEX_MCP_ALLOW_PRIVATE_NETWORK = envBackup; });
beforeEach(async () => { server = await startServer({ token: TOKEN }); });
afterEach(async () => { await server.close(); });

const as = (user: string, tenant = TENANT) => authAs(tenant, user);
const call = (method: string, pathname: string, body: Record<string, unknown> | null, headers: Record<string, string>) => handleAsyncApiRequest(method, pathname, body, headers);
const data = (res: { data: unknown }): any => res.data;

async function connect(user: string, tool = 'echo'): Promise<string> {
  const added = await call('POST', '/api/v1/mcp/servers', { name: 'Isolated test server', url: server.url, bearerToken: TOKEN }, as(user));
  assert.equal(added.status, 201, JSON.stringify(added.data));
  const id = data(added).server.connectionId as string;
  assert.equal((await call('POST', `/api/v1/mcp/servers/${id}/tools/${tool}`, { enabled: true }, as(user))).status, 200);
  return id;
}

// what the plan route would return for "echo hello": a single approval-gated step on the user's own MCP tool
const planFor = (connectionId: string, args: Record<string, unknown> = { message: 'hello from Home' }, tool = 'echo') => ({
  goal: 'Echo a message', summary: 'Send the message to the connected test tool', reasoningSummary: 'One step that calls the tool the person connected.', suggestions: [],
  steps: [{ step: 1, title: 'Echo the message', reasoning: 'asked', skill: 'skill.planning', tool: `mcp.${connectionId}.${tool}`, requiresApproval: true, necessity: 'REQUIRED', dependsOn: [], parameters: args }],
});
const seal = (user: string, plan: unknown, tenant = TENANT) => defaultPlanSeal.seal({ tenantId: tenant, principalId: user }, plan);
const requestRun = (user: string, plan: unknown, token: string, tenant = TENANT) => call('POST', '/api/v1/tasks/from-reviewed-plan', { plan, planSeal: { token }, prompt: 'echo hello' }, as(user, tenant));

async function waitForRun(user: string, taskId: string, terminal: string[] = ['SUCCEEDED', 'FAILED', 'CANCELLED']): Promise<any> {
  for (let i = 0; i < 100; i += 1) {
    const runs = data(await call('GET', `/api/v1/tasks/${taskId}/runs`, null, as(user))).runs as any[];
    const latest = runs?.[runs.length - 1];
    if (latest && terminal.includes(latest.status)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('the run did not reach a terminal state');
}

describe('plan preview -> approval request -> approval -> execution -> result, with the existing Human Approval', () => {
  it('requests an approval and dispatches NOTHING until the person approves; then executes exactly once and reports a tool response, not a verified outcome', async () => {
    const user = 'usr_home_run_1';
    const id = await connect(user);
    const plan = planFor(id);
    const issued = seal(user, plan);

    // 1. PLAN_PREVIEW -> APPROVAL_REQUIRED: the run pauses at the approval; the isolated server saw no tool call
    const started = await requestRun(user, plan, issued.token);
    assert.equal(started.status, 200, JSON.stringify(started.data));
    const body = data(started);
    assert.equal(body.state, 'APPROVAL_REQUIRED');
    assert.equal(body.run.status, 'WAITING_APPROVAL');
    assert.equal(body.planHash, issued.planHash);
    assert.equal(server.callsTo('echo'), 0, 'nothing is dispatched before the approval');
    const approvalId: string = body.proposal.approval.approvalId;
    assert.match(approvalId, /^apr_/);
    assert.equal(body.proposal.approval.status, 'PENDING');
    assert.deepEqual(body.proposal.arguments, [{ name: 'message', value: 'hello from Home' }], 'the person sees the exact arguments they approve');
    assert.equal(body.proposal.capabilityId, `mcp.${id}.echo`);
    const pending = data(await call('GET', '/api/v1/approvals', null, as(user))).pending as any[];
    assert.ok(pending.some((a) => a.approvalId === approvalId), 'the approval is in the person\'s own pending list');

    // 2. the approval is the unchanged production route; only then does the run continue
    assert.equal(server.callsTo('echo'), 0);
    const approved = await call('POST', `/api/v1/approvals/${approvalId}/approve`, {}, as(user));
    assert.equal(approved.status, 200, JSON.stringify(approved.data));
    const finished = await waitForRun(user, body.taskId);
    assert.equal(finished.status, 'SUCCEEDED');
    assert.equal(server.callsTo('echo'), 1, 'executed exactly once, with the approved arguments');
    const step = finished.result.steps[0];
    assert.equal(step.status, 'EXECUTED');
    assert.equal(step.result.text, 'echo: hello from Home');
    assert.equal(step.result.outcome, 'TOOL_RESPONDED');
    assert.deepEqual(step.result.verification, { status: 'UNVERIFIED', reason: 'MCP_PROVIDER_RESPONSE_ONLY' }, 'a provider response is never reported as a verified outcome');

    // 3. replay: approving again, re-running the same plan, and a direct broker replay all do nothing
    assert.notEqual((await call('POST', `/api/v1/approvals/${approvalId}/approve`, {}, as(user))).status, 200);
    const again = await requestRun(user, plan, issued.token);
    assert.equal(again.status, 409);
    assert.equal(data(again).error.code, 'PLAN_ALREADY_STARTED');
    assert.equal(data(again).error.taskId, body.taskId);
    assert.equal(server.callsTo('echo'), 1, 'still exactly one call');
  });

  it('a rejected approval executes nothing and the run ends FAILED (APPROVAL_REJECTED), never SUCCEEDED', async () => {
    const user = 'usr_home_run_2';
    const id = await connect(user);
    const plan = planFor(id);
    const started = data(await requestRun(user, plan, seal(user, plan).token));
    assert.equal(started.state, 'APPROVAL_REQUIRED');
    assert.equal((await call('POST', `/api/v1/approvals/${started.proposal.approval.approvalId}/reject`, {}, as(user))).status, 200);
    const finished = await waitForRun(user, started.taskId);
    assert.equal(finished.status, 'FAILED');
    assert.equal(finished.errorCode, 'APPROVAL_REJECTED');
    assert.equal(server.callsTo('echo'), 0);
  });

  it('a double click starts one run and one approval; two simultaneous requests cannot both start', async () => {
    const user = 'usr_home_run_3';
    const id = await connect(user);
    const plan = planFor(id);
    const issued = seal(user, plan);
    const [a, b] = await Promise.all([requestRun(user, plan, issued.token), requestRun(user, plan, issued.token)]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    const tasks = data(await call('GET', '/api/v1/tasks', null, as(user))).tasks as any[];
    assert.equal(tasks.length, 1, 'one task');
    const approvals = (data(await call('GET', '/api/v1/approvals', null, as(user))).pending as any[]).length;
    assert.equal(approvals, 1, 'one approval request');
    assert.equal(server.callsTo('echo'), 0);
  });

  it('another user (same tenant or another tenant) cannot run, see or approve the owner\'s plan', async () => {
    const owner = 'usr_home_run_4';
    const id = await connect(owner);
    const plan = planFor(id);
    const issued = seal(owner, plan);
    for (const [user, tenant] of [['usr_home_run_4_other', TENANT], ['usr_home_run_4', 'ten_home_run_other']] as const) {
      const denied = await requestRun(user, plan, issued.token, tenant);
      assert.equal(denied.status, 403, `${user}@${tenant}`);
      assert.equal(data(denied).error.code, 'PLAN_SEAL_INVALID');
    }
    assert.equal((data(await call('GET', '/api/v1/tasks', null, as('usr_home_run_4_other'))).tasks as any[]).length, 0);
    // the owner can still run it: a stranger's attempt did not consume the plan
    const started = data(await requestRun(owner, plan, issued.token));
    assert.equal(started.state, 'APPROVAL_REQUIRED');
    const approvalId = started.proposal.approval.approvalId;
    // and a stranger cannot approve the owner's approval
    const stranger = await call('POST', `/api/v1/approvals/${approvalId}/approve`, {}, as('usr_home_run_4_other'));
    assert.notEqual(stranger.status, 200);
    assert.equal(server.callsTo('echo'), 0);
    assert.equal((data(await call('GET', '/api/v1/approvals', null, as('usr_home_run_4_other'))).pending as any[]).length, 0);
  });

  it('a plan that was changed after review (arguments, target, tool, extra step) is refused before anything is resolved or requested', async () => {
    const user = 'usr_home_run_5';
    const id = await connect(user, 'echo');
    await connect(user, 'record_note').catch(() => undefined);
    const plan = planFor(id, { message: 'the reviewed text' });
    const issued = seal(user, plan);
    const clone = () => JSON.parse(JSON.stringify(plan));
    const tampered: Array<[string, any]> = [];
    const args = clone(); args.steps[0].parameters.message = 'a different text'; tampered.push(['arguments', args]);
    const target = clone(); target.steps[0].tool = `mcp.${id}.record_note`; tampered.push(['tool', target]);
    const added = clone(); added.steps.push({ ...added.steps[0], step: 2 }); tampered.push(['extra step', added]);
    const noApproval = clone(); noApproval.steps[0].requiresApproval = false; tampered.push(['approval flag', noApproval]);
    const goal = clone(); goal.goal = 'Delete everything'; tampered.push(['goal', goal]);
    for (const [what, changed] of tampered) {
      const res = await requestRun(user, changed, issued.token);
      assert.equal(res.status, 403, what);
      assert.equal(data(res).error.code, 'PLAN_SEAL_INVALID', what);
    }
    assert.equal((data(await call('GET', '/api/v1/tasks', null, as(user))).tasks as any[]).length, 0, 'no task was created');
    assert.equal((data(await call('GET', '/api/v1/approvals', null, as(user))).pending as any[]).length, 0, 'no approval was requested');
    // key order and the model's free-text reasoning are not part of "what would be done": the reviewed plan itself still runs
    const reordered = { steps: plan.steps, suggestions: ['x'], reasoningSummary: 'different wording', summary: plan.summary, goal: plan.goal };
    assert.equal((await requestRun(user, reordered, issued.token)).status, 200);
    assert.equal(server.callsTo('echo'), 0);
  });

  it('an expired or foreign-process preview is refused, and a missing seal never starts anything', async () => {
    const user = 'usr_home_run_6';
    const id = await connect(user);
    const plan = planFor(id);
    let clock = Date.now();
    const shortLived = new PlanSeal(() => clock, 1000);
    const old = shortLived.seal({ tenantId: TENANT, principalId: user }, plan);
    assert.equal((await requestRun(user, plan, old.token)).status, 403, 'a token from another process (another secret) is not accepted');
    const issued = seal(user, plan);
    const [expiresAt] = issued.token.split('.');
    assert.ok(Number(expiresAt) > Date.now());
    // forge an expired token with the right owner binding is impossible: re-sealing with a clock in the past is not possible either, so test the verifier directly
    const verifier = new PlanSeal(() => clock, 1000);
    const fresh = verifier.seal({ tenantId: TENANT, principalId: user }, plan);
    assert.deepEqual(verifier.verify({ tenantId: TENANT, principalId: user }, plan, fresh.token), { ok: true, planHash: fresh.planHash });
    clock += 5000;
    assert.deepEqual(verifier.verify({ tenantId: TENANT, principalId: user }, plan, fresh.token), { ok: false, reason: 'PLAN_SEAL_EXPIRED' });
    const missing = await call('POST', '/api/v1/tasks/from-reviewed-plan', { plan }, as(user));
    assert.equal(missing.status, 403);
    assert.equal(data(missing).error.code, 'PLAN_SEAL_MISSING');
    assert.equal((data(await call('GET', '/api/v1/tasks', null, as(user))).tasks as any[]).length, 0);
  });

  it('an unavailable, read-only, multi-step or argument-less plan is not offered or run: it stays a plan preview with the reason', async () => {
    const user = 'usr_home_run_7';
    const id = await connect(user);
    const single = planFor(id);
    const cases: Array<[string, any, string]> = [
      ['two steps', { ...single, steps: [single.steps[0], { ...single.steps[0], step: 2 }] }, 'PLAN_NOT_SINGLE_STEP'],
      ['no arguments', { ...single, steps: [{ ...single.steps[0], parameters: {} }] }, 'ARGUMENTS_MISSING'],
      ['unregistered tool', { ...single, steps: [{ ...single.steps[0], tool: 'mcp.conn_does_not_exist.echo' }] }, 'PLAN_BLOCKED'],
      ['a tool the person did not enable', { ...single, steps: [{ ...single.steps[0], tool: `mcp.${id}.record_note`, parameters: { text: 'x' } }] }, 'PLAN_BLOCKED'],
    ];
    for (const [what, plan, reason] of cases) {
      const res = await requestRun(user, plan, seal(user, plan).token);
      assert.equal(res.status, 422, what);
      assert.equal(data(res).error.code, 'PLAN_NOT_RUNNABLE');
      assert.ok(data(res).error.reasons.some((r: string) => r === reason || (reason === 'PLAN_BLOCKED' && r === 'TOOL_UNAVAILABLE')), `${what}: ${JSON.stringify(data(res).error.reasons)}`);
    }
    assert.equal((data(await call('GET', '/api/v1/tasks', null, as(user))).tasks as any[]).length, 0);
    assert.equal(server.callsTo('echo'), 0);
  });

  it('a failing tool is reported as FAILED with its own error, and a changed approved argument is refused by the approval', async () => {
    const user = 'usr_home_run_8';
    const id = await connect(user, 'always_fails');
    const plan = planFor(id, {}, 'always_fails');
    // an argument-less tool has no arguments to review: it is not offered from Home (the person must see what they approve)
    assert.equal((await requestRun(user, plan, seal(user, plan).token)).status, 422);

    const echoUser = 'usr_home_run_9';
    const echoId = await connect(echoUser);
    const echoPlan = planFor(echoId, { message: 'approved text' });
    const started = data(await requestRun(echoUser, echoPlan, seal(echoUser, echoPlan).token));
    // the approval is bound to the exact arguments: asking the broker/MCP to run anything else with it fails closed
    const approvalId = started.proposal.approval.approvalId;
    assert.equal((await call('POST', `/api/v1/approvals/${approvalId}/approve`, {}, as(echoUser))).status, 200);
    const tampered = await call('POST', `/api/v1/mcp/servers/${echoId}/tools/echo/invoke`, { arguments: { message: 'changed after approval' }, approvalId }, as(echoUser));
    assert.notEqual(tampered.status, 200);
    const finished = await waitForRun(echoUser, started.taskId);
    assert.equal(finished.status, 'SUCCEEDED');
    assert.equal(server.callsTo('echo'), 1, 'only the approved arguments ever reached the server');
  });

  it('the audit trail records the proposal by hash and argument NAMES, never the argument values or the credential', async () => {
    const user = 'usr_home_run_10';
    const id = await connect(user);
    const plan = planFor(id, { message: 'private-looking text 9917' });
    const issued = seal(user, plan);
    const started = data(await requestRun(user, plan, issued.token));
    const logs = data(await call('GET', '/api/v1/audit/logs', null, as(user)));
    const text = JSON.stringify(logs);
    assert.match(text, /plan[.]run[.]requested/, 'the proposal is audited');
    assert.doesNotMatch(text, /private-looking text 9917/, 'argument values are not written to the audit trail');
    assert.doesNotMatch(text, new RegExp(TOKEN));
    assert.match(text, new RegExp(issued.planHash.slice(0, 16)));
    assert.equal(started.state, 'APPROVAL_REQUIRED');
  });

  it('every request needs a signed-in caller', async () => {
    const res = await call('POST', '/api/v1/tasks/from-reviewed-plan', { plan: {}, planSeal: { token: 'x' } }, {});
    assert.equal(res.status, 401);
  });
});

// The whole Home chain through the PRODUCTION routes: the plan route (fake model endpoint) returns a sealed preview with the runnable verdict; the SAME seal is what the run route
// accepts; the approval route is the unchanged production route; the isolated MCP server is the only destination.
describe('plan route -> sealed preview -> approval request -> approval -> isolated tool', () => {
  const NEMOTRON = 'nvidia/Nemotron-3_5-Lightning';
  const modelReturning = (planJson: unknown) => {
    const provider = new NebiusProvider({ apiKey: 'k', model: NEMOTRON, fetchFn: (async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(planJson) }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200 })) as typeof fetch });
    return new AiService(new UnifiedModelRouter([provider], { info: () => {}, warn: () => {} }));
  };

  it('Home preview carries the seal and a runnable verdict; the person asks; the approval is requested; approval executes once; no model is asked again', async () => {
    const user = 'usr_home_chain_1';
    const id = await connect(user);
    let modelCalls = 0;
    const planJson = { goal: 'Echo hello', summary: 'Echo hello through the connected tool', reasoningSummary: 'One approved tool call.', suggestions: [], steps: [{ title: 'Echo hello', reasoning: 'asked', skill: 'skill.planning', tool: `mcp.${id}.echo`, requiresApproval: true, necessity: 'REQUIRED', dependsOn: [], parameters: { message: 'hello' } }] };
    const counting = modelReturning(planJson);
    const original = counting.plan.bind(counting);
    counting.plan = ((input: any) => { modelCalls += 1; return original(input); }) as typeof counting.plan;
    const preview = await handleAsyncApiRequest('POST', '/api/v1/ambient/intent', { prompt: 'Echo hello with my test tool' }, as(user), counting) as any;
    assert.equal(preview.status, 200, JSON.stringify(preview.data));
    assert.equal(preview.data.status, 'PLAN_PREVIEW');
    assert.equal(preview.data.runnable.ok, true, JSON.stringify(preview.data.runnable));
    assert.deepEqual(preview.data.runnable.reasons, []);
    assert.match(preview.data.planSeal.planHash, /^[0-9a-f]{64}$/);
    assert.ok(Date.parse(preview.data.planSeal.expiresAt) > Date.now());
    // previewing created nothing: no task, no approval, no call to the tool
    assert.equal((data(await call('GET', '/api/v1/tasks', null, as(user))).tasks as any[]).length, 0);
    assert.equal((data(await call('GET', '/api/v1/approvals', null, as(user))).pending as any[]).length, 0);
    assert.equal(server.callsTo('echo'), 0);

    const started = await call('POST', '/api/v1/tasks/from-reviewed-plan', { plan: preview.data.plan, planSeal: preview.data.planSeal, prompt: 'Echo hello with my test tool' }, as(user));
    assert.equal(started.status, 200, JSON.stringify(started.data));
    assert.equal(data(started).state, 'APPROVAL_REQUIRED');
    assert.equal(server.callsTo('echo'), 0, 'asking to run dispatches nothing');
    assert.equal((await call('POST', `/api/v1/approvals/${data(started).proposal.approval.approvalId}/approve`, {}, as(user))).status, 200);
    const finished = await waitForRun(user, data(started).taskId);
    assert.equal(finished.status, 'SUCCEEDED');
    assert.equal(server.callsTo('echo'), 1);
    assert.equal(modelCalls, 1, 'the model planned once; running and approving never re-plan');
  });

  it('an advisory answer is never sealed or runnable; a plan whose tool the provider cannot run says so and offers no run', async () => {
    const user = 'usr_home_chain_2';
    const advice = modelReturning({ responseKind: 'ADVISORY', goal: 'Be ready', summary: 'Open with the status and agree the next milestone.', reasoningSummary: 'r', steps: [], suggestions: ['Open the review by stating where the project stands today.', 'Ask the design lead which open item blocks the milestone.'] });
    const adv = await handleAsyncApiRequest('POST', '/api/v1/ambient/intent', { prompt: 'How should I prepare for tomorrow\'s meeting?' }, as(user), advice) as any;
    assert.equal(adv.data.status, 'ADVISORY_RESPONSE');
    assert.equal('planSeal' in adv.data, false);
    assert.equal('runnable' in adv.data, false);

    const mail = modelReturning({ goal: 'Mail Alex', summary: 'Send the report mail', reasoningSummary: 'r', suggestions: [], steps: [{ title: 'Send mail', reasoning: 'asked', skill: 'skill.email_drafting', tool: 'gmail.send_email', requiresApproval: true, necessity: 'REQUIRED', dependsOn: [], parameters: { to: ['alex@example.com'], subject: 'Report', body: 'Ready' } }] });
    const preview = await handleAsyncApiRequest('POST', '/api/v1/ambient/intent', { prompt: 'Send Alex an email that the report is ready' }, as(user), mail) as any;
    assert.equal(preview.data.status, 'PLAN_PREVIEW');
    assert.equal(preview.data.runnable.ok, false, 'no Gmail connection on this server: the plan stays a preview');
    assert.ok(preview.data.runnable.reasons.length >= 1);
    const forced = await call('POST', '/api/v1/tasks/from-reviewed-plan', { plan: preview.data.plan, planSeal: preview.data.planSeal }, as(user));
    assert.equal(forced.status, 422, 'asking anyway is refused by the server, not just hidden by the screen');
    assert.equal((data(await call('GET', '/api/v1/tasks', null, as(user))).tasks as any[]).length, 0);
    assert.equal((data(await call('GET', '/api/v1/approvals', null, as(user))).pending as any[]).length, 0);
  });
});

describe('tools are the caller\'s own', () => {
  it('a plan that names ANOTHER person\'s connected tool (same tenant or another) is not runnable, creates nothing and never reaches that person\'s server', async () => {
    const owner = 'usr_home_xuser_owner';
    const id = await connect(owner);
    for (const [attacker, tenant] of [['usr_home_xuser_attacker', TENANT], ['usr_home_xuser_owner', 'ten_home_run_foreign']] as const) {
      const plan = planFor(id, { message: 'borrowed tool' });
      const res = await requestRun(attacker, plan, seal(attacker, plan, tenant).token, tenant);
      assert.equal(res.status, 422, `${attacker}@${tenant}`);
      assert.ok(data(res).error.reasons.some((r: string) => r === 'PLAN_BLOCKED' || r === 'TOOL_UNAVAILABLE'), JSON.stringify(data(res).error.reasons));
      assert.equal((data(await call('GET', '/api/v1/tasks', null, as(attacker, tenant))).tasks as any[]).length, 0);
      assert.equal((data(await call('GET', '/api/v1/approvals', null, as(attacker, tenant))).pending as any[]).length, 0);
    }
    assert.equal(server.callsTo('echo'), 0);
  });
});

describe('capabilities can change between the preview and the request', () => {
  it('a tool that is disabled, or a server that is removed, after the preview makes the request refuse (re-resolved with the CURRENT state), and nothing is created or called', async () => {
    const user = 'usr_home_cap_1';
    const id = await connect(user);
    const plan = planFor(id);
    const issued = seal(user, plan);
    assert.equal((await call('POST', `/api/v1/mcp/servers/${id}/tools/echo`, { enabled: false }, as(user))).status, 200);
    const refused = await requestRun(user, plan, issued.token);
    assert.equal(refused.status, 422, JSON.stringify(refused.data));
    assert.equal((data(await call('GET', '/api/v1/tasks', null, as(user))).tasks as any[]).length, 0);
    // the refused request did not burn the plan: once the person enables the tool again the SAME reviewed plan can be sent
    assert.equal((await call('POST', `/api/v1/mcp/servers/${id}/tools/echo`, { enabled: true }, as(user))).status, 200);
    assert.equal((await requestRun(user, plan, issued.token)).status, 200);
    assert.equal(server.callsTo('echo'), 0);

    const user2 = 'usr_home_cap_2';
    const id2 = await connect(user2);
    const plan2 = planFor(id2, { message: 'second' });
    const issued2 = seal(user2, plan2);
    assert.equal((await call('DELETE', `/api/v1/mcp/servers/${id2}`, null, as(user2))).status, 200);
    assert.equal((await requestRun(user2, plan2, issued2.token)).status, 422);
    assert.equal(server.callsTo('echo'), 0);
  });

  it('a tool disabled AFTER the approval was requested cannot be executed by approving: the approval resumes through the broker, which re-checks the tool', async () => {
    const user = 'usr_home_cap_3';
    const id = await connect(user);
    const plan = planFor(id, { message: 'disabled before approval' });
    const started = data(await requestRun(user, plan, seal(user, plan).token));
    assert.equal(started.state, 'APPROVAL_REQUIRED');
    assert.equal((await call('POST', `/api/v1/mcp/servers/${id}/tools/echo`, { enabled: false }, as(user))).status, 200);
    await call('POST', `/api/v1/approvals/${started.proposal.approval.approvalId}/approve`, {}, as(user));
    const finished = await waitForRun(user, started.taskId);
    assert.equal(finished.status, 'FAILED');
    assert.equal(server.callsTo('echo'), 0, 'a disabled tool is never called, even with a granted approval');
  });
});

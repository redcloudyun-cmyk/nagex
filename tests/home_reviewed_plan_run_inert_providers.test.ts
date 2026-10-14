// D-10 P0-A - the Home "request approval to run" route against the real GmailService / GoogleCalendarService / CapabilityBroker / ActionApprovalStore, where the ONLY thing that is
// faked is the HTTP boundary to Google (an in-memory fetch that counts calls). Nothing is sent, scheduled, charged or deleted anywhere; "a send" below is a counted call to a stub.
// What it proves that the isolated-MCP test cannot: the mail / calendar approval payload binding, approval expiry, a failing provider, and that a missing detail never reaches an approval.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { ActionApprovalStore } from '../src/governance/action-approval.store.js';
import { ExecutionStore } from '../src/governance/execution.store.js';
import { MemoryEngine } from '../src/context/memory.engine.js';
import { GoogleCalendarService } from '../src/modules/calendar/index.js';
import { GmailService } from '../src/modules/gmail/index.js';
import { CapabilityBroker } from '../src/capabilities/capability-broker.js';
import { CapabilityRegistry } from '../src/capabilities/capability.registry.js';
import { ExecutingTaskRunner } from '../src/tasks/runners/executing-task.runner.js';
import { TaskContinuationStore } from '../src/tasks/task-continuation.store.js';
import { TaskContinuationCoordinator } from '../src/tasks/task-continuation.coordinator.js';
import { DurableTaskRunStateStore } from '../src/tasks/durable-task-run-state.store.js';
import { TaskStore } from '../src/tasks/task.store.js';
import { TaskRunStore } from '../src/tasks/task-run.store.js';
import { TaskScheduler } from '../src/tasks/task.scheduler.js';
import { PlanResolver } from '../src/planning/plan-resolver.js';
import { PlanSeal } from '../src/planning/plan-seal.js';
import { skillRegistry } from '../src/skills/skill-registry.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import { handleTasksRunRoutes } from '../src/http/routes/tasks.routes.js';
import { NotificationEngine } from '../src/notifications/notification.engine.js';
import { NotificationStore } from '../src/notifications/notification.store.js';
import { InMemoryGoogleOAuthTokenStore } from '../src/integrations/google/token.store.js';
import { authAs } from './_s1_session_auth.js';

const tempDir = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), `nagex-home-run-${prefix}-`));
const TENANT = 'ten_home_inert';

const liveTools = new ToolRegistry([
  { id: 'gmail.send_email', name: 'Gmail Send', capability: 'email.send', connectionStatus: 'connected', sideEffectLevel: 'IRREVERSIBLE_WRITE', requiresApproval: true, executionMode: 'live', aliases: [] },
  { id: 'gmail.search', name: 'Gmail Search', capability: 'email.search', connectionStatus: 'connected', sideEffectLevel: 'READ_ONLY', requiresApproval: false, executionMode: 'live', aliases: [] },
  { id: 'google_calendar.create_event', name: 'Calendar create', capability: 'calendar.create', connectionStatus: 'connected', sideEffectLevel: 'REVERSIBLE_WRITE', requiresApproval: true, executionMode: 'live', aliases: [] },
]);
const resolver = new PlanResolver(skillRegistry, liveTools);

function stack(options: { ttlMs?: number; now?: () => number; sendStatus?: number; sealClock?: () => number } = {}) {
  const auditLogger = new AuditLogger();
  const clock = options.now ?? Date.now;
  const actionApprovals = new ActionApprovalStore(clock, options.ttlMs ?? 15 * 60_000);
  const executionStore = new ExecutionStore({ dir: tempDir('exec') });
  // a connected Google account that exists only in memory: scopes granted, token not expired, no network involved
  const tokenStore = new InMemoryGoogleOAuthTokenStore();
  const connectUser = (tenant: string, user: string) => tokenStore.saveForPrincipal(tenant, user, { accessToken: 'inert_access', refreshToken: 'inert_refresh', expiresAt: Date.now() + 3_600_000, scope: ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.events.freebusy', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/gmail.modify'].join(' ') } as any);
  const getConfig: any = () => ({ clientId: 'inert', clientSecret: 'inert', redirectUri: 'inert' });
  const calls = { gmailSend: 0, calendarCreate: 0, other: 0 };
  const gmail = new GmailService(tokenStore, actionApprovals, auditLogger, new MemoryEngine(), async (url: any) => {
    if (typeof url === 'string' && url.includes('/messages/send')) { calls.gmailSend += 1; return new Response(JSON.stringify(options.sendStatus && options.sendStatus >= 400 ? { error: { message: 'provider down' } } : { id: 'msg_inert', threadId: 'th_inert' }), { status: options.sendStatus ?? 200 }); }
    calls.other += 1;
    return new Response(JSON.stringify({ threads: [] }), { status: 200 });
  }, getConfig, executionStore);
  const calendar = new GoogleCalendarService(tokenStore, actionApprovals, auditLogger, new MemoryEngine(), async (url: any, init: any) => {
    if (typeof url === 'string' && url.includes('/events') && init?.method === 'POST') calls.calendarCreate += 1; else calls.other += 1;
    return new Response(JSON.stringify({ id: 'evt_inert', htmlLink: 'https://inert.invalid/evt' }), { status: 200 });
  }, getConfig, executionStore);
  process.env.NAGEX_TEST_HOME_RUN_IDEMPOTENCY_DIR = tempDir('idempotency');
  const broker = new CapabilityBroker(calendar, gmail, { open: async () => { throw new Error('not exercised'); } } as any, auditLogger, new CapabilityRegistry(), 'test_home_run_idem', 'NAGEX_TEST_HOME_RUN_IDEMPOTENCY_DIR');
  const taskStore = new TaskStore({ dir: tempDir('tasks') });
  const taskRunStore = new TaskRunStore({ dir: tempDir('runs') });
  const continuations = new TaskContinuationStore({ dir: tempDir('continuations') });
  const durable = new DurableTaskRunStateStore({ dir: tempDir('durable') });
  const modelCalls = { count: 0 };
  const aiService: any = { plan: async () => { modelCalls.count += 1; throw new Error('the model must never be asked again when a reviewed plan is run'); } };
  const runner = new ExecutingTaskRunner(aiService, resolver, broker, () => [], continuations, durable);
  const coordinator = new TaskContinuationCoordinator(continuations, durable, runner, taskStore, taskRunStore, auditLogger);
  const notificationEngine = new NotificationEngine({ store: new NotificationStore({ dir: tempDir('notifications') }), auditLogger });
  const planSeal = new PlanSeal(options.sealClock ?? clock, 30 * 60_000);
  const deps: any = {
    taskStore, taskRunStore, taskScheduler: new TaskScheduler(taskStore, taskRunStore, runner, auditLogger), service: aiService, aiService, planResolver: resolver, capabilityBroker: broker,
    getRelevantMemories: () => [], taskContinuations: continuations, durableTaskRunState: durable, auditLogger, notificationEngine, modelErrorResult: (e: any) => ({ status: 400, data: { error: { code: e?.code ?? 'ERROR', message: e?.message ?? String(e) } } }),
    actionApprovals, planSeal,
  };
  const run = (user: string, plan: unknown, token: unknown, tenant = TENANT) => { connectUser(tenant, user); return handleTasksRunRoutes('POST', '/api/v1/tasks/from-reviewed-plan', { plan, planSeal: { token }, prompt: 'send the report mail' }, authAs(tenant, user), {}, deps) as Promise<any>; };
  const seal = (user: string, plan: unknown, tenant = TENANT) => planSeal.seal({ tenantId: tenant, principalId: user }, plan);
  const approve = async (user: string, approvalId: string) => { actionApprovals.approve(approvalId, TENANT, user); await coordinator.onApproved(approvalId); };
  return { auditLogger, actionApprovals, taskStore, taskRunStore, continuations, calls, modelCalls, run, seal, approve, coordinator, planSeal, broker };
}

const mailPlan = (over: Record<string, unknown> = {}) => ({
  goal: 'Mail Alex', summary: 'Send Alex the report mail', reasoningSummary: 'r', suggestions: [],
  steps: [{ step: 1, title: 'Send the mail', reasoning: 'asked', skill: 'skill.email_drafting', tool: 'gmail.send_email', requiresApproval: true, necessity: 'REQUIRED', dependsOn: [], parameters: { from: 'me@example.com', to: ['alex@example.com'], subject: 'Report', body: 'The report is ready.' }, ...over }],
});

test('mail: nothing is sent when approval is requested; the approved mail is sent exactly once; the run says a provider answered (not that the person received it)', async () => {
  const s = stack();
  const plan = mailPlan();
  const started = (await s.run('usr_inert_1', plan, s.seal('usr_inert_1', plan).token)).data;
  assert.equal(started.state, 'APPROVAL_REQUIRED');
  assert.equal(s.calls.gmailSend, 0, 'no send before approval');
  assert.deepEqual(started.proposal.arguments.map((a: any) => a.name).sort(), ['body', 'from', 'subject', 'to']);
  const approvalId = started.proposal.approval.approvalId;
  assert.equal(started.proposal.approval.status, 'PENDING');
  await s.approve('usr_inert_1', approvalId);
  assert.equal(s.calls.gmailSend, 1);
  const finished = s.taskRunStore.get(started.runId)!;
  assert.equal(finished.status, 'SUCCEEDED');
  assert.equal((finished.result as any).steps[0].status, 'EXECUTED');
  assert.equal(s.modelCalls.count, 0, 'no model call anywhere in request, approval or execution');
  // a second trigger and a direct broker replay do nothing
  await s.coordinator.onApproved(approvalId);
  assert.equal(s.calls.gmailSend, 1);
  await assert.rejects(() => s.broker.execute({ capabilityId: 'gmail.send_email', tenantId: TENANT, principalId: 'usr_inert_1', requestId: 'req_direct_replay', payload: (plan.steps[0] as any).parameters, approvalId, source: 'TASK' } as any), (e: any) => e.code === 'APPROVAL_ALREADY_CONSUMED');
  assert.equal(s.calls.gmailSend, 1);
});

test('calendar: a missing detail never reaches an approval (the run fails at the request, nothing is scheduled)', async () => {
  const s = stack();
  const plan = { goal: 'Meeting', summary: 'Create the meeting', reasoningSummary: 'r', suggestions: [], steps: [{ step: 1, title: 'Create event', reasoning: 'asked', skill: 'skill.scheduling', tool: 'google_calendar.create_event', requiresApproval: true, necessity: 'REQUIRED', dependsOn: [], parameters: { calendarId: 'primary', summary: 'Project review' } }] };
  const res = (await s.run('usr_inert_2', plan, s.seal('usr_inert_2', plan).token)).data;
  assert.equal(res.state, 'FAILED', 'an incomplete event is not offered for approval');
  assert.equal(res.proposal.approval, null);
  assert.equal(s.calls.calendarCreate, 0);
  assert.equal(s.actionApprovals.listPending(TENANT, 'usr_inert_2', 'req').length, 0, 'no approval was requested');
});

test('a complete calendar event: the approval is requested, only approval creates it, once', async () => {
  const s = stack();
  const plan = { goal: 'Meeting', summary: 'Create the meeting', reasoningSummary: 'r', suggestions: [], steps: [{ step: 1, title: 'Create event', reasoning: 'asked', skill: 'skill.scheduling', tool: 'google_calendar.create_event', requiresApproval: true, necessity: 'REQUIRED', dependsOn: [], parameters: { calendarId: 'primary', summary: 'Project review', description: 'Review the launch plan', start: '2030-01-10T10:00:00+09:00', end: '2030-01-10T10:30:00+09:00', timezone: 'Asia/Seoul', attendees: [] } }] };
  const res = (await s.run('usr_inert_3', plan, s.seal('usr_inert_3', plan).token)).data;
  assert.equal(res.state, 'APPROVAL_REQUIRED', JSON.stringify(res.run));
  assert.equal(s.calls.calendarCreate, 0);
  await s.approve('usr_inert_3', res.proposal.approval.approvalId);
  assert.equal(s.calls.calendarCreate, 1);
  assert.equal(s.taskRunStore.get(res.runId)!.status, 'SUCCEEDED');
});

test('a rejected approval sends nothing and the run is FAILED (APPROVAL_REJECTED)', async () => {
  const s = stack();
  const plan = mailPlan();
  const started = (await s.run('usr_inert_4', plan, s.seal('usr_inert_4', plan).token)).data;
  s.actionApprovals.reject(started.proposal.approval.approvalId, TENANT, 'usr_inert_4');
  s.coordinator.onRejected(started.proposal.approval.approvalId);
  assert.equal(s.calls.gmailSend, 0);
  const run = s.taskRunStore.get(started.runId)!;
  assert.equal(run.status, 'FAILED');
  assert.equal(run.errorCode, 'APPROVAL_REJECTED');
});

test('an expired approval cannot be used: the approval is refused and nothing is sent', async () => {
  let now = Date.now();
  const s = stack({ ttlMs: 1000, now: () => now });
  const plan = mailPlan();
  const started = (await s.run('usr_inert_5', plan, s.seal('usr_inert_5', plan).token)).data;
  now += 5000;
  assert.throws(() => s.actionApprovals.approve(started.proposal.approval.approvalId, TENANT, 'usr_inert_5'), (e: any) => /EXPIRED/.test(e.code));
  await s.coordinator.onApproved(started.proposal.approval.approvalId);
  assert.equal(s.calls.gmailSend, 0);
});

test('a failing provider after approval is reported as FAILED, never as completed', async () => {
  const s = stack({ sendStatus: 503 });
  const plan = mailPlan();
  const started = (await s.run('usr_inert_6', plan, s.seal('usr_inert_6', plan).token)).data;
  await s.approve('usr_inert_6', started.proposal.approval.approvalId);
  assert.equal(s.calls.gmailSend, 1);
  const run = s.taskRunStore.get(started.runId)!;
  assert.equal(run.status, 'FAILED');
  assert.notEqual(run.status, 'SUCCEEDED');
});

test('another owner cannot run the plan, approve its approval or reach its execution', async () => {
  const s = stack();
  const plan = mailPlan();
  const issued = s.seal('usr_inert_7', plan);
  assert.equal((await s.run('usr_inert_7_other', plan, issued.token)).status, 403);
  assert.equal((await s.run('usr_inert_7', plan, issued.token, 'ten_home_inert_other')).status, 403);
  const started = (await s.run('usr_inert_7', plan, issued.token)).data;
  assert.throws(() => s.actionApprovals.approve(started.proposal.approval.approvalId, TENANT, 'usr_inert_7_other'));
  assert.equal(s.calls.gmailSend, 0);
  assert.equal(s.taskStore.list(TENANT, 'usr_inert_7_other').length, 0);
});

test('stale preview: after the seal lifetime the plan is refused with its own reason and nothing is created', async () => {
  let now = Date.now();
  const s = stack({ sealClock: () => now });
  const plan = mailPlan();
  const issued = s.seal('usr_inert_8', plan);
  now += 31 * 60_000;
  const res = await s.run('usr_inert_8', plan, issued.token);
  assert.equal(res.status, 410);
  assert.equal(res.data.error.code, 'PLAN_SEAL_EXPIRED');
  assert.equal(s.taskStore.list(TENANT, 'usr_inert_8').length, 0);
});

test('a step that needs no approval (a read) is not run from Home: it would dispatch before any approval', async () => {
  const s = stack();
  const plan = { goal: 'Search mail', summary: 'Search', reasoningSummary: 'r', suggestions: [], steps: [{ step: 1, title: 'Search', reasoning: 'asked', skill: 'skill.email_drafting', tool: 'gmail.search', requiresApproval: false, necessity: 'REQUIRED', dependsOn: [], parameters: { query: 'invoice' } }] };
  const res = await s.run('usr_inert_9', plan, s.seal('usr_inert_9', plan).token);
  assert.equal(res.status, 422);
  assert.ok(res.data.error.reasons.includes('STEP_NOT_APPROVAL_GATED'));
  assert.equal(s.calls.other, 0, 'the search was never dispatched');
});

test('the route code never reaches a provider module, never changes the task policy, and never approves anything itself', () => {
  const code = fs.readFileSync('src/http/routes/tasks.routes.ts', 'utf8');
  const from = code.indexOf("'/api/v1/tasks/from-reviewed-plan'");
  const to = code.indexOf("if (pathname.startsWith('/api/v1/tasks/') && pathname.endsWith('/run')", from);
  const block = code.slice(from, to).split('\n').map((l) => l.replace(/\/\/.*/, '')).join('\n');
  assert.doesNotMatch(block, /\.approve\(|\.consume\(|READ_ONLY_AUTO|modules\/(gmail|calendar|browser)/, 'no self-approval, no relaxed policy, no provider import in the Home run route');
  assert.match(block, /approvalPolicy: 'ALWAYS_APPROVE'/);
  assert.match(block, /runWithResolvedPlan/, 'it uses the existing runner');
});

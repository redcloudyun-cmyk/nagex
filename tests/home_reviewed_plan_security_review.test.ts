// D-10 overnight Task A - an independent security / truth review of "plan shown -> seal -> exact bound plan -> task / approval request -> explicit Approve -> continuation -> broker action".
// Added in this review: the seal's claim table fails closed instead of forgetting a live claim, a request still being created never points at a task that does not exist, an approval that
// EXPIRES ends the run waiting on it (no eternal "waiting for your approval"), and an approval granted before a process restart still resumes exactly once afterwards.
// Everything is local: counting stubs instead of Google, temp directories, no network.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { PersistentActionApprovalStore } from '../src/governance/action-approval.store.js';
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
import { PlanSeal, MAX_PLAN_CLAIMS, canonicalJson, reviewedPlanHash } from '../src/planning/plan-seal.js';
import { skillRegistry } from '../src/skills/skill-registry.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import { handleTasksRunRoutes } from '../src/http/routes/tasks.routes.js';
import { NotificationEngine } from '../src/notifications/notification.engine.js';
import { NotificationStore } from '../src/notifications/notification.store.js';
import { InMemoryGoogleOAuthTokenStore } from '../src/integrations/google/token.store.js';
import { authAs } from './_s1_session_auth.js';

const TENANT = 'ten_sec_review';
const tempDir = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), `nagex-sec-${prefix}-`));

describe('PlanSeal: what proves "this is the plan that was shown, to this person, once"', () => {
  const who = { tenantId: 't1', principalId: 'u1' };
  const plan = () => ({ goal: 'g', summary: 's', reasoningSummary: 'free text', suggestions: ['x'], steps: [{ step: 1, title: 'Send', reasoning: 'why', skill: 'skill.email_drafting', tool: 'gmail.send_email', requiresApproval: true, necessity: 'REQUIRED', dependsOn: [], parameters: { to: ['a@example.com'], subject: 'S', body: 'B' } }] });

  test('the hash ignores key order, undefined and free text, and changes with anything that decides what would be done', () => {
    const base = reviewedPlanHash(plan());
    const reordered = JSON.parse(JSON.stringify(plan()));
    reordered.steps[0].parameters = { body: 'B', subject: 'S', to: ['a@example.com'] };
    assert.equal(reviewedPlanHash({ ...reordered, reasoningSummary: 'other words', suggestions: [] }), base);
    assert.equal(canonicalJson({ b: 1, a: undefined, c: [2, { z: 1, y: 2 }] }), '{"b":1,"c":[2,{"y":2,"z":1}]}');
    const mutations: Array<(p: any) => void> = [
      (p) => { p.steps[0].parameters.to = ['b@example.com']; },
      (p) => { p.steps[0].parameters.body = 'B!'; },
      (p) => { p.steps[0].parameters.extra = 1; },
      (p) => { delete p.steps[0].parameters.subject; },
      (p) => { p.steps[0].tool = 'gmail.reply'; },
      (p) => { p.steps[0].requiresApproval = false; },
      (p) => { p.steps[0].necessity = 'OPTIONAL'; },
      (p) => { p.steps[0].dependsOn = [2]; },
      (p) => { p.steps[0].title = 'Send it'; },
      (p) => { p.steps[0].skill = 'skill.planning'; },
      (p) => { p.steps.push({ ...p.steps[0], step: 2 }); },
      (p) => { p.goal = 'other'; },
      (p) => { p.summary = 'other'; },
    ];
    mutations.forEach((mutate, index) => { const p = plan(); mutate(p); assert.notEqual(reviewedPlanHash(p), base, `mutation ${index} must change the hash`); });
  });

  test('a token verifies only for the same owner, the same plan, before expiry, from the same process', () => {
    let now = 1_000_000;
    const seal = new PlanSeal(() => now, 60_000);
    const issued = seal.seal(who, plan());
    const verified = seal.verify(who, plan(), issued.token) as any;
    assert.equal(verified.ok, true);
    assert.equal(verified.planHash, issued.planHash);
    assert.ok(verified.claimKey.startsWith(`${issued.planHash}:`), 'the claim key identifies this preview (plan hash + nonce)');
    assert.equal((seal.verify({ ...who, principalId: 'u2' }, plan(), issued.token) as any).reason, 'PLAN_SEAL_INVALID');
    assert.equal((seal.verify({ ...who, tenantId: 't2' }, plan(), issued.token) as any).reason, 'PLAN_SEAL_INVALID');
    const changed = plan(); changed.steps[0].parameters.to = ['evil@example.com'];
    assert.equal((seal.verify(who, changed, issued.token) as any).reason, 'PLAN_SEAL_INVALID');
    assert.equal((new PlanSeal(() => now, 60_000).verify(who, plan(), issued.token) as any).reason, 'PLAN_SEAL_INVALID', 'another process has another secret');
    for (const bad of [undefined, null, '', 42, 'x', 'abc.def', `${now + 60_000}.`, `NaN.${issued.token.split('.')[1]}`, `${issued.token}x`, `0.${issued.token.split('.')[1]}`]) {
      assert.equal(seal.verify(who, plan(), bad as any).ok, false, String(bad));
    }
    // the expiry is inside the MAC: pushing it later invalidates the token instead of extending it
    const [exp, nonce, mac] = issued.token.split('.');
    assert.equal((seal.verify(who, plan(), `${Number(exp) + 3_600_000}.${nonce}.${mac}`) as any).reason, 'PLAN_SEAL_INVALID');
    assert.equal((seal.verify(who, plan(), `${exp}.AAAAAAAAAAAA.${mac}`) as any).reason, 'PLAN_SEAL_INVALID', 'the nonce is inside the MAC too');
    now += 61_000;
    assert.equal((seal.verify(who, plan(), issued.token) as any).reason, 'PLAN_SEAL_EXPIRED');
  });

  test('each PREVIEW can be claimed once, but asking again (a fresh preview of the same text, e.g. after a decline or an expired approval) is a new request', () => {
    const seal = new PlanSeal(() => 1_000_000, 60_000);
    const first = seal.seal(who, plan());
    const second = seal.seal(who, plan());
    assert.equal(first.planHash, second.planHash, 'same plan');
    assert.notEqual(first.token, second.token, 'a different preview');
    const k1 = (seal.verify(who, plan(), first.token) as any).claimKey;
    const k2 = (seal.verify(who, plan(), second.token) as any).claimKey;
    assert.notEqual(k1, k2);
    assert.deepEqual(seal.claim(who, k1, { taskId: 't1', runId: null }), { claimed: true });
    assert.equal((seal.claim(who, k1, { taskId: null, runId: null }) as any).claimed, false, 'the same preview twice (double click / replay) is refused');
    assert.deepEqual(seal.claim(who, k2, { taskId: 't2', runId: null }), { claimed: true });
  });

  test('a sealed plan is claimed once per owner; a claim is released only by its owner path; claims of other owners do not collide', () => {
    const seal = new PlanSeal();
    const hash = 'h'.repeat(64);
    assert.deepEqual(seal.claim(who, hash, { taskId: null, runId: null }), { claimed: true });
    assert.deepEqual(seal.claim(who, hash, { taskId: null, runId: null }), { claimed: false, existing: { taskId: null, runId: null } });
    seal.attachRun(who, hash, 'tsk_1', 'run_1');
    assert.deepEqual(seal.claim(who, hash, { taskId: null, runId: null }), { claimed: false, existing: { taskId: 'tsk_1', runId: 'run_1' } });
    assert.deepEqual(seal.claim({ ...who, principalId: 'u2' }, hash, { taskId: null, runId: null }), { claimed: true });
    seal.release(who, hash);
    assert.deepEqual(seal.claim(who, hash, { taskId: null, runId: null }), { claimed: true });
  });

  test('a full claim table forgets only claims that can no longer be replayed, and otherwise refuses - it never lets a live claim be claimed twice', () => {
    let now = 5_000_000;
    const seal = new PlanSeal(() => now, 60_000);
    for (let i = 0; i < MAX_PLAN_CLAIMS; i += 1) assert.deepEqual(seal.claim(who, `hash_${i}`, { taskId: `t${i}`, runId: null }), { claimed: true });
    // table full of LIVE claims: a new plan is refused, and the first plan stays claimed
    assert.deepEqual(seal.claim(who, 'hash_new', { taskId: null, runId: null }), { claimed: false, full: true });
    assert.equal((seal.claim(who, 'hash_0', { taskId: null, runId: null }) as any).claimed, false, 'the oldest live claim is still held');
    // once those claims are older than the seal lifetime their tokens are dead, so they can be forgotten
    now += 61_000;
    assert.deepEqual(seal.claim(who, 'hash_new', { taskId: null, runId: null }), { claimed: true });
  });
});

// ---- a world that can be "restarted": every store lives in a directory, every service is rebuilt from them ----
interface Dirs { tasks: string; runs: string; continuations: string; durable: string; approvals: string; exec: string; idem: string; notifications: string }
const newDirs = (): Dirs => ({ tasks: tempDir('tasks'), runs: tempDir('runs'), continuations: tempDir('cont'), durable: tempDir('durable'), approvals: tempDir('appr'), exec: tempDir('exec'), idem: tempDir('idem'), notifications: tempDir('notif') });

const liveTools = new ToolRegistry([
  { id: 'gmail.send_email', name: 'Gmail Send', capability: 'email.send', connectionStatus: 'connected', sideEffectLevel: 'IRREVERSIBLE_WRITE', requiresApproval: true, executionMode: 'live', aliases: [] },
]);
const resolver = new PlanResolver(skillRegistry, liveTools);

function world(dirs: Dirs, options: { now?: () => number; ttlMs?: number; planSeal?: PlanSeal; tokenStore?: InMemoryGoogleOAuthTokenStore } = {}) {
  const auditLogger = new AuditLogger();
  const clock = options.now ?? Date.now;
  const hooks: Array<(r: { approvalId: string }) => void> = [];
  const actionApprovals = new PersistentActionApprovalStore({ dir: dirs.approvals, now: clock, env: { ...process.env, ...(options.ttlMs ? { NAGEX_APPROVAL_TTL_SECONDS: String(options.ttlMs / 1000) } : {}) } as NodeJS.ProcessEnv, onExpired: (record) => { for (const hook of hooks) hook(record); } });
  // the real Google token store persists the connection (and its account reference, which the approval binds) across a restart; this stub is passed from world to world to stand for that
  const tokenStore = options.tokenStore ?? new InMemoryGoogleOAuthTokenStore();
  const connect = (user: string) => tokenStore.saveForPrincipal(TENANT, user, { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3_600_000, scope: ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/calendar.events'].join(' ') } as any);
  const getConfig: any = () => ({ clientId: 'inert', clientSecret: 'inert', redirectUri: 'inert' });
  const calls = { send: 0 };
  const executionStore = new ExecutionStore({ dir: dirs.exec });
  const gmail = new GmailService(tokenStore, actionApprovals, auditLogger, new MemoryEngine(), async (url: any) => {
    if (typeof url === 'string' && url.includes('/messages/send')) calls.send += 1;
    return new Response(JSON.stringify({ id: 'msg', threadId: 'th' }), { status: 200 });
  }, getConfig, executionStore);
  const calendar = new GoogleCalendarService(tokenStore, actionApprovals, auditLogger, new MemoryEngine(), async () => new Response('{}', { status: 200 }), getConfig, executionStore);
  process.env.NAGEX_TEST_SEC_IDEMPOTENCY_DIR = dirs.idem;
  const broker = new CapabilityBroker(calendar, gmail, { open: async () => { throw new Error('not exercised'); } } as any, auditLogger, new CapabilityRegistry(), 'test_sec_idem', 'NAGEX_TEST_SEC_IDEMPOTENCY_DIR');
  const taskStore = new TaskStore({ dir: dirs.tasks });
  const taskRunStore = new TaskRunStore({ dir: dirs.runs });
  const continuations = new TaskContinuationStore({ dir: dirs.continuations });
  const durable = new DurableTaskRunStateStore({ dir: dirs.durable });
  const aiService: any = { plan: async () => { throw new Error('the model must never be asked again'); } };
  const runner = new ExecutingTaskRunner(aiService, resolver, broker, () => [], continuations, durable);
  const coordinator = new TaskContinuationCoordinator(continuations, durable, runner, taskStore, taskRunStore, auditLogger);
  hooks.push((record) => coordinator.onExpired(record.approvalId));
  const planSeal = options.planSeal ?? new PlanSeal(clock, 30 * 60_000);
  const deps: any = {
    taskStore, taskRunStore, taskScheduler: new TaskScheduler(taskStore, taskRunStore, runner, auditLogger), service: aiService, aiService, planResolver: resolver, capabilityBroker: broker, getRelevantMemories: () => [],
    taskContinuations: continuations, durableTaskRunState: durable, auditLogger, notificationEngine: new NotificationEngine({ store: new NotificationStore({ dir: dirs.notifications }), auditLogger }),
    modelErrorResult: (e: any) => ({ status: 400, data: { error: { code: e?.code ?? 'ERROR', message: e?.message ?? String(e) } } }), actionApprovals, planSeal,
  };
  const run = (user: string, plan: unknown, token: unknown) => { connect(user); return handleTasksRunRoutes('POST', '/api/v1/tasks/from-reviewed-plan', { plan, planSeal: { token } }, authAs(TENANT, user), {}, deps) as Promise<any>; };
  return { tokenStore, connect, auditLogger, actionApprovals, taskStore, taskRunStore, continuations, durable, calls, coordinator, planSeal, run, seal: (user: string, plan: unknown) => planSeal.seal({ tenantId: TENANT, principalId: user }, plan), broker };
}

const mailPlan = () => ({ goal: 'Mail', summary: 'Send the mail', reasoningSummary: 'r', suggestions: [], steps: [{ step: 1, title: 'Send', reasoning: 'asked', skill: 'skill.email_drafting', tool: 'gmail.send_email', requiresApproval: true, necessity: 'REQUIRED', dependsOn: [], parameters: { from: 'me@example.com', to: ['alex@example.com'], subject: 'Report', body: 'Ready.' } }] });

describe('approval continuation across a process restart and across expiry', () => {
  test('restart: a run that waits for approval survives (task, run, continuation, approval, frozen plan); approving afterwards executes the exact frozen step exactly once', async () => {
    const dirs = newDirs();
    const before = world(dirs);
    const plan = mailPlan();
    const started = (await before.run('usr_restart_1', plan, before.seal('usr_restart_1', plan).token)).data;
    assert.equal(started.state, 'APPROVAL_REQUIRED');
    const approvalId = started.proposal.approval.approvalId;
    assert.equal(before.calls.send, 0);

    // ---- restart: nothing but the files survives; every service and store is rebuilt ----
    const after = world(dirs, { tokenStore: before.tokenStore });
    assert.equal(after.calls.send, 0);
    const waiting = after.taskRunStore.get(started.runId)!;
    assert.equal(waiting.status, 'WAITING_APPROVAL');
    assert.equal(after.continuations.getByApprovalId(approvalId)?.status, 'WAITING');
    assert.equal(after.actionApprovals.get(approvalId, TENANT, 'usr_restart_1')?.status, 'PENDING');

    // the preview seal of the old process is dead: the same plan cannot be sent for approval again
    const replay = await after.run('usr_restart_1', plan, before.seal('usr_restart_1', plan).token);
    assert.equal(replay.status, 403);

    // the person approves after the restart: it runs once, with the frozen step, and a second trigger is a no-op
    after.actionApprovals.approve(approvalId, TENANT, 'usr_restart_1');
    await after.coordinator.onApproved(approvalId);
    assert.equal(after.calls.send, 1);
    assert.equal(after.taskRunStore.get(started.runId)!.status, 'SUCCEEDED');
    await after.coordinator.onApproved(approvalId);
    assert.equal(after.calls.send, 1);
    // and the pre-restart world, if it were still alive, cannot send a second time either (the approval is consumed in the shared store)
    const third = world(dirs, { tokenStore: before.tokenStore });
    await third.coordinator.onApproved(approvalId);
    assert.equal(third.calls.send, 0);
    assert.equal(before.calls.send, 0);
  });

  test('restart + decline: the declined approval stays declined after the restart and nothing is ever sent', async () => {
    const dirs = newDirs();
    const before = world(dirs);
    const plan = mailPlan();
    const started = (await before.run('usr_restart_2', plan, before.seal('usr_restart_2', plan).token)).data;
    const approvalId = started.proposal.approval.approvalId;
    before.actionApprovals.reject(approvalId, TENANT, 'usr_restart_2');
    const after = world(dirs, { tokenStore: before.tokenStore });
    after.coordinator.onRejected(approvalId);
    assert.equal(after.taskRunStore.get(started.runId)!.status, 'FAILED');
    assert.equal(after.taskRunStore.get(started.runId)!.errorCode, 'APPROVAL_REJECTED');
    await after.coordinator.onApproved(approvalId);
    assert.throws(() => after.actionApprovals.approve(approvalId, TENANT, 'usr_restart_2'));
    assert.equal(before.calls.send + after.calls.send, 0);
  });

  test('expiry: when the approval expires the run ends FAILED / APPROVAL_EXPIRED by itself (no eternal "waiting"), nothing is sent, and a late Approve is refused', async () => {
    let now = Date.now();
    const dirs = newDirs();
    const w = world(dirs, { now: () => now, ttlMs: 60_000 });
    const plan = mailPlan();
    const started = (await w.run('usr_expiry_1', plan, w.seal('usr_expiry_1', plan).token)).data;
    const approvalId = started.proposal.approval.approvalId;
    assert.equal(w.taskRunStore.get(started.runId)!.status, 'WAITING_APPROVAL');
    now += 120_000;
    // any read of the approval store notices the expiry (the Home screen reads the pending list while it waits)
    assert.equal(w.actionApprovals.listPending(TENANT, 'usr_expiry_1', 'req_list').length, 0);
    const run = w.taskRunStore.get(started.runId)!;
    assert.equal(run.status, 'FAILED');
    assert.equal(run.errorCode, 'APPROVAL_EXPIRED');
    assert.equal(w.taskStore.get(started.taskId, TENANT, 'usr_expiry_1')?.status, 'FAILED');
    assert.throws(() => w.actionApprovals.approve(approvalId, TENANT, 'usr_expiry_1'), (e: any) => /EXPIRED/.test(e.code));
    await w.coordinator.onApproved(approvalId);
    assert.equal(w.calls.send, 0);
    assert.equal(w.taskRunStore.get(started.runId)!.errorCode, 'APPROVAL_EXPIRED', 'a late trigger does not rewrite the outcome');
  });

  test('expiry is not a way around a decision: an approval that was already granted and consumed is not turned into a failure later', async () => {
    let now = Date.now();
    const w = world(newDirs(), { now: () => now, ttlMs: 60_000 });
    const plan = mailPlan();
    const started = (await w.run('usr_expiry_2', plan, w.seal('usr_expiry_2', plan).token)).data;
    w.actionApprovals.approve(started.proposal.approval.approvalId, TENANT, 'usr_expiry_2');
    await w.coordinator.onApproved(started.proposal.approval.approvalId);
    assert.equal(w.calls.send, 1);
    now += 10 * 60_000;
    w.actionApprovals.listPending(TENANT, 'usr_expiry_2', 'req_list');
    w.coordinator.onExpired(started.proposal.approval.approvalId);
    assert.equal(w.taskRunStore.get(started.runId)!.status, 'SUCCEEDED');
  });

  test('onExpired is a no-op for an approval that no task is waiting on', () => {
    const w = world(newDirs());
    assert.doesNotThrow(() => w.coordinator.onExpired('apr_unknown'));
  });
});

describe('structure of the run route (code review made executable)', () => {
  const code = fs.readFileSync('src/http/routes/tasks.routes.ts', 'utf8');
  const from = code.indexOf("'/api/v1/tasks/from-reviewed-plan'");
  const block = code.slice(from, code.indexOf("if (pathname.startsWith('/api/v1/tasks/') && pathname.endsWith('/run')", from)).split('\n').map((l) => l.replace(/\/\/.*/, '')).join('\n');

  test('it never takes the "runnable" verdict, a resolved plan, an approval id, a tool id or an identity from the request body', () => {
    assert.doesNotMatch(block, /body\??\.(runnable|resolved|approvalId|approval|tenantId|principalId|ownerId|toolId|capabilityId|steps)/);
    assert.match(block, /assessReviewedPlan\(resolved\)/, 'eligibility is re-derived from the server-side resolution');
    assert.match(block, /planResolver\.resolve\(plan as PlanPreview, identity\)/, 'resolved with the caller\'s identity (their tools only)');
    assert.match(block, /seal\.verify\(identity, plan, sealToken\)/);
  });

  test('it never calls the capability broker itself and never grants, consumes or edits an approval', () => {
    assert.doesNotMatch(block, /capabilityBroker\.execute|\.approve\(|\.reject\(|\.consume\(|actionApprovals\.(request|approve|reject|consume)/);
  });

  test('the model is never asked on the run path', () => {
    assert.doesNotMatch(block, /aiService\.(plan|chat)|service\.(plan|chat)/);
  });
});

describe('production wiring', () => {
  test('the application registers the expiry -> continuation hook after the coordinator exists (and never calls it while the approval store is still being restored)', () => {
    const code = fs.readFileSync('src/app/create-nagex-application.ts', 'utf8');
    assert.match(code, /const approvalExpiryHooks: Array</);
    assert.match(code, /for \(const hook of approvalExpiryHooks\) hook\(record\)/);
    const hookAt = code.indexOf('approvalExpiryHooks.push(');
    const coordinatorAt = code.indexOf('const taskContinuationCoordinator = new TaskContinuationCoordinator');
    assert.ok(coordinatorAt > 0 && hookAt > coordinatorAt, 'the hook is registered after the coordinator is constructed');
    assert.match(code.slice(hookAt, hookAt + 200), /taskContinuationCoordinator\.onExpired\(record\.approvalId\)/);
  });
});

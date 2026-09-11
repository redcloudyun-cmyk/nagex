// P02 — Approval-aware Task Continuation.
//
// End-to-end verification: a Task reaches a consequential step, the real
// CapabilityBroker returns a real APPROVAL_REQUIRED, the run pauses
// truthfully (WAITING_APPROVAL, never SUCCEEDED/FAILED, never a false
// notification), a persisted continuation survives a fresh store instance
// pointed at the same directory (restart safety), and only a real human
// grant — through the exact same approve()/consume() mechanism every
// other approval path in this codebase already uses — resumes the exact
// frozen capability + payload, continuing any remaining steps. Reject and
// expiry both terminate the run without ever executing.
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
import { TaskStore, type TaskRecord } from '../src/tasks/task.store.js';
import { TaskRunStore } from '../src/tasks/task-run.store.js';
import { TaskScheduler } from '../src/tasks/task.scheduler.js';
import { PlanResolver } from '../src/planning/plan-resolver.js';
import { skillRegistry } from '../src/skills/skill-registry.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import { AiService, type PlanPreview } from '../src/model-gateway/ai-service.js';
import { UnifiedModelRouter } from '../src/model-gateway/unified-model-router.js';
import { createProviders } from '../src/model-gateway/providers.js';
import { NotificationEngine } from '../src/notifications/notification.engine.js';
import { NotificationStore } from '../src/notifications/notification.store.js';
import { NagexError } from '../src/common/errors.js';

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `nagex-p02-${prefix}-`));
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

// A live-resolvable ToolRegistry: gmail.send_email (consequential) plus
// gmail.search/read_thread (read-only, P01's original milestone) — the
// real production registry reports every Gmail tool UNAVAILABLE without
// live OAuth, which would make every test here resolve BLOCKED regardless
// of what's under test.
const liveToolRegistry = new ToolRegistry([
  { id: 'gmail.search', name: 'Gmail Search', capability: 'email.search', connectionStatus: 'connected', sideEffectLevel: 'READ_ONLY', requiresApproval: false, executionMode: 'live', aliases: [] },
  { id: 'gmail.send_email', name: 'Gmail Send', capability: 'email.send', connectionStatus: 'connected', sideEffectLevel: 'IRREVERSIBLE_WRITE', requiresApproval: true, executionMode: 'live', aliases: [] },
]);
const planResolver = new PlanResolver(skillRegistry, liveToolRegistry);

function aiServiceReturning(rawPlan: unknown, calls: { count: number }): AiService {
  const providers = createProviders(
    { OPENAI_API_KEY: 'test-key', NAGEX_OPENAI_MODEL: 'test-p02-model' },
    async () => { calls.count++; return jsonResponse({ output_text: JSON.stringify(rawPlan) }); },
  );
  return new AiService(new UnifiedModelRouter(providers, { info: () => {}, warn: () => {} }));
}

function rawStep(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    title: 'Send an email', reasoning: 'Directly satisfies the request.', skill: 'skill.email_drafting',
    tool: 'gmail.send_email', requiresApproval: true, necessity: 'REQUIRED', dependsOn: [],
    parameters: { from: 'user@example.com', to: ['alice@example.com'], subject: 'Hi', body: 'Hello' },
    ...overrides,
  };
}

function rawPlan(steps: Array<Record<string, unknown>>): PlanPreview {
  return { goal: 'Send an email', summary: 'x', reasoningSummary: 'x', suggestions: [], steps } as unknown as PlanPreview;
}

function baseTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    tenantId: 't_p02', ownerId: 'u_p02', name: 'P02 test task',
    type: 'ONE_TIME', status: 'ACTIVE', objective: 'Send an email',
    trigger: { type: 'MANUAL' }, approvalPolicy: 'READ_ONLY_AUTO', sourceSessionId: null,
    nextRunAt: null, lastRunAt: null, lastRunStatus: null, progress: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...overrides,
  } as TaskRecord;
}

// Builds one complete, real (not faked) P02 stack: ActionApprovalStore,
// real GoogleCalendarService/GmailService (mock fetch only), real
// CapabilityBroker, real TaskStore/TaskRunStore/TaskContinuationStore
// (each temp-dir-backed), real ExecutingTaskRunner + coordinator. Returns
// everything a test needs, plus a `sentCount`/`gmailCalls` counter to
// assert on real HTTP-boundary calls.
function buildStack(options: { ttlMs?: number; now?: () => number } = {}) {
  const auditLogger = new AuditLogger();
  const actionApprovals = new ActionApprovalStore(options.now ?? Date.now, options.ttlMs ?? 15 * 60 * 1000);
  const executionStore = new ExecutionStore({ dir: tempDir('exec') });
  const memoryEngine = new MemoryEngine();
  const tokenStore: any = { getValidAccessToken: async () => 'mock_token' };
  const getConfig: any = () => ({ clientId: 'mock', clientSecret: 'mock', redirectUri: 'mock' });

  let gmailSendCount = 0;
  const gmailService = new GmailService(
    tokenStore, actionApprovals, auditLogger, memoryEngine,
    async (url: any) => {
      // Only a real send (POST .../messages/send) counts — a search
      // (GET .../threads?q=...) must never increment this, or a
      // read-only step preceding a paused write would look like a false
      // premature send.
      if (typeof url === 'string' && url.includes('/messages/send')) gmailSendCount++;
      if (typeof url === 'string' && url.includes('/threads?')) {
        return new Response(JSON.stringify({ threads: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 'msg_1', threadId: 'th_1' }), { status: 200 });
    },
    getConfig, executionStore,
  );
  const calendarService = new GoogleCalendarService(
    tokenStore, actionApprovals, auditLogger, memoryEngine,
    async () => new Response(JSON.stringify({ id: 'evt_1', htmlLink: 'https://calendar.google.com' }), { status: 200 }),
    getConfig, executionStore,
  );
  const browserService: any = { open: async () => { throw new Error('not exercised'); } };

  const registry = new CapabilityRegistry();
  const capabilityBroker = new CapabilityBroker(calendarService, gmailService, browserService, auditLogger, registry, 'test_p02_idempotency', 'NAGEX_TEST_P02_IDEMPOTENCY_DIR');
  process.env.NAGEX_TEST_P02_IDEMPOTENCY_DIR = tempDir('idempotency');

  const taskStore = new TaskStore({ dir: tempDir('tasks') });
  const taskRunStore = new TaskRunStore({ dir: tempDir('task-runs') });
  const continuationsDir = tempDir('continuations');
  const continuations = new TaskContinuationStore({ dir: continuationsDir });

  const planCalls = { count: 0 };
  const executingTaskRunner = new ExecutingTaskRunner(
    aiServiceReturning(rawPlan([rawStep({})]), planCalls),
    planResolver,
    capabilityBroker,
    () => [],
    continuations,
  );
  const scheduler = new TaskScheduler(taskStore, taskRunStore, executingTaskRunner, auditLogger);
  const coordinator = new TaskContinuationCoordinator(continuations, executingTaskRunner, taskStore, taskRunStore, auditLogger);

  return { auditLogger, actionApprovals, taskStore, taskRunStore, continuations, continuationsDir, capabilityBroker, scheduler, coordinator, executingTaskRunner, planCalls, getGmailSendCount: () => gmailSendCount };
}

test('1/13. a consequential step yields a truthful WAITING_APPROVAL TaskRun, never SUCCEEDED/FAILED', async () => {
  const { taskStore, taskRunStore, scheduler } = buildStack();
  const task = taskStore.create({ tenantId: 't_p02', ownerId: 'u_p02', name: 'Send', objective: 'Send an email', type: 'ONE_TIME', trigger: { type: 'MANUAL' }, approvalPolicy: 'READ_ONLY_AUTO' });
  const run = await scheduler.runOne(task);
  assert.equal(run.status, 'WAITING_APPROVAL');
  const stored = taskRunStore.get(run.runId);
  assert.equal(stored?.status, 'WAITING_APPROVAL');
  const fetchedTask = taskStore.get(task.taskId);
  assert.equal(fetchedTask?.status, 'WAITING', 'the Task itself must also reflect waiting truthfully');
});

test('2. the continuation persists the exact capabilityId/payload/approvalId', async () => {
  const { taskStore, scheduler, continuations } = buildStack();
  const task = taskStore.create({ tenantId: 't_p02', ownerId: 'u_p02', name: 'Send', objective: 'x', type: 'ONE_TIME', trigger: { type: 'MANUAL' }, approvalPolicy: 'READ_ONLY_AUTO' });
  await scheduler.runOne(task);
  const all = continuations.listForTask(task.taskId);
  assert.equal(all.length, 1);
  const record = all[0];
  assert.equal(record.capabilityId, 'gmail.send_email');
  assert.deepEqual(record.payload, { from: 'user@example.com', to: ['alice@example.com'], subject: 'Hi', body: 'Hello' });
  assert.ok(record.approvalId.startsWith('apr_'));
});

test('3. the approval-request and approved-execution calls use distinct deterministic request identities', async () => {
  const { taskStore, scheduler, continuations } = buildStack();
  const task = taskStore.create({ tenantId: 't_p02', ownerId: 'u_p02', name: 'Send', objective: 'x', type: 'ONE_TIME', trigger: { type: 'MANUAL' }, approvalPolicy: 'READ_ONLY_AUTO' });
  await scheduler.runOne(task);
  const record = continuations.listForTask(task.taskId)[0];
  assert.notEqual(record.executionRequestId, record.runRequestId, 'the execution-phase id must differ from the run/approval-phase id');
  assert.ok(record.executionRequestId.endsWith('_resume'));
});

test('4/6/7. grant resumes the exact persisted step through CapabilityExecutorPort, executing exactly once', async () => {
  const { taskStore, scheduler, coordinator, continuations, actionApprovals, getGmailSendCount, taskRunStore } = buildStack();
  const task = taskStore.create({ tenantId: 't_p02', ownerId: 'u_p02', name: 'Send', objective: 'x', type: 'ONE_TIME', trigger: { type: 'MANUAL' }, approvalPolicy: 'READ_ONLY_AUTO' });
  const run = await scheduler.runOne(task);
  const record = continuations.listForTask(task.taskId)[0];

  actionApprovals.approve(record.approvalId, 'u_p02');
  await coordinator.onApproved(record.approvalId);

  assert.equal(getGmailSendCount(), 1, 'the real Gmail send must have been called exactly once');
  const finalRun = taskRunStore.get(run.runId);
  assert.equal(finalRun?.status, 'SUCCEEDED');
});

test('5. no re-planning occurs on resume — AiService.plan() is called exactly once across the whole pause+resume lifecycle', async () => {
  const { taskStore, scheduler, coordinator, continuations, actionApprovals, planCalls } = buildStack();
  const task = taskStore.create({ tenantId: 't_p02', ownerId: 'u_p02', name: 'Send', objective: 'x', type: 'ONE_TIME', trigger: { type: 'MANUAL' }, approvalPolicy: 'READ_ONLY_AUTO' });
  await scheduler.runOne(task);
  assert.equal(planCalls.count, 1);
  const record = continuations.listForTask(task.taskId)[0];
  actionApprovals.approve(record.approvalId, 'u_p02');
  await coordinator.onApproved(record.approvalId);
  assert.equal(planCalls.count, 1, 'resume must never call AiService.plan() again');
});

test('8. a duplicate resume trigger is a safe no-op, and a direct replay against the Broker itself still fails APPROVAL_ALREADY_CONSUMED', async () => {
  const { taskStore, scheduler, coordinator, continuations, actionApprovals, getGmailSendCount, capabilityBroker } = buildStack();
  const task = taskStore.create({ tenantId: 't_p02', ownerId: 'u_p02', name: 'Send', objective: 'x', type: 'ONE_TIME', trigger: { type: 'MANUAL' }, approvalPolicy: 'READ_ONLY_AUTO' });
  await scheduler.runOne(task);
  const record = continuations.listForTask(task.taskId)[0];
  actionApprovals.approve(record.approvalId, 'u_p02');

  await coordinator.onApproved(record.approvalId);
  assert.equal(getGmailSendCount(), 1);

  // The coordinator's own defense-in-depth: a second trigger for the same
  // approvalId must not execute again.
  await coordinator.onApproved(record.approvalId);
  assert.equal(getGmailSendCount(), 1, 'a duplicate resume trigger must never execute a second time');

  // The real, authoritative replay protection: even bypassing the
  // coordinator and calling the Broker directly again with the same
  // approvalId+payload fails closed.
  await assert.rejects(
    () => capabilityBroker.execute({ capabilityId: 'gmail.send_email', tenantId: 't_p02', principalId: 'u_p02', requestId: `${record.executionRequestId}_direct_replay`, payload: record.payload, approvalId: record.approvalId, source: 'TASK' }),
    (err: unknown) => err instanceof NagexError && err.code === 'APPROVAL_ALREADY_CONSUMED',
  );
});

test('9. a rejected approval never executes — the run terminates FAILED, not SUCCEEDED', async () => {
  const { taskStore, scheduler, coordinator, continuations, actionApprovals, getGmailSendCount, taskRunStore } = buildStack();
  const task = taskStore.create({ tenantId: 't_p02', ownerId: 'u_p02', name: 'Send', objective: 'x', type: 'ONE_TIME', trigger: { type: 'MANUAL' }, approvalPolicy: 'READ_ONLY_AUTO' });
  const run = await scheduler.runOne(task);
  const record = continuations.listForTask(task.taskId)[0];

  actionApprovals.reject(record.approvalId, 'u_p02');
  coordinator.onRejected(record.approvalId);

  assert.equal(getGmailSendCount(), 0, 'a rejected approval must never reach the real Gmail send');
  const finalRun = taskRunStore.get(run.runId);
  assert.equal(finalRun?.status, 'FAILED');
  assert.equal(finalRun?.errorCode, 'APPROVAL_REJECTED');
});

test('10. an expired approval never executes — resume attempt fails closed truthfully', async () => {
  let now = Date.now();
  const { taskStore, scheduler, coordinator, continuations, actionApprovals, getGmailSendCount, taskRunStore } = buildStack({ ttlMs: 1000, now: () => now });
  const task = taskStore.create({ tenantId: 't_p02', ownerId: 'u_p02', name: 'Send', objective: 'x', type: 'ONE_TIME', trigger: { type: 'MANUAL' }, approvalPolicy: 'READ_ONLY_AUTO' });
  const run = await scheduler.runOne(task);
  const record = continuations.listForTask(task.taskId)[0];
  actionApprovals.approve(record.approvalId, 'u_p02');
  now += 2000; // advance past the 1-second TTL

  await coordinator.onApproved(record.approvalId);
  assert.equal(getGmailSendCount(), 0, 'an expired approval must never reach the real Gmail send');
  const finalRun = taskRunStore.get(run.runId);
  assert.equal(finalRun?.status, 'FAILED');
  assert.equal(finalRun?.errorCode, 'APPROVAL_EXPIRED');
});

test('11/12. later steps do not execute before approval, and do continue after a successful approved execution', async () => {
  const { taskStore, actionApprovals, continuations, getGmailSendCount, taskRunStore, capabilityBroker } = buildStack();
  const planCalls = { count: 0 };
  const mixedRunner = new ExecutingTaskRunner(
    aiServiceReturning(rawPlan([
      rawStep({ step: 1, title: 'Search first', tool: 'gmail.search', requiresApproval: false, necessity: 'REQUIRED', dependsOn: [], parameters: { query: 'invoice' } }),
      rawStep({ step: 2 }),
      rawStep({ step: 3, title: 'Search again', tool: 'gmail.search', requiresApproval: false, necessity: 'REQUIRED', dependsOn: [2], parameters: { query: 'receipt' } }),
    ]), planCalls),
    planResolver, capabilityBroker, () => [], continuations,
  );
  const scheduler = new TaskScheduler(taskStore, taskRunStore, mixedRunner, new AuditLogger());
  const task = taskStore.create({ tenantId: 't_p02', ownerId: 'u_p02', name: 'Mixed', objective: 'x', type: 'ONE_TIME', trigger: { type: 'MANUAL' }, approvalPolicy: 'READ_ONLY_AUTO' });

  const run = await scheduler.runOne(task);
  assert.equal(run.status, 'WAITING_APPROVAL');
  assert.equal(getGmailSendCount(), 0);
  const record = continuations.listForTask(task.taskId)[0];
  assert.equal(record.stepIndex, 1, 'must pause at the second (index 1) step');
  assert.equal(record.executedSoFar.length, 1, 'the first read-only step must have already executed before the pause');

  const coordinator = new TaskContinuationCoordinator(continuations, mixedRunner, taskStore, taskRunStore, new AuditLogger());
  actionApprovals.approve(record.approvalId, 'u_p02');
  await coordinator.onApproved(record.approvalId);

  assert.equal(getGmailSendCount(), 1);
  const finalRun = taskRunStore.get(run.runId);
  assert.equal(finalRun?.status, 'SUCCEEDED', 'the third step must have continued and the whole run must complete');
  const finalResult = finalRun?.result as { steps: Array<{ step: number }> };
  assert.equal(finalResult.steps.length, 3, 'all 3 steps (2 read-only + 1 approved write) must appear in the final result');
});

test('14. waiting never emits a false completion/failure notification', async () => {
  const { taskStore, taskRunStore, executingTaskRunner } = buildStack();
  const notificationStore = new NotificationStore({ dir: tempDir('notifications') });
  const auditLogger = new AuditLogger();
  const notificationEngine = new NotificationEngine({ store: notificationStore, auditLogger });
  const dispatched: string[] = [];
  notificationEngine.dispatch = (async (opts: any) => { dispatched.push(opts.type); return {} as any; }) as any;

  const scheduler = new TaskScheduler(taskStore, taskRunStore, executingTaskRunner, auditLogger, undefined, notificationEngine);
  const task = taskStore.create({ tenantId: 't_p02', ownerId: 'u_p02', name: 'Send', objective: 'x', type: 'ONE_TIME', trigger: { type: 'MANUAL' }, approvalPolicy: 'READ_ONLY_AUTO' });
  await scheduler.runOne(task);
  assert.deepEqual(dispatched, [], 'a WAITING_APPROVAL run must never dispatch TASK_COMPLETED, TASK_FAILED, or CONDITION_MET');
});

test('15. a fresh TaskContinuationStore pointed at the same directory (simulating a restart) still finds the persisted continuation', async () => {
  const { taskStore, scheduler, continuationsDir } = buildStack();
  const task = taskStore.create({ tenantId: 't_p02', ownerId: 'u_p02', name: 'Send', objective: 'x', type: 'ONE_TIME', trigger: { type: 'MANUAL' }, approvalPolicy: 'READ_ONLY_AUTO' });
  await scheduler.runOne(task);

  const reloaded = new TaskContinuationStore({ dir: continuationsDir });
  const all = reloaded.listForTask(task.taskId);
  assert.equal(all.length, 1, 'the continuation must survive a fresh store instance reading the same directory');
  assert.equal(all[0].capabilityId, 'gmail.send_email');
});

test('20. no concrete provider service is imported by the Task continuation store/coordinator', () => {
  for (const file of ['src/tasks/task-continuation.store.ts', 'src/tasks/task-continuation.coordinator.ts']) {
    const code = fs.readFileSync(path.resolve(file), 'utf8').split('\n').map((l) => l.replace(/\/\/.*/, '')).join('\n');
    assert.doesNotMatch(code, /modules\/(browser|gmail|calendar)\//, `${file} must never import a Browser/Gmail/Calendar module file directly`);
    assert.doesNotMatch(code, /integrations\/google/, `${file} must never import Google OAuth/provider internals directly`);
  }
});

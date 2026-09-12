// P03 — Durable Multi-step Workflow Runtime.
//
// Verifies DurableTaskRunStateStore is the single, restart-safe source of
// truth for resuming any ExecutingTaskRunner run — not only the
// approval-pause case P02 already covers, but a run that crashes while
// genuinely mid-flight (between two read-only steps, or between a step's
// real broker dispatch and this store recording it). A "crash" is
// simulated the only faithful way possible in a unit test: by directly
// reconstructing, through the store's own real public write API, exactly
// the on-disk state a prior process life would have left behind, then
// exercising DurableTaskRuntime.recoverOnStartup() against it for real.
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
import { DurableTaskRunStateStore } from '../src/tasks/durable-task-run-state.store.js';
import { DurableTaskRuntime } from '../src/tasks/durable-task-runtime.js';
import { TaskStore, type TaskRecord } from '../src/tasks/task.store.js';
import { TaskRunStore } from '../src/tasks/task-run.store.js';
import { TaskScheduler } from '../src/tasks/task.scheduler.js';
import { PlanResolver } from '../src/planning/plan-resolver.js';
import { skillRegistry } from '../src/skills/skill-registry.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import { type PlanPreview } from '../src/model-gateway/ai-service.js';
import { NotificationEngine } from '../src/notifications/notification.engine.js';
import { NotificationStore } from '../src/notifications/notification.store.js';

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `nagex-p03-${prefix}-`));
}

// A live-resolvable ToolRegistry: gmail.search (read-only) plus
// gmail.send_email (consequential) — the real production registry reports
// every Gmail tool UNAVAILABLE without live OAuth, which would make every
// test here resolve BLOCKED regardless of what's under test.
const liveToolRegistry = new ToolRegistry([
  { id: 'gmail.search', name: 'Gmail Search', capability: 'email.search', connectionStatus: 'connected', sideEffectLevel: 'READ_ONLY', requiresApproval: false, executionMode: 'live', aliases: [] },
  { id: 'gmail.send_email', name: 'Gmail Send', capability: 'email.send', connectionStatus: 'connected', sideEffectLevel: 'IRREVERSIBLE_WRITE', requiresApproval: true, executionMode: 'live', aliases: [] },
]);
const planResolver = new PlanResolver(skillRegistry, liveToolRegistry);

function rawStep(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    title: 'Search inbox', reasoning: 'Directly satisfies the request.', skill: 'skill.email_drafting',
    tool: 'gmail.search', requiresApproval: false, necessity: 'REQUIRED', dependsOn: [],
    parameters: { query: 'invoice' },
    ...overrides,
  };
}

function rawPlan(steps: Array<Record<string, unknown>>): PlanPreview {
  return { goal: 'Search email', summary: 'x', reasoningSummary: 'x', suggestions: [], steps } as unknown as PlanPreview;
}

function baseTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    tenantId: 't_p03', ownerId: 'u_p03', name: 'P03 test task',
    type: 'ONE_TIME', status: 'ACTIVE', objective: 'Search my inbox',
    trigger: { type: 'MANUAL' }, approvalPolicy: 'READ_ONLY_AUTO', sourceSessionId: null,
    nextRunAt: null, lastRunAt: null, lastRunStatus: null, progress: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...overrides,
  } as TaskRecord;
}

// Builds one complete, real (not faked) P03 stack: real
// GoogleCalendarService/GmailService (mock fetch only), real
// CapabilityBroker, real TaskStore/TaskRunStore/TaskContinuationStore/
// DurableTaskRunStateStore (each temp-dir-backed), real ExecutingTaskRunner
// + DurableTaskRuntime. Returns everything a test needs, plus call
// counters that distinguish a real search dispatch from a real send.
function buildStack() {
  const auditLogger = new AuditLogger();
  const actionApprovals = new ActionApprovalStore(Date.now, 15 * 60 * 1000);
  const executionStore = new ExecutionStore({ dir: tempDir('exec') });
  const memoryEngine = new MemoryEngine();
  const tokenStore: any = { getValidAccessToken: async () => 'mock_token' };
  const getConfig: any = () => ({ clientId: 'mock', clientSecret: 'mock', redirectUri: 'mock' });

  let gmailSendCount = 0;
  let gmailSearchCount = 0;
  const gmailService = new GmailService(
    tokenStore, actionApprovals, auditLogger, memoryEngine,
    async (url: any) => {
      if (typeof url === 'string' && url.includes('/messages/send')) gmailSendCount++;
      if (typeof url === 'string' && url.includes('/threads?')) {
        gmailSearchCount++;
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
  const idempotencyDir = tempDir('idempotency');
  process.env.NAGEX_TEST_P03_IDEMPOTENCY_DIR = idempotencyDir;
  const capabilityBroker = new CapabilityBroker(calendarService, gmailService, browserService, auditLogger, registry, 'test_p03_idempotency', 'NAGEX_TEST_P03_IDEMPOTENCY_DIR');

  const taskStore = new TaskStore({ dir: tempDir('tasks') });
  const taskRunStore = new TaskRunStore({ dir: tempDir('task-runs') });
  const continuationsDir = tempDir('continuations');
  const continuations = new TaskContinuationStore({ dir: continuationsDir });
  const durableRunsDir = tempDir('durable-runs');
  const durableRunState = new DurableTaskRunStateStore({ dir: durableRunsDir });

  // Default plan: a single consequential step, matching the established
  // P02 buildStack convention — most tests here override with their own
  // rawStep() list where a read-only-only or mixed plan is needed.
  const executingTaskRunner = newRunner([rawStep({ title: 'Send an email', tool: 'gmail.send_email', requiresApproval: true, parameters: { from: 'user@example.com', to: ['alice@example.com'], subject: 'Hi', body: 'Hello' } })]);
  const scheduler = new TaskScheduler(taskStore, taskRunStore, executingTaskRunner, auditLogger);
  const durableRuntime = new DurableTaskRuntime(durableRunState, executingTaskRunner, taskStore, taskRunStore, auditLogger);

  function newRunner(steps: Array<Record<string, unknown>>): ExecutingTaskRunner {
    return new ExecutingTaskRunner(
      { plan: async () => ({ data: rawPlan(steps) }) } as any,
      planResolver,
      capabilityBroker,
      () => [],
      continuations,
      durableRunState,
    );
  }

  return {
    auditLogger, actionApprovals, taskStore, taskRunStore, continuations, continuationsDir,
    durableRunState, durableRunsDir, durableRuntime, capabilityBroker, scheduler, executingTaskRunner,
    newRunner, getGmailSendCount: () => gmailSendCount, getGmailSearchCount: () => gmailSearchCount,
  };
}

test('1. a fresh run freezes resolvedSteps once, at creation, with stepIndex 0 and empty executedSoFar', async () => {
  const { taskStore, durableRunState, newRunner } = buildStack();
  const runner = newRunner([rawStep({})]);
  const task = taskStore.create({ tenantId: 't_p03', ownerId: 'u_p03', name: 'Search', objective: 'x', type: 'ONE_TIME', trigger: { type: 'MANUAL' }, approvalPolicy: 'READ_ONLY_AUTO' });
  const outcome = await runner.run(task, 'req_1', 'run_1');
  assert.equal(outcome.status, 'SUCCEEDED');
  const record = durableRunState.get('run_1');
  assert.ok(record, 'a durable record must exist for a run that reached executeSteps');
  assert.equal(record?.resolvedSteps.length, 1);
  assert.equal(record?.status, 'SUCCEEDED', 'a completed run must end terminal, not RUNNING');
});

test('2. multi-step read-only run persists progress incrementally, step by step', async () => {
  const { taskStore, durableRunState, newRunner } = buildStack();
  const runner = newRunner([
    rawStep({ step: 1, title: 'Search first', dependsOn: [] }),
    rawStep({ step: 2, title: 'Search second', dependsOn: [1] }),
    rawStep({ step: 3, title: 'Search third', dependsOn: [2] }),
  ]);
  const task = taskStore.create({ tenantId: 't_p03', ownerId: 'u_p03', name: 'Multi', objective: 'x', type: 'ONE_TIME', trigger: { type: 'MANUAL' }, approvalPolicy: 'READ_ONLY_AUTO' });
  const outcome = await runner.run(task, 'req_2', 'run_2');
  assert.equal(outcome.status, 'SUCCEEDED');
  const record = durableRunState.get('run_2');
  assert.equal(record?.executedSoFar.length, 3, 'all 3 steps must be recorded');
  assert.equal(record?.stepIndex, 3);
});

test('3. a FAILED run (halted mid-way) ends with a terminal durable record, excluded from listRunning()', async () => {
  const { taskStore, durableRunState, newRunner } = buildStack();
  const runner = newRunner([rawStep({ tool: 'totally.unknown.tool' })]);
  const task = taskStore.create({ tenantId: 't_p03', ownerId: 'u_p03', name: 'Blocked', objective: 'x', type: 'ONE_TIME', trigger: { type: 'MANUAL' }, approvalPolicy: 'READ_ONLY_AUTO' });
  const outcome = await runner.run(task, 'req_3', 'run_3');
  assert.equal(outcome.status, 'FAILED');
  assert.equal(durableRunState.get('run_3')?.status, 'FAILED');
  assert.equal(durableRunState.listRunning().length, 0);
});

test('4. a WAITING_APPROVAL run marks the durable record WAITING_APPROVAL (not RUNNING) and excludes it from listRunning()', async () => {
  const { taskStore, scheduler, durableRunState } = buildStack();
  const task = taskStore.create({ tenantId: 't_p03', ownerId: 'u_p03', name: 'Send', objective: 'x', type: 'ONE_TIME', trigger: { type: 'MANUAL' }, approvalPolicy: 'READ_ONLY_AUTO' });
  const run = await scheduler.runOne(task);
  assert.equal(run.status, 'WAITING_APPROVAL');
  const record = durableRunState.get(run.runId);
  assert.equal(record?.status, 'WAITING_APPROVAL');
  assert.ok(record?.waitingApprovalId, 'the durable record must reference the real approvalId it is waiting on');
  assert.equal(durableRunState.listRunning().length, 0, 'a paused run must never look like a crashed one');
});

test('5. durable state survives a fresh store instance pointed at the same directory (restart safety)', async () => {
  const { taskStore, newRunner, durableRunsDir } = buildStack();
  const runner = newRunner([rawStep({})]);
  const task = taskStore.create({ tenantId: 't_p03', ownerId: 'u_p03', name: 'Search', objective: 'x', type: 'ONE_TIME', trigger: { type: 'MANUAL' }, approvalPolicy: 'READ_ONLY_AUTO' });
  await runner.run(task, 'req_5', 'run_5');

  const reloaded = new DurableTaskRunStateStore({ dir: durableRunsDir });
  const record = reloaded.get('run_5');
  assert.ok(record, 'the durable record must survive a fresh store instance reading the same directory');
  assert.equal(record?.status, 'SUCCEEDED');
});

test('6. startup recovery resumes a run left genuinely mid-flight, reconstructed exactly as a real crash would leave it', async () => {
  const { taskStore, taskRunStore, durableRunState, durableRuntime, getGmailSearchCount } = buildStack();
  const task = taskStore.create({ tenantId: 't_p03', ownerId: 'u_p03', name: 'Recover', objective: 'x', type: 'ONE_TIME', trigger: { type: 'MANUAL' }, approvalPolicy: 'READ_ONLY_AUTO' });

  const resolved = planResolver.resolve(rawPlan([
    rawStep({ step: 1, title: 'Search first', dependsOn: [] }),
    rawStep({ step: 2, title: 'Search second', dependsOn: [1] }),
  ]));
  const runId = 'exe_recover_1';
  const runRequestId = 'req_recover_1';
  taskRunStore.start({ runId, taskId: task.taskId, tenantId: task.tenantId, startedAt: new Date().toISOString() });
  durableRunState.create({ runId, taskId: task.taskId, tenantId: task.tenantId, ownerId: task.ownerId, runRequestId, resolvedSteps: resolved.steps });
  // Simulate: step 1 already executed and was durably recorded by the
  // prior process life; it died before ever reaching step 2.
  durableRunState.recordStepExecuted(runId, { step: 1, capabilityId: 'gmail.search', status: 'EXECUTED', result: { threads: [] } }, 1);
  assert.equal(getGmailSearchCount(), 0, 'the reconstruction itself must never make a real call');
  assert.equal(durableRunState.listRunning().length, 1);

  const { recovered, failed } = await durableRuntime.recoverOnStartup();
  assert.equal(recovered, 1);
  assert.equal(failed, 0);
  assert.equal(durableRunState.listRunning().length, 0, 'recovery must leave no run looking still-crashed');
  assert.equal(getGmailSearchCount(), 1, 'only the genuinely un-executed step 2 must dispatch a real call');
  const finalRun = taskRunStore.get(runId);
  assert.equal(finalRun?.status, 'SUCCEEDED');
  const finalResult = finalRun?.result as { steps: Array<{ step: number }> };
  assert.equal(finalResult.steps.length, 2, 'both the pre-crash step and the recovered step must appear in the final result');
});

test('7. startup recovery correctly resumes into a fresh approval pause when the next step is a consequential write', async () => {
  const { taskStore, taskRunStore, durableRunState, durableRuntime, continuations } = buildStack();
  const task = taskStore.create({ tenantId: 't_p03', ownerId: 'u_p03', name: 'Recover to pause', objective: 'x', type: 'ONE_TIME', trigger: { type: 'MANUAL' }, approvalPolicy: 'READ_ONLY_AUTO' });

  const resolved = planResolver.resolve(rawPlan([
    rawStep({ step: 1, title: 'Search first', dependsOn: [] }),
    rawStep({ step: 2, title: 'Send an email', tool: 'gmail.send_email', requiresApproval: true, dependsOn: [1], parameters: { from: 'user@example.com', to: ['alice@example.com'], subject: 'Hi', body: 'Hello' } }),
  ]));
  const runId = 'exe_recover_2';
  const runRequestId = 'req_recover_2';
  taskRunStore.start({ runId, taskId: task.taskId, tenantId: task.tenantId, startedAt: new Date().toISOString() });
  durableRunState.create({ runId, taskId: task.taskId, tenantId: task.tenantId, ownerId: task.ownerId, runRequestId, resolvedSteps: resolved.steps });
  durableRunState.recordStepExecuted(runId, { step: 1, capabilityId: 'gmail.search', status: 'EXECUTED', result: { threads: [] } }, 1);

  const { recovered, failed } = await durableRuntime.recoverOnStartup();
  assert.equal(recovered, 1);
  assert.equal(failed, 0);
  const finalRun = taskRunStore.get(runId);
  assert.equal(finalRun?.status, 'WAITING_APPROVAL');
  const record = continuations.listForTask(task.taskId)[0];
  assert.ok(record, 'a real continuation must have been created for the newly-reached approval');
  assert.equal(durableRunState.get(runId)?.status, 'WAITING_APPROVAL');
});

test('8. startup recovery never touches a run already WAITING_APPROVAL', async () => {
  const { taskStore, scheduler, durableRunState, durableRuntime } = buildStack();
  const task = taskStore.create({ tenantId: 't_p03', ownerId: 'u_p03', name: 'Already waiting', objective: 'x', type: 'ONE_TIME', trigger: { type: 'MANUAL' }, approvalPolicy: 'READ_ONLY_AUTO' });
  const run = await scheduler.runOne(task);
  assert.equal(run.status, 'WAITING_APPROVAL');

  const { recovered, failed } = await durableRuntime.recoverOnStartup();
  assert.equal(recovered, 0);
  assert.equal(failed, 0);
  assert.equal(durableRunState.get(run.runId)?.status, 'WAITING_APPROVAL', 'recovery must leave an already-paused run untouched');
});

test('9. startup recovery never touches a terminal (SUCCEEDED) run', async () => {
  const { taskStore, newRunner, durableRunState, durableRuntime } = buildStack();
  const runner = newRunner([rawStep({})]);
  const task = taskStore.create({ tenantId: 't_p03', ownerId: 'u_p03', name: 'Search', objective: 'x', type: 'ONE_TIME', trigger: { type: 'MANUAL' }, approvalPolicy: 'READ_ONLY_AUTO' });
  await runner.run(task, 'req_9', 'run_9');
  assert.equal(durableRunState.get('run_9')?.status, 'SUCCEEDED');

  const { recovered, failed } = await durableRuntime.recoverOnStartup();
  assert.equal(recovered, 0);
  assert.equal(failed, 0);
});

test('10. a re-dispatched step after simulated crash reuses the exact same deterministic requestId, so the Broker idempotency cache prevents a real second execution', async () => {
  const { taskStore, taskRunStore, durableRunState, durableRuntime, capabilityBroker, getGmailSearchCount } = buildStack();
  const task = taskStore.create({ tenantId: 't_p03', ownerId: 'u_p03', name: 'Idempotent recovery', objective: 'x', type: 'ONE_TIME', trigger: { type: 'MANUAL' }, approvalPolicy: 'READ_ONLY_AUTO' });

  const resolved = planResolver.resolve(rawPlan([rawStep({ step: 1, dependsOn: [] })]));
  const runId = 'exe_recover_idem';
  const runRequestId = 'req_recover_idem';

  // The real dispatch happens here, exactly as executeSteps() would have
  // dispatched it — same deterministic requestId formula
  // (`${runRequestId}_step${step.step}`) — but the crash lands before
  // DurableTaskRunStateStore ever records it: stepIndex stays 0.
  const originalResult = await capabilityBroker.execute({
    capabilityId: 'gmail.search', tenantId: task.tenantId, principalId: task.ownerId,
    requestId: `${runRequestId}_step1`, payload: { query: 'invoice' }, source: 'TASK',
  });
  assert.equal(originalResult.status, 'EXECUTED');
  assert.equal(getGmailSearchCount(), 1, 'the original dispatch must have made exactly one real call');

  taskRunStore.start({ runId, taskId: task.taskId, tenantId: task.tenantId, startedAt: new Date().toISOString() });
  durableRunState.create({ runId, taskId: task.taskId, tenantId: task.tenantId, ownerId: task.ownerId, runRequestId, resolvedSteps: resolved.steps });
  // stepIndex is left at 0 — recovery must re-attempt step 1.

  const { recovered, failed } = await durableRuntime.recoverOnStartup();
  assert.equal(recovered, 1);
  assert.equal(failed, 0);
  assert.equal(getGmailSearchCount(), 1, 'recovery re-dispatching step 1 must hit the Broker idempotency cache, never a second real call');
  assert.deepEqual(durableRunState.get(runId)?.executedSoFar[0]?.result, (originalResult as { result: unknown }).result, 'the recovered step result must be the exact original cached result');
});

test('11. an orphaned run whose task was deleted since it started is marked FAILED by recovery, not left stuck', async () => {
  const { taskStore, taskRunStore, durableRunState, durableRuntime } = buildStack();
  const task = taskStore.create({ tenantId: 't_p03', ownerId: 'u_p03', name: 'Doomed', objective: 'x', type: 'ONE_TIME', trigger: { type: 'MANUAL' }, approvalPolicy: 'READ_ONLY_AUTO' });
  const resolved = planResolver.resolve(rawPlan([rawStep({})]));
  const runId = 'exe_recover_orphan';
  taskRunStore.start({ runId, taskId: task.taskId, tenantId: task.tenantId, startedAt: new Date().toISOString() });
  durableRunState.create({ runId, taskId: task.taskId, tenantId: task.tenantId, ownerId: task.ownerId, runRequestId: 'req_orphan', resolvedSteps: resolved.steps });
  taskStore.delete(task.taskId);

  const { recovered, failed } = await durableRuntime.recoverOnStartup();
  assert.equal(recovered, 0);
  assert.equal(failed, 1);
  assert.equal(durableRunState.get(runId)?.status, 'FAILED');
});

test('12. recoverOnStartup() returns an accurate summary across a mix of recoverable and orphaned runs', async () => {
  const { taskStore, taskRunStore, durableRunState, durableRuntime } = buildStack();
  const resolved = planResolver.resolve(rawPlan([rawStep({})]));

  const okTask = taskStore.create({ tenantId: 't_p03', ownerId: 'u_p03', name: 'OK', objective: 'x', type: 'ONE_TIME', trigger: { type: 'MANUAL' }, approvalPolicy: 'READ_ONLY_AUTO' });
  taskRunStore.start({ runId: 'exe_mix_ok', taskId: okTask.taskId, tenantId: okTask.tenantId, startedAt: new Date().toISOString() });
  durableRunState.create({ runId: 'exe_mix_ok', taskId: okTask.taskId, tenantId: okTask.tenantId, ownerId: okTask.ownerId, runRequestId: 'req_mix_ok', resolvedSteps: resolved.steps });

  const doomedTask = taskStore.create({ tenantId: 't_p03', ownerId: 'u_p03', name: 'Doomed', objective: 'x', type: 'ONE_TIME', trigger: { type: 'MANUAL' }, approvalPolicy: 'READ_ONLY_AUTO' });
  taskRunStore.start({ runId: 'exe_mix_doomed', taskId: doomedTask.taskId, tenantId: doomedTask.tenantId, startedAt: new Date().toISOString() });
  durableRunState.create({ runId: 'exe_mix_doomed', taskId: doomedTask.taskId, tenantId: doomedTask.tenantId, ownerId: doomedTask.ownerId, runRequestId: 'req_mix_doomed', resolvedSteps: resolved.steps });
  taskStore.delete(doomedTask.taskId);

  const { recovered, failed } = await durableRuntime.recoverOnStartup();
  assert.equal(recovered, 1);
  assert.equal(failed, 1);
});

test('13. TaskContinuationRecord no longer duplicates resolvedSteps/stepIndex/executedSoFar (single source of truth is DurableTaskRunStateStore)', async () => {
  const { taskStore, scheduler, continuations } = buildStack();
  const task = taskStore.create({ tenantId: 't_p03', ownerId: 'u_p03', name: 'Send', objective: 'x', type: 'ONE_TIME', trigger: { type: 'MANUAL' }, approvalPolicy: 'READ_ONLY_AUTO' });
  await scheduler.runOne(task);
  const record = continuations.listForTask(task.taskId)[0];
  assert.ok(record);
  assert.equal('resolvedSteps' in record, false);
  assert.equal('stepIndex' in record, false);
  assert.equal('executedSoFar' in record, false);
  // It still keeps the small denormalized fields needed to describe what
  // the approval is for.
  assert.equal(record.capabilityId, 'gmail.send_email');
  assert.ok(record.runId, 'must still point at the durable run-state record by runId');
});

test('14. listForTask isolates durable records per task correctly across multiple concurrent runs', async () => {
  const { taskStore, newRunner, durableRunState } = buildStack();
  const runnerA = newRunner([rawStep({})]);
  const runnerB = newRunner([rawStep({})]);
  const taskA = taskStore.create({ tenantId: 't_p03', ownerId: 'u_p03', name: 'A', objective: 'x', type: 'ONE_TIME', trigger: { type: 'MANUAL' }, approvalPolicy: 'READ_ONLY_AUTO' });
  const taskB = taskStore.create({ tenantId: 't_p03', ownerId: 'u_p03', name: 'B', objective: 'x', type: 'ONE_TIME', trigger: { type: 'MANUAL' }, approvalPolicy: 'READ_ONLY_AUTO' });
  await runnerA.run(taskA, 'req_a', 'run_a');
  await runnerB.run(taskB, 'req_b', 'run_b');

  assert.equal(durableRunState.listForTask(taskA.taskId).length, 1);
  assert.equal(durableRunState.listForTask(taskA.taskId)[0].runId, 'run_a');
  assert.equal(durableRunState.listForTask(taskB.taskId).length, 1);
  assert.equal(durableRunState.listForTask(taskB.taskId)[0].runId, 'run_b');
});

test('15. no concrete provider service is imported by the durable run-state store or runtime', () => {
  for (const file of ['src/tasks/durable-task-run-state.store.ts', 'src/tasks/durable-task-runtime.ts']) {
    const code = fs.readFileSync(path.resolve(file), 'utf8').split('\n').map((l) => l.replace(/\/\/.*/, '')).join('\n');
    assert.doesNotMatch(code, /modules\/(browser|gmail|calendar)\//, `${file} must never import a Browser/Gmail/Calendar module file directly`);
    assert.doesNotMatch(code, /integrations\/google/, `${file} must never import Google OAuth/provider internals directly`);
  }
});

test('16. no false completion/failure notification for a run recovered into a fresh approval pause', async () => {
  const { taskStore, taskRunStore, durableRunState, capabilityBroker } = buildStack();
  const notificationStore = new NotificationStore({ dir: tempDir('notifications') });
  const auditLogger = new AuditLogger();
  const notificationEngine = new NotificationEngine({ store: notificationStore, auditLogger });
  const dispatched: string[] = [];
  notificationEngine.dispatch = (async (opts: any) => { dispatched.push(opts.type); return {} as any; }) as any;

  const runner = new ExecutingTaskRunner({ plan: async () => ({ data: rawPlan([rawStep({})]) }) } as any, planResolver, capabilityBroker, () => [], new TaskContinuationStore({ dir: tempDir('cont') }), durableRunState);
  const runtime = new DurableTaskRuntime(durableRunState, runner, taskStore, taskRunStore, auditLogger, undefined, notificationEngine);

  const task = taskStore.create({ tenantId: 't_p03', ownerId: 'u_p03', name: 'Recover to pause quietly', objective: 'x', type: 'ONE_TIME', trigger: { type: 'MANUAL' }, approvalPolicy: 'READ_ONLY_AUTO' });
  const resolved = planResolver.resolve(rawPlan([
    rawStep({ step: 1, dependsOn: [] }),
    rawStep({ step: 2, title: 'Send an email', tool: 'gmail.send_email', requiresApproval: true, dependsOn: [1], parameters: { from: 'user@example.com', to: ['alice@example.com'], subject: 'Hi', body: 'Hello' } }),
  ]));
  const runId = 'exe_recover_quiet';
  taskRunStore.start({ runId, taskId: task.taskId, tenantId: task.tenantId, startedAt: new Date().toISOString() });
  durableRunState.create({ runId, taskId: task.taskId, tenantId: task.tenantId, ownerId: task.ownerId, runRequestId: 'req_recover_quiet', resolvedSteps: resolved.steps });
  durableRunState.recordStepExecuted(runId, { step: 1, capabilityId: 'gmail.search', status: 'EXECUTED', result: {} }, 1);

  await runtime.recoverOnStartup();
  assert.deepEqual(dispatched, ['APPROVAL_REQUEST'], 'a recovered run that pauses again must dispatch APPROVAL_REQUEST but never TASK_COMPLETED/TASK_FAILED');
});

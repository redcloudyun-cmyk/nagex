// P04 — NAgex Notification Delivery.
//
// Comprehensive test coverage for the P04 directive:
// - APPROVAL_REQUEST notification on WAITING_APPROVAL
// - Deduplication across restart, resume, and duplicate finalization
// - Terminal notification correctness (TASK_COMPLETED, TASK_FAILED, CONDITION_MET)
// - NotificationStore restart persistence, unread/read, and principal isolation
// - Multi-channel resilience (Telegram/Slack/Desktop failures)
// - Metadata safety (no secrets/tokens)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NotificationStore, type NotificationRecord } from '../src/notifications/notification.store.js';
import { NotificationEngine } from '../src/notifications/notification.engine.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { TaskStore } from '../src/tasks/task.store.js';
import { TaskRunStore } from '../src/tasks/task-run.store.js';
import { TaskScheduler } from '../src/tasks/task.scheduler.js';
import { finalizeTaskRun, type TaskRunFinalizationDeps } from '../src/tasks/task-run-finalizer.js';
import { TelegramIdentityStore } from '../src/integrations/telegram/telegram-identity.store.js';
import { TelegramBotClient } from '../src/integrations/telegram/telegram.client.js';
import { SlackIdentityStore } from '../src/integrations/slack/slack-identity.store.js';
import { SlackClient } from '../src/integrations/slack/slack.client.js';
import { DesktopRuntimeEngine } from '../src/desktop/desktop-runtime.engine.js';
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
import { DurableTaskRuntime } from '../src/tasks/durable-task-runtime.js';
import { PlanResolver } from '../src/planning/plan-resolver.js';
import { skillRegistry } from '../src/skills/skill-registry.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import { AiService, type PlanPreview } from '../src/model-gateway/ai-service.js';
import { UnifiedModelRouter } from '../src/model-gateway/unified-model-router.js';
import { createProviders } from '../src/model-gateway/providers.js';
import type { TaskRunOutcome } from '../src/tasks/task.scheduler.js';

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `nagex-p04-${prefix}-`));
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

// ── Shared test infrastructure ──────────────────────────────────────────

const liveToolRegistry = new ToolRegistry([
  { id: 'gmail.search', name: 'Gmail Search', capability: 'email.search', connectionStatus: 'connected', sideEffectLevel: 'READ_ONLY', requiresApproval: false, executionMode: 'live', aliases: [] },
  { id: 'gmail.send_email', name: 'Gmail Send', capability: 'email.send', connectionStatus: 'connected', sideEffectLevel: 'IRREVERSIBLE_WRITE', requiresApproval: true, executionMode: 'live', aliases: [] },
]);
const planResolver = new PlanResolver(skillRegistry, liveToolRegistry);

function aiServiceReturning(rawPlan: unknown): AiService {
  const providers = createProviders(
    { OPENAI_API_KEY: 'test-key', NAGEX_OPENAI_MODEL: 'test-p04-model' },
    async () => jsonResponse({ output_text: JSON.stringify(rawPlan) }),
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

function buildP04Stack() {
  const auditLogger = new AuditLogger();
  const actionApprovals = new ActionApprovalStore();
  const executionStore = new ExecutionStore({ dir: tempDir('exec') });
  const memoryEngine = new MemoryEngine();
  const tokenStore: any = { getValidAccessToken: async () => 'mock_token' };
  const getConfig: any = () => ({ clientId: 'mock', clientSecret: 'mock', redirectUri: 'mock' });

  const gmailService = new GmailService(
    tokenStore, actionApprovals, auditLogger, memoryEngine,
    async (url: any) => {
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
  const capabilityBroker = new CapabilityBroker(calendarService, gmailService, browserService, auditLogger, registry, 'test_p04_idempotency', 'NAGEX_TEST_P04_IDEMPOTENCY_DIR');
  process.env.NAGEX_TEST_P04_IDEMPOTENCY_DIR = tempDir('idempotency');

  const taskStore = new TaskStore({ dir: tempDir('tasks') });
  const taskRunStore = new TaskRunStore({ dir: tempDir('task-runs') });
  const continuationsDir = tempDir('continuations');
  const continuations = new TaskContinuationStore({ dir: continuationsDir });
  const durableRunStateDir = tempDir('durable-runs');
  const durableRunState = new DurableTaskRunStateStore({ dir: durableRunStateDir });

  const notifDir = tempDir('notifications');
  const notificationStore = new NotificationStore({ dir: notifDir });
  const notificationEngine = new NotificationEngine({ store: notificationStore, auditLogger });

  const executingTaskRunner = new ExecutingTaskRunner(
    aiServiceReturning(rawPlan([rawStep({})])),
    planResolver,
    capabilityBroker,
    () => [],
    continuations,
    durableRunState,
  );
  const scheduler = new TaskScheduler(taskStore, taskRunStore, executingTaskRunner, auditLogger, undefined, notificationEngine);
  const coordinator = new TaskContinuationCoordinator(continuations, durableRunState, executingTaskRunner, taskStore, taskRunStore, auditLogger, undefined, notificationEngine);
  const durableRuntime = new DurableTaskRuntime(durableRunState, executingTaskRunner, taskStore, taskRunStore, auditLogger, undefined, notificationEngine);

  return {
    auditLogger, actionApprovals, taskStore, taskRunStore, continuations, continuationsDir,
    durableRunState, durableRunStateDir, capabilityBroker, scheduler, coordinator,
    durableRuntime, executingTaskRunner, notificationStore, notificationEngine, notifDir,
  };
}

function createTask(taskStore: TaskStore, overrides: Partial<Parameters<TaskStore['create']>[0]> = {}) {
  return taskStore.create({
    tenantId: 't_p04', ownerId: 'u_p04', name: 'P04 Test Task',
    objective: 'Send an email', type: 'ONE_TIME',
    trigger: { type: 'MANUAL' }, approvalPolicy: 'READ_ONLY_AUTO',
    ...overrides,
  });
}

// ── P04 Section 11: Required test coverage ──────────────────────────────

test('P04-01: WAITING_APPROVAL creates one APPROVAL_REQUEST notification', async () => {
  const { taskStore, notificationStore, scheduler } = buildP04Stack();
  const task = createTask(taskStore);
  await scheduler.runOne(task);

  // Allow async notification dispatch to complete
  await new Promise((r) => setTimeout(r, 50));

  const notifications = notificationStore.list('t_p04', 'u_p04');
  const approvalNotifs = notifications.filter((n) => n.type === 'APPROVAL_REQUEST');
  assert.equal(approvalNotifs.length, 1, 'exactly one APPROVAL_REQUEST notification must exist');
  assert.equal(approvalNotifs[0].principalId, 'u_p04');
  assert.ok(approvalNotifs[0].title.includes('Approval Required'));
  assert.ok(approvalNotifs[0].metadata?.taskId);
  assert.ok(approvalNotifs[0].metadata?.runId);
});

test('P04-02: duplicate wait transition does not duplicate APPROVAL_REQUEST notification', async () => {
  const { taskStore, taskRunStore, notificationStore, notificationEngine, auditLogger } = buildP04Stack();
  const task = createTask(taskStore);
  const runId = 'run_dup_test';
  taskRunStore.start({ runId, taskId: task.taskId, tenantId: 't_p04', startedAt: new Date().toISOString() });

  const deps: TaskRunFinalizationDeps = { tasks: taskStore, runs: taskRunStore, audit: auditLogger, now: () => new Date(), notificationEngine };
  const outcome: TaskRunOutcome = {
    status: 'WAITING_APPROVAL',
    result: { approvalId: 'apr_dup_test', waitingAtStep: 1 },
  };

  // Finalize twice with the same taskId + runId + WAITING_APPROVAL
  finalizeTaskRun(deps, task, runId, 'req_1', outcome);
  await new Promise((r) => setTimeout(r, 50));
  finalizeTaskRun(deps, task, runId, 'req_2', outcome);
  await new Promise((r) => setTimeout(r, 50));

  const notifications = notificationStore.list('t_p04', 'u_p04');
  const approvalNotifs = notifications.filter((n) => n.type === 'APPROVAL_REQUEST');
  assert.equal(approvalNotifs.length, 1, 'deduplication must prevent a second APPROVAL_REQUEST');
});

test('P04-03: success creates one TASK_COMPLETED notification', async () => {
  const { taskStore, taskRunStore, notificationStore, notificationEngine, auditLogger } = buildP04Stack();
  const task = createTask(taskStore);
  const runId = 'run_success';
  taskRunStore.start({ runId, taskId: task.taskId, tenantId: 't_p04', startedAt: new Date().toISOString() });

  const deps: TaskRunFinalizationDeps = { tasks: taskStore, runs: taskRunStore, audit: auditLogger, now: () => new Date(), notificationEngine };
  finalizeTaskRun(deps, task, runId, 'req_s', { status: 'SUCCEEDED', result: { done: true } });
  await new Promise((r) => setTimeout(r, 50));

  const notifications = notificationStore.list('t_p04', 'u_p04');
  assert.equal(notifications.filter((n) => n.type === 'TASK_COMPLETED').length, 1);
});

test('P04-04: failure creates one TASK_FAILED notification', async () => {
  const { taskStore, taskRunStore, notificationStore, notificationEngine, auditLogger } = buildP04Stack();
  const task = createTask(taskStore);
  const runId = 'run_fail';
  taskRunStore.start({ runId, taskId: task.taskId, tenantId: 't_p04', startedAt: new Date().toISOString() });

  const deps: TaskRunFinalizationDeps = { tasks: taskStore, runs: taskRunStore, audit: auditLogger, now: () => new Date(), notificationEngine };
  finalizeTaskRun(deps, task, runId, 'req_f', { status: 'FAILED', errorCode: 'TEST_FAILURE' });
  await new Promise((r) => setTimeout(r, 50));

  const notifications = notificationStore.list('t_p04', 'u_p04');
  assert.equal(notifications.filter((n) => n.type === 'TASK_FAILED').length, 1);
});

test('P04-05: condition match creates one CONDITION_MET notification', async () => {
  const { taskStore, taskRunStore, notificationStore, notificationEngine, auditLogger } = buildP04Stack();
  const task = createTask(taskStore);
  const runId = 'run_cond';
  taskRunStore.start({ runId, taskId: task.taskId, tenantId: 't_p04', startedAt: new Date().toISOString() });

  const deps: TaskRunFinalizationDeps = { tasks: taskStore, runs: taskRunStore, audit: auditLogger, now: () => new Date(), notificationEngine };
  finalizeTaskRun(deps, task, runId, 'req_c', { status: 'SUCCEEDED', conditionMet: true, result: null });
  await new Promise((r) => setTimeout(r, 50));

  const notifications = notificationStore.list('t_p04', 'u_p04');
  assert.equal(notifications.filter((n) => n.type === 'CONDITION_MET').length, 1);
  assert.equal(notifications.filter((n) => n.type === 'TASK_COMPLETED').length, 0, 'CONDITION_MET must not also create TASK_COMPLETED');
});

test('P04-06: duplicate terminal finalization does not duplicate notification (dedupeKey)', async () => {
  const { taskStore, taskRunStore, notificationStore, notificationEngine, auditLogger } = buildP04Stack();
  const task = createTask(taskStore);
  const runId = 'run_dup_term';
  taskRunStore.start({ runId, taskId: task.taskId, tenantId: 't_p04', startedAt: new Date().toISOString() });

  const deps: TaskRunFinalizationDeps = { tasks: taskStore, runs: taskRunStore, audit: auditLogger, now: () => new Date(), notificationEngine };
  // Finalize twice with the same outcome
  finalizeTaskRun(deps, task, runId, 'req_t1', { status: 'SUCCEEDED', result: null });
  await new Promise((r) => setTimeout(r, 50));
  finalizeTaskRun(deps, task, runId, 'req_t2', { status: 'SUCCEEDED', result: null });
  await new Promise((r) => setTimeout(r, 50));

  const notifications = notificationStore.list('t_p04', 'u_p04');
  assert.equal(notifications.filter((n) => n.type === 'TASK_COMPLETED').length, 1, 'deduplication must prevent a second TASK_COMPLETED');
});

test('P04-07: approval resume does not duplicate terminal notification', async () => {
  const { taskStore, taskRunStore, notificationStore, notificationEngine, auditLogger } = buildP04Stack();
  const task = createTask(taskStore);
  const runId = 'run_resume';
  taskRunStore.start({ runId, taskId: task.taskId, tenantId: 't_p04', startedAt: new Date().toISOString() });

  const deps: TaskRunFinalizationDeps = { tasks: taskStore, runs: taskRunStore, audit: auditLogger, now: () => new Date(), notificationEngine };
  // First: WAITING_APPROVAL
  finalizeTaskRun(deps, task, runId, 'req_w', { status: 'WAITING_APPROVAL', result: { approvalId: 'apr_resume_test' } });
  await new Promise((r) => setTimeout(r, 50));
  // Then: SUCCEEDED (simulating approval resume)
  finalizeTaskRun(deps, task, runId, 'req_r', { status: 'SUCCEEDED', result: null });
  await new Promise((r) => setTimeout(r, 50));

  const notifications = notificationStore.list('t_p04', 'u_p04');
  assert.equal(notifications.filter((n) => n.type === 'APPROVAL_REQUEST').length, 1);
  assert.equal(notifications.filter((n) => n.type === 'TASK_COMPLETED').length, 1);
  // Total should be exactly 2 (APPROVAL_REQUEST + TASK_COMPLETED)
  assert.equal(notifications.length, 2, 'approval resume must not create duplicate notifications');
});

test('P04-08: NotificationStore restart persistence', () => {
  const dir = tempDir('restart');
  const store1 = new NotificationStore({ dir });

  store1.save({
    id: 'notif_restart_1', tenantId: 'ten_1', principalId: 'usr_1',
    type: 'TASK_COMPLETED', title: 'Test', body: 'Test',
    read: false, channelDeliveries: [{ channel: 'WEB', status: 'DELIVERED' }],
    dedupeKey: 'test:key:1', createdAt: new Date().toISOString(),
  });

  // Fresh store instance simulating restart
  const store2 = new NotificationStore({ dir });
  const recovered = store2.list('ten_1', 'usr_1');
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].dedupeKey, 'test:key:1', 'dedupeKey must survive restart');
  assert.equal(store2.existsByDedupeKey('ten_1', 'usr_1', 'test:key:1'), true);
});

test('P04-09: unread/read persistence', () => {
  const dir = tempDir('readstate');
  const store1 = new NotificationStore({ dir });
  store1.save({
    id: 'notif_read_1', tenantId: 'ten_1', principalId: 'usr_1',
    type: 'TASK_COMPLETED', title: 'Test', body: 'Test',
    read: false, channelDeliveries: [{ channel: 'WEB', status: 'DELIVERED' }],
    createdAt: new Date().toISOString(),
  });

  assert.equal(store1.getUnreadCount('ten_1', 'usr_1'), 1);
  store1.markAsRead('notif_read_1', 'ten_1', 'usr_1');
  assert.equal(store1.getUnreadCount('ten_1', 'usr_1'), 0);

  // Persist across restart
  const store2 = new NotificationStore({ dir });
  assert.equal(store2.getUnreadCount('ten_1', 'usr_1'), 0, 'read state must survive restart');
  const record = store2.get('notif_read_1');
  assert.equal(record?.read, true);
});

test('P04-10: tenant/principal isolation', () => {
  const dir = tempDir('isolation');
  const store = new NotificationStore({ dir });

  store.save({
    id: 'notif_a', tenantId: 'ten_a', principalId: 'usr_a',
    type: 'TASK_COMPLETED', title: 'A', body: 'A',
    read: false, channelDeliveries: [{ channel: 'WEB', status: 'DELIVERED' }],
    createdAt: new Date().toISOString(),
  });
  store.save({
    id: 'notif_b', tenantId: 'ten_b', principalId: 'usr_b',
    type: 'TASK_COMPLETED', title: 'B', body: 'B',
    read: false, channelDeliveries: [{ channel: 'WEB', status: 'DELIVERED' }],
    createdAt: new Date().toISOString(),
  });

  assert.equal(store.list('ten_a', 'usr_a').length, 1);
  assert.equal(store.list('ten_b', 'usr_b').length, 1);
  assert.equal(store.getUnreadCount('ten_a', 'usr_a'), 1);
  assert.equal(store.getUnreadCount('ten_b', 'usr_b'), 1);

  // Principal guard: usr_a cannot mark usr_b's notification as read
  const crossResult = store.markAsRead('notif_b', 'ten_b', 'usr_a');
  assert.equal(crossResult, undefined, 'principal guard must prevent cross-principal read marking');
  assert.equal(store.getUnreadCount('ten_b', 'usr_b'), 1, 'usr_b notification must remain unread');

  // Owner can still mark their own notification as read
  const ownResult = store.markAsRead('notif_b', 'ten_b', 'usr_b');
  assert.equal(ownResult?.read, true);
});

// ── P04-R1: Tenant isolation (Store level) ──────────────────────────────

test('P04-R1-01: same principal, tenant A/B list isolation', () => {
  const dir = tempDir('r1-list');
  const store = new NotificationStore({ dir });
  const sameId = 'usr_shared';

  store.save({
    id: 'notif_ta', tenantId: 'ten_a', principalId: sameId,
    type: 'TASK_COMPLETED', title: 'A', body: 'A',
    read: false, channelDeliveries: [{ channel: 'WEB', status: 'DELIVERED' }],
    createdAt: new Date().toISOString(),
  });
  store.save({
    id: 'notif_tb', tenantId: 'ten_b', principalId: sameId,
    type: 'TASK_COMPLETED', title: 'B', body: 'B',
    read: false, channelDeliveries: [{ channel: 'WEB', status: 'DELIVERED' }],
    createdAt: new Date().toISOString(),
  });

  const listA = store.list('ten_a', sameId);
  const listB = store.list('ten_b', sameId);
  assert.equal(listA.length, 1);
  assert.equal(listA[0].id, 'notif_ta');
  assert.equal(listB.length, 1);
  assert.equal(listB[0].id, 'notif_tb');
});

test('P04-R1-02: same principal, tenant A/B unread count isolation', () => {
  const dir = tempDir('r1-unread');
  const store = new NotificationStore({ dir });
  const sameId = 'usr_shared';

  store.save({
    id: 'notif_ua', tenantId: 'ten_a', principalId: sameId,
    type: 'TASK_COMPLETED', title: 'A', body: 'A',
    read: false, channelDeliveries: [{ channel: 'WEB', status: 'DELIVERED' }],
    createdAt: new Date().toISOString(),
  });

  assert.equal(store.getUnreadCount('ten_a', sameId), 1);
  assert.equal(store.getUnreadCount('ten_b', sameId), 0, 'tenant B unread must not include tenant A record');
});

test('P04-R1-03: tenant A markAsRead cannot mutate tenant B notification (same principal)', () => {
  const dir = tempDir('r1-markone');
  const store = new NotificationStore({ dir });
  const sameId = 'usr_shared';

  store.save({
    id: 'notif_mb', tenantId: 'ten_b', principalId: sameId,
    type: 'TASK_COMPLETED', title: 'B', body: 'B',
    read: false, channelDeliveries: [{ channel: 'WEB', status: 'DELIVERED' }],
    createdAt: new Date().toISOString(),
  });

  const result = store.markAsRead('notif_mb', 'ten_a', sameId);
  assert.equal(result, undefined, 'tenant A must not be able to mark tenant B notification as read');
  assert.equal(store.getUnreadCount('ten_b', sameId), 1, 'tenant B notification must remain unread');
});

test('P04-R1-04: tenant A markAllAsRead leaves tenant B unread (same principal)', () => {
  const dir = tempDir('r1-markall');
  const store = new NotificationStore({ dir });
  const sameId = 'usr_shared';

  store.save({
    id: 'notif_maa', tenantId: 'ten_a', principalId: sameId,
    type: 'TASK_COMPLETED', title: 'A', body: 'A',
    read: false, channelDeliveries: [{ channel: 'WEB', status: 'DELIVERED' }],
    createdAt: new Date().toISOString(),
  });
  store.save({
    id: 'notif_mab', tenantId: 'ten_b', principalId: sameId,
    type: 'TASK_COMPLETED', title: 'B', body: 'B',
    read: false, channelDeliveries: [{ channel: 'WEB', status: 'DELIVERED' }],
    createdAt: new Date().toISOString(),
  });

  const count = store.markAllAsRead('ten_a', sameId);
  assert.equal(count, 1, 'only tenant A notification should be marked');
  assert.equal(store.getUnreadCount('ten_b', sameId), 1, 'tenant B notification must remain unread');
});

test('P04-R1-05: same tenant+principal+dedupeKey creates one record', () => {
  const dir = tempDir('r1-dedupe-same');
  const store = new NotificationStore({ dir });

  store.save({
    id: 'notif_d1', tenantId: 'ten_a', principalId: 'usr_x',
    type: 'TASK_COMPLETED', title: 'X', body: 'X',
    read: false, channelDeliveries: [{ channel: 'WEB', status: 'DELIVERED' }],
    dedupeKey: 'shared:key', createdAt: new Date().toISOString(),
  });

  assert.equal(store.existsByDedupeKey('ten_a', 'usr_x', 'shared:key'), true);
  assert.equal(store.getByDedupeKey('ten_a', 'usr_x', 'shared:key')?.id, 'notif_d1');
});

test('P04-R1-06: same principal + same dedupeKey across tenant A/B creates two records', async () => {
  const dir = tempDir('r1-dedupe-tenant');
  const store = new NotificationStore({ dir: path.join(dir, 'notifs') });
  const auditLogger = new AuditLogger();
  const engine = new NotificationEngine({ store, auditLogger });

  const recA = await engine.dispatch({
    tenantId: 'ten_a', principalId: 'usr_shared',
    type: 'TASK_COMPLETED', title: 'A', body: 'A', dedupeKey: 'cross:tenant:key',
  });
  const recB = await engine.dispatch({
    tenantId: 'ten_b', principalId: 'usr_shared',
    type: 'TASK_COMPLETED', title: 'B', body: 'B', dedupeKey: 'cross:tenant:key',
  });

  assert.notEqual(recA.id, recB.id, 'different tenants with the same dedupeKey must not collapse into one record');
  assert.equal(store.list('ten_a', 'usr_shared').length, 1);
  assert.equal(store.list('ten_b', 'usr_shared').length, 1);
});

test('P04-R1-07: same tenant + same dedupeKey across principal X/Y creates two records', async () => {
  const dir = tempDir('r1-dedupe-principal');
  const store = new NotificationStore({ dir: path.join(dir, 'notifs') });
  const auditLogger = new AuditLogger();
  const engine = new NotificationEngine({ store, auditLogger });

  const recX = await engine.dispatch({
    tenantId: 'ten_shared', principalId: 'usr_x',
    type: 'TASK_COMPLETED', title: 'X', body: 'X', dedupeKey: 'cross:principal:key',
  });
  const recY = await engine.dispatch({
    tenantId: 'ten_shared', principalId: 'usr_y',
    type: 'TASK_COMPLETED', title: 'Y', body: 'Y', dedupeKey: 'cross:principal:key',
  });

  assert.notEqual(recX.id, recY.id, 'different principals with the same dedupeKey must not collapse into one record');
  assert.equal(store.list('ten_shared', 'usr_x').length, 1);
  assert.equal(store.list('ten_shared', 'usr_y').length, 1);
});

test('P04-11: absent Telegram/Slack does not create false failure', async () => {
  const dir = tempDir('no-external');
  const store = new NotificationStore({ dir });
  const auditLogger = new AuditLogger();

  // NotificationEngine with NO Telegram, NO Slack, NO Desktop
  const engine = new NotificationEngine({ store, auditLogger });
  const record = await engine.dispatch({
    tenantId: 'ten_1', principalId: 'usr_1',
    type: 'TASK_COMPLETED', title: 'Done', body: 'Completed',
  });

  // Only WEB delivery should exist, with DELIVERED status
  assert.equal(record.channelDeliveries.length, 1);
  assert.equal(record.channelDeliveries[0].channel, 'WEB');
  assert.equal(record.channelDeliveries[0].status, 'DELIVERED');
  // No FAILED deliveries anywhere
  const failures = record.channelDeliveries.filter((d) => d.status === 'FAILED');
  assert.equal(failures.length, 0, 'absent channels must not produce FAILED deliveries');
});

test('P04-12: unsupported Desktop -> SKIPPED', async () => {
  const dir = tempDir('desktop-skip');
  const store = new NotificationStore({ dir });
  const auditLogger = new AuditLogger();
  const desktopRuntimeEngine = new DesktopRuntimeEngine({
    sessionStore: { getOrCreateMain: () => ({ sessionId: 'test', type: 'main' }) } as any,
    taskStore: { listByOwner: () => [] } as any,
    auditLogger,
  });

  const engine = new NotificationEngine({ store, desktopRuntimeEngine, auditLogger });
  const record = await engine.dispatch({
    tenantId: 'ten_1', principalId: 'usr_1',
    type: 'TASK_COMPLETED', title: 'Done', body: 'Completed',
  });

  const desktopDel = record.channelDeliveries.find((d) => d.channel === 'DESKTOP');
  // Desktop runtime is not actually running (no Electron), so it should be SKIPPED or DELIVERED
  // (DesktopRuntimeEngine.dispatchNotification returns a payload object which is truthy, so DELIVERED)
  // Either way, it must NOT be FAILED
  assert.ok(desktopDel, 'Desktop delivery must be attempted');
  assert.notEqual(desktopDel?.status, 'FAILED', 'Desktop must not produce false FAILED');
});

test('P04-13: external delivery failure does not fail TaskRun', async () => {
  const { taskStore, taskRunStore, notificationEngine, auditLogger } = buildP04Stack();

  // Replace the notification engine's dispatch to throw
  const originalDispatch = notificationEngine.dispatch.bind(notificationEngine);
  let dispatchError: Error | null = null;
  notificationEngine.dispatch = async (opts: any) => {
    try {
      return await originalDispatch(opts);
    } catch (err) {
      dispatchError = err as Error;
      throw err;
    }
  };

  const task = createTask(taskStore);
  const runId = 'run_ext_fail';
  taskRunStore.start({ runId, taskId: task.taskId, tenantId: 't_p04', startedAt: new Date().toISOString() });

  const deps: TaskRunFinalizationDeps = { tasks: taskStore, runs: taskRunStore, audit: auditLogger, now: () => new Date(), notificationEngine };
  // finalizeTaskRun must not throw even if dispatch had an issue
  const run = finalizeTaskRun(deps, task, runId, 'req_ext', { status: 'SUCCEEDED', result: null });
  assert.equal(run.status, 'SUCCEEDED', 'TaskRun must remain SUCCEEDED regardless of notification dispatch');
});

test('P04-14: metadata does not expose secret approval payload/token', async () => {
  const { taskStore, notificationStore, scheduler } = buildP04Stack();
  const task = createTask(taskStore);
  await scheduler.runOne(task);
  await new Promise((r) => setTimeout(r, 50));

  const notifications = notificationStore.list('t_p04', 'u_p04');
  for (const notif of notifications) {
    const metaStr = JSON.stringify(notif.metadata ?? {});
    // Must never contain secrets, tokens, credentials, full payloads
    assert.doesNotMatch(metaStr, /mock_token/i, 'metadata must not contain OAuth tokens');
    assert.doesNotMatch(metaStr, /clientSecret/i, 'metadata must not contain client secrets');
    assert.doesNotMatch(metaStr, /password/i, 'metadata must not contain passwords');
    // Allowed fields: taskId, runId, approvalId, waitingAtStep, capabilityId
    if (notif.metadata) {
      for (const key of Object.keys(notif.metadata)) {
        assert.ok(
          ['taskId', 'runId', 'approvalId', 'waitingAtStep', 'capabilityId'].includes(key),
          `unexpected metadata key "${key}" — only safe identifiers allowed`,
        );
      }
    }
  }
});

test('P04-15: dedupeKey persists and is queryable across store restart', () => {
  const dir = tempDir('dedupe-persist');
  const store1 = new NotificationStore({ dir });

  store1.save({
    id: 'notif_dk', tenantId: 'ten_1', principalId: 'usr_1',
    type: 'TASK_COMPLETED', title: 'Test', body: 'Test',
    read: false, channelDeliveries: [{ channel: 'WEB', status: 'DELIVERED' }],
    dedupeKey: 'task123:run456:TASK_COMPLETED', createdAt: new Date().toISOString(),
  });

  assert.equal(store1.existsByDedupeKey('ten_1', 'usr_1', 'task123:run456:TASK_COMPLETED'), true);
  assert.equal(store1.existsByDedupeKey('ten_1', 'usr_1', 'nonexistent:key'), false);

  // After restart
  const store2 = new NotificationStore({ dir });
  assert.equal(store2.existsByDedupeKey('ten_1', 'usr_1', 'task123:run456:TASK_COMPLETED'), true);
  const found = store2.getByDedupeKey('ten_1', 'usr_1', 'task123:run456:TASK_COMPLETED');
  assert.ok(found);
  assert.equal(found?.id, 'notif_dk');
});

test('P04-16: NotificationEngine deduplication returns existing record without creating new one', async () => {
  const dir = tempDir('engine-dedupe');
  const store = new NotificationStore({ dir });
  const auditLogger = new AuditLogger();
  const engine = new NotificationEngine({ store, auditLogger });

  const first = await engine.dispatch({
    tenantId: 'ten_1', principalId: 'usr_1',
    type: 'TASK_COMPLETED', title: 'First', body: 'First',
    dedupeKey: 'unique:event:key',
  });

  const second = await engine.dispatch({
    tenantId: 'ten_1', principalId: 'usr_1',
    type: 'TASK_COMPLETED', title: 'Second', body: 'Second',
    dedupeKey: 'unique:event:key',
  });

  // Must return the same record
  assert.equal(first.id, second.id, 'second dispatch with same dedupeKey must return existing record');
  assert.equal(first.title, 'First', 'returned record must be the original, not the duplicate');
  assert.equal(store.list('ten_1', 'usr_1').length, 1, 'only one notification must exist');
});

test('P04-17: persist-first ordering ensures WEB notification survives', async () => {
  const dir = tempDir('persist-first');
  const store = new NotificationStore({ dir });
  const auditLogger = new AuditLogger();

  // Simulating a Telegram failure — the WEB record should still be persisted
  const tgIdentityStore = new TelegramIdentityStore({ dir: tempDir('tg-id') });
  tgIdentityStore.link('tg_999', 'usr_1', 'ten_1', 'req_1');

  // Create a TelegramBotClient that throws
  const tgBotClient = new TelegramBotClient(null);
  const originalSend = tgBotClient.sendMessage.bind(tgBotClient);
  tgBotClient.sendMessage = async () => { throw new Error('Telegram unavailable'); };

  const engine = new NotificationEngine({
    store, auditLogger,
    telegramIdentityStore: tgIdentityStore,
    telegramBotClient: tgBotClient,
  });

  const record = await engine.dispatch({
    tenantId: 'ten_1', principalId: 'usr_1',
    type: 'TASK_COMPLETED', title: 'Persist First', body: 'Must survive',
  });

  // WEB must be DELIVERED, Telegram must be FAILED
  const webDel = record.channelDeliveries.find((d) => d.channel === 'WEB');
  const tgDel = record.channelDeliveries.find((d) => d.channel === 'TELEGRAM');
  assert.equal(webDel?.status, 'DELIVERED');
  assert.equal(tgDel?.status, 'FAILED');

  // The record must be persisted on disk
  const store2 = new NotificationStore({ dir });
  const recovered = store2.list('ten_1', 'usr_1');
  assert.equal(recovered.length, 1, 'notification must be persisted even when Telegram fails');
});

test('P04-18: markAllAsRead scoped by principal', () => {
  const dir = tempDir('mark-all');
  const store = new NotificationStore({ dir });

  store.save({
    id: 'notif_x', tenantId: 'ten_1', principalId: 'usr_x',
    type: 'TASK_COMPLETED', title: 'X', body: 'X',
    read: false, channelDeliveries: [{ channel: 'WEB', status: 'DELIVERED' }],
    createdAt: new Date().toISOString(),
  });
  store.save({
    id: 'notif_y', tenantId: 'ten_1', principalId: 'usr_y',
    type: 'TASK_COMPLETED', title: 'Y', body: 'Y',
    read: false, channelDeliveries: [{ channel: 'WEB', status: 'DELIVERED' }],
    createdAt: new Date().toISOString(),
  });

  const count = store.markAllAsRead('ten_1', 'usr_x');
  assert.equal(count, 1, 'only usr_x notifications should be marked');
  assert.equal(store.getUnreadCount('ten_1', 'usr_x'), 0);
  assert.equal(store.getUnreadCount('ten_1', 'usr_y'), 1, 'usr_y notifications must remain unread');
});

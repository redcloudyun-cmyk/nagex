// P07 — Reusable Workflow Definition Foundation.
//
// A WorkflowDefinition is a reusable description/template only — never an
// execution engine. These tests prove: durable tenant+owner-scoped CRUD,
// deterministic WorkflowDefinition -> PlanPreview -> ResolvedPlan mapping,
// that instantiation hands off to the exact existing Task/Plan/Capability
// Broker/Approval/Durable Runtime path unchanged, and that once a run has
// started, editing or deleting the WorkflowDefinition can never affect it —
// the frozen resolved plan / durable run state is the sole execution source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkflowDefinitionStore } from '../src/workflows/workflow-definition.store.js';
import { WorkflowDefinitionService, buildPlanPreview } from '../src/workflows/workflow-definition.service.js';
import { TaskStore } from '../src/tasks/task.store.js';
import { TaskRunStore } from '../src/tasks/task-run.store.js';
import { TaskContinuationStore } from '../src/tasks/task-continuation.store.js';
import { TaskContinuationCoordinator } from '../src/tasks/task-continuation.coordinator.js';
import { DurableTaskRunStateStore } from '../src/tasks/durable-task-run-state.store.js';
import { DurableTaskRuntime } from '../src/tasks/durable-task-runtime.js';
import { TaskScheduler } from '../src/tasks/task.scheduler.js';
import { ExecutingTaskRunner } from '../src/tasks/runners/executing-task.runner.js';
import { PlanResolver } from '../src/planning/plan-resolver.js';
import { skillRegistry } from '../src/skills/skill-registry.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import { CapabilityBroker } from '../src/capabilities/capability-broker.js';
import { CapabilityRegistry } from '../src/capabilities/capability.registry.js';
import { GoogleCalendarService } from '../src/modules/calendar/index.js';
import { GmailService } from '../src/modules/gmail/index.js';
import { ActionApprovalStore } from '../src/governance/action-approval.store.js';
import { ExecutionStore } from '../src/governance/execution.store.js';
import { MemoryEngine } from '../src/context/memory.engine.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { NagexError } from '../src/common/errors.js';
import type { AiService } from '../src/model-gateway/ai-service.js';
import { handleApiRequest, handleAsyncApiRequest } from '../src/server_web.js';

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `nagex-wf-${prefix}-`));
}

function stepInput(overrides: Record<string, unknown> = {}) {
  return { title: 'Search inbox', skill: 'skill.email_drafting', tool: 'gmail.search', parameters: { query: 'invoice' }, ...overrides };
}

// ── Store/service level: build only what CRUD needs (no capability broker) ──

function buildLightStack() {
  const auditLogger = new AuditLogger();
  const taskStore = new TaskStore({ dir: tempDir('tasks-light') });
  const liveToolRegistry = new ToolRegistry([
    { id: 'gmail.search', name: 'Gmail Search', capability: 'email.search', connectionStatus: 'connected', sideEffectLevel: 'READ_ONLY', requiresApproval: false, executionMode: 'live', aliases: [] },
  ]);
  const planResolver = new PlanResolver(skillRegistry, liveToolRegistry);
  const store = new WorkflowDefinitionStore({ dir: tempDir('workflows-light') });
  const service = new WorkflowDefinitionService({ store, taskStore, planResolver, auditLogger });
  return { auditLogger, taskStore, planResolver, store, service };
}

function createWorkflow(service: WorkflowDefinitionService, tenantId: string, ownerPrincipalId: string, overrides: Record<string, unknown> = {}) {
  return service.create(tenantId, ownerPrincipalId, {
    tenantId, ownerPrincipalId, name: 'Test Workflow', description: 'A test workflow.', enabled: true, steps: [stepInput()],
    ...overrides,
  } as any, 'req_wf_create');
}

// ── 1-5: basic durable CRUD ──────────────────────────────────────────────

test('1. create persists durably (fresh store instance sees it)', () => {
  const dir = tempDir('create-restart');
  const store1 = new WorkflowDefinitionStore({ dir });
  const created = store1.create({ tenantId: 't1', ownerPrincipalId: 'u1', name: 'W', description: 'd', steps: [stepInput()] });

  const store2 = new WorkflowDefinitionStore({ dir });
  const restored = store2.get(created.workflowId, 't1', 'u1');
  assert.ok(restored);
  assert.equal(restored!.name, 'W');
  assert.equal(restored!.steps.length, 1);
});

test('2. get returns the workflow only for its correct owner', () => {
  const { service } = buildLightStack();
  const created = createWorkflow(service, 't1', 'u1');
  assert.ok(service.get(created.workflowId, 't1', 'u1'));
});

test('3. list returns only the calling tenant+owner\'s workflows', () => {
  const { service } = buildLightStack();
  createWorkflow(service, 't1', 'u1', { name: 'Mine' });
  createWorkflow(service, 't1', 'u2', { name: 'Not mine (diff owner)' });
  createWorkflow(service, 't2', 'u1', { name: 'Not mine (diff tenant)' });
  const list = service.list('t1', 'u1');
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'Mine');
});

test('4. update mutates only for the correct owner', () => {
  const { service } = buildLightStack();
  const created = createWorkflow(service, 't1', 'u1');
  const updated = service.update(created.workflowId, 't1', 'u1', { name: 'Renamed' }, 'req_update');
  assert.equal(updated.name, 'Renamed');
  assert.ok(updated.updatedAt >= created.updatedAt);
});

test('5. delete removes the workflow only for the correct owner', () => {
  const { service } = buildLightStack();
  const created = createWorkflow(service, 't1', 'u1');
  service.delete(created.workflowId, 't1', 'u1', 'req_delete');
  assert.equal(service.get(created.workflowId, 't1', 'u1'), undefined);
});

// ── 6-11: tenant/owner isolation ─────────────────────────────────────────

test('6. same principalId, tenant A vs B isolation', () => {
  const { service } = buildLightStack();
  createWorkflow(service, 'ten_a', 'usr_shared', { name: 'A' });
  createWorkflow(service, 'ten_b', 'usr_shared', { name: 'B' });
  assert.equal(service.list('ten_a', 'usr_shared').length, 1);
  assert.equal(service.list('ten_a', 'usr_shared')[0].name, 'A');
  assert.equal(service.list('ten_b', 'usr_shared').length, 1);
  assert.equal(service.list('ten_b', 'usr_shared')[0].name, 'B');
});

test('7. same tenant, principal A vs B isolation', () => {
  const { service } = buildLightStack();
  createWorkflow(service, 'ten_1', 'usr_a', { name: 'A' });
  createWorkflow(service, 'ten_1', 'usr_b', { name: 'B' });
  assert.equal(service.list('ten_1', 'usr_a').length, 1);
  assert.equal(service.list('ten_1', 'usr_b').length, 1);
});

test('8. wrong tenant GET returns not found', () => {
  const { service } = buildLightStack();
  const created = createWorkflow(service, 'ten_a', 'usr_shared');
  assert.equal(service.get(created.workflowId, 'ten_b', 'usr_shared'), undefined);
});

test('9. wrong owner GET returns not found (same tenant)', () => {
  const { service } = buildLightStack();
  const created = createWorkflow(service, 'ten_1', 'usr_a');
  assert.equal(service.get(created.workflowId, 'ten_1', 'usr_b'), undefined);
});

test('10. wrong tenant PATCH does not mutate the workflow', () => {
  const { service } = buildLightStack();
  const created = createWorkflow(service, 'ten_a', 'usr_shared', { name: 'Original' });
  assert.throws(() => service.update(created.workflowId, 'ten_b', 'usr_shared', { name: 'Hijacked' }, 'req_x'), (err: unknown) => err instanceof NagexError && err.code === 'WORKFLOW_NOT_FOUND');
  assert.equal(service.get(created.workflowId, 'ten_a', 'usr_shared')!.name, 'Original');
});

test('11. wrong owner DELETE does not delete the workflow', () => {
  const { service } = buildLightStack();
  const created = createWorkflow(service, 'ten_1', 'usr_a');
  assert.throws(() => service.delete(created.workflowId, 'ten_1', 'usr_b', 'req_x'), (err: unknown) => err instanceof NagexError && err.code === 'WORKFLOW_NOT_FOUND');
  assert.ok(service.get(created.workflowId, 'ten_1', 'usr_a'));
});

// ── 12-14: disabled/deleted/wrong-tenant run guards ──────────────────────

test('12. wrong tenant RUN (prepareRun) creates no Task', () => {
  const { service, taskStore } = buildLightStack();
  const created = createWorkflow(service, 'ten_a', 'usr_shared');
  assert.throws(() => service.prepareRun(created.workflowId, 'ten_b', 'usr_shared', 'req_run'), (err: unknown) => err instanceof NagexError && err.code === 'WORKFLOW_NOT_FOUND');
  assert.equal(taskStore.list('ten_a', 'usr_shared').length, 0);
  assert.equal(taskStore.list('ten_b', 'usr_shared').length, 0);
});

test('13. disabled workflow cannot run', () => {
  const { service, taskStore } = buildLightStack();
  const created = createWorkflow(service, 'ten_1', 'usr_1', { enabled: false });
  assert.throws(() => service.prepareRun(created.workflowId, 'ten_1', 'usr_1', 'req_run'), (err: unknown) => err instanceof NagexError && err.code === 'WORKFLOW_DISABLED');
  assert.equal(taskStore.list('ten_1', 'usr_1').length, 0, 'a rejected run must never create a Task');
});

test('14. deleted workflow cannot run', () => {
  const { service } = buildLightStack();
  const created = createWorkflow(service, 'ten_1', 'usr_1');
  service.delete(created.workflowId, 'ten_1', 'usr_1', 'req_delete');
  assert.throws(() => service.prepareRun(created.workflowId, 'ten_1', 'usr_1', 'req_run'), (err: unknown) => err instanceof NagexError && err.code === 'WORKFLOW_NOT_FOUND');
});

test('disabled workflow may still be read and updated (only new runs are rejected)', () => {
  const { service } = buildLightStack();
  const created = createWorkflow(service, 'ten_1', 'usr_1', { enabled: false });
  assert.ok(service.get(created.workflowId, 'ten_1', 'usr_1'));
  const updated = service.update(created.workflowId, 'ten_1', 'usr_1', { name: 'Still editable' }, 'req_x');
  assert.equal(updated.name, 'Still editable');
});

// ── 15: restart ───────────────────────────────────────────────────────────

test('15. restart preserves workflow definitions', () => {
  const dir = tempDir('restart');
  const store1 = new WorkflowDefinitionStore({ dir });
  const created = store1.create({ tenantId: 't1', ownerPrincipalId: 'u1', name: 'Persisted', description: '', steps: [stepInput()] });
  const store2 = new WorkflowDefinitionStore({ dir });
  assert.ok(store2.get(created.workflowId, 't1', 'u1'));
  assert.equal(store2.list('t1', 'u1').length, 1);
});

// ── Plan mapping ──────────────────────────────────────────────────────────

test('buildPlanPreview maps steps deterministically using only static fields', () => {
  const { service } = buildLightStack();
  const created = createWorkflow(service, 't1', 'u1', {
    name: 'Mapped', description: 'desc',
    steps: [stepInput({ title: 'Step A' }), stepInput({ title: 'Step B', tool: null, parameters: undefined })],
  });
  const preview = buildPlanPreview(created);
  assert.equal(preview.goal, 'Mapped');
  assert.equal(preview.summary, 'desc');
  assert.equal(preview.steps.length, 2);
  assert.equal(preview.steps[0].step, 1);
  assert.equal(preview.steps[0].title, 'Step A');
  assert.equal(preview.steps[0].requiresApproval, false);
  assert.equal(preview.steps[1].step, 2);
  assert.equal(preview.steps[1].tool, null);
});

// ── Full-stack execution: real CapabilityBroker/Approval/Durable Runtime ──

const liveToolRegistry = new ToolRegistry([
  { id: 'gmail.search', name: 'Gmail Search', capability: 'email.search', connectionStatus: 'connected', sideEffectLevel: 'READ_ONLY', requiresApproval: false, executionMode: 'live', aliases: [] },
  { id: 'gmail.send_email', name: 'Gmail Send', capability: 'email.send', connectionStatus: 'connected', sideEffectLevel: 'IRREVERSIBLE_WRITE', requiresApproval: true, executionMode: 'live', aliases: [] },
]);
const fullPlanResolver = new PlanResolver(skillRegistry, liveToolRegistry);

function buildFullStack() {
  const auditLogger = new AuditLogger();
  const actionApprovals = new ActionApprovalStore();
  const executionStore = new ExecutionStore({ dir: tempDir('exec') });
  const memoryEngine = new MemoryEngine();
  const tokenStore: any = { getValidAccessToken: async () => 'mock_token' };
  const getConfig: any = () => ({ clientId: 'mock', clientSecret: 'mock', redirectUri: 'mock' });

  let gmailSearchCount = 0;
  const gmailService = new GmailService(
    tokenStore, actionApprovals, auditLogger, memoryEngine,
    async (url: any) => {
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
  const capabilityBroker = new CapabilityBroker(calendarService, gmailService, browserService, auditLogger, registry, 'test_wf_idempotency', 'NAGEX_TEST_WF_IDEMPOTENCY_DIR');
  process.env.NAGEX_TEST_WF_IDEMPOTENCY_DIR = tempDir('idempotency');

  const taskStore = new TaskStore({ dir: tempDir('tasks') });
  const taskRunStore = new TaskRunStore({ dir: tempDir('task-runs') });
  const continuations = new TaskContinuationStore({ dir: tempDir('continuations') });
  const durableRunState = new DurableTaskRunStateStore({ dir: tempDir('durable-runs') });
  const workflowStore = new WorkflowDefinitionStore({ dir: tempDir('workflows') });
  const workflowService = new WorkflowDefinitionService({ store: workflowStore, taskStore, planResolver: fullPlanResolver, auditLogger });

  // A workflow is a reusable definition, not an execution engine — the
  // planning LLM must never be reachable via runWithResolvedPlan(). This
  // fake throws if ExecutingTaskRunner.run()/plan() is ever called instead.
  const neverCalledAiService = {
    plan: async () => { throw new Error('WorkflowDefinition steps are static — aiService.plan() must never be called for a workflow-instantiated run.'); },
  } as unknown as AiService;

  const executingTaskRunner = new ExecutingTaskRunner(neverCalledAiService, fullPlanResolver, capabilityBroker, () => [], continuations, durableRunState);
  const coordinator = new TaskContinuationCoordinator(continuations, durableRunState, executingTaskRunner, taskStore, taskRunStore, auditLogger);
  const durableRuntime = new DurableTaskRuntime(durableRunState, executingTaskRunner, taskStore, taskRunStore, auditLogger);

  function runWorkflow(workflowId: string, tenantId: string, ownerPrincipalId: string, requestId = 'req_wf_run') {
    const prepared = workflowService.prepareRun(workflowId, tenantId, ownerPrincipalId, requestId);
    const scheduler = new TaskScheduler(
      taskStore, taskRunStore,
      { run: (t: any, reqId: string, runId: string) => executingTaskRunner.runWithResolvedPlan(t, reqId, runId, prepared.resolved) },
      auditLogger,
    );
    return scheduler.runOne(prepared.task).then((run) => ({ run, task: prepared.task, workflow: prepared.workflow }));
  }

  return {
    auditLogger, actionApprovals, taskStore, taskRunStore, continuations, durableRunState,
    workflowStore, workflowService, capabilityBroker, coordinator, durableRuntime,
    executingTaskRunner, runWorkflow, getGmailSearchCount: () => gmailSearchCount,
  };
}

test('16. a READ_ONLY workflow step resolves and executes through the real CapabilityExecutorPort/Broker path', async () => {
  const { workflowService, runWorkflow, getGmailSearchCount } = buildFullStack();
  const workflow = workflowService.create('t_wf', 'u_wf', {
    tenantId: 't_wf', ownerPrincipalId: 'u_wf', name: 'Search inbox', description: 'x', steps: [stepInput()],
  }, 'req_create');

  const { run } = await runWorkflow(workflow.workflowId, 't_wf', 'u_wf');
  assert.equal(run.status, 'SUCCEEDED');
  assert.equal(getGmailSearchCount(), 1, 'the READ_ONLY step must have gone through the real Broker/Gmail HTTP call, not a fabricated result');
});

test('17. a consequential workflow step reaches WAITING_APPROVAL, and one-time approval consumption still applies', async () => {
  const { workflowService, runWorkflow, actionApprovals, coordinator, continuations, capabilityBroker } = buildFullStack();
  const workflow = workflowService.create('t_wf2', 'u_wf2', {
    tenantId: 't_wf2', ownerPrincipalId: 'u_wf2', name: 'Send email', description: 'x',
    steps: [stepInput({ title: 'Send it', tool: 'gmail.send_email', parameters: { from: 'me@example.com', to: ['you@example.com'], subject: 'Hi', body: 'Hello' } })],
  }, 'req_create');

  const { run, task } = await runWorkflow(workflow.workflowId, 't_wf2', 'u_wf2');
  assert.equal(run.status, 'WAITING_APPROVAL');
  // TaskRunStore.waitForApproval() never sets `result` (documented, existing
  // behavior) — the approvalId lives only on the persisted continuation.
  const record = continuations.listForTask(task.taskId)[0];
  assert.ok(record);
  const approvalId = record.approvalId;

  actionApprovals.approve(approvalId, 'u_wf2');
  await coordinator.onApproved(approvalId);

  // Existing one-time consumption is untouched by P07: a direct replay
  // against the Broker with the same approvalId+payload still fails closed.
  await assert.rejects(
    () => capabilityBroker.execute({ capabilityId: 'gmail.send_email', tenantId: 't_wf2', principalId: 'u_wf2', requestId: `${record!.executionRequestId}_direct_replay`, payload: record!.payload, approvalId, source: 'TASK' }),
    (err: unknown) => err instanceof NagexError && err.code === 'APPROVAL_ALREADY_CONSUMED',
  );
});

test('18. editing a WorkflowDefinition after a run has started does not change the durable frozen plan', async () => {
  const { workflowService, runWorkflow, durableRunState } = buildFullStack();
  const workflow = workflowService.create('t_wf3', 'u_wf3', {
    tenantId: 't_wf3', ownerPrincipalId: 'u_wf3', name: 'Original name', description: 'x', steps: [stepInput({ title: 'Original step' })],
  }, 'req_create');

  const { run } = await runWorkflow(workflow.workflowId, 't_wf3', 'u_wf3');
  assert.equal(run.status, 'SUCCEEDED');
  const frozenBefore = durableRunState.get(run.runId);
  assert.ok(frozenBefore);
  assert.equal(frozenBefore!.resolvedSteps[0].title, 'Original step');

  workflowService.update(workflow.workflowId, 't_wf3', 'u_wf3', { steps: [stepInput({ title: 'Edited step', tool: 'gmail.send_email' })] }, 'req_edit');

  const frozenAfter = durableRunState.get(run.runId);
  assert.equal(frozenAfter!.resolvedSteps[0].title, 'Original step', 'the already-frozen durable plan must be unaffected by a later edit');
});

test('19. deleting a WorkflowDefinition after a run has started does not invalidate the already-running Task', async () => {
  const { workflowService, runWorkflow, actionApprovals, coordinator, continuations, taskStore } = buildFullStack();
  const workflow = workflowService.create('t_wf4', 'u_wf4', {
    tenantId: 't_wf4', ownerPrincipalId: 'u_wf4', name: 'Send email', description: 'x',
    steps: [stepInput({ title: 'Send it', tool: 'gmail.send_email', parameters: { from: 'me@example.com', to: ['you@example.com'], subject: 'Hi', body: 'Hello' } })],
  }, 'req_create');

  const { run, task } = await runWorkflow(workflow.workflowId, 't_wf4', 'u_wf4');
  assert.equal(run.status, 'WAITING_APPROVAL');

  workflowService.delete(workflow.workflowId, 't_wf4', 'u_wf4', 'req_delete');
  assert.equal(workflowService.get(workflow.workflowId, 't_wf4', 'u_wf4'), undefined);

  const approvalId = continuations.listForTask(task.taskId)[0].approvalId;
  actionApprovals.approve(approvalId, 'u_wf4');
  await coordinator.onApproved(approvalId);

  const finishedRun = taskStore.get(task.taskId, 't_wf4', 'u_wf4');
  assert.ok(finishedRun, 'the Task itself must be unaffected by the WorkflowDefinition having been deleted');
});

test('20. TaskRecord.workflowDefinitionId is set correctly and is traceability-only', async () => {
  const { workflowService, runWorkflow } = buildFullStack();
  const workflow = workflowService.create('t_wf5', 'u_wf5', {
    tenantId: 't_wf5', ownerPrincipalId: 'u_wf5', name: 'Traceable', description: 'x', steps: [stepInput()],
  }, 'req_create');

  const { task, run } = await runWorkflow(workflow.workflowId, 't_wf5', 'u_wf5');
  assert.equal(task.workflowDefinitionId, workflow.workflowId);
  assert.equal(run.status, 'SUCCEEDED', 'workflowDefinitionId is metadata only — execution outcome must not depend on it');
});

// ── Existing suites must remain green (exercised via the full npm run
// test:tasks / test:runtime / test:architecture / notification / memory /
// modules scoped runs, not duplicated here). ─────────────────────────────

// ── HTTP route wiring smoke tests ────────────────────────────────────────

const WF_HEADERS_A = { 'x-nagex-tenant': 'ten_wf_http_a', 'x-principal-id': 'usr_wf_http' };
const WF_HEADERS_B = { 'x-nagex-tenant': 'ten_wf_http_b', 'x-principal-id': 'usr_wf_http' };

test('HTTP: full CRUD lifecycle is reachable and tenant/owner-scoped', async () => {
  const created = await handleApiRequest('POST', '/api/v1/workflows', { name: 'HTTP Workflow', description: 'd', steps: [stepInput()] }, WF_HEADERS_A);
  assert.equal(created.status, 201);
  const workflowId = (created.data as { workflowId: string }).workflowId;

  const listA = await handleApiRequest('GET', '/api/v1/workflows', null, WF_HEADERS_A);
  assert.ok((listA.data as { workflows: Array<{ workflowId: string }> }).workflows.some((w) => w.workflowId === workflowId));

  const listB = await handleApiRequest('GET', '/api/v1/workflows', null, WF_HEADERS_B);
  assert.ok(!(listB.data as { workflows: Array<{ workflowId: string }> }).workflows.some((w) => w.workflowId === workflowId));

  const getB = await handleApiRequest('GET', `/api/v1/workflows/${workflowId}`, null, WF_HEADERS_B);
  assert.equal(getB.status, 404);
  assert.equal((getB.data as { error: { code: string } }).error.code, 'WORKFLOW_NOT_FOUND');

  const patchB = await handleApiRequest('PATCH', `/api/v1/workflows/${workflowId}`, { name: 'Hijacked' }, WF_HEADERS_B);
  assert.equal(patchB.status, 404);

  const patchA = await handleApiRequest('PATCH', `/api/v1/workflows/${workflowId}`, { name: 'Renamed' }, WF_HEADERS_A);
  assert.equal(patchA.status, 200);
  assert.equal((patchA.data as { name: string }).name, 'Renamed');

  const deleteB = await handleApiRequest('DELETE', `/api/v1/workflows/${workflowId}`, null, WF_HEADERS_B);
  assert.equal(deleteB.status, 404);

  const deleteA = await handleApiRequest('DELETE', `/api/v1/workflows/${workflowId}`, null, WF_HEADERS_A);
  assert.equal(deleteA.status, 200);
});

test('HTTP: wrong-tenant /run cannot instantiate another tenant\'s workflow', async () => {
  const created = await handleApiRequest('POST', '/api/v1/workflows', { name: 'Run me', description: 'd', steps: [stepInput()] }, WF_HEADERS_A);
  const workflowId = (created.data as { workflowId: string }).workflowId;

  const runB = await handleAsyncApiRequest('POST', `/api/v1/workflows/${workflowId}/run`, {}, WF_HEADERS_B);
  assert.equal(runB.status, 404);
  assert.equal((runB.data as { error: { code: string } }).error.code, 'WORKFLOW_NOT_FOUND');
});

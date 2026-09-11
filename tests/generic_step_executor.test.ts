// P01 — Generic Step Executor.
//
// Verifies ExecutingTaskRunner's first milestone: session-free, single-call
// read-only capabilities (gmail.search / gmail.read_thread) execute through
// CapabilityExecutorPort exactly, never bypass it, never self-approve, and
// halt truthfully on BLOCKED/APPROVAL_REQUIRED. Also verifies
// CompositeTaskRunner only routes a READ_ONLY_AUTO task here — every
// ALWAYS_APPROVE task keeps going to PlanPreviewTaskRunner unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExecutingTaskRunner } from '../src/tasks/runners/executing-task.runner.js';
import { CompositeTaskRunner } from '../src/tasks/runners/composite.runner.js';
import { TaskContinuationStore } from '../src/tasks/task-continuation.store.js';
import { DurableTaskRunStateStore } from '../src/tasks/durable-task-run-state.store.js';
import { PlanResolver } from '../src/planning/plan-resolver.js';
import { skillRegistry } from '../src/skills/skill-registry.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import { AiService, type PlanPreview } from '../src/model-gateway/ai-service.js';
import { UnifiedModelRouter } from '../src/model-gateway/unified-model-router.js';
import { createProviders } from '../src/model-gateway/providers.js';
import { NagexError } from '../src/common/errors.js';
import type { CapabilityExecutorPort } from '../src/contracts/capability.port.js';
import type { CapabilityRequest, CapabilityBrokerResult } from '../src/capabilities/capability.types.js';
import type { TaskRecord } from '../src/tasks/task.store.js';
import type { TaskRunner, TaskRunOutcome } from '../src/tasks/task.scheduler.js';

// Each test gets its own isolated, temp-dir-backed continuation store —
// matching this repo's established per-test FileRecordStore isolation
// pattern — so approvalId-keyed continuation records from one test can
// never leak into another.
function newContinuationStore(): TaskContinuationStore {
  return new TaskContinuationStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-test-continuations-')) });
}

function newDurableRunStateStore(): DurableTaskRunStateStore {
  return new DurableTaskRunStateStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-test-durable-runs-')) });
}

// A ToolRegistry whose gmail.search/gmail.read_thread are LIVE/connected
// (the real production registry reports them UNAVAILABLE without real
// OAuth, which would make every test here resolve BLOCKED regardless of
// what's under test) plus one write-shaped tool to exercise the
// APPROVAL_REQUIRED halt path.
const liveToolRegistry = new ToolRegistry([
  { id: 'gmail.search', name: 'Gmail Search', capability: 'email.search', connectionStatus: 'connected', sideEffectLevel: 'READ_ONLY', requiresApproval: false, executionMode: 'live', aliases: [] },
  { id: 'gmail.read_thread', name: 'Gmail Read Thread', capability: 'email.thread.read', connectionStatus: 'connected', sideEffectLevel: 'READ_ONLY', requiresApproval: false, executionMode: 'live', aliases: [] },
  { id: 'gmail.send_email', name: 'Gmail Send', capability: 'email.send', connectionStatus: 'connected', sideEffectLevel: 'IRREVERSIBLE_WRITE', requiresApproval: true, executionMode: 'live', aliases: [] },
  // Registered and live-resolvable, but deliberately NOT in
  // ExecutingTaskRunner's EXECUTABLE_CAPABILITY_IDS allowlist — exercises
  // the "resolved fine, but not yet supported for auto-execution" path,
  // distinct from an unresolved/BLOCKED tool.
  { id: 'gmail.list_labels', name: 'Gmail List Labels', capability: 'email.labels.list', connectionStatus: 'connected', sideEffectLevel: 'READ_ONLY', requiresApproval: false, executionMode: 'live', aliases: [] },
  // H01 — now the same id in both ToolRegistry and CapabilityRegistry (the
  // real production registry still reports UNAVAILABLE without live OAuth).
  { id: 'google_calendar.free_slots', name: 'Google Calendar Availability', capability: 'calendar.freebusy.query', connectionStatus: 'connected', sideEffectLevel: 'READ_ONLY', requiresApproval: false, executionMode: 'live', aliases: [] },
]);
const resolver = new PlanResolver(skillRegistry, liveToolRegistry);

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function aiServiceReturning(rawPlan: unknown): AiService {
  const providers = createProviders(
    { OPENAI_API_KEY: 'test-key', NAGEX_OPENAI_MODEL: 'test-step-executor-model' },
    async () => jsonResponse({ output_text: JSON.stringify(rawPlan) }),
  );
  return new AiService(new UnifiedModelRouter(providers, { info: () => {}, warn: () => {} }));
}

function rawStep(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    title: 'Search inbox', reasoning: 'Directly satisfies the request.', skill: 'skill.email_drafting',
    tool: 'gmail.search', requiresApproval: false, necessity: 'REQUIRED', dependsOn: [], parameters: { query: 'invoice' },
    ...overrides,
  };
}

function rawPlan(steps: Array<Record<string, unknown>>): PlanPreview {
  return { goal: 'Search email', summary: 'Look something up.', reasoningSummary: 'Read-only lookup.', suggestions: [], steps } as unknown as PlanPreview;
}

function baseTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    tenantId: 't_step_exec', ownerId: 'u_step_exec', name: 'Executor test task',
    type: 'ONE_TIME', status: 'ACTIVE', objective: 'Search my inbox for invoices',
    trigger: { type: 'MANUAL' }, approvalPolicy: 'READ_ONLY_AUTO', sourceSessionId: null,
    nextRunAt: null, lastRunAt: null, lastRunStatus: null, progress: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...overrides,
  } as TaskRecord;
}

// A fully-controllable CapabilityExecutorPort — records every call and lets
// each test script exactly what the broker returns (or throws) per call.
function fakeBroker(script: (request: CapabilityRequest) => CapabilityBrokerResult | Promise<CapabilityBrokerResult>): { broker: CapabilityExecutorPort; calls: CapabilityRequest[] } {
  const calls: CapabilityRequest[] = [];
  return {
    calls,
    broker: {
      execute: async (request: CapabilityRequest) => {
        calls.push(request);
        return script(request);
      },
    },
  };
}

test('H01: the Calendar free-slots path — previously excluded by the ToolRegistry/CapabilityRegistry id mismatch — now executes through CapabilityExecutorPort with no Task-specific translation', async () => {
  const { broker, calls } = fakeBroker(() => ({ status: 'EXECUTED', capabilityId: 'google_calendar.free_slots', result: { slots: [{ start: '2026-10-01T09:00:00Z', end: '2026-10-01T10:00:00Z' }] } }));
  const aiService = aiServiceReturning(rawPlan([rawStep({ title: 'Check availability', skill: 'skill.scheduling', tool: 'google_calendar.free_slots', parameters: { timeMin: '2026-10-01T00:00:00Z', timeMax: '2026-10-01T23:59:59Z' } })]));
  const runner = new ExecutingTaskRunner(aiService, resolver, broker, () => [], newContinuationStore(), newDurableRunStateStore());
  const outcome = await runner.run(baseTask(), 'req_h01', 'req_h01_run');
  assert.equal(outcome.status, 'SUCCEEDED');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].capabilityId, 'google_calendar.free_slots', 'resolvedToolId must reach the broker unchanged — no translation table in Task code');
  assert.deepEqual(calls[0].payload, { timeMin: '2026-10-01T00:00:00Z', timeMax: '2026-10-01T23:59:59Z' });
});

test('1. one read-only capability executes successfully', async () => {
  const { broker, calls } = fakeBroker(() => ({ status: 'EXECUTED', capabilityId: 'gmail.search', result: { threads: [{ threadId: 't1', snippet: 'Invoice #1' }] } }));
  const aiService = aiServiceReturning(rawPlan([rawStep({})]));
  const runner = new ExecutingTaskRunner(aiService, resolver, broker, () => [], newContinuationStore(), newDurableRunStateStore());
  const outcome = await runner.run(baseTask(), 'req_1', 'req_1_run');
  assert.equal(outcome.status, 'SUCCEEDED');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].capabilityId, 'gmail.search');
});

test('2. multiple independent read-only steps execute in order', async () => {
  const { broker, calls } = fakeBroker((req) => ({ status: 'EXECUTED', capabilityId: req.capabilityId, result: { ok: req.capabilityId } }));
  const aiService = aiServiceReturning(rawPlan([
    rawStep({ tool: 'gmail.search', parameters: { query: 'invoice' } }),
    rawStep({ title: 'Read the thread', tool: 'gmail.read_thread', parameters: { threadId: 't1' }, dependsOn: [1] }),
  ]));
  const runner = new ExecutingTaskRunner(aiService, resolver, broker, () => [], newContinuationStore(), newDurableRunStateStore());
  const outcome = await runner.run(baseTask(), 'req_2', 'req_2_run');
  assert.equal(outcome.status, 'SUCCEEDED');
  assert.deepEqual(calls.map((c) => c.capabilityId), ['gmail.search', 'gmail.read_thread'], 'steps must execute in resolved order');
});

test('3. step result is captured truthfully in TaskRunOutcome', async () => {
  const { broker } = fakeBroker(() => ({ status: 'EXECUTED', capabilityId: 'gmail.search', result: { threads: [{ threadId: 'abc', snippet: 'real snippet' }] } }));
  const aiService = aiServiceReturning(rawPlan([rawStep({})]));
  const runner = new ExecutingTaskRunner(aiService, resolver, broker, () => [], newContinuationStore(), newDurableRunStateStore());
  const outcome = await runner.run(baseTask(), 'req_3', 'req_3_run');
  const result = outcome.result as { kind: string; steps: Array<{ step: number; capabilityId: string; result: unknown }> };
  assert.equal(result.kind, 'STEP_EXECUTION');
  assert.equal(result.steps.length, 1);
  assert.deepEqual(result.steps[0].result, { threads: [{ threadId: 'abc', snippet: 'real snippet' }] }, 'the real broker result must be preserved verbatim, never fabricated');
});

test('4a. a BLOCKED step (PlanResolver-level, unresolved tool) halts before any broker call', async () => {
  const { broker, calls } = fakeBroker(() => { throw new Error('must never be called'); });
  const aiService = aiServiceReturning(rawPlan([rawStep({ tool: 'totally.unknown.tool' })]));
  const runner = new ExecutingTaskRunner(aiService, resolver, broker, () => [], newContinuationStore(), newDurableRunStateStore());
  const outcome = await runner.run(baseTask(), 'req_4a', 'req_4a_run');
  assert.equal(outcome.status, 'FAILED');
  assert.equal(outcome.errorCode, 'STEP_BLOCKED');
  assert.equal(calls.length, 0, 'a BLOCKED step must never reach the broker');
});

test('4b. a BLOCKED step (broker-level) halts before later steps execute', async () => {
  const { broker, calls } = fakeBroker((req) => req.capabilityId === 'gmail.search' ? { status: 'BLOCKED', capabilityId: req.capabilityId, reasonCode: 'CAPABILITY_POLICY_FAILED' } : { status: 'EXECUTED', capabilityId: req.capabilityId, result: {} });
  const aiService = aiServiceReturning(rawPlan([
    rawStep({ tool: 'gmail.search', parameters: { query: 'x' } }),
    rawStep({ title: 'Second step', tool: 'gmail.read_thread', parameters: { threadId: 't1' }, dependsOn: [1] }),
  ]));
  const runner = new ExecutingTaskRunner(aiService, resolver, broker, () => [], newContinuationStore(), newDurableRunStateStore());
  const outcome = await runner.run(baseTask(), 'req_4b', 'req_4b_run');
  assert.equal(outcome.status, 'FAILED');
  assert.equal(outcome.errorCode, 'CAPABILITY_POLICY_FAILED');
  assert.equal(calls.length, 1, 'the second step must never be dispatched once the first is BLOCKED');
});

test('5. APPROVAL_REQUIRED pauses (WAITING_APPROVAL) without ever auto-approving — P02: a real approval is created via the Broker, but only the REQUEST path is ever called, never an execute-with-approvalId call', async () => {
  const { broker, calls } = fakeBroker((req) => {
    assert.equal(req.approvalId, undefined, 'the runner must never supply an approvalId itself — that would be self-approval');
    return { status: 'APPROVAL_REQUIRED', capabilityId: req.capabilityId, approval: { approvalId: 'apr_test_5' } };
  });
  const aiService = aiServiceReturning(rawPlan([rawStep({ title: 'Send an email', tool: 'gmail.send_email', requiresApproval: true, parameters: { to: ['x@example.com'] } })]));
  const runner = new ExecutingTaskRunner(aiService, resolver, broker, () => [], newContinuationStore(), newDurableRunStateStore());
  const outcome = await runner.run(baseTask(), 'req_5', 'req_5_run');
  assert.equal(outcome.status, 'WAITING_APPROVAL');
  assert.equal(calls.length, 1, 'the broker must be called exactly once, to create the real approval — never to execute it');
});

test('6. a capability error preserves the real error code', async () => {
  const { broker } = fakeBroker(() => { throw new NagexError({ code: 'GMAIL_DISCONNECTED', category: 'POLICY', message: 'Gmail is not connected.', request_id: 'req_6' }); });
  const aiService = aiServiceReturning(rawPlan([rawStep({})]));
  const runner = new ExecutingTaskRunner(aiService, resolver, broker, () => [], newContinuationStore(), newDurableRunStateStore());
  const outcome = await runner.run(baseTask(), 'req_6', 'req_6_run');
  assert.equal(outcome.status, 'FAILED');
  assert.equal(outcome.errorCode, 'GMAIL_DISCONNECTED', 'the real capability error code must never be collapsed into a generic one');
});

test('7-8. tenant/principal are propagated correctly and source remains TASK', async () => {
  const { broker, calls } = fakeBroker(() => ({ status: 'EXECUTED', capabilityId: 'gmail.search', result: {} }));
  const aiService = aiServiceReturning(rawPlan([rawStep({})]));
  const runner = new ExecutingTaskRunner(aiService, resolver, broker, () => [], newContinuationStore(), newDurableRunStateStore());
  const task = baseTask({ tenantId: 't_specific', ownerId: 'u_specific' });
  await runner.run(task, 'req_7', 'req_7_run');
  assert.equal(calls[0].tenantId, 't_specific');
  assert.equal(calls[0].principalId, 'u_specific');
  assert.equal(calls[0].source, 'TASK');
});

test('9. per-step request IDs are unique and deterministically derived from the run requestId', async () => {
  const { broker, calls } = fakeBroker((req) => ({ status: 'EXECUTED', capabilityId: req.capabilityId, result: {} }));
  const aiService = aiServiceReturning(rawPlan([
    rawStep({ tool: 'gmail.search', parameters: { query: 'x' } }),
    rawStep({ title: 'Second', tool: 'gmail.read_thread', parameters: { threadId: 't1' }, dependsOn: [1] }),
  ]));
  const runner = new ExecutingTaskRunner(aiService, resolver, broker, () => [], newContinuationStore(), newDurableRunStateStore());
  await runner.run(baseTask(), 'req_9_fixed', 'req_9_fixed_run');
  assert.equal(calls[0].requestId, 'req_9_fixed_step1');
  assert.equal(calls[1].requestId, 'req_9_fixed_step2');
  assert.notEqual(calls[0].requestId, calls[1].requestId);
});

test('a capability not in the executable allowlist halts truthfully rather than being silently skipped or executed', async () => {
  const { broker, calls } = fakeBroker(() => { throw new Error('must never be called'); });
  const aiService = aiServiceReturning(rawPlan([rawStep({ title: 'List labels', tool: 'gmail.list_labels', parameters: {} })]));
  const runner = new ExecutingTaskRunner(aiService, resolver, broker, () => [], newContinuationStore(), newDurableRunStateStore());
  const outcome = await runner.run(baseTask(), 'req_allowlist', 'req_allowlist_run');
  assert.equal(outcome.status, 'FAILED');
  assert.equal(outcome.errorCode, 'STEP_CAPABILITY_NOT_EXECUTABLE');
  assert.equal(calls.length, 0);
});

// ─── Composite routing: only a READ_ONLY_AUTO task reaches ExecutingTaskRunner ───

test('CompositeTaskRunner routes a READ_ONLY_AUTO task to ExecutingTaskRunner', async () => {
  let executingCalled = false;
  const executing: TaskRunner = { run: async (): Promise<TaskRunOutcome> => { executingCalled = true; return { status: 'SUCCEEDED' }; } };
  const other: TaskRunner = { run: async (): Promise<TaskRunOutcome> => { throw new Error('must not be called'); } };
  const composite = new CompositeTaskRunner(other, other, undefined, executing);
  await composite.run(baseTask({ type: 'ONE_TIME', approvalPolicy: 'READ_ONLY_AUTO' }), 'req_route_1', 'run_route_1');
  assert.equal(executingCalled, true);
});

test('CompositeTaskRunner still routes an ALWAYS_APPROVE task to PlanPreviewTaskRunner, never ExecutingTaskRunner', async () => {
  let planPreviewCalled = false;
  const planPreview: TaskRunner = { run: async (): Promise<TaskRunOutcome> => { planPreviewCalled = true; return { status: 'SUCCEEDED' }; } };
  const executing: TaskRunner = { run: async (): Promise<TaskRunOutcome> => { throw new Error('must not be called for an ALWAYS_APPROVE task'); } };
  const other: TaskRunner = { run: async (): Promise<TaskRunOutcome> => { throw new Error('must not be called'); } };
  const composite = new CompositeTaskRunner(planPreview, other, undefined, executing);
  await composite.run(baseTask({ type: 'ONE_TIME', approvalPolicy: 'ALWAYS_APPROVE' }), 'req_route_2', 'run_route_2');
  assert.equal(planPreviewCalled, true, 'an ALWAYS_APPROVE task must keep going to PlanPreviewTaskRunner, exactly as before P01');
});

test('CompositeTaskRunner still works with no ExecutingTaskRunner injected (backward-compatible optional param)', async () => {
  let planPreviewCalled = false;
  const planPreview: TaskRunner = { run: async (): Promise<TaskRunOutcome> => { planPreviewCalled = true; return { status: 'SUCCEEDED' }; } };
  const other: TaskRunner = { run: async (): Promise<TaskRunOutcome> => { throw new Error('must not be called'); } };
  const composite = new CompositeTaskRunner(planPreview, other);
  await composite.run(baseTask({ type: 'ONE_TIME', approvalPolicy: 'READ_ONLY_AUTO' }), 'req_route_3', 'run_route_3');
  assert.equal(planPreviewCalled, true, 'without an injected ExecutingTaskRunner, a READ_ONLY_AUTO task must fall back to PlanPreviewTaskRunner rather than crashing');
});

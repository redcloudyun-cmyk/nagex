// V01a / V01a-R1 — Test-Only Deterministic Plan Injection.
//
// Verifies: (1) ExecutingTaskRunner.runWithResolvedPlan() is a pure,
// behavior-preserving extraction from run()'s tail — same outcome given the
// same resolved plan; (2) the new POST /api/v1/tasks/:id/run-with-fixed-plan
// route does not exist (falls through to the ordinary 404) unless BOTH
// NAGEX_ENABLE_TEST_PLAN_INJECTION is exactly '1' AND the request's
// X-NAgex-Test-Token exactly matches NAGEX_TEST_PLAN_INJECTION_TOKEN
// (V01a-R1 hardening — the flag alone left the route callable by any
// network client that could reach the server while it was enabled), each
// gate re-checked per request, never distinguished in the response, token
// never echoed; (3) when both gates pass, it drives a real Task run
// through the real step-execution/durable-state/approval-continuation
// path for a fixed, deterministic plan, exactly like V01's LIVE harness
// needs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleApiRequest, handleAsyncApiRequest } from '../src/server_web.js';
import { ExecutingTaskRunner } from '../src/tasks/runners/executing-task.runner.js';
import { TaskContinuationStore } from '../src/tasks/task-continuation.store.js';
import { DurableTaskRunStateStore } from '../src/tasks/durable-task-run-state.store.js';
import { PlanResolver } from '../src/planning/plan-resolver.js';
import { skillRegistry } from '../src/skills/skill-registry.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import { AiService, type PlanPreview } from '../src/model-gateway/ai-service.js';
import { UnifiedModelRouter } from '../src/model-gateway/unified-model-router.js';
import { createProviders } from '../src/model-gateway/providers.js';
import type { CapabilityExecutorPort } from '../src/contracts/capability.port.js';
import type { CapabilityRequest, CapabilityBrokerResult } from '../src/capabilities/capability.types.js';
import type { TaskRecord } from '../src/tasks/task.store.js';

const HEADERS = { 'x-nagex-tenant': 'ten_production_01', 'x-principal-id': 'usr_fixedplan_test' };

function tempStore(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `nagex-v01a-${prefix}-`));
}

const liveToolRegistry = new ToolRegistry([
  { id: 'gmail.search', name: 'Gmail Search', capability: 'email.search', connectionStatus: 'connected', sideEffectLevel: 'READ_ONLY', requiresApproval: false, executionMode: 'live', aliases: [] },
  { id: 'gmail.send_email', name: 'Gmail Send', capability: 'email.send', connectionStatus: 'connected', sideEffectLevel: 'IRREVERSIBLE_WRITE', requiresApproval: true, executionMode: 'live', aliases: [] },
]);
const resolver = new PlanResolver(skillRegistry, liveToolRegistry);

function rawStep(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    title: 'Search inbox', reasoning: 'Directly satisfies the request.', skill: 'skill.email_drafting',
    tool: 'gmail.search', requiresApproval: false, necessity: 'REQUIRED', dependsOn: [], parameters: { query: 'invoice' },
    ...overrides,
  };
}

function rawPlan(steps: Array<Record<string, unknown>>): PlanPreview {
  return { goal: 'x', summary: 'x', reasoningSummary: 'x', suggestions: [], steps } as unknown as PlanPreview;
}

function baseTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    tenantId: 't_v01a', ownerId: 'u_v01a', name: 'V01a test task',
    type: 'ONE_TIME', status: 'ACTIVE', objective: 'Search my inbox',
    trigger: { type: 'MANUAL' }, approvalPolicy: 'READ_ONLY_AUTO', sourceSessionId: null,
    nextRunAt: null, lastRunAt: null, lastRunStatus: null, progress: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...overrides,
  } as TaskRecord;
}

function fakeBroker(script: (request: CapabilityRequest) => CapabilityBrokerResult | Promise<CapabilityBrokerResult>): CapabilityExecutorPort {
  return { execute: async (request: CapabilityRequest) => script(request) };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function aiServiceReturning(rawSteps: Array<Record<string, unknown>>): AiService {
  const providers = createProviders(
    { OPENAI_API_KEY: 'test-key', NAGEX_OPENAI_MODEL: 'test-v01a-model' },
    async () => jsonResponse({ output_text: JSON.stringify(rawPlan(rawSteps)) }),
  );
  return new AiService(new UnifiedModelRouter(providers, { info: () => {}, warn: () => {} }));
}

// ── 1. runWithResolvedPlan() extraction is behavior-preserving ───────────

test('1. runWithResolvedPlan() given the same resolved plan produces the same outcome as run()', async () => {
  const steps = [rawStep({})];
  const broker = fakeBroker(() => ({ status: 'EXECUTED', capabilityId: 'gmail.search', result: { threads: [] } }));

  const runnerA = new ExecutingTaskRunner(aiServiceReturning(steps), resolver, broker, () => [], new TaskContinuationStore({ dir: tempStore('cont-a') }), new DurableTaskRunStateStore({ dir: tempStore('durable-a') }));
  const outcomeA = await runnerA.run(baseTask(), 'req_a', 'run_a');

  const resolved = resolver.resolve(rawPlan(steps));
  const runnerB = new ExecutingTaskRunner(aiServiceReturning(steps), resolver, broker, () => [], new TaskContinuationStore({ dir: tempStore('cont-b') }), new DurableTaskRunStateStore({ dir: tempStore('durable-b') }));
  const outcomeB = await runnerB.runWithResolvedPlan(baseTask(), 'req_b', 'run_b', resolved);

  assert.equal(outcomeA.status, 'SUCCEEDED');
  assert.equal(outcomeB.status, outcomeA.status);
  const resultA = outcomeA.result as { steps: Array<{ capabilityId: string; result: unknown }> };
  const resultB = outcomeB.result as { steps: Array<{ capabilityId: string; result: unknown }> };
  assert.deepEqual(resultB.steps.map((s) => ({ capabilityId: s.capabilityId, result: s.result })), resultA.steps.map((s) => ({ capabilityId: s.capabilityId, result: s.result })));
});

// ── 2-9. V01a-R1: the route requires BOTH the flag and a matching token ──

async function createRealTask(): Promise<string> {
  const res = await handleApiRequest('POST', '/api/v1/tasks', {
    name: 'V01a HTTP test', objective: 'placeholder — plan is injected, never used', type: 'ONE_TIME',
    trigger: { type: 'MANUAL' }, approvalPolicy: 'READ_ONLY_AUTO',
  }, HEADERS);
  assert.equal(res.status, 201);
  return (res.data as { taskId: string }).taskId;
}

const TEST_TOKEN = 'nagex-v01a-r1-test-token-9f3c7a1e2b4d6f80';
const TOKEN_HEADER = 'x-nagex-test-token';

function clearGate() {
  delete process.env.NAGEX_ENABLE_TEST_PLAN_INJECTION;
  delete process.env.NAGEX_TEST_PLAN_INJECTION_TOKEN;
}

test('2. (V01a-R1 #1) the route 404s (indistinguishable from a nonexistent route) when the flag is unset, even with a correct token header sent', async () => {
  clearGate();
  process.env.NAGEX_TEST_PLAN_INJECTION_TOKEN = TEST_TOKEN;
  try {
    const taskId = await createRealTask();
    const withoutFlag = await handleAsyncApiRequest('POST', `/api/v1/tasks/${taskId}/run-with-fixed-plan`, { steps: [rawStep({})] }, { ...HEADERS, [TOKEN_HEADER]: TEST_TOKEN });
    const nonexistentRoute = await handleAsyncApiRequest('POST', `/api/v1/tasks/${taskId}/this-route-truly-does-not-exist`, {}, HEADERS);
    assert.equal(withoutFlag.status, 404);
    assert.equal(withoutFlag.status, nonexistentRoute.status, 'must produce the exact same status as a genuinely nonexistent route');
  } finally {
    clearGate();
  }
});

test('3. (V01a-R1 #2-4) the route 404s when the flag is empty, "0", or "true" (not exactly "1"), even with a correct token', async () => {
  process.env.NAGEX_TEST_PLAN_INJECTION_TOKEN = TEST_TOKEN;
  try {
    const taskId = await createRealTask();
    for (const value of ['', '0', 'true', 'TRUE', '1 ']) {
      process.env.NAGEX_ENABLE_TEST_PLAN_INJECTION = value;
      const res = await handleAsyncApiRequest('POST', `/api/v1/tasks/${taskId}/run-with-fixed-plan`, { steps: [rawStep({})] }, { ...HEADERS, [TOKEN_HEADER]: TEST_TOKEN });
      assert.equal(res.status, 404, `flag value ${JSON.stringify(value)} must not enable the route`);
    }
  } finally {
    clearGate();
  }
});

test('4. (V01a-R1 #5) flag "1" + no NAGEX_TEST_PLAN_INJECTION_TOKEN configured at all -> 404', async () => {
  process.env.NAGEX_ENABLE_TEST_PLAN_INJECTION = '1';
  delete process.env.NAGEX_TEST_PLAN_INJECTION_TOKEN;
  try {
    const taskId = await createRealTask();
    const res = await handleAsyncApiRequest('POST', `/api/v1/tasks/${taskId}/run-with-fixed-plan`, { steps: [rawStep({})] }, { ...HEADERS, [TOKEN_HEADER]: TEST_TOKEN });
    assert.equal(res.status, 404, 'an unset server-side token must never accidentally allow the route through');
  } finally {
    clearGate();
  }
});

test('5. (V01a-R1 #6) flag "1" + NAGEX_TEST_PLAN_INJECTION_TOKEN set to an empty string -> 404', async () => {
  process.env.NAGEX_ENABLE_TEST_PLAN_INJECTION = '1';
  process.env.NAGEX_TEST_PLAN_INJECTION_TOKEN = '';
  try {
    const taskId = await createRealTask();
    const res = await handleAsyncApiRequest('POST', `/api/v1/tasks/${taskId}/run-with-fixed-plan`, { steps: [rawStep({})] }, { ...HEADERS, [TOKEN_HEADER]: '' });
    assert.equal(res.status, 404, 'an empty server-side token must always be invalid, never treated as "no token required"');
  } finally {
    clearGate();
  }
});

test('6. (V01a-R1 #7) flag "1" + real token configured + request header missing -> 404', async () => {
  process.env.NAGEX_ENABLE_TEST_PLAN_INJECTION = '1';
  process.env.NAGEX_TEST_PLAN_INJECTION_TOKEN = TEST_TOKEN;
  try {
    const taskId = await createRealTask();
    const res = await handleAsyncApiRequest('POST', `/api/v1/tasks/${taskId}/run-with-fixed-plan`, { steps: [rawStep({})] }, HEADERS);
    assert.equal(res.status, 404);
  } finally {
    clearGate();
  }
});

test('7. (V01a-R1 #8) flag "1" + real token configured + wrong request token -> 404', async () => {
  process.env.NAGEX_ENABLE_TEST_PLAN_INJECTION = '1';
  process.env.NAGEX_TEST_PLAN_INJECTION_TOKEN = TEST_TOKEN;
  try {
    const taskId = await createRealTask();
    const res = await handleAsyncApiRequest('POST', `/api/v1/tasks/${taskId}/run-with-fixed-plan`, { steps: [rawStep({})] }, { ...HEADERS, [TOKEN_HEADER]: 'wrong-token-entirely' });
    assert.equal(res.status, 404);
    // A different-length wrong token exercises the length-mismatch guard
    // (checked before timingSafeEqual, which would otherwise throw).
    const shortWrong = await handleAsyncApiRequest('POST', `/api/v1/tasks/${taskId}/run-with-fixed-plan`, { steps: [rawStep({})] }, { ...HEADERS, [TOKEN_HEADER]: 'short' });
    assert.equal(shortWrong.status, 404);
  } finally {
    clearGate();
  }
});

// ── 8. When both gates pass, the route genuinely reaches the real ────────
// production pipeline (PlanResolver -> ExecutingTaskRunner -> real
// CapabilityBroker), not a stub. This local/CI environment has no live
// Google OAuth configured (confirmed: the real ToolRegistry reports
// gmail.search UNAVAILABLE here, exactly like every other test file in
// this suite that exercises live Gmail/Calendar through the real app
// graph), so the real, honest, deterministic-for-this-environment outcome
// is STEP_BLOCKED at resolution — not a fabricated success. The full pause
// -> approve -> resume lifecycle this route unlocks is proven separately:
// in-process with a controlled fake broker (test 10 below, exactly like
// task_approval_continuation.test.ts's own pattern), and for real on the
// live target host by V01's own LIVE harness (which does have live OAuth).
test('8. (V01a-R1 #9) flag "1" + correct token -> the route executes, reaching the real pipeline and producing a truthful, persisted TaskRun', async () => {
  process.env.NAGEX_ENABLE_TEST_PLAN_INJECTION = '1';
  process.env.NAGEX_TEST_PLAN_INJECTION_TOKEN = TEST_TOKEN;
  try {
    const taskId = await createRealTask();
    const steps = [rawStep({ step: 1, title: 'Search first', tool: 'gmail.search', dependsOn: [], parameters: { query: 'invoice' } })];

    const runRes = await handleAsyncApiRequest('POST', `/api/v1/tasks/${taskId}/run-with-fixed-plan`, { steps }, { ...HEADERS, [TOKEN_HEADER]: TEST_TOKEN });
    assert.equal(runRes.status, 200);
    const run = runRes.data as { runId: string; taskId: string; status: string; errorCode: string | null };
    assert.equal(run.taskId, taskId);
    assert.equal(run.status, 'FAILED');
    assert.equal(run.errorCode, 'STEP_BLOCKED', 'must be a real PlanResolver-level classification, not a crash or a silently fabricated result');

    const runsRes = await handleApiRequest('GET', `/api/v1/tasks/${taskId}/runs`, null, HEADERS);
    const { runs } = runsRes.data as { runs: Array<{ runId: string; status: string }> };
    assert.ok(runs.find((r) => r.runId === run.runId), 'the run created via the fixed-plan route must be a genuine, persisted TaskRunRecord');
  } finally {
    clearGate();
  }
});

test('9. (V01a-R1 #10) the token is never echoed back in any response, success or failure', async () => {
  process.env.NAGEX_ENABLE_TEST_PLAN_INJECTION = '1';
  process.env.NAGEX_TEST_PLAN_INJECTION_TOKEN = TEST_TOKEN;
  try {
    const taskId = await createRealTask();
    const wrongTokenRes = await handleAsyncApiRequest('POST', `/api/v1/tasks/${taskId}/run-with-fixed-plan`, { steps: [rawStep({})] }, { ...HEADERS, [TOKEN_HEADER]: 'wrong-token' });
    assert.doesNotMatch(JSON.stringify(wrongTokenRes), new RegExp(TEST_TOKEN));

    const correctTokenRes = await handleAsyncApiRequest('POST', `/api/v1/tasks/${taskId}/run-with-fixed-plan`, { steps: [rawStep({})] }, { ...HEADERS, [TOKEN_HEADER]: TEST_TOKEN });
    assert.doesNotMatch(JSON.stringify(correctTokenRes), new RegExp(TEST_TOKEN));
  } finally {
    clearGate();
  }
});

test('11. (V01a-R1 #12) normal Task APIs are unaffected by the gate changes', async () => {
  const created = await handleApiRequest('POST', '/api/v1/tasks', {
    name: 'V01a-R1 normal API check', objective: 'Search my inbox for invoices', type: 'ONE_TIME',
    trigger: { type: 'MANUAL' }, approvalPolicy: 'ALWAYS_APPROVE',
  }, HEADERS);
  assert.equal(created.status, 201);
  const taskId = (created.data as { taskId: string }).taskId;
  const fetched = await handleApiRequest('GET', `/api/v1/tasks/${taskId}`, null, HEADERS);
  assert.equal(fetched.status, 200);
  const runsRes = await handleApiRequest('GET', `/api/v1/tasks/${taskId}/runs`, null, HEADERS);
  assert.equal(runsRes.status, 200);
});

// ── 10. runWithResolvedPlan() supports the full pause -> approve -> resume ─
// lifecycle exactly like run() does (in-process, controlled fake broker —
// mirrors task_approval_continuation.test.ts's own pattern, entering
// through this new entry point specifically). Unaffected by the HTTP-level
// token gate above — this is V01a's original in-process lifecycle
// coverage, re-verified still green after the V01a-R1 correction.
test('10. (V01a-R1 #11) via runWithResolvedPlan(): step 1 executes, step 2 pauses at a real approval, step 3 does not run until approved — then the whole run completes', async () => {
  const continuations = new TaskContinuationStore({ dir: tempStore('cont-6') });
  const durableRunState = new DurableTaskRunStateStore({ dir: tempStore('durable-6') });
  const calls: string[] = [];
  const broker = fakeBroker((req) => {
    if (req.capabilityId === 'gmail.search') return { status: 'EXECUTED', capabilityId: req.capabilityId, result: { threads: [] } };
    if (req.capabilityId === 'gmail.send_email' && !req.approvalId) { calls.push('request'); return { status: 'APPROVAL_REQUIRED', capabilityId: req.capabilityId, approval: { approvalId: 'apr_v01a_test' } }; }
    if (req.capabilityId === 'gmail.send_email' && req.approvalId) { calls.push('execute'); return { status: 'EXECUTED', capabilityId: req.capabilityId, result: { messageId: 'msg_v01a' } }; }
    throw new Error(`unexpected capability ${req.capabilityId}`);
  });
  const runner = new ExecutingTaskRunner(aiServiceReturning([rawStep({})]), resolver, broker, () => [], continuations, durableRunState);
  const task = baseTask();

  const steps = [
    rawStep({ step: 1, title: 'Search first', tool: 'gmail.search', dependsOn: [], parameters: { query: 'invoice' } }),
    rawStep({ step: 2, title: 'Send an email', tool: 'gmail.send_email', requiresApproval: true, dependsOn: [1], parameters: { from: 'user@example.com', to: ['alice@example.com'], subject: 'V01a', body: 'x' } }),
    rawStep({ step: 3, title: 'Search again', tool: 'gmail.search', dependsOn: [2], parameters: { query: 'receipt' } }),
  ];
  const resolved = resolver.resolve(rawPlan(steps));
  const outcome = await runner.runWithResolvedPlan(task, 'req_v01a_6', 'run_v01a_6', resolved);
  assert.equal(outcome.status, 'WAITING_APPROVAL');
  const result = outcome.result as { completedSteps: Array<{ step: number }>; waitingAtStep: number; approvalId: string };
  assert.equal(result.completedSteps.length, 1, 'step 1 (read-only) must have already executed');
  assert.equal(result.waitingAtStep, 2);

  const continuation = continuations.listForTask(task.taskId)[0];
  assert.ok(continuation);
  const finalOutcome = await runner.resumeFromApproval(continuation, task);
  assert.equal(finalOutcome.status, 'SUCCEEDED');
  const finalResult = finalOutcome.result as { steps: Array<{ step: number }> };
  assert.equal(finalResult.steps.length, 3, 'all 3 steps (2 read-only + 1 approved write) must appear in the final result');
  assert.deepEqual(calls, ['request', 'execute']);
});

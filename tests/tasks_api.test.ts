import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleApiRequest, handleAsyncApiRequest } from '../src/server_web.js';
import { AiService } from '../src/model-gateway/ai-service.js';
import type { ModelProvider } from '../src/model-gateway/model-provider.js';
import { UnifiedModelRouter } from '../src/model-gateway/unified-model-router.js';

const HEADERS = { 'x-nagex-tenant': 'ten_production_01', 'x-principal-id': 'usr_tasks_test' };

function createTaskBody(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Daily Morning Brief',
    objective: 'Summarize my calendar for today.',
    type: 'RECURRING',
    trigger: { type: 'SCHEDULE', schedule: '0 8 * * *', timezone: 'Asia/Seoul' },
    approvalPolicy: 'READ_ONLY_AUTO',
    ...overrides,
  };
}

// ── GET /api/v1/sessions/main ───────────────────────────────────────────

test('GET /api/v1/sessions/main returns a stable MAIN session for the calling principal', async () => {
  const first = await handleApiRequest('GET', '/api/v1/sessions/main', null, HEADERS);
  const second = await handleApiRequest('GET', '/api/v1/sessions/main', null, HEADERS);
  assert.equal(first.status, 200);
  const firstData = first.data as { sessionId: string; type: string };
  const secondData = second.data as { sessionId: string };
  assert.equal(firstData.type, 'MAIN');
  assert.equal(firstData.sessionId, secondData.sessionId);
});

// ── POST /api/v1/tasks ──────────────────────────────────────────────────

test('POST /api/v1/tasks creates an ACTIVE task with a computed nextRunAt for a SCHEDULE trigger', async () => {
  const res = await handleApiRequest('POST', '/api/v1/tasks', createTaskBody(), HEADERS);
  assert.equal(res.status, 201);
  const data = res.data as Record<string, unknown>;
  assert.equal(data.status, 'ACTIVE');
  assert.equal(data.type, 'RECURRING');
  assert.equal(typeof data.nextRunAt, 'string');
  assert.match(data.taskId as string, /^tsk_/);
});

test('POST /api/v1/tasks rejects an invalid type or trigger.type rather than silently accepting it', async () => {
  const badType = await handleApiRequest('POST', '/api/v1/tasks', createTaskBody({ type: 'NOT_A_TYPE' }), HEADERS);
  assert.notEqual(badType.status, 201);
  const badTrigger = await handleApiRequest('POST', '/api/v1/tasks', createTaskBody({ trigger: { type: 'NOT_A_TRIGGER' } }), HEADERS);
  assert.notEqual(badTrigger.status, 201);
});

test('POST /api/v1/tasks rejects a blank name/objective', async () => {
  const res = await handleApiRequest('POST', '/api/v1/tasks', createTaskBody({ name: '' }), HEADERS);
  assert.notEqual(res.status, 201);
});

// ── GET /api/v1/tasks + GET /api/v1/tasks/:id ───────────────────────────

test('GET /api/v1/tasks lists only the calling principal\'s tasks; GET /api/v1/tasks/:id fetches one', async () => {
  const otherHeaders = { ...HEADERS, 'x-principal-id': 'usr_other_owner' };
  const mine = await handleApiRequest('POST', '/api/v1/tasks', createTaskBody({ name: 'Mine' }), HEADERS);
  await handleApiRequest('POST', '/api/v1/tasks', createTaskBody({ name: 'Theirs' }), otherHeaders);

  const list = await handleApiRequest('GET', '/api/v1/tasks', null, HEADERS);
  assert.equal(list.status, 200);
  const tasks = (list.data as { tasks: Array<{ taskId: string; name: string }> }).tasks;
  assert.ok(tasks.some((t) => t.taskId === (mine.data as { taskId: string }).taskId));
  assert.ok(!tasks.some((t) => t.name === 'Theirs'));

  const fetched = await handleApiRequest('GET', `/api/v1/tasks/${(mine.data as { taskId: string }).taskId}`, null, HEADERS);
  assert.equal(fetched.status, 200);
  assert.equal((fetched.data as { name: string }).name, 'Mine');
});

test('GET /api/v1/tasks/:id 404s for an unknown task', async () => {
  const res = await handleApiRequest('GET', '/api/v1/tasks/tsk_does_not_exist', null, HEADERS);
  assert.equal(res.status, 404);
});

// ── PATCH / pause / resume / delete ─────────────────────────────────────

test('PATCH /api/v1/tasks/:id updates fields and recomputes nextRunAt when the trigger changes', async () => {
  const created = await handleApiRequest('POST', '/api/v1/tasks', createTaskBody(), HEADERS);
  const taskId = (created.data as { taskId: string }).taskId;
  const originalNextRunAt = (created.data as { nextRunAt: string }).nextRunAt;

  const patched = await handleApiRequest('PATCH', `/api/v1/tasks/${taskId}`, { trigger: { type: 'INTERVAL', intervalMinutes: 30 } }, HEADERS);
  assert.equal(patched.status, 200);
  const data = patched.data as { nextRunAt: string; trigger: { type: string } };
  assert.equal(data.trigger.type, 'INTERVAL');
  assert.notEqual(data.nextRunAt, originalNextRunAt);
});

test('pause -> resume via the API round-trips a task back to ACTIVE', async () => {
  const created = await handleApiRequest('POST', '/api/v1/tasks', createTaskBody(), HEADERS);
  const taskId = (created.data as { taskId: string }).taskId;

  const paused = await handleApiRequest('POST', `/api/v1/tasks/${taskId}/pause`, null, HEADERS);
  assert.equal(paused.status, 200);
  assert.equal((paused.data as { status: string }).status, 'PAUSED');

  const resumed = await handleApiRequest('POST', `/api/v1/tasks/${taskId}/resume`, null, HEADERS);
  assert.equal(resumed.status, 200);
  assert.equal((resumed.data as { status: string }).status, 'ACTIVE');
});

test('DELETE /api/v1/tasks/:id removes the task permanently', async () => {
  const created = await handleApiRequest('POST', '/api/v1/tasks', createTaskBody(), HEADERS);
  const taskId = (created.data as { taskId: string }).taskId;

  const deleted = await handleApiRequest('DELETE', `/api/v1/tasks/${taskId}`, null, HEADERS);
  assert.equal(deleted.status, 200);

  const fetched = await handleApiRequest('GET', `/api/v1/tasks/${taskId}`, null, HEADERS);
  assert.equal(fetched.status, 404);
});

// ── GET /api/v1/tasks/:id/runs + POST /api/v1/tasks/:id/run ─────────────

function buildPlanningService(): AiService {
  const provider: ModelProvider = {
    name: 'test',
    model: 'test-model',
    status: () => ({ configured: true, available: true, provider: 'test', model: 'test-model' }),
    generate: async (request) => ({
      text: JSON.stringify({
        goal: 'Summarize today',
        summary: 'Read the calendar and summarize it.',
        reasoningSummary: 'Read-only summary task.',
        suggestions: [],
        steps: [{ title: 'Recall memory', reasoning: 'Ground the summary.', skill: 'Memory Recall', tool: 'memory.search', requiresApproval: false, necessity: 'REQUIRED', dependsOn: [] }],
      }),
      provider: 'test',
      model: 'test-model',
      latencyMs: 1,
      requestId: request.requestId,
    }),
  };
  return new AiService(new UnifiedModelRouter([provider], { info: () => {}, warn: () => {} }));
}

test('POST /api/v1/tasks/:id/run executes the task through the real scheduler/runner exactly once and records a run', async () => {
  const created = await handleApiRequest('POST', '/api/v1/tasks', createTaskBody({ type: 'ONE_TIME', trigger: { type: 'MANUAL' } }), HEADERS);
  const taskId = (created.data as { taskId: string }).taskId;

  const service = buildPlanningService();
  const runRes = await handleAsyncApiRequest('POST', `/api/v1/tasks/${taskId}/run`, {}, HEADERS, service);
  assert.equal(runRes.status, 200);
  const run = runRes.data as { status: string; taskId: string };
  assert.equal(run.status, 'SUCCEEDED');
  assert.equal(run.taskId, taskId);

  const runsList = await handleApiRequest('GET', `/api/v1/tasks/${taskId}/runs`, null, HEADERS);
  assert.equal(runsList.status, 200);
  const runs = (runsList.data as { runs: Array<{ taskId: string }> }).runs;
  assert.equal(runs.length, 1);
  assert.equal(runs[0].taskId, taskId);

  // A ONE_TIME task completes after a successful manual run.
  const fetched = await handleApiRequest('GET', `/api/v1/tasks/${taskId}`, null, HEADERS);
  assert.equal((fetched.data as { status: string }).status, 'COMPLETED');
});

test('POST /api/v1/tasks/:id/run 404s for an unknown task, never silently no-oping', async () => {
  const res = await handleAsyncApiRequest('POST', '/api/v1/tasks/tsk_does_not_exist/run', {}, HEADERS);
  assert.equal(res.status, 404);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TaskStore } from '../src/tasks/task.store.js';
import { TaskRunStore } from '../src/tasks/task-run.store.js';
import { TaskScheduler } from '../src/tasks/task.scheduler.js';
import { BackgroundTaskRunner, CompositeTaskRunner, PlanPreviewTaskRunner, ConditionalWatchTaskRunner } from '../src/tasks/task.runner.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { AiService } from '../src/model-gateway/ai-service.js';
import { PlanResolver } from '../src/planning/plan-resolver.js';
import { skillRegistry } from '../src/skills/skill-registry.js';
import { toolRegistry } from '../src/tools/tool-registry.js';
import { handleAsyncApiRequest } from '../src/server_web.js';

test('Background Tasks (item 09): BackgroundTaskRunner updates step-by-step progress from 0% to 100%', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-bg-test-1-'));
  try {
    const taskStore = new TaskStore({ dir: path.join(tmpDir, 'tasks') });
    const taskRunStore = new TaskRunStore({ dir: path.join(tmpDir, 'runs') });
    const auditLogger = new AuditLogger();

    const mockAiService: AiService = {
      statuses: () => [],
      chat: async () => ({ provider: 'mock', model: 'mock-model', latencyMs: 10, requestId: 'req_1', data: { message: 'MET: false' } }),
      plan: async () => ({
        provider: 'mock',
        model: 'mock-model',
        latencyMs: 10,
        requestId: 'req_1',
        data: { goal: 'Test Goal', summary: 'Test Summary', reasoningSummary: 'Test Reasoning', steps: [] },
      }),
    } as unknown as AiService;

    const planResolver = new PlanResolver(skillRegistry, toolRegistry);
    const bgRunner = new BackgroundTaskRunner(taskStore, mockAiService, planResolver, () => []);
    const compositeRunner = new CompositeTaskRunner(
      new PlanPreviewTaskRunner(mockAiService, planResolver, () => []),
      new ConditionalWatchTaskRunner({} as any, mockAiService),
      bgRunner,
    );

    const scheduler = new TaskScheduler(taskStore, taskRunStore, compositeRunner, auditLogger);

    const task = taskStore.create({
      tenantId: 'ten_test',
      ownerId: 'usr_test',
      name: 'Batch Document Analysis',
      objective: 'Analyze and summarize 500 PDF documents in the background',
      type: 'BACKGROUND',
      trigger: { type: 'MANUAL' },
    });

    assert.equal(task.type, 'BACKGROUND');
    assert.equal(task.status, 'ACTIVE');
    assert.equal(task.progress, undefined);

    const run = await scheduler.runOne(task);
    assert.equal(run.status, 'SUCCEEDED');

    const updatedTask = taskStore.get(task.taskId)!;
    assert.ok(updatedTask.progress);
    assert.equal(updatedTask.progress.percent, 100);
    assert.equal(updatedTask.progress.completedSteps, 4);
    assert.equal(updatedTask.progress.totalSteps, 4);
    assert.ok(updatedTask.progress.logs.length >= 4);
    assert.ok(updatedTask.progress.logs[0].includes('Background task started'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Background Tasks (AC-12): Cancelling a background task halts execution and sets status to CANCELLED', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-bg-test-2-'));
  try {
    const taskStore = new TaskStore({ dir: path.join(tmpDir, 'tasks') });
    const taskRunStore = new TaskRunStore({ dir: path.join(tmpDir, 'runs') });
    const auditLogger = new AuditLogger();

    const mockAiService: AiService = {
      statuses: () => [],
      chat: async () => ({ provider: 'mock', model: 'mock-model', latencyMs: 10, requestId: 'req_1', data: { message: 'MET: false' } }),
      plan: async () => ({
        provider: 'mock',
        model: 'mock-model',
        latencyMs: 10,
        requestId: 'req_1',
        data: { goal: 'Test Goal', summary: 'Test Summary', reasoningSummary: 'Test Reasoning', steps: [] },
      }),
    } as unknown as AiService;

    const planResolver = new PlanResolver(skillRegistry, toolRegistry);
    const bgRunner = new BackgroundTaskRunner(taskStore, mockAiService, planResolver, () => []);
    const task = taskStore.create({
      tenantId: 'ten_test',
      ownerId: 'usr_test',
      name: 'Long Running Code Audit',
      objective: 'Audit all repositories for security vulnerabilities',
      type: 'BACKGROUND',
      trigger: { type: 'MANUAL' },
    });

    // Mark task as CANCELLED before run
    taskStore.cancel(task.taskId);
    assert.equal(taskStore.get(task.taskId)?.status, 'CANCELLED');

    const outcome = await bgRunner.run(task, 'req_cancel_test');
    assert.equal(outcome.status, 'FAILED');
    assert.equal(outcome.errorCode, 'TASK_CANCELLED');

    const haltedTask = taskStore.get(task.taskId)!;
    assert.ok(haltedTask.progress);
    assert.ok(haltedTask.progress.currentStep.includes('Halted'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Background Tasks API: POST /api/v1/tasks/:id/cancel cancels an active task via API', async () => {
  const headers = { 'x-nagex-tenant': 'ten_test', 'x-principal-id': 'usr_test' };
  const mockAiService: AiService = {
    statuses: () => [],
    chat: async () => ({ provider: 'mock', model: 'mock-model', latencyMs: 10, requestId: 'req_1', data: { message: 'MET: false' } }),
    plan: async () => ({
      provider: 'mock',
      model: 'mock-model',
      latencyMs: 10,
      requestId: 'req_1',
      data: { goal: 'Test Goal', summary: 'Test Summary', reasoningSummary: 'Test Reasoning', steps: [] },
    }),
  } as unknown as AiService;

  const createRes = await handleAsyncApiRequest(
    'POST',
    '/api/v1/tasks',
    {
      name: 'Background Data Sync',
      objective: 'Sync remote database records to local index',
      type: 'BACKGROUND',
      trigger: { type: 'MANUAL' },
    },
    headers,
    mockAiService,
  );

  assert.equal(createRes.status, 201);
  const task = createRes.data as any;
  assert.equal(task.type, 'BACKGROUND');

  const cancelRes = await handleAsyncApiRequest('POST', `/api/v1/tasks/${task.taskId}/cancel`, {}, headers, mockAiService);
  assert.equal(cancelRes.status, 200);
  assert.equal((cancelRes.data as any).status, 'CANCELLED');

  const getRes = await handleAsyncApiRequest('GET', `/api/v1/tasks/${task.taskId}`, null, headers, mockAiService);
  assert.equal(getRes.status, 200);
  assert.equal((getRes.data as any).status, 'CANCELLED');
});

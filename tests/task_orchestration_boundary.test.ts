// Phase 06 — Task Orchestration Cleanup.
//
// Verifies the Task subsystem's runner responsibilities are physically
// separated (one file per runner under src/tasks/runners/), every external
// consumer still reaches them through the stable src/tasks/task.runner.ts
// entrypoint (now a re-export aggregator, not an implementation), no Task
// file ever imports a Browser/Gmail/Calendar concrete implementation
// directly (ConditionalWatchTaskRunner reaches Browser only through
// CapabilityExecutorPort), and CompositeTaskRunner's routing plus
// ConditionalWatchTaskRunner's fail-safe/cleanup behavior are unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CompositeTaskRunner } from '../src/tasks/runners/composite.runner.js';
import { ConditionalWatchTaskRunner } from '../src/tasks/runners/conditional-watch.runner.js';
import { PlanPreviewTaskRunner } from '../src/tasks/runners/plan-preview.runner.js';
import { BackgroundTaskRunner } from '../src/tasks/runners/background.runner.js';
import type { TaskRunner, TaskRunOutcome } from '../src/tasks/task.scheduler.js';
import type { TaskRecord } from '../src/tasks/task.store.js';
import type { CapabilityExecutorPort } from '../src/contracts/capability.port.js';
import type { CapabilityRequest, CapabilityBrokerResult } from '../src/capabilities/capability.types.js';
import { createNagexApplication } from '../src/app/create-nagex-application.js';

function readSourceWithoutComments(relPath: string): string {
  const source = fs.readFileSync(path.resolve(relPath), 'utf8');
  return source.split('\n').map((line) => line.replace(/\/\/.*/, '')).join('\n');
}

function baseTask(overrides: Partial<TaskRecord>): TaskRecord {
  return {
    taskId: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    tenantId: 't1',
    ownerId: 'u1',
    name: 'Boundary test task',
    type: 'ONE_TIME',
    status: 'ACTIVE',
    objective: 'x',
    trigger: { type: 'MANUAL' },
    approvalPolicy: 'READ_ONLY_AUTO',
    sourceSessionId: null,
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: null,
    progress: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as TaskRecord;
}

// ─── 1: ConditionalWatchTaskRunner depends on CapabilityExecutorPort, not Browser concrete ───

test('1. ConditionalWatchTaskRunner constructs against a fake CapabilityExecutorPort, no real Browser/Playwright required', () => {
  const calls: string[] = [];
  const fakeBroker: CapabilityExecutorPort = {
    execute: async (request: CapabilityRequest): Promise<CapabilityBrokerResult> => {
      calls.push(request.capabilityId);
      if (request.capabilityId === 'browser.open') return { status: 'EXECUTED', capabilityId: request.capabilityId, result: { browserSessionId: 'sess_1' } } as CapabilityBrokerResult;
      if (request.capabilityId === 'browser.snapshot') return { status: 'EXECUTED', capabilityId: request.capabilityId, result: { url: 'https://example.com', title: 't', text: 'price $100' } } as CapabilityBrokerResult;
      return { status: 'EXECUTED', capabilityId: request.capabilityId, result: {} } as CapabilityBrokerResult;
    },
  };
  const runner = new ConditionalWatchTaskRunner(fakeBroker, { chat: async () => ({ data: { message: 'MET: false\nREASON: no match' } }) } as any);
  assert.ok(runner, 'ConditionalWatchTaskRunner must construct against a fake port with zero real Browser/Playwright dependency');
});

// ─── 2: no Task file imports Browser/Gmail/Calendar concrete implementation ───

test('2. No file under src/tasks/ imports a Browser/Gmail/Calendar module internal file or concrete class directly', () => {
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        const code = readSourceWithoutComments(full);
        if (/modules\/(browser|gmail|calendar)\//.test(code)) offenders.push(full);
      }
    }
  };
  walk('src/tasks');
  assert.deepEqual(offenders, [], `these Task files import Browser/Gmail/Calendar directly instead of going through CapabilityExecutorPort: ${offenders.join(', ')}`);
});

// ─── 3-5: CompositeTaskRunner routing ───

test('3. CompositeTaskRunner routes BACKGROUND correctly', async () => {
  let backgroundCalled = false;
  const background: TaskRunner = { run: async (): Promise<TaskRunOutcome> => { backgroundCalled = true; return { status: 'SUCCEEDED' }; } };
  const other: TaskRunner = { run: async (): Promise<TaskRunOutcome> => { throw new Error('must not be called'); } };
  const composite = new CompositeTaskRunner(other, other, background);
  await composite.run(baseTask({ type: 'BACKGROUND' }), 'req_1', 'run_1');
  assert.equal(backgroundCalled, true, 'a BACKGROUND task must route to the injected background runner');
});

test('4. CompositeTaskRunner routes CONDITIONAL correctly', async () => {
  let watchCalled = false;
  const watch: TaskRunner = { run: async (): Promise<TaskRunOutcome> => { watchCalled = true; return { status: 'SUCCEEDED', conditionMet: false }; } };
  const other: TaskRunner = { run: async (): Promise<TaskRunOutcome> => { throw new Error('must not be called'); } };
  const composite = new CompositeTaskRunner(other, watch);
  await composite.run(baseTask({ type: 'CONDITIONAL', trigger: { type: 'CONDITION', condition: 'x', watchUrl: 'https://example.com', checkIntervalMinutes: 15 } }), 'req_2', 'run_2');
  assert.equal(watchCalled, true, 'a CONDITIONAL task with a CONDITION trigger must route to the conditional watch runner');
});

test('5. default path routes PlanPreview', async () => {
  let planPreviewCalled = false;
  const planPreview: TaskRunner = { run: async (): Promise<TaskRunOutcome> => { planPreviewCalled = true; return { status: 'SUCCEEDED' }; } };
  const other: TaskRunner = { run: async (): Promise<TaskRunOutcome> => { throw new Error('must not be called'); } };
  const composite = new CompositeTaskRunner(planPreview, other);
  await composite.run(baseTask({ type: 'ONE_TIME' }), 'req_3', 'run_3');
  assert.equal(planPreviewCalled, true, 'a non-BACKGROUND, non-CONDITIONAL task must route to the plan preview runner');
});

// ─── 6: PlanPreview never calls capability executor ───

test('6. PlanPreviewTaskRunner has zero CapabilityExecutorPort dependency (constructor-level check)', () => {
  const code = readSourceWithoutComments('src/tasks/runners/plan-preview.runner.ts');
  assert.doesNotMatch(code, /CapabilityExecutorPort|capabilityBroker/, 'PlanPreviewTaskRunner must never depend on CapabilityExecutorPort — it only produces a reviewable plan');
});

// ─── 7: ConditionalWatch always closes opened browser session ───

test('7. ConditionalWatchTaskRunner closes the browser session even when the judge step throws', async () => {
  const calls: string[] = [];
  const broker: CapabilityExecutorPort = {
    execute: async (request: CapabilityRequest): Promise<CapabilityBrokerResult> => {
      calls.push(request.capabilityId);
      if (request.capabilityId === 'browser.open') return { status: 'EXECUTED', capabilityId: request.capabilityId, result: { browserSessionId: 'sess_1' } } as CapabilityBrokerResult;
      if (request.capabilityId === 'browser.snapshot') return { status: 'EXECUTED', capabilityId: request.capabilityId, result: { url: 'https://example.com', title: 't', text: 'x' } } as CapabilityBrokerResult;
      return { status: 'EXECUTED', capabilityId: request.capabilityId, result: {} } as CapabilityBrokerResult;
    },
  };
  const throwingAi = { chat: async () => { throw new Error('model unavailable'); } } as any;
  const runner = new ConditionalWatchTaskRunner(broker, throwingAi);
  const outcome = await runner.run(baseTask({ type: 'CONDITIONAL', trigger: { type: 'CONDITION', condition: 'x', watchUrl: 'https://example.com', checkIntervalMinutes: 15 } }), 'req_7');
  assert.equal(outcome.status, 'FAILED');
  assert.ok(calls.includes('browser.close'), 'browser.close must be called even when the judge step throws');
});

// ─── 8: ambiguous judgment stays false ───

test('8. An ambiguous/unparseable model response defaults conditionMet to false', async () => {
  const broker: CapabilityExecutorPort = {
    execute: async (request: CapabilityRequest): Promise<CapabilityBrokerResult> => {
      if (request.capabilityId === 'browser.open') return { status: 'EXECUTED', capabilityId: request.capabilityId, result: { browserSessionId: 'sess_1' } } as CapabilityBrokerResult;
      if (request.capabilityId === 'browser.snapshot') return { status: 'EXECUTED', capabilityId: request.capabilityId, result: { url: 'https://example.com', title: 't', text: 'x' } } as CapabilityBrokerResult;
      return { status: 'EXECUTED', capabilityId: request.capabilityId, result: {} } as CapabilityBrokerResult;
    },
  };
  const ambiguousAi = { chat: async () => ({ data: { message: 'I am not sure what to say here.' } }) } as any;
  const runner = new ConditionalWatchTaskRunner(broker, ambiguousAi);
  const outcome = await runner.run(baseTask({ type: 'CONDITIONAL', trigger: { type: 'CONDITION', condition: 'x', watchUrl: 'https://example.com', checkIntervalMinutes: 15 } }), 'req_8');
  assert.equal(outcome.status, 'SUCCEEDED');
  assert.equal(outcome.conditionMet, false, 'an unparseable model response must never be treated as met (fail-safe)');
});

// ─── 9: Background cancellation stops progression ───

test('9. BackgroundTaskRunner halts and stops progressing once the task is CANCELLED', async () => {
  let getCallCount = 0;
  let lastProgressCall: any = null;
  const fakeTaskStore = {
    get: (_taskId: string) => {
      getCallCount++;
      return getCallCount === 1 ? baseTask({ status: 'ACTIVE' }) : baseTask({ status: 'CANCELLED' });
    },
    updateProgress: (_taskId: string, progress: any) => { lastProgressCall = progress; },
  } as any;
  const fakeAiService = { plan: async () => { throw new Error('must not be reached after cancellation'); } } as any;
  const fakePlanResolver = { resolve: () => { throw new Error('must not be reached'); } } as any;
  const runner = new BackgroundTaskRunner(fakeTaskStore, fakeAiService, fakePlanResolver, () => []);
  const outcome = await runner.run(baseTask({ type: 'BACKGROUND' }), 'req_9');
  assert.equal(outcome.status, 'FAILED');
  assert.equal(outcome.errorCode, 'TASK_CANCELLED');
  assert.ok(lastProgressCall.currentStep.includes('Halted'), 'progress must record the halt, not silently stop');
});

// ─── 10: Composition Root wires the same shared CapabilityBroker into conditional watch ───

test('10. Composition Root wires ConditionalWatchTaskRunner with the exact same capabilityBroker/aiService the app graph exposes', () => {
  const code = readSourceWithoutComments('src/app/create-nagex-application.ts');
  assert.match(code, /new ConditionalWatchTaskRunner\(capabilityBroker, aiService\)/, 'Composition Root must wire ConditionalWatchTaskRunner with the shared capabilityBroker/aiService instances');
  const app = createNagexApplication();
  assert.ok(app.taskRunner, 'the app graph must expose a real taskRunner');
});

// ─── 11: every external consumer still reaches runners only through task.runner.ts ───

test('11. No production file outside src/tasks/runners/ (and task.runner.ts itself) deep-imports a runner file directly', () => {
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const normalized = full.replace(/\\/g, '/');
      if (entry.isDirectory()) {
        if (normalized.endsWith('src/tasks/runners')) continue;
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.ts') && normalized !== 'src/tasks/task.runner.ts') {
        const code = readSourceWithoutComments(full);
        if (/tasks\/runners\//.test(code)) offenders.push(full);
      }
    }
  };
  walk('src');
  assert.deepEqual(offenders, [], `these files deep-import a Task runner file instead of going through src/tasks/task.runner.ts: ${offenders.join(', ')}`);
});

// ─── 12: task.runner.ts is a pure re-export, and each runner has one source of truth ───

test('12. task.runner.ts is a pure re-export aggregator, and each runner file exists exactly once', () => {
  const code = readSourceWithoutComments('src/tasks/task.runner.ts');
  assert.doesNotMatch(code, /class \w+/, 'task.runner.ts must contain no class implementation after the split — only re-exports');
  for (const file of ['plan-preview.runner.ts', 'background.runner.ts', 'conditional-watch.runner.ts', 'composite.runner.ts']) {
    assert.ok(fs.existsSync(path.resolve('src/tasks/runners', file)), `src/tasks/runners/${file} must exist`);
  }
});

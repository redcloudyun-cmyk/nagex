import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseCronExpression,
  computeNextScheduleRun,
  computeNextRunAt,
  TaskScheduler,
  type TaskRunner,
  type TaskRunOutcome,
} from '../src/tasks/task.scheduler.js';
import { TaskStore, type TaskRecord } from '../src/tasks/task.store.js';
import { TaskRunStore } from '../src/tasks/task-run.store.js';
import { AuditLogger } from '../src/governance/audit.logger.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-task-scheduler-'));
}

// ── cron parsing ────────────────────────────────────────────────────────

test('parseCronExpression accepts *, exact numbers, comma lists, and */step', () => {
  assert.ok(parseCronExpression('0 8 * * *'));
  assert.ok(parseCronExpression('0,30 8,20 * * *'));
  assert.ok(parseCronExpression('*/15 * * * *'));
});

test('parseCronExpression rejects malformed expressions instead of guessing', () => {
  assert.equal(parseCronExpression('not a cron'), null);
  assert.equal(parseCronExpression('0 8 * *'), null); // only 4 fields
  assert.equal(parseCronExpression('60 8 * * *'), null); // minute out of range
  assert.equal(parseCronExpression('0 25 * * *'), null); // hour out of range
});

// ── computeNextScheduleRun ───────────────────────────────────────────────

test('daily-at-8am cron finds the next occurrence in the given timezone', () => {
  // 2026-06-01T00:00:00.000Z is 2026-06-01 09:00 in Asia/Seoul (UTC+9) —
  // already past that day's 08:00 run, so the next occurrence is the
  // following day, 2026-06-02 08:00 KST = 2026-06-01T23:00:00.000Z.
  const from = new Date('2026-06-01T00:00:00.000Z');
  const next = computeNextScheduleRun('0 8 * * *', 'Asia/Seoul', from);
  assert.ok(next);
  assert.equal(next!.toISOString(), '2026-06-01T23:00:00.000Z');
});

test('when already past today\'s run time, the next occurrence rolls to tomorrow', () => {
  const from = new Date('2026-06-01T10:00:00.000Z'); // already past 08:00 UTC today
  const next = computeNextScheduleRun('0 8 * * *', 'UTC', from);
  assert.ok(next);
  assert.equal(next!.toISOString(), '2026-06-02T08:00:00.000Z');
});

test('every-15-minutes (*/15) finds the next matching minute', () => {
  const from = new Date('2026-06-01T00:07:00.000Z');
  const next = computeNextScheduleRun('*/15 * * * *', 'UTC', from);
  assert.ok(next);
  assert.equal(next!.toISOString(), '2026-06-01T00:15:00.000Z');
});

test('an invalid timezone fails closed to null, never a wrong-timezone guess', () => {
  const next = computeNextScheduleRun('0 8 * * *', 'Not/AZone', new Date());
  assert.equal(next, null);
});

test('an expression that can never match (Feb 30) returns null rather than looping forever', () => {
  const next = computeNextScheduleRun('0 0 30 2 *', 'UTC', new Date('2026-01-01T00:00:00.000Z'));
  assert.equal(next, null);
});

// ── computeNextRunAt ─────────────────────────────────────────────────────

test('an INTERVAL trigger fires N minutes after the reference time', () => {
  const from = new Date('2026-06-01T00:00:00.000Z');
  const next = computeNextRunAt({ type: 'INTERVAL', intervalMinutes: 45 }, from);
  assert.ok(next);
  assert.equal(next!.toISOString(), '2026-06-01T00:45:00.000Z');
});

test('CONDITION/WEBHOOK/MANUAL triggers are not scheduler-driven — computeNextRunAt returns null', () => {
  for (const trigger of [{ type: 'CONDITION' as const }, { type: 'WEBHOOK' as const }, { type: 'MANUAL' as const }, { type: 'CALENDAR_EVENT' as const }]) {
    assert.equal(computeNextRunAt(trigger, new Date()), null, `expected ${trigger.type} to be non-scheduler-driven`);
  }
});

// ── TaskScheduler orchestration ──────────────────────────────────────────

function baseTaskInput(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: 'ten_1',
    ownerId: 'usr_1',
    name: 'Test Task',
    objective: 'Do the thing.',
    type: 'RECURRING' as const,
    trigger: { type: 'INTERVAL' as const, intervalMinutes: 60 },
    approvalPolicy: 'READ_ONLY_AUTO' as const,
    nextRunAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

class FakeRunner implements TaskRunner {
  public calls = 0;
  public lastTask: TaskRecord | null = null;
  constructor(private readonly outcome: TaskRunOutcome) {}
  async run(task: TaskRecord): Promise<TaskRunOutcome> {
    this.calls += 1;
    this.lastTask = task;
    return this.outcome;
  }
}

test('tick() runs every due task exactly once via the injected runner, and never a task that is not due', async () => {
  const taskStore = new TaskStore({ dir: tempDir() });
  const runStore = new TaskRunStore({ dir: tempDir() });
  const runner = new FakeRunner({ status: 'SUCCEEDED', result: { ok: true } });
  const audit = new AuditLogger();
  const scheduler = new TaskScheduler(taskStore, runStore, runner, audit, () => new Date('2026-06-01T00:00:00.000Z'));

  const due = taskStore.create(baseTaskInput());
  taskStore.create(baseTaskInput({ name: 'not due', nextRunAt: '2099-01-01T00:00:00.000Z' }));

  const results = await scheduler.tick();
  assert.equal(results.length, 1);
  assert.equal(runner.calls, 1);
  assert.equal(runner.lastTask?.taskId, due.taskId);
});

test('runOne() records a TaskRun, reschedules a RECURRING task on success, and audits the full lifecycle', async () => {
  const taskStore = new TaskStore({ dir: tempDir() });
  const runStore = new TaskRunStore({ dir: tempDir() });
  const runner = new FakeRunner({ status: 'SUCCEEDED', result: { note: 'ok' } });
  const audit = new AuditLogger();
  const scheduler = new TaskScheduler(taskStore, runStore, runner, audit, () => new Date('2026-06-01T00:00:00.000Z'));

  const task = taskStore.create(baseTaskInput());
  const run = await scheduler.runOne(task);

  assert.equal(run.status, 'SUCCEEDED');
  assert.deepEqual(run.result, { note: 'ok' });

  const updatedTask = taskStore.get(task.taskId)!;
  assert.equal(updatedTask.status, 'ACTIVE'); // RECURRING -> back to ACTIVE, rescheduled
  assert.equal(updatedTask.lastRunStatus, 'SUCCEEDED');
  assert.equal(updatedTask.nextRunAt, '2026-06-01T01:00:00.000Z'); // +60 minutes

  const actions = audit.getRecentLogs(10).map((e) => e.action).reverse();
  assert.deepEqual(actions, ['task.triggered', 'execution.started', 'execution.succeeded']);
});

test('runOne() marks the TaskRun and Task FAILED when the runner rejects, and audits execution.failed', async () => {
  const taskStore = new TaskStore({ dir: tempDir() });
  const runStore = new TaskRunStore({ dir: tempDir() });
  const runner: TaskRunner = { run: async () => { throw new Error('boom'); } };
  const audit = new AuditLogger();
  const scheduler = new TaskScheduler(taskStore, runStore, runner, audit, () => new Date('2026-06-01T00:00:00.000Z'));

  const task = taskStore.create(baseTaskInput({ type: 'ONE_TIME', trigger: { type: 'MANUAL' } }));
  const run = await scheduler.runOne(task);

  assert.equal(run.status, 'FAILED');
  assert.equal(run.errorCode, 'boom');

  const updatedTask = taskStore.get(task.taskId)!;
  assert.equal(updatedTask.status, 'FAILED');

  const actions = audit.getRecentLogs(10).map((e) => e.action).reverse();
  assert.deepEqual(actions, ['task.triggered', 'execution.started', 'execution.failed']);
});

test('a ONE_TIME task completes (not reschedules) after a successful run', async () => {
  const taskStore = new TaskStore({ dir: tempDir() });
  const runStore = new TaskRunStore({ dir: tempDir() });
  const runner = new FakeRunner({ status: 'SUCCEEDED', result: null });
  const audit = new AuditLogger();
  const scheduler = new TaskScheduler(taskStore, runStore, runner, audit, () => new Date('2026-06-01T00:00:00.000Z'));

  const task = taskStore.create(baseTaskInput({ type: 'ONE_TIME', trigger: { type: 'SCHEDULE', schedule: '0 8 * * *', timezone: 'UTC' } }));
  await scheduler.runOne(task);

  const updatedTask = taskStore.get(task.taskId)!;
  assert.equal(updatedTask.status, 'COMPLETED');
  assert.equal(updatedTask.nextRunAt, null);
});

test('a run persists (survives a restart) via a fresh TaskRunStore pointed at the same directory', async () => {
  const runDir = tempDir();
  const taskStore = new TaskStore({ dir: tempDir() });
  const runStore = new TaskRunStore({ dir: runDir });
  const runner = new FakeRunner({ status: 'SUCCEEDED', result: { x: 1 } });
  const audit = new AuditLogger();
  const scheduler = new TaskScheduler(taskStore, runStore, runner, audit, () => new Date('2026-06-01T00:00:00.000Z'));

  const task = taskStore.create(baseTaskInput());
  const run = await scheduler.runOne(task);

  const restored = new TaskRunStore({ dir: runDir }).get(run.runId);
  assert.ok(restored);
  assert.equal(restored!.status, 'SUCCEEDED');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskStore } from '../src/tasks/task.store.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-task-store-'));
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: 'ten_1',
    ownerId: 'usr_1',
    name: 'Daily Morning Brief',
    objective: 'Summarize my calendar for today.',
    type: 'RECURRING' as const,
    trigger: { type: 'SCHEDULE' as const, schedule: '0 8 * * *', timezone: 'Asia/Seoul' },
    approvalPolicy: 'READ_ONLY_AUTO' as const,
    ...overrides,
  };
}

test('create() rejects a blank name or objective — never a silently empty task', () => {
  const store = new TaskStore({ dir: tempDir() });
  assert.throws(() => store.create(baseInput({ name: '  ' })), /TASK_NAME_REQUIRED|name is required/i);
  assert.throws(() => store.create(baseInput({ objective: '' })), /TASK_OBJECTIVE_REQUIRED|objective is required/i);
});

test('create() produces an ACTIVE task with the given fields', () => {
  const store = new TaskStore({ dir: tempDir() });
  const task = store.create(baseInput());
  assert.equal(task.status, 'ACTIVE');
  assert.equal(task.type, 'RECURRING');
  assert.equal(task.name, 'Daily Morning Brief');
  assert.equal(task.lastRunAt, null);
  assert.match(task.taskId, /^tsk_/);
});

test('list() only returns tasks for the given owner, newest first', () => {
  const store = new TaskStore({ dir: tempDir() });
  const a = store.create(baseInput({ ownerId: 'usr_a', name: 'A' }));
  const b = store.create(baseInput({ ownerId: 'usr_a', name: 'B' }));
  store.create(baseInput({ ownerId: 'usr_b', name: 'C' }));
  const list = store.list('usr_a');
  assert.equal(list.length, 2);
  assert.ok(list.every((t) => t.ownerId === 'usr_a'));
  assert.equal(list[0].taskId, b.taskId); // newest first
  assert.equal(list[1].taskId, a.taskId);
});

test('pause -> resume round-trips a RECURRING task back to ACTIVE', () => {
  const store = new TaskStore({ dir: tempDir() });
  const task = store.create(baseInput());
  const paused = store.pause(task.taskId);
  assert.equal(paused.status, 'PAUSED');
  const resumed = store.resume(task.taskId);
  assert.equal(resumed.status, 'ACTIVE');
});

test('resume on a CONDITIONAL/WAITING task returns it to WAITING, not ACTIVE', () => {
  const store = new TaskStore({ dir: tempDir() });
  const task = store.create(baseInput({ type: 'CONDITIONAL', trigger: { type: 'CONDITION', condition: 'flight price drops' } }));
  store.pause(task.taskId);
  const resumed = store.resume(task.taskId);
  assert.equal(resumed.status, 'WAITING');
});

test('pausing a task that is not active/waiting is rejected (state machine, not a free-for-all)', () => {
  const store = new TaskStore({ dir: tempDir() });
  const task = store.create(baseInput());
  store.cancel(task.taskId);
  assert.throws(() => store.pause(task.taskId), /not active/i);
});

test('cancel() moves a task to CANCELLED regardless of its current status', () => {
  const store = new TaskStore({ dir: tempDir() });
  const task = store.create(baseInput());
  const cancelled = store.cancel(task.taskId);
  assert.equal(cancelled.status, 'CANCELLED');
});

test('delete() permanently removes the task — a second get() returns undefined', () => {
  const store = new TaskStore({ dir: tempDir() });
  const task = store.create(baseInput());
  store.delete(task.taskId);
  assert.equal(store.get(task.taskId), undefined);
});

test('operating on an unknown taskId fails closed with TASK_NOT_FOUND', () => {
  const store = new TaskStore({ dir: tempDir() });
  assert.throws(() => store.pause('tsk_does_not_exist'), /was not found/i);
  assert.throws(() => store.delete('tsk_does_not_exist'), /was not found/i);
});

test('listDue only returns ACTIVE tasks whose nextRunAt has arrived — never CONDITIONAL/MANUAL/paused tasks', () => {
  const store = new TaskStore({ dir: tempDir() });
  const due = store.create(baseInput({ nextRunAt: '2026-01-01T00:00:00.000Z' }));
  const future = store.create(baseInput({ name: 'future', nextRunAt: '2099-01-01T00:00:00.000Z' }));
  const noSchedule = store.create(baseInput({ name: 'manual', type: 'BACKGROUND', trigger: { type: 'MANUAL' } }));
  const paused = store.create(baseInput({ name: 'paused', nextRunAt: '2026-01-01T00:00:00.000Z' }));
  store.pause(paused.taskId);

  const result = store.listDue(new Date('2026-06-01T00:00:00.000Z'));
  const ids = result.map((t) => t.taskId);
  assert.ok(ids.includes(due.taskId));
  assert.ok(!ids.includes(future.taskId));
  assert.ok(!ids.includes(noSchedule.taskId));
  assert.ok(!ids.includes(paused.taskId));
});

test('recordRunOutcome reschedules a RECURRING task and keeps it ACTIVE', () => {
  const store = new TaskStore({ dir: tempDir() });
  const task = store.create(baseInput());
  const updated = store.recordRunOutcome(task.taskId, { status: 'SUCCEEDED', completedAt: '2026-06-02T08:00:00.000Z', nextRunAt: '2026-06-03T08:00:00.000Z' });
  assert.equal(updated.status, 'ACTIVE');
  assert.equal(updated.lastRunAt, '2026-06-02T08:00:00.000Z');
  assert.equal(updated.lastRunStatus, 'SUCCEEDED');
  assert.equal(updated.nextRunAt, '2026-06-03T08:00:00.000Z');
});

test('recordRunOutcome completes a ONE_TIME task and clears nextRunAt', () => {
  const store = new TaskStore({ dir: tempDir() });
  const task = store.create(baseInput({ type: 'ONE_TIME', trigger: { type: 'SCHEDULE', schedule: '0 14 * * *', timezone: 'UTC' } }));
  const updated = store.recordRunOutcome(task.taskId, { status: 'SUCCEEDED', completedAt: '2026-06-02T14:00:00.000Z', nextRunAt: '2026-06-03T14:00:00.000Z' });
  assert.equal(updated.status, 'COMPLETED');
  assert.equal(updated.nextRunAt, null);
});

test('recordRunOutcome marks a ONE_TIME task FAILED on failure, never silently COMPLETED', () => {
  const store = new TaskStore({ dir: tempDir() });
  const task = store.create(baseInput({ type: 'ONE_TIME', trigger: { type: 'MANUAL' } }));
  const updated = store.recordRunOutcome(task.taskId, { status: 'FAILED', completedAt: '2026-06-02T14:00:00.000Z', nextRunAt: null });
  assert.equal(updated.status, 'FAILED');
});

test('a task survives a restart (a fresh TaskStore instance pointed at the same directory)', () => {
  const dir = tempDir();
  const created = new TaskStore({ dir }).create(baseInput());
  const restored = new TaskStore({ dir }).get(created.taskId);
  assert.ok(restored);
  assert.equal(restored!.name, created.name);
  assert.equal(restored!.trigger.schedule, '0 8 * * *');
});

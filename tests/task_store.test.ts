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

test('list() only returns tasks for the given tenant+owner, newest first', () => {
  const store = new TaskStore({ dir: tempDir() });
  const a = store.create(baseInput({ ownerId: 'usr_a', name: 'A' }));
  const b = store.create(baseInput({ ownerId: 'usr_a', name: 'B' }));
  store.create(baseInput({ ownerId: 'usr_b', name: 'C' }));
  const list = store.list('ten_1', 'usr_a');
  assert.equal(list.length, 2);
  assert.ok(list.every((t) => t.ownerId === 'usr_a'));
  assert.equal(list[0].taskId, b.taskId); // newest first
  assert.equal(list[1].taskId, a.taskId);
});

test('pause -> resume round-trips a RECURRING task back to ACTIVE', () => {
  const store = new TaskStore({ dir: tempDir() });
  const task = store.create(baseInput());
  const paused = store.pause(task.taskId, task.tenantId, task.ownerId);
  assert.equal(paused.status, 'PAUSED');
  const resumed = store.resume(task.taskId, task.tenantId, task.ownerId);
  assert.equal(resumed.status, 'ACTIVE');
});

test('resume on a CONDITIONAL/WAITING task returns it to WAITING, not ACTIVE', () => {
  const store = new TaskStore({ dir: tempDir() });
  const task = store.create(baseInput({ type: 'CONDITIONAL', trigger: { type: 'CONDITION', condition: 'flight price drops' } }));
  store.pause(task.taskId, task.tenantId, task.ownerId);
  const resumed = store.resume(task.taskId, task.tenantId, task.ownerId);
  assert.equal(resumed.status, 'WAITING');
});

test('pausing a task that is not active/waiting is rejected (state machine, not a free-for-all)', () => {
  const store = new TaskStore({ dir: tempDir() });
  const task = store.create(baseInput());
  store.cancel(task.taskId, task.tenantId, task.ownerId);
  assert.throws(() => store.pause(task.taskId, task.tenantId, task.ownerId), /not active/i);
});

test('cancel() moves a task to CANCELLED regardless of its current status', () => {
  const store = new TaskStore({ dir: tempDir() });
  const task = store.create(baseInput());
  const cancelled = store.cancel(task.taskId, task.tenantId, task.ownerId);
  assert.equal(cancelled.status, 'CANCELLED');
});

test('delete() permanently removes the task — a second get() returns undefined', () => {
  const store = new TaskStore({ dir: tempDir() });
  const task = store.create(baseInput());
  store.delete(task.taskId, task.tenantId, task.ownerId);
  assert.equal(store.get(task.taskId, task.tenantId, task.ownerId), undefined);
});

test('operating on an unknown taskId fails closed with TASK_NOT_FOUND', () => {
  const store = new TaskStore({ dir: tempDir() });
  assert.throws(() => store.pause('tsk_does_not_exist', 'ten_1', 'usr_1'), /was not found/i);
  assert.throws(() => store.delete('tsk_does_not_exist', 'ten_1', 'usr_1'), /was not found/i);
});

// ── Task Isolation Correction: tenant/owner isolation ───────────────────

test('list isolation: same principalId across tenant A/B never mixes', () => {
  const store = new TaskStore({ dir: tempDir() });
  store.create(baseInput({ tenantId: 'ten_a', ownerId: 'usr_shared', name: 'A' }));
  store.create(baseInput({ tenantId: 'ten_b', ownerId: 'usr_shared', name: 'B' }));
  assert.equal(store.list('ten_a', 'usr_shared').length, 1);
  assert.equal(store.list('ten_a', 'usr_shared')[0].name, 'A');
  assert.equal(store.list('ten_b', 'usr_shared').length, 1);
  assert.equal(store.list('ten_b', 'usr_shared')[0].name, 'B');
});

test('list isolation: same tenant, principal A vs B never mixes', () => {
  const store = new TaskStore({ dir: tempDir() });
  store.create(baseInput({ tenantId: 'ten_1', ownerId: 'usr_a', name: 'A' }));
  store.create(baseInput({ tenantId: 'ten_1', ownerId: 'usr_b', name: 'B' }));
  assert.equal(store.list('ten_1', 'usr_a').length, 1);
  assert.equal(store.list('ten_1', 'usr_b').length, 1);
});

test('get isolation: wrong tenant returns undefined, identical to a nonexistent task', () => {
  const store = new TaskStore({ dir: tempDir() });
  const task = store.create(baseInput({ tenantId: 'ten_a', ownerId: 'usr_shared' }));
  assert.equal(store.get(task.taskId, 'ten_b', 'usr_shared'), undefined);
  assert.equal(store.get('tsk_does_not_exist', 'ten_a', 'usr_shared'), undefined);
});

test('get isolation: wrong owner in the same tenant returns undefined', () => {
  const store = new TaskStore({ dir: tempDir() });
  const task = store.create(baseInput({ tenantId: 'ten_1', ownerId: 'usr_a' }));
  assert.equal(store.get(task.taskId, 'ten_1', 'usr_b'), undefined);
  assert.ok(store.get(task.taskId, 'ten_1', 'usr_a'));
});

test('update isolation: wrong tenant/owner cannot mutate; task remains unchanged', () => {
  const store = new TaskStore({ dir: tempDir() });
  const task = store.create(baseInput({ tenantId: 'ten_a', ownerId: 'usr_shared', name: 'Original' }));
  assert.throws(() => store.update(task.taskId, 'ten_b', 'usr_shared', { name: 'Hijacked' }), /was not found/i);
  assert.equal(store.get(task.taskId, 'ten_a', 'usr_shared')!.name, 'Original');
});

test('pause isolation: wrong tenant/owner cannot pause; task remains unchanged', () => {
  const store = new TaskStore({ dir: tempDir() });
  const task = store.create(baseInput({ tenantId: 'ten_a', ownerId: 'usr_shared' }));
  assert.throws(() => store.pause(task.taskId, 'ten_b', 'usr_shared'), /was not found/i);
  assert.equal(store.get(task.taskId, 'ten_a', 'usr_shared')!.status, 'ACTIVE');
});

test('resume isolation: wrong tenant/owner cannot resume; task remains unchanged', () => {
  const store = new TaskStore({ dir: tempDir() });
  const task = store.create(baseInput({ tenantId: 'ten_a', ownerId: 'usr_shared' }));
  store.pause(task.taskId, 'ten_a', 'usr_shared');
  assert.throws(() => store.resume(task.taskId, 'ten_b', 'usr_shared'), /was not found/i);
  assert.equal(store.get(task.taskId, 'ten_a', 'usr_shared')!.status, 'PAUSED');
});

test('cancel isolation: wrong tenant/owner cannot cancel; task remains unchanged', () => {
  const store = new TaskStore({ dir: tempDir() });
  const task = store.create(baseInput({ tenantId: 'ten_a', ownerId: 'usr_shared' }));
  assert.throws(() => store.cancel(task.taskId, 'ten_b', 'usr_shared'), /was not found/i);
  assert.equal(store.get(task.taskId, 'ten_a', 'usr_shared')!.status, 'ACTIVE');
});

test('delete isolation: wrong tenant/owner cannot delete; task still exists for its real owner', () => {
  const store = new TaskStore({ dir: tempDir() });
  const task = store.create(baseInput({ tenantId: 'ten_a', ownerId: 'usr_shared' }));
  assert.throws(() => store.delete(task.taskId, 'ten_b', 'usr_shared'), /was not found/i);
  assert.ok(store.get(task.taskId, 'ten_a', 'usr_shared'));
});

test('restart persistence: legitimate owner still sees/uses the task after a fresh store instance', () => {
  const dir = tempDir();
  const created = new TaskStore({ dir }).create(baseInput({ tenantId: 'ten_1', ownerId: 'usr_1' }));
  const store2 = new TaskStore({ dir });
  assert.ok(store2.get(created.taskId, 'ten_1', 'usr_1'));
  assert.equal(store2.list('ten_1', 'usr_1').length, 1);
  assert.equal(store2.get(created.taskId, 'ten_2', 'usr_1'), undefined);
});

test('listDue only returns ACTIVE tasks whose nextRunAt has arrived — never CONDITIONAL/MANUAL/paused tasks', () => {
  const store = new TaskStore({ dir: tempDir() });
  const due = store.create(baseInput({ nextRunAt: '2026-01-01T00:00:00.000Z' }));
  const future = store.create(baseInput({ name: 'future', nextRunAt: '2099-01-01T00:00:00.000Z' }));
  const noSchedule = store.create(baseInput({ name: 'manual', type: 'BACKGROUND', trigger: { type: 'MANUAL' } }));
  const paused = store.create(baseInput({ name: 'paused', nextRunAt: '2026-01-01T00:00:00.000Z' }));
  store.pause(paused.taskId, paused.tenantId, paused.ownerId);

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
  const restored = new TaskStore({ dir }).get(created.taskId, created.tenantId, created.ownerId);
  assert.ok(restored);
  assert.equal(restored!.name, created.name);
  assert.equal(restored!.trigger.schedule, '0 8 * * *');
});

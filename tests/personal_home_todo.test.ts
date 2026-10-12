import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MemoryEngine } from '../src/context/memory.engine.js';
import { PersistentActionApprovalStore } from '../src/governance/action-approval.store.js';
import { PersonalHomeService, buildHomeTodo } from '../src/home/personal-home.service.js';
import { PersonalContextService } from '../src/context/personal-context.service.js';
import { CurrentPersonalContextService } from '../src/personal/current-personal-context.service.js';
import { PersonalReminderStore } from '../src/personal/personal-reminder.store.js';
import { TaskStore } from '../src/tasks/task.store.js';
import { CaptureStore } from '../src/workspace/capture.store.js';
import { VaultStore } from '../src/workspace/vault.store.js';

// Home "Personal To-do" comes from the real reminder + task stores for the signed-in user only, and states plainly when
// there is no source instead of showing placeholder tasks.

const tenantId = 'ten_todo';
const userId = 'usr_todo';

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-todo-'));
  const taskStore = new TaskStore({ dir: path.join(dir, 'tasks') });
  const personalReminderStore = new PersonalReminderStore(path.join(dir, 'reminders'));
  const memoryEngine = new MemoryEngine({ dir: path.join(dir, 'memories') });
  const context = new CurrentPersonalContextService({
    googleCalendarService: { listUpcomingEvents: async () => [] } as never,
    taskStore,
    personalReminderStore,
    actionApprovals: new PersistentActionApprovalStore({ dir: path.join(dir, 'approvals') }),
    captureStore: new CaptureStore(path.join(dir, 'captures')),
    vaultStore: new VaultStore(path.join(dir, 'vault')),
    personalContextService: new PersonalContextService(memoryEngine),
  });
  return { taskStore, personalReminderStore, home: new PersonalHomeService({ currentPersonalContextService: context }) };
}

test('the To-do lists the user\'s due/overdue reminders and not-yet-running tasks, and only theirs', async () => {
  const h = harness();
  // 'due today' must stay today even when the suite runs in the last hour of the local day
  const endOfToday = new Date(); endOfToday.setHours(23, 59, 0, 0);
  const soon = new Date(Math.min(Date.now() + 60 * 60_000, endOfToday.getTime())).toISOString();
  const earlier = new Date(Date.now() - 60 * 60_000).toISOString();
  h.personalReminderStore.createReminder({ tenant_id: tenantId, user_id: userId, title: 'Call the client', scheduled_at: soon, timezone: 'UTC' });
  h.personalReminderStore.createReminder({ tenant_id: tenantId, user_id: userId, title: 'Send the invoice', scheduled_at: earlier, timezone: 'UTC' });
  h.personalReminderStore.createReminder({ tenant_id: tenantId, user_id: 'usr_other', title: 'Somebody else\'s reminder', scheduled_at: soon, timezone: 'UTC' });
  h.taskStore.create({ tenantId, ownerId: userId, name: 'Write the report', objective: 'Write it', type: 'ONE_TIME', trigger: { type: 'MANUAL' } });
  h.taskStore.create({ tenantId, ownerId: 'usr_other', name: 'Other user task', objective: 'x', type: 'ONE_TIME', trigger: { type: 'MANUAL' } });

  const home = await h.home.getPersonalHome({ tenantId, principalId: userId });
  assert.equal(home.todo?.status, 'OK');
  const titles = home.todo!.items.map((i) => i.title);
  assert.ok(titles.includes('Call the client'));
  assert.ok(titles.includes('Send the invoice'));
  assert.ok(titles.includes('Write the report'));
  assert.ok(!titles.some((t) => /Somebody else|Other user/.test(t)), 'another user\'s items never appear');
  assert.equal(home.todo!.items.find((i) => i.title === 'Send the invoice')?.state, 'Overdue');
  assert.equal(home.todo!.items.find((i) => i.title === 'Call the client')?.state, 'Due today');
});

test('no reminders or tasks is an honest empty list; no source is UNAVAILABLE, never invented items', () => {
  assert.deepEqual(buildHomeTodo(null, new Date()), { status: 'UNAVAILABLE', items: [] });
  const empty = { rightNow: { reminders: [] }, today: { tasks: [] }, sourceStatus: { reminders: 'OK', tasks: 'OK' } } as never;
  assert.deepEqual(buildHomeTodo(empty, new Date()), { status: 'OK', items: [] });
  const unavailable = { rightNow: { reminders: [] }, today: { tasks: [] }, sourceStatus: { reminders: 'UNAVAILABLE', tasks: 'UNAVAILABLE' } } as never;
  assert.equal(buildHomeTodo(unavailable, new Date()).status, 'UNAVAILABLE');
  const failing = { rightNow: { reminders: [] }, today: { tasks: [] }, sourceStatus: { reminders: 'ERROR', tasks: 'OK' } } as never;
  assert.equal(buildHomeTodo(failing, new Date()).status, 'ERROR');
});

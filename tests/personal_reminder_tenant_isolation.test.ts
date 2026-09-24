// R23.1H — PersonalReminderStore tenant isolation.
//
// PersonalReminderStore was user-scoped only — a genuine CROSS_TENANT_LEAK:
// a shared user_id across two tenants could see, update, or cancel each
// other's reminders. Every read/mutation now requires tenant_id + user_id
// together, never user_id alone, and a wrong-tenant lookup is
// indistinguishable from a genuinely nonexistent id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersonalReminderStore } from '../src/personal/personal-reminder.store.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-reminder-tenant-'));
}

const tenantA = 'ten_reminder_A';
const tenantB = 'ten_reminder_B';
const sharedUserId = 'usr_shared_across_tenants';

test('REMINDER_CROSS_TENANT_LEAK=0: tenant A/user X cannot see tenant B/user X reminder', () => {
  const store = new PersonalReminderStore(tempDir());
  const remA = store.createReminder({ tenant_id: tenantA, user_id: sharedUserId, title: 'Tenant A reminder', scheduled_at: new Date().toISOString(), timezone: 'UTC' });
  store.createReminder({ tenant_id: tenantB, user_id: sharedUserId, title: 'Tenant B reminder', scheduled_at: new Date().toISOString(), timezone: 'UTC' });

  const listA = store.listReminders(tenantA, sharedUserId);
  assert.equal(listA.length, 1);
  assert.equal(listA[0].reminder_id, remA.reminder_id);

  const listB = store.listReminders(tenantB, sharedUserId);
  assert.equal(listB.length, 1);
  assert.notEqual(listB[0].reminder_id, remA.reminder_id);

  assert.equal(store.getReminder(remA.reminder_id, tenantB, sharedUserId), null, 'tenant B must never be able to read tenant A\'s reminder by id, even with the same user_id');
});

test('wrong tenant cannot update or cancel a reminder', () => {
  const store = new PersonalReminderStore(tempDir());
  const rem = store.createReminder({ tenant_id: tenantA, user_id: sharedUserId, title: 'Do not touch from tenant B', scheduled_at: new Date().toISOString(), timezone: 'UTC' });

  const wrongTenantUpdate = store.updateStatus(rem.reminder_id, tenantB, sharedUserId, 'CANCELLED');
  assert.equal(wrongTenantUpdate, null, 'a wrong-tenant status update must be refused');

  const wrongTenantDelete = store.deleteReminder(rem.reminder_id, tenantB, sharedUserId);
  assert.equal(wrongTenantDelete, false, 'a wrong-tenant delete must be refused');

  // The real record must be completely untouched by either attempt.
  const stillThere = store.getReminder(rem.reminder_id, tenantA, sharedUserId);
  assert.ok(stillThere);
  assert.equal(stillThere!.status, 'ACTIVE');
});

test('nonexistent and cross-tenant lookup are indistinguishable', () => {
  const store = new PersonalReminderStore(tempDir());
  const rem = store.createReminder({ tenant_id: tenantA, user_id: sharedUserId, title: 'Real reminder', scheduled_at: new Date().toISOString(), timezone: 'UTC' });

  const crossTenantResult = store.getReminder(rem.reminder_id, tenantB, sharedUserId);
  const nonexistentResult = store.getReminder('rem_truly_does_not_exist', tenantA, sharedUserId);

  assert.equal(crossTenantResult, null);
  assert.equal(nonexistentResult, null);
  assert.equal(crossTenantResult, nonexistentResult, 'both must resolve to the identical null result, never leaking existence');
});

test('due-reminder scanning preserves tenant ownership', () => {
  const store = new PersonalReminderStore(tempDir());
  const due = new Date(Date.now() - 60_000).toISOString();
  const remA = store.createReminder({ tenant_id: tenantA, user_id: sharedUserId, title: 'Due A', scheduled_at: due, timezone: 'UTC' });
  const remB = store.createReminder({ tenant_id: tenantB, user_id: sharedUserId, title: 'Due B', scheduled_at: due, timezone: 'UTC' });

  const allDue = store.getDueReminders(new Date());
  const foundA = allDue.find((r) => r.reminder_id === remA.reminder_id);
  const foundB = allDue.find((r) => r.reminder_id === remB.reminder_id);
  assert.ok(foundA);
  assert.ok(foundB);
  assert.equal(foundA!.tenant_id, tenantA, 'a global due-reminder scan must never lose or reassign a real tenant_id');
  assert.equal(foundB!.tenant_id, tenantB);

  const dueForTenantAOnly = store.getDueReminders(new Date(), tenantA);
  assert.equal(dueForTenantAOnly.length, 1);
  assert.equal(dueForTenantAOnly[0].reminder_id, remA.reminder_id, 'an explicit tenant-scoped scan must exclude other tenants\' due reminders');
});

test('existing normal (single-tenant) reminder behavior still works', () => {
  const store = new PersonalReminderStore(tempDir());
  const rem = store.createReminder({ tenant_id: tenantA, user_id: sharedUserId, title: 'Call the client', scheduled_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(), timezone: 'Asia/Seoul' });
  assert.equal(rem.status, 'ACTIVE');

  const active = store.listReminders(tenantA, sharedUserId, 'ACTIVE');
  assert.equal(active.length, 1);

  const updated = store.updateStatus(rem.reminder_id, tenantA, sharedUserId, 'COMPLETED');
  assert.equal(updated?.status, 'COMPLETED');
  assert.ok(updated?.completed_at);
  assert.equal(store.listReminders(tenantA, sharedUserId, 'ACTIVE').length, 0);

  const deleted = store.deleteReminder(rem.reminder_id, tenantA, sharedUserId);
  assert.equal(deleted, true);
  assert.equal(store.getReminder(rem.reminder_id, tenantA, sharedUserId), null);
});

test('restart persistence retains tenant scope', () => {
  const dir = tempDir();
  const store = new PersonalReminderStore(dir);
  const remA = store.createReminder({ tenant_id: tenantA, user_id: sharedUserId, title: 'Persisted A', scheduled_at: new Date().toISOString(), timezone: 'UTC' });
  store.createReminder({ tenant_id: tenantB, user_id: sharedUserId, title: 'Persisted B', scheduled_at: new Date().toISOString(), timezone: 'UTC' });

  const freshStore = new PersonalReminderStore(dir);
  assert.equal(freshStore.listReminders(tenantA, sharedUserId).length, 1);
  assert.equal(freshStore.listReminders(tenantB, sharedUserId).length, 1);
  const reloadedA = freshStore.getReminder(remA.reminder_id, tenantA, sharedUserId);
  assert.ok(reloadedA);
  assert.equal(reloadedA!.tenant_id, tenantA);
  assert.equal(freshStore.getReminder(remA.reminder_id, tenantB, sharedUserId), null, 'tenant scope must survive a restart, not just an in-memory instance');
});

test('legacy backfill: a pre-migration record with no tenant_id is durably assigned to the canonical default tenant, never visible to every tenant sharing user_id', () => {
  const dir = tempDir();
  const legacyId = 'rem_legacy_no_tenant';
  const filePath = path.join(dir, 'personal_reminders.json');
  fs.writeFileSync(filePath, JSON.stringify([
    {
      reminder_id: legacyId,
      user_id: sharedUserId,
      title: 'Pre-migration reminder',
      scheduled_at: new Date().toISOString(),
      timezone: 'UTC',
      status: 'ACTIVE',
      created_at: new Date().toISOString(),
    },
  ], null, 2));

  const store = new PersonalReminderStore(dir);
  const legacyUnderDefault = store.getReminder(legacyId, 'ten_production_01', sharedUserId);
  assert.ok(legacyUnderDefault, 'a legacy record must be reachable under the defined legacy/default tenant');

  const legacyUnderOtherTenant = store.getReminder(legacyId, tenantA, sharedUserId);
  assert.equal(legacyUnderOtherTenant, null, 'a legacy record must NOT become visible to every tenant sharing user_id — only the one defined legacy/default tenant');

  // The backfill must be durable — a fresh instance over the same file
  // must not need to re-migrate or duplicate the record.
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  assert.equal(raw.length, 1);
  assert.equal(raw[0].tenant_id, 'ten_production_01');

  const freshStore = new PersonalReminderStore(dir);
  assert.equal(freshStore.listReminders('ten_production_01', sharedUserId).length, 1);
});

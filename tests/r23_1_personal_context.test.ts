// R23.1 — Personal Context Aggregation.
//
// CurrentPersonalContextService is the ONE canonical Calendar/Task/
// Reminder/Approval/Inbox/Vault/Memory aggregation pipeline
// (CONTEXT_AGGREGATION_PIPELINE_COUNT=1). Every test here exercises the
// real, file-backed canonical stores — only Calendar/Gmail transport is
// faked (same pattern used throughout this suite), never a hand-rolled
// stand-in for the stores actually under test. Read/aggregate only: no
// test here ever asserts a mutation of a source store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CurrentPersonalContextService } from '../src/personal/current-personal-context.service.js';
import { PersonalHomeService } from '../src/home/personal-home.service.js';
import { TaskStore } from '../src/tasks/task.store.js';
import { PersonalReminderStore } from '../src/personal/personal-reminder.store.js';
import { PersistentActionApprovalStore } from '../src/governance/action-approval.store.js';
import { CaptureStore } from '../src/workspace/capture.store.js';
import { VaultStore } from '../src/workspace/vault.store.js';
import { MemoryEngine } from '../src/context/memory.engine.js';
import { PersonalContextService } from '../src/context/personal-context.service.js';
import type { GoogleCalendarService } from '../src/modules/calendar/index.js';
import type { GmailService } from '../src/modules/gmail/index.js';
import type { UpcomingCalendarEvent } from '../src/modules/calendar/calendar.client.js';

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fakeCalendar(events: UpcomingCalendarEvent[] | (() => Promise<UpcomingCalendarEvent[]>)): GoogleCalendarService {
  return {
    listUpcomingEvents: typeof events === 'function' ? events : async () => events,
  } as unknown as GoogleCalendarService;
}

function fakeGmail(impl?: (query: string) => Promise<{ threads: Array<{ threadId: string; snippet: string; historyId: string | null }> }>): GmailService {
  return {
    search: async (input: { query: string }) => impl ? impl(input.query) : { threads: [] },
  } as unknown as GmailService;
}

function calendarEvent(overrides: Partial<UpcomingCalendarEvent> = {}): UpcomingCalendarEvent {
  return {
    id: 'evt_default',
    title: 'Default Event',
    start: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    end: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    status: 'confirmed',
    updated: null,
    attendees: [],
    ...overrides,
  };
}

interface Harness {
  service: CurrentPersonalContextService;
  taskStore: TaskStore;
  personalReminderStore: PersonalReminderStore;
  actionApprovals: PersistentActionApprovalStore;
  captureStore: CaptureStore;
  vaultStore: VaultStore;
  memoryEngine: MemoryEngine;
  personalContextService: PersonalContextService;
}

function buildHarness(overrides: { googleCalendarService?: GoogleCalendarService; gmailService?: GmailService } = {}): Harness {
  const dir = tempDir('nagex-r23-1-');
  const taskStore = new TaskStore({ dir: path.join(dir, 'tasks') });
  const personalReminderStore = new PersonalReminderStore(path.join(dir, 'reminders'));
  const actionApprovals = new PersistentActionApprovalStore({ dir: path.join(dir, 'approvals') });
  const captureStore = new CaptureStore(path.join(dir, 'captures'));
  const vaultStore = new VaultStore();
  const memoryEngine = new MemoryEngine({ dir: path.join(dir, 'memories') });
  const personalContextService = new PersonalContextService(memoryEngine);

  const googleCalendarService = overrides.googleCalendarService ?? fakeCalendar([]);
  const gmailService = overrides.gmailService ?? fakeGmail();

  const service = new CurrentPersonalContextService({
    googleCalendarService,
    gmailService,
    taskStore,
    personalReminderStore,
    actionApprovals,
    captureStore,
    vaultStore,
    personalContextService,
  });

  return { service, taskStore, personalReminderStore, actionApprovals, captureStore, vaultStore, memoryEngine, personalContextService };
}

const tenantId = 'ten_r23_1';
const userId = 'usr_r23_1';

test('1. aggregates real Calendar + task + reminder', async () => {
  const h = buildHarness({
    googleCalendarService: fakeCalendar([calendarEvent({ id: 'evt_sync', title: 'Team Sync' })]),
  });
  h.taskStore.create({ tenantId, ownerId: userId, name: 'Write report', objective: 'Write the report', type: 'ONE_TIME', trigger: { type: 'MANUAL' } });
  h.personalReminderStore.createReminder({ user_id: userId, title: 'Call the client', scheduled_at: new Date().toISOString(), timezone: 'UTC' });

  const ctx = await h.service.buildCurrentContext({ tenantId, userId });

  assert.equal(ctx.today.events.length, 1);
  assert.equal(ctx.today.events[0].title, 'Team Sync');
  assert.equal(ctx.today.tasks.length, 1);
  assert.equal(ctx.today.tasks[0].name, 'Write report');
  assert.equal(ctx.rightNow.reminders.length, 1);
  assert.equal(ctx.rightNow.reminders[0].title, 'Call the client');
});

test('2. nearest event selected correctly', async () => {
  const later = calendarEvent({ id: 'evt_later', title: 'Later Meeting', start: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(), end: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString() });
  const nearer = calendarEvent({ id: 'evt_nearer', title: 'Nearer Meeting', start: new Date(Date.now() + 20 * 60 * 1000).toISOString(), end: new Date(Date.now() + 40 * 60 * 1000).toISOString() });
  const h = buildHarness({ googleCalendarService: fakeCalendar([later, nearer]) });

  const ctx = await h.service.buildCurrentContext({ tenantId, userId });

  assert.equal(ctx.rightNow.nextEvent?.id, 'evt_nearer', 'the nearest upcoming event must be chosen regardless of API return order');
});

test('3. past event excluded', async () => {
  const past = calendarEvent({ id: 'evt_past', title: 'Past Standup', start: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), end: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() });
  const future = calendarEvent({ id: 'evt_future', title: 'Future Sync' });
  const h = buildHarness({ googleCalendarService: fakeCalendar([past, future]) });

  const ctx = await h.service.buildCurrentContext({ tenantId, userId });

  assert.equal(ctx.today.events.length, 1);
  assert.equal(ctx.today.events[0].id, 'evt_future');
  assert.ok(!ctx.today.events.some((e) => e.id === 'evt_past'), 'a past (already-ended) event must never appear as current/upcoming');
});

test('4. related Gmail grounded by attendee', async () => {
  const event = calendarEvent({ id: 'evt_client', title: 'Client Call', attendees: ['alice@example.com'] });
  let capturedQuery = '';
  const h = buildHarness({
    googleCalendarService: fakeCalendar([event]),
    gmailService: fakeGmail(async (query) => {
      capturedQuery = query;
      return { threads: [{ threadId: 'thr_alice_1', snippet: 'Following up on the proposal.', historyId: null }] };
    }),
  });

  const ctx = await h.service.buildCurrentContext({ tenantId, userId });

  assert.match(capturedQuery, /alice@example\.com/, 'the Gmail search must be grounded in the real attendee email');
  assert.equal(ctx.relatedContext.emails.length, 1);
  assert.equal(ctx.relatedContext.emails[0].threadId, 'thr_alice_1');
  assert.equal(ctx.relatedContext.emails[0].relatedToEventId, 'evt_client');
  assert.equal(ctx.relatedContext.emails[0].sourceTrace.type, 'GMAIL');
});

test('5. related Vault grounded', async () => {
  const event = calendarEvent({ id: 'evt_alice_review', title: 'Contract Review', attendees: ['alice@example.com'] });
  const h = buildHarness({ googleCalendarService: fakeCalendar([event]) });
  const saved = h.vaultStore.saveItem({ tenantId, userId, type: 'DOCUMENT', title: 'Alice Contract Draft', storageRef: 'ref_1' });
  h.vaultStore.saveItem({ tenantId, userId, type: 'DOCUMENT', title: 'Unrelated Recipe', storageRef: 'ref_2' });

  const ctx = await h.service.buildCurrentContext({ tenantId, userId });

  assert.equal(ctx.relatedContext.vaultItems.length, 1);
  assert.equal(ctx.relatedContext.vaultItems[0].id, saved.vaultItemId);
  assert.equal(ctx.relatedContext.vaultItems[0].relatedToEventId, 'evt_alice_review');
});

test('6. ACTIVE Memory included', async () => {
  const event = calendarEvent({ id: 'evt_qbr', title: 'Quarterly Business Review' });
  const h = buildHarness({ googleCalendarService: fakeCalendar([event]) });
  const mem = h.memoryEngine.proposeMemory('USER', tenantId, userId, { subject: 'Quarterly', predicate: 'context', value: 'Business Review prep notes' }, undefined, { userConfirmed: true });

  const ctx = await h.service.buildCurrentContext({ tenantId, userId });

  assert.ok(ctx.relatedContext.memories.some((m) => m.id === mem.id), 'an ACTIVE memory sharing real content words with today context must be surfaced');
});

test('7. deleted/conflicted/unconfirmed-sensitive Memory excluded', async () => {
  const event = calendarEvent({ id: 'evt_secret_sync', title: 'Secret Project Sync' });
  const h = buildHarness({ googleCalendarService: fakeCalendar([event]) });

  const deleted = h.memoryEngine.proposeMemory('USER', tenantId, userId, { subject: 'Secret', predicate: 'context', value: 'Project notes to delete' }, undefined, { userConfirmed: true });
  h.memoryEngine.deleteMemory(deleted.id, tenantId, userId);

  // The second propose with a different value for the same subject/
  // predicate is the one that lands CONFLICTED — the first stays ACTIVE
  // until the conflict is resolved (R22.3's documented model).
  h.memoryEngine.proposeMemory('USER', tenantId, userId, { subject: 'Secret', predicate: 'context', value: 'Project first version' }, undefined, { userConfirmed: true });
  const conflicted = h.memoryEngine.proposeMemory('USER', tenantId, userId, { subject: 'Secret', predicate: 'context', value: 'Project conflicting version' }, undefined, { userConfirmed: true });
  assert.equal(conflicted.lifecycle, 'CONFLICTED', 'test setup sanity: the second differing propose must actually land CONFLICTED');

  const sensitive = h.memoryEngine.proposeMemory('USER', tenantId, userId, { subject: 'Secret', predicate: 'contact', value: 'reach me at secret.project@example.com' });

  const ctx = await h.service.buildCurrentContext({ tenantId, userId });

  const surfacedIds = ctx.relatedContext.memories.map((m) => m.id);
  assert.ok(!surfacedIds.includes(deleted.id), 'a DELETED memory must never be surfaced');
  assert.ok(!surfacedIds.includes(conflicted.id), 'a CONFLICTED memory must never be surfaced');
  assert.ok(!surfacedIds.includes(sensitive.id), 'an unconfirmed S2 memory must never be surfaced for proactive use');
  assert.equal(h.memoryEngine.getActiveMemories('USER', tenantId, userId).some((m) => m.id === sensitive.id), false, 'the S2 memory must genuinely never have reached ACTIVE');
});

test('8. pending approval surfaced', async () => {
  const h = buildHarness();
  const approval = h.actionApprovals.request({ toolId: 'gmail.send_email', tenantId, principalId: userId, payload: { to: 'x@example.com' } });

  const ctx = await h.service.buildCurrentContext({ tenantId, userId });

  assert.equal(ctx.rightNow.pendingApprovals.length, 1);
  assert.equal(ctx.rightNow.pendingApprovals[0].id, approval.approvalId);
  assert.ok(ctx.needsAttention.some((a) => a.kind === 'PENDING_APPROVAL' && a.sourceRef.id === approval.approvalId));
});

test('9. archived Inbox not treated as attention', async () => {
  const h = buildHarness();
  const needsReview = h.captureStore.createCapture({ ownerId: userId, tenantId, type: 'TEXT', content: 'Needs eyes' });
  h.captureStore.updateStatus(needsReview.captureId, tenantId, userId, 'NEEDS_REVIEW', { extractedTitle: 'Needs eyes capture' });

  const archived = h.captureStore.createCapture({ ownerId: userId, tenantId, type: 'TEXT', content: 'Old note' });
  h.captureStore.updateStatus(archived.captureId, tenantId, userId, 'ARCHIVED', { extractedTitle: 'Old archived note' });

  const actioned = h.captureStore.createCapture({ ownerId: userId, tenantId, type: 'TEXT', content: 'Done note' });
  h.captureStore.updateStatus(actioned.captureId, tenantId, userId, 'ACTIONED', { extractedTitle: 'Done actioned note' });

  const ctx = await h.service.buildCurrentContext({ tenantId, userId });

  assert.equal(ctx.today.importantInbox.length, 1);
  assert.equal(ctx.today.importantInbox[0].id, needsReview.captureId);
  assert.ok(!ctx.needsAttention.some((a) => a.sourceRef.id === archived.captureId), 'ARCHIVED content must never resurface as needing attention');
  assert.ok(!ctx.needsAttention.some((a) => a.sourceRef.id === actioned.captureId), 'ACTIONED content must never resurface as needing attention');
});

test('10. partial Gmail failure degrades honestly', async () => {
  const event = calendarEvent({ id: 'evt_with_attendee', title: 'Partner Sync', attendees: ['bob@example.com'] });
  const h = buildHarness({
    googleCalendarService: fakeCalendar([event]),
    gmailService: fakeGmail(async () => { throw new Error('Gmail connection failed'); }),
  });
  h.taskStore.create({ tenantId, ownerId: userId, name: 'Independent task', objective: 'Do the thing', type: 'ONE_TIME', trigger: { type: 'MANUAL' } });

  const ctx = await h.service.buildCurrentContext({ tenantId, userId });

  assert.equal(ctx.sourceStatus.gmail, 'UNAVAILABLE');
  assert.equal(ctx.relatedContext.emails.length, 0, 'no fabricated/stale email data when Gmail fails');
  // Other sources must still be retained — one optional source failing
  // must never fail the whole snapshot.
  assert.equal(ctx.sourceStatus.calendar, 'OK');
  assert.equal(ctx.today.events.length, 1);
  assert.equal(ctx.today.tasks.length, 1);
});

test('11. tenant isolation', async () => {
  const h = buildHarness();
  h.taskStore.create({ tenantId: 'ten_A', ownerId: userId, name: 'Tenant A task', objective: 'A', type: 'ONE_TIME', trigger: { type: 'MANUAL' } });
  h.actionApprovals.request({ toolId: 'gmail.send_email', tenantId: 'ten_A', principalId: userId, payload: {} });
  h.vaultStore.saveItem({ tenantId: 'ten_A', userId, type: 'DOCUMENT', title: 'Tenant A doc', storageRef: 'r1' });
  const capA = h.captureStore.createCapture({ ownerId: userId, tenantId: 'ten_A', type: 'TEXT', content: 'A' });
  h.captureStore.updateStatus(capA.captureId, 'ten_A', userId, 'NEEDS_REVIEW');

  const ctxB = await h.service.buildCurrentContext({ tenantId: 'ten_B', userId });

  assert.equal(ctxB.today.tasks.length, 0, 'tenant B must never see tenant A tasks');
  assert.equal(ctxB.rightNow.pendingApprovals.length, 0, 'tenant B must never see tenant A approvals');
  assert.equal(ctxB.today.importantInbox.length, 0, 'tenant B must never see tenant A inbox items');
});

test('12. user isolation', async () => {
  const h = buildHarness();
  h.taskStore.create({ tenantId, ownerId: 'usr_A', name: 'User A task', objective: 'A', type: 'ONE_TIME', trigger: { type: 'MANUAL' } });
  h.actionApprovals.request({ toolId: 'gmail.send_email', tenantId, principalId: 'usr_A', payload: {} });
  h.personalReminderStore.createReminder({ user_id: 'usr_A', title: 'User A reminder', scheduled_at: new Date().toISOString(), timezone: 'UTC' });
  const memA = h.memoryEngine.proposeMemory('USER', tenantId, 'usr_A', { subject: 'Private', predicate: 'note', value: 'user A only' }, undefined, { userConfirmed: true });

  const ctxB = await h.service.buildCurrentContext({ tenantId, userId: 'usr_B' });

  assert.equal(ctxB.today.tasks.length, 0, 'user B must never see user A tasks');
  assert.equal(ctxB.rightNow.pendingApprovals.length, 0, 'user B must never see user A approvals');
  assert.equal(ctxB.rightNow.reminders.length, 0, 'user B must never see user A reminders');
  assert.ok(!ctxB.relatedContext.memories.some((m) => m.id === memA.id), 'user B must never see user A memory');
});

test('13. no fabricated source', async () => {
  const event = calendarEvent({ id: 'evt_real', title: 'Real Sync' });
  const h = buildHarness({ googleCalendarService: fakeCalendar([event]) });
  const task = h.taskStore.create({ tenantId, ownerId: userId, name: 'Real task', objective: 'Real', type: 'ONE_TIME', trigger: { type: 'MANUAL' } });
  const approval = h.actionApprovals.request({ toolId: 'gmail.send_email', tenantId, principalId: userId, payload: {} });

  const ctx = await h.service.buildCurrentContext({ tenantId, userId });

  // Every sourceTrace must reference a real id we actually created — never
  // a synthesized/random one.
  const traceIds = new Set(ctx.sourceTraces.map((t) => t.sourceId));
  assert.ok(traceIds.has('evt_real'));
  assert.ok(traceIds.has(task.taskId));
  assert.ok(traceIds.has(approval.approvalId));
  for (const trace of ctx.sourceTraces) {
    assert.ok(trace.sourceId && trace.sourceId.length > 0, 'every sourceTrace must carry a real, non-empty sourceId');
    assert.ok(['CALENDAR', 'GMAIL', 'TASK', 'REMINDER', 'APPROVAL', 'INBOX', 'VAULT', 'MEMORY'].includes(trace.type));
  }
});

test('14. no duplicate context items', async () => {
  const h = buildHarness({ googleCalendarService: fakeCalendar([calendarEvent({ id: 'evt_dup_check' })]) });
  h.taskStore.create({ tenantId, ownerId: userId, name: 'Task one', objective: 'X', type: 'ONE_TIME', trigger: { type: 'MANUAL' } });
  h.taskStore.create({ tenantId, ownerId: userId, name: 'Task two', objective: 'Y', type: 'ONE_TIME', trigger: { type: 'MANUAL' } });

  const ctx = await h.service.buildCurrentContext({ tenantId, userId });

  const eventIds = ctx.today.events.map((e) => e.id);
  assert.equal(new Set(eventIds).size, eventIds.length);
  const taskIds = ctx.today.tasks.map((t) => t.id);
  assert.equal(new Set(taskIds).size, taskIds.length);
  const traceKeys = ctx.sourceTraces.map((t) => `${t.type}:${t.sourceId}`);
  assert.equal(new Set(traceKeys).size, traceKeys.length, 'sourceTraces must never contain the same (type, sourceId) twice');
});

test('15. deterministic ordering', async () => {
  const events = [
    calendarEvent({ id: 'evt_b', title: 'B', start: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(), end: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString() }),
    calendarEvent({ id: 'evt_a', title: 'A', start: new Date(Date.now() + 30 * 60 * 1000).toISOString(), end: new Date(Date.now() + 45 * 60 * 1000).toISOString() }),
  ];
  const h = buildHarness({ googleCalendarService: fakeCalendar(events) });
  h.taskStore.create({ tenantId, ownerId: userId, name: 'Ordering task 1', objective: 'X', type: 'ONE_TIME', trigger: { type: 'MANUAL' } });
  h.taskStore.create({ tenantId, ownerId: userId, name: 'Ordering task 2', objective: 'Y', type: 'ONE_TIME', trigger: { type: 'MANUAL' } });

  const ctx1 = await h.service.buildCurrentContext({ tenantId, userId });
  const ctx2 = await h.service.buildCurrentContext({ tenantId, userId });

  assert.deepEqual(ctx1.today.events.map((e) => e.id), ctx2.today.events.map((e) => e.id));
  assert.deepEqual(ctx1.today.events.map((e) => e.id), ['evt_a', 'evt_b'], 'events must be ordered earliest-start-first, deterministically');
  assert.deepEqual(ctx1.today.tasks.map((t) => t.id), ctx2.today.tasks.map((t) => t.id));
});

test('16. no mutation of underlying stores', async () => {
  const h = buildHarness({ googleCalendarService: fakeCalendar([calendarEvent({ id: 'evt_no_mutate' })]) });
  h.taskStore.create({ tenantId, ownerId: userId, name: 'Immutable task', objective: 'X', type: 'ONE_TIME', trigger: { type: 'MANUAL' } });
  h.actionApprovals.request({ toolId: 'gmail.send_email', tenantId, principalId: userId, payload: {} });
  const cap = h.captureStore.createCapture({ ownerId: userId, tenantId, type: 'TEXT', content: 'Untouched' });
  h.captureStore.updateStatus(cap.captureId, tenantId, userId, 'NEEDS_REVIEW');
  h.vaultStore.saveItem({ tenantId, userId, type: 'DOCUMENT', title: 'Untouched vault item', storageRef: 'r1' });
  h.memoryEngine.proposeMemory('USER', tenantId, userId, { subject: 'X', predicate: 'note', value: 'untouched' }, undefined, { userConfirmed: true });

  const before = {
    tasks: h.taskStore.list(tenantId, userId),
    approvals: h.actionApprovals.listPending(tenantId, userId),
    captures: h.captureStore.listCaptures(tenantId, userId),
    vault: h.vaultStore.listItems(tenantId, userId),
    memories: h.memoryEngine.getActiveMemories('USER', tenantId, userId),
  };

  await h.service.buildCurrentContext({ tenantId, userId });
  await h.service.buildCurrentContext({ tenantId, userId });

  const after = {
    tasks: h.taskStore.list(tenantId, userId),
    approvals: h.actionApprovals.listPending(tenantId, userId),
    captures: h.captureStore.listCaptures(tenantId, userId),
    vault: h.vaultStore.listItems(tenantId, userId),
    memories: h.memoryEngine.getActiveMemories('USER', tenantId, userId),
  };

  assert.deepEqual(before, after, 'buildCurrentContext must never mutate any underlying source store');
});

test('17. PersonalHome integration uses the same canonical aggregation path', async () => {
  const h = buildHarness({ googleCalendarService: fakeCalendar([calendarEvent({ id: 'evt_shared_pipeline' })]) });
  let callCount = 0;
  const originalBuild = h.service.buildCurrentContext.bind(h.service);
  (h.service as any).buildCurrentContext = async (...args: Parameters<typeof originalBuild>) => {
    callCount += 1;
    return originalBuild(...args);
  };

  const homeService = new PersonalHomeService({ currentPersonalContextService: h.service });
  const res = await homeService.getPersonalHome({ tenantId, principalId: userId });

  assert.equal(callCount, 1, 'PersonalHomeService must call the exact same CurrentPersonalContextService instance, never a parallel aggregation path');
  assert.equal(res.sourceStatus.calendar, 'CONNECTED');
  assert.equal(res.today.meetings.length, 1);
  assert.equal(res.today.meetings[0].id, 'evt_shared_pipeline');
});

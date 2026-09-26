// R23.2 — Right Now / Today Intelligence.
//
// RightNowIntelligenceService is the ONE canonical prioritization pipeline
// over the R23.1 CurrentPersonalContext snapshot
// (RIGHT_NOW_INTELLIGENCE_PIPELINE_COUNT=1). It never queries Calendar,
// Gmail, TaskStore, Memory, Vault, Inbox, Reminder, or Approval stores
// directly — every fact here comes from a real CurrentPersonalContextService
// snapshot built by the same real, file-backed canonical stores used
// throughout tests/r23_1_personal_context.test.ts (only Calendar/Gmail
// transport is faked). No test here ever asserts a mutation of a source
// store, and no test constructs an AiService/model router — this layer
// makes no provider/model call at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CurrentPersonalContextService, type CurrentPersonalContext } from '../src/personal/current-personal-context.service.js';
import { RightNowIntelligenceService } from '../src/personal/right-now-intelligence.service.js';
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

function fakeCalendar(events: UpcomingCalendarEvent[]): GoogleCalendarService {
  return { listUpcomingEvents: async () => events } as unknown as GoogleCalendarService;
}

function fakeGmail(): GmailService {
  return { search: async () => ({ threads: [] }) } as unknown as GmailService;
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
  contextService: CurrentPersonalContextService;
  service: RightNowIntelligenceService;
  taskStore: TaskStore;
  personalReminderStore: PersonalReminderStore;
  actionApprovals: PersistentActionApprovalStore;
  captureStore: CaptureStore;
  vaultStore: VaultStore;
  memoryEngine: MemoryEngine;
}

function buildHarness(overrides: { googleCalendarService?: GoogleCalendarService; gmailService?: GmailService } = {}): Harness {
  const dir = tempDir('nagex-r23-2-');
  const taskStore = new TaskStore({ dir: path.join(dir, 'tasks') });
  const personalReminderStore = new PersonalReminderStore(path.join(dir, 'reminders'));
  const actionApprovals = new PersistentActionApprovalStore({ dir: path.join(dir, 'approvals') });
  const captureStore = new CaptureStore(path.join(dir, 'captures'));
  const vaultStore = new VaultStore();
  const memoryEngine = new MemoryEngine({ dir: path.join(dir, 'memories') });
  const personalContextService = new PersonalContextService(memoryEngine);

  const contextService = new CurrentPersonalContextService({
    googleCalendarService: overrides.googleCalendarService ?? fakeCalendar([]),
    gmailService: overrides.gmailService ?? fakeGmail(),
    taskStore,
    personalReminderStore,
    actionApprovals,
    captureStore,
    vaultStore,
    personalContextService,
  });

  // No AiService / model router anywhere in this harness — structural proof
  // that RightNowIntelligenceService needs, and makes, no model call.
  const service = new RightNowIntelligenceService({ currentPersonalContextService: contextService });

  return { contextService, service, taskStore, personalReminderStore, actionApprovals, captureStore, vaultStore, memoryEngine };
}

const tenantId = 'ten_r23_2';
const userId = 'usr_r23_2';

// ─── 1. ongoing meeting becomes primary ───

test('1. ongoing meeting becomes primary', async () => {
  const h = buildHarness({
    googleCalendarService: fakeCalendar([
      calendarEvent({ id: 'evt_ongoing', title: 'Ongoing Sync', start: new Date(Date.now() - 5 * 60 * 1000).toISOString(), end: new Date(Date.now() + 25 * 60 * 1000).toISOString() }),
    ]),
  });
  const intel = await h.service.buildRightNow({ tenantId, userId });

  assert.ok(intel.primary);
  assert.equal(intel.primary?.kind, 'MEETING');
  assert.equal(intel.primary?.priorityClass, 'P0');
  assert.equal(intel.primary?.reason, 'In progress now');
  assert.equal(intel.primary?.sourceRef.id, 'evt_ongoing');
});

// ─── 2. near-term meeting becomes primary ───

test('2. near-term meeting becomes primary', async () => {
  const h = buildHarness({
    googleCalendarService: fakeCalendar([
      calendarEvent({ id: 'evt_soon', title: 'Client Sync', start: new Date(Date.now() + 20 * 60 * 1000).toISOString(), end: new Date(Date.now() + 50 * 60 * 1000).toISOString() }),
    ]),
  });
  const intel = await h.service.buildRightNow({ tenantId, userId });

  assert.ok(intel.primary);
  assert.equal(intel.primary?.kind, 'MEETING');
  assert.equal(intel.primary?.priorityClass, 'P1');
  assert.match(intel.primary!.reason, /^Starts in \d+ minutes?$/);
});

// ─── 3. later meeting does not beat due reminder ───

test('3. later meeting does not beat due reminder', async () => {
  const h = buildHarness({
    googleCalendarService: fakeCalendar([
      calendarEvent({ id: 'evt_later', title: 'Afternoon Review', start: new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString(), end: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString() }),
    ]),
  });
  h.personalReminderStore.createReminder({
    tenant_id: tenantId, user_id: userId, title: 'Call the client', scheduled_at: new Date(Date.now() - 2 * 60 * 1000).toISOString(), timezone: 'UTC',
  });

  const intel = await h.service.buildRightNow({ tenantId, userId });

  assert.equal(intel.primary?.kind, 'REMINDER');
  assert.equal(intel.primary?.priorityClass, 'P0');
  assert.equal(intel.primary?.title, 'Call the client');
});

// ─── 4. overdue reminder outranks later event ───

test('4. overdue reminder outranks later event', async () => {
  const h = buildHarness({
    googleCalendarService: fakeCalendar([
      calendarEvent({ id: 'evt_near', title: 'Near-term standup', start: new Date(Date.now() + 10 * 60 * 1000).toISOString(), end: new Date(Date.now() + 25 * 60 * 1000).toISOString() }),
    ]),
  });
  h.personalReminderStore.createReminder({
    tenant_id: tenantId, user_id: userId, title: 'Overdue follow-up', scheduled_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(), timezone: 'UTC',
  });

  const intel = await h.service.buildRightNow({ tenantId, userId });

  assert.equal(intel.primary?.kind, 'REMINDER');
  assert.equal(intel.primary?.title, 'Overdue follow-up');
  assert.match(intel.primary!.reason, /^Overdue by \d+ minutes?$/);
  // The near-term (P1) meeting must still be present, just not primary.
  assert.ok(intel.upcoming.some((i) => i.sourceRef.id === 'evt_near'));
});

// ─── 5. RUNNING task can surface as immediate ───

test('5. RUNNING task can surface as immediate', async () => {
  const h = buildHarness();
  const created = h.taskStore.create({ tenantId, ownerId: userId, name: 'Sync export', objective: 'Export the report', type: 'ONE_TIME', trigger: { type: 'MANUAL' } });
  h.taskStore.markRunning(created.taskId);

  const intel = await h.service.buildRightNow({ tenantId, userId });

  assert.equal(intel.primary?.kind, 'TASK');
  assert.equal(intel.primary?.priorityClass, 'P0');
  assert.equal(intel.primary?.reason, 'Task is currently running');
  assert.equal(intel.primary?.sourceRef.id, created.taskId);
});

// ─── 6. pending approval appears in needs attention ───

test('6. pending approval appears in needs attention', async () => {
  const h = buildHarness();
  const approval = h.actionApprovals.request({ toolId: 'GMAIL_SEND', tenantId, principalId: userId, payload: {} });

  const intel = await h.service.buildRightNow({ tenantId, userId });

  assert.ok(intel.needsAttention.some((a) => a.kind === 'PENDING_APPROVAL' && a.sourceRef.id === approval.approvalId));
  // Also ranked as a P2 candidate (visible via primary/upcoming since
  // nothing else outranks it here).
  assert.equal(intel.primary?.kind, 'APPROVAL');
  assert.equal(intel.primary?.priorityClass, 'P2');
});

// ─── 7. NEEDS_REVIEW Inbox item appears ───

test('7. NEEDS_REVIEW Inbox item appears', async () => {
  const h = buildHarness();
  const capture = h.captureStore.createCapture({ ownerId: userId, tenantId, type: 'TEXT', content: 'Look at this' });
  h.captureStore.updateStatus(capture.captureId, tenantId, userId, 'NEEDS_REVIEW', { extractedTitle: 'Look at this capture' });

  const intel = await h.service.buildRightNow({ tenantId, userId });

  assert.equal(intel.primary?.kind, 'INBOX');
  assert.equal(intel.primary?.reason, 'Needs your review');
  assert.equal(intel.primary?.sourceRef.id, capture.captureId);
});

// ─── 8. ARCHIVED/ACTIONED Inbox item excluded ───

test('8. ARCHIVED/ACTIONED Inbox item excluded', async () => {
  const h = buildHarness();
  const archived = h.captureStore.createCapture({ ownerId: userId, tenantId, type: 'TEXT', content: 'Old' });
  h.captureStore.updateStatus(archived.captureId, tenantId, userId, 'ARCHIVED', { extractedTitle: 'Old archived' });
  const actioned = h.captureStore.createCapture({ ownerId: userId, tenantId, type: 'TEXT', content: 'Done' });
  h.captureStore.updateStatus(actioned.captureId, tenantId, userId, 'ACTIONED', { extractedTitle: 'Done actioned' });

  const intel = await h.service.buildRightNow({ tenantId, userId });

  assert.equal(intel.primary, null);
  assert.equal(intel.today.length, 0);
  assert.ok(!intel.needsAttention.some((a) => a.sourceRef.id === archived.captureId));
  assert.ok(!intel.needsAttention.some((a) => a.sourceRef.id === actioned.captureId));
});

// ─── 9. related Vault/email/memory never outranks primary source ───

test('9. related Vault/email/memory never outranks primary source', async () => {
  const event = calendarEvent({ id: 'evt_prep', title: 'Client strategy meeting', start: new Date(Date.now() + 10 * 60 * 1000).toISOString(), end: new Date(Date.now() + 40 * 60 * 1000).toISOString(), attendees: ['bob@example.com'] });
  const h = buildHarness({
    googleCalendarService: fakeCalendar([event]),
    gmailService: { search: async () => ({ threads: [{ threadId: 'th_1', snippet: 'Re: strategy', historyId: null }] }) } as unknown as GmailService,
  });
  h.vaultStore.saveItem({ tenantId, userId, title: 'Bob Proposal v3', type: 'DOCUMENT', storageRef: 'ref_prop_v3' });

  const intel = await h.service.buildRightNow({ tenantId, userId });

  assert.equal(intel.primary?.kind, 'MEETING');
  // Related-context items are consumed only for suggestions/sourceTraces —
  // they never appear as a competing primary/upcoming/today candidate kind.
  assert.ok(!intel.upcoming.some((i) => i.sourceRef.type === 'GMAIL' || i.sourceRef.type === 'VAULT'));
  assert.ok(!intel.today.some((i) => i.sourceRef.type === 'GMAIL' || i.sourceRef.type === 'VAULT'));
});

// ─── 10. suggestion generated only from grounded context ───

test('10. suggestion generated only from grounded context', async () => {
  const event = calendarEvent({ id: 'evt_grounded', title: 'Client strategy meeting', start: new Date(Date.now() + 10 * 60 * 1000).toISOString(), end: new Date(Date.now() + 40 * 60 * 1000).toISOString(), attendees: ['bob@example.com'] });
  const h = buildHarness({
    googleCalendarService: fakeCalendar([event]),
    gmailService: { search: async () => ({ threads: [{ threadId: 'th_grounded', snippet: 'Re: strategy', historyId: null }] }) } as unknown as GmailService,
  });

  const intel = await h.service.buildRightNow({ tenantId, userId });

  const prep = intel.suggestions.find((s) => s.kind === 'MEETING_PREP');
  assert.ok(prep, 'a grounded MEETING_PREP suggestion must be produced');
  assert.ok(prep!.sourceRefs.some((r) => r.type === 'CALENDAR' && r.id === 'evt_grounded'));
  assert.ok(prep!.sourceRefs.some((r) => r.type === 'GMAIL' && r.id === 'th_grounded'));
  assert.match(prep!.reason, /starts in \d+ minutes/i);
});

// ─── 11. no suggestion when nothing actionable exists ───

test('11. no suggestion when nothing actionable exists', async () => {
  const h = buildHarness({
    googleCalendarService: fakeCalendar([calendarEvent({ id: 'evt_no_material', start: new Date(Date.now() + 10 * 60 * 1000).toISOString(), end: new Date(Date.now() + 40 * 60 * 1000).toISOString() })]),
  });

  const intel = await h.service.buildRightNow({ tenantId, userId });

  assert.deepEqual(intel.suggestions, []);
});

// ─── 12. source trace required for every output item ───

test('12. source trace required for every output item', async () => {
  const h = buildHarness({
    googleCalendarService: fakeCalendar([calendarEvent({ id: 'evt_trace', start: new Date(Date.now() + 5 * 60 * 1000).toISOString(), end: new Date(Date.now() + 35 * 60 * 1000).toISOString() })]),
  });
  h.personalReminderStore.createReminder({ tenant_id: tenantId, user_id: userId, title: 'Trace check', scheduled_at: new Date().toISOString(), timezone: 'UTC' });
  h.actionApprovals.request({ toolId: 'CALENDAR_CREATE_EVENT', tenantId, principalId: userId, payload: {} });

  const intel = await h.service.buildRightNow({ tenantId, userId });

  assert.ok(intel.primary?.sourceRef.id);
  for (const item of intel.upcoming) assert.ok(item.sourceRef.id, `upcoming item ${item.title} missing sourceRef.id`);
  for (const item of intel.today) assert.ok(item.sourceRef.id, `today item ${item.title} missing sourceRef.id`);
  for (const item of intel.needsAttention) assert.ok(item.sourceRef.id, `needsAttention item ${item.title} missing sourceRef.id`);
  for (const s of intel.suggestions) assert.ok(s.sourceRefs.length > 0, `suggestion ${s.kind} missing sourceRefs`);
});

// ─── 13. tenant isolation preserved ───

test('13. tenant isolation preserved', async () => {
  const h = buildHarness();
  h.actionApprovals.request({ toolId: 'GMAIL_SEND', tenantId: 'ten_A', principalId: userId, payload: {} });

  const intelA = await h.service.buildRightNow({ tenantId: 'ten_A', userId });
  const intelB = await h.service.buildRightNow({ tenantId: 'ten_B', userId });

  assert.ok(intelA.primary);
  assert.equal(intelB.primary, null, 'tenant B must never see tenant A\'s approval (CROSS_TENANT_LEAK=0)');
});

// ─── 14. user isolation preserved ───

test('14. user isolation preserved', async () => {
  const h = buildHarness();
  h.actionApprovals.request({ toolId: 'GMAIL_SEND', tenantId, principalId: 'usr_A', payload: {} });

  const intelA = await h.service.buildRightNow({ tenantId, userId: 'usr_A' });
  const intelB = await h.service.buildRightNow({ tenantId, userId: 'usr_B' });

  assert.ok(intelA.primary);
  assert.equal(intelB.primary, null, 'user B must never see user A\'s approval (CROSS_USER_LEAK=0)');
});

// ─── 15. same input + now produces same ordering ───

test('15. same input + now produces same ordering (RIGHT_NOW_DETERMINISTIC=1)', async () => {
  const now = new Date('2026-09-22T09:00:00.000Z');
  const h = buildHarness({
    googleCalendarService: fakeCalendar([
      calendarEvent({ id: 'evt_a', start: new Date(now.getTime() + 10 * 60 * 1000).toISOString(), end: new Date(now.getTime() + 40 * 60 * 1000).toISOString() }),
      calendarEvent({ id: 'evt_b', start: new Date(now.getTime() + 20 * 60 * 1000).toISOString(), end: new Date(now.getTime() + 50 * 60 * 1000).toISOString() }),
    ]),
  });
  h.personalReminderStore.createReminder({ tenant_id: tenantId, user_id: userId, title: 'Determinism check', scheduled_at: new Date(now.getTime() - 60 * 1000).toISOString(), timezone: 'UTC' });

  const context1 = await h.contextService.buildCurrentContext({ tenantId, userId, now });
  const context2 = await h.contextService.buildCurrentContext({ tenantId, userId, now });
  const intel1 = h.service.evaluate(context1);
  const intel2 = h.service.evaluate(context2);

  assert.deepEqual(intel1.primary, intel2.primary);
  assert.deepEqual(intel1.upcoming, intel2.upcoming);
  assert.deepEqual(intel1.today, intel2.today);
});

// ─── 16. tie ordering deterministic ───

test('16. tie ordering deterministic (explicit tie-breakers: priority class -> timestamp -> source type order -> id)', async () => {
  const now = new Date('2026-09-22T09:00:00.000Z');
  const h = buildHarness({
    googleCalendarService: fakeCalendar([
      calendarEvent({ id: 'evt_tie', start: now.toISOString(), end: new Date(now.getTime() + 30 * 60 * 1000).toISOString() }),
    ]),
  });
  // Same priority class (P0, both due exactly "now") and same timestamp as
  // the event above — only the canonical source-type order tie-break
  // (REMINDER before CALENDAR) can decide the winner.
  h.personalReminderStore.createReminder({ tenant_id: tenantId, user_id: userId, title: 'Tie reminder', scheduled_at: now.toISOString(), timezone: 'UTC' });

  const context = await h.contextService.buildCurrentContext({ tenantId, userId, now });
  const intel1 = h.service.evaluate(context);
  const intel2 = h.service.evaluate(context);

  assert.equal(intel1.primary?.kind, 'REMINDER');
  assert.deepEqual(intel1.primary, intel2.primary, 'identical input must always resolve the tie the same way');
});

// ─── 17. no store mutation ───

test('17. no store mutation', async () => {
  const h = buildHarness({
    googleCalendarService: fakeCalendar([calendarEvent({ id: 'evt_ro', start: new Date(Date.now() + 5 * 60 * 1000).toISOString(), end: new Date(Date.now() + 35 * 60 * 1000).toISOString() })]),
  });
  const created = h.taskStore.create({ tenantId, ownerId: userId, name: 'RO check', objective: 'x', type: 'ONE_TIME', trigger: { type: 'MANUAL' } });
  h.personalReminderStore.createReminder({ tenant_id: tenantId, user_id: userId, title: 'RO reminder', scheduled_at: new Date().toISOString(), timezone: 'UTC' });
  h.actionApprovals.request({ toolId: 'GMAIL_SEND', tenantId, principalId: userId, payload: {} });

  const tasksBefore = JSON.stringify(h.taskStore.list(tenantId, userId));
  const remindersBefore = JSON.stringify(h.personalReminderStore.listReminders(tenantId, userId));
  const approvalsBefore = JSON.stringify(h.actionApprovals.listPending(tenantId, userId));

  await h.service.buildRightNow({ tenantId, userId });
  await h.service.buildRightNow({ tenantId, userId });

  assert.equal(JSON.stringify(h.taskStore.list(tenantId, userId)), tasksBefore);
  assert.equal(JSON.stringify(h.personalReminderStore.listReminders(tenantId, userId)), remindersBefore);
  assert.equal(JSON.stringify(h.actionApprovals.listPending(tenantId, userId)), approvalsBefore);
  assert.ok(created.taskId);
});

// ─── 18. PersonalHome consumes canonical intelligence path ───

test('18. PersonalHome consumes canonical intelligence path (RIGHT_NOW_INTELLIGENCE_PIPELINE_COUNT=1)', async () => {
  const h = buildHarness({
    googleCalendarService: fakeCalendar([calendarEvent({ id: 'evt_home', start: new Date(Date.now() + 10 * 60 * 1000).toISOString(), end: new Date(Date.now() + 40 * 60 * 1000).toISOString() })]),
  });
  let evaluateCallCount = 0;
  const originalEvaluate = h.service.evaluate.bind(h.service);
  (h.service as any).evaluate = (context: CurrentPersonalContext) => {
    evaluateCallCount += 1;
    return originalEvaluate(context);
  };

  const homeService = new PersonalHomeService({ currentPersonalContextService: h.contextService, rightNowIntelligenceService: h.service });
  const res = await homeService.getPersonalHome({ tenantId, principalId: userId });

  assert.equal(evaluateCallCount, 1, 'PersonalHomeService must call evaluate() exactly once per request, never a second parallel ranking path');
  assert.equal(res.rightNow?.type, 'MEETING');
  assert.equal(res.rightNow?.sourceRef, 'evt_home');
});

// ─── 19. empty state truthful ───

test('19. empty state truthful', async () => {
  const h = buildHarness();
  const intel = await h.service.buildRightNow({ tenantId, userId });

  assert.equal(intel.primary, null);
  assert.deepEqual(intel.upcoming, []);
  assert.deepEqual(intel.today, []);
  assert.deepEqual(intel.needsAttention, []);
  assert.deepEqual(intel.suggestions, []);
  assert.ok(intel.generatedAt);
});

// ─── 20. no provider/model call ───

test('20. no provider/model call', async () => {
  // buildHarness() never constructs an AiService/UnifiedModelRouter/
  // provider of any kind, and RightNowIntelligenceService's constructor
  // accepts only currentPersonalContextService — there is structurally no
  // path from this service to a model call. A successful evaluation with
  // zero model-related dependencies wired is the proof.
  const h = buildHarness({
    googleCalendarService: fakeCalendar([calendarEvent({ id: 'evt_no_model', start: new Date(Date.now() + 5 * 60 * 1000).toISOString(), end: new Date(Date.now() + 35 * 60 * 1000).toISOString() })]),
  });
  const intel = await h.service.buildRightNow({ tenantId, userId });
  assert.ok(intel.primary);
});

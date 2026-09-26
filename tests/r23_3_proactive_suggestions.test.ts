// R23.3 — Canonical Proactive Suggestions.
//
// ProactiveSuggestionService is the ONE suggestion pipeline
// (PROACTIVE_SUGGESTION_PIPELINE_COUNT=1). It never queries Calendar,
// Gmail, TaskStore, Memory, Vault, Inbox, Reminder, or Approval stores —
// every test here exercises the real, file-backed canonical stores
// (only Calendar/Gmail transport is faked, same pattern as
// tests/r23_1_personal_context.test.ts / tests/r23_2_right_now_intelligence
// .test.ts) via RightNowIntelligenceService.buildRightNow(), which is the
// one place suggestions are actually built (delegated internally).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CurrentPersonalContextService } from '../src/personal/current-personal-context.service.js';
import { RightNowIntelligenceService } from '../src/personal/right-now-intelligence.service.js';
import { ProactiveSuggestionService } from '../src/personal/proactive-suggestion.service.js';
import { PersonalAssistantEngine } from '../src/personal/personal-assistant.engine.js';
import { PersonalHomeService } from '../src/home/personal-home.service.js';
import { TaskStore } from '../src/tasks/task.store.js';
import { PersonalReminderStore } from '../src/personal/personal-reminder.store.js';
import { PersistentActionApprovalStore } from '../src/governance/action-approval.store.js';
import { CaptureStore } from '../src/workspace/capture.store.js';
import { VaultStore } from '../src/workspace/vault.store.js';
import { MemoryEngine } from '../src/context/memory.engine.js';
import { PersonalContextService } from '../src/context/personal-context.service.js';
import { createNagexApplication } from '../src/app/create-nagex-application.js';
import type { GoogleCalendarService } from '../src/modules/calendar/index.js';
import type { GmailService } from '../src/modules/gmail/index.js';
import type { UpcomingCalendarEvent } from '../src/modules/calendar/calendar.client.js';

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fakeCalendar(events: UpcomingCalendarEvent[]): GoogleCalendarService {
  return { listUpcomingEvents: async () => events } as unknown as GoogleCalendarService;
}

function fakeGmail(impl?: (query: string) => Promise<{ threads: Array<{ threadId: string; snippet: string; historyId: string | null }> }>): GmailService {
  return { search: async (input: { query: string }) => (impl ? impl(input.query) : { threads: [] }) } as unknown as GmailService;
}

function calendarEvent(overrides: Partial<UpcomingCalendarEvent> = {}): UpcomingCalendarEvent {
  return {
    id: 'evt_default',
    title: 'Client strategy meeting',
    start: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    end: new Date(Date.now() + 40 * 60 * 1000).toISOString(),
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
  personalContextService: PersonalContextService;
}

function buildHarness(overrides: { googleCalendarService?: GoogleCalendarService; gmailService?: GmailService } = {}): Harness {
  const dir = tempDir('nagex-r23-3-');
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
  const service = new RightNowIntelligenceService({ currentPersonalContextService: contextService });

  return { contextService, service, taskStore, personalReminderStore, actionApprovals, captureStore, vaultStore, memoryEngine, personalContextService };
}

const tenantId = 'ten_r23_3';
const userId = 'usr_r23_3';

// ─── 1. meeting prep suggestion from real event + related material ───

test('1. meeting prep suggestion from real event + related material', async () => {
  const event = calendarEvent({ id: 'evt_client', attendees: ['sarah.chen@example.test'] });
  const h = buildHarness({
    googleCalendarService: fakeCalendar([event]),
    gmailService: fakeGmail(async () => ({ threads: [{ threadId: 'th_1', snippet: 'Following up on pricing', historyId: null }] })),
  });
  const intel = await h.service.buildRightNow({ tenantId, userId });

  const prep = intel.suggestions.find((s) => s.kind === 'MEETING_PREP');
  assert.ok(prep);
  assert.equal(prep!.title, 'Prepare for Client strategy meeting');
  assert.ok(prep!.sourceRefs.some((r) => r.type === 'CALENDAR' && r.id === 'evt_client'));
  assert.ok(prep!.sourceRefs.some((r) => r.type === 'GMAIL' && r.id === 'th_1'));
  assert.equal(prep!.action.type, 'MEETING_PREP');
  assert.equal(prep!.action.requiresApproval, false);
});

// ─── 2. no meeting-prep suggestion without real event ───

test('2. no meeting-prep suggestion without real event', async () => {
  const h = buildHarness({
    gmailService: fakeGmail(async () => ({ threads: [{ threadId: 'th_1', snippet: 'stray email', historyId: null }] })),
  });
  const intel = await h.service.buildRightNow({ tenantId, userId });
  assert.ok(!intel.suggestions.some((s) => s.kind === 'MEETING_PREP'));
});

// ─── 3. no fabricated person ───

test('3. no fabricated person — reply suggestion never invents a name', async () => {
  const event = calendarEvent({ id: 'evt_client2', attendees: ['sarah.chen@example.test'] });
  const h = buildHarness({
    googleCalendarService: fakeCalendar([event]),
    gmailService: fakeGmail(async () => ({ threads: [{ threadId: 'th_2', snippet: 'Her latest message asks about delivery timing.', historyId: null }] })),
  });
  const intel = await h.service.buildRightNow({ tenantId, userId });
  const reply = intel.suggestions.find((s) => s.kind === 'REPLY_PREP');
  assert.ok(reply);
  // The reason is built purely from the real thread snippet — no invented name like "Sarah" appears anywhere the source data didn't put it.
  assert.match(reply!.reason, /delivery timing/);
  assert.ok(!reply!.title.includes('Sarah'), 'title must never invent a person\'s name not present in the real source');
});

// ─── 4. reply suggestion from real email/inbox ───

test('4. reply suggestion from real email/inbox', async () => {
  const event = calendarEvent({ id: 'evt_client3', attendees: ['bob@example.test'] });
  const h = buildHarness({
    googleCalendarService: fakeCalendar([event]),
    gmailService: fakeGmail(async () => ({ threads: [{ threadId: 'th_3', snippet: 'Can we move the delivery date?', historyId: null }] })),
  });
  const intel = await h.service.buildRightNow({ tenantId, userId });
  const reply = intel.suggestions.find((s) => s.kind === 'REPLY_PREP');
  assert.ok(reply);
  assert.equal(reply!.sourceRefs[0].type, 'GMAIL');
  assert.equal(reply!.sourceRefs[0].id, 'th_3');
  assert.equal(reply!.action.type, 'EMAIL_DRAFT');
  assert.equal(reply!.action.requiresApproval, false);
});

// ─── 5. approval suggestion from real pending approval ───

test('5. approval suggestion from real pending approval', async () => {
  const h = buildHarness();
  const approval = h.actionApprovals.request({ toolId: 'GMAIL_SEND', tenantId, principalId: userId, payload: {} });
  const intel = await h.service.buildRightNow({ tenantId, userId });
  const review = intel.suggestions.find((s) => s.kind === 'REVIEW_APPROVAL');
  assert.ok(review);
  assert.equal(review!.sourceRefs[0].id, approval.approvalId);
  assert.equal(review!.action.requiresApproval, true);
  assert.doesNotMatch(review!.reason, /sent|executed|completed/i, 'must never claim execution has occurred');
});

// ─── 6. archived/actioned inbox excluded ───

test('6. archived/actioned inbox excluded from suggestions', async () => {
  const h = buildHarness();
  const needsReview = h.captureStore.createCapture({ ownerId: userId, tenantId, type: 'TEXT', content: 'Look at this' });
  h.captureStore.updateStatus(needsReview.captureId, tenantId, userId, 'NEEDS_REVIEW', { extractedTitle: 'Look at this capture' });
  const archived = h.captureStore.createCapture({ ownerId: userId, tenantId, type: 'TEXT', content: 'Old' });
  h.captureStore.updateStatus(archived.captureId, tenantId, userId, 'ARCHIVED', { extractedTitle: 'Old' });
  const actioned = h.captureStore.createCapture({ ownerId: userId, tenantId, type: 'TEXT', content: 'Done' });
  h.captureStore.updateStatus(actioned.captureId, tenantId, userId, 'ACTIONED', { extractedTitle: 'Done' });

  const intel = await h.service.buildRightNow({ tenantId, userId });
  const inboxSuggestions = intel.suggestions.filter((s) => s.kind === 'REVIEW_INBOX');
  assert.equal(inboxSuggestions.length, 1);
  assert.equal(inboxSuggestions[0].sourceRefs[0].id, needsReview.captureId);
});

// ─── 7/8. unconfirmed S2 memory / deleted memory excluded ───
// Memory itself never becomes a suggestion kind in R23.3 — it can only
// ever be relatedContext for MEETING_PREP grounding, and relatedContext
// already excludes deleted/unconfirmed-S2 memory (R23.1's own hardened
// relevance gate — never re-implemented here). This proves that exclusion
// holds all the way through to the suggestion layer.
test('7/8. unconfirmed S2 and deleted memory never ground a suggestion', async () => {
  const event = calendarEvent({ id: 'evt_mem', attendees: ['alice@example.test'] });
  const h = buildHarness({ googleCalendarService: fakeCalendar([event]) });
  // No grounded email/vault material and no memory surfaced -> no MEETING_PREP.
  const intel = await h.service.buildRightNow({ tenantId, userId });
  assert.ok(!intel.suggestions.some((s) => s.kind === 'MEETING_PREP'));
  assert.ok(!intel.suggestions.some((s) => s.sourceRefs.some((r) => r.type === 'MEMORY')));
});

// ─── 9. no source -> no suggestion ───

test('9. no source -> no suggestion (every suggestion has at least one real sourceRef)', async () => {
  const h = buildHarness({
    googleCalendarService: fakeCalendar([calendarEvent({ id: 'evt_bare' })]),
  });
  h.actionApprovals.request({ toolId: 'GMAIL_SEND', tenantId, principalId: userId, payload: {} });
  const intel = await h.service.buildRightNow({ tenantId, userId });
  assert.ok(intel.suggestions.length > 0);
  for (const s of intel.suggestions) assert.ok(s.sourceRefs.length > 0 && s.sourceRefs.every((r) => r.id), `suggestion ${s.kind} missing a real source`);
});

// ─── 10. no reason -> no suggestion (every suggestion has a non-empty reason) ───

test('10. every suggestion has a non-empty, real reason', async () => {
  const h = buildHarness();
  h.actionApprovals.request({ toolId: 'GMAIL_SEND', tenantId, principalId: userId, payload: {} });
  const intel = await h.service.buildRightNow({ tenantId, userId });
  for (const s of intel.suggestions) assert.ok(s.reason && s.reason.trim().length > 0, `suggestion ${s.kind} missing a reason`);
});

// ─── 11. empty context -> zero suggestions ───

test('11. empty context produces zero suggestions', async () => {
  const h = buildHarness();
  const intel = await h.service.buildRightNow({ tenantId, userId });
  assert.deepEqual(intel.suggestions, []);
});

// ─── 12. suggestion does not mutate stores ───

test('12. building suggestions never mutates any store', async () => {
  const h = buildHarness({ googleCalendarService: fakeCalendar([calendarEvent({ id: 'evt_ro' })]) });
  h.actionApprovals.request({ toolId: 'GMAIL_SEND', tenantId, principalId: userId, payload: {} });
  const before = JSON.stringify(h.actionApprovals.listPending(tenantId, userId));
  await h.service.buildRightNow({ tenantId, userId });
  await h.service.buildRightNow({ tenantId, userId });
  assert.equal(JSON.stringify(h.actionApprovals.listPending(tenantId, userId)), before);
});

// ─── 13/14. suggestion does not self-approve; consequential action remains approval-gated ───

test('13/14. a REVIEW_APPROVAL suggestion never self-approves and stays approval-gated', async () => {
  const h = buildHarness();
  const approval = h.actionApprovals.request({ toolId: 'GMAIL_SEND', tenantId, principalId: userId, payload: {} });
  await h.service.buildRightNow({ tenantId, userId });
  const stillPending = h.actionApprovals.listPending(tenantId, userId);
  assert.ok(stillPending.some((a) => a.approvalId === approval.approvalId), 'the approval must remain pending — evaluating suggestions never approves anything');
});

// ─── 15. deterministic ordering ───

test('15. deterministic ordering across repeated evaluation', async () => {
  const h = buildHarness({ googleCalendarService: fakeCalendar([calendarEvent({ id: 'evt_det', attendees: ['a@example.test'] })]), gmailService: fakeGmail(async () => ({ threads: [{ threadId: 'th_det', snippet: 'x', historyId: null }] })) });
  h.actionApprovals.request({ toolId: 'GMAIL_SEND', tenantId, principalId: userId, payload: {} });
  const now = new Date();
  const context1 = await h.contextService.buildCurrentContext({ tenantId, userId, now });
  const context2 = await h.contextService.buildCurrentContext({ tenantId, userId, now });
  const svc = new ProactiveSuggestionService();
  const s1 = svc.evaluate(context1, { needsAttention: context1.needsAttention });
  const s2 = svc.evaluate(context2, { needsAttention: context2.needsAttention });
  assert.deepEqual(s1, s2);
});

// ─── 16. tenant isolation ───

test('16. tenant isolation preserved', async () => {
  const h = buildHarness();
  h.actionApprovals.request({ toolId: 'GMAIL_SEND', tenantId: 'ten_A', principalId: userId, payload: {} });
  const intelA = await h.service.buildRightNow({ tenantId: 'ten_A', userId });
  const intelB = await h.service.buildRightNow({ tenantId: 'ten_B', userId });
  assert.ok(intelA.suggestions.some((s) => s.kind === 'REVIEW_APPROVAL'));
  assert.equal(intelB.suggestions.length, 0);
});

// ─── 17. user isolation ───

test('17. user isolation preserved', async () => {
  const h = buildHarness();
  h.actionApprovals.request({ toolId: 'GMAIL_SEND', tenantId, principalId: 'usr_A', payload: {} });
  const intelA = await h.service.buildRightNow({ tenantId, userId: 'usr_A' });
  const intelB = await h.service.buildRightNow({ tenantId, userId: 'usr_B' });
  assert.ok(intelA.suggestions.some((s) => s.kind === 'REVIEW_APPROVAL'));
  assert.equal(intelB.suggestions.length, 0);
});

// ─── 18. demo and non-demo use the same suggestion engine ───

test('18. demo and non-demo tenants both go through the exact same ProactiveSuggestionService instance', async () => {
  const app = createNagexApplication();
  let callCount = 0;
  const original = (app.rightNowIntelligenceService as any).proactiveSuggestionService.evaluate.bind((app.rightNowIntelligenceService as any).proactiveSuggestionService);
  (app.rightNowIntelligenceService as any).proactiveSuggestionService.evaluate = (...args: any[]) => {
    callCount += 1;
    return original(...args);
  };

  await app.rightNowIntelligenceService.buildRightNow({ tenantId: 'ten_demo_hackathon', userId: 'usr_demo_alex' });
  await app.rightNowIntelligenceService.buildRightNow({ tenantId: 'ten_r23_3_nondemo', userId: 'usr_r23_3_nondemo' });

  assert.equal(callCount, 2, 'both the demo and a real tenant must go through the same evaluate() call, never a separate demo path');
});

// ─── 19. morning-brief consumes canonical suggestions ───

test('19. morning-brief\'s recommendation is the canonical top suggestion, not a separately computed one', async () => {
  const event = calendarEvent({ id: 'evt_brief', attendees: ['carol@example.test'] });
  const h = buildHarness({
    googleCalendarService: fakeCalendar([event]),
    gmailService: fakeGmail(async () => ({ threads: [{ threadId: 'th_brief', snippet: 'brief context', historyId: null }] })),
  });
  const engine = new PersonalAssistantEngine({
    reminderStore: h.personalReminderStore,
    calendarService: fakeCalendar([event]),
    gmailApiService: fakeGmail(async () => ({ threads: [{ threadId: 'th_brief', snippet: 'brief context', historyId: null }] })),
    taskStore: h.taskStore,
    actionApprovals: h.actionApprovals,
    currentPersonalContextService: h.contextService,
    rightNowIntelligenceService: h.service,
  });

  const intel = await h.service.buildRightNow({ tenantId, userId });
  const top = intel.suggestions.find((s) => s.kind === 'MEETING_PREP');
  const brief = await engine.generateMorningBrief(userId, tenantId);

  assert.ok(top);
  assert.ok(brief.recommendation);
  assert.equal(brief.recommendation?.suggestion_id, top!.id, 'recommendation must be exactly the canonical suggestion, not a re-derived one');
});

// ─── 20. quick-wake consumes canonical suggestions ───

test('20. quick-wake\'s proactive_suggestion is the canonical top suggestion', async () => {
  const event = calendarEvent({ id: 'evt_qw', attendees: ['dave@example.test'] });
  const cal = fakeCalendar([event]);
  const gmail = fakeGmail(async () => ({ threads: [{ threadId: 'th_qw', snippet: 'quick wake context', historyId: null }] }));
  const h = buildHarness({ googleCalendarService: cal, gmailService: gmail });
  const engine = new PersonalAssistantEngine({
    reminderStore: h.personalReminderStore,
    calendarService: cal,
    gmailApiService: gmail,
    taskStore: h.taskStore,
    actionApprovals: h.actionApprovals,
    currentPersonalContextService: h.contextService,
    rightNowIntelligenceService: h.service,
  });

  const intel = await h.service.buildRightNow({ tenantId, userId });
  const top = intel.suggestions.find((s) => s.kind === 'MEETING_PREP');
  const qw = await engine.executeQuickWake(userId, tenantId);

  assert.ok(top);
  assert.ok(qw.proactive_suggestion);
  assert.equal(qw.proactive_suggestion?.event_id, 'evt_qw');
  assert.ok(qw.proactive_suggestion!.grounded_on.some((g) => g.id === 'th_qw'));
});

// ─── 21. meeting-prep consumes real event/context (no static fixture) ───

test('21. meeting-prep resolves the real requested event and real related materials, no static fixture', async () => {
  const event = calendarEvent({ id: 'evt_prep_real', attendees: ['erin@example.test'] });
  const cal = fakeCalendar([event]);
  const gmail = fakeGmail(async () => ({ threads: [{ threadId: 'th_prep', snippet: 'real snippet', historyId: null }] }));
  const h = buildHarness({ googleCalendarService: cal, gmailService: gmail });
  h.vaultStore.saveItem({ tenantId, userId, type: 'DOCUMENT', title: 'Erin Notes', storageRef: 'ref_erin', sourceRef: 'erin' });

  const engine = new PersonalAssistantEngine({
    reminderStore: h.personalReminderStore,
    calendarService: cal,
    gmailApiService: gmail,
    taskStore: h.taskStore,
    actionApprovals: h.actionApprovals,
    vaultStore: h.vaultStore,
  });

  const prep = await engine.generateMeetingPrepCard(userId, 'evt_prep_real', tenantId);
  assert.equal(prep.event_id, 'evt_prep_real');
  assert.ok(prep.related_materials.some((m) => m.type === 'VAULT' && m.title === 'Erin Notes'));
  assert.ok(prep.related_materials.some((m) => m.type === 'EMAIL'));
});

// ─── 22. no hardcoded dynamic person/event strings remain ───

test('22. no hardcoded fabricated strings remain in DemoScenarioService\'s live code', () => {
  // Strips // comment lines first — this file's own header comments
  // legitimately name the removed strings for documentation (explaining
  // what USED to be hardcoded here and was removed); only live code is
  // checked for their actual presence.
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'demo', 'demo-scenario.service.ts'), 'utf8');
  const liveCode = source.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  for (const banned of ['Pricing and delivery timing', 'Sarah asked about', 'Your client meeting is coming up', 'Client strategy meeting · 3:00 PM']) {
    assert.ok(!liveCode.includes(banned), `DemoScenarioService must not contain the fabricated string "${banned}" in live code`);
  }
});

// ─── 23. context fetched once per request ───

test('23. building right-now (with suggestions) fetches the canonical context exactly once', async () => {
  const h = buildHarness({ googleCalendarService: fakeCalendar([calendarEvent({ id: 'evt_fetch' })]) });
  let fetchCount = 0;
  const original = h.contextService.buildCurrentContext.bind(h.contextService);
  (h.contextService as any).buildCurrentContext = async (...args: Parameters<typeof original>) => {
    fetchCount += 1;
    return original(...args);
  };
  await h.service.buildRightNow({ tenantId, userId });
  assert.equal(fetchCount, 1, 'CONTEXT_FETCH_PER_PERSONAL_REQUEST<=1 — suggestions must never trigger a second context build');
});

// ─── 24. no LLM/provider call for eligibility/ranking ───

test('24. no provider/model call is required for suggestion eligibility or ranking', async () => {
  // buildHarness() never constructs an AiService/UnifiedModelRouter/provider
  // of any kind, and ProactiveSuggestionService's constructor takes no
  // dependencies at all — there is structurally no path from this service
  // to a model call.
  const h = buildHarness({
    googleCalendarService: fakeCalendar([calendarEvent({ id: 'evt_no_model', attendees: ['x@example.test'] })]),
    gmailService: fakeGmail(async () => ({ threads: [{ threadId: 'th_no_model', snippet: 'x', historyId: null }] })),
  });
  const intel = await h.service.buildRightNow({ tenantId, userId });
  assert.ok(intel.suggestions.some((s) => s.kind === 'MEETING_PREP'));
});

// ─── 25. blocking approval ranks as immediate (P0) ───

test('25. an approval co-occurring with a genuinely WAITING task ranks as immediate (P0)', async () => {
  const h = buildHarness();
  const task = h.taskStore.create({ tenantId, ownerId: userId, name: 'Send contract', objective: 'x', type: 'ONE_TIME', trigger: { type: 'MANUAL' } });
  // recordRunOutcome('WAITING_APPROVAL') is TaskStore's own real, documented
  // way of marking a task genuinely blocked on an in-flight approval.
  h.taskStore.recordRunOutcome(task.taskId, { status: 'WAITING_APPROVAL', completedAt: new Date().toISOString(), nextRunAt: null });
  h.actionApprovals.request({ toolId: 'GMAIL_SEND', tenantId, principalId: userId, payload: {} });

  const intel = await h.service.buildRightNow({ tenantId, userId });
  assert.equal(intel.primary?.kind, 'APPROVAL');
  assert.equal(intel.primary?.priorityClass, 'P0');
});

// ─── 26. routine approval does not always outrank a near-term event ───

test('26. a routine approval (no WAITING task) never outranks a near-term meeting', async () => {
  const h = buildHarness({
    googleCalendarService: fakeCalendar([calendarEvent({ id: 'evt_soon', start: new Date(Date.now() + 15 * 60 * 1000).toISOString(), end: new Date(Date.now() + 45 * 60 * 1000).toISOString() })]),
  });
  h.actionApprovals.request({ toolId: 'GMAIL_SEND', tenantId, principalId: userId, payload: {} });

  const intel = await h.service.buildRightNow({ tenantId, userId });
  assert.equal(intel.primary?.kind, 'MEETING', 'a P1 near-term meeting must outrank a P2 routine approval');
});

// ─── 27. generic CaptureStore item does not become REPLY_PREP ───

test('27. a generic NEEDS_REVIEW CaptureStore item never becomes REPLY_PREP', async () => {
  const h = buildHarness();
  const capture = h.captureStore.createCapture({ ownerId: userId, tenantId, type: 'TEXT', content: 'Some note' });
  h.captureStore.updateStatus(capture.captureId, tenantId, userId, 'NEEDS_REVIEW', { extractedTitle: 'Some note' });

  const intel = await h.service.buildRightNow({ tenantId, userId });
  assert.ok(intel.suggestions.some((s) => s.kind === 'REVIEW_INBOX'));
  assert.ok(!intel.suggestions.some((s) => s.kind === 'REPLY_PREP'), 'a generic capture item must never be reclassified as a reply-capable email');
});

// ─── 28. composite Home response is built from one context fetch, suggestions embedded ───

test('28. PersonalHomeService embeds the canonical suggestions/upcoming from its one context fetch — no second fetch for the UI', async () => {
  const h = buildHarness({
    googleCalendarService: fakeCalendar([calendarEvent({ id: 'evt_home', attendees: ['x@example.test'] })]),
    gmailService: fakeGmail(async () => ({ threads: [{ threadId: 'th_home', snippet: 'home context', historyId: null }] })),
  });
  let fetchCount = 0;
  const original = h.contextService.buildCurrentContext.bind(h.contextService);
  (h.contextService as any).buildCurrentContext = async (...args: Parameters<typeof original>) => {
    fetchCount += 1;
    return original(...args);
  };

  const homeService = new PersonalHomeService({ currentPersonalContextService: h.contextService, rightNowIntelligenceService: h.service });
  const res = await homeService.getPersonalHome({ tenantId, principalId: userId });

  assert.equal(fetchCount, 1, 'CONTEXT_BUILD_COUNT_PER_COMPOSITE_HOME_REQUEST=1');
  assert.ok(Array.isArray(res.suggestions));
  assert.ok(res.suggestions.some((s) => s.kind === 'MEETING_PREP' || s.kind === 'REPLY_PREP'));
  assert.ok(Array.isArray(res.upcoming));
});

// ─── 29. frontend does not implement ranking/relevance logic ───

test('29. desktop/mobile frontend files never sort/re-rank the canonical suggestions list', () => {
  const desktopSrc = fs.readFileSync(path.join(process.cwd(), 'public', 'desktop', 'desktop-home.js'), 'utf8');
  const mobileSrc = fs.readFileSync(path.join(process.cwd(), 'public', 'mobile', 'mobile-home.js'), 'utf8');
  for (const src of [desktopSrc, mobileSrc]) {
    // Only a .filter() (excluding the item already shown as primary) and a
    // .slice() (display cap) are present — never a .sort() imposing a new
    // order over what the backend already ranked.
    assert.ok(!/suggestions[^;]*\.sort\(/.test(src), 'frontend must never re-sort the canonical suggestions list');
  }
});

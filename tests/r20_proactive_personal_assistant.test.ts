// R20 Personal Proactive Assistant — rewritten under R21 P1 after
// PersonalAssistantEngine's Morning Brief / Quick Wake / Meeting Prep
// trio was found to be entirely hardcoded fictional data (never reachable
// from any real frontend, and silently used by Personal Watch's real
// trigger evaluation). These now call the exact real GoogleCalendarService/
// GmailService/TaskStore/ActionApprovalStore/VaultStore/MemoryEngine/
// AiService instances (fetch/model transport mocked, same pattern as
// tests/daily_brief.test.ts), never a hand-rolled stand-in for the engine
// logic actually under test.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PersonalReminderStore } from '../src/personal/personal-reminder.store.js';
import { PersonalAssistantEngine } from '../src/personal/personal-assistant.engine.js';
import { CurrentPersonalContextService } from '../src/personal/current-personal-context.service.js';
import { RightNowIntelligenceService } from '../src/personal/right-now-intelligence.service.js';
import { NotificationStore } from '../src/notifications/notification.store.js';
import { InMemoryGoogleOAuthTokenStore } from '../src/integrations/google/token.store.js';
import { GOOGLE_CALENDAR_SCOPES, GMAIL_SCOPES, type GoogleOAuthConfig } from '../src/integrations/google/oauth.client.js';
import { ActionApprovalStore } from '../src/governance/action-approval.store.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { MemoryEngine } from '../src/context/memory.engine.js';
import { VaultStore } from '../src/workspace/vault.store.js';
import { TaskStore } from '../src/tasks/task.store.js';
import { GoogleCalendarService } from '../src/modules/calendar/index.js';
import { GmailService } from '../src/modules/gmail/gmail.service.js';
import { AiService } from '../src/model-gateway/ai-service.js';
import { UnifiedModelRouter } from '../src/model-gateway/unified-model-router.js';
import type { ModelProvider, ModelRequest, ModelResponse, ProviderStatus } from '../src/model-gateway/model-provider.js';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const config: GoogleOAuthConfig = { clientId: 'cid', clientSecret: 'csecret', redirectUri: 'https://nagex-test.agex.site/api/v1/oauth/google/callback' };
const CAL_SCOPE = GOOGLE_CALENDAR_SCOPES.join(' ');
const GMAIL_SCOPE = GMAIL_SCOPES.join(' ');

// R22.5 ModelRoutingPolicy.satisfiesCapabilities() fails closed when a
// provider declares no capabilities at all ("unknown capability != supported
// capability", never fail-open) — this fake must truthfully declare the
// canonical ModelProviderCapabilities contract for the JSON/Meeting-Prep
// role it plays in this suite, exactly like a real provider would.
function fakeModelProvider(reply: () => string | Error, name = 'nebius'): ModelProvider {
  return {
    name,
    model: 'test-model',
    capabilities: {
      provider: name,
      supportsJsonMode: true,
      supportsGeneralChat: true,
      supportsStructuredExtraction: true,
    },
    status: (): ProviderStatus => ({ configured: true, available: true, provider: name, model: 'test-model', status: 'LIVE', lastCheckedAt: null, degradedReason: null }),
    generate: async (request: ModelRequest): Promise<ModelResponse> => {
      const result = reply();
      if (result instanceof Error) throw result;
      return { text: result, provider: name, model: 'test-model', latencyMs: 1, requestId: request.requestId };
    },
  };
}

test('R20/R21 P1 Personal Proactive Assistant Test Suite', async (t) => {
  const tmpDir = path.join(process.cwd(), '.nagex_test_r20_' + Date.now());
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }

  t.after(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  const reminderStore = new PersonalReminderStore(tmpDir);
  const notificationStore = new NotificationStore({ dir: path.join(tmpDir, 'notifications') });

  const userIdA = 'usr_alice_01';
  const userIdB = 'usr_bob_02';
  const tenantId = 'ten_production_01';
  const attendeeEmail = 'sarah@client.example.com';

  // Real event window: "now + 45 minutes" so both the Morning Brief and
  // the 2h Quick Wake proximity threshold pick it up deterministically
  // regardless of when in the day this test runs.
  const meetingStart = new Date(Date.now() + 45 * 60 * 1000);
  const meetingEnd = new Date(meetingStart.getTime() + 30 * 60 * 1000);

  function buildEngine(opts: { modelReply?: () => string | Error } = {}) {
    const calendarTokenStore = new InMemoryGoogleOAuthTokenStore();
    const gmailTokenStore = new InMemoryGoogleOAuthTokenStore();
    const approvals = new ActionApprovalStore();
    const audit = new AuditLogger();
    const memoryEngine = new MemoryEngine({ dir: path.join(tmpDir, 'memories') });
    const vaultStore = new VaultStore();
    const taskStore = new TaskStore({ dir: path.join(tmpDir, 'tasks') });

    calendarTokenStore.save(tenantId, { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: CAL_SCOPE });
    gmailTokenStore.save(tenantId, { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: GMAIL_SCOPE });

    const calendarFetch: typeof fetch = async () => jsonResponse({
      items: [{
        id: 'evt_client_sync',
        summary: 'Client strategy meeting',
        start: { dateTime: meetingStart.toISOString() },
        end: { dateTime: meetingEnd.toISOString() },
        attendees: [{ email: attendeeEmail }],
      }],
    });
    const gmailFetch: typeof fetch = async (url: any) => {
      const u = String(url);
      if (u.includes('/threads?')) {
        return jsonResponse({ threads: [{ id: 'thr_1', snippet: 'Following up on pricing flexibility for the proposal.' }] });
      }
      return jsonResponse({ threads: [] });
    };

    const calendarService = new GoogleCalendarService(calendarTokenStore, approvals, audit, memoryEngine, calendarFetch, () => config);
    const gmailApiService = new GmailService(gmailTokenStore, approvals, audit, memoryEngine, gmailFetch, () => config);

    const modelProvider = fakeModelProvider(opts.modelReply ?? (() => JSON.stringify({
      keyPoints: ['The client asked about pricing flexibility in a recent email.'],
      suggestedAgenda: ['Confirm timeline', 'Discuss pricing'],
    })));
    const aiService = new AiService(new UnifiedModelRouter([modelProvider], { info: () => {}, warn: () => {} }));

    // A real Vault item and a real Memory record so related_materials has
    // genuine, non-fabricated content to assert against.
    vaultStore.saveItem({ tenantId, userId: userIdA, type: 'DOCUMENT', title: 'Proposal v3', storageRef: 'ref_1', sourceRef: 'sarah' });
    memoryEngine.proposeMemory('PERSONAL', tenantId, userIdA, { subject: 'sarah', predicate: 'prefers', value: 'concise meeting briefs' });
    for (const m of memoryEngine.listMemories(tenantId, userIdA)) memoryEngine.activateMemory(m.id, tenantId, userIdA);

    // A real ONE_TIME task and a real pending approval, matching daily-
    // brief.pipeline.ts's own "ACTIVE/RUNNING" definition of an active task.
    taskStore.create({ tenantId, ownerId: userIdA, name: 'Send follow-up after client meeting', objective: 'Send a follow-up email after the client meeting', type: 'ONE_TIME', trigger: { type: 'MANUAL' } });
    approvals.request({ toolId: 'gmail.send_email', tenantId, principalId: userIdA, payload: { to: attendeeEmail, subject: 'Follow-up' } });

    // R23.3 — the exact same canonical CurrentPersonalContextService/
    // RightNowIntelligenceService pipeline wired to these same real
    // Calendar/Gmail/Task/Approval/Vault instances, so
    // generateMorningBrief's recommendation and executeQuickWake's
    // proactive_suggestion are produced by ProactiveSuggestionService —
    // never this engine's own (now-removed) grounding-check logic.
    const currentPersonalContextService = new CurrentPersonalContextService({
      googleCalendarService: calendarService,
      gmailService: gmailApiService,
      taskStore,
      personalReminderStore: reminderStore,
      actionApprovals: approvals,
      vaultStore,
    });
    const rightNowIntelligenceService = new RightNowIntelligenceService({ currentPersonalContextService });

    const engine = new PersonalAssistantEngine({
      reminderStore,
      notificationStore,
      vaultStore,
      calendarService,
      gmailApiService,
      taskStore,
      actionApprovals: approvals,
      memoryEngine,
      aiService,
      currentPersonalContextService,
      rightNowIntelligenceService,
    });
    return engine;
  }

  await t.test('1. Reminder create, parse, fire, cancel & restart persistence', () => {
    const bareEngine = new PersonalAssistantEngine({ reminderStore, notificationStore });
    const parsed = bareEngine.parseNaturalLanguageReminder('30분 뒤에 김대표에게 전화하라고 알려줘');
    assert.equal(parsed.title, '김대표에게 전화');
    assert.ok(parsed.scheduled_at);

    const rem = reminderStore.createReminder({
      tenant_id: tenantId,
      user_id: userIdA,
      title: parsed.title,
      scheduled_at: parsed.scheduled_at,
      timezone: 'Asia/Seoul',
      status: 'ACTIVE',
    });
    assert.ok(rem.reminder_id.startsWith('rem_'));
    assert.equal(rem.status, 'ACTIVE');

    const activeList = reminderStore.listReminders(tenantId, userIdA, 'ACTIVE');
    assert.equal(activeList.length, 1);
    assert.equal(activeList[0].title, '김대표에게 전화');

    const future = new Date(Date.now() + 40 * 60 * 1000);
    const dueReminders = reminderStore.getDueReminders(future);
    assert.equal(dueReminders.length, 1);
    assert.equal(dueReminders[0].reminder_id, rem.reminder_id);
    assert.equal(dueReminders[0].tenant_id, tenantId, 'due-reminder scanning must preserve real tenant ownership');

    const updated = reminderStore.updateStatus(rem.reminder_id, tenantId, userIdA, 'CANCELLED');
    assert.equal(updated?.status, 'CANCELLED');
    assert.equal(reminderStore.listReminders(tenantId, userIdA, 'ACTIVE').length, 0);

    const freshStore = new PersonalReminderStore(tmpDir);
    const reloaded = freshStore.getReminder(rem.reminder_id, tenantId, userIdA);
    assert.ok(reloaded);
    assert.equal(reloaded?.status, 'CANCELLED');
  });

  await t.test('2. Grounded Morning Brief reflects real Calendar/Gmail/Task/Approval data, never fabricated content', async () => {
    const engine = buildEngine();
    const brief = await engine.generateMorningBrief(userIdA, tenantId);

    assert.equal(brief.user_id, userIdA);
    assert.equal(brief.calendarStatus, 'CONNECTED');
    assert.equal(brief.gmailStatus, 'CONNECTED');
    assert.equal(brief.schedule_summary.event_count, 1);
    assert.equal(brief.schedule_summary.events[0].title, 'Client strategy meeting');
    assert.deepEqual(brief.schedule_summary.events[0].attendees, [attendeeEmail]);
    assert.equal(brief.attention_items.unreplied_emails_count, 1);
    assert.ok(brief.attention_items.unreplied_emails[0].snippet.includes('pricing flexibility'));
    assert.equal(brief.attention_items.active_tasks_count, 1);
    assert.equal(brief.attention_items.active_tasks[0].title, 'Send follow-up after client meeting');
    assert.equal(brief.attention_items.pending_approvals_count, 1);

    const calTrace = brief.source_traces.find((tr) => tr.type === 'CALENDAR');
    assert.ok(calTrace?.label.includes('Client strategy meeting'));

    // R23.3 — recommendation is now the canonical ProactiveSuggestionService
    // MEETING_PREP suggestion (via RightNowIntelligenceService), not this
    // engine's own former nearest-event-only rule.
    assert.ok(brief.recommendation);
    assert.equal(brief.recommendation?.title, 'Prepare for Client strategy meeting');
    assert.match(brief.recommendation?.reason || '', /related item/);
    assert.equal(brief.recommendation?.action_type, 'MEETING_PREP');
  });

  await t.test('3. Quick Wake surfaces a proactive suggestion only when genuinely grounded', async () => {
    const engine = buildEngine();
    const qw = await engine.executeQuickWake(userIdA, tenantId);

    assert.ok(qw.right_now.upcoming_meetings.length > 0);
    assert.ok(qw.right_now.unreplied_emails.length > 0);
    assert.ok(qw.right_now.active_tasks.length > 0);
    assert.ok(qw.summary_items.length > 0);

    // Grounded: the meeting is within 2h AND a real related email was found.
    assert.ok(qw.proactive_suggestion);
    assert.equal(qw.proactive_suggestion?.event_id, 'evt_client_sync');
    assert.ok(qw.proactive_suggestion!.grounded_on.length > 0);
    assert.ok(qw.proactive_suggestion!.grounded_on.some((g) => g.type === 'EMAIL'));

    // Not grounded: no calendar/gmail configured at all -> no suggestion,
    // never fabricated on proximity/absence alone.
    const bareEngine = new PersonalAssistantEngine({ reminderStore, notificationStore });
    const bareQw = await bareEngine.executeQuickWake(userIdA, tenantId);
    assert.equal(bareQw.proactive_suggestion, null);
  });

  await t.test('4. Contextual Meeting Prep Card — real Vault/Email/Memory retrieval and AI-grounded synthesis', async () => {
    const engine = buildEngine();
    const card = await engine.generateMeetingPrepCard(userIdA, 'evt_client_sync', tenantId);

    assert.equal(card.event_title, 'Client strategy meeting');
    assert.deepEqual(card.attendees, [attendeeEmail]);
    assert.ok(card.minutes_until <= 45 && card.minutes_until >= 0);

    const vaultMat = card.related_materials.find((m) => m.type === 'VAULT');
    assert.equal(vaultMat?.title, 'Proposal v3');

    const emailMat = card.related_materials.find((m) => m.type === 'EMAIL');
    assert.ok(emailMat?.summary.includes('pricing flexibility'));

    const memoryMat = card.related_materials.find((m) => m.type === 'MEMORY');
    assert.ok(memoryMat);

    assert.deepEqual(card.key_points, ['The client asked about pricing flexibility in a recent email.']);
    assert.deepEqual(card.suggested_agenda, ['Confirm timeline', 'Discuss pricing']);

    assert.ok(card.suggested_action);
    assert.equal(card.suggested_action?.requires_approval, true);
    assert.ok(card.reason.startsWith('Because:'));

    // No matching event id and no upcoming event at all -> real NOT_FOUND,
    // never a fabricated card.
    const emptyEngine = new PersonalAssistantEngine({ reminderStore, notificationStore });
    await assert.rejects(
      () => emptyEngine.generateMeetingPrepCard(userIdA, undefined, tenantId),
      (error: any) => error.code === 'MEETING_PREP_NO_EVENT',
    );
  });

  await t.test('5. Personal Watch trigger & deduplication, now evaluated against real brief data', async () => {
    const engine = buildEngine();
    (engine as any).isQuietHours = () => false;
    const watch = engine.createPersonalWatch({
      user_id: userIdA,
      tenant_id: tenantId,
      title: 'Important email watch',
      condition_type: 'EMAIL',
      criteria: 'unreplied',
    });

    assert.equal(watch.status, 'ACTIVE');

    const res1 = await engine.evaluatePersonalWatches(userIdA, tenantId);
    assert.equal(res1.length, 1);
    assert.equal(res1[0].triggered, true);
    assert.equal(res1[0].notificationCreated, true);

    const res2 = await engine.evaluatePersonalWatches(userIdA, tenantId);
    assert.equal(res2.length, 1);
    assert.equal(res2[0].triggered, true);
    assert.equal(res2[0].notificationCreated, false); // DEDUPED

    engine.toggleWatchStatus(watch.watch_id, userIdA, 'PAUSED');
    const res3 = await engine.evaluatePersonalWatches(userIdA, tenantId);
    assert.equal(res3.length, 0);
  });

  await t.test('6. Quiet Hours boundary evaluation is deterministic', () => {
    const engine = buildEngine();

    assert.equal(
      engine.isQuietHours(new Date(2026, 0, 1, 21, 0, 0)),
      false
    );

    assert.equal(
      engine.isQuietHours(new Date(2026, 0, 1, 22, 0, 0)),
      true
    );

    assert.equal(
      engine.isQuietHours(new Date(2026, 0, 2, 6, 59, 0)),
      true
    );

    assert.equal(
      engine.isQuietHours(new Date(2026, 0, 2, 7, 0, 0)),
      false
    );
  });

  await t.test('7. Routine candidate proposal & explicit user confirmation', () => {
    const engine = new PersonalAssistantEngine({ reminderStore, notificationStore });
    const candidate = engine.proposeRoutineCandidate({
      user_id: userIdA,
      tenant_id: tenantId,
      title: '오전 미팅 준비 Routine',
      description: '미팅 30분 전 관련 자료 자동 취합',
      trigger_rule: '30 minutes before calendar event',
      action_suggestion: 'Prepare Meeting Prep Card',
      confidence: 0.95,
      frequency: 7,
      source_memory_ids: ['mem_01', 'mem_02'],
    });

    assert.equal(candidate.status, 'PROPOSED');
    assert.equal(candidate.confidence, 0.95);

    const confirmed = engine.confirmRoutineCandidate(userIdA, candidate.routine_id, true);
    assert.equal(confirmed?.status, 'CONFIRMED');

    const bobCandidate = engine.proposeRoutineCandidate({
      user_id: userIdB,
      tenant_id: tenantId,
      title: 'Bob Routine',
      description: 'Bob custom routine',
      trigger_rule: 'Daily 09:00',
      action_suggestion: 'Bob Daily Brief',
      confidence: 0.8,
      frequency: 3,
      source_memory_ids: ['mem_bob_01'],
    });

    assert.equal(engine.listRoutineCandidates(userIdA).length, 1);
    assert.equal(engine.listRoutineCandidates(userIdB).length, 1);
    assert.equal(engine.listRoutineCandidates(userIdB)[0].routine_id, bobCandidate.routine_id);

    const illegalConfirm = engine.confirmRoutineCandidate(userIdA, bobCandidate.routine_id, true);
    assert.equal(illegalConfirm, null);
  });
});

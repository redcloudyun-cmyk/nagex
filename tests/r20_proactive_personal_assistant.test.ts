import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PersonalReminderStore } from '../src/personal/personal-reminder.store.js';
import { PersonalAssistantEngine } from '../src/personal/personal-assistant.engine.js';
import { NotificationStore } from '../src/notifications/notification.store.js';

test('R20 Personal Proactive Assistant Test Suite', async (t) => {
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
  const assistantEngine = new PersonalAssistantEngine({
    reminderStore,
    notificationStore,
  });

  const userIdA = 'usr_alice_01';
  const userIdB = 'usr_bob_02';
  const tenantId = 'ten_production_01';

  await t.test('1. Reminder create, parse, fire, cancel & restart persistence', () => {
    // Natural language parse
    const parsed = assistantEngine.parseNaturalLanguageReminder('30분 뒤에 김대표에게 전화하라고 알려줘');
    assert.equal(parsed.title, '김대표에게 전화');
    assert.ok(parsed.scheduled_at);

    // Create persistent reminder
    const rem = reminderStore.createReminder({
      user_id: userIdA,
      title: parsed.title,
      scheduled_at: parsed.scheduled_at,
      timezone: 'Asia/Seoul',
      status: 'ACTIVE',
    });
    assert.ok(rem.reminder_id.startsWith('rem_'));
    assert.equal(rem.status, 'ACTIVE');

    // List reminders
    const activeList = reminderStore.listReminders(userIdA, 'ACTIVE');
    assert.equal(activeList.length, 1);
    assert.equal(activeList[0].title, '김대표에게 전화');

    // Due reminders check with future time
    const future = new Date(Date.now() + 40 * 60 * 1000);
    const dueReminders = reminderStore.getDueReminders(future);
    assert.equal(dueReminders.length, 1);
    assert.equal(dueReminders[0].reminder_id, rem.reminder_id);

    // Cancel reminder
    const updated = reminderStore.updateStatus(rem.reminder_id, userIdA, 'CANCELLED');
    assert.equal(updated?.status, 'CANCELLED');
    assert.equal(reminderStore.listReminders(userIdA, 'ACTIVE').length, 0);

    // Restart persistence test
    const freshStore = new PersonalReminderStore(tmpDir);
    const reloaded = freshStore.getReminder(rem.reminder_id);
    assert.ok(reloaded);
    assert.equal(reloaded?.status, 'CANCELLED');
  });

  await t.test('2. Grounded Morning Brief & Source Traceability', () => {
    const brief = assistantEngine.generateMorningBrief(userIdA, tenantId);

    assert.equal(brief.user_id, userIdA);
    assert.equal(brief.greeting, 'Good morning.');
    assert.equal(brief.schedule_summary.event_count, 3);
    assert.equal(brief.attention_items.unreplied_emails_count, 1);
    assert.equal(brief.attention_items.due_tasks_count, 2);
    assert.equal(brief.attention_items.pending_approvals_count, 1);

    // Verify grounding and source traces
    assert.ok(brief.source_traces.length >= 7);
    const calTrace = brief.source_traces.find((t) => t.type === 'CALENDAR');
    assert.ok(calTrace);
    assert.ok(calTrace?.label.includes('프로젝트 미팅'));

    // Grounded recommendation explainability
    assert.ok(brief.recommendation);
    assert.ok(brief.recommendation?.reason.startsWith('Because:'));
  });

  await t.test('3. Quick Wake real context query', () => {
    const qw = assistantEngine.executeQuickWake(userIdA, tenantId);

    assert.ok(qw.right_now.upcoming_meetings.length > 0);
    assert.ok(qw.right_now.unreplied_emails.length > 0);
    assert.ok(qw.right_now.due_tasks.length > 0);
    assert.ok(qw.summary_items.length > 0);
    assert.ok(qw.summary_text.includes('일정이 있습니다'));
  });

  await t.test('4. Contextual Meeting Preparation Card & Vault/Email retrieval', () => {
    const card = assistantEngine.generateMeetingPrepCard(userIdA, 'evt_140', tenantId);

    assert.equal(card.event_title, '14:00 김대표 미팅');
    assert.equal(card.minutes_until, 30);
    assert.equal(card.related_materials.length, 3);

    const vaultMat = card.related_materials.find((m) => m.type === 'VAULT');
    assert.equal(vaultMat?.title, 'proposal-v3.pdf');

    const emailMat = card.related_materials.find((m) => m.type === 'EMAIL');
    assert.ok(emailMat?.title.includes('가격 제안 수정 요청건'));

    const memoryMat = card.related_materials.find((m) => m.type === 'MEMORY');
    assert.ok(memoryMat?.title.includes('지난 회의 메모'));

    assert.ok(card.suggested_action);
    assert.equal(card.suggested_action?.requires_approval, true);
    assert.ok(card.reason.startsWith('Because:'));
  });

  await t.test('5. Personal Watch trigger & deduplication', () => {
    const watch = assistantEngine.createPersonalWatch({
      user_id: userIdA,
      tenant_id: tenantId,
      title: '중요 메일 감시 Watch',
      condition_type: 'EMAIL',
      criteria: 'unreplied',
    });

    assert.equal(watch.status, 'ACTIVE');

    // First evaluation: condition true -> notification created
    const res1 = assistantEngine.evaluatePersonalWatches(userIdA, tenantId);
    assert.equal(res1.length, 1);
    assert.equal(res1[0].triggered, true);
    assert.equal(res1[0].notificationCreated, true);

    // Second evaluation on SAME condition & SAME item: deduped (no new notification)
    const res2 = assistantEngine.evaluatePersonalWatches(userIdA, tenantId);
    assert.equal(res2.length, 1);
    assert.equal(res2[0].triggered, true);
    assert.equal(res2[0].notificationCreated, false); // DEDUPED!

    // Pause watch test
    assistantEngine.toggleWatchStatus(watch.watch_id, userIdA, 'PAUSED');
    const res3 = assistantEngine.evaluatePersonalWatches(userIdA, tenantId);
    assert.equal(res3.length, 0); // No active watches evaluated
  });

  await t.test('6. Routine candidate proposal & explicit user confirmation', () => {
    const candidate = assistantEngine.proposeRoutineCandidate({
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

    // User confirms candidate
    const confirmed = assistantEngine.confirmRoutineCandidate(userIdA, candidate.routine_id, true);
    assert.equal(confirmed?.status, 'CONFIRMED');

    // Confirm candidate for user B isolation test
    const bobCandidate = assistantEngine.proposeRoutineCandidate({
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

    assert.equal(assistantEngine.listRoutineCandidates(userIdA).length, 1);
    assert.equal(assistantEngine.listRoutineCandidates(userIdB).length, 1);
    assert.equal(assistantEngine.listRoutineCandidates(userIdB)[0].routine_id, bobCandidate.routine_id);

    // Cross-user confirmation access attempt fails
    const illegalConfirm = assistantEngine.confirmRoutineCandidate(userIdA, bobCandidate.routine_id, true);
    assert.equal(illegalConfirm, null);
  });
});

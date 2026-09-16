// R10.1 — Change detection + IMPORTANT_CHANGE notifications + the Home
// "Proactive Assistant state" line. detectMeaningfulChanges/
// dispatchDetectedChanges are pure/thin enough to test directly (no HTTP,
// no real Calendar/Gmail); the Home state line reuses the same vm-sandbox
// pattern tests/plan_resolution_ui.test.ts already established for testing
// a browser IIFE's real (not reimplemented) logic without a DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { detectMeaningfulChanges, dispatchDetectedChanges } from '../src/assistant/daily-brief-change-detection.js';
import type { GeneratedDailyBrief } from '../src/assistant/daily-brief.pipeline.js';
import type { DailyBriefRecord } from '../src/governance/daily-brief.store.js';
import { NotificationEngine } from '../src/notifications/notification.engine.js';
import { NotificationStore } from '../src/notifications/notification.store.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import fsSync from 'node:fs';
import os from 'node:os';

function baseRecord(overrides: Partial<DailyBriefRecord> = {}): DailyBriefRecord {
  return {
    briefId: 'db_fixture',
    tenantId: 'ten_cd',
    principalId: 'usr_cd',
    date: '2026-09-17',
    generatedAt: '2026-09-17T00:00:00.000Z',
    status: 'OK',
    provider: 'nebius',
    model: 'test-model',
    latencyMs: 10,
    fallbackOccurred: false,
    calendarStatus: 'CONNECTED',
    gmailStatus: 'CONNECTED',
    schedule: [],
    emails: [],
    summary: 'ok',
    actionItems: [],
    requestId: 'req_fixture',
    source: 'SCHEDULED',
    ...overrides,
  };
}

function baseCurrent(overrides: Partial<GeneratedDailyBrief> = {}): GeneratedDailyBrief {
  const { briefId, ...rest } = baseRecord();
  return { ...rest, ...overrides };
}

// ── detectMeaningfulChanges: pure unit tests ──────────────────────────────

test('1. no baseline (first generation of the day) never reports a change, even with real data present', () => {
  const current = baseCurrent({ schedule: [{ sourceType: 'CALENDAR', sourceId: 'evt_1', title: 'Standup', start: 't0', end: 't1', capability: 'google_calendar', timestamp: 't0', status: 'confirmed', updated: 'u0' }] });
  const changes = detectMeaningfulChanges({ previous: null, current });
  assert.deepEqual(changes, []);
});

test('2. no real change between two generations produces no notification', () => {
  const schedule: DailyBriefRecord['schedule'] = [{ sourceType: 'CALENDAR', sourceId: 'evt_1', title: 'Standup', start: 't0', end: 't1', capability: 'google_calendar', timestamp: 't0', status: 'confirmed', updated: 'u0' }];
  const previous = baseRecord({ schedule });
  // Same event, same start/end, only its `updated` timestamp bumped — a
  // real Google field that changes on ANY edit including irrelevant ones
  // (e.g. attendee RSVP) must never by itself trigger a notification.
  const current = baseCurrent({ schedule: [{ ...schedule[0], updated: 'u1' }] });
  const changes = detectMeaningfulChanges({ previous, current });
  assert.deepEqual(changes, []);
});

test('3. a genuinely new calendar event produces CALENDAR_NEW', () => {
  const previous = baseRecord({ schedule: [] });
  const current = baseCurrent({ schedule: [{ sourceType: 'CALENDAR', sourceId: 'evt_2', title: 'Client call', start: 't0', end: 't1', capability: 'google_calendar', timestamp: 't0', status: 'confirmed', updated: null }] });
  const changes = detectMeaningfulChanges({ previous, current });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, 'CALENDAR_NEW');
  assert.match(changes[0].body, /Client call/);
});

test('4. the same event moving to a new start/end produces CALENDAR_MOVED, not CALENDAR_NEW', () => {
  const previous = baseRecord({ schedule: [{ sourceType: 'CALENDAR', sourceId: 'evt_3', title: 'Client meeting', start: '2026-09-17T10:00:00Z', end: '2026-09-17T10:30:00Z', capability: 'google_calendar', timestamp: 't0', status: 'confirmed', updated: null }] });
  const current = baseCurrent({ schedule: [{ sourceType: 'CALENDAR', sourceId: 'evt_3', title: 'Client meeting', start: '2026-09-17T15:00:00Z', end: '2026-09-17T15:30:00Z', capability: 'google_calendar', timestamp: 't0', status: 'confirmed', updated: 'u1' }] });
  const changes = detectMeaningfulChanges({ previous, current });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, 'CALENDAR_MOVED');
  assert.match(changes[0].body, /15:00/);
});

test('5. an event dropping out of today\'s list (real cancellation signal) produces CALENDAR_CANCELLED', () => {
  const previous = baseRecord({ schedule: [{ sourceType: 'CALENDAR', sourceId: 'evt_4', title: 'Design review', start: 't0', end: 't1', capability: 'google_calendar', timestamp: 't0', status: 'confirmed', updated: null }] });
  const current = baseCurrent({ schedule: [] });
  const changes = detectMeaningfulChanges({ previous, current });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, 'CALENDAR_CANCELLED');
});

test('6. a new unread email produces GMAIL_NEW; a deadline/action-worded one produces GMAIL_ACTION_REQUEST instead', () => {
  const previous = baseRecord({ emails: [] });
  const current = baseCurrent({
    emails: [
      { sourceType: 'GMAIL', sourceId: 'th_1', snippet: 'Here is the weekly newsletter.', capability: 'gmail', timestamp: null, historyId: 'h1' },
      { sourceType: 'GMAIL', sourceId: 'th_2', snippet: 'Please respond by Friday — this is time-sensitive.', capability: 'gmail', timestamp: null, historyId: 'h2' },
    ],
  });
  const changes = detectMeaningfulChanges({ previous, current });
  assert.equal(changes.length, 2);
  const byId = Object.fromEntries(changes.map((c) => [c.dedupeSuffix, c.kind]));
  assert.equal(byId['gmail:new:th_1'], 'GMAIL_NEW');
  assert.equal(byId['gmail:action:th_2'], 'GMAIL_ACTION_REQUEST');
});

test('7. irrelevant metadata differences (disconnected source, historyId-only change) never produce a change', () => {
  const previous = baseRecord({ gmailStatus: 'DISCONNECTED', emails: [] });
  const current = baseCurrent({ gmailStatus: 'CONNECTED', emails: [{ sourceType: 'GMAIL', sourceId: 'th_9', snippet: 'hi', capability: 'gmail', timestamp: null, historyId: 'h9' }] });
  // gmailStatus differs between previous/current (DISCONNECTED -> CONNECTED)
  // — diffing against a source that wasn't even connected last time would
  // report every item as "new", which is not a real change; must stay silent.
  assert.deepEqual(detectMeaningfulChanges({ previous, current }), []);
});

test('8. a newly proposed approval since the last brief produces APPROVAL_NEW', () => {
  const previous = baseRecord();
  const current = baseCurrent();
  const changes = detectMeaningfulChanges({
    previous, current,
    newApprovalsSincePrevious: [{ approvalId: 'apr_1', toolId: 'gmail.send_message', createdAt: '2026-09-17T01:00:00.000Z' }],
  });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, 'APPROVAL_NEW');
});

test('9. a new HIGH-priority recommended action produces ACTION_ITEM_HIGH_NEW; a new LOW/MEDIUM one does not', () => {
  const previous = baseRecord({ actionItems: [] });
  const current = baseCurrent({
    actionItems: [
      { title: 'Reply to client', reasoning: 'r', priority: 'HIGH' },
      { title: 'Read newsletter', reasoning: 'r', priority: 'LOW' },
    ],
  });
  const changes = detectMeaningfulChanges({ previous, current });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, 'ACTION_ITEM_HIGH_NEW');
});

// ── dispatchDetectedChanges: real dedup via a real NotificationEngine ────

function buildRealNotificationEngine() {
  const store = new NotificationStore({ dir: fsSync.mkdtempSync(path.join(os.tmpdir(), 'nagex-notif-test-')) });
  return new NotificationEngine({ store, auditLogger: new AuditLogger() });
}

test('10. duplicate change (same tenant/principal/date/signature) is deduped, not double-notified', async () => {
  const engine = buildRealNotificationEngine();
  const changes = detectMeaningfulChanges({
    previous: baseRecord({ schedule: [] }),
    current: baseCurrent({ schedule: [{ sourceType: 'CALENDAR', sourceId: 'evt_dup', title: 'Dup test', start: 't0', end: 't1', capability: 'google_calendar', timestamp: 't0', status: 'confirmed', updated: null }] }),
  });
  assert.equal(changes.length, 1);
  await dispatchDetectedChanges(engine, 'ten_dup', 'usr_dup', '2026-09-17', changes, 'req_dup_1');
  await dispatchDetectedChanges(engine, 'ten_dup', 'usr_dup', '2026-09-17', changes, 'req_dup_2');
  const list = engine.list('ten_dup', 'usr_dup', 50);
  assert.equal(list.length, 1, 'the same logical change must produce exactly one persisted notification');
  assert.equal(list[0].type, 'IMPORTANT_CHANGE');
});

test('11. no changes means no notification is dispatched at all', async () => {
  const engine = buildRealNotificationEngine();
  await dispatchDetectedChanges(engine, 'ten_none', 'usr_none', '2026-09-17', [], 'req_none');
  assert.equal(engine.list('ten_none', 'usr_none', 50).length, 0);
});

// ── Home Proactive Assistant state line: the real browser logic, run in a
//    vm sandbox (no jsdom in this repo — same technique already used by
//    tests/plan_resolution_ui.test.ts for plan-resolution-view.js). ────────

function loadDailyBriefView(locale: 'en' | 'ko' = 'en'): {
  buildProactiveState: (data: unknown, cfg: unknown) => { text: string; cls: string; retry: boolean } | null;
} {
  const i18nSource = fs.readFileSync(path.join(process.cwd(), 'public', 'i18n.js'), 'utf8');
  const source = fs.readFileSync(path.join(process.cwd(), 'public', 'daily-brief.js'), 'utf8');
  const storage: Record<string, string> = {};
  const documentStub = { documentElement: {} as Record<string, unknown>, title: '', querySelectorAll: () => [] as unknown[] };
  const localStorageStub = {
    getItem: (key: string) => (Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null),
    setItem: (key: string, value: string) => { storage[key] = value; },
  };
  const sandbox: Record<string, unknown> = { document: documentStub, localStorage: localStorageStub };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(i18nSource, sandbox, { filename: 'i18n.js' });
  if (locale === 'ko') (sandbox.window as { NAGEX_I18N: { setLocale: (l: string) => void } }).NAGEX_I18N.setLocale('ko');
  vm.runInContext(source, sandbox, { filename: 'daily-brief.js' });
  return (sandbox.window as Record<string, unknown>).NAGEX_DAILY_BRIEF_VIEW as ReturnType<typeof loadDailyBriefView>;
}

test('12. Home state: automation OFF never shows a proactive line, even with a real brief present', () => {
  const view = loadDailyBriefView();
  const state = view.buildProactiveState({ date: '2026-09-17', status: 'OK', source: 'SCHEDULED' }, { enabled: false, taskStatus: 'PAUSED' });
  assert.equal(state, null);
});

test('13. Home state: Generating — task currently RUNNING', () => {
  const view = loadDailyBriefView();
  const state = view.buildProactiveState(null, { enabled: true, taskStatus: 'RUNNING' });
  assert.ok(state);
  assert.equal(state!.cls, 'db-proactive-generating');
  assert.match(state!.text, /Generating/);
  assert.equal(state!.retry, false);
});

test('14. Home state: Ready — a real, today, SCHEDULED-sourced brief exists', () => {
  const view = loadDailyBriefView();
  const today = new Date().toISOString().slice(0, 10);
  const state = view.buildProactiveState({ date: today, status: 'OK', source: 'SCHEDULED' }, { enabled: true, taskStatus: 'ACTIVE', localTime: '08:00', lastRunStatus: 'SUCCEEDED' });
  assert.ok(state);
  assert.equal(state!.cls, 'db-proactive-ready');
  assert.match(state!.text, /08:00/);
});

test('15. Home state: Ready never claims a manually-generated brief was automatic', () => {
  const view = loadDailyBriefView();
  const today = new Date().toISOString().slice(0, 10);
  const state = view.buildProactiveState({ date: today, status: 'OK', source: 'MANUAL' }, { enabled: true, taskStatus: 'ACTIVE', localTime: '08:00', nextRunAt: '2026-09-18T23:00:00.000Z' });
  // Falls through to "Scheduled" (next run), never fake-claims automatic generation.
  assert.ok(state);
  assert.equal(state!.cls, 'db-proactive-scheduled');
});

test('16. Home state: Failed — last scheduled run failed and no usable brief exists for today, offers Retry', () => {
  const view = loadDailyBriefView();
  const state = view.buildProactiveState(null, { enabled: true, taskStatus: 'ACTIVE', lastRunStatus: 'FAILED' });
  assert.ok(state);
  assert.equal(state!.cls, 'db-proactive-failed');
  assert.equal(state!.retry, true);
});

test('17. Home state: Failed is never shown once a usable brief exists for today, even if the last run status is stale FAILED', () => {
  const view = loadDailyBriefView();
  const today = new Date().toISOString().slice(0, 10);
  // e.g. the scheduled run failed, the user then manually refreshed successfully.
  const state = view.buildProactiveState({ date: today, status: 'OK', source: 'MANUAL' }, { enabled: true, taskStatus: 'ACTIVE', lastRunStatus: 'FAILED', nextRunAt: null });
  assert.notEqual(state?.cls, 'db-proactive-failed');
});

test('18. Home state: fully localized in KR — no stray English leaks into the Generating/Ready/Failed strings', () => {
  const view = loadDailyBriefView('ko');
  const generating = view.buildProactiveState(null, { enabled: true, taskStatus: 'RUNNING' });
  assert.ok(generating);
  assert.equal(generating!.text, '아침 브리핑을 생성하는 중…');

  const today = new Date().toISOString().slice(0, 10);
  const ready = view.buildProactiveState({ date: today, status: 'OK', source: 'SCHEDULED' }, { enabled: true, taskStatus: 'ACTIVE', localTime: '08:00' });
  assert.ok(ready);
  assert.match(ready!.text, /자동으로 생성됨/);

  const failed = view.buildProactiveState(null, { enabled: true, taskStatus: 'ACTIVE', lastRunStatus: 'FAILED' });
  assert.ok(failed);
  assert.equal(failed!.text, '아침 브리핑을 생성하지 못했습니다.');
  assert.equal(failed!.retry, true);
});

test('19. Home state: EN strings match the canonical English copy exactly', () => {
  const view = loadDailyBriefView('en');
  const generating = view.buildProactiveState(null, { enabled: true, taskStatus: 'RUNNING' });
  assert.equal(generating!.text, 'Generating your morning brief…');
  const failed = view.buildProactiveState(null, { enabled: true, taskStatus: 'ACTIVE', lastRunStatus: 'FAILED' });
  assert.equal(failed!.text, "Morning brief couldn't be generated.");
  assert.equal(failed!.retry, true);
});

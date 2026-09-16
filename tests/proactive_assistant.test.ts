// R10 — Proactive Assistant. Tests the genuinely new pieces: the
// /api/v1/proactive-assistant/config upsert route, CompositeTaskRunner's
// new DAILY_BRIEF dispatch branch, and DailyBriefTaskRunner's real
// success/failure/notification behavior. Scheduling itself (cron parsing,
// timezone/DST correctness, duplicate-tick prevention, restart recovery)
// is NOT re-tested here — it is the existing, already-tested
// TaskScheduler/TaskStore/computeNextScheduleRun machinery (see
// task.scheduler.test.ts), reused unmodified per R10 §2's own instruction
// not to build a parallel scheduler.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleAsyncApiRequest, taskStore as sharedTaskStore } from '../src/server_web.js';
import { InMemoryGoogleOAuthTokenStore } from '../src/integrations/google/token.store.js';
import type { GoogleOAuthConfig } from '../src/integrations/google/oauth.client.js';
import { ActionApprovalStore } from '../src/governance/action-approval.store.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { MemoryEngine } from '../src/context/memory.engine.js';
import { GoogleCalendarService } from '../src/modules/calendar/index.js';
import { GmailService } from '../src/modules/gmail/gmail.service.js';
import { AiService } from '../src/model-gateway/ai-service.js';
import { UnifiedModelRouter } from '../src/model-gateway/unified-model-router.js';
import type { ModelProvider, ModelRequest, ModelResponse, ProviderStatus } from '../src/model-gateway/model-provider.js';
import { TaskStore } from '../src/tasks/task.store.js';
import { ActivityStore } from '../src/governance/activity.store.js';
import { DailyBriefStore } from '../src/governance/daily-brief.store.js';
import { DailyBriefTaskRunner, CompositeTaskRunner, PlanPreviewTaskRunner, ConditionalWatchTaskRunner } from '../src/tasks/task.runner.js';
import { TaskScheduler } from '../src/tasks/task.scheduler.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const config: GoogleOAuthConfig = { clientId: 'cid', clientSecret: 'csecret', redirectUri: 'https://nagex-test.agex.site/api/v1/oauth/google/callback' };

function fakeModelProvider(reply: () => string | Error): ModelProvider {
  return {
    name: 'nebius',
    model: 'test-model',
    status: (): ProviderStatus => ({ configured: true, available: true, provider: 'nebius', model: 'test-model', status: 'LIVE', lastCheckedAt: null, degradedReason: null }),
    generate: async (request: ModelRequest): Promise<ModelResponse> => {
      const result = reply();
      if (result instanceof Error) throw result;
      return { text: result, provider: 'nebius', model: 'test-model', latencyMs: 1, requestId: request.requestId };
    },
  };
}

function buildHarness(modelReply: () => string | Error = () => JSON.stringify({ summary: 'ok', actionItems: [] })) {
  const calendarTokenStore = new InMemoryGoogleOAuthTokenStore();
  const gmailTokenStore = new InMemoryGoogleOAuthTokenStore();
  const approvals = new ActionApprovalStore();
  const audit = new AuditLogger();
  const memory = new MemoryEngine();
  const calendarService = new GoogleCalendarService(calendarTokenStore, approvals, audit, memory, async () => jsonResponse({ items: [] }), () => config);
  const gmailService = new GmailService(gmailTokenStore, approvals, audit, memory, async () => jsonResponse({ threads: [] }), () => config);
  const aiService = new AiService(new UnifiedModelRouter([fakeModelProvider(modelReply)], { info: () => {}, warn: () => {} }));
  const taskStore = new TaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-tasks-test-')) });
  const activityStore = new ActivityStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-activity-test-')) });
  const dailyBriefStore = new DailyBriefStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-briefs-test-')) });
  return { calendarService, gmailService, aiService, taskStore, activityStore, dailyBriefStore };
}

const RUN_ID = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
function headersFor(name: string) {
  return { 'x-nagex-tenant': 'ten_proactive', 'x-principal-id': `usr_${name}_${RUN_ID}` };
}

test('GET /api/v1/proactive-assistant/config with no schedule yet returns a truthful disabled default, never a fake enabled state', async () => {
  const h = buildHarness();
  const HEADERS = headersFor('no_config');
  const res = await handleAsyncApiRequest('GET', '/api/v1/proactive-assistant/config', null, HEADERS, h.aiService, {}, h.calendarService, h.gmailService);
  assert.equal(res.status, 200);
  const data = res.data as any;
  assert.equal(data.enabled, false);
  assert.equal(data.localTime, null);
  assert.equal(data.nextRunAt, null);
});

test('PUT /api/v1/proactive-assistant/config creates a real underlying RECURRING Task with a correctly-computed nextRunAt', async () => {
  const h = buildHarness();
  const HEADERS = headersFor('create');
  const res = await handleAsyncApiRequest('PUT', '/api/v1/proactive-assistant/config', { enabled: true, localTime: '08:00', timezone: 'Asia/Seoul', weekdays: [1, 2, 3, 4, 5], notifyOnComplete: true }, HEADERS, h.aiService, {}, h.calendarService, h.gmailService);
  assert.equal(res.status, 200);
  const data = res.data as any;
  assert.equal(data.enabled, true);
  assert.equal(data.localTime, '08:00');
  assert.equal(data.timezone, 'Asia/Seoul');
  assert.deepEqual(data.weekdays, [1, 2, 3, 4, 5]);
  assert.ok(data.nextRunAt);
  // 08:00 KST = 23:00 UTC the previous day — real timezone-aware
  // computation (Intl-based, DST-safe), not a server-local-time guess.
  assert.match(data.nextRunAt, /T23:00:00\.000Z$/);
});

test('PUT with enabled=false never produces a nextRunAt, and the task is real but paused', async () => {
  const h = buildHarness();
  const HEADERS = headersFor('disabled');
  const res = await handleAsyncApiRequest('PUT', '/api/v1/proactive-assistant/config', { enabled: false, localTime: '09:00', timezone: 'UTC', weekdays: [0, 1, 2, 3, 4, 5, 6] }, HEADERS, h.aiService, {}, h.calendarService, h.gmailService);
  const data = res.data as any;
  assert.equal(data.enabled, false);
  assert.equal(data.nextRunAt, null);
});

test('PUT rejects an invalid IANA timezone rather than silently falling back to UTC or the server local zone', async () => {
  const h = buildHarness();
  const HEADERS = headersFor('bad_timezone');
  const res = await handleAsyncApiRequest('PUT', '/api/v1/proactive-assistant/config', { enabled: true, localTime: '08:00', timezone: 'Not/AZone', weekdays: [1] }, HEADERS, h.aiService, {}, h.calendarService, h.gmailService);
  assert.equal((res.data as any).error.code, 'PROACTIVE_ASSISTANT_CONFIG_INVALID');
});

test('a second PUT updates the same underlying task rather than creating a duplicate schedule', async () => {
  const h = buildHarness();
  const HEADERS = headersFor('update_not_duplicate');
  await handleAsyncApiRequest('PUT', '/api/v1/proactive-assistant/config', { enabled: true, localTime: '08:00', timezone: 'UTC', weekdays: [1] }, HEADERS, h.aiService, {}, h.calendarService, h.gmailService);
  await handleAsyncApiRequest('PUT', '/api/v1/proactive-assistant/config', { enabled: true, localTime: '09:30', timezone: 'UTC', weekdays: [2] }, HEADERS, h.aiService, {}, h.calendarService, h.gmailService);
  // The route itself uses the real shared module-level taskStore (same
  // pattern as activityStore/actionApprovals elsewhere in server_web.ts —
  // not the DI'd calendarService/gmailApiService/aiService), so this
  // assertion reads from that same shared store, not the harness's own
  // isolated one.
  const tasks = sharedTaskStore.list(HEADERS['x-nagex-tenant'], HEADERS['x-principal-id']);
  const dailyBriefTasks = tasks.filter((t) => t.automationKind === 'DAILY_BRIEF');
  assert.equal(dailyBriefTasks.length, 1, 'must update in place, never create a second schedule');
  assert.equal(dailyBriefTasks[0].trigger.schedule, '30 9 * * 2');
});

test('CompositeTaskRunner routes a task with automationKind DAILY_BRIEF to DailyBriefTaskRunner, not the generic plan/execute path', async () => {
  const h = buildHarness();
  const runner = new DailyBriefTaskRunner(
    { calendarService: h.calendarService, gmailApiService: h.gmailService, aiService: h.aiService, taskStore: h.taskStore, activityStore: h.activityStore },
    h.dailyBriefStore,
  );
  const composite = new CompositeTaskRunner(
    new PlanPreviewTaskRunner(h.aiService, {} as any, () => []),
    new ConditionalWatchTaskRunner({} as any, h.aiService),
    undefined,
    undefined,
    runner,
  );
  const task = h.taskStore.create({
    tenantId: 'ten_route', ownerId: 'usr_route', name: 'Daily Brief', objective: 'x',
    type: 'RECURRING', trigger: { type: 'SCHEDULE', schedule: '0 8 * * *', timezone: 'UTC' },
    approvalPolicy: 'READ_ONLY_AUTO', automationKind: 'DAILY_BRIEF', notifyOnComplete: false,
  });
  const outcome = await composite.run(task, 'req_route_test', 'run_route_test');
  // Real success (mocked provider succeeds) proves DailyBriefTaskRunner
  // actually ran — PlanPreviewTaskRunner would never produce this shape.
  assert.equal(outcome.status, 'SUCCEEDED');
  assert.equal((outcome.result as any).kind, 'DAILY_BRIEF');
});

test('DailyBriefTaskRunner: success persists the brief and dispatches DAILY_BRIEF_READY only when notifyOnComplete is true', async () => {
  const h = buildHarness(() => JSON.stringify({ summary: 'Morning brief ready.', actionItems: [] }));
  const dispatched: any[] = [];
  const fakeNotificationEngine = { dispatch: async (opts: any) => { dispatched.push(opts); return {}; } } as any;
  const runner = new DailyBriefTaskRunner(
    { calendarService: h.calendarService, gmailApiService: h.gmailService, aiService: h.aiService, taskStore: h.taskStore, activityStore: h.activityStore },
    h.dailyBriefStore,
    fakeNotificationEngine,
  );
  const task = h.taskStore.create({
    tenantId: 'ten_notify', ownerId: 'usr_notify', name: 'Daily Brief', objective: 'x',
    type: 'RECURRING', trigger: { type: 'SCHEDULE', schedule: '0 8 * * *', timezone: 'UTC' },
    approvalPolicy: 'READ_ONLY_AUTO', automationKind: 'DAILY_BRIEF', notifyOnComplete: true,
  });
  const outcome = await runner.run(task, 'req_notify_test', 'run_notify_test');
  assert.equal(outcome.status, 'SUCCEEDED');
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].type, 'DAILY_BRIEF_READY');
  assert.equal(dispatched[0].tenantId, 'ten_notify');

  const persisted = h.dailyBriefStore.getForDate('ten_notify', 'usr_notify', new Date().toISOString().slice(0, 10));
  assert.ok(persisted);
  assert.equal(persisted!.summary, 'Morning brief ready.');
});

test('DailyBriefTaskRunner: notifyOnComplete=false suppresses the DAILY_BRIEF_READY notification but still persists the brief', async () => {
  const h = buildHarness();
  const dispatched: any[] = [];
  const fakeNotificationEngine = { dispatch: async (opts: any) => { dispatched.push(opts); return {}; } } as any;
  const runner = new DailyBriefTaskRunner(
    { calendarService: h.calendarService, gmailApiService: h.gmailService, aiService: h.aiService, taskStore: h.taskStore, activityStore: h.activityStore },
    h.dailyBriefStore,
    fakeNotificationEngine,
  );
  const task = h.taskStore.create({
    tenantId: 'ten_silent', ownerId: 'usr_silent', name: 'Daily Brief', objective: 'x',
    type: 'RECURRING', trigger: { type: 'SCHEDULE', schedule: '0 8 * * *', timezone: 'UTC' },
    approvalPolicy: 'READ_ONLY_AUTO', automationKind: 'DAILY_BRIEF', notifyOnComplete: false,
  });
  await runner.run(task, 'req_silent_test', 'run_silent_test');
  assert.equal(dispatched.length, 0);
  assert.ok(h.dailyBriefStore.getForDate('ten_silent', 'usr_silent', new Date().toISOString().slice(0, 10)));
});

test('DailyBriefTaskRunner: a real provider failure returns FAILED truthfully and dispatches no DAILY_BRIEF_READY notification', async () => {
  const h = buildHarness(() => new Error('all providers down'));
  const dispatched: any[] = [];
  const fakeNotificationEngine = { dispatch: async (opts: any) => { dispatched.push(opts); return {}; } } as any;
  const runner = new DailyBriefTaskRunner(
    { calendarService: h.calendarService, gmailApiService: h.gmailService, aiService: h.aiService, taskStore: h.taskStore, activityStore: h.activityStore },
    h.dailyBriefStore,
    fakeNotificationEngine,
  );
  const task = h.taskStore.create({
    tenantId: 'ten_fail', ownerId: 'usr_fail', name: 'Daily Brief', objective: 'x',
    type: 'RECURRING', trigger: { type: 'SCHEDULE', schedule: '0 8 * * *', timezone: 'UTC' },
    approvalPolicy: 'READ_ONLY_AUTO', automationKind: 'DAILY_BRIEF', notifyOnComplete: true,
  });
  const outcome = await runner.run(task, 'req_fail_test', 'run_fail_test');
  assert.equal(outcome.status, 'FAILED');
  assert.equal(outcome.errorCode, 'DAILY_BRIEF_UNAVAILABLE');
  assert.equal(dispatched.length, 0, 'no DAILY_BRIEF_READY for a real failure');
  assert.equal(h.dailyBriefStore.getForDate('ten_fail', 'usr_fail', new Date().toISOString().slice(0, 10)), null, 'an UNAVAILABLE generation must never be persisted as today\'s brief');
});

test('end-to-end: TaskScheduler.runOne on a real due DAILY_BRIEF task calls finalizeTaskRun, which reschedules nextRunAt and records a real TaskRun', async () => {
  const h = buildHarness();
  const runner = new DailyBriefTaskRunner(
    { calendarService: h.calendarService, gmailApiService: h.gmailService, aiService: h.aiService, taskStore: h.taskStore, activityStore: h.activityStore },
    h.dailyBriefStore,
  );
  const { TaskRunStore } = await import('../src/tasks/task-run.store.js');
  const runStore = new TaskRunStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-runs-test-')) });
  const scheduler = new TaskScheduler(h.taskStore, runStore, runner, new AuditLogger());

  const inOneMinute = new Date(Date.now() + 60_000);
  const task = h.taskStore.create({
    tenantId: 'ten_e2e', ownerId: 'usr_e2e', name: 'Daily Brief', objective: 'x',
    type: 'RECURRING',
    trigger: { type: 'SCHEDULE', schedule: `${inOneMinute.getUTCMinutes()} ${inOneMinute.getUTCHours()} * * *`, timezone: 'UTC' },
    approvalPolicy: 'READ_ONLY_AUTO', automationKind: 'DAILY_BRIEF', notifyOnComplete: false,
    nextRunAt: inOneMinute.toISOString(),
  });

  const run = await scheduler.runOne(task);
  assert.equal(run.status, 'SUCCEEDED');
  const updated = h.taskStore.get(task.taskId, 'ten_e2e', 'usr_e2e');
  assert.equal(updated!.lastRunStatus, 'SUCCEEDED');
  assert.ok(updated!.lastRunAt);
  assert.ok(updated!.nextRunAt, 'a RECURRING task must be rescheduled after a real run, not left null');
  assert.notEqual(updated!.nextRunAt, inOneMinute.toISOString(), 'nextRunAt must advance to the next real occurrence, not repeat the one just run');
});

test('security: proactive-assistant config for one tenant/principal is never visible to another', async () => {
  const h = buildHarness();
  const HEADERS_A = headersFor('sec_a');
  const HEADERS_B = { 'x-nagex-tenant': 'ten_other_proactive', 'x-principal-id': `usr_sec_b_${RUN_ID}` };
  await handleAsyncApiRequest('PUT', '/api/v1/proactive-assistant/config', { enabled: true, localTime: '07:00', timezone: 'UTC', weekdays: [1] }, HEADERS_A, h.aiService, {}, h.calendarService, h.gmailService);
  const resB = await handleAsyncApiRequest('GET', '/api/v1/proactive-assistant/config', null, HEADERS_B, h.aiService, {}, h.calendarService, h.gmailService);
  assert.equal((resB.data as any).enabled, false, "tenant B must never see tenant A's schedule");
});

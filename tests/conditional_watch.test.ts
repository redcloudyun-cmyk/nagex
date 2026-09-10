import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import type { AddressInfo } from 'node:net';
import { TaskStore } from '../src/tasks/task.store.js';
import { TaskRunStore } from '../src/tasks/task-run.store.js';
import { TaskScheduler, computeNextRunAt } from '../src/tasks/task.scheduler.js';
import { ConditionalWatchTaskRunner, CompositeTaskRunner, PlanPreviewTaskRunner } from '../src/tasks/task.runner.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { ActionApprovalStore } from '../src/governance/action-approval.store.js';
import { MemoryEngine } from '../src/context/memory.engine.js';
import { BrowserSessionStore } from '../src/browser/browser-session.store.js';
import { PlaywrightBrowserRuntime } from '../src/integrations/browser/browser.runtime.js';
import { BrowserToolService } from '../src/tools/browser.service.js';
import { AiService } from '../src/model-gateway/ai-service.js';
import type { ModelProvider } from '../src/model-gateway/model-provider.js';
import { UnifiedModelRouter } from '../src/model-gateway/unified-model-router.js';
import { PlanResolver } from '../src/planning/plan-resolver.js';
import { skillRegistry } from '../src/skills/skill-registry.js';
import { toolRegistry } from '../src/tools/tool-registry.js';
import { CapabilityBroker } from '../src/capabilities/capability-broker.js';
import { handleApiRequest, handleAsyncApiRequest } from '../src/server_web.js';

function startFixtureServer(priceText: string): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html><head><title>Flight Price</title></head><body><p>${priceText}</p></body></html>`);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ origin: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

// One shared Chromium process for this whole file — see browser_agent.test.ts
// for why (avoids launching/leaking a browser process per test).
const sharedRuntime = new PlaywrightBrowserRuntime();
after(async () => {
  await sharedRuntime.shutdown();
});

function buildBrowserService() {
  return new BrowserToolService(sharedRuntime, new BrowserSessionStore(), new ActionApprovalStore(), new AuditLogger(), new MemoryEngine());
}

function buildCapabilityBroker(browserService: BrowserToolService = buildBrowserService()): CapabilityBroker {
  return new CapabilityBroker(undefined as any, undefined as any, browserService, new AuditLogger());
}

// A mock model whose response is controlled per-test, and which records the
// exact prompt it was sent — lets tests verify the real page snapshot text
// actually reaches the judgment prompt, without a real LLM call.
function buildMockAiService(responseText: string, capture?: { lastPrompt: string }): AiService {
  const provider: ModelProvider = {
    name: 'test',
    model: 'test-model',
    status: () => ({ configured: true, available: true, provider: 'test', model: 'test-model' }),
    generate: async (request) => {
      if (capture) capture.lastPrompt = request.messages[request.messages.length - 1]?.content || '';
      return { text: responseText, provider: 'test', model: 'test-model', latencyMs: 1, requestId: request.requestId };
    },
  };
  return new AiService(new UnifiedModelRouter([provider], { info: () => {}, warn: () => {} }));
}

function conditionTask(overrides: Record<string, unknown> = {}) {
  return {
    taskId: 'tsk_watch_1',
    tenantId: 'ten_1',
    ownerId: 'usr_watch_1',
    name: 'Flight price watch',
    objective: 'Watch for a flight price drop.',
    type: 'CONDITIONAL' as const,
    status: 'WAITING' as const,
    sourceSessionId: null,
    trigger: { type: 'CONDITION' as const, condition: 'The price is below $800', watchUrl: '', checkIntervalMinutes: 15 },
    approvalPolicy: 'READ_ONLY_AUTO' as const,
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ── computeNextRunAt ─────────────────────────────────────────────────────

test('computeNextRunAt schedules a CONDITION trigger with watchUrl+checkIntervalMinutes; a bare condition (no watchUrl) is never scheduler-driven', () => {
  const from = new Date('2026-06-01T00:00:00.000Z');
  const scheduled = computeNextRunAt({ type: 'CONDITION', watchUrl: 'https://example.com', checkIntervalMinutes: 15 }, from);
  assert.ok(scheduled);
  assert.equal(scheduled!.toISOString(), '2026-06-01T00:15:00.000Z');

  assert.equal(computeNextRunAt({ type: 'CONDITION', condition: 'x' }, from), null);
  assert.equal(computeNextRunAt({ type: 'CONDITION', watchUrl: 'https://example.com' }, from), null);
});

// ── TaskStore: create/listDue/recordRunOutcome for CONDITIONAL ──────────────

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-cw-'));
}

test('create() starts a CONDITIONAL task WAITING, never ACTIVE', () => {
  const store = new TaskStore({ dir: tempDir() });
  const task = store.create({
    tenantId: 't1', ownerId: 'u1', name: 'Watch', objective: 'Watch a page.', type: 'CONDITIONAL',
    trigger: { type: 'CONDITION', condition: 'x', watchUrl: 'https://example.com', checkIntervalMinutes: 15 },
  });
  assert.equal(task.status, 'WAITING');
});

test('listDue includes a due WAITING CONDITIONAL task, and excludes one not yet due', () => {
  const store = new TaskStore({ dir: tempDir() });
  const due = store.create({ tenantId: 't1', ownerId: 'u1', name: 'Due watch', objective: 'x', type: 'CONDITIONAL', trigger: { type: 'CONDITION', condition: 'x', watchUrl: 'https://example.com', checkIntervalMinutes: 15 }, nextRunAt: '2026-01-01T00:00:00.000Z' });
  const notYetDue = store.create({ tenantId: 't1', ownerId: 'u1', name: 'Future watch', objective: 'x', type: 'CONDITIONAL', trigger: { type: 'CONDITION', condition: 'x', watchUrl: 'https://example.com', checkIntervalMinutes: 15 }, nextRunAt: '2099-01-01T00:00:00.000Z' });

  const dueList = store.listDue(new Date('2026-06-01T00:00:00.000Z')).map((t) => t.taskId);
  assert.ok(dueList.includes(due.taskId));
  assert.ok(!dueList.includes(notYetDue.taskId));
});

test('recordRunOutcome: condition met completes the task; unmet or failed stays WAITING and reschedules (AC-11)', () => {
  const store = new TaskStore({ dir: tempDir() });
  const task = store.create({ tenantId: 't1', ownerId: 'u1', name: 'Watch', objective: 'x', type: 'CONDITIONAL', trigger: { type: 'CONDITION', condition: 'x', watchUrl: 'https://example.com', checkIntervalMinutes: 15 } });

  const unmet = store.recordRunOutcome(task.taskId, { status: 'SUCCEEDED', completedAt: '2026-06-01T00:00:00.000Z', nextRunAt: '2026-06-01T00:15:00.000Z', conditionMet: false });
  assert.equal(unmet.status, 'WAITING');
  assert.equal(unmet.nextRunAt, '2026-06-01T00:15:00.000Z');

  const failed = store.recordRunOutcome(task.taskId, { status: 'FAILED', completedAt: '2026-06-01T00:15:00.000Z', nextRunAt: '2026-06-01T00:30:00.000Z', conditionMet: false });
  assert.equal(failed.status, 'WAITING'); // a failed check never surfaces as met, and never stops the watch

  const met = store.recordRunOutcome(task.taskId, { status: 'SUCCEEDED', completedAt: '2026-06-01T00:30:00.000Z', nextRunAt: '2026-06-01T00:45:00.000Z', conditionMet: true });
  assert.equal(met.status, 'COMPLETED');
  assert.equal(met.nextRunAt, null);
});

// ── ConditionalWatchTaskRunner: real browser, mocked model judgment ────────

test('a misconfigured CONDITION trigger (missing condition/watchUrl) fails closed without ever touching the browser', async () => {
  const browserService = buildBrowserService();
  const aiService = buildMockAiService('MET: true\nREASON: n/a');
  const runner = new ConditionalWatchTaskRunner(buildCapabilityBroker(browserService), aiService);
  const outcome = await runner.run(conditionTask({ trigger: { type: 'CONDITION', condition: '', watchUrl: '' } }), 'req_1');
  assert.equal(outcome.status, 'FAILED');
  assert.equal(outcome.errorCode, 'CONDITION_WATCH_MISCONFIGURED');
  assert.equal(outcome.conditionMet, false);
});

test('unmet condition: real page content reaches the judgment prompt, and the runner reports conditionMet=false', async () => {
  const fixture = await startFixtureServer('Current price: $950');
  try {
    const browserService = buildBrowserService();
    const capture = { lastPrompt: '' };
    const aiService = buildMockAiService('MET: false\nREASON: The price is still above $800.', capture);
    const runner = new ConditionalWatchTaskRunner(buildCapabilityBroker(browserService), aiService);

    const outcome = await runner.run(conditionTask({ trigger: { type: 'CONDITION', condition: 'The price is below $800', watchUrl: fixture.origin, checkIntervalMinutes: 15 } }), 'req_1');

    assert.equal(outcome.status, 'SUCCEEDED');
    assert.equal(outcome.conditionMet, false);
    assert.match(capture.lastPrompt, /Current price: \$950/);
    assert.match(capture.lastPrompt, /The price is below \$800/);
  } finally {
    await fixture.close();
  }
});

test('met condition: the runner reports conditionMet=true with a grounded reason', async () => {
  const fixture = await startFixtureServer('Current price: $650');
  try {
    const browserService = buildBrowserService();
    const aiService = buildMockAiService('MET: true\nREASON: The listed price of $650 is below the $800 threshold.');
    const runner = new ConditionalWatchTaskRunner(buildCapabilityBroker(browserService), aiService);

    const outcome = await runner.run(conditionTask({ trigger: { type: 'CONDITION', condition: 'The price is below $800', watchUrl: fixture.origin, checkIntervalMinutes: 15 } }), 'req_1');

    assert.equal(outcome.status, 'SUCCEEDED');
    assert.equal(outcome.conditionMet, true);
    assert.match((outcome.result as { reason: string }).reason, /\$650/);
  } finally {
    await fixture.close();
  }
});

test('an ambiguous/unparseable model response defaults to NOT met (fail-safe, never a false positive)', async () => {
  const fixture = await startFixtureServer('Current price: $650');
  try {
    const browserService = buildBrowserService();
    const aiService = buildMockAiService('I am not sure what you mean.');
    const runner = new ConditionalWatchTaskRunner(buildCapabilityBroker(browserService), aiService);
    const outcome = await runner.run(conditionTask({ trigger: { type: 'CONDITION', condition: 'The price is below $800', watchUrl: fixture.origin, checkIntervalMinutes: 15 } }), 'req_1');
    assert.equal(outcome.conditionMet, false);
  } finally {
    await fixture.close();
  }
});

test('a page that requires human verification fails the check (never claims met) and the browser session is closed afterward', async () => {
  const server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html><head><title>Verify</title></head><body><p>Please verify you are human before continuing.</p></body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const sessions = new BrowserSessionStore();
    const browserService = new BrowserToolService(sharedRuntime, sessions, new ActionApprovalStore(), new AuditLogger(), new MemoryEngine());
    const aiService = buildMockAiService('MET: true\nREASON: should never be reached');
    const runner = new ConditionalWatchTaskRunner(buildCapabilityBroker(browserService), aiService);

    const outcome = await runner.run(conditionTask({ trigger: { type: 'CONDITION', condition: 'x', watchUrl: `http://127.0.0.1:${port}`, checkIntervalMinutes: 15 } }), 'req_1');
    assert.equal(outcome.status, 'FAILED');
    assert.equal(outcome.errorCode, 'BROWSER_HUMAN_VERIFICATION_REQUIRED');
    assert.equal(outcome.conditionMet, false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// ── CompositeTaskRunner routing ─────────────────────────────────────────────

test('CompositeTaskRunner routes a CONDITIONAL/CONDITION task to the watch runner and everything else to the plan-preview runner', async () => {
  let watchCalled = false;
  let planCalled = false;
  const watchRunner = { run: async () => { watchCalled = true; return { status: 'SUCCEEDED' as const, conditionMet: false }; } };
  const planRunner = { run: async () => { planCalled = true; return { status: 'SUCCEEDED' as const }; } };
  const composite = new CompositeTaskRunner(planRunner, watchRunner);

  await composite.run(conditionTask(), 'req_1');
  assert.equal(watchCalled, true);
  assert.equal(planCalled, false);

  watchCalled = false;
  await composite.run({ ...conditionTask(), type: 'RECURRING', trigger: { type: 'SCHEDULE', schedule: '0 8 * * *', timezone: 'UTC' } }, 'req_2');
  assert.equal(planCalled, true);
  assert.equal(watchCalled, false);
});

// ── full scheduler integration ──────────────────────────────────────────────

test('full scheduler tick: an unmet condition stays WAITING with a rescheduled nextRunAt; a met condition completes the task and stops rescheduling', async () => {
  const taskStore = new TaskStore({ dir: tempDir() });
  const taskRunStore = new TaskRunStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-cw-runs-')) });
  const audit = new AuditLogger();

  const fixture = await startFixtureServer('Current price: $950');
  try {
    const browserService = buildBrowserService();
    const unmetAi = buildMockAiService('MET: false\nREASON: still too expensive');
    const composite = new CompositeTaskRunner(
      new PlanPreviewTaskRunner(unmetAi, new PlanResolver(skillRegistry, toolRegistry), () => []),
      new ConditionalWatchTaskRunner(buildCapabilityBroker(browserService), unmetAi),
    );
    const scheduler = new TaskScheduler(taskStore, taskRunStore, composite, audit);

    const task = taskStore.create({
      tenantId: 't1', ownerId: 'u1', name: 'Watch', objective: 'x', type: 'CONDITIONAL',
      trigger: { type: 'CONDITION', condition: 'The price is below $800', watchUrl: fixture.origin, checkIntervalMinutes: 15 },
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    });

    const due = taskStore.listDue(new Date());
    assert.equal(due.length, 1);
    assert.equal(due[0].taskId, task.taskId);

    const run = await scheduler.runOne(task);
    assert.equal(run.status, 'SUCCEEDED');

    const afterUnmet = taskStore.get(task.taskId)!;
    assert.equal(afterUnmet.status, 'WAITING');
    assert.ok(afterUnmet.nextRunAt);
    assert.ok(new Date(afterUnmet.nextRunAt as string).getTime() > Date.now());

    // Now the condition becomes met.
    const metAi = buildMockAiService('MET: true\nREASON: price dropped');
    const compositeMet = new CompositeTaskRunner(
      new PlanPreviewTaskRunner(metAi, new PlanResolver(skillRegistry, toolRegistry), () => []),
      new ConditionalWatchTaskRunner(buildCapabilityBroker(browserService), metAi),
    );
    const schedulerMet = new TaskScheduler(taskStore, taskRunStore, compositeMet, audit, () => new Date(new Date(afterUnmet.nextRunAt as string).getTime() + 1000));
    const finalRun = await schedulerMet.runOne(afterUnmet);
    assert.equal(finalRun.status, 'SUCCEEDED');

    const finalTask = taskStore.get(task.taskId)!;
    assert.equal(finalTask.status, 'COMPLETED');
    assert.equal(finalTask.nextRunAt, null);
  } finally {
    await fixture.close();
  }
});

// ── HTTP route validation ───────────────────────────────────────────────────

test('POST /api/v1/tasks rejects a CONDITIONAL task missing condition or watchUrl, and defaults checkIntervalMinutes when omitted', () => {
  const headers = { 'x-nagex-tenant': 'ten_production_01', 'x-principal-id': 'usr_watch_http_test' };

  const missingUrl = handleApiRequest('POST', '/api/v1/tasks', { name: 'Watch', objective: 'Watch a page.', type: 'CONDITIONAL', trigger: { type: 'CONDITION', condition: 'x' } }, headers);
  assert.notEqual(missingUrl.status, 201);
  assert.equal((missingUrl.data as { error: { code: string } }).error.code, 'WATCH_URL_REQUIRED');

  const missingCondition = handleApiRequest('POST', '/api/v1/tasks', { name: 'Watch', objective: 'Watch a page.', type: 'CONDITIONAL', trigger: { type: 'CONDITION', watchUrl: 'https://example.com' } }, headers);
  assert.notEqual(missingCondition.status, 201);
  assert.equal((missingCondition.data as { error: { code: string } }).error.code, 'CONDITION_REQUIRED');

  const wrongTriggerType = handleApiRequest('POST', '/api/v1/tasks', { name: 'Watch', objective: 'Watch a page.', type: 'CONDITIONAL', trigger: { type: 'MANUAL' } }, headers);
  assert.notEqual(wrongTriggerType.status, 201);
  assert.equal((wrongTriggerType.data as { error: { code: string } }).error.code, 'CONDITIONAL_TASK_REQUIRES_CONDITION_TRIGGER');

  const ok = handleApiRequest('POST', '/api/v1/tasks', { name: 'Flight watch', objective: 'Watch a page.', type: 'CONDITIONAL', trigger: { type: 'CONDITION', condition: 'price < 800', watchUrl: 'https://example.com' } }, headers);
  assert.equal(ok.status, 201);
  const data = ok.data as { status: string; trigger: { checkIntervalMinutes: number }; nextRunAt: string };
  assert.equal(data.status, 'WAITING');
  assert.equal(data.trigger.checkIntervalMinutes, 15);
  assert.equal(typeof data.nextRunAt, 'string');
});

test('POST /api/v1/tasks/:id/run executes a real CONDITIONAL task end to end through the HTTP route', async () => {
  const fixture = await startFixtureServer('Current price: $650');
  try {
    const headers = { 'x-nagex-tenant': 'ten_production_01', 'x-principal-id': 'usr_watch_http_run' };
    const created = handleApiRequest('POST', '/api/v1/tasks', { name: 'Flight watch', objective: 'Watch a page.', type: 'CONDITIONAL', trigger: { type: 'CONDITION', condition: 'The price is below $800', watchUrl: fixture.origin, checkIntervalMinutes: 15 } }, headers);
    assert.equal(created.status, 201);
    const taskId = (created.data as { taskId: string }).taskId;

    const service = buildMockAiService('MET: true\nREASON: price dropped below the threshold');
    const browserApiService = buildBrowserService();
    const runRes = await handleAsyncApiRequest('POST', `/api/v1/tasks/${taskId}/run`, {}, headers, service, {}, undefined, undefined, browserApiService);
    assert.equal(runRes.status, 200);
    assert.equal((runRes.data as { status: string }).status, 'SUCCEEDED');

    const fetched = handleApiRequest('GET', `/api/v1/tasks/${taskId}`, null, headers);
    assert.equal((fetched.data as { status: string }).status, 'COMPLETED');
  } finally {
    await fixture.close();
  }
});

// ── i18n coverage for the new Tasks form fields ─────────────────────────────

test('EN/KR: the new watchUrl/checkInterval/condition form labels are translated, not raw keys', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'public', 'i18n.js'), 'utf8');
  const storage: Record<string, string> = {};
  const sandbox: Record<string, unknown> = {
    document: { documentElement: {}, title: '', querySelectorAll: () => [] },
    localStorage: {
      getItem: (key: string) => (Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null),
      setItem: (key: string, value: string) => { storage[key] = value; },
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'i18n.js' });
  const i18n = (sandbox.window as Record<string, unknown>).NAGEX_I18N as { t: (k: string) => string; setLocale: (l: string) => void };

  const keys = ['tasks.form.condition', 'tasks.form.conditionPlaceholder', 'tasks.form.watchUrl', 'tasks.form.checkInterval'];
  for (const key of keys) {
    assert.notEqual(i18n.t(key), key, `expected an EN translation for ${key}`);
  }
  i18n.setLocale('ko');
  for (const key of keys) {
    assert.notEqual(i18n.t(key), key, `expected a KR translation for ${key}`);
  }
});

// Phase 01 — Composition Root Refactoring.
//
// Verifies createNagexApplication() produces the exact same shared-identity
// object graph server_web.ts's inline construction used to produce, and
// that constructing it has no import-time side effects (no HTTP server, no
// scheduler interval). Does not, and must not, assert independence of the
// pre-existing separate module singletons (browserRuntime,
// browserSessionStore, googleTokenStore, captureStore, canonicalSkillRegistry,
// canonicalToolRegistry, capabilityRegistry) — those are unchanged by this
// phase and are shared across app instances by design.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createNagexApplication } from '../src/app/create-nagex-application.js';
import type { CalendarCandidatePayload } from '../src/workspace/candidate.types.js';

// CapabilityBroker's idempotency store is disk-persisted (FileRecordStore,
// keyed by tenantId:principalId:requestId) and outlives a single test run —
// a hardcoded id here would collide with a stale record from an earlier
// run of this same file (different payload timestamp -> a real, correctly
// triggered CAPABILITY_IDEMPOTENCY_CONFLICT). Every id must be unique per run.
function uniqueId(label: string): string {
  return `${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function validCalendarPayload(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    calendarId: 'primary',
    summary: 'Composition root test event',
    description: '',
    start: new Date(Date.now() + 3600_000).toISOString(),
    end: new Date(Date.now() + 7200_000).toISOString(),
    timezone: 'UTC',
    attendees: [] as string[],
    ...overrides,
  };
}

test('1. createNagexApplication() returns the required application graph', () => {
  const app = createNagexApplication();
  const requiredKeys: Array<keyof typeof app> = [
    'pdp', 'runtime', 'auditLogger', 'billing', 'creditEngine', 'memoryEngine', 'aiService', 'planResolver',
    'actionApprovals', 'executionStore', 'googleCalendarService', 'gmailService', 'browserService',
    'capabilityBroker', 'sessionStore', 'conversationStore', 'conversationContextService', 'taskStore',
    'taskRunStore', 'taskRunner', 'taskScheduler', 'telegramIdentityStore', 'telegramBotClient', 'telegramService',
    'slackIdentityStore', 'slackClient', 'slackService', 'desktopRuntimeEngine', 'notificationStore',
    'notificationEngine', 'knowledgeEngine', 'storageProvider', 'candidateStore', 'activityStore',
    'candidateActionResolver', 'quickCaptureService', 'inputRouter', 'getRelevantMemories', 'pinnedMemories',
  ];
  for (const key of requiredKeys) {
    assert.notEqual(app[key], undefined, `NagexApplication.${String(key)} must not be undefined`);
  }
});

test('2. shared approval store identity is preserved: an approval requested via googleCalendarService is visible through app.actionApprovals directly', () => {
  const app = createNagexApplication();
  const requestId = `req_root_2_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const approval = app.googleCalendarService.requestCreateEventApproval({
    tenantId: 't_root_2', principalId: 'u_root_2', requestId,
    payload: validCalendarPayload() as unknown as CalendarCandidatePayload,
  });
  const fromSharedStore = app.actionApprovals.get(approval.approvalId, 't_root_2', 'u_root_2');
  assert.ok(fromSharedStore, 'the approval created via googleCalendarService must be visible through the shared actionApprovals instance, not a private copy');
  assert.equal(fromSharedStore!.approvalId, approval.approvalId);
});

test('3. CapabilityBroker executes against the exact same googleCalendarService/actionApprovals instances the app graph holds', async () => {
  const app = createNagexApplication();
  // tests/_setup.ts does not redirect NAGEX_CAPABILITIES_IDEMPOTENCY_DIR, so
  // CapabilityBroker's idempotency store is disk-persisted at the real,
  // non-test-isolated default path across every run on this machine (a
  // pre-existing gap, out of scope for this refactor's allowed file list —
  // see the Composition Root pre-flight report) — every identifier here
  // must be unique per run to avoid a real, correctly-triggered
  // CAPABILITY_IDEMPOTENCY_CONFLICT against a stale prior-run record.
  const tenantId3 = uniqueId('t_root_3');
  const principalId3 = uniqueId('u_root_3');
  const result = await app.capabilityBroker.execute({
    capabilityId: 'google_calendar.create_event',
    tenantId: tenantId3,
    principalId: principalId3,
    requestId: uniqueId('req_root_3'),
    payload: validCalendarPayload(),
    source: 'WEB',
  });

  assert.equal(result.status, 'APPROVAL_REQUIRED');
  const approvalId = (result as { approval?: { approvalId: string } }).approval?.approvalId;
  assert.ok(approvalId, 'CapabilityBroker must return a real approvalId');
  assert.ok(app.actionApprovals.get(approvalId!, tenantId3, principalId3), 'CapabilityBroker must route through the same actionApprovals instance the app graph holds, not a private copy');
});

test('4. taskRunner/notificationEngine are wired with the exact same shared local identifiers as everything else in the graph (source-level construction check)', () => {
  const source = fs.readFileSync(path.resolve('src/app/create-nagex-application.ts'), 'utf8');
  // Strip comments before asserting — a comment mentioning these
  // identifiers must never produce a false positive/negative for this check.
  const codeOnly = source.split('\n').map((line) => line.replace(/\/\/.*/, '')).join('\n');
  assert.match(codeOnly, /new ConditionalWatchTaskRunner\(capabilityBroker, aiService\)/, 'taskRunner must wire ConditionalWatchTaskRunner with the same capabilityBroker/aiService returned on the app graph');
  assert.match(codeOnly, /new TaskScheduler\(taskStore, taskRunStore, taskRunner, auditLogger, undefined, notificationEngine\)/, 'taskScheduler must be constructed with the same taskRunner/notificationEngine returned on the app graph');
  assert.match(codeOnly, /store: notificationStore,\s*\n\s*telegramIdentityStore,\s*\n\s*telegramBotClient,\s*\n\s*slackIdentityStore,\s*\n\s*slackClient,\s*\n\s*desktopRuntimeEngine,\s*\n\s*auditLogger,/, 'notificationEngine must be constructed with the same shared instances returned on the app graph');
});

test('5. Constructing the app graph never starts an HTTP server or a scheduler interval (source-level check)', () => {
  const source = fs.readFileSync(path.resolve('src/app/create-nagex-application.ts'), 'utf8');
  const codeOnly = source.split('\n').map((line) => line.replace(/\/\/.*/, '')).join('\n');
  assert.doesNotMatch(codeOnly, /\.listen\(/, 'createNagexApplication() must never start an HTTP server');
  assert.doesNotMatch(codeOnly, /setInterval\(/, 'createNagexApplication() must never start a scheduler interval — that stays gated behind require.main === module in server_web.ts');
  assert.doesNotMatch(codeOnly, /process\.exit\(/, 'createNagexApplication() must never call process.exit()');
});

test('6. Constructing the app graph completes synchronously without starting a browser, without throwing, and without external calls', () => {
  const before = Date.now();
  const app = createNagexApplication();
  const elapsedMs = Date.now() - before;
  assert.ok(app, 'createNagexApplication() must return a value');
  // A real Playwright browser launch or a real network call would make this
  // take at least tens/hundreds of milliseconds; plain object construction
  // should be near-instant. This is a coarse but effective guard against an
  // accidental eager side effect creeping into the composition root.
  assert.ok(elapsedMs < 500, `createNagexApplication() took ${elapsedMs}ms — expected near-instant pure object construction, no eager browser/network work`);
});

test('7. Two createNagexApplication() calls produce two independent application graphs (server_web.ts calls this exactly once)', () => {
  const appA = createNagexApplication();
  const appB = createNagexApplication();
  assert.notEqual(appA.memoryEngine, appB.memoryEngine);
  assert.notEqual(appA.taskStore, appB.taskStore);
  assert.notEqual(appA.actionApprovals, appB.actionApprovals);
  assert.notEqual(appA.capabilityBroker, appB.capabilityBroker);
  assert.notEqual(appA.pinnedMemories, appB.pinnedMemories);
  // Independent graphs must not cross-pollinate: an approval created in A
  // must not be visible in B's store.
  const approval = appA.googleCalendarService.requestCreateEventApproval({
    tenantId: 't_root_7', principalId: 'u_root_7', requestId: 'req_root_7',
    payload: validCalendarPayload() as unknown as CalendarCandidatePayload,
  });
  assert.equal(appB.actionApprovals.get(approval.approvalId, 't_root_7', 'u_root_7'), undefined, 'two application graphs must never share approval state');
});

test('8. Seed memory (mem1-4) and pinnedMemories are present and consistent per graph, without changing seed content', () => {
  const oldDir = process.env.NAGEX_MEMORIES_DIR;
  process.env.NAGEX_MEMORIES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-root-seed-test-'));
  try {
    const app = createNagexApplication();
    const active = app.memoryEngine.getActiveMemories('USER', 'usr_admin_001');
    const subjects = active.map((m) => (m.content as { subject?: string }).subject).sort();
    assert.deepEqual(subjects, ['Acme Corp Context', 'Preferred Tools', 'User Profile'].sort());
    assert.equal(app.pinnedMemories.size, 2, 'exactly mem2 and mem3 are pinned, matching the original inline seed logic');
  } finally {
    if (oldDir !== undefined) {
      process.env.NAGEX_MEMORIES_DIR = oldDir;
    } else {
      delete process.env.NAGEX_MEMORIES_DIR;
    }
  }
});

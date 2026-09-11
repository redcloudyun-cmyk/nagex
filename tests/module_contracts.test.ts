// Phase 03 — Module Contracts.
//
// Verifies the new src/contracts/** ports: the real Browser/Calendar/Gmail
// implementations still structurally satisfy them (compile-time
// conformance), CapabilityBroker/ConditionalWatchTaskRunner/
// CandidateActionResolver can be constructed against fake, minimal ports
// with zero integration internals (no Playwright, no real Google OAuth),
// the Composition Root still wires the real concrete implementations
// through unchanged, shared instance identity is preserved, and the
// contract files themselves stay pure (no integrations/, Playwright,
// OAuth, or HTTP-transport imports).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CapabilityBroker } from '../src/capabilities/capability-broker.js';
import { ConditionalWatchTaskRunner } from '../src/tasks/task.runner.js';
import { CandidateActionResolver } from '../src/workspace/action-resolver.js';
import { CandidateStore } from '../src/workspace/candidate.store.js';
import { CaptureStore } from '../src/workspace/capture.store.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { GoogleCalendarService } from '../src/modules/calendar/index.js';
import { GmailService } from '../src/modules/gmail/index.js';
import { BrowserToolService } from '../src/modules/browser/browser.service.js';
import { createNagexApplication } from '../src/app/create-nagex-application.js';
import type { AiService } from '../src/model-gateway/ai-service.js';
import type { CapabilityExecutorPort } from '../src/contracts/capability.port.js';
import type { BrowserPort } from '../src/contracts/browser.port.js';
import type { CalendarApprovalRequesterPort, CalendarExecutionPort } from '../src/contracts/calendar.port.js';
import type { GmailPort } from '../src/contracts/gmail.port.js';
import type { CapabilityRequest, CapabilityBrokerResult } from '../src/capabilities/capability.types.js';
import type { CalendarCandidatePayload } from '../src/workspace/candidate.types.js';

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `nagex-module-contracts-${prefix}-`));
}

function uniqueId(label: string): string {
  return `${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ─── 1-3: compile-time conformance — the real implementations satisfy the
// new ports. These assertions are never executed; if the concrete class
// stopped structurally satisfying the port, this file would fail to
// compile (npm run build), which is the actual check. ───

void function browserConformance(real: BrowserToolService): void {
  const _asPort: BrowserPort = real; // 1. Browser implementation satisfies BrowserPort
};

void function calendarConformance(real: GoogleCalendarService): void {
  const _asApprovalPort: CalendarApprovalRequesterPort = real; // 2a. satisfies CalendarApprovalRequesterPort
  const _asExecutionPort: CalendarExecutionPort = real; // 2b. satisfies CalendarExecutionPort
};

void function gmailConformance(real: GmailService): void {
  const _asPort: GmailPort = real; // 3. Gmail implementation satisfies the introduced GmailPort
};

// ─── 4: CapabilityBroker can operate through the capability contract ───

test('4. CapabilityBroker can be used through CapabilityExecutorPort (the shape task.runner.ts depends on)', async () => {
  const app = createNagexApplication();
  const port: CapabilityExecutorPort = app.capabilityBroker;
  const call = port.execute({
    capabilityId: 'google_calendar.free_slots',
    tenantId: uniqueId('t_mc4'),
    principalId: uniqueId('u_mc4'),
    requestId: uniqueId('req_mc4'),
    payload: { timeMin: new Date().toISOString(), timeMax: new Date(Date.now() + 3600_000).toISOString() },
    source: 'WEB',
  });
  // GOOGLE_CALENDAR_DISCONNECTED (thrown, since getFreeSlots requires a
  // live token) in this environment with no real OAuth is the expected,
  // truthful outcome — the point of this test is that the call reaches
  // real execution through the port, not that Google is connected.
  try {
    const result = await call;
    assert.ok(result.status === 'EXECUTED' || result.status === 'BLOCKED', `expected a real attempted execution, got ${JSON.stringify(result)}`);
  } catch (err) {
    assert.ok(err instanceof Error && 'code' in err && (err as { code: string }).code === 'GOOGLE_CALENDAR_DISCONNECTED', `expected either a real result or a real GOOGLE_CALENDAR_DISCONNECTED failure, got ${err}`);
  }
});

// ─── 5: consumers construct against fake, minimal ports — no Playwright,
// no real Google OAuth, no integration internals required at all. ───

test('5a. CapabilityBroker constructs and operates against fully fake Calendar/Gmail/Browser ports', async () => {
  const calls: string[] = [];
  const fakeCalendar: CalendarApprovalRequesterPort = {
    getFreeSlots: async () => { calls.push('getFreeSlots'); return { slots: [], busy: [], calendarId: 'primary', timeMin: '', timeMax: '' }; },
    requestCreateEventApproval: () => { throw new Error('not exercised'); },
    requestUpdateEventApproval: () => { throw new Error('not exercised'); },
    requestCancelEventApproval: () => { throw new Error('not exercised'); },
    requestRespondToEventApproval: () => { throw new Error('not exercised'); },
  };
  const fakeGmail: GmailPort = {
    search: async () => { throw new Error('not exercised'); },
    readThread: async () => { throw new Error('not exercised'); },
    requestApproval: () => { throw new Error('not exercised'); },
  };
  const fakeBrowser: BrowserPort = {
    open: async () => { throw new Error('not exercised'); },
    close: async () => { throw new Error('not exercised'); },
    navigate: async () => { throw new Error('not exercised'); },
    tabs: async () => { throw new Error('not exercised'); },
    snapshot: async () => { throw new Error('not exercised'); },
    structuredSnapshot: async () => { throw new Error('not exercised'); },
    find: async () => { throw new Error('not exercised'); },
    extract: async () => { throw new Error('not exercised'); },
    back: async () => { throw new Error('not exercised'); },
    forward: async () => { throw new Error('not exercised'); },
    reload: async () => { throw new Error('not exercised'); },
    click: async () => { throw new Error('not exercised'); },
  };

  const broker = new CapabilityBroker(fakeCalendar, fakeGmail, fakeBrowser, new AuditLogger(), undefined, `mc5a_${uniqueId('idem')}`, 'NAGEX_CAPABILITIES_IDEMPOTENCY_DIR_UNUSED');
  const result = await broker.execute({
    capabilityId: 'google_calendar.free_slots',
    tenantId: uniqueId('t_mc5a'),
    principalId: uniqueId('u_mc5a'),
    requestId: uniqueId('req_mc5a'),
    payload: { timeMin: new Date().toISOString(), timeMax: new Date(Date.now() + 3600_000).toISOString() },
    source: 'WEB',
  });
  assert.equal(result.status, 'EXECUTED');
  assert.deepEqual(calls, ['getFreeSlots'], 'the fake Calendar port must be the one actually invoked — no real Google OAuth/Playwright needed to construct or operate CapabilityBroker');
});

test('5b. ConditionalWatchTaskRunner constructs against a fully fake CapabilityExecutorPort', () => {
  let executeCalled = false;
  const fakePort: CapabilityExecutorPort = {
    execute: async (_request: CapabilityRequest): Promise<CapabilityBrokerResult> => {
      executeCalled = true;
      return { status: 'EXECUTED', capabilityId: 'browser.open', result: {} };
    },
  };
  const runner = new ConditionalWatchTaskRunner(fakePort, {} as AiService);
  assert.ok(runner, 'ConditionalWatchTaskRunner must construct against a fake port with no real CapabilityBroker/Playwright/Google OAuth');
  void executeCalled;
});

test('5c. CandidateActionResolver constructs and operates against a fully fake CalendarExecutionPort', async () => {
  const dir = tempDir('5c');
  const candidateStore = new CandidateStore({ dir: path.join(dir, 'candidates') });
  const captureStore = new CaptureStore(path.join(dir, 'captures'));
  const calls: string[] = [];
  const fakeCalendar: CalendarExecutionPort = {
    requestCreateEventApproval: (input) => {
      calls.push('requestCreateEventApproval');
      return {
        approvalId: 'apr_fake_1', toolId: 'google_calendar.create_event', tenantId: input.tenantId, principalId: input.principalId,
        canonicalPayload: {}, payloadHash: 'fake', status: 'PENDING', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(),
        approvedAt: null, rejectedAt: null, usedAt: null, executionId: null,
      };
    },
    executeCreateEvent: async () => { throw new Error('not exercised in this test'); },
    getApproval: () => { throw new Error('not exercised in this test'); },
  };

  const resolver = new CandidateActionResolver({ candidateStore, captureStore, calendarService: fakeCalendar });
  const cap = captureStore.createCapture({ ownerId: 'u_mc5c', tenantId: 't_mc5c', type: 'TEXT', content: 'x', metadata: { contentHash: 'h1' } });
  const seeded = candidateStore.upsert({
    tenantId: 't_mc5c', principalId: 'u_mc5c', captureId: cap.captureId, contentHash: 'h1', sourceRefs: ['capture:x'],
    title: 'Meeting', type: 'CALENDAR',
    payload: { summary: 'Meeting', start: new Date(Date.now() + 3600_000).toISOString(), end: new Date(Date.now() + 7200_000).toISOString(), timezone: 'UTC', attendees: [] } as CalendarCandidatePayload,
  });
  candidateStore.accept(seeded.candidateId, 't_mc5c', 'u_mc5c');

  const result = await resolver.executeCandidate(seeded.candidateId, 't_mc5c', 'u_mc5c');
  assert.equal(result.action?.status, 'PENDING_APPROVAL');
  assert.deepEqual(calls, ['requestCreateEventApproval'], 'the fake Calendar port must be the one actually invoked — no real Google OAuth/Playwright needed to construct or operate CandidateActionResolver for Calendar candidates');
});

// ─── 6-8: contract purity (source-level, matching this repo's established
// technique for "must never import X" checks — comments stripped first so
// an explanatory comment mentioning a banned term can never produce a
// false positive). ───

const CONTRACT_FILES = ['capability.port.ts', 'browser.port.ts', 'calendar.port.ts', 'gmail.port.ts'];

function readContractSourceWithoutComments(filename: string): string {
  const source = fs.readFileSync(path.resolve('src/contracts', filename), 'utf8');
  return source.split('\n').map((line) => line.replace(/\/\/.*/, '')).join('\n');
}

test('6. No contract file imports Playwright types', () => {
  for (const file of CONTRACT_FILES) {
    const code = readContractSourceWithoutComments(file);
    assert.doesNotMatch(code, /playwright/i, `${file} must never import a Playwright type`);
  }
});

test('7. No contract file imports Google OAuth/token-store internals', () => {
  for (const file of CONTRACT_FILES) {
    const code = readContractSourceWithoutComments(file);
    assert.doesNotMatch(code, /oauth/i, `${file} must never import an OAuth type`);
    assert.doesNotMatch(code, /token\.store/i, `${file} must never import the token store`);
  }
});

test('8. No contract file imports HTTP server/request/response types, or from integrations/ or server_web', () => {
  for (const file of CONTRACT_FILES) {
    const code = readContractSourceWithoutComments(file);
    assert.doesNotMatch(code, /IncomingMessage|ServerResponse|node:http/, `${file} must never import an HTTP transport type`);
    assert.doesNotMatch(code, /from ['"].*\/integrations\//, `${file} must never import from integrations/`);
    assert.doesNotMatch(code, /server_web/, `${file} must never import from server_web`);
  }
});

// ─── 9-10: Composition Root still wires real concrete implementations,
// and shared instance identity is preserved end to end through the ports. ───

test('9. Composition Root wires the real concrete Calendar/Gmail/Browser implementations into the port-typed CapabilityBroker', () => {
  const app = createNagexApplication();
  assert.ok(app.googleCalendarService instanceof GoogleCalendarService);
  assert.ok(app.gmailService instanceof GmailService);
  assert.ok(app.browserService instanceof BrowserToolService);
  assert.ok(app.capabilityBroker instanceof CapabilityBroker);
});

test('10. Shared instance identity is preserved through the new port typing: an approval requested via the concrete googleCalendarService is visible through CapabilityBroker\'s execute() using the exact same underlying store', async () => {
  const app = createNagexApplication();
  const tenantId = uniqueId('t_mc10');
  const principalId = uniqueId('u_mc10');

  const direct = app.googleCalendarService.requestCreateEventApproval({
    tenantId, principalId, requestId: uniqueId('req_mc10_direct'),
    payload: { calendarId: 'primary', summary: 'x', description: '', start: new Date(Date.now() + 3600_000).toISOString(), end: new Date(Date.now() + 7200_000).toISOString(), timezone: 'UTC', attendees: [] },
  });

  const viaBroker = await app.capabilityBroker.execute({
    capabilityId: 'google_calendar.create_event',
    tenantId, principalId, requestId: uniqueId('req_mc10_broker'),
    payload: { calendarId: 'primary', summary: 'y', description: '', start: new Date(Date.now() + 3600_000).toISOString(), end: new Date(Date.now() + 7200_000).toISOString(), timezone: 'UTC', attendees: [] },
    source: 'WEB',
  });
  assert.equal(viaBroker.status, 'APPROVAL_REQUIRED');
  const brokerApprovalId = (viaBroker as { approval?: { approvalId: string } }).approval?.approvalId;

  // Both approvals must be readable back through the same concrete
  // googleCalendarService.getApproval() — proving CapabilityBroker's
  // port-typed dependency is the exact same instance, not a copy.
  assert.ok(app.googleCalendarService.getApproval(direct.approvalId));
  assert.ok(app.googleCalendarService.getApproval(brokerApprovalId!));
});

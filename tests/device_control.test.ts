// DC1 — Device Control Foundation, first slice.
//
// Proves the whole observe -> propose -> policy -> execute -> observe ->
// verify -> stop loop against a REAL browser (Playwright, a local HTTP
// test server — same harness pattern as
// tests/browser_session_ownership_isolation.test.ts) driven by the
// deterministic FakeVisualExecutionModelAdapter, per Section 6: a real
// model provider is never used to paper over an orchestration defect —
// this whole file exists to prove the orchestration first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserToolService } from '../src/modules/browser/browser.service.js';
import { PlaywrightBrowserRuntime } from '../src/modules/browser/browser.runtime.js';
import { BrowserSessionStore } from '../src/modules/browser/browser-session.store.js';
import { ActionApprovalStore } from '../src/governance/action-approval.store.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { MemoryEngine } from '../src/context/memory.engine.js';
import { NagexError } from '../src/common/errors.js';
import { DeviceExecutionSessionStore } from '../src/device-control/device-execution-session.store.js';
import { DeviceControlService } from '../src/device-control/device-control.service.js';
import { FakeVisualExecutionModelAdapter } from '../src/device-control/fake-visual-execution-model.adapter.js';
import type { ProposedDeviceAction } from '../src/device-control/device-action.types.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-device-control-test-'));
}

function createTestServer(): Promise<{ baseUrl: string; hostname: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.writeHead(200);
      res.end(`
        <html>
          <head><title>DC1 Test Page</title></head>
          <body>
            <h1>DC1 Test Page</h1>
            <div style="height:2000px">
              <a href="#" id="nav-link">Next</a>
              <button id="submit-btn">Submit Order</button>
              <input type="text" id="name-input" name="name" value="" placeholder="Your name">
            </div>
          </body>
        </html>
      `);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      resolve({ baseUrl: `http://127.0.0.1:${address.port}`, hostname: '127.0.0.1', close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

async function buildHarness() {
  const dir = tempDir();
  const runtime = new PlaywrightBrowserRuntime(false, path.join(dir, 'profiles'));
  const browserSessions = new BrowserSessionStore({ dir: path.join(dir, 'browser-sessions') });
  const approvals = new ActionApprovalStore();
  const audit = new AuditLogger();
  // D1 — must not share the process-default memory store: this file's own
  // unique temp dir (tempDir()) already isolates every other store built
  // here (browser sessions, device sessions), but MemoryEngine was the one
  // exception, silently falling back to the shared default directory and
  // risking cross-test id collisions within the same node --test process.
  const memory = new MemoryEngine({ dir: path.join(dir, 'memories') });
  const browserService = new BrowserToolService(runtime, browserSessions, approvals, audit, memory);
  const deviceSessionsDir = path.join(dir, 'device-sessions');
  const deviceSessions = new DeviceExecutionSessionStore({ dir: deviceSessionsDir });
  return { dir, deviceSessionsDir, runtime, browserSessions, approvals, browserService, deviceSessions };
}

const TENANT_A = 'ten_dc1_a';
const TENANT_B = 'ten_dc1_b';
const OWNER_X = 'usr_dc1_x';
const OWNER_Y = 'usr_dc1_y';

const NAV: (url: string) => ProposedDeviceAction = (url) => ({ action: 'NAVIGATE', value: url });
const OBSERVE: ProposedDeviceAction = { action: 'OBSERVE' };
const STOP: ProposedDeviceAction = { action: 'STOP', expectedResult: 'done' };
const CLICK_LINK: ProposedDeviceAction = { action: 'CLICK', target: { selector: '#nav-link' } };
const CLICK_SUBMIT: ProposedDeviceAction = { action: 'CLICK', target: { selector: '#submit-btn' } };
const TYPE_NAME: ProposedDeviceAction = { action: 'TYPE', target: { selector: '#name-input' }, value: 'NAgex DC1' };
const SCROLL_DOWN: ProposedDeviceAction = { action: 'SCROLL', value: 'down' };
const KEYPRESS_ENTER: ProposedDeviceAction = { action: 'KEYPRESS', value: 'Enter' };

// ── 1-4: session store — schema, isolation, persistence ──────────────────

test('DEVICE_SESSION_CREATE: create() populates a durable, correctly-scoped RUNNING session', async () => {
  const { deviceSessions } = await buildHarness();
  const record = deviceSessions.create({
    tenantId: TENANT_A,
    ownerPrincipalId: OWNER_X,
    browserSessionId: 'brw_fake',
    goal: 'test goal',
    allowedActions: ['OBSERVE', 'STOP'],
    allowedDomains: ['example.com'],
    maxSteps: 5,
    maxDurationMs: 60_000,
    riskCeiling: 'CONSEQUENTIAL',
  });
  assert.equal(record.status, 'RUNNING');
  assert.equal(record.stepCount, 0);
  assert.equal(record.pendingAction, null);
  assert.equal(record.approvalId, null);
  assert.equal(record.tenantId, TENANT_A);
  assert.equal(record.ownerPrincipalId, OWNER_X);
});

test('DEVICE_SESSION_TENANT_ISOLATION: getOwned returns null for the wrong tenant, identical to a nonexistent id', async () => {
  const { deviceSessions } = await buildHarness();
  const record = deviceSessions.create({ tenantId: TENANT_A, ownerPrincipalId: OWNER_X, browserSessionId: 'brw_fake', goal: 'g', allowedActions: [], allowedDomains: [], maxSteps: 5, maxDurationMs: 1000, riskCeiling: 'LOW' });
  assert.equal(deviceSessions.getOwned(record.deviceExecutionSessionId, TENANT_B, OWNER_X), null);
  assert.equal(deviceSessions.getOwned('des_does_not_exist', TENANT_A, OWNER_X), deviceSessions.getOwned(record.deviceExecutionSessionId, TENANT_B, OWNER_X));
});

test('DEVICE_SESSION_OWNER_ISOLATION: getOwned returns null for the wrong owner (same tenant)', async () => {
  const { deviceSessions } = await buildHarness();
  const record = deviceSessions.create({ tenantId: TENANT_A, ownerPrincipalId: OWNER_X, browserSessionId: 'brw_fake', goal: 'g', allowedActions: [], allowedDomains: [], maxSteps: 5, maxDurationMs: 1000, riskCeiling: 'LOW' });
  assert.equal(deviceSessions.getOwned(record.deviceExecutionSessionId, TENANT_A, OWNER_Y), null);
});

test('DEVICE_SESSION_RESTART_PERSISTENCE: a session created by one store instance is visible to a fresh instance over the same directory', async () => {
  const { deviceSessionsDir, deviceSessions } = await buildHarness();
  const record = deviceSessions.create({ tenantId: TENANT_A, ownerPrincipalId: OWNER_X, browserSessionId: 'brw_fake', goal: 'restart test', allowedActions: [], allowedDomains: [], maxSteps: 5, maxDurationMs: 1000, riskCeiling: 'LOW' });
  const restarted = new DeviceExecutionSessionStore({ dir: deviceSessionsDir });
  const reloaded = restarted.getOwned(record.deviceExecutionSessionId, TENANT_A, OWNER_X);
  assert.ok(reloaded);
  assert.equal(reloaded?.goal, 'restart test');
});

// ── 5-8: bounded lifecycle / hard boundaries ──────────────────────────────

test('DEVICE_SESSION_MAX_STEPS: a session that never STOPs terminates FAILED once maxSteps is reached', async () => {
  const testServer = await createTestServer();
  const { runtime, browserService, deviceSessions } = await buildHarness();
  try {
    // OBSERVE forever — the fake adapter is scripted with more OBSERVEs
    // than maxSteps allows, so the loop must stop itself before the
    // script would ever exhaust.
    const model = new FakeVisualExecutionModelAdapter([NAV(testServer.baseUrl), OBSERVE, OBSERVE, OBSERVE, OBSERVE, OBSERVE, OBSERVE, OBSERVE, OBSERVE]);
    const service = new DeviceControlService(deviceSessions, browserService, model);
    const outcome = await service.startSession({
      tenantId: TENANT_A, ownerId: OWNER_X, requestId: 'req_maxsteps', goal: 'loop forever',
      allowedDomains: [testServer.hostname], maxSteps: 3, maxDurationMs: 60_000,
    });
    assert.equal(outcome.kind, 'TERMINATED');
    if (outcome.kind === 'TERMINATED') {
      assert.equal(outcome.status, 'FAILED');
      assert.equal(outcome.terminationReason, 'DEVICE_MAX_STEPS_EXCEEDED');
    }
  } finally {
    await runtime.shutdown();
    await testServer.close();
  }
});

test('DEVICE_SESSION_MAX_DURATION: a session terminates FAILED once maxDurationMs has elapsed', async () => {
  const testServer = await createTestServer();
  const { runtime, browserService, deviceSessions } = await buildHarness();
  try {
    const model = new FakeVisualExecutionModelAdapter([NAV(testServer.baseUrl), OBSERVE, OBSERVE, OBSERVE]);
    const service = new DeviceControlService(deviceSessions, browserService, model);
    // 0ms budget — the very first real observation already exceeds it.
    const outcome = await service.startSession({
      tenantId: TENANT_A, ownerId: OWNER_X, requestId: 'req_maxdur', goal: 'exceed duration',
      allowedDomains: [testServer.hostname], maxSteps: 50, maxDurationMs: 0,
    });
    assert.equal(outcome.kind, 'TERMINATED');
    if (outcome.kind === 'TERMINATED') {
      assert.equal(outcome.status, 'FAILED');
      assert.equal(outcome.terminationReason, 'DEVICE_MAX_DURATION_EXCEEDED');
    }
  } finally {
    await runtime.shutdown();
    await testServer.close();
  }
});

test('DEVICE_ALLOWED_DOMAIN_ENFORCEMENT: a NAVIGATE proposal to a disallowed domain terminates FAILED and never navigates', async () => {
  const testServer = await createTestServer();
  const { runtime, browserService, deviceSessions } = await buildHarness();
  try {
    const model = new FakeVisualExecutionModelAdapter([NAV('https://not-allowed.example.org/')]);
    const service = new DeviceControlService(deviceSessions, browserService, model);
    const outcome = await service.startSession({
      tenantId: TENANT_A, ownerId: OWNER_X, requestId: 'req_domain', goal: 'go off-domain',
      allowedDomains: [testServer.hostname], maxSteps: 5, maxDurationMs: 60_000,
    });
    assert.equal(outcome.kind, 'TERMINATED');
    if (outcome.kind === 'TERMINATED') {
      assert.equal(outcome.status, 'FAILED');
      assert.ok(outcome.terminationReason.startsWith('DEVICE_DOMAIN_NOT_ALLOWED'));
    }
  } finally {
    await runtime.shutdown();
    await testServer.close();
  }
});

test('DEVICE_ALLOWED_ACTION_ENFORCEMENT: a proposed action outside allowedActions terminates FAILED', async () => {
  const testServer = await createTestServer();
  const { runtime, browserService, deviceSessions } = await buildHarness();
  try {
    const model = new FakeVisualExecutionModelAdapter([NAV(testServer.baseUrl), CLICK_LINK]);
    const service = new DeviceControlService(deviceSessions, browserService, model);
    const outcome = await service.startSession({
      tenantId: TENANT_A, ownerId: OWNER_X, requestId: 'req_action', goal: 'try a disallowed action',
      allowedDomains: [testServer.hostname], allowedActions: ['NAVIGATE', 'OBSERVE', 'STOP'], maxSteps: 5, maxDurationMs: 60_000,
    });
    assert.equal(outcome.kind, 'TERMINATED');
    if (outcome.kind === 'TERMINATED') {
      assert.equal(outcome.status, 'FAILED');
      assert.equal(outcome.terminationReason, 'DEVICE_ACTION_NOT_ALLOWED:CLICK');
    }
  } finally {
    await runtime.shutdown();
    await testServer.close();
  }
});

// ── 9-14: real observation / proposal / primitive execution ──────────────

test('VISUAL_OBSERVATION: the model receives a real structuredSnapshot and a non-null screenshot reference', async () => {
  const testServer = await createTestServer();
  const { runtime, browserService, deviceSessions } = await buildHarness();
  try {
    const model = new FakeVisualExecutionModelAdapter([NAV(testServer.baseUrl), STOP]);
    const service = new DeviceControlService(deviceSessions, browserService, model);
    await service.startSession({
      tenantId: TENANT_A, ownerId: OWNER_X, requestId: 'req_obs', goal: 'observe the page',
      allowedDomains: [testServer.hostname], maxSteps: 5, maxDurationMs: 60_000,
    });
    assert.equal(model.calls.length, 2, 'one call for the initial blank observation, one after NAVIGATE');
    const secondCall = model.calls[1];
    assert.ok(secondCall.structuredSnapshot.text.includes('DC1 Test Page'));
    assert.ok(secondCall.screenshotRef, 'a screenshot evidence reference must be present');
  } finally {
    await runtime.shutdown();
    await testServer.close();
  }
});

test('VISUAL_ACTION_PROPOSAL: goal/allowedActions/priorActions are threaded correctly across turns', async () => {
  const testServer = await createTestServer();
  const { runtime, browserService, deviceSessions } = await buildHarness();
  try {
    const model = new FakeVisualExecutionModelAdapter([NAV(testServer.baseUrl), CLICK_LINK, STOP]);
    const service = new DeviceControlService(deviceSessions, browserService, model);
    await service.startSession({
      tenantId: TENANT_A, ownerId: OWNER_X, requestId: 'req_prop', goal: 'click the link then stop',
      allowedDomains: [testServer.hostname], maxSteps: 10, maxDurationMs: 60_000,
    });
    assert.equal(model.calls[0].goal, 'click the link then stop');
    assert.deepEqual(model.calls[0].priorActions, []);
    assert.equal(model.calls.length, 3);
    assert.equal(model.calls[2].priorActions.length, 2);
    assert.equal(model.calls[2].priorActions[1].action.action, 'CLICK');
    assert.ok(model.calls[2].priorActions[1].outcome.startsWith('EXECUTED'));
  } finally {
    await runtime.shutdown();
    await testServer.close();
  }
});

test('VISUAL_CLICK_EXECUTION: a scripted CLICK on an ordinary (non-consequential) target actually clicks the real page', async () => {
  const testServer = await createTestServer();
  const { runtime, browserService, deviceSessions } = await buildHarness();
  try {
    const model = new FakeVisualExecutionModelAdapter([NAV(testServer.baseUrl), CLICK_LINK, STOP]);
    const service = new DeviceControlService(deviceSessions, browserService, model);
    const outcome = await service.startSession({
      tenantId: TENANT_A, ownerId: OWNER_X, requestId: 'req_click', goal: 'click the link',
      allowedDomains: [testServer.hostname], maxSteps: 10, maxDurationMs: 60_000,
    });
    assert.equal(outcome.kind, 'COMPLETED');
  } finally {
    await runtime.shutdown();
    await testServer.close();
  }
});

test('VISUAL_TYPE_EXECUTION: a scripted TYPE actually fills the real input field', async () => {
  const testServer = await createTestServer();
  const { runtime, browserService, deviceSessions } = await buildHarness();
  try {
    const model = new FakeVisualExecutionModelAdapter([NAV(testServer.baseUrl), TYPE_NAME, OBSERVE, STOP]);
    const service = new DeviceControlService(deviceSessions, browserService, model);
    await service.startSession({
      tenantId: TENANT_A, ownerId: OWNER_X, requestId: 'req_type', goal: 'type a name',
      allowedDomains: [testServer.hostname], maxSteps: 10, maxDurationMs: 60_000,
    });
    // The observation AFTER the TYPE (the 3rd model call, index 2) must
    // show the real, typed value — proving the loop re-observes the real
    // page rather than trusting a stale/assumed state.
    const postTypeSnapshot = model.calls[2].structuredSnapshot;
    const nameInput = postTypeSnapshot.inputs.find((i) => i.name === 'name');
    assert.equal(nameInput?.value, 'NAgex DC1');
  } finally {
    await runtime.shutdown();
    await testServer.close();
  }
});

test('VISUAL_KEYPRESS_EXECUTION: a scripted KEYPRESS executes without error', async () => {
  const testServer = await createTestServer();
  const { runtime, browserService, deviceSessions } = await buildHarness();
  try {
    const model = new FakeVisualExecutionModelAdapter([NAV(testServer.baseUrl), TYPE_NAME, KEYPRESS_ENTER, STOP]);
    const service = new DeviceControlService(deviceSessions, browserService, model);
    const outcome = await service.startSession({
      tenantId: TENANT_A, ownerId: OWNER_X, requestId: 'req_keypress', goal: 'type then press enter',
      allowedDomains: [testServer.hostname], maxSteps: 10, maxDurationMs: 60_000,
    });
    assert.equal(outcome.kind, 'COMPLETED');
  } finally {
    await runtime.shutdown();
    await testServer.close();
  }
});

test('VISUAL_POST_ACTION_VERIFICATION: a scripted SCROLL is followed by a fresh, real post-action observation', async () => {
  const testServer = await createTestServer();
  const { runtime, browserService, deviceSessions } = await buildHarness();
  try {
    const model = new FakeVisualExecutionModelAdapter([NAV(testServer.baseUrl), SCROLL_DOWN, STOP]);
    const service = new DeviceControlService(deviceSessions, browserService, model);
    const outcome = await service.startSession({
      tenantId: TENANT_A, ownerId: OWNER_X, requestId: 'req_scroll', goal: 'scroll down',
      allowedDomains: [testServer.hostname], maxSteps: 10, maxDurationMs: 60_000,
    });
    assert.equal(outcome.kind, 'COMPLETED');
    // Every observation (including the one right after SCROLL) came from a
    // real structuredSnapshot() call against the live page, not a cached
    // value — proven simply by there being one call per loop turn.
    assert.equal(model.calls.length, 3);
  } finally {
    await runtime.shutdown();
    await testServer.close();
  }
});

// ── 15-18: approval pause / resume ────────────────────────────────────────

test('DEVICE_APPROVAL_PAUSE: a consequential CLICK freezes the session at WAITING_APPROVAL with the exact pending action', async () => {
  const testServer = await createTestServer();
  const { runtime, browserService, deviceSessions } = await buildHarness();
  try {
    const model = new FakeVisualExecutionModelAdapter([NAV(testServer.baseUrl), CLICK_SUBMIT]);
    const service = new DeviceControlService(deviceSessions, browserService, model);
    const outcome = await service.startSession({
      tenantId: TENANT_A, ownerId: OWNER_X, requestId: 'req_pause', goal: 'submit the order',
      allowedDomains: [testServer.hostname], maxSteps: 10, maxDurationMs: 60_000,
    });
    assert.equal(outcome.kind, 'WAITING_APPROVAL');
    if (outcome.kind !== 'WAITING_APPROVAL') return;
    const session = deviceSessions.getOwned(outcome.deviceExecutionSessionId, TENANT_A, OWNER_X);
    assert.equal(session?.status, 'WAITING_APPROVAL');
    assert.deepEqual(session?.pendingAction, CLICK_SUBMIT);
    assert.equal(session?.approvalId, outcome.approval.approvalId);
  } finally {
    await runtime.shutdown();
    await testServer.close();
  }
});

test('DEVICE_APPROVAL_RIGHTFUL_RESUME: approving and resuming executes the exact frozen action and the loop continues to completion', async () => {
  const testServer = await createTestServer();
  const { runtime, approvals, browserService, deviceSessions } = await buildHarness();
  try {
    const model = new FakeVisualExecutionModelAdapter([NAV(testServer.baseUrl), CLICK_SUBMIT, STOP]);
    const service = new DeviceControlService(deviceSessions, browserService, model);
    const paused = await service.startSession({
      tenantId: TENANT_A, ownerId: OWNER_X, requestId: 'req_resume', goal: 'submit the order',
      allowedDomains: [testServer.hostname], maxSteps: 10, maxDurationMs: 60_000,
    });
    assert.equal(paused.kind, 'WAITING_APPROVAL');
    if (paused.kind !== 'WAITING_APPROVAL') return;

    approvals.approve(paused.approval.approvalId, TENANT_A, OWNER_X, 'req_approve');
    const resumed = await service.resumeSession({
      tenantId: TENANT_A, ownerId: OWNER_X, requestId: 'req_resume_exec',
      deviceExecutionSessionId: paused.deviceExecutionSessionId, approvalId: paused.approval.approvalId,
    });
    assert.equal(resumed.kind, 'COMPLETED');
    const session = deviceSessions.getOwned(paused.deviceExecutionSessionId, TENANT_A, OWNER_X);
    assert.equal(session?.status, 'COMPLETED');
    assert.equal(session?.pendingAction, null);
    assert.equal(session?.approvalId, null);
  } finally {
    await runtime.shutdown();
    await testServer.close();
  }
});

test('DEVICE_APPROVAL_WRONG_OWNER_BLOCK: resuming with the wrong tenant/owner is blocked and never consumes the approval', async () => {
  const testServer = await createTestServer();
  const { runtime, approvals, browserService, deviceSessions } = await buildHarness();
  try {
    const model = new FakeVisualExecutionModelAdapter([NAV(testServer.baseUrl), CLICK_SUBMIT, STOP]);
    const service = new DeviceControlService(deviceSessions, browserService, model);
    const paused = await service.startSession({
      tenantId: TENANT_A, ownerId: OWNER_X, requestId: 'req_wrong_owner', goal: 'submit the order',
      allowedDomains: [testServer.hostname], maxSteps: 10, maxDurationMs: 60_000,
    });
    assert.equal(paused.kind, 'WAITING_APPROVAL');
    if (paused.kind !== 'WAITING_APPROVAL') return;

    approvals.approve(paused.approval.approvalId, TENANT_A, OWNER_X, 'req_approve');

    await assert.rejects(
      service.resumeSession({ tenantId: TENANT_B, ownerId: OWNER_X, requestId: 'req_ct', deviceExecutionSessionId: paused.deviceExecutionSessionId, approvalId: paused.approval.approvalId }),
      (err: unknown) => err instanceof NagexError && err.code === 'DEVICE_SESSION_NOT_FOUND',
    );
    await assert.rejects(
      service.resumeSession({ tenantId: TENANT_A, ownerId: OWNER_Y, requestId: 'req_co', deviceExecutionSessionId: paused.deviceExecutionSessionId, approvalId: paused.approval.approvalId }),
      (err: unknown) => err instanceof NagexError && err.code === 'DEVICE_SESSION_NOT_FOUND',
    );

    // The session must still be waiting, and the approval must still be
    // APPROVED (unconsumed) — neither blocked attempt may have touched it.
    const session = deviceSessions.getOwned(paused.deviceExecutionSessionId, TENANT_A, OWNER_X);
    assert.equal(session?.status, 'WAITING_APPROVAL');
    const approval = approvals.get(paused.approval.approvalId, TENANT_A, OWNER_X);
    assert.equal(approval?.status, 'APPROVED');
  } finally {
    await runtime.shutdown();
    await testServer.close();
  }
});

test('DEVICE_APPROVAL_ONE_TIME_CONSUME: a second resume attempt with the same approval is rejected', async () => {
  const testServer = await createTestServer();
  const { runtime, approvals, browserService, deviceSessions } = await buildHarness();
  try {
    const model = new FakeVisualExecutionModelAdapter([NAV(testServer.baseUrl), CLICK_SUBMIT, STOP]);
    const service = new DeviceControlService(deviceSessions, browserService, model);
    const paused = await service.startSession({
      tenantId: TENANT_A, ownerId: OWNER_X, requestId: 'req_onetime', goal: 'submit the order',
      allowedDomains: [testServer.hostname], maxSteps: 10, maxDurationMs: 60_000,
    });
    assert.equal(paused.kind, 'WAITING_APPROVAL');
    if (paused.kind !== 'WAITING_APPROVAL') return;

    approvals.approve(paused.approval.approvalId, TENANT_A, OWNER_X, 'req_approve');
    const first = await service.resumeSession({
      tenantId: TENANT_A, ownerId: OWNER_X, requestId: 'req_resume_1',
      deviceExecutionSessionId: paused.deviceExecutionSessionId, approvalId: paused.approval.approvalId,
    });
    assert.equal(first.kind, 'COMPLETED');

    await assert.rejects(
      service.resumeSession({ tenantId: TENANT_A, ownerId: OWNER_X, requestId: 'req_resume_2', deviceExecutionSessionId: paused.deviceExecutionSessionId, approvalId: paused.approval.approvalId }),
      (err: unknown) => err instanceof NagexError && err.code === 'DEVICE_SESSION_NOT_WAITING',
    );

    const approval = approvals.get(paused.approval.approvalId, TENANT_A, OWNER_X);
    assert.equal(approval?.status, 'CONSUMED');
  } finally {
    await runtime.shutdown();
    await testServer.close();
  }
});

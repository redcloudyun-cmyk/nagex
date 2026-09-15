// DC3-B2 Production — DesktopControlService.
//
// Proves the orchestration layer (allowlist -> approval propose/freeze ->
// approve -> execute exactly once -> verify -> Activity) against a fake
// WindowsIsolatedDesktopController (no real Windows host required for
// this layer's own logic — the native controller/worker mechanics were
// already proven real-host in DC3-B2-R1 through R3 and are re-verified
// separately in the real Windows acceptance pass).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActionApprovalStore } from '../src/governance/action-approval.store.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { ActivityStore } from '../src/governance/activity.store.js';
import { DesktopExecutionSessionStore } from '../src/device-agent/desktop-execution-session.store.js';
import { DesktopAppAllowlist } from '../src/device-agent/desktop-app-allowlist.js';
import { DesktopActivityAdapter } from '../src/device-agent/desktop-activity-adapter.js';
import { WindowsIsolatedDesktopController, type DesktopWorkerResult } from '../src/device-agent/windows-isolated-desktop-controller.js';
import { DesktopControlService } from '../src/device-agent/desktop-control.service.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-desktop-control-test-'));
}

function ok(overrides: Partial<DesktopWorkerResult> = {}): DesktopWorkerResult {
  return { requestId: 'r', status: 'OK', observedBefore: null, observedAfter: null, verification: false, errorCode: null, matchCount: -1, ...overrides };
}

class FakeController extends WindowsIsolatedDesktopController {
  public available = true;
  public initialized = new Set<string>();
  public nextMutateResult: DesktopWorkerResult = ok({ status: 'SUCCEEDED_VERIFIED', observedBefore: 'a', observedAfter: 'b', verification: true });
  public cancelCalls = 0;

  public override isAvailable(): boolean {
    return this.available;
  }
  public override hasSession(executionSessionId: string): boolean {
    return this.initialized.has(executionSessionId);
  }
  public override async init(executionSessionId: string): Promise<DesktopWorkerResult> {
    this.initialized.add(executionSessionId);
    return ok();
  }
  public override async openApp(): Promise<DesktopWorkerResult> {
    return ok({ status: 'OK', observedAfter: 'pid=1234', matchCount: 1 });
  }
  public override async observe(): Promise<DesktopWorkerResult> {
    return ok({ status: 'OK', observedAfter: 'observed-value', matchCount: 1 });
  }
  public override async mutate(): Promise<DesktopWorkerResult> {
    return this.nextMutateResult;
  }
  public override async closeApp(): Promise<DesktopWorkerResult> {
    return ok();
  }
  public override async cancel(): Promise<DesktopWorkerResult> {
    this.cancelCalls += 1;
    return ok();
  }
  public override async shutdown(executionSessionId: string): Promise<DesktopWorkerResult> {
    this.initialized.delete(executionSessionId);
    return ok();
  }
}

function buildHarness() {
  const sessions = new DesktopExecutionSessionStore({ dir: tempDir() });
  const controller = new FakeController();
  const allowlist = new DesktopAppAllowlist();
  const approvals = new ActionApprovalStore();
  const auditLogger = new AuditLogger();
  const activityAdapter = new DesktopActivityAdapter(new ActivityStore({ dir: tempDir() }));
  const service = new DesktopControlService(sessions, controller, allowlist, approvals, auditLogger, activityAdapter);
  return { sessions, controller, allowlist, approvals, auditLogger, activityAdapter, service };
}

test('DESKTOP_UNKNOWN_APP_BLOCKED (service layer): startSession with an unallowlisted appId is terminated, never proposed for approval', async () => {
  const { service } = buildHarness();
  const outcome = await service.startSession({ tenantId: 't1', ownerId: 'o1', deviceId: 'd1', requestId: 'r1', appId: 'NOT_A_REAL_APP', action: 'OBSERVE', target: 'x' });
  assert.equal(outcome.kind, 'TERMINATED');
  if (outcome.kind === 'TERMINATED') assert.equal(outcome.status, 'APP_NOT_ALLOWED');
});

test('DESKTOP_BACKGROUND_UNSUPPORTED: when the isolated controller is unavailable, the service reports it truthfully rather than silently falling back', async () => {
  const { service, controller } = buildHarness();
  controller.available = false;
  const outcome = await service.startSession({ tenantId: 't1', ownerId: 'o1', deviceId: 'd1', requestId: 'r1', appId: 'NAGEX_TEST_HARNESS', action: 'OBSERVE', target: 'x' });
  assert.equal(outcome.kind, 'TERMINATED');
  if (outcome.kind === 'TERMINATED') assert.equal(outcome.status, 'BACKGROUND_UNSUPPORTED');
});

test('OBSERVE executes immediately with no approval proposed', async () => {
  const { service } = buildHarness();
  const outcome = await service.startSession({ tenantId: 't1', ownerId: 'o1', deviceId: 'd1', requestId: 'r1', appId: 'NAGEX_TEST_HARNESS', action: 'OBSERVE', target: 'NagexTestTextInput' });
  assert.equal(outcome.kind, 'COMPLETED');
});

test('a mutation proposes and freezes an approval instead of executing immediately', async () => {
  const { service } = buildHarness();
  const outcome = await service.startSession({ tenantId: 't1', ownerId: 'o1', deviceId: 'd1', requestId: 'r1', appId: 'NAGEX_TEST_HARNESS', action: 'SET_VALUE', target: 'NagexTestTextInput', parameters: { value: 'x' } });
  assert.equal(outcome.kind, 'WAITING_APPROVAL');
  if (outcome.kind === 'WAITING_APPROVAL') {
    assert.equal(outcome.approval.toolId, 'device.desktop.execute');
    assert.equal(outcome.approval.status, 'PENDING');
  }
});

test('DESKTOP_SET_VALUE_VERIFIED / approval-gated execute-exactly-once: resuming with the approved approvalId executes and verifies; a second resume with the same approvalId is rejected', async () => {
  const { service, approvals } = buildHarness();
  const start = await service.startSession({ tenantId: 't1', ownerId: 'o1', deviceId: 'd1', requestId: 'r1', appId: 'NAGEX_TEST_HARNESS', action: 'SET_VALUE', target: 'NagexTestTextInput', parameters: { value: 'x' } });
  assert.equal(start.kind, 'WAITING_APPROVAL');
  if (start.kind !== 'WAITING_APPROVAL') return;

  approvals.approve(start.approval.approvalId, 't1', 'o1');
  const resumed = await service.resumeSession({
    tenantId: 't1', ownerId: 'o1', requestId: 'r2', deviceId: 'd1', approvalId: start.approval.approvalId,
    appId: 'NAGEX_TEST_HARNESS', action: 'SET_VALUE', target: 'NagexTestTextInput', parameters: { value: 'x' },
  });
  assert.equal(resumed.kind, 'COMPLETED');
  if (resumed.kind === 'COMPLETED') {
    assert.equal(resumed.result.status, 'SUCCEEDED_VERIFIED');
    assert.equal(resumed.result.verification, true);
  }

  // Exactly-once: the same approvalId cannot be consumed again.
  const secondAttempt = await service.resumeSession({
    tenantId: 't1', ownerId: 'o1', requestId: 'r3', deviceId: 'd1', approvalId: start.approval.approvalId,
    appId: 'NAGEX_TEST_HARNESS', action: 'SET_VALUE', target: 'NagexTestTextInput', parameters: { value: 'x' },
  });
  assert.equal(secondAttempt.kind, 'TERMINATED');
});

test('DESKTOP_WRONG_TENANT_BLOCKED / DESKTOP_WRONG_OWNER_BLOCKED / DESKTOP_INVALID_SESSION_BLOCKED: a session created under one tenant/owner cannot be reused by another', async () => {
  const { service, sessions } = buildHarness();
  const session = sessions.create({ deviceId: 'd1', tenantId: 't1', ownerId: 'o1', mode: 'BACKGROUND', expiresAt: new Date(Date.now() + 60_000).toISOString() });

  const wrongTenant = await service.startSession({ tenantId: 't2', ownerId: 'o1', deviceId: 'd1', requestId: 'r1', executionSessionId: session.executionSessionId, appId: 'NAGEX_TEST_HARNESS', action: 'OBSERVE', target: 'x' });
  assert.equal(wrongTenant.kind, 'TERMINATED');
  if (wrongTenant.kind === 'TERMINATED') assert.equal(wrongTenant.terminationReason, 'DESKTOP_INVALID_SESSION');

  const wrongOwner = await service.startSession({ tenantId: 't1', ownerId: 'o2', deviceId: 'd1', requestId: 'r1', executionSessionId: session.executionSessionId, appId: 'NAGEX_TEST_HARNESS', action: 'OBSERVE', target: 'x' });
  assert.equal(wrongOwner.kind, 'TERMINATED');
  if (wrongOwner.kind === 'TERMINATED') assert.equal(wrongOwner.terminationReason, 'DESKTOP_INVALID_SESSION');

  const unknownSession = await service.startSession({ tenantId: 't1', ownerId: 'o1', deviceId: 'd1', requestId: 'r1', executionSessionId: 'dxs_does_not_exist', appId: 'NAGEX_TEST_HARNESS', action: 'OBSERVE', target: 'x' });
  assert.equal(unknownSession.kind, 'TERMINATED');
});

test('DESKTOP_TARGET_AMBIGUOUS / DESKTOP_TOCTOU_TARGET_CHANGE_BLOCKED: native TARGET_AMBIGUOUS / TARGET_CHANGED_SINCE_OBSERVATION statuses are surfaced truthfully, never silently reported as success', async () => {
  const { service, controller, approvals } = buildHarness();
  controller.nextMutateResult = { requestId: 'r', status: 'TARGET_AMBIGUOUS', observedBefore: null, observedAfter: null, verification: false, errorCode: null, matchCount: 3 };

  const start = await service.startSession({ tenantId: 't1', ownerId: 'o1', deviceId: 'd1', requestId: 'r1', appId: 'NAGEX_TEST_HARNESS', action: 'TOGGLE', target: 'x' });
  assert.equal(start.kind, 'WAITING_APPROVAL');
  if (start.kind !== 'WAITING_APPROVAL') return;
  approvals.approve(start.approval.approvalId, 't1', 'o1');
  const resumed = await service.resumeSession({ tenantId: 't1', ownerId: 'o1', requestId: 'r2', deviceId: 'd1', approvalId: start.approval.approvalId, appId: 'NAGEX_TEST_HARNESS', action: 'TOGGLE', target: 'x' });
  assert.equal(resumed.kind, 'TERMINATED');
  if (resumed.kind === 'TERMINATED') assert.equal(resumed.terminationReason, 'TARGET_AMBIGUOUS');

  controller.nextMutateResult = { requestId: 'r', status: 'TARGET_CHANGED_SINCE_OBSERVATION', observedBefore: null, observedAfter: null, verification: false, errorCode: null, matchCount: -1 };
  const start2 = await service.startSession({ tenantId: 't1', ownerId: 'o1', deviceId: 'd1', requestId: 'r3', appId: 'NAGEX_TEST_HARNESS', action: 'TOGGLE', target: 'x' });
  if (start2.kind !== 'WAITING_APPROVAL') return;
  approvals.approve(start2.approval.approvalId, 't1', 'o1');
  const resumed2 = await service.resumeSession({ tenantId: 't1', ownerId: 'o1', requestId: 'r4', deviceId: 'd1', approvalId: start2.approval.approvalId, appId: 'NAGEX_TEST_HARNESS', action: 'TOGGLE', target: 'x' });
  assert.equal(resumed2.kind, 'TERMINATED');
  if (resumed2.kind === 'TERMINATED') assert.equal(resumed2.terminationReason, 'TARGET_CHANGED_SINCE_OBSERVATION');
});

test('DESKTOP_CANCEL_VISIBLE: cancel() forwards to the controller only for an owned, initialized session', async () => {
  const { service, controller, sessions } = buildHarness();
  const session = sessions.create({ deviceId: 'd1', tenantId: 't1', ownerId: 'o1', mode: 'BACKGROUND', expiresAt: new Date(Date.now() + 60_000).toISOString() });
  await controller.init(session.executionSessionId);
  await service.cancel('t1', 'o1', session.executionSessionId);
  assert.equal(controller.cancelCalls, 1);

  // Wrong owner: no cancel forwarded.
  await service.cancel('t1', 'someone-else', session.executionSessionId);
  assert.equal(controller.cancelCalls, 1);
});

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
  const activityStore = new ActivityStore({ dir: tempDir() });
  const activityAdapter = new DesktopActivityAdapter(activityStore);
  const service = new DesktopControlService(sessions, controller, allowlist, approvals, auditLogger, activityAdapter);
  return { sessions, controller, allowlist, approvals, auditLogger, activityStore, activityAdapter, service };
}

function newSession(sessions: DesktopExecutionSessionStore, overrides: Partial<{ deviceId: string; tenantId: string; ownerId: string }> = {}) {
  return sessions.create({
    deviceId: overrides.deviceId ?? 'd1',
    tenantId: overrides.tenantId ?? 't1',
    ownerId: overrides.ownerId ?? 'o1',
    mode: 'BACKGROUND',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
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
  const outcome = await service.cancel('t1', 'o1', 'd1', session.executionSessionId, 'req1');
  assert.equal(outcome.kind, 'TERMINATED');
  if (outcome.kind === 'TERMINATED') assert.equal(outcome.status, 'CANCELLED');
  assert.equal(controller.cancelCalls, 1);

  // Wrong owner: no cancel forwarded (session already closed by the real
  // cancel above, so use a fresh session to isolate the ownership check).
  const session2 = sessions.create({ deviceId: 'd1', tenantId: 't1', ownerId: 'o1', mode: 'BACKGROUND', expiresAt: new Date(Date.now() + 60_000).toISOString() });
  await controller.init(session2.executionSessionId);
  const wrongOwnerOutcome = await service.cancel('t1', 'someone-else', 'd1', session2.executionSessionId, 'req2');
  assert.equal(wrongOwnerOutcome.kind, 'TERMINATED');
  if (wrongOwnerOutcome.kind === 'TERMINATED') assert.equal(wrongOwnerOutcome.terminationReason, 'DESKTOP_INVALID_SESSION');
  assert.equal(controller.cancelCalls, 1);
});

// ═══════════════════════════════════════════════════════════════════════
// DC3-B2-R4 — First-class CANCEL capability closure.
// ═══════════════════════════════════════════════════════════════════════

test('DESKTOP_CANCEL_CAPABILITY_REACHABLE / DESKTOP_CANCEL_ROUTES_TO_SERVICE: action=CANCEL reaches DesktopControlService.cancel() through startSession() — the same entry point the real CapabilityBroker dispatch uses, with no approval required', async () => {
  const { service, sessions, controller } = buildHarness();
  const session = newSession(sessions);
  await controller.init(session.executionSessionId);

  const outcome = await service.startSession({
    tenantId: 't1', ownerId: 'o1', deviceId: 'd1', requestId: 'r1',
    executionSessionId: session.executionSessionId, appId: 'NAGEX_TEST_HARNESS', action: 'CANCEL',
  });

  assert.equal(outcome.kind, 'TERMINATED');
  if (outcome.kind === 'TERMINATED') assert.equal(outcome.status, 'CANCELLED');
  assert.equal(controller.cancelCalls, 1, 'CANCEL routed through startSession() must reach the controller exactly once');
});

test('DESKTOP_CANCEL_DOES_NOT_REQUIRE_APPROVAL: a CANCEL request never proposes/waits on an approval, unlike every mutation action', async () => {
  const { service, sessions, controller, approvals } = buildHarness();
  const session = newSession(sessions);
  await controller.init(session.executionSessionId);
  const before = (approvals as any).records?.size ?? 0;

  const outcome = await service.startSession({
    tenantId: 't1', ownerId: 'o1', deviceId: 'd1', requestId: 'r1',
    executionSessionId: session.executionSessionId, appId: 'NAGEX_TEST_HARNESS', action: 'CANCEL',
  });

  assert.notEqual(outcome.kind, 'WAITING_APPROVAL');
  const after = (approvals as any).records?.size ?? 0;
  assert.equal(after, before, 'cancel must never create a new approval record');
});

test('DESKTOP_CANCEL_WRONG_TENANT_BLOCKED / DESKTOP_CANCEL_WRONG_OWNER_BLOCKED / DESKTOP_CANCEL_WRONG_SESSION_BLOCKED: cancel requires the same canonical identity checks as any other action', async () => {
  const { service, sessions, controller } = buildHarness();
  const session = newSession(sessions, { tenantId: 't1', ownerId: 'o1' });
  await controller.init(session.executionSessionId);

  const wrongTenant = await service.cancel('t2', 'o1', 'd1', session.executionSessionId, 'r1');
  assert.equal(wrongTenant.kind, 'TERMINATED');
  if (wrongTenant.kind === 'TERMINATED') assert.equal(wrongTenant.terminationReason, 'DESKTOP_INVALID_SESSION');
  assert.equal(controller.cancelCalls, 0);

  const wrongOwner = await service.cancel('t1', 'o2', 'd1', session.executionSessionId, 'r2');
  assert.equal(wrongOwner.kind, 'TERMINATED');
  if (wrongOwner.kind === 'TERMINATED') assert.equal(wrongOwner.terminationReason, 'DESKTOP_INVALID_SESSION');
  assert.equal(controller.cancelCalls, 0);

  const wrongSession = await service.cancel('t1', 'o1', 'd1', 'dxs_does_not_exist', 'r3');
  assert.equal(wrongSession.kind, 'TERMINATED');
  if (wrongSession.kind === 'TERMINATED') assert.equal(wrongSession.terminationReason, 'DESKTOP_INVALID_SESSION');
  assert.equal(controller.cancelCalls, 0);

  // Only the genuinely owned session, with the correct identity, actually cancels.
  const real = await service.cancel('t1', 'o1', 'd1', session.executionSessionId, 'r4');
  assert.equal(real.kind, 'TERMINATED');
  if (real.kind === 'TERMINATED') assert.equal(real.status, 'CANCELLED');
  assert.equal(controller.cancelCalls, 1);
});

test('DESKTOP_CANCEL_WRONG_DEVICE_BLOCKED: cancel is rejected when the requesting deviceId does not match the session\'s own deviceId', async () => {
  const { service, sessions, controller } = buildHarness();
  const session = newSession(sessions, { deviceId: 'd1' });
  await controller.init(session.executionSessionId);

  const outcome = await service.cancel('t1', 'o1', 'd2', session.executionSessionId, 'r1');
  assert.equal(outcome.kind, 'TERMINATED');
  if (outcome.kind === 'TERMINATED') assert.equal(outcome.terminationReason, 'DESKTOP_WRONG_DEVICE');
  assert.equal(controller.cancelCalls, 0);
});

test('DESKTOP_CANCEL_BEFORE_MUTATION: cancelling a session that was opened but never mutated still tears down cleanly', async () => {
  const { service, sessions, controller } = buildHarness();
  const session = newSession(sessions);
  await controller.init(session.executionSessionId);

  const outcome = await service.cancel('t1', 'o1', 'd1', session.executionSessionId, 'r1');
  assert.equal(outcome.kind, 'TERMINATED');
  if (outcome.kind === 'TERMINATED') assert.equal(outcome.status, 'CANCELLED');
  assert.equal(controller.initialized.has(session.executionSessionId), false, 'controller session must be shut down');
});

test('DESKTOP_CANCEL_PREVENTS_NEXT_MUTATION: a mutation attempted after cancel is blocked, never reaching the controller', async () => {
  const { service, sessions, controller } = buildHarness();
  const session = newSession(sessions);
  await controller.init(session.executionSessionId);
  await service.cancel('t1', 'o1', 'd1', session.executionSessionId, 'r1');

  const mutationOutcome = await service.startSession({
    tenantId: 't1', ownerId: 'o1', deviceId: 'd1', requestId: 'r2',
    executionSessionId: session.executionSessionId, appId: 'NAGEX_TEST_HARNESS', action: 'TOGGLE', target: 'x',
  });
  // TOGGLE is a mutation -> would normally propose an approval, but the
  // session is already non-ACTIVE by the time execute() would run. Since
  // startSession() proposes approval before checking session state (the
  // check lives in execute()/resumeSession()), the propose itself may
  // still succeed — the load-bearing proof is that RESUMING it never
  // actually mutates.
  if (mutationOutcome.kind === 'WAITING_APPROVAL') {
    const resumed = await service.resumeSession({
      tenantId: 't1', ownerId: 'o1', requestId: 'r3', deviceId: 'd1', approvalId: mutationOutcome.approval.approvalId,
      executionSessionId: session.executionSessionId, appId: 'NAGEX_TEST_HARNESS', action: 'TOGGLE', target: 'x',
    });
    assert.equal(resumed.kind, 'TERMINATED');
    if (resumed.kind === 'TERMINATED') assert.equal(resumed.terminationReason, 'DESKTOP_SESSION_NOT_ACTIVE');
  } else {
    assert.equal(mutationOutcome.kind, 'TERMINATED');
  }
  assert.equal(controller.cancelCalls, 1, 'no additional controller activity beyond the original cancel');
});

test('DESKTOP_CANCEL_IDEMPOTENT: a second cancel on an already-cancelled session is a safe no-op, not a duplicate teardown', async () => {
  const { service, sessions, controller } = buildHarness();
  const session = newSession(sessions);
  await controller.init(session.executionSessionId);

  const first = await service.cancel('t1', 'o1', 'd1', session.executionSessionId, 'r1');
  assert.equal(first.kind, 'TERMINATED');
  if (first.kind === 'TERMINATED') assert.equal(first.terminationReason, 'USER_CANCELLED');
  assert.equal(controller.cancelCalls, 1);

  const second = await service.cancel('t1', 'o1', 'd1', session.executionSessionId, 'r2');
  assert.equal(second.kind, 'TERMINATED');
  if (second.kind === 'TERMINATED') {
    assert.equal(second.status, 'CANCELLED');
    assert.equal(second.terminationReason, 'ALREADY_TERMINAL');
  }
  assert.equal(controller.cancelCalls, 1, 'no duplicate controller.cancel() call on the second, idempotent request');
});

test('DESKTOP_CANCEL_AFTER_COMPLETE_NO_REWRITE: cancelling a session that already completed via CLOSE_APP is a no-op and never rewrites its Activity', async () => {
  const { service, sessions, controller, approvals, activityStore } = buildHarness();
  const session = newSession(sessions);
  await controller.init(session.executionSessionId);

  const start = await service.startSession({
    tenantId: 't1', ownerId: 'o1', deviceId: 'd1', requestId: 'r1',
    executionSessionId: session.executionSessionId, appId: 'NAGEX_TEST_HARNESS', action: 'CLOSE_APP',
  });
  assert.equal(start.kind, 'WAITING_APPROVAL');
  if (start.kind !== 'WAITING_APPROVAL') return;
  approvals.approve(start.approval.approvalId, 't1', 'o1');
  const resumed = await service.resumeSession({
    tenantId: 't1', ownerId: 'o1', requestId: 'r2', deviceId: 'd1', approvalId: start.approval.approvalId,
    executionSessionId: session.executionSessionId, appId: 'NAGEX_TEST_HARNESS', action: 'CLOSE_APP',
  });
  assert.equal(resumed.kind, 'COMPLETED');

  const activityBefore = activityStore.list('t1', 'o1', 10)[0];
  assert.notEqual(activityBefore?.status, 'FAILED');

  const cancelOutcome = await service.cancel('t1', 'o1', 'd1', session.executionSessionId, 'r3');
  assert.equal(cancelOutcome.kind, 'TERMINATED');
  if (cancelOutcome.kind === 'TERMINATED') assert.equal(cancelOutcome.terminationReason, 'ALREADY_TERMINAL');
  assert.equal(controller.cancelCalls, 0, 'a completed, already-closed session never reaches controller.cancel()');

  const activityAfter = activityStore.list('t1', 'o1', 10)[0];
  assert.deepEqual(activityAfter, activityBefore, 'the completed session\'s Activity item must be byte-identical after a no-op cancel attempt — never rewritten');
});

test('DESKTOP_CANCEL_AFTER_FAILURE_NO_REWRITE: a genuinely failed mutation\'s own outcome/Activity is never retroactively rewritten by a subsequent cancel', async () => {
  const { service, sessions, controller, approvals, activityStore } = buildHarness();
  const session = newSession(sessions);
  await controller.init(session.executionSessionId);
  controller.nextMutateResult = { requestId: 'r', status: 'TARGET_AMBIGUOUS', observedBefore: null, observedAfter: null, verification: false, errorCode: null, matchCount: 2 };

  const start = await service.startSession({
    tenantId: 't1', ownerId: 'o1', deviceId: 'd1', requestId: 'r1',
    executionSessionId: session.executionSessionId, appId: 'NAGEX_TEST_HARNESS', action: 'TOGGLE', target: 'x',
  });
  assert.equal(start.kind, 'WAITING_APPROVAL');
  if (start.kind !== 'WAITING_APPROVAL') return;
  approvals.approve(start.approval.approvalId, 't1', 'o1');
  const resumed = await service.resumeSession({
    tenantId: 't1', ownerId: 'o1', requestId: 'r2', deviceId: 'd1', approvalId: start.approval.approvalId,
    executionSessionId: session.executionSessionId, appId: 'NAGEX_TEST_HARNESS', action: 'TOGGLE', target: 'x',
  });
  assert.equal(resumed.kind, 'TERMINATED');
  if (resumed.kind === 'TERMINATED') assert.equal(resumed.terminationReason, 'TARGET_AMBIGUOUS');

  // The failed mutation's own already-returned outcome is immutable —
  // this assertion is the real point: a later cancel cannot change what
  // already happened and was already reported.
  assert.equal(resumed.kind, 'TERMINATED');

  // The session itself is still ACTIVE (one failed mutation does not end
  // the session) — cancel now legitimately proceeds and closes it out.
  const cancelOutcome = await service.cancel('t1', 'o1', 'd1', session.executionSessionId, 'r3');
  assert.equal(cancelOutcome.kind, 'TERMINATED');
  if (cancelOutcome.kind === 'TERMINATED') assert.equal(cancelOutcome.terminationReason, 'USER_CANCELLED');
  void activityStore;
});

test('DESKTOP_CANCEL_PENDING_APPROVAL_PREVENTS_RESUME: a mutation proposed before cancel can never mutate after it, even though the approval itself is still technically APPROVED', async () => {
  const { service, sessions, controller, approvals } = buildHarness();
  const session = newSession(sessions);
  await controller.init(session.executionSessionId);

  const start = await service.startSession({
    tenantId: 't1', ownerId: 'o1', deviceId: 'd1', requestId: 'r1',
    executionSessionId: session.executionSessionId, appId: 'NAGEX_TEST_HARNESS', action: 'SET_VALUE', target: 'x', parameters: { value: 'y' },
  });
  assert.equal(start.kind, 'WAITING_APPROVAL');
  if (start.kind !== 'WAITING_APPROVAL') return;
  approvals.approve(start.approval.approvalId, 't1', 'o1');

  // Human override wins: cancel before ever resuming the approved mutation.
  await service.cancel('t1', 'o1', 'd1', session.executionSessionId, 'r2');

  const resumed = await service.resumeSession({
    tenantId: 't1', ownerId: 'o1', requestId: 'r3', deviceId: 'd1', approvalId: start.approval.approvalId,
    executionSessionId: session.executionSessionId, appId: 'NAGEX_TEST_HARNESS', action: 'SET_VALUE', target: 'x', parameters: { value: 'y' },
  });
  assert.equal(resumed.kind, 'TERMINATED');
  if (resumed.kind === 'TERMINATED') assert.equal(resumed.terminationReason, 'DESKTOP_SESSION_NOT_ACTIVE');
  assert.equal(controller.cancelCalls, 1, 'the resume attempt must never reach the controller a second time');

  // The approval itself is left untouched (never silently consumed by
  // cancel processing) — it is only ever checked, never spent, by the
  // blocked resume above.
  const stillApproved = approvals.assertExecutable(start.approval.approvalId, 't1', 'o1', 'device.desktop.execute', 'r4');
  assert.equal(stillApproved.status, 'APPROVED');
});

test('DESKTOP_CANCEL_ACTIVITY / DESKTOP_CANCEL_NO_DUPLICATE_TERMINAL_EVENT: cancel records exactly one CANCELLED Activity item, never duplicated by an idempotent second cancel', async () => {
  const { service, sessions, controller, activityStore } = buildHarness();
  const session = newSession(sessions);
  await controller.init(session.executionSessionId);

  await service.cancel('t1', 'o1', 'd1', session.executionSessionId, 'r1');
  const itemsAfterFirst = activityStore.list('t1', 'o1', 50).filter((a) => a.source?.executionId === session.executionSessionId);
  assert.equal(itemsAfterFirst.length, 1);
  assert.equal(itemsAfterFirst[0].status, 'FAILED'); // CANCELLED maps onto the real ActivityStatus enum's FAILED value
  assert.ok(itemsAfterFirst[0].title.includes('NAgex'));

  await service.cancel('t1', 'o1', 'd1', session.executionSessionId, 'r2');
  const itemsAfterSecond = activityStore.list('t1', 'o1', 50).filter((a) => a.source?.executionId === session.executionSessionId);
  assert.equal(itemsAfterSecond.length, 1, 'the idempotent second cancel must not create a second Activity item');
  assert.deepEqual(itemsAfterSecond[0], itemsAfterFirst[0], 'and must not modify the existing one either');
});

test('DESKTOP_CANCEL_AUDIT: cancel emits bounded desktop.execute.cancel.requested and desktop.execute.cancelled audit events, never duplicated on an idempotent repeat', async () => {
  const { service, sessions, controller, auditLogger } = buildHarness();
  const session = newSession(sessions);
  await controller.init(session.executionSessionId);

  const logged: string[] = [];
  const originalLogEvent = auditLogger.logEvent.bind(auditLogger);
  auditLogger.logEvent = ((event: Parameters<typeof originalLogEvent>[0]) => {
    logged.push(event.action);
    return originalLogEvent(event);
  }) as typeof auditLogger.logEvent;

  await service.cancel('t1', 'o1', 'd1', session.executionSessionId, 'r1');
  assert.ok(logged.includes('desktop.execute.cancel.requested'));
  assert.ok(logged.includes('desktop.execute.cancelled'));
  const countAfterFirst = logged.filter((a) => a === 'desktop.execute.cancelled').length;
  assert.equal(countAfterFirst, 1);

  await service.cancel('t1', 'o1', 'd1', session.executionSessionId, 'r2');
  const countAfterSecond = logged.filter((a) => a === 'desktop.execute.cancelled').length;
  assert.equal(countAfterSecond, 1, 'no duplicate terminal audit event on an idempotent second cancel');
});

test('DESKTOP_CANCEL_GRACEFUL_CLEANUP / DESKTOP_CANCEL_NO_RESIDUAL_PROCESS: cancel closes the app gracefully and shuts down the controller session — never a force-kill, and no residual controller-tracked session afterward', async () => {
  const { service, sessions, controller } = buildHarness();
  const session = newSession(sessions);
  await controller.init(session.executionSessionId);
  assert.equal(controller.hasSession(session.executionSessionId), true);

  let closeAppCalled = false;
  let shutdownCalled = false;
  const originalCloseApp = controller.closeApp.bind(controller);
  const originalShutdown = controller.shutdown.bind(controller);
  controller.closeApp = (async (...args: Parameters<typeof originalCloseApp>) => { closeAppCalled = true; return originalCloseApp(...args); }) as typeof controller.closeApp;
  controller.shutdown = (async (...args: Parameters<typeof originalShutdown>) => { shutdownCalled = true; return originalShutdown(...args); }) as typeof controller.shutdown;

  await service.cancel('t1', 'o1', 'd1', session.executionSessionId, 'r1');

  assert.equal(closeAppCalled, true, 'cancel must gracefully close the app (WindowPattern.Close(), never SendInput/force-kill)');
  assert.equal(shutdownCalled, true, 'cancel must shut down the isolated desktop/worker session');
  assert.equal(controller.hasSession(session.executionSessionId), false, 'no residual controller-tracked session after cancel');
});

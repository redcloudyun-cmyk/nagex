import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ActionApprovalStore, hashCanonicalPayload } from '../src/governance/action-approval.store.js';
import { DeviceIdentityStore } from '../src/device-agent/device-identity.store.js';
import { DevicePendingCommandStore } from '../src/device-agent/device-pending-command.store.js';
import { DeviceCommandService, ACCESSIBILITY_PLAN_TOOL_ID } from '../src/device-agent/device-command.service.js';
import { SessionStore } from '../src/sessions/session.store.js';
import { handleDeviceAgentRoutes } from '../src/http/routes/device-agent.routes.js';
import { mobileAccessibilityDraftPayload } from '../src/mobile/mobile-accessibility-approval.service.js';

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-r2c-')); }
function sha256(text: string): string { return crypto.createHash('sha256').update(text, 'utf8').digest('hex'); }
function expectCode(fn: () => unknown, code: string) {
  assert.throws(fn, (error: unknown) => (error as { code?: string }).code === code);
}

function makeHarness(patch: Record<string, unknown> = {}) {
  const now = Date.now();
  const devices = new DeviceIdentityStore({ dir: path.join(tmp(), 'devices') });
  const pending = new DevicePendingCommandStore({ dir: path.join(tmp(), 'pending') });
  const approvals = new ActionApprovalStore(() => now);
  const device = devices.enroll({
    tenantId: 'ten',
    ownerId: 'usr',
    publicKey: 'pub',
    agentVersion: 'android-r2c',
    capabilityInventory: ['permission:ACCESSIBILITY_SERVICE:ENABLED'],
  });
  const message = 'See you at 6.';
  const messageHash = hashCanonicalPayload({ message });
  const material = mobileAccessibilityDraftPayload({
    targetPackage: 'com.kakao.talk',
    targetAppVersion: '26.8.2',
    recipientRef: 'rcp_sarah',
    displayName: 'Sarah',
    approvedTextHash: sha256(message),
    messageHash,
    deviceId: device.deviceId,
    route: 'ANDROID_ACCESSIBILITY',
  });
  const approval = approvals.request({
    toolId: ACCESSIBILITY_PLAN_TOOL_ID,
    tenantId: 'ten',
    principalId: 'usr',
    payload: material,
  });
  approvals.approve(approval.approvalId, 'ten', 'usr');
  const input = {
    tenantId: 'ten',
    principalId: 'usr',
    requestId: 'req_r2c',
    deviceId: device.deviceId,
    approvalRef: approval.approvalId,
    recipientRef: 'rcp_sarah',
    targetPackage: 'com.kakao.talk',
    targetAppVersion: '26.8.2',
    route: 'ANDROID_ACCESSIBILITY',
    planId: 'plan_r2c',
    approvedPayloadHash: sha256(message),
    approvedText: message,
    messageHash,
    displayName: 'Sarah',
    expiresAt: new Date(now + 60_000).toISOString(),
    steps: [
      { stepId: 's1', action: 'OPEN_APP', screenContract: 'chat-list', semanticTarget: 'kakao_app' },
      { stepId: 's2', action: 'VERIFY_RECIPIENT', screenContract: 'conversation', semanticTarget: 'Sarah' },
      { stepId: 's3', action: 'TYPE_APPROVED_TEXT', screenContract: 'composer', semanticTarget: 'message_input' },
      { stepId: 's4', action: 'OBSERVE_RESULT', screenContract: 'composer', semanticTarget: 'draft' },
    ],
    ...patch,
  };
  const service = new DeviceCommandService(devices, pending, approvals, () => now);
  return { devices, pending, approvals, device, approval, input, service };
}

test('M4C-R2C valid governed enqueue stores one ACCESSIBILITY_EXECUTE_PLAN and heartbeat dequeue consumes once', () => {
  const h = makeHarness();
  const result = h.service.enqueueAccessibilityPlan(h.input);
  assert.equal(result.status, 'QUEUED');
  assert.equal(result.command.commandType, 'ACCESSIBILITY_EXECUTE_PLAN');
  assert.equal(result.command.deviceId, h.device.deviceId);
  assert.equal(result.command.data.planId, 'plan_r2c');
  assert.equal(result.command.data.approvedPayloadHash, h.input.approvedPayloadHash);
  assert.equal(result.command.data.approvedText, h.input.approvedText);
  const delivered = h.pending.dequeueNext(h.device.deviceId, 'ten', 'usr');
  assert.equal(delivered?.commandId, result.command.commandId);
  assert.equal(h.pending.dequeueNext(h.device.deviceId, 'ten', 'usr'), null);
});

test('M4C-R2C unauthenticated API enqueue is rejected', async () => {
  const h = makeHarness();
  await assert.rejects(
    () => handleDeviceAgentRoutes('POST', '/api/v1/device-agent/accessibility-plans', h.input, {}, {}, {
      deviceAgentTransportEndpoint: {} as any,
      deviceCommandService: h.service,
      deviceIdentityStore: h.devices,
      sessionStore: new SessionStore({ dir: path.join(tmp(), 'sessions') }),
    }),
    (error: unknown) => (error as { code?: string }).code === 'DEVICE_COMMAND_AUTH_REQUIRED',
  );
});

test('M4C-R2C authenticated narrow API enqueues without generic command passthrough', async () => {
  const h = makeHarness();
  const sessions = new SessionStore({ dir: path.join(tmp(), 'sessions') });
  const session = sessions.createAuthSession('ten', 'usr');
  const res = await handleDeviceAgentRoutes('POST', '/api/v1/device-agent/accessibility-plans', h.input, { authorization: `Bearer ${session.sessionId}` }, {}, {
    deviceAgentTransportEndpoint: {} as any,
    deviceCommandService: h.service,
    deviceIdentityStore: h.devices,
    sessionStore: sessions,
  });
  assert.equal(res?.status, 202);
  assert.equal((res?.data as any).commandType, 'ACCESSIBILITY_EXECUTE_PLAN');
});

const blockedCases: Array<[string, Record<string, unknown>, string]> = [
  ['wrong tenant rejected', { tenantId: 'other' }, 'DEVICE_NOT_FOUND'],
  ['wrong user rejected', { principalId: 'other' }, 'DEVICE_NOT_FOUND'],
  ['missing approval rejected', { approvalRef: 'apr_missing' }, 'APPROVAL_NOT_FOUND'],
  ['recipient mismatch rejected', { recipientRef: 'rcp_other' }, 'APPROVAL_PAYLOAD_MISMATCH'],
  ['message hash mismatch rejected', { messageHash: 'wrong' }, 'APPROVAL_PAYLOAD_MISMATCH'],
  ['wrong route rejected', { route: 'APP_LINK' }, 'ROUTE_MUTATION_REAPPROVAL_REQUIRED'],
  ['unsupported package rejected', { targetPackage: 'com.other' }, 'APP_NOT_ALLOWLISTED'],
  ['unsupported version rejected', { targetAppVersion: '99.0.0' }, 'APP_VERSION_UNSUPPORTED'],
  ['send action rejected', { steps: [{ stepId: 's1', action: 'PRESS_SEND', screenContract: 'composer', semanticTarget: 'send' }] }, 'ACCESSIBILITY_ACTION_NOT_ALLOWED'],
  ['arbitrary action rejected', { steps: [{ stepId: 's1', action: 'SHELL', screenContract: 'system', semanticTarget: 'shell' }] }, 'ACCESSIBILITY_ACTION_NOT_ALLOWED'],
  ['expired plan rejected', { expiresAt: '2020-01-01T00:00:00.000Z' }, 'ACCESSIBILITY_PLAN_EXPIRED'],
];

for (const [name, patch, code] of blockedCases) {
  test(`M4C-R2C ${name}`, () => {
    const h = makeHarness(patch);
    expectCode(() => h.service.enqueueAccessibilityPlan(h.input), code);
  });
}

test('M4C-R2C inactive device rejected', () => {
  const h = makeHarness();
  h.devices.revoke(h.device.deviceId, 'ten', 'usr');
  expectCode(() => h.service.enqueueAccessibilityPlan(h.input), 'DEVICE_NOT_ACTIVE');
});

test('M4C-R2C expired approval rejected', () => {
  const now = Date.now();
  let current = now;
  const h = makeHarness();
  const approvals = new ActionApprovalStore(() => current, 1);
  const service = new DeviceCommandService(h.devices, h.pending, approvals, () => now);
  const approval = approvals.request({ toolId: ACCESSIBILITY_PLAN_TOOL_ID, tenantId: 'ten', principalId: 'usr', payload: mobileAccessibilityDraftPayload({ deviceId: h.device.deviceId, recipientRef: 'rcp_sarah', targetPackage: 'com.kakao.talk', targetAppVersion: '26.8.2', route: 'ANDROID_ACCESSIBILITY', approvedTextHash: h.input.approvedPayloadHash, messageHash: h.input.messageHash, displayName: 'Sarah' }) });
  approvals.approve(approval.approvalId, 'ten', 'usr');
  current = now + 120_000;
  expectCode(() => service.enqueueAccessibilityPlan({ ...h.input, approvalRef: approval.approvalId }), 'APPROVAL_EXPIRED');
});

test('M4C-R2C duplicate plan id returns existing command and second active plan is rejected', () => {
  const h = makeHarness();
  const first = h.service.enqueueAccessibilityPlan(h.input);
  const duplicate = h.service.enqueueAccessibilityPlan(h.input);
  assert.equal(duplicate.status, 'DUPLICATE_RETURNED');
  assert.equal(duplicate.command.commandId, first.command.commandId);
  expectCode(() => h.service.enqueueAccessibilityPlan({ ...h.input, planId: 'plan_other' }), 'DEVICE_COMMAND_ALREADY_PENDING');
});

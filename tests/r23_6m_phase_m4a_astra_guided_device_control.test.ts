import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashCanonicalPayload } from '../src/governance/action-approval.store.js';
import {
  AstraDeviceUIReasoner,
  DeviceUIActionGate,
  DeviceUIReasoningCoordinator,
  FakeDeviceUIReasoner,
  approvedMessageHash,
  containsSensitiveScreen,
  redactDeviceUIObservation,
  type DeviceUIActionProposal,
  type DeviceUIExecutionBudget,
  type DeviceUIObservation,
  type DeviceUIReasoningInput,
} from '../src/execution/device-ui-reasoner.js';
import { MobileAppAccessibilityExecutionService } from '../src/execution/mobile-app-accessibility-execution.js';
import { MobileExecutionAuthority } from '../src/execution/mobile-execution-authority.js';
import { DeviceIdentityStore } from '../src/device-agent/device-identity.store.js';
import { DeviceConnectionStatusStore } from '../src/device-agent/device-connection-status.store.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-m4a-')); }

function harness() {
  const devices = new DeviceIdentityStore({ dir: tmp() });
  const connections = new DeviceConnectionStatusStore({ dir: tmp() });
  const device = devices.enroll({ tenantId: 'ten', ownerId: 'usr', publicKey: 'pub', agentVersion: 'android-m4a', capabilityInventory: ['permission:ACCESSIBILITY_SERVICE:ENABLED'] });
  connections.markConnected(device.deviceId, 'ten', 'usr');
  const authority = new MobileExecutionAuthority(devices, connections);
  return { device, authority, accessibility: new MobileAppAccessibilityExecutionService(authority) };
}

function material(deviceId: string) {
  return {
    appId: 'KAKAOTALK',
    packageName: 'com.kakao.talk',
    recipientRef: 'rcp_sarah',
    displayName: 'Sarah',
    messageHash: approvedMessageHash('See you at 6.'),
    deviceId,
    executionRoute: 'ANDROID_ACCESSIBILITY',
  };
}

function approval(deviceId: string, patch: Record<string, unknown> = {}) {
  return {
    status: 'APPROVED',
    canonicalPayload: {
      capability: 'KAKAOTALK_ACCESSIBILITY_SEND',
      recipientRef: 'rcp_sarah',
      provider: 'KAKAOTALK',
      environment: 'ANDROID',
      executionRoute: 'ANDROID_ACCESSIBILITY',
      materialPayloadHash: hashCanonicalPayload(material(deviceId)),
      ...patch,
    },
  };
}

function plan(h = harness(), patch: Record<string, unknown> = {}) {
  return {
    tenantId: 'ten',
    principalId: 'usr',
    deviceId: h.device.deviceId,
    requestId: 'req_m4a',
    appId: 'KAKAOTALK',
    packageName: 'com.kakao.talk',
    detectedVersion: '10.x-certified-test-range',
    actions: ['OPEN_APP', 'OPEN_CHAT', 'SEARCH_CONTACT', 'SELECT_CONTACT', 'FOCUS_MESSAGE_BOX', 'TYPE_MESSAGE', 'REQUEST_SEND_APPROVAL', 'PRESS_SEND', 'OBSERVE_RESULT'],
    recipientRef: 'rcp_sarah',
    displayName: 'Sarah',
    approvedMessage: 'See you at 6.',
    typedMessage: 'See you at 6.',
    observedRecipientName: 'Sarah',
    recipientCandidateCount: 1,
    selectorContractPresent: true,
    approval: approval(h.device.deviceId),
    ...patch,
  } as Parameters<MobileAppAccessibilityExecutionService['prepare']>[0];
}

function observation(deviceId: string, patch: Partial<DeviceUIObservation> = {}): DeviceUIObservation {
  return {
    platform: 'ANDROID',
    deviceRef: deviceId,
    packageName: 'com.kakao.talk',
    appVersion: '10.x-certified-test-range',
    screenId: 'conversation',
    foregroundState: 'FOREGROUND',
    nodes: [
      { nodeRef: 'node_send', resourceId: 'send', role: 'Button', contentDescription: 'Send', clickable: true, editable: false, enabled: true },
      { nodeRef: 'node_input', resourceId: 'message', role: 'EditText', text: '', clickable: true, editable: true, enabled: true },
    ],
    availableSemanticActions: ['REQUEST_SEND', 'TYPE_APPROVED_TEXT', 'OBSERVE_RESULT'],
    executionStep: 'MESSAGE_TYPED',
    timestamp: '2026-10-07T00:00:00.000Z',
    screenshotAllowed: false,
    ...patch,
  };
}

function budget(patch: Partial<DeviceUIExecutionBudget> = {}): DeviceUIExecutionBudget {
  return { maxSteps: 10, maxClicks: 5, maxTextInputs: 1, maxScrolls: 2, maxReasonerCalls: 2, deadlineMs: 30_000, usedSteps: 0, usedClicks: 0, usedTextInputs: 0, usedScrolls: 0, usedReasonerCalls: 0, startedAtMs: Date.now(), ...patch };
}

function proposal(patch: Partial<DeviceUIActionProposal> = {}): DeviceUIActionProposal {
  return {
    provider: 'ASTRA',
    model: 'gpt-6-astra',
    action: 'REQUEST_SEND',
    targetNodeRef: 'node_send',
    semanticTarget: 'send button',
    expectedApp: 'com.kakao.talk',
    expectedScreen: 'conversation',
    confidence: 0.94,
    evidence: ['button contentDescription=Send'],
    executionStep: 'MESSAGE_TYPED',
    requiresApproval: true,
    reasonCode: 'SEMANTIC_MATCH',
    ...patch,
  };
}

function reasoningInput(h = harness(), patch: Partial<DeviceUIReasoningInput> = {}): DeviceUIReasoningInput {
  const p = plan(h);
  return {
    requestId: 'req_m4a',
    providerPreference: ['DETERMINISTIC', 'ASTRA'],
    observation: observation(h.device.deviceId),
    executionGoal: { appId: 'KAKAOTALK', packageName: 'com.kakao.talk', deviceId: h.device.deviceId, recipientRef: 'rcp_sarah', displayName: 'Sarah', approvedMessageHash: approvedMessageHash('See you at 6.'), route: 'ANDROID_ACCESSIBILITY', approvalId: 'appr_1' },
    allowedActions: ['REQUEST_SEND', 'TYPE_APPROVED_TEXT', 'OBSERVE_RESULT', 'WAIT'],
    currentPlan: p,
    budget: budget(),
    ...patch,
  };
}

test('M4A deterministic path succeeds without calling Astra', () => {
  const h = harness();
  const reasoner = new FakeDeviceUIReasoner([proposal()]);
  const result = h.accessibility.prepare(plan(h));
  assert.equal(result.resultCode, 'READY');
  assert.equal(reasoner.calls.length, 0);
});

test('M4A Astra recovery proposes one typed action and NAgex Action Gate authorizes it', async () => {
  const h = harness();
  const reasoner = new FakeDeviceUIReasoner([proposal()]);
  const coordinator = new DeviceUIReasoningCoordinator(reasoner);
  const result = await coordinator.recover(reasoningInput(h));
  assert.equal(reasoner.calls.length, 1);
  assert.equal(result.decision, 'AUTHORIZED_ACTION');
  assert.equal(result.authorizedAction, 'PRESS_SEND');
  assert.equal(result.proposal?.provider, 'ASTRA');
});

test('M4A malformed/unknown/low-confidence proposals and unavailable Astra fail closed', async () => {
  const h = harness();
  const gate = new DeviceUIActionGate();
  assert.equal(gate.validate(reasoningInput(h), { action: 'CLICK_COORDINATE' }).decision, 'REASONER_OUTPUT_INVALID');
  assert.equal(gate.validate(reasoningInput(h), proposal({ action: 'SCROLL_BOUNDED' })).decision, 'BLOCKED');
  assert.equal(gate.validate(reasoningInput(h), proposal({ confidence: 0.2 })).reasonCode, 'LOW_CONFIDENCE');
  const unavailable = new DeviceUIReasoningCoordinator(new AstraDeviceUIReasoner());
  const result = await unavailable.recover(reasoningInput(h));
  assert.equal(result.decision, 'BLOCKED');
  assert.equal(result.reasonCode, 'PROVIDER_NOT_CONFIGURED');
});

test('M4A Action Gate blocks app, recipient, message, device, route, approval, and send-boundary drift', () => {
  const h = harness();
  const gate = new DeviceUIActionGate();
  assert.equal(gate.validate(reasoningInput(h, { observation: observation(h.device.deviceId, { packageName: 'evil.package' }) }), proposal()).reasonCode, 'WRONG_PACKAGE');
  assert.equal(gate.validate(reasoningInput(h, { currentPlan: plan(h, { observedRecipientName: 'Sam' }) }), proposal()).reasonCode, 'RECIPIENT_CHANGED_AFTER_APPROVAL');
  assert.equal(gate.validate(reasoningInput(h, { currentPlan: plan(h, { typedMessage: 'Changed text' }) }), proposal()).reasonCode, 'MESSAGE_CHANGED_AFTER_APPROVAL');
  assert.equal(gate.validate(reasoningInput(h, { observation: observation('other_device') }), proposal()).reasonCode, 'DEVICE_CHANGED_AFTER_APPROVAL');
  assert.equal(gate.validate(reasoningInput(h, { currentPlan: plan(h, { approval: approval(h.device.deviceId, { executionRoute: 'APP_LINK' }) }) }), proposal()).reasonCode, 'ROUTE_CHANGED_AFTER_APPROVAL');
  assert.equal(gate.validate(reasoningInput(h, { currentPlan: plan(h, { approval: null }) }), proposal()).reasonCode, 'APPROVAL_MISSING');
  assert.equal(gate.validate(reasoningInput(h, { currentPlan: plan(h, { approval: approval(h.device.deviceId, { materialPayloadHash: 'wrong' }) }) }), proposal()).reasonCode, 'SEND_BOUNDARY_REVALIDATION_FAILED');
});

test('M4A execution budget, timeout, scroll budget, and user override block execution', () => {
  const h = harness();
  const gate = new DeviceUIActionGate();
  assert.equal(gate.validate(reasoningInput(h, { budget: budget({ usedReasonerCalls: 2 }) }), proposal()).decision, 'EXECUTION_BUDGET_EXCEEDED');
  assert.equal(gate.validate(reasoningInput(h, { budget: budget({ startedAtMs: Date.now() - 60_000, deadlineMs: 1 }) }), proposal()).decision, 'EXECUTION_BUDGET_EXCEEDED');
  assert.equal(gate.validate(reasoningInput(h, { budget: budget({ usedScrolls: 2 }) }), proposal({ action: 'SCROLL_BOUNDED' })).decision, 'EXECUTION_BUDGET_EXCEEDED');
  assert.equal(gate.validate(reasoningInput(h, { currentPlan: plan(h, { userInterrupted: true }) }), proposal()).decision, 'USER_INTERRUPTED');
});

test('M4A observation redaction, screenshot default, and sensitive screens block reasoning', () => {
  const h = harness();
  const obs = observation(h.device.deviceId, {
    screenshotRef: 'screen_1',
    screenshotAllowed: false,
    nodes: [{ nodeRef: 'otp', resourceId: 'otp_code', role: 'EditText', text: '123456', clickable: true, editable: true, enabled: true }],
  });
  const redacted = redactDeviceUIObservation(obs);
  assert.equal(redacted.screenshotRef, undefined);
  assert.equal(redacted.nodes[0]?.text, '[REDACTED]');
  assert.equal(containsSensitiveScreen(obs), true);
  const gate = new DeviceUIActionGate();
  assert.equal(gate.validate(reasoningInput(h, { observation: obs }), proposal()).reasonCode, 'SENSITIVE_SCREEN_REASONING_BLOCKED');
});

test('M4A Astra implementation is provider-neutral, schema-bound, and cannot self-approve or execute', async () => {
  const h = harness();
  const astra = new AstraDeviceUIReasoner({ apiKey: 'sk-test', proposeFn: async (input) => {
    assert.equal(input.observation.screenshotRef, undefined);
    return proposal({ provider: 'ASTRA', confidence: 1 });
  } });
  assert.equal(astra.status().configured, true);
  const p = await astra.reason(reasoningInput(h));
  assert.equal(p.action, 'REQUEST_SEND');
  const gate = new DeviceUIActionGate();
  assert.equal(gate.validate(reasoningInput(h, { currentPlan: plan(h, { approval: null }) }), p).decision, 'PERMISSION_REQUIRED');
});

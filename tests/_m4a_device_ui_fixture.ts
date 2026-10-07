import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hashCanonicalPayload } from '../src/governance/action-approval.store.js';
import { DeviceConnectionStatusStore } from '../src/device-agent/device-connection-status.store.js';
import { DeviceIdentityStore } from '../src/device-agent/device-identity.store.js';
import { MobileAppAccessibilityExecutionService } from '../src/execution/mobile-app-accessibility-execution.js';
import { MobileExecutionAuthority } from '../src/execution/mobile-execution-authority.js';
import { approvedMessageHash, type DeviceUIActionProposal, type DeviceUIExecutionBudget, type DeviceUIObservation, type DeviceUIReasoningInput } from '../src/execution/device-ui-reasoner.js';

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-m4b-')); }

export function harness() {
  const devices = new DeviceIdentityStore({ dir: tmp() });
  const connections = new DeviceConnectionStatusStore({ dir: tmp() });
  const device = devices.enroll({ tenantId: 'ten', ownerId: 'usr', publicKey: 'pub', agentVersion: 'android-m4b', capabilityInventory: ['permission:ACCESSIBILITY_SERVICE:ENABLED'] });
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

function approval(deviceId: string) {
  return {
    status: 'APPROVED',
    canonicalPayload: {
      capability: 'KAKAOTALK_ACCESSIBILITY_SEND',
      recipientRef: 'rcp_sarah',
      provider: 'KAKAOTALK',
      environment: 'ANDROID',
      executionRoute: 'ANDROID_ACCESSIBILITY',
      materialPayloadHash: hashCanonicalPayload(material(deviceId)),
    },
  };
}

export function plan(h = harness(), patch: Record<string, unknown> = {}) {
  return {
    tenantId: 'ten',
    principalId: 'usr',
    deviceId: h.device.deviceId,
    requestId: 'req_m4b',
    appId: 'KAKAOTALK',
    packageName: 'com.kakao.talk',
    detectedVersion: '26.8.2',
    actions: ['OPEN_APP', 'OPEN_CHAT', 'SEARCH_CONTACT', 'SELECT_CONTACT', 'FOCUS_MESSAGE_BOX', 'TYPE_MESSAGE', 'REQUEST_SEND_APPROVAL', 'OBSERVE_RESULT'],
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

export function observation(deviceId: string, patch: Partial<DeviceUIObservation> = {}): DeviceUIObservation {
  return {
    platform: 'ANDROID',
    deviceRef: deviceId,
    packageName: 'com.kakao.talk',
    appVersion: '26.8.2',
    screenId: 'conversation',
    foregroundState: 'FOREGROUND',
    nodes: [
      { nodeRef: 'node_send', resourceId: 'send', role: 'Button', contentDescription: 'Send', clickable: true, editable: false, enabled: true },
      { nodeRef: 'node_search', resourceId: 'search', role: 'Button', contentDescription: 'Search', clickable: true, editable: false, enabled: true },
    ],
    availableSemanticActions: ['FIND_ELEMENT', 'TYPE_APPROVED_TEXT', 'OBSERVE_RESULT'],
    executionStep: 'MESSAGE_TYPED',
    timestamp: '2026-10-07T00:00:00.000Z',
    screenshotAllowed: false,
    ...patch,
  };
}

function budget(patch: Partial<DeviceUIExecutionBudget> = {}): DeviceUIExecutionBudget {
  return { maxSteps: 10, maxClicks: 5, maxTextInputs: 1, maxScrolls: 2, maxReasonerCalls: 3, deadlineMs: 30_000, usedSteps: 0, usedClicks: 0, usedTextInputs: 0, usedScrolls: 0, usedReasonerCalls: 0, startedAtMs: Date.now(), ...patch };
}

export function proposal(patch: Partial<DeviceUIActionProposal> = {}): DeviceUIActionProposal {
  return {
    provider: 'ASTRA',
    model: 'gpt-6-astra',
    action: 'FIND_ELEMENT',
    targetNodeRef: 'node_search',
    semanticTarget: 'search',
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

export function reasoningInput(h = harness(), patch: Partial<DeviceUIReasoningInput> = {}): DeviceUIReasoningInput {
  return {
    requestId: 'req_m4b',
    providerPreference: ['DETERMINISTIC', 'ASTRA'],
    observation: observation(h.device.deviceId),
    executionGoal: { appId: 'KAKAOTALK', packageName: 'com.kakao.talk', deviceId: h.device.deviceId, recipientRef: 'rcp_sarah', displayName: 'Sarah', approvedMessageHash: approvedMessageHash('See you at 6.'), route: 'ANDROID_ACCESSIBILITY', approvalId: 'appr_1' },
    allowedActions: ['FIND_ELEMENT', 'TYPE_APPROVED_TEXT', 'OBSERVE_RESULT', 'WAIT'],
    currentPlan: plan(h),
    budget: budget(),
    ...patch,
  };
}

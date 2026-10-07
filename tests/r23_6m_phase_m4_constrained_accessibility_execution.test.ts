import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NagexError } from '../src/common/errors.js';
import { DeviceConnectionStatusStore } from '../src/device-agent/device-connection-status.store.js';
import { DeviceIdentityStore } from '../src/device-agent/device-identity.store.js';
import { hashCanonicalPayload } from '../src/governance/action-approval.store.js';
import { MobileAppAccessibilityExecutionService, MOBILE_APP_EXECUTION_POLICIES, MOBILE_APP_ADAPTERS, ACCESSIBILITY_ROUTE_PREFERENCE } from '../src/execution/mobile-app-accessibility-execution.js';
import { MobileExecutionAuthority, SUPPORTED_M4_ROUTES } from '../src/execution/mobile-execution-authority.js';

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-m4-accessibility-')); }

function harness(inventory = ['permission:ACCESSIBILITY_SERVICE:ENABLED']) {
  const devices = new DeviceIdentityStore({ dir: tmp() });
  const connections = new DeviceConnectionStatusStore({ dir: tmp() });
  const device = devices.enroll({ tenantId: 'ten', ownerId: 'usr', publicKey: 'pub', agentVersion: 'android-m4', capabilityInventory: inventory });
  connections.markConnected(device.deviceId, 'ten', 'usr');
  const authority = new MobileExecutionAuthority(devices, connections);
  return { devices, connections, device, authority, accessibility: new MobileAppAccessibilityExecutionService(authority) };
}

function approval(deviceId: string, patch: Record<string, unknown> = {}) {
  const payload = {
    appId: 'KAKAOTALK',
    packageName: 'com.kakao.talk',
    recipientRef: 'rcp_sarah',
    displayName: 'Sarah',
    messageHash: hashCanonicalPayload({ message: 'See you at 6.' }),
    deviceId,
    executionRoute: 'ANDROID_ACCESSIBILITY',
  };
  return {
    status: 'APPROVED',
    canonicalPayload: {
      capability: 'KAKAOTALK_ACCESSIBILITY_SEND',
      recipientRef: 'rcp_sarah',
      provider: 'KAKAOTALK',
      environment: 'ANDROID',
      executionRoute: 'ANDROID_ACCESSIBILITY',
      materialPayloadHash: hashCanonicalPayload(payload),
      ...patch,
    },
  };
}

function plan(h = harness(), patch: Record<string, unknown> = {}) {
  return {
    tenantId: 'ten',
    principalId: 'usr',
    deviceId: h.device.deviceId,
    requestId: 'req_m4',
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

function code(fn: () => unknown): string {
  try {
    fn();
    return 'NO_THROW';
  } catch (e) {
    assert.ok(e instanceof NagexError);
    return e.code;
  }
}

test('M4 route and policy expose accessibility as constrained fallback only', () => {
  assert.deepEqual([...SUPPORTED_M4_ROUTES], ['PROVIDER_API', 'ANDROID_NATIVE', 'APP_LINK', 'BROWSER', 'ANDROID_ACCESSIBILITY', 'HUMAN_HANDOFF']);
  assert.deepEqual([...ACCESSIBILITY_ROUTE_PREFERENCE], ['PROVIDER_API', 'ANDROID_NATIVE', 'APP_LINK', 'BROWSER', 'ANDROID_ACCESSIBILITY', 'HUMAN_HANDOFF']);
  const kakao = MOBILE_APP_EXECUTION_POLICIES.find((item) => item.appId === 'KAKAOTALK');
  assert.equal(MOBILE_APP_ADAPTERS.map((adapter) => adapter.policy.appId).join(','), 'KAKAOTALK');
  assert.equal(kakao?.certificationStatus, 'CERTIFIED');
  assert.equal(kakao?.recipientEnforcement, 'STRICT');
  assert.equal(kakao?.requiresForeground, true);
  assert.equal(kakao?.requiresUserPresence, true);
  for (const appId of ['WHATSAPP', 'INSTAGRAM', 'MESSENGER']) {
    assert.equal(MOBILE_APP_EXECUTION_POLICIES.find((item) => item.appId === appId)?.certificationStatus, 'NOT_CERTIFIED');
  }
});

test('M4 accessibility disabled/enabled, wrong device, offline, cross-tenant/user, and approval missing fail closed', () => {
  const disabled = harness(['permission:ACCESSIBILITY_SERVICE:DISABLED']);
  assert.equal(disabled.authority.evaluate({
    tenantId: 'ten', principalId: 'usr', requestId: 'req_disabled', capability: 'KAKAOTALK_ACCESSIBILITY_SEND', canonicalAction: 'SEND_MESSAGE',
    targetRef: 'rcp_sarah', provider: 'KAKAOTALK', executionEnvironment: 'ANDROID', executionRoute: 'ANDROID_ACCESSIBILITY', deviceId: disabled.device.deviceId,
    approval: approval(disabled.device.deviceId),
  }).disposition, 'PERMISSION_REQUIRED');

  const h = harness();
  assert.equal(h.accessibility.prepare(plan(h)).canonical.confirmationStrength, 'MEDIUM');
  assert.equal(code(() => h.accessibility.prepare(plan(h, { deviceId: 'other_device' }))), 'BLOCKED');
  h.connections.markDisconnected(h.device.deviceId, 'ten', 'usr');
  assert.equal(code(() => h.accessibility.prepare(plan(h))), 'BLOCKED');
  const h2 = harness();
  assert.equal(code(() => h2.accessibility.prepare(plan(h2, { tenantId: 'other' }))), 'BLOCKED');
  assert.equal(code(() => h2.accessibility.prepare(plan(h2, { principalId: 'other' }))), 'BLOCKED');
  assert.equal(code(() => h2.accessibility.prepare(plan(h2, { approval: null }))), 'APPROVAL_REQUIRED');
});

test('M4 app/action/version/recipient/message/UI/timeout/user-interrupt validation is fail closed', () => {
  const h = harness();
  assert.equal(code(() => h.accessibility.prepare(plan(h, { appId: 'WHATSAPP', packageName: 'com.whatsapp', detectedVersion: 'NOT_CERTIFIED' }))), 'APP_VERSION_UNSUPPORTED');
  assert.equal(code(() => h.accessibility.prepare(plan(h, { packageName: 'evil.package' }))), 'APP_NOT_ALLOWLISTED');
  assert.equal(code(() => h.accessibility.prepare(plan(h, { detectedVersion: '11.0' }))), 'APP_VERSION_UNSUPPORTED');
  assert.equal(code(() => h.accessibility.prepare(plan(h, { actions: ['CLICK_ANYTHING'] }))), 'ACTION_NOT_ALLOWLISTED');
  assert.equal(code(() => h.accessibility.prepare(plan(h, { recipientCandidateCount: 2 }))), 'RECIPIENT_AMBIGUOUS');
  assert.equal(code(() => h.accessibility.prepare(plan(h, { observedRecipientName: 'Sam' }))), 'RECIPIENT_MISMATCH');
  assert.equal(code(() => h.accessibility.prepare(plan(h, { typedMessage: 'Changed text' }))), 'MESSAGE_PAYLOAD_MISMATCH');
  assert.equal(code(() => h.accessibility.prepare(plan(h, { selectorContractPresent: false }))), 'UI_CONTRACT_MISMATCH');
  assert.equal(code(() => h.accessibility.prepare(plan(h, { userInterrupted: true }))), 'USER_INTERRUPTED');
  assert.equal(code(() => h.accessibility.prepare(plan(h, { timedOutStep: 'SEARCH_CONTACT' }))), 'EXECUTION_TIMEOUT');
});

test('M4 approval binding rejects route, recipient, and payload drift; voice/mobile cannot bypass approval', () => {
  const h = harness();
  assert.equal(code(() => h.accessibility.prepare(plan(h, { approval: approval(h.device.deviceId, { executionRoute: 'APP_LINK' }) }))), 'REAPPROVAL_REQUIRED');
  assert.equal(code(() => h.accessibility.prepare(plan(h, { approval: approval(h.device.deviceId, { recipientRef: 'rcp_other' }) }))), 'REAPPROVAL_REQUIRED');
  assert.equal(code(() => h.accessibility.prepare(plan(h, { approval: approval(h.device.deviceId, { materialPayloadHash: 'wrong' }) }))), 'REAPPROVAL_REQUIRED');
  assert.equal(code(() => h.accessibility.prepare(plan(h, { approval: null }))), 'APPROVAL_REQUIRED');
});

test('M4 command is bounded and never generic UI automation', () => {
  const h = harness();
  const result = h.accessibility.prepare(plan(h));
  assert.equal(result.command?.commandType, 'ACCESSIBILITY_EXECUTE_PLAN');
  assert.equal(result.command?.data.requiresForeground, true);
  assert.equal(result.command?.data.requiresUserPresence, true);
  assert.deepEqual(result.command?.data.selectorStrategy, ['resource-id', 'contentDescription', 'semantic role/class', 'text label', 'relative hierarchy']);
  assert.equal(result.command?.data.messageHash, hashCanonicalPayload({ message: 'See you at 6.' }));
  assert.equal(result.state, 'PLANNED');
  assert.notEqual(result.canonical.status, 'EXECUTED_CONFIRMED');
});

test('M4 Android source exposes a user-enabled, package-scoped service without coordinate-only automation', () => {
  const manifest = fs.readFileSync('mobile-android/app/src/main/AndroidManifest.xml', 'utf8');
  const service = fs.readFileSync('mobile-android/app/src/main/java/com/nagex/mobile/NagexAccessibilityExecutionService.kt', 'utf8');
  const xml = fs.readFileSync('mobile-android/app/src/main/res/xml/nagex_accessibility_service.xml', 'utf8');
  assert.match(manifest, /android\.permission\.BIND_ACCESSIBILITY_SERVICE/);
  assert.match(xml, /android:packageNames="com\.kakao\.talk"/);
  assert.match(xml, /android:canPerformGestures="false"/);
  assert.doesNotMatch(service, /dispatchGesture|GestureDescription|absolute|coordinate|CLICK_ANYTHING|TYPE_ANYTHING|SCROLL_ANYWHERE/i);
  assert.match(service, /TYPE_TOUCH_INTERACTION_START/);
});

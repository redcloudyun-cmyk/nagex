import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ActionApprovalStore } from '../src/governance/action-approval.store.js';
import { DeviceConnectionStatusStore } from '../src/device-agent/device-connection-status.store.js';
import { DeviceIdentityStore, type DeviceIdentityRecord } from '../src/device-agent/device-identity.store.js';
import { MobileExecutionAuthority, buildAndroidCapabilityReport, SUPPORTED_M2_CAPABILITIES, SUPPORTED_M2_ROUTES, type DeviceCapabilityKind, type RouteAuthorityRequest } from '../src/execution/mobile-execution-authority.js';
import { MobileMessageRunService } from '../src/mobile/mobile-message-run.service.js';
import { MobileMessageRunStore } from '../src/mobile/mobile-message-run.store.js';
import { RecipientRefStore } from '../src/mobile/recipient-ref.store.js';
import { NagexError } from '../src/common/errors.js';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-m2-authority-'));
}

function deviceHarness(inventory: string[] = ['permission:SEND_SMS:GRANTED', 'permission:READ_CONTACTS:GRANTED', 'permission:RECORD_AUDIO:GRANTED', 'permission:POST_NOTIFICATIONS:GRANTED']) {
  const devices = new DeviceIdentityStore({ dir: tmp() });
  const connections = new DeviceConnectionStatusStore({ dir: tmp() });
  const device = devices.enroll({ tenantId: 'ten', ownerId: 'usr', publicKey: 'pub', agentVersion: 'android-test', capabilityInventory: inventory });
  connections.markConnected(device.deviceId, 'ten', 'usr');
  const authority = new MobileExecutionAuthority(devices, connections);
  return { devices, connections, device, authority };
}

function approvedSmsRequest(_authority: MobileExecutionAuthority, device: DeviceIdentityRecord, approval: { status: string; canonicalPayload: Record<string, unknown> } = { status: 'APPROVED', canonicalPayload: { canonicalAction: 'SEND_MESSAGE', recipientRef: 'rcp_1', provider: 'DEVICE_NATIVE', environment: 'ANDROID', executionRoute: 'ANDROID_SMS_MANAGER', capability: 'SMS_SEND' } }): RouteAuthorityRequest {
  return {
    tenantId: 'ten',
    principalId: 'usr',
    requestId: 'req',
    capability: 'SMS_SEND',
    canonicalAction: 'SEND_MESSAGE',
    targetRef: 'rcp_1',
    provider: 'DEVICE_NATIVE',
    executionEnvironment: 'ANDROID',
    executionRoute: 'ANDROID_SMS_MANAGER',
    deviceId: device.deviceId,
    approval,
  };
}

test('M2 model exposes supported as-built capabilities and routes only', () => {
  assert.deepEqual([...SUPPORTED_M2_ROUTES], ['PROVIDER_API', 'ANDROID_NATIVE', 'APP_LINK', 'BROWSER', 'HUMAN_HANDOFF']);
  assert.ok(SUPPORTED_M2_CAPABILITIES.includes('SMS_SEND'));
  assert.ok(SUPPORTED_M2_CAPABILITIES.includes('KAKAOTALK_HANDOFF'));
  assert.equal(SUPPORTED_M2_CAPABILITIES.includes('PHONE_CALL'), false);
  assert.equal(SUPPORTED_M2_CAPABILITIES.includes('PAYMENT'), false);
});

test('M2 1/8/13. supported SMS + granted permission + valid approval allows Android native route', () => {
  const { authority, device } = deviceHarness();
  const result = authority.evaluate(approvedSmsRequest(authority, device));
  assert.equal(result.disposition, 'ALLOW');
  assert.equal(result.selectedRoute, 'ANDROID_NATIVE');
  assert.equal(result.confirmationStrength, 'DEVICE_SEND_CALLBACK');
});

test('M2 2. denied Android SMS permission requires permission and never falls through', () => {
  const { authority, device } = deviceHarness(['permission:SEND_SMS:DENIED']);
  const result = authority.evaluate(approvedSmsRequest(authority, device));
  assert.equal(result.disposition, 'PERMISSION_REQUIRED');
  assert.deepEqual(result.reasonCodes, ['PERMISSION_NOT_GRANTED']);
  assert.equal(result.selectedRoute, null);
});

test('M2 3. revoked Android SMS permission rejects stale grant', () => {
  const { authority, device } = deviceHarness(['permission:SEND_SMS:REVOKED']);
  const result = authority.evaluate(approvedSmsRequest(authority, device));
  assert.equal(result.disposition, 'PERMISSION_REQUIRED');
  assert.ok(result.reasonCodes.includes('STALE_PERMISSION_GRANT'));
});

test('M2 4/20. device offline blocks native SMS and reports no approval bypass', () => {
  const { authority, device, connections } = deviceHarness();
  connections.markDisconnected(device.deviceId, 'ten', 'usr');
  const result = authority.evaluate(approvedSmsRequest(authority, device));
  assert.equal(result.disposition, 'BLOCKED');
  assert.ok(result.reasonCodes.includes('DEVICE_UNAVAILABLE'));
});

test('M2 5. unsupported capabilities are explicit unsupported, not unavailable', () => {
  const { authority, device } = deviceHarness();
  const result = authority.evaluate({ ...approvedSmsRequest(authority, device), capability: 'PHONE_CALL', executionRoute: 'ANDROID_CALL_INTENT' });
  assert.equal(result.disposition, 'UNSUPPORTED');
  assert.deepEqual(result.reasonCodes, ['CAPABILITY_UNSUPPORTED']);
});

test('M2 6/14/15. provider API routes fail closed when provider is disconnected', () => {
  const { authority } = deviceHarness();
  for (const capability of ['GMAIL_SEND', 'CALENDAR_WRITE'] as DeviceCapabilityKind[]) {
    const result = authority.evaluate({
      tenantId: 'ten',
      principalId: 'usr',
      requestId: `req_${capability}`,
      capability,
      canonicalAction: capability === 'GMAIL_SEND' ? 'SEND_EMAIL' : 'CREATE_EVENT',
      targetRef: capability === 'GMAIL_SEND' ? 'user@example.com' : 'evt_target',
      provider: capability === 'GMAIL_SEND' ? 'GOOGLE_GMAIL' : 'GOOGLE_CALENDAR',
      executionEnvironment: 'SERVER',
      executionRoute: 'PROVIDER_API',
      approval: { status: 'APPROVED', canonicalPayload: { executionRoute: 'PROVIDER_API', provider: capability === 'GMAIL_SEND' ? 'GOOGLE_GMAIL' : 'GOOGLE_CALENDAR', targetRef: capability === 'GMAIL_SEND' ? 'user@example.com' : 'evt_target' } },
      providerConnected: false,
    });
    assert.equal(result.disposition, 'BLOCKED');
    assert.ok(result.reasonCodes.includes('PROVIDER_DISCONNECTED'));
  }
});

test('M2 7. missing approval returns approval required', () => {
  const { authority, device } = deviceHarness();
  const result = authority.evaluate({ ...approvedSmsRequest(authority, device), approval: null });
  assert.equal(result.disposition, 'APPROVAL_REQUIRED');
  assert.ok(result.reasonCodes.includes('APPROVAL_MISSING'));
});

test('M2 9/10/11. route, account, recipient and payload drift require reapproval', () => {
  const { authority, device } = deviceHarness();
  const base = approvedSmsRequest(authority, device, { status: 'APPROVED', canonicalPayload: { targetRef: 'rcp_1', accountRef: 'acct_1', executionRoute: 'ANDROID_SMS_MANAGER', provider: 'DEVICE_NATIVE', environment: 'ANDROID', capability: 'SMS_SEND', materialPayloadHash: 'old' } });
  const cases: Array<[Partial<RouteAuthorityRequest>, string]> = [
    [{ executionRoute: 'KAKAOTALK_SHARE' }, 'ROUTE_CHANGED_AFTER_APPROVAL'],
    [{ accountRef: 'acct_2' }, 'ACCOUNT_CHANGED_AFTER_APPROVAL'],
    [{ targetRef: 'rcp_2' }, 'TARGET_CHANGED_AFTER_APPROVAL'],
    [{ materialPayload: { message: 'new' } }, 'PAYLOAD_CHANGED_AFTER_APPROVAL'],
  ];
  for (const [patch, reason] of cases) {
    const result = authority.evaluate({ ...base, ...patch });
    assert.equal(result.disposition, 'REAPPROVAL_REQUIRED');
    assert.ok(result.reasonCodes.includes(reason as any), reason);
  }
});

test('M2 12/19. KakaoTalk is represented as manual handoff only', () => {
  const { authority, device } = deviceHarness();
  const result = authority.evaluate({
    tenantId: 'ten',
    principalId: 'usr',
    requestId: 'req_kakao',
    capability: 'KAKAOTALK_HANDOFF',
    canonicalAction: 'SEND_MESSAGE',
    targetRef: 'rcp_1',
    provider: 'KAKAOTALK',
    executionEnvironment: 'ANDROID',
    executionRoute: 'KAKAOTALK_SHARE',
    deviceId: device.deviceId,
    approval: { status: 'APPROVED', canonicalPayload: { targetRef: 'rcp_1', provider: 'KAKAOTALK', environment: 'ANDROID', executionRoute: 'KAKAOTALK_SHARE', capability: 'KAKAOTALK_HANDOFF' } },
  });
  assert.equal(result.disposition, 'ALLOW');
  assert.equal(result.selectedRoute, 'HUMAN_HANDOFF');
  assert.ok(result.reasonCodes.includes('MANUAL_HANDOFF_ONLY'));
});

test('M2 16. browser consequential route remains browser approval scoped', () => {
  const { authority } = deviceHarness();
  const result = authority.evaluate({
    tenantId: 'ten',
    principalId: 'usr',
    requestId: 'req_browser',
    capability: 'BROWSER_EXECUTION',
    canonicalAction: 'BROWSER_MUTATE',
    targetRef: 'selector:#buy',
    provider: 'BROWSER',
    executionEnvironment: 'BROWSER',
    executionRoute: 'BROWSER',
    providerConnected: true,
    approval: { status: 'APPROVED', canonicalPayload: { targetRef: 'selector:#buy', provider: 'BROWSER', environment: 'BROWSER', executionRoute: 'BROWSER', capability: 'BROWSER_EXECUTION' } },
  });
  assert.equal(result.disposition, 'ALLOW');
  assert.equal(result.selectedRoute, 'BROWSER');
});

test('M2 17/18. Telegram and Slack require ownership-proven self delivery', () => {
  const { authority } = deviceHarness();
  for (const capability of ['TELEGRAM_SELF_DELIVERY', 'SLACK_SELF_DELIVERY'] as DeviceCapabilityKind[]) {
    const blocked = authority.evaluate({ tenantId: 'ten', principalId: 'usr', requestId: `req_${capability}`, capability, canonicalAction: 'SEND_MESSAGE', targetRef: 'self', provider: capability.split('_')[0], executionEnvironment: 'SERVER', executionRoute: 'PROVIDER_API', providerConnected: true, channelOwnershipVerified: false, approval: { status: 'APPROVED', canonicalPayload: { targetRef: 'self', executionRoute: 'PROVIDER_API' } } });
    assert.equal(blocked.disposition, 'BLOCKED');
    assert.ok(blocked.reasonCodes.includes('RECIPIENT_UNENFORCEABLE'));
    const allowed = authority.evaluate({ ...blockedCandidate(capability), channelOwnershipVerified: true });
    assert.equal(allowed.disposition, 'ALLOW');
  }
});

function blockedCandidate(capability: DeviceCapabilityKind): RouteAuthorityRequest {
  return { tenantId: 'ten', principalId: 'usr', requestId: `req_ok_${capability}`, capability, canonicalAction: 'SEND_MESSAGE', targetRef: 'self', provider: capability.split('_')[0], executionEnvironment: 'SERVER', executionRoute: 'PROVIDER_API', providerConnected: true, approval: { status: 'APPROVED', canonicalPayload: { targetRef: 'self', executionRoute: 'PROVIDER_API' } } };
}

test('M2 19. Android capability report contains safe metadata only', () => {
  const { device, connections } = deviceHarness();
  const report = buildAndroidCapabilityReport({ device, connection: connections.getStatus(device.deviceId, 'ten', 'usr') });
  assert.equal(report.platform, 'ANDROID');
  assert.equal(report.deviceId, device.deviceId);
  assert.ok(report.supportedCapabilities.includes('SMS_SEND'));
  assert.equal(JSON.stringify(report).includes('phoneNumber'), false);
  assert.equal(JSON.stringify(report).includes('session'), false);
});

test('M2 22/26. forged, cross-tenant and cross-user device claims are rejected', () => {
  const { authority, device } = deviceHarness();
  for (const patch of [{ deviceId: 'dev_forged' }, { tenantId: 'ten_other' }, { principalId: 'usr_other' }]) {
    const result = authority.evaluate({ ...approvedSmsRequest(authority, device), ...patch });
    assert.equal(result.disposition, 'BLOCKED');
    assert.ok(result.reasonCodes.includes('DEVICE_UNAVAILABLE'));
  }
});

test('M2 SMS regression. MobileMessageRunService consults authority before consuming approval', () => {
  const devices = new DeviceIdentityStore({ dir: tmp() });
  const connections = new DeviceConnectionStatusStore({ dir: tmp() });
  const device = devices.enroll({ tenantId: 'ten', ownerId: 'usr', publicKey: 'pub', agentVersion: 'android-test', capabilityInventory: ['permission:SEND_SMS:GRANTED'] });
  connections.markConnected(device.deviceId, 'ten', 'usr');
  const authority = new MobileExecutionAuthority(devices, connections);
  const recipients = new RecipientRefStore({ dir: tmp() });
  const ref = recipients.mintOrReuse({ tenantId: 'ten', ownerId: 'usr', deviceId: device.deviceId, androidContactId: 'contact', displayName: 'Alex' });
  const approvals = new ActionApprovalStore();
  const service = new MobileMessageRunService(new MobileMessageRunStore({ dir: tmp() }), recipients, approvals, undefined, authority);

  let run = service.createDraft({ tenantId: 'ten', ownerId: 'usr', deviceId: device.deviceId, requestId: 'req_1', recipientRef: ref.recipientRef, message: 'hello' });
  run = service.requestApproval(run.runId, 'ten', 'usr', 'req_2');
  approvals.approve(run.approvalId!, 'ten', 'usr', 'req_3');
  run = service.confirmApproval(run.runId, 'ten', 'usr', 'req_4');
  run = service.executeApproved(run.runId, 'ten', 'usr', device.deviceId, 'req_5');
  assert.equal(run.status, 'SEND_ATTEMPTED');

  const deniedDevice = devices.updateCapabilityInventory(device.deviceId, 'ten', 'usr', ['permission:SEND_SMS:DENIED'])!;
  const run2 = service.createDraft({ tenantId: 'ten', ownerId: 'usr', deviceId: deniedDevice.deviceId, requestId: 'req_6', recipientRef: ref.recipientRef, message: 'blocked' });
  const pending = service.requestApproval(run2.runId, 'ten', 'usr', 'req_7');
  approvals.approve(pending.approvalId!, 'ten', 'usr', 'req_8');
  const approved = service.confirmApproval(pending.runId, 'ten', 'usr', 'req_9');
  assert.throws(
    () => service.executeApproved(approved.runId, 'ten', 'usr', deniedDevice.deviceId, 'req_10'),
    (error: unknown) => error instanceof NagexError && error.code === 'PERMISSION_REQUIRED',
  );
  assert.equal(approvals.get(approved.approvalId!, 'ten', 'usr')?.status, 'APPROVED');
});

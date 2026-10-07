import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ActionApprovalStore } from '../src/governance/action-approval.store.js';
import { DeviceConnectionStatusStore } from '../src/device-agent/device-connection-status.store.js';
import { DeviceIdentityStore } from '../src/device-agent/device-identity.store.js';
import { AppLinkExecutionService } from '../src/execution/app-link-execution.js';
import { MobileExecutionAuthority, type DeviceCapabilityKind, type RouteAuthorityRequest } from '../src/execution/mobile-execution-authority.js';
import { NagexError } from '../src/common/errors.js';

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-m3-routes-')); }

function harness(inventory = ['permission:SEND_SMS:GRANTED', 'permission:READ_CONTACTS:GRANTED', 'permission:RECORD_AUDIO:GRANTED', 'permission:POST_NOTIFICATIONS:GRANTED']) {
  const devices = new DeviceIdentityStore({ dir: tmp() });
  const connections = new DeviceConnectionStatusStore({ dir: tmp() });
  const device = devices.enroll({ tenantId: 'ten', ownerId: 'usr', publicKey: 'pub', agentVersion: 'android-m3', capabilityInventory: inventory });
  connections.markConnected(device.deviceId, 'ten', 'usr');
  const authority = new MobileExecutionAuthority(devices, connections);
  return { devices, connections, device, authority, appLinks: new AppLinkExecutionService(authority) };
}

function approved(capability: DeviceCapabilityKind, route: string, targetRef = 'target', provider = 'TEST'): { status: string; canonicalPayload: Record<string, unknown> } {
  const environment = route === 'BROWSER' ? 'BROWSER' : route === 'ANDROID_SMS_MANAGER' || route === 'APP_LINK' ? 'ANDROID' : 'SERVER';
  return { status: 'APPROVED', canonicalPayload: { capability, executionRoute: route, targetRef, provider, environment } };
}

function request(capability: DeviceCapabilityKind, route: string, patch: Partial<RouteAuthorityRequest> = {}): RouteAuthorityRequest {
  return {
    tenantId: 'ten',
    principalId: 'usr',
    requestId: `req_${capability}`,
    capability,
    canonicalAction: capability,
    targetRef: 'target',
    provider: 'TEST',
    executionEnvironment: route === 'BROWSER' ? 'BROWSER' : route === 'ANDROID_SMS_MANAGER' || route === 'APP_LINK' ? 'ANDROID' : 'SERVER',
    executionRoute: route,
    providerConnected: true,
    channelOwnershipVerified: true,
    approval: approved(capability, route),
    ...patch,
  };
}

test('M3 1-3. SMS native allowed, permission revoked, and device offline route through M2 authority', () => {
  const h = harness();
  const allowed = h.authority.evaluate(request('SMS_SEND', 'ANDROID_SMS_MANAGER', { provider: 'DEVICE_NATIVE', executionEnvironment: 'ANDROID', deviceId: h.device.deviceId, targetRef: 'rcp_1', approval: approved('SMS_SEND', 'ANDROID_SMS_MANAGER', 'rcp_1', 'DEVICE_NATIVE') }));
  assert.equal(allowed.disposition, 'ALLOW');
  assert.equal(allowed.selectedRoute, 'ANDROID_NATIVE');
  assert.equal(h.authority.toCanonicalResult(allowed).confirmationStrength, 'STRONG');

  const revoked = harness(['permission:SEND_SMS:REVOKED']);
  const denied = revoked.authority.evaluate(request('SMS_SEND', 'ANDROID_SMS_MANAGER', { provider: 'DEVICE_NATIVE', executionEnvironment: 'ANDROID', deviceId: revoked.device.deviceId, targetRef: 'rcp_1', approval: approved('SMS_SEND', 'ANDROID_SMS_MANAGER', 'rcp_1', 'DEVICE_NATIVE') }));
  assert.equal(denied.disposition, 'PERMISSION_REQUIRED');

  h.connections.markDisconnected(h.device.deviceId, 'ten', 'usr');
  const offline = h.authority.evaluate(request('SMS_SEND', 'ANDROID_SMS_MANAGER', { provider: 'DEVICE_NATIVE', executionEnvironment: 'ANDROID', deviceId: h.device.deviceId, targetRef: 'rcp_1', approval: approved('SMS_SEND', 'ANDROID_SMS_MANAGER', 'rcp_1', 'DEVICE_NATIVE') }));
  assert.equal(offline.disposition, 'BLOCKED');
});

test('M3 4-8. Gmail and Calendar provider routes allow only provider API and require reapproval for fallback/account drift', () => {
  const h = harness();
  const gmail = h.authority.evaluate(request('GMAIL_SEND', 'PROVIDER_API', { provider: 'GOOGLE_GMAIL', accountRef: 'acct_a', approval: approved('GMAIL_SEND', 'PROVIDER_API', 'target', 'GOOGLE_GMAIL') }));
  assert.equal(gmail.disposition, 'ALLOW');
  assert.equal(gmail.selectedRoute, 'PROVIDER_API');
  const gmailDisconnected = h.authority.evaluate(request('GMAIL_SEND', 'PROVIDER_API', { provider: 'GOOGLE_GMAIL', providerConnected: false }));
  assert.equal(gmailDisconnected.disposition, 'BLOCKED');
  assert.ok(gmailDisconnected.reasonCodes.includes('PROVIDER_DISCONNECTED'));
  const fallback = h.authority.evaluateRouteFailover({ approved: request('GMAIL_SEND', 'PROVIDER_API'), candidate: request('BROWSER_EXECUTION', 'BROWSER'), consequential: true });
  assert.equal(fallback.disposition, 'REAPPROVAL_REQUIRED');

  const calendar = h.authority.evaluate(request('CALENDAR_WRITE', 'PROVIDER_API', { provider: 'GOOGLE_CALENDAR', accountRef: 'cal_a', approval: { status: 'APPROVED', canonicalPayload: { targetRef: 'target', accountRef: 'cal_a', provider: 'GOOGLE_CALENDAR', executionRoute: 'PROVIDER_API' } } }));
  assert.equal(calendar.disposition, 'ALLOW');
  const accountDrift = h.authority.evaluate(request('CALENDAR_WRITE', 'PROVIDER_API', { provider: 'GOOGLE_CALENDAR', accountRef: 'cal_b', approval: { status: 'APPROVED', canonicalPayload: { targetRef: 'target', accountRef: 'cal_a', provider: 'GOOGLE_CALENDAR', executionRoute: 'PROVIDER_API' } } }));
  assert.equal(accountDrift.disposition, 'REAPPROVAL_REQUIRED');
  assert.ok(accountDrift.reasonCodes.includes('ACCOUNT_CHANGED_AFTER_APPROVAL'));
});

test('M3 9-10. Browser consequential approval is route-bound and route drift requires reapproval', () => {
  const h = harness();
  const browser = h.authority.evaluate(request('BROWSER_EXECUTION', 'BROWSER', { provider: 'BROWSER', executionEnvironment: 'BROWSER', targetRef: 'selector:#submit', approval: approved('BROWSER_EXECUTION', 'BROWSER', 'selector:#submit', 'BROWSER') }));
  assert.equal(browser.disposition, 'ALLOW');
  assert.equal(browser.selectedRoute, 'BROWSER');
  assert.equal(h.authority.toCanonicalResult(browser).confirmationStrength, 'MEDIUM');
  const drift = h.authority.evaluate(request('BROWSER_EXECUTION', 'BROWSER', { provider: 'BROWSER', executionEnvironment: 'BROWSER', approval: { status: 'APPROVED', canonicalPayload: { targetRef: 'selector:#submit', provider: 'BROWSER', environment: 'BROWSER', executionRoute: 'PROVIDER_API' } } }));
  assert.equal(drift.disposition, 'REAPPROVAL_REQUIRED');
});

test('M3 11-14. Telegram and Slack remain self-delivery only', () => {
  const h = harness();
  for (const capability of ['TELEGRAM_SELF_DELIVERY', 'SLACK_SELF_DELIVERY'] as DeviceCapabilityKind[]) {
    const allowed = h.authority.evaluate(request(capability, 'PROVIDER_API', { provider: capability.split('_')[0], targetRef: 'self', channelOwnershipVerified: true, approval: approved(capability, 'PROVIDER_API', 'self', capability.split('_')[0]) }));
    assert.equal(allowed.disposition, 'ALLOW');
    const arbitrary = h.authority.evaluate(request(capability, 'PROVIDER_API', { provider: capability.split('_')[0], targetRef: 'someone_else', channelOwnershipVerified: false, approval: approved(capability, 'PROVIDER_API', 'self', capability.split('_')[0]) }));
    assert.equal(arbitrary.disposition, 'BLOCKED');
    assert.ok(arbitrary.reasonCodes.includes('RECIPIENT_UNENFORCEABLE'));
  }
});

test('M3 15-18/21-23. app-link allowlist validates scheme, package, payload, device, and weak confirmation', () => {
  const h = harness();
  const approval = { status: 'APPROVED', canonicalPayload: { targetRef: 'nagex://status/open', provider: 'NAGEX_ANDROID', executionRoute: 'APP_LINK' } };
  const launched = h.appLinks.prepare({ tenantId: 'ten', principalId: 'usr', deviceId: h.device.deviceId, capability: 'DEEP_LINK_OPEN', targetApp: 'NAGEX_ANDROID', uri: 'nagex://status/open', actionKind: 'OPEN_STATUS', approvedRoute: 'APP_LINK', approvalReference: approval, correlationId: 'req_app_link' });
  assert.equal(launched.status, 'APP_LAUNCHED');
  assert.equal(launched.command.commandType, 'APP_LINK_OPEN');
  assert.equal(launched.canonical.confirmationStrength, 'WEAK');
  assert.notEqual(launched.canonical.status, 'EXECUTED_CONFIRMED');

  assert.throws(() => h.appLinks.prepare({ ...baseAppLink(h), uri: 'javascript://status/open' }), (e: unknown) => e instanceof NagexError && e.code === 'UNKNOWN_SCHEME_EXECUTION');
  assert.throws(() => h.appLinks.prepare({ ...baseAppLink(h), targetApp: 'KAKAOTALK', uri: 'nagex://status/open' }), (e: unknown) => e instanceof NagexError && e.code === 'UNKNOWN_SCHEME_EXECUTION');
  assert.throws(() => h.appLinks.prepare({ ...baseAppLink(h), uri: 'nagex://voice/open' }), (e: unknown) => e instanceof NagexError && e.code === 'REAPPROVAL_REQUIRED');
  assert.throws(() => h.appLinks.prepare({ ...baseAppLink(h), deviceId: 'dev_other' }), (e: unknown) => e instanceof NagexError && e.code === 'BLOCKED');
});

function baseAppLink(h: ReturnType<typeof harness>) {
  return {
    tenantId: 'ten',
    principalId: 'usr',
    deviceId: h.device.deviceId,
    capability: 'DEEP_LINK_OPEN' as const,
    targetApp: 'NAGEX_ANDROID' as const,
    uri: 'nagex://status/open',
    actionKind: 'OPEN_STATUS' as const,
    approvedRoute: 'APP_LINK' as const,
    approvalReference: { status: 'APPROVED', canonicalPayload: { targetRef: 'nagex://status/open', provider: 'NAGEX_ANDROID', executionRoute: 'APP_LINK' } },
    correlationId: 'req_app_link_base',
  };
}

test('M3 19-20. Kakao app-link integration remains handoff only and never message sent', () => {
  const h = harness();
  const result = h.appLinks.prepare({
    tenantId: 'ten',
    principalId: 'usr',
    deviceId: h.device.deviceId,
    capability: 'KAKAOTALK_HANDOFF',
    targetApp: 'KAKAOTALK',
    uri: 'kakaolink://send/share',
    actionKind: 'KAKAOTALK_SHARE_HANDOFF',
    approvedRoute: 'HUMAN_HANDOFF',
    approvalReference: { status: 'APPROVED', canonicalPayload: { targetRef: 'kakaolink://send/share', provider: 'KAKAOTALK', executionRoute: 'KAKAOTALK_SHARE', capability: 'KAKAOTALK_HANDOFF' } },
    correlationId: 'req_kakao',
  });
  assert.equal(result.status, 'HANDOFF_STARTED');
  assert.equal(result.canonical.status, 'HANDOFF_STARTED');
  assert.equal(result.canonical.confirmationStrength, 'NONE');
  assert.notEqual(result.status as string, 'MESSAGE_SENT');
});

test('M3 24-26 and exclusions. voice/mobile cannot bypass approval, cross-tenant/user block, no payment/booking/generic Android UI authority', () => {
  const h = harness();
  const voiceSms = h.authority.evaluate(request('SMS_SEND', 'ANDROID_SMS_MANAGER', { provider: 'DEVICE_NATIVE', executionEnvironment: 'ANDROID', deviceId: h.device.deviceId, approval: null }));
  assert.equal(voiceSms.disposition, 'APPROVAL_REQUIRED');
  const crossTenant = h.authority.evaluate(request('SMS_SEND', 'ANDROID_SMS_MANAGER', { tenantId: 'other', provider: 'DEVICE_NATIVE', executionEnvironment: 'ANDROID', deviceId: h.device.deviceId, approval: approved('SMS_SEND', 'ANDROID_SMS_MANAGER') }));
  assert.equal(crossTenant.disposition, 'BLOCKED');
  const crossUser = h.authority.evaluate(request('SMS_SEND', 'ANDROID_SMS_MANAGER', { principalId: 'other', provider: 'DEVICE_NATIVE', executionEnvironment: 'ANDROID', deviceId: h.device.deviceId, approval: approved('SMS_SEND', 'ANDROID_SMS_MANAGER') }));
  assert.equal(crossUser.disposition, 'BLOCKED');
  assert.equal(h.authority.evaluate(request('PAYMENT', 'PROVIDER_API')).disposition, 'UNSUPPORTED');
  assert.equal(h.authority.evaluate(request('ANDROID_UI_AUTOMATION', 'UNSUPPORTED_FUTURE')).disposition, 'UNSUPPORTED');
});

test('M3 source guard. Android app-link and Kakao handoff executors do not implement phone, payment, booking, or Kakao send confirmation', () => {
  const android = fs.readFileSync('mobile-android/app/src/main/java/com/nagex/mobile/AndroidAppLinkExecutor.kt', 'utf8');
  const kakao = fs.readFileSync('mobile-android/app/src/main/java/com/nagex/mobile/KakaoTalkHandoffExecutor.kt', 'utf8');
  assert.doesNotMatch(android, /performAction|ACTION_CALL|Payment|Booking/i);
  assert.doesNotMatch(kakao, /MESSAGE_SENT|SENT_CONFIRMED|sendTextMessage|performAction/i);
});

// R10.2-D Increment 5 — Local Device Agent outbound transport route
// (DC3-B1), extracted verbatim from server_web.ts's handleAsyncApiRequest.
// Deliberately does NOT trust x-nagex-tenant/x-principal-id headers the
// way every other route does — a device's tenantId/ownerId are only ever
// accepted as authenticated here because they are cryptographically bound
// to an enrolled, ACTIVE device via DeviceTransportSecurity.verify()'s
// real Ed25519 signature check (inside deviceAgentTransportEndpoint.handle
// itself), never because a caller-controlled header said so. Never
// touches CapabilityBroker/CapabilityRegistry — device.desktop.execute is
// not reachable through this route at all.
//
// R23.6M Phase B1 — adds the one missing piece DC3-A/DC3-B1 never wired to
// HTTP: enrollment itself. DeviceIdentityStore.enroll() has existed since
// DC3-A but had no caller anywhere in the codebase — a device could only
// ever be enrolled by hand-writing a record file.
//
// R23.6M Phase B4 security audit finding, fixed here: /enroll originally
// derived tenantId/ownerId from the same x-nagex-tenant/x-principal-id
// headers every other route in this codebase currently trusts at face
// value (a pre-existing, systemic gap spanning the whole HTTP layer, not
// specific to this route — see server_web.ts's handleApiRequest, which
// falls back to 'ten_production_01'/'usr_admin_001' when these headers are
// simply absent). For most routes that is an accepted, if imperfect,
// existing posture. For device enrollment specifically it is not
// acceptable: it would let any caller mint a real, ACTIVE device identity
// for an arbitrary tenant/user just by setting two headers. /enroll is
// fixed narrowly (not the rest of the app) by requiring the SAME real,
// already-working session mechanism auth.routes.ts already uses for login
// (an httpOnly `nagex_session` cookie, or `Authorization: Bearer
// <sessionId>`, validated via SessionStore.getSession() — real,
// expiry/revocation-checked, bound to tenantId/principalId at login time,
// not client-controlled). tenantId/ownerId are derived ONLY from that
// validated session; x-nagex-tenant/x-principal-id are no longer read for
// this route at all. This does not change or weaken
// DeviceTransportSecurity — /message's signature-based verification is
// completely untouched.
import crypto from 'node:crypto';
import { NagexError } from '../../common/errors.js';
import type { DeviceAgentTransportEndpoint } from '../../device-agent/device-agent-transport-endpoint.service.js';
import type { DeviceIdentityRecord, DeviceIdentityStore } from '../../device-agent/device-identity.store.js';
import type { DevicePendingCommandStore } from '../../device-agent/device-pending-command.store.js';
import type { DeviceCommandStatusStore } from '../../device-agent/device-command-status.store.js';
import type { DeviceConnectionStatusStore } from '../../device-agent/device-connection-status.store.js';
import type { KakaoAccessibilityApprovalService } from '../../mobile/kakaotalk-accessibility-approval.service.js';
import { buildKakaoAccessibilityMessageHash } from '../../mobile/kakao-accessibility-draft.types.js';
import { ANDROID_ACCESSIBILITY_ROUTE, KAKAOTALK_PROVIDER, SELECT_KAKAO_DIRECT_CONVERSATION_ACTION, SEND_KAKAO_DIRECT_MESSAGE_ACTION } from '../../mobile/kakaotalk-accessibility-approval.service.js';
import type { SessionStore } from '../../sessions/session.store.js';
import { getSessionIdFromHeaders } from './auth.routes.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';

function getHeaderValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function publicKeyFingerprint(publicKey: string): string {
  return crypto.createHash('sha256').update(publicKey.trim()).digest('hex');
}

function projectDeviceForSettings(device: DeviceIdentityRecord | null, connectionState?: string): Record<string, unknown> {
  if (!device) return {};
  const agentVersion = device.agentVersion.toLowerCase();
  const isAndroid = agentVersion.includes('android') || device.os === 'Android';
  const os = device.os || (isAndroid ? 'Android' : (process.platform === 'win32' ? 'Windows' : process.platform));
  return {
    deviceId: device.deviceId,
    nickname: device.nickname ?? null,
    systemDeviceName: device.systemDeviceName || (isAndroid ? 'Android device' : (process.env.COMPUTERNAME || process.env.HOSTNAME || 'This device')),
    deviceType: device.deviceType || (isAndroid ? 'Mobile device' : 'PC / Laptop'),
    os,
    onlineStatus: connectionState === 'CONNECTED' ? 'ONLINE' : 'OFFLINE',
    lastActive: device.lastSeenAt,
    trustStatus: device.status === 'ACTIVE' ? 'Trusted' : 'Revoked',
    controlCapabilities: device.capabilityInventory,
  };
}

export interface DeviceAgentRouteDeps {
  deviceAgentTransportEndpoint: DeviceAgentTransportEndpoint;
  deviceIdentityStore: DeviceIdentityStore;
  devicePendingCommandStore: DevicePendingCommandStore;
  deviceConnectionStatusStore?: DeviceConnectionStatusStore;
  deviceCommandStatusStore?: DeviceCommandStatusStore;
  kakaoAccessibilityApprovalService: KakaoAccessibilityApprovalService;
  sessionStore: SessionStore;
}

export const handleDeviceAgentRoutes: AsyncRouteRegistrar<DeviceAgentRouteDeps> = async (method, pathname, body, headers, _query, deps): Promise<ApiResult | undefined> => {
  const { deviceAgentTransportEndpoint, deviceIdentityStore, devicePendingCommandStore, deviceConnectionStatusStore, deviceCommandStatusStore, kakaoAccessibilityApprovalService, sessionStore } = deps;

  if (pathname === '/api/v1/device-agent/message' && method === 'POST') {
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
    const envelope = body?.envelope as any;
    const payload = body?.payload as any;
    if (!envelope || typeof envelope !== 'object' || payload === undefined) {
      throw new NagexError({ code: 'DEVICE_MESSAGE_MALFORMED', category: 'VALIDATION', message: 'A device message requires envelope and payload.', request_id: requestId });
    }
    const result = deviceAgentTransportEndpoint.handle({ envelope, payload }, requestId);
    return { status: 200, data: result };
  }

  if (pathname === '/api/v1/device-agent/devices' && method === 'GET') {
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
    const sessionId = getSessionIdFromHeaders(headers);
    const session = sessionId ? sessionStore.getSession(sessionId) : null;
    if (!session) {
      throw new NagexError({ code: 'DEVICE_LIST_AUTH_REQUIRED', category: 'AUTHENTICATION', message: 'A valid authenticated session is required to list devices.', request_id: requestId });
    }
    const devices = deviceIdentityStore.listOwned(session.tenantId, session.principalId).map((device) => {
      const connection = deviceConnectionStatusStore?.getStatus(device.deviceId, session.tenantId, session.principalId);
      return projectDeviceForSettings(device, connection?.connectionState);
    });
    return { status: 200, data: { devices } };
  }

  const nicknameMatch = pathname.match(/^\/api\/v1\/device-agent\/devices\/([^/]+)\/nickname$/);
  if (nicknameMatch && method === 'PUT') {
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
    const sessionId = getSessionIdFromHeaders(headers);
    const session = sessionId ? sessionStore.getSession(sessionId) : null;
    if (!session) {
      throw new NagexError({ code: 'DEVICE_RENAME_AUTH_REQUIRED', category: 'AUTHENTICATION', message: 'A valid authenticated session is required to rename a device.', request_id: requestId });
    }
    const nickname = body?.nickname === null ? null : (typeof body?.nickname === 'string' ? body.nickname.trim() : null);
    const device = deviceIdentityStore.updateNickname(decodeURIComponent(nicknameMatch[1]), session.tenantId, session.principalId, nickname);
    if (!device) {
      throw new NagexError({ code: 'DEVICE_RENAME_NOT_FOUND', category: 'NOT_FOUND', message: 'Device was not found for this account.', request_id: requestId });
    }
    const connection = deviceConnectionStatusStore?.getStatus(device.deviceId, session.tenantId, session.principalId);
    return { status: 200, data: projectDeviceForSettings(device, connection?.connectionState) };
  }

  if (pathname === '/api/v1/device-agent/enroll' && method === 'POST') {
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;

    // tenantId/ownerId come ONLY from a real, validated session — never
    // from a caller-supplied header. A missing, unknown, expired, or
    // revoked session is rejected identically (never a distinguishable
    // error that would help an attacker probe session validity).
    const sessionId = getSessionIdFromHeaders(headers);
    const session = sessionId ? sessionStore.getSession(sessionId) : null;
    if (!session) {
      throw new NagexError({ code: 'DEVICE_ENROLL_AUTH_REQUIRED', category: 'AUTHENTICATION', message: 'A valid authenticated session is required to enroll a device.', request_id: requestId });
    }
    const tenantId = session.tenantId;
    const ownerId = session.principalId;

    const publicKey = typeof body?.publicKey === 'string' ? body.publicKey : '';
    const agentVersion = typeof body?.agentVersion === 'string' ? body.agentVersion : '';
    const capabilityInventory = Array.isArray(body?.capabilityInventory) && body.capabilityInventory.every((c: unknown) => typeof c === 'string')
      ? (body.capabilityInventory as string[])
      : [];
    if (!publicKey.trim() || !agentVersion.trim()) {
      throw new NagexError({ code: 'DEVICE_ENROLL_FIELDS_REQUIRED', category: 'VALIDATION', message: 'publicKey and agentVersion are required.', request_id: requestId });
    }
    const device = deviceIdentityStore.enroll({
      tenantId,
      ownerId,
      publicKey,
      agentVersion,
      capabilityInventory,
      nickname: typeof body?.nickname === 'string' ? body.nickname : null,
      systemDeviceName: typeof body?.systemDeviceName === 'string' ? body.systemDeviceName : null,
      deviceType: typeof body?.deviceType === 'string' ? body.deviceType : null,
      os: typeof body?.os === 'string' ? body.os : null,
    });
    return { status: 201, data: device };
  }

  const validateMatch = pathname.match(/^\/api\/v1\/device-agent\/devices\/([^/]+)\/validate$/);
  if (validateMatch && method === 'POST') {
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
    const sessionId = getSessionIdFromHeaders(headers);
    const session = sessionId ? sessionStore.getSession(sessionId) : null;
    if (!session) {
      throw new NagexError({ code: 'DEVICE_VALIDATE_AUTH_REQUIRED', category: 'AUTHENTICATION', message: 'A valid authenticated session is required to validate a device binding.', request_id: requestId });
    }
    const pathDeviceId = decodeURIComponent(validateMatch[1]);
    const bodyDeviceId = typeof body?.deviceId === 'string' ? body.deviceId : '';
    const publicKey = typeof body?.publicKey === 'string' ? body.publicKey : '';
    if (!bodyDeviceId || bodyDeviceId !== pathDeviceId || !publicKey.trim()) {
      throw new NagexError({ code: 'DEVICE_VALIDATE_FIELDS_REQUIRED', category: 'VALIDATION', message: 'deviceId and publicKey are required.', request_id: requestId });
    }
    const device = deviceIdentityStore.getAny(pathDeviceId);
    if (!device) {
      throw new NagexError({ code: 'DEVICE_BINDING_NOT_FOUND', category: 'NOT_FOUND', message: 'Device binding was not found on this runtime.', request_id: requestId });
    }
    if (device.tenantId !== session.tenantId || device.ownerId !== session.principalId || device.status !== 'ACTIVE' || publicKeyFingerprint(device.publicKey) !== publicKeyFingerprint(publicKey)) {
      throw new NagexError({ code: 'DEVICE_BINDING_NOT_AUTHORIZED', category: 'AUTHORIZATION', message: 'Device binding could not be validated for this session.', request_id: requestId });
    }
    return { status: 200, data: { deviceId: device.deviceId, status: device.status, tenantId: device.tenantId, ownerId: device.ownerId } };
  }

  if (pathname === '/api/v1/device-agent/accessibility-plans' && method === 'POST') {
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
    const sessionId = getSessionIdFromHeaders(headers);
    const session = sessionId ? sessionStore.getSession(sessionId) : null;
    if (!session) {
      throw new NagexError({ code: 'DEVICE_COMMAND_AUTH_REQUIRED', category: 'AUTHENTICATION', message: 'A valid authenticated session is required to enqueue an accessibility plan.', request_id: requestId });
    }
    const deviceId = typeof body?.deviceId === 'string' ? body.deviceId : '';
    const recipientRef = typeof body?.recipientRef === 'string' ? body.recipientRef : '';
    const draftId = typeof body?.draftId === 'string' ? body.draftId : '';
    const approvalId = typeof body?.approvalId === 'string' ? body.approvalId : '';
    const messageHash = typeof body?.messageHash === 'string' ? body.messageHash : '';
    const conversationRef = typeof body?.conversationRef === 'string' ? body.conversationRef : '';
    const provider = typeof body?.provider === 'string' ? body.provider : '';
    const route = typeof body?.route === 'string' ? body.route : '';
    const planId = typeof body?.planId === 'string' ? body.planId : `aplan_${crypto.randomUUID()}`;
    const expectedProviderDisplayName = typeof body?.expectedProviderDisplayName === 'string' ? body.expectedProviderDisplayName : '';
    const steps = Array.isArray(body?.steps) ? body.steps : [{ action: SELECT_KAKAO_DIRECT_CONVERSATION_ACTION, expectedProviderDisplayName, conversationRef }];
    if (!deviceId || !recipientRef || !draftId || !approvalId || !messageHash || !conversationRef || !expectedProviderDisplayName.trim() || provider !== KAKAOTALK_PROVIDER || route !== ANDROID_ACCESSIBILITY_ROUTE) {
      throw new NagexError({ code: 'ACCESSIBILITY_PLAN_FIELDS_REQUIRED', category: 'VALIDATION', message: 'draftId, deviceId, recipientRef, approvalId, messageHash, provider, route, conversationRef, and expectedProviderDisplayName are required.', request_id: requestId });
    }
    const device = deviceIdentityStore.getOwned(deviceId, session.tenantId, session.principalId);
    if (!device || device.status !== 'ACTIVE') {
      throw new NagexError({ code: 'DEVICE_NOT_FOUND', category: 'NOT_FOUND', message: 'Device was not found for this tenant/user.', request_id: requestId });
    }
    if (!device.capabilityInventory.includes('permission:ACCESSIBILITY_SERVICE:ENABLED')) {
      throw new NagexError({ code: 'ACCESSIBILITY_NOT_ENABLED', category: 'POLICY', message: 'Accessibility permission is not enabled for this device.', request_id: requestId });
    }
    if (steps.length !== 1 || typeof steps[0] !== 'object' || (steps[0] as Record<string, unknown>).action !== SELECT_KAKAO_DIRECT_CONVERSATION_ACTION) {
      throw new NagexError({ code: 'ACCESSIBILITY_ACTION_NOT_ALLOWED', category: 'POLICY', message: 'Only SELECT_KAKAO_DIRECT_CONVERSATION is supported for R2G accessibility plans.', request_id: requestId });
    }
    const executionId = `aplan_exec_${crypto.randomUUID()}`;
    kakaoAccessibilityApprovalService.consumeDraftApproval(approvalId, {
      tenantId: session.tenantId,
      ownerId: session.principalId,
      draftId,
      deviceId,
      recipientRef,
      conversationRef,
      messageHash,
      expectedProviderDisplayName,
      requestId,
    }, executionId);
    const command = devicePendingCommandStore.enqueue(deviceId, session.tenantId, session.principalId, 'ACCESSIBILITY_EXECUTE_PLAN', null, {
      planId,
      executionId,
      packageName: 'com.kakao.talk',
      targetPackage: 'com.kakao.talk',
        provider,
        route,
        draftId,
        recipientRef,
      messageHash,
      conversationRef,
      expectedProviderDisplayName,
      steps: [{ action: SELECT_KAKAO_DIRECT_CONVERSATION_ACTION, expectedProviderDisplayName, conversationRef }],
      requiresForeground: true,
      requiresUserPresence: true,
    });
    deviceCommandStatusStore?.markQueued({
      commandId: command.commandId,
      tenantId: session.tenantId,
      ownerId: session.principalId,
      deviceId,
      executionId,
    });
    return { status: 202, data: { status: 'QUEUED', command } };
  }

  if (pathname === '/api/v1/device-agent/accessibility-send-plans' && method === 'POST') {
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
    const sessionId = getSessionIdFromHeaders(headers);
    const session = sessionId ? sessionStore.getSession(sessionId) : null;
    if (!session) {
      throw new NagexError({ code: 'DEVICE_COMMAND_AUTH_REQUIRED', category: 'AUTHENTICATION', message: 'A valid authenticated session is required to enqueue an accessibility send plan.', request_id: requestId });
    }
    const deviceId = typeof body?.deviceId === 'string' ? body.deviceId : '';
    const recipientRef = typeof body?.recipientRef === 'string' ? body.recipientRef : '';
    const draftId = typeof body?.draftId === 'string' ? body.draftId : '';
    const approvalId = typeof body?.approvalId === 'string' ? body.approvalId : '';
    const message = typeof body?.message === 'string' ? body.message : '';
    const messageHash = typeof body?.messageHash === 'string' ? body.messageHash : '';
    const conversationRef = typeof body?.conversationRef === 'string' ? body.conversationRef : '';
    const provider = typeof body?.provider === 'string' ? body.provider : '';
    const route = typeof body?.route === 'string' ? body.route : '';
    const expectedProviderDisplayName = typeof body?.expectedProviderDisplayName === 'string' ? body.expectedProviderDisplayName : '';
    const planId = typeof body?.planId === 'string' ? body.planId : `aplan_${crypto.randomUUID()}`;
    if (!deviceId || !recipientRef || !draftId || !approvalId || !message || !messageHash || !conversationRef || !expectedProviderDisplayName.trim() || provider !== KAKAOTALK_PROVIDER || route !== ANDROID_ACCESSIBILITY_ROUTE) {
      throw new NagexError({ code: 'ACCESSIBILITY_SEND_PLAN_FIELDS_REQUIRED', category: 'VALIDATION', message: 'draftId, deviceId, recipientRef, approvalId, message, messageHash, provider, route, conversationRef, and expectedProviderDisplayName are required.', request_id: requestId });
    }
    if (buildKakaoAccessibilityMessageHash(message) !== messageHash) {
      throw new NagexError({ code: 'ACCESSIBILITY_SEND_MESSAGE_HASH_MISMATCH', category: 'POLICY', message: 'Message hash does not match the exact message text.', request_id: requestId });
    }
    const device = deviceIdentityStore.getOwned(deviceId, session.tenantId, session.principalId);
    if (!device || device.status !== 'ACTIVE') {
      throw new NagexError({ code: 'DEVICE_NOT_FOUND', category: 'NOT_FOUND', message: 'Device was not found for this tenant/user.', request_id: requestId });
    }
    if (!device.capabilityInventory.includes('permission:ACCESSIBILITY_SERVICE:ENABLED')) {
      throw new NagexError({ code: 'ACCESSIBILITY_NOT_ENABLED', category: 'POLICY', message: 'Accessibility permission is not enabled for this device.', request_id: requestId });
    }
    const executionId = `aplan_exec_${crypto.randomUUID()}`;
    kakaoAccessibilityApprovalService.assertSendApprovalExecutable(approvalId, {
      tenantId: session.tenantId,
      ownerId: session.principalId,
      draftId,
      deviceId,
      recipientRef,
      conversationRef,
      messageHash,
      expectedProviderDisplayName,
      requestId,
    });
    const command = devicePendingCommandStore.enqueue(deviceId, session.tenantId, session.principalId, 'ACCESSIBILITY_EXECUTE_PLAN', null, {
      planId,
      executionId,
      packageName: 'com.kakao.talk',
      targetPackage: 'com.kakao.talk',
      provider,
      route,
      action: SEND_KAKAO_DIRECT_MESSAGE_ACTION,
      draftId,
      recipientRef,
      approvalId,
      message,
      messageHash,
      conversationRef,
      expectedProviderDisplayName,
      steps: [{ action: 'KAKAOTALK_GOVERNED_SEND', expectedProviderDisplayName, conversationRef, messageHash }],
      requiresForeground: true,
      requiresUserPresence: true,
    });
    deviceCommandStatusStore?.markQueued({
      commandId: command.commandId,
      tenantId: session.tenantId,
      ownerId: session.principalId,
      deviceId,
      executionId,
    });
    return { status: 202, data: { status: 'QUEUED', command } };
  }

  if (pathname === '/api/v1/device-agent/accessibility-prepare-message-plans' && method === 'POST') {
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
    const sessionId = getSessionIdFromHeaders(headers);
    const session = sessionId ? sessionStore.getSession(sessionId) : null;
    if (!session) {
      throw new NagexError({ code: 'DEVICE_COMMAND_AUTH_REQUIRED', category: 'AUTHENTICATION', message: 'A valid authenticated session is required to enqueue an accessibility preparation plan.', request_id: requestId });
    }
    const deviceId = typeof body?.deviceId === 'string' ? body.deviceId : '';
    const recipientRef = typeof body?.recipientRef === 'string' ? body.recipientRef : '';
    const draftId = typeof body?.draftId === 'string' ? body.draftId : '';
    const message = typeof body?.message === 'string' ? body.message : '';
    const messageHash = typeof body?.messageHash === 'string' ? body.messageHash : '';
    const conversationRef = typeof body?.conversationRef === 'string' ? body.conversationRef : '';
    const provider = typeof body?.provider === 'string' ? body.provider : '';
    const route = typeof body?.route === 'string' ? body.route : '';
    const expectedProviderDisplayName = typeof body?.expectedProviderDisplayName === 'string' ? body.expectedProviderDisplayName : '';
    const planId = typeof body?.planId === 'string' ? body.planId : `aplan_${crypto.randomUUID()}`;
    if (!deviceId || !recipientRef || !draftId || !message || !messageHash || !conversationRef || !expectedProviderDisplayName.trim() || provider !== KAKAOTALK_PROVIDER || route !== ANDROID_ACCESSIBILITY_ROUTE) {
      throw new NagexError({ code: 'ACCESSIBILITY_PREPARE_PLAN_FIELDS_REQUIRED', category: 'VALIDATION', message: 'draftId, deviceId, recipientRef, message, messageHash, provider, route, conversationRef, and expectedProviderDisplayName are required.', request_id: requestId });
    }
    if (buildKakaoAccessibilityMessageHash(message) !== messageHash) {
      throw new NagexError({ code: 'ACCESSIBILITY_PREPARE_MESSAGE_HASH_MISMATCH', category: 'POLICY', message: 'Message hash does not match the exact message text.', request_id: requestId });
    }
    const device = deviceIdentityStore.getOwned(deviceId, session.tenantId, session.principalId);
    if (!device || device.status !== 'ACTIVE') {
      throw new NagexError({ code: 'DEVICE_NOT_FOUND', category: 'NOT_FOUND', message: 'Device was not found for this tenant/user.', request_id: requestId });
    }
    if (!device.capabilityInventory.includes('permission:ACCESSIBILITY_SERVICE:ENABLED')) {
      throw new NagexError({ code: 'ACCESSIBILITY_NOT_ENABLED', category: 'POLICY', message: 'Accessibility permission is not enabled for this device.', request_id: requestId });
    }
    const executionId = `aplan_exec_${crypto.randomUUID()}`;
    const command = devicePendingCommandStore.enqueue(deviceId, session.tenantId, session.principalId, 'ACCESSIBILITY_EXECUTE_PLAN', null, {
      planId,
      executionId,
      packageName: 'com.kakao.talk',
      targetPackage: 'com.kakao.talk',
      provider,
      route,
      action: 'PREPARE_MESSAGE',
      draftId,
      recipientRef,
      message,
      messageHash,
      conversationRef,
      expectedProviderDisplayName,
      steps: [{ action: 'KAKAOTALK_PREPARE_MESSAGE', expectedProviderDisplayName, conversationRef, messageHash }],
      requiresForeground: true,
      requiresUserPresence: true,
      requiresSendApproval: false,
    });
    deviceCommandStatusStore?.markQueued({
      commandId: command.commandId,
      tenantId: session.tenantId,
      ownerId: session.principalId,
      deviceId,
      executionId,
    });
    return { status: 202, data: { status: 'QUEUED', command } };
  }

  return undefined;
};

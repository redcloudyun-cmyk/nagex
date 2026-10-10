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
import type { DeviceCommandService } from '../../device-agent/device-command.service.js';
import type { DeviceIdentityStore } from '../../device-agent/device-identity.store.js';
import type { DevicePendingCommandStore } from '../../device-agent/device-pending-command.store.js';
import type { DeviceConnectionStatusStore } from '../../device-agent/device-connection-status.store.js';
import type { DeviceCommandStatusStore } from '../../device-agent/device-command-status.store.js';
import type { KakaoAccessibilityApprovalService } from '../../mobile/kakaotalk-accessibility-approval.service.js';
import { ANDROID_ACCESSIBILITY_ROUTE, KAKAOTALK_PROVIDER, SELECT_KAKAO_DIRECT_CONVERSATION_ACTION, SEND_KAKAO_DIRECT_MESSAGE_ACTION } from '../../mobile/kakaotalk-accessibility-approval.service.js';
import { buildKakaoAccessibilityMessageHash } from '../../mobile/kakao-accessibility-draft.types.js';
import type { SessionStore } from '../../sessions/session.store.js';
import { getSessionIdFromHeaders } from './auth.routes.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';

function getHeaderValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export interface DeviceAgentRouteDeps {
  deviceAgentTransportEndpoint: DeviceAgentTransportEndpoint;
  deviceCommandService?: DeviceCommandService;
  deviceIdentityStore: DeviceIdentityStore;
  sessionStore: SessionStore;
  /** Legacy compatibility for pre-generalized route tests; runtime command enqueue uses deviceCommandService. */
  devicePendingCommandStore?: DevicePendingCommandStore;
  deviceConnectionStatusStore?: DeviceConnectionStatusStore;
  deviceCommandStatusStore?: DeviceCommandStatusStore;
  kakaoAccessibilityApprovalService?: KakaoAccessibilityApprovalService;
}

export const handleDeviceAgentRoutes: AsyncRouteRegistrar<DeviceAgentRouteDeps> = async (method, pathname, body, headers, _query, deps): Promise<ApiResult | undefined> => {
  const { deviceAgentTransportEndpoint, deviceCommandService, deviceIdentityStore, sessionStore } = deps;

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
    const device = deviceIdentityStore.enroll({ tenantId, ownerId, publicKey, agentVersion, capabilityInventory });
    return { status: 201, data: device };
  }

  if (pathname === '/api/v1/device-agent/accessibility-plans' && method === 'POST') {
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
    const sessionId = getSessionIdFromHeaders(headers);
    const session = sessionId ? sessionStore.getSession(sessionId) : null;
    if (!session) {
        throw new NagexError({ code: 'DEVICE_COMMAND_AUTH_REQUIRED', category: 'AUTHENTICATION', message: 'A valid authenticated session is required to enqueue an accessibility plan.', request_id: requestId });
    }
    if (!deviceCommandService) {
      const { devicePendingCommandStore, deviceCommandStatusStore, kakaoAccessibilityApprovalService } = deps;
      if (!devicePendingCommandStore || !kakaoAccessibilityApprovalService) {
        throw new NagexError({ code: 'DEVICE_COMMAND_SERVICE_UNAVAILABLE', category: 'INTERNAL', message: 'Device command service is not configured.', request_id: requestId });
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
        throw new NagexError({ code: 'ACCESSIBILITY_ACTION_NOT_ALLOWED', category: 'POLICY', message: 'Only SELECT_KAKAO_DIRECT_CONVERSATION is supported for compatibility accessibility plans.', request_id: requestId });
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

    const steps = Array.isArray(body?.steps) ? body.steps : [];
    const result = deviceCommandService.enqueueAccessibilityPlan({
      tenantId: session.tenantId,
      principalId: session.principalId,
      requestId,
      deviceId: typeof body?.deviceId === 'string' ? body.deviceId : '',
      approvalRef: typeof body?.approvalRef === 'string' ? body.approvalRef : '',
      recipientRef: typeof body?.recipientRef === 'string' ? body.recipientRef : '',
      targetPackage: typeof body?.targetPackage === 'string' ? body.targetPackage : '',
      targetAppVersion: typeof body?.targetAppVersion === 'string' ? body.targetAppVersion : '',
      route: typeof body?.route === 'string' ? body.route : '',
      planId: typeof body?.planId === 'string' ? body.planId : '',
      approvedPayloadHash: typeof body?.approvedPayloadHash === 'string' ? body.approvedPayloadHash : '',
      approvedText: typeof body?.approvedText === 'string' ? body.approvedText : undefined,
      messageHash: typeof body?.messageHash === 'string' ? body.messageHash : '',
      displayName: typeof body?.displayName === 'string' ? body.displayName : '',
      expiresAt: typeof body?.expiresAt === 'string' ? body.expiresAt : '',
      steps: steps as any,
      budget: body?.budget && typeof body.budget === 'object' && !Array.isArray(body.budget) ? body.budget as Record<string, unknown> : undefined,
    });
    return {
      status: result.status === 'QUEUED' ? 202 : 200,
      data: {
        status: result.status,
        commandId: result.command.commandId,
        planId: result.command.data.planId,
        commandType: result.command.commandType,
        deviceId: result.command.deviceId,
        queuedAt: result.command.queuedAt,
      },
    };
  }

  if (pathname === '/api/v1/device-agent/accessibility-send-plans' && method === 'POST') {
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
    const sessionId = getSessionIdFromHeaders(headers);
    const session = sessionId ? sessionStore.getSession(sessionId) : null;
    if (!session) {
      throw new NagexError({ code: 'DEVICE_COMMAND_AUTH_REQUIRED', category: 'AUTHENTICATION', message: 'A valid authenticated session is required to enqueue an accessibility send plan.', request_id: requestId });
    }
    const { devicePendingCommandStore, deviceCommandStatusStore, kakaoAccessibilityApprovalService } = deps;
    if (!devicePendingCommandStore || !kakaoAccessibilityApprovalService) {
      throw new NagexError({ code: 'DEVICE_COMMAND_SERVICE_UNAVAILABLE', category: 'INTERNAL', message: 'Legacy Kakao send compatibility dependencies are not configured.', request_id: requestId });
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

  return undefined;
};

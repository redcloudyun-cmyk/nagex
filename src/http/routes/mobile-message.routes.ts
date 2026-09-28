// R23.6M Phase C — mobile SMS message lifecycle routes.
//
// Every route here requires a real, validated session (Authorization:
// Bearer <sessionId> or the nagex_session cookie, checked against
// SessionStore.getSession()) — never the x-nagex-tenant/x-principal-id
// headers the pre-existing (Phase B3) contacts/resolve route still uses.
// This was an explicit instruction for all new Phase C mobile endpoints,
// narrowing the same real security gap the Phase B4 enrollment fix
// addressed, one route family at a time.
//
// deviceId is client-supplied but never trusted at face value: every
// route below re-validates it against DeviceIdentityStore (must exist,
// must belong to this exact session's tenant/owner, must be ACTIVE)
// before doing anything else — mirrors the enrollment route's own
// pattern, applied here to prevent a session from creating/approving a
// message run against a device it does not own or that has been revoked.
import crypto from 'node:crypto';
import { NagexError } from '../../common/errors.js';
import type { DeviceIdentityStore } from '../../device-agent/device-identity.store.js';
import type { SessionStore } from '../../sessions/session.store.js';
import type { MobileMessageRunService } from '../../mobile/mobile-message-run.service.js';
import { getSessionIdFromHeaders } from './auth.routes.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';
// R23.6M Phase D1 — real production wiring: draft creation resolves a
// channel through the canonical ExecutionRouteResolver/MessagingAdapterRegistry
// boundary before calling the unchanged MobileMessageRunService.createDraft().
// In D1 this always resolves SMS (the only registered adapter) — the point
// is that the resolver/registry/adapter chain is genuinely on the real
// request path, not a dead file nothing calls.
import type { ExecutionRouteResolver } from '../../messaging/execution-route-resolver.js';
import { parseOptionalMessagingChannel } from '../../messaging/messaging-channel.js';

function getHeaderValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export interface MobileMessageRouteDeps {
  sessionStore: SessionStore;
  deviceIdentityStore: DeviceIdentityStore;
  mobileMessageRunService: MobileMessageRunService;
  executionRouteResolver: ExecutionRouteResolver;
}

interface AuthedSession {
  tenantId: string;
  ownerId: string;
}

function requireSession(headers: Record<string, string | string[] | undefined>, sessionStore: SessionStore, requestId: string): AuthedSession {
  const sessionId = getSessionIdFromHeaders(headers);
  const session = sessionId ? sessionStore.getSession(sessionId) : null;
  if (!session) {
    throw new NagexError({ code: 'MOBILE_MESSAGE_AUTH_REQUIRED', category: 'AUTHENTICATION', message: 'A valid authenticated session is required.', request_id: requestId });
  }
  return { tenantId: session.tenantId, ownerId: session.principalId };
}

function requireOwnedActiveDevice(deviceIdentityStore: DeviceIdentityStore, deviceId: string, tenantId: string, ownerId: string, requestId: string): void {
  const device = deviceIdentityStore.getOwned(deviceId, tenantId, ownerId);
  if (!device) {
    throw new NagexError({ code: 'MOBILE_MESSAGE_DEVICE_NOT_FOUND', category: 'NOT_FOUND', message: `Device ${deviceId} was not found.`, request_id: requestId });
  }
  if (device.status !== 'ACTIVE') {
    throw new NagexError({ code: 'MOBILE_MESSAGE_DEVICE_REVOKED', category: 'AUTHORIZATION', message: `Device ${deviceId} is not active.`, request_id: requestId });
  }
}

const BASE_PATH = '/api/v1/mobile/messages';

export const handleMobileMessageRoutes: AsyncRouteRegistrar<MobileMessageRouteDeps> = async (method, pathname, body, headers, _query, deps): Promise<ApiResult | undefined> => {
  const { sessionStore, deviceIdentityStore, mobileMessageRunService, executionRouteResolver } = deps;
  const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;

  if (pathname === BASE_PATH && method === 'POST') {
    const { tenantId, ownerId } = requireSession(headers, sessionStore, requestId);
    const deviceId = typeof body?.deviceId === 'string' ? body.deviceId : '';
    const recipientRef = typeof body?.recipientRef === 'string' ? body.recipientRef : '';
    const message = typeof body?.message === 'string' ? body.message : '';
    if (!deviceId || !recipientRef) {
      throw new NagexError({ code: 'MOBILE_MESSAGE_FIELDS_REQUIRED', category: 'VALIDATION', message: 'deviceId and recipientRef are required.', request_id: requestId });
    }
    requireOwnedActiveDevice(deviceIdentityStore, deviceId, tenantId, ownerId, requestId);

    // R23.6M Phase D1 — optional, additive field. Existing clients that
    // omit it (every Phase C caller) get the exact same behavior as
    // before: the resolver has only one registered adapter (SMS), so it
    // always resolves SMS. An explicit, unsupported channel (e.g.
    // "KAKAOTALK" in D1) fails closed here — MESSAGING_CHANNEL_UNSUPPORTED
    // — and is never silently downgraded to SMS.
    const preferredChannel = parseOptionalMessagingChannel(body?.preferredChannel, requestId);

    const resolved = await executionRouteResolver.resolve({
      recipientRef,
      message,
      preferredChannel,
      tenantId,
      ownerId,
      deviceId,
      locale: getHeaderValue(headers, 'x-nagex-locale') || 'ko-KR',
      requestId,
    });
    // Defensive, not load-bearing: D1's registry can only ever resolve
    // SMS, so this can never actually fail — it documents that invariant
    // rather than silently trusting it.
    if (resolved.channel !== 'SMS' || resolved.route !== 'ANDROID_SMS_MANAGER') {
      throw new NagexError({ code: 'MESSAGING_UNEXPECTED_RESOLUTION', category: 'INTERNAL', message: `Resolver returned unexpected channel/route: ${resolved.channel}/${resolved.route}.`, request_id: requestId });
    }
    await resolved.adapter.checkCapability({ recipientRef, message, preferredChannel, tenantId, ownerId, deviceId, locale: 'ko-KR', requestId });

    const run = mobileMessageRunService.createDraft({ tenantId, ownerId, deviceId, requestId, recipientRef, message });
    return { status: 201, data: run };
  }

  const getMatch = pathname.match(new RegExp(`^${BASE_PATH}/([^/]+)$`));
  if (getMatch && method === 'GET') {
    const { tenantId, ownerId } = requireSession(headers, sessionStore, requestId);
    const runId = decodeURIComponent(getMatch[1]);
    let run = mobileMessageRunService.getOwnedRun(runId, tenantId, ownerId);
    if (!run) {
      throw new NagexError({ code: 'MOBILE_MESSAGE_RUN_NOT_FOUND', category: 'NOT_FOUND', message: `Run ${runId} was not found.`, request_id: requestId });
    }
    // A status read while APPROVAL_REQUIRED also refreshes from the real,
    // live ActionApprovalStore state — never auto-approves anything;
    // confirmApproval() only ever reflects a decision that already
    // happened via the real approve/reject routes.
    if (run.status === 'APPROVAL_REQUIRED') {
      run = mobileMessageRunService.confirmApproval(runId, tenantId, ownerId, requestId);
    }
    return { status: 200, data: run };
  }

  if (getMatch && method === 'PATCH') {
    const { tenantId, ownerId } = requireSession(headers, sessionStore, requestId);
    const runId = decodeURIComponent(getMatch[1]);
    const message = typeof body?.message === 'string' ? body.message : '';
    if (!message) {
      throw new NagexError({ code: 'MOBILE_MESSAGE_REQUIRED', category: 'VALIDATION', message: 'message is required.', request_id: requestId });
    }
    const run = mobileMessageRunService.updateDraftMessage(runId, tenantId, ownerId, requestId, message);
    return { status: 200, data: run };
  }

  const approvalMatch = pathname.match(new RegExp(`^${BASE_PATH}/([^/]+)/request-approval$`));
  if (approvalMatch && method === 'POST') {
    const { tenantId, ownerId } = requireSession(headers, sessionStore, requestId);
    const runId = decodeURIComponent(approvalMatch[1]);
    const run = mobileMessageRunService.requestApproval(runId, tenantId, ownerId, requestId);
    return { status: 200, data: run };
  }

  return undefined;
};

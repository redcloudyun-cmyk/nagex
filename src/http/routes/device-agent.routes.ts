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
import type { DeviceIdentityStore } from '../../device-agent/device-identity.store.js';
import type { SessionStore } from '../../sessions/session.store.js';
import { getSessionIdFromHeaders } from './auth.routes.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';

function getHeaderValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export interface DeviceAgentRouteDeps {
  deviceAgentTransportEndpoint: DeviceAgentTransportEndpoint;
  deviceIdentityStore: DeviceIdentityStore;
  sessionStore: SessionStore;
}

export const handleDeviceAgentRoutes: AsyncRouteRegistrar<DeviceAgentRouteDeps> = async (method, pathname, body, headers, _query, deps): Promise<ApiResult | undefined> => {
  const { deviceAgentTransportEndpoint, deviceIdentityStore, sessionStore } = deps;

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

  return undefined;
};

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
// ever be enrolled by hand-writing a record file. /enroll is the ordinary,
// authenticated-user-session route (x-nagex-tenant/x-principal-id, same
// convention as every other non-device-transport route) a logged-in user's
// device — desktop OR Android; this route is not mobile-specific — calls
// once, submitting the public half of a keypair IT generated locally and
// never transmits the private half. This is intentionally the only place
// a DeviceIdentityRecord is created; every device (Windows agent, Android
// companion app, or any future platform) enrolls exactly the same way.
import crypto from 'node:crypto';
import { NagexError } from '../../common/errors.js';
import type { DeviceAgentTransportEndpoint } from '../../device-agent/device-agent-transport-endpoint.service.js';
import type { DeviceIdentityStore } from '../../device-agent/device-identity.store.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';

function getHeaderValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export interface DeviceAgentRouteDeps {
  deviceAgentTransportEndpoint: DeviceAgentTransportEndpoint;
  deviceIdentityStore: DeviceIdentityStore;
}

export const handleDeviceAgentRoutes: AsyncRouteRegistrar<DeviceAgentRouteDeps> = async (method, pathname, body, headers, _query, deps): Promise<ApiResult | undefined> => {
  const { deviceAgentTransportEndpoint, deviceIdentityStore } = deps;

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
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant');
    const ownerId = getHeaderValue(headers, 'x-principal-id');
    if (!tenantId || !ownerId) {
      throw new NagexError({ code: 'DEVICE_ENROLL_AUTH_REQUIRED', category: 'VALIDATION', message: 'x-nagex-tenant and x-principal-id are required.', request_id: requestId });
    }
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

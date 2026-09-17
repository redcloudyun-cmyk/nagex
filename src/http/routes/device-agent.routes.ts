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
import crypto from 'node:crypto';
import { NagexError } from '../../common/errors.js';
import type { DeviceAgentTransportEndpoint } from '../../device-agent/device-agent-transport-endpoint.service.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';

function getHeaderValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export interface DeviceAgentRouteDeps {
  deviceAgentTransportEndpoint: DeviceAgentTransportEndpoint;
}

export const handleDeviceAgentRoutes: AsyncRouteRegistrar<DeviceAgentRouteDeps> = async (method, pathname, body, headers, _query, deps): Promise<ApiResult | undefined> => {
  const { deviceAgentTransportEndpoint } = deps;

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

  return undefined;
};

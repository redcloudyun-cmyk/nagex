// R23.6M Phase B3 — mobile contact-resolution route.
//
// Deliberately separate from device-agent.routes.ts's signed-envelope
// transport: contact resolution is a read-oriented query, not a device
// execution command, so it uses the same authenticated tenant/principal
// header convention as every other ordinary API route (matching
// competitor-pricing-agent.routes.ts) rather than requiring a full
// Ed25519-signed envelope for a query with no execution side effect.
// Device ownership/status is still verified explicitly below — a revoked
// or not-owned deviceId is rejected before ContactResolver ever runs, so
// this route cannot be used to act as, or read for, a device the caller
// does not actually own.
import crypto from 'node:crypto';
import { NagexError } from '../../common/errors.js';
import type { DeviceIdentityStore } from '../../device-agent/device-identity.store.js';
import type { ContactResolver } from '../../mobile/contact-resolver.service.js';
import { isMobileContactCandidateInput, type MobileContactCandidateInput } from '../../mobile/contact-resolution.types.js';
import type { ApiResult, SyncRouteRegistrar } from '../http-types.js';

function getHeaderValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export interface MobileDeviceRouteDeps {
  deviceIdentityStore: DeviceIdentityStore;
  contactResolver: ContactResolver;
}

const CONTACTS_RESOLVE_PATH = '/api/v1/mobile/contacts/resolve';

export const handleMobileDeviceRoutes: SyncRouteRegistrar<MobileDeviceRouteDeps> = (method, pathname, body, headers, _query, deps): ApiResult | undefined => {
  const { deviceIdentityStore, contactResolver } = deps;

  if (pathname === CONTACTS_RESOLVE_PATH && method === 'POST') {
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant');
    const ownerId = getHeaderValue(headers, 'x-principal-id');
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
    if (!tenantId || !ownerId) {
      throw new NagexError({ code: 'MOBILE_CONTACT_RESOLVE_AUTH_REQUIRED', category: 'VALIDATION', message: 'x-nagex-tenant and x-principal-id are required.', request_id: requestId });
    }

    const deviceId = typeof body?.deviceId === 'string' ? body.deviceId : '';
    const spokenName = typeof body?.spokenName === 'string' ? body.spokenName : '';
    const rawCandidates = Array.isArray(body?.candidates) ? body.candidates : [];
    if (!deviceId) {
      throw new NagexError({ code: 'MOBILE_CONTACT_DEVICE_ID_REQUIRED', category: 'VALIDATION', message: 'deviceId is required.', request_id: requestId });
    }

    // Fail closed on device ownership/status BEFORE any candidate is ever
    // considered — a revoked device, or a deviceId belonging to a
    // different tenant/owner, is rejected identically to how every other
    // device-scoped operation in this codebase already fails closed.
    const device = deviceIdentityStore.getOwned(deviceId, tenantId, ownerId);
    if (!device) {
      throw new NagexError({ code: 'MOBILE_DEVICE_NOT_FOUND', category: 'NOT_FOUND', message: `Device ${deviceId} was not found.`, request_id: requestId });
    }
    if (device.status !== 'ACTIVE') {
      throw new NagexError({ code: 'MOBILE_DEVICE_REVOKED', category: 'AUTHORIZATION', message: `Device ${deviceId} is not active.`, request_id: requestId });
    }

    const candidates: MobileContactCandidateInput[] = rawCandidates.filter(isMobileContactCandidateInput);

    const result = contactResolver.resolve({ tenantId, ownerId, deviceId, spokenName, candidates, requestId });
    return { status: 200, data: result };
  }

  return undefined;
};

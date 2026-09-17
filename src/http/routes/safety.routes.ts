// R10.2-D Increment 5 — Trust & Safety layer routes (TS-5, TS-6),
// extracted verbatim from server_web.ts's handleAsyncApiRequest.
// SafetyEngine.getInstance() and PersistentSafetyStore are the existing,
// unchanged singleton/store this domain already used — this move
// relocates the HTTP translation only, no safety logic changed.
import { SafetyEngine } from '../../governance/safety.engine.js';
import { PersistentSafetyStore } from '../../governance/safety.store.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';

function getHeaderValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export const handleSafetyRoutes: AsyncRouteRegistrar<Record<string, never>> = async (method, pathname, body, headers): Promise<ApiResult | undefined> => {
  if (pathname === '/api/v1/safety/evaluate' && method === 'POST') {
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || 'usr_default';
    const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const input = (body?.input as string) || '';
    const domain = body?.domain as string | undefined;
    const decision = await SafetyEngine.getInstance().evaluateIntent({
      input,
      domain,
      tenantId,
      userId: principalId,
    });
    return { status: 200, data: decision };
  }
  if (pathname === '/api/v1/safety/events' && method === 'GET') {
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || 'usr_default';
    const safetyStore = new PersistentSafetyStore();
    const events = await safetyStore.getEvents(tenantId);
    return { status: 200, data: { events, total: events.length } };
  }
  if (pathname === '/api/v1/safety/status' && method === 'GET') {
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || 'usr_default';
    const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const safetyStore = new PersistentSafetyStore();
    const userStatus = await safetyStore.getUserStatus(tenantId, principalId);
    return { status: 200, data: userStatus };
  }

  return undefined;
};

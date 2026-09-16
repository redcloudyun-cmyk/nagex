// R10.2-D Increment 4 — Google Calendar routes, extracted verbatim from
// server_web.ts's handleAsyncApiRequest. The four mutation routes
// (create/update/cancel/respond-to-event) all require a pre-existing
// approvalId and call GoogleCalendarService.executeXxx(), which is built
// on R10.2-B's GoogleCapabilityExecutionPipeline — the canonical,
// approval-gated execution chokepoint for all Calendar mutations. This
// module never constructs a payload write itself and never imports
// calendar.client.ts directly.
//
// free-slots is the one READ_ONLY exception that legitimately calls
// queryFreeBusy/computeFreeSlots (the module's real public read API, not a
// mutation client) and refreshes its own OAuth token via fetch — this is
// the exact pre-existing behavior, unchanged, and is why this file (and
// only this file) is named in the Increment 4 "no raw fetch()" guard's
// documented exception (see tests/http_route_modularization.test.ts).
import crypto from 'node:crypto';
import { NagexError } from '../../common/errors.js';
import { DEFAULT_GOOGLE_TENANT_ID, googleTokenStore } from '../../integrations/google/token.store.js';
import { readGoogleOAuthConfig } from '../../integrations/google/oauth.client.js';
import { queryFreeBusy, computeFreeSlots, type GoogleCalendarService } from '../../modules/calendar/index.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';

function getHeaderValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export interface CalendarRouteDeps {
  calendarService: GoogleCalendarService;
}

export const handleCalendarRoutes: AsyncRouteRegistrar<CalendarRouteDeps> = async (method, pathname, body, headers, _query, deps): Promise<ApiResult | undefined> => {
  const { calendarService } = deps;

  if (pathname === '/api/v1/tools/google-calendar/create-event' && method === 'POST') {
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
    const approvalId = typeof body?.approvalId === 'string' ? body.approvalId : '';
    if (!approvalId) throw new NagexError({ code: 'APPROVAL_ID_REQUIRED', category: 'VALIDATION', message: 'approvalId is required.', request_id: requestId });
    const result = await calendarService.executeCreateEvent({ approvalId, payload: body?.payload, tenantId, principalId, requestId });
    return { status: 200, data: result };
  }

  if (pathname === '/api/v1/tools/google-calendar/update-event' && method === 'POST') {
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
    const approvalId = typeof body?.approvalId === 'string' ? body.approvalId : '';
    if (!approvalId) throw new NagexError({ code: 'APPROVAL_ID_REQUIRED', category: 'VALIDATION', message: 'approvalId is required.', request_id: requestId });
    const result = await calendarService.executeUpdateEvent({ approvalId, payload: body?.payload, tenantId, principalId, requestId });
    return { status: 200, data: result };
  }

  if (pathname === '/api/v1/tools/google-calendar/cancel-event' && method === 'POST') {
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
    const approvalId = typeof body?.approvalId === 'string' ? body.approvalId : '';
    if (!approvalId) throw new NagexError({ code: 'APPROVAL_ID_REQUIRED', category: 'VALIDATION', message: 'approvalId is required.', request_id: requestId });
    const result = await calendarService.executeCancelEvent({ approvalId, payload: body?.payload, tenantId, principalId, requestId });
    return { status: 200, data: result };
  }

  if (pathname === '/api/v1/tools/google-calendar/respond-to-event' && method === 'POST') {
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
    const approvalId = typeof body?.approvalId === 'string' ? body.approvalId : '';
    if (!approvalId) throw new NagexError({ code: 'APPROVAL_ID_REQUIRED', category: 'VALIDATION', message: 'approvalId is required.', request_id: requestId });
    const result = await calendarService.executeRespondToEvent({ approvalId, payload: body?.payload, tenantId, principalId, requestId });
    return { status: 200, data: result };
  }

  if (pathname === '/api/v1/tools/google-calendar/free-slots' && method === 'POST') {
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
    const config = readGoogleOAuthConfig();
    const accessToken = config ? await googleTokenStore.getValidAccessToken(tenantId, config, fetch, requestId) : null;
    if (!accessToken) throw new NagexError({ code: 'GOOGLE_CALENDAR_DISCONNECTED', category: 'POLICY', message: 'Google Calendar is not connected.', request_id: requestId });
    const calendarId = (typeof body?.calendarId === 'string' && body.calendarId) || 'primary';
    const timeMin = typeof body?.timeMin === 'string' ? body.timeMin : new Date().toISOString();
    const timeMax = typeof body?.timeMax === 'string' ? body.timeMax : new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    const busy = await queryFreeBusy(accessToken, { calendarId, timeMin, timeMax }, fetch, requestId);
    return { status: 200, data: { busy, freeSlots: computeFreeSlots(busy, timeMin, timeMax) } };
  }

  return undefined;
};

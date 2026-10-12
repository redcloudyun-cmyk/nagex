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
import type { GoogleCalendarConnectionService } from '../../integrations/google/calendar-connection.js';
import type { GoogleCalendarService } from '../../modules/calendar/index.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';
import { callerIdentity } from '../request-identity.js';

function getHeaderValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export interface CalendarRouteDeps {
  calendarService: GoogleCalendarService;
  calendarConnection?: GoogleCalendarConnectionService;
}

export const handleCalendarRoutes: AsyncRouteRegistrar<CalendarRouteDeps> = async (method, pathname, body, headers, _query, deps): Promise<ApiResult | undefined> => {
  const { calendarService, calendarConnection } = deps;

  if (pathname === '/api/v1/tools/google-calendar/create-event' && method === 'POST') {
    const tenantId = callerIdentity(headers).tenantId;
    const principalId = callerIdentity(headers).principalId;
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
    const approvalId = typeof body?.approvalId === 'string' ? body.approvalId : '';
    if (!approvalId) throw new NagexError({ code: 'APPROVAL_ID_REQUIRED', category: 'VALIDATION', message: 'approvalId is required.', request_id: requestId });
    const result = await calendarService.executeCreateEvent({ approvalId, payload: body?.payload, tenantId, principalId, requestId });
    return { status: 200, data: result };
  }

  if (pathname === '/api/v1/tools/google-calendar/update-event' && method === 'POST') {
    const tenantId = callerIdentity(headers).tenantId;
    const principalId = callerIdentity(headers).principalId;
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
    const approvalId = typeof body?.approvalId === 'string' ? body.approvalId : '';
    if (!approvalId) throw new NagexError({ code: 'APPROVAL_ID_REQUIRED', category: 'VALIDATION', message: 'approvalId is required.', request_id: requestId });
    const result = await calendarService.executeUpdateEvent({ approvalId, payload: body?.payload, tenantId, principalId, requestId });
    return { status: 200, data: result };
  }

  if (pathname === '/api/v1/tools/google-calendar/cancel-event' && method === 'POST') {
    const tenantId = callerIdentity(headers).tenantId;
    const principalId = callerIdentity(headers).principalId;
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
    const approvalId = typeof body?.approvalId === 'string' ? body.approvalId : '';
    if (!approvalId) throw new NagexError({ code: 'APPROVAL_ID_REQUIRED', category: 'VALIDATION', message: 'approvalId is required.', request_id: requestId });
    const result = await calendarService.executeCancelEvent({ approvalId, payload: body?.payload, tenantId, principalId, requestId });
    return { status: 200, data: result };
  }

  if (pathname === '/api/v1/tools/google-calendar/respond-to-event' && method === 'POST') {
    const tenantId = callerIdentity(headers).tenantId;
    const principalId = callerIdentity(headers).principalId;
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
    const approvalId = typeof body?.approvalId === 'string' ? body.approvalId : '';
    if (!approvalId) throw new NagexError({ code: 'APPROVAL_ID_REQUIRED', category: 'VALIDATION', message: 'approvalId is required.', request_id: requestId });
    const result = await calendarService.executeRespondToEvent({ approvalId, payload: body?.payload, tenantId, principalId, requestId });
    return { status: 200, data: result };
  }

  if (pathname === '/api/v1/tools/google-calendar/free-slots' && method === 'POST') {
    const tenantId = callerIdentity(headers).tenantId;
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
    const principalId = callerIdentity(headers).principalId;
    const calendarId = (typeof body?.calendarId === 'string' && body.calendarId) || 'primary';
    const timeMin = typeof body?.timeMin === 'string' ? body.timeMin : new Date().toISOString();
    const timeMax = typeof body?.timeMax === 'string' ? body.timeMax : new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    // Same credential-brokered, principal-bound path as every other calendar read (no second Google client here).
    const result = await calendarService.getFreeSlots({ tenantId, principalId, calendarId, timeMin, timeMax, requestId });
    return { status: 200, data: { busy: result.busy, freeSlots: result.slots } };
  }

  if (pathname === '/api/v1/calendar/upcoming' && method === 'GET') {
    // Identity comes from the verified session only. The answer states WHY there are no events (not connected,
    // must reconnect, Google failed) instead of a bare connected:false, and carries the user's real events.
    const identity = callerIdentity(headers);
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_${crypto.randomUUID()}`;
    if (!calendarConnection) throw new NagexError({ code: 'CALENDAR_CONNECTION_NOT_CONFIGURED', category: 'RUNTIME', message: 'Calendar connection status is not available.', request_id: requestId });
    const now = new Date();
    const result = await calendarConnection.readEvents(
      { tenantId: identity.tenantId, principalId: identity.principalId, requestId },
      { timeMin: now.toISOString(), timeMax: new Date(now.getTime() + 7 * 24 * 3600 * 1000).toISOString(), maxResults: 20 },
    );
    const { connection } = result;
    const providerFailed = connection.state === 'ERROR';
    return {
      status: providerFailed ? (connection.reason === 'PROVIDER_TIMEOUT' ? 504 : 502) : 200,
      data: {
        events: result.events,
        connected: connection.state === 'CONNECTED',
        connection,
        message: connection.state === 'CONNECTED' ? (result.events.length ? null : 'No upcoming events.') : connection.message,
        ...(providerFailed ? { error: { code: connection.reason, message: connection.message, retryable: connection.retryable } } : {}),
      },
    };
  }

  return undefined;
};

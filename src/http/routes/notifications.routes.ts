// R10.2-D Increment 2 — Notification routes, extracted verbatim from
// server_web.ts's handleAsyncApiRequest. Read/mark-read/mark-all-read/
// dispatch — no approval gate (notifications have never required one),
// tenant/principal-scoped throughout. `notificationEngine` is the
// caller's own (possibly test-overridden) parameter — built into deps
// per-call, never captured at module load, exactly like every other
// R10.2-D registrar.
import crypto from 'node:crypto';
import { NagexError } from '../../common/errors.js';
import type { NotificationEngine } from '../../notifications/notification.engine.js';
import type { NotificationType } from '../../notifications/notification.store.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';
import { callerIdentity } from '../request-identity.js';

function getHeaderValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export interface NotificationsRouteDeps {
  notificationEngine: NotificationEngine;
}

export const handleNotificationsRoutes: AsyncRouteRegistrar<NotificationsRouteDeps> = async (method, pathname, body, headers, _query, deps): Promise<ApiResult | undefined> => {
  const { notificationEngine } = deps;

  if (pathname === '/api/v1/notifications' && method === 'GET') {
    const tenantId = callerIdentity(headers).tenantId;
    const principalId = callerIdentity(headers).principalId;
    const notifications = notificationEngine.list(tenantId, principalId);
    const unreadCount = notificationEngine.getUnreadCount(tenantId, principalId);
    return { status: 200, data: { notifications, unreadCount, total: notifications.length } };
  }
  if (pathname === '/api/v1/notifications/read-all' && method === 'POST') {
    const tenantId = callerIdentity(headers).tenantId;
    const principalId = callerIdentity(headers).principalId;
    const updatedCount = notificationEngine.markAllAsRead(tenantId, principalId);
    return { status: 200, data: { success: true, updatedCount } };
  }
  if (pathname.startsWith('/api/v1/notifications/') && pathname.endsWith('/read') && method === 'POST') {
    const tenantId = callerIdentity(headers).tenantId;
    const principalId = callerIdentity(headers).principalId;
    const id = pathname.slice('/api/v1/notifications/'.length, pathname.length - '/read'.length);
    const record = notificationEngine.markAsRead(id, tenantId, principalId);
    if (!record) {
      return { status: 404, data: { error: { code: 'NOTIFICATION_NOT_FOUND', category: 'NOT_FOUND', message: `Notification ${id} was not found.` } } };
    }
    return { status: 200, data: record };
  }
  if (pathname === '/api/v1/notifications/dispatch' && method === 'POST') {
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_notif_disp_${crypto.randomUUID()}`;
    // S2C — the recipient is the AUTHENTICATED CALLER. A principalId/tenantId in the body is at most a redundant assertion; a
    // different one is refused by the engine before any notification is written or any channel is invoked.
    const caller = callerIdentity(headers);
    const type = (typeof body?.type === 'string' ? body.type : 'SYSTEM_ALERT') as NotificationType;
    const title = typeof body?.title === 'string' ? body.title.trim() : 'Notification';
    const bodyText = typeof body?.body === 'string' ? body.body.trim() : '';

    if (!bodyText) {
      throw new NagexError({ code: 'NOTIFICATION_BODY_REQUIRED', category: 'VALIDATION', message: 'Notification body is required.', request_id: requestId });
    }

    const record = await notificationEngine.dispatchForCaller({ tenantId: caller.tenantId, principalId: caller.principalId }, {
      type,
      title,
      body: bodyText,
      metadata: body?.metadata && typeof body.metadata === 'object' ? (body.metadata as Record<string, unknown>) : undefined,
      requestId,
      assertedPrincipalId: body?.principalId,
      assertedTenantId: body?.tenantId,
    });
    return { status: 201, data: record };
  }

  return undefined;
};

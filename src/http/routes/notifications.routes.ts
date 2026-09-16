// R10.2-D Increment 2 — Notification routes, extracted verbatim from
// server_web.ts's handleAsyncApiRequest. Read/mark-read/mark-all-read/
// dispatch — no approval gate (notifications have never required one),
// tenant/principal-scoped throughout. `notificationEngine` is the
// caller's own (possibly test-overridden) parameter — built into deps
// per-call, never captured at module load, exactly like every other
// R10.2-D registrar.
import crypto from 'node:crypto';
import { NagexError } from '../../common/errors.js';
import { DEFAULT_GOOGLE_TENANT_ID } from '../../integrations/google/token.store.js';
import type { NotificationEngine } from '../../notifications/notification.engine.js';
import type { NotificationType } from '../../notifications/notification.store.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';

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
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const notifications = notificationEngine.list(tenantId, principalId);
    const unreadCount = notificationEngine.getUnreadCount(tenantId, principalId);
    return { status: 200, data: { notifications, unreadCount, total: notifications.length } };
  }
  if (pathname === '/api/v1/notifications/read-all' && method === 'POST') {
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const updatedCount = notificationEngine.markAllAsRead(tenantId, principalId);
    return { status: 200, data: { success: true, updatedCount } };
  }
  if (pathname.startsWith('/api/v1/notifications/') && pathname.endsWith('/read') && method === 'POST') {
    const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
    const principalId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';
    const id = pathname.slice('/api/v1/notifications/'.length, pathname.length - '/read'.length);
    const record = notificationEngine.markAsRead(id, tenantId, principalId);
    if (!record) {
      return { status: 404, data: { error: { code: 'NOTIFICATION_NOT_FOUND', category: 'NOT_FOUND', message: `Notification ${id} was not found.` } } };
    }
    return { status: 200, data: record };
  }
  if (pathname === '/api/v1/notifications/dispatch' && method === 'POST') {
    const requestId = getHeaderValue(headers, 'x-request-id') || `req_notif_disp_${crypto.randomUUID()}`;
    const principalId = typeof body?.principalId === 'string' && body.principalId.trim() ? body.principalId.trim() : (getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001');
    const tenantId = typeof body?.tenantId === 'string' && body.tenantId.trim() ? body.tenantId.trim() : (getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID);
    const type = (typeof body?.type === 'string' ? body.type : 'SYSTEM_ALERT') as NotificationType;
    const title = typeof body?.title === 'string' ? body.title.trim() : 'Notification';
    const bodyText = typeof body?.body === 'string' ? body.body.trim() : '';

    if (!bodyText) {
      throw new NagexError({ code: 'NOTIFICATION_BODY_REQUIRED', category: 'VALIDATION', message: 'Notification body is required.', request_id: requestId });
    }

    const record = await notificationEngine.dispatch({
      tenantId,
      principalId,
      type,
      title,
      body: bodyText,
      metadata: body?.metadata && typeof body.metadata === 'object' ? (body.metadata as Record<string, unknown>) : undefined,
      requestId,
    });
    return { status: 201, data: record };
  }

  return undefined;
};

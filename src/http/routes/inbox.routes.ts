// R18 — Inbox HTTP Route Module
import { DEFAULT_GOOGLE_TENANT_ID } from '../../integrations/google/token.store.js';
import { NagexError } from '../../common/errors.js';
import type { InboxStore } from '../../workspace/inbox.store.js';
import type { VaultStore } from '../../workspace/vault.store.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';

function getHeaderValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export interface InboxRouteDeps {
  inboxStore: InboxStore;
  vaultStore: VaultStore;
}

export const handleInboxRoutes: AsyncRouteRegistrar<InboxRouteDeps> = async (method, pathname, body, headers, _query, deps): Promise<ApiResult | undefined> => {
  const { inboxStore, vaultStore } = deps;
  const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
  const userId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';

  if (pathname === '/api/v1/workspace/inbox' && method === 'GET') {
    const items = inboxStore.listItems(tenantId, userId);
    const unreadCount = items.filter((i) => i.status === 'NEW').length;
    return { status: 200, data: { items, unreadCount, total: items.length } };
  }

  if (pathname.startsWith('/api/v1/workspace/inbox/') && !pathname.endsWith('/archive') && !pathname.endsWith('/save-to-vault') && pathname !== '/api/v1/workspace/inbox/capture' && method === 'GET') {
    const inboxItemId = pathname.slice('/api/v1/workspace/inbox/'.length);
    const item = inboxStore.getItem(inboxItemId, tenantId, userId);
    if (!item) {
      return { status: 404, data: { error: 'INBOX_ITEM_NOT_FOUND', message: `Inbox item ${inboxItemId} not found.` } };
    }
    return { status: 200, data: item };
  }

  if (pathname === '/api/v1/workspace/inbox/capture' && method === 'POST') {
    const title = typeof body?.title === 'string' ? body.title : 'New Quick Capture';
    const item = inboxStore.createItem({
      tenantId,
      userId,
      sourceType: typeof body?.sourceType === 'string' ? (body.sourceType as any) : 'MANUAL_CAPTURE',
      title,
      summary: typeof body?.summary === 'string' ? body.summary : undefined,
      contentRef: typeof body?.contentRef === 'string' ? body.contentRef : undefined,
      priority: typeof body?.priority === 'string' ? (body.priority as any) : 'MEDIUM',
    });
    return { status: 201, data: item };
  }

  if (pathname.startsWith('/api/v1/workspace/inbox/') && pathname.endsWith('/archive') && method === 'POST') {
    const inboxItemId = pathname.slice('/api/v1/workspace/inbox/'.length, pathname.length - '/archive'.length);
    const updated = inboxStore.updateStatus(inboxItemId, tenantId, userId, 'ARCHIVED');
    if (!updated) {
      return { status: 404, data: { error: 'INBOX_ITEM_NOT_FOUND', message: `Inbox item ${inboxItemId} not found.` } };
    }
    return { status: 200, data: updated };
  }

  if (pathname.startsWith('/api/v1/workspace/inbox/') && pathname.endsWith('/save-to-vault') && method === 'POST') {
    const inboxItemId = pathname.slice('/api/v1/workspace/inbox/'.length, pathname.length - '/save-to-vault'.length);
    const inboxItem = inboxStore.getItem(inboxItemId, tenantId, userId);
    if (!inboxItem) {
      return { status: 404, data: { error: 'INBOX_ITEM_NOT_FOUND', message: `Inbox item ${inboxItemId} not found.` } };
    }

    const vaultItem = vaultStore.saveItem({
      tenantId,
      userId,
      workspaceId: inboxItem.workspaceId,
      type: inboxItem.sourceType === 'UPLOADED_FILE' ? 'FILE' : inboxItem.sourceType === 'WEB_LINK' ? 'LINK' : 'DOCUMENT',
      title: inboxItem.title,
      storageRef: inboxItem.contentRef || `ref_${inboxItemId}`,
      source: 'INBOX_SAVE',
      sourceRef: inboxItemId,
      metadata: { originalSourceType: inboxItem.sourceType },
    });

    inboxStore.updateStatus(inboxItemId, tenantId, userId, 'ACTIONED');
    return { status: 201, data: { vaultItem, inboxItem } };
  }

  if (pathname.startsWith('/api/v1/workspace/inbox/') && method === 'DELETE') {
    const inboxItemId = pathname.slice('/api/v1/workspace/inbox/'.length);
    const deleted = inboxStore.deleteItem(inboxItemId, tenantId, userId);
    if (!deleted) {
      return { status: 404, data: { error: 'INBOX_ITEM_NOT_FOUND', message: `Inbox item ${inboxItemId} not found.` } };
    }
    return { status: 200, data: { success: true, inboxItemId } };
  }

  return undefined;
};

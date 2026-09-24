// R23.1H — Canonical Inbox HTTP Route Module.
//
// Previously backed by the standalone InboxStore (R18), which diverged
// from the canonical Unified Capture pipeline (CaptureStore, R21/R22.9):
// public/app.js::renderInbox() always read/rendered this route's response
// as capture-shaped (metadata.extractedTitle, status READY/NEEDS_REVIEW/
// FAILED/ARCHIVED/ACTIONED), while InboxStore actually returned a
// differently-shaped InboxItem (title/summary/status NEW/REVIEWED/
// ACTIONED/ARCHIVED) — a real, silent data-contract mismatch. Investigation
// (see R23.1H report) found InboxStore had exactly one live UI entry point
// (the Link Capture modal's "Add to Inbox" button), zero dedicated tests,
// and no other production consumer, while CaptureStore is the actively
// developed, heavily-tested canonical system whose status vocabulary
// (NEEDS_REVIEW/ARCHIVED/ACTIONED) already matches this route's own
// intent. This route is now backed by CaptureStore end to end — the same
// store CurrentPersonalContextService (R23.1) already reads — so the UI,
// Personal Context, and any future proactive layer agree on one canonical
// Inbox (CANONICAL_USER_INBOX_PIPELINE_COUNT=1). InboxStore itself has
// been retired (no remaining production reference).
import { DEFAULT_GOOGLE_TENANT_ID } from '../../integrations/google/token.store.js';
import type { CaptureStore } from '../../workspace/capture.store.js';
import type { VaultStore } from '../../workspace/vault.store.js';
import type { CaptureType } from '../../workspace/workspace.types.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';

function getHeaderValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export interface InboxRouteDeps {
  captureStore: CaptureStore;
  vaultStore: VaultStore;
}

// The one caller-facing sourceType this route ever accepted was WEB_LINK
// (the Link Capture modal's "Add to Inbox" destination) — the only real,
// live production entry point InboxStore ever had. Mapped to the
// canonical CaptureType vocabulary; anything else falls back to TEXT
// rather than silently guessing.
function toCaptureType(sourceType: unknown): CaptureType {
  return sourceType === 'WEB_LINK' ? 'LINK' : 'TEXT';
}

export const handleInboxRoutes: AsyncRouteRegistrar<InboxRouteDeps> = async (method, pathname, body, headers, _query, deps): Promise<ApiResult | undefined> => {
  const { captureStore, vaultStore } = deps;
  const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
  const userId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';

  if (pathname === '/api/v1/workspace/inbox' && method === 'GET') {
    const items = captureStore.listCaptures(tenantId, userId);
    const unreadCount = items.filter((i) => i.status === 'NEEDS_REVIEW').length;
    return { status: 200, data: { items, unreadCount, total: items.length } };
  }

  if (pathname.startsWith('/api/v1/workspace/inbox/') && !pathname.endsWith('/archive') && !pathname.endsWith('/save-to-vault') && pathname !== '/api/v1/workspace/inbox/capture' && method === 'GET') {
    const captureId = pathname.slice('/api/v1/workspace/inbox/'.length);
    const item = captureStore.getCapture(captureId, tenantId, userId);
    if (!item) {
      return { status: 404, data: { error: 'INBOX_ITEM_NOT_FOUND', message: `Inbox item ${captureId} not found.` } };
    }
    return { status: 200, data: item };
  }

  if (pathname === '/api/v1/workspace/inbox/capture' && method === 'POST') {
    const title = typeof body?.title === 'string' ? body.title : 'New Quick Capture';
    const summary = typeof body?.summary === 'string' ? body.summary : undefined;
    const contentRef = typeof body?.contentRef === 'string' ? body.contentRef : undefined;
    const type = toCaptureType(body?.sourceType);
    // A lightweight, already-understood save (the user supplied the title
    // themselves via the link preview) — created directly READY, never
    // routed through the async understanding pipeline, matching this
    // button's pre-existing instant behavior (mirrors the sibling "Save to
    // Vault" button in the same modal, which is also a direct, synchronous
    // record write, not a capture-and-understand flow).
    const created = captureStore.createCapture({
      ownerId: userId,
      tenantId,
      type,
      content: contentRef || title,
      source: 'WEB',
    });
    const item = captureStore.updateStatus(created.captureId, tenantId, userId, 'READY', {
      extractedTitle: title,
      extractedSummary: summary,
      url: type === 'LINK' ? contentRef : undefined,
    }) || created;
    return { status: 201, data: item };
  }

  if (pathname.startsWith('/api/v1/workspace/inbox/') && pathname.endsWith('/archive') && method === 'POST') {
    const captureId = pathname.slice('/api/v1/workspace/inbox/'.length, pathname.length - '/archive'.length);
    const updated = captureStore.updateStatus(captureId, tenantId, userId, 'ARCHIVED');
    if (!updated) {
      return { status: 404, data: { error: 'INBOX_ITEM_NOT_FOUND', message: `Inbox item ${captureId} not found.` } };
    }
    return { status: 200, data: updated };
  }

  if (pathname.startsWith('/api/v1/workspace/inbox/') && pathname.endsWith('/save-to-vault') && method === 'POST') {
    const captureId = pathname.slice('/api/v1/workspace/inbox/'.length, pathname.length - '/save-to-vault'.length);
    const captureItem = captureStore.getCapture(captureId, tenantId, userId);
    if (!captureItem) {
      return { status: 404, data: { error: 'INBOX_ITEM_NOT_FOUND', message: `Inbox item ${captureId} not found.` } };
    }

    const vaultItem = vaultStore.saveItem({
      tenantId,
      userId,
      type: captureItem.type === 'FILE' ? 'FILE' : captureItem.type === 'LINK' ? 'LINK' : 'DOCUMENT',
      title: captureItem.metadata?.extractedTitle || captureItem.content,
      storageRef: captureItem.metadata?.objectKey || `ref_${captureId}`,
      source: 'INBOX_SAVE',
      sourceRef: captureId,
      metadata: { originalCaptureType: captureItem.type },
    });

    captureStore.updateStatus(captureId, tenantId, userId, 'ACTIONED');
    return { status: 201, data: { vaultItem, inboxItem: captureItem } };
  }

  if (pathname.startsWith('/api/v1/workspace/inbox/') && method === 'DELETE') {
    const captureId = pathname.slice('/api/v1/workspace/inbox/'.length);
    const deleted = captureStore.deleteCapture(captureId, tenantId, userId);
    if (!deleted) {
      return { status: 404, data: { error: 'INBOX_ITEM_NOT_FOUND', message: `Inbox item ${captureId} not found.` } };
    }
    return { status: 200, data: { success: true, inboxItemId: captureId } };
  }

  return undefined;
};

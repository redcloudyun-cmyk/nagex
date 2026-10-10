// R18 — Vault HTTP Route Module
import type { VaultStore } from '../../workspace/vault.store.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';
import { tryGetCallerIdentity } from '../request-identity.js';

export interface VaultRouteDeps {
  vaultStore: VaultStore;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function getStoredText(item: { metadata?: Record<string, unknown> }): string | null {
  const text = item.metadata?.contentText ?? item.metadata?.textContent;
  return typeof text === 'string' ? text : null;
}

export const handleVaultRoutes: AsyncRouteRegistrar<VaultRouteDeps> = async (method, pathname, body, headers, query, deps): Promise<ApiResult | undefined> => {
  const { vaultStore } = deps;
  const caller = tryGetCallerIdentity(headers);
  // No authenticated caller: this registrar handles nothing. (route-access.ts has already answered 401
  // for every route that requires one, so only public routes can reach a later registrar.)
  if (!caller) return undefined;
  const tenantId = caller.tenantId;
  const userId = caller.principalId;

  if (pathname === '/api/v1/workspace/vault' && method === 'GET') {
    const q = typeof query?.q === 'string' ? query.q : undefined;
    const items = q ? vaultStore.searchItems(tenantId, userId, q) : vaultStore.listItems(tenantId, userId);
    const sizes = items.map((i) => i.metadata?.sizeBytes).filter((size): size is number => typeof size === 'number' && Number.isFinite(size) && size >= 0);
    const storageUsageAvailable = sizes.length === items.length;
    return {
      status: 200,
      data: {
        items,
        recentItems: items,
        total: items.length,
        usedSizeBytes: storageUsageAvailable ? sizes.reduce((acc, size) => acc + size, 0) : null,
        quotaSizeBytes: null,
        storageUsageAvailable,
        storageUsageLabel: storageUsageAvailable ? 'Storage usage calculated from persisted item sizes.' : 'Storage usage is unavailable for one or more existing Vault items.',
        query: q || null,
        storageInfo: { provider: 'local', isCloud: false, label: 'NAgex Personal Vault' },
      },
    };
  }

  if (pathname === '/api/v1/workspace/vault' && method === 'POST') {
    const title = typeof body?.title === 'string' ? body.title : 'Untitled Vault Item';
    const type = typeof body?.type === 'string' ? (body.type as any) : 'DOCUMENT';
    const storageRef = typeof body?.storageRef === 'string' ? body.storageRef : `ref_${Date.now()}`;
    const contentText = typeof body?.contentText === 'string' ? body.contentText : typeof body?.content === 'string' ? body.content : undefined;
    const incomingMetadata = body?.metadata && typeof body.metadata === 'object' ? (body.metadata as Record<string, unknown>) : {};
    const metadata: Record<string, unknown> = { ...incomingMetadata };
    if (contentText !== undefined) {
      metadata.contentText = contentText;
      if (typeof metadata.sizeBytes !== 'number') metadata.sizeBytes = byteLength(contentText);
    }

    const item = vaultStore.saveItem({
      tenantId,
      userId,
      type,
      title,
      mimeType: typeof body?.mimeType === 'string' ? body.mimeType : undefined,
      storageRef,
      source: typeof body?.source === 'string' ? body.source : 'MANUAL_SAVE',
      sourceRef: typeof body?.sourceRef === 'string' ? body.sourceRef : undefined,
      metadata,
    });

    return { status: 201, data: item };
  }

  if (pathname.startsWith('/api/v1/workspace/vault/') && method === 'GET') {
    const suffix = pathname.slice('/api/v1/workspace/vault/'.length);
    const previewSuffix = '/preview';
    const downloadSuffix = '/download';
    const isPreview = suffix.endsWith(previewSuffix);
    const isDownload = suffix.endsWith(downloadSuffix);
    const vaultItemId = isPreview ? suffix.slice(0, -previewSuffix.length) : isDownload ? suffix.slice(0, -downloadSuffix.length) : suffix;
    const item = vaultStore.getItem(vaultItemId, tenantId, userId);
    if (!item) {
      return { status: 404, data: { error: 'VAULT_ITEM_NOT_FOUND', message: `Vault item ${vaultItemId} not found.` } };
    }
    if (isPreview || isDownload) {
      const contentText = getStoredText(item);
      if (contentText === null) {
        return {
          status: 409,
          data: {
            error: 'VAULT_CONTENT_UNAVAILABLE',
            message: `Vault item ${vaultItemId} has no persisted preview/download content in the local Vault store.`,
          },
        };
      }
      return {
        status: 200,
        data: {
          vaultItemId: item.vaultItemId,
          title: item.title,
          mimeType: item.mimeType,
          bytes: byteLength(contentText),
          contentText,
          disposition: isDownload ? 'attachment' : 'inline',
        },
      };
    }
    return { status: 200, data: item };
  }

  if (pathname.startsWith('/api/v1/workspace/vault/') && method === 'DELETE') {
    const vaultItemId = pathname.slice('/api/v1/workspace/vault/'.length);
    const deleted = vaultStore.deleteItem(vaultItemId, tenantId, userId);
    if (!deleted) {
      return { status: 404, data: { error: 'VAULT_ITEM_NOT_FOUND', message: `Vault item ${vaultItemId} not found.` } };
    }
    return { status: 200, data: { success: true, vaultItemId } };
  }

  return undefined;
};

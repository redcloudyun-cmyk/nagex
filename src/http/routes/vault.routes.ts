// R18 — Vault HTTP Route Module
import { DEFAULT_GOOGLE_TENANT_ID } from '../../integrations/google/token.store.js';
import type { VaultStore } from '../../workspace/vault.store.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';

function getHeaderValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export interface VaultRouteDeps {
  vaultStore: VaultStore;
}

export const handleVaultRoutes: AsyncRouteRegistrar<VaultRouteDeps> = async (method, pathname, body, headers, query, deps): Promise<ApiResult | undefined> => {
  const { vaultStore } = deps;
  const tenantId = getHeaderValue(headers, 'x-nagex-tenant') || DEFAULT_GOOGLE_TENANT_ID;
  const userId = getHeaderValue(headers, 'x-principal-id') || 'usr_admin_001';

  if (pathname === '/api/v1/workspace/vault' && method === 'GET') {
    const q = typeof query?.q === 'string' ? query.q : undefined;
    const items = q ? vaultStore.searchItems(tenantId, userId, q) : vaultStore.listItems(tenantId, userId);
    return {
      status: 200,
      data: {
        items,
        recentItems: items,
        total: items.length,
        usedSizeBytes: items.reduce((acc, i) => acc + (typeof i.metadata?.sizeBytes === 'number' ? i.metadata.sizeBytes : 1024), 0),
        quotaSizeBytes: 10737418240,
        query: q || null,
        storageInfo: { provider: 'local', isCloud: false, label: 'NAgex Personal Vault' },
      },
    };
  }

  if (pathname === '/api/v1/workspace/vault' && method === 'POST') {
    const title = typeof body?.title === 'string' ? body.title : 'Untitled Vault Item';
    const type = typeof body?.type === 'string' ? (body.type as any) : 'DOCUMENT';
    const storageRef = typeof body?.storageRef === 'string' ? body.storageRef : `ref_${Date.now()}`;

    const item = vaultStore.saveItem({
      tenantId,
      userId,
      type,
      title,
      mimeType: typeof body?.mimeType === 'string' ? body.mimeType : undefined,
      storageRef,
      source: typeof body?.source === 'string' ? body.source : 'MANUAL_SAVE',
      sourceRef: typeof body?.sourceRef === 'string' ? body.sourceRef : undefined,
      metadata: body?.metadata && typeof body.metadata === 'object' ? (body.metadata as Record<string, unknown>) : undefined,
    });

    return { status: 201, data: item };
  }

  if (pathname.startsWith('/api/v1/workspace/vault/') && method === 'GET') {
    const vaultItemId = pathname.slice('/api/v1/workspace/vault/'.length);
    const item = vaultStore.getItem(vaultItemId, tenantId, userId);
    if (!item) {
      return { status: 404, data: { error: 'VAULT_ITEM_NOT_FOUND', message: `Vault item ${vaultItemId} not found.` } };
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

// R18 — Vault Domain Store Layer
import crypto from 'node:crypto';
import type { SaveVaultItemParams, VaultItem } from './vault.types.js';

export class VaultStore {
  private readonly items: Map<string, VaultItem> = new Map();

  public saveItem(params: SaveVaultItemParams): VaultItem {
    const vaultItemId = `vlt_${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    const item: VaultItem = {
      vaultItemId,
      userId: params.userId,
      tenantId: params.tenantId,
      workspaceId: params.workspaceId || 'ws_default_01',
      type: params.type,
      title: params.title,
      mimeType: params.mimeType || 'application/octet-stream',
      storageRef: params.storageRef,
      source: params.source || 'USER_SAVE',
      sourceRef: params.sourceRef,
      metadata: params.metadata || {},
      createdAt: now,
      updatedAt: now,
    };

    this.items.set(vaultItemId, item);
    return item;
  }

  public getItem(vaultItemId: string, tenantId: string, userId: string): VaultItem | undefined {
    const item = this.items.get(vaultItemId);
    if (!item || item.tenantId !== tenantId || item.userId !== userId) return undefined;
    return item;
  }

  public listItems(tenantId: string, userId: string, workspaceId?: string): VaultItem[] {
    const result: VaultItem[] = [];
    for (const item of this.items.values()) {
      if (item.tenantId === tenantId && item.userId === userId) {
        if (!workspaceId || item.workspaceId === workspaceId) {
          result.push(item);
        }
      }
    }
    return result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  public searchItems(tenantId: string, userId: string, query: string, workspaceId?: string): VaultItem[] {
    const q = query.toLowerCase().trim();
    if (!q) return this.listItems(tenantId, userId, workspaceId);

    return this.listItems(tenantId, userId, workspaceId).filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        item.type.toLowerCase().includes(q) ||
        item.mimeType.toLowerCase().includes(q) ||
        (typeof item.sourceRef === 'string' && item.sourceRef.toLowerCase().includes(q))
    );
  }

  public deleteItem(vaultItemId: string, tenantId: string, userId: string): boolean {
    const item = this.getItem(vaultItemId, tenantId, userId);
    if (!item) return false;
    return this.items.delete(vaultItemId);
  }
}

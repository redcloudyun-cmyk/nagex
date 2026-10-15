import crypto from 'node:crypto';
import type { SaveVaultItemParams, VaultItem } from './vault.types.js';
import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';
import { NagexError } from '../common/errors.js';

export class VaultStore {
  private readonly store: FileRecordStore<VaultItem>;

  constructor(dataDir?: string) {
    const dir = dataDir ?? resolveNagexDataDir('vault', 'NAGEX_VAULT_DIR');
    this.store = new FileRecordStore<VaultItem>(dir, (val: unknown): val is VaultItem => {
      const v = val as any;
      return typeof v === 'object' && v !== null && typeof v.vaultItemId === 'string' && typeof v.tenantId === 'string' && typeof v.userId === 'string';
    });
  }

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

    // FileRecordStore.write() logs and swallows a failed disk write; answering "saved" (201 with an item id) for something that was not stored is a fake success, so a write that does not
    // persist is an error here too. Callers that mark other records as done only after this call (the Inbox) therefore never do so for an item that does not exist.
    try {
      this.store.writeOrThrow(vaultItemId, item);
    } catch {
      throw new NagexError({ code: 'VAULT_WRITE_FAILED', category: 'INTERNAL', message: 'The Vault could not store this item, so nothing was saved.' });
    }
    return item;
  }

  // D-9: a durable, IDEMPOTENT save for an approved action. The id is chosen by the caller (derived from the approval), so repeating the same save can never create a second
  // item; the write throws when it cannot persist (saveItem swallows write errors), and the item is read back so "saved" always means "readable by its owner".
  public saveItemOnce(params: SaveVaultItemParams & { vaultItemId: string }): VaultItem {
    const existing = this.store.read(params.vaultItemId);
    if (existing) {
      if (existing.tenantId !== params.tenantId || existing.userId !== params.userId) throw new Error('VAULT_ITEM_ID_CONFLICT');
      return existing;
    }
    const now = new Date().toISOString();
    const item: VaultItem = {
      vaultItemId: params.vaultItemId,
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
    this.store.writeOrThrow(params.vaultItemId, item);
    const persisted = this.getItem(params.vaultItemId, params.tenantId, params.userId);
    if (!persisted) throw new Error('VAULT_ITEM_NOT_PERSISTED');
    return persisted;
  }

  public getItem(vaultItemId: string, tenantId: string, userId: string): VaultItem | undefined {
    const item = this.store.read(vaultItemId);
    if (!item || item.tenantId !== tenantId || item.userId !== userId) return undefined;
    return item;
  }

  public listItems(tenantId: string, userId: string, workspaceId?: string): VaultItem[] {
    const result: VaultItem[] = [];
    const items = this.store.readAll();
    for (const item of items) {
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
    this.store.remove(vaultItemId);
    return true;
  }
}

export const vaultStore = new VaultStore();

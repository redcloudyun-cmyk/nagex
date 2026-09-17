// R18 — Inbox Domain Store Layer
import crypto from 'node:crypto';
import type { CreateInboxItemParams, InboxItem, InboxItemStatus } from './inbox.types.js';

export class InboxStore {
  private readonly items: Map<string, InboxItem> = new Map();

  public createItem(params: CreateInboxItemParams): InboxItem {
    const inboxItemId = `inb_${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    const item: InboxItem = {
      inboxItemId,
      userId: params.userId,
      tenantId: params.tenantId,
      workspaceId: params.workspaceId || 'ws_default_01',
      sourceType: params.sourceType,
      sourceRef: params.sourceRef,
      title: params.title,
      summary: params.summary || params.title,
      contentRef: params.contentRef,
      status: 'NEW',
      priority: params.priority || 'MEDIUM',
      createdAt: now,
      updatedAt: now,
    };

    this.items.set(inboxItemId, item);
    return item;
  }

  public listItems(tenantId: string, userId: string, workspaceId?: string): InboxItem[] {
    const result: InboxItem[] = [];
    for (const item of this.items.values()) {
      if (item.tenantId === tenantId && item.userId === userId) {
        if (!workspaceId || item.workspaceId === workspaceId) {
          result.push(item);
        }
      }
    }
    return result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  public getItem(inboxItemId: string, tenantId: string, userId: string): InboxItem | undefined {
    const item = this.items.get(inboxItemId);
    if (!item || item.tenantId !== tenantId || item.userId !== userId) return undefined;
    return item;
  }

  public updateStatus(inboxItemId: string, tenantId: string, userId: string, status: InboxItemStatus): InboxItem | undefined {
    const item = this.getItem(inboxItemId, tenantId, userId);
    if (!item) return undefined;

    item.status = status;
    item.updatedAt = new Date().toISOString();
    if (status === 'ACTIONED' || status === 'ARCHIVED') {
      item.processedAt = item.updatedAt;
    }
    return item;
  }

  public deleteItem(inboxItemId: string, tenantId: string, userId: string): boolean {
    const item = this.getItem(inboxItemId, tenantId, userId);
    if (!item) return false;
    return this.items.delete(inboxItemId);
  }
}

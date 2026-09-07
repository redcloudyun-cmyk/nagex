import fs from 'node:fs';
import path from 'node:path';
import { generateResourceId } from '../common/utils.js';
import { resolveNagexDataDir } from '../governance/file-record.store.js';
import type { CaptureItem, CaptureStatus, CaptureType } from './workspace.types.js';

export class CaptureStore {
  private readonly dataDir: string;
  private readonly items = new Map<string, CaptureItem>();

  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? resolveNagexDataDir('workspace-captures', 'NAGEX_CAPTURES_DIR');
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    try {
      const files = fs.readdirSync(this.dataDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const raw = fs.readFileSync(path.join(this.dataDir, file), 'utf8');
          const parsed = JSON.parse(raw) as CaptureItem;
          if (parsed && parsed.captureId) {
            this.items.set(parsed.captureId, parsed);
          }
        } catch (err) {
          console.warn(`[CaptureStore] Failed to read capture file ${file}:`, err);
        }
      }
    } catch {
      // Empty or non-existent dir on start is fine
    }
  }

  private saveItemToDisk(item: CaptureItem): void {
    const filePath = path.join(this.dataDir, `${item.captureId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(item, null, 2), { encoding: 'utf8', mode: 0o600 });
  }

  public createCapture(params: {
    ownerId: string;
    tenantId: string;
    type: CaptureType;
    content: string;
    source?: 'WEB' | 'DESKTOP' | 'MOBILE' | 'TELEGRAM' | 'SLACK';
    metadata?: Partial<CaptureItem['metadata']>;
  }): CaptureItem {
    const captureId = generateResourceId('cap');
    const now = new Date().toISOString();
    const item: CaptureItem = {
      captureId,
      ownerId: params.ownerId,
      tenantId: params.tenantId,
      type: params.type,
      content: params.content,
      status: 'CAPTURED',
      source: params.source ?? 'WEB',
      metadata: params.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.items.set(captureId, item);
    this.saveItemToDisk(item);
    return item;
  }

  public getCapture(captureId: string): CaptureItem | null {
    return this.items.get(captureId) ?? null;
  }

  public updateStatus(captureId: string, status: CaptureStatus, metadataUpdates?: Partial<CaptureItem['metadata']>): CaptureItem | null {
    const item = this.items.get(captureId);
    if (!item) return null;
    item.status = status;
    item.updatedAt = new Date().toISOString();
    if (metadataUpdates) {
      item.metadata = { ...item.metadata, ...metadataUpdates };
    }
    this.saveItemToDisk(item);
    return item;
  }

  public listCaptures(ownerId: string, filter?: { status?: CaptureStatus; type?: CaptureType }): CaptureItem[] {
    const result: CaptureItem[] = [];
    for (const item of this.items.values()) {
      if (item.ownerId !== ownerId) continue;
      if (filter?.status && item.status !== filter.status) continue;
      if (filter?.type && item.type !== filter.type) continue;
      result.push(item);
    }
    return result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  public deleteCapture(captureId: string): boolean {
    const existing = this.items.get(captureId);
    if (!existing) return false;
    this.items.delete(captureId);
    const filePath = path.join(this.dataDir, `${captureId}.json`);
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { force: true });
    }
    return true;
  }
}

export const captureStore = new CaptureStore();

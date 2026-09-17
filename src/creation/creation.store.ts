// R17 — Creation Domain Persistence Layer
import path from 'node:path';
import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';
import type { CreationRecord } from './creation.types.js';

export function isCreationRecord(value: unknown): value is CreationRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.creationId === 'string' &&
    typeof v.tenantId === 'string' &&
    typeof v.ownerId === 'string' &&
    typeof v.type === 'string' &&
    typeof v.status === 'string' &&
    typeof v.prompt === 'string' &&
    typeof v.imageUrl === 'string' &&
    typeof v.createdAt === 'string'
  );
}

export class CreationStore {
  private readonly store: FileRecordStore<CreationRecord>;

  constructor(options?: { dir?: string }) {
    const dir = options?.dir ?? resolveNagexDataDir('creations', 'NAGEX_CREATIONS_DIR');
    this.store = new FileRecordStore<CreationRecord>(dir, isCreationRecord);
  }

  public saveCreation(record: CreationRecord): CreationRecord {
    this.store.write(record.creationId, record);
    return record;
  }

  public getCreation(creationId: string, tenantId: string, ownerId: string): CreationRecord | null {
    const record = this.store.read(creationId);
    if (!record || record.tenantId !== tenantId || record.ownerId !== ownerId) {
      return null;
    }
    return record;
  }

  public listCreations(tenantId: string, ownerId: string, limit = 50): CreationRecord[] {
    const records = this.store.readAll().filter((rec: CreationRecord) => rec.tenantId === tenantId && rec.ownerId === ownerId);
    records.sort((a: CreationRecord, b: CreationRecord) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return records.slice(0, limit);
  }

  public getLineage(parentCreationId: string, tenantId: string, ownerId: string): CreationRecord[] {
    return this.store.readAll().filter(
      (rec: CreationRecord) => rec.tenantId === tenantId && rec.ownerId === ownerId && (rec.creationId === parentCreationId || rec.parentCreationId === parentCreationId)
    );
  }
}

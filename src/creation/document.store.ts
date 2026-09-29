import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';
import type { DocumentRecord } from './creation-runtime.types.js';

export function isDocumentRecord(value: unknown): value is DocumentRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.documentId === 'string' &&
    typeof v.tenantId === 'string' &&
    typeof v.ownerId === 'string' &&
    typeof v.title === 'string' &&
    typeof v.summary === 'string' &&
    typeof v.content === 'string' &&
    typeof v.documentKind === 'string' &&
    (v.locale === 'en' || v.locale === 'ko') &&
    typeof v.createdAt === 'string' &&
    typeof v.updatedAt === 'string'
  );
}

export class DocumentStore {
  private readonly store: FileRecordStore<DocumentRecord>;

  constructor(options?: { dir?: string }) {
    const dir = options?.dir ?? resolveNagexDataDir('documents', 'NAGEX_DOCUMENTS_DIR');
    this.store = new FileRecordStore<DocumentRecord>(dir, isDocumentRecord);
  }

  public save(record: DocumentRecord): DocumentRecord {
    this.store.write(record.documentId, record);
    return record;
  }

  public get(documentId: string, tenantId: string, ownerId: string): DocumentRecord | null {
    const record = this.store.read(documentId);
    if (!record || record.tenantId !== tenantId || record.ownerId !== ownerId) {
      return null;
    }
    return record;
  }

  public list(tenantId: string, ownerId: string, limit = 50): DocumentRecord[] {
    const records = this.store.readAll().filter((rec) => rec.tenantId === tenantId && rec.ownerId === ownerId);
    records.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return records.slice(0, Math.max(0, limit));
  }

  public getRevisions(parentDocumentId: string, tenantId: string, ownerId: string): DocumentRecord[] {
    return this.store.readAll().filter(
      (rec) => rec.tenantId === tenantId && rec.ownerId === ownerId && (rec.documentId === parentDocumentId || rec.parentDocumentId === parentDocumentId)
    ).sort((a, b) => a.revisionIndex - b.revisionIndex);
  }
}

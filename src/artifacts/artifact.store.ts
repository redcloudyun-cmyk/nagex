import crypto from 'node:crypto';
import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';
import type { ArtifactRecord, SaveCompletedArtifactInput } from './artifact.types.js';

export function isArtifactRecord(value: unknown): value is ArtifactRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.artifactId === 'string' && typeof v.tenantId === 'string' && typeof v.ownerId === 'string'
    && (v.type === 'RESEARCH' || v.type === 'ANALYSIS' || v.type === 'DOCUMENT') && v.status === 'COMPLETED'
    && typeof v.title === 'string' && typeof v.preview === 'string'
    && (v.sourceType === 'RESEARCH_RESULT' || v.sourceType === 'CAPTURE')
    && typeof v.sourceId === 'string' && typeof v.openTarget === 'string'
    && typeof v.createdAt === 'string' && typeof v.updatedAt === 'string';
}

export class ArtifactStore {
  private readonly records: FileRecordStore<ArtifactRecord>;
  private readonly now: () => string;

  constructor(options: { dir?: string; now?: () => string } = {}) {
    this.records = new FileRecordStore<ArtifactRecord>(options.dir ?? resolveNagexDataDir('artifacts', 'NAGEX_ARTIFACTS_DIR'), isArtifactRecord);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public saveCompleted(input: SaveCompletedArtifactInput): ArtifactRecord {
    const artifactId = `art_${crypto.createHash('sha256').update(`${input.tenantId}:${input.ownerId}:${input.sourceType}:${input.sourceId}`).digest('hex').slice(0, 24)}`;
    const existing = this.records.read(artifactId);
    const timestamp = this.now();
    const record: ArtifactRecord = {
      artifactId, tenantId: input.tenantId, ownerId: input.ownerId, type: input.type, status: 'COMPLETED',
      title: input.title.trim(), preview: input.preview.trim().slice(0, 500), sourceType: input.sourceType,
      sourceId: input.sourceId, openTarget: input.openTarget, createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp,
    };
    this.records.write(artifactId, record);
    return record;
  }

  public get(artifactId: string, tenantId: string, ownerId: string): ArtifactRecord | null {
    const record = this.records.read(artifactId);
    return record && record.tenantId === tenantId && record.ownerId === ownerId ? record : null;
  }

  public list(tenantId: string, ownerId: string, limit = 20): ArtifactRecord[] {
    return this.records.readAll().filter((item) => item.tenantId === tenantId && item.ownerId === ownerId && item.status === 'COMPLETED')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, Math.max(0, limit));
  }
}

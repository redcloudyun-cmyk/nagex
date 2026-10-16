import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';
import type { ResearchRunRecord } from './research-run.types.js';

export function isResearchRunRecord(value: unknown): value is ResearchRunRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.runId === 'string'
    && typeof v.tenantId === 'string'
    && typeof v.ownerId === 'string'
    && typeof v.query === 'string'
    && typeof v.status === 'string'
    && Array.isArray(v.sources)
    && Array.isArray(v.claims)
    && typeof v.startedAt === 'string';
}

// Provenance of every research report: what was searched, retrieved and verified. Owner- and tenant-scoped; an unknown id, a malformed id and someone else's run are indistinguishable.
export class ResearchRunStore {
  private readonly store: FileRecordStore<ResearchRunRecord>;

  constructor(options?: { dir?: string }) {
    const dir = options?.dir ?? resolveNagexDataDir('research-runs', 'NAGEX_RESEARCH_RUNS_DIR');
    this.store = new FileRecordStore<ResearchRunRecord>(dir, isResearchRunRecord);
  }

  public save(record: ResearchRunRecord): ResearchRunRecord {
    this.store.write(record.runId, record);
    return record;
  }

  public get(runId: string, tenantId: string, ownerId: string): ResearchRunRecord | null {
    if (!/^run_[0-9a-f]{24}$/.test(runId)) return null;
    const record = this.store.read(runId);
    if (!record || record.tenantId !== tenantId || record.ownerId !== ownerId) return null;
    return record;
  }

  public list(tenantId: string, ownerId: string, limit = 50): ResearchRunRecord[] {
    return this.store.readAll()
      .filter((r) => r.tenantId === tenantId && r.ownerId === ownerId)
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
      .slice(0, Math.max(0, limit));
  }
}

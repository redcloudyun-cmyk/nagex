import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';
import crypto from 'node:crypto';

export type ProactiveInteractionDecision = 'ACCEPTED' | 'DISMISSED' | 'SNOOZED' | 'MODIFIED' | 'DONT_SUGGEST_AGAIN';

export interface ProactiveInteractionRecord {
  id: string;
  tenantId: string;
  principalId: string;
  suggestionId: string;
  decision: ProactiveInteractionDecision;
  sourceRefs: Array<{ type: string; id: string; label?: string }>;
  taskId?: string;
  snoozedUntil?: string;
  modifiedTitle?: string;
  suppressKey?: string;
  createdAt: string;
  updatedAt: string;
}

export function isProactiveInteractionRecord(value: unknown): value is ProactiveInteractionRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.tenantId === 'string' &&
    typeof v.principalId === 'string' &&
    typeof v.suggestionId === 'string' &&
    typeof v.decision === 'string' &&
    Array.isArray(v.sourceRefs) &&
    typeof v.createdAt === 'string' &&
    typeof v.updatedAt === 'string'
  );
}

export interface ProactiveInteractionStoreOptions {
  dir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
}

export class ProactiveInteractionStore {
  private readonly records = new Map<string, ProactiveInteractionRecord>();
  private readonly fileStore: FileRecordStore<ProactiveInteractionRecord>;
  private readonly now: () => string;

  constructor(options: ProactiveInteractionStoreOptions = {}) {
    const env = options.env ?? process.env;
    const dir = options.dir ?? resolveNagexDataDir('proactive-interactions', 'NAGEX_PROACTIVE_INTERACTIONS_DIR', env);
    this.fileStore = new FileRecordStore<ProactiveInteractionRecord>(dir, isProactiveInteractionRecord);
    this.now = options.now ?? (() => new Date().toISOString());
    for (const record of this.fileStore.readAll()) this.records.set(record.id, record);
  }

  private id(tenantId: string, principalId: string, suggestionId: string, decision: ProactiveInteractionDecision): string {
    return `pro_${crypto.createHash('sha256').update(`${tenantId}:${principalId}:${suggestionId}:${decision}`).digest('hex').slice(0, 24)}`;
  }

  public save(input: Omit<ProactiveInteractionRecord, 'id' | 'createdAt' | 'updatedAt'>): ProactiveInteractionRecord {
    const id = this.id(input.tenantId, input.principalId, input.suggestionId, input.decision);
    const existing = this.records.get(id);
    const now = this.now();
    const record: ProactiveInteractionRecord = { ...input, id, createdAt: existing?.createdAt ?? now, updatedAt: now };
    this.records.set(id, record);
    this.fileStore.write(id, record);
    return record;
  }

  public list(tenantId: string, principalId: string): ProactiveInteractionRecord[] {
    return [...this.records.values()]
      .filter((record) => record.tenantId === tenantId && record.principalId === principalId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  public isSuppressed(tenantId: string, principalId: string, suppressKey: string): boolean {
    return this.list(tenantId, principalId).some((record) => record.decision === 'DONT_SUGGEST_AGAIN' && record.suppressKey === suppressKey);
  }
}

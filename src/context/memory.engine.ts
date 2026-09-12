import { generateResourceId, getCurrentISOString } from '../common/utils.js';
import { NagexError } from '../common/errors.js';
import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';

export type MemoryScope = 'EXECUTION' | 'SESSION' | 'AGENT' | 'USER' | 'TENANT';
export type MemoryLifecycle = 'PROPOSED' | 'VALIDATING' | 'ACTIVE' | 'CONFLICTED' | 'SUPERSEDED' | 'EXPIRED' | 'DELETED';

const VALID_SCOPES: ReadonlySet<string> = new Set(['EXECUTION', 'SESSION', 'AGENT', 'USER', 'TENANT']);
const VALID_LIFECYCLES: ReadonlySet<string> = new Set([
  'PROPOSED',
  'VALIDATING',
  'ACTIVE',
  'CONFLICTED',
  'SUPERSEDED',
  'EXPIRED',
  'DELETED',
]);

const TERMINAL_MEMORY_STATES: ReadonlySet<MemoryLifecycle> = new Set([
  'CONFLICTED',
  'SUPERSEDED',
  'EXPIRED',
  'DELETED',
]);

export interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  owner_id: string;
  lifecycle: MemoryLifecycle;
  content: {
    subject: string;
    predicate: string;
    value: unknown;
  };
  // Phase 1 STEP 9, item K — traceability back to the canonical Candidate
  // this memory was written from, so a lost/crashed action-linkage write
  // can be reconciled instead of writing a second memory.
  candidateId?: string;
  created_at: string;
  updated_at: string;
}

export function isMemoryRecord(value: unknown): value is MemoryRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || !v.id.trim()) return false;
  if (typeof v.scope !== 'string' || !VALID_SCOPES.has(v.scope)) return false;
  if (typeof v.owner_id !== 'string' || !v.owner_id.trim()) return false;
  if (typeof v.lifecycle !== 'string' || !VALID_LIFECYCLES.has(v.lifecycle)) return false;
  if (!v.content || typeof v.content !== 'object') return false;
  const c = v.content as Record<string, unknown>;
  if (typeof c.subject !== 'string' || !c.subject.trim()) return false;
  if (typeof c.predicate !== 'string' || !c.predicate.trim()) return false;
  if (typeof v.created_at !== 'string' || !v.created_at.trim()) return false;
  if (typeof v.updated_at !== 'string' || !v.updated_at.trim()) return false;
  if (v.candidateId !== undefined && typeof v.candidateId !== 'string') return false;
  return true;
}

export interface MemoryEngineOptions {
  dir?: string;
  env?: NodeJS.ProcessEnv;
}

export class MemoryEngine {
  private readonly fileStore: FileRecordStore<MemoryRecord>;
  private readonly memoryStore: Map<string, MemoryRecord> = new Map();

  constructor(options?: MemoryEngineOptions) {
    const dir = options?.dir ?? resolveNagexDataDir('memories', 'NAGEX_MEMORIES_DIR', options?.env);
    this.fileStore = new FileRecordStore<MemoryRecord>(dir, isMemoryRecord);
    for (const record of this.fileStore.readAll()) {
      this.memoryStore.set(record.id, record);
    }
  }

  public proposeMemory(
    scope: MemoryScope,
    ownerId: string,
    content: { subject: string; predicate: string; value: unknown },
    candidateId?: string,
  ): MemoryRecord {
    const id = generateResourceId('mem');
    const now = getCurrentISOString();

    const record: MemoryRecord = {
      id,
      scope,
      owner_id: ownerId,
      lifecycle: 'PROPOSED',
      content,
      candidateId,
      created_at: now,
      updated_at: now,
    };

    this.fileStore.writeOrThrow(id, record);
    this.memoryStore.set(id, record);
    return record;
  }

  // Phase 1 STEP 9 — reconciliation lookup, mirrors TaskStore.findByCandidateId.
  public findByCandidateId(candidateId: string): MemoryRecord | undefined {
    for (const record of this.memoryStore.values()) {
      if (record.candidateId === candidateId) return record;
    }
    return undefined;
  }

  // Seed memory initialization helper to prevent duplicate seed creation on process restart.
  public findSeedMemory(criteria: {
    scope: MemoryScope;
    ownerId: string;
    subject: string;
    predicate: string;
  }): MemoryRecord | undefined {
    for (const record of this.memoryStore.values()) {
      if (
        record.scope === criteria.scope &&
        record.owner_id === criteria.ownerId &&
        record.content.subject === criteria.subject &&
        record.content.predicate === criteria.predicate &&
        !TERMINAL_MEMORY_STATES.has(record.lifecycle)
      ) {
        return record;
      }
    }
    return undefined;
  }

  public activateMemory(id: string): MemoryRecord {
    const record = this.memoryStore.get(id);
    if (!record) {
      throw new NagexError({
        code: 'MEMORY_NOT_FOUND',
        category: 'NOT_FOUND',
        message: `Memory ID ${id} not found.`,
        request_id: 'mem_req',
      });
    }

    if (TERMINAL_MEMORY_STATES.has(record.lifecycle)) {
      throw new NagexError({
        code: 'MEMORY_ALREADY_TERMINAL',
        category: 'CONFLICT',
        message: `Memory ID ${id} is in terminal state ${record.lifecycle} and cannot be reactivated.`,
        request_id: 'mem_req',
      });
    }

    const now = getCurrentISOString();
    const updatedRecord: MemoryRecord = {
      ...record,
      lifecycle: 'ACTIVE',
      updated_at: now,
    };

    this.fileStore.writeOrThrow(id, updatedRecord);
    record.lifecycle = 'ACTIVE';
    record.updated_at = now;
    this.memoryStore.set(id, record);
    return record;
  }

  public getActiveMemories(scope: MemoryScope, ownerId: string): MemoryRecord[] {
    const active: MemoryRecord[] = [];
    for (const record of this.memoryStore.values()) {
      if (record.scope === scope && record.owner_id === ownerId && record.lifecycle === 'ACTIVE') {
        active.push(record);
      }
    }
    return active;
  }

  // Memory must be controllable and deletable (MASTER.md Safety Principle 9):
  // this permanently removes the record, not merely unpins it.
  public deleteMemory(id: string): MemoryRecord {
    const record = this.memoryStore.get(id);
    if (!record) {
      throw new NagexError({
        code: 'MEMORY_NOT_FOUND',
        category: 'NOT_FOUND',
        message: `Memory ID ${id} not found.`,
        request_id: 'mem_req',
      });
    }
    const deletedRecord: MemoryRecord = {
      ...record,
      lifecycle: 'DELETED',
      updated_at: getCurrentISOString(),
    };
    this.fileStore.remove(id);
    this.memoryStore.delete(id);
    return deletedRecord;
  }
}

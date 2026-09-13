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

// Memory Tenant Isolation Correction — the one canonical default tenant
// already used everywhere else in this codebase (see
// DEFAULT_GOOGLE_TENANT_ID in integrations/google/token.store.ts) is
// duplicated here as a literal rather than imported, to avoid giving the
// context/ module a new dependency on integrations/google/ for a single
// constant. Used ONLY to durably backfill legacy records that predate
// tenantId — never used to stamp a newly created record.
const LEGACY_BACKFILL_TENANT_ID = 'ten_production_01';

export interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  // Memory Tenant Isolation Correction — optional only so a pre-existing
  // on-disk record (written before this field existed) can still pass
  // isMemoryRecord() and load; every record entering the in-memory store
  // is durably backfilled to a real tenantId in the constructor below, and
  // every newly created record always has one set. Never treat this as
  // "tenant is optional" for any ownership decision downstream.
  tenantId?: string;
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
  if (v.tenantId !== undefined && (typeof v.tenantId !== 'string' || !v.tenantId.trim())) return false;
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
      if (record.tenantId === undefined) {
        // One-time legacy backfill, atomic per record: build the upgraded
        // copy, durably write it FIRST, and only replace the canonical
        // in-memory record once that write has actually succeeded — never
        // mutate `record` in place and write second, which could leave the
        // in-memory state "upgraded" while the disk write behind it never
        // landed. writeOrThrow() throws synchronously on failure, and that
        // throw is intentionally allowed to propagate out of this
        // constructor: a legacy record that cannot be safely backfilled
        // must stop startup, not silently run with partially-upgraded
        // memory state.
        const upgraded: MemoryRecord = { ...record, tenantId: LEGACY_BACKFILL_TENANT_ID };
        this.fileStore.writeOrThrow(upgraded.id, upgraded);
        this.memoryStore.set(upgraded.id, upgraded);
      } else {
        this.memoryStore.set(record.id, record);
      }
    }
  }

  // Centralized ownership gate — mirrors the exact requireOwned() pattern
  // already used by TaskStore/CandidateStore/WorkflowDefinitionStore/
  // ActionApprovalStore. A tenant or owner mismatch is externally
  // indistinguishable from a genuinely nonexistent id: both throw the same
  // MEMORY_NOT_FOUND, never a distinguishing MEMORY_WRONG_TENANT/
  // MEMORY_WRONG_OWNER code.
  private requireOwned(id: string, tenantId: string, ownerId: string): MemoryRecord {
    const record = this.memoryStore.get(id);
    if (!record || record.tenantId !== tenantId || record.owner_id !== ownerId) {
      throw new NagexError({
        code: 'MEMORY_NOT_FOUND',
        category: 'NOT_FOUND',
        message: `Memory ID ${id} not found.`,
        request_id: 'mem_req',
      });
    }
    return record;
  }

  public proposeMemory(
    scope: MemoryScope,
    tenantId: string,
    ownerId: string,
    content: { subject: string; predicate: string; value: unknown },
    candidateId?: string,
  ): MemoryRecord {
    const id = generateResourceId('mem');
    const now = getCurrentISOString();

    const record: MemoryRecord = {
      id,
      scope,
      tenantId,
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
  // Deliberately NOT tenant-scoped — unchanged by this correction. It is
  // only ever called with a candidateId already resolved through a
  // tenant/owner-checked Candidate lookup (see action-resolver.ts), so the
  // caller has already authenticated ownership before this runs; scoping
  // candidate reconciliation itself is a separate, not-yet-needed concern.
  public findByCandidateId(candidateId: string): MemoryRecord | undefined {
    for (const record of this.memoryStore.values()) {
      if (record.candidateId === candidateId) return record;
    }
    return undefined;
  }

  // Seed memory initialization helper to prevent duplicate seed creation on process restart.
  public findSeedMemory(criteria: {
    scope: MemoryScope;
    tenantId: string;
    ownerId: string;
    subject: string;
    predicate: string;
  }): MemoryRecord | undefined {
    for (const record of this.memoryStore.values()) {
      if (
        record.scope === criteria.scope &&
        record.tenantId === criteria.tenantId &&
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

  public activateMemory(id: string, tenantId: string, ownerId: string): MemoryRecord {
    const record = this.requireOwned(id, tenantId, ownerId);

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

  public getActiveMemories(scope: MemoryScope, tenantId: string, ownerId: string): MemoryRecord[] {
    const active: MemoryRecord[] = [];
    for (const record of this.memoryStore.values()) {
      if (record.scope === scope && record.tenantId === tenantId && record.owner_id === ownerId && record.lifecycle === 'ACTIVE') {
        active.push(record);
      }
    }
    return active;
  }

  // By-id ownership-checked lookup (new — Memory Tenant Isolation
  // Correction). Returns undefined for a nonexistent id, a wrong tenant, or
  // a wrong owner alike — never distinguishable from each other.
  public get(id: string, tenantId: string, ownerId: string): MemoryRecord | undefined {
    const record = this.memoryStore.get(id);
    if (!record || record.tenantId !== tenantId || record.owner_id !== ownerId) return undefined;
    return record;
  }

  // Memory must be controllable and deletable (MASTER.md Safety Principle 9):
  // this permanently removes the record, not merely unpins it.
  public deleteMemory(id: string, tenantId: string, ownerId: string): MemoryRecord {
    const record = this.requireOwned(id, tenantId, ownerId);
    const deletedRecord: MemoryRecord = {
      ...record,
      lifecycle: 'DELETED',
      updated_at: getCurrentISOString(),
    };
    this.fileStore.removeOrThrow(id);
    this.memoryStore.delete(id);
    return deletedRecord;
  }
}

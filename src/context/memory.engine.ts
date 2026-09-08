import { generateResourceId, getCurrentISOString } from '../common/utils.js';
import { NagexError } from '../common/errors.js';

export type MemoryScope = 'EXECUTION' | 'SESSION' | 'AGENT' | 'USER' | 'TENANT';
export type MemoryLifecycle = 'PROPOSED' | 'VALIDATING' | 'ACTIVE' | 'CONFLICTED' | 'SUPERSEDED' | 'EXPIRED' | 'DELETED';

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

export class MemoryEngine {
  private memoryStore: Map<string, MemoryRecord> = new Map();

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

    record.lifecycle = 'ACTIVE';
    record.updated_at = getCurrentISOString();
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
    record.lifecycle = 'DELETED';
    record.updated_at = getCurrentISOString();
    this.memoryStore.delete(id);
    return record;
  }
}

import { generateResourceId, getCurrentISOString } from '../common/utils.js';
import { AgexError } from '../common/errors.js';

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
  created_at: string;
  updated_at: string;
}

export class MemoryEngine {
  private memoryStore: Map<string, MemoryRecord> = new Map();

  public proposeMemory(
    scope: MemoryScope,
    ownerId: string,
    content: { subject: string; predicate: string; value: unknown }
  ): MemoryRecord {
    const id = generateResourceId('mem');
    const now = getCurrentISOString();

    const record: MemoryRecord = {
      id,
      scope,
      owner_id: ownerId,
      lifecycle: 'PROPOSED',
      content,
      created_at: now,
      updated_at: now,
    };

    this.memoryStore.set(id, record);
    return record;
  }

  public activateMemory(id: string): MemoryRecord {
    const record = this.memoryStore.get(id);
    if (!record) {
      throw new AgexError({
        code: 'MEMORY_NOT_FOUND',
        category: 'NOT_FOUND',
        message: `Memory ID ${id} not found.`,
        request_id: 'mem_req',
      });
    }

    if (TERMINAL_MEMORY_STATES.has(record.lifecycle)) {
      throw new AgexError({
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
}

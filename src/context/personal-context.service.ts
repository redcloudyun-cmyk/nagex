import { getCurrentISOString } from '../common/utils.js';
import type { MemoryEngine, MemoryRecord, MemoryScope } from './memory.engine.js';

export interface PersonalContextBundle {
  memories: MemoryRecord[];
  generatedAt: string;
  tenantId: string;
  principalId: string;
  workspaceId?: string;
}

export interface GetContextOptions {
  tenantId: string;
  principalId: string;
  workspaceId?: string;
  prompt?: string;
  maxMemories?: number;
  allowS2?: boolean;
}

export class PersonalContextService {
  constructor(
    private readonly memoryEngine: MemoryEngine,
    private readonly pinResolver?: (id: string) => boolean
  ) {}

  public getRelevantMemories(
    tenantId: string,
    principalId: string,
    prompt: string = '',
    workspaceId?: string,
    maxMemories: number = 10,
    options?: { allowS2?: boolean }
  ): MemoryRecord[] {
    const settings = this.memoryEngine.getSettings(tenantId, principalId);
    if (!settings.memoryUseEnabled) {
      return [];
    }

    const scopes: MemoryScope[] = ['PERSONAL', 'USER', 'ORGANIZATION', 'WORKSPACE', 'SESSION', 'AGENT', 'TENANT'];
    const activeMemories = scopes.flatMap((s) => this.memoryEngine.getActiveMemories(s, tenantId, principalId));

    // Exclude DELETED / EXPIRED / SUPERSEDED / CONFLICTED / PROPOSED
    // R22.3 P0: Exclude S3 always. Exclude S2 from remote model context by default unless allowS2 is explicitly set.
    const allowS2 = options?.allowS2 === true;
    const validActive = activeMemories.filter(
      (m) =>
        m.lifecycle === 'ACTIVE' &&
        m.tenantId === tenantId &&
        m.owner_id === principalId &&
        m.sensitivity !== 'S3' &&
        (allowS2 || m.sensitivity !== 'S2')
    );

    if (validActive.length === 0) return [];

    const queryTokens = prompt
      .toLowerCase()
      .split(/[\s,._\-:;!?]+/)
      .filter((t) => t.length > 1);

    const scored = validActive.map((mem) => {
      let score = 0;
      const subj = (mem.content?.subject || '').toLowerCase();
      const pred = (mem.content?.predicate || '').toLowerCase();
      const val =
        typeof mem.content?.value === 'string'
          ? mem.content.value.toLowerCase()
          : JSON.stringify(mem.content?.value || '').toLowerCase();

      let matchCount = 0;
      for (const token of queryTokens) {
        if (subj.includes(token) || pred.includes(token) || val.includes(token)) {
          matchCount++;
        }
      }

      if (queryTokens.length === 0) {
        // No query provided: default general relevance ranking
        score += 1;
      } else {
        score += matchCount * 10;
      }

      const isPinned = Boolean(mem.pinned) || (this.pinResolver ? this.pinResolver(mem.id) : false);

      // Hard rule: Pinned memory is NOT automatically relevant!
      // An unrelated pinned memory must not leak into a prompt.
      // Only reward pin if there is at least one match or no query!
      if (isPinned && (matchCount > 0 || queryTokens.length === 0)) {
        score += 2;
      } else if (isPinned && matchCount === 0 && queryTokens.length > 0) {
        // Unrelated pinned memory with specific query gets 0 score so it won't leak!
        score = 0;
      }

      if (workspaceId && mem.workspaceId === workspaceId) {
        score += 5;
      }

      if (mem.userConfirmed) {
        score += 3;
      }

      // Recency boost (up to +3 points for items created within last 7 days)
      const ageMs = Date.now() - new Date(mem.created_at).getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      if (ageDays < 7) {
        score += Math.max(0, 3 - ageDays * 0.4);
      }

      return { mem, score };
    });

    // Filter out items with 0 score when a query prompt is supplied
    const filtered = queryTokens.length > 0 ? scored.filter((item) => item.score > 0) : scored;

    filtered.sort((a, b) => b.score - a.score);

    return filtered.slice(0, maxMemories).map((item) => item.mem);
  }

  public getPersonalContextBundle(options: GetContextOptions): PersonalContextBundle {
    const memories = this.getRelevantMemories(
      options.tenantId,
      options.principalId,
      options.prompt || '',
      options.workspaceId,
      options.maxMemories ?? 10,
      { allowS2: options.allowS2 }
    );

    return {
      memories,
      generatedAt: getCurrentISOString(),
      tenantId: options.tenantId,
      principalId: options.principalId,
      workspaceId: options.workspaceId,
    };
  }
}

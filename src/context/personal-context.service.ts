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

export const MEMORY_RELEVANCE_STOPWORDS = new Set([
  'and', 'the', 'for', 'with', 'to', 'of', 'in', 'on', 'my', 'a', 'an', 'is', 'it', 'this', 'that',
  'are', 'was', 'were', 'be', 'been', 'will', 'can', 'you', 'your', 'me', 'we', 'our', 'they', 'them',
  'but', 'or', 'if', 'not', 'no', 'do', 'does', 'did', 'have', 'has', 'had', 'from', 'as', 'at', 'by',
  '그리고', '및', '를', '을', '에', '에서', '으로', '로', '와', '과', '한', '하는', '해줘', '해', '달라', '있는', '있습니다', '합니다', '니다'
]);

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

    const trimmedPrompt = (prompt || '').trim();
    const isPromptMode = trimmedPrompt.length > 0;

    let meaningfulTokens: string[] = [];
    if (isPromptMode) {
      const rawTokens = trimmedPrompt
        .toLowerCase()
        .split(/[\s,._\-:;!?'"()\[\]{}]+/)
        .map((t) => t.trim())
        .filter((t) => t.length > 1);

      meaningfulTokens = rawTokens.filter((t) => !MEMORY_RELEVANCE_STOPWORDS.has(t));
    }

    const scored = validActive.map((mem) => {
      const subj = (mem.content?.subject || '').toLowerCase();
      const pred = (mem.content?.predicate || '').toLowerCase();
      const val =
        typeof mem.content?.value === 'string'
          ? mem.content.value.toLowerCase()
          : JSON.stringify(mem.content?.value || '').toLowerCase();

      let matchCount = 0;
      let isRelevant = false;

      if (isPromptMode) {
        if (meaningfulTokens.length > 0) {
          for (const token of meaningfulTokens) {
            if (subj.includes(token) || pred.includes(token) || val.includes(token)) {
              matchCount++;
            }
          }
          isRelevant = matchCount > 0;
        } else {
          // Prompt contained only stopwords, so no memory is relevant
          isRelevant = false;
        }
      } else {
        // General-context mode (empty prompt): all valid active memories are eligible
        isRelevant = true;
      }

      // HARD INVARIANT: RANKING_BOOST_CANNOT_CREATE_RELEVANCE=TRUE
      // If prompt-bearing and not relevant, EXCLUDE immediately.
      if (isPromptMode && !isRelevant) {
        return { mem, score: 0, isRelevant: false };
      }

      let score = isPromptMode ? matchCount * 10 : 1;

      const isPinned = Boolean(mem.pinned) || (this.pinResolver ? this.pinResolver(mem.id) : false);
      if (isPinned) {
        score += 2;
      }

      if (mem.userConfirmed) {
        score += 3;
      }

      if (workspaceId && mem.workspaceId === workspaceId) {
        score += 5;
      }

      const ageMs = Date.now() - new Date(mem.created_at).getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      if (ageDays < 7) {
        score += Math.max(0, 3 - ageDays * 0.4);
      }

      return { mem, score, isRelevant: true };
    });

    const eligible = scored.filter((item) => item.isRelevant && item.score > 0);

    eligible.sort((a, b) => b.score - a.score);

    return eligible.slice(0, maxMemories).map((item) => item.mem);
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

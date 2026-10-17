// What to LOOK UP is not what the person TYPED. A natural question ("갤럭시 폴드6와 폴드7의 주요 스펙 차이가 뭐지?") is a poor search query: an encyclopedia's full-text search returns nothing for it,
// while "갤럭시 Z 폴드7" finds the right page at once. A model is good at naming what to look up; it is NOT trusted for what the answer says - the facts come only from the pages that come back.
//
// The planner only proposes search queries. It cannot add a source, change a fact or skip a check: its output goes through the same sanitizer, the same search routes and the same URL policy as any
// query, and when it fails (no model, bad answer, too slow) the search simply uses the person's own words. Optional and replaceable; nothing depends on it for correctness.
export interface SearchQueryPlannerPort {
  plan(input: { question: string; language: 'ko' | 'en'; today: string; requestId?: string }): Promise<string[]>;
}

/** The part of AiService the planner needs (kept narrow so a test can stand in for it). */
export interface QueryPlanningModel {
  researchPlanQueries(input: { query: string; locale: 'en' | 'ko'; today: string; requestId?: string }): Promise<{ data: { queries: string[] } }>;
}

export class ModelSearchQueryPlanner implements SearchQueryPlannerPort {
  constructor(private readonly model: QueryPlanningModel, private readonly deadlineMs = 6_000) {}

  public async plan(input: { question: string; language: 'ko' | 'en'; today: string; requestId?: string }): Promise<string[]> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const answer = await Promise.race([
        this.model.researchPlanQueries({ query: input.question, locale: input.language, today: input.today, requestId: input.requestId ? `${input.requestId}_qplan` : undefined }),
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), this.deadlineMs); }),
      ]);
      if (!answer) return [];
      return cleanQueries(answer.data.queries);
    } catch {
      return [];
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/** At most three short, distinct queries; anything that looks like an instruction, a URL or a long passage is dropped. */
export function cleanQueries(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const q = item.replace(/\s+/g, ' ').trim();
    if (q.length < 2 || q.length > 120 || /https?:\/\//i.test(q) || seen.has(q.toLowerCase())) continue;
    seen.add(q.toLowerCase());
    out.push(q);
    if (out.length >= 3) break;
  }
  return out;
}

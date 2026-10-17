import { randomUUID } from 'node:crypto';
import { getCurrentISOString } from '../common/utils.js';
import { QuestionClassificationService } from './question-classification.service.js';
import { WebSearchService } from './web-search.service.js';
import { SourceFreshnessValidator } from './source-freshness.validator.js';
import type { EvidencePack, EvidenceSource, EvidencePackStatus } from './evidence-pack.types.js';
import type { SearchResult } from './web-search-provider.port.js';
import { validateOutboundUrl } from '../security/outbound-url-policy.js';
import { mentionsAny, selectRelevantExcerpt, versionedTokens } from './evidence-excerpt.js';
import type { SourceFetchOutcome } from './source-fetcher.js';
import type { SearchQueryResult } from './web-search-provider.port.js';
import type { SearchQueryPlannerPort } from './search-query-planner.js';
import { STATUS_PRECEDENCE } from './search-recovery.js';
import { detectRequestLanguage } from '../common/request-language.js';

export function mapSearchStatusToEvidenceStatus(status: string): EvidencePackStatus {
  switch (status) {
    case 'SUCCESS': return 'SUCCESS';
    case 'NO_RESULTS': return 'NO_RESULTS';
    case 'UNAVAILABLE': return 'UNAVAILABLE';
    case 'DEGRADED': return 'DEGRADED';
    case 'AUTH_FAILED': return 'AUTH_FAILED';
    case 'RATE_LIMITED': return 'RATE_LIMITED';
    case 'TIMEOUT': return 'TIMEOUT';
    case 'PROVIDER_ERROR': return 'PROVIDER_ERROR';
    case 'INVALID_RESPONSE': return 'INVALID_RESPONSE';
    case 'FAILED': return 'FAILED';
    default: return 'FAILED';
  }
}

/** The part of SourceFetcher the evidence pack needs (robots.txt, the outbound policy and byte/time budgets all live behind it). */
export interface PageExcerptFetcher { fetch(url: string): Promise<SourceFetchOutcome> }

export type WebMode = 'ON' | 'OFF' | 'UNSPECIFIED';

export interface EvidenceBuildOptions {
  forceSearch?: boolean;
  maxSources?: number;
  requestId?: string;
  /** the person's Web switch for THIS request: OFF means nothing is looked up (and the pack says so); ON / UNSPECIFIED leave it to the freshness classification */
  webMode?: WebMode;
  /** who the cache entry belongs to (tenant + principal): a person's earlier search is never served to anyone else */
  scopeKey?: string;
  /** let the query planner (when the service has one) turn the question into search queries */
  planQueries?: boolean;
}

export interface EvidencePackServiceOptions {
  /** Test-world switch, decided by the composition root and never read from the environment here: a service built without it rejects loopback and private destinations */
  allowLocalTestDestinations?: boolean;
  /** when present, the pages of the best sources are read and the passages that bear on the question go into the pack */
  fetcher?: PageExcerptFetcher;
  /** how long a successful search is reused for the same person and the same question (a follow-up "make it a table" must not search again) */
  cacheTtlMs?: number;
  /** names what to look up for a natural question (a model proposes; the facts still come only from the pages). Used only for callers that ask for it. */
  queryPlanner?: SearchQueryPlannerPort;
  /** how many of the best sources are read, and how long all of the reading may take together */
  excerptSources?: number;
  excerptBudgetMs?: number;
  now?: () => number;
}

const DEFAULT_CACHE_TTL_MS = 10 * 60_000;
const MAX_CACHE_ENTRIES = 200;
const normalizeForKey = (query: string): string => query.toLowerCase().replace(/\s+/g, ' ').trim();

export class EvidencePackService {
  private readonly cache = new Map<string, { at: number; pack: EvidencePack }>();
  private readonly now: () => number;

  constructor(
    private readonly classifier: QuestionClassificationService = new QuestionClassificationService(),
    private readonly webSearchService: WebSearchService = new WebSearchService(),
    private readonly options: EvidencePackServiceOptions = {}
  ) {
    this.now = options.now ?? Date.now;
  }

  public isWebSearchAvailable(): boolean {
    return this.webSearchService.isAvailable();
  }

  public async buildEvidencePack(query: string, options?: EvidenceBuildOptions): Promise<EvidencePack> {
    const classification = this.classifier.classify(query);
    const now = getCurrentISOString();
    const evidencePackId = `evpack_${randomUUID()}`;
    const base = { evidencePackId, query, generatedAt: now, freshnessRequirement: classification.freshness, category: classification.category } as const;

    // the person's own switch is respected: nothing leaves, and the pack says that this is why
    // the person's switch dominates everything, including a forced search: Web OFF means nothing is looked up
    if (options?.webMode === 'OFF') {
      return { ...base, status: classification.freshness === 'NONE' ? 'NOT_REQUIRED' : 'DISABLED', sources: [] };
    }

    const shouldSearch = options?.forceSearch || classification.freshness !== 'NONE';

    if (!shouldSearch) {
      return { ...base, status: 'NOT_REQUIRED', sources: [] };
    }

    if (!this.webSearchService.isAvailable()) {
      return { ...base, status: 'UNAVAILABLE', sources: [], error: 'Web search capability is unavailable.', attempts: [{ provider: this.webSearchService.getProviderName(), outcome: 'SKIPPED', failureClass: null, reasons: ['NOT_CONFIGURED'] }] };
    }

    const cacheKey = options?.scopeKey ? `${options.scopeKey}|${normalizeForKey(query)}` : null;
    if (cacheKey) {
      const hit = this.cache.get(cacheKey);
      if (hit && this.now() - hit.at < (this.options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS)) {
        return { ...hit.pack, fromCache: true };
      }
      if (hit) this.cache.delete(cacheKey);
    }

    const searchOutcome = await this.searchAll(query, options, classification.category);

    if (searchOutcome.status !== 'SUCCESS') {
      const mappedStatus = mapSearchStatusToEvidenceStatus(searchOutcome.status);
      return {
        ...base,
        status: mappedStatus,
        sources: [],
        error: searchOutcome.error || `Web search returned status ${searchOutcome.status}`,
        noEvidenceReason: searchOutcome.status === 'NO_RESULTS' ? 'NOTHING_FOUND' : 'SEARCH_FAILED',
        ...(searchOutcome.attempts ? { attempts: searchOutcome.attempts } : {}),
        ...(searchOutcome.provider ? { provider: searchOutcome.provider } : {}),
        ...(searchOutcome.queries ? { queries: searchOutcome.queries } : {}),
      };
    }

    const sources = await this.processSearchResults(searchOutcome.results, options?.maxSources || 5, now, classification.category);

    if (sources.length === 0) {
      return {
        ...base,
        status: 'NO_RESULTS',
        sources: [],
        error: 'No valid evidence sources found after URL safety validation.',
        noEvidenceReason: 'NO_SAFE_SOURCES',
        ...(searchOutcome.attempts ? { attempts: searchOutcome.attempts } : {}),
        ...(searchOutcome.provider ? { provider: searchOutcome.provider } : {}),
      };
    }

    await this.attachExcerpts(this.readingOrder(sources, query, classification.category).slice(0, this.options.excerptSources ?? 4), query, now, classification.category);

    // For a named, versioned product (a phone, a console, a graphics card) a page that mentions none of the named things is another product's page, not evidence: it is dropped, and when nothing is left the
    // honest result is "no relevant source" - never an unrelated page offered as support.
    const relevant = this.keepRelevant(sources, query, classification.category);
    if (relevant.length === 0) {
      // when part of the search could not be asked (rate limited, timed out), "nothing relevant" would be untrue: it was not all looked at
      const gap = searchOutcome.degraded ?? [];
      const notAskedAll = gap.length > 0;
      return {
        ...base,
        status: notAskedAll ? (gap.includes('RATE_LIMITED') ? 'RATE_LIMITED' : gap.includes('TIMEOUT') ? 'TIMEOUT' : 'PROVIDER_ERROR') : 'NO_RESULTS',
        sources: [],
        error: notAskedAll ? 'Part of the search could not be asked, and what was returned did not mention the product named in the question.' : 'No retrieved source mentions the product named in the question.',
        noEvidenceReason: notAskedAll ? 'SEARCH_FAILED' : 'NOTHING_RELEVANT',
        ...(searchOutcome.attempts ? { attempts: searchOutcome.attempts } : {}),
        ...(searchOutcome.provider ? { provider: searchOutcome.provider } : {}),
        ...(searchOutcome.queries ? { queries: searchOutcome.queries } : {}),
      };
    }

    const pack: EvidencePack = {
      ...base,
      status: 'SUCCESS',
      sources: relevant,
      ...(searchOutcome.attempts ? { attempts: searchOutcome.attempts } : {}),
      ...(searchOutcome.provider ? { provider: searchOutcome.provider } : {}),
      ...(searchOutcome.queries ? { queries: searchOutcome.queries } : {}),
      ...(searchOutcome.degraded && searchOutcome.degraded.length > 0 ? { degraded: searchOutcome.degraded } : {}),
    };
    if (cacheKey) {
      if (this.cache.size >= MAX_CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value as string);
      this.cache.set(cacheKey, { at: this.now(), pack });
    }
    return pack;
  }

  /**
   * One question, one or more searches. With a query planner (and only when the caller asks for it) the model names what to look up - a natural question is a poor search query - and the results of the
   * planned queries are interleaved, so each compared thing is represented. Without a planner, or when it fails, the person's own words are searched (unchanged behaviour).
   */
  private async searchAll(query: string, options: EvidenceBuildOptions | undefined, category: string): Promise<SearchQueryResult> {
    const trace: { planned: string[] | null } = { planned: null };
    const outcome = await this.searchAllInner(query, options, trace, category);
    // what was planned is reported on EVERY path (an empty list means the planner had nothing and the person's own words were searched)
    return trace.planned === null ? outcome : { ...outcome, queries: trace.planned };
  }

  private async searchAllInner(query: string, options: EvidenceBuildOptions | undefined, trace: { planned: string[] | null }, category: string): Promise<SearchQueryResult> {
    const maxResults = (options?.maxSources || 5) * 2; // Fetch extra for deduplication
    // a question about a specific product is not about an idea: a scholarly index adds noise and requests, not evidence
    const scholarly = category === 'PRODUCT' || category === 'PRODUCT_PRICE' ? false : undefined;
    const run = (q: string): Promise<SearchQueryResult> => this.webSearchService.search({ query: q, maxResults, requestId: options?.requestId, ...(scholarly === false ? { scholarly } : {}) });
    let queries = [query];
    if (options?.planQueries && this.options.queryPlanner) {
      const planned = await this.options.queryPlanner.plan({ question: query, language: detectRequestLanguage(query) === 'ko' ? 'ko' : 'en', today: new Date(this.now()).toISOString().slice(0, 10), requestId: options.requestId });
      trace.planned = planned;
      if (planned.length > 0) queries = planned;
    }
    if (queries.length === 1) return run(queries[0]);

    const outcomes = await Promise.all(queries.map(run));
    const attempts = Array.from(new Map(outcomes.flatMap((o) => o.attempts ?? []).map((a) => [JSON.stringify(a), a] as const)).values());
    const succeeded = outcomes.filter((o) => o.status === 'SUCCESS' && o.results.length > 0);
    if (succeeded.length === 0) {
      // the planned queries found nothing usable (an encyclopedia may know no page by those words): the person's own words get one try
      if (outcomes.every((o) => o.status === 'NO_RESULTS')) {
        const own = await run(query);
        return { ...own, attempts: [...attempts, ...(own.attempts ?? [])] };
      }
      const worst = outcomes.slice().sort((a, b) => STATUS_PRECEDENCE.indexOf(a.status) - STATUS_PRECEDENCE.indexOf(b.status))[0];
      return { ...worst, attempts };
    }
    const seen = new Set<string>();
    const merged: SearchResult[] = [];
    for (let i = 0; merged.length < maxResults && succeeded.some((o) => i < o.results.length); i += 1) {
      for (const o of succeeded) {
        const r = o.results[i];
        if (!r) continue;
        const key = this.normalizeUrl(String(r.url || ''));
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(r);
      }
    }
    const degraded = Array.from(new Set(outcomes.flatMap((o) => o.degraded ?? [])));
    return { status: 'SUCCESS', results: merged, provider: succeeded[0].provider, attempts, ...(degraded.length > 0 ? { degraded } : {}) };
  }

  /**
   * Which pages to READ first. For a comparison, one page for each thing compared comes before a second page about any of them: the sources are visited greedily so every named thing is covered by a page
   * that is about it (by title or summary), and the rest follow in search order. Without named things the search order stands.
   */
  private readingOrder(sources: EvidenceSource[], query: string, category: string): EvidenceSource[] {
    const tokens = category === 'PRODUCT' || category === 'PRODUCT_PRICE' ? versionedTokens(query) : [];
    if (tokens.length < 2) return sources;
    const remaining = new Set(tokens);
    const first: EvidenceSource[] = [];
    for (const token of tokens) {
      if (!remaining.has(token)) continue;
      // a page that is ABOUT the thing (its title) before one that merely mentions it (its summary)
      const about = sources.find((s) => !first.includes(s) && mentionsAny(s.title, [token])) ?? sources.find((s) => !first.includes(s) && mentionsAny(`${s.title} ${s.snippet ?? ''}`, [token]));
      if (!about) continue;
      first.push(about);
      for (const t of tokens) if (mentionsAny(about.title, [t])) remaining.delete(t);
      remaining.delete(token);
    }
    return [...first, ...sources.filter((s) => !first.includes(s))];
  }

  private keepRelevant(sources: EvidenceSource[], query: string, category: string): EvidenceSource[] {
    if (category !== 'PRODUCT' && category !== 'PRODUCT_PRICE') return sources;
    const tokens = versionedTokens(query);
    if (tokens.length === 0) return sources;
    const kept = sources.filter((s) => mentionsAny(`${s.title} ${s.snippet ?? ''} ${s.excerpt ?? ''}`, tokens));
    // the ids are consecutive again: the model and the person see [1] [2] [3], not [2] [5]
    kept.forEach((s, index) => { s.sourceId = `src_${index + 1}`; });
    return kept;
  }

  /** Reads the pages of the best sources and keeps the passages that bear on the question. A page that cannot be read (robots.txt, policy, size, time) keeps its snippet: nothing is invented to fill the gap. */
  private async attachExcerpts(toRead: EvidenceSource[], query: string, retrievedAt: string, category: string): Promise<void> {
    const fetcher = this.options.fetcher;
    if (!fetcher) return;
    const work = Promise.all(toRead.map(async (source) => {
      try {
        const outcome = await fetcher.fetch(source.url);
        if (!outcome.ok) return;
        const excerpt = selectRelevantExcerpt(outcome.source.text, query, 1800);
        if (excerpt) source.excerpt = excerpt;
        source.fullText = outcome.source.text.slice(0, 24_000);
        // the page may carry its own date when the search result did not: it is the page's claim about itself, and is used only to judge freshness
        const pageDate = outcome.source.modifiedAt || outcome.source.publishedAt;
        if (!source.publishedAt && pageDate) {
          source.publishedAt = pageDate;
          source.freshnessStatus = SourceFreshnessValidator.validateFreshness(pageDate, retrievedAt, category);
        }
      } catch {
        // an unreadable page is a snippet-only source
      }
    }));
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => { timer = setTimeout(resolve, this.options.excerptBudgetMs ?? 9_000); });
    await Promise.race([work, deadline]);
    if (timer) clearTimeout(timer);
  }

  private async processSearchResults(
    results: SearchResult[],
    limit: number,
    retrievedAt: string,
    category: string
  ): Promise<EvidenceSource[]> {
    const seenUrls = new Set<string>();
    // Directive J: Fix domain deduplication bug using Map<string, number> count tracking
    const domainCounts = new Map<string, number>();
    const validSources: EvidenceSource[] = [];

    for (const r of results) {
      if (validSources.length >= limit) break;

      const rawUrl = (r.url || '').trim();
      if (!rawUrl) continue;

      // SSRF & URL Safety validation using canonical browser-url-validator
      if (!(await this.isValidPublicUrl(rawUrl))) continue;

      const normalizedUrl = this.normalizeUrl(rawUrl);
      if (seenUrls.has(normalizedUrl)) continue;
      seenUrls.add(normalizedUrl);

      try {
        const parsed = new URL(rawUrl);
        const domain = parsed.hostname.toLowerCase();

        // Directive J: Allow up to max 2 sources per domain - except for a product comparison, where one site (the maker's, an encyclopedia) legitimately holds one page per compared model and
        // dropping the third would drop a model from the comparison
        const count = domainCounts.get(domain) || 0;
        if (count >= (category === 'PRODUCT' ? 4 : 2)) continue;
        domainCounts.set(domain, count + 1);

        const freshnessStatus = SourceFreshnessValidator.validateFreshness(r.publishedAt, retrievedAt, category);

        validSources.push({
          sourceId: `src_${validSources.length + 1}`,
          title: r.title || 'Untitled Source',
          url: rawUrl,
          sourceName: r.sourceName || domain,
          snippet: r.snippet || '',
          publishedAt: r.publishedAt,
          observedAt: r.observedAt,
          retrievedAt,
          freshnessStatus,
        });
      } catch {
        continue;
      }
    }

    return validSources;
  }

  public async isValidPublicUrl(urlString: string): Promise<boolean> {
    try {
      await validateOutboundUrl(urlString, { allowLocalTestDestinations: this.options.allowLocalTestDestinations === true });
      return true;
    } catch {
      return false;
    }
  }

  private normalizeUrl(urlStr: string): string {
    try {
      const u = new URL(urlStr);
      return `${u.protocol}//${u.hostname.toLowerCase()}${u.pathname.replace(/\/$/, '')}${u.search}`;
    } catch {
      return urlStr.toLowerCase();
    }
  }
}

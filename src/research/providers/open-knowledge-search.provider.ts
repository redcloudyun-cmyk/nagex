// A keyless, read-only search provider over two open knowledge APIs whose terms allow exactly this use:
//   - Wikipedia's MediaWiki search API (descriptive User-Agent, serial requests, CC BY-SA text that is attributed through the source list);
//   - OpenAlex's works API (open scholarly metadata, abstracts included).
// It is NOT general web search and is never presented as such: it is enabled only on purpose (NAGEX_WEB_SEARCH_PROVIDER=open_knowledge), its name appears in every report's method section, and the
// reports it feeds are built from encyclopedic and scholarly sources only. A deployment that wants news and company pages configures a web search provider (Tavily or an HTTP search endpoint) instead.
import { getCurrentISOString } from '../../common/utils.js';
import type { SearchQueryInput, SearchQueryResult, SearchResult, WebSearchProviderPort } from '../web-search-provider.port.js';

export interface OpenKnowledgeOptions {
  enabled?: boolean;
  fetchFn?: typeof fetch;
  wikipediaBase?: (language: string) => string;
  openAlexBase?: string;
  timeoutMs?: number;
  now?: () => Date;
  /** the shortest pause between two requests to the public APIs (default 200 ms on the real network, none for an injected fetch) */
  minGapMs?: number;
}

/** A public API said "too many requests". Carries how long it asked NAgex to stay away. */
class RateLimitedError extends Error {
  constructor(public readonly host: string, public readonly retryAfterMs: number) { super(`rate_limited:${host}`); }
}

const USER_AGENT = 'NAgex-Research/1.0 (read-only personal research assistant)';

const stripTags = (html: string): string => html.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#0?39;/g, "'").replace(/\s+/g, ' ').trim();

// An encyclopedia's search does not understand a question: generic words ("specifications", "차이") either match nothing or pull in pages that merely contain them (a phone question returns other phones'
// pages). The query is relaxed - letters and digits are separated ("Fold6" -> "Fold 6", the way pages spell it), generic words are dropped, the first few distinctive words are kept - and tried FIRST.
const GENERIC_WORDS = new Set(['what', 'which', 'is', 'are', 'the', 'of', 'and', 'or', 'a', 'an', 'to', 'in', 'on', 'for', 'how', 'does', 'do', 'yet', 'between', 'spec', 'specs', 'specification', 'specifications', 'features',
  'details', 'release', 'released', 'date', 'difference', 'differences', 'compare', 'comparison', 'vs', 'versus', 'price', 'review', 'latest', 'newest', 'new', '스펙', '사양', '차이', '비교', '출시', '출시일', '가격', '최신', '알려줘', '뭐지', '주요']);
export function relaxQuery(query: string): string {
  // a Korean particle glued to a number ("폴드6와", "폴드7의") is not part of the name
  const spaced = String(query ?? '').replace(/(\d)(와|과|의|을|를|은|는|이|가|도|로|에서|에|부터|까지|보다)(?![가-힣])/g, '$1').replace(/([A-Za-z가-힣])(\d)/g, '$1 $2').replace(/(\d)([A-Za-z])/g, '$1 $2');
  const tokens = spaced.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0 && !GENERIC_WORDS.has(t.toLowerCase()));
  return tokens.slice(0, 5).join(' ');
}

/** Just the named thing: the first number in the relaxed query and the (up to two) words before it - "Nintendo Switch 2", "갤럭시 폴드 6". Empty when the question names nothing versioned. */
export function entityQuery(query: string): string {
  const tokens = relaxQuery(query).split(' ').filter(Boolean);
  const at = tokens.findIndex((t, i) => i > 0 && /^\d{1,4}$/.test(t) && !/^\d+$/.test(tokens[i - 1]));
  return at < 0 ? '' : tokens.slice(Math.max(0, at - 2), at + 1).join(' ');
}

function abstractFromInvertedIndex(index: unknown): string {
  if (!index || typeof index !== 'object') return '';
  const slots: Array<[number, string]> = [];
  for (const [word, positions] of Object.entries(index as Record<string, unknown>)) {
    if (Array.isArray(positions)) for (const p of positions) if (typeof p === 'number') slots.push([p, word]);
  }
  return slots.sort((a, b) => a[0] - b[0]).map(([, w]) => w).join(' ');
}

export class OpenKnowledgeSearchProvider implements WebSearchProviderPort {
  public readonly name = 'open_knowledge';
  private readonly enabled: boolean;
  private readonly fetchFn: typeof fetch;
  private readonly wikipediaBase: (language: string) => string;
  private readonly openAlexBase: string;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private readonly minGapMs: number;
  /** per host: when the API said we may come back; nothing is sent before then (an API that said no is not asked again and again) */
  private readonly blockedUntil = new Map<string, number>();
  private lastRequestAt = 0;

  constructor(options: OpenKnowledgeOptions = {}) {
    this.enabled = options.enabled ?? (process.env.NAGEX_WEB_SEARCH_PROVIDER || '').toLowerCase() === 'open_knowledge';
    this.fetchFn = options.fetchFn || globalThis.fetch;
    this.wikipediaBase = options.wikipediaBase ?? ((language) => `https://${language}.wikipedia.org`);
    this.openAlexBase = options.openAlexBase ?? 'https://api.openalex.org';
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.now = options.now ?? (() => new Date());
    this.minGapMs = options.minGapMs ?? (options.fetchFn ? 0 : 200);
  }

  public isConfigured(): boolean {
    return this.enabled;
  }

  // The public APIs ask for serial requests with a descriptive User-Agent: every request of this provider goes through one queue, whoever asked (several planned queries may be searched at once).
  private tail: Promise<unknown> = Promise.resolve();

  private getJson(url: string): Promise<{ status: number; json?: any }> {
    const run = this.tail.then(() => this.getJsonNow(url));
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async getJsonNow(url: string): Promise<{ status: number; json?: any }> {
    const host = new URL(url).host;
    const nowMs = this.now().getTime();
    const until = this.blockedUntil.get(host) ?? 0;
    if (until > nowMs) throw new RateLimitedError(host, until - nowMs);
    const wait = this.lastRequestAt + this.minGapMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastRequestAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchFn(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: controller.signal });
      if (response.status === 429) {
        const header = Number((response.headers as any)?.get?.('retry-after'));
        const stayAway = Math.min(10 * 60_000, Math.max(5_000, Number.isFinite(header) && header > 0 ? header * 1000 : 60_000));
        this.blockedUntil.set(host, this.now().getTime() + stayAway);
        throw new RateLimitedError(host, stayAway);
      }
      if (!response.ok) return { status: response.status };
      return { status: response.status, json: await response.json() };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A ladder, each rung tried only when the one before found nothing: the relaxed query (generic words such as "specs" or "스펙" make an encyclopedia rank pages that merely contain them), then just the
   * named thing ("Nintendo Switch 2"), then the words as given. At most three requests, and only as many as needed.
   */
  private async searchWikipedia(query: string, language: string, limit: number, retrievedAt: string): Promise<SearchResult[]> {
    const seen = new Set<string>();
    for (const rung of [relaxQuery(query), entityQuery(query), query]) {
      const q = rung.trim();
      if (!q || seen.has(q.toLowerCase())) continue;
      seen.add(q.toLowerCase());
      const found = await this.searchWikipediaOnce(q, language, limit, retrievedAt);
      if (found.length > 0) return found;
    }
    return [];
  }

  private async searchWikipediaOnce(query: string, language: string, limit: number, retrievedAt: string): Promise<SearchResult[]> {
    const base = this.wikipediaBase(language);
    const url = `${base}/w/api.php?action=query&list=search&format=json&srlimit=${limit}&srprop=snippet%7Ctimestamp&srsearch=${encodeURIComponent(query)}`;
    const { status, json } = await this.getJson(url);
    if (status !== 200 || !json?.query?.search || !Array.isArray(json.query.search)) throw new Error(`wikipedia:${status}`);
    return json.query.search.map((item: any, index: number): SearchResult => ({
      id: `wiki_${language}_${item.pageid ?? index}`,
      title: String(item.title ?? 'Untitled'),
      url: `${base}/wiki/${encodeURIComponent(String(item.title ?? '').replace(/ /g, '_'))}`,
      snippet: stripTags(String(item.snippet ?? '')),
      sourceName: language === 'ko' ? 'Wikipedia (ko)' : 'Wikipedia',
      observedAt: typeof item.timestamp === 'string' ? item.timestamp : undefined,
      retrievedAt,
      provider: this.name,
    }));
  }

  private async searchOpenAlex(query: string, limit: number, retrievedAt: string): Promise<SearchResult[]> {
    const fromYear = this.now().getUTCFullYear() - 2;
    const select = 'id,title,doi,publication_date,abstract_inverted_index,primary_location';
    const url = `${this.openAlexBase}/works?search=${encodeURIComponent(query)}&filter=from_publication_date:${fromYear}-01-01&per-page=${limit}&select=${select}`;
    const { status, json } = await this.getJson(url);
    if (status !== 200 || !json || !Array.isArray(json.results)) throw new Error(`openalex:${status}`);
    const out: SearchResult[] = [];
    json.results.forEach((work: any, index: number) => {
      const landing = work?.primary_location?.landing_page_url;
      const pageUrl = typeof work?.doi === 'string' && work.doi.startsWith('http') ? work.doi : typeof landing === 'string' ? landing : '';
      const abstract = abstractFromInvertedIndex(work?.abstract_inverted_index);
      if (!pageUrl || !abstract) return;
      out.push({
        id: `oa_${String(work.id ?? index).split('/').pop()}`,
        title: String(work.title ?? 'Untitled'),
        url: pageUrl,
        snippet: abstract.slice(0, 1200),
        sourceName: work?.primary_location?.source?.display_name || 'OpenAlex',
        publishedAt: typeof work.publication_date === 'string' ? work.publication_date : undefined,
        retrievedAt,
        provider: this.name,
      });
    });
    return out;
  }

  public async search(input: SearchQueryInput): Promise<SearchQueryResult> {
    if (!this.enabled) return { status: 'UNAVAILABLE', results: [], error: 'The open knowledge search provider is not enabled.', provider: this.name };
    const max = Math.max(2, Math.min(input.maxResults || 6, 12));
    const retrievedAt = getCurrentISOString();
    const language = input.language === 'ko' || /[가-힣]/.test(input.query) ? 'ko' : 'en';
    const half = Math.ceil(max / 2);
    const results: SearchResult[] = [];
    const errors: string[] = [];
    let stayAwayMs = 0;
    const note = (e: any): void => {
      if (e instanceof RateLimitedError) { errors.push('rate_limited'); stayAwayMs = Math.max(stayAwayMs, e.retryAfterMs); return; }
      errors.push(e?.name === 'AbortError' ? 'timeout' : String(e?.message ?? e));
    };
    try { results.push(...await this.searchWikipedia(input.query, language, half, retrievedAt)); } catch (e: any) { note(e); }
    // a Korean question is also asked in English: the scholarly index and most encyclopedic coverage are English
    if (language === 'ko') { try { results.push(...await this.searchWikipedia(input.query, 'en', Math.max(1, Math.floor(half / 2)), retrievedAt)); } catch (e: any) { note(e); } }
    if (input.scholarly !== false) { try { results.push(...await this.searchOpenAlex(input.query, half, retrievedAt)); } catch (e: any) { note(e); } }

    // some of the sources answered, some did not: the results are real, and the part that failed is reported (so "no relevant page" is never claimed when a source was simply not asked)
    if (results.length > 0) return { status: 'SUCCESS', results: results.slice(0, max + 2), provider: this.name, ...(errors.length > 0 ? { degraded: errors.map((e) => (e === 'rate_limited' ? 'RATE_LIMITED' as const : e === 'timeout' ? 'TIMEOUT' as const : 'ERROR' as const)) } : {}) };
    if (errors.length > 0 && errors.every((e) => e === 'rate_limited')) return { status: 'RATE_LIMITED', results: [], error: 'The open knowledge sources asked NAgex to wait.', provider: this.name, httpStatus: 429, retryAfterMs: stayAwayMs };
    // Nothing found AND something failed on the way is NOT "nothing exists": a source that errored never looked, so the honest answer is an error (it can be retried or another route used), not an empty success.
    if (errors.length > 0) {
      const timedOut = errors.some((e) => e === 'timeout');
      return { status: timedOut ? 'TIMEOUT' : 'PROVIDER_ERROR', results: [], error: errors.length >= (language === 'ko' ? 3 : 2) ? 'The open knowledge sources could not be reached.' : 'Part of the open knowledge sources could not be reached and the rest found nothing.', provider: this.name };
    }
    return { status: 'NO_RESULTS', results: [], provider: this.name };
  }
}

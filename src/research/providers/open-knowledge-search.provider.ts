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
}

const USER_AGENT = 'NAgex-Research/1.0 (read-only personal research assistant)';

const stripTags = (html: string): string => html.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#0?39;/g, "'").replace(/\s+/g, ' ').trim();

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

  constructor(options: OpenKnowledgeOptions = {}) {
    this.enabled = options.enabled ?? (process.env.NAGEX_WEB_SEARCH_PROVIDER || '').toLowerCase() === 'open_knowledge';
    this.fetchFn = options.fetchFn || globalThis.fetch;
    this.wikipediaBase = options.wikipediaBase ?? ((language) => `https://${language}.wikipedia.org`);
    this.openAlexBase = options.openAlexBase ?? 'https://api.openalex.org';
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.now = options.now ?? (() => new Date());
  }

  public isConfigured(): boolean {
    return this.enabled;
  }

  private async getJson(url: string): Promise<{ status: number; json?: any }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchFn(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: controller.signal });
      if (!response.ok) return { status: response.status };
      return { status: response.status, json: await response.json() };
    } finally {
      clearTimeout(timer);
    }
  }

  private async searchWikipedia(query: string, language: string, limit: number, retrievedAt: string): Promise<SearchResult[]> {
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
    try { results.push(...await this.searchWikipedia(input.query, language, half, retrievedAt)); } catch (e: any) { errors.push(e?.name === 'AbortError' ? 'timeout' : String(e?.message ?? e)); }
    // a Korean question is also asked in English: the scholarly index and most encyclopedic coverage are English
    if (language === 'ko') { try { results.push(...await this.searchWikipedia(input.query, 'en', Math.max(1, Math.floor(half / 2)), retrievedAt)); } catch (e: any) { errors.push(String(e?.message ?? e)); } }
    try { results.push(...await this.searchOpenAlex(input.query, half, retrievedAt)); } catch (e: any) { errors.push(e?.name === 'AbortError' ? 'timeout' : String(e?.message ?? e)); }

    if (results.length > 0) return { status: 'SUCCESS', results: results.slice(0, max + 2), provider: this.name };
    if (errors.length > 0 && errors.length >= (language === 'ko' ? 3 : 2)) {
      const timedOut = errors.some((e) => e === 'timeout');
      return { status: timedOut ? 'TIMEOUT' : 'PROVIDER_ERROR', results: [], error: 'The open knowledge sources could not be reached.', provider: this.name };
    }
    return { status: 'NO_RESULTS', results: [], provider: this.name };
  }
}

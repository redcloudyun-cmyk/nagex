import { getCurrentISOString } from '../../common/utils.js';
import type { SearchQueryInput, SearchResult, WebSearchProviderPort } from '../web-search-provider.port.js';

export class HttpWebSearchProvider implements WebSearchProviderPort {
  public readonly name: string;
  private readonly apiKey?: string;
  private readonly endpoint?: string;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.name = env.NAGEX_WEB_SEARCH_PROVIDER || 'HTTP_SEARCH';
    this.apiKey = env.NAGEX_WEB_SEARCH_API_KEY;
    this.endpoint = env.NAGEX_WEB_SEARCH_ENDPOINT;
  }

  public isConfigured(): boolean {
    // Returns true if explicit API key/endpoint is provided or if explicit provider is configured
    return Boolean(this.apiKey || this.endpoint || (process.env.NAGEX_WEB_SEARCH_PROVIDER && process.env.NAGEX_WEB_SEARCH_PROVIDER !== 'NONE'));
  }

  public async search(input: SearchQueryInput): Promise<SearchResult[]> {
    if (!this.isConfigured()) {
      return [];
    }

    const maxResults = input.maxResults || 5;
    const now = getCurrentISOString();

    if (this.endpoint) {
      try {
        const url = new URL(this.endpoint);
        url.searchParams.set('q', input.query);
        url.searchParams.set('limit', String(maxResults));

        const headers: Record<string, string> = {
          'User-Agent': 'NAgex-Research/1.0',
        };
        if (this.apiKey) {
          headers['Authorization'] = `Bearer ${this.apiKey}`;
          headers['X-API-Key'] = this.apiKey;
        }

        const res = await fetch(url.toString(), { headers });
        if (!res.ok) return [];

        const json: any = await res.json();
        const items = Array.isArray(json) ? json : (json.results || json.data || json.organic || []);

        return items.slice(0, maxResults).map((item: any, idx: number) => ({
          id: `search_res_${idx + 1}`,
          title: item.title || item.name || 'Untitled Result',
          url: item.url || item.link || '',
          snippet: item.snippet || item.description || item.abstract || '',
          sourceName: item.sourceName || item.source || (item.url ? new URL(item.url).hostname : undefined),
          publishedAt: item.publishedAt || item.date || undefined,
          observedAt: item.observedAt || undefined,
          retrievedAt: now,
          provider: this.name,
        }));
      } catch {
        return [];
      }
    }

    return [];
  }
}

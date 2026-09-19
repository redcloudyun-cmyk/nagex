import { getCurrentISOString } from '../../common/utils.js';
import type { SearchQueryInput, SearchQueryResult, SearchResult, WebSearchProviderPort } from '../web-search-provider.port.js';

export interface HttpProviderOptions {
  apiKey?: string;
  endpoint?: string;
  providerName?: string;
  fetchFn?: typeof fetch;
}

export class HttpWebSearchProvider implements WebSearchProviderPort {
  public readonly name: string;
  private readonly apiKey?: string;
  private readonly endpoint?: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: HttpProviderOptions = {}) {
    this.name = options.providerName || process.env.NAGEX_WEB_SEARCH_PROVIDER || 'custom_http';
    this.apiKey = options.apiKey !== undefined ? options.apiKey : process.env.NAGEX_WEB_SEARCH_API_KEY;
    this.endpoint = options.endpoint !== undefined ? options.endpoint : process.env.NAGEX_WEB_SEARCH_ENDPOINT;
    this.fetchFn = options.fetchFn || globalThis.fetch;
  }

  public isConfigured(): boolean {
    // Directive D: provider must have explicit API key or endpoint configured to be truthful AVAILABLE
    return Boolean(this.apiKey && this.apiKey.trim().length > 0) || Boolean(this.endpoint && this.endpoint.trim().length > 0);
  }

  public async search(input: SearchQueryInput): Promise<SearchQueryResult> {
    if (!this.isConfigured()) {
      return {
        status: 'UNAVAILABLE',
        results: [],
        error: 'Custom HTTP search provider is not configured.',
        provider: this.name,
      };
    }

    const maxResults = input.maxResults || 5;
    const now = getCurrentISOString();

    if (!this.endpoint) {
      return {
        status: 'UNAVAILABLE',
        results: [],
        error: 'Search endpoint is required for Custom HTTP provider.',
        provider: this.name,
      };
    }

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

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const res = await this.fetchFn(url.toString(), { headers, signal: controller.signal }).finally(() => clearTimeout(timeoutId));

      if (res.status === 401 || res.status === 403) {
        return {
          status: 'AUTH_FAILED',
          results: [],
          error: `HTTP search authentication failed (HTTP ${res.status}).`,
          provider: this.name,
        };
      }

      if (res.status === 429) {
        return {
          status: 'RATE_LIMITED',
          results: [],
          error: 'HTTP search rate limit exceeded.',
          provider: this.name,
        };
      }

      if (!res.ok) {
        return {
          status: 'PROVIDER_ERROR',
          results: [],
          error: `HTTP search provider returned status ${res.status}.`,
          provider: this.name,
        };
      }

      const json: any = await res.json();
      const items = Array.isArray(json) ? json : (json.results || json.data || json.organic || []);

      const results: SearchResult[] = items.slice(0, maxResults).map((item: any, idx: number) => ({
        id: `search_res_${idx + 1}`,
        title: item.title || item.name || 'Untitled Result',
        url: item.url || item.link || '',
        snippet: item.snippet || item.description || item.abstract || '',
        sourceName: item.sourceName || item.source || (item.url ? new URL(item.url).hostname : undefined),
        publishedAt: item.publishedAt || item.date || undefined,
        observedAt: item.observedAt || undefined,
        retrievedAt: now,
        provider: this.name,
      })).filter((r: SearchResult) => r.url.length > 0);

      if (results.length === 0) {
        return {
          status: 'NO_RESULTS',
          results: [],
          provider: this.name,
        };
      }

      return {
        status: 'SUCCESS',
        results,
        provider: this.name,
      };
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        return {
          status: 'TIMEOUT',
          results: [],
          error: 'HTTP search timed out.',
          provider: this.name,
        };
      }
      return {
        status: 'PROVIDER_ERROR',
        results: [],
        error: err?.message || 'HTTP search failed.',
        provider: this.name,
      };
    }
  }
}

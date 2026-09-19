import type { SearchQueryInput, SearchQueryResult, SearchResult, WebSearchProviderPort } from '../web-search-provider.port.js';

export interface TavilyProviderOptions {
  apiKey?: string;
  endpoint?: string;
  fetchFn?: typeof fetch;
}

export class TavilyWebSearchProvider implements WebSearchProviderPort {
  public readonly name = 'tavily';
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: TavilyProviderOptions = {}) {
    // Directive D: constructor-captured options take precedence; do not mix process.env directly inside isConfigured()
    this.apiKey = options.apiKey !== undefined
      ? options.apiKey
      : (process.env.NAGEX_TAVILY_API_KEY || process.env.NAGEX_WEB_SEARCH_API_KEY || '');
    this.endpoint = options.endpoint || process.env.NAGEX_WEB_SEARCH_ENDPOINT || 'https://api.tavily.com/search';
    this.fetchFn = options.fetchFn || globalThis.fetch;
  }

  public isConfigured(): boolean {
    return Boolean(this.apiKey && this.apiKey.trim().length > 0);
  }

  public async search(input: SearchQueryInput): Promise<SearchQueryResult> {
    if (!this.isConfigured()) {
      return {
        status: 'UNAVAILABLE',
        results: [],
        error: 'Tavily API key is not configured.',
        provider: this.name,
      };
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await this.fetchFn(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          api_key: this.apiKey,
          query: input.query,
          max_results: input.maxResults || 5,
          search_depth: 'basic',
          include_answer: false,
        }),
        signal: controller.signal,
      }).finally(() => clearTimeout(timeoutId));

      if (response.status === 401 || response.status === 403) {
        return {
          status: 'AUTH_FAILED',
          results: [],
          error: `Authentication failed (HTTP ${response.status}).`,
          provider: this.name,
        };
      }

      if (response.status === 429) {
        return {
          status: 'RATE_LIMITED',
          results: [],
          error: 'Tavily API rate limit exceeded.',
          provider: this.name,
        };
      }

      if (!response.ok) {
        return {
          status: 'PROVIDER_ERROR',
          results: [],
          error: `Tavily API returned HTTP status ${response.status}.`,
          provider: this.name,
        };
      }

      const data = (await response.json()) as any;
      if (!data || !Array.isArray(data.results)) {
        return {
          status: 'INVALID_RESPONSE',
          results: [],
          error: 'Tavily API response format is invalid.',
          provider: this.name,
        };
      }

      const retrievedAt = new Date().toISOString();
      const normalized: SearchResult[] = data.results.map((item: any, idx: number) => ({
        id: `tav_${Date.now()}_${idx}`,
        title: typeof item.title === 'string' ? item.title.trim() : 'Untitled',
        url: typeof item.url === 'string' ? item.url.trim() : '',
        snippet: typeof item.content === 'string' ? item.content.trim() : typeof item.snippet === 'string' ? item.snippet.trim() : '',
        sourceName: item.domain || item.source || undefined,
        publishedAt: typeof item.published_date === 'string' && item.published_date.trim() ? item.published_date.trim() : undefined,
        retrievedAt,
        provider: this.name,
      }));

      const validResults = normalized.filter((r) => r.url.length > 0);

      if (validResults.length === 0) {
        return {
          status: 'NO_RESULTS',
          results: [],
          provider: this.name,
        };
      }

      return {
        status: 'SUCCESS',
        results: validResults,
        provider: this.name,
      };
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        return {
          status: 'TIMEOUT',
          results: [],
          error: 'Tavily web search timed out.',
          provider: this.name,
        };
      }
      return {
        status: 'PROVIDER_ERROR',
        results: [],
        error: err?.message || 'Tavily web search failed.',
        provider: this.name,
      };
    }
  }
}

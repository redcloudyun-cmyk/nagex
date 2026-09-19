import { HttpWebSearchProvider } from './providers/http-web-search.provider.js';
import { TavilyWebSearchProvider } from './providers/tavily-web-search.provider.js';
import type { SearchQueryInput, SearchQueryResult, SearchResult, WebSearchProviderPort } from './web-search-provider.port.js';
import { sanitizeTextForSearchQuery } from '../context/sensitivity.detector.js';

export type SearchCapabilityStatus = 'AVAILABLE' | 'UNAVAILABLE' | 'DEGRADED';

export class WebSearchService {
  private readonly provider: WebSearchProviderPort;

  constructor(provider?: WebSearchProviderPort) {
    if (provider) {
      this.provider = provider;
    } else {
      const providerType = (process.env.NAGEX_WEB_SEARCH_PROVIDER || '').toLowerCase();
      if (providerType === 'tavily' || Boolean(process.env.NAGEX_TAVILY_API_KEY)) {
        this.provider = new TavilyWebSearchProvider();
      } else {
        this.provider = new HttpWebSearchProvider();
      }
    }
  }

  public getProviderName(): string {
    return this.provider.name;
  }

  public isAvailable(): boolean {
    return this.provider.isConfigured();
  }

  public getStatus(): SearchCapabilityStatus {
    return this.isAvailable() ? 'AVAILABLE' : 'UNAVAILABLE';
  }

  public status(): { configured: boolean; status: SearchCapabilityStatus; provider: string } {
    const configured = this.isAvailable();
    return {
      configured,
      status: configured ? 'AVAILABLE' : 'UNAVAILABLE',
      provider: this.provider.name,
    };
  }

  public sanitizeQuery(query: string): string {
    return sanitizeTextForSearchQuery(query);
  }

  public async search(input: SearchQueryInput): Promise<SearchQueryResult> {
    if (!this.isAvailable()) {
      return {
        status: 'UNAVAILABLE',
        results: [],
        error: 'Web search provider is not configured or unavailable.',
        provider: this.provider.name,
      };
    }

    // Directive F: Re-use canonical sensitivity detector to strip S2/S3 secret markers or personal sensitive data before sending query
    const sanitizedQuery = this.sanitizeQuery(input.query);
    if (!sanitizedQuery.trim()) {
      return {
        status: 'NO_RESULTS',
        results: [],
        error: 'Query became empty after sensitivity sanitization.',
        provider: this.provider.name,
      };
    }

    return this.provider.search({
      ...input,
      query: sanitizedQuery,
    });
  }
}

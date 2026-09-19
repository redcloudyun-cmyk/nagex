import { HttpWebSearchProvider } from './providers/http-web-search.provider.js';
import type { SearchQueryInput, SearchResult, WebSearchProviderPort } from './web-search-provider.port.js';

export type SearchCapabilityStatus = 'AVAILABLE' | 'UNAVAILABLE' | 'DEGRADED';

export class WebSearchService {
  private readonly provider: WebSearchProviderPort;

  constructor(provider?: WebSearchProviderPort) {
    this.provider = provider || new HttpWebSearchProvider();
  }

  public isAvailable(): boolean {
    return this.provider.isConfigured();
  }

  public getStatus(): SearchCapabilityStatus {
    return this.isAvailable() ? 'AVAILABLE' : 'UNAVAILABLE';
  }

  public status(): { configured: boolean; status: SearchCapabilityStatus } {
    const configured = this.isAvailable();
    return {
      configured,
      status: configured ? 'AVAILABLE' : 'UNAVAILABLE',
    };
  }

  public sanitizeQuery(query: string): string {
    return this.sanitizeSearchQuery(query);
  }

  public async search(input: SearchQueryInput): Promise<SearchResult[]> {
    if (!this.isAvailable()) {
      return [];
    }

    // Security: sanitize query to ensure S2/S3 secret markers or personal sensitive markers are never sent to external search providers
    const sanitizedQuery = this.sanitizeSearchQuery(input.query);
    if (!sanitizedQuery.trim()) {
      return [];
    }

    return this.provider.search({
      ...input,
      query: sanitizedQuery,
    });
  }

  private sanitizeSearchQuery(query: string): string {
    let q = query || '';
    // Strip S3 secret keys sk-...
    q = q.replace(/sk-[a-zA-Z0-9\-_]{20,}/gi, '');
    // Strip Bearer tokens
    q = q.replace(/bearer\s+[a-zA-Z0-9\._\-]{20,}/gi, '');
    // Strip API keys / secret parameters
    q = q.replace(/(?:api_key|apikey|secret|key)\s*[:=]?\s*[a-zA-Z0-9\-_]+/gi, '');
    // Strip S2 personal emails
    q = q.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '');
    // Strip phone numbers
    q = q.replace(/01[016789]-?\d{3,4}-?\d{4}/g, '');
    // Strip SSN
    q = q.replace(/\d{3}-\d{2}-\d{4}/g, '');
    // Strip S2 personal context user markers e.g. "for user Jane Smith", "User Profile: Jane Smith"
    q = q.replace(/(?:for\s+user|user\s+profile:?|user)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?/gi, '');
    return q.replace(/\s+/g, ' ').trim();
  }
}

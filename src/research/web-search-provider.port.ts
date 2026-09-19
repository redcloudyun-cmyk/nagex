export interface SearchQueryInput {
  query: string;
  maxResults?: number;
  freshness?: string;
  language?: string;
  region?: string;
  requestId?: string;
}

export interface SearchResult {
  id: string;
  title: string;
  url: string;
  snippet: string;
  sourceName?: string;
  publishedAt?: string;
  observedAt?: string;
  retrievedAt: string;
  provider: string;
}

export type SearchProviderResultStatus =
  | 'SUCCESS'
  | 'NO_RESULTS'
  | 'UNAVAILABLE'
  | 'AUTH_FAILED'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'PROVIDER_ERROR'
  | 'INVALID_RESPONSE'
  | 'FAILED';

export interface SearchQueryResult {
  status: SearchProviderResultStatus;
  results: SearchResult[];
  error?: string;
  provider?: string;
}

export interface WebSearchProviderPort {
  readonly name: string;
  isConfigured(): boolean;
  search(input: SearchQueryInput): Promise<SearchQueryResult>;
}

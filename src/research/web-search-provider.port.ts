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

export interface WebSearchProviderPort {
  readonly name: string;
  isConfigured(): boolean;
  search(input: SearchQueryInput): Promise<SearchResult[]>;
}

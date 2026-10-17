export interface SearchQueryInput {
  query: string;
  maxResults?: number;
  freshness?: string;
  language?: string;
  region?: string;
  requestId?: string;
  /** false: the question is about a specific product, not an idea - a provider with a scholarly index leaves it out (papers are noise for "what are this phone's specs") */
  scholarly?: boolean;
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
  /** what the provider said about a failure, for classification only (never shown to the person) */
  httpStatus?: number;
  retryAfterMs?: number;
  /** the provider says the plan's quota is used up (not a momentary rate limit) */
  quotaExhausted?: boolean;
  /** routes tried or skipped on the way to this result (set by the search service when it recovered from a failure) */
  attempts?: import('./evidence-pack.types.js').SearchAttemptSummary[];
  /** sources of a multi-source provider that did NOT answer although others did (the results are real; the gap is reported) */
  degraded?: Array<'RATE_LIMITED' | 'TIMEOUT' | 'ERROR'>;
  /** the (sanitized) queries that were actually sent, when more than the person's own words were searched */
  queries?: string[];
}

/** A documented Retry-After header (delta-seconds form) in milliseconds; anything else is no information. */
export function retryAfterMsOf(headers: { get(name: string): string | null } | undefined | null): number | undefined {
  const raw = headers?.get('retry-after');
  if (!raw || !/^\d{1,6}$/.test(raw.trim())) return undefined;
  return Number(raw.trim()) * 1000;
}

export interface WebSearchProviderPort {
  readonly name: string;
  isConfigured(): boolean;
  search(input: SearchQueryInput): Promise<SearchQueryResult>;
}

import type { FreshnessRequirement } from './question-classification.service.js';

export type SourceFreshnessStatus = 'CURRENT' | 'RECENT' | 'UNDATED' | 'STALE' | 'UNKNOWN' | 'SUSPICIOUS';

export type EvidencePackStatus =
  | 'NOT_REQUIRED'
  /** the person turned Web research off for this request: nothing was looked up, and that is the reason */
  | 'DISABLED'
  | 'SUCCESS'
  | 'NO_RESULTS'
  | 'UNAVAILABLE'
  | 'DEGRADED'
  | 'AUTH_FAILED'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'PROVIDER_ERROR'
  | 'INVALID_RESPONSE'
  | 'FAILED';

export interface EvidenceSource {
  sourceId: string;
  title: string;
  url: string;
  sourceName?: string;
  snippet?: string;
  /** the page text as it was read (bounded), kept in memory so claims can be checked against it - NEVER sent to the client */
  fullText?: string;
  /** the passages of the page itself that bear on the question (fetched under robots.txt and the outbound policy); absent when the page could not be read */
  excerpt?: string;
  publishedAt?: string;
  observedAt?: string;
  retrievedAt: string;
  freshnessStatus: SourceFreshnessStatus;
}

/** What one search route did, in words that carry no provider text and no secret. */
export interface SearchAttemptSummary {
  provider: string;
  outcome: 'SUCCEEDED' | 'FAILED' | 'SKIPPED';
  /** the normalized failure class (see src/adaptive/failure-taxonomy.ts), or null when the route succeeded or was not tried */
  failureClass: string | null;
  /** SKIPPED routes say why: NOT_CONFIGURED, QUOTA_EXHAUSTED_RECENTLY, AUTH_REJECTED ... */
  reasons?: string[];
}

export interface EvidencePack {
  evidencePackId: string;
  query: string;
  generatedAt: string;
  freshnessRequirement: FreshnessRequirement;
  category: string;
  status: EvidencePackStatus;
  sources: EvidenceSource[];
  error?: string;
  /** every route that was tried or skipped, in order; empty when nothing was searched */
  attempts?: SearchAttemptSummary[];
  /** the provider that produced the sources */
  provider?: string;
  /** what was searched when it was not simply the person's own words (a planned set of short queries) */
  queries?: string[];
  /** sources of the search that did not answer although others did (the offered sources are real; the gap is reported) */
  degraded?: Array<'RATE_LIMITED' | 'TIMEOUT' | 'ERROR'>;
  /** when no source is offered: why (a coded reason, never provider text) */
  noEvidenceReason?: 'SEARCH_FAILED' | 'NOTHING_FOUND' | 'NO_SAFE_SOURCES' | 'NOTHING_RELEVANT';
  /** the sources of this query were kept from an earlier search of the same person a few minutes ago */
  fromCache?: boolean;
}

export interface ResearchResult {
  query: string;
  freshness: FreshnessRequirement;
  category: string;
  answer: string;
  evidencePackId: string;
  sources: EvidenceSource[];
  executedAt: string;
}

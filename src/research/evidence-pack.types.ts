import type { FreshnessRequirement } from './question-classification.service.js';

export type SourceFreshnessStatus = 'CURRENT' | 'RECENT' | 'UNDATED' | 'STALE' | 'UNKNOWN' | 'SUSPICIOUS';

export type EvidencePackStatus =
  | 'NOT_REQUIRED'
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
  publishedAt?: string;
  observedAt?: string;
  retrievedAt: string;
  freshnessStatus: SourceFreshnessStatus;
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

// What a research run keeps, so that a report can always be traced back to what was actually retrieved: the sources (address, publisher, publication date, the moment each was retrieved, how, and a hash of
// the text that was read), the verified claims with their verbatim quotes, and what was rejected or skipped. Owner- and tenant-scoped; never contains a credential.
import type { SourceFreshnessStatus } from './evidence-pack.types.js';

/** FULL_TEXT: the page itself was fetched and read. SEARCH_SNIPPET: the page could not be fetched; only the text the search provider returned was available. */
export type RetrievalBasis = 'FULL_TEXT' | 'SEARCH_SNIPPET';

export interface ResearchSourceRecord {
  sourceId: string;
  title: string;
  publisher: string;
  url: string;
  finalUrl: string;
  publishedAt?: string;
  /** when the source says it was last modified or edited (not the same as when it was first published) */
  updatedAt?: string;
  retrievedAt: string;
  basis: RetrievalBasis;
  /** sha256 of the exact text the claims were checked against */
  contentHash: string;
  textLength: number;
  textTruncated: boolean;
  httpStatus?: number;
  robots: 'ALLOWED' | 'NO_ROBOTS_FILE' | 'NOT_APPLICABLE';
  freshness: SourceFreshnessStatus;
  provider: string;
  /** why the page itself could not be read when only the search provider's excerpt was used */
  fetchNote?: string;
}

export interface ResearchSkippedSource {
  url: string;
  title?: string;
  reason: string;
  message: string;
}

export interface ResearchClaimRecord {
  claimId: string;
  sourceId: string;
  statement: string;
  /** copied verbatim from the source text; NAgex found it there */
  quote: string;
}

export interface ResearchConflictRecord {
  topic: string;
  claimIds: string[];
  note: string;
}

export interface ResearchStepRecord {
  step: 'PLAN' | 'SEARCH' | 'RETRIEVE' | 'EXTRACT' | 'COMPOSE' | 'PUBLISH';
  status: 'DONE' | 'SKIPPED' | 'FAILED';
  detail?: string;
}

export type ResearchRunStatus = 'COMPLETED' | 'UNAVAILABLE' | 'NO_RESULTS' | 'NO_EVIDENCE' | 'FAILED';

export interface ResearchRunRecord {
  runId: string;
  tenantId: string;
  ownerId: string;
  query: string;
  locale: 'en' | 'ko';
  status: ResearchRunStatus;
  provider: string;
  plannedQueries: string[];
  startedAt: string;
  completedAt: string;
  sources: ResearchSourceRecord[];
  skipped: ResearchSkippedSource[];
  claims: ResearchClaimRecord[];
  rejectedClaims: number;
  rejectionReasons: Record<string, number>;
  /** a few of the statements that were refused, with the reason - what was NOT admitted is as inspectable as what was */
  rejectedSamples: Array<{ reason: string; sourceId?: string; statement?: string }>;
  conflicts: ResearchConflictRecord[];
  droppedParagraphs: number;
  steps: ResearchStepRecord[];
  /** the sources the report actually cites (the others were read but not used) */
  citedSourceIds?: string[];
  documentId?: string;
  artifactId?: string;
  failure?: { code: string; message: string };
}

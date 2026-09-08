export type CaptureType = 'TEXT' | 'LINK' | 'FILE' | 'AUDIO';

export type CaptureStatus =
  | 'CAPTURED'
  | 'UPLOADING'
  | 'QUEUED'
  | 'PROCESSING'
  | 'EXTRACTED'
  | 'UNDERSTOOD'
  | 'READY'
  | 'NEEDS_REVIEW'
  | 'ACTIONED'
  | 'FAILED'
  | 'ARCHIVED';

export type ProcessingStage =
  | 'CAPTURED'
  | 'UPLOADED'
  | 'QUEUED'
  | 'PROCESSING'
  | 'EXTRACTED'
  | 'UNDERSTOOD'
  | 'NEEDS_REVIEW'
  | 'READY'
  | 'ACTIONED'
  | 'FAILED';

export type CandidateStatus = 'PROPOSED' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED';

export interface CandidateSourceRef {
  chunkId?: string;
  pageNumber?: number;
  snippet?: string;
}

export interface BaseCandidate {
  candidateId: string;
  captureId: string;
  type: 'TASK' | 'CALENDAR' | 'MEMORY' | 'KNOWLEDGE';
  title: string;
  reason: string;
  confidence: number;
  sourceRefs: CandidateSourceRef[];
  status: CandidateStatus;
}

export interface TaskCandidate extends BaseCandidate {
  type: 'TASK';
  description?: string;
  dueDateCandidate?: string;
  priorityCandidate?: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface CalendarCandidate extends BaseCandidate {
  type: 'CALENDAR';
  startCandidate?: string;
  endCandidate?: string;
  timezone?: string;
  location?: string;
}

export interface MemoryCandidate extends BaseCandidate {
  type: 'MEMORY';
  statement: string;
  memoryType?: 'USER' | 'FACT' | 'PREFERENCE';
  scope?: string;
}

export interface KnowledgeCandidate extends BaseCandidate {
  type: 'KNOWLEDGE';
  summary: string;
  tags?: string[];
  chunkIds?: string[];
}

export type WorkspaceCandidate =
  | TaskCandidate
  | CalendarCandidate
  | MemoryCandidate
  | KnowledgeCandidate;

// Real Text Understanding output (Phase 1 STEP 2) — grounded in the source
// content only, never invented.
export interface ExtractedEntity {
  name: string;
  type: string;
}

export interface ExtractedDate {
  text: string;
  normalized: string | null;
  confidence: number;
}

export interface ExtractedActionItem {
  text: string;
  confidence: number;
}

export interface ProcessingChunk {
  // Deterministic for the same captureId + contentHash (Phase 1 STEP 4, item
  // G) — a retry over unchanged bytes always mints the same chunkIds.
  chunkId: string;
  text: string;
  // null (never guessed) when the source has no page structure (e.g. a URL
  // capture) or the parser could not determine page boundaries.
  pageStart: number | null;
  pageEnd: number | null;
  characterStart: number;
  characterEnd: number;
  tokenEstimate: number;
}

export interface CaptureMetadata {
  originalName?: string;
  mimeType?: string;
  sizeBytes?: number;
  url?: string;
  durationSeconds?: number;
  extractedTitle?: string;
  extractedSummary?: string;
  extractedTags?: string[];
  objectKey?: string;
  storageProvider?: 'local' | 's3';
  checksum?: string;

  // Canonical Pipeline Metadata
  processingStage?: ProcessingStage;
  processingSubStage?: string; // 'Reading page...', 'Extracting PDF...', 'Analyzing content...', 'Preparing suggestions...'
  processingStartedAt?: string;
  processingCompletedAt?: string;
  processorVersion?: string; // '1.0.0'
  modelProvider?: string;
  modelName?: string;
  modelRequestId?: string;
  modelLatencyMs?: number;
  errorCode?: string;
  errorMessage?: string;
  // Phase 1 STEP 9, item C/R — the same failure taxonomy used for Candidate
  // Actions, so the UI's Retry/"Try again" gating reads one consistent pair
  // of fields regardless of whether a capture or an action failed.
  failureCategory?: 'RETRYABLE' | 'TERMINAL' | 'AMBIGUOUS' | 'NEEDS_HUMAN';
  retryable?: boolean;
  // Durable retry bookkeeping (item D/V) — survives restart via the same
  // CaptureItem persistence every other field here already uses.
  retryAttemptCount?: number;
  lastRetryAt?: string;

  // Extracted Web & Document Properties
  sourceUrl?: string;
  finalUrl?: string;
  // null (never a fabricated placeholder) when the real page genuinely has
  // no title — see Phase 1 STEP 3, item D.
  pageTitle?: string | null;
  retrievedAt?: string;
  contentText?: string;
  contentHash?: string;
  pageCount?: number;
  characterCount?: number;
  chunks?: ProcessingChunk[];
  // Real PDF extraction truthfulness (Phase 1 STEP 4, item D/N).
  extractedCharacters?: number;
  hasText?: boolean;
  extractionMethod?: string;
  extractionWarnings?: string[];
  totalChunks?: number;
  processedChunks?: number;
  // Browser Agent session used for this retrieval (Phase 1 STEP 3, item D) —
  // present whenever a session was actually opened, even on a failed or
  // human-verification-blocked retrieval.
  browserSessionId?: string | null;
  // Large-page/large-document handling truthfulness (Phase 1 STEP 3 item J,
  // reused for PDFs in STEP 4 item I): whether the content sent to the model
  // covered the full retrieved page/document or was truncated, and how much.
  truncated?: boolean;
  processedCharacters?: number;
  totalCharacters?: number;

  // Extracted Entities, Dates, Action Items & Topics
  topics?: string[];
  entities?: ExtractedEntity[];
  dates?: ExtractedDate[];
  actionItems?: ExtractedActionItem[];

  // Transcripts & Hardened Candidates
  transcript?: {
    text: string;
    timestamps?: Array<{ start: number; end: number; text: string }>;
    speakers?: Array<{ speaker: string; text: string }>;
  };
  extractedContent?: string;
  // Legacy embedded candidate array (Phase 1 STEP 2-4) — kept as a
  // temporary backward-compatibility echo (Phase 1 STEP 5, item O). Not the
  // source of truth: canonical candidate identity/status lives in
  // CandidateStore, referenced by candidateIds below.
  candidates?: WorkspaceCandidate[];
  // References into the canonical CandidateStore (Phase 1 STEP 5, item P) —
  // the durable, typed record for each id is the source of truth for that
  // candidate's status; this capture never stores a second, divergent copy
  // of it.
  candidateIds?: string[];
  suggestedAction?: {
    type: 'TASK' | 'CALENDAR' | 'MEMORY' | 'KNOWLEDGE';
    title: string;
    detail?: string;
  };
}

export interface CaptureItem {
  captureId: string;
  ownerId: string;
  tenantId: string;
  type: CaptureType;
  content: string; // Text content, URL, or reference
  status: CaptureStatus;
  source: 'WEB' | 'DESKTOP' | 'MOBILE' | 'TELEGRAM' | 'SLACK';
  metadata: CaptureMetadata;
  vaultPath?: string;
  createdAt: string;
  updatedAt: string;
}

export interface VaultCategory {
  categoryId: string;
  name: string;
  icon: string;
  itemCount: number;
  totalSizeBytes: number;
}

export interface PersonalVaultSummary {
  ownerId: string;
  totalItems: number;
  totalSizeBytes: number;
  quotaSizeBytes: number;
  storageInfo: {
    provider: 'local' | 's3';
    isCloud: boolean;
    label: string;
    mode?: 'LIVE' | 'DEVELOPMENT' | 'OFFLINE';
    reachable?: boolean;
    endpointReachable?: boolean;
    bucketAuthorized?: boolean;
    readable?: boolean;
    writable?: boolean;
    bucket?: string;
    region?: string;
  };
  categories: VaultCategory[];
  recentItems: CaptureItem[];
}

export interface InboxSummary {
  ownerId: string;
  unreadCount: number;
  needsReviewCount: number;
  items: CaptureItem[];
}

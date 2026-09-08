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

export interface ProcessingChunk {
  chunkId: string;
  text: string;
  pageNumber?: number;
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
  errorCode?: string;
  errorMessage?: string;

  // Extracted Web & Document Properties
  sourceUrl?: string;
  finalUrl?: string;
  pageTitle?: string;
  retrievedAt?: string;
  contentText?: string;
  contentHash?: string;
  pageCount?: number;
  characterCount?: number;
  chunks?: ProcessingChunk[];

  // Extracted Entities, Dates, Action Items & Topics
  topics?: string[];
  entities?: string[];
  dates?: string[];
  actionItems?: string[];

  // Transcripts & Hardened Candidates
  transcript?: {
    text: string;
    timestamps?: Array<{ start: number; end: number; text: string }>;
    speakers?: Array<{ speaker: string; text: string }>;
  };
  extractedContent?: string;
  candidates?: WorkspaceCandidate[];
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

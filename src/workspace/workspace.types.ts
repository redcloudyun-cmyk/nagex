export type CaptureType = 'TEXT' | 'LINK' | 'FILE' | 'AUDIO';

export type CaptureStatus =
  | 'CAPTURED'
  | 'UPLOADING'
  | 'QUEUED'
  | 'PROCESSING'
  | 'READY'
  | 'NEEDS_REVIEW'
  | 'ACTIONED'
  | 'FAILED'
  | 'ARCHIVED';

export interface TaskCandidate {
  type: 'TASK';
  title: string;
  description?: string;
  dueDate?: string;
  priority?: 'LOW' | 'MEDIUM' | 'HIGH';
  confidence: number;
}

export interface CalendarCandidate {
  type: 'CALENDAR';
  title: string;
  startTime?: string;
  endTime?: string;
  location?: string;
  confidence: number;
}

export interface MemoryCandidate {
  type: 'MEMORY';
  content: string;
  category?: string;
  confidence: number;
}

export interface KnowledgeCandidate {
  type: 'KNOWLEDGE';
  title: string;
  content: string;
  tags?: string[];
  confidence: number;
}

export type WorkspaceCandidate =
  | TaskCandidate
  | CalendarCandidate
  | MemoryCandidate
  | KnowledgeCandidate;

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
  transcript?: {
    text: string;
    timestamps?: Array<{ start: number; end: number; text: string }>;
    speakers?: Array<{ speaker: string; text: string }>;
  };
  extractedContent?: string;
  chunks?: string[];
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

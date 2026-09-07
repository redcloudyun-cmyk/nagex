export type CaptureType = 'TEXT' | 'LINK' | 'FILE' | 'AUDIO';

export type CaptureStatus =
  | 'CAPTURED'
  | 'UPLOADING'
  | 'PROCESSING'
  | 'READY'
  | 'NEEDS_REVIEW'
  | 'ACTIONED'
  | 'FAILED'
  | 'ARCHIVED';

export interface CaptureMetadata {
  originalName?: string;
  mimeType?: string;
  sizeBytes?: number;
  url?: string;
  durationSeconds?: number;
  extractedTitle?: string;
  extractedSummary?: string;
  extractedTags?: string[];
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
  content: string; // Text content, URL, file path, or transcript
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
  categories: VaultCategory[];
  recentItems: CaptureItem[];
}

export interface InboxSummary {
  ownerId: string;
  unreadCount: number;
  needsReviewCount: number;
  items: CaptureItem[];
}

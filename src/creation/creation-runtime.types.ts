import type { RoutingMode } from '../model-gateway/model-provider.js';

export type CreationKind = 'DOCUMENT' | 'REPORT' | 'IMAGE' | 'PRESENTATION' | 'VIDEO';

export type CreationStatus = 'SUCCESS' | 'FAILED' | 'UNAVAILABLE';

export interface CreationSourceRef {
  type: 'EVIDENCE_PACK' | 'CAPTURE' | 'MEMORY' | 'ARTIFACT';
  id: string;
}

export interface CreationRequest {
  creationKind: CreationKind;
  prompt: string;
  sourceRefs?: CreationSourceRef[];
  options?: {
    documentKind?: string;
    style?: string;
    targetAudience?: string;
    locale?: 'en' | 'ko';
    format?: 'MARKDOWN' | 'PDF' | 'HTML';
    routingMode?: RoutingMode;
    aspectRatio?: string;
    requestedProviderId?: string;
    transparentBackground?: boolean;
    privacyMode?: 'STANDARD' | 'LOCAL_ONLY';
    title?: string;
    // the part of the prompt that is the person's own words (a revision's prompt also carries the existing document): the page count is read from this alone
    lengthRequest?: string;
  };
  tenantId: string;
  ownerId: string;
  requestId: string;
}

export interface CreationResult {
  status: CreationStatus;
  creationId: string;
  creationKind: CreationKind;
  title: string;
  summary: string;
  content: string;
  openTarget: string;
  artifactId?: string;
  mimeType: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface DocumentCreationSpec {
  title?: string;
  documentKind?: string;
  objective: string;
  instructions: string;
  sourceContext?: string;
  locale: 'en' | 'ko';
  requestedFormat?: 'MARKDOWN' | 'PDF' | 'HTML';
  routingMode?: RoutingMode;
  tenantId: string;
  ownerId: string;
  requestId: string;
}

export interface DocumentRecord {
  documentId: string;
  tenantId: string;
  ownerId: string;
  title: string;
  summary: string;
  content: string;
  documentKind: string;
  locale: 'en' | 'ko';
  format: 'MARKDOWN' | 'PDF' | 'HTML';
  sourceRefs: CreationSourceRef[];
  parentDocumentId?: string;
  revisionIndex: number;
  artifactId?: string;
  // Additive: the research run (sources, retrieval times, verified claims) this report was composed from
  researchRunId?: string;
  // Additive: this version was made by bringing an older version back (the older version itself is untouched)
  restoredFromDocumentId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreationExecutor<TReq = CreationRequest, TRes = CreationResult> {
  readonly kind: CreationKind;
  execute(request: TReq): Promise<TRes>;
}

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
  createdAt: string;
  updatedAt: string;
}

export interface CreationExecutor<TReq = CreationRequest, TRes = CreationResult> {
  readonly kind: CreationKind;
  execute(request: TReq): Promise<TRes>;
}

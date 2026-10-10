import crypto from 'node:crypto';
import type { AiService } from '../../model-gateway/ai-service.js';
import type { DocumentStore } from '../document.store.js';
import type { ArtifactStore } from '../../artifacts/artifact.store.js';
import type { AuditLogger } from '../../governance/audit.logger.js';
import type { MemoryRecord } from '../../context/memory.engine.js';
import type {
  CreationExecutor,
  CreationKind,
  CreationRequest,
  CreationResult,
  DocumentRecord,
} from '../creation-runtime.types.js';

export interface DocumentExecutorDeps {
  aiService: AiService;
  documentStore: DocumentStore;
  artifactStore?: ArtifactStore;
  auditLogger?: AuditLogger;
  getRelevantMemories?: (tenantId: string, ownerId: string, query: string) => MemoryRecord[];
}

export class DocumentExecutor implements CreationExecutor<CreationRequest, CreationResult> {
  public readonly kind: CreationKind = 'DOCUMENT';

  constructor(private readonly deps: DocumentExecutorDeps) {}

  public async execute(request: CreationRequest): Promise<CreationResult> {
    const { tenantId, ownerId, requestId, prompt, options = {} } = request;
    const locale = options.locale || 'en';
    const documentKind = options.documentKind || 'REPORT';

    if (!prompt || !prompt.trim()) {
      return {
        status: 'FAILED',
        creationId: '',
        creationKind: 'DOCUMENT',
        title: '',
        summary: '',
        content: '',
        openTarget: '',
        mimeType: 'text/markdown',
        createdAt: new Date().toISOString(),
        errorCode: 'INVALID_PROMPT',
        errorMessage: 'Document creation prompt is required.',
      };
    }

    try {
      const memories = this.deps.getRelevantMemories
        ? this.deps.getRelevantMemories(tenantId, ownerId, prompt)
        : [];

      const outcome = await this.deps.aiService.documentSynthesis({
        prompt: prompt.trim(),
        documentKind,
        instructions: options.style,
        locale,
        memories,
        mode: options.routingMode || 'auto',
        requestId,
      });

      const { title, summary, content } = outcome.data;

      // Truthfulness validation: Reject empty / null / whitespace-only content
      if (!title || !title.trim() || !content || !content.trim()) {
        return {
          status: 'FAILED',
          creationId: '',
          creationKind: 'DOCUMENT',
          title: '',
          summary: '',
          content: '',
          openTarget: '',
          mimeType: 'text/markdown',
          createdAt: new Date().toISOString(),
          errorCode: 'EMPTY_GENERATION',
          errorMessage: 'Model provider returned empty document content.',
        };
      }

      const documentId = `doc_${crypto.createHash('sha256').update(`${tenantId}:${ownerId}:${requestId}:${prompt.slice(0, 50)}`).digest('hex').slice(0, 24)}`;
      const now = new Date().toISOString();

      const docRecord: DocumentRecord = {
        documentId,
        tenantId,
        ownerId,
        title: title.trim(),
        summary: summary.trim(),
        content: content.trim(),
        documentKind,
        locale,
        format: options.format || 'MARKDOWN',
        sourceRefs: request.sourceRefs || [],
        revisionIndex: 1,
        createdAt: now,
        updatedAt: now,
      };

      // Persist canonical document artifact
      this.deps.documentStore.save(docRecord);

      // Persist thin durable projection to ArtifactStore for Recent Creations
      let artifactRecord;
      if (this.deps.artifactStore) {
        artifactRecord = this.deps.artifactStore.saveCompleted({
          tenantId,
          ownerId,
          type: 'DOCUMENT',
          title: docRecord.title,
          preview: docRecord.summary || docRecord.content.slice(0, 500),
          sourceType: 'CAPTURE',
          sourceId: documentId,
          openTarget: `/api/v1/creations/documents/${documentId}`,
        });
        docRecord.artifactId = artifactRecord.artifactId;
        this.deps.documentStore.save(docRecord);
      }

      // Log governance audit event if logger present
      this.deps.auditLogger?.logEvent({
        actor: { type: 'user', id: ownerId },
        tenant_id: tenantId,
        action: 'document.created',
        resource: { type: 'DocumentRecord', id: documentId },
        result: 'SUCCESS',
        request_id: requestId,
        details: { title: docRecord.title, documentKind, provider: outcome.provider, model: outcome.model },
      });

      return {
        status: 'SUCCESS',
        creationId: documentId,
        creationKind: 'DOCUMENT',
        title: docRecord.title,
        summary: docRecord.summary,
        content: docRecord.content,
        openTarget: `/api/v1/creations/documents/${documentId}`,
        artifactId: artifactRecord?.artifactId,
        mimeType: 'text/markdown',
        metadata: {
          provider: outcome.provider,
          model: outcome.model,
          latencyMs: outcome.latencyMs,
          documentKind,
        },
        createdAt: now,
      };
    } catch (error: any) {
      return {
        status: 'FAILED',
        creationId: '',
        creationKind: 'DOCUMENT',
        title: '',
        summary: '',
        content: '',
        openTarget: '',
        mimeType: 'text/markdown',
        createdAt: new Date().toISOString(),
        errorCode: error?.code || 'DOCUMENT_CREATION_FAILED',
        errorMessage: error?.message || 'Failed to create document.',
      };
    }
  }

  public async executeRevision(params: {
    parentDocumentId: string;
    instruction: string;
    tenantId: string;
    ownerId: string;
    requestId: string;
    locale?: 'en' | 'ko';
    routingMode?: any;
  }): Promise<CreationResult> {
    const parent = this.deps.documentStore.get(params.parentDocumentId, params.tenantId, params.ownerId);
    if (!parent) {
      return {
        status: 'FAILED',
        creationId: '',
        creationKind: 'DOCUMENT',
        title: '',
        summary: '',
        content: '',
        openTarget: '',
        mimeType: 'text/markdown',
        createdAt: new Date().toISOString(),
        errorCode: 'DOCUMENT_NOT_FOUND',
        errorMessage: `Document ${params.parentDocumentId} not found.`,
      };
    }

    const revisionPrompt = `Existing Document Title: "${parent.title}"\nExisting Content:\n"""\n${parent.content}\n"""\n\nRevision Instruction: ${params.instruction}`;

    const request: CreationRequest = {
      creationKind: 'DOCUMENT',
      prompt: revisionPrompt,
      options: {
        documentKind: parent.documentKind,
        style: `Revision of ${parent.documentId}: ${params.instruction}`,
        locale: params.locale || parent.locale,
        routingMode: params.routingMode,
      },
      tenantId: params.tenantId,
      ownerId: params.ownerId,
      requestId: params.requestId,
    };

    const result = await this.execute(request);
    if (result.status === 'SUCCESS' && result.creationId) {
      const revisedDoc = this.deps.documentStore.get(result.creationId, params.tenantId, params.ownerId);
      if (revisedDoc) {
        revisedDoc.parentDocumentId = parent.parentDocumentId || parent.documentId;
        revisedDoc.revisionIndex = parent.revisionIndex + 1;
        this.deps.documentStore.save(revisedDoc);
      }
    }
    return result;
  }
}

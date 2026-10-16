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

  // Revisions being written right now, by owner + document + instruction. A second identical request while one is in flight (a double click, a client retry after a slow answer) joins it instead of
  // writing the revision again - one model call, one stored revision. The entry is gone when the revision settles, so asking again later is a new, deliberate revision.
  private readonly revisionsInFlight = new Map<string, Promise<CreationResult>>();

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
        ...(options.lengthRequest !== undefined ? { lengthRequest: options.lengthRequest } : {}),
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

      const artifactRecord = this.persist(docRecord, requestId, { provider: outcome.provider, model: outcome.model });

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

  // Canonical document + its thin projection for Recent Creations + the governance audit event. Shared by model-written documents (execute) and documents NAgex composed itself (createFromContent).
  private persist(docRecord: DocumentRecord, requestId: string, details: Record<string, unknown>, action = 'document.created'): { artifactId: string } | undefined {
    this.deps.documentStore.save(docRecord);
    let artifactRecord: { artifactId: string } | undefined;
    if (this.deps.artifactStore) {
      artifactRecord = this.deps.artifactStore.saveCompleted({
        tenantId: docRecord.tenantId,
        ownerId: docRecord.ownerId,
        type: 'DOCUMENT',
        title: docRecord.title,
        preview: docRecord.summary || docRecord.content.slice(0, 500),
        sourceType: 'CAPTURE',
        sourceId: docRecord.documentId,
        openTarget: `/api/v1/creations/documents/${docRecord.documentId}`,
      });
      docRecord.artifactId = artifactRecord.artifactId;
      this.deps.documentStore.save(docRecord);
    }
    this.deps.auditLogger?.logEvent({
      actor: { type: 'user', id: docRecord.ownerId },
      tenant_id: docRecord.tenantId,
      action,
      resource: { type: 'DocumentRecord', id: docRecord.documentId },
      result: 'SUCCESS',
      request_id: requestId,
      details: { title: docRecord.title, documentKind: docRecord.documentKind, ...details },
    });
    return artifactRecord;
  }

  // Bringing an older version back: a NEW version (the next revision of the family) whose text is the older one's. Nothing is overwritten - not the older version, not the newest - and no model is asked.
  // Restoring what is already the newest text is refused (there is nothing to bring back), so a double click cannot add a second identical version.
  public restoreVersion(params: { sourceDocumentId: string; tenantId: string; ownerId: string; requestId: string }): CreationResult {
    const fail = (errorCode: string, errorMessage: string): CreationResult => ({
      status: 'FAILED', creationId: '', creationKind: 'DOCUMENT', title: '', summary: '', content: '', openTarget: '', mimeType: 'text/markdown', createdAt: new Date().toISOString(), errorCode, errorMessage,
    });
    const source = this.deps.documentStore.get(params.sourceDocumentId, params.tenantId, params.ownerId);
    if (!source) return fail('DOCUMENT_NOT_FOUND', `Document ${params.sourceDocumentId} not found.`);
    const root = source.parentDocumentId || source.documentId;
    const family = this.deps.documentStore.getRevisions(root, params.tenantId, params.ownerId);
    const newest = [...family].sort((a, b) => a.revisionIndex - b.revisionIndex || Date.parse(a.createdAt) - Date.parse(b.createdAt)).pop() ?? source;
    if (newest.documentId === source.documentId || newest.content === source.content) return fail('VERSION_ALREADY_CURRENT', 'This version is already the current one.');
    const documentId = `doc_${crypto.createHash('sha256').update(`${params.tenantId}:${params.ownerId}:restore:${source.documentId}:${newest.documentId}`).digest('hex').slice(0, 24)}`;
    const now = new Date().toISOString();
    const record: DocumentRecord = {
      documentId,
      tenantId: params.tenantId,
      ownerId: params.ownerId,
      title: source.title,
      summary: source.summary,
      content: source.content,
      documentKind: source.documentKind,
      locale: source.locale,
      format: source.format,
      sourceRefs: source.sourceRefs,
      ...(source.researchRunId ? { researchRunId: source.researchRunId } : {}),
      parentDocumentId: root,
      restoredFromDocumentId: source.documentId,
      revisionIndex: newest.revisionIndex + 1,
      createdAt: now,
      updatedAt: now,
    };
    const artifact = this.persist(record, params.requestId, { composedBy: 'NAGEX', restoredFrom: source.documentId, revisionIndex: record.revisionIndex }, 'document.restored');
    return {
      status: 'SUCCESS',
      creationId: documentId,
      creationKind: 'DOCUMENT',
      title: record.title,
      summary: record.summary,
      content: record.content,
      openTarget: `/api/v1/creations/documents/${documentId}`,
      artifactId: artifact?.artifactId,
      mimeType: 'text/markdown',
      metadata: { documentKind: record.documentKind, restoredFrom: source.documentId, revisionIndex: record.revisionIndex },
      createdAt: now,
    };
  }

  // A document whose text was composed by NAgex itself (a verified research report): nothing is asked of a model here. The id is derived from the run that produced it, so the same run is never stored twice.
  public createFromContent(params: {
    tenantId: string;
    ownerId: string;
    requestId: string;
    idSeed: string;
    title: string;
    summary: string;
    content: string;
    locale: 'en' | 'ko';
    documentKind: string;
    researchRunId?: string;
    sourceRefs?: DocumentRecord['sourceRefs'];
  }): CreationResult {
    const documentId = `doc_${crypto.createHash('sha256').update(`${params.tenantId}:${params.ownerId}:${params.idSeed}`).digest('hex').slice(0, 24)}`;
    const now = new Date().toISOString();
    const docRecord: DocumentRecord = {
      documentId,
      tenantId: params.tenantId,
      ownerId: params.ownerId,
      title: params.title.trim(),
      summary: params.summary.trim(),
      content: params.content.trim(),
      documentKind: params.documentKind,
      locale: params.locale,
      format: 'MARKDOWN',
      sourceRefs: params.sourceRefs ?? [],
      ...(params.researchRunId ? { researchRunId: params.researchRunId } : {}),
      revisionIndex: 1,
      createdAt: now,
      updatedAt: now,
    };
    const artifactRecord = this.persist(docRecord, params.requestId, { composedBy: 'NAGEX', ...(params.researchRunId ? { researchRunId: params.researchRunId } : {}) });
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
      metadata: { documentKind: params.documentKind, composedBy: 'NAGEX' },
      createdAt: now,
    };
  }

  public executeRevision(params: {
    parentDocumentId: string;
    instruction: string;
    tenantId: string;
    ownerId: string;
    requestId: string;
    locale?: 'en' | 'ko';
    routingMode?: any;
  }): Promise<CreationResult> {
    const key = crypto.createHash('sha256').update(JSON.stringify([params.tenantId, params.ownerId, params.parentDocumentId, params.instruction])).digest('hex');
    const running = this.revisionsInFlight.get(key);
    if (running) return running;
    const started = this.writeRevision(params).finally(() => { this.revisionsInFlight.delete(key); });
    this.revisionsInFlight.set(key, started);
    return started;
  }

  private async writeRevision(params: {
    parentDocumentId: string;
    instruction: string;
    tenantId: string;
    ownerId: string;
    requestId: string;
    locale?: 'en' | 'ko';
    routingMode?: any;
  }): Promise<CreationResult> {
    const parent =this.deps.documentStore.get(params.parentDocumentId, params.tenantId, params.ownerId);
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
        lengthRequest: params.instruction,
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

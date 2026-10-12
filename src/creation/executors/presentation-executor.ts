import crypto from 'node:crypto';
import type { AiService } from '../../model-gateway/ai-service.js';
import { outlineToMarkdown, type PresentationOutline } from '../../model-gateway/presentation-outline.js';
import type { ArtifactStore } from '../../artifacts/artifact.store.js';
import type { AuditLogger } from '../../governance/audit.logger.js';
import type { MemoryRecord } from '../../context/memory.engine.js';
import type { DocumentStore } from '../document.store.js';
import type { PresentationStore, PresentationRecord } from '../presentation.store.js';
import type { CreationProviderRouter } from '../providers/creation-provider-router.js';
import type { PresentationCreationSpec } from '../specs/creation-spec.types.js';
import { PPTX_MIME } from '../pptx/pptx-writer.js';
import type { CreationExecutor, CreationKind, CreationRequest, CreationResult } from '../creation-runtime.types.js';

export interface PresentationExecutorDeps {
  aiService: AiService;
  presentationStore: PresentationStore;
  providerRouter: CreationProviderRouter;
  artifactStore?: ArtifactStore;
  documentStore?: DocumentStore;
  auditLogger?: AuditLogger;
  getRelevantMemories?: (tenantId: string, ownerId: string, query: string) => MemoryRecord[];
}

const MAX_SOURCE_CHARS = 8000;

function failure(errorCode: string, errorMessage: string): CreationResult {
  return {
    status: 'FAILED',
    creationId: '',
    creationKind: 'PRESENTATION',
    title: '',
    summary: '',
    content: '',
    openTarget: '',
    mimeType: PPTX_MIME,
    createdAt: new Date().toISOString(),
    errorCode,
    errorMessage,
  };
}

/**
 * R23.7C-D — Presentation / Slides runtime. The model plans the deck; NAgex validates the plan, routes the rendering through the provider-neutral
 * PresentationProviderPort, stores the produced file under a NAgex-owned identity (pres_<24 hex>) and projects it into the artifact store.
 * Nothing is reported as created unless a real file exists; a missing model, an unusable plan or a failed render is a failure, never a success.
 */
export class PresentationExecutor implements CreationExecutor<CreationRequest, CreationResult> {
  public readonly kind: CreationKind = 'PRESENTATION';

  constructor(private readonly deps: PresentationExecutorDeps) {}

  public async execute(request: CreationRequest): Promise<CreationResult> {
    const { tenantId, ownerId, requestId, prompt, options = {} } = request;
    const locale = options.locale === 'ko' ? 'ko' : 'en';

    if (!prompt || !prompt.trim()) return failure('INVALID_PROMPT', 'Presentation creation prompt is required.');

    // Source context: only documents the caller owns (an unknown or foreign reference is refused, never silently ignored).
    let sourceContext = '';
    for (const ref of request.sourceRefs || []) {
      if (ref.type !== 'ARTIFACT') continue;
      const artifact = this.deps.artifactStore?.get(ref.id, tenantId, ownerId);
      const document = artifact && artifact.type === 'DOCUMENT' ? this.deps.documentStore?.get(artifact.sourceId, tenantId, ownerId) : null;
      if (!document) return failure('UNAUTHORIZED_REFERENCE', 'A source document for this presentation was not found.');
      sourceContext += `${sourceContext ? '\n\n' : ''}# ${document.title}\n${document.content}`.slice(0, MAX_SOURCE_CHARS);
    }

    let outline: PresentationOutline;
    let modelMeta: { provider?: string; model?: string; latencyMs?: number } = {};
    try {
      const memories = this.deps.getRelevantMemories ? this.deps.getRelevantMemories(tenantId, ownerId, prompt) : [];
      const outcome = await this.deps.aiService.presentationOutline({
        prompt: prompt.trim(),
        sourceContext: sourceContext || undefined,
        instructions: options.style,
        locale,
        memories,
        mode: options.routingMode || 'auto',
        requestId,
      });
      outline = outcome.data;
      modelMeta = { provider: outcome.provider, model: outcome.model, latencyMs: outcome.latencyMs };
    } catch (error: any) {
      return failure(error?.code || 'PRESENTATION_PLANNING_FAILED', error?.message || 'The presentation could not be planned.');
    }

    const spec: PresentationCreationSpec = {
      creationKind: 'PRESENTATION',
      title: outline.title,
      subtitle: outline.subtitle || undefined,
      audience: options.targetAudience,
      locale,
      sourceRefs: request.sourceRefs,
      slides: outline.slides.map((slide, index) => ({ slideId: `s${index + 1}`, objective: slide.title, title: slide.title, bullets: slide.bullets })),
      tenantId,
      ownerId,
      requestId,
    };

    let providerResult;
    try {
      const decision = this.deps.providerRouter.selectPresentationProvider(spec, { requestedProviderId: options.requestedProviderId });
      providerResult = await decision.selectedProvider.generatePresentation(spec);
    } catch (error: any) {
      return failure(error?.code || 'NO_CREATION_PROVIDER_AVAILABLE', error?.message || 'No presentation renderer is available.');
    }
    const buffer = providerResult.output?.presentationBuffer;
    if (providerResult.status !== 'COMPLETED' || !buffer || buffer.length === 0) {
      return failure(providerResult.errorCode || 'PRESENTATION_RENDER_FAILED', providerResult.errorMessage || 'The presentation file could not be produced.');
    }

    const presentationId = `pres_${crypto.randomBytes(12).toString('hex')}`;
    const now = new Date().toISOString();
    const summary = outline.subtitle || outline.slides.slice(0, 3).map((slide) => slide.title).join(' · ');
    const openTarget = `/api/v1/creations/presentations/${presentationId}`;

    const record: PresentationRecord = {
      presentationId,
      tenantId,
      ownerId,
      title: outline.title,
      subtitle: outline.subtitle,
      summary,
      locale,
      slides: outline.slides,
      mimeType: PPTX_MIME,
      byteLength: buffer.length,
      binaryStoragePath: this.deps.presentationStore.saveBinary(presentationId, buffer),
      sourceRefs: request.sourceRefs || [],
      providerExecutionMetadata: providerResult.metadata,
      createdAt: now,
      updatedAt: now,
    };
    this.deps.presentationStore.save(record);

    let artifactId: string | undefined;
    if (this.deps.artifactStore) {
      const artifact = this.deps.artifactStore.saveCompleted({
        tenantId,
        ownerId,
        type: 'PRESENTATION',
        title: record.title,
        preview: summary.slice(0, 500),
        sourceType: 'CAPTURE',
        sourceId: presentationId,
        openTarget,
      });
      artifactId = artifact.artifactId;
      record.artifactId = artifactId;
      this.deps.presentationStore.save(record);
    }

    this.deps.auditLogger?.logEvent({
      actor: { type: 'user', id: ownerId },
      tenant_id: tenantId,
      action: 'presentation.created',
      resource: { type: 'PresentationRecord', id: presentationId },
      result: 'SUCCESS',
      request_id: requestId,
      details: { title: record.title, slides: outline.slides.length, bytes: buffer.length, renderer: providerResult.metadata.providerId, provider: modelMeta.provider, model: modelMeta.model },
    });

    return {
      status: 'SUCCESS',
      creationId: presentationId,
      creationKind: 'PRESENTATION',
      title: record.title,
      summary,
      content: outlineToMarkdown(outline),
      openTarget,
      artifactId,
      mimeType: PPTX_MIME,
      // provider/model identity stays in the audit trail and the stored record, never in what the product shows
      metadata: { slideCount: outline.slides.length, downloadTarget: `${openTarget}/download`, byteLength: buffer.length },
      createdAt: now,
    };
  }
}

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
import { requestedSlideCount } from '../slide-count.js';
import { revisionSlideTarget } from '../slide-revision.js';
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

interface RevisionParams {
  parentPresentationId: string;
  instruction: string;
  tenantId: string;
  ownerId: string;
  requestId: string;
  locale?: 'en' | 'ko';
  routingMode?: any;
}

/**
 * R23.7C-D — Presentation / Slides runtime. The model plans the deck; NAgex validates the plan, routes the rendering through the provider-neutral
 * PresentationProviderPort, stores the produced file under a NAgex-owned identity (pres_<24 hex>) and projects it into the artifact store.
 * Nothing is reported as created unless a real file exists; a missing model, an unusable plan or a failed render is a failure, never a success.
 */
export class PresentationExecutor implements CreationExecutor<CreationRequest, CreationResult> {
  public readonly kind: CreationKind = 'PRESENTATION';

  // Revisions being written right now, by owner + deck + instruction: an identical request while one is in flight joins it (one model call, one stored deck).
  private readonly revisionsInFlight = new Map<string, Promise<CreationResult>>();

  constructor(private readonly deps: PresentationExecutorDeps) {}

  // Source context: only documents the caller owns (an unknown or foreign reference is refused, never silently ignored).
  private loadSources(request: CreationRequest): { text: string } | { error: CreationResult } {
    const { tenantId, ownerId } = request;
    let text = '';
    for (const ref of request.sourceRefs || []) {
      if (ref.type !== 'ARTIFACT') continue;
      const artifact = this.deps.artifactStore?.get(ref.id, tenantId, ownerId);
      const document = artifact && artifact.type === 'DOCUMENT' ? this.deps.documentStore?.get(artifact.sourceId, tenantId, ownerId) : null;
      if (!document) return { error: failure('UNAUTHORIZED_REFERENCE', 'A source document for this presentation was not found.') };
      text += `${text ? '\n\n' : ''}# ${document.title}\n${document.content}`.slice(0, MAX_SOURCE_CHARS);
    }
    return { text };
  }

  public async execute(request: CreationRequest): Promise<CreationResult> {
    const { tenantId, ownerId, requestId, prompt, options = {} } = request;
    const locale = options.locale === 'ko' ? 'ko' : 'en';

    if (!prompt || !prompt.trim()) return failure('INVALID_PROMPT', 'Presentation creation prompt is required.');

    const sources = this.loadSources(request);
    if ('error' in sources) return sources.error;
    const sourceContext = sources.text;

    let outline: PresentationOutline;
    let modelMeta: { provider?: string; model?: string; latencyMs?: number } = {};
    // "8장짜리": the number the person named is the TOTAL (title slide included) unless they say otherwise; the model is told an exact number of content slides
    const wanted = requestedSlideCount(prompt);
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
        contentSlides: wanted?.contentSlides,
      });
      outline = outcome.data;
      modelMeta = { provider: outcome.provider, model: outcome.model, latencyMs: outcome.latencyMs };
    } catch (error: any) {
      return failure(error?.code || 'PRESENTATION_PLANNING_FAILED', error?.message || 'The presentation could not be planned.');
    }

    return this.produce(request, locale, outline, modelMeta, wanted ? { totalSlides: wanted.totalSlides, clamped: wanted.clamped } : null);
  }

  /**
   * Revises a deck the person owns. The parent is never changed: the revision is a NEW deck (its own id, file and artifact) that points back to it, like a document revision.
   * The size follows from the instruction by NAgex's own arithmetic ("한 장 추가" = one content slide more than the deck has now); the model restructures the content.
   */
  // Bringing an older version of a deck back: a NEW deck (the next revision of the family) with the older deck's slides and a copy of its file. The older deck and its file are untouched, no model is asked,
  // and restoring what already is the newest deck is refused.
  public restoreVersion(params: { sourcePresentationId: string; tenantId: string; ownerId: string; requestId: string }): CreationResult {
    const { tenantId, ownerId, requestId } = params;
    const source = this.deps.presentationStore.get(params.sourcePresentationId, tenantId, ownerId);
    if (!source) return failure('PRESENTATION_NOT_FOUND', `Presentation ${params.sourcePresentationId} not found.`);
    const root = source.parentPresentationId || source.presentationId;
    const family = this.deps.presentationStore.list(tenantId, ownerId, 10_000).filter((p) => p.presentationId === root || p.parentPresentationId === root);
    const newest = [...family].sort((a, b) => (a.revisionIndex ?? 1) - (b.revisionIndex ?? 1) || Date.parse(a.createdAt) - Date.parse(b.createdAt)).pop() ?? source;
    if (newest.presentationId === source.presentationId || JSON.stringify([newest.title, newest.slides]) === JSON.stringify([source.title, source.slides])) {
      return failure('VERSION_ALREADY_CURRENT', 'This version is already the current one.');
    }
    const bytes = this.deps.presentationStore.getBinary(source.binaryStoragePath);
    if (!bytes || bytes.length === 0) return failure('PRESENTATION_FILE_MISSING', 'The file of that version is no longer available.');
    const presentationId = `pres_${crypto.randomBytes(12).toString('hex')}`;
    const now = new Date().toISOString();
    const openTarget = `/api/v1/creations/presentations/${presentationId}`;
    const record: PresentationRecord = {
      presentationId,
      tenantId,
      ownerId,
      title: source.title,
      subtitle: source.subtitle,
      summary: source.summary,
      locale: source.locale,
      slides: source.slides,
      mimeType: source.mimeType,
      byteLength: bytes.length,
      binaryStoragePath: this.deps.presentationStore.saveBinary(presentationId, bytes),
      sourceRefs: source.sourceRefs,
      providerExecutionMetadata: source.providerExecutionMetadata,
      parentPresentationId: root,
      revisedFromPresentationId: newest.presentationId,
      restoredFromPresentationId: source.presentationId,
      revisionIndex: (newest.revisionIndex ?? 1) + 1,
      createdAt: now,
      updatedAt: now,
    };
    this.deps.presentationStore.save(record);
    let artifactId: string | undefined;
    if (this.deps.artifactStore) {
      const artifact = this.deps.artifactStore.saveCompleted({ tenantId, ownerId, type: 'PRESENTATION', title: record.title, preview: record.summary.slice(0, 500), sourceType: 'CAPTURE', sourceId: presentationId, openTarget });
      artifactId = artifact.artifactId;
      record.artifactId = artifactId;
      this.deps.presentationStore.save(record);
    }
    this.deps.auditLogger?.logEvent({
      actor: { type: 'user', id: ownerId },
      tenant_id: tenantId,
      action: 'presentation.restored',
      resource: { type: 'PresentationRecord', id: presentationId },
      result: 'SUCCESS',
      request_id: requestId,
      details: { title: record.title, slides: record.slides.length, restoredFrom: source.presentationId, revisionIndex: record.revisionIndex },
    });
    return {
      status: 'SUCCESS',
      creationId: presentationId,
      creationKind: 'PRESENTATION',
      title: record.title,
      summary: record.summary,
      content: '',
      openTarget,
      artifactId,
      mimeType: record.mimeType,
      metadata: { slideCount: record.slides.length, downloadTarget: `${openTarget}/download`, byteLength: bytes.length, restoredFrom: source.presentationId, revisionIndex: record.revisionIndex },
      createdAt: now,
    };
  }

  public executeRevision(params: RevisionParams): Promise<CreationResult> {
    const key = crypto.createHash('sha256').update(JSON.stringify([params.tenantId, params.ownerId, params.parentPresentationId, params.instruction])).digest('hex');
    const running = this.revisionsInFlight.get(key);
    if (running) return running;
    const started = this.writeRevision(params).finally(() => { this.revisionsInFlight.delete(key); });
    this.revisionsInFlight.set(key, started);
    return started;
  }

  private async writeRevision(params: RevisionParams): Promise<CreationResult> {
    const { tenantId, ownerId, requestId } = params;
    const instruction = (params.instruction || '').trim();
    if (!instruction) return failure('INVALID_PROMPT', 'A revision instruction is required.');
    const parent = this.deps.presentationStore.get(params.parentPresentationId, tenantId, ownerId);
    if (!parent) return failure('PRESENTATION_NOT_FOUND', `Presentation ${params.parentPresentationId} not found.`);
    const locale = params.locale === 'ko' || params.locale === 'en' ? params.locale : parent.locale;

    // the deck's source document, when it still exists and is still the owner's, informs the revision; if it is gone the revision rests on the deck itself
    let sourceContext = '';
    const sources = this.loadSources({ creationKind: 'PRESENTATION', prompt: instruction, sourceRefs: parent.sourceRefs, tenantId, ownerId, requestId });
    if (!('error' in sources)) sourceContext = sources.text;

    const target = revisionSlideTarget(instruction, parent.slides.length);
    const existing = outlineToMarkdown({ title: parent.title, subtitle: parent.subtitle, slides: parent.slides });
    const prompt = [
      'Revise the existing presentation below according to the revision instruction. Keep what the instruction does not ask to change; when it asks for the whole deck to be rebuilt, restructure it end to end.',
      `Revision instruction: ${instruction}`,
      '',
      "EXISTING PRESENTATION (the person's own deck):",
      existing,
    ].join('\n');

    let outline: PresentationOutline;
    let modelMeta: { provider?: string; model?: string; latencyMs?: number } = {};
    try {
      const memories = this.deps.getRelevantMemories ? this.deps.getRelevantMemories(tenantId, ownerId, instruction) : [];
      const outcome = await this.deps.aiService.presentationOutline({
        prompt,
        sourceContext: sourceContext || undefined,
        locale,
        memories,
        mode: params.routingMode || 'auto',
        requestId,
        contentSlides: target?.contentSlides,
      });
      outline = outcome.data;
      modelMeta = { provider: outcome.provider, model: outcome.model, latencyMs: outcome.latencyMs };
    } catch (error: any) {
      return failure(error?.code || 'PRESENTATION_PLANNING_FAILED', error?.message || 'The presentation could not be revised.');
    }

    return this.produce(
      { creationKind: 'PRESENTATION', prompt: instruction, sourceRefs: parent.sourceRefs, tenantId, ownerId, requestId, options: { locale } },
      locale,
      outline,
      modelMeta,
      target ? { totalSlides: target.contentSlides + 1, clamped: false } : null,
      { parent },
    );
  }

  // Everything after the model has planned the deck: validate -> render through the provider port -> store under a NAgex-owned identity -> artifact -> audit -> result.
  private async produce(
    request: CreationRequest,
    locale: 'en' | 'ko',
    outline: PresentationOutline,
    modelMeta: { provider?: string; model?: string; latencyMs?: number },
    wanted: { totalSlides: number; clamped: boolean } | null,
    revision?: { parent: PresentationRecord },
  ): Promise<CreationResult> {
    const { tenantId, ownerId, requestId, options = {} } = request;

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
      ...(revision
        ? { parentPresentationId: revision.parent.parentPresentationId || revision.parent.presentationId, revisedFromPresentationId: revision.parent.presentationId, revisionIndex: (revision.parent.revisionIndex ?? 1) + 1 }
        : {}),
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
      action: revision ? 'presentation.revised' : 'presentation.created',
      resource: { type: 'PresentationRecord', id: presentationId },
      result: 'SUCCESS',
      request_id: requestId,
      details: { title: record.title, slides: outline.slides.length, bytes: buffer.length, renderer: providerResult.metadata.providerId, provider: modelMeta.provider, model: modelMeta.model, ...(revision ? { revisedFrom: revision.parent.presentationId } : {}) },
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
      // slideCount = content slides (as before; the file has one more, the title slide); requestedSlideCount only when the person named a size, so a shortfall is visible. A request without a named size keeps exactly the old keys.
      metadata: {
        slideCount: outline.slides.length,
        ...(wanted ? { requestedSlideCount: wanted.totalSlides, ...(wanted.clamped ? { requestedSlideCountReduced: true } : {}) } : {}),
        downloadTarget: `${openTarget}/download`,
        byteLength: buffer.length,
        ...(revision ? { revisedFrom: revision.parent.presentationId, revisionIndex: record.revisionIndex } : {}),
      },
      createdAt: now,
    };
  }
}

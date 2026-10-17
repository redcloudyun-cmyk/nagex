import crypto from 'node:crypto';
import type { AiService } from '../../model-gateway/ai-service.js';
import { outlineToMarkdown, type OutlineDemotion, type PresentationOutline } from '../../model-gateway/presentation-outline.js';
import type { ArtifactStore } from '../../artifacts/artifact.store.js';
import type { AuditLogger } from '../../governance/audit.logger.js';
import type { MemoryRecord } from '../../context/memory.engine.js';
import type { DocumentStore } from '../document.store.js';
import type { ImageStore } from '../image.store.js';
import { imageSize } from '../image-size.js';
import { groundingCorpus, groundOutline } from '../pptx/number-grounding.js';
import type { PresentationStore, PresentationRecord } from '../presentation.store.js';
import type { CreationProviderRouter } from '../providers/creation-provider-router.js';
import type { PresentationCreationSpec } from '../specs/creation-spec.types.js';
import { RICH_PPTX_MIME as PPTX_MIME } from '../pptx/rich-deck-writer.js';
import { requestedSlideCount } from '../slide-count.js';
import { revisionSlideTarget } from '../slide-revision.js';
import type { CreationExecutor, CreationKind, CreationRequest, CreationResult } from '../creation-runtime.types.js';

export interface PresentationExecutorDeps {
  aiService: AiService;
  presentationStore: PresentationStore;
  providerRouter: CreationProviderRouter;
  artifactStore?: ArtifactStore;
  documentStore?: DocumentStore;
  // the person's own stored pictures, which a deck may place on a slide (owner-checked, PNG / JPEG only). Absent -> pictures are never offered.
  imageStore?: ImageStore;
  auditLogger?: AuditLogger;
  getRelevantMemories?: (tenantId: string, ownerId: string, query: string) => MemoryRecord[];
}

const MAX_SOURCE_CHARS = 8000;
const MAX_OFFERED_IMAGES = 6;

/** A picture of the person's that the planner may place, under a reference only (never a URL, never an id of the store). */
interface OfferedImage { ref: string; title: string; bytes: Buffer }

/** What the plan is checked against and what it may use: the figures the person gave, the pictures the person owns, the titles of what the deck rests on. */
interface PlanContext { known: Set<string>; images: Map<string, OfferedImage>; sourceTitles: string[] }

const LAYOUT_NAME = {
  ko: { CHART: '차트', METRICS: '핵심 수치', TABLE: '표', IMAGE: '그림', QUOTE: '인용문', SECTION: '구분 슬라이드', BULLETS: '슬라이드' },
  en: { CHART: 'chart', METRICS: 'key figures', TABLE: 'table', IMAGE: 'picture', QUOTE: 'quote', SECTION: 'section break', BULLETS: 'slide' },
} as const;
const DEMOTION_REASON = {
  ko: { UNGROUNDED_NUMBERS: '수치가 요청이나 자료에 없어 글로 바꿨어요', IMAGE_NOT_AVAILABLE: '사용할 수 있는 그림이 없어 글로 바꿨어요', INVALID: '형식이 맞지 않아 글로 바꿨어요', PLACEHOLDER_ONLY: '채울 내용이 없어 뺐어요' },
  en: { UNGROUNDED_NUMBERS: 'its figures are not in your request or sources, so it is shown as text', IMAGE_NOT_AVAILABLE: 'no usable picture was available, so it is shown as text', INVALID: 'its data was not in a usable form, so it is shown as text', PLACEHOLDER_ONLY: 'there was nothing to put on it, so it was left out' },
} as const;

/** One plain sentence per demoted slide: what was asked for, which slide, and why it is text instead. */
export function demotionNotices(demotions: OutlineDemotion[], locale: 'en' | 'ko'): string[] {
  return demotions.map((d) => {
    const reason = d.code === 'UNGROUNDED_NUMBERS' || d.code === 'IMAGE_NOT_AVAILABLE' || d.code === 'PLACEHOLDER_ONLY' ? DEMOTION_REASON[locale][d.code] : DEMOTION_REASON[locale].INVALID;
    const name = LAYOUT_NAME[locale][d.layout];
    return locale === 'ko' ? `${d.slide}번 슬라이드의 ${name}: ${reason}.` : `Slide ${d.slide} (${name}): ${reason}.`;
  });
}

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
  private loadSources(request: CreationRequest): { text: string; titles: string[]; images: OfferedImage[] } | { error: CreationResult } {
    const { tenantId, ownerId } = request;
    let text = '';
    const titles: string[] = [];
    const images: OfferedImage[] = [];
    for (const ref of request.sourceRefs || []) {
      if (ref.type !== 'ARTIFACT') continue;
      const artifact = this.deps.artifactStore?.get(ref.id, tenantId, ownerId);
      // the person's own picture: offered to the planner under a reference, when it is a PNG or a JPEG (anything else is not offered - and not an error: the deck simply cannot use it)
      if (artifact && artifact.type === 'IMAGE') {
        const record = this.deps.imageStore?.get(artifact.sourceId, tenantId, ownerId);
        const bytes = record ? this.deps.imageStore!.getBinary(record.binaryStoragePath) : null;
        if (record && bytes && imageSize(bytes) && images.length < MAX_OFFERED_IMAGES) images.push({ ref: `image_${images.length + 1}`, title: record.title, bytes });
        continue;
      }
      const document = artifact && artifact.type === 'DOCUMENT' ? this.deps.documentStore?.get(artifact.sourceId, tenantId, ownerId) : null;
      if (!document) return { error: failure('UNAUTHORIZED_REFERENCE', 'A source document for this presentation was not found.') };
      text += `${text ? '\n\n' : ''}# ${document.title}\n${document.content}`.slice(0, MAX_SOURCE_CHARS);
      titles.push(document.title);
    }
    return { text, titles, images };
  }

  public async execute(request: CreationRequest): Promise<CreationResult> {
    const { tenantId, ownerId, requestId, prompt, options = {} } = request;
    const locale = options.locale === 'ko' ? 'ko' : 'en';

    if (!prompt || !prompt.trim()) return failure('INVALID_PROMPT', 'Presentation creation prompt is required.');

    const sources = this.loadSources(request);
    if ('error' in sources) return sources.error;
    const sourceContext = sources.text;
    const offered = new Map(sources.images.map((image) => [image.ref, image] as const));

    let outline: PresentationOutline;
    let memoryText = '';
    let modelMeta: { provider?: string; model?: string; latencyMs?: number } = {};
    // "8장짜리": the number the person named is the TOTAL (title slide included) unless they say otherwise; the model is told an exact number of content slides
    const wanted = requestedSlideCount(prompt);
    try {
      const memories = this.deps.getRelevantMemories ? this.deps.getRelevantMemories(tenantId, ownerId, prompt) : [];
      memoryText = memories.map((memory) => `${memory.content.subject} ${memory.content.predicate} ${String(memory.content.value)}`).join('\n');
      const outcome = await this.deps.aiService.presentationOutline({
        prompt: prompt.trim(),
        sourceContext: sourceContext || undefined,
        instructions: options.style,
        locale,
        memories,
        mode: options.routingMode || 'auto',
        requestId,
        contentSlides: wanted?.contentSlides,
        images: sources.images.map((image) => ({ ref: image.ref, title: image.title })),
      });
      outline = outcome.data;
      modelMeta = { provider: outcome.provider, model: outcome.model, latencyMs: outcome.latencyMs };
    } catch (error: any) {
      return failure(error?.code || 'PRESENTATION_PLANNING_FAILED', error?.message || 'The presentation could not be planned.');
    }

    // the figures the plan may state are the ones the person gave: the request, the instructions, the source documents and what NAgex remembers for them
    const context: PlanContext = { known: groundingCorpus(prompt, options.style, sourceContext, memoryText), images: offered, sourceTitles: sources.titles };
    return this.produce(request, locale, outline, modelMeta, wanted ? { totalSlides: wanted.totalSlides, clamped: wanted.clamped } : null, context);
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
    let offered = new Map<string, OfferedImage>();
    let sourceTitles: string[] = [];
    const sources = this.loadSources({ creationKind: 'PRESENTATION', prompt: instruction, sourceRefs: parent.sourceRefs, tenantId, ownerId, requestId });
    if (!('error' in sources)) { sourceContext = sources.text; sourceTitles = sources.titles; offered = new Map(sources.images.map((image) => [image.ref, image] as const)); }

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
        images: [...offered.values()].map((image) => ({ ref: image.ref, title: image.title })),
      });
      outline = outcome.data;
      modelMeta = { provider: outcome.provider, model: outcome.model, latencyMs: outcome.latencyMs };
    } catch (error: any) {
      return failure(error?.code || 'PRESENTATION_PLANNING_FAILED', error?.message || 'The presentation could not be revised.');
    }

    // a revision may keep every figure of the deck it revises (they were the person's when it was made) and add the ones in the instruction and the sources
    const context: PlanContext = { known: groundingCorpus(instruction, sourceContext, existing), images: offered, sourceTitles };
    return this.produce(
      { creationKind: 'PRESENTATION', prompt: instruction, sourceRefs: parent.sourceRefs, tenantId, ownerId, requestId, options: { locale } },
      locale,
      outline,
      modelMeta,
      target ? { totalSlides: target.contentSlides + 1, clamped: false } : null,
      context,
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
    context: PlanContext,
    revision?: { parent: PresentationRecord },
  ): Promise<CreationResult> {
    const { tenantId, ownerId, requestId, options = {} } = request;

    // 1. the figures of every chart / table / key-figure card are the person's - or the slide is text. 2. a picture is one the person owns and offered - or the slide is text. Both are SAID, never silent.
    const grounded = groundOutline(outline, context.known);
    const demotions: OutlineDemotion[] = [...(grounded.outline.demotions ?? [])];
    const checkedSlides = grounded.outline.slides.map((slide, index) => {
      if (slide.layout !== 'IMAGE' || !slide.image || context.images.has(slide.image.ref)) return slide;
      demotions.push({ slide: index + 1, layout: 'IMAGE', code: 'IMAGE_NOT_AVAILABLE' });
      const { image: _image, layout: _layout, ...text } = slide;
      return text;
    });
    outline = { ...grounded.outline, slides: checkedSlides, ...(demotions.length ? { demotions } : {}) };
    const notices = demotionNotices(demotions, locale);

    const spec: PresentationCreationSpec = {
      creationKind: 'PRESENTATION',
      title: outline.title,
      subtitle: outline.subtitle || undefined,
      audience: options.targetAudience,
      locale,
      sourceRefs: request.sourceRefs,
      slides: outline.slides.map((slide, index) => ({
        slideId: `s${index + 1}`, objective: slide.title, title: slide.title, bullets: slide.bullets,
        layout: slide.layout, chart: slide.chart, metrics: slide.metrics, table: slide.table, quote: slide.quote, attribution: slide.attribution, subtitle: slide.subtitle, notes: slide.notes,
        image: slide.image ? { bytes: context.images.get(slide.image.ref)!.bytes, alt: slide.image.alt, caption: slide.image.caption } : undefined,
      })),
      sources: context.sourceTitles.length ? context.sourceTitles : undefined,
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

    // what the file contains beyond bullets, from the writer's own report (a plain deck has none of it and its result keeps its old keys)
    const built = (providerResult.output?.rawDeckJson as { report?: { charts?: number; tables?: number; images?: number } } | undefined)?.report;
    const speakerNotes = outline.slides.filter((slide) => Boolean(slide.notes)).length;
    const visuals = (built?.charts ?? 0) + (built?.tables ?? 0) + (built?.images ?? 0) + speakerNotes > 0
      ? { charts: built?.charts ?? 0, tables: built?.tables ?? 0, images: built?.images ?? 0, speakerNotes }
      : null;

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
      content: outlineToMarkdown(outline) + (notices.length ? `\n\n${notices.map((notice) => `> ※ ${notice}`).join('\n')}` : ''),
      openTarget,
      artifactId,
      mimeType: PPTX_MIME,
      // provider/model identity stays in the audit trail and the stored record, never in what the product shows
      // slideCount = content slides (as before; the file has one more, the title slide); requestedSlideCount only when the person named a size, so a shortfall is visible. A request without a named size keeps exactly the old keys.
      metadata: {
        slideCount: outline.slides.length,
        // what the deck contains beyond bullets, and what was asked for but is text instead (and why) - facts, not claims about how it looks
        ...(visuals ? { visuals } : {}),
        ...(demotions.length ? { demotions, notices } : {}),
        ...(wanted ? { requestedSlideCount: wanted.totalSlides, ...(wanted.clamped ? { requestedSlideCountReduced: true } : {}) } : {}),
        downloadTarget: `${openTarget}/download`,
        byteLength: buffer.length,
        ...(revision ? { revisedFrom: revision.parent.presentationId, revisionIndex: record.revisionIndex } : {}),
      },
      createdAt: now,
    };
  }
}

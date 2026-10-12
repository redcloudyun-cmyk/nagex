import type {
  PresentationProviderPort,
  PresentationProviderCapabilities,
  ProviderAvailabilityStatus,
  ProviderExecutionResult,
} from '../creation-provider.types.js';
import type { PresentationCreationSpec } from '../../specs/creation-spec.types.js';
import { buildPptx, PPTX_MIME } from '../../pptx/pptx-writer.js';

/**
 * NAgex's own PresentationML renderer: a deck outline becomes a real .pptx file in-process, with no third-party service and no network call,
 * so it is always available. It renders text slides only (title slide + title/bullet slides): no images, charts or speaker notes, which the
 * capabilities below state honestly.
 */
export class LocalPptxPresentationAdapter implements PresentationProviderPort {
  public readonly providerId = 'nagex-local-pptx';

  public getStatus(): ProviderAvailabilityStatus {
    return 'AVAILABLE';
  }

  public getCapabilities(): PresentationProviderCapabilities {
    return {
      generateDeck: true,
      renderVisuals: false,
      editSlide: false,
      exportPdf: false,
      exportPptx: true,
      brandTemplates: false,
      chartRendering: false,
      speakerNotesSupport: false,
    };
  }

  public async generatePresentation(
    spec: PresentationCreationSpec
  ): Promise<ProviderExecutionResult<{ presentationUrl?: string; presentationBuffer?: Buffer; rawDeckJson?: Record<string, unknown>; mimeType: string }>> {
    const startedAt = Date.now();
    const createdAt = new Date().toISOString();
    const metadata = { providerId: this.providerId, engineOrModel: 'presentationml-writer', createdAt };
    const slides = (spec.slides || []).filter((slide) => slide.title && slide.title.trim() && (slide.bullets || []).some((bullet) => bullet && bullet.trim()));
    if (!spec.title || !spec.title.trim() || slides.length === 0) {
      return { status: 'FAILED', errorCode: 'INVALID_SPEC', errorMessage: 'A presentation needs a title and at least one slide with content.', metadata: { ...metadata, completedAt: new Date().toISOString(), latencyMs: Date.now() - startedAt } };
    }
    try {
      const buffer = buildPptx({
        title: spec.title.trim(),
        subtitle: spec.subtitle && spec.subtitle.trim() ? spec.subtitle.trim() : undefined,
        locale: spec.locale,
        slides: slides.map((slide) => ({ title: slide.title.trim(), bullets: (slide.bullets || []).map((bullet) => bullet.trim()).filter(Boolean) })),
      });
      return {
        status: 'COMPLETED',
        output: { presentationBuffer: buffer, mimeType: PPTX_MIME },
        metadata: { ...metadata, completedAt: new Date().toISOString(), latencyMs: Date.now() - startedAt },
      };
    } catch (error: any) {
      return { status: 'FAILED', errorCode: 'PPTX_BUILD_FAILED', errorMessage: error?.message || 'The presentation file could not be built.', metadata: { ...metadata, completedAt: new Date().toISOString(), latencyMs: Date.now() - startedAt } };
    }
  }
}

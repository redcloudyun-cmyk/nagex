import type {
  PresentationProviderPort,
  PresentationProviderCapabilities,
  ProviderAvailabilityStatus,
  ProviderExecutionResult,
} from '../creation-provider.types.js';
import type { PresentationCreationSpec, PresentationSlideSpec } from '../../specs/creation-spec.types.js';
import { buildRichDeck, RichDeckError, RICH_PPTX_MIME } from '../../pptx/rich-deck-writer.js';
import type { RichSlide } from '../../pptx/rich-deck.types.js';

/**
 * NAgex's in-process presentation renderer: a deck plan becomes a real .pptx with no third-party SERVICE and no network call, so it is always available. The file is written by the open-source
 * PptxGenJS library under NAgex's own structure and font-fit rules (pptx/rich-deck-writer.ts): real slide masters and placeholders, native editable charts, tables, pictures with alt text, key-figure
 * cards, quotes, section breaks and speaker notes. A plan the writer cannot draw truthfully FAILS with a stable code - there is no silent fallback to something poorer.
 */
export class LocalPptxPresentationAdapter implements PresentationProviderPort {
  public readonly providerId = 'nagex-local-pptx';

  public getStatus(): ProviderAvailabilityStatus {
    return 'AVAILABLE';
  }

  public getCapabilities(): PresentationProviderCapabilities {
    return {
      generateDeck: true,
      renderVisuals: true,
      editSlide: false,
      exportPdf: false,
      exportPptx: true,
      brandTemplates: false,
      chartRendering: true,
      speakerNotesSupport: true,
    };
  }

  private toRich(slide: PresentationSlideSpec): RichSlide {
    const title = slide.title.trim();
    const bullets = (slide.bullets || []).map((bullet) => bullet.trim()).filter(Boolean);
    const notes = slide.notes?.trim() || undefined;
    switch (slide.layout) {
      case 'CHART': return { layout: 'CHART', title, bullets, notes, chart: slide.chart! };
      case 'METRICS': return { layout: 'METRICS', title, bullets, notes, metrics: slide.metrics! };
      case 'TABLE': return { layout: 'TABLE', title, bullets, notes, table: slide.table! };
      case 'IMAGE': return { layout: 'IMAGE', title, bullets, notes, image: slide.image! };
      case 'QUOTE': return { layout: 'QUOTE', title, bullets, notes, quote: slide.quote!, attribution: slide.attribution };
      case 'SECTION': return { layout: 'SECTION', title, bullets: [], notes, subtitle: slide.subtitle };
      default: return { layout: 'BULLETS', title, bullets, notes };
    }
  }

  public async generatePresentation(
    spec: PresentationCreationSpec
  ): Promise<ProviderExecutionResult<{ presentationUrl?: string; presentationBuffer?: Buffer; rawDeckJson?: Record<string, unknown>; mimeType: string }>> {
    const startedAt = Date.now();
    const createdAt = new Date().toISOString();
    const metadata = { providerId: this.providerId, engineOrModel: 'pptxgenjs', createdAt };
    // a slide needs a title and something to say - except a section break (title only) and a quote (the quote is the content)
    const slides = (spec.slides || []).filter((slide) => slide.title && slide.title.trim() && (slide.layout === 'SECTION' || slide.layout === 'QUOTE' || (slide.bullets || []).some((bullet) => bullet && bullet.trim())));
    if (!spec.title || !spec.title.trim() || slides.length === 0) {
      return { status: 'FAILED', errorCode: 'INVALID_SPEC', errorMessage: 'A presentation needs a title and at least one slide with content.', metadata: { ...metadata, completedAt: new Date().toISOString(), latencyMs: Date.now() - startedAt } };
    }
    try {
      const { buffer, report } = await buildRichDeck({
        title: spec.title.trim(),
        subtitle: spec.subtitle && spec.subtitle.trim() ? spec.subtitle.trim() : undefined,
        locale: spec.locale,
        slides: slides.map((slide) => this.toRich(slide)),
        sources: spec.sources,
      });
      return {
        status: 'COMPLETED',
        output: { presentationBuffer: buffer, mimeType: RICH_PPTX_MIME, rawDeckJson: { report } },
        metadata: { ...metadata, completedAt: new Date().toISOString(), latencyMs: Date.now() - startedAt },
      };
    } catch (error: any) {
      const code = error instanceof RichDeckError ? error.code : 'PPTX_BUILD_FAILED';
      return { status: 'FAILED', errorCode: code, errorMessage: error?.message || 'The presentation file could not be built.', metadata: { ...metadata, completedAt: new Date().toISOString(), latencyMs: Date.now() - startedAt } };
    }
  }
}

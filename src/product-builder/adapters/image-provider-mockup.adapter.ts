// Visual mockups for the Product Builder, made by an EXISTING image provider (the same ImageProviderPort the creation module uses - OpenAI, Google, NVIDIA NIM, a local GPU endpoint ...).
//
// What this adapter guarantees:
//   - the pictures are REAL provider output, and are CHECKED: the bytes must be a real, complete image of a plausible size (adaptive/goal-verifier.ts) - a provider that answers "200" with an error page,
//     a truncated file or a speck gets a typed failure (IMAGE_VERIFICATION_FAILED), never a stored "mockup". The stored type is the real one, not the claimed one;
//   - a provider that cannot produce one (no key, no quota, a refusal) yields a typed failure that carries the provider's own code and HTTP status, so the adaptive layer can classify it (quota is not
//     rate limiting is not a refusal). This adapter never draws a placeholder, never reuses an old picture and never moves to another provider by itself: that decision belongs to the planner and,
//     when the terms change, to the person;
//   - images are only requested after the plan has been approved (the service calls this after Gate 1), at most `count` of them, one after the other (a failure stops the series: no further spend).
import type { ImageProviderPort } from '../../creation/providers/creation-provider.types.js';
import type { ImageCreationSpec } from '../../creation/specs/creation-spec.types.js';
import { verifyImageBytes } from '../../adaptive/goal-verifier.js';
import type { RouteCandidate } from '../../adaptive/route-candidate.js';
import type { MockupOutcome, MockupPort } from '../product-builder.ports.js';
import type { ProductPlan } from '../product-builder.types.js';

const VARIANTS = [
  'a dashboard-first home screen: summary cards and a chart at the top, the main list below',
  'a list-first home screen: a searchable table or list takes the page, with a compact summary strip',
  'a card-based home screen: friendly cards for each record with clear primary actions',
  'a minimal home screen with a left sidebar for navigation and a roomy content area',
];

export function mockupSubject(plan: ProductPlan, variant: string, feedback: string | null): string {
  const pages = plan.pages.map((p) => p.title).join(', ');
  const features = plan.features.map((f) => f.title).join(', ');
  return [
    `A polished, realistic user-interface mockup (a flat screenshot of the screen, no device frame) of a website: ${plan.summary}.`,
    `Audience: ${plan.audience}. Pages: ${pages}. Key features: ${features}.`,
    `Show ${variant}.`,
    feedback ? `The person asked for these changes: ${feedback}.` : '',
    'Clean modern layout, readable labels, believable sample data, consistent colours. No watermark, no browser chrome.',
  ].filter(Boolean).join(' ');
}

const BLOCKS: Record<string, { code: string; need: 'QUOTA' | 'CREDENTIAL' | 'PERSON' | 'CONFIGURATION'; say: (provider: string, detail: string) => string }> = {
  PROVIDER_QUOTA_EXCEEDED: { code: 'IMAGE_QUOTA_EXCEEDED', need: 'QUOTA', say: (p, d) => `The image provider (${p}) has no quota left for pictures. ${d}` },
  PROVIDER_AUTH_FAILED: { code: 'IMAGE_PROVIDER_AUTH_FAILED', need: 'CREDENTIAL', say: (p, d) => `The image provider (${p}) rejected NAgex's credential. ${d}` },
  PROVIDER_UNCONFIGURED: { code: 'IMAGE_PROVIDER_UNAVAILABLE', need: 'CREDENTIAL', say: (p) => `The image provider (${p}) is not set up.` },
  CONTENT_REJECTED: { code: 'IMAGE_CONTENT_REJECTED', need: 'PERSON', say: (p, d) => `The image provider (${p}) declined to draw this. ${d}` },
};

export interface ImageProviderMockupOptions {
  /** the facts about this route (cost, data handling, reliability ...), read fresh each time so a quota seen exhausted a moment ago is visible */
  route?: () => RouteCandidate;
}

export class ImageProviderMockupAdapter implements MockupPort {
  public readonly route?: () => RouteCandidate;

  constructor(private readonly provider: ImageProviderPort, private readonly aspectRatio: ImageCreationSpec['aspectRatio'] = '16:9', options: ImageProviderMockupOptions = {}) {
    this.route = options.route;
  }

  public get providerId(): string { return this.provider.providerId; }

  public available(): boolean {
    const status = this.provider.getStatus();
    return status === 'AVAILABLE' || status === 'CONFIGURED' || status === 'DEGRADED';
  }

  public async generate(input: { plan: ProductPlan; count: number; feedback: string | null; requestId: string; tenantId?: string; ownerId?: string }): Promise<MockupOutcome> {
    const images: Array<{ caption: string; mimeType: string; data: Buffer; width: number; height: number; sha256: string }> = [];
    const count = Math.max(1, Math.min(4, Math.floor(input.count)));
    for (let i = 0; i < count; i += 1) {
      const variant = VARIANTS[i % VARIANTS.length];
      const spec: ImageCreationSpec = {
        creationKind: 'IMAGE',
        subject: mockupSubject(input.plan, variant, input.feedback),
        style: 'clean product UI design, high fidelity',
        aspectRatio: this.aspectRatio,
        outputUsage: 'DOCUMENT_ILLUSTRATION',
        qualityPreference: 'BALANCED',
        locale: 'en',
        purpose: 'visual mockup of a website for the person to approve before it is built',
        tenantId: input.tenantId ?? 'product-builder',
        ownerId: input.ownerId ?? 'product-builder',
        requestId: input.requestId,
      };
      let result;
      try {
        result = await this.provider.generateImage(spec);
      } catch (error) {
        result = { status: 'FAILED' as const, errorCode: 'IMAGE_GENERATION_FAILED', errorMessage: error instanceof Error ? error.message : 'The image provider failed.', metadata: { providerId: this.providerId, createdAt: new Date().toISOString() } };
      }
      const buffer = result.status === 'COMPLETED' ? result.output?.imageBuffer : undefined;
      if (result.status === 'COMPLETED' && buffer && buffer.length > 0) {
        // what the provider handed over must BE an image: real container, complete, plausible size. Its claimed type is not trusted.
        const verified = verifyImageBytes(buffer, { claimedMime: result.output?.mimeType });
        if (verified.ok && verified.mimeType && verified.width && verified.height && verified.sha256) {
          images.push({ caption: `Home screen, variant ${i + 1}: ${variant.split(':')[0]}`, mimeType: verified.mimeType, data: buffer, width: verified.width, height: verified.height, sha256: verified.sha256 });
          continue;
        }
        if (images.length > 0) break;
        return { ok: false, code: 'IMAGE_VERIFICATION_FAILED', need: 'PERSON', providerCode: 'IMAGE_VERIFICATION_FAILED', chargeable: true, message: `The image provider (${this.providerId}) returned something that is not a usable image (${verified.problems.filter((p) => p !== 'CLAIMED_TYPE_MISMATCH').join(', ').toLowerCase().replace(/_/g, ' ')}), so it was not kept.` };
      }
      // a failure stops the series (no further spend). Pictures already made are kept; none made at all is a block with the provider's own reason.
      if (images.length > 0) break;
      // the provider's reason in its first sentence (the rest is usually a list of links); never a fragment cut in the middle of a word
      const detail = String(result.errorMessage ?? '').replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s/)[0].slice(0, 220);
      const providerCode = String(result.errorCode ?? '') || (result.status === 'UNAVAILABLE' ? 'PROVIDER_UNCONFIGURED' : '');
      const customStatus = result.metadata?.customData?.httpStatus;
      const evidence = { providerCode: providerCode || undefined, ...(typeof customStatus === 'number' ? { httpStatus: customStatus } : {}), chargeable: true };
      const known = BLOCKS[providerCode] ?? (result.status === 'UNAVAILABLE' ? BLOCKS.PROVIDER_UNCONFIGURED : undefined);
      if (known) return { ok: false, code: known.code, need: known.need, message: known.say(this.providerId, detail).trim(), ...evidence };
      return { ok: false, code: 'IMAGE_GENERATION_FAILED', need: 'PERSON', message: `The image provider (${this.providerId}) could not make the mockups. ${detail}`.trim(), ...evidence };
    }
    return { ok: true, images };
  }
}

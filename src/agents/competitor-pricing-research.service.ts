// R23.6E Phase C Section 1 — retrieval order: Web Search / EvidencePack
// first, Browser fallback only when EvidencePack yields nothing usable and
// the caller gave a concrete target URL. This is orchestration glue over
// the existing R22.4 (EvidencePackService) and R23.5B (BrowserToolService)
// stacks — no new fetch/crawler/research framework, per Decision 1/the
// Phase C directive's explicit prohibition.
import { randomUUID } from 'node:crypto';
import type { BrowserToolService } from '../modules/browser/index.js';
import type { EvidencePackService } from '../research/evidence-pack.service.js';
import { PricingExtractionService } from './pricing-extraction.service.js';
import type { ExtractionSourceInput } from './pricing-extraction.types.js';
import { normalizeEvidenceSource, normalizeBrowserEvidence } from './untrusted-evidence.normalizer.js';
import type { UntrustedPricingEvidence } from './competitor-pricing-email.types.js';

export interface CompetitorPricingResearchInput {
  tenantId: string;
  ownerId: string;
  requestId: string;
  competitor: string;
  targetUrl: string | null;
}

export class CompetitorPricingResearchService {
  constructor(
    private readonly evidencePackService: EvidencePackService,
    private readonly browserService: BrowserToolService,
    private readonly extractionService: PricingExtractionService,
  ) {}

  public async research(input: CompetitorPricingResearchInput): Promise<UntrustedPricingEvidence[]> {
    const evidencePack = await this.evidencePackService.buildEvidencePack(`${input.competitor} pricing`, {
      forceSearch: true,
      requestId: input.requestId,
    });

    const hasUsableWebSources = evidencePack.status === 'SUCCESS' && evidencePack.sources.length > 0;

    if (hasUsableWebSources) {
      const sources: ExtractionSourceInput[] = evidencePack.sources.map((s) => ({
        sourceId: s.sourceId,
        title: s.title,
        url: s.url,
        text: s.snippet ?? '',
        retrievedAt: s.retrievedAt,
      }));
      const facts = await this.extractionService.extractFacts(input.competitor, sources, input.requestId);
      const factsBySourceId = new Map(facts.map((f) => [f.sourceId, f]));
      return evidencePack.sources
        .filter((s) => factsBySourceId.has(s.sourceId))
        .map((s) => normalizeEvidenceSource(s, toFacts(factsBySourceId.get(s.sourceId)!)));
    }

    // Browser fallback — only reached when web search produced nothing
    // usable AND the caller gave a concrete URL to check directly.
    if (input.targetUrl) {
      return this.researchViaBrowser(input);
    }

    return [];
  }

  private async researchViaBrowser(input: CompetitorPricingResearchInput): Promise<UntrustedPricingEvidence[]> {
    const session = await this.browserService.open({ tenantId: input.tenantId, ownerId: input.ownerId, requestId: input.requestId });
    try {
      await this.browserService.navigate({ tenantId: input.tenantId, ownerId: input.ownerId, requestId: input.requestId, browserSessionId: session.browserSessionId, url: input.targetUrl! });
      const extracted = await this.browserService.extract({ tenantId: input.tenantId, ownerId: input.ownerId, requestId: input.requestId, browserSessionId: session.browserSessionId, target: 'all' });
      const pageText = extracted.extracted.text ?? '';
      if (!pageText.trim()) return [];

      const sourceId = `browser_${randomUUID()}`;
      const sources: ExtractionSourceInput[] = [{ sourceId, title: extracted.title, url: extracted.url, text: pageText, retrievedAt: extracted.timestamp }];
      const facts = await this.extractionService.extractFacts(input.competitor, sources, input.requestId);
      const fact = facts.find((f) => f.sourceId === sourceId);
      if (!fact) return [];

      return [normalizeBrowserEvidence(extracted.url, extracted.title, pageText.slice(0, 500), extracted.trust, extracted.timestamp, toFacts(fact))];
    } finally {
      await this.browserService.close({ tenantId: input.tenantId, ownerId: input.ownerId, requestId: input.requestId, browserSessionId: session.browserSessionId });
    }
  }
}

function toFacts(fact: { planName: string | null; price: number | null; currency: string | null; billingPeriod: string | null; region: string | null; taxIncluded: boolean | null }) {
  return { planName: fact.planName, price: fact.price, currency: fact.currency, billingPeriod: fact.billingPeriod, region: fact.region, taxIncluded: fact.taxIncluded };
}

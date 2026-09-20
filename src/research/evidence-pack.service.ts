import { randomUUID } from 'node:crypto';
import { getCurrentISOString } from '../common/utils.js';
import { QuestionClassificationService } from './question-classification.service.js';
import { WebSearchService } from './web-search.service.js';
import { SourceFreshnessValidator } from './source-freshness.validator.js';
import type { EvidencePack, EvidenceSource, EvidencePackStatus } from './evidence-pack.types.js';
import type { SearchResult } from './web-search-provider.port.js';
import { isUrlSafe } from '../modules/browser/browser-url-validator.js';

export function mapSearchStatusToEvidenceStatus(status: string): EvidencePackStatus {
  switch (status) {
    case 'SUCCESS': return 'SUCCESS';
    case 'NO_RESULTS': return 'NO_RESULTS';
    case 'UNAVAILABLE': return 'UNAVAILABLE';
    case 'DEGRADED': return 'DEGRADED';
    case 'AUTH_FAILED': return 'AUTH_FAILED';
    case 'RATE_LIMITED': return 'RATE_LIMITED';
    case 'TIMEOUT': return 'TIMEOUT';
    case 'PROVIDER_ERROR': return 'PROVIDER_ERROR';
    case 'INVALID_RESPONSE': return 'INVALID_RESPONSE';
    case 'FAILED': return 'FAILED';
    default: return 'FAILED';
  }
}

export class EvidencePackService {
  constructor(
    private readonly classifier: QuestionClassificationService = new QuestionClassificationService(),
    private readonly webSearchService: WebSearchService = new WebSearchService()
  ) {}

  public isWebSearchAvailable(): boolean {
    return this.webSearchService.isAvailable();
  }

  public async buildEvidencePack(
    query: string,
    options?: { forceSearch?: boolean; maxSources?: number; requestId?: string }
  ): Promise<EvidencePack> {
    const classification = this.classifier.classify(query);
    const now = getCurrentISOString();
    const evidencePackId = `evpack_${randomUUID()}`;

    const shouldSearch = options?.forceSearch || classification.freshness !== 'NONE';

    if (!shouldSearch) {
      return {
        evidencePackId,
        query,
        generatedAt: now,
        freshnessRequirement: classification.freshness,
        category: classification.category,
        status: 'NOT_REQUIRED',
        sources: [],
      };
    }

    if (!this.webSearchService.isAvailable()) {
      return {
        evidencePackId,
        query,
        generatedAt: now,
        freshnessRequirement: classification.freshness,
        category: classification.category,
        status: 'UNAVAILABLE',
        sources: [],
        error: 'Web search capability is unavailable.',
      };
    }

    const searchOutcome = await this.webSearchService.search({
      query,
      maxResults: (options?.maxSources || 5) * 2, // Fetch extra for deduplication
      requestId: options?.requestId,
    });

    if (searchOutcome.status !== 'SUCCESS') {
      const mappedStatus = mapSearchStatusToEvidenceStatus(searchOutcome.status);
      return {
        evidencePackId,
        query,
        generatedAt: now,
        freshnessRequirement: classification.freshness,
        category: classification.category,
        status: mappedStatus,
        sources: [],
        error: searchOutcome.error || `Web search returned status ${searchOutcome.status}`,
      };
    }

    const sources = this.processSearchResults(searchOutcome.results, options?.maxSources || 5, now, classification.category);

    if (sources.length === 0) {
      return {
        evidencePackId,
        query,
        generatedAt: now,
        freshnessRequirement: classification.freshness,
        category: classification.category,
        status: 'NO_RESULTS',
        sources: [],
        error: 'No valid evidence sources found after URL safety validation.',
      };
    }

    return {
      evidencePackId,
      query,
      generatedAt: now,
      freshnessRequirement: classification.freshness,
      category: classification.category,
      status: 'SUCCESS',
      sources,
    };
  }

  private processSearchResults(
    results: SearchResult[],
    limit: number,
    retrievedAt: string,
    category: string
  ): EvidenceSource[] {
    const seenUrls = new Set<string>();
    // Directive J: Fix domain deduplication bug using Map<string, number> count tracking
    const domainCounts = new Map<string, number>();
    const validSources: EvidenceSource[] = [];

    for (const r of results) {
      if (validSources.length >= limit) break;

      const rawUrl = (r.url || '').trim();
      if (!rawUrl) continue;

      // SSRF & URL Safety validation using canonical browser-url-validator
      if (!this.isValidPublicUrl(rawUrl)) continue;

      const normalizedUrl = this.normalizeUrl(rawUrl);
      if (seenUrls.has(normalizedUrl)) continue;
      seenUrls.add(normalizedUrl);

      try {
        const parsed = new URL(rawUrl);
        const domain = parsed.hostname.toLowerCase();
        
        // Directive J: Allow up to max 2 sources per domain
        const count = domainCounts.get(domain) || 0;
        if (count >= 2) continue;
        domainCounts.set(domain, count + 1);

        const freshnessStatus = SourceFreshnessValidator.validateFreshness(r.publishedAt, retrievedAt, category);

        validSources.push({
          sourceId: `src_${validSources.length + 1}`,
          title: r.title || 'Untitled Source',
          url: rawUrl,
          sourceName: r.sourceName || domain,
          snippet: r.snippet || '',
          publishedAt: r.publishedAt,
          observedAt: r.observedAt,
          retrievedAt,
          freshnessStatus,
        });
      } catch {
        continue;
      }
    }

    return validSources;
  }

  public isValidPublicUrl(urlString: string): boolean {
    const res = isUrlSafe(urlString, { allowLocalhostInTests: false });
    return res.safe;
  }

  private normalizeUrl(urlStr: string): string {
    try {
      const u = new URL(urlStr);
      return `${u.protocol}//${u.hostname.toLowerCase()}${u.pathname.replace(/\/$/, '')}${u.search}`;
    } catch {
      return urlStr.toLowerCase();
    }
  }
}

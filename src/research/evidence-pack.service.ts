import { randomUUID } from 'node:crypto';
import { getCurrentISOString } from '../common/utils.js';
import { QuestionClassificationService } from './question-classification.service.js';
import { WebSearchService } from './web-search.service.js';
import { SourceFreshnessValidator } from './source-freshness.validator.js';
import type { EvidencePack, EvidenceSource } from './evidence-pack.types.js';
import type { SearchResult } from './web-search-provider.port.js';

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

    if (!shouldSearch || !this.webSearchService.isAvailable()) {
      return {
        evidencePackId,
        query,
        generatedAt: now,
        freshnessRequirement: classification.freshness,
        category: classification.category,
        sources: [],
      };
    }

    const searchResults = await this.webSearchService.search({
      query,
      maxResults: (options?.maxSources || 5) * 2, // Fetch extra for deduplication
      requestId: options?.requestId,
    });

    const sources = this.processSearchResults(searchResults, options?.maxSources || 5, now);

    return {
      evidencePackId,
      query,
      generatedAt: now,
      freshnessRequirement: classification.freshness,
      category: classification.category,
      sources,
    };
  }

  private processSearchResults(results: SearchResult[], limit: number, retrievedAt: string): EvidenceSource[] {
    const seenUrls = new Set<string>();
    const seenDomains = new Set<string>();
    const validSources: EvidenceSource[] = [];

    for (const r of results) {
      if (validSources.length >= limit) break;

      const rawUrl = (r.url || '').trim();
      if (!rawUrl) continue;

      // SSRF & URL Safety validation
      if (!this.isValidPublicUrl(rawUrl)) continue;

      const normalizedUrl = this.normalizeUrl(rawUrl);
      if (seenUrls.has(normalizedUrl)) continue;
      seenUrls.add(normalizedUrl);

      try {
        const parsed = new URL(rawUrl);
        const domain = parsed.hostname.toLowerCase();
        // Collapse multiple results from exact same domain if we already have 2
        const domainCount = Array.from(seenDomains).filter((d) => d === domain).length;
        if (domainCount >= 2) continue;
        seenDomains.add(domain);

        const freshnessStatus = SourceFreshnessValidator.validateFreshness(r.publishedAt, retrievedAt);

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
        continue; // Skip invalid URL parse failures
      }
    }

    return validSources;
  }

  public isValidPublicUrl(urlString: string): boolean {
    try {
      const u = new URL(urlString);
      // Require http or https only
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return false;
      }

      const hostname = u.hostname.toLowerCase();
      // Block localhost, loopback, private IPs
      if (
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '0.0.0.0' ||
        hostname === '::1' ||
        hostname.endsWith('.local') ||
        hostname.endsWith('.internal')
      ) {
        return false;
      }

      // Block IPv4 private ranges (10.x.x.x, 172.16-31.x.x, 192.168.x.x, 169.254.x.x)
      if (/^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/.test(hostname)) {
        return false;
      }

      return true;
    } catch {
      return false;
    }
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

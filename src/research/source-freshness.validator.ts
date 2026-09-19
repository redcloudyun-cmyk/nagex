import type { SourceFreshnessStatus } from './evidence-pack.types.js';

export class SourceFreshnessValidator {
  public static validateFreshness(
    publishedAt?: string,
    retrievedAt?: string,
    category: string = 'GENERAL'
  ): SourceFreshnessStatus {
    // Directive I: invalid retrievedAt timestamp format must not fall back to STALE
    if (retrievedAt) {
      const retrievedMs = new Date(retrievedAt).getTime();
      if (Number.isNaN(retrievedMs)) {
        return 'UNKNOWN';
      }
    }

    if (!publishedAt || !publishedAt.trim()) {
      return 'UNDATED';
    }

    const pubDate = new Date(publishedAt).getTime();
    if (Number.isNaN(pubDate)) {
      return 'UNKNOWN';
    }

    const refDate = retrievedAt ? new Date(retrievedAt).getTime() : Date.now();
    const diffMs = refDate - pubDate;

    // Directive I: Future-dated source (publishedAt > current_time + 5 mins) classified as SUSPICIOUS (never RECENT/CURRENT)
    if (diffMs < -300000) {
      return 'SUSPICIOUS';
    }

    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const upperCategory = (category || 'GENERAL').toUpperCase();

    // Category-aware recency policy
    if (['MARKET', 'FINANCE', 'WEATHER', 'PRODUCT_PRICE'].includes(upperCategory)) {
      if (diffDays <= 2) return 'CURRENT';
      if (diffDays <= 7) return 'RECENT';
      return 'STALE';
    }

    if (['NEWS', 'POLITICS'].includes(upperCategory)) {
      if (diffDays <= 3) return 'CURRENT';
      if (diffDays <= 14) return 'RECENT';
      return 'STALE';
    }

    if (['LAW', 'POLICY'].includes(upperCategory)) {
      if (diffDays <= 30) return 'CURRENT';
      if (diffDays <= 180) return 'RECENT';
      return 'STALE';
    }

    if (['TECHNOLOGY', 'COMPANY'].includes(upperCategory)) {
      if (diffDays <= 30) return 'CURRENT';
      if (diffDays <= 90) return 'RECENT';
      return 'STALE';
    }

    // Default / General
    if (diffDays <= 7) {
      return 'CURRENT';
    }
    if (diffDays <= 30) {
      return 'RECENT';
    }
    return 'STALE';
  }
}

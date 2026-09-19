import type { SourceFreshnessStatus } from './evidence-pack.types.js';

export class SourceFreshnessValidator {
  public static validateFreshness(publishedAt?: string, retrievedAt?: string): SourceFreshnessStatus {
    if (!publishedAt || !publishedAt.trim()) {
      return 'UNDATED';
    }

    const pubDate = new Date(publishedAt).getTime();
    if (Number.isNaN(pubDate)) {
      return 'UNKNOWN';
    }

    const refDate = retrievedAt ? new Date(retrievedAt).getTime() : Date.now();
    const diffMs = refDate - pubDate;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays < 0) {
      // Future dated or clock skew
      return 'RECENT';
    }
    if (diffDays <= 7) {
      return 'CURRENT';
    }
    if (diffDays <= 30) {
      return 'RECENT';
    }
    return 'STALE';
  }
}

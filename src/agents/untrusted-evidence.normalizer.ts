// R23.6E Decision 3 — the ONE boundary allowed to construct
// UntrustedPricingEvidence. Every EvidencePack/EvidenceSource result and
// every Browser extract/snapshot result MUST pass through here before it
// may be compared, synthesized, or shown as grounding for the Gmail draft.
// trust is never optional and is never fabricated as trusted — a value
// that fails validation is rejected, not silently coerced.
import { NagexError } from '../common/errors.js';
import type { EvidenceSource } from '../research/evidence-pack.types.js';
import type { BrowserContentTrustMetadata } from '../modules/browser/index.js';
import type { UntrustedEvidenceSourceKind, UntrustedEvidenceTrust, UntrustedPricingEvidence } from './competitor-pricing-email.types.js';

export function createUntrustedEvidenceTrust(source: UntrustedEvidenceSourceKind): UntrustedEvidenceTrust {
  return {
    level: 'UNTRUSTED_EXTERNAL',
    source,
    canGrantPermission: false,
    canApproveAction: false,
    canAuthorizeCredentialUse: false,
    canOverridePolicy: false,
    canWritePersistentMemory: false,
  };
}

// Browser content already carries its own real, already-validated
// provenance (R23.5B) — this maps it onto the wider evidence trust shape
// rather than re-deriving/fabricating a new one.
export function trustFromBrowserProvenance(trust: BrowserContentTrustMetadata): UntrustedEvidenceTrust {
  return {
    level: trust.level,
    source: 'BROWSER',
    canGrantPermission: false,
    canApproveAction: false,
    canAuthorizeCredentialUse: false,
    canOverridePolicy: false,
    canWritePersistentMemory: false,
  };
}

export function isUntrustedEvidenceTrust(value: unknown): value is UntrustedEvidenceTrust {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return v.level === 'UNTRUSTED_EXTERNAL'
    && (v.source === 'WEB' || v.source === 'BROWSER' || v.source === 'EXTERNAL_API')
    && v.canGrantPermission === false
    && v.canApproveAction === false
    && v.canAuthorizeCredentialUse === false
    && v.canOverridePolicy === false
    && v.canWritePersistentMemory === false;
}

export function isUntrustedPricingEvidence(value: unknown): value is UntrustedPricingEvidence {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.sourceUrl === 'string'
    && typeof v.retrievedAt === 'string'
    && typeof v.title === 'string'
    && typeof v.excerpt === 'string'
    && (v.planName === null || typeof v.planName === 'string')
    // Section 8 — "No NaN/Infinity may enter a run record": a non-finite
    // price is treated as an invalid evidence item, never coerced to null
    // here (the extraction/grounding boundary is what nulls an unsupported
    // price; a value that reaches this far claiming to be a number must
    // actually be one).
    && (v.price === null || (typeof v.price === 'number' && Number.isFinite(v.price)))
    && (v.currency === null || typeof v.currency === 'string')
    && (v.billingPeriod === null || typeof v.billingPeriod === 'string')
    && (v.region === null || typeof v.region === 'string')
    && (v.taxIncluded === null || typeof v.taxIncluded === 'boolean')
    && isUntrustedEvidenceTrust(v.trust);
}

// Fail-closed gate: throws rather than letting evidence without valid,
// mandatory provenance reach comparison/synthesis. Mirrors R23.5B's
// DEVICE_BROWSER_TRUST_PROVENANCE_MISSING fail-closed pattern.
export function assertUntrustedPricingEvidence(value: unknown, requestId: string): UntrustedPricingEvidence {
  if (!isUntrustedPricingEvidence(value)) {
    throw new NagexError({
      code: 'AGENT_EVIDENCE_PROVENANCE_MISSING',
      category: 'VALIDATION',
      message: 'Evidence is missing required, valid untrusted-content provenance and cannot be used for comparison or synthesis.',
      request_id: requestId,
    });
  }
  return value;
}

// Raw pricing facts extracted upstream (e.g. by a model or a structured
// extractor) are plain, un-provenanced values — this function is the only
// place allowed to attach real trust to them, from a real EvidenceSource.
export function normalizeEvidenceSource(
  source: EvidenceSource,
  facts: { planName: string | null; price: number | null; currency: string | null; billingPeriod: string | null; region: string | null; taxIncluded: boolean | null },
): UntrustedPricingEvidence {
  return {
    sourceUrl: source.url,
    retrievedAt: source.retrievedAt,
    title: source.title,
    excerpt: source.snippet ?? '',
    planName: facts.planName,
    price: facts.price,
    currency: facts.currency,
    billingPeriod: facts.billingPeriod,
    region: facts.region,
    taxIncluded: facts.taxIncluded,
    trust: createUntrustedEvidenceTrust('WEB'),
  };
}

export function normalizeBrowserEvidence(
  url: string,
  title: string,
  excerpt: string,
  trust: BrowserContentTrustMetadata,
  retrievedAt: string,
  facts: { planName: string | null; price: number | null; currency: string | null; billingPeriod: string | null; region: string | null; taxIncluded: boolean | null },
): UntrustedPricingEvidence {
  return {
    sourceUrl: url,
    retrievedAt,
    title,
    excerpt,
    planName: facts.planName,
    price: facts.price,
    currency: facts.currency,
    billingPeriod: facts.billingPeriod,
    region: facts.region,
    taxIncluded: facts.taxIncluded,
    trust: trustFromBrowserProvenance(trust),
  };
}

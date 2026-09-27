// R23.6E Decision 5 / 6 — a price delta is computed only when the current
// evidence and the previous verified baseline genuinely describe the same
// thing (plan, currency, billing period, region, tax assumption). No
// baseline, or a mismatch on any of these, must never be silently coerced
// into a fabricated "increased/decreased" claim.
import type { CompetitorPricingBaselineRecord, PricingChange, UntrustedPricingEvidence } from './competitor-pricing-email.types.js';

// Live extraction (a real model call over real page text — see
// pricing-extraction.service.ts) is not required to phrase a monthly or
// annual billing period identically every time: "monthly", "month", and
// "per member / month" have all been observed, verbatim, across separate
// real fetches of the same real pricing page. Left uncanonicalized, this
// phrasing variance alone breaks the dimension-key exact-match and
// produces a false NO_BASELINE even though nothing about the plan actually
// changed. This is the one deterministic normalization boundary allowed to
// fold known-equivalent billing-period phrasings together for dimension-key
// purposes; it never touches the raw wording stored on evidence/baseline
// records for display, and it never guesses at a phrase it doesn't
// recognize — an unrecognized phrase is normalized for whitespace/case only
// and forms its own distinct dimension, exactly as before this boundary
// existed.
const MONTHLY_BILLING_PHRASES = new Set(['month', 'monthly', 'per month', '/month', 'per member/month']);
const ANNUAL_BILLING_PHRASES = new Set(['year', 'yearly', 'annual', 'annually', 'per year', '/year']);

export function canonicalizeBillingPeriod(raw: string | null): string | null {
  if (raw === null) return null;
  const compact = raw.trim().toLowerCase().replace(/\s+/g, ' ').replace(/\s*\/\s*/g, '/');
  if (MONTHLY_BILLING_PHRASES.has(compact)) return 'monthly';
  if (ANNUAL_BILLING_PHRASES.has(compact)) return 'annual';
  // Unknown/ambiguous phrasing is never fabricated into monthly/annual —
  // it is kept as its own normalized (whitespace/case-collapsed) value, so
  // it still forms a stable, distinct dimension rather than being coerced.
  return compact;
}

// Normalizes a snapshot's comparison-relevant dimensions into one stable
// key so a baseline can be looked up/stored per exact dimension
// combination — this is what makes "same product/plan, same billing
// period, same currency, same region" enforceable at the store layer, not
// just at diff time.
export function computeDimensionKey(input: { planName: string | null; currency: string | null; billingPeriod: string | null; region: string | null }): string {
  const norm = (v: string | null) => (v ?? '').trim().toLowerCase();
  return [norm(input.planName), norm(input.currency), norm(canonicalizeBillingPeriod(input.billingPeriod)), norm(input.region)].join('|');
}

export function computePricingChange(
  current: UntrustedPricingEvidence,
  previous: CompetitorPricingBaselineRecord | null,
): PricingChange {
  if (!previous) {
    return { current, previous: null, comparable: false, reason: 'NO_BASELINE' };
  }

  const currentKey = computeDimensionKey(current);
  const previousKey = computeDimensionKey(previous);
  const dimensionsMatch = currentKey === previousKey;
  const taxAssumptionsAgree = current.taxIncluded === null || previous.taxIncluded === null || current.taxIncluded === previous.taxIncluded;

  if (!dimensionsMatch || !taxAssumptionsAgree || current.price === null || current.currency === null) {
    return { current, previous, comparable: false, reason: 'NOT_DIRECTLY_COMPARABLE' };
  }

  const absoluteChange = current.price - previous.price;
  const percentChange = previous.price !== 0 ? (absoluteChange / previous.price) * 100 : undefined;
  return { current, previous, comparable: true, absoluteChange, percentChange };
}

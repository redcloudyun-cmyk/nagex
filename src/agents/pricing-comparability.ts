// R23.6E Decision 5 / 6 — a price delta is computed only when the current
// evidence and the previous verified baseline genuinely describe the same
// thing (plan, currency, billing period, region, tax assumption). No
// baseline, or a mismatch on any of these, must never be silently coerced
// into a fabricated "increased/decreased" claim.
import type { CompetitorPricingBaselineRecord, PricingChange, UntrustedPricingEvidence } from './competitor-pricing-email.types.js';

// Normalizes a snapshot's comparison-relevant dimensions into one stable
// key so a baseline can be looked up/stored per exact dimension
// combination — this is what makes "same product/plan, same billing
// period, same currency, same region" enforceable at the store layer, not
// just at diff time.
export function computeDimensionKey(input: { planName: string | null; currency: string | null; billingPeriod: string | null; region: string | null }): string {
  const norm = (v: string | null) => (v ?? '').trim().toLowerCase();
  return [norm(input.planName), norm(input.currency), norm(input.billingPeriod), norm(input.region)].join('|');
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

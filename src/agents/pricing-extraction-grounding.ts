// R23.6E Phase C Section 4 — "$29 does not automatically establish monthly
// billing, USD, tax inclusion, or region." This is the code-level backstop
// against a model inferring/fabricating a field the source text does not
// actually support: every non-null field the model proposes is checked
// against the real source text it was extracted from, and nulled out if
// unsupported. This runs regardless of what the model itself claims.
import type { PricingExtractionCandidateFact } from './pricing-extraction.types.js';

const CURRENCY_MARKERS: Record<string, string[]> = {
  USD: ['usd', '$'],
  KRW: ['krw', '₩'],
  EUR: ['eur', '€'],
  GBP: ['gbp', '£'],
  JPY: ['jpy', '¥'],
  CNY: ['cny', 'rmb', '¥'],
};

const BILLING_PERIOD_MARKERS: Record<string, string[]> = {
  MONTHLY: ['month', '/mo', 'per mo'],
  ANNUAL: ['year', 'annual', '/yr', 'per yr'],
  WEEKLY: ['week', '/wk'],
  DAILY: ['day', '/day'],
};

const TAX_INCLUDED_MARKERS = ['tax included', 'incl. tax', 'incl tax', 'including tax', 'tax-inclusive'];
const TAX_EXCLUDED_MARKERS = ['tax not included', 'excl. tax', 'excl tax', 'excluding tax', 'plus tax', '+ tax', 'tax-exclusive'];

function containsAny(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

export function isFiniteOrNull(value: number | null): value is number | null {
  return value === null || Number.isFinite(value);
}

// The one place a raw extracted fact is checked against its real source
// text before it is trusted for anything downstream. Never throws — an
// unsupported field is simply nulled, never rejected outright (only a
// missing/mismatched sourceId rejects the whole fact, see
// pricing-extraction.service.ts).
export function groundFactAgainstSourceText(fact: PricingExtractionCandidateFact, sourceText: string): PricingExtractionCandidateFact {
  const text = sourceText.toLowerCase();

  // Price: not fabricated if not finite, and not trusted if the literal
  // number never actually appears in the source text.
  let price: number | null = fact.price;
  if (!Number.isFinite(price)) {
    price = null;
  } else if (price !== null) {
    const asText = String(price);
    const asFixed = price.toFixed(2);
    if (!text.includes(asText) && !text.includes(asFixed)) {
      price = null;
    }
  }

  let currency: string | null = fact.currency;
  if (currency) {
    const markers = CURRENCY_MARKERS[currency.toUpperCase()] ?? [currency.toLowerCase()];
    if (!containsAny(text, markers)) currency = null;
  }

  let billingPeriod: string | null = fact.billingPeriod;
  if (billingPeriod) {
    const markers = BILLING_PERIOD_MARKERS[billingPeriod.toUpperCase()] ?? [billingPeriod.toLowerCase()];
    if (!containsAny(text, markers)) billingPeriod = null;
  }

  let taxIncluded: boolean | null = fact.taxIncluded;
  if (taxIncluded === true && !containsAny(text, TAX_INCLUDED_MARKERS)) taxIncluded = null;
  if (taxIncluded === false && !containsAny(text, TAX_EXCLUDED_MARKERS)) taxIncluded = null;

  return { ...fact, price, currency, billingPeriod, taxIncluded };
}

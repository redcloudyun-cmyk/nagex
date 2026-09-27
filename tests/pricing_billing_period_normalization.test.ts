// Post-R23.6E hardening — discovered live against real Notion pricing
// (notion.com/pricing): separate real fetches, seconds apart, produced
// billingPeriod extractions of "monthly", "month", and "per member / month"
// for the exact same actual billing period. Since computeDimensionKey()
// previously used the raw extracted string verbatim, this phrasing
// variance alone could make a second real observation miss the first
// observation's promoted baseline (a false NO_BASELINE), even though
// nothing about the underlying plan changed. This file certifies the
// canonicalizeBillingPeriod() boundary added to fix that, without letting
// canonicalization fabricate equivalence for anything not explicitly known
// to mean the same thing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeBillingPeriod, computeDimensionKey } from '../src/agents/pricing-comparability.js';
import { CompetitorPricingBaselineStore } from '../src/agents/competitor-pricing-baseline.store.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-billing-period-test-'));
}

test('1. "month" canonicalizes the same as "monthly"', () => {
  assert.equal(canonicalizeBillingPeriod('month'), canonicalizeBillingPeriod('monthly'));
});

test('2. "monthly" canonicalizes the same as "per month"', () => {
  assert.equal(canonicalizeBillingPeriod('monthly'), canonicalizeBillingPeriod('per month'));
});

test('3. "/month" canonicalizes the same as "monthly"', () => {
  assert.equal(canonicalizeBillingPeriod('/month'), canonicalizeBillingPeriod('monthly'));
});

test('4. "per member / month" canonicalizes the same as "monthly" for dimension purposes', () => {
  assert.equal(canonicalizeBillingPeriod('per member / month'), canonicalizeBillingPeriod('monthly'));
  assert.equal(canonicalizeBillingPeriod('per member / month'), 'monthly');
});

test('5. a canonical monthly baseline is reused across raw phrase variants', () => {
  const dir = tempDir();
  const store = new CompetitorPricingBaselineStore({ dir });
  const written = store.upsertVerified({
    tenantId: 'ten_a',
    ownerId: 'usr_a',
    competitor: 'Notion',
    planName: 'Free',
    currency: 'KRW',
    billingPeriod: 'monthly',
    region: null,
    taxIncluded: null,
    price: 0,
    sourceUrl: 'https://www.notion.com/pricing',
    retrievedAt: '2026-09-27T08:57:38.341Z',
  });

  for (const variant of ['month', 'per month', '/month', 'per member / month']) {
    const key = computeDimensionKey({ planName: 'Free', currency: 'KRW', billingPeriod: variant, region: null });
    const found = store.getOwned('ten_a', 'usr_a', 'Notion', key);
    assert.equal(found?.baselineId, written.baselineId, `variant "${variant}" must resolve to the same baseline`);
  }
});

test('6. annual and monthly remain different dimensions', () => {
  assert.notEqual(canonicalizeBillingPeriod('annual'), canonicalizeBillingPeriod('monthly'));
  assert.notEqual(canonicalizeBillingPeriod('yearly'), canonicalizeBillingPeriod('month'));
  const monthlyKey = computeDimensionKey({ planName: 'Pro', currency: 'USD', billingPeriod: 'monthly', region: null });
  const annualKey = computeDimensionKey({ planName: 'Pro', currency: 'USD', billingPeriod: 'annual', region: null });
  assert.notEqual(monthlyKey, annualKey);
});

test('7. an unknown/ambiguous billing-period phrase is never fabricated into monthly or annual', () => {
  const unknown = canonicalizeBillingPeriod('one-time payment');
  assert.notEqual(unknown, 'monthly');
  assert.notEqual(unknown, 'annual');
  // still deterministic and stable (whitespace/case-normalized), not dropped
  assert.equal(unknown, canonicalizeBillingPeriod('One-Time Payment'));
});

test('8. currency/plan/region isolation is unchanged by billing-period canonicalization', () => {
  const base = { planName: 'Pro', currency: 'USD', billingPeriod: 'monthly', region: null as string | null };
  const key = computeDimensionKey(base);
  assert.notEqual(key, computeDimensionKey({ ...base, currency: 'EUR' }));
  assert.notEqual(key, computeDimensionKey({ ...base, planName: 'Free' }));
  assert.notEqual(key, computeDimensionKey({ ...base, region: 'US' }));
});

test('9. raw evidence billing-period wording is preserved and gains no authority over the canonical key', () => {
  const dir = tempDir();
  const store = new CompetitorPricingBaselineStore({ dir });
  const written = store.upsertVerified({
    tenantId: 'ten_a',
    ownerId: 'usr_a',
    competitor: 'Acme',
    planName: 'Pro',
    currency: 'USD',
    billingPeriod: 'per member / month',
    region: null,
    taxIncluded: null,
    price: 10,
    sourceUrl: 'https://acme.example/pricing',
    retrievedAt: '2026-09-27T00:00:00.000Z',
  });
  // The persisted record keeps the raw wording for display/evidence...
  assert.equal(written.billingPeriod, 'per member / month');
  // ...but the dimension key it was actually stored under is canonical,
  // exactly as any other "monthly" observation would compute it.
  assert.equal(written.dimensionKey, computeDimensionKey({ planName: 'Pro', currency: 'USD', billingPeriod: 'monthly', region: null }));
});

test('10. no cross-tenant/cross-user baseline regression from the canonicalization change', () => {
  const dir = tempDir();
  const store = new CompetitorPricingBaselineStore({ dir });
  store.upsertVerified({
    tenantId: 'ten_a',
    ownerId: 'usr_a',
    competitor: 'Acme',
    planName: 'Pro',
    currency: 'USD',
    billingPeriod: 'monthly',
    region: null,
    taxIncluded: null,
    price: 10,
    sourceUrl: 'https://acme.example/pricing',
    retrievedAt: '2026-09-27T00:00:00.000Z',
  });
  const key = computeDimensionKey({ planName: 'Pro', currency: 'USD', billingPeriod: 'per month', region: null });
  assert.equal(store.getOwned('ten_b', 'usr_a', 'Acme', key), undefined, 'cross-tenant access must remain indistinguishable from nonexistent');
  assert.equal(store.getOwned('ten_a', 'usr_b', 'Acme', key), undefined, 'cross-owner access must remain indistinguishable from nonexistent');
});

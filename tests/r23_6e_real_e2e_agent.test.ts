// R23.6E Phase B — canonical scenario contract, durable baseline
// persistence, untrusted evidence normalization boundary, and the run
// state-machine skeleton. Deliberately does NOT exercise real research,
// Gmail draft/send, or approval — those land in Phase C-E. These tests
// prove the Phase B primitives are sound in isolation: fail-closed
// provenance, comparability rules, baseline durability/isolation, and that
// the orchestration policy itself cannot be skipped.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CompetitorPricingBaselineStore } from '../src/agents/competitor-pricing-baseline.store.js';
import { CompetitorPricingRunStore } from '../src/agents/competitor-pricing-run.store.js';
import { CompetitorPricingRunService } from '../src/agents/competitor-pricing-run.service.js';
import { isLegalRunTransition, assertLegalRunTransition } from '../src/agents/competitor-pricing-run.state.js';
import { computeDimensionKey, computePricingChange } from '../src/agents/pricing-comparability.js';
import {
  createUntrustedEvidenceTrust,
  isUntrustedPricingEvidence,
  assertUntrustedPricingEvidence,
  normalizeEvidenceSource,
} from '../src/agents/untrusted-evidence.normalizer.js';
import { handleCompetitorPricingAgentRoutes } from '../src/http/routes/competitor-pricing-agent.routes.js';
import type { UntrustedPricingEvidence } from '../src/agents/competitor-pricing-email.types.js';
import type { EvidenceSource } from '../src/research/evidence-pack.types.js';

function tmp(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `nagex-r236e-${label}-`));
}

function headers(tenantId: string, ownerId: string): Record<string, string> {
  return { 'x-nagex-tenant': tenantId, 'x-principal-id': ownerId, 'x-request-id': 'req_test' };
}

function makeEvidence(overrides: Partial<UntrustedPricingEvidence> = {}): UntrustedPricingEvidence {
  return {
    sourceUrl: 'https://acme.example/pricing',
    retrievedAt: '2026-09-27T00:00:00.000Z',
    title: 'Acme Pricing',
    excerpt: 'Pro plan $29/month',
    planName: 'Pro',
    price: 29,
    currency: 'USD',
    billingPeriod: 'MONTHLY',
    region: null,
    taxIncluded: null,
    trust: createUntrustedEvidenceTrust('WEB'),
    ...overrides,
  };
}

// ── Evidence provenance is mandatory (Decision 3) ────────────────────────

test('R23.6E untrusted evidence trust is mandatory and never fabricated as trusted', () => {
  const trust = createUntrustedEvidenceTrust('WEB');
  assert.equal(trust.level, 'UNTRUSTED_EXTERNAL');
  assert.equal(trust.source, 'WEB');
  assert.equal(trust.canGrantPermission, false);
  assert.equal(trust.canApproveAction, false);
  assert.equal(trust.canAuthorizeCredentialUse, false);
  assert.equal(trust.canOverridePolicy, false);
  assert.equal(trust.canWritePersistentMemory, false);
});

test('R23.6E evidence missing trust fails validation, never silently passes', () => {
  const { trust, ...withoutTrust } = makeEvidence();
  assert.equal(isUntrustedPricingEvidence(withoutTrust), false);
  assert.equal(isUntrustedPricingEvidence({ ...withoutTrust, trust: { level: 'TRUSTED' } }), false);
});

test('R23.6E missing/invalid provenance fails closed at the normalization boundary', () => {
  const { trust, ...withoutTrust } = makeEvidence();
  assert.throws(
    () => assertUntrustedPricingEvidence(withoutTrust, 'req_1'),
    (error: any) => {
      assert.equal(error.code, 'AGENT_EVIDENCE_PROVENANCE_MISSING');
      return true;
    },
  );
  // A fully valid evidence item passes straight through unchanged.
  const valid = makeEvidence();
  assert.deepEqual(assertUntrustedPricingEvidence(valid, 'req_1'), valid);
});

test('R23.6E normalizeEvidenceSource always attaches real WEB provenance, never a caller-supplied one', () => {
  const source: EvidenceSource = {
    sourceId: 'src_1',
    title: 'Acme Pricing',
    url: 'https://acme.example/pricing',
    retrievedAt: '2026-09-27T00:00:00.000Z',
    freshnessStatus: 'CURRENT',
  };
  const evidence = normalizeEvidenceSource(source, { planName: 'Pro', price: 29, currency: 'USD', billingPeriod: 'MONTHLY', region: null, taxIncluded: null });
  assert.equal(evidence.trust.source, 'WEB');
  assert.equal(evidence.trust.level, 'UNTRUSTED_EXTERNAL');
  assert.equal(isUntrustedPricingEvidence(evidence), true);
});

// ── Baseline durability + isolation (Decision 4) ─────────────────────────

test('R23.6E baseline store enforces tenant/owner isolation', () => {
  const dir = tmp('baseline-iso');
  const store = new CompetitorPricingBaselineStore({ dir });
  const record = store.upsertVerified({
    tenantId: 'ten_a', ownerId: 'usr_a', competitor: 'Acme',
    planName: 'Pro', currency: 'USD', billingPeriod: 'MONTHLY', region: null, taxIncluded: null,
    price: 25, sourceUrl: 'https://acme.example/pricing', retrievedAt: '2026-09-20T00:00:00.000Z',
  });
  const dimensionKey = computeDimensionKey({ planName: 'Pro', currency: 'USD', billingPeriod: 'MONTHLY', region: null });

  assert.equal(store.getOwned('ten_a', 'usr_a', 'Acme', dimensionKey)?.baselineId, record.baselineId);
  assert.equal(store.getOwned('ten_b', 'usr_a', 'Acme', dimensionKey), undefined, 'cross-tenant access must be indistinguishable from nonexistent');
  assert.equal(store.getOwned('ten_a', 'usr_b', 'Acme', dimensionKey), undefined, 'cross-owner access must be indistinguishable from nonexistent');
});

test('R23.6E baseline survives store recreation over the same directory (durable, not in-memory-only)', () => {
  const dir = tmp('baseline-durable');
  const store1 = new CompetitorPricingBaselineStore({ dir });
  store1.upsertVerified({
    tenantId: 'ten_a', ownerId: 'usr_a', competitor: 'Acme',
    planName: 'Pro', currency: 'USD', billingPeriod: 'MONTHLY', region: null, taxIncluded: null,
    price: 25, sourceUrl: 'https://acme.example/pricing', retrievedAt: '2026-09-20T00:00:00.000Z',
  });

  // A fresh instance over the same directory simulates a process restart.
  const store2 = new CompetitorPricingBaselineStore({ dir });
  const dimensionKey = computeDimensionKey({ planName: 'Pro', currency: 'USD', billingPeriod: 'MONTHLY', region: null });
  const restored = store2.getOwned('ten_a', 'usr_a', 'Acme', dimensionKey);
  assert.ok(restored, 'baseline must survive a fresh store instance over the same directory');
  assert.equal(restored?.price, 25);
});

test('R23.6E a baseline for one dimension combination never leaks into a different, incompatible one', () => {
  const dir = tmp('baseline-dims');
  const store = new CompetitorPricingBaselineStore({ dir });
  store.upsertVerified({
    tenantId: 'ten_a', ownerId: 'usr_a', competitor: 'Acme',
    planName: 'Pro', currency: 'USD', billingPeriod: 'MONTHLY', region: null, taxIncluded: null,
    price: 25, sourceUrl: 'https://acme.example/pricing', retrievedAt: '2026-09-20T00:00:00.000Z',
  });
  const annualKey = computeDimensionKey({ planName: 'Pro', currency: 'USD', billingPeriod: 'ANNUAL', region: null });
  assert.equal(store.getOwned('ten_a', 'usr_a', 'Acme', annualKey), undefined);
});

// ── Comparability (Decision 5, 6) ────────────────────────────────────────

test('R23.6E no previous baseline produces a truthful current-only state, never a fabricated change', () => {
  const current = makeEvidence();
  const change = computePricingChange(current, null);
  assert.equal(change.comparable, false);
  assert.equal(change.reason, 'NO_BASELINE');
  assert.equal(change.absoluteChange, undefined);
  assert.equal(change.percentChange, undefined);
});

test('R23.6E mismatched billing period is NOT_DIRECTLY_COMPARABLE, never coerced into a delta', () => {
  const current = makeEvidence({ billingPeriod: 'ANNUAL', price: 290 });
  const previousBaseline = {
    baselineId: 'cpb_1', tenantId: 'ten_a', ownerId: 'usr_a', competitor: 'Acme',
    dimensionKey: computeDimensionKey({ planName: 'Pro', currency: 'USD', billingPeriod: 'MONTHLY', region: null }),
    planName: 'Pro', currency: 'USD', billingPeriod: 'MONTHLY', region: null, taxIncluded: null,
    price: 25, sourceUrl: 'https://acme.example/pricing', retrievedAt: '2026-09-20T00:00:00.000Z',
    verifiedAt: '2026-09-20T00:00:00.000Z', createdAt: '2026-09-20T00:00:00.000Z',
  };
  const change = computePricingChange(current, previousBaseline);
  assert.equal(change.comparable, false);
  assert.equal(change.reason, 'NOT_DIRECTLY_COMPARABLE');
});

test('R23.6E mismatched currency is NOT_DIRECTLY_COMPARABLE', () => {
  const current = makeEvidence({ currency: 'KRW', price: 39000 });
  const previousBaseline = {
    baselineId: 'cpb_1', tenantId: 'ten_a', ownerId: 'usr_a', competitor: 'Acme',
    dimensionKey: computeDimensionKey({ planName: 'Pro', currency: 'USD', billingPeriod: 'MONTHLY', region: null }),
    planName: 'Pro', currency: 'USD', billingPeriod: 'MONTHLY', region: null, taxIncluded: null,
    price: 25, sourceUrl: 'https://acme.example/pricing', retrievedAt: '2026-09-20T00:00:00.000Z',
    verifiedAt: '2026-09-20T00:00:00.000Z', createdAt: '2026-09-20T00:00:00.000Z',
  };
  const change = computePricingChange(current, previousBaseline);
  assert.equal(change.comparable, false);
  assert.equal(change.reason, 'NOT_DIRECTLY_COMPARABLE');
});

test('R23.6E identical comparable dimensions compute a real, non-fabricated delta', () => {
  const current = makeEvidence({ price: 29 });
  const previousBaseline = {
    baselineId: 'cpb_1', tenantId: 'ten_a', ownerId: 'usr_a', competitor: 'Acme',
    dimensionKey: computeDimensionKey({ planName: 'Pro', currency: 'USD', billingPeriod: 'MONTHLY', region: null }),
    planName: 'Pro', currency: 'USD', billingPeriod: 'MONTHLY', region: null, taxIncluded: null,
    price: 25, sourceUrl: 'https://acme.example/pricing', retrievedAt: '2026-09-20T00:00:00.000Z',
    verifiedAt: '2026-09-20T00:00:00.000Z', createdAt: '2026-09-20T00:00:00.000Z',
  };
  const change = computePricingChange(current, previousBaseline);
  assert.equal(change.comparable, true);
  assert.equal(change.absoluteChange, 4);
  assert.equal(change.percentChange, 16);
});

// ── Run state machine (Section 15 / Phase B) ─────────────────────────────

test('R23.6E run status cannot skip the orchestration policy (e.g. research cannot jump straight to sent)', () => {
  assert.equal(isLegalRunTransition('RESEARCHING', 'SENT_CONFIRMED'), false);
  assert.equal(isLegalRunTransition('RESEARCHING', 'REPORT_READY'), true);
  assert.equal(isLegalRunTransition('APPROVAL_REQUIRED', 'SEND_ATTEMPTED'), false, 'approval must be APPROVED before a send can be attempted');
  assert.throws(() => assertLegalRunTransition('RESEARCHING', 'SENT_CONFIRMED', 'req_1'), (error: any) => {
    assert.equal(error.code, 'AGENT_RUN_ILLEGAL_TRANSITION');
    return true;
  });
});

test('R23.6E terminal states (SENT_CONFIRMED, FAILED, BLOCKED) allow no further transition', () => {
  for (const terminal of ['SENT_CONFIRMED', 'FAILED', 'BLOCKED'] as const) {
    assert.equal(isLegalRunTransition(terminal, 'RESEARCHING'), false);
    assert.equal(isLegalRunTransition(terminal, 'APPROVAL_REQUIRED'), false);
  }
});

test('R23.6E a rejected approval (BLOCKED) can never resume toward send', () => {
  assert.equal(isLegalRunTransition('BLOCKED', 'APPROVED'), false);
  assert.equal(isLegalRunTransition('BLOCKED', 'SEND_ATTEMPTED'), false);
});

test('R23.6E payload drift re-enters approval rather than terminating the run', () => {
  assert.equal(isLegalRunTransition('APPROVED', 'APPROVAL_REQUIRED'), true);
  assert.equal(isLegalRunTransition('APPROVED', 'SENT_CONFIRMED'), false, 'approved cannot skip the send-attempt step');
});

// ── Run service / route (Phase B skeleton) ───────────────────────────────

test('R23.6E starting a run persists it in RESEARCHING and is tenant/owner isolated', () => {
  const runService = new CompetitorPricingRunService(
    new CompetitorPricingRunStore({ dir: tmp('run-store') }),
    new CompetitorPricingBaselineStore({ dir: tmp('baseline-store') }),
  );
  const run = runService.startRun({ tenantId: 'ten_a', ownerId: 'usr_a', requestId: 'req_1', competitor: 'Acme' });
  assert.equal(run.status, 'RESEARCHING');
  assert.equal(run.evidence.length, 0);
  assert.equal(run.change, null);

  assert.equal(runService.getOwnedRun(run.runId, 'ten_a', 'usr_a')?.runId, run.runId);
  assert.equal(runService.getOwnedRun(run.runId, 'ten_b', 'usr_a'), undefined);
  assert.equal(runService.getOwnedRun(run.runId, 'ten_a', 'usr_b'), undefined);
});

test('R23.6E starting a run requires a non-blank competitor', () => {
  const runService = new CompetitorPricingRunService(
    new CompetitorPricingRunStore({ dir: tmp('run-store-2') }),
    new CompetitorPricingBaselineStore({ dir: tmp('baseline-store-2') }),
  );
  assert.throws(
    () => runService.startRun({ tenantId: 'ten_a', ownerId: 'usr_a', requestId: 'req_1', competitor: '   ' }),
    (error: any) => {
      assert.equal(error.code, 'AGENT_COMPETITOR_REQUIRED');
      return true;
    },
  );
});

test('R23.6E POST /api/v1/agents/competitor-pricing-email creates a run in RESEARCHING and never sends anything', async () => {
  const runService = new CompetitorPricingRunService(
    new CompetitorPricingRunStore({ dir: tmp('run-store-route') }),
    new CompetitorPricingBaselineStore({ dir: tmp('baseline-store-route') }),
  );
  const result = await handleCompetitorPricingAgentRoutes(
    'POST', '/api/v1/agents/competitor-pricing-email',
    { competitor: 'Acme', recipientEmail: 'user@example.com' },
    headers('ten_a', 'usr_a'), {}, { competitorPricingRunService: runService },
  );
  assert.ok(result);
  assert.equal(result?.status, 201);
  const run = result?.data as any;
  assert.equal(run.status, 'RESEARCHING');
  // Phase B route module imports no Gmail/approval/credential dependency at
  // all — there is no code path here that could reach SENT_CONFIRMED.
  assert.notEqual(run.status, 'SENT_CONFIRMED');
  assert.notEqual(run.status, 'SEND_ATTEMPTED');
});

test('R23.6E POST rejects a blank competitor rather than silently creating an empty run', async () => {
  const runService = new CompetitorPricingRunService(
    new CompetitorPricingRunStore({ dir: tmp('run-store-route-2') }),
    new CompetitorPricingBaselineStore({ dir: tmp('baseline-store-route-2') }),
  );
  await assert.rejects(
    () => handleCompetitorPricingAgentRoutes('POST', '/api/v1/agents/competitor-pricing-email', {}, headers('ten_a', 'usr_a'), {}, { competitorPricingRunService: runService }),
    (error: any) => {
      assert.equal(error.code, 'AGENT_COMPETITOR_REQUIRED');
      return true;
    },
  );
});

test('R23.6E GET run status is tenant/owner isolated at the route layer', async () => {
  const runService = new CompetitorPricingRunService(
    new CompetitorPricingRunStore({ dir: tmp('run-store-route-3') }),
    new CompetitorPricingBaselineStore({ dir: tmp('baseline-store-route-3') }),
  );
  const created = await handleCompetitorPricingAgentRoutes(
    'POST', '/api/v1/agents/competitor-pricing-email', { competitor: 'Acme' },
    headers('ten_a', 'usr_a'), {}, { competitorPricingRunService: runService },
  );
  const runId = (created?.data as any).runId;

  const ownRead = await handleCompetitorPricingAgentRoutes(
    'GET', `/api/v1/agents/competitor-pricing-email/${runId}`, null, headers('ten_a', 'usr_a'), {}, { competitorPricingRunService: runService },
  );
  assert.equal(ownRead?.status, 200);

  await assert.rejects(
    () => handleCompetitorPricingAgentRoutes('GET', `/api/v1/agents/competitor-pricing-email/${runId}`, null, headers('ten_b', 'usr_a'), {}, { competitorPricingRunService: runService }),
    (error: any) => {
      assert.equal(error.code, 'AGENT_RUN_NOT_FOUND');
      return true;
    },
  );
});

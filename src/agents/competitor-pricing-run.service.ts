// R23.6E — CompetitorPricingRunService. Phase B skeleton only: run
// creation, ownership-scoped lookup, and the transition primitive every
// later phase method will call through. Phase C adds real research
// (EvidencePackService/WebSearchService/BrowserService), Phase D adds
// synthesis + Gmail draft, Phase E adds approval + real send. This file
// deliberately does not call any of those yet (Decision 1 — one narrow,
// scenario-specific orchestration, never a generic workflow/binding engine).
import { NagexError } from '../common/errors.js';
import type { CompetitorPricingBaselineStore } from './competitor-pricing-baseline.store.js';
import type { CompetitorPricingRunStore } from './competitor-pricing-run.store.js';
import { assertLegalRunTransition } from './competitor-pricing-run.state.js';
import { assertUntrustedPricingEvidence } from './untrusted-evidence.normalizer.js';
import { computeDimensionKey, computePricingChange } from './pricing-comparability.js';
import type { CompetitorPricingResearchRequest, CompetitorPricingRunRecord, E2EAgentFailureReason, E2EAgentRunStatus, UntrustedPricingEvidence } from './competitor-pricing-email.types.js';

// The one seam CompetitorPricingRunService depends on for research —
// CompetitorPricingResearchService implements this, and tests can supply a
// minimal fake without constructing the real EvidencePackService/
// BrowserToolService/PricingExtractionService chain.
export interface CompetitorPricingResearchPort {
  research(input: { tenantId: string; ownerId: string; requestId: string; competitor: string; targetUrl: string | null }): Promise<UntrustedPricingEvidence[]>;
}

export class CompetitorPricingRunService {
  constructor(
    private readonly runStore: CompetitorPricingRunStore,
    private readonly baselineStore: CompetitorPricingBaselineStore,
    private readonly researchService: CompetitorPricingResearchPort,
  ) {}

  public startRun(input: CompetitorPricingResearchRequest): CompetitorPricingRunRecord {
    const competitor = input.competitor.trim();
    if (!competitor) {
      throw new NagexError({ code: 'AGENT_COMPETITOR_REQUIRED', category: 'VALIDATION', message: 'competitor is required.', request_id: input.requestId });
    }
    return this.runStore.create({
      tenantId: input.tenantId,
      ownerId: input.ownerId,
      requestId: input.requestId,
      competitor,
      targetUrl: input.targetUrl?.trim() || null,
      recipientEmail: input.recipientEmail?.trim() || null,
    });
  }

  public getOwnedRun(runId: string, tenantId: string, ownerId: string): CompetitorPricingRunRecord | undefined {
    return this.runStore.getOwned(runId, tenantId, ownerId);
  }

  // Phase C — Research -> evidence normalization -> structured extraction
  // -> baseline lookup -> comparability -> REPORT_READY. Never touches
  // Gmail/approval/credentials, and never writes the baseline (Decision 10
  // — baseline promotion happens only after a real SENT_CONFIRMED, in
  // Phase E, so a failed/abandoned run can never silently become the new
  // comparison point).
  public async completeResearch(runId: string, tenantId: string, ownerId: string, requestId: string): Promise<CompetitorPricingRunRecord> {
    const run = this.requireOwnedRun(runId, tenantId, ownerId, requestId);

    let rawEvidence;
    try {
      rawEvidence = await this.researchService.research({ tenantId, ownerId, requestId, competitor: run.competitor, targetUrl: run.targetUrl });
    } catch {
      return this.transitionTo(run, 'FAILED', requestId, { failureReason: 'RESEARCH_UNAVAILABLE' });
    }

    // Fail closed on missing/invalid provenance — this throws synchronously
    // and the run remains RESEARCHING (never silently downgraded to
    // FAILED), mirroring R23.5B's own fail-closed precedent for missing
    // browser trust provenance.
    const evidence = rawEvidence.map((item) => assertUntrustedPricingEvidence(item, requestId));

    if (evidence.length === 0) {
      return this.transitionTo(run, 'FAILED', requestId, { failureReason: 'EVIDENCE_INSUFFICIENT' });
    }

    // The first grounded evidence item is the "current" pricing snapshot
    // this run reports and compares against. Its own dimensions (plan,
    // currency, billing period, region) — not the run's raw request —
    // determine which baseline is looked up (Decision 5/7: comparison
    // dimensions must actually match, never assumed from the request alone).
    const current = evidence[0];
    const dimensionKey = computeDimensionKey(current);
    const baseline = this.baselineStore.getOwned(tenantId, ownerId, run.competitor, dimensionKey) ?? null;
    const change = computePricingChange(current, baseline);

    return this.transitionTo(run, 'REPORT_READY', requestId, { evidence, change, failureReason: null });
  }

  private requireOwnedRun(runId: string, tenantId: string, ownerId: string, requestId: string): CompetitorPricingRunRecord {
    const run = this.runStore.getOwned(runId, tenantId, ownerId);
    if (!run) {
      throw new NagexError({ code: 'AGENT_RUN_NOT_FOUND', category: 'NOT_FOUND', message: `Run ${runId} was not found.`, request_id: requestId });
    }
    return run;
  }

  // The one place a run's status is ever mutated — every later-phase method
  // (completeResearch, createDraft, requestApproval, recordSendResult, ...)
  // must go through this, so AGENT_RUN_ILLEGAL_TRANSITION is the only way
  // an out-of-order move can happen, never a missed check in one specific
  // phase method.
  protected transitionTo(
    run: CompetitorPricingRunRecord,
    next: E2EAgentRunStatus,
    requestId: string,
    patch: Partial<Omit<CompetitorPricingRunRecord, 'runId' | 'tenantId' | 'ownerId' | 'status'>> & { failureReason?: E2EAgentFailureReason | null } = {},
  ): CompetitorPricingRunRecord {
    assertLegalRunTransition(run.status, next, requestId);
    return this.runStore.save({ ...run, ...patch, status: next });
  }

  // Exposed for Phase B tests / future phase methods that need read access
  // to the baseline for the run's competitor without duplicating the
  // ownership-scoped lookup.
  public getBaselineStore(): CompetitorPricingBaselineStore {
    return this.baselineStore;
  }
}

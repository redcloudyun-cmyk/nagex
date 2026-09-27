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
import type { CompetitorPricingResearchRequest, CompetitorPricingRunRecord, E2EAgentFailureReason, E2EAgentRunStatus } from './competitor-pricing-email.types.js';

export class CompetitorPricingRunService {
  constructor(
    private readonly runStore: CompetitorPricingRunStore,
    private readonly baselineStore: CompetitorPricingBaselineStore,
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

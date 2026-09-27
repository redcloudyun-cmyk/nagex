// R23.6E — CompetitorPricingRunService. Phase B skeleton only: run
// creation, ownership-scoped lookup, and the transition primitive every
// later phase method will call through. Phase C adds real research
// (EvidencePackService/WebSearchService/BrowserService), Phase D adds
// synthesis + Gmail draft, Phase E adds approval + real send. This file
// deliberately does not call any of those yet (Decision 1 — one narrow,
// scenario-specific orchestration, never a generic workflow/binding engine).
import { NagexError } from '../common/errors.js';
import { GMAIL_SEND_EMAIL_TOOL_ID } from '../modules/gmail/index.js';
import type { CompetitorPricingBaselineStore } from './competitor-pricing-baseline.store.js';
import type { CompetitorPricingRunStore } from './competitor-pricing-run.store.js';
import { assertLegalRunTransition } from './competitor-pricing-run.state.js';
import { assertUntrustedPricingEvidence } from './untrusted-evidence.normalizer.js';
import { computeDimensionKey, computePricingChange } from './pricing-comparability.js';
import { resolveRecipientEmail, type VerifiedIdentityLookup } from './recipient-resolution.js';
import { composePricingReport, type ReportLocale } from './pricing-report-composer.js';
import type { CompetitorPricingResearchRequest, CompetitorPricingRunRecord, E2EAgentFailureReason, E2EAgentRunStatus, UntrustedPricingEvidence } from './competitor-pricing-email.types.js';

// The one seam CompetitorPricingRunService depends on for research —
// CompetitorPricingResearchService implements this, and tests can supply a
// minimal fake without constructing the real EvidencePackService/
// BrowserToolService/PricingExtractionService chain.
export interface CompetitorPricingResearchPort {
  research(input: { tenantId: string; ownerId: string; requestId: string; competitor: string; targetUrl: string | null }): Promise<UntrustedPricingEvidence[]>;
}

// The one seam for requesting the real, human-facing gmail.send_email
// approval — GmailService.requestApproval already satisfies this shape
// exactly. Never used for gmail.create_draft (Section 7/Decision — this
// milestone never calls Gmail's own draft API at all) and never for
// executeSendEmail (that's Phase E, gated on the human APPROVE this
// produces).
export interface GmailSendApprovalPort {
  requestApproval(input: { toolId: string; tenantId: string; principalId: string; payload: unknown; requestId: string }): { approvalId: string };
}

export class CompetitorPricingRunService {
  constructor(
    private readonly runStore: CompetitorPricingRunStore,
    private readonly baselineStore: CompetitorPricingBaselineStore,
    private readonly researchService: CompetitorPricingResearchPort,
    private readonly identityLookup: VerifiedIdentityLookup,
    private readonly gmailApprovalPort: GmailSendApprovalPort,
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

  // Phase D Section 6/9 — REPORT_READY -> DRAFT_CREATED. Resolves the real
  // recipient (explicit request value, else the caller's own VERIFIED
  // account email, else BLOCK — never guessed from evidence/memory/model
  // output), composes the report deterministically from Phase C's already-
  // grounded facts (no re-query, no model invention), and freezes the
  // result as this run's one immutable draft payload. Never calls Gmail's
  // own create_draft API (Section 7/Decision — that tool is itself
  // approval-gated in this codebase, and self-approving it internally
  // would be a hidden approval this product forbids).
  public createDraft(runId: string, tenantId: string, ownerId: string, requestId: string, locale: ReportLocale = 'en'): CompetitorPricingRunRecord {
    const run = this.requireOwnedRun(runId, tenantId, ownerId, requestId);

    const recipient = resolveRecipientEmail(run.recipientEmail, ownerId, this.identityLookup);
    if (!recipient) {
      return this.transitionTo(run, 'BLOCKED', requestId, { failureReason: 'RECIPIENT_INVALID' });
    }

    const current = run.evidence[0];
    if (!current || !run.change) {
      // Should be unreachable given REPORT_READY's own precondition, but
      // never fabricate a report from absent evidence.
      return this.transitionTo(run, 'FAILED', requestId, { failureReason: 'DRAFT_FAILED' });
    }

    const { subject, body } = composePricingReport({ competitor: run.competitor, current, change: run.change, locale, now: new Date().toISOString() });
    const draftPayload = { to: [recipient], cc: [], bcc: [], subject, body };

    return this.transitionTo(run, 'DRAFT_CREATED', requestId, {
      recipientEmail: recipient,
      reportSubject: subject,
      reportBody: body,
      draftPayload,
    });
  }

  // Phase D Section 8/9 — DRAFT_CREATED -> APPROVAL_REQUIRED. Requests the
  // one real, human-facing approval for gmail.send_email, bound to the
  // exact frozen draftPayload from createDraft() — never regenerated here.
  // This is the only approval this run ever creates in Phase D; no
  // create_draft approval, no second approval implementation, no
  // server-side self-approval.
  public requestSendApproval(runId: string, tenantId: string, ownerId: string, requestId: string): CompetitorPricingRunRecord {
    const run = this.requireOwnedRun(runId, tenantId, ownerId, requestId);
    if (!run.draftPayload) {
      return this.transitionTo(run, 'FAILED', requestId, { failureReason: 'DRAFT_FAILED' });
    }

    let approval: { approvalId: string };
    try {
      approval = this.gmailApprovalPort.requestApproval({
        toolId: GMAIL_SEND_EMAIL_TOOL_ID,
        tenantId,
        principalId: ownerId,
        payload: { from: 'me', ...run.draftPayload, attachments: [], threadId: null, replyToMessageId: null },
        requestId,
      });
    } catch {
      return this.transitionTo(run, 'FAILED', requestId, { failureReason: 'CREDENTIAL_UNAVAILABLE' });
    }

    return this.transitionTo(run, 'APPROVAL_REQUIRED', requestId, { approvalId: approval.approvalId });
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

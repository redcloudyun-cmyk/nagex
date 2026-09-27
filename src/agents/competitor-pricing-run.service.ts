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

// The one seam for the real, human-facing gmail.send_email approval and
// send — GmailService already satisfies this shape exactly (requestApproval/
// getApproval/executeSendEmail). Never used for gmail.create_draft
// (Section 7/Decision — this milestone never calls Gmail's own draft API
// at all). This is the ONLY place this service ever touches Gmail — never
// the concrete GmailService class, never action-approval.store/
// security/credentials directly (see the Phase C/D structural test).
export interface GmailSendPort {
  requestApproval(input: { toolId: string; tenantId: string; principalId: string; payload: unknown; requestId: string }): { approvalId: string };
  getApproval(approvalId: string, tenantId: string, principalId: string): { status: string } | undefined;
  executeSendEmail(input: { approvalId: string; payload: unknown; tenantId: string; principalId: string; requestId: string }): Promise<{ executionId: string; externalId: string; externalUrl: string }>;
}

// Optional — real production wiring passes the composition root's real
// AuditLogger; tests may omit it. Structurally compatible with
// AuditLogger.logEvent (any return value is fine here; only the input
// shape matters). Never given anything but metadata (runId/approvalId/
// executionId/action/result) — never the draft payload or a credential.
export interface AuditLogPort {
  logEvent(event: { actor: { type: string; id: string }; tenant_id: string; action: string; resource: { type: string; id: string }; result: 'SUCCESS' | 'DENIED' | 'PENDING_APPROVAL' | 'FAILED'; request_id: string; details?: Record<string, unknown> }): unknown;
}

// Phase F Section 4 — optional. Real production wiring passes the
// composition root's real MemoryEngine.proposeMemory bound to 'USER'
// scope; MemoryEngine already enforces sourceRef/S2/S3/tenant+owner
// scoping and already dedupes an identical repeated proposal (see
// findMatchingMemory) — this service never re-implements any of that, it
// only ever proposes, never force-activates (no userConfirmed: true).
export interface GovernedMemoryPort {
  proposeMemory(input: { tenantId: string; ownerId: string; subject: string; predicate: string; value: unknown; sourceRef: string }): unknown;
}

export interface RunFinalizationResult {
  run: CompetitorPricingRunRecord;
  // Section 9/10 — deliberately separate from run.status. A baseline or
  // memory bookkeeping failure after a confirmed Gmail send must never be
  // reported as the email having failed; these two booleans are the
  // truthful, independent record of whether each piece of post-send
  // bookkeeping actually completed.
  baselinePromoted: boolean;
  memoryProposed: boolean;
}

export class CompetitorPricingRunService {
  constructor(
    private readonly runStore: CompetitorPricingRunStore,
    private readonly baselineStore: CompetitorPricingBaselineStore,
    private readonly researchService: CompetitorPricingResearchPort,
    private readonly identityLookup: VerifiedIdentityLookup,
    private readonly gmailSendPort: GmailSendPort,
    private readonly auditLogger?: AuditLogPort,
    private readonly memoryPort?: GovernedMemoryPort,
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
      approval = this.gmailSendPort.requestApproval({
        toolId: GMAIL_SEND_EMAIL_TOOL_ID,
        tenantId,
        principalId: ownerId,
        payload: this.toGmailComposePayload(run.draftPayload),
        requestId,
      });
    } catch {
      return this.transitionTo(run, 'FAILED', requestId, { failureReason: 'CREDENTIAL_UNAVAILABLE' });
    }

    return this.transitionTo(run, 'APPROVAL_REQUIRED', requestId, { approvalId: approval.approvalId });
  }

  // Phase E Section 5 — APPROVAL_REQUIRED -> APPROVED only after the real
  // approval system confirms the exact approval is APPROVED. Presence of
  // an approvalId is never treated as proof by itself. REJECTED/EXPIRED
  // both BLOCK the run (Section 2/3) — never silently retried, never a
  // send. Idempotent-safe: called again while still PENDING, this simply
  // returns the run unchanged rather than throwing.
  public confirmApproval(runId: string, tenantId: string, ownerId: string, requestId: string): CompetitorPricingRunRecord {
    const run = this.requireOwnedRun(runId, tenantId, ownerId, requestId);
    if (!run.approvalId) {
      return this.transitionTo(run, 'BLOCKED', requestId, { failureReason: 'APPROVAL_REJECTED' });
    }

    const approval = this.gmailSendPort.getApproval(run.approvalId, tenantId, ownerId);
    if (!approval || approval.status === 'REJECTED') {
      this.audit('approval.rejected', run, requestId, 'DENIED');
      return this.transitionTo(run, 'BLOCKED', requestId, { failureReason: 'APPROVAL_REJECTED' });
    }
    if (approval.status === 'EXPIRED') {
      this.audit('approval.expired', run, requestId, 'DENIED');
      return this.transitionTo(run, 'BLOCKED', requestId, { failureReason: 'APPROVAL_EXPIRED' });
    }
    if (approval.status !== 'APPROVED') {
      // Still PENDING (or an unexpected CONSUMED at this stage) — no human
      // decision yet; the run correctly stays at APPROVAL_REQUIRED.
      return run;
    }

    const approved = this.transitionTo(run, 'APPROVED', requestId, {});
    this.audit('approval.confirmed', approved, requestId, 'SUCCESS');
    return approved;
  }

  // Phase E Section 6-11 — APPROVED -> SEND_ATTEMPTED -> SENT_CONFIRMED/FAILED.
  //
  // Crash-window handling (Section 11): the run is transitioned to
  // SEND_ATTEMPTED and durably persisted BEFORE the real Gmail call is
  // made. This is what makes a process crash mid-send leave a truthful
  // "attempted, outcome unknown" record rather than nothing at all — and
  // because SEND_ATTEMPTED has no legal self-transition
  // (competitor-pricing-run.state.ts), a retry of this exact method on an
  // already-SEND_ATTEMPTED run fails closed with AGENT_RUN_ILLEGAL_TRANSITION
  // before ever touching Gmail again. This is layer 1 of duplicate-send
  // protection.
  //
  // Layer 2 is the existing ActionApprovalStore itself: approvalId
  // consumption is synchronous, durably persisted, and one-time-use,
  // written to disk BEFORE the real Gmail HTTP call even begins (see
  // GoogleCapabilityExecutionPipeline.execute()). So even if some other
  // code path bypassed layer 1, GmailService.executeSendEmail would still
  // reject a replay with APPROVAL_ALREADY_CONSUMED before calling Gmail a
  // second time.
  //
  // Residual, NOT fixed here (out of Phase E's scope — a pre-existing
  // property of the shared GoogleCapabilityExecutionPipeline, affecting
  // every Google mutation, not something R23.6E introduces or can safely
  // fix on its own): if APPROVAL_ALREADY_CONSUMED is thrown here, it means
  // some earlier attempt already durably consumed the approval before this
  // call — most plausibly this exact run's own previous attempt, crashed
  // between Gmail actually processing the send and this method recording
  // SENT_CONFIRMED. We cannot prove from here whether that earlier Gmail
  // call actually succeeded. The truthful choice is to leave the run at
  // SEND_ATTEMPTED — never FAILED (would hide a real send) and never
  // SENT_CONFIRMED (would fabricate confirmation). This is a genuine,
  // unresolved ambiguity: only a real reconciliation check against Gmail's
  // own Sent history could resolve it, and no such capability exists in
  // this codebase today.
  public async executeApprovedSend(runId: string, tenantId: string, ownerId: string, requestId: string): Promise<CompetitorPricingRunRecord> {
    const run = this.requireOwnedRun(runId, tenantId, ownerId, requestId);
    if (!run.draftPayload || !run.approvalId) {
      return this.transitionTo(run, 'FAILED', requestId, { failureReason: 'SEND_FAILED' });
    }

    const attempting = this.transitionTo(run, 'SEND_ATTEMPTED', requestId, {});
    this.audit('send.attempted', attempting, requestId, 'PENDING_APPROVAL');

    try {
      const result = await this.gmailSendPort.executeSendEmail({
        approvalId: attempting.approvalId!,
        payload: this.toGmailComposePayload(attempting.draftPayload),
        tenantId,
        principalId: ownerId,
        requestId,
      });
      const confirmed = this.transitionTo(attempting, 'SENT_CONFIRMED', requestId, { executionId: result.executionId });
      this.audit('send.confirmed', confirmed, requestId, 'SUCCESS');
      return confirmed;
    } catch (error) {
      if (error instanceof NagexError && error.code === 'APPROVAL_ALREADY_CONSUMED') {
        // Ambiguous crash-window outcome — see the method doc comment.
        // Deliberately NOT transitioned further; SEND_ATTEMPTED itself is
        // the truthful "attempted, unconfirmed" state.
        this.audit('send.ambiguous_replay_blocked', attempting, requestId, 'DENIED');
        return attempting;
      }
      const failed = this.transitionTo(attempting, 'FAILED', requestId, { failureReason: 'SEND_FAILED' });
      this.audit('send.failed', failed, requestId, 'FAILED');
      return failed;
    }
  }

  // Phase F Section 1/9 — SENT_CONFIRMED is the ONLY status that may
  // trigger baseline promotion or governed Memory. Any other status
  // (including REPORT_READY/DRAFT_CREATED/APPROVAL_REQUIRED/APPROVED/
  // SEND_ATTEMPTED/FAILED/BLOCKED) is a safe no-op here — never an error,
  // so calling this on an in-progress or terminal-but-unsent run is always
  // safe. Idempotent by construction: baselineStore.upsertVerified()
  // replaces (never appends to) the same dimension key, and
  // MemoryEngine.proposeMemory() already refreshes rather than duplicates
  // an identical existing value — so finalizing the same SENT_CONFIRMED
  // run twice does not corrupt or duplicate anything (Section 3/25).
  public finalizeRun(runId: string, tenantId: string, ownerId: string, requestId: string): RunFinalizationResult {
    const run = this.requireOwnedRun(runId, tenantId, ownerId, requestId);
    if (run.status !== 'SENT_CONFIRMED') {
      return { run, baselinePromoted: false, memoryProposed: false };
    }

    const current = run.evidence[0];
    let baselinePromoted = false;
    // Only a real, evidenced numeric price is ever promotable — a run
    // whose current price is truthfully unknown (null) has nothing valid
    // to compare a future run against, so no baseline write happens.
    if (current && current.price !== null) {
      try {
        this.baselineStore.upsertVerified({
          tenantId,
          ownerId,
          competitor: run.competitor,
          planName: current.planName,
          currency: current.currency,
          billingPeriod: current.billingPeriod,
          region: current.region,
          taxIncluded: current.taxIncluded,
          price: current.price,
          sourceUrl: current.sourceUrl,
          retrievedAt: current.retrievedAt,
        });
        baselinePromoted = true;
        this.audit('finalize.baseline_promoted', run, requestId, 'SUCCESS');
      } catch {
        // Section 10 — a bookkeeping failure here must never downgrade the
        // already-confirmed send; audited separately, run.status untouched.
        this.audit('finalize.baseline_failed', run, requestId, 'FAILED');
      }
    }

    let memoryProposed = false;
    if (this.memoryPort) {
      try {
        // Section 4 — a stable, generic delivery-channel preference only;
        // never the price itself, never raw evidence/report/page text.
        // sourceRef ties it to this run's real completed execution.
        this.memoryPort.proposeMemory({
          tenantId,
          ownerId,
          subject: 'user',
          predicate: 'prefers_delivery_channel_for_competitor_pricing_reports',
          value: 'email',
          sourceRef: run.executionId ?? run.runId,
        });
        memoryProposed = true;
        this.audit('finalize.memory_proposed', run, requestId, 'SUCCESS');
      } catch {
        this.audit('finalize.memory_failed', run, requestId, 'FAILED');
      }
    }

    this.audit('finalize.completed', run, requestId, 'SUCCESS');
    return { run, baselinePromoted, memoryProposed };
  }

  private toGmailComposePayload(draft: CompetitorPricingRunRecord['draftPayload']) {
    return { from: 'me', ...draft, attachments: [], threadId: null, replyToMessageId: null };
  }

  private audit(action: string, run: CompetitorPricingRunRecord, requestId: string, result: 'SUCCESS' | 'DENIED' | 'PENDING_APPROVAL' | 'FAILED'): void {
    if (!this.auditLogger) return;
    try {
      this.auditLogger.logEvent({
        actor: { type: 'user', id: run.ownerId },
        tenant_id: run.tenantId,
        action: `competitor_pricing_email.${action}`,
        resource: { type: 'CompetitorPricingRun', id: run.runId },
        result,
        request_id: requestId,
        details: { runId: run.runId, approvalId: run.approvalId, executionId: run.executionId },
      });
    } catch {
      /* audit logging is best-effort and must never affect the real outcome */
    }
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

// R10.2-C — the common completion lifecycle every successful capture
// analysis (TEXT/LINK/FILE) shares, extracted out of capture-processor.ts
// where it was independently duplicated three times (processText/
// processUrl/processPdf each ending in the identical merge-candidates ->
// upsert-canonical-candidates -> compute-next-status -> audit -> persist
// sequence). Deliberately NOT used by processAudioFallback — that path has
// a genuinely different (pre-existing, unchanged) completion shape: it
// always ends READY regardless of its PROPOSED candidate and never emits
// capture.analyzed/candidate.proposed audit events. Routing it through
// this finalizer would silently change its observable behavior, which
// R10.2-C's own governing rules forbid — see the R10.2-C completion
// report's "disclosed observation" section.
//
// Type-specific work (payload extraction, model analysis, candidate
// generation from the analysis) stays in capture-processor.ts and is
// handed to finalizeCaptureAnalysis() only once it is already computed —
// this module never calls a model, a browser, or a PDF parser itself.
import type { CaptureStore } from './capture.store.js';
import type { CaptureItem, CaptureStatus, WorkspaceCandidate } from './workspace.types.js';
import type { StructuredAnalysisResult, ModelProvenance } from './capture-processor.js';
import { CandidateStore, type UpsertCandidateInput } from './candidate.store.js';
import type { AuditLogger } from '../governance/audit.logger.js';

export interface FinalizeCaptureAnalysisDeps {
  store: CaptureStore;
  candidateStore?: CandidateStore;
  auditLogger?: AuditLogger;
}

export interface FinalizeCaptureAnalysisInput {
  item: CaptureItem;
  analysis: StructuredAnalysisResult;
  provenance?: ModelProvenance;
  freshCandidates: WorkspaceCandidate[];
  contentHash: string | undefined;
  // Used to build the capture.analyzed audit event's request_id, matching
  // each type's pre-existing naming (req_text_anz_/req_url_anz_/req_pdf_anz_)
  // — kept per-caller rather than collapsed into one generic value so audit
  // logs stay just as traceable to their originating capture type as before.
  auditRequestPrefix: string;
  // Fields specific to this capture type that belong in the
  // capture.analyzed audit event's own `details` (e.g. PDF's
  // totalChunks/processedChunks/truncated) — merged in alongside the
  // fields every type already shares (candidateCount/topics/modelProvider/
  // modelName). Optional; most types need nothing extra here.
  extraAnalyzedAuditDetails?: Record<string, unknown>;
  // Every field specific to this capture type (extractedTitle, sourceUrl,
  // pageTitle, chunks, hasText, ...) — merged into the final updateStatus
  // call alongside the fields every type shares (below). Never a field
  // already owned by this function (contentHash, extractedSummary, topics,
  // entities, dates, actionItems, candidates, candidateIds, model*,
  // suggestedAction) — those are computed once, here, identically for
  // every capture type.
  extraMetadata: Partial<CaptureItem['metadata']>;
}

// Phase 1 STEP 2 item H idempotency, moved verbatim from capture-processor.ts:
// a retry must not append duplicate PROPOSED candidates for content that
// hasn't changed.
export function mergeCandidates(existing: WorkspaceCandidate[] | undefined, fresh: WorkspaceCandidate[]): WorkspaceCandidate[] {
  const preserved = (existing || []).filter((c) => c.status !== 'PROPOSED');
  const identity = (c: WorkspaceCandidate): string => {
    const key = c.type === 'MEMORY' ? c.statement : c.type === 'KNOWLEDGE' ? c.summary : c.title;
    return `${c.type}:${key.trim().toLowerCase()}`;
  };
  const preservedIdentities = new Set(preserved.map(identity));
  const dedupedFresh = fresh.filter((c) => !preservedIdentities.has(identity(c)));
  return [...preserved, ...dedupedFresh];
}

// Phase 1 STEP 5, moved verbatim from capture-processor.ts: converts one
// understanding-derived WorkspaceCandidate into the canonical CandidateStore's
// typed, discriminated upsert input. sourceRefs are always something the
// model was genuinely shown, never fabricated.
export function toCanonicalUpsertInput(item: CaptureItem, wc: WorkspaceCandidate, contentHash: string | undefined): UpsertCandidateInput {
  const sourceRefs = wc.sourceRefs.length > 0
    ? wc.sourceRefs.map((r) => r.chunkId || `capture:${item.captureId}`)
    : [`capture:${item.captureId}`];
  const base = {
    tenantId: item.tenantId,
    principalId: item.ownerId,
    captureId: item.captureId,
    contentHash,
    sourceRefs,
    confidence: wc.confidence,
    title: wc.title,
    summary: wc.reason,
  };
  if (wc.type === 'TASK') {
    return { ...base, type: 'TASK', payload: { name: wc.title, objective: wc.description, dueAt: wc.dueDateCandidate ?? null } };
  }
  if (wc.type === 'CALENDAR') {
    return { ...base, type: 'CALENDAR', payload: { summary: wc.title, start: wc.startCandidate ?? null, end: wc.endCandidate ?? null, timezone: wc.timezone ?? null, attendees: [] } };
  }
  if (wc.type === 'MEMORY') {
    return { ...base, type: 'MEMORY', payload: { statement: wc.statement, category: wc.memoryType } };
  }
  return { ...base, type: 'KNOWLEDGE', payload: { title: wc.title, summary: wc.summary, sourceCaptureId: item.captureId } };
}

// Phase 1 STEP 5, moved verbatim from capture-processor.ts: upserts this
// pass's understanding-derived candidates into the durable CandidateStore
// (idempotent) and expires any still-PROPOSED canonical candidate for this
// capture whose contentHash no longer matches. A no-op returning the
// existing references unchanged when no CandidateStore is wired, so
// offline/unit-test harnesses are unaffected.
function upsertCanonicalCandidates(deps: FinalizeCaptureAnalysisDeps, item: CaptureItem, freshCandidates: WorkspaceCandidate[], contentHash: string | undefined): string[] {
  if (!deps.candidateStore) return item.metadata.candidateIds || [];
  deps.candidateStore.expireStaleForCapture(item.captureId, item.tenantId, item.ownerId, contentHash);

  const merged = new Set<string>(item.metadata.candidateIds || []);
  for (const wc of freshCandidates) {
    const record = deps.candidateStore.upsert(toCanonicalUpsertInput(item, wc, contentHash));
    merged.add(record.candidateId);
  }
  return [...merged];
}

// The one shared completion tail for TEXT/LINK/FILE capture analysis:
// merge candidates (idempotency) -> upsert into the canonical CandidateStore
// -> compute next status (NEEDS_REVIEW iff any candidate is still PROPOSED)
// -> audit capture.analyzed + one candidate.proposed per fresh candidate ->
// persist the final CaptureItem state -> return it (or the pre-update item,
// truthfully, if the store update itself failed to find/return a record —
// never fabricating a "successful" item the store didn't actually persist).
export function finalizeCaptureAnalysis(deps: FinalizeCaptureAnalysisDeps, input: FinalizeCaptureAnalysisInput): CaptureItem {
  const { item, analysis, provenance, freshCandidates, contentHash, auditRequestPrefix, extraAnalyzedAuditDetails, extraMetadata } = input;

  const candidates = mergeCandidates(item.metadata.candidates, freshCandidates);
  const candidateIds = upsertCanonicalCandidates(deps, item, freshCandidates, contentHash);
  const completedAt = new Date().toISOString();
  const nextStatus: CaptureStatus = candidates.some((c) => c.status === 'PROPOSED') ? 'NEEDS_REVIEW' : 'READY';

  if (deps.auditLogger) {
    deps.auditLogger.logEvent({
      actor: { type: 'system', id: 'capture-processor' },
      tenant_id: item.tenantId,
      action: 'capture.analyzed',
      resource: { type: 'CaptureItem', id: item.captureId },
      result: 'SUCCESS',
      request_id: `req_${auditRequestPrefix}_anz_${Date.now()}`,
      // NOTE: topics is intentionally NOT a common field here — the
      // pre-refactor PDF path never included it in this event's details
      // (TEXT/URL did), and R10.2-C preserves that exact difference rather
      // than silently "fixing" it. TEXT/URL pass topics via
      // extraAnalyzedAuditDetails below.
      details: { candidateCount: freshCandidates.length, modelProvider: provenance?.provider, modelName: provenance?.model, ...extraAnalyzedAuditDetails },
    });

    for (const cand of freshCandidates) {
      deps.auditLogger.logEvent({
        actor: { type: 'system', id: 'capture-processor' },
        tenant_id: item.tenantId,
        action: 'candidate.proposed',
        resource: { type: 'Candidate', id: cand.candidateId },
        result: 'SUCCESS',
        request_id: `req_cand_prop_${Date.now()}`,
        details: { captureId: item.captureId, candidateType: cand.type, title: cand.title },
      });
    }
  }

  const updated = deps.store.updateStatus(item.captureId, item.tenantId, item.ownerId, nextStatus, {
    processingStage: 'UNDERSTOOD',
    processingCompletedAt: completedAt,
    extractedSummary: analysis.summary,
    contentHash,
    ...extraMetadata,
    topics: analysis.topics,
    entities: analysis.entities,
    dates: analysis.dates,
    actionItems: analysis.actionItems,
    candidates,
    candidateIds,
    modelProvider: provenance?.provider,
    modelName: provenance?.model,
    modelRequestId: provenance?.requestId,
    modelLatencyMs: provenance?.latencyMs,
    suggestedAction: freshCandidates.length > 0 ? {
      type: freshCandidates[0].type,
      title: freshCandidates[0].title,
      detail: analysis.summary,
    } : undefined,
  });

  return updated ?? item;
}

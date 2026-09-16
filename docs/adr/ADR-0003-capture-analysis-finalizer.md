# ADR-0003 — capture-analysis-finalizer.ts extracted from CaptureProcessor

**Status:** Accepted
**Date:** 2026-09-16
**Related:** R10.2-C (Capture Processor Pipeline Refactoring)

## Decision

Extract the common capture-analysis completion lifecycle — shared identically by `CaptureProcessor.processText()`, `.processUrl()`, and `.processPdf()` — into a new standalone module, `src/workspace/capture-analysis-finalizer.ts`, exporting a pure function `finalizeCaptureAnalysis(deps, input)` plus two smaller pure helpers it depends on (`mergeCandidates`, `toCanonicalUpsertInput`).

`CaptureProcessor` itself keeps everything genuinely type-specific: URL retrieval via the Browser Agent, PDF extraction via `pdf-extractor.ts`, TEXT's direct pass-through, the multi-chunk `analyzeLargeDocument`/`analyzeContentWithModel` machinery, `buildCandidatesFromAnalysis`, the offline `fallbackStructuredAnalysis`, and all outer-level orchestration (`process()`'s Trust & Safety gate, `recordCaptureActivity`/`recordCaptureFailureActivity`, `updateStatusWithFailure`).

## Why this split, not a bigger one

The R10.2-C directive suggested (as one option) also splitting out `processText()`/`processUrl()`/`processPdf()` themselves into separate per-type modules (`process-text.ts`, `process-url.ts`, `process-pdf.ts`). This was considered and rejected for now:

- Each `process*()` method is tightly coupled to `CaptureProcessor`'s own constructor-injected dependencies (`this.aiService`, `this.browserService`, `this.storageProvider`, `this.store`) and to sibling private methods (`updateStatusWithFailure`, `analyzeContentWithModel`, `analyzeLargeDocument`, `buildCandidatesFromAnalysis`) that are themselves shared across all three paths — splitting the outer methods out would mean either passing the whole `CaptureProcessor` instance into each new file (no real boundary gained) or duplicating/re-injecting five-plus dependencies per file (more surface, not less).
- The actual, measurable duplication (§17: jscpd before 89 clones/862 duplicated lines → after 83 clones/753 duplicated lines, a real ~13% reduction) lived almost entirely in the completion tail, not in the retrieval/extraction logic — extracting the tail captures essentially all of the available win without the added fragmentation risk.
- The directive itself warns against "fragmentation into many tiny files without a clear boundary." `capture-analysis-finalizer.ts` has an unambiguous, single responsibility (the completion lifecycle); a `process-text.ts` etc. split would not have one as clean, since each would still need to reach back into `CaptureProcessor` for shared analysis machinery.

If a future round finds the type-specific `process*()` methods themselves have grown enough independent complexity to justify their own files, that decision should get its own ADR at that time — this one only commits to the finalizer boundary.

## What moved, and what stayed

**Moved to `capture-analysis-finalizer.ts` (verbatim, unchanged logic):**
- `mergeCandidates()` — idempotency merge (a retry must never duplicate an already-known PROPOSED candidate).
- `toCanonicalUpsertInput()` — WorkspaceCandidate → CandidateStore canonical payload mapping.
- The private `upsertCanonicalCandidates()` helper (now internal to the finalizer module, not exported — only `finalizeCaptureAnalysis` needs it).
- The full completion tail: merge candidates → upsert canonical candidates → compute `nextStatus` (`NEEDS_REVIEW` iff any candidate is still `PROPOSED`) → audit `capture.analyzed` + one `candidate.proposed` per fresh candidate → `CaptureStore.updateStatus()` → return the persisted item, or the pre-update item if the store update itself returned `null` (never fabricating success).

**Stayed in `capture-processor.ts`:**
- All type-specific retrieval/extraction (Browser Agent calls, `pdf-extractor.ts` calls, chunking decisions).
- `analyzeContentWithModel`/`analyzeLargeDocument`/`fallbackStructuredAnalysis`/`buildCandidatesFromAnalysis` — these build the `analysis`/`freshCandidates` inputs the finalizer consumes; they are analysis-and-generation logic, not completion-lifecycle logic.
- `process()`'s outer dispatch, Trust & Safety gate, and the two Activity-recording helpers — these wrap ALL FOUR capture types (including `processAudioFallback`, which deliberately does NOT use the finalizer — see below), so they belong to the orchestrator, not the finalizer.
- `updateStatusWithFailure()` — used by every failure branch across every `process*()` method, including ones that never reach the finalizer at all (e.g. `BROWSER_UNSAFE_URL`, `PDF_STORAGE_MISSING`).

## `processAudioFallback` deliberately does NOT use the finalizer

`processAudioFallback()` has a genuinely different completion shape from the other three: it always ends `READY` regardless of its one `PROPOSED` task candidate, and it never emits `capture.analyzed`/`candidate.proposed` audit events. Routing it through `finalizeCaptureAnalysis()` would have silently changed its observable behavior (its candidate would force `NEEDS_REVIEW`, and two new audit events would start firing that never fired before) — exactly what R10.2-C's governing rules forbid ("Do not silently 'improve' semantics unless backed by tests and documented"). This inconsistency is pre-existing, not introduced by this refactor, and is registered as **DEBT-0003** in `docs/TECHNICAL_DEBT_REGISTRY.md` rather than silently fixed.

## Dependency direction / architecture boundary

`capture-analysis-finalizer.ts` depends only on `capture.store.ts`, `workspace.types.ts`, `candidate.store.ts` (all Workspace-domain), and `audit.logger.ts` (governance, already a repo-wide cross-cutting dependency). It has zero dependency on any provider adapter (Calendar/Gmail/Browser), zero dependency on `model-gateway/`, and makes no network call of its own — enforced by `tests/capture_analysis_finalizer.test.ts` test 1 (a static source-text guard, mirroring the pattern `tests/google_modules_boundary.test.ts` and `tests/google_capability_execution_pipeline.test.ts` already established for the Google mutation pipeline).

## Idempotency contract (documented, not changed)

Retrying a capture (same content, same `contentHash`) must never duplicate a still-`PROPOSED` candidate — enforced by `mergeCandidates()`'s identity check (type + title/statement/summary, case-insensitive) and `CandidateStore.expireStaleForCapture()`'s contentHash-based staleness check, both moved verbatim. This contract is exercised directly in `tests/capture_analysis_finalizer.test.ts` tests 5–6, in addition to the pre-existing `tests/retry_failure_handling.test.ts` coverage (unaffected, still green).

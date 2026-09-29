# R23.7H-B1.5 — Creation Capability Reality Audit

**Date:** 2026-09-29
**Status:** Audit complete; implementation not started
**Governing product flow:** Understand → Create → Prepare → Approve → Act

## Executive conclusion

NAgex does not currently have a production-honest general-purpose creation suite. The repository has three materially different things that the UI presently blurs together:

1. **Real research and file/PDF understanding runtimes.** These use configured search/model providers and return grounded results, but research has no durable result history and the dedicated Analyze screen does not render the real capture result.
2. **A real, narrow competitor-pricing report workflow.** It retrieves evidence, composes a deterministic report, persists the run, freezes an email payload, requests approval, and can use the real Gmail execution path. It is not a generic “Report” creator and produces no downloadable document.
3. **A legacy creation domain whose output is mock SVG artwork.** Its API, IDs, file-backed history, retrieval, and variation lineage are live, but `generateCreation()` calls `generateMockImageSvg()` and no image model/provider. The returned record is marked `COMPLETED`, so it must not be exposed as real AI image generation.

Slides, video, general writing/document artifacts, and file-to-artifact creation are not implemented. UI labels, example prompts, static catalog entries, and planner output do not change that conclusion.

The minimum truthful first “Create with NAgex” surface is therefore:

- **Research** — only after a small wiring task connects the Home action to the real research/conversation evidence path and gives the result a durable artifact/reference.
- **Analyze a file** — only after a small wiring task makes the user upload real bytes through the canonical capture pipeline and renders the persisted capture analysis instead of hardcoded findings.
- **Competitor pricing report** — optionally exposed as a clearly narrow template/workflow, never as an unrestricted “Report” tile.

Image, Slides, Video, and generic Report must be omitted from B2. The mock image route should be explicitly isolated as legacy/demo until replaced by a real provider.

## Audit method and classification rules

This audit followed each claim from user surface to route, service, provider/model, persistence, returned artifact, and later retrieval. UI labels, documentation, fixtures, route names, and planner steps were not accepted as proof without a reachable execution path.

The required classifications are used exactly as follows:

- `REAL_WIRED`: a real request reaches real execution and produces a real result.
- `REAL_PARTIAL`: meaningful runtime exists, but truthful product exposure lacks an important part.
- `MOCK_DEMO`: output is primarily mock/static/synthetic.
- `CONTRACT_ONLY`: contracts exist without a usable execution path.
- `NOT_IMPLEMENTED`: no meaningful implementation exists.

## Repository evidence

### Active creation-domain plumbing

- `src/http/routes/creation.routes.ts:19-81` exposes generate, variation, list, and get-with-lineage routes.
- `src/app/create-nagex-application.ts:280-281` constructs `CreationStore` and `CreationService`; `src/server_web.ts:609` dispatches the routes. The domain is active, not dead registration.
- `src/creation/creation.store.ts:27-48` persists records through `FileRecordStore`, filters by tenant/owner, sorts history, and resolves lineage.
- `src/creation/creation.service.ts:6-33` implements `generateMockImageSvg()`. `generateCreation()` uses it at line 61 and then records the synthetic data URL as `COMPLETED`.
- `public/app.js:4934-5086` contains a reachable legacy Create view with generate, variation, retrieval, and history rendering.
- `tests/r17_final_completion.test.ts:63-137` verifies the active API and persistence plumbing, but asserts a `data:image/svg+xml` output; it does not prove a real image provider.

### Real research plumbing

- `src/http/routes/research.routes.ts:24-82` exposes `POST /api/v1/research`, forces live search, fails truthfully without verified sources, and invokes `AiService.research()` only with a valid evidence pack.
- `src/research/evidence-pack.service.ts:36-115` classifies freshness, calls the configured search provider, validates public URLs, deduplicates sources, and returns explicit unavailable/error states.
- `src/research/web-search.service.ts:9-65` selects Tavily or a configured HTTP provider and reports unavailable when neither is configured.
- `src/model-gateway/ai-service.ts:565-608` routes evidence-grounded research synthesis through the Model Gateway with `RESEARCH_SYNTHESIS`.
- `src/http/routes/conversation.routes.ts:182-227` also adds evidence packs to ordinary conversation when freshness requires it.
- `tests/r22_4_evidence_pack_web_search.test.ts:522-568` verifies that explicit research performs search and cannot report evidence-backed completion with zero evidence.

The dedicated research route returns a result but does not persist an artifact or provide list/get history. More importantly, Home research examples currently call the generic prompt/ambient path (`public/app.js:5228-5230`), while the ambient presentation contains hardcoded findings and source cards (`public/app.js`, `renderCanonicalUserPresentation`). That surface is not proof of the real `/api/v1/research` result.

### Real file/PDF understanding versus the legacy Analyze screen

- `src/http/routes/workspace.routes.ts:59-102` provides upload init/completion and accepts actual bytes; the simpler upload route at lines 104-144 rejects empty payloads.
- `src/workspace/quick-capture.service.ts:251+` stores binary captures and enters canonical processing.
- `src/workspace/capture-processor.ts:553-660` extracts PDF content, chunks large documents, calls model analysis, records provenance, and persists structured metadata.
- `tests/pdf_understanding.test.ts` exercises real `pdfjs-dist` fixtures, chunking, provider fallback/failure, provenance, candidates, and tenant isolation.

The legacy Analyze screen is disconnected from that truthful result:

- `public/app.js:5090-5199` initializes `/uploads/init` and `/uploads/complete` but does not send the selected file bytes in the completion request.
- The same handler then writes a fixed “0 critical issues, 3 operational key clauses, and 2 actionable recommendations” result directly into the DOM. It never reads the returned capture analysis.
- `tests/r17_final_completion.test.ts:269-305` checks only that init/complete return successfully; it does not validate real analysis output.

The underlying analysis runtime is real. The dedicated product surface is not.

### Narrow report workflow

- `src/agents/competitor-pricing-research.service.ts:25-73` performs real EvidencePack research with a real Browser fallback and model-based structured extraction.
- `src/agents/pricing-report-composer.ts` creates a deterministic, evidence-grounded pricing report with explicit unknown/limitation handling.
- `src/agents/competitor-pricing-run.service.ts:106-174` advances research to `REPORT_READY`, then creates and freezes a draft payload.
- `src/agents/competitor-pricing-run.store.ts:19-79` persists the run, evidence, report subject/body, approval, and execution references with tenant/owner isolation.
- `src/http/routes/competitor-pricing-agent.routes.ts:49-135` exposes start, get, and guarded continuation. Approval is not bypassed.
- `tests/r23_6e_real_e2e_agent.test.ts` covers evidence retrieval, legal transitions, report creation, payload freezing, approval, real send handling, and failure paths.

This is a real report-producing workflow, but only for competitor pricing. It has get-by-run-ID, not a general report history API; its report is persisted text, not PDF/DOCX or an exportable document.

### Negative evidence: unsupported claims

- Slides/presentations appear in `public/index.html:191-193`, i18n example text, and static catalog data (`src/http/routes/catalog.routes.ts:48`). No Slides provider, artifact service, presentation file generator, persistence model, or retrieval route exists.
- No video generation service, provider, artifact type, route, store, or consumer execution path exists.
- No general report/document/writing artifact type or generator exists. Chat/model text and plan summaries are responses, not reopenable creation artifacts.
- No file/data-to-new-artifact pipeline exists. File capture and understanding are real, but they produce capture analysis/candidates, not a generated report, deck, image, or document.

## Current creation architecture

### Legacy image creation path

```text
Legacy Create view
→ POST /api/v1/creations/generate
→ CreationService.generateCreation
→ generateMockImageSvg (local deterministic SVG; no provider)
→ CreationStore / FileRecordStore
→ CreationRecord with data URL, thumbnail, recipe, status COMPLETED
→ GET /api/v1/creations or GET /api/v1/creations/:id
```

### Research path

```text
Direct API or evidence-aware conversation
→ POST /api/v1/research (direct path)
→ EvidencePackService
→ Tavily or configured HTTP search provider
→ validated EvidencePack
→ AiService.research
→ Unified Model Router / configured model provider
→ response with answer + evidencePackId + sources
→ no durable research-result store or history endpoint
```

### File/PDF understanding path

```text
Canonical upload/capture surface
→ /api/v1/workspace/upload or upload init/complete with real bytes
→ QuickCaptureService
→ CaptureProcessor
→ PDF extraction/chunking or text analysis
→ Model Gateway structured understanding
→ CaptureStore metadata + candidates + Activity/Vault projection
→ Inbox/Vault/item retrieval
```

### Competitor-pricing report path

```text
Scenario API
→ competitor-pricing run
→ live search / browser evidence
→ model-based pricing extraction
→ deterministic report composition
→ durable run record
→ immutable email-ready draft
→ approval
→ canonical Gmail execution
→ persisted run/audit result
```

## Capability matrix

| Capability | Classification | Real provider/model | Persisted artifact/result | Retrieval/history | Truthful Home exposure now |
|---|---|---|---|---|---|
| General report creation | `REAL_PARTIAL` | Only in narrow competitor-pricing research/extraction | Pricing report text persisted in scenario run | Get by run ID; no general list/export | No generic Report tile |
| Slides/presentation creation | `NOT_IMPLEMENTED` | No | No | No | No |
| Image generation | `MOCK_DEMO` | No; local SVG function | Yes, but mock SVG is marked completed | List/get/lineage exist | No |
| Video generation | `NOT_IMPLEMENTED` | No | No | No | No |
| Research | `REAL_PARTIAL` | Yes, when search and model providers are configured | Direct result is transient | No result history/reopen | No, until small wiring/persistence gap closes |
| Analyze | `REAL_PARTIAL` | Canonical capture processor uses Model Gateway | Capture metadata/candidates are persisted | Inbox/Vault/item retrieval | No dedicated tile until UI uses real bytes/result |
| General writing/document generation | `NOT_IMPLEMENTED` | Chat text exists, artifact generation does not | No writing artifact | No | No |
| File/data-based creation | `NOT_IMPLEMENTED` | File understanding is real; creation is absent | Analysis only | Capture retrieval only | No creation claim |
| Creation history | `REAL_PARTIAL` | Provider-independent infrastructure | File-backed `CreationRecord` | List/get exists | Not while records are mock image output |
| Creation variations | `MOCK_DEMO` | No | Mock child SVG plus lineage | Get returns lineage | No |

## Candidate Home action assessment

### Report

- **Capability:** Report
- **Runtime status:** Narrow competitor-pricing report only; no generic report generator
- **Classification:** `REAL_PARTIAL`
- **Current entry point:** `POST /api/v1/agents/competitor-pricing-email`, then guarded `/continue`
- **Execution path:** run service → real evidence retrieval/extraction → deterministic pricing report
- **Persistence:** durable competitor-pricing run record
- **History support:** get by run ID only; no list, preview catalog, or export
- **Home quick-action eligible:** **NO** as “Report”; potentially YES later as “Competitor pricing report”
- **Recent Creations eligible:** **NO** under current generic creation model
- **Blocking gap:** generic claim mismatch, no artifact adapter/list/export, no normal consumer entry point
- **Recommended UI treatment:** omit generic Report; optionally add a narrowly named workflow after a small adapter task
- **Evidence:** pricing run service/store/routes and R23.6E tests cited above

### Slides

- **Runtime status:** labels/static catalog only
- **Classification:** `NOT_IMPLEMENTED`
- **Current entry point:** example prompt only
- **Execution path / persistence / history:** none
- **Home quick-action eligible:** **NO**
- **Recent Creations eligible:** **NO**
- **Blocking gap:** complete runtime/provider/artifact/export stack
- **Recommended UI treatment:** omit
- **Evidence:** no runtime found; static references only

### Image

- **Runtime status:** active mock SVG generator
- **Classification:** `MOCK_DEMO`
- **Current entry point:** legacy Create view and `/api/v1/creations/generate`
- **Execution path:** route → `CreationService` → `generateMockImageSvg`
- **Persistence:** file-backed creation records and embedded data URLs
- **History support:** list/get/lineage exists
- **Home quick-action eligible:** **NO**
- **Recent Creations eligible:** **NO** as real creations
- **Blocking gap:** real image provider, truthful failure/status semantics, real reference-image ingestion
- **Recommended UI treatment:** isolate as demo/legacy; never label as AI-generated production output
- **Evidence:** creation service/store/routes and R17 test

### Video

- **Runtime status:** absent
- **Classification:** `NOT_IMPLEMENTED`
- **Current entry point / execution / persistence / history:** none
- **Home quick-action eligible:** **NO**
- **Recent Creations eligible:** **NO**
- **Blocking gap:** entire capability
- **Recommended UI treatment:** omit
- **Evidence:** repository search found no video generation runtime

### Research

- **Runtime status:** real evidence retrieval and model synthesis; Home entry is not wired to it and output is not durable
- **Classification:** `REAL_PARTIAL`
- **Current entry point:** direct `/api/v1/research` or evidence-aware conversation
- **Execution path:** EvidencePack → real search provider → Model Gateway research synthesis
- **Persistence:** none for standalone research result
- **History support:** none
- **Home quick-action eligible:** **NO** today; **YES after small gap**
- **Recent Creations eligible:** **NO** today
- **Blocking gap:** connect Home to canonical path, persist artifact/reference, render actual answer/sources
- **Recommended UI treatment:** first B2 candidate after the small completion task
- **Evidence:** research route/services/tests cited above

### Analyze

- **Runtime status:** real capture analysis exists; dedicated screen is synthetic/disconnected
- **Classification:** `REAL_PARTIAL`
- **Current entry point:** truthful path is file capture/upload; legacy Analyze view is not truthful
- **Execution path:** upload bytes → QuickCaptureService → CaptureProcessor → Model Gateway → CaptureStore
- **Persistence:** capture, metadata, candidates, Vault/Activity projections
- **History support:** Inbox/Vault/item retrieval
- **Home quick-action eligible:** **NO** today; **YES after small gap**
- **Recent Creations eligible:** **NO** as a creation; analysis results may later be artifacts
- **Blocking gap:** send real bytes and render the returned persisted analysis rather than fixed DOM copy
- **Recommended UI treatment:** first B2 candidate after the small completion task
- **Evidence:** workspace routes, capture processor, PDF tests, and legacy UI cited above

## Mock, demo, legacy, duplicated, and disconnected findings

1. `generateMockImageSvg()` is the sole image output engine. Calling the API “real” because its persistence is real would be a false product claim.
2. Image reference IDs in the legacy UI are fixed strings; no reference image is loaded or processed by a model.
3. Variation changes the prompt/seed and produces another mock SVG; it is not real image editing.
4. The legacy Analyze screen fabricates a successful analysis narrative and counts after upload completion.
5. The ambient Research presentation includes fixed findings/source cards rather than the direct `/api/v1/research` response.
6. The presentation example and Google Slides catalog entry have no execution backend.
7. `PersonalHomeService` currently reads completed `CreationStore` records into “Prepared for you” (`src/home/personal-home.service.ts:402-420`). Because those records are mock SVG outputs, that integration is semantically unsafe until genuine creation records can be distinguished.
8. The generic creation route, real research route, capture analysis runtime, and competitor-pricing report use separate result models. There is no canonical cross-capability artifact contract today.

## Creation persistence and Recent Creations feasibility

`CreationRecord` currently supplies:

- title-like value: prompt only
- type: image-only enum (`TEXT_TO_IMAGE`, `IMAGE_EDIT`, `VARIATION`)
- timestamp: yes
- preview/thumbnail: yes, embedded mock SVG data URL
- status: only `COMPLETED` or `FAILED`
- source/reference: reference and parent IDs, but no general source provenance
- reopen: yes through get-by-ID and the legacy UI
- variation/history: yes for direct parent lineage

It does **not** support reports, research, analysis, slides, video, files, provider provenance, external asset lifecycle, safe download/export, or a truthful distinction between mock and provider output. Research has no result store; capture analysis belongs to CaptureStore; pricing reports belong to scenario runs.

**Recommendation: `IMPLEMENT_AFTER_SMALL_GAP`.** Do not build a second Home-only history. First define a small canonical artifact projection/adapter that references owning records rather than copying their content. Only genuine artifacts should enter it. The legacy mock creation records must be excluded or explicitly tagged `MOCK_DEMO` before any consumer “Recent Creations” surface ships.

Minimum fields for that projection:

```text
artifactId
owner/tenant
artifactType
title
consumerState
createdAt/updatedAt
owningDomain + sourceId
preview capability (not necessarily embedded data)
open target
provider/provenance summary for audit use
parent/root lineage when supported
```

## Relationship to PersonalHomeResponse

Choose **C: compose server-side into `PersonalHomeResponse`**, with the creation/artifact domain retaining ownership of its records.

Reasons:

- B1 established `PersonalHomeResponse` as the one semantic Home source.
- `PersonalHomeService` already receives `CreationStore` and server-side maps records, so composition is the existing direction rather than a new architecture.
- A dedicated client fetch would reintroduce desktop/mobile derivation, loading, dedupe, and failure differences.
- Home should receive a normalized, bounded `recentCreations` projection containing source identity and open target, not raw provider/domain records.
- Full artifact content/history remains in the owning endpoint; Home receives only its semantic summary.
- Source failure must remain isolated so creation history failure cannot blank personal state.

The current mapping of mock completed image records into `preparedForYou` should be removed or gated in B2. It must not be broadened.

## Minimum truthful “Create with NAgex”

### Recommended initial surface

Do not show six equal tiles. After the small runtime-completion tasks below, expose two grounded actions:

1. **Research a topic** — executes the real evidence-grounded route, shows actual sources/failure, persists an artifact reference, and can reopen it.
2. **Analyze a file** — uploads real bytes through the canonical capture pipeline and opens the actual persisted analysis/candidates.

Optionally expose **Competitor pricing report** as a specialized workflow if product scope warrants it. Its label and description must make the constraint explicit.

### Omit

- Report (generic)
- Slides
- Image
- Video
- Write document
- Turn file into presentation/report

No disabled “coming soon” grid is needed in the primary Home surface; unsupported capability density is not product completeness.

## Recommended R23.7H-B2 scope — Agentic Creation Home Integration

### Milestone objective

Make Home truthfully communicate that NAgex can understand and produce useful, reopenable work, without claiming unsupported media creation.

### In scope

1. Add a small canonical artifact projection owned by server-side domain adapters, not Home UI logic.
2. Wire **Research** Home action to the real evidence-grounded execution path.
3. Persist the resulting research answer/source references as a genuine artifact or durable owning-domain record.
4. Wire **Analyze a file** to the canonical real-byte upload/capture processor.
5. Render/open the real persisted analysis and remove or isolate the legacy hardcoded Analyze result.
6. Add a bounded `recentCreations` semantic projection to `PersonalHomeResponse`, composed server-side and deduplicated by source identity.
7. Render the same quick-action eligibility and recent-artifact model on desktop/mobile.
8. Fail truthfully for missing search/model/provider, unsupported file, OCR-needed PDF, and processing failure.
9. Exclude legacy mock image records from consumer Home.
10. Add tenant isolation, provenance, source-failure isolation, reopen, EN/KR, accessibility, and real-browser tests.

### Proposed acceptance criteria

- A Home Research request reaches actual search and Model Gateway synthesis; no fixed findings/sources appear.
- A Home Analyze request sends actual bytes and displays the stored capture analysis.
- Each successful result has one stable source identity and one reopen target.
- Recent Creations is server-composed into `PersonalHomeResponse`; desktop/mobile perform no independent derivation.
- Missing providers and failed sources produce `Unavailable`/`Failed`, never synthetic success.
- Mock SVG creations never appear as genuine Recent Creations.
- No generic Report, Slides, Image, or Video action is visible.

## Explicit exclusions

- No implementation in this audit.
- No B2 visual redesign.
- No image provider or repair of mock image generation.
- No Slides or presentation generation.
- No video generation.
- No general report/document generation.
- No new provider integration.
- No top-level navigation change.
- No second Home API or client-side creation aggregation.
- No R23.8P or R23.9C work.

## Final decision

R23.7H-B2 should not be “add six creation buttons.” It should be **Agentic Creation Home Integration for the two runtimes that are closest to production-honest exposure: Research and Analyze**, plus a small durable artifact projection and server-side Home composition. The current mock image creation domain is useful infrastructure evidence but not a shippable capability claim. The specialized pricing report is real but must remain narrowly named until a generic artifact/report contract exists.

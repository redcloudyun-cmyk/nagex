# R23.7C-A — Creation Runtime Architecture & Provider Audit

**Date:** 2026-09-29
**Status:** Audit Complete — Architecture Recommendation Only (Runtime Code Mutated: NO)
**Baseline Branch:** `r23.6m-mobile-voice-action`
**Baseline SHA:** `eacd46e73b3641310568c78c6a2466920a794cc8`
**Governing Product Vision:** NAgex Personal AI — Understand → Create → Review → Approve → Act

---

## 1. Executive Summary

NAgex has successfully established truthful consumer entry points for **Research** and **Analyze** on Personal Home (R23.7H-B2 certified). However, expanding NAgex into a complete Personal AI operating system requires supporting multi-format creation capabilities:
* **Report / General Document Creation**
* **Real Image Generation & Editing**
* **Slides / Presentation Composition**
* **Video Generation & Storyboarding**

This audit evaluates NAgex's codebase to design a **unified, coherent Creation Runtime Architecture**. Rather than building four disconnected, siloed creation tools ("Report App", "Image App", "Slides App", "Video App"), NAgex must adopt a single, provider-neutral Creation Runtime with domain-specific capability executors.

### Core Audit Conclusions
1. **`ArtifactStore` Invariant Preserved:** `ArtifactStore` must remain a lightweight `THIN_PROJECTION` index of completed user artifacts. It must **never** be turned into a document database, binary blob store, or provider execution engine.
2. **Legacy `CreationStore` Retirement Plan:** The legacy `CreationStore` (`src/creation/*`) currently generates synthetic MD5 SVG data URLs (`generateMockImageSvg`). It is excluded from Personal Home and should be gracefully deprecated and migrated to the unified Creation Runtime.
3. **Recommended First Creation Milestone:** **`Report` / `Document Creation` (R23.7C-B)**. It builds directly on NAgex's certified evidence synthesis (`AiService.research`), document extraction (`QuickCaptureService`), and personal context aggregation (`CurrentPersonalContextService`), offering immediate production value without third-party binary rendering dependencies.

---

## 2. Baseline Verification

* **Working Branch:** `r23.6m-mobile-voice-action` (Verified via `git branch --show-current`)
* **HEAD SHA:** `eacd46e73b3641310568c78c6a2466920a794cc8` (Verified via `git rev-parse HEAD`)
* **Pre-commit Checks:** All 1464 legacy unit tests, 72 regression tests, 28 browser matrix tests, and TypeScript build (`npm run build`) are 100% PASS on this baseline.

---

## 3. Existing Creation Architecture Audit

The repository currently contains three distinct, partially connected creation flows:

| Creation System | Source Path | Execution Mechanism | Underlying Persistence | Home Projection Status |
| :--- | :--- | :--- | :--- | :--- |
| **Research Synthesis** | `src/http/routes/research.routes.ts` | `EvidencePackService` + `AiService.research` | Evidence Pack Store + `ArtifactStore` | `REAL_PARTIAL` (Exposed & Certified) |
| **Analyze / File Capture** | `src/http/routes/workspace.routes.ts` & `capture.routes.ts` | `QuickCaptureService` + `AiService.understand` | Capture Store + `ArtifactStore` | `REAL_PARTIAL` (Exposed & Certified) |
| **Legacy Image Generation** | `src/creation/creation.service.ts` | Inline MD5 base64 SVG generator (`generateMockImageSvg`) | `CreationStore` (`NAGEX_CREATIONS_DIR`) | `MOCK_DEMO` (Excluded from Home) |

### Current Capability Truth Baseline
* **Research:** `REAL_PARTIAL` (Live evidence grounding, synthesized markdown output)
* **Analyze:** `REAL_PARTIAL` (Live document parsing, entity/action extraction)
* **Specialized Competitor Report:** `REAL_PARTIAL` (Fixed pricing comparison agent)
* **General Report / Document:** `NOT_IMPLEMENTED`
* **Real Image Generation & Editing:** `MOCK_DEMO` (Synthetic SVG mock)
* **Slides / Presentation:** `NOT_IMPLEMENTED`
* **Video Generation:** `NOT_IMPLEMENTED`
* **General Writing:** `NOT_IMPLEMENTED`

---

## 4. Existing Route Inventory

The repository contains the following HTTP endpoints related to creation, research, capture, and artifacts:

| Route | Method | Handler / Service | Input Payload | Model / Provider | Primary Persistence | Returned Artifact |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `/api/v1/research` | `POST` | `handleResearchRoutes` | `{ query }` | Nebius / OpenAI / Gemini (`RESEARCH_SYNTHESIS`) | Evidence Pack + `ArtifactStore` | Synthesized Markdown Answer |
| `/api/v1/workspace/upload` | `POST` | `handleWorkspaceRoutes` | `{ filename, mimeType, base64 }` | `QuickCaptureService` + `AiService.understand` | Capture Store + `ArtifactStore` | Extracted File Summary & Metadata |
| `/api/v1/creations/generate` | `POST` | `handleCreationRoutes` | `{ prompt, recipe }` | `generateMockImageSvg` (Internal MD5 SVG) | Legacy `CreationStore` | Mock Base64 SVG Data URL |
| `/api/v1/creations/:id/variation` | `POST` | `handleCreationRoutes` | `{ promptModifier, recipeOverrides }` | `generateMockImageSvg` (Internal MD5 SVG) | Legacy `CreationStore` | Mock Base64 SVG Variation |
| `/api/v1/creations` | `GET` | `handleCreationRoutes` | Query params (`limit`) | N/A | Legacy `CreationStore` | `CreationRecord[]` list |
| `/api/v1/creations/:id` | `GET` | `handleCreationRoutes` | Path param (`id`) | N/A | Legacy `CreationStore` | Single `CreationRecord` + Lineage |
| `/api/v1/artifacts` | `GET` | `handleArtifactRoutes` | Query params (`limit`) | N/A | `ArtifactStore` | `ArtifactRecord[]` list |
| `/api/v1/artifacts/:id` | `GET` | `handleArtifactRoutes` | Path param (`id`) | N/A | `ArtifactStore` | Single `ArtifactRecord` |

---

## 5. CreationStore vs ArtifactStore Audit

### Legacy `CreationStore` (`src/creation/creation.store.ts`)
* **Role:** Implemented in early R17 for image creation experiments.
* **Persisted Object:** `CreationRecord` containing `creationId`, `prompt`, `recipe` (`style`, `aspectRatio`, `guidanceScale`, `quality`, `seed`), `imageUrl` (inline base64 SVG string), `parentCreationId`, and `referenceImageId`.
* **Current Status:** Stores synthetic mock SVG data URIs. In R23.7H-B2, `CreationStore` was **excluded from Personal Home** (`personal-home.service.ts` line 412) to enforce truthfulness.
* **Retirement Strategy:** `CreationStore` will remain untouched for legacy API route compatibility, but new real creation capabilities will bypass it completely and write to the new Creation Runtime + `ArtifactStore`.

### `ArtifactStore` (`src/artifacts/artifact.store.ts`)
* **Role:** Certified in R23.7H-B2 as `THIN_PROJECTION`.
* **Persisted Object:** `ArtifactRecord` containing `artifactId`, `tenantId`, `ownerId`, `type` (`RESEARCH` \| `ANALYSIS`), `status` (`COMPLETED`), `title`, `preview` (first 500 chars), `sourceType`, `sourceId`, and `openTarget`.
* **Invariant:** `ArtifactStore` does **not** store raw execution state, binary assets, document contents, or provider request parameters. It acts purely as a durable index for consumer Home surfaces.

---

## 6. Current Model Routing Audit

Model routing is governed by `UnifiedModelRouter` (`src/model-gateway/unified-model-router.ts`) and `ModelRoutingPolicy` (`src/model-gateway/model-routing-policy.ts`).

### Current `ModelTaskKind` Vocabulary (`src/model-gateway/model-routing.types.ts`)
* `'CHAT'`
* `'RESEARCH_SYNTHESIS'`
* `'PLAN'`
* `'STRUCTURED_EXTRACTION'`
* `'DAILY_BRIEF'`
* `'MEETING_PREP'`
* `'PERSPECTIVE_ANALYSIS'`
* `'PERSPECTIVE_SYNTHESIS'`
* `'FORECAST_ANALYSIS'`
* `'FORECAST_SYNTHESIS'`

### Recommended Model Routing Taxonomy
For creation execution, NAgex should adopt a distinct **`CreationKind`** domain enum mapped internally to specialized `ModelTaskKind` entries:
```typescript
export type CreationKind =
  | 'DOCUMENT'
  | 'REPORT'
  | 'IMAGE'
  | 'PRESENTATION'
  | 'VIDEO';
```
This ensures high-level creation workflows (e.g. multi-step report drafting or image generation) can select optimal model providers (e.g. Gemini 1.5 Pro for 1M context document synthesis, FLUX/Imagen 3 for images) without overloading general chat routing.

---

## 7. Provider Capability Matrix (Code vs External API)

| Provider | NAgex Code Implementation Status (`src/model-gateway/providers.ts`) | Real Provider Platform Capabilities |
| :--- | :--- | :--- |
| **Gemini** | Text generation (`:generateContent`), System prompts, JSON mode (`responseMimeType: 'application/json'`). | Text (Gemini 1.5 Pro/Flash), Structured JSON, Multimodal (Images, Audio, PDF, Video inputs), Image Gen (Imagen 3 API), Google Slides API. |
| **OpenAI** | Text generation (`/v1/responses` endpoint). | Text (GPT-4o), Structured Outputs, Vision input, DALL-E 3 Image Generation, Sora Video (Preview). |
| **Nebius** | Text LLMs (`/v1/chat/completions`), JSON mode (`response_format: { type: 'json_object' }`). | High-throughput Text LLMs (Llama 3.3 70B, Qwen 2.5), FLUX / Stable Diffusion image generation endpoints. |

### Key Distinction:
* **Supported by NAgex Code:** Text generation, Structured JSON extraction, Evidence synthesis, Planning.
* **Supported by External Provider, NOT NAgex:** Native image generation, Multimodal binary inputs, PPTX/Slides rendering, Video generation.

---

## 8. External Provider Research & Standards

### 1. Document / Report Generation
* **Standard:** Markdown / HTML structure synthesized by LLMs (Gemini 1.5 Pro / Nebius Llama 3.3 70B) + PDF/DOCX rendering via established node libraries (`pdfkit`, `puppeteer`, `docx`).
* **Grounding Requirement:** Must integrate evidence pack citations (`[src_1]`) and personal context memory.

### 2. Image Generation & Editing
* **Options:** Nebius Studio FLUX.1 / Stable Diffusion XL API, Google Imagen 3 API, or OpenAI DALL-E 3 API.
* **Output Standard:** Binary PNG/JPEG objects stored in local/object storage (e.g. `LocalStorageProvider` / `S3StorageProvider`), with signed URLs served to the frontend.

### 3. Presentation / Slides Generation
* **Architecture:** Two-phase generation:
  1. LLM synthesizes structured slide deck JSON (slide title, bullet points, layout template, speaker notes).
  2. Slide composition engine renders JSON into PPTX (`pptxgenjs`) or HTML slide deck (Reveal.js / Marp).

### 4. Video Generation
* **Architecture:** Multi-stage pipeline:
  1. Script & Storyboard generation (LLM).
  2. Image asset generation per scene (FLUX / Imagen 3).
  3. Video clip synthesis (Sora / Runway / Luma API).
  4. Composition & Rendering.

---

## 9. Canonical Creation Contract Proposal

We propose a unified, provider-neutral **Creation Contract**:

```typescript
export interface CreationRequest {
  creationKind: 'DOCUMENT' | 'REPORT' | 'IMAGE' | 'PRESENTATION' | 'VIDEO';
  prompt: string;
  sourceRefs?: Array<{ type: 'EVIDENCE_PACK' | 'CAPTURE' | 'MEMORY' | 'ARTIFACT'; id: string }>;
  options?: {
    outputFormat?: 'MARKDOWN' | 'PDF' | 'HTML' | 'PNG' | 'PPTX' | 'MP4';
    style?: string;
    aspectRatio?: string;
    targetAudience?: string;
    language?: 'en' | 'ko';
  };
  tenantId: string;
  ownerId: string;
  requestId: string;
}

export interface CreationResult {
  creationId: string;
  creationKind: CreationKind;
  title: string;
  summary: string;
  canonicalContentRef: string; // File path or Object Storage Key
  mimeType: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}
```

---

## 10. Creation Lifecycle State Machine

Creation tasks can be asynchronous or long-running (especially video and complex presentations). We define a dedicated Creation Lifecycle:

```text
REQUESTED ──► PREPARING ──► GENERATING ──► RENDERING ──► COMPLETED
                 │               │              │
                 ▼               ▼              ▼
              FAILED          FAILED         FAILED
```

* **`REQUESTED`:** Request validated and queued.
* **`PREPARING`:** Resolving source documents, memories, and evidence packs.
* **`GENERATING`:** Calling provider models (LLM text, image gen API, etc.).
* **`RENDERING`:** Formatting into final media output (PDF, PPTX, MP4, PNG).
* **`COMPLETED`:** Output stored durably and indexed into `ArtifactStore`.
* **`FAILED`:** Truthful error recorded; no artifact projection created.

---

## 11. Artifact Ownership & Storage Architecture

```text
┌─────────────────────────────────────────────────────────────────┐
│                      Creation Runtime                           │
└────────────────────────────────┬────────────────────────────────┘
                                 │ Generates & Renders
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│               Durable Content Storage Layer                     │
│  - Documents:  storage/documents/{tenantId}/{id}.md (.pdf)     │
│  - Images:     storage/images/{tenantId}/{id}.png              │
│  - Slides:     storage/slides/{tenantId}/{id}.pptx             │
│  - Video:      storage/videos/{tenantId}/{id}.mp4              │
└────────────────────────────────┬────────────────────────────────┘
                                 │ Emits Lightweight Projection
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                  ArtifactStore (THIN_PROJECTION)                │
│  - artifactId, title, preview (500 chars), openTarget          │
└─────────────────────────────────────────────────────────────────┘
```

`ArtifactStore` strictly remains a **thin durable projection**. Canonical binary assets and full document texts live in dedicated domain storage paths managed by `LocalStorageProvider` / `S3StorageProvider`.

---

## 12. Reopen / Edit / Variation Semantics

To move beyond one-shot downloads, NAgex artifacts will support explicit lifecycle actions:

* **Open:** Retrieve canonical content from storage via `openTarget` URL.
* **Continue Editing (Document/Report):** Pass existing markdown + new instruction to LLM.
* **Create Variation (Image/Slides):** Pass parent artifact ID + modification prompt to create a child artifact linked by `parentArtifactId`.
* **Export:** Render markdown/JSON into PDF, DOCX, or PPTX on demand.

---

## 13. File Input & Context Ingestion Architecture

Existing ingestion pipeline (`QuickCaptureService`) supports:
* Text / Markdown files
* PDF files (via `pdfjs-dist`)
* HTML / Web snapshots
* JSON / Structured data

These captured files feed directly into `CreationRequest.sourceRefs`, allowing users to request: *"Create a summary report from my uploaded Q3_Financials.pdf"*.

---

## 14. Personal Context & Memory Integration

NAgex Personal AI differentiates itself by infusing personal memory into creation:
1. **Explicit Selection:** `CurrentPersonalContextService` supplies relevant memories (`MemoryRecord[]`) based on query relevance.
2. **Privacy Boundary:** Sensitive vault secrets and unrelated tenant memories are strictly excluded.
3. **Grounding:** User preferences (e.g. *"Prefer concise executive summaries in Korean"*) guide creation templates without hallucinating facts.

---

## 15. Human Approval & Security Boundary

* **Document / Image Generation:** Read-only creation within NAgex requires **NO approval** (low risk).
* **External Actions:** Sending a created report via Gmail, posting an image to Slack, or publishing externally requires **EXPLICIT HUMAN APPROVAL** via `ActionApprovalStore`.
* **Prompt Injection Protection:** Source files and web evidence are wrapped in strict delimiters (`"""`) with system prompts instructing the model never to execute embedded prompt injection instructions.
* **SSRF & Asset Security:** External image/video asset URLs are downloaded server-side through NAgex's certified SSRF protection before serving to clients.

---

## 16. Creation Capability Matrix & Roadmap

| Capability | Current NAgex State | Provider Readiness | Missing Repository Layer | Recommended Priority |
| :--- | :--- | :--- | :--- | :--- |
| **Report / Document** | `NOT_IMPLEMENTED` | **HIGH** (Gemini 1.5 Pro / Nebius 70B) | Document Composition Service & PDF exporter | **Priority 1 (Phase B)** |
| **Image** | `MOCK_DEMO` (SVG) | **HIGH** (Nebius FLUX / Imagen 3 API) | Image Provider Adapter & Storage integration | **Priority 2 (Phase C)** |
| **Slides / Presentation** | `NOT_IMPLEMENTED` | **MEDIUM** (LLM JSON + PPTX library) | Slide Layout Engine & PPTX Exporter | **Priority 3 (Phase D)** |
| **Video** | `NOT_IMPLEMENTED` | **LOW / MEDIUM** (Async Video API) | Multi-stage Video Render Orchestrator | **Priority 4 (Phase E)** |

---

## 17. Recommended Unified Architecture

We recommend adopting a **Unified Creation Runtime** pattern:

```text
                                CreationRuntime Orchestrator
                                            │
               ┌────────────────────────────┼────────────────────────────┐
               ▼                            ▼                            ▼
      DocumentExecutor                ImageExecutor             PresentationExecutor
 (Markdown / PDF / Report)         (FLUX / Imagen / PNG)           (Slide Deck / PPTX)
```

---

## 18. Migration Strategy

1. **Preserve B2 Baseline:** Keep `PersonalHomeResponse`, `recentCreations`, and `ArtifactStore` unchanged.
2. **Deprecate Legacy CreationStore:** Retain `src/creation/*` for legacy route compatibility; map new creation capabilities to `CreationRuntime`.
3. **Zero Breaking Changes:** Ensure `GET /api/v1/personal/home` continues to receive truthful `recentCreations` populated via `ArtifactStore.saveCompleted`.

---

## 19. Next Milestone Definition (R23.7C-B)

### Milestone Name: `R23.7C-B — General Document & Report Creation Runtime`
* **Scope:** Implement real, evidence-grounded Report and General Document creation.
* **Key Components:**
  1. `DocumentCreationService`: Synthesizes long-form structured markdown documents grounded in user prompt, selected files, and personal memory.
  2. `DocumentStorage`: Stores durable `.md` documents in `NAGEX_DOCUMENTS_DIR`.
  3. `ArtifactStore` Integration: Emits lightweight `RESEARCH` / `DOCUMENT` artifact projections to Recent Creations.
  4. Personal Home UI Integration: Wire "Create Report" action in Personal Home to open real document viewer/editor.

---

## 20. Risks & Open Questions

1. **Provider Quotas & Rate Limits:** Long-form document and image generation consume higher LLM token quotas. Fallback handling across Nebius, Gemini, and OpenAI must be strictly enforced.
2. **Async Rendering Timeouts:** Image and presentation generation can take 5–15 seconds. Frontend must support asynchronous state polling (`PREPARING` → `GENERATING` → `COMPLETED`).

---

## 21. Final Recommendation

NAgex should proceed immediately to **R23.7C-B (General Document & Report Creation Runtime)**. Building Report/Document creation first provides the highest immediate user value, leverages 100% of NAgex's existing certified evidence and memory infrastructure, and establishes the foundational `CreationRuntime` architecture for subsequent media formats (Image, Slides, Video).

---

## 22. Repository Safety & Status Summary

```text
R23.7C-A AUDIT = COMPLETE
RUNTIME CODE MUTATED = NO
```
* **Baseline Branch:** `r23.6m-mobile-voice-action`
* **Baseline SHA:** `eacd46e73b3641310568c78c6a2466920a794cc8`
* **Audit Document Created:** `docs/NAgex_R23_7C_A_Creation_Runtime_Architecture_Provider_Audit_20260929.md`
* **Pre-existing Unrelated Changes Preserved:** YES

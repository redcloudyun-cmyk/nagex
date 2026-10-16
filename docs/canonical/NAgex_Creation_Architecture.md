# NAgex Creation Architecture

**Canonical Domain:** Creation Runtime / Providers / Artifacts
**Status:** CANONICAL — current implemented baseline plus clearly marked future-compatible design
**Date:** 2026-09-29

## 1. Executive Decision

NAgex owns the **Creation OS / orchestration layer**. Specialized generation engines remain replaceable providers.

> NAgex owns the intelligence, context, orchestration, governance, artifact model, history, and user relationship. Specialized generation engines remain replaceable providers.

NAgex must neither rebuild every foundation generation model nor become a thin API wrapper.

## 2. Ownership Boundary

### NAgex owns

- user intent;
- personal memory/context;
- connected-data context;
- research/RAG inputs;
- creation planning;
- canonical creation specifications;
- permission/privacy/governance;
- provider routing;
- artifact identity;
- artifact storage contract;
- history and revisions;
- cross-artifact workflows;
- audit/provenance;
- result presentation.

### Providers own

- specialized inference/generation/rendering;
- provider-specific optimization;
- provider-specific temporary job/session mechanics;
- model-specific implementation details.

Provider IDs and temporary URLs are metadata, not canonical artifact identity.

## 3. Implemented Baseline

The R23.7C architecture establishes a provider-neutral creation foundation.

Implemented architecture includes:

- `CreationRuntime`;
- document creation through `DocumentExecutor`;
- task-aware model routing for document synthesis;
- canonical document artifact handling;
- thin ArtifactStore projection;
- provider-neutral creation specification types;
- `CreationProviderRouter`;
- `ImageProviderPort`;
- `PresentationProviderPort`;
- `VideoProviderPort`;
- capability-aware and availability-aware routing types;
- provider-independent artifact/revision concepts.

R23.7C-P records the provider architecture baseline as code/types committed and tested. Therefore it outranks earlier “Proposed” strategy documents when describing **current implemented architecture**.

## 4. ModelRouter vs CreationProviderRouter

```text
ModelRouter
→ selects a reasoning / synthesis model.

CreationProviderRouter
→ selects a specialized media creation / rendering provider.
```

These responsibilities must remain separate.

## 5. Canonical Creation Specs

All creation requests should converge toward provider-neutral canonical specifications rather than provider-specific request objects.

Current baseline includes a shared `CanonicalCreationSpecBase` and domain specifications for:

- image;
- presentation;
- video.

The common specification carries durable intent such as instructions, locale, constraints, brand context, user preferences, requested format, and metadata.

Domain specifications add media-specific intent.

## 6. Document Creation

Document/report creation is primarily a NAgex-native orchestration/runtime capability using external or local reasoning models as replaceable writing/synthesis engines.

Canonical flow:

```text
User Request
→ NAgex Context / Memory
→ CreationRuntime
→ DocumentExecutor
→ Model Gateway / Document Synthesis
→ Canonical Document Artifact
→ ArtifactStore Projection
→ History / Revision
```

Provider failure or empty generation is not success.

## 7. Image Creation

Target architecture:

```text
User Intent
→ Context / Memory
→ ImageCreationSpec
→ ImageExecutor
→ CreationProviderRouter
→ ImageProviderPort
→ Specialized Provider
→ Validate / Ingest Binary
→ Canonical Image Artifact
→ History / Revision
```

NAgex must own the resulting artifact, not merely retain a provider temporary URL.

Future provider families may include cloud and private/local execution. Exact provider/model names remain configuration-driven and must be verified when implemented.

## 8. Presentation Creation

NAgex should own:

- audience/goal;
- narrative;
- slide structure;
- content;
- visual intent;
- brand context;
- chart/image requirements;
- speaker notes where supported;
- canonical artifact/revision history.

Specialist presentation providers may render/export the presentation. A future native renderer remains possible without changing the canonical contract.

## 9. Video Creation

NAgex should own:

- narrative;
- storyboard;
- scene specifications;
- duration/aspect constraints;
- camera/visual intent;
- narration/dialogue intent;
- referenced assets;
- provider routing;
- canonical artifact lineage.

NAgex should not attempt to build a foundation video model merely to own the workflow.

### 9.1 Implemented video runtime (2026-10-16)

A video is an asynchronous, paid job at an outside service, so `VideoProviderPort` is a job port (price estimate, submit with an idempotency key, poll, optional cancel while queued, download), not a blocking call. The runtime lives in `VideoJobService`:

```text
Request → Price (provider quote or published price list, labelled) → Approval (the existing ActionApprovalStore, bound to provider, model,
prompt, length, shape, source image and price) → Submit once → Bounded polling (provider states only) → Download (outbound-URL policy)
→ Validate a real MP4 → Store (owner-checked) → Artifact (VIDEO) → Play / download
```

Rules: nothing is sent to a provider before the approval; a price that rose by more than 10 % needs a new approval; the same paid job is never started twice (identical active requests are one job, the approval is consumed once, the provider call carries the job's idempotency key, a restart mid-submission is resolved or reported as uncertain, never repeated blindly); `COMPLETED` exists only after a valid MP4 is stored; no progress percentage is shown because providers do not report one; a provider or price change is a new request with a new approval. Video is offered (router, capability brief, UI) only when a provider is really configured. Adapters: Higgsfield (REST, server-side key pair) and Google Veo (paid; offered only when the operator enables it). Evidence and live-run requirements: `docs/evidence/NAGEX_VIDEO_GENERATION_20261016.md`.

## 10. Provider Capability & Availability

Provider selection must be capability-aware and availability-aware.

Availability states include the baseline concepts:

- `UNCONFIGURED`
- `CONFIGURED`
- `AVAILABLE`
- `DEGRADED`
- `UNAVAILABLE`

Routing may consider required capability, requested format, privacy requirement, provider availability, explicit provider override when allowed, and fallback policy.

Routing decisions should remain explainable.

## 11. Privacy & Local Execution

Creation provider interfaces must not assume:

- public cloud only;
- API-key only;
- public URL only;
- one vendor SDK.

This preserves compatibility with local/private execution such as NVIDIA NIM, local diffusion pipelines, ComfyUI-style execution, or other future providers.

For `LOCAL_ONLY` or equivalent privacy requirements, cloud providers are ineligible unless policy explicitly changes.

## 12. NVIDIA / Nemotron Boundary

Nemotron is primarily a reasoning/multimodal model candidate and belongs behind `ModelRouter` when used that way.

NVIDIA NIM/local GPU may host compatible creation models and therefore can participate behind future Creation Provider adapters.

NIM itself is not a fixed image or video model.

Possible future pattern:

```text
Reference Asset
→ Nemotron / multimodal understanding
→ Canonical Creation Spec
→ Creation Provider (cloud or NVIDIA NIM/local)
→ Generated Artifact
→ Optional multimodal review
→ Canonical NAgex Artifact
```

Multimodal understanding must not be mislabeled as media generation.

## 13. Artifact Ownership & Revisions

Canonical artifact identity is NAgex-owned.

A revision may use a different provider from its parent without breaking lineage.

Provider-specific metadata may be retained for provenance/debugging but remains subordinate.

Cross-user and cross-tenant artifact/reference access is prohibited.

## 14. Failure Semantics

```text
COMPLETED   = real artifact produced and validated
PENDING     = provider work not yet complete
FAILED      = generation failed
UNAVAILABLE = provider/capability unavailable
```

`PENDING` is not success.

An empty/null generation is not success.

A provider error is not success.

A provider temporary URL is not the canonical artifact.

Content-policy rejection must not trigger provider-shopping intended to bypass safety controls.

## 15. Cross-Artifact Intelligence

A major NAgex differentiation is workflow continuity across artifact types:

```text
Research
→ Report
→ Presentation
→ Images
→ Video
→ Email / Meeting / Sharing / Follow-up
```

Memory, personal context, project context, brand context, and source provenance should carry forward where authorized.

## 16. JEV Relationship — EXPERIMENTAL

A future Fast Decision/JEV layer may help decide whether deep reasoning is necessary or rank already-eligible provider candidates.

It cannot:

- grant approval;
- override BLOCK;
- weaken privacy;
- access credentials;
- declare an invalid artifact successful.

Hard policy and deterministic validation remain authoritative.

## 17. Current vs Proposed

### Implemented / baseline

- provider-neutral Creation Runtime foundation;
- document runtime;
- canonical document artifacts/revisions;
- provider-neutral creation spec types;
- creation provider ports;
- deterministic CreationProviderRouter baseline.

### Next implementation direction

- real image runtime/providers;
- presentation runtime;
- video runtime;
- private/local provider adapters where justified;
- cross-artifact workflows.

### Experimental

- JEV-backed fast decision/evaluation;
- automatic provider quality scoring beyond verified deterministic signals.

## 18. Non-Negotiable Invariants

```text
REAL_ARTIFACT_REQUIRED = 1
PROVIDER_NEUTRAL_RUNTIME = 1
ARTIFACTSTORE_IS_NOT_RUNTIME = 1
PROVIDER_URL_IS_NOT_ARTIFACT = 1
FAILED_GENERATION_IS_NOT_SUCCESS = 1
EMPTY_GENERATION_IS_NOT_SUCCESS = 1
PENDING_IS_NOT_SUCCESS = 1
USER_OWNERSHIP_ENFORCED = 1
TENANT_BOUNDARY_ENFORCED = 1
CROSS_TENANT_REFERENCE_LEAK = 0
NVIDIA_NIM_COMPATIBILITY = REQUIRED
LOCAL_GPU_COMPATIBILITY = REQUIRED
```

## 19. Source Provenance

Consolidated from:

- `NAgex_Creation_Provider_Architecture_Strategy_20260929.md`
- `NAgex_R23_7C_A_Creation_Runtime_Architecture_Provider_Audit_20260929.md`
- `NAgex_R23_7C_P_Creation_Provider_Architecture_Baseline_20260929.md`
- `NAgex_R23_7H_B1_5_Creation_Capability_Reality_Audit_20260929.md`
- `NAgex_Fast_Decision_Reasoning_Creation_Architecture_20260929.md`
- current R23.7C-B implementation/closure evidence supplied for this project

The earlier strategy documents remain useful design provenance, but their “Proposed” status must not overwrite the implemented R23.7C baseline.

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

## 20. Product Builder - a website from a request, through four gates (2026-10-17)

A request such as "build me a customer management website with records, search and a dashboard, and put it online" is a **project**, not a chat answer and not a hidden agent run. It is a persistent, resumable state machine
(`src/product-builder/`) in which the person decides at four gates, each through the **same Approval Authority** every other consequential action uses (`ActionApprovalStore`; there is no second approval engine):

```text
REQUIREMENTS -> PLAN -> [Gate 1: PLAN] -> VISUAL MOCKUPS (generated images) -> DESIGN SPEC -> [Gate 2: DESIGN] -> BUILD PLAN -> [Gate 3: BUILD]
   -> IMPLEMENT (isolated workspace) -> TEST (isolated browser) -> PREVIEW (sandboxed) -> [Gate 4: DEPLOY] -> DEPLOY -> VERIFY -> DEPLOYED_VERIFIED
```

States: `REQUIREMENTS_DRAFT, PLAN_PENDING_APPROVAL, PLAN_APPROVED, MOCKUP_GENERATING, DESIGN_PENDING_APPROVAL, DESIGN_APPROVED, BUILD_PLAN_PENDING_APPROVAL, BUILD_APPROVED, IMPLEMENTING, TESTING, PREVIEW_READY,
DEPLOY_PENDING_APPROVAL, DEPLOYING, DEPLOYED_VERIFIED, FAILED, BLOCKED, CANCELLED`. Only the moves listed in `ALLOWED_TRANSITIONS` happen.

### 20.1 What a gate means

- **Bound to what the person saw.** Every approval is bound to the *version and hash* of the artifact (plan, design, build plan, deployment target + files). A changed artifact is a new version with a new approval; the old
  approval is withdrawn and can never be used; a stored artifact that no longer matches its approval is refused (`APPROVAL_STALE`) and a fresh approval is requested for what exists now. A change at a later gate may reach back to
  an earlier one; everything that depended on it is redone and every later approval is withdrawn.
- **Consumed once.** An approval is consumed against the CURRENT artifact when its gate is passed.
- **Nothing before its gate.** No image is requested before Gate 1, no file is written before Gate 3, nothing is sent to a host before Gate 4 (the service re-checks that the matching gate was passed for the *current* build
  plan / target before it acts).
- **Gate 3 freezes the scope:** plan and design versions, the isolated workspace and its limits, the permissions it grants and the ones it does not, the repair-attempt limit, and the statement that nothing is deployed in this step.
- **Gate 4 binds the deployment:** provider, account, application name, exposure, cost (the hosting plan's, which NAgex does not control), environment secrets (none), database (none), rollback, and the exact files.

### 20.2 Truthfulness

- **BLOCKED with the reason**, never a pretend result: a missing credential, an exhausted quota, a refusal, a missing sandbox or engine ends the step in `BLOCKED` with a typed reason (`CREDENTIAL | QUOTA | AUTHORIZATION | SANDBOX | ENGINE |
  CONFIGURATION | PERSON`). There are no placeholder pictures and no silent provider switch: when the image provider has no quota the person is told, and another **authorized** provider is used only if the person chooses it.
- **A model that is down or answers unusably does not end a project:** the step is BLOCKED and resumes; a change request whose redraft fails changes nothing (the earlier version and its approval stand).
- **Pictures are not made twice:** mockups already generated are kept when a later step fails.
- **"Deployed" means checked.** `DEPLOYED_VERIFIED` is reported only after the address answers, serves the build marker NAgex itself stamped into the page, and the product's own checks pass in an isolated browser at that address.
  A provider that accepted the files but serves something else ends the project `FAILED (DEPLOY_NOT_VERIFIED)`.
- **An uncertain deployment is never repeated.** A timeout, a server error after sending, or a restart while sending ends in `BLOCKED (DEPLOY_STATE_UNCERTAIN)`: the person checks the hosting account; NAgex does not send it a second time.
- **What is true is NAgex's to say, not the model's:** the engine, framework, data store and hosting target in the build plan are written by NAgex over whatever the planning model proposed.

### 20.3 Isolation (what is and is not claimed)

- Generated files are **data**. They are validated (plain relative paths, allowed extensions, count and size limits, self-contained: no external resources, no `eval`) and written all-or-nothing into an owner-scoped workspace. They are
  **never executed by Node on the NAgex host**: no install, no build, no shell.
- They run only inside Chromium's renderer, in an **isolated test run** whose network is limited to the product's own loopback origin (every other request is aborted and counted, and fails the run), with service workers, downloads and
  permissions off. This is a browser-level boundary, **not an operating-system or container sandbox**. A project that needs install/build/server code cannot be built here and would end in `BLOCKED (SANDBOX)`.
- The **preview** is served under a `sandbox` Content-Security-Policy (opaque origin: no access to NAgex pages, cookies or storage) from a **signed, short-lived link** bound to one owner and one workspace; the link is the only credential
  (the sandboxed frame sends no session). Tampered, expired, other-project and path-walking requests are 404.
- Projects, mockups, screenshots, previews and every action are **owner-scoped**: someone else's project is the same 404 as one that does not exist (including `preview-link`).

### 20.4 Ports and adapters (replaceable; none is the architecture)

| Port | Adapter today | Reality |
|---|---|---|
| `PlanningPort` | `GatewayPlanningAdapter` (Model Gateway; strict closed-shape validation, one repair, then fail closed) | live-verified with Gemini (see evidence) |
| `MockupPort` | `ImageProviderMockupAdapter` over the existing `ImageProviderPort` providers | real adapter; the dev Gemini key has no image quota - reported as such |
| `CodingEnginePort` | `GatewayStaticSiteEngine` - a **one-shot** static-site generator through the Gateway; writes files only | live-verified with Gemini. **Not** an autonomous coding agent. A proven agentic engine needs a container sandbox (Docker Desktop is installed on the dev host but its daemon is not running); until then it is not integrated |
| `SiteTesterPort` | `PlaywrightSiteTester` (isolated Chromium) | real |
| `DeployPort` | `VercelDeployAdapter` (official REST API: `POST /v13/deployments`, `GET /v13/deployments/{id}`) | implemented from the documentation; **no live deployment has been made** (no credential). Cloudflare Pages direct upload is not implemented: its file-hash/upload protocol is not in the API reference page and is not guessed |
| `DeployVerifierPort` | `HttpDeployVerifier` (public https only; marker + isolated checks) | real |

The Model Gateway gained two optional per-request controls for long generations: `maxOutputTokens` reaches Gemini (`generationConfig.maxOutputTokens`) and OpenAI (`max_output_tokens`), and `timeoutMs` (clamped to 1 s - 5 min, only for that request).

### 20.5 Surfaces

`/api/v1/product-builder/...` (capability, projects, gate decisions, deploy-request, resolve, cancel, owner-only pictures, signed sandboxed preview) and one Main card that shows only what the project record says: the stage rail, the artifact waiting for a
decision with the consequence of approving it, the reason something is blocked, the isolated test results with pictures per width, the sandboxed preview, the deployment target in the clear, and - only after verification - the address.
After a refresh or a restart the most recent unfinished project is brought back at the same step (a finished or cancelled one is not).

```text
PRODUCT_NOTHING_BEFORE_ITS_GATE = 1
PRODUCT_APPROVAL_BOUND_TO_VERSION_AND_HASH = 1
PRODUCT_APPROVAL_CONSUMED_ONCE = 1
PRODUCT_GENERATED_CODE_EXECUTED_ON_HOST = 0
PRODUCT_PLACEHOLDER_IMAGES = 0
PRODUCT_DEPLOYED_WITHOUT_VERIFICATION = 0
PRODUCT_UNCERTAIN_DEPLOY_RETRIED = 0
PRODUCT_CROSS_OWNER_ACCESS = 0
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

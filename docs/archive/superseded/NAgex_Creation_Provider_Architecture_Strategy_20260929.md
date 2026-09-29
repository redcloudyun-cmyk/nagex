# NAgex Creation Provider Architecture Strategy

**Project:** NAgex Personal AI
**Document Type:** Architecture / Product Strategy
**Status:** Proposed Architecture Baseline
**Date:** 2026-09-29
**Context:** R23.7C Creation Runtime
**Applies To:** Document, Image, Presentation, Video Creation

---

## 1. Executive Decision

NAgex should **not attempt to rebuild every specialized creation engine** used by leading document, image, presentation, and video products.

NAgex should also **not become a thin API wrapper** around those services.

The recommended architecture is a hybrid model:

> **NAgex owns the intelligence, context, orchestration, governance, artifact model, history, and user relationship. Specialized generation engines remain replaceable providers.**

In practical terms:

- NAgex owns **WHY / WHAT / WHEN / CONTEXT / GOVERNANCE**.
- External or local generation providers may perform specialized **HOW** operations.
- Provider-specific outputs are normalized into **NAgex canonical artifacts**.
- Users interact with NAgex rather than having to understand which underlying provider executed a task.

Core principle:

> **The model reasons. NAgex governs and executes.**

For Creation:

> **NAgex understands what should be created, prepares the context and specification, selects an appropriate execution engine, governs execution, and owns the resulting artifact lifecycle.**

---

## 2. Why Specialized Creation Services Perform Better

A specialized service is usually not just a foundation model behind a prompt box. Its value comes from a domain-specific pipeline.

```text
User Request
    ↓
Intent Understanding
    ↓
Content Planning
    ↓
Domain-Specific Specification
    ↓
Generation Model
    ↓
Layout / Composition / Rendering
    ↓
Artifact Model
    ↓
Editing / Revision
    ↓
Export / Delivery
```

A presentation service may additionally contain presentation outline planning, slide narrative construction, layout selection, theme systems, image selection/generation, chart generation, typography rules, page composition, editable object models, PPTX/PDF rendering, and revision workflows.

An image service may contain prompt expansion, reference-image conditioning, composition controls, style controls, aspect-ratio handling, editing/inpainting, variations, safety controls, and output optimization.

A video service may contain storyboarding, scene decomposition, shot planning, temporal generation, camera/motion controls, audio handling, scene continuity, rendering, and encoding.

Therefore, recreating the complete stack of every specialist product would create substantial cost and distract NAgex from its primary differentiation.

---

## 3. NAgex Competitive Boundary

NAgex should not define success as being a better graphic editor than Canva, a better presentation renderer than Gamma, or training a better image/video foundation model than major AI labs.

NAgex should instead own:

```text
Personal Context
+
Memory
+
Connected Data
+
Research / RAG
+
Intent Understanding
+
Creation Planning
+
Canonical Specifications
+
Provider Selection
+
Human Approval / Governance
+
Artifact Ownership
+
Revision History
+
Cross-Artifact Workflows
+
Real-World Actions
```

A specialized creation service primarily answers: **How do I create this type of content?**

NAgex should additionally answer: **What does this person need to create, why do they need it, what information should be used, which execution engine is appropriate, what should happen after creation, and what should be remembered?**

---

## 4. Strategic Architecture

```text
                     NAgex Personal AI
                            │
                 Personal Context / Memory
                            │
              Connected Data / Files / Apps
                            │
                  Research / RAG / Search
                            │
                    Intent Resolution
                            │
                     Creation Planner
                            │
                 Canonical Creation Spec
                            │
                    Creation Runtime
                            │
       ┌────────────────────┼────────────────────┐
       │                    │                    │
DocumentExecutor       ImageExecutor      PresentationExecutor
       │                    │                    │
DocumentRouter         ImageRouter        PresentationRouter
       │                    │                    │
LLM Providers       Image Providers      Specialist Providers
       │                    │                    │
       └────────────────────┼────────────────────┘
                            │
                     Artifact Layer
                            │
              History / Revision / Memory
                            │
                 Approval / Export / Action
```

Future extension:

```text
VideoExecutor
      ↓
VideoProviderRouter
      ↓
Video Generation Providers
      ↓
Canonical Video Artifact
```

**CreationRuntime must never be coupled to a single provider.**

---

## 5. Ownership Matrix

| Capability | NAgex Owns | Provider Can Supply |
|---|---:|---:|
| User intent understanding | Yes | No |
| Personal memory/context | Yes | No |
| Connected data context | Yes | No |
| Research/RAG grounding | Yes | Partial |
| Creation planning | Yes | Partial |
| Canonical Creation Spec | Yes | No |
| Provider routing | Yes | No |
| Approval/governance | Yes | No |
| Artifact identity | Yes | No |
| Creation history | Yes | No |
| Revision lineage | Yes | No |
| Cross-artifact workflows | Yes | No |
| Foundation LLM | No | Yes |
| Foundation image model | No | Yes |
| Foundation video model | No | Yes |
| Specialized presentation renderer | Hybrid | Yes |
| PDF/DOCX/PPTX rendering | Hybrid | Yes |
| Native editor | Progressive | Yes/External |

The provider is an execution dependency. It must not become NAgex's source of truth.

---

## 6. Canonical Creation Specification

The most important abstraction is not the provider API. It is the **NAgex Canonical Creation Specification**.

```text
CreationRequest
    ↓
CreationPlanner
    ↓
CanonicalCreationSpec
    ↓
Executor
    ↓
Provider Adapter
```

This prevents provider lock-in. A provider may disappear, increase prices, degrade quality, change APIs, become unavailable in a region, or be replaced by a better provider. NAgex should be able to change the execution engine without changing the user's mental model or losing artifact ownership.

---

## 7. Document Strategy

### Recommendation

**Build the document/report runtime primarily inside NAgex while using external LLMs as reasoning/writing engines.**

High-quality reports depend heavily on personal context, files, connected data, RAG, web research, source grounding, reasoning, structure, writing, citation, and revision. These are core Personal AI capabilities.

```text
NAgex Document Planner
        ↓
DocumentCreationSpec
        ↓
DocumentExecutor
        ↓
Task-Aware Model Router
        ↓
LLM Provider
        ↓
Validation
        ↓
Canonical Document Artifact
        ↓
Revision / Export / Action
```

NAgex should own document intent, source/context selection, outline/structure, grounding, provider routing, artifact persistence, revision history, citations/source references, permissions, and export workflow.

Providers should supply reasoning, drafting, rewriting, summarization, translation, and structured synthesis.

PDF and DOCX rendering can be added separately from the canonical document model.

---

## 8. Image Strategy

### Recommendation

**NAgex owns image intent/specification/artifact lifecycle. External image models perform generation.**

Do not build R23.7C-C as merely `prompt → Image API → PNG`.

```text
User Intent
    ↓
ImageCreationSpec
    ↓
ImageExecutor
    ↓
ImageProviderRouter
    ↓
Provider Adapter
    ↓
Image Generation Engine
    ↓
Canonical Image Artifact
```

Example `ImageCreationSpec` concepts:

```text
purpose
subject
composition
style
aspectRatio
brandContext
referenceImages
textRequirements
outputUsage
quality
locale
constraints
```

Potential architecture:

```text
ImageExecutor
    │
    ├── OpenAIImageAdapter
    ├── GoogleImageAdapter
    ├── OtherCloudImageAdapter
    └── LocalImageAdapter
```

NAgex owns the image and its context even when another model generated the pixels.

---

## 9. Presentation / Slides Strategy

### Recommendation

**Use a hybrid architecture.**

NAgex should own presentation objective, audience, source/context selection, narrative, outline, slide structure, factual grounding, speaker notes, image/chart intent, brand context, revision instructions, and artifact history.

A specialist service may initially own layout, theme rendering, visual composition, editable presentation rendering, and PPTX/PDF production.

```text
User Request
      ↓
NAgex Context Engine
      ↓
Presentation Planner
      ↓
Canonical PresentationSpec
      ↓
PresentationExecutor
      ↓
PresentationProviderRouter
      │
      ├── Specialist Provider Adapter
      ├── Design Platform Adapter
      └── Native NAgex Renderer
      ↓
Canonical Presentation Artifact
```

Conceptual `PresentationSpec`:

```text
title
purpose
audience
language
tone
brand
slides[]
    slideId
    objective
    title
    narrative
    bullets
    visualIntent
    imagePrompt
    chartSpec
    sourceRefs
speakerNotes
references
```

The canonical specification is more strategically valuable than binding NAgex directly to one presentation vendor. A native NAgex renderer can be developed progressively after the canonical model is stable.

---

## 10. Video Strategy

### Recommendation

**Do not attempt to build a video foundation model.**

A competitive video foundation model requires major investment in GPU infrastructure, training data, distributed training, inference infrastructure, temporal consistency, motion generation, audio/video synchronization, safety systems, and rendering infrastructure.

NAgex should instead build the intelligence above the generation model.

```text
User Intent
     ↓
Video Planner
     ↓
VideoCreationSpec
     ↓
Storyboard
     ↓
Scene Specifications
     ↓
VideoExecutor
     ↓
VideoProviderRouter
     ↓
External / Future Local Provider
     ↓
Scene Assets
     ↓
Composition
     ↓
Canonical Video Artifact
```

NAgex's differentiation should be the ability to determine why the video is needed, who it is for, which source material to use, what story should be told, what scenes are required, which assets already exist, which provider is appropriate, and how the output relates to other user artifacts.

---

## 11. Provider Routing

Creation providers should be selected dynamically.

Selection criteria may eventually include:

```text
capability
quality
cost
latency
availability
privacy
region
artifact type
requested format
user preference
organization policy
provider health
```

Provider selection must remain server-controlled and policy-aware. Users may optionally select a provider, but the architecture must not require them to understand provider details.

---

## 12. Provider Adapter Contract

Every external creation service should sit behind a NAgex adapter.

```text
PresentationProviderPort
        │
        ├── ProviderAAdapter
        ├── ProviderBAdapter
        └── NativeNAgexAdapter
```

Adapters should be responsible for authentication, provider request translation, capability mapping, provider response parsing, provider error normalization, provider-specific polling where necessary, rate-limit handling, and safe metadata extraction.

Adapters must **not** own user identity, NAgex artifact identity, NAgex memory, approval policy, tenant authorization, or canonical creation history.

---

## 13. Artifact Ownership

A fundamental NAgex rule:

> **The provider output is not the canonical NAgex artifact.**

```text
Provider Result
      ↓
Validation
      ↓
Normalization
      ↓
Canonical Artifact
      ↓
ArtifactStore / Domain Store
```

This enables provider replacement, revisions across providers, unified history, unified search, Memory integration, cross-artifact relationships, consistent permissions, and future migrations.

---

## 14. Cross-Artifact Intelligence

A document, presentation, image, and video should not be isolated features.

```text
Research
   ↓
Report
   ↓
Presentation
   ↓
Supporting Images
   ↓
Demo Video
   ↓
Email / Meeting / Sharing
```

All artifacts can share source material, project context, brand context, user preferences, factual grounding, and revision history.

Example user request:

> "Turn this report into a presentation and make a cover image."

NAgex should understand the relationship between all three artifacts.

A specialist point solution usually sees the artifact being generated. NAgex can see the **user's broader work context**.

---

## 15. Example: Investor Meeting

User:

> "Prepare me for tomorrow's investor meeting."

Target NAgex behavior:

```text
Calendar
+
Memory
+
Previous Documents
+
Email
+
Drive
+
Web Research
        ↓
Context Assembly
        ↓
Meeting Preparation Plan
        │
        ├── Meeting Brief
        ├── Updated Report
        ├── Investor Presentation
        └── Supporting Images
        ↓
User Review / Approval
        ↓
Artifact History
        ↓
Follow-up Actions
```

This is where Creation Runtime becomes part of Personal AI rather than a collection of generation buttons.

---

## 16. Build vs Buy Decision

The decision should be made by layer, not globally.

### Build inside NAgex when

The capability depends heavily on personal context, represents NAgex's source of truth, contains authorization/governance, determines provider selection, manages artifact identity or revision/history, connects multiple workflows, or creates durable product differentiation.

### Use external APIs when

The capability requires expensive foundation-model training, large specialized inference infrastructure, is rapidly improving outside NAgex, can be cleanly abstracted behind an adapter, does not need to become the source of truth, or would consume disproportionate engineering resources.

### Hybrid when

NAgex needs long-term control but external services currently provide substantially better execution. Presentation rendering is the clearest example.

---

## 17. Avoiding Vendor Lock-In

Never persist only provider-specific job IDs or URLs as the artifact.

Persist NAgex's canonical specification and normalized result.

```text
NAgex Artifact
- artifactId
- artifactType
- owner
- tenant/workspace
- creationSpec
- sourceRefs
- canonicalContent
- revisions
- providerExecutionMetadata
- createdAt
- updatedAt
```

Provider metadata is execution metadata, not artifact identity.

---

## 18. Truthful Execution

External APIs introduce additional failure states. Creation Runtime should distinguish states such as:

```text
REQUESTED
PLANNING
QUEUED
GENERATING
PROCESSING
SUCCEEDED
FAILED
UNAVAILABLE
CANCELLED
```

where appropriate.

Never translate timeout, provider queue, provider error, empty output, or failed export into successful NAgex creation.

Core invariant remains:

```text
FAKE_SUCCESS_PATHS = 0
```

---

## 19. Cost Architecture

Provider abstraction enables cost control. NAgex can eventually choose among fast/economical, premium, local, privacy-first, or specialized providers depending on task requirements.

This also supports future billing models such as NAgex-managed credits, BYOK/user provider credentials, local execution, and organization/provider policy without redesigning Creation Runtime.

Billing decisions should remain separate from canonical artifact architecture.

---

## 20. Privacy and Security

Provider routing must respect data sensitivity.

Before sending context externally, NAgex should know what information is required, which provider receives it, whether sensitive context is necessary, whether the provider is permitted, whether local execution is required, and whether user approval is necessary.

Creation provider adapters must receive only the minimum context necessary for execution.

Never expose unrelated Memory, unrelated Vault content, credentials, provider API keys, or cross-tenant data.

---

## 21. Recommended R23.7C Roadmap Adjustment

Before expanding Creation Runtime, establish this architecture as the baseline.

```text
R23.7C-A
Creation Runtime Architecture / Provider Audit
        ↓
R23.7C-B
Document & Report Creation Runtime
        ↓
R23.7C-P
Creation Provider Architecture Baseline
        ↓
R23.7C-C
Image Creation Runtime
        ↓
R23.7C-D
Presentation Creation Runtime
        ↓
R23.7C-E
Video Creation Runtime
```

`R23.7C-P` is an architectural checkpoint rather than a large implementation milestone. Its purpose is to prevent each executor from inventing incompatible provider abstractions.

---

## 22. Requirements for R23.7C-C Image

Before implementation, define:

```text
ImageCreationSpec
ImageProviderPort
ImageProviderCapabilities
ImageProviderRouter
ImageArtifact
ImageRevision semantics
```

Do not hardcode the first available image provider into `ImageExecutor`.

```text
ImageExecutor
      ↓
ImageProviderRouter
      ↓
ImageProviderPort
      │
      ├── Provider Adapter A
      ├── Provider Adapter B
      └── Future Local Adapter
```

---

## 23. Requirements for Presentation Runtime

Before implementation, define:

```text
PresentationSpec
PresentationProviderPort
PresentationProviderCapabilities
PresentationProviderRouter
PresentationArtifact
PresentationRevision semantics
```

Separate **CONTENT PLANNING** from **VISUAL RENDERING**.

NAgex should be capable of generating the same canonical presentation through different renderers.

---

## 24. Requirements for Video Runtime

Before implementation, define:

```text
VideoCreationSpec
StoryboardSpec
SceneSpec
VideoProviderPort
VideoProviderCapabilities
VideoProviderRouter
VideoArtifact
```

Do not make provider-specific concepts part of the canonical schema unless unavoidable.

---

## 25. Native NAgex Creation Engines

External provider usage does not prevent future native engines.

```text
Cloud Provider
Local Provider
Native NAgex Provider
```

can implement the same provider port.

This creates a migration path:

```text
External First
     ↓
Hybrid
     ↓
Native where strategically justified
```

NAgex should internalize capabilities selectively when provider cost becomes material, privacy demands it, external APIs constrain product UX, provider dependence becomes strategically risky, or NAgex can produce meaningfully differentiated results.

Native development should be justified by product economics and differentiation, not by a desire to eliminate all external dependencies.

---

## 26. Product UX Principle

Users should not experience NAgex as unrelated mini-apps for Chat, Images, Slides, Video, and Reports.

The preferred experience is:

> **Tell NAgex what you need. NAgex determines what needs to be created and coordinates the work.**

Creation tools can still exist as explicit entry points, but they should share the same Personal AI brain.

---

## 27. Strategic Differentiation

The target differentiation is not simply "NAgex generates images" or "NAgex makes presentations."

It is:

> **NAgex knows the user, understands the user's current context, creates the right artifacts using the right engines, remembers the results, revises them over time, and can continue into real actions.**

This allows NAgex to use world-class specialized engines without surrendering the product relationship.

---

## 28. Final Architecture Principle

```text
                    NAgex Owns
                         │
     ┌───────────────────┼───────────────────┐
     │                   │                   │
 Context             Intelligence        Governance
     │                   │                   │
     └───────────────────┼───────────────────┘
                         │
                  Creation Runtime
                         │
                Canonical Specs
                         │
                  Provider Ports
                         │
      ┌──────────────────┼──────────────────┐
      │                  │                  │
 Cloud APIs       Specialized APIs      Local Models
      │                  │                  │
      └──────────────────┼──────────────────┘
                         │
                 Provider Results
                         │
                    Validation
                         │
                Canonical Artifacts
                         │
        History / Memory / Revision / Action
```

**NAgex must own the orchestration layer and the artifact lifecycle. The generation engine should remain replaceable.**

---

## 29. Decision

**APPROVED STRATEGIC DIRECTION**

1. Keep R23.7C-B Document Runtime as a predominantly native NAgex orchestration/runtime capability.
2. Build R23.7C-C Image around a provider-neutral `ImageProviderPort`, not a single image API.
3. Build Presentation as a hybrid system: NAgex planning/specification + specialist rendering providers + future native renderer.
4. Build Video as orchestration/storyboarding/provider routing; do not attempt foundation-model development.
5. Maintain NAgex canonical artifacts independently of provider-specific job/result models.
6. Make Provider Routing a first-class Creation Runtime architecture.
7. Preserve provider replaceability across all Creation domains.
8. Treat Personal Context + Memory + Research + Governance + Artifact Lifecycle as the core NAgex moat.

---

## One-line Product Architecture

> **NAgex owns the brain, context, trust, orchestration, and artifacts; specialized providers supply replaceable generation engines.**

## Product Implication

> **Most creation tools create one artifact. NAgex should understand why the artifact is needed, create it with the best available engine, remember it, revise it, and continue the user's work.**

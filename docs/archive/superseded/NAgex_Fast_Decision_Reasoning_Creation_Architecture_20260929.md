# NAgex Fast Decision, Deep Reasoning & Creation Execution Architecture

**Project:** NAgex Personal AI
**Document Type:** Canonical Architecture / Development Baseline
**Status:** PROPOSED ARCHITECTURE BASELINE
**Date:** 2026-09-29
**Applies To:** Decision Runtime, Model Routing, Creation Runtime, Provider Routing, NVIDIA/Nemotron/NIM, Local Execution

---

## 1. Purpose

This document defines the canonical separation of responsibilities between:

1. **Fast Decision**
2. **Deep Reasoning**
3. **Specialized Creation / Execution**

The architecture is intended to prevent NAgex from sending every decision to a large language model, while preserving deep reasoning when it is genuinely required.

The central architecture is:

> **DECIDE → REASON → EXECUTE → EVALUATE**

NAgex remains the governing system across the entire loop.

---

## 2. Core Principle

NAgex must not confuse:

- decision
- reasoning
- generation
- execution
- governance

These are separate responsibilities.

Canonical principle:

> **JEV decides quickly where appropriate. Reasoning models think deeply where required. Specialized providers execute domain-specific generation. NAgex governs the whole lifecycle.**

NAgex owns:

- Personal Context
- Memory
- Current State
- Policy
- Permission
- Human Approval
- Routing policy
- Artifact identity
- History
- Audit
- Security
- Execution truth

External or local models are replaceable execution components.

---

## 3. Canonical Three-Level Intelligence Architecture

```text
                     NAgex Personal AI
                            │
               Context / Memory / State
                            │
                  Intent Understanding
                            │
          ┌─────────────────┴─────────────────┐
          │                                   │
 LEVEL 1 — FAST DECISION             LEVEL 2 — DEEP REASONING
          │                                   │
         JEV                              ModelRouter
          │                    ┌──────────────┼──────────────┐
          │                 OpenAI          Gemini       Nemotron
          │                                                │
          └────────────────────┬───────────────────────────┘
                               │
                       Creation Planner
                               │
                    Canonical Creation Spec
                               │
                LEVEL 3 — SPECIALIZED EXECUTION
                               │
                    CreationProviderRouter
                               │
             ┌─────────────────┼─────────────────┐
             │                 │                 │
        OpenAI Image      Google Image      NVIDIA NIM
                                                │
                                       FLUX / Qwen /
                                       Local Models
```

The three levels have different purposes.

### Level 1 — Fast Decision

JEV or an equivalent structured decision engine.

Target responsibilities:

- intent classification
- task classification
- complexity classification
- routing hints
- escalation decision
- retry decision
- result evaluation signal
- lightweight structured judgment

The objective is:

**low latency + low cost + deterministic structured output where possible**

### Level 2 — Deep Reasoning

Reasoning/model providers such as:

- OpenAI
- Gemini
- NVIDIA Nemotron
- future local reasoning models

Target responsibilities:

- research
- synthesis
- planning
- complex analysis
- document reasoning
- multimodal understanding
- creation planning
- difficult structured extraction
- agent reasoning

### Level 3 — Specialized Execution

Domain-specific generation/rendering providers.

Examples:

- OpenAI Image
- Google Gemini Image
- NVIDIA NIM image models
- FLUX
- Qwen Image
- Gamma
- Canva
- video-generation providers
- local GPU creation models

These providers create/render assets. They do not govern NAgex.

---

## 4. JEV Role

JEV is not another general-purpose LLM in this architecture.

Its strategic role is:

> **Fast Structured Decision Layer**

JEV should answer questions such as:

- What kind of task is this?
- Does this require deep reasoning?
- Does this require research?
- Which execution domain is required?
- Can this request follow a deterministic path?
- Should execution escalate?
- Should a failed result retry or escalate?
- Which routing candidates are appropriate?

Example:

```text
User:
"Create a hero image for this report."

            ↓

JEV

task                 IMAGE_CREATION
complexity           LOW
researchRequired     false
memoryRequired       limited
reasoningRequired    LOW
approvalRequired     false

            ↓

Image Creation Pipeline
```

A complex request may produce:

```text
User:
"Prepare tomorrow's investor meeting using current market data,
create a strategy report, a 10-slide deck, and supporting images."

            ↓

JEV

complexity           HIGH
researchRequired     true
memoryRequired       true
deepReasoning        true
documentRequired     true
presentationRequired true
imageRequired        true

            ↓

Deep Reasoning / Research
            ↓
Creation Planning
```

---

## 5. JEV Is Not an Authority

This is a mandatory security boundary.

JEV may produce a decision signal.

JEV may NOT override NAgex policy.

Required invariants:

```text
JEV_CAN_APPROVE = 0
JEV_CAN_OVERRIDE_BLOCK = 0
JEV_CAN_BYPASS_HUMAN_APPROVAL = 0
JEV_CAN_BYPASS_PERMISSION = 0
JEV_CAN_BYPASS_PRIVACY_POLICY = 0
```

Canonical order:

```text
Hard Policy
    ↓
Permission Authority
    ↓
JEV Decision Signal
    ↓
Deterministic Validation
    ↓
Model / Provider Router
    ↓
Human Approval when required
    ↓
Execution
```

Example:

```text
privacyRequirement = LOCAL_ONLY

JEV recommends Google Cloud with confidence 0.99

Result:

REJECT CLOUD ROUTE

→ select eligible local execution path
or
→ return UNAVAILABLE
```

JEV confidence is never authorization.

---

## 6. ModelRouter

ModelRouter answers:

> **Which reasoning/synthesis model should perform this cognitive task?**

Examples:

- OpenAI
- Gemini
- Nemotron
- future local LLM

ModelRouter responsibilities may include:

- capability
- reasoning quality requirement
- JSON/structured output support
- evidence grounding requirement
- latency
- availability
- privacy
- cost policy
- local execution policy

ModelRouter does not select Gamma, Canva, FLUX, or other specialized renderers merely because they use AI internally.

---

## 7. CreationProviderRouter

CreationProviderRouter answers:

> **Which specialized generation/rendering engine should execute this CreationSpec?**

Potential candidates:

```text
Image
 ├─ OpenAI Image
 ├─ Google Image
 ├─ NVIDIA NIM
 ├─ FLUX
 └─ Local GPU

Presentation
 ├─ Gamma
 ├─ Canva
 └─ Native NAgex Renderer

Video
 ├─ cloud video provider
 ├─ NVIDIA/local provider
 └─ future provider
```

CreationProviderRouter enforces:

- required capabilities
- availability
- requested format
- privacy
- provider policy
- explicit provider request
- local-only constraints

Business logic must remain provider-neutral.

---

## 8. JEV + CreationProviderRouter

JEV should eventually provide a **routing signal**, not directly invoke a provider.

Example conceptual result:

```json
{
  "routeClass": "NVIDIA_LOCAL",
  "confidence": 0.94,
  "reasonCodes": [
    "LOCAL_ONLY",
    "CAPABILITY_SATISFIED"
  ],
  "fallbackClass": null
}
```

Then:

```text
JEV Decision Signal
       ↓
CreationProviderRouter
       ↓
Deterministic Capability Validation
       ↓
Policy Validation
       ↓
Provider Availability Validation
       ↓
Selected Provider
```

This preserves speed without sacrificing correctness.

---

## 9. NVIDIA / Nemotron Strategic Position

NVIDIA must exist in NAgex in two distinct architectural roles.

### Role A — Nemotron as Reasoning / Multimodal Intelligence

Conceptually:

```text
NAgex
   ↓
ModelRouter
   ↓
Nemotron Adapter
   ↓
NVIDIA NIM / vLLM / SGLang / Ollama / compatible local runtime
```

Potential responsibilities:

- agent reasoning
- planning
- tool selection
- multimodal understanding
- document intelligence
- image understanding
- video understanding
- retrieval-related reasoning
- private/local inference

Nemotron should not automatically be treated as an image-generation provider.

Understanding and generation are separate capabilities.

### Role B — NVIDIA Ecosystem as Private Creation Execution

Conceptually:

```text
ImageExecutor
      ↓
CreationProviderRouter
      ↓
ImageProviderPort
      ↓
NvidiaNimImageAdapter
      ↓
Configured NVIDIA-compatible Generation Model
```

Possible execution models may include supported:

- FLUX-family models
- Qwen Image-family models
- future image-generation models

Model names must remain configuration-driven.

---

## 10. NVIDIA NIM Is an Execution Environment

NVIDIA NIM must not be modeled as if it were one fixed AI model.

Conceptually:

```text
NvidiaNimImageAdapter
       ↓
Configured NIM Endpoint
       ↓
Selected Generation Model
       ↓
Private / Local / Cloud GPU Infrastructure
```

Future adapters may include:

```text
NvidiaNimImageAdapter
NvidiaNimVideoAdapter
NvidiaNimMultimodalAdapter
```

Only add adapters when an actual product requirement exists.

Do not create speculative implementation solely for architectural symmetry.

---

## 11. Private Execution Plane

NAgex should preserve a first-class Private Execution Plane.

```text
                    NAgex
                      │
          ┌───────────┴───────────┐
          │                       │
   Cloud Execution         Private Execution
          │                       │
 OpenAI / Google          Nemotron / NIM
                          Local GPU Models
```

This becomes strategically important for:

- private personal data
- restricted organization data
- cost optimization
- offline/limited-connectivity operation
- provider independence
- predictable workloads
- local GPU utilization

A local NVIDIA GPU server should therefore be considered a potential NAgex execution node, not merely a development machine.

---

## 12. Privacy Routing

The architecture must support policy such as:

```text
STANDARD
RESTRICTED
LOCAL_ONLY
```

Example:

```text
Creation Request
      ↓
privacyRequirement = LOCAL_ONLY
      ↓
Hard Policy
      ↓
JEV Routing Signal
      ↓
CreationProviderRouter
      ↓
Cloud providers removed from candidate set
      ↓
NVIDIA NIM / Local GPU
      ↓
Canonical NAgex Artifact
```

If no compliant provider exists:

```text
UNAVAILABLE
```

Never silently violate privacy requirements.

---

## 13. Decision → Reason → Execute → Evaluate

The full canonical loop is:

```text
             ┌────────────────────────────┐
             │       User Request         │
             └─────────────┬──────────────┘
                           ↓
                     Context Assembly
                           ↓
                         DECIDE
                           │
                          JEV
                           │
              ┌────────────┴────────────┐
              │                         │
        Simple / Known             Complex / Uncertain
              │                         │
              │                       REASON
              │                         │
              │                ModelRouter
              │             OpenAI/Gemini/Nemotron
              │                         │
              └────────────┬────────────┘
                           ↓
                         EXECUTE
                           │
                 Specialized Provider
                           │
                           ↓
                         Result
                           │
                           ↓
                        EVALUATE
                           │
                          JEV
                           │
          ┌────────────────┼────────────────┐
          │                │                │
        ACCEPT           RETRY           ESCALATE
          │                │                │
          └────────────────┴────────────────┘
                           ↓
                    Canonical Artifact
```

This loop should become a reusable NAgex runtime pattern.

---

## 14. Evaluation Is Advisory

Post-execution JEV evaluation may help determine:

- result structurally complete?
- obvious requirement missed?
- retry appropriate?
- escalation required?
- deeper review required?

But JEV must not be used as an unsupported universal quality oracle.

For subjective outputs such as:

- visual beauty
- presentation aesthetics
- persuasive quality
- creative quality

JEV alone must not automatically claim correctness.

Evaluation should combine:

```text
Deterministic Validation
+
Capability-specific Validation
+
JEV Decision Signal
+
Deep Model Review when justified
+
Human Review when consequential
```

---

## 15. Escalation Architecture

The fast path must always permit escalation.

Conceptually:

```text
JEV
 ↓
confidence sufficient?
 │
 ├─ YES → deterministic path
 │
 └─ NO  → ModelRouter
             ↓
          Deep Reasoning
```

Other escalation triggers:

- conflicting context
- ambiguous user intent
- high-risk action
- insufficient evidence
- unsupported capability
- repeated provider failure
- low-confidence decision
- complex multimodal input

Do not force JEV to answer beyond its demonstrated capability.

---

## 16. Benchmark Requirement

JEV must earn its place through measurement.

Before making JEV a mandatory production dependency, compare it against:

1. existing deterministic routing
2. current lightweight model routing
3. deep reasoning model routing where applicable

Measure at minimum:

```text
decision latency
routing accuracy
false routing rate
unnecessary escalation rate
missed escalation rate
cost per decision
structured-output reliability
provider-selection correctness
policy-violation attempts blocked downstream
```

The benchmark should use representative NAgex workloads.

Do not conclude that JEV is faster or cheaper in production solely from architectural expectations.

---

## 17. JEV Decision Provider Abstraction

JEV should be introduced behind an abstraction.

Conceptually:

```text
DecisionProviderPort
       │
       ├── DeterministicDecisionProvider
       ├── JevDecisionProvider
       └── FutureDecisionProvider
```

This prevents NAgex from becoming dependent on JEV internals.

Potential request:

```text
DecisionRequest

intent
taskKind
contextSummary
requiredCapabilities
privacyRequirement
riskLevel
providerStates
localExecutionState
constraints
```

Potential response:

```text
DecisionSignal

decision
confidence
reasonCodes
recommendedRouteClass
escalationRequired
fallbackClass
```

Do not expose hidden provider internals directly to the UI.

---

## 18. Decision Signal Must Be Structured

Avoid free-form prose as the primary JEV contract.

Bad:

```text
"I think Google might be the best option because..."
```

Preferred:

```json
{
  "decision": "ROUTE",
  "recommendedRouteClass": "LOCAL_IMAGE",
  "confidence": 0.94,
  "reasonCodes": [
    "LOCAL_ONLY",
    "CAPABILITY_MATCH"
  ],
  "escalationRequired": false
}
```

Human-readable explanation can be derived separately.

Structured signals improve:

- determinism
- testability
- auditability
- latency
- routing safety

---

## 19. Canonical Creation Flow

The Creation architecture becomes:

```text
User Intent
    ↓
Context / Memory
    ↓
Fast Decision Layer
    ↓
Deep Reasoning when required
    ↓
Creation Planner
    ↓
Canonical Creation Spec
    ↓
CreationProviderRouter
    ↓
Provider Port
    ↓
Provider Adapter
    ↓
Provider Execution
    ↓
Deterministic Validation
    ↓
Optional JEV Evaluation
    ↓
Deep Review if escalated
    ↓
Canonical NAgex Artifact
    ↓
History / Revision / Memory / Action
```

Provider-specific payloads never become NAgex domain models.

---

## 20. Cross-Artifact Intelligence

The architecture should work across:

```text
Research
   ↓
Report
   ↓
Presentation
   ↓
Images
   ↓
Video
   ↓
External Action
```

Example:

> "Prepare me for tomorrow's investor meeting."

NAgex may:

1. inspect Calendar context
2. retrieve relevant Memory
3. retrieve connected documents
4. determine whether current research is required
5. use JEV to classify/escalate
6. use a reasoning model for market analysis
7. generate a report
8. derive PresentationCreationSpec
9. render a presentation
10. derive ImageCreationSpecs
11. generate supporting images
12. optionally generate a video/demo asset
13. retain artifact lineage
14. ask for approval before consequential external actions

The value is the connected workflow, not a single model.

---

## 21. Human Approval Boundary

Human Approval remains authoritative for consequential actions.

Examples may include:

- sending an email
- publishing externally
- sharing sensitive material
- booking
- payment
- destructive changes
- external state mutation

Neither JEV nor a deep reasoning model may bypass this gate.

Canonical rule:

```text
AI recommendation
       ≠
authorization
```

---

## 22. Failure Semantics

Never convert decision or provider uncertainty into fake success.

Required:

```text
FAILED != SUCCEEDED
PENDING != SUCCEEDED
PROVIDER_ACCEPTED != ARTIFACT_CREATED
LOW_CONFIDENCE != CONFIRMED
JEV_RECOMMENDED != AUTHORIZED
```

Preserve existing NAgex invariants:

```text
FAKE_SUCCESS_PATHS = 0
STALE_STATE_LEAK = 0
RAW_I18N_KEY_LEAK = 0
TECHNICAL_UI_LEAK = 0
CROSS_SESSION_LEAK = 0
RESET_SCOPE_LEAK = 0
```

Add architecture invariants:

```text
JEV_POLICY_BYPASS = 0
JEV_APPROVAL_BYPASS = 0
MODEL_PROVIDER_COUPLING = 0
CREATION_PROVIDER_COUPLING = 0
LOCAL_ONLY_CLOUD_LEAK = 0
```

---

## 23. Cost Architecture

The purpose of the fast decision layer is not simply to minimize model usage.

It should optimize total task execution.

Potential future routing factors:

```text
latency
cost
quality requirement
privacy
complexity
risk
provider availability
local GPU availability
required capabilities
user preference
```

Examples:

Simple classification:

```text
JEV
```

Complex strategy report:

```text
JEV
 ↓
Deep Reasoning Model
```

Private multimodal analysis:

```text
JEV
 ↓
Nemotron / Local Model
```

Image generation:

```text
JEV
 ↓
CreationProviderRouter
 ↓
Image Provider
```

---

## 24. Local GPU Strategy

Local GPU execution should be treated as a first-class future capability.

Potential architecture:

```text
NAgex Runtime
     ↓
Execution Route
     │
     ├─ Cloud
     │
     └─ Private
           ↓
       NVIDIA NIM
           ↓
       Local GPU
```

Possible local workloads:

- Nemotron reasoning
- embeddings
- reranking
- multimodal understanding
- image generation
- background processing
- privacy-sensitive workloads

Do not assume all workloads should be local.

Routing should remain workload-dependent.

---

## 25. Development Rule

Future NAgex features should ask these questions in order:

### Question 1

Can this decision be made deterministically?

If yes:

use deterministic logic.

### Question 2

If not, can the Fast Decision Layer make the structured decision reliably?

If yes:

use JEV.

### Question 3

Does the task require deeper reasoning?

If yes:

use ModelRouter.

### Question 4

Does the task require specialized generation/rendering?

If yes:

use CreationProviderRouter.

### Question 5

Is the action consequential?

If yes:

apply policy / permission / Human Approval before execution.

This prevents unnecessary model calls.

---

## 26. Anti-Patterns

Do NOT build:

```text
Every request
   ↓
Largest LLM
```

Do NOT build:

```text
JEV
 ↓
direct provider invocation
```

Do NOT build:

```text
Nemotron
 ↓
automatic permission
```

Do NOT build:

```text
Provider recommendation
 ↓
policy bypass
```

Do NOT build:

```text
OpenAI/Gemini/NVIDIA-specific business logic
inside CreationExecutor
```

Do NOT make JEV a single point of architectural lock-in.

---

## 27. Recommended Development Sequence

This architecture should not derail the current R23.7C Creation roadmap.

Recommended sequence:

```text
R23.7C-P
Creation Provider Architecture
        CLOSED

        ↓

R23.7C-C
Real Image Creation Runtime
        ↓
preserve JEV/NVIDIA/local compatibility

        ↓

JEV Decision Runtime POC
        ↓
benchmark against existing routing
        ↓
production decision

        ↓

R23.7C-D
Presentation Runtime

        ↓

R23.7C-E
Video Runtime
```

JEV should first prove measurable value.

Do not make R23.7C-C dependent on an unvalidated JEV implementation.

---

## 28. JEV POC Definition of Success

A future JEV POC should not be considered successful merely because it runs.

It should demonstrate measurable improvement in at least one meaningful dimension without unacceptable regression in others.

Candidate criteria:

- materially lower decision latency
- lower routing cost
- equal or better routing accuracy
- reliable structured output
- safe escalation behavior
- no policy bypass
- stable operation under realistic NAgex workload

The exact acceptance threshold should be established from baseline measurements.

Do not invent thresholds before baseline data exists.

---

## 29. Architectural Ownership Matrix

| Layer | NAgex Owns | Replaceable Component |
|---|---|---|
| Personal Context | Yes | No |
| Memory | Yes | No |
| Policy / Permission | Yes | No |
| Human Approval | Yes | No |
| Fast Decision Orchestration | Yes | JEV engine |
| Deep Reasoning Routing | Yes | OpenAI / Gemini / Nemotron / Local |
| Creation Planning | Yes | reasoning model may assist |
| Canonical Creation Specs | Yes | No |
| Creation Provider Routing | Yes | No |
| Image Generation | No | provider |
| Presentation Rendering | No / Hybrid | provider / native renderer |
| Video Generation | No | provider |
| Artifact Identity | Yes | No |
| Artifact History | Yes | No |
| Revision Lineage | Yes | No |
| Audit | Yes | No |
| External Execution Governance | Yes | execution provider |

---

## 30. Canonical Architecture Statement

The architecture should be summarized as:

> **NAgex governs. JEV decides quickly. Reasoning models think deeply. Specialized providers create and execute.**

And:

> **Fast decisions must not bypass policy. Deep reasoning must not become authorization. Provider execution must not become artifact ownership.**

And:

> **The model reasons. NAgex governs and executes.**

---

## 31. Long-Term Strategic Result

This architecture allows NAgex to evolve from a conventional LLM application into a layered Personal AI runtime:

```text
                   NAgex Personal AI OS

              Memory / Personal Context
                         │
                  Trust / Governance
                         │
                Decision Intelligence
                         │
             ┌───────────┴───────────┐
             │                       │
        Fast Decision           Deep Reasoning
             │                       │
            JEV              Cloud / Nemotron /
                                  Local Models
             └───────────┬───────────┘
                         │
                Creation / Action
                         │
          Cloud / NVIDIA / Local Execution
                         │
                 Canonical Artifacts
                         │
              History / Revision / Action
```

This makes provider choice an implementation detail while preserving NAgex as the user's persistent Personal AI.

---

## 32. Final Decision

Adopt this architecture as the development baseline.

1. Keep JEV separate from ModelRouter and CreationProviderRouter.
2. Introduce JEV only behind a replaceable DecisionProvider abstraction.
3. Never allow JEV to authorize or bypass policy.
4. Use Nemotron as a strategic reasoning/multimodal/private-model path.
5. Use NVIDIA NIM/local GPU as a strategic Private Execution Plane.
6. Keep cloud providers as first-class execution options.
7. Preserve deterministic routing where it is already sufficient.
8. Benchmark JEV before making it a mandatory production dependency.
9. Preserve canonical NAgex artifact ownership regardless of provider.
10. Use **DECIDE → REASON → EXECUTE → EVALUATE** as the reusable runtime pattern.

---

# Architecture Baseline

```text
NAgex owns:
Context
Memory
Policy
Trust
Routing
Approval
Artifacts
History
Execution Governance

JEV supplies:
Fast Structured Decision Signals

Reasoning Models supply:
Deep Reasoning
Research
Planning
Multimodal Understanding

Creation Providers supply:
Specialized Generation
Rendering
Media Execution

NVIDIA provides strategic paths for:
Nemotron reasoning
NIM deployment
Private inference
Local GPU execution

NAgex remains the governing system.
```

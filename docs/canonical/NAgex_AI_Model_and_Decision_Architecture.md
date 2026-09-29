# NAgex AI, Model & Decision Architecture

**Canonical Domain:** AI / Model Gateway / Routing / Fast Decision
**Status:** CANONICAL with explicitly marked EXPERIMENTAL sections
**Date:** 2026-09-29

## 1. Purpose

NAgex must remain provider-neutral and model-agnostic. Models are reasoning/synthesis infrastructure, not the product authority.

Canonical separation:

```text
Hard Policy / Privacy / Permission
              ↓
      Decision Runtime
              ↓
         ModelRouter
              ↓
 Reasoning / Synthesis Models
              ↓
   Domain Runtime / Planner
              ↓
Specialized Provider Router where needed
```

## 2. Model Gateway

Provider-specific model calls belong behind the Model Gateway.

Business/domain modules should not depend directly on raw provider SDKs when a gateway abstraction exists.

The gateway is responsible for normalized:

- provider/model capability;
- availability;
- invocation;
- structured output mode;
- errors;
- latency/usage metadata;
- provider failover where policy allows;
- observability.

Provider addition/removal should not require rewriting unrelated domain logic.

## 3. ModelRouter

`ModelRouter` answers:

> **Which reasoning/synthesis model should perform this task?**

Routing may consider:

- task kind;
- required capabilities;
- structured-output requirements;
- evidence grounding;
- multimodal needs;
- context length;
- latency preference;
- cost;
- provider availability;
- privacy/data-disclosure policy;
- explicit allowed override;
- failure recovery.

Provider/model names remain configuration-driven where practical.

## 4. Security Before Routing

Routing must not begin with “which model is cheapest/fastest?”

Canonical order:

```text
Data / Context
→ Classification
→ Disclosure / Minimization Policy
→ Permission / Privacy Constraints
→ Eligible Provider/Model Set
→ Routing
→ Invocation
```

Cost and latency optimization never override data protection.

Fallback must preserve or strengthen the original security/privacy constraints. Provider outage must never silently downgrade privacy.

## 5. Data Classes

The existing architecture uses sensitivity classes such as:

- `S0 — LOW`
- `S1 — PERSONAL`
- `S2 — SENSITIVE`
- `S3 — SECRET`

The canonical AI architecture must preserve the rule that highly protected data is not sent to a general remote model merely for convenience, cost, or availability. Exact classification/enforcement belongs to the canonical Trust/Privacy specification.

## 6. NVIDIA / Nemotron

NVIDIA has two distinct architectural roles and they must not be conflated.

### 6.1 Nemotron — reasoning / multimodal intelligence

Nemotron belongs behind `ModelRouter` when its verified capabilities fit the task. It may be used for reasoning, tool-oriented intelligence, multimodal understanding, or other verified model capabilities.

Do not classify “multimodal understanding” as media generation.

### 6.2 NVIDIA NIM / local GPU — execution environment

NVIDIA NIM is an inference/deployment environment, not one fixed model.

It can support a private/local execution plane for compatible models. A future NIM-backed image/video/multimodal adapter belongs behind the appropriate provider port rather than being hard-coded into business logic.

This preserves future local/private execution without changing canonical artifact ownership.

## 7. CreationProviderRouter Is Different

`ModelRouter` and `CreationProviderRouter` answer different questions.

```text
ModelRouter
→ Which reasoning/synthesis model should think/write/extract?

CreationProviderRouter
→ Which specialized creation engine should render/generate this artifact?
```

A specialized renderer is not selected by `ModelRouter` merely because it uses AI internally.

## 8. Fast Decision Layer

NAgex may use a fast structured decision layer to avoid unnecessary deep-model calls.

Potential decision outputs include:

- `ROUTE_DIRECT`
- `REASON_DEEP`
- `RESEARCH_REQUIRED`
- `ASK_USER`
- `REQUIRE_APPROVAL`
- `RETRY`
- `ESCALATE`
- `ACCEPT`

However, a fast decision component is advisory within the authority chain. It cannot weaken hard policy.

## 9. JEV Status — EXPERIMENTAL / OPTIONAL

JEV is not a required production dependency at this stage.

It is a candidate `DecisionProvider` for a future benchmarked Fast Decision Runtime.

Canonical invariants:

```text
JEV_CAN_APPROVE = 0
JEV_CAN_OVERRIDE_BLOCK = 0
JEV_CAN_BYPASS_HUMAN_APPROVAL = 0
JEV_CAN_BYPASS_PERMISSION = 0
JEV_CAN_BYPASS_PRIVACY_POLICY = 0
JEV_CAN_READ_CREDENTIALS = 0
```

If JEV fails, times out, or returns malformed output, deterministic policy remains authoritative.

Before promotion to a mandatory runtime dependency, JEV must be benchmarked against deterministic routing and an appropriate lightweight-model baseline for:

- p50/p95 latency;
- routing accuracy;
- false-direct rate;
- false-escalation rate;
- policy violations;
- approval bypass;
- cost per decision;
- fallback behavior;
- reproducibility where required.

## 10. DecisionProvider Abstraction

Target-compatible abstraction:

```text
DecisionProviderPort
├─ DeterministicDecisionProvider
├─ JevDecisionProvider          # optional / experimental
└─ FutureDecisionProvider
```

`DecisionSignal` should be structured data rather than free-form prose.

The architecture may preserve this extension point before JEV itself becomes a production requirement.

## 11. Three-Level Intelligence Model

```text
Level 1 — FAST DECISION
Classification / ranking / route / retry / escalate
Potential provider: deterministic logic, JEV POC

Level 2 — DEEP REASONING
Research / planning / analysis / writing / multimodal understanding
Providers: Gemini / OpenAI / Nemotron / other configured local or cloud models

Level 3 — SPECIALIZED EXECUTION
Image / slides / video / other domain generation
Providers: specialized cloud or private/local execution engines
```

NAgex governs all three levels.

## 12. Failure Semantics

A model/provider failure is not success.

Unknown security state fails closed.

Fallback cannot cross a forbidden privacy boundary.

Routing metadata may be observable for audit/developer use but should not force ordinary users to understand provider internals.

## 13. Non-Negotiable Invariants

```text
PROVIDER_NEUTRAL_MODEL_GATEWAY = 1
MODEL_IS_NOT_AUTHORITY = 1
MODEL_CAN_BYPASS_PERMISSION = 0
MODEL_CAN_BYPASS_APPROVAL = 0
JEV_IS_OPTIONAL = 1
PRIVACY_DOWNGRADE_ON_FAILURE = 0
S3_GENERAL_REMOTE_DISCLOSURE = 0
PROVIDER_SPECIFIC_BUSINESS_COUPLING = 0
```

## 14. Source Provenance

Consolidated from:

- `MODEL-ROUTER.md`
- `NAGEX_GLOBAL_MODEL_GATEWAY_ARCHITECTURE.md`
- `NAgex_LLM_Integration_Strategy_20260927.md`
- `NAGEX_MULTI_AI_PERSPECTIVE_AND_FORECAST_MODEL.md`
- `NAgex_Fast_Decision_Reasoning_Creation_Architecture_20260929.md`
- permission/credential directives where they constrain AI authority

The Fast Decision/JEV material remains partially proposed. This document therefore marks JEV as experimental rather than silently treating the proposal as implemented runtime behavior.

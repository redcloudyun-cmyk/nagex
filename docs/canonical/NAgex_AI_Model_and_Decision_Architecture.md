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

### 6.3 Nemotron through Nebius Token Factory — current runtime (ADR-0012)

Nemotron is reached through the existing `UnifiedModelRouter` / `ModelRoutingPolicy` as provider `nebius`
(model `nvidia/Nemotron-3_5-Lightning`, OpenAI-compatible chat completions). It is a **preferred** provider for `PLAN`,
`RESEARCH_SYNTHESIS` and `MEETING_PREP` only; every other TaskKind keeps its routing, and the existing providers are the fallback.
Its capabilities are evidence-graded and only chat completion is declared `SUPPORTED`; JSON-mode adherence, tool use, strict
structured extraction and long context are `UNVERIFIED` and are not relied on. Hidden provider reasoning is never an answer and is
never returned, logged or stored. A model that was routed a task has no execution authority: approval and execution stay separate.

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

### 10.1 As built for the device loop (2026-10-16)

`DecisionPort` (`src/device-control/decision-port.ts`) is the provider-independent seam for the browser/device loop; `JevDecisionPort` (`jev-decision.adapter.ts`) is one replaceable provider behind it. It is composed only when `NAGEX_JEV_DECISION_ENABLED=true` **and** `NAGEX_JEV_API_KEY` is set; otherwise the loop runs exactly as it does without it (every other suite runs with no advisor).

- **Where it sits.** After every hard check (domain allow-list, allowed actions, risk ceiling) and before the action - so it is only ever asked about an action that already passed them.
- **What it can say** (validated whole by `normalizeAdvice`; unknown or not-offered ids, out-of-range numbers, unknown enumerations and self-contradiction are rejected): `recommendedActionId` (PROCEED / OBSERVE / WAIT / HANDOFF), `actionConfidence`, a risk probability (the escalation flag is derived by NAgex from it, never taken from the provider), `retryRecommendation`, `completionAssessment`, `decisionReasonCode`.
- **What it can change - tightenings only:** hold a CLICK for the person's approval (the existing `forceApproval` path), or hand the task to the person (`BLOCKED_NEEDS_HUMAN`). No input can remove a check, approve, widen a domain or reach a credential. Advice about completion and about which action is better is recorded, not acted on.
- **Privacy.** A request can hold only enumerated kinds, counts and outcome categories; the goal, page text, typed text, control names and addresses have nowhere to go.
- **Failure.** Disabled, no credential, slow (2.5 s), down, malformed, not-offered, inconsistent - all are "no advice"; a provider that fails twice in a session is not asked again in that session.
- **Verified vs not.** The System One request/answer shape (`choice` / `noul` questions; `answers.<name>.{choice|probability|score, confidence}`) is the one the repository already uses (`model-gateway/jev-provider.ts`, recorded live benchmark). The four questions asked for this loop (action, risk, retry, completion) are NAgex's own and have **not** been run against the live service - no credential was available; tests use a simulated provider of that shape. Evidence: `docs/evidence/NAGEX_JEV_DECISION_PORT_20261016.md`.

### 10.2 Goal-driven adaptive execution (as built, 2026-10-17)

NAgex is goal-driven, not provider-driven: a failed route is not a failed goal, and a denied permission is not an invitation to find another route. The shared core is `src/adaptive/` (ADR-0017); it is a set of
pure decisions that the existing state machines call - there is no second agent runtime and no second approval engine.

```text
GOAL -> DISCOVER routes -> EVALUATE (hard eligibility) -> SELECT (deterministic order, optional advisory reorder)
     -> AUTHORIZE (approval when the terms change) -> EXECUTE -> VERIFY (at the goal level) -> RECOVER OR COMPLETE
```

- **Failure taxonomy** (12 classes): `AUTHENTICATION_FAILURE, PERMISSION_DENIED, QUOTA_EXHAUSTED, RATE_LIMITED, BILLING_REQUIRED, PROVIDER_UNAVAILABLE, TIMEOUT, INPUT_UNSUPPORTED, CAPABILITY_UNAVAILABLE,
  TRANSIENT_EXECUTION_FAILURE, VERIFICATION_FAILED, UNKNOWN_OUTCOME`. Retry and fallback differ by class: quota is not hammered; a rate limit is waited out only for a short documented delay, otherwise another route;
  an input a route cannot take needs a compatible route; **a denial is never routed around**; **an unknown outcome of a chargeable or consequential request is never duplicated or moved elsewhere until it is reconciled**.
- **Route candidates** carry verified facts only (authentication, availability, quota as NAgex has seen it, accepted input, cost - unknown stays unknown, who would receive the data, reliability evidence with a minimum
  sample size). There is no quality field: no output quality is measured, so none is claimed.
- **Hard eligibility precedes ranking** and cannot be overridden by a recommendation: not configured, credential rejected, unavailable, quota exhausted (with a cool-down), incompatible input, sensitivity above the
  route's ceiling (S0-S3), price above the authorized ceiling, already tried, failure class forbids moving.
- **Material terms.** Moving the work to a route where a new company receives the data, the processing location differs, the price is higher **or unknown**, or the route accepts less, needs the person's decision
  (an approval of tool `adaptive.route.switch`, bound to the exact route and its terms, used once). Only an explicit standing authorization may stand in, never for a location change, an unknown price or a reduced capability.
- **Bounded**: total attempts, switches and retries per route; running out is `ABORT`, never "try again".
- **Advisory ranking (JEV or any decision provider)**: after hard eligibility it may reorder the eligible set or recommend asking the person; it cannot add or admit a route, remove a check, approve, pay or reach a credential;
  an unoffered route, low confidence or malformed answer is no advice; a failing provider is given up on. The JEV request is one `choice` question in the System One shape the repository already uses (§10.1);
  it carries only enumerated kinds and buckets. **No live JEV call has been made** (no credential). Without an advisor the order is deterministic and the history says so.
- **Goal-level verification**: an image is accepted only if its bytes are a real, complete image of plausible size (type and dimensions read from the container; a claimed type is not trusted).
- **History**: every attempt (route, class, decision, who ranked, approval) is kept per goal, owner-scoped and without content.

```text
ADAPTIVE_SWITCH_ON_MATERIAL_TERMS_WITHOUT_APPROVAL = 0
DENIAL_ROUTED_AROUND = 0
UNKNOWN_OUTCOME_DUPLICATED = 0
ADVISOR_MAKES_INELIGIBLE_ROUTE_ELIGIBLE = 0
ADVISOR_APPROVES_OR_PAYS = 0
UNVERIFIED_PROVIDER_OUTPUT_ACCEPTED_AS_GOAL_COMPLETE = 0
```

First consumer: the Product Builder's mockups. Not yet routed through this layer: the Model Gateway's own provider failover (an operator-level, pre-configured choice), video jobs, deployment and the coding engine.

### 10.3 Answers about the current world (as built, 2026-10-17)

A fluent answer is not a trustworthy answer. For anything that changes over time - products and their newest models, releases, prices, availability, versions, laws, office holders, events - what a model remembers is
the *oldest* part of the truth. NAgex therefore decides **deterministically** whether current facts are needed, hands the model evidence as **untrusted data**, and **checks the answer afterwards** (ADR-0018).
The model proposes words; NAgex owns what is claimed as checked.

```text
question -> (read in its conversation: follow-up / correction) -> freshness by STRUCTURE
         -> Web switch -> search ROUTES (adaptive core, ADR-0017) -> pages read -> relevant sources only
         -> evidence fenced as data -> answer -> citations / language / denial checks -> honest note when unchecked
```

- **What needs checking is recognised by the structure of the question**, never by a product's name: a versioned name (a name and a number) that is compared, released, on sale or priced; release-status questions; live values (price, quote, weather, headline); policy and technology status. Korean is matched as Korean (JavaScript `\b` never matched Hangul). Text the person supplied (translate, proofread) is not a question about the world.
- **A turn is read in its conversation.** A follow-up keeps the subject of the earlier question. A challenge to an earlier answer is a *correction*: the disputed claim is found, checked against the evidence, corrected explicitly in the first sentence when the evidence shows the person is right, and the original question is answered again. Only earlier *questions* are ever sent to a search engine, never earlier answers.
- **The Web switch is real.** Off means nothing is looked up; the answer begins with one plain note, in the person's language, that nothing was checked.
- **Live values are never guessed.** A question whose whole answer is a live value and that could not be checked is not answered from memory; the reply says why and what the person can do. Other questions are answered from the model's knowledge **labelled as unverified**, and a model without sources **may not deny** that something exists or has been released (it is asked once more; a surviving denial is removed).
- **Evidence is data, not instructions.** It is fenced with a per-request random marker, listed by id, and includes the page's relevant passages, read under robots.txt and the outbound URL policy. A source that mentions none of the named products is not evidence. A citation to a source that was not retrieved never reaches the person. When part of the search could not be asked, the result is that failure - "nothing relevant" is never claimed.
- **Search is a goal with routes** (ADR-0017): failures are classified; a quota, a rejected credential or a long Retry-After is not retried or waited out in an interactive request and not asked again during its cool-down; another route is used only inside the operator's explicit configuration (`NAGEX_WEB_SEARCH_FALLBACKS`) and when its price is known to be zero; any other alternative stops the search and says it needs the person. A model may *name what to look up* (a natural question is a poor query); it never supplies facts.
- **What this layer does not claim.** `grounding` in the chat response says what an answer *rests on* (sources cited / retrieved but not cited / not verified live / not required) - retrieval-level facts. It never says a claim was verified. Claim-level verification, independent second-model review and conflicting-source investigation are the next layer and extend this path.

```text
CURRENT_FACT_STATED_AS_FACT_WITHOUT_EVIDENCE = 0
RELEASE_OR_EXISTENCE_DENIED_WITHOUT_EVIDENCE = 0
LIVE_VALUE_ANSWERED_FROM_MEMORY = 0
FABRICATED_CITATION_REACHES_THE_PERSON = 0
WEB_SWITCH_IGNORED = 0
RETRIEVED_TEXT_OBEYED_AS_INSTRUCTION = 0
CANNED_ENGLISH_FOR_A_NON_ENGLISH_REQUEST = 0
INTERNAL_INSTRUCTION_LABEL_IN_ANSWER = 0
RATE_LIMITED_ROUTE_ASKED_AGAIN_WITHIN_ITS_WAIT = 0
UNRELATED_PRODUCT_PAGE_OFFERED_AS_EVIDENCE = 0
```

Without an operator-configured web-search provider NAgex cannot ground answers in the real web: Product questions are then answered unverified, with the note. The keyless `open_knowledge` route (Wikipedia + OpenAlex) is encyclopedic, not general web search, and cannot reach a manufacturer's own pages.


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

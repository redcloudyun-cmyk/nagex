# NAGEX Global Model Gateway & Secure Multi-LLM Architecture

**Document ID:** NAGEX-GLOBAL-MODEL-GATEWAY  
**Version:** 1.0  
**Status:** MANDATORY ARCHITECTURE / PRODUCT INFRASTRUCTURE RULE  
**Scope:** Global model access, provider abstraction, secure disclosure, routing, capacity, billing, metering, fallback, BYOK, regional deployment, and large-scale growth.

---

## 1. Purpose

NAGEX is a global, general-purpose personalized AI Agent.

It must not depend on one model vendor, one country, one API account, one model family, or one billing strategy.

NAGEX must be able to use suitable models from the United States, Korea, China, and other regions whenever legally and operationally available.

Primary operating principle:

> **Best model for the task, not one model for everything.**

But this is subordinate to a stronger rule:

> **NAGEX chooses the best model only after determining what data that model is allowed to see.**

The Model Gateway exists to solve five problems together:

1. Secure model eligibility
2. Capability-based model selection
3. Cost / quality / latency optimization
4. Provider capacity and failover
5. Usage metering and commercial billing

---

## 2. Global-First Product Principle

NAGEX is developed in Korea, but must be architected as a global product from the beginning.

Do not design:

```text
Korean product
→ later translated for global use
```

Design:

```text
Global product
→ developed and initially operated from Korea
```

The architecture must assume:

- users in multiple countries
- multiple languages
- multiple time zones
- multiple currencies
- multiple privacy and regulatory regimes
- multiple cloud regions
- multiple model providers
- provider outages and rate limits
- regional model availability differences
- local/on-prem/private deployments
- enterprise customers with their own model contracts
- rapidly changing model economics

Globalization is an architectural requirement, not a translation project.

---

## 3. Provider-Neutral and Model-Agnostic

NAGEX must not hard-code its core runtime around one provider.

Potential model ecosystems include, but are not limited to:

### United States / Global

- OpenAI
- Anthropic
- Google Gemini
- xAI
- Microsoft/Azure-hosted models
- other globally available providers

### China

- Qwen family
- DeepSeek family
- GLM family
- other legally and operationally available Chinese models

### Korea

- HyperCLOVA X family
- EXAONE family
- other Korean commercial/open models

### Local / Private

- self-hosted open-weight LLMs
- private VPC inference
- enterprise-dedicated deployments
- on-prem inference
- specialized local models

These are examples, not a hard-coded support list.

Providers and models must be represented through registries and adapters.

---

## 4. Canonical Architecture

All application code should call the NAGEX Model Gateway, not individual provider APIs directly.

```text
User / Agent / Workflow
        ↓
Intent / Task Classification
        ↓
Data Classification
        ↓
Model Disclosure Policy
        ↓
Eligible Model Set
        ↓
Capability Matching
        ↓
Capacity Check
        ↓
Cost / Quality / Latency Routing
        ↓
NAGEX Model Gateway
        ↓
Provider Adapter
        ↓
Provider Project / Deployment / Account Pool
        ↓
LLM
```

No product feature should need to know provider-specific API details unless it is part of the provider adapter layer.

---

## 5. Security Before Model Selection

Routing must never begin with:

```text
Which model is cheapest?
```

It must begin with:

```text
What data is allowed to leave this trust boundary?
```

Required evaluation order:

```text
1. Security eligibility
2. Privacy eligibility
3. Region / compliance eligibility
4. Capability suitability
5. Quality
6. Cost
7. Latency
```

Cost optimization is important, but must never override data protection.

---

## 6. Mandatory Data Disclosure Gate

The Model Router must not receive unrestricted raw user data before a disclosure decision is made.

Canonical flow:

```text
User Request / Personal Context / Files / Memory
↓
Data Classification
↓
Sensitive Data Detection
↓
Minimization
↓
Redaction / Transformation
↓
Model Disclosure Policy
↓
Eligible Model Set
↓
Model Routing
↓
LLM Call
```

The disclosure layer must answer:

- Is remote model use permitted?
- Which providers are permitted?
- Which regions are permitted?
- Can raw content be used?
- Must data be redacted?
- Is derived-only information sufficient?
- Must a local/private model be used?
- Is this request prohibited from model disclosure entirely?

---

## 7. Relationship to Personal Data Architecture

This document MUST be applied together with:

`docs/NAGEX_PERSONAL_DATA_SYNC_ARCHITECTURE.md`

The existing sensitivity classes remain authoritative.

### S0 — LOW

General low-sensitivity content.

Possible policy:

```text
remote model permitted
```

subject to provider and regional rules.

### S1 — PERSONAL

Examples:

- ordinary personal messages
- work communication
- calendar context
- social communication

Preferred:

```text
minimize
→ redact where useful
→ send only task-required context
```

### S2 — SENSITIVE

Examples may include:

- financial details
- health information
- legal/confidential documents
- identity information
- private enterprise information
- highly sensitive personal communications

Default principle:

```text
RAW REMOTE DISCLOSURE = DENY
```

Preferred alternatives:

- local model
- approved private/VPC deployment
- on-prem inference
- derived-only information
- deterministic processing
- explicitly approved minimized disclosure

### S3 — SECRET

Examples:

- OTP
- passwords
- password-reset codes
- recovery codes
- private keys
- API keys
- authentication tokens
- security secrets

Mandatory:

```text
DO NOT SEND TO REMOTE LLM
DO NOT LOG
DO NOT USE AS ROUTING METADATA
DO NOT ANALYZE THROUGH GENERAL CLOUD MODELS
```

No router or model call may automatically downgrade S3.

---

## 8. Minimize Before Model Use

NAGEX should provide a model only the minimum data required to perform the task.

Bad:

```text
entire mailbox
→ LLM
```

Better:

```text
relevant messages
→ remove secrets and unrelated fields
→ extract task-required facts
→ LLM
```

For financial analysis, for example, a model may only need:

```text
date
merchant category
amount
currency
recurring status
historical baseline
```

It often does not need:

- card number
- account number
- identity number
- approval code
- authentication token

Raw data should not be sent merely because a provider offers a large context window.

---

## 9. Model Disclosure Policy

The model-disclosure decision should consider:

```text
dataSensitivity
taskType
modelLocation
provider
deploymentType
userPolicy
enterprisePolicy
regionPolicy
dataResidency
necessity
redactionState
```

Conceptual decision model:

```ts
interface ModelDisclosureDecision {
  allowed: boolean;
  reason: string;

  allowedProviders: string[];
  allowedRegions: string[];

  rawContentAllowed: boolean;
  redactionRequired: boolean;
  derivedOnly: boolean;

  localOnly: boolean;
}
```

The exact implementation may differ, but the policy boundary must exist before routing.

---

## 10. Model Capability Tiers

NAGEX should use different models for different levels of work.

### Low-Level

Suitable for:

- classification
- tagging
- simple extraction
- formatting
- simple summarization
- routing
- basic language transformation

Priority:

```text
low cost + low latency + sufficient quality
```

### Mid-Level

Suitable for:

- general writing
- ordinary question answering
- standard analysis
- moderate coding
- routine agent decisions

Priority:

```text
balanced cost / quality / latency
```

### High-Level

Suitable for:

- complex reasoning
- advanced coding
- architecture design
- difficult planning
- multi-document synthesis
- high-value deliverables
- difficult agent decisions

Priority:

```text
quality and reasoning first
within policy and cost limits
```

### Specialized

Examples:

- image generation
- video generation
- speech
- transcription
- OCR
- embedding
- reranking
- code-specialized models
- vision
- domain-specific inference

Specialized work should not be forced through a generic LLM when a better specialized model exists.

---

## 11. Multi-Model Orchestration

A single request may use multiple models.

Example:

```text
User Request
↓
Low-cost model: intent classification
↓
Deterministic preprocessing / retrieval
↓
High-level model: core reasoning
↓
Low-cost model: formatting
↓
Validator / critic model if justified
↓
Result
```

Benefits:

- lower cost
- faster latency
- better allocation of premium reasoning
- provider flexibility

Do not add model calls gratuitously. Every call should have a defined role and measurable value.

---

## 12. Model Registry

NAGEX should maintain a canonical Model Registry.

Conceptual profile:

```ts
interface ModelProfile {
  provider: string;
  modelId: string;
  modelFamily?: string;

  region?: string;
  deploymentType: 'PUBLIC_API' | 'PRIVATE_CLOUD' | 'VPC' | 'ON_PREM' | 'LOCAL';

  inputModalities: string[];
  outputModalities: string[];

  contextWindow?: number;

  supportsReasoning: boolean;
  supportsToolUse: boolean;
  supportsStructuredOutput: boolean;
  supportsVision: boolean;

  languageStrengths?: string[];
  capabilityTags: string[];

  costTier: string;
  latencyTier: string;
  qualityTier: string;

  allowedSensitivityMax: 'S0' | 'S1' | 'S2';
  status: 'ACTIVE' | 'DEGRADED' | 'DISABLED';
}
```

Do not scatter model names across business logic.

---

## 13. Provider Registry

The Provider Registry should describe provider-level properties such as:

- supported regions
- production projects/accounts
- credential references
- available models
- quota/capacity
- privacy mode
- data residency
- health
- rate limit state
- contract tier

The registry stores operational metadata, not raw credentials.

---

## 14. Provider Adapters

Each provider adapter should normalize provider-specific behavior.

Responsibilities may include:

- authentication
- request shape
- streaming
- tool/function calling
- structured output
- usage extraction
- token accounting
- provider error normalization
- retryable error classification
- provider request IDs

Provider-specific details must not leak into unrelated domains.

---

## 15. Provider Account and Credential Strategy

NAGEX must not depend on one personal API key.

Production should use provider mechanisms such as:

- organization-level accounts where supported
- production projects
- service accounts
- regional projects
- provider deployments
- credential pools
- dedicated/contracted capacity when justified

Example:

```text
Provider Organization
├─ nagex-prod-asia-a
├─ nagex-prod-asia-b
├─ nagex-prod-us
├─ nagex-batch
└─ nagex-internal
```

This is infrastructure pooling.

It does **not** mean creating one provider account per ordinary NAGEX user.

---

## 16. Secret Management

Provider credentials must never be broadly hard-coded.

Production credentials should live in an appropriate secret system.

Conceptual references:

```text
/providers/openai/prod-asia-a
/providers/google/prod-asia-a
/providers/anthropic/prod-us-a
/providers/qwen/prod-a
```

Secrets must not appear in:

- source control
- audit payloads
- error bodies
- analytics
- ordinary application logs

The Model Gateway should consume scoped credential references rather than expose raw keys to domain services.

---

## 17. Capacity Manager

User growth requires capacity management independent of model routing.

The Capacity Manager should track:

- provider health
- current rate limits
- token/request quotas
- concurrency
- queue depth
- recent latency
- recent failures
- regional availability
- contractual/dedicated capacity

The router must not select a deployment that cannot currently serve the request.

---

## 18. NAGEX Rate Limiting

NAGEX requires its own limits regardless of provider limits.

Conceptual hierarchy:

```text
Global platform limit
↓
Tenant limit
↓
User limit
↓
Plan / subscription limit
↓
Capability-specific limit
↓
Provider capacity limit
```

A small number of users or workflows must not exhaust the entire platform.

---

## 19. Queueing

Not every AI request should execute synchronously.

Suitable queue candidates include:

- large reports
- batch document processing
- media generation
- background research
- scheduled workflows
- non-interactive transformations

Interactive chat and approval flows should remain low latency when practical.

Queued work must retain safe references to:

- tenant/principal
- security classification
- disclosure decision
- model eligibility constraints

Do not place sensitive plaintext in queue metadata unnecessarily.

---

## 20. Fallback Routing

Fallback must be capability-safe and privacy-safe.

Bad:

```text
primary failed
→ send to any available model
```

Required:

```text
primary failed
↓
re-evaluate safe eligible model pool
↓
select compatible permitted fallback
```

Fallback must preserve:

- sensitivity rules
- region policy
- capability requirements
- output/tool requirements
- enterprise restrictions

If no safe fallback exists:

```text
FAIL CLOSED
```

Never relax privacy policy just to maintain availability.

---

## 21. Circuit Breaker

Repeated provider failures should temporarily remove a provider/deployment from active selection.

Conceptual states:

```text
CLOSED
OPEN
HALF_OPEN
```

The gateway should avoid flooding a failing provider and should probe recovery safely.

---

## 22. Region-Aware Routing

Global operation may require regional gateways or regional provider pools.

Examples:

```text
Asia
US
EU
Korea
Enterprise-private region
```

Region selection may depend on:

- tenant contract
- user policy
- regulatory policy
- latency
- data residency
- provider/model availability

Never route protected data to another jurisdiction solely because it is cheaper or currently has more capacity.

---

## 23. Local / Private Model Escalation

For sensitive tasks, NAGEX should be able to use:

```text
local model
private VPC model
on-prem model
dedicated enterprise deployment
```

rather than public model APIs.

Security policy may reduce the eligible model set to private/local inference only.

---

## 24. BYOK — Bring Your Own Key

NAGEX may support two access modes.

### Managed Mode

```text
User
→ NAGEX
→ NAGEX provider account
→ model
```

Best for ordinary users.

NAGEX manages:

- credentials
- capacity
- routing
- usage
- provider abstraction

### BYOK Mode

```text
User / Enterprise
→ NAGEX
→ customer provider credential / contract
→ model
```

Useful for:

- enterprise customers
- customers with dedicated provider pricing
- customers with private data agreements
- customers with region-specific deployments

BYOK should be optional, not required for mainstream users.

BYOK credentials must be securely stored and tenant-scoped.

---

## 25. Usage Metering

Every billable model operation should generate normalized usage.

Conceptual record:

```ts
interface ModelUsageRecord {
  tenantId: string;
  principalId: string;
  requestId: string;

  provider: string;
  modelId: string;
  deploymentId?: string;

  inputUnits?: number;
  outputUnits?: number;

  imageCount?: number;
  audioSeconds?: number;
  videoSeconds?: number;

  providerCost?: number;
  currency?: string;

  startedAt: string;
  completedAt: string;
}
```

Metering units vary by provider and modality.

Normalize usage without losing raw provider usage needed for reconciliation.

---

## 26. Cost Ledger

Provider billing and user billing are different concerns.

Conceptual flow:

```text
Provider Billing
↓
NAGEX Cost Ledger
↓
Usage Meter
↓
Credit / Billing Engine
↓
User Billing
```

NAGEX must be able to reconcile provider costs against internal usage.

---

## 27. User-Facing Billing Abstraction

Ordinary users should not have to understand every provider's token pricing.

NAGEX may expose:

```text
NAGEX Credits
```

or plan-based included usage.

This allows internal model substitutions without constantly changing the user-facing commercial model.

However:

- billing must not create surprise charges
- premium operations should be understandable
- enterprise users may require detailed usage exports

---

## 28. Cost-Aware Routing

The router should optimize cost only within the safe eligible set.

Conceptual objective:

```text
minimize expected cost
subject to:
- security policy
- quality floor
- latency objective
- capability requirements
- availability
```

Do not simply pick the cheapest model.

Repeated poor output or retries can make a cheap model more expensive overall.

---

## 29. Quality-Aware Escalation

NAGEX should support model escalation.

Example:

```text
low-cost model
↓
confidence insufficient / task complexity high
↓
mid-tier model
↓
still insufficient
↓
high-level model
```

Escalation criteria should be explicit where practical.

Avoid uncontrolled model-call loops.

---

## 30. Provider Account Scaling

### Early Scale

```text
NAGEX Gateway
→ one or a few production projects per provider
→ metering
→ rate limiter
```

### Growth Scale

```text
multi-project
multi-region
credential pool
queueing
capacity manager
fallback
circuit breaker
cost optimizer
```

### Large Scale

```text
regional gateways
enterprise capacity contracts
dedicated throughput
reserved capacity
multi-provider balancing
self-hosted/private inference
enterprise BYOK pools
```

The application layer should not need to be redesigned as scale grows.

Capacity should expand behind the Gateway abstraction.

---

## 31. Multi-Tenant Isolation

Provider infrastructure may be shared, but logical usage must remain tenant-safe.

NAGEX should track:

```text
tenant
principal
request
policy decision
model
provider
cost
usage
```

Never allow:

- cross-tenant prompt/context leakage
- unsafe shared caches
- cross-tenant logs with raw payloads
- one tenant consuming another tenant's reserved capacity

---

## 32. Caching

Caching may reduce cost but must obey data classification.

Possible safe candidates:

- public model metadata
- public research transformations
- deterministic S0 outputs where appropriate

Sensitive prompts/results must not enter shared caches unless isolation and policy explicitly permit it.

Cache keys must not expose protected information.

---

## 33. Logging and Observability

Operational telemetry should prefer:

- request ID
- provider
- model
- timing
- token/unit counts
- safe error code
- sensitivity class
- routing decision ID

Avoid logging:

- raw private prompts
- private documents
- OTPs
- API keys
- authentication secrets
- decrypted protected payloads

Debugging must not become a privacy bypass.

---

## 34. Auditability

For sensitive or high-value model operations, NAGEX should be able to answer:

- Which policy decided disclosure?
- Which model/provider was selected?
- Why was it eligible?
- Was redaction applied?
- Which region/deployment handled it?
- What usage/cost was recorded?
- Was fallback used?

Do not store raw protected content merely to support auditability.

Store safe decision metadata.

---

## 35. Model Routing Decision Record

Conceptual structure:

```ts
interface ModelRoutingDecision {
  requestId: string;

  sensitivity: string;
  disclosurePolicyId: string;

  eligibleModels: string[];
  rejectedModels?: Array<{
    modelId: string;
    reason: string;
  }>;

  selectedModel: string;
  selectedProvider: string;
  selectedRegion?: string;

  reasonCodes: string[];
  fallbackUsed: boolean;
}
```

Exact implementation may differ.

---

## 36. Failure Semantics

NAGEX must fail closed when model-security state is uncertain.

Examples:

```text
classification unavailable
→ do not send raw protected data

redaction failure
→ do not send original data as fallback

credential unavailable
→ do not use an unapproved credential

region eligibility unknown
→ deny protected remote call

no permitted model available
→ ask user / defer / local-only
```

Never implement:

```text
security check failed
→ call default provider anyway
```

---

## 37. No Plaintext Emergency Fallback

An outage must not create a privacy downgrade.

Prohibited:

```text
private model unavailable
→ send sensitive raw content to public API
```

Availability problems must never silently weaken disclosure rules.

---

## 38. Provider Contract Awareness

Provider capabilities and contractual privacy terms can differ.

Where relevant, NAGEX policy/configuration should represent:

- training/data-use settings
- retention behavior
- enterprise privacy agreements
- regional processing
- zero-retention options
- private/dedicated deployment status

Do not assume all provider APIs have identical privacy guarantees.

---

## 39. User Choice and Enterprise Policy

Routing may consider user preferences such as:

- lower cost
- faster response
- local/private preference
- premium reasoning permission
- preferred language/model family

Enterprise policy may impose stricter requirements such as:

- approved providers only
- specific regions only
- no public models
- dedicated deployment only
- BYOK only
- local/on-prem only

User preference can never override stricter enterprise/security policy.

---

## 40. UX Principle

Most users should not need to select models manually.

Default experience:

```text
User asks for outcome
↓
NAGEX chooses safe appropriate model(s)
↓
User receives result
```

Advanced users may optionally inspect:

- model used
- reasoning tier
- privacy mode
- estimated/actual usage

NAGEX is the product, not a thin dropdown in front of model APIs.

---

## 41. Global Language Strategy

Model selection should account for language quality.

A Korean-language task may route differently from:

- English
- Chinese
- Japanese
- multilingual mixed documents

Language strength is a routing signal, not a permanent provider lock-in.

NAGEX should benchmark actual quality periodically rather than rely only on vendor marketing.

---

## 42. Benchmarking

NAGEX should maintain evaluation sets for major task classes, including where relevant:

- Korean reasoning
- English reasoning
- Chinese reasoning
- coding
- slide outline quality
- document extraction
- agent tool selection
- structured output reliability
- latency
- cost
- hallucination rate

Routing policy should be informed by measured quality.

---

## 43. Dynamic Economics

Model prices change frequently.

Do not hard-code assumptions such as:

```text
Model A is always cheapest
```

Pricing and provider economics should be maintained as operational metadata.

The cost optimizer should be updateable without rewriting unrelated product code.

---

## 44. Capability-Based Model Contracts

Callers should request capabilities rather than vendor names where practical.

Example:

```text
need:
- reasoning: HIGH
- language: ko
- tools: YES
- structuredOutput: YES
- sensitivityMax: S1
- latency: INTERACTIVE
```

rather than:

```text
use provider/model X
```

Explicit model pinning may still exist for:

- testing
- admin controls
- enterprise policy
- explicit advanced-user selection

---

## 45. Target Gateway Components

```text
NAGEX Model Gateway
├─ Provider Registry
├─ Model Registry
├─ Provider Adapters
├─ Credential Pool
├─ Data Disclosure Gate
├─ Security Eligibility Engine
├─ Capability Matcher
├─ Model Router
├─ Cost Optimizer
├─ Capacity Manager
├─ Rate Limiter
├─ Queue / Scheduler Interface
├─ Fallback Engine
├─ Circuit Breaker
├─ Usage Meter
├─ Cost Ledger
├─ Billing Interface
└─ Audit / Observability
```

Not every component must be implemented immediately, but these boundaries should guide growth.

---

## 46. Canonical End-to-End Flow

```text
User Request
↓
Intent Resolution
↓
Task Classification
↓
Context Collection
↓
Data Classification
↓
Disclosure Policy
↓
Minimization / Redaction
↓
Eligible Model Set
↓
Capability Match
↓
Regional / Enterprise Policy
↓
Capacity Check
↓
Cost / Quality / Latency Optimization
↓
Model Selection
↓
Credential / Deployment Selection
↓
LLM Call
↓
Usage Capture
↓
Cost Ledger
↓
Result Validation
↓
Agent / User Result
```

---

## 47. Development Invariants

### MODEL-INV-001 — No Direct Provider Coupling

Domain/business modules must not directly depend on raw provider clients when Model Gateway support exists.

### MODEL-INV-002 — Disclosure Before Routing

No remote model selection may bypass the Model Disclosure Policy.

### MODEL-INV-003 — Secrets Never Reach General Remote Models

S3 data must not be sent to general remote LLM APIs.

### MODEL-INV-004 — No Privacy Downgrade on Fallback

Fallback must preserve or strengthen security requirements.

### MODEL-INV-005 — Provider Neutrality

Adding/removing a provider must not require rewriting unrelated domain logic.

### MODEL-INV-006 — Usage Is Metered

Billable model calls must create normalized usage records.

### MODEL-INV-007 — Cost Cannot Override Security

A cheaper model/provider cannot be selected if it is not security-eligible.

### MODEL-INV-008 — Capacity Is Explicit

Provider capacity and rate limits must be runtime constraints.

### MODEL-INV-009 — Tenant Isolation

Model context, usage, and billing records must remain tenant/principal scoped.

### MODEL-INV-010 — No Plaintext Emergency Path

Outages must never trigger an unapproved plaintext/provider fallback.

---

## 48. Required Tests

Future Model Gateway implementation should test at minimum:

1. S3 input never reaches remote provider adapter
2. S2 raw disclosure denied by default
3. redaction failure prevents protected remote call
4. no eligible model causes fail-closed result
5. cost router cannot select security-ineligible model
6. provider outage re-evaluates safe eligible fallback
7. fallback never silently changes allowed region
8. tenant A usage cannot appear in tenant B ledger
9. rate limiting is enforced before provider exhaustion
10. capacity-degraded model is removed from active selection
11. provider response usage is normalized
12. billing ledger records provider cost safely
13. provider secrets never appear in logs
14. routing decision is auditable without storing raw sensitive content
15. BYOK credentials are tenant-scoped
16. local-only policy cannot call public APIs
17. circuit breaker stops repeated unhealthy calls
18. language-specific routing honors capability requirements
19. low-level task can route to economical model
20. high-level task can escalate to stronger model
21. shared application code remains provider-neutral
22. model/routing changes run evaluation or golden tests

---

## 49. Scaling Stages

### Stage A — Early Product

```text
Provider adapters
Model registry
Disclosure gate
Basic router
Usage metering
Rate limiter
```

### Stage B — Growth

```text
multi-project credentials
capacity manager
fallback
circuit breaker
queueing
cost optimizer
regional routing
```

### Stage C — Large Scale

```text
regional gateways
dedicated/contracted capacity
reserved throughput
private inference
BYOK enterprise pools
advanced cost ledger
automated provider balancing
```

---

## 50. Relationship to Product UX

This architecture supports:

`docs/NAGEX_PRODUCT_UX_INTENT_INTERACTION_PRINCIPLES.md`

The user expresses intent.

NAGEX decides:

- what information is safe to use
- what model class is appropriate
- what provider is eligible
- whether local/private inference is required
- how much reasoning quality is needed
- how to minimize cost without reducing required quality or safety

The user should not have to understand this internal complexity.

---

## 51. Relationship to Safety Harness

This architecture is also governed by:

`docs/NAGEX_DEVELOPMENT_SAFETY_HARNESS.md`

Any implementation must preserve:

- fail-closed semantics
- auditability
- architecture boundaries
- behavior tests
- explicit technical debt
- no undocumented bypass

---

## 52. Prohibited Shortcuts

Do NOT:

- use one personal API key as the production scaling architecture
- let every domain call providers directly
- route solely by price
- send all user context to every model
- send protected raw content merely because a model supports large context
- bypass disclosure policy during outages
- hard-code model choices across business logic
- expose provider credentials through broad `.env` usage across services
- treat provider invoice totals as sufficient user metering
- silently use another jurisdiction because capacity is available there
- use BYOK as a substitute for a managed consumer product
- force ordinary users to select models manually
- assume all providers have identical privacy guarantees

---

## 53. Architecture Completion Gate

Any major Model Gateway milestone should report:

```text
NAGEX MODEL GATEWAY SAFETY GATE

Provider-neutral interface              PASS / FAIL
Model Registry updated                  PASS / N/A
Provider Registry updated               PASS / N/A
Disclosure gate executed first          PASS
S3 remote disclosure                    MUST BE ZERO
S2 raw remote default                   DENY
Redaction/minimization                   PASS / N/A
Region eligibility                      PASS
Security before cost routing            PASS
Capacity check                          PASS
Safe fallback                           PASS / N/A
No privacy downgrade fallback           PASS
Usage metering                          PASS
Cost ledger                             PASS / N/A
Tenant isolation                        PASS
Secrets absent from logs                PASS
Fail-closed tests                       PASS
New technical debt                      DECLARED

MODEL GATEWAY RESULT                    PASS / FAIL
```

If the result is FAIL, do not claim the milestone complete.

---

## 54. Governing Rules

> **NAGEX is global by architecture, not by translation.**

> **NAGEX is model-agnostic by design, not by maintaining a long list of hard-coded APIs.**

> **NAGEX uses the most appropriate model for each task, rather than the most powerful model for every task.**

> **NAGEX determines what a model is allowed to see before deciding which model to use.**

> **Sensitive user data must never be exposed merely to improve convenience, cost, or availability.**

> **At scale, users consume NAGEX capability; NAGEX manages provider capacity behind the gateway.**

These rules are mandatory architectural constraints.

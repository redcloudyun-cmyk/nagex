# NAgex External Benchmark & Integration Guidance

**Date:** 2026-09-26  
**Status:** CANONICAL REFERENCE / DEVELOPMENT INPUT  
**Scope:** External products, services, architectures, model providers, agent runtimes, security patterns, execution patterns, and cost/provider strategies previously reviewed for NAgex  
**Product Boundary:** NAgex only

---

## 0. Purpose

This document consolidates the external products, services, technologies, and architectural ideas reviewed during NAgex development and converts them into explicit engineering guidance.

This is not a shopping list. Not every reviewed item should become a dependency.

Governing rule:

> External references may influence NAgex architecture, but they must not become NAgex's identity or override canonical product, security, privacy, and human-control invariants.

NAgex's durable product assets are:

~~~text
Personal Memory
Personal Context
Permission
Credential Isolation
Execution History
Trust
User Relationship
~~~

LLM providers, browser runtimes, decision providers, and external services are replaceable components around those assets.

---

# 1. Product / Competitive Benchmarks

## 1.1 Meta Muse

### Why reviewed

Meta Muse was reviewed as one of the closest external benchmarks to NAgex's intended Personal AI / Agentic AI category.

Relevant themes:

- persistent personal agent runtime
- dedicated browser / cloud execution
- background continuation
- credential isolation / surrogation
- independent permission authority
- prompt-injection and untrusted-content boundaries
- human approval before consequential actions
- auditability
- personality / conversational identity

### Adopt

~~~text
Persistent agent runtime
Background execution
Browser/computer execution
Credential isolation
Independent permission authority
Untrusted-content defense
Site/API policy
Long-running task continuation
~~~

### Differentiate

NAgex must not be positioned as "Muse but smaller."

Preferred differentiation:

~~~text
Personality
+ Editable Personal Memory
+ Provenance
+ Personal Context
+ Permission Transparency
+ Human Approval Control
+ Credential Isolation
+ Execution Auditability
= Governed Personal AI
~~~

### Development impact

Already reflected:

- R23.2D Demo Canonicalization
- R23.3T Permission / Approval Hardening

Current / next:

- R23.4V Credential Broker / Inject-only Vault
- R23.5B Browser Untrusted-Content Boundary
- R23.7G Background Runtime Certification
- R23.8P Governed Personality / Trust UX

---

## 1.2 Wissly

### Why reviewed

Wissly was reviewed mainly as a document/RAG/evidence UX reference.

### Useful patterns

- source-grounded answers
- inspectable evidence
- scope-constrained search
- answer-to-source navigation
- clear distinction between generated answer and supporting material

### Apply to NAgex

- Vault search
- personal knowledge search
- research/evidence surfaces
- memory provenance inspection
- source-scoped answers

Desired interaction:

~~~text
Answer
→ supporting source
→ exact source object / range
→ user inspection
~~~

Do not turn NAgex into a document-QA-only product. Evidence UX is a trust feature inside a broader Personal AI.

---

## 1.3 WebMCP

### Why reviewed

WebMCP was validated during earlier agent/web application work and is relevant to structured browser/tool interaction.

### Canonical lesson

Prefer structured interfaces before visual automation.

~~~text
1. Native API
2. MCP / WebMCP / structured tool
3. DOM / structured browser
4. Vision-based browser control
5. Desktop visual control
~~~

Canonical principle:

> API FIRST → STRUCTURED CONTROL → VISUAL CONTROL

Visual automation remains fallback, not the preferred default.

---

# 2. Decision / Intelligence Providers

## 2.1 Jev

### Why reviewed

Jev was reviewed as a possible external decision provider rather than as another general-purpose conversational LLM.

### Suitable uses

~~~text
risk classification
ambiguity detection
retry / abort / escalate recommendation
task-completion judgment
inbox/action classification
evidence sufficiency signal
model-tier routing signal
approval escalation recommendation
~~~

### Unsuitable uses

~~~text
general conversation
long-form drafting
RAG answer generation
report generation
meeting-summary generation
complex planning ownership
final permission authority
~~~

### Required architecture

~~~text
Hard Policy
   ↓
Permission Authority
   ↓
Jev advisory signal (optional)
   ↓
Human Approval when required
   ↓
Execution
~~~

Mandatory invariants:

~~~text
JEV_CAN_APPROVE=0
JEV_CAN_OVERRIDE_BLOCK=0
JEV_CAN_BYPASS_HUMAN_APPROVAL=0
JEV_CAN_READ_CREDENTIALS=0
~~~

### Development decision

Do not make Jev a blocking dependency for R23.4V.

Recommended timing:

- complete Credential Broker first
- keep Jev behind a provider interface
- later run an advisory-only POC against deterministic Permission Authority outcomes

---

# 3. Multi-model / Model Gateway References

## 3.1 Multi-model orchestration

NAgex should not rely on one model for all tasks.

~~~text
User
 ↓
NAgex
 ↓
Task classification
 ↓
Model Router
 ├─ fast / low-cost
 ├─ reasoning
 ├─ structured extraction
 ├─ vision
 ├─ coding
 └─ local/private
~~~

Examples:

~~~text
simple classification
→ small/cheap model

research synthesis
→ stronger reasoning model

browser screenshot judgment
→ vision-capable model

sensitive local document processing
→ local/private model

complex planning
→ high-reasoning tier
~~~

---

## 3.2 OpenAI

Role:

- general chat
- reasoning
- selected structured tasks
- development/coding support

Guidance:

- keep provider-neutral adapter boundaries
- never let OpenAI-specific APIs define NAgex's core product contract

---

## 3.3 Google Gemini

Role:

- general model provider
- multimodal work
- structured output
- Google ecosystem adjacency

Guidance:

- continue as a first-class cloud provider
- route based on capability/security/cost rather than brand preference

---

## 3.4 Nebius / NVIDIA Nemotron

Role:

- hackathon-relevant provider and model family
- lower-cost and infrastructure-oriented model execution
- substantive NAgex Model Gateway integration

Guidance:

- continue real provider support
- clearly distinguish live usage from mock/provider-unavailable states
- retain capability-driven routing

---

## 3.5 Anthropic Claude

Role:

- reasoning/coding/general provider candidate

Guidance:

- adapter compatibility is valuable
- not an immediate critical-path dependency

---

## 3.6 Qwen / DeepSeek / GLM

Role:

- global provider diversification
- cost/performance alternatives
- Chinese ecosystem/model availability

Guidance:

- support through provider-neutral registry where appropriate
- do not send sensitive data merely because a model is cheaper
- route only after security and regional eligibility checks

---

## 3.7 HyperCLOVA X / EXAONE

Role:

- Korean-language / regional optimization candidates

Guidance:

- optional regional providers
- not part of NAgex's core identity

---

# 4. Local / Private Model References

## 4.1 Ollama

Best fit:

- local development
- small private workloads
- quick user-managed local model integration

Not intended to define production inference architecture.

## 4.2 LM Studio

Best fit:

- local development and experimentation
- manual model testing
- developer convenience

Not a production runtime dependency.

## 4.3 vLLM

Best fit:

- self-hosted GPU inference
- server-grade private model serving
- production-oriented local/private deployment

Long-term role:

~~~text
NAgex Model Gateway
 ├─ Cloud providers
 └─ Private providers
      ├─ Ollama
      └─ vLLM
~~~

Local/private inference is important for:

- sensitive memory preprocessing
- PII detection
- secret detection
- private summarization
- local embedding
- context preprocessing
- future privacy-sensitive private workloads

---

# 5. Developer / Cost Optimization References

## 5.1 Antigravity

Role:

- development environment / coding productivity

Guidance:

- keep it outside the NAgex runtime architecture
- integrate external/local models through standard API/MCP interfaces
- NAgex architecture must remain independent of the chosen coding IDE

## 5.2 OpenCode Go / Muse Spark

Role:

- low-cost development/model experimentation

Guidance:

- useful for coding-cost optimization and compatibility experiments
- do not make them a production NAgex foundation without verified reliability, policy, and data-handling guarantees

## 5.3 CheapAI

Role:

- low-cost OpenAI/Anthropic-compatible gateway experimentation

Use for:

- development
- compatibility testing
- fallback experiments
- cost benchmarking

Not recommended as a trust-critical production dependency for personal memory or credential-bearing flows.

## 5.4 Cafe24 LLM Router

Role:

- reference for multi-model routing, provider fallback, unified API shape

Guidance:

- architecture reference is useful
- NAgex should own its own Model Gateway and routing policy
- do not outsource the canonical decision layer unless the external service is explicitly trusted and replaceable

---

# 6. Billing / Provider Ownership Strategy

Long-term modes:

~~~text
Managed
BYOK
Private / Local
~~~

## Managed

~~~text
User
→ NAgex managed credits
→ NAgex provider account
→ provider usage settlement
~~~

## BYOK

~~~text
User
→ own provider credential
→ NAgex Credential Broker
→ provider
~~~

R23.4V Credential Broker is a prerequisite for safe BYOK.

---

# 7. Identity / Connected Ecosystems

## 7.1 Google

Strategic surface:

~~~text
Identity
Gmail
Calendar
Drive
Docs
~~~

Google remains first-class.

## 7.2 Microsoft

Target surface:

~~~text
Identity
Outlook
Calendar
OneDrive
Office
Teams
~~~

Google + Microsoft remain the preferred primary social/connected identity ecosystems. Kakao is not a current priority.

Microsoft connector breadth should not interrupt R23.4V/R23.5B.

---

# 8. Browser / Computer Use

## 8.1 Browser structured execution

Preserve:

~~~text
API first
→ structured browser
→ visual browser only when needed
~~~

R23.5B will explicitly treat browser/page content as untrusted.

## 8.2 Desktop Local Device Agent

Current direction:

- Windows-first desktop control
- approval-gated mutation
- isolated execution
- human cancel/override
- bounded action loop

It must remain downstream of Permission Authority and Credential Broker.

## 8.3 Android Device Bridge

Future mobile control.

Priority:

- after Windows/browser trust and execution paths stabilize
- not part of immediate R23.4V critical path

---

# 9. Reservation / Transaction References

## 9.1 모두닥-style medical reservation

Potential NAgex flow:

~~~text
User goal
→ understand preferences/context
→ search providers
→ inspect availability
→ compare
→ propose option
→ explicit user approval
→ reserve
→ calendar update
→ activity/audit
→ memory update only when appropriate
~~~

Reservation is a strong candidate for R23.6E One Complete Real E2E Agent Scenario.

Exact provider/site must be selected based on:

- official API availability
- automation policy
- stable reproducibility
- login/credential requirements
- geographic availability
- test safety

Do not hardcode NAgex architecture around one reservation service.

## 9.2 Stripe Link / tokenized payment delegation

Relevant lesson:

- underlying payment details remain outside the agent
- transaction is scoped to an approved purchase

NAgex target:

~~~text
paymentMethodRef
transactionIntent
merchant
amount
explicit user approval
→ payment provider
~~~

Never:

~~~text
raw card number
→ LLM / agent context
~~~

Payment remains P2.

Prerequisite order:

~~~text
Permission Authority
→ Credential Broker
→ Browser Trust Boundary
→ Reservation / transaction execution
→ Payment
~~~

---

# 10. Credential Broker — Strategic Synthesis

Credential Broker is now the highest-priority application of the benchmark work.

~~~text
User / Connected App / BYOK
          ↓
Encrypted Credential Store
          ↓
Credential Broker
          ↓
credential handle / scoped lease
          ↓
Execution boundary
          ↓
Provider / Browser / Connector
~~~

Agent-visible:

~~~text
credentialRef
provider
scope metadata
availability
expiry metadata
~~~

Agent-invisible:

~~~text
access token
refresh token
password
API key
session secret
raw payment credential
~~~

Mandatory invariants:

~~~text
MODEL_CAN_READ_SECRET=0
AGENT_CAN_READ_SECRET=0
SECRET_IN_PROMPT=0
SECRET_IN_LOG=0
SECRET_IN_MEMORY=0
SECRET_IN_ACTIVITY=0
SECRET_IN_APPROVAL_PAYLOAD=0

CREDENTIAL_INJECT_ONLY=1
CREDENTIAL_SCOPE_ENFORCED=1
CREDENTIAL_PROVIDER_BOUND=1
CREDENTIAL_USER_BOUND=1
CROSS_TENANT_SECRET_ACCESS=0
~~~

---

# 11. Evidence / Trust UX Synthesis

Users should be able to answer:

~~~text
Why is NAgex suggesting this?
What source did it use?
What will it change?
What data will leave my system?
Which credential/service will be used?
Did it actually execute?
Can I revoke or deny it?
~~~

Reflect progressively in:

- Vault
- Search
- Memory
- Approval
- Activity
- Connected Apps
- future Credential UI

Do not expose internal terms such as Permission Authority, Capability Broker, payload hash, model router, or credential injection in ordinary UI.

---

# 12. Priority Classification

## P0 — Core / Immediate

~~~text
Meta Muse security/runtime lessons
Credential Broker / inject-only Vault
Permission Authority
Browser untrusted-content boundary
WebMCP / API-first structured control
Multi-model routing
Local/private model support
Persistent memory + provenance
Google ecosystem
~~~

R23.3T Permission Authority is complete and should remain frozen.

Current implementation focus:

> R23.4V Credential Broker / Inject-only Vault MVP

## P1 — Strong differentiation

~~~text
Jev advisory decision provider
Reservation workflow
Wissly-style evidence UX expansion
Background runtime certification
Governed Personality
Microsoft ecosystem
Desktop/browser execution expansion
~~~

## P2 — After the core path is stable

~~~text
Payment
Stripe Link-style delegated payment
Android Device Bridge
full BYOK user-facing management
advanced provider marketplace
~~~

## Development / Experimentation Only

~~~text
CheapAI
Cafe24 Router
OpenCode Go
Muse Spark
Antigravity-specific provider hacks
~~~

These may reduce development cost or help benchmarking, but must not become trust-critical architectural foundations by default.

---

# 13. Updated Canonical Development Sequence

As of 2026-09-26:

~~~text
R23.2D  Demo Canonicalization                    CLOSED
   ↓
R23.3T  Permission / Approval Hardening         CLOSED
   ↓
R23.4V  Credential Broker / Inject-only Vault   CURRENT
   ↓
R23.5B  Browser Untrusted-Content Boundary
   ↓
R23.6E  One Complete Real E2E Agent Scenario
   ↓
R23.7G  Background Runtime Certification
   ↓
R23.8P  Governed Personality / Trust UX
   ↓
R23.9C  Final Hackathon Certification
~~~

Supporting POCs must not interrupt this dependency chain.

Jev may be explored only as a non-blocking advisory POC.

Payment remains outside the critical path.

---

# 14. Rules for Future External References

When a new product, model, framework, or service is proposed, classify it before implementation:

~~~text
1. Product benchmark?
2. Model provider?
3. Decision provider?
4. Execution provider?
5. Security/trust component?
6. Developer tool?
7. Infrastructure provider?
8. Transaction/connected-service integration?
~~~

Then answer:

~~~text
Does it improve NAgex's durable product assets?
Does it preserve user control?
Does it introduce a new source of truth?
Does it duplicate an existing canonical store/runtime?
Can it be replaced?
Can sensitive data reach it?
Can it grant itself permission?
Does it create vendor lock-in?
Is it critical path or optional?
~~~

No external reference should be integrated merely because it is new, cheap, popular, or technically impressive.

---

# 15. Final Product Position

> NAgex should not compete by owning the best single model. It should become the trusted personal intelligence and action layer that can use many models and services while keeping the user's memory, context, credentials, permissions, and execution history under one governed system.

~~~text
                   NAgex
                     │
      ┌──────────────┴──────────────┐
      │                             │
Personal Intelligence          Action Runtime
      │                             │
Memory                      Permission Authority
Context                           │
Right Now                        Approval
Suggestions                       │
Personality                 Credential Broker
      │                             │
      └──────────────┬──────────────┘
                     │
                Agent Planner
                     │
                Model Gateway
        ┌────────────┼────────────┐
        │            │            │
      Cloud        Local       Advisory
      LLMs         LLMs          Jev
        │            │            │
        └────────────┴────────────┘
                     │
              Capability Broker
                     │
   ┌─────────┬───────┼─────────┬────────────┐
   │         │       │         │            │
 Gmail    Calendar Browser   Desktop   Reservation
~~~

The LLM is not NAgex.

The governed personal context and execution relationship is NAgex.

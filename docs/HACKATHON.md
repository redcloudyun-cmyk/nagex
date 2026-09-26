# NAgex Hackathon Specification

## 1. Target Event

**Nebius x NVIDIA Global AI Hackathon**

NAgex is being independently developed for this hackathon from 2026-09-05 onward.

Its repository was bootstrapped from an earlier internal experimental codebase owned by the same entrant.

That origin must be described transparently where required.

## 2. Hackathon Product Direction

NAgex targets a Personal AI / Agentic AI experience.

The strongest submission should demonstrate more than a branded assistant UI.

It should show a real agent loop that uses NVIDIA and Nebius technologies in a substantive execution path.

Current competitive positioning:

> **NAgex is a governed personal AI that remembers your context, helps decide what matters now, prepares and executes useful actions, and keeps you in control of memory, permissions, credentials, and consequential actions.**

Supporting line:

> **Many models behind. One personal AI in front.**

The current benchmark and implementation guidance is:

- `docs/NAgex_Meta_Muse_Benchmark_Revised_Development_Directive_v2_20260923.md`
- `docs/NAgex_External_Benchmark_and_Integration_Guidance_20260926.md`
- `docs/NAgex_R23.4V_Credential_Broker_Inject_Only_Vault_Development_Directive_20260926.md`

These are subordinate to `MASTER.md` and frozen architecture invariants. The consolidated guidance classifies previously reviewed references such as Muse, Jev, Wissly, WebMCP, model providers, local/private inference, BYOK, reservation, and payment so optional experiments do not interrupt the critical path.

## 3. Required Technical Direction

Target stack:

- NVIDIA open-source model, with Nemotron as the primary target family
- Nebius Token Factory and/or Nebius AI Cloud
- NAgex Model Gateway / Router
- Personal Agent Runtime
- Memory
- Skills / Tools
- Human Approval
- Auditable execution

Trust-critical direction added after the Meta Muse benchmark:

- independent permission authority,
- credential broker / inject-only secret handling,
- browser untrusted-content boundary,
- prompt-injection resistance at the policy boundary,
- API-first / site-policy-aware browser automation,
- no parallel demo-only execution path.

## 4. Current Hackathon Priority Sequence

As of 2026-09-26:

```text
R23.2D  Demo Canonicalization                    CLOSED
   ↓
R23.3T  Permission / Approval Hardening         CLOSED
   ↓
R23.4V  Credential Broker / Inject-only Vault   CLOSED
   ↓
R23.5B  Browser Untrusted-Content Boundary       CURRENT
   ↓
R23.6E  One complete real E2E agent scenario
   ↓
R23.7G  Background Runtime Certification
   ↓
R23.8P  Governed Personality / Trust UX
   ↓
R23.9C  Final Hackathon Certification
```

Payment/tokenized virtual-card work is P2 and is not part of the critical submission path unless all preceding gates close early.

The dependency order matters more than the milestone labels.

Jev is an optional advisory POC only and must not interrupt the current critical path. Wissly-style evidence UX, Microsoft connector expansion, reservation scenarios, and local/private model expansion are retained as planned inputs but are scheduled according to dependency and hackathon value. Payment/tokenized virtual-card work remains P2.

## 5. Hackathon Trust Invariants

The submission path must preserve:

```text
FAKE_SUCCESS_PATHS=0
DEMO_PARALLEL_INTELLIGENCE_PIPELINE=0

AGENT_SELF_APPROVAL=0
APPROVAL_BYPASS=0
REJECT_MUTATION=0
APPROVAL_ONE_TIME_CONSUME=1

PLAINTEXT_CREDENTIAL_TO_LLM=0
PLAINTEXT_CREDENTIAL_TO_LOG=0
AGENT_CREDENTIAL_READ=0

WEB_CONTENT_TRUSTED=0
WEB_PAGE_CAN_GRANT_PERMISSION=0
PROMPT_INJECTION_CAN_BYPASS_APPROVAL=0

CROSS_TENANT_LEAK=0
CROSS_USER_LEAK=0
```

A browser page, email, document, model output, or agent-generated tool instruction is never a permission authority.

## 6. Integration Truthfulness

Every hackathon-facing feature must be marked accurately:

```text
Implemented
Partially implemented
Prototype / Mock
Planned
```

Do not claim:

- a model is live when mocked,
- Nebius is used when only documented,
- a tool executed when the result was static,
- persistent memory when only session state exists,
- a demo response represents the canonical runtime when it bypasses the real runtime,
- a credential is protected if plaintext can enter model context or logs.

## 7. Required Demo Story

The submission should prioritize **one complete real path** rather than many partial cards.

Recommended scenario:

> Monitor a competitor's pricing, summarize what changed, and email me the report.

Required structure:

```text
1. User provides a goal
2. NAgex retrieves relevant personal context/memory
3. NAgex plans or resolves the task
4. NVIDIA/Nebius reasoning is substantively used
5. NAgex uses API/browser tools under site policy
6. External content remains untrusted
7. Result is grounded in real evidence
8. Email draft is prepared
9. Consequential send triggers Needs your attention
10. User reviews and approves
11. NAgex performs the real Gmail action
12. Activity/audit shows what happened
13. Any retained memory goes through canonical memory policy
```

The demo must not use a static success response or a parallel demo-only execution pipeline.

## 8. Closure Definition

A hackathon-facing capability is not complete merely because a backend class or API exists.

Closure requires, where applicable:

```text
Backend contract
+ canonical runtime path
+ real user-facing UI path
+ deterministic regression
+ affected browser certification
+ test-server verification
+ no mock/parallel demo path
```

## 9. Submission Readiness

Before submission verify:

- public repository is clean,
- setup instructions work,
- license is present,
- no secrets exist,
- real Nebius/NVIDIA usage is demonstrable,
- demo is reproducible,
- README distinguishes implemented vs planned,
- project-origin disclosure is accurate,
- architecture diagram matches actual implementation,
- credential handling claims match real boundaries,
- consequential actions cannot bypass approval,
- demo mode uses canonical product logic,
- browser automation policy is explicit,
- video remains within event limits.

## 10. Development Evidence

Hackathon-period work should be easy to identify in Git history.

Meaningful updates should include:

- product redefinition,
- NVIDIA/Nebius integration,
- agent runtime changes,
- personal-memory implementation,
- skills/tools,
- approval flow,
- credential isolation,
- browser trust/security boundaries,
- demo canonicalization,
- demo-specific UX,
- tests and documentation.

## 11. Submission Positioning

Preferred positioning:

> NAgex is a new hackathon project created during the submission period and bootstrapped from an entrant-owned internal experimental codebase. The hackathon work establishes a new product identity and implements the Personal AI, NVIDIA/Nebius, memory, governed tool execution, credential isolation, browser safety, and human-control direction.

Avoid describing the bootstrap source as a previous commercial NAgex product.

Do not position NAgex as "Muse but smaller." The benchmark informs architecture and priorities; it does not define NAgex's identity.

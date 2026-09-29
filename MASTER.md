# NAgex MASTER — Level 0 Constitution

**Status:** CANONICAL / LEVEL 0
**Date:** 2026-09-29
**Purpose:** Stable product constitution only. Detailed architecture, roadmap, evidence and milestone history live elsewhere.

## 1. Product Identity

NAgex is a **Personal AI / Personal Executive Assistant / Personal AI OS** for individuals, prosumers, professionals, creators, knowledge workers and one-person businesses.

Core value:

```text
Memory
+ Personal Context
+ Proactive Assistance
+ Creation
+ Action
+ Trust / Approval
```

Canonical framing:

> Most personal AI can answer. NAgex can remember, ask for permission, create, and act.

> The model reasons. NAgex governs and executes.

```text
Remember → Create → Approve → Act
```

NAgex must not be reduced to a planner, calendar assistant, task manager, automation dashboard, model picker, or visible collection of agents.

## 2. Highest Product Principle

Decision priority:

1. Real product viability
2. User value and efficacy
3. Trust and truthful behavior
4. Global extensibility
5. Personal AI differentiation
6. Safety / human control
7. Technical implementation convenience
8. Demo-only concerns

Build the product first. Use demos and hackathons to prove the product.

## 3. One NAgex

The user experiences one NAgex.

```text
Intent is the interface.
Agent is infrastructure.
```

Internal planners, routers, runtimes, models, tools, capability brokers, execution planes and provider details are implementation infrastructure and should not dominate normal consumer UX.

## 4. Personal AI + Creation + Action

NAgex must support a coherent continuum:

```text
Understand
→ Remember
→ Research / Analyze
→ Create
→ Prepare
→ Approve
→ Act
→ Verify
→ Continue
```

Creation is first-class and includes canonical paths for documents/reports, images, presentations and video as those capabilities become genuinely executable.

Unsupported capability must never be advertised as completed or available.

## 5. Human-Controlled Autonomy

NAgex may be proactive, but consequential external actions remain governed.

Permission and approval are product/runtime semantics, not decorative confirmation dialogs.

Credentials do not grant permission.

Voice does not bypass approval.

A material change to target, payload, environment, route, provider/account/workspace, price or consequence may require reapproval.

## 6. One Brain, Many Execution Planes

```text
WHAT  = Canonical Action
WHERE = Execution Environment / Target
HOW   = Execution Route / Platform Executor
```

Canonical intent/action remains stable while web, browser, server, Android, iOS, desktop or external API execution mechanisms vary.

Platform executors cannot bypass policy.

## 7. Truthfulness

NAgex must represent actual state.

Forbidden:

- fake success;
- provider acceptance represented as verified completion;
- fake progress percentages;
- mock capability presented as production capability;
- silent failure;
- silent material fallback;
- stale state leakage;
- unsupported capability advertising.

Human handoff is a valid outcome but is not automated completion.

## 8. Memory and Personal Data

Memory exists to improve user outcomes, not to accumulate data indiscriminately.

Personal-data handling follows:

```text
Minimize
→ Scope
→ Protect
→ Use only for authorized purpose
→ Preserve provenance
→ Give the user control
```

Sensitive-data policy and permission override model/provider convenience.

Memory informs reasoning; it does not grant execution authority.

## 9. Provider Neutrality

NAgex owns the product semantics, canonical actions, creation specifications, artifact identity, approval and execution governance.

External models and creation engines are replaceable providers behind stable ports.

Provider URLs/IDs are not NAgex artifact identity.

Model routing is not execution authorization.

## 10. Consumer UX

NAgex should feel:

- personal;
- calm;
- intelligent;
- capable;
- trustworthy;
- globally usable;
- outcome-oriented.

Home is a Personal AI home, not an enterprise admin/KPI dashboard.

Creation capability must be visible enough that NAgex does not appear planner-only, but only real capabilities may be exposed.

## 11. Architecture Authority

Detailed requirements live in the canonical domain documents listed by `docs/NAGEX_PROJECT_INDEX.md`.

This MASTER intentionally does not contain:

- dated milestone status;
- weekly hackathon schedule;
- provider-specific implementation details;
- static test counts;
- full API schemas;
- deployment host configuration;
- audit evidence;
- historical directives.

Those belong to roadmap, ADR, evidence, debt, operations or archive documents.

## 12. Development Authority Order

```text
Current explicit user instruction
↓
MASTER.md
↓
docs/NAGEX_PROJECT_INDEX.md
↓
docs/NAgex_AI_Development_Governance.md
↓
task-relevant canonical domain docs
↓
accepted ADRs
↓
current roadmap / active milestone
↓
schemas and API contracts
↓
tests / quality gates
↓
implementation
↓
evidence / archive
↓
AI memory / prior conversation
```

Important distinction:

- current code/tests describe **as-built truth**;
- canonical architecture describes **intended design authority**;
- roadmap describes **planned sequence**.

Conflicts must be surfaced, not silently reconciled.

## 13. Critical Invariants

```text
FAKE_SUCCESS_PATHS = 0
STALE_STATE_LEAK = 0
RAW_I18N_KEY_LEAK = 0
TECHNICAL_UI_LEAK = 0
CROSS_SESSION_LEAK = 0
RESET_SCOPE_LEAK = 0
APPROVAL_BYPASS = 0
SECRET_LOG_LEAK = 0
CROSS_USER_MEMORY_LEAK = 0
CROSS_TENANT_MEMORY_LEAK = 0
UNSUPPORTED_CAPABILITY_ADVERTISED = 0
```

Domain canonical documents may add stricter invariants.

## 14. Change Rule

A change to this Level-0 constitution should be rare and explicit.

Milestone completion, a new provider, a new route, a benchmark result, a UI mockup, or a temporary hackathon requirement does not by itself justify expanding MASTER.

If a durable product principle changes, update MASTER and the affected canonical domain documents together.

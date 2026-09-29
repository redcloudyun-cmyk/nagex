# NAgex Core Runtime Architecture

**Canonical Domain:** Core Runtime / Goal / Plan / State / Capability
**Status:** CANONICAL — consolidated architecture draft for repository adoption
**Date:** 2026-09-29

## 1. Architectural Goal

NAgex separates reasoning, state, memory, capability selection, approval, execution, model/provider concerns, and audit so that one Personal AI can continue real work without allowing any one model, tool, provider, UI, or device to become the authority.

Canonical statement:

> **The model reasons. NAgex governs and executes.**

The runtime exists to transform user intent into truthful, policy-governed, observable and resumable outcomes.

## 2. Canonical Runtime Flow

```text
User / Event / Capture
        ↓
Intent + Context
        ↓
Goal
        ↓
Plan / Decision
        ↓
Capability Resolution
        ↓
Permission / Approval
        ↓
Execution Planning
        ↓
Execution Plane / Tool / Creation Runtime
        ↓
Observation / Verification
        ↓
Re-plan when required
        ↓
Result
        ↓
Activity / Audit
        ↓
Memory / Continuation
```

Not every request requires every stage. Simple low-risk requests may take a shorter path, but they may not bypass mandatory policy.

## 3. Runtime Responsibilities

The shared NAgex runtime is responsible for:

- accepting user goals and structured events;
- gathering authorized context;
- maintaining durable task/execution state;
- invoking planning/reasoning when necessary;
- resolving skills, tools and execution capabilities;
- evaluating permission and approval requirements;
- dispatching canonical actions to the correct execution plane;
- observing and verifying results;
- re-planning when material conditions change;
- persisting meaningful state;
- surfacing truthful user-facing status;
- recording audit evidence.

## 4. Runtime Components

### 4.1 Goal / Intent Layer

Represents what the user is trying to accomplish, independent of provider or device implementation.

### 4.2 Planner

Transforms a goal into inspectable steps when planning is necessary. Plans are mutable working structures, not permanent authority.

Plan acceptance is not equivalent to approval for consequential execution.

### 4.3 Skill Registry

A Skill describes reusable know-how and should declare at minimum:

```text
id
name
description
input_schema
output_schema
required_tools
required_permissions
risk_level
execution_policy
```

Skills never bypass policy.

### 4.4 Tool / Capability Registry

Tools expose explicit executable interfaces. Capability resolution determines what can actually execute in the current environment.

### 4.5 Approval Layer

Approval is a runtime state, not a UI-only confirmation.

Typical lifecycle:

```text
NOT_REQUIRED
PENDING
APPROVED
REJECTED
EXPIRED
CONSUMED
```

The canonical Trust specification owns detailed approval invariants.

### 4.6 Model Gateway / Model Router

Reasoning and synthesis providers remain behind provider-neutral abstractions. Model routing is not execution authorization.

### 4.7 Execution Coordination

Canonical actions are routed to an eligible execution target and platform executor. Platform details do not leak into the canonical user action.

### 4.8 Creation Runtime

Creation is a first-class domain runtime for documents, images, presentations and later video. It is not a fake UI projection and is not equivalent to the generic ArtifactStore.

### 4.9 Activity and Audit

Activity is human-meaningful product history. Audit is deeper technical/security evidence. They share provenance but serve different audiences.

## 5. Execution State Model

A durable execution may use states such as:

```text
CREATED
CONTEXT_READY
PLANNING
READY
AWAITING_APPROVAL
EXECUTING
OBSERVING
REPLANNING
COMPLETED
FAILED
CANCELLED
```

Domain runtimes may add narrower states, but must preserve truthful mapping to consumer states.

## 6. Canonical Consumer State Mapping

Internal runtime detail should map to understandable product states such as:

- Prepared
- Needs approval
- In progress
- Completed
- Needs your action
- Failed
- Unavailable

Provider acceptance, queue admission, or plan generation is not completion.

## 7. Persistence and Continuation

Work that must continue across time must not depend only on a chat turn or process memory.

Where applicable, NAgex persists:

- goal/task identity;
- current plan/version;
- execution state;
- approval state;
- next run/wait condition;
- result references;
- failure/recovery state;
- audit provenance.

Restart or reconnect must not silently convert unfinished work into success.

## 8. Failure Handling

NAgex distinguishes at least:

- model/provider failure;
- tool/executor failure;
- authorization failure;
- approval rejection/expiry;
- invalid plan/spec;
- unavailable capability;
- timeout;
- partial execution;
- verification failure.

Fallback must never bypass security, privacy or approval policy.

## 9. Public Contract Rule

When a public contract changes, update together where applicable:

```text
Implementation
+ Schema / Type
+ Tests
+ Documentation
```

Contract migration must be deliberate. Blind global renames or compatibility assumptions are prohibited.

## 10. Observability

The system must be able to explain, at an appropriate depth:

- current state;
- what NAgex is doing;
- what needs user attention;
- what actually executed;
- what failed;
- why continuation/reapproval is required.

Technical provider/router/session details stay out of routine consumer UI unless they are needed for recovery or advanced inspection.

## 11. Composition and Ownership

One semantic responsibility should have one canonical owner.

Examples:

- Home aggregation should not be independently re-derived in multiple clients.
- Memory should not have parallel demo and canonical stores.
- Routes should belong to domain modules rather than accumulating method/path business routing in the composition root.
- Execution must use canonical chokepoints rather than direct provider/service calls that bypass policy.

## 12. Core Invariants

```text
MODEL_IS_NOT_AUTHORITY = 1
TOOL_CAN_BYPASS_POLICY = 0
APPROVAL_BYPASS = 0
FAKE_SUCCESS_PATHS = 0
STALE_STATE_LEAK = 0
CROSS_SESSION_LEAK = 0
RESET_SCOPE_LEAK = 0
TRUTHFUL_RUNTIME_STATE = 1
DURABLE_WORK_REQUIRES_DURABLE_STATE = 1
```

## 13. Source Provenance

Consolidated primarily from:

- `ARCHITECTURE.md`
- `DEVELOPMENT.md`
- durable runtime principles in `MASTER.md`
- `NAgex_Activity_and_Execution_Transparency_Amendment_v1.md`
- current R22/R23 architecture ownership rules

Dated priority sequences in older development documents are not copied as current roadmap authority.

# NAgex Architecture Specification

## 1. Architectural Goal

NAgex separates product reasoning, execution policy, tools, memory, and model-provider concerns so that the agent can act autonomously within explicit user-controlled boundaries.

## 2. High-Level Architecture

```text
┌───────────────────────────────┐
│           NAgex UI            │
└───────────────┬───────────────┘
                │
                ▼
┌───────────────────────────────┐
│     Personal Agent Runtime    │
│ Goal / Plan / State / Policy  │
└──────┬────────┬────────┬──────┘
       │        │        │
       ▼        ▼        ▼
    Memory    Skills    Tools
       │                  │
       └────────┬─────────┘
                ▼
      Human Approval Layer
                │
                ▼
       Model Gateway / Router
                │
       ┌────────┴────────┐
       ▼                 ▼
NVIDIA Nemotron     Other Models
       │
       ▼
Nebius Token Factory / AI Cloud
                │
                ▼
          Execution Result
                │
                ▼
          Audit + Memory
```

## 3. Core Runtime Components

### Personal Agent Runtime

Responsible for:

- accepting a user goal,
- gathering context,
- maintaining execution state,
- invoking planning,
- selecting Skills and Tools,
- enforcing approval requirements,
- observing results,
- deciding whether to re-plan,
- completing or failing explicitly.

### Memory

Responsible for:

- session context,
- user preferences,
- task history,
- long-term memory,
- sensitive-memory classification,
- execution-history retrieval.

### Planner

Responsible for converting goals into steps.

A plan must remain inspectable and should support update or replacement after new observations.

### Skill Registry

A Skill should define:

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

### Tool Registry

Tools must expose explicit interfaces and permissions.

Tools must not bypass runtime policy.

### Approval Layer

Approval is a first-class runtime state, not a UI-only confirmation.

Typical states:

```text
NOT_REQUIRED
PENDING
APPROVED
REJECTED
EXPIRED
```

### Model Gateway

All model-provider calls should pass through a provider abstraction.

### Model Router

The router selects models based on policy and runtime constraints.

### Audit

Audit records should capture:

- execution id,
- user goal,
- plan version,
- model/provider,
- tool invocations,
- approval transitions,
- result,
- failure,
- timestamps.

## 4. Execution State Model

Recommended high-level states:

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

## 5. API and Schema Rule

Any public contract change must update, together where applicable:

```text
Implementation
+ Schema
+ Tests
+ Documentation
```

Legacy `agex` identifiers must not be globally renamed without checking all contract dependencies.

## 6. Failure Handling

NAgex should distinguish:

- model-provider failure,
- tool failure,
- authorization failure,
- approval rejection,
- invalid plan,
- timeout,
- partial execution.

Fallback behavior must never bypass security or approval policy.

## 7. Observability

The runtime should make visible:

- current execution state,
- selected model,
- current plan step,
- tool activity,
- approval status,
- completion or failure reason.

This visibility is important both for users and for the hackathon demo.
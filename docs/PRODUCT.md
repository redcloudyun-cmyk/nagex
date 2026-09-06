# NAGEX Product Specification

## 1. Product Name

**NAGEX — Next-generation Agent Experience**

## 2. Product Statement

NAGEX is a personal AI agent system designed to remember useful context, reason about user goals, select reusable skills and tools, request approval for consequential actions, execute real tasks, and preserve an auditable history.

NAGEX is not intended to be only:

- a chatbot,
- a prompt wrapper,
- a static workflow builder,
- or a generic enterprise AI platform.

## 3. Primary User Value

The product should reduce repeated instruction and manual task coordination.

The desired experience is:

```text
The user explains the goal once
→ NAGEX understands context
→ NAGEX creates a plan
→ NAGEX selects skills and tools
→ NAGEX asks only when approval is necessary
→ NAGEX executes
→ NAGEX explains what happened
→ NAGEX remembers useful outcomes
```

## 4. Core Capabilities

### Persistent Memory
Retain useful user context across sessions with explicit user control.

### Planning
Transform goals into observable and revisable execution plans.

### Skills
Represent reusable domain capability as explicit, inspectable Skills.

### Tools
Access external capabilities through controlled tool interfaces.

### Human Approval
Require explicit approval for consequential external actions.

### Execution
Perform real tasks and expose state, result, failure, and recovery.

### Model Routing
Select suitable models based on task capability, latency, cost, context size, reliability, and policy.

### Auditability
Preserve enough information to understand what the agent attempted and why.

## 5. Core UX Principles

1. **Goal-first** — The user should start from a goal, not internal implementation details.
2. **Visible agency** — Planning and execution state should be understandable.
3. **Approval before consequence** — The user should know what will happen before sensitive actions.
4. **Memory with control** — The user must be able to inspect and remove retained memory.
5. **Truthful UI** — Mock, planned, and live states must not be visually conflated.
6. **Minimal interruption** — Approval should be requested only when policy requires it.
7. **Recoverable execution** — Failure should support retry, fallback, or re-planning where appropriate.

## 6. Product Boundaries

NAGEX may support multi-user or tenant-aware infrastructure where inherited code already provides useful foundations, but the product experience for the hackathon should remain centered on Personal AI and agentic execution.

Broad marketplace, enterprise governance, advanced billing, or unrelated platform features are secondary unless they directly support the hackathon experience.

## 7. Target Demo Experience

A successful demo should show a user providing a goal and NAGEX performing a real execution loop:

```text
Goal
→ Context / Memory
→ Plan
→ NVIDIA/Nebius reasoning path
→ Skill / Tool selection
→ Approval if required
→ Execution
→ Result
→ Audit / Memory
```

At least one meaningful part of this path must use real Nebius and NVIDIA infrastructure.

## 8. Product Success Criteria

The product is stronger when judges can clearly see:

- why persistent context matters,
- how the agent decides what to do,
- where NVIDIA and Nebius are used,
- what external action is being performed,
- when human approval is required,
- and how NAGEX differs from a simple LLM chat interface.
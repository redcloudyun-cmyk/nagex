# NAgex MASTER SPECIFICATION

> **NAgex — Next-generation Agent Experience**

**Document Role:** Level 0 / Single Source of Truth  
**Project Start:** 2026-09-05  
**Project Type:** Independent hackathon project  
**Target Event:** Nebius x NVIDIA Global AI Hackathon

## 1. Product Definition

NAgex is a Personal AI and Agentic AI system designed to remember user context, reason about goals, use tools, execute real-world tasks, and keep meaningful actions under human control.

NAgex is not defined as a generic chatbot or a simple LLM wrapper.

```text
User Intent
   ↓
Context + Persistent Memory
   ↓
Planning / Reasoning
   ↓
Skills + Tools
   ↓
Human Approval when required
   ↓
Execution
   ↓
Result + Audit
   ↓
Memory / Learning
```

## 2. Brand

**Name:** NAgex  
**Meaning:** Next-generation Agent Experience

> A personal AI agent that remembers, reasons, uses tools, and acts with human-controlled autonomy.

NAgex must be presented as an independent product.

## 3. Project Origin

NAgex was created as an independent project on 2026-09-05.

The initial repository was bootstrapped from an earlier internal experimental AI platform codebase owned by the same entrant. That prior codebase is used only as a technical starting point.

From the NAgex root commit onward:

- Product decisions belong to NAgex.
- Branding belongs to NAgex.
- Hackathon implementation belongs to NAgex.
- Architecture may diverge from the earlier experimental project.
- NAgex must not be presented as a previously released commercial product.
- NAgex must not conceal the fact that an internal experimental codebase was used as its initial technical foundation.

## 4. Hackathon Objective

NAgex is being developed for the Nebius x NVIDIA Global AI Hackathon.

The hackathon implementation must demonstrate real use of required Nebius and NVIDIA technologies rather than documentation-only integration.

Target integration areas:

- NVIDIA Nemotron models
- Nebius Token Factory
- Nebius AI Cloud
- Agent reasoning
- Tool execution
- Persistent memory
- Human approval
- Model routing
- Auditable execution

Features that are planned but not yet implemented must never be described as completed.

## 5. Core Product Capabilities

### 5.1 Persistent Memory
NAgex should retain useful user context across interactions. Memory must distinguish session context, user preferences, task history, long-term memory, sensitive data, and agent execution history. Memory must be inspectable and controllable by the user.

### 5.2 Agent Planning
NAgex must transform an objective into executable steps.

```text
Goal
→ Analyze
→ Plan
→ Select Skill / Tool
→ Execute or Request Approval
→ Observe Result
→ Re-plan when necessary
→ Complete
```

### 5.3 Skills
Reusable capabilities should be explicit Skills with name, description, permissions, input/output contract, required tools, safety level, and execution policy.

### 5.4 Tools
Tools provide controlled access to capabilities such as web, files, code execution, APIs, search, browser, and user-authorized integrations.

### 5.5 Human Approval
Meaningful external-impact actions must support human approval, including external messaging, data modification, financial actions, destructive operations, permission changes, and sensitive data transfers.

### 5.6 Execution
Each execution should preserve goal, plan, selected model, tool calls, approval state, result, errors, timestamps, and audit information.

### 5.7 Model Routing
The Model Router should support routing based on task type, complexity, latency, context length, cost, model capability, availability, and failure recovery. NVIDIA/Nebius usage must remain substantive in the hackathon execution path.

## 6. Target Architecture

```text
NAgex UI
   │
   ▼
Personal Agent Runtime
   │
   ├── Memory
   ├── Planner
   ├── Skills
   ├── Tools
   └── Approval
   │
   ▼
Model Gateway / Router
   │
   ├── NVIDIA Nemotron
   └── Additional Models
   │
   ▼
Nebius Token Factory / Nebius AI Cloud
   │
   ▼
Execution Result
   │
   ▼
Audit + Memory
```

## 7. Safety and Control Principles

1. Human authority takes precedence over agent autonomy.
2. Sensitive actions require explicit policy evaluation.
3. Secrets must not be embedded in source code, logs, prompts, or public repositories.
4. Tool permissions must be explicit.
5. Cross-user and cross-tenant access is default-deny.
6. Agent actions must be observable.
7. Destructive operations must not happen silently.
8. Model failure must not bypass security policy.
9. Memory must be controllable and deletable.
10. Demo convenience must not create unsafe production defaults.

## 8. Implementation Truthfulness

Documentation, UI, README, demo video, and Devpost submission must distinguish:

- Implemented
- Partially implemented
- Prototype / Mock
- Planned

A mock must never be represented as a live integration.

## 9. Development Priorities

### Phase H1 — Separation and Foundation
- NAgex independent repository
- Independent Git history
- NAgex branding
- Remove legacy product-specific documentation
- Normalize package names and internal identifiers
- Establish NAgex documentation SSOT

### Phase H2 — Hackathon AI Core
- NVIDIA Nemotron integration
- Nebius Token Factory integration
- Model Gateway
- Model Router
- Agent planning loop

### Phase H3 — Personal AI
- Persistent memory
- Skills
- Tool registry
- Permission model
- Human approval

### Phase H4 — Demonstrable Execution
- Real tool execution
- Execution timeline
- Audit log
- Failure handling
- Re-planning
- User-visible model/provider state

### Phase H5 — Submission Productization
- Product UI
- NAgex branding
- Public repository cleanup
- Security review
- README
- Architecture documentation
- Demo scenario
- Demo video
- Devpost submission

## 10. Naming Rules

Canonical naming:

```text
NAgex
NAgex Agent
NAgex Runtime
NAgex Memory
NAgex Skill
NAgex Tool
NAgex Model Gateway
NAgex Model Router
```

Internal identifiers should eventually use `nagex`, `Nagex`, and `NAgex`.

Legacy identifiers inherited from the bootstrap codebase must be migrated deliberately with associated schemas and tests.

## 11. Source of Truth Priority

```text
MASTER.md
   ↓
AGENTS.md
   ↓
Domain documentation under docs/
   ↓
Schemas / API contracts
   ↓
Tests
   ↓
Implementation
```

Existing implementation does not override this specification merely because legacy code already behaves differently.

## 12. Definition of Done

A NAgex feature is complete only when applicable items are satisfied:

- Product behavior implemented
- Security boundary checked
- Input/output contract defined
- Error handling implemented
- Tests pass
- UI state is truthful
- Auditability exists where required
- Documentation matches implementation
- No secrets committed
- No misleading mock behavior
- Build succeeds

## 13. Core Product Statement

> **A next-generation personal AI agent experience that combines persistent memory, reasoning, reusable skills, controlled tools, human approval, and real task execution.**

This definition supersedes inherited product descriptions from the bootstrap codebase.
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

## 4. Integration Truthfulness

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
- persistent memory when only session state exists.

## 5. Recommended Demo Story

A compact demo should demonstrate one coherent user goal.

Example structure:

```text
1. User provides a goal
2. NAgex retrieves relevant memory/context
3. NAgex plans the task
4. NVIDIA/Nebius reasoning is visibly used
5. NAgex chooses a Skill / Tool
6. A consequential action triggers approval
7. User approves
8. NAgex executes the action
9. Result and audit trail are displayed
10. Useful outcome is retained in memory
```

## 6. Submission Readiness

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
- video remains within event limits.

## 7. Development Evidence

Hackathon-period work should be easy to identify in Git history.

Meaningful updates should include:

- product redefinition,
- NVIDIA/Nebius integration,
- agent runtime changes,
- personal-memory implementation,
- skills/tools,
- approval flow,
- demo-specific UX,
- tests and documentation.

## 8. Submission Positioning

Preferred positioning:

> NAgex is a new hackathon project created during the submission period and bootstrapped from an entrant-owned internal experimental codebase. The hackathon work establishes a new product identity and implements the Personal AI, NVIDIA/Nebius, memory, agent-planning, tool-execution, and human-approval direction.

Avoid describing the bootstrap source as a previous commercial NAgex product.
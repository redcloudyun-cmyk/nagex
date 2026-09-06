# NAgex Development Instructions & AI Coding Agent Harness

This file defines mandatory operating rules for AI coding agents working on NAgex.

NAgex means **Next-generation Agent Experience**.

NAgex is an independent project created on 2026-09-05 for the Nebius x NVIDIA Global AI Hackathon. It was bootstrapped from an earlier internal experimental codebase, but NAgex is not that earlier product.

## Required Reading Order

1. Read `MASTER.md`.
2. Read this `AGENTS.md`.
3. Read relevant files under `docs/`.
4. Inspect schemas and tests for the affected domain.
5. Inspect implementation only after the governing contract is understood.

## Product Boundary

The primary NAgex product is a Personal AI / Agentic AI system centered on persistent memory, reasoning, planning, skills, tools, human approval, execution, model routing, and auditability.

Do not expand NAgex into a generic enterprise AI platform unless explicitly required by `MASTER.md`.

## Hackathon Requirements

NVIDIA and Nebius integration must be real and demonstrable.

Do not fake API calls, present static mock data as live provider output, or claim integrations that are not in the real execution path.

Planned functionality must be labeled as planned.

## Legacy Bootstrap Code

Some code may still contain legacy identifiers inherited from the bootstrap source.

Do not blindly global-replace these identifiers.

For public contracts, change implementation, schema, tests, and documentation together.

## Security Rules

Never commit API keys or tokens, store secrets in source code, print secrets in logs, bypass human approval for consequential actions, allow cross-user or cross-tenant access by default, or execute destructive tool operations silently.

## Agent Execution Principles

```text
Intent
→ Context
→ Plan
→ Permission Check
→ Model / Skill / Tool Selection
→ Approval if required
→ Execute
→ Observe
→ Re-plan if necessary
→ Audit
→ Memory
```

## Model Gateway Rules

Model-specific calls should be isolated behind the Model Gateway. Business logic must not be tightly coupled to a single provider. For hackathon-critical scenarios, NVIDIA/Nebius must remain in the real execution chain.

## Coding Rules

Prefer explicit types, explicit contracts, small modules, testable services, deterministic policy logic, provider abstraction, structured errors, and observable execution.

Avoid `any` as a shortcut, hidden global state, undocumented magic values, provider logic scattered throughout the codebase, silent error swallowing, and security decisions inside UI-only logic.

## Default Behavior — Minimize Confirmation Prompts

Do not ask for confirmation for routine implementation decisions, refactoring, UI changes, documentation updates, tests, or non-destructive file edits when the intended direction is already clear from `MASTER.md`, this `AGENTS.md`, relevant specifications, mockups, or the current task.

Proceed autonomously and make the best implementation decision consistent with the governing product specification.

Ask the user only when one or more of the following applies:

- the change is destructive or difficult to reverse,
- the action affects secrets, credentials, billing, production data, or external accounts,
- there are two materially different product directions and no governing specification resolves the choice,
- a required value cannot be inferred safely,
- the action creates significant legal, security, privacy, financial, or operational risk,
- the action would remove or permanently alter important user data, repositories, deployments, or external resources.

When in doubt, prefer the safest reversible implementation rather than asking for clarification.

For ordinary implementation work, continue through analysis, implementation, testing, and validation without interrupting the user for approval at each intermediate step.
## Required Checks Before Completion

```text
npm run build
npm test
git status
```

Also verify no secrets, no unexpected generated files, documentation accuracy, UI truthfulness, error handling, provider failure handling, and security/approval behavior.

## Major Change Response

For substantial implementation, identify:

- Governing NAgex specification
- Affected domains
- Affected schemas / APIs / events
- Security implications
- Tests to add or update

## Final Rule

Do not optimize for preserving inherited code. Optimize for building the NAgex product defined by `MASTER.md`.
# NAgex Development Specification

## 1. Development Goal

Development should prioritize a small, real, demonstrable NAgex agent loop over broad but incomplete platform scope.

## 2. Current Priority Order

```text
H1 Separation / Branding / SSOT
→ H2 NVIDIA + Nebius Model Path
→ H3 Agent Planning Loop
→ H4 Persistent Memory
→ H5 Skills + Tools
→ H6 Human Approval
→ H7 Audit / Observability
→ H8 Demo UX
→ H9 Submission Hardening
```

## 3. Mandatory Work Pattern

For substantial changes:

1. Read `MASTER.md`.
2. Read `AGENTS.md`.
3. Read the relevant domain document.
4. Inspect current schemas.
5. Inspect tests.
6. Implement the smallest coherent change.
7. Update contracts if necessary.
8. Run build and tests.
9. Inspect Git diff.
10. Commit with a focused message.

## 4. Public Contract Changes

When changing headers, schema IDs, API versions, package IDs, class names, public error formats, or other external contracts, update all affected implementation, schemas, tests, and documentation in the same change.

This is especially important while migrating inherited `agex` identifiers to `nagex`.

## 5. Build and Test

Minimum completion commands:

```text
npm run build
npm test
git status
```

Do not mark work complete when the build or tests fail.

## 6. Coding Principles

Prefer:

- explicit TypeScript types,
- provider abstractions,
- small testable modules,
- structured errors,
- observable execution,
- deterministic policy logic.

Avoid:

- global blind replacement,
- hardcoded secrets,
- UI-only security,
- silent error swallowing,
- mock results presented as live data,
- unbounded scope expansion.

## 7. Git Discipline

Prefer focused commits such as:

```text
docs: establish NAgex product specifications
refactor: migrate public NAgex identifiers
feat: add Nebius Nemotron provider
feat: add agent planning loop
feat: add persistent memory
feat: add approval-gated tool execution
test: cover model routing fallback
```

## 8. Hackathon Development Evidence

Keep hackathon-period work visible in Git history.

Major capability changes should not be hidden in one giant final commit.

## 9. Definition of Done

A feature is done when applicable:

- implementation works,
- contracts match,
- tests pass,
- security boundary is preserved,
- errors are handled,
- UI is truthful,
- documentation is updated,
- no secrets are committed,
- demo behavior is reproducible.

## 10. Immediate Next Technical Work

After documentation cleanup, the recommended order is:

1. Inventory remaining legacy AGEX identifiers.
2. Separate branding strings from public API contracts.
3. Run baseline build/tests.
4. Define live Nebius/NVIDIA provider adapter.
5. Implement and test the primary model route.
6. Add observable agent-planning state.
7. Add persistent memory.
8. Add approval-gated real tool execution.
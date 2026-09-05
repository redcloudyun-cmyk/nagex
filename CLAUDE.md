# AGEX Claude Code & AI Agent Instructions

Before doing any implementation work, read:
@AGENTS.md

The instructions in AGENTS.md are the primary development rules for this repository.
Also follow the rules below.

---

## Claude-Specific Working Rules

1. Read `MASTER.md` before architectural or cross-domain changes.
2. Use `docs/INDEX.md` to locate only the specifications relevant to the current task.
3. Do not load all AGEX documents unless the task spans the entire platform.
4. Do not infer missing platform contracts from existing code alone.
5. If implementation and specification conflict, identify the mismatch before preserving legacy behavior.
6. Do not introduce a new Resource, Permission, Event, lifecycle state, or public API shape without checking the canonical specification.
7. When making a public contract change, include schema and test changes in the same task.
8. Never bypass Runtime, Model Gateway, IAM, Tenant Isolation, or Security boundaries for implementation convenience.
9. Do not replace explicit AGEX domain concepts with generic maps or `any` objects simply to move faster.
10. Prefer a narrow, specification-compliant change over a broad speculative redesign.

---

## Required Response Before Major Implementation

For substantial work, briefly identify:
- Governing AGEX specification
- Affected domain(s)
- Affected schemas/APIs/events
- Security/tenant implications
- Tests required

Then implement.

---

## Specification Gap Behavior

If a necessary contract is genuinely undefined:
- Do not silently invent one;
- Identify the missing contract;
- Propose the smallest specification-compatible option;
- Isolate any provisional implementation behind a clearly named interface or TODO.

---

## Completion Check

Before declaring a task complete, verify:
- Specification compliance
- Tenant isolation
- Permission/policy handling
- Versioning implications
- Error handling
- Observability
- Tests

# NAGEX Documentation Index

> **NAGEX — Next-generation Agent Experience**

This directory contains the canonical domain documentation for NAGEX.

`MASTER.md` remains the Level 0 product-level source of truth.  
Files under `docs/` define the major product and implementation domains.

## Reading Order

For major implementation work, use this order:

```text
MASTER.md
→ AGENTS.md
→ docs/INDEX.md
→ Relevant domain document
→ Schemas / API contracts
→ Tests
→ Implementation
```

## Documents

| Document | Purpose |
|---|---|
| `PRODUCT.md` | Product definition, user value, UX principles, product boundaries |
| `ARCHITECTURE.md` | System architecture and runtime boundaries |
| `HACKATHON.md` | Nebius x NVIDIA hackathon implementation and submission requirements |
| `PERSONAL-AI.md` | Persistent memory, personalization, context, and user control |
| `MODEL-ROUTER.md` | Model Gateway, routing policy, NVIDIA Nemotron, Nebius integration |
| `SECURITY.md` | Permissions, human approval, secrets, audit, isolation |
| `DEVELOPMENT.md` | Development workflow, implementation order, testing, release readiness |

## Documentation Status Rules

Every capability described in these documents must be classified as one of:

- **Implemented**
- **Partially implemented**
- **Prototype / Mock**
- **Planned**

Documentation must never present a planned or mocked capability as production-ready.

## Naming

Canonical product naming:

```text
NAGEX
NAGEX Agent
NAGEX Runtime
NAGEX Memory
NAGEX Skill
NAGEX Tool
NAGEX Model Gateway
NAGEX Model Router
```

Legacy bootstrap identifiers may remain temporarily inside code while migration is in progress, but they do not define NAGEX product identity.
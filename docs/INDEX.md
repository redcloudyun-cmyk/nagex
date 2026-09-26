# NAgex Documentation Index

> **NAgex — Personal AI for the Next Age**

This directory contains the canonical domain documentation for NAgex.

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
| `NAgex_Meta_Muse_Benchmark_Revised_Development_Directive_v2_20260923.md` | Muse-benchmarked hackathon roadmap amendment: demo canonicalization, permission authority, credential isolation, browser trust boundary, E2E priority |
| `NAgex_External_Benchmark_and_Integration_Guidance_20260926.md` | Consolidated guidance for Muse, Jev, Wissly, WebMCP, model providers, local LLM, developer tools, BYOK, reservation, payment, and future external references |
| `NAgex_R23.3T_Permission_Approval_Hardening_Development_Directive_20260926.md` | R23.3T permission/approval hardening directive; milestone closed after test-server certification |
| `NAgex_R23.4V_Credential_Broker_Inject_Only_Vault_Development_Directive_20260926.md` | R23.4V credential broker directive; milestone closed after full regression, browser certification, server verification, and encrypted persistence configuration |
| `PERSONAL-AI.md` | Persistent memory, personalization, context, and user control |
| `MODEL-ROUTER.md` | Model Gateway, routing policy, NVIDIA Nemotron, Nebius integration |
| `SECURITY.md` | Permissions, human approval, secrets, audit, isolation |
| `DEVELOPMENT.md` | Development workflow, implementation order, testing, release readiness |
| `DEPLOYMENT.md` | Server setup and env vars for OAuth token persistence, restart-safety notes |
| `HANDOVER.md` | Agent/developer transition documentation, recent major work, test benchmarks, operating rules |

## Current Hackathon Amendment

For work on the 2026-10-29 internal hackathon target, read:

```text
MASTER.md
→ docs/HACKATHON.md
→ docs/NAgex_Meta_Muse_Benchmark_Revised_Development_Directive_v2_20260923.md
→ docs/NAgex_External_Benchmark_and_Integration_Guidance_20260926.md
→ docs/NAgex_R23.4V_Credential_Broker_Inject_Only_Vault_Development_Directive_20260926.md
→ relevant security/product domain docs
→ implementation
```

The Muse benchmark amendment does not override frozen architecture invariants. It sets the current hackathon dependency order and trust priorities.

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
NAgex
NAgex Agent
NAgex Runtime
NAgex Memory
NAgex Skill
NAgex Tool
NAgex Model Gateway
NAgex Model Router
```

Legacy bootstrap identifiers may remain temporarily inside code while migration is in progress, but they do not define NAgex product identity.

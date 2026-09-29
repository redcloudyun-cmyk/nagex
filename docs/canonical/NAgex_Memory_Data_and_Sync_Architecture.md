# NAgex Memory, Data & Sync Architecture

**Canonical Domain:** Memory / Personal Context / Personal Data / Multi-device Sync
**Status:** CANONICAL
**Date:** 2026-09-29

## 1. Purpose

NAgex must preserve useful personal context across time and devices without turning a central service into an unnecessary plaintext warehouse of the user's private life.

Canonical data principle:

> **Capture at the edge, process locally first where feasible, minimize before sync, encrypt protected data before it leaves a trusted device, and decrypt protected content only on trusted endpoints.**

## 2. Memory Classes

NAgex distinguishes at least:

- Session Memory
- User Preference Memory
- Task/Working Memory
- Long-Term Fact Memory
- Relationship/Project Context
- Decision Memory
- Sensitive Memory
- Execution Memory

Memory types and storage schemas may evolve, but sensitivity, source provenance, scope and user control remain mandatory.

## 3. Memory Write Policy

Memory is not an unrestricted transcript dump.

A memory write should consider:

- usefulness beyond the immediate turn;
- confidence;
- provenance/source reference;
- sensitivity;
- scope;
- retention;
- user control;
- whether the information is a proposal versus established fact.

Sensitive or uncertain content must not silently become durable personal truth.

## 4. Memory Retrieval

Retrieval should be scoped to the current user, tenant/workspace where applicable, task, session and authorized purpose.

Current explicit user intent outranks stale memory.

Memory may inform reasoning; it does not grant permission to execute.

## 5. Personal Context Object

NAgex may assemble task-specific personal context from authorized sources such as:

- preferences;
- people/relationships;
- active projects;
- prior decisions;
- relevant task history;
- calendar;
- Vault/Knowledge;
- current conversation;
- connected services.

The context should be minimized to what the task needs.

## 6. Raw Data vs Derived Knowledge

NAgex distinguishes:

```text
RAW EVENT
→ exact source payload

NORMALIZED EVENT
→ structured representation

DERIVED KNOWLEDGE
→ minimal useful fact

ACTION STATE
→ task / reminder / proposal / approval / automation
```

Sync the lowest-information representation that still supports the intended experience.

Default preference:

```text
Do not sync
↓
Sync derived knowledge only
↓
Sync redacted normalized event
↓
Sync encrypted raw content only when necessary and permitted
```

## 7. Sensitivity Classes

The personal-data architecture defines:

- `S0 — LOW`
- `S1 — PERSONAL`
- `S2 — SENSITIVE`
- `S3 — SECRET`

Sensitivity influences capture, storage, sync, model disclosure, logging and retention.

`S3` must not be sent to a general remote model merely for convenience.

## 8. Local-First Safety Processing

Before external transmission, perform feasible deterministic processing at the source:

- source allow/deny policy;
- OTP/authentication-code filtering;
- sensitive-data detection;
- redaction;
- normalization;
- coarse classification;
- retention decision;
- sync eligibility decision.

Local inference may be preferred for sensitive classification/summarization where suitable.

## 9. Encryption and Device Trust

Protected synchronized payloads should be encrypted before leaving a trusted device.

The relay should be zero-knowledge or near-zero-knowledge for protected payloads where architecture permits.

Decryption occurs only on trusted endpoints.

Device trust and key lifecycle must be explicit; plaintext fallback is prohibited.

## 10. Multi-Device Consistency

Multi-device sync must preserve:

- stable object identity;
- provenance;
- version/conflict information;
- deletion/tombstone semantics where needed;
- trust scope;
- retention policy.

Conflict resolution must not silently resurrect deleted or superseded sensitive data.

## 11. Provenance

Provenance survives transformation.

A derived fact should retain enough source reference to explain where it came from and support correction/removal where appropriate.

This is especially important for memory-grounded recommendations and Daily Brief.

## 12. Retention and Deletion

Retention should vary by data class and user choice.

Deletion must propagate appropriately across canonical storage, sync state and derived structures rather than only hiding one UI record.

## 13. AI / LLM Boundary

Before model invocation:

```text
Relevant Data
→ Sensitivity / Disclosure Policy
→ Minimize / Redact
→ Eligible Model/Provider Set
→ Invocation
```

Model routing never overrides the personal-data policy.

## 14. Official Connectors and Notification Intelligence

Notification capture and official connectors are complementary:

- notification intelligence can provide broad, local event awareness;
- official connectors provide richer structured access where the user explicitly connects them.

Capture does not imply permission to execute.

## 15. Product Modes

The source architecture defines privacy modes conceptually including:

- Maximum Privacy
- Balanced
- User-Explicit Extended Sync

Exact UX labels may evolve, but the user must be able to understand and control meaningful sync/disclosure choices.

## 16. User Control

Users need appropriate ability to:

- inspect memory;
- understand why it was used;
- correct/delete memory;
- control sensitive sources;
- manage connected devices/sources;
- understand sync/privacy state.

## 17. Failure Semantics

Failure must be truthful.

Examples:

- encryption unavailable → do not fall back to plaintext;
- untrusted device → do not decrypt;
- sync unavailable → retain truthful pending/local state;
- provider unavailable → do not weaken privacy;
- missing provenance → do not present uncertain derived content as established fact.

## 18. Development Invariants

```text
SECRET_EXFILTRATION_FORBIDDEN = 1
PLAINTEXT_FALLBACK = 0
MINIMIZE_BY_DEFAULT = 1
SOURCE_CONSENT_EXPLICIT = 1
SERVER_IS_NOT_DEFAULT_PLAINTEXT_TRUST_ANCHOR = 1
PROVENANCE_SURVIVES_TRANSFORMATION = 1
APPROVAL_SAFETY_INDEPENDENT_OF_SYNC = 1
CROSS_USER_MEMORY_LEAK = 0
CROSS_TENANT_MEMORY_LEAK = 0
```

## 19. Source Provenance

Consolidated from:

- `NAGEX_PERSONAL_DATA_SYNC_ARCHITECTURE.md`
- `PERSONAL-AI.md`
- relevant Personal Workspace / Memory principles in `MASTER.md`
- current Memory/Personal Home architecture where it clarifies user-visible value

Implementation-specific storage engines and milestone statuses remain outside this durable contract.

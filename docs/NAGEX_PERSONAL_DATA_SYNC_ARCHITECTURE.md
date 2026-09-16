# NAGEX Personal Data & Device Sync Architecture

**Document ID:** NAGEX-ARCH-PERSONAL-DATA-SYNC  
**Version:** 1.0  
**Status:** MANDATORY ARCHITECTURE RULE  
**Applies To:** Mobile Companion, Desktop, Web, Sync Relay, Notification Intelligence, Communication Intelligence, Memory, Daily Brief, Important Change, Action Proposal, device-to-device sync, backups, AI/model calls, and future personal-data capabilities.

---

# 1. Purpose

NAGEX must provide one continuous personal-agent experience across mobile, desktop, web, and future devices without turning a central cloud service into a plaintext warehouse of the user's private life.

The architecture therefore adopts:

> **Local-first processing + sensitivity classification + data minimization + selective synchronization + end-to-end encryption + trusted-device decryption.**

The primary design problem is not simply where to store data. It is deciding, for each piece of information:

1. whether it should be captured at all,
2. whether it may leave the source device,
3. whether raw content is needed on another device,
4. whether a derived fact is sufficient,
5. whether a cloud relay may see plaintext,
6. how devices converge without losing user control.

---

# 2. Governing Principles

## P1 — Capture at the Edge

Mobile-originating events should be captured on the mobile device where possible.

Examples:

- Android notifications
- SMS notifications
- KakaoTalk notifications
- Telegram notifications
- Instagram/Facebook/social notifications
- shopping/delivery notifications
- bank/card notifications
- device/system events

Capture does not imply sync.

---

## P2 — Process Locally First

Before any external transmission, the source device should perform all feasible deterministic safety processing:

- app allow/deny policy
- sensitive-data detection
- OTP/authentication-code filtering
- local redaction
- source normalization
- coarse category classification
- retention decision
- sync eligibility decision

When suitable local models are available, sensitive summarization/classification should prefer on-device inference.

---

## P3 — Raw Data and Derived Knowledge Are Different Assets

NAGEX must distinguish at least:

```text
RAW EVENT
→ exact notification/message/event payload

NORMALIZED EVENT
→ structured representation of the event

DERIVED KNOWLEDGE
→ minimal useful fact inferred from the event

ACTION STATE
→ task, reminder, approval, proposal, automation state
```

Example:

```text
RAW:
"김대진 대표: 내일까지 견적서 부탁드립니다."

DERIVED KNOWLEDGE:
"김대진 대표가 내일까지 견적서 준비를 요청함"

ACTION STATE:
Task proposal: "견적서 준비" / due tomorrow
```

NAGEX should sync the lowest-information representation that still supports the intended user experience.

---

## P4 — Minimize Before Sync

Default order of preference:

```text
Do not sync
↓
Sync derived knowledge only
↓
Sync redacted normalized event
↓
Sync encrypted raw content only when genuinely necessary and user-permitted
```

Convenience is not sufficient justification for raw-data synchronization.

---

## P5 — Encrypt Before Leaving the Device

Sensitive synchronized payloads must be encrypted before leaving a trusted device.

The sync service should be designed as a **zero-knowledge or near-zero-knowledge relay** for protected payloads.

The server must not require plaintext personal content merely to perform synchronization.

---

## P6 — Decrypt Only on Trusted Devices

Plaintext protected content may be available only to explicitly trusted endpoints with valid device keys and authorization.

Cloud application servers, logging systems, analytics systems, queues, and observability systems must not implicitly gain decryption access.

---

## P7 — P2P When Practical, Relay When Necessary

Preferred sync strategy:

```text
Trusted device online together
→ direct device-to-device synchronization when practical

Devices not simultaneously reachable
→ encrypted store-and-forward relay
```

The product must not depend on permanent simultaneous connectivity.

---

## P8 — User Choice Is Per Source and Per Sensitivity

Notification access is not blanket consent to upload everything.

Users must be able to configure source applications and processing levels separately.

Example:

```text
KakaoTalk       → Redact + Sync
Telegram        → Sync
SMS             → Redact + Sync
Bank            → Local Only / Minimal Financial Event
Card            → Local Only / Minimal Financial Event
Authenticator   → Drop
```

---

# 3. Sensitivity Classes

Every captured personal event must receive a sensitivity classification before synchronization.

## S0 — LOW

Examples:

- generic delivery status
- non-sensitive application status
- public content notification

Policy:

```text
sync: allowed if user enabled source
encryption: transport + storage minimum; E2EE preferred
raw retention: short/default policy
```

## S1 — PERSONAL

Examples:

- personal messages
- social DMs
- calendar-related notifications
- ordinary work communications

Policy:

```text
sync: selective
preferred form: derived knowledge or redacted event
encryption: E2EE required
```

## S2 — SENSITIVE

Examples:

- financial transactions
- legal/contractual notifications
- highly confidential work messages
- health-related notifications
- identity-related events

Policy:

```text
raw sync: default deny
derived/redacted sync: user-policy controlled
encryption: E2EE required
cloud plaintext: forbidden
```

## S3 — SECRET

Examples:

- OTP
- authentication codes
- password-reset codes
- recovery codes
- private keys
- security tokens
- verification secrets

Mandatory policy:

```text
DROP OR LOCAL-ONLY
DO NOT SYNC
DO NOT STORE LONG-TERM
DO NOT SEND TO LLM
DO NOT LOG
DO NOT INCLUDE IN ANALYTICS
```

S3 content must not be downgraded automatically.

---

# 4. Data Flow

Canonical mobile-originated flow:

```text
Android / Mobile Source
        ↓
Notification Capture
        ↓
Source App Policy
        ↓
Sensitive Data Detector
        ↓
Local Redaction
        ↓
Normalizer
        ↓
Sensitivity Classifier
        ↓
Local Event Store
        ↓
Sync Policy Decision
        ├── DROP
        ├── LOCAL_ONLY
        ├── DERIVED_ONLY
        ├── REDACTED_SYNC
        └── ENCRYPTED_RAW_SYNC
                    ↓
              Client Encryption
                    ↓
              NAGEX Sync Relay
                    ↓
              Trusted Device
                    ↓
              Client Decryption
                    ↓
      Daily Brief / Important Change /
      Action Proposal / Search / Memory
```

---

# 5. Canonical Event Model

Conceptual model:

```ts
interface PersonalDeviceEvent {
  id: string;
  deviceId: string;

  sourceType:
    | 'NOTIFICATION'
    | 'OFFICIAL_CONNECTOR'
    | 'USER_SHARE'
    | 'DEVICE_EVENT';

  sourceApp?: string;
  sourcePackage?: string;

  category:
    | 'MESSAGING'
    | 'SOCIAL'
    | 'FINANCE'
    | 'COMMERCE'
    | 'DELIVERY'
    | 'CALENDAR'
    | 'SYSTEM'
    | 'OTHER';

  sensitivity: 'S0' | 'S1' | 'S2' | 'S3';

  syncPolicy:
    | 'DROP'
    | 'LOCAL_ONLY'
    | 'DERIVED_ONLY'
    | 'REDACTED_SYNC'
    | 'ENCRYPTED_RAW_SYNC';

  receivedAt: string;
  sourceEventId?: string;

  redacted?: boolean;
  actionable?: boolean;
  priority?: 'LOW' | 'NORMAL' | 'HIGH';

  derivedKnowledge?: Record<string, unknown>;
}
```

Raw content should be stored separately from metadata so retention and sync policies can be applied independently.

---

# 6. Sync Envelope

The relay-facing object should not expose protected plaintext.

Conceptual envelope:

```ts
interface EncryptedSyncEnvelope {
  envelopeId: string;
  tenantId: string;
  principalId: string;
  sourceDeviceId: string;
  targetScope: 'USER_DEVICES' | 'SPECIFIC_DEVICE';

  objectType: string;
  objectId: string;
  version: number;

  ciphertext: string;
  nonce: string;
  keyId: string;

  createdAt: string;
  expiresAt?: string;
}
```

The relay may retain only the minimum routing metadata necessary.

Metadata leakage must be treated as a privacy concern; identifiers, source app names, message subjects, sender names, and financial amounts must not be exposed as routing metadata unless strictly required.

---

# 7. Device Trust and Key Architecture

NAGEX must treat device trust as a first-class security boundary.

Minimum requirements:

- unique device identity
- device registration
- user-visible trusted-device list
- explicit device revocation
- per-device keys or equivalent protected key material
- no plaintext master key stored on the sync relay
- key rotation support
- recovery design that does not silently weaken E2EE

Preferred conceptual hierarchy:

```text
User Root Identity
       ↓
Device Authorization
       ↓
Device Key
       ↓
Data/Envelope Keys
```

OS-backed secure key storage should be used where available.

Revoked devices must lose access to newly encrypted data. Historical-data access and re-key semantics must be explicitly documented.

---

# 8. Multi-Device Consistency

Cross-device sync requires deterministic conflict semantics.

NAGEX must define behavior for:

- duplicate event ingestion
- delayed delivery
- out-of-order delivery
- offline edits
- concurrent edits
- deletion while another device is offline
- approval state changes from multiple devices

Not every domain requires CRDTs.

Use the simplest correct rule per domain:

```text
append-only events → immutable IDs + dedup
user preferences → versioned last-writer with conflict metadata
Tasks → domain-aware merge/version checks
Approvals → server/canonical atomic state machine; never last-writer-wins
Secrets → never merge implicitly
```

Approval and mutation authorization must never be resolved through casual synchronization conflict rules.

---

# 9. Provenance

Derived knowledge must retain provenance without requiring permanent retention of raw content.

At minimum record:

- source type
- source device
- source event ID/hash where appropriate
- extraction time
- transformation/redaction version
- model/version if AI was used
- confidence where meaningful

The UI should be able to distinguish:

```text
Original content available
Redacted source available
Derived fact only
Source expired/deleted
```

NAGEX must never present derived knowledge as if it were a verbatim original message.

---

# 10. Retention and Deletion

Retention must be data-class-aware.

Recommended default direction:

```text
S3 secret            → immediate drop / ephemeral only
S2 raw sensitive     → local-only, short retention unless user opts in
S1 raw personal      → configurable local retention
Derived knowledge    → policy-based retention
Action state         → retained while operationally relevant
Encrypted relay blob → TTL and deletion after delivery/retention expiry
```

Deletion must propagate using explicit tombstones/versioned deletion semantics where cross-device consistency requires it.

"Delete" must not mean only hiding an item from one UI.

Backups must obey the same classification and encryption rules as primary storage.

---

# 11. AI / LLM Boundary

No personal event is automatically eligible for an LLM merely because it was captured.

Before any model call, apply a separate **Model Disclosure Policy**.

Decision inputs include:

- sensitivity
- user settings
- model location (local vs remote)
- provider
- task necessity
- redaction feasibility

Rules:

```text
S3 → NEVER remote LLM
S2 → local model preferred; remote only under explicit permitted policy after minimization
S1 → minimized/redacted context preferred
S0 → normal policy
```

If a derived result can be produced deterministically, do not send raw content to a model unnecessarily.

---

# 12. Notification Intelligence Integration

The Mobile Companion may support broad Android notification intake, but must not treat all apps equally.

The app-selection UX should make capture scope visible and reversible.

Example:

```text
Allow NAGEX to process notifications from:

☑ KakaoTalk       Redact + Sync
☑ Messages        Redact + Sync
☑ Telegram        Sync
☑ Instagram       Derived Only
☐ Banking         Local Only
☐ Card            Local Only
✕ Authenticator   Blocked
```

A source being technically readable does not make it product-policy eligible.

---

# 13. Official Connector + Notification Duality

NAGEX should support two complementary intake tiers.

## Tier A — Notification Intelligence

Benefits:

- broad coverage
- works for many apps without provider-specific API integration
- good for event detection

Limitations:

- incomplete metadata
- truncated content
- no guaranteed history
- platform privacy restrictions
- usually cannot perform canonical provider actions

## Tier B — Official Connectors

Examples:

- Gmail API
- Google Calendar API
- Telegram Bot/API where suitable
- Slack/Teams APIs where suitable

Benefits:

- richer metadata
- canonical IDs
- more reliable synchronization
- explicit action APIs

When both are available, they must be deduplicated using provenance/source identifiers rather than creating duplicate user events.

---

# 14. Push Notifications

Push notifications sent by NAGEX must not leak sensitive plaintext onto third-party push infrastructure or lock screens unnecessarily.

Prefer generic push payloads such as:

```text
"NAGEX has an important update"
```

with protected content fetched after the trusted client unlocks/authenticates.

Highly sensitive text should not be embedded directly in push payloads.

---

# 15. Logging, Analytics, and Observability

Safety applies to operational telemetry too.

Forbidden by default:

- raw message bodies
- notification bodies
- OTP/authentication codes
- private financial details
- decrypted sync payloads
- encryption keys

Logs should use:

- event IDs
- categories
- safe reason codes
- redacted identifiers
- aggregate metrics

Crash reports must be scrubbed before external transmission.

---

# 16. Failure Semantics

Personal-data sync must fail closed.

Examples:

```text
Sensitivity classification unavailable
→ do not upload raw data

Encryption unavailable
→ do not sync protected data

Device trust cannot be verified
→ do not decrypt

Key lookup fails
→ do not fall back to plaintext

Redaction pipeline fails
→ LOCAL_ONLY / HOLD, not raw upload

Unknown source application
→ default conservative source policy
```

No "temporary plaintext sync" fallback is allowed.

---

# 17. Product Modes

The architecture should support different privacy profiles without changing the core data model.

Suggested modes:

## Maximum Privacy

- raw personal data remains on source device
- derived knowledge only syncs
- local models preferred

## Balanced

- S1 redacted/E2EE sync
- S2 derived-only by default
- S3 blocked

## User-Explicit Extended Sync

- selected encrypted raw data may sync to trusted devices
- relay still cannot decrypt

Enterprise policy may further restrict these modes.

---

# 18. Mobile/desktop UX Requirements

The user must be able to answer:

1. What is NAGEX reading?
2. What stays only on this device?
3. What is synchronized?
4. Which devices can decrypt it?
5. What was sent to an AI provider?
6. How do I stop or delete it?

Required management surfaces should eventually include:

- Notification Sources
- Privacy/Sensitivity Rules
- Trusted Devices
- Sync Status
- AI Disclosure history/settings
- Local Data & Retention

Privacy controls must not be hidden behind developer terminology.

---

# 19. Development Invariants

The following are mandatory:

## DATA-INV-001 — Secret Exfiltration Forbidden

S3/secret data must never be synchronized or sent to an LLM.

## DATA-INV-002 — No Plaintext Fallback

Encryption or trust failure must never degrade into plaintext synchronization.

## DATA-INV-003 — Minimize by Default

Raw personal content must not be synchronized when derived/redacted data is sufficient.

## DATA-INV-004 — Source Consent Is Explicit

Notification permission alone is insufficient; NAGEX source/app policy must also allow processing/sync.

## DATA-INV-005 — Server Is Not the Default Trust Anchor for Plaintext

The relay/backend must not require general access to personal plaintext to perform sync.

## DATA-INV-006 — Provenance Survives Transformation

Derived knowledge must remain distinguishable from original content.

## DATA-INV-007 — Approval Safety Is Independent of Sync

A synchronized approval record or UI state must never itself constitute authorization to mutate unless the canonical Approval/Policy execution path validates it.

---

# 20. Required Tests

Future implementation must include tests for at least:

- S3 OTP detected → never persisted/synced/model-sent
- redaction failure → raw sync denied
- encryption failure → sync denied
- revoked device → new content unavailable
- unknown device → decryption denied
- duplicate mobile notification → one normalized event
- notification + official connector duplicate → one logical event
- out-of-order sync → deterministic final state
- deletion propagation
- relay sees ciphertext, not protected plaintext
- logs contain no protected content
- remote LLM policy denies S3
- approval cannot be forged through synced state
- offline source device eventually syncs permitted events

---

# 21. Implementation Sequence

This document defines architecture now; implementation may be staged.

## Stage A — Foundation

- PersonalDeviceEvent model
- sensitivity classifier interface
- source/app policy
- local event store
- OTP/secret hard-block rules
- sync-policy enum

## Stage B — Android Mobile Companion

- NotificationListenerService
- app allowlist
- local redaction
- local privacy UI
- local-only event timeline

## Stage C — Secure Multi-Device Sync

- device identity/trust
- key management
- E2EE envelope
- encrypted relay
- dedup/version handling
- device revocation

## Stage D — Agent Integration

- Important Change
- Daily Brief
- Action Proposal
- memory/knowledge derived from permitted events
- source provenance UI

## Stage E — Official Connectors / Enrichment

- connector dedup
- richer canonical metadata
- provider actions through existing approval gates

---

# 22. Non-Goals / Prohibited Shortcuts

This architecture does NOT permit:

- collecting every notification merely because Android permission exists
- uploading all notification plaintext to simplify development
- storing encryption keys next to server ciphertext in a way that nullifies E2EE
- treating a cloud database as the canonical plaintext personal memory by default
- sending financial/secret raw data to arbitrary LLM providers
- bypassing NAGEX Approval/Policy because a request came from a trusted device
- packet interception or reverse-engineered app traffic as the primary integration strategy

---

# 23. Completion Gate for Personal-Data Features

Any feature touching mobile notifications, personal communications, device sync, E2EE, or sensitive personal events must report:

```text
================================================
NAGEX PERSONAL DATA SAFETY GATE
================================================
Source/app policy defined             YES
Sensitivity classification defined    YES
S3 handling                            DROP / LOCAL_EPHEMERAL
Raw sync required?                     YES / NO
Minimization justification             DECLARED
Encryption before sync                 PASS / N/A
Trusted-device check                   PASS / N/A
Plaintext fallback exists?             MUST BE NO
Remote-LLM disclosure policy tested    PASS / N/A
Logging redaction                      PASS
Retention/deletion policy              DECLARED
Provenance preserved                   PASS
Approval integrity unaffected          PASS
New technical debt                     DECLARED
------------------------------------------------
PERSONAL DATA GATE RESULT               PASS / FAIL
================================================
```

If `PERSONAL DATA GATE RESULT=FAIL`, the feature must not be reported as complete.

---

# 24. Governing Rule

> **NAGEX should synchronize user capability and useful knowledge, not indiscriminately synchronize the user's private life. Raw personal data stays at the edge unless there is a specific, user-authorized reason for it to leave. Anything that leaves a device is minimized first and protected before transit. Secrets stay local.**

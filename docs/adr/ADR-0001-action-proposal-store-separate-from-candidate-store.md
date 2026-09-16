# ADR-0001 — ActionProposalStore is a separate store from CandidateStore

**Status:** Accepted
**Date:** 2026-09-16
**Related:** R11 (Proactive Action Suggestions), R10/R10.1 (Daily Brief, change detection)

## Decision

R11 introduces `src/assistant/action-proposal.store.ts` (`ActionProposalStore`) as a new, independent persistent store, rather than extending the existing `CandidateStore` (`src/workspace/candidate.store.ts`) with new candidate types for reschedule/reply/review proposals.

## Reason

`CandidateStore` and `ActionProposalStore` model two different real-world objects that only superficially look alike (both are "a suggestion the human reviews").

| | CandidateStore | ActionProposalStore |
|---|---|---|
| Identity key | `captureId` (Quick Capture pipeline) | `date` + `sourceType` + `sourceId` + `proposalType` (Daily Brief change) |
| Origin | Unified Capture understanding (text/URL/PDF/audio) | R10.1 `detectMeaningfulChanges()` output |
| Types | Fixed: `TASK` / `CALENDAR` (create only) / `MEMORY` / `KNOWLEDGE` | `CALENDAR_RESCHEDULE` (update, not create) / `EMAIL_REPLY_DRAFT` / `CREATE_TASK` / `FOLLOW_UP` / `REVIEW_APPROVAL` / `CREATE_AUTOMATION` |
| Execution owner | `CandidateActionResolver` (single resolver, dispatches by `type`) | `action-proposal-executor.ts` (dispatches by `proposalType`) |
| Dedup identity | `semanticIdentity()` — hash of `captureId::contentHash::type::normalized text` | `dedupeKey` — `proposal:{tenant}:{principal}:{date}:{sourceType}:{sourceId}:{proposalType}` (§9) |
| Re-run behavior | Re-processing the same capture refreshes a still-PROPOSED candidate | Re-generating the same Daily Brief day is a no-op once a proposal for that exact change already exists |

Forcing proposals into `CandidateStore` would have required:

1. Adding a `captureId` to every proposal despite it never originating from a Capture — either faking one or making the field optional and load-bearing-only-sometimes, which weakens the one invariant that makes `CandidateStore.upsert()`'s semantic-identity dedup correct today.
2. Adding `CALENDAR_UPDATE`/`EMAIL_REPLY` variants to `CandidatePayload`'s discriminated union, which `CandidateActionResolver.executeCalendar()` currently assumes is always a *create* (`requestCreateEventApproval`/`executeCreateEvent`) — an update path would need a second branch keyed on a field that doesn't exist on the type today, risking a regression in the already-shipped, already-tested Capture → Candidate → Task/Calendar/Memory/Knowledge flow.
3. Coupling two independently-evolving features (Unified Capture triage, Daily Brief proactive suggestions) through one shared persistence/execution module, so a change meant for one could silently affect the other.

A new, sibling store with its own narrow lifecycle (`PROPOSED → APPROVED/REJECTED → EXECUTING → COMPLETED/FAILED/EXPIRED`) keeps both features independently testable and evolvable, while still **reusing the execution runtime** (`TaskStore.create()`, `GoogleCalendarService.requestRespondToEventApproval()`/`executeRespondToEvent()`, `ActionApprovalStore`) exactly as `CandidateActionResolver` does — the duplication is in the *proposal record shape and dedup key*, not in the *mutation path*.

## Required behavior

- `ActionProposalStore` MUST use the same `FileRecordStore` persistence primitive as every other durable store in this codebase (`DailyBriefStore`, `ActivityStore`, `TaskStore`, `PersistentActionApprovalStore`) — no new persistence mechanism.
- `ActionProposalStore` mutating methods MUST be tenant/principal ownership-gated with the same `requireOwned()`-style pattern `ActionApprovalStore`/`CandidateStore` already use.
- A proposal's execution MUST route through an already-existing, already-approval-gated service method (`TaskStore.create()`, `GoogleCalendarService.request*/execute*`) — never a new adapter call, never `CapabilityBroker` bypass beyond what `CandidateActionResolver` already does for the same underlying capability (see DEBT-0001).

## Forbidden behavior

- `action-proposal-executor.ts` MUST NOT import `src/modules/calendar/calendar.client.ts` or `src/modules/gmail/gmail.client.ts` directly (enforced by `tests/google_modules_boundary.test.ts` test 11, which already covers all of `src/`).
- `ActionProposalStore` MUST NOT be merged into `CandidateStore` in a future refactor without also resolving the `CandidateActionResolver.executeCalendar()` create-only assumption above; doing so silently would risk a regression in the Capture flow.

## Assumptions

- The two features' dedup identities (`captureId`-based vs `date+sourceType+sourceId+proposalType`-based) will remain structurally different for the foreseeable future, because Quick Capture and Daily Brief change detection have genuinely different notions of "the same suggestion recurring."

## Consequences

- Two stores, two executors, two HTTP route families (`/api/v1/candidates/*`, `/api/v1/action-proposals/*`) exist side by side, both ultimately funneling into the same underlying `TaskStore`/`GoogleCalendarService`/`GmailService`/`ActionApprovalStore`. This is accepted duplication at the *proposal-record* layer, not at the *mutation* layer.
- If a third proposal-like feature is added later, this ADR should be revisited to decide whether a shared "reviewable suggestion" base abstraction is now worth the coupling risk described above.

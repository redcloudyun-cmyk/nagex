# ADR-0002 — GoogleCapabilityExecutionPipeline (DEBT-0001 closure)

**Status:** Accepted
**Date:** 2026-09-16
**Related:** R10.2-B (Google Capability Execution Pipeline / Safety-Harness Enforcement), DEBT-0001, R11 (Action Proposals), R9/R10 (Daily Brief)

## Decision

Introduce one canonical `GoogleCapabilityExecutionPipeline` (`src/capabilities/google-capability-execution-pipeline.ts`) and a declarative `MutationCapabilityDefinition` registry (`src/capabilities/mutation-registry.ts`, assembled by `src/capabilities/google-mutation-registry.ts`) that every Google mutation capability — Calendar `create/update/cancel/respond_to_event`, Gmail `send_email/reply/create_draft` — now flows through. `GoogleCalendarService` and `GmailService` each own one pipeline instance via **composition** (a private field constructed in their own constructor from their existing dependencies), not inheritance.

## Why composition, not inheritance

The directive itself instructed against a `GoogleBaseService` superclass unless the repository architecture proved inheritance clearly superior. It doesn't, for three concrete reasons observed while reading the pre-refactor code:

1. `GoogleCalendarService` and `GmailService` have genuinely different constructor shapes only in the sense of what they close over (Calendar's `formatScheduledFor`, Gmail's `normalizePayload`/email-list validation) — an inheritance hierarchy would need either an abstract method per capability-specific validator (turning the base class into exactly the kind of generic-payload-aware object §9 explicitly forbids) or a second escape hatch back down to the subclass, which is composition wearing an inheritance costume.
2. Both services already had, and keep, other real dependencies (`MemoryEngine` for post-success hooks, `ExecutionStore`, `AuditLogger`) that are naturally passed to a constructed collaborator, not natural candidates for base-class fields a subclass silently inherits.
3. A future Drive/Docs integration (see "Extension rule" below) needs the pipeline and nothing else about Calendar or Gmail — composition means it depends on one focused class; inheritance would mean depending on (or awkwardly not depending on) a base class shaped by two earlier, unrelated services.

## Canonical mutation path

```text
Caller (server_web.ts route / CandidateActionResolver / action-proposal-executor.ts / ExecutingTaskRunner via CapabilityBroker)
  ↓
GmailService / GoogleCalendarService   (capability-specific payload validation, toolId dispatch)
  ↓
GoogleCapabilityExecutionPipeline.requestApproval() / .execute()
  ↓
ActionApprovalStore  (request → approve/reject → consume: ownership-bound, tamper-hash-checked, one-time-use)
  ↓
GoogleOAuthTokenStore.getValidAccessToken()  (fail-closed: null, never throws)
  ↓
ExecutionStore  (started → succeeded/failed, durable)
  ↓
Provider client (calendar.client.ts / gmail.client.ts — the real Google HTTP call)
  ↓
AuditLogger  (tool.execution.started / .succeeded / .failed, approval.requested / .approved / .rejected)
  ↓
(only on success) capability-specific afterSuccess hook (MemoryEngine)
```

This matches INV-001's spirit — no mutation reaches the provider client without first proving a real, hash-verified, one-time-use, tenant/principal-bound `ActionApprovalStore` approval — while being honest that it does **not** route through `CapabilityBroker`/`PolicyDecisionPoint` (see "What remains open" below; this is DEBT-0001's honest closure condition, not a claim of a fuller chain than what exists).

## What stays service-specific (never moved into the pipeline)

Per the directive's §8/§9, the pipeline is deliberately payload-blind:

- **Payload validators** (`assertValidPayload`, `assertValidUpdatePayload`, `assertValidCancelPayload`, `assertValidRespondPayload` in `google-calendar.service.ts`; `assertValidGmailPayload`, `normalizePayload`, the reply-requires-thread check in `gmail.service.ts`) stay exactly where they were, unchanged, and are referenced by each service's own `MutationCapabilityDefinition.validatePayload`.
- **Provider execution** (`createCalendarEvent`/`updateCalendarEvent`/`cancelCalendarEvent`/`respondToCalendarEvent`/`sendGmailMessage`/`createGmailDraft`) stays in each module's `*.client.ts`, invoked only via the `executeProvider` callback the pipeline receives — the pipeline never imports a client file directly (enforced by `tests/google_modules_boundary.test.ts` test 11 and `tests/google_capability_execution_pipeline.test.ts` test 17).
- **Post-success memory behavior** (`MemoryEngine.proposeMemory`/`activateMemory`) stays in each service's `afterSuccess` hook — Calendar and Gmail write structurally different memory statements, and forcing one generic string builder was explicitly out of scope (§12).
- **Audit detail field names**: Calendar's pre-existing `externalEventId` audit key (vs. Gmail's `externalId`) was preserved exactly via `MutationCapabilityDefinition.successExternalIdAuditKey` rather than silently unified — an already-shipped, externally-observable audit contract must not change as a side effect of a refactor.

## Approval consume ordering (unchanged, now centralized)

`execute()` preserves the exact pre-refactor order: validate payload → audit `tool.execution.started` → resolve OAuth token (fail closed, audited on failure) → `ActionApprovalStore.consume()` (hash-checked, one-time-use, synchronous w.r.t. the event loop — no `await` between the check and the `CONSUMED` write) → `ExecutionStore.start()` → real provider call → `ExecutionStore.succeed()`/`.fail()` + audit → (success only) `afterSuccess`. `tests/google_capability_execution_pipeline.test.ts` test 6 proves two concurrent `execute()` calls on the same approval result in exactly one provider call, never two.

## Fail-closed behavior

Every one of INV-002's forbidden fallbacks was checked against the pipeline and is absent: no implicit approval, no silent bypass, no direct provider access from outside a service, no best-effort mutation, no retry-without-request, no execution under missing tenant/principal/approvalId (`MUTATION_CONTEXT_INCOMPLETE`), no treating a consumed-then-failed approval as retryable. See the R10.2-B Safety Harness report for the full test-by-test evidence.

## The §12 bug this refactor fixed

Before this refactor, `GoogleCalendarService.executeWrite()`/`executeCreateEvent()` and `GmailService.executeCompose()` each called `MemoryEngine.proposeMemory()`/`.activateMemory()` **inside the same `try` block** that governed provider-call failure. If the memory write threw *after* a real, already-`ExecutionStore.succeed()`-recorded external mutation, the shared `catch` block called `ExecutionStore.fail()` over the already-succeeded record and re-threw — reporting a genuinely successful Google write as a failure. `GoogleCapabilityExecutionPipeline.execute()` moves the post-success hook entirely outside the failure-classifying `try/catch`: a hook failure is caught, logged (`nagex_mutation_after_success_hook_failed`), and never allowed to alter the truthful `SUCCEEDED` result or the durable execution record. `tests/google_capability_execution_pipeline.test.ts` test 12 is a direct regression test for this fix.

## Read vs. mutation distinction

Read-only Google operations (`GoogleCalendarService.getFreeSlots`/`.listUpcomingEvents`, `GmailService.search`/`.readThread`) use only `GoogleCapabilityExecutionPipeline.resolveAccessToken()` — the same fail-closed token resolution mutations use — and never touch `ActionApprovalStore`, `ExecutionStore`, or the mutation registry. Read capabilities are structurally incapable of reaching `execute()`; there is no shared code path that could accidentally require approval for a read or skip approval for a write.

## What remains open (honestly, not silently)

This pipeline does **not** route through `CapabilityBroker`/`PolicyDecisionPoint` — it is the same category of direct-to-service call `CandidateActionResolver` and the `POST /api/v1/approvals` HTTP dispatcher already made before this refactor, now just funneled through one shared chokepoint instead of two duplicated ones. DEBT-0001 is closed on the basis that Google mutation paths now traverse one canonical boundary with proven approval integrity and fail-closed behavior — not on the basis that a `CapabilityBroker`+`PolicyDecisionPoint` layer now sits in front of it, which it does not. If a future milestone wires `CapabilityBroker`/`PolicyDecisionPoint` in front of Google mutations generally, this pipeline is the natural single point to attach that check to (inside `execute()`, before the OAuth resolution step) rather than something to route around.

## Extension rule for future Google write integrations (Drive/Docs, etc.)

A future Google Drive/Docs (or any other Google-provider) mutation MUST:

1. Define its own `MutationCapabilityDefinition` (own `toolId`, own `validatePayload`, own disconnected error code/message) inside its own owning module — never inside `google-capability-execution-pipeline.ts` or `mutation-registry.ts`.
2. Export that definition list through its module's public `index.ts` only, and add it to `google-mutation-registry.ts`'s `buildMutationRegistry([...])` call.
3. Construct one `GoogleCapabilityExecutionPipeline` instance (composition, in its own constructor) and call `.requestApproval()`/`.execute()` — never call a raw provider client function directly, never re-implement request/consume/execute/audit logic.
4. Keep any post-success side effect (memory, notifications, etc.) in an `afterSuccess` hook, never inside the mutation's own try/catch.

Doing this keeps the mutation registry and pipeline test suite (`tests/google_capability_execution_pipeline.test.ts`) as the single place new Google write integrations are proven safe, rather than each new integration re-deriving its own approval lifecycle from scratch.

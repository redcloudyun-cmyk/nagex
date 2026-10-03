# ADR-0005 — Plan ownership and update authority

**Status:** Accepted (R24.8B)
**Date:** 2026-10-03
**Related:** R24.8A (functional completion audit), MASTER §5 / §13, Trust, Identity, Privacy & Approval (§10 "models, agents, tools … are not authority")

## Context

R24.8A found that `POST /api/v1/plans` honored a client-supplied `id`, so a second user could POST another user's
plan id and take the plan over (the first user then received 404). `PUT /api/v1/plans/:id` accepted arbitrary
`status` and `steps` from the client, and anonymous callers shared a `default-tenant/default-user` namespace.

## Decision

1. **The server owns identity.** `POST` and `PUT /api/v1/plans…` require an authenticated session
   (`resolveAuthenticatedIdentity`). Anonymous requests, including ones that name a real account in
   `X-Principal-Id` / `X-NAgex-Tenant`, receive `401 AUTHENTICATION_REQUIRED`. Tenant and owner always come from the
   session record; a client-supplied id, tenantId, userId, status, createdAt or updatedAt is never read.
2. **Ids are server-generated** (`plan_<uuid>`). Because a client cannot choose an id, there is no collision to
   reveal, and POSTing an existing id simply creates a new plan for the caller.
3. **Field authority** for a stored plan:

   | Class | Fields | Who may write |
   |---|---|---|
   | SYSTEM_MANAGED | `id`, `tenantId`, `userId`, `createdAt`, `updatedAt` | server only |
   | USER_EDITABLE | `title`, `originalPrompt` (create only), descriptive step content (`step`, `title`, `reasoning`, `skill`, `tool`, `necessity`, `dependsOn`), status transitions among `DRAFT`, `READY`, `CANCELLED` | the owning user |
   | EXECUTION_MANAGED | status `IN_PROGRESS` / `COMPLETED` / `FAILED`, any step execution state, readiness, approval or result metadata, resolver-derived step fields (`resolved*`, `toolAvailability`, `executionReadiness`, `approvalRequired`, `parameters`, …) | an execution / approval path only — never a client |

   Execution-managed values sent by a client are dropped on create and rejected (`400 PLAN_STATUS_NOT_EDITABLE`) when
   they are a status on update. A plan whose status is execution-managed is locked against client edits
   (`409 PLAN_STATE_LOCKED`).
4. **Non-enumeration.** A foreign plan id and an unknown plan id are the same `404` for `PUT` (and `GET`).
5. **Scope.** Reads (`GET`) keep the legacy header identity; removing the default-principal fallback across all
   route modules is a recorded SECURITY_GATE, not part of this decision.

## Consequences

- `StoredPlanStep` (descriptive only) replaces the resolver step type in `PersistedPlan.steps`; older records on
  disk may carry extra fields, which are ignored.
- Anonymous/demo flows cannot persist plans (the plan is still shown to the user; it is simply not saved).
- Tests: `tests/r24_8b_plan_integrity.test.ts` (behavior) and `tests/r24_8b_ui_integrity_contract.test.ts` (source guard).

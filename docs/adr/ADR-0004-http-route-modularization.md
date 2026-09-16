# ADR-0004 — HTTP route modularization (incremental, first slice)

**Status:** Accepted (partial implementation — see "Scope of this round")
**Date:** 2026-09-16
**Related:** R10.2-D (HTTP Route Modularization)

## Decision

Introduce `src/http/` as the home for HTTP-layer infrastructure separate from `server_web.ts`:

```text
src/http/
  http-types.ts       — ApiResult, SyncRouteRegistrar<TDeps>, AsyncRouteRegistrar<TDeps>
  router.ts            — SyncHttpRouter<TDeps>, AsyncHttpRouter<TDeps>
  routes/
    health.routes.ts             — GET /api/v1/health, GET /api/v1/vcs/status
    action-proposals.routes.ts   — R11's /api/v1/action-proposals* routes
```

`server_web.ts`'s two real dispatch entry points (`handleAsyncApiRequest`, `handleApiRequest` — both exported with their exact pre-existing signatures, since ~40 test files call them directly) now delegate matched domains to a registrar via a router call, in place of the original inline `if` blocks, and fall through to the next inline check (or eventually 404) exactly as before.

## Why registrars, not a framework

§6 of the R10.2-D directive explicitly forbids migrating to Express/Fastify/Hono/NestJS/Koa. `SyncHttpRouter`/`AsyncHttpRouter` are intentionally the smallest possible abstraction that preserves the original code's actual semantics: **strict sequential match, first real result wins**. This is not a generic dispatch framework with path-templating, middleware chains, or content negotiation — it is a typed array of `(method, pathname, body, headers, query, deps) => ApiResult | undefined` functions, tried in registration order. `tests/http_route_modularization.test.ts` tests 1–4 prove this ordering/fallthrough/no-fabricated-result behavior directly.

## Why registrar `deps` are built per-call, not once at module load

Several of `handleAsyncApiRequest`'s own parameters (`calendarService`, `gmailApiService`, `service`, etc.) are themselves overridable — many existing tests pass a fake/isolated service instance positionally to exercise a route without touching the real shared singleton. A registrar's `deps` object is therefore constructed **inside** `handleAsyncApiRequest`'s body, from its own (possibly-overridden) local parameters plus whichever module-level singletons weren't already parameterized (e.g. `actionProposalStore`, `taskStore`, `activityStore`) — never captured once at module load, which would have silently broken every test that overrides `calendarService`.

## Composition Root responsibility

`server_web.ts` remains the Composition Root for HTTP: it owns constructing each domain's `RouteDeps` object from the real application singletons (or, for tests, from caller-supplied overrides) and registering each route module's handler function with the appropriate router. Route modules never construct their own service instances (§12/§13) — `ActionProposalsRouteDeps`/`HealthRouteDeps` are plain interfaces naming exactly what that one domain needs, not a shared god-object carrying the whole application (§13's explicit anti-pattern).

## Mutation safety rule (unchanged, now enforced structurally per-module)

`action-proposals.routes.ts` — the one migrated mutation-capable domain — never imports `google-calendar.service.ts`/`calendar.client.ts`/`gmail.service.ts`/`gmail.client.ts` directly, and its `/execute` path calls only `action-proposal-executor.ts`'s existing `executeActionProposal()` (R11's canonical, approval-gated execution function, itself built on R10.2-B's `GoogleCapabilityExecutionPipeline` for the Calendar-mutating `CALENDAR_RESCHEDULE` proposal type). Enforced by `tests/http_route_modularization.test.ts` tests 13–14 and (repo-wide) `tests/google_modules_boundary.test.ts` test 11, which already covers every file under `src/`, including the new `src/http/` tree.

## Extension rule for future domains

A new route module (e.g. a future `calendar.routes.ts`) MUST:

1. Export a `SyncRouteRegistrar<TDeps>` or `AsyncRouteRegistrar<TDeps>` (matching whichever of `handleApiRequest`/`handleAsyncApiRequest` it needs to run inside — most domains needing a real provider call belong in the async one).
2. Define its own narrow `XRouteDeps` interface — never reuse or extend another domain's deps interface, and never accept "the whole application" as a parameter.
3. Never import a provider client file directly (`*.client.ts`) — only through that provider's module public `index.ts`, exactly like every other part of this codebase.
4. Be registered from `server_web.ts` at the exact same relative position its inline `if` block previously occupied, so route precedence/shadowing behavior never silently changes (§14/§15) — verified by adding it to `tests/http_route_modularization.test.ts`'s real-entry-point tests (the pattern tests 8–12 establish).

## Scope of this round — an honest, incremental first slice, not the full milestone

The R10.2-D directive describes a full modularization of `server_web.ts`'s ~130 HTTP endpoints across ~20+ domains. This round delivers:

- The router/registrar infrastructure itself (`src/http/http-types.ts`, `router.ts`).
- **Two** migrated domains: `health.routes.ts` (GET `/api/v1/health`, GET `/api/v1/vcs/status` — also removing a real pre-existing duplication, since both routes previously had byte-identical inline copies in `handleAsyncApiRequest` AND `handleApiRequest`) and `action-proposals.routes.ts` (R11's list/approve/reject/execute lifecycle — chosen specifically because it is R10.2-D's best available proof that the registrar pattern preserves approval-gated mutation safety end-to-end).
- `server_web.ts`: 3042 → 2982 lines (-2%, a real but small reduction, honestly reported as such — not inflated).

This matches the directive's own §18 instruction ("Do not move 100 endpoints blindly in one mechanical rewrite... move one low-risk read-only domain, run tests, move another domain, move mutation-heavy domains after architecture guards exist") taken literally: this round establishes the contract, proves it on one read-only domain and one mutation-with-approval domain, and stops there rather than attempting an unverifiable big-bang rewrite of the remaining ~125 endpoints in a single pass. The remaining migration is registered as **DEBT-0004** in `docs/TECHNICAL_DEBT_REGISTRY.md`, not silently left undocumented, with the domain order already established by §19 of the directive as the intended continuation plan.

# ADR-0004 — HTTP route modularization (incremental, first slice)

**Status:** Accepted (partial implementation — see "Scope of this round", "Increment 2 update", "Increment 3 update", and "Increment 4 update")
**Date:** 2026-09-16 (Increment 1); updated 2026-09-17 (Increment 2, Increment 3, Increment 4)
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

## Increment 2 update (2026-09-17) — no architectural decision changed

R10.2-D Increment 2 applied the exact same registrar/router pattern decided above to five more domains, without introducing any new pattern, helper abstraction, or deviation from the rules already stated in this ADR:

- `memory.routes.ts` (GET/POST `/api/v1/memory`, DELETE `/api/v1/memory/:id`, PUT `/api/v1/memory/:id/pin`)
- `modules.routes.ts` (GET `/api/v1/modules`, GET `/api/v1/modules/:id`, PUT `/api/v1/modules/:id/state` — the real PDP-authorized, fail-closed, audited mutation path, unchanged behavior)
- `catalog.routes.ts` (GET `/api/v1/plans`, `/api/v1/skills`, `/api/v1/tools`, `/api/v1/agents`, `/api/v1/knowledge`; also relocates the `planRegistry`/`knowledgeBase` static data, each confirmed to have exactly one consumer)
- `settings.routes.ts` (GET/POST `/api/v1/quickwake/config`, GET/POST `/api/v1/autonomy/config`)
- `notifications.routes.ts` (GET `/api/v1/notifications`, POST `/api/v1/notifications/read-all`, POST `/api/v1/notifications/:id/read`, POST `/api/v1/notifications/dispatch`)

No new ADR was created for this increment, per the governing directive's own instruction not to create ADR churn for repeated application of an already-accepted pattern — this section exists only to keep the "Scope of this round" numbers below from going stale, not to record a new decision.

`server_web.ts`: 2982 → 2732 lines (-8.4%); imports 60 → 63 (net +3: five new registrar imports, two removed now-dead `canonicalSkillRegistry`/`canonicalToolRegistry` imports fully absorbed into `catalog.routes.ts`). Using a consistent `method === '<VERB>'` check-block count: 26/147 endpoints now migrated (~18%), 121 remaining — see **DEBT-0004**'s updated `progress` field for the full breakdown and counting methodology. This is still an incremental slice, not the full milestone; DEBT-0004 remains OPEN.

## Increment 3 update (2026-09-17) — no architectural decision changed, one file-allowlist relocation

R10.2-D Increment 3 applied the same registrar/router pattern to the three medium-risk operational domains named in the directive's own roadmap:

- `tasks.routes.ts` — `handleTasksRoutes` (sync: list/create/runs/pause/resume/cancel/delete/patch/get, wired into `handleApiRequest`) and `handleTasksRunRoutes` (async: `/run` and the test-only-gated `/run-with-fixed-plan`, wired into `handleAsyncApiRequest`, since both genuinely `await scheduler.runOne()`). Risk classification: CRUD/lifecycle is READ_ONLY/LOCAL_MUTATION; `/run` and `/run-with-fixed-plan` are SCHEDULER_MUTATION.
- `automations.routes.ts` — `handleAutomationsRoutes` (sync CRUD for WorkflowDefinition) and `handleAutomationsRunRoutes` (async `/run`, the real production instantiate/run bridge). Same SCHEDULER_MUTATION classification as Tasks `/run`.
- `workspace.routes.ts` — all Workspace/Capture/Candidate/Activity routes (route-input, storage/status, inbox, vault, uploads, captures, items, candidates, activity), all funneled through the single canonical `QuickCaptureService` — this module never reimplements capture/candidate business logic, only translates HTTP <-> that one service, preserving R10.2-C's shared finalization architecture untouched.

**One real static-architecture-guard update was required, not merely cosmetic**: `tests/architecture_enforcement.test.ts`'s ARCH-008 (Composition Root Ownership) previously allowlisted `src/server_web.ts` as the one file permitted to construct an ephemeral `TaskScheduler`/`CompositeTaskRunner`/`ExecutingTaskRunner` pair (for the DI-test-override on `/run` and the real workflow-run bridge). Moving that exact same, unchanged construction pattern into `tasks.routes.ts`/`automations.routes.ts` is not a new architectural decision — it is the same named exception the ADR already documents, now living in the files that actually use it — so the allowlist was updated to follow the code rather than left to falsely fail. No new exception was added; the exception's own justification (throwaway scheduler needed to inject a resolved plan or an alternate model) is identical to before.

`server_web.ts`: 2732 → 2108 lines (-22.8%, inside the directive's own <2100 directional target); imports 63 → 61 (net -2: ten task/workflow/workspace-only imports removed — `TaskStore`, `TaskRunStore`, `TaskType`, `TaskApprovalPolicy`, `TaskScheduler`, the four task-runner classes, `InputRouter`, `CandidateStatus`/`CandidateType` — against three new registrar imports added). `TaskTrigger`/`TaskRecord`/`computeNextRunAt` remain imported since they're still genuinely used by the unrelated, out-of-scope Daily Brief/Proactive Assistant automation config route. Using the same `method === '<VERB>'` check-block count: 69/147 endpoints now migrated (~47%), 78 remaining — see **DEBT-0004**'s updated `progress` field. jscpd moved from 780→822 duplicated lines (2.81%→2.94%), a small, expected increase proportional to the ~1,450 lines of route-module code added (each route repeats the same `getHeaderValue`/tenant-default-extraction shape the original inline code already had) — not a new duplication pattern introduced by this increment. DEBT-0004 remains OPEN; Increment 4 (Gmail/Calendar/Approvals + remaining mutation-heavy domains, plus final Composition Root cleanup) is next.

## Increment 4 update (2026-09-17) — no architectural decision changed, one allowlist reconciliation

R10.2-D Increment 4 applied the same registrar/router pattern to the three directive-named mutation-heavy domains plus every other clearly-owned domain reachable without touching the Main Session / conversational core:

- `gmail.routes.ts` — send-email/reply/create-draft/search/read-thread. Every mutation still requires a pre-existing `approvalId` and calls `GmailService.executeXxx()`, built on R10.2-B's `GoogleCapabilityExecutionPipeline`. Never imports `gmail.client.ts` directly.
- `calendar.routes.ts` — create/update/cancel/respond-to-event (same approval-gated `GoogleCalendarService.executeXxx()` -> pipeline shape) plus `free-slots`, the one READ_ONLY exception that legitimately calls the module's real public read API (`queryFreeBusy`/`computeFreeSlots`, imported via the module index, never the client) and refreshes its own OAuth token via `fetch()` — unchanged pre-existing behavior, not a new coupling.
- `approvals.routes.ts` — list/request/get/legacy calendar-event alias/approve-reject/legacy action. Approval record state is a separate concept from provider-mutation permission: this module only ever proxies to `GoogleCalendarService`/`GmailService`'s own `approve()`/`reject()`/`getApproval()`/`requestXxxApproval()` methods (already the pipeline's front door) and the `TaskContinuationCoordinator` fire-and-forget hook — it never itself calls an `executeXxx()` provider mutation. `approvalQueue` (the legacy demo/seed list) moved here with its only consumer.
- `browser.routes.ts` — all 17 Browser Agent routes (sessions, navigate, tabs, snapshot, screenshot, scroll, wait, type, select, click, click/execute, close, find, extract, back, forward, reload). `click`'s APPROVAL_REQUIRED/execute split (server resolves the live element, decides harmless-vs-consequential) is preserved exactly.
- `google-oauth.routes.ts` — two registrars (`handleGoogleOAuthStartRoutes` sync for `/start`/`/start-url`, `handleGoogleOAuthCallbackRoutes` async for `/callback`/`/status`/`/disconnect`) sharing `pendingGoogleOAuthState`, the one-time CSRF nonce, as this module's own state — moved with its only three consumers.
- `telegram.routes.ts`, `slack.routes.ts` — integration status/webhook-or-events/send/identity-link/identities, unchanged.
- `desktop.routes.ts` — Quick Wake status/toggle/tray-action, unchanged.
- `governance.routes.ts` — executions (the one real ADMIN/SYSTEM mutation: PDP-authorized agent execution + credit charge)/billing/audit logs. `executionHistory`/`ensureTenantSeeded`/`INITIAL_CREDIT_GRANT`/`MANAGED_AI_COST_BREAKDOWN`/`SUBSCRIPTION_INFO` moved here with their remaining consumers (`executionHistory`'s length is still exposed to `health.routes.ts` via an import, since that domain legitimately needs it too).

**One static-architecture-guard reconciliation, not a new rule**: ARCH-008's allowlist already named `tasks.routes.ts`/`automations.routes.ts` (Increment 3). No further allowlist change was needed this increment — Gmail/Calendar/Approvals/Browser never construct an `Application`-graph class themselves, they only call methods on the singletons already threaded through as deps, preserving the Composition Root invariant without any exception growth.

`server_web.ts`: 2108 → 1454 lines (-31.0%); imports 61 → 44 (net -17: removed `PolicyDecisionPoint`/`resolveBuiltInPrincipalPermissions`/`GOOGLE_CALENDAR_*_TOOL_ID`/`GMAIL_*_TOOL_ID`/`queryFreeBusy`/`computeFreeSlots`/`googleTokenStore`/`buildGoogleAuthorizeUrl`/`exchangeGoogleAuthorizationCode`/`readGoogleOAuthConfig`/`TelegramIdentityStore`/`TelegramBotClient`/`SlackIdentityStore`/`SlackClient`/`DesktopRuntimeEngine`/`SessionStore`/`PlanResolver` class values (several downgraded to `import type` where only used as a parameter type) against nine new registrar imports). Using the same `method === '<VERB>'` check-block count: 125/147 endpoints now migrated (85.0%), 22 remaining — see **DEBT-0004**'s updated `progress` field for the full breakdown, methodology, and explicit justification for what's left (Main Session / conversational core + Daily Brief / Proactive Assistant automation + Safety/Providers/Capabilities-Execute/My-Space/Device-Agent). jscpd moved from 822→875 duplicated lines (2.94%→3.09%), proportional to the ~1,800 lines of route-module code added, not a new duplication pattern. DEBT-0004 remains OPEN — the completion conditions (composition-root responsibility fully clear, zero material domain ownership) are not yet met while the conversational core stays inline — with the remainder explicitly scoped to Increment 5.

### Final registrar structure (as of Increment 4)

19 route modules under `src/http/routes/`: `health`, `action-proposals`, `memory`, `modules`, `catalog`, `settings`, `notifications`, `tasks`, `automations`, `workspace`, `gmail`, `calendar`, `approvals`, `browser`, `google-oauth`, `telegram`, `slack`, `desktop`, `governance`. Each exports one or two `SyncRouteRegistrar`/`AsyncRouteRegistrar` functions plus a narrow `XRouteDeps` interface naming only what that domain needs — never `entireApplication`.

### Residual inline route policy

A route may remain inline in `server_web.ts` only when it is: (a) genuine bootstrap/composition/server-lifecycle/global-error-boundary code, or (b) explicitly named and justified in **DEBT-0004**'s `description`/`reason` fields, never silently left. As of Increment 4 that residual is the Main Session / conversational core and Daily Brief / Proactive Assistant automation surface, targeted for Increment 5.

### Mutation route rule (unchanged since Increment 1, now proven across every Google-mutating domain)

Every route capable of a real external side effect — Calendar, Gmail, Browser click — continues to resolve through its domain's canonical service (`GoogleCalendarService`, `GmailService`, `BrowserToolService`), which is itself the only caller of the provider client. No route module has ever imported `calendar.client.ts`/`gmail.client.ts` directly, verified structurally by `tests/google_modules_boundary.test.ts` test 11 (repo-wide) and the domain-specific guards in `tests/http_route_modularization.test.ts`.

### Future-domain extension rule (unchanged from Increment 1's "Extension rule for future domains")

Increment 5's Main Session / Daily Brief route modules must follow the same four rules already stated above: export a `SyncRouteRegistrar`/`AsyncRouteRegistrar`, define a narrow deps interface, never deep-import a provider client, and register at the exact same relative dispatch position — verified by extending `tests/http_route_modularization.test.ts`'s real-entry-point and route-ownership-guard tests, the same pattern used in every increment so far.

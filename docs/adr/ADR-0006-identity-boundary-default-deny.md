# ADR-0006 — Identity boundary: server-side credentials only, default-deny routes

**Status:** Accepted (Security Gate S1)
**Date:** 2026-10-03
**Related:** Security Gate S0 audit (S0-01, S0-02, S0-07, S0-18), ADR-0005, Trust/Identity/Privacy/Approval §6 and §13, MASTER §5

## Context

S0 found that 177 of 310 HTTP routes took their caller from `X-Principal-Id` / `X-NAgex-Tenant`, falling back to the
default admin (`usr_admin_001`) and default tenant (`ten_production_01`). R24.6C only stripped headers that named a
*registered* account, so any anonymous caller could act as the default admin or as any synthetic principal/tenant, and
`usr_admin_001` / `admin` carried built-in `module:manage` authority. Separately, five copies of the session-cookie parser
called `decodeURIComponent` on the raw cookie outside the request error boundary, so a single malformed cookie terminated
the process.

## Decision

1. **Identity comes only from a server-side session.** `canonicalizeRequestHeaders()` (both HTTP entry points) returns a
   copy of the request headers with every client identity header removed and, when a valid session is presented, records
   the session's identity in a module-private `WeakMap` keyed by that copy. Routes read the caller with `callerIdentity()`
   (throws `AUTHENTICATION_REQUIRED`) / `tryGetCallerIdentity()`; a headers object that did not pass through
   canonicalization has no identity, and a copy/spread of one does not inherit it.
2. **Default deny.** `src/http/route-access.ts` lists the only routes reachable without an authenticated identity
   (`PUBLIC`, `SELF_AUTHENTICATED`, `ANONYMOUS_PRESERVED`), each with a reason. Everything else — including routes that do
   not exist yet — is answered `401 AUTHENTICATION_REQUIRED` by both entry points before any registrar runs.
3. **No default identity.** No route, store or service falls back to a default principal or tenant. The built-in admin by
   literal id is removed: `resolveBuiltInPrincipalPermissions` elevates only `system` principals and the registered user ids
   an operator lists in `NAGEX_BUILTIN_ADMIN_PRINCIPALS` (default empty). Unlinked Telegram/Slack users are isolated
   principals in their own tenant. A channel identity is linked to the authenticated caller only; a body-supplied
   `principalId`/`tenantId` is ignored.
4. **One crash-safe credential parser** (`src/http/session-credential.ts`): never throws; malformed, oversized or
   control-character credentials are "no credential". The request handler is additionally wrapped so an unexpected throw
   fails that request, never the process.
5. **Demo persona.** `X-NAgex-Demo: 1` may read an explicit allow-list of GET routes as the fixed synthetic demo persona
   (`src/demo/demo-identity.ts`). It grants no write, model, browser, Gmail or Calendar access. DemoScenarioService's
   fixture responses are unchanged.

## Consequences

- Signed-out visitors can no longer read any tenant data; the previously recorded `IMAGE_BROWSER_AUTH_DEBT` is closed.
- Tests that relied on header/default identity now sign in through the real stores (`tests/_s1_session_auth.ts`, test-only).
- Operational scripts under `scripts/nagex-*.sh` still send identity headers and need a session-aware update (not part of S1).
- Not part of S1 (later gate phases): S0-03..S0-06 (rate limit key, reactivate oracle, SSRF, channel webhook signatures),
  S0-08..S0-17, S0-19+. Notification `dispatch` still accepts a body-supplied *target* (S0-09); executions remain one global
  list (S0-08).

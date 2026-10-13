# MCP production certification

**Date:** 2026-10-13
**Branch:** `feat/agex-assets-mcp-20261013` (pushed; not merged to `main`; not deployed)

## 0. What this certifies — and what it does not

| | |
|---|---|
| Certified | NAgex's production MCP path (registration, Streamable HTTP initialization, discovery, enablement, approval-bound execution, ownership, pinning, SSRF/redirect/private-network protection, credential protection, audit, credential expiry and reconnection, removal, restart persistence) against an **isolated, repository-controlled MCP server** (`scripts/mcp-test-server.mjs`) over real HTTP **and TLS**, driven through the production routes, Capability Broker and approval store. |
| **Not** certified | Any **third-party** MCP provider. No authorized third-party HTTPS MCP server is configured in this environment (`MCP_CHECK_URL` is unset) and none was contacted. The read-only check script is ready: `MCP_CHECK_URL=https://… [MCP_CHECK_TOKEN=…] node scripts/mcp-remote-check.mjs`. |
| Not supported | **stdio** servers (they would execute processes on the API server) and **OAuth-protected** MCP servers (the client sends a static bearer token; the MCP OAuth authorization flow is not implemented). Such servers cannot be added. |
| Not proven | That the deployed test server has `NAGEX_TOKEN_ENCRYPTION_KEY` set (without it connections live in memory only — the UI says so) or that `NAGEX_MCP_ALLOW_PRIVATE_NETWORK` is unset there. |

The isolated server is a conformant Streamable HTTP server (JSON-RPC 2.0 over POST, session ids, JSON and `text/event-stream` replies, DELETE session termination, bearer auth, pagination). Certifying against it proves NAgex's client and governance behave correctly against a protocol-conformant server that this repository controls; it says nothing about any vendor's server.

## 1. The 14 completion points

| # | Requirement | Implementation | Evidence |
|---|---|---|---|
| 1 | Server registration | `McpService.addServer`, `POST /api/v1/mcp/servers`; 10 servers per user; name/URL/credential validation; nothing stored when discovery fails | `mcp_runtime` (adds a server, nothing stored on failure, limit), `mcp_e2e_isolated_server` registration tests, `connections_redesign_browser` G |
| 2 | HTTPS Streamable HTTP initialization | `McpClient.initialize` (protocol `2025-06-18`, negotiated version echoed, `Mcp-Session-Id` kept, `notifications/initialized`), JSON and SSE bodies, size/time bounded; sessions ended with `DELETE` after discovery, refresh and every approved call | `mcp_runtime` client tests; `mcp_e2e_isolated_server` (SSE, pagination, **0 live server sessions after every operation**, TLS variant incl. refusal of an untrusted certificate) |
| 3 | Tool discovery and schema validation | `parseToolDescriptor` / `validateArguments` (constrained names, sanitized descriptions, schemas limited to a checkable subset, hostile descriptors rejected not half-accepted, arguments validated **before** approval is requested) | `mcp_runtime` "tool schema validation", e2e "arguments are validated…" |
| 4 | Explicit tool enable / disable | every discovered tool starts OFF; enabling is the owner's explicit acceptance of the current definition; UI requires a confirmation with a warning | `mcp_runtime`, e2e, `connections_redesign_browser` |
| 5 | Credential encryption and redaction | AES-256-GCM at rest with `NAGEX_TOKEN_ENCRYPTION_KEY`; the credential never appears in any API response, audit event, DOM or browser storage; the UI field is cleared at once | `mcp_runtime` persistence + audit tests; e2e "file on disk is encrypted"; browser tests (no credential in DOM/storage) |
| 6 | User / tenant ownership | owner-scoped store; foreign records answer "not found"; identity only from the verified session (forged `X-Principal-Id` / tenant headers ignored) | `mcp_runtime` HTTP + ownership tests; e2e "isolation between users and tenants" (list/read/enable/invoke/spend approval/reconnect/delete all 404) |
| 7 | Server identity and tool-definition pinning | identity (server name + origin) pinned at first initialize; mismatch disables every tool; a changed definition (hash over name, description and schema) disables that tool until re-enabled; both re-checked **before an approval is spent** | `mcp_runtime`, e2e "changed definition… / identity" |
| 8 | SSRF, redirect, private-network | https only, no embedded credentials, no private/loopback/link-local/metadata/reserved address (literal, resolved and again at connect time — DNS rebinding), redirects are errors, bounded size/time, optional host allow-list (`NAGEX_MCP_ALLOWED_HOSTS`), private-network escape hatch only via `NAGEX_MCP_ALLOW_PRIVATE_NETWORK=1` (development/tests) | `mcp_runtime` "URL policy (SSRF boundary)" and client tests; production policy refusing loopback over HTTP |
| 9 | Capability Broker integration | an enabled tool is a per-user `CONSEQUENTIAL` / approval-`REQUIRED` capability (never in the global catalog); invoke goes through `CapabilityBroker.execute` only | `mcp_runtime` "execution only through the Capability Broker" |
| 10 | Approval-bound execution | first call only creates a pending approval (server sees **no** call); approval is hash-bound to the exact arguments, one-time, consumed immediately before the call; replay refused; another user cannot spend it | `mcp_runtime`, e2e "a disabled tool cannot be invoked… exactly one call", "state-changing tool… unchanged without approval" |
| 11 | Tool result verification | results are untrusted (size-capped, control characters removed, non-text content reported by type only); a tool-reported error is recorded as a **FAILED** execution; every result carries `outcome` and `verification: UNVERIFIED (MCP_PROVIDER_RESPONSE_ONLY)` — MCP gives no way to verify a side effect, so a server answer is never presented as verified completion | `mcp_runtime` "truthful outcomes", e2e "tool that reports an error…" |
| 12 | Audit and error reporting | `mcp.server_added / refreshed / reconnected / removed / tool_enabled / tool_disabled / tool_changed / identity_mismatch / server_auth_failed`, `tool.execution.started / succeeded / failed` — no credential or argument content; localized EN/KR user-facing messages for the connection errors a user can hit (rejected credential, unreachable, timeout, rate limit, protocol error, redirect, identity changed, tool changed) | `mcp_runtime` audit test; browser tests (EN/KR, no raw codes) |
| 13 | Token expiration and reconnection | a credential the server rejects (refresh or an approved call) moves the connection to `AUTH_REQUIRED` and unregisters its tools **before any approval is spent**; `POST /api/v1/mcp/servers/:id/reconnect` replaces the credential only after the server still identifies as the pinned one; a transient failure (timeout/5xx) never disables the owner's tools; UI shows Needs attention + a reconnect form | `mcp_runtime` "reconnection…", e2e "rotated credential", browser "rejected credential… reconnect" |
| 14 | Server and tool removal | tool disable unregisters the capability at once; server removal unregisters all its tools and deletes the record | `mcp_runtime`, e2e "removing a server…" |

Additional completions in this work: `NAGEX_MCP_TIMEOUT_MS` operator knob (1–60 s, default 15 s); persisted-store durability disclosed by `GET /api/v1/mcp/servers` (`durable`) and in the UI; the planner is told which tools this user enabled (`tests/mcp_planning_discovery.test.ts`).

## 2. Real-server end-to-end (isolated server) — what was driven

`tests/mcp_e2e_isolated_server.test.ts` (15 tests): registration and pinning; paged discovery + SSE; wrong credential refused and nothing stored; unauthenticated caller never reaches a server; disabled-tool rejection; approval before any server call, hash-bound, one-time, replay refused; state-changing tool unchanged without approval; schema-invalid arguments never reach approval; tool-reported error; cross-user and cross-tenant isolation; credential rotation → `AUTH_REQUIRED` → reconnect, approval not spent by the failed attempt; changed definition and identity blocking; removal; timeout (`MCP_TIMEOUT`, FAILED execution, tools stay enabled); restart persistence (encrypted file, restored for the owner only, still approval-gated after restart); `scripts/mcp-remote-check.mjs` over HTTP and over TLS (throwaway certificate trusted for that run only; the same server with the certificate untrusted is refused).

## 3. Operator checklist for the test server

1. `NAGEX_TOKEN_ENCRYPTION_KEY` set (otherwise MCP connections and Google/GitHub tokens are memory-only).
2. `NAGEX_MCP_ALLOW_PRIVATE_NETWORK` **unset**.
3. Optionally `NAGEX_MCP_ALLOWED_HOSTS` to restrict which MCP hosts users may register.
4. After deploy of this branch: `sudo systemctl restart nagex` (backend changes), then run `MCP_CHECK_URL=<authorized https server> node scripts/mcp-remote-check.mjs` from the repository root.

## 4. Remaining gates before "production ready" can be claimed

- A real third-party HTTPS MCP server, authorized by the owner, passes `scripts/mcp-remote-check.mjs` and one controlled non-destructive tool call through Settings (this is the only thing this run could not do).
- The deployed server's environment (items 1 and 2 above) is verified.

## 5. Deployment candidate (not deployed)

- Branch: `feat/agex-assets-mcp-20261013` (pushed). Behavioural head verified by the full gate: `812bc9d`; later commits on this branch are documentation only.
- Not merged into `main` and not deployed. Deploying is the owner's step: fast-forward the server checkout to this branch, `npx tsc -p .`, then `sudo systemctl restart nagex` (backend and `public/` changes), then the checks in section 3.
- Nothing in this branch changes authentication policy, approvals, or the Model Gateway; the new routes are `POST /api/v1/mcp/servers/:id/reconnect` and `GET /api/v1/connectors/catalog` (both session-required).
- Human acceptance of the Connections design remains **PENDING**.

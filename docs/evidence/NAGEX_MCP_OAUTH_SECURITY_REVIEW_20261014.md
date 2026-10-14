# NAgex MCP OAuth — independent pre-live security review
2026-10-14 · Branch: feat/mcp-oauth-discovery-20261013 · PR #13

**Review type:** source review and evidence cross-check, not a code execution or real Slack authorization.
**Decision:** GO for isolated real-provider **test planning**; NO-GO for general production activation/merge-to-main until the checkpoints below are resolved.

## Evidence verified in GitHub
- Overnight report exists: `docs/evidence/NAGEX_MCP_OAUTH_OVERNIGHT_REPORT_20261014.md`.
- Branch compares ahead of `integration/r23.7-agex-mcp-20261013`, with zero behind as inspected on 2026-10-14. This is NOT a merge certificate.
- User-provided terminal evidence: focused 80 PASS, regression 2842 PASS/8 SKIP, browser 230 PASS/6 SKIP, all FAIL=0 at source SHA 3976306. Those counts are reported, not rerun in this review.
- Slack public OAuth metadata was verified with no credentials. No authorized Slack account or actual MCP tool execution exists yet.

## Security observations

### SR-01 — High: token refresh/revocation lifecycle not production-complete
`src/mcp/mcp-oauth-runtime.ts`: `bearerFor` rejects known expired tokens, and `src/mcp/mcp.service.ts` disables tool access on reauth-needed path. Positive.
However refresh-token rotation and provider-side revocation are absent (acknowledged by overnight report). Do not sell a permanently connected Slack workspace yet. Make reauthorization/reconnect UX truthful and document issuer revocation at account disconnect.

### SR-02 — Medium / verification required: CSRF and callback browser/session linkage
`src/http/routes/mcp-oauth.routes.ts`: `POST /start` and `POST /connect` use `resolveAuthenticatedIdentity`; state is random and owner-bound, consumed once; callback uses GET and must preserve browser's session cookie. Positive.
No route-local Origin / Sec-Fetch-Site / explicit CSRF token policy appeared in the inspected handler; the HTTP layer has a CORS allowlist but CORS headers are not themselves CSRF defense. Need examine deployed cookie SameSite, all request entry points and security middleware before asserting exploitability.
**Required pre-activation test:** a browser-originated cross-site POST cannot start or reconnect an OAuth provider with a victim's session; OAuth redirect GET callback still works in intended browser flow; cross-browser/state ownership is enforced. Avoid relying only on CORS.

### SR-03 — Medium: provider-reported scopes may be absent or differ
`src/mcp/mcp-oauth-callback.ts` rejects missing scope reports and unexpected elevation before token persistence. Positive fail-closed.
Slack OAuth.v2.user.access public documentation contains `authed_user.scope`; a real response can differ from mock fixtures. First live account attempt must be supervised and examined only for **redacted scope names**, no raw tokens. Never bypass `TOKEN_SCOPE_MISMATCH` to force a green state.

### SR-04 — Medium: single-process state and local encrypted store
`src/mcp/mcp-oauth-state.ts`: states and PKCE verifiers are memory-only, expire after 10 minutes, one-time, owner-bound. `src/mcp/mcp-oauth-persistent-store.ts` provides atomic local encrypted snapshot.
A multi-process/failover deployment needs an atomic shared state store and durable multi-writer token storage, or else a verified strict single-process topology. On restart, incomplete flows legitimately fail closed. Document process topology before deployment.

### SR-05 — Medium: provider operator config and secret management
`src/mcp/mcp-oauth-providers.ts` requires opt-in `NAGEX_MCP_OAUTH_ENABLED=1`, vetted template, operator-side client ID/secret and exact HTTPS callback path. Encrypted vault requires encryption key. Positive.
Before provisioning real client secret: demonstrate restrictive file/env access, audit redaction, secrets not included in diagnostics or process commands, rotation/revocation runbook, and secret scanning in Git.

### SR-06 — Integration claims
`src/mcp/mcp.service.ts` binds OAuth to the existing McpService, verifies initialize/tools/list before `CONNECTED`, and retains disabled-by-default tool governance. Source evidence supports design intent, but no live account or provider tool call has been certified.

## Required closure gates (no invented PASS)
1. Review origin/session cookies and implement (or document with executed negative evidence) CSRF protection for OAuth start/connect; callback GET remains compatible.
2. Validate exact Slack OAuth redirect host in authorized test origin; do not provision arbitrary production client credentials or deploy first.
3. Register Slack *internal* or approved app with exact scopes and callback, under a disposable workspace with admin consent. Human must complete email/MFA/admin steps. No automated bypass.
4. One authorized real user consent and token exchange, credential store restart preservation, user/tenant isolation; redact all actual token material.
5. Authenticated `initialize` + `tools/list` with tools disabled by default; Human Approval before one read-only call.
6. Revoke/expire and disconnect negative-path certification. Document current lack of remote revoke and refresh.
7. Rerun build, focused suite, regression, browser gates at final SHA. User UI acceptance. Only then consider PR merge **into integration**, not automatic main promotion or test/production deployment.

## Recommended operational next step
Complete SR-02 with an **isolated adversarial browser/session CSRF certification** and confirm cookie/session topology. This can be done without Slack credentials; then initiate manual creation of the test Slack app/workspace.

**No main merge, deployment, service restart, account creation, provider login or external tool action was executed in this review.**

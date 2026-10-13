# NAgex — First Real MCP OAuth Provider: Slack (Read-only Preflight)
Date: 2026-10-13
Status: **CANDIDATE ONLY — NOT CONNECTED**

## Source-backed candidate
Slack's official remote MCP endpoint: `https://mcp.slack.com/mcp`.
Slack documents OAuth consent, a published protected-resource metadata location and authorization-server metadata location. Official references:
- https://docs.slack.dev/ai/slack-mcp-server/
- https://docs.slack.dev/ai/slack-mcp-server/connect-to-harnesses/
- https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-11-25/basic/authorization.mdx

Slack requires an authorized Slack workspace, applicable MCP integration approval by the workspace admin, Slack app client ID, and compatible OAuth configuration. Slack's documentation says a Marketplace-published app or an internal app is required for MCP, not an unlisted app.

## What NAgex can verify without credentials now
1. `npm run build`.
2. `node scripts/mcp-oauth-provider-preflight.mjs slack` — readonly HTTPS GET to published protected-resource metadata, using NAgex's SSRF, DNS rebinding, redirect, size and timeout safeguards.
3. If the protected resource's advertised identifier differs from the MCP URL, return BLOCKED; investigate the official canonical identifier rather than silently altering audience binding.
4. **Never** treat metadata lookup as user consent, connection or tool E2E.

## Requirements that still block real sign-in
- Provision a **NAgex-owned** Slack OAuth application with registered exact callback URI; verify app's eligibility and workspace permissions.
- Resolve actual authorization issuer and endpoints using standards-compliant discovery. Verify authorization server metadata against issuer. The current NAgex metadata parser is preparatory; the provider registry presently takes trusted operator material, not live discovered issuer metadata.
- Confirm Slack's OAuth token-exchange endpoint and its required client authentication method. Existing NAgex OAuth code implements a generic PKCE form POST **without client-secret or vendor-specific auth**. Do not incorrectly assume Slack will accept that token exchange.
- Confirm how Slack returns scopes. NAgex deliberately rejects unreported grants when it requested scopes, to prevent silent privilege escalation. Provider-specific scope verification requires explicit security review.
- Wire a real single-process coordinator with restart/replay behavior and encrypted credential store. In the current production path OAuth start/callback returns 503.
- Bind the saved OAuth access token to exactly the user's resource-specific MCP server, discover tools under that grant and **require existing NAgex per-tool enablement + hash-bound human approval** to invoke.
- Validate revocation, expiry, token rotation, disconnect, negative cases and user/tenant isolation. Ensure no bearer token, code, PKCE verifier or refresh token reaches client storage/logs.
- Run real user consent only on an approved **disposable test workspace and account**, with explicit user authorization. Begin with read-only search, not message sending.

## Suggested certification state
```
METADATA_PREFLIGHT=UNVERIFIED
OPERATOR_CLIENT_REGISTERED=NO
AUTH_START_LIVE=NO
CALLBACK_LIVE=NO
TOKEN_EXCHANGE_LIVE=NO
MCP_DISCOVERY_AUTHENTICATED=NO
APPROVAL_GOVERNED_TOOL_CALL=NO
USER_ACCEPTANCE=NO
```

No changes to production `main`, test server or protected user tokens are authorized by this preflight.

## 2026-10-13 — real public metadata finding

The user ran the preflight and saw `MCP_OAUTH_METADATA_REJECTED`. The actual official resource metadata at
`https://mcp.slack.com/.well-known/oauth-protected-resource` reports:

- MCP Streamable HTTP endpoint: `https://mcp.slack.com/mcp`
- RFC9728 protected resource identifier: `https://mcp.slack.com`
- authorization server: `https://mcp.slack.com`

The first preflight hardcoded the endpoint as the expected resource and incorrectly rejected this legitimate metadata. The preflight was corrected to keep these *distinct* addresses and still require an exact, canonical protected-resource match. No URL security policy was bypassed. The revised preflight has **not yet been user-run**.

Supporting official references:
- https://mcp.slack.com/.well-known/oauth-protected-resource
- https://docs.slack.dev/ai/slack-mcp-server/

Remaining blockers are unchanged: confidential-client OAuth, trusted issuer discovery, operator-owned Slack app/workspace approval, callback and stored-token runtime integration, live end-to-end certification.

## Further official OAuth authorization server metadata

The official `https://mcp.slack.com/.well-known/oauth-authorization-server` response advertises:

- Issuer: `https://mcp.slack.com` (canonical URL may include trailing slash)
- Authorization endpoint: `https://slack.com/oauth/v2_user/authorize`
- Token endpoint: `https://slack.com/api/oauth.v2.user.access`
- PKCE methods: `S256`
- Token endpoint client authentication: `client_secret_post`

The vendor-documented authorization-server metadata URL is now probed separately and pinned to the protected-resource issuer. A result of `METADATA_VERIFIED` is strictly a read-only metadata result, **not a working OAuth connection**. The current generic NAgex token exchange does not send the Slack confidential client secret and cannot yet claim to support this endpoint. NAgex must provision a verified operator-owned Slack app, secure server-side client secret resolution, applicable scopes, and a provider-certified token exchange flow before turning on Connect.

Reference: https://mcp.slack.com/.well-known/oauth-authorization-server

## 2026-10-14 — what the official docs say, and what NAgex now does about it

Sources read for the confidential exchange (no account was connected):
- https://docs.slack.dev/ai/slack-mcp-server/ — only directory-published or internal apps may use MCP (unlisted apps are prohibited); workspace admins approve MCP client integrations; authorization endpoint `https://slack.com/oauth/v2_user/authorize`, token endpoint `https://slack.com/api/oauth.v2.user.access`; the app's `client_id` and `client_secret` are used.
- https://docs.slack.dev/reference/methods/oauth.v2.user.access — arguments `client_id`, `client_secret`, `code`, `code_verifier`, `redirect_uri`, `grant_type`, `refresh_token`; credentials are preferably sent with HTTP Basic, form parameters being the fallback; the documented success response is HTTP 200 JSON with `ok: true`, `access_token`, `token_type: "user"` (not "Bearer"), `authed_user.scope` and `team.id`; no top-level `scope`, `expires_in` or `refresh_token` is documented for this method.
- Slack's own authorization-server metadata (checked live) advertises `token_endpoint_auth_methods_supported: ["client_secret_post"]`, so NAgex pins `client_secret_post` (the metadata, not the method page, is what the registry verifies).

What changed in response:
- `slack-user-v2` response profile: `ok:false` on HTTP 200 is a failure, `token_type "user"` is accepted only under this profile, scopes are read from `scope` or `authed_user.scope` (comma or space separated) and refused if the two disagree. The generic profile still requires `Bearer`.
- The access token is presented to `https://mcp.slack.com/mcp` as a Bearer credential; the RFC 8707 resource is sent as published (`https://mcp.slack.com`, no trailing slash).
- Because Slack's docs do not say whether the exchange response carries a scope list, a token without a checkable scope is **refused** (never stored). If the real provider omits it, the first live run will fail closed with `TOKEN_SCOPE_MISMATCH` and that must be reviewed by a person, not worked around.

Live public-metadata check with the production code path (`node scripts/mcp-oauth-runtime-check.mjs`, dummy client values, no sign-in): Slack → `AVAILABLE`, metadata verified, default read-only scopes all advertised, `client_secret_post` advertised. This is configuration + public metadata only.

```
METADATA_PREFLIGHT=VERIFIED (live, public)
OPERATOR_CLIENT_REGISTERED=NO
AUTH_START_LIVE=NO
CALLBACK_LIVE=NO
TOKEN_EXCHANGE_LIVE=NO   (confidential exchange is covered only by a local fake provider)
MCP_DISCOVERY_AUTHENTICATED=NO
APPROVAL_GOVERNED_TOOL_CALL=NO
USER_ACCEPTANCE=NO
```

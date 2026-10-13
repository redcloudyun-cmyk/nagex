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

# NAgex Operations & Deployment

**Canonical Domain:** Deployment / Runtime Operations / Persistence / Verification
**Status:** CANONICAL operational baseline; host-specific values remain environment configuration
**Date:** 2026-09-29

## 1. Deployment Principle

Deployment must be reproducible, fail closed, preserve durable user state, and avoid presenting a partially verified release as healthy.

Operational scripts are implementation, not permission to discard local work.

## 2. Deployment Pipeline

The repository deployment notes define a guarded update path conceptually:

```text
Verify repository/branch/state
→ Fetch/update approved revision
→ Install locked dependencies
→ Verify required browser runtime
→ Build
→ Deterministic tests
→ Restart service
→ Safe post-deploy verification where supported
```

A failed pre-restart gate should leave the previous working service running where the deployment mechanism supports that behavior.

## 3. Repository Safety

Production/test deployment automation may require a clean checkout, but developer workspaces may contain unrelated changes.

Never apply destructive server-style cleanup commands to a developer working tree without explicit authorization.

Development Git discipline remains:

```text
NO git add .
NO git add -A
NO git commit -a
NO blind reset --hard
NO blind clean -fd
```

Stage exact milestone files.

## 4. Browser Runtime

Browser capability must fail closed when the required browser runtime is unavailable or cannot launch.

Checking for a cache directory is insufficient; deployment should verify the exact expected executable and real launch behavior.

OS-level browser dependencies are host provisioning concerns, separate from normal application updates.

## 5. Service Runtime

The canonical deployment environment uses a managed service process. Environment configuration and secrets belong outside the repository.

Service restart must not destroy durable approvals, executions, OAuth state, tasks or other data that are defined as persistent.

## 6. Secret and Environment Management

Secrets must not be committed.

Sensitive values belong in controlled environment/secret storage.

Logs must not print:

- OAuth refresh/access tokens;
- client secrets;
- encryption keys;
- credential plaintext;
- protected test tokens.

## 7. Google OAuth Persistence

The deployment baseline stores Google OAuth tokens encrypted outside the Git checkout.

The source deployment notes define `/var/lib/nagex` as the preferred Linux service data location with a user-local fallback for development/non-standard environments.

`NAGEX_TOKEN_ENCRYPTION_KEY` protects persisted token material.

Failure behavior is fail-closed:

- missing token file → disconnected;
- corrupted/wrong-key token file → disconnected;
- revoked refresh → disconnected.

Never report these states as connected.

## 7d. GitHub and MCP Connections

GitHub (built-in connection) is available only when the OAuth App is configured; otherwise the UI shows it as unavailable and offers no Connect action.

| Variable | Purpose |
|---|---|
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub OAuth App credentials (secret never reaches a client) |
| `GITHUB_REDIRECT_URI` | must equal the OAuth App callback, `<origin>/api/v1/oauth/github/callback` |
| `GITHUB_OAUTH_SCOPES` | optional; default `read:user repo` |
| `NAGEX_GITHUB_TOKEN_STORE_PATH` | optional; default `/var/lib/nagex/github-oauth.json` with the same fallback as Google |
| `NAGEX_MCP_STORE_PATH` | optional; default `/var/lib/nagex/mcp-connections.json` |
| `NAGEX_MCP_ALLOWED_HOSTS` | optional comma-separated allowlist (`host` or `*.suffix`) for MCP server hosts |
| `NAGEX_MCP_ALLOW_PRIVATE_NETWORK` | development/test only; never set in production |

GitHub tokens and MCP connections (with their credentials) are persisted encrypted with `NAGEX_TOKEN_ENCRYPTION_KEY`; without the key they live in memory only and do not survive a restart. A missing, corrupted or wrong-key file means "not connected" — never connected.

No real GitHub account or OAuth App has been exercised by automated tests; those are scripted-provider tests. Real-account verification stays pending until credentials are configured on the server and a user connects.

**Readiness and certification procedure (operator):**

1. Create a GitHub OAuth App (GitHub → Settings → Developer settings → OAuth Apps) whose Authorization callback URL is exactly `<public origin>/api/v1/oauth/github/callback`.
2. Put `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `GITHUB_REDIRECT_URI` in the service environment (a systemd drop-in, never in the repository) and run `sudo systemctl restart nagex`.
3. Run `node scripts/github-readiness-check.mjs` on the server: it reports configuration (redirect URI shape, requested scopes, no write/admin scope, encryption key) without printing any secret.
4. Real-account read-only certification: `GITHUB_CERT_TOKEN=<test account token> GITHUB_CERT_REPO=owner/repo GITHUB_CERT_PATH=README.md node scripts/github-readiness-check.mjs` drives the production connection service (GET `/user`, repository list, directory, file, identity isolation). Then connect through Settings → Connections as the real user; the card must show `CONNECTED` with the account login, and Disconnect must return it to `Not connected`.

**Remote MCP server check:** `MCP_CHECK_URL=https://<server>/mcp [MCP_CHECK_TOKEN=<bearer>] node scripts/mcp-remote-check.mjs` runs the production URL policy, initialize handshake and tool discovery/schema validation against a real server. It never calls a tool and never prints the token.

## 7a. Channel Webhook Secrets

The Telegram and Slack webhooks are accepted only when authenticated (ADR-0007):

- `TELEGRAM_WEBHOOK_SECRET` — 1–256 characters of `A-Z a-z 0-9 _ -`, the same value registered as `secret_token` in Telegram `setWebhook`.
- `SLACK_SIGNING_SECRET` — the Slack app's Signing Secret.

Failure behavior is fail-closed: with the secret missing, empty or unusable every webhook request is answered `503` and nothing is processed. Never report an integration as receiving events while its secret is unset. Secrets are environment/secret-manager values; never commit or log them.

## 7b. Trusted Proxies (client address for abuse throttling)

Node reports the TCP peer as the client address. Behind a reverse proxy (the deployed chain is Cloudflare tunnel → nginx → Node on `127.0.0.1`) that peer is the proxy, so the proxy must be declared (ADR-0011):

- `NAGEX_TRUSTED_PROXIES` — comma-separated IPs and/or CIDRs of the proxies that sit directly in front of Node, e.g. `127.0.0.1,::1` for a same-host nginx. Not a hop count; no Cloudflare range is built in. An empty, absent or invalid value trusts nothing, so `X-Forwarded-For` is ignored and the TCP peer is used.
- The proxy hop must **append** the address it observed (nginx `proxy_add_x_forwarded_for`) and must be the only network path to Node (Node listens on `127.0.0.1`). `CF-Connecting-IP` is never read.
- Until it is set behind a proxy, every client shares the proxy address for the per-IP and pair throttles and the server logs one `forwarded_for_ignored_no_trusted_proxy` warning.
- After changing it, re-verify on the public path that a forged `X-Forwarded-For` does not evade the login throttle.

The throttle state is process-local (single node).

## 7c. Model Provider Configuration (Nebius / Nemotron)

Model providers are configured from server environment only (ADR-0012); nothing a client sends can select or supply a credential:

- `NEBIUS_API_KEY` — Nebius Token Factory credential. **No default.** Absent or blank → the provider is unavailable (the application and all other routes keep working). Secret: never commit, log or echo it.
- `NAGEX_NEBIUS_MODEL` — default `nvidia/Nemotron-3_5-Lightning`.
- `NAGEX_NEBIUS_BASE_URL` — default `https://api.tokenfactory.nebius.com/v1`. Must be `https` (plain `http` is accepted only for a loopback test endpoint) and carry no embedded credentials, otherwise the provider stays unconfigured.
- `NAGEX_NEBIUS_TIMEOUT_MS` — per-request timeout, default `60000`. `NAGEX_NEBIUS_MAX_TOKENS` — default `8192` (includes reasoning tokens).
- `NAGEX_PROVIDER_PRIORITY` — unchanged (global tie-break order); the per-task Nemotron preference is routing data in code, not an environment setting.

When the key is present Nemotron becomes the first attempt for PLAN, RESEARCH_SYNTHESIS and MEETING_PREP; the other providers remain the fallback. An opt-in, single-call real certification is `NAGEX_LIVE_NEBIUS_CERT=1 node scripts/nebius-live-cert.mjs` (after build); the normal test suite never calls the paid API. There is no runtime spend guard: watch Nebius billing and the per-request token counts in the `model_request_succeeded` log.

## 8. Approval and Execution Persistence

Approvals and execution records that must survive restart are stored outside transient process memory.

Writes should be atomic to avoid torn state.

Expired approvals cannot be approved or executed.

Persistence must not include secrets merely because the execution references a credential.

## 9. Safe Verification

Operational verification separates safe checks from external mutations.

### Safe verification
May include:

- repository revision/state;
- build/tests;
- service health;
- OAuth connection status;
- read-only capability probes;
- browser safe navigation/snapshot;
- SSRF/safety checks;
- architecture bypass scans.

### Live external verification
May include explicitly authorized:

- test email send;
- test calendar creation;
- controlled browser submission;
- replay verification.

Live E2E is never silently folded into routine deployment.

## 10. Health and Readiness

Health endpoints and operational checks must reflect actual implementation.

Do not document or rely on a health route that does not exist in the deployed revision.

As routes evolve, deployment docs/scripts must be updated together.

## 11. Rollback / Failure

A deployment failure should produce a clear operational state and avoid security downgrade.

Rollback strategy must preserve compatible durable state and must not silently replay consequential actions.

## 12. Logging and Evidence

Operational logs should support:

- revision identification;
- build/test result;
- service restart status;
- verification result;
- safe failure diagnosis.

Logs are evidence, not a substitute for canonical runtime state.

## 13. Environment-Specific Configuration

Hostnames, ports, filesystem paths, service names, OAuth redirect URIs and provider credentials are environment configuration.

Canonical docs describe the contract; deployment manifests/env files describe the actual host.

## 14. CI

Ephemeral CI runners may provision browser binaries and OS dependencies each run.

Persistent hosts should provision OS dependencies separately from normal app updates unless the host image changes.

CI must not depend on production secrets for deterministic regression.

## 15. Operational Invariants

```text
SECRETS_IN_REPO = 0
SECRET_LOG_LEAK = 0
BROKEN_BROWSER_REPORTED_AVAILABLE = 0
LIVE_EXTERNAL_MUTATION_IN_SAFE_CHECK = 0
DEPLOYMENT_DESTROYS_DURABLE_USER_STATE = 0
OAUTH_CORRUPTION_REPORTED_CONNECTED = 0
EXPIRED_APPROVAL_EXECUTABLE = 0
```

## 16. Source Provenance

Consolidated from:

- `DEPLOYMENT.md`
- `ops/automated-testing.md`
- `DEVELOPMENT.md`
- current repository/server operational principles

Host-specific commands and historical script behavior remain implementation/evidence and should be re-verified against the active deployment revision before operational use.

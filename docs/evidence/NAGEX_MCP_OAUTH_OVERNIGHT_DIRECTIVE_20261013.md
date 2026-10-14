# NAgex — Overnight Autonomous Development Directive
**Issued:** 2026-10-13, night (KST)  
**Agent:** Claude Code / Antigravity  
**Scope:** NAgex Personal AI, MCP OAuth real integration  
**Base branch:** `feat/mcp-oauth-discovery-20261013`  
**PR:** https://github.com/redcloudyun-cmyk/nagex/pull/13  
**Status:** IMPLEMENTATION ORDER — not evidence of work completed

## 0. Mission and decision hierarchy

Overnight, move NAgex toward **one genuinely usable external MCP OAuth connection**. Slack's officially published remote MCP service is the first candidate. The measurable product journey is:

**Tap Slack → NAgex-managed provider login/consent → authenticated callback → durable encrypted user-bound token → MCP initialize/tools discovery → tool OFF by default → enable with informed consent → natural-language read-only request → existing Human Approval → one-time broker-governed execution → truthful result.**

Aim for a functional integration, not an inflated catalog or mock Connected badge.

Priority order: actual user outcome > security/correctness > external certification > developer ergonomics > catalog volume. NAgex provides operator API credentials; ordinary users never obtain API keys, client secrets or MCP URLs.

## 1. Baseline and verified evidence

- At last verified user run: focused `mcp_oauth_*.test.js` **39 pass / 0 fail** (before recent Slack preflight code updates).
- Previous browser certification **225 total, 219 pass, 0 fail, 6 skip**; requires rerun after latest changes.
- Live Slack **public metadata preflight** at branch commit `c0be293`: `METADATA_VERIFIED`; resource verified; authorization server metadata verified; PKCE S256 yes; 30 scope names; `requiredTokenClientAuth=["client_secret_post"]`. It did **not** connect any account.
- Slack MCP endpoint `https://mcp.slack.com/mcp`. RFC 9728 OAuth protected resource identifier `https://mcp.slack.com`. These are intentionally different.
- AS metadata endpoint `https://mcp.slack.com/.well-known/oauth-authorization-server`; source must be verified before trusting provider-specific parameters.
- Existing code includes discovery, pending PKCE state, token exchange, operator registry, in-memory encrypted vault, single-process persistent credential store, callback, routes and a test-injected coordinator. **Production coordinator not wired; OAuth start/callback 503 when unconfigured.** Do not call this live.
- Current branch head must be discovered freshly with `git fetch` + `git log`. Do not assume a particular commit is latest.

## 2. Safe autonomous operation

1. Work only in a fresh or clean **isolated worktree** sourced from `origin/feat/mcp-oauth-discovery-20261013`. Previously used Windows folder: `F:\nxc-mcpoauth`. Before touching anything, inspect `pwd`, `git status --short`, current branch, all worktrees, HEAD and remotes. Preserve unrelated/untracked `artifacts/` and local Voice WIP. No `git reset --hard`, `git clean`, destructive checkout or force push.
2. Commit bounded changes to the MCP OAuth feature branch. If other agents have advanced origin, fetch, inspect and reconcile (no blind overwrites).
3. **No deployment tonight**: do not restart `nagex.service`, change `main`, merge PR, reconfigure Cloudflare, alter production `.env`, change billing or provision production accounts.
4. Do not use/copy/display user secrets. Logs, tests and PR messages must redact credentials and OAuth callback codes.
5. Slack workspace/app creation is optional and **only where the actual user is present to complete signup/confirmation/MFA/admin consent**, and terms permit it. Never fabricate workspace or registration success. The user authorized preparing/creating a disposable test workspace if feasible; that does NOT authorize unattended impersonation, bypassing required controls, purchasing a plan or sending real messages.
6. Never use Whisper or derivatives. Preserve existing Human Approval, tenant ownership, permissions, revocation, action logs and deterministic execution boundary.

## 3. Stage A — Provider-specific confidential OAuth exchange (P0)

- Review Slack's current official resource + AS metadata, spec and app registration rules; cite docs in evidence.
- Extend existing `src/mcp/mcp-oauth-token.ts` rather than duplicating HTTP stacks. Support strictly operator-selected `none` (where legitimate) and `client_secret_post` when certified for the registered provider.
- Secret resolved **server-side** via an approved secret resolver or protected env reference, never from the UI/user-supplied URL/metadata callback. If absent, return truthful `SETUP_REQUIRED` / 503. Provider client authentication mode and exact token endpoint must be pinned at registration.
- Revalidate resource/audience, issuer, redirect URI, requested scopes and callback state on each authentication boundary. Implement strict validation of Slack's actual response type based on official evidence, without weakening token scope checks or revealing tokens in errors.
- Keep HTTPS only, DNS rebinding/SSRF protections, bounded HTTP response/time, zero automatic redirects, TLS validation, no dangerous redirects and no credentials in HTTP GET.
- Add tests with a local fake provider that **asserts the exact client_secret_post form**, no secret in browser response/logs, fail closed without operator configuration, no over-scoping and no wrong-owner token storage.
- Do not mark Slack `LIVE` from metadata validation alone.

## 4. Stage B — Operator configuration and production-safe coordinator

- Add explicit operator-managed allowlisted registration (approved issuer/resource/MCP endpoint, registered client ID, exact callback URL, token auth method, scopes and encrypted secret reference). Validate configuration once and at use; no arbitrary end-user token URL.
- Wire `McpOAuthProviderRegistry`, pending state, `PersistentMcpOAuthCredentialStore`, trusted token resolver, and canonical HTTP callback via a single NAgex coordinator with **fail-closed activation**.
- Use a clear opt-in deployment flag; default OFF. Never implicitly activate on presence of partial credentials.
- Verify callback against same authenticated account/session that initiated. One-time state replay, code substitution, provider denial and tenant ID forgery must fail.
- Existing pending state is process-memory only: single-process explicit limitation; multi-worker/restart fail closed until atomic persisted state is implemented. On server restart, expired unfinished flows require re-initiation.
- Distinguish `OAUTH_CREDENTIAL_STORED` from `MCP_CONNECTED_VERIFIED`. Token persistence is not proof of a working server.
- **Danger gate:** if operator credentials or legitimate provider metadata conflict, stop external activation and continue isolated code + tests instead.

## 5. Stage C — Bind credential to MCP runtime and approval

- Use `https://mcp.slack.com/mcp` only for authenticated MCP transport, not the protected resource metadata URL.
- Resolve the right encrypted token by authenticated tenant + principal + pinned resource/issuer/client tuple. Expired/revoked token becomes `REAUTH_REQUIRED`; never attempt a consequential tool operation with expired credentials.
- Reuse current `McpService`, existing schema/identity pinning, `McpClient`, capability registry, permission broker, Action Approval and execution audit. **Do not create a parallel executor.**
- Upon authentic `initialize` and `tools/list`, tools default OFF. Surface tool name/capabilities only after verified connection. Add rate/timeout limits and tool signature change lock-out.
- Test read-only search/list before any writes. A real-world tool call requires the user's explicit Human Approval, bound to target/args/identity/hash; never auto-approve.
- Treat remote MCP tool replies as `TOOL_RESPONDED` and independently unverified, not guaranteed side-effect completion.
- Implement disconnect (local token removal, disabling tools, provider revocation only when documented and approved), failure state and session isolation.

## 6. Stage D — Human-friendly Apps & Connections

- Ordinary user path: icon → provider consent. Technical token/server fields remain behind Advanced.
- Show Connect only when operator config **and** executable authorization path exist, otherwise precise Setup Required/Coming Later.
- Reuse existing AGEX/NAgex assets instead of redesigning Home/Settings.
- EN canonical + natural Korean, desktop and 360/390/430 responsive.
- No fake `CONNECTED` badge, no app-count inflation. Keep independent counts: catalog, operator-configured, OAuth verified, MCP tools verified, human-approved execution.
- Do not build 100 discovery-only cards before one real provider integration works.

## 7. Stage E — Live-provider gate (only if authorized, otherwise BLOCKED)

1. Workspace exists and is legitimately owned/approved; NAgex-owned Slack app properly registered; operator client secret available securely; redirect allowlisted.
2. Use a **disposable test account** and explicit OAuth consent. If login/MFA/workspace admin permission needed, STOP this live subtask and report owner action. Continue other safe tasks.
3. Verify real Slack token exchange, encrypted persistence across restart **in isolated test instance**, authenticated tools discovery and one safe read-only tool call after Human Approval.
4. Prove revoked/missing scope, wrong user/tenant, replay, identity mismatch and disconnect fail closed.
5. Report exact external-test evidence; never call isolated fake OAuth test a real provider PASS.

## 8. Mandatory verification and final status

- Register **every** new `tests/*.test.ts` in `tests/test-contract.registry.json` with accurate gate classification before any full gate.
- Run: `npm run build`, `node --require ./dist/tests/_setup.js --test ./dist/tests/mcp_oauth_*.test.js`, `npm test`, `npm run test:browser-cert`, in that order. STOP the related merge/closure gate on failure; no stale `dist`.
- Follow any regression failure to the responsible source; no quick weakening of assertions, removing tests, masking statuses or endless timeout increases.
- End with source SHA, tested SHA, test counts/pass/fail/skip, connection outcome, and exact blocked conditions.
- Push only feature branch to GitHub; update **Draft PR #13** with factual results. Do not merge or deploy without separate authorization.
- Create `docs/evidence/NAGEX_MCP_OAUTH_OVERNIGHT_REPORT_20261014.md`. Include:
  `BASE_SHA`, `FINAL_SHA`, `SLACK_METADATA`, `CONFIDENTIAL_TOKEN_EXCHANGE`, `OPERATOR_REGISTRATION`, `OAUTH_START`, `CALLBACK`, `ENCRYPTED_PERSISTENCE`, `MCP_DISCOVERY`, `HUMAN_APPROVAL`, `REAL_SLACK_OAUTH`, `REAL_READ_ONLY_TOOL`, `REGRESSION`, `BROWSER_CERT`, `DEPLOYMENT` and `HUMAN_UI_ACCEPTANCE`. Use PASS / FAIL / BLOCKED / NOT_RUN truthfully.
- Provide a short Korean morning handoff: changes, evidence, next action, blockers. If blocked by Slack signup/provider registration, do not wait idle: finish code quality, security tests, reconnection/expiry and release-readiness documentation.

**DONE tonight means highest safely executable work complete with evidence, not falsely claiming a live provider connection.**

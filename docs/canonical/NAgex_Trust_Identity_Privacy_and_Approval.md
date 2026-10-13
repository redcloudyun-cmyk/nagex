# NAgex Trust, Identity, Privacy & Approval

**Canonical Domain:** Trust / Security / Identity / Privacy / Permission / Approval
**Status:** CANONICAL consolidated security contract
**Date:** 2026-09-29

## 1. Security Goal

NAgex may reason, create, automate, browse, communicate, schedule, and eventually transact, but authority remains with the user and deterministic policy.

Security is not a UI convention. It must be enforced at runtime boundaries.

## 2. Authority Order

```text
Current Explicit User Intent
        ↓
Identity / Tenant / Ownership Boundary
        ↓
Hard Privacy & Security Policy
        ↓
Permission Authority
        ↓
Approval Requirement
        ↓
Advisory Model / JEV Signals
        ↓
Deterministic Validation
        ↓
Canonical Execution
        ↓
Audit
```

No lower layer may weaken a higher layer.

## 3. Permission Outcomes

Canonical permission outcomes:

- `ALLOW`
- `REQUIRE_APPROVAL`
- `BLOCK`

Unknown, contradictory, unverifiable, or unsafe permission state fails closed.

A model recommendation cannot upgrade `BLOCK` or `REQUIRE_APPROVAL` to `ALLOW`.

## 4. Human Approval

Consequential external mutations require approval when policy says so.

Examples include:

- external messages;
- Calendar mutations;
- destructive changes;
- sensitive data transfers;
- financial/reservation/payment actions;
- permission changes;
- other capabilities marked approval-required.

Approval must bind to the material action being executed. Material drift in target, payload, environment, route, provider/account/workspace, amount, or conditions requires re-evaluation and, where applicable, reapproval.

Reject is terminal and non-mutating.

Voice does not bypass approval.

Consent to voice (speech) processing is separate from approval of an action. NAgex servers do not receive raw audio; third-party speech processing requires provider-specific informed consent that can be withdrawn, unknown processing location is never described as on-device, and raw audio is not persisted by default. Whisper-based speech engines are prohibited (ADR-0013).

Automation does not bypass approval.

Memory does not bypass approval.

Model confidence does not bypass approval.

## 5. Replay & Payload Integrity

Consequential execution must remain replay-safe.

```text
APPROVAL_PAYLOAD_DRIFT_BLOCKED = 1
APPROVAL_REPLAY_BLOCKED = 1
REJECT_MUTATION = 0
```

An approved action must not be silently transformed into a materially different action after approval.

## 6. Identity & Isolation

Default rules:

- cross-user access: deny;
- cross-tenant access: deny;
- cross-workspace access: deny unless explicitly authorized;
- object ownership must be checked server-side;
- user-facing identity and authentication state must not be inferred from UI-only state.

Identity lifecycle, sessions, federation, provisioning, and RBAC remain separate implementation domains but must obey this canonical boundary.

### 6.1 Account disable / delete / recovery

- Disabling or deleting an account is a consequential change of the person's own data and always needs fresh proof of identity. NAgex adds no password authentication for it.
- A local (legacy password) account confirms with its password. A Google or Microsoft account confirms with a session created by a provider sign-in within the last 5 minutes **and** its typed account email; an older session is refused with `REAUTH_REQUIRED` and nothing changes. Organization-managed accounts (OIDC / SAML / SCIM) are governed by their organization and are refused here.
- Disabling or requesting deletion revokes every session of the account and is audited. Deletion has a 14-day grace period.
- A provider sign-in on a disabled or deletion-pending account opens **no** session. It issues a single-use, 10-minute, state-bound token; reactivation or cancelling the deletion happens only when the person explicitly chooses it, and is audited. A deleted account cannot be recovered.
- "Fresh" means a provider sign-in happened minutes ago; NAgex does not claim the provider forced a password re-entry.

## 7. Credential Broker / Vault

Credentials are capability enablers, not permission.

Credential existence never implies authorization to use it.

Secrets must not be:

- committed to source;
- embedded in frontend code;
- printed in logs;
- inserted into approval payloads;
- exposed to JEV;
- exposed to untrusted browser/page content;
- propagated through general model prompts unless an explicitly governed mechanism requires it.

Future browser login, reservation, or payment flows should request scoped credential use through the Credential Broker without distributing plaintext credentials to unrelated components.

```text
JEV_CAN_READ_CREDENTIALS = 0
```

## 8. Untrusted Content Boundary

Browser pages, retrieved documents, email content, uploaded files, web search results, and model-generated text may contain instructions. They are **content**, not authority.

Untrusted content must never:

- grant permission;
- override system/user policy;
- access credentials;
- silently change the execution target;
- waive approval;
- trigger destructive actions solely because the content requested it.

Browser/tool metadata should preserve trust provenance where the implementation supports it.

## 9. Memory Security

Memory must be:

- scoped;
- source-traceable;
- inspectable;
- controllable;
- deletable where product policy requires;
- subordinate to the user's current explicit instruction.

Sensitive memory must not be disclosed to a provider merely because it improves answer quality.

## 10. Data Disclosure & Privacy

Before remote model/provider use, NAgex must determine what data is necessary and allowed to leave the current trust boundary.

Data minimization precedes provider optimization.

A provider outage or cheaper route must never cause an unapproved privacy downgrade.

## 11. Trusted Transaction Execution

Reservation and payment belong to one governed transaction family when both are required.

Execution requires prior user authorization and must bind approval to the material transaction state, including where applicable:

- target;
- amount;
- conditions;
- cancellation/refund terms;
- selected payment reference;
- execution route.

Raw card data should not become a general NAgex application secret; tokenized/reference-based payment mechanisms are preferred.

Material price/condition drift requires reapproval.

## 12. Auditability

Permission and execution decisions should produce structured audit evidence without leaking protected payload contents.

Audit should be sufficient to determine:

- who/what requested the action;
- which identity/tenant/workspace owned it;
- what policy decision occurred;
- whether approval was required and obtained;
- what canonical action executed;
- result/failure;
- timestamps and replay identity.

## 13. Fail-Closed Rules

```text
UNKNOWN_PERMISSION_STATE → BLOCK
CREDENTIAL_STATE_UNCERTAIN → BLOCK / UNAVAILABLE
UNTRUSTED_CONTENT_REQUESTS_AUTHORITY → BLOCK
APPROVAL_MISMATCH → BLOCK
TENANT_OR_OWNER_MISMATCH → NOT_FOUND / DENY
MODEL_FAILURE → NEVER SECURITY_DOWNGRADE
PROVIDER_OUTAGE → NEVER PRIVACY_DOWNGRADE
```

## 14. Development Safety Harness

Security-critical development must preserve:

- no mutation without required approval;
- fail-closed behavior;
- explainable important decisions;
- explicit technical debt;
- regression tests for approval, permission, replay, tenant isolation, and failure behavior;
- truthful UI state.

Direct mutation paths that bypass the canonical execution/approval chokepoint are prohibited.

## 15. Non-Negotiable Invariants

```text
HUMAN_AUTHORITY_PRECEDENCE = 1
FAIL_CLOSED = 1
APPROVAL_BYPASS = 0
CROSS_USER_LEAK = 0
CROSS_TENANT_LEAK = 0
CREDENTIAL_PERMISSION_EQUIVALENCE = 0
UNTRUSTED_CONTENT_AUTHORITY = 0
JEV_CAN_APPROVE = 0
JEV_CAN_OVERRIDE_BLOCK = 0
JEV_CAN_READ_CREDENTIALS = 0
SECRET_LOG_LEAK = 0
```

### 15.1 Connected-account state (Google Calendar)

A connected external account is owned by exactly one tenant + user. Its state is always computed for the verified session identity — never a default account, never a client-supplied user, tenant, header, query or body field.

| State | Meaning |
|---|---|
| `NOT_CONNECTED` | no connection for this tenant + user |
| `CONNECTING` | this user started authorization and it has not finished (visible only to that user) |
| `CONNECTED` | a usable grant with the required scopes; `verifiedAt` is set only when an authorized provider call just succeeded |
| `REAUTH_REQUIRED` | the connection exists but must be authorized again: revoked/expired grant, provider-rejected token, or a missing scope |
| `ERROR` | the connection is fine but the provider failed (timeout, outage, rate limit, API disabled) or NAgex hit an internal fault — retry, do not reconnect |
| `UNAVAILABLE` | this deployment cannot offer the provider (no OAuth client) — no connect action is shown |

- A grant the provider no longer honours is **not silently deleted**: the connection metadata and the reauthorization flag are kept (and persisted), while the unusable access/refresh secrets are purged immediately. Reconnecting replaces it.
- A transient provider failure never marks a grant dead and never prompts the user to reconnect.
- Tool/capability availability that depends on a connection is evaluated for the verified identity and fails closed without one.
- Reads (`google_calendar.list_events`, free/busy) are read-only and identity-bound; every calendar write keeps the existing approval requirement.

### 15.2 Built-in connection: GitHub (read-only)

GitHub is a built-in connected app using the same ownership and state model as 15.1 (tenant + user from the verified session only; `NOT_CONNECTED | CONNECTING | CONNECTED | REAUTH_REQUIRED | ERROR | UNAVAILABLE`).

- The OAuth callback only completes in the session that started the flow, with a one-time server-held `state`; the token is **proved with an authorized `/user` call before it is stored**, so `CONNECTED` is never recorded from a bare code exchange.
- Tokens are encrypted at rest (`NAGEX_TOKEN_ENCRYPTION_KEY`), never returned to a client and never logged. A token GitHub rejects (401) is purged but the connection stays visible as `REAUTH_REQUIRED`; rate limits, outages and timeouts are `ERROR` and never disconnect.
- Disconnect revokes the user's grant at GitHub (best effort) and always clears the local grant.
- **Implemented capabilities are read-only:** `github.list_repos`, `github.list_directory`, `github.read_file` (`READ_ONLY`, no approval, identity-bound through the Capability Broker). Owner/repo/path/ref are strictly validated, file size is capped, binary files are not returned, and everything read from a repository is marked `untrusted` (it is content, never instructions — section 8).
- **Not implemented:** any write to GitHub (branch, commit, pull request, issue, comment) and any execution of repository code. A future write capability must be registered `CONSEQUENTIAL` with approval `REQUIRED` and run through the Broker's hash-bound approval continuation; code execution is not offered on the API server.
- The OAuth scope defaults to `read:user repo` (GitHub offers no read-only private-repository scope for OAuth Apps) and can be narrowed with `GITHUB_OAUTH_SCOPES`; the connection reports whether private repositories are reachable.

### 15.3 MCP servers (user-registered tool servers)

MCP is an extension point inside the existing authority model, not a second one.

- Transport is Streamable HTTP only. **stdio / process-spawning servers are not supported** (they would execute arbitrary code on the API server).
- A server URL is an SSRF boundary: https only, no embedded credentials, no private / loopback / link-local / metadata / reserved address (checked on the literal host, on every resolved address at registration, and again at connect time), optional operator allowlist (`NAGEX_MCP_ALLOWED_HOSTS`), redirects never followed, bounded time and size. `NAGEX_MCP_ALLOW_PRIVATE_NETWORK=1` exists for development and tests only.
- Every connection belongs to one tenant + user; a foreign connection is indistinguishable from a missing one. The optional bearer credential is encrypted at rest and never returned.
- The server identity (origin, advertised name) is **pinned** on first successful initialize. A different identity disables every tool of that connection and it stays untrusted until removed and re-added.
- Tool definitions are untrusted input: names are constrained, descriptions sanitized and capped, and an input schema must stay inside a small fully-checkable JSON Schema subset or the tool is rejected at discovery. Arguments are validated against the accepted schema before an approval is even requested.
- A discovered tool is **disabled** until its owner enables it. If its definition changes (checked on refresh and again immediately before every call) it is disabled again until re-enabled; a `readOnlyHint` from a server is shown, never trusted.
- An enabled tool becomes a per-user `CapabilityRegistry` entry (`provider: MCP`, `CONSEQUENTIAL`, approval `REQUIRED`, never listed in the catalog). Execution is only via `CapabilityBroker.execute`: the Permission Authority applies, the call requires a hash-bound, one-time `ActionApproval` consumed immediately before the call, and execution/audit records are written without credentials or argument content.
- Results are untrusted data (size-capped text; non-text content is reported by type only). The autonomous task runner does not execute MCP tools; they run only after an explicit approval.

## 16. Source Provenance

Consolidated from:

- `SECURITY.md`
- `NAGEX_DEVELOPMENT_SAFETY_HARNESS.md`
- `NAgex_Trust_and_Safety_Layer_Development_Directive_20260908.md`
- `NAgex_R23.3T_Permission_Approval_Hardening_Development_Directive_20260926.md`
- `NAgex_R23.4V_Credential_Broker_Inject_Only_Vault_Development_Directive_20260926.md`
- `NAgex_R23.5B_Browser_Untrusted_Content_Boundary_Development_Directive_20260927.md`
- `NAGEX_SIGNUP_LOGIN_AUTHENTICATION_POLICY.md`
- `NAGEX_ADMIN_CONSOLE_MEMBER_PRIVACY_ARCHITECTURE.md`
- `R23.4V_CREDENTIAL_INVENTORY_20260926.md`

Milestone-specific implementation details remain evidence/archive material after this canonical contract is adopted.

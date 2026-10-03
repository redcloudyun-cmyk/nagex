# NAgex Security Specification

## 1. Security Goal

NAgex must allow useful agent autonomy without allowing the agent to silently exceed user authority.

## 2. Core Principles

- Default deny for unauthorized actions.
- Human approval for consequential actions.
- Least privilege for tools.
- Secrets remain server-side.
- Cross-user and cross-tenant access is denied by default.
- Agent actions are auditable.
- Failure does not weaken policy.

## 2a. Identity boundary (Security Gate S1)

- Identity comes only from a server-side session. `X-Principal-Id` / `X-NAgex-Tenant`, request bodies and query strings never establish a user or tenant.
- Routes are default-deny: anything not listed in `src/http/route-access.ts` requires an authenticated identity.
- There is no default admin, default tenant or built-in admin by name. See ADR-0006.

## 2b. Channel webhook authenticity (Security Gate S2A)

- A Telegram or Slack webhook is not an authenticated caller. It is refused (`401`) before any identity lookup, memory read, conversation write, model call or outbound send unless it carries the server-configured Telegram secret-token header, or a valid Slack `v0` signature over the authentic raw body inside a 5-minute window.
- `TELEGRAM_WEBHOOK_SECRET` and `SLACK_SIGNING_SECRET` come from server configuration only. A missing secret fails closed (`503`), never "verification off". See ADR-0007.

## 2c. Channel identity ownership (Security Gate S2B)

- A Telegram/Slack user id supplied by a client is never proof of ownership. A channel account is linked to a NAgex principal only when a one-time challenge issued to that signed-in principal is redeemed FROM the channel account, through the authenticated webhook; the link is bound to the issuing principal and tenant.
- An identity already linked to another principal is never silently taken over; unlinking is explicit and owner-only. Challenges are single-use, 10 minutes, process-local. See ADR-0008.

## 3. Human Approval

Approval must be enforced in runtime logic, not only UI.

Typical approval-required categories:

- sending messages,
- modifying remote data,
- deleting data,
- purchases or payments,
- publishing,
- permission changes,
- account changes,
- sensitive data transfer.

Approval requests should show:

```text
What will happen
Which tool will be used
What data will be sent
What resource will change
Potential consequences
```

## 4. Tool Permissions

Each tool or Skill should declare required permissions.

The runtime should evaluate permissions before execution.

## 5. Secrets

Never commit:

- API keys,
- access tokens,
- passwords,
- private certificates,
- provider secrets.

Use environment variables or a secret manager.

Do not log raw secrets.

## 6. Tenant / User Isolation

Inherited tenant-aware logic may be retained where useful.

Any user-scoped or tenant-scoped operation must validate the active scope server-side.

Client-provided scope identifiers must not be trusted without authorization checks.

## 7. Memory Security

Memory must follow the same authorization boundaries as source data.

Sensitive data should be minimized and removable.

## 8. Audit

Security-relevant audit events should include:

- permission denial,
- approval requested,
- approval accepted,
- approval rejected,
- tool invocation,
- destructive action,
- provider failure,
- authentication/authorization failure.

## 9. Demo Safety

Demo shortcuts must not introduce dangerous defaults.

Mock actions must be labeled as mock.

Real external actions used in a demo should remain reversible or low-risk where practical.

## 10. Security Completion Checklist

Before release or public demo:

- no committed secrets,
- approval policy tested,
- authorization tested,
- tool permissions tested,
- error paths tested,
- client cannot directly access provider secrets,
- audit events exist for consequential actions.
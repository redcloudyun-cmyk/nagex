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
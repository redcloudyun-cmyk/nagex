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

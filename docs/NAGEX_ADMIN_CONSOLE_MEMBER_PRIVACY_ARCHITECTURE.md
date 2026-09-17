# NAGEX Admin Console · Member Management · Privacy Governance Development Directive

**Status:** Planned / Governing Design Document  
**Product:** NAGEX  
**Scope:** Member lifecycle, admin operations, privacy-preserving support, usage/LLM monitoring, security/audit, operational automation  
**Principle:** Administrators manage account state and system health, not users' private lives.

---

## 1. Purpose

NAGEX will eventually operate with hundreds, thousands, and potentially far more users. At that scale, member management cannot depend on administrators manually reviewing individual accounts.

The operating model must be:

> **Policy + Automation + Exception Handling + Monitoring**

Administrators should not manage thousands of users one by one. The system should automatically handle normal lifecycle events and surface only exceptions, risk signals, failures, and cases requiring human judgment.

This document defines the product, privacy, security, and implementation principles for the future NAGEX Admin Console.

---

## 2. Core Administrative Principle

NAGEX is a personal AI Agent and may process highly sensitive personal context such as account identity, email/calendar connection state, device information, AI/agent usage, automation history, API/model consumption, files and artifacts, task execution history, security events, billing/plan information, and external integration health.

Therefore the Admin Console must be designed around **minimum necessary access**, not maximum operator convenience.

Canonical principle:

> **Administrators manage account state and system health, not users' private lives.**

Korean interpretation:

> **관리자는 회원의 상태와 시스템을 관리하되, 사용자의 사적 내용을 기본적으로 열람하지 않는다.**

---

## 3. Operational Model at Scale

Normal user operations should be automated.

Examples include signup, verification, recovery, consent, account activation, plan/entitlement assignment, inactivity handling, account closure, connection health checks, usage threshold detection, payment failure detection, suspicious login detection, abnormal API/model usage detection, repeated agent failure detection, expired external-service connections, and automated notification routing.

Human administrators should primarily handle exceptions such as repeated billing failure, suspicious authentication, unusually high model/API cost, repeated task execution failure, security event escalation, integration outage affecting specific users, account suspension appeal, privacy/access requests, and incident investigation.

---

## 4. Admin Console Top-Level Information Architecture

Proposed future route structure:

```text
/admin

/dashboard
/users
/organizations
/roles
/plans
/usage
/billing
/llm
/agents
/automations
/integrations
/incidents
/security
/audit
/system
```

This is an architectural direction, not a requirement to implement all routes in one milestone.

---

## 5. Administrative Layers

### Level 1 — Aggregate Operations

Default admin view.

Examples:
- total users
- active users
- new registrations
- paid users
- plan distribution
- daily/monthly model cost
- agent run volume
- agent failure rate
- integration health
- suspicious login count
- provider incidents
- queue/runtime health

This layer should rely on aggregated data whenever possible.

### Level 2 — User Operations

Used when a specific account requires investigation or support.

Allowed examples:
- internal user ID
- account status
- plan
- registration date
- last active time
- masked identity
- connection status
- usage totals
- failed run count
- automation count
- security flags
- billing state
- administrative action history

This layer should still avoid revealing private content by default.

### Level 3 — Sensitive Investigation

Exceptional access only.

Potential examples:
- private conversation contents
- uploaded document contents
- email body
- calendar event details
- memory contents
- detailed IP/session evidence
- sensitive support evidence

Access must require stronger authorization, justification, and auditability.

---

## 6. Privacy-by-Default Rules

### 6.1 Default Deny
Administrative access is denied unless explicitly allowed by role/policy.

### 6.2 Data Minimization
Only show the minimum data needed to complete the administrative task.

### 6.3 Masking by Default
Potential identifiers should be masked where full values are unnecessary.

Examples:

```text
Email:
yo***@example.com

IP:
203.0.113.xxx

External account:
g***@gmail.com
```

### 6.4 User Content Is Private by Default

Normal administrators must not automatically gain access to complete conversation history, prompts, memory contents, uploaded file contents, generated private artifacts, email body, full calendar details, or raw browser/computer interaction content.

### 6.5 Aggregate Before Individual
Where operational goals can be met using aggregate metrics, the UI should not expose individual-level private data.

---

## 7. Sensitive Data Boundary

The Admin Console must remain compatible with NAGEX data sensitivity policy.

```text
S0 — LOW
S1 — PERSONAL
S2 — SENSITIVE
S3 — SECRET
```

S3 includes passwords, OTP values, recovery codes, API keys, OAuth tokens, access/refresh tokens, private keys, and equivalent authentication secrets.

### Absolute Rule

> S3 secrets must never be exposed in the Admin Console.

There must be no "show secret" admin override.

---

## 8. Administrator RBAC / ABAC

Suggested operational roles:

### Support Operator
May access masked account identity, account status, plan, connection status, and general failure state. Must not access private content, raw security evidence, or secrets.

### Billing Operator
May access plan, billing state, credit/usage totals, and payment-related operational status. Must not access private conversations, files, or model prompt contents.

### Technical Operations
May access execution state, error category, provider/integration health, job/runtime diagnostics, and sanitized technical logs. Must not automatically access user private content or secrets.

### Security Administrator
May access authentication anomalies, security events, session/device risk indicators, and account lock/suspension controls. Access must be heavily audited.

### Privacy / Compliance Administrator
May handle data access requests, export requests, deletion requests, and privacy incident workflows.

### Super Administrator
Must not mean unrestricted invisible access. High-risk actions should still require explicit reason, policy enforcement, step-up authentication where applicable, audit events, and possibly dual authorization.

---

## 9. Break-Glass Access

Sensitive-content access, if ever required, must use a dedicated **Break-Glass** workflow.

Required properties:

1. operator identifies the user/case
2. operator enters a reason
3. policy determines whether the operator is eligible
4. step-up authentication may be required
5. approval may be required for high-risk categories
6. access scope is limited
7. access expires automatically
8. all access is audited
9. the event is reviewable by security/privacy administrators

Break-glass access must never become the normal support workflow.

---

## 10. Member 360 View

The future user detail screen should be an operational 360 view, not a surveillance dashboard.

Recommended default fields:

```text
Account
- User ID
- Account status
- Plan
- Registered at
- Last active
- Locale

Connections
- Google status
- Gmail status
- Calendar status
- Other supported integrations

Usage
- Monthly model/API usage
- Agent run count
- Failure count
- Automation count
- Current quota / entitlement

Operations
- Current blocked tasks
- Pending approvals count
- Integration errors
- Recent operational incidents

Security
- Risk flags
- Session/device summary
- Recent security events

Administration
- Previous admin actions
- Suspension / reactivation history
- Support case references
```

Private content must not be present in the default 360 view.

---

## 11. LLM / API Usage Monitoring

Future monitoring should support platform-level and account-level views.

### Platform Level
- total tokens / requests
- cost by provider
- cost by model
- latency percentiles
- error rate
- throttling
- fallback usage
- regional routing
- provider health

### Account Level
- monthly usage
- cost allocation
- unusual growth
- quota status
- error rate
- fallback frequency

### Privacy Rule
Admin usage views should prefer metadata and aggregate consumption statistics. Do not expose prompts/responses merely because model usage is being monitored.

---

## 12. Agent Operations Monitoring

Admin Console should eventually monitor:
- running tasks
- queued tasks
- failed tasks
- repeatedly failing tasks
- stuck workflows
- approval bottlenecks
- automation failures
- tool/integration health
- artifact generation failures
- runtime resource pressure

The operator should see operational outcome/status, not hidden model reasoning.

Do not expose chain-of-thought.

---

## 13. Exception-First Admin Dashboard

The Admin Dashboard should prioritize exceptions over raw population lists.

Example:

```text
Users
12,482 total
+183 this week

Active users
4,312 / 30 days

Paid users
1,184

LLM cost today
$742.18

High-cost accounts
23

Failed agent runs
41

Approvals pending > threshold
17

Provider incidents
1

Suspicious login events
8
```

Then:

```text
Needs Attention

- users exceeding usage threshold
- repeated authentication anomalies
- elevated provider latency
- expired integrations
- repeated agent failures
- billing failures
- security incidents
```

Actual thresholds must be policy/configuration driven, not hardcoded assumptions from this document.

---

## 14. Admin Action Safety

Administrative mutations are high-risk.

Examples:
- suspend user
- restore account
- change role
- change entitlement
- disconnect integration
- revoke device/session
- reset authentication
- delete/export personal data
- grant sensitive investigation access

Requirements:
- consequence-specific CTA
- confirmation
- authorization check
- idempotency where appropriate
- audit log
- reason for sensitive operations
- no silent administrative mutation

---

## 15. Auditability

Every material administrative action should record:
- actor admin ID
- target user/org ID
- action type
- timestamp
- result
- reason where required
- authorization/policy result
- request/correlation ID
- scope of accessed data when relevant

Sensitive read access itself may also require audit logging.

Audit logs must not contain secrets.

---

## 16. Search and Bulk Operations

Thousands of users require efficient operations.

Future Admin Console should support:
- indexed search
- filters
- saved views
- segments
- bulk selection
- policy-controlled batch actions
- export of permitted operational data

Bulk operations must not bypass normal safety controls.

---

## 17. Automation Over Manual Administration

Preferred operating principle:

```text
Normal Case
→ automatic lifecycle handling

Exception
→ detected by policy/monitoring

High-Risk Exception
→ admin review

Sensitive Exception
→ restricted investigation workflow
```

The goal is to make the platform operationally self-managing for normal cases.

---

## 18. Authentication and Account Lifecycle Scope

Before full Admin Console implementation, NAGEX needs a canonical account lifecycle.

Required future scope includes:
- signup
- identity verification
- login
- logout
- session management
- account recovery
- optional social/enterprise login
- consent/version tracking
- account state
- suspension/reactivation
- closure/deletion workflow
- organization membership if applicable
- roles/entitlements
- administrative roles

Admin Console must operate on this canonical identity/account model rather than creating a second user database.

---

## 19. Architecture Boundary

The Admin Console is a separate operational surface.

```text
NAGEX User Surface
        |
        | canonical services / policy
        |
Admin Console
```

Both surfaces may use common backend services, but authorization policies, data projection, privacy rules, and audit requirements differ.

Admin UI must never become an alternate way to bypass user-side safety controls.

---

## 20. Suggested Implementation Roadmap

This document should be created now, but full implementation should **not** interrupt the current R12.1 UX sequence.

### Now
**Architecture / governing document only**
- define principles
- preserve privacy constraints
- prevent future incompatible design decisions

### R12.1 Increment 4
**Finish Settings UX**
- user-facing control center
- no Admin Console implementation yet

### R12.2
**Mobile UX Hardening**
- finish remaining DEBT-0005 mobile/browser validation items
- stabilize the primary user experience

### R13 — Identity & Account Lifecycle
Implement or harden:
- signup
- login/session lifecycle
- account states
- consent/version tracking
- organization membership where needed
- user/admin role separation
- entitlements
- recovery / suspension / closure

This is the prerequisite for scalable member administration.

### R14 — Admin Console Foundation
Implement:
- separate `/admin` shell
- admin authentication/authorization
- Admin RBAC/ABAC
- aggregate dashboard
- user search
- privacy-safe Member 360
- account state operations
- admin audit log
- masking
- break-glass foundation

### R15 — Operations & Cost Observability
Implement:
- model/provider usage monitoring
- LLM/API cost
- agent runtime monitoring
- integration health
- automation health
- abnormal usage detection
- incident/exception queues

### R16 — Billing / Organization / Advanced Governance
As commercial requirements mature:
- plans/credits
- organizations
- enterprise roles
- quotas
- invoicing integration
- policy management
- compliance workflows

Dependency order:

```text
User UX
→ Identity / Account Lifecycle
→ Privacy-Safe Admin Foundation
→ Operational / LLM Observability
→ Commercial / Enterprise Governance
```

---

## 21. Why Admin Console Should Not Be Built Immediately

Building the UI before identity, permissions, account states, and privacy policy boundaries are canonical would create major rework.

Dangerous failure modes include duplicate user authority, frontend-only admin permissions, unrestricted support access, fake monitoring states, privacy access bolted on after launch, account management tightly coupled to UI, and admin actions without auditability.

Therefore:

> Design now.  
> Establish identity/account authority next.  
> Implement the Admin Console on top of that authority.

---

## 22. Initial Admin Capability Matrix

Before implementation, classify each feature as:
- REAL + READABLE
- REAL + WRITABLE
- AGGREGATE ONLY
- RESTRICTED
- NOT IMPLEMENTED

| Capability | Source | Default Admin Access | Sensitive Access | Mutation |
|---|---|---|---|---|
| Account state | Identity service | Yes | No | Policy controlled |
| Plan/entitlement | Entitlement service | Yes | No | Role controlled |
| Model usage | Usage ledger | Aggregate/account totals | Prompt content prohibited by default | No |
| Agent failures | Task/runtime store | Sanitized | Private payload restricted | Retry if allowed |
| Connection state | Integration store | Status only | OAuth secret prohibited | Disconnect/reconnect policy |
| Conversation content | User data store | No | Break-glass only if justified | No normal mutation |
| API/OAuth secret | Vault | No | No | Never displayed |
| Admin audit | Audit store | Authorized admins | Security/privacy roles | Append only |

Populate this table with actual repository services only when R13/R14 implementation begins.

---

## 23. Non-Negotiable Invariants

1. Admins do not receive unrestricted private-content access by default.
2. Secrets are never exposed through Admin UI.
3. Sensitive reads are auditable.
4. High-risk actions require explicit authorization.
5. Break-glass is exceptional and time-limited.
6. Account state comes from one canonical authority.
7. Admin Console cannot bypass Approval or security policy.
8. Monitoring does not imply prompt/content access.
9. Failure and unknown state must not be shown as healthy.
10. Demo/fake user records must never leak into production operations.
11. Aggregates are preferred over individual private data.
12. Administrative UX remains separate from normal NAGEX UX.

---

## 24. Future Verification Harness

```text
========================================================
NAGEX ADMIN / MEMBER PRIVACY HARNESS
========================================================

[H1] IDENTITY
Canonical user authority                  PASS
Duplicate admin-side user store           NONE
Account lifecycle defined                 PASS

[H2] ADMIN AUTHORIZATION
Admin RBAC/ABAC                           PASS
Frontend-only authority                   NONE
Privilege escalation tests                PASS

[H3] PRIVACY
Default private-content access            NO
PII masking                               PASS
S3 secret exposure                        NONE
Break-glass controlled                    PASS
Sensitive reads audited                   PASS

[H4] MEMBER OPERATIONS
Search/filter                             PASS
Exception-first workflow                  PASS
Bulk action policy                        PASS
Manual per-user dependence                LOW

[H5] ADMIN MUTATION
Consequence-specific confirmation         PASS
Authorization before mutation             PASS
Audit event                               PASS
Idempotency where required                PASS

[H6] OBSERVABILITY
LLM usage metadata                        PASS
Provider health                           PASS
Agent/runtime health                      PASS
Prompt/content required for monitoring    NO

[H7] TRUTHFULNESS
Fake member data                          NONE
Fake health state                         NONE
Failure shown as healthy                  NO

[H8] AUDIT
Admin action traceability                 PASS
Sensitive access traceability             PASS
Secrets in logs                           NONE

--------------------------------------------------------
HARNESS RESULT                            PASS / FAIL
========================================================
```

Do not declare the Admin Console production-ready unless the relevant harness sections pass.

---

## 25. Final Product Statement

NAGEX should scale by automating normal account operations and focusing human administrators on exceptions.

At the same time, scalability must not be achieved by giving operators unrestricted visibility into users' private lives.

The target operating model is:

> **Automate the normal. Surface the exceptional. Protect the private. Audit the sensitive.**

This document is the governing foundation for NAGEX member management and the future Admin Console.

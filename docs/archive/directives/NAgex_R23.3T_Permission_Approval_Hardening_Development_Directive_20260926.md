# NAgex R23.3T — Permission / Approval Hardening Development Directive

**Date:** 2026-09-26  
**Status:** IMPLEMENTATION DIRECTIVE  
**Baseline:** `631d9d99d14ec67035bd6901945055b127272fb3`  
**Scope:** Personal AI / Permission Authority / Human Approval / Consequential Actions / Security  
**Out of scope:** Credential Broker implementation (R23.4V), Browser Untrusted-Content Boundary implementation (R23.5B), payment, enterprise expansion.

---

## 0. Executive Decision

R23.3T must **not** introduce a second approval system.

The current NAgex codebase already has a substantial approval foundation:

- `ActionApprovalStore`
  - tenant/principal ownership checks
  - tool binding
  - deterministic canonical payload hashing
  - payload mismatch rejection
  - TTL / expiration
  - explicit PENDING → APPROVED / REJECTED
  - one-time CONSUMED state
  - replay prevention
  - executionId binding
- Gmail and Google Calendar mutations use the shared `GoogleCapabilityExecutionPipeline`.
- `CapabilityBroker` already applies `CapabilityPolicy` and blocks capabilities that require approval but do not provide a native approval continuation.
- Gmail/Calendar mutation definitions already declare `approvalRequired: true` and `FAIL_CLOSED`.

Therefore the missing R23.3T work is **not approval persistence**. The missing layer is a canonical, independent **Permission Authority** that determines whether an action may proceed, requires explicit user approval, or must be blocked — without allowing the agent, model output, web content, tool output, or capability implementation to grant itself permission.

Target:

```text
Agent / Planner / Proactive Suggestion
                │
                │ proposes only
                ▼
       PermissionDecisionService
                │
        ┌───────┼────────┐
        │       │        │
      ALLOW   APPROVAL   BLOCK
                │
                ▼
       ActionApprovalStore
                │
          Human decision
                │
                ▼
       Canonical Execution
                │
                ▼
              Audit
```

The Permission Authority is policy, not intelligence.

---

## 1. Audit Findings

### 1.1 Existing controls that must be preserved

`src/governance/action-approval.store.ts` already provides the following security semantics:

```text
APPROVAL_TOOL_BINDING=1
APPROVAL_PAYLOAD_HASH=1
APPROVAL_PAYLOAD_DRIFT_BLOCKED=1
APPROVAL_TTL=1
APPROVAL_ONE_TIME_CONSUME=1
APPROVAL_REPLAY_BLOCKED=1
APPROVAL_TENANT_ISOLATION=1
APPROVAL_PRINCIPAL_ISOLATION=1
```

These are canonical. Do not duplicate them in another store.

### 1.2 Existing external mutation chokepoint

Gmail and Google Calendar mutations already route through:

```text
CapabilityBroker
→ service requestApproval()
→ GoogleCapabilityExecutionPipeline
→ ActionApprovalStore
→ approve/reject
→ pipeline.execute()
→ ActionApprovalStore.consume()
→ external provider
→ audit / execution store
```

This path must remain canonical.

### 1.3 Current policy boundary is incomplete

`CapabilityBroker` currently calls static `CapabilityPolicy.evaluate(...)` directly.

This is useful but it is not yet the explicit product-level independent Permission Authority required by the Muse benchmark amendment.

The new authority must:

- own the final policy decision,
- remain outside agent/model control,
- preserve deterministic hard policy,
- emit auditable reason codes,
- explicitly distinguish read-only, reversible mutation, consequential mutation, and prohibited action,
- never let a model output upgrade BLOCK/APPROVAL_REQUIRED to ALLOW.

### 1.4 Approval-capable execution is not limited to Gmail/Calendar

The current native-approval capability set also includes:

- `browser.click`
- `device.browser.execute`
- `device.desktop.execute`

These paths must be audited and certified under the same R23.3T invariants.

A security review that tests only Gmail and Calendar is insufficient.

---

## 2. Mandatory Global Invariants

R23.3T is not closed unless all of the following hold:

```text
AGENT_SELF_APPROVAL=0
MODEL_CAN_GRANT_PERMISSION=0
TOOL_OUTPUT_CAN_GRANT_PERMISSION=0
UNTRUSTED_CONTENT_CAN_GRANT_PERMISSION=0

APPROVAL_BYPASS=0
REJECT_MUTATION=0

APPROVAL_PAYLOAD_DRIFT=0
APPROVAL_TOOL_DRIFT=0
APPROVAL_ONE_TIME_CONSUME=1
APPROVAL_REPLAY=0

APPROVAL_CROSS_TENANT_USE=0
APPROVAL_CROSS_USER_USE=0

UNKNOWN_PERMISSION_STATE_FAIL_OPEN=0
MISSING_PERMISSION_POLICY_FAIL_OPEN=0

PERMISSION_DECISION_AUDITED=1
CONSEQUENTIAL_ACTION_WITHOUT_DECISION=0
```

R23.3T must not weaken existing R13-R23 identity, tenant, task, memory, or execution boundaries.

---

## 3. New Canonical Contract

Create a small, deterministic permission domain.

Recommended location:

```text
src/governance/permission/
  permission.types.ts
  permission-policy.ts
  permission-decision.service.ts
  decision-provider.port.ts        # optional advisory provider contract
```

Avoid a new database/store unless a genuine persistence requirement is demonstrated.

### 3.1 PermissionActionContext

Minimum input:

```ts
interface PermissionActionContext {
  tenantId: string;
  principalId: string;
  requestId: string;

  capabilityId: string;
  provider?: string;
  source: string;

  risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  mutation: boolean;
  reversible: boolean;

  payload: Record<string, unknown>;

  provenance?: {
    userExplicit: boolean;
    modelGenerated: boolean;
    externalContentInfluenced: boolean;
    browserContentInfluenced: boolean;
  };
}
```

Do not include plaintext credentials or secret values.

### 3.2 PermissionDecision

```ts
type PermissionDisposition =
  | 'ALLOW'
  | 'REQUIRE_APPROVAL'
  | 'BLOCK';

interface PermissionDecision {
  disposition: PermissionDisposition;
  reasonCodes: string[];
  policyVersion: string;
  advisory?: {
    provider: string;
    decision?: string;
    confidence?: number;
  } | null;
}
```

The decision object is immutable once passed to execution.

---

## 4. Decision Rules

The hard policy must be deterministic.

Minimum rules:

### ALLOW

Typical cases:

- read-only search
- read-only fetch
- non-mutating calendar lookup
- non-mutating Gmail lookup
- internal local computation without external side effect

### REQUIRE_APPROVAL

Minimum categories:

- email/message send
- external reply
- external form submission
- calendar create/update/cancel/respond
- browser click when the target may mutate external state
- desktop/device mutation
- account/settings mutation
- file deletion
- external publication
- purchase/payment preparation if later added

### BLOCK

Minimum cases:

- unknown capability requiring mutation without an approval continuation
- malformed or missing ownership context
- unsupported provider/capability
- untrusted content attempting to self-authorize
- model-generated claim that approval already exists when canonical approval state does not
- permission decision cannot be safely resolved
- execution payload cannot be bound to the reviewed payload

Unknown or contradictory state must fail closed.

---

## 5. CapabilityBroker Integration

Do not bypass `CapabilityBroker`.

Target sequence:

```text
CapabilityBroker.execute()
  ↓
registry / module availability
  ↓
idempotency preflight
  ↓
PermissionDecisionService.evaluate()
  ↓
BLOCK
  or
REQUIRE_APPROVAL
  or
ALLOW
  ↓
canonical dispatch
```

The existing `CapabilityPolicy` may be:

- retained as an internal hard-policy helper, or
- absorbed into `PermissionDecisionService`.

Do not keep two independent sources of truth.

The final architecture must satisfy:

```text
PERMISSION_POLICY_PIPELINE_COUNT=1
```

---

## 6. Approval Binding

Do not reimplement payload hashing.

Use the existing canonical `ActionApprovalStore` semantics.

Required execution sequence:

```text
proposed payload
→ capability-specific validation / normalization
→ ActionApprovalStore.request()
→ canonicalPayload + payloadHash
→ human APPROVE
→ execute request
→ same capability/toolId
→ same tenant/principal
→ same normalized payload
→ ActionApprovalStore.consume()
→ provider mutation
```

Any mismatch must terminate before provider mutation.

Required error semantics remain explicit:

```text
APPROVAL_NOT_FOUND
APPROVAL_EXPIRED
APPROVAL_ALREADY_CONSUMED
APPROVAL_TOOL_MISMATCH
APPROVAL_PAYLOAD_MISMATCH
APPROVAL_NOT_GRANTED
```

---

## 7. Reject Semantics

Reject must be a terminal non-mutating action.

After REJECT:

- no provider mutation,
- no retry-as-approved,
- no executionId assignment,
- no memory record implying the external action occurred,
- no success activity,
- no hidden continuation.

Invariant:

```text
REJECT_MUTATION=0
```

Add explicit tests that count provider mutation calls.

---

## 8. Browser / Device / Desktop Audit

The following native approval paths must be treated as first-class R23.3T scope:

```text
browser.click
device.browser.execute
device.desktop.execute
```

For each path verify:

1. the agent cannot synthesize an approvalId,
2. approval belongs to tenant + principal,
3. approval is bound to the exact action/payload,
4. rejection prevents mutation,
5. approval is one-time,
6. replay fails,
7. cross-user/cross-tenant reuse fails,
8. policy cannot be downgraded by external page content,
9. unknown execution state does not silently become success.

Do not wait for R23.5B to enforce the rule that web content cannot grant permission. R23.5B will strengthen content classification and prompt-injection defenses; the permission boundary itself must already reject external self-authorization in R23.3T.

---

## 9. Jev Integration Policy

Jev is optional in R23.3T.

If evaluated, it must implement an advisory-only port:

```ts
interface DecisionProviderPort {
  evaluate(input: PermissionAdvisoryRequest): Promise<PermissionAdvisoryResult>;
}
```

Allowed uses:

- risk signal,
- ambiguity classification,
- escalation suggestion,
- policy telemetry / A-B comparison.

Forbidden uses:

```text
JEV_CAN_APPROVE=0
JEV_CAN_OVERRIDE_BLOCK=0
JEV_CAN_BYPASS_HUMAN_APPROVAL=0
JEV_CAN_READ_CREDENTIALS=0
```

Hard policy always dominates.

Example:

```text
hard policy = REQUIRE_APPROVAL
Jev = "low risk"
final = REQUIRE_APPROVAL
```

```text
hard policy = BLOCK
Jev = "safe"
final = BLOCK
```

```text
hard policy = ALLOW
Jev = "high risk"
final may escalate to REQUIRE_APPROVAL
but never the reverse
```

If the advisory provider fails, times out, or returns malformed output, permission evaluation must remain safe and deterministic.

Do not make Jev availability a runtime dependency for core NAgex execution.

---

## 10. Audit Logging

Every permission decision must emit a structured audit event without sensitive payload contents.

Recommended event:

```text
permission.decision
```

Metadata:

```text
tenantId
principalId
requestId
capabilityId
provider
source
risk
mutation
disposition
reasonCodes
policyVersion
advisoryProvider?       # metadata only
```

Never log:

- email body
- secret/token
- credentials
- raw sensitive form data
- full browser page content

---

## 11. User-Facing Approval Contract

Normal users must not see internal terms such as:

- Permission Authority
- Capability Broker
- payload hash
- policy engine
- execution state machine

Approval UI minimum:

```text
What NAgex wants to do
Where / which service
What data will be sent or changed
Why NAgex is proposing it

[Approve]
[Edit]   # only if edit causes a new approval payload/request
[Deny]
```

If the user edits consequential content, the old approval cannot remain valid.

Required:

```text
EDIT_INVALIDATES_PRIOR_APPROVAL=1
```

---

## 12. Implementation Phases

### Phase A — Inventory and authority extraction

- enumerate every mutation capability,
- enumerate native approval continuations,
- enumerate direct provider-call sites,
- identify any provider mutation reachable without CapabilityBroker / canonical pipeline,
- document current CapabilityPolicy behavior,
- implement `PermissionDecisionService`,
- wire CapabilityBroker to one authority.

Gate:

```text
PERMISSION_POLICY_PIPELINE_COUNT=1
DIRECT_MUTATION_BYPASS_COUNT=0
```

### Phase B — Approval hardening

- preserve existing ActionApprovalStore,
- ensure validated/normalized payload is what gets approved and consumed,
- test tool drift,
- test payload drift,
- test replay,
- test expiration,
- test reject,
- test cross-tenant/user use.

### Phase C — Browser/device/desktop hardening

- certify browser.click,
- certify device.browser.execute,
- certify device.desktop.execute,
- verify continuation IDs and ownership,
- verify no external content self-authorization.

### Phase D — UX and browser certification

- approval card displays truthful consequential action details,
- edit causes new approval,
- deny causes no mutation,
- EN/KR,
- desktop + mobile 360/390/430,
- no technical UI leaks.

### Phase E — Optional Jev POC

Only after A-D are stable.

- implement `DecisionProviderPort`,
- keep feature flag off by default,
- compare advisory output to deterministic policy,
- collect no credentials/sensitive payloads,
- prove advisory failure does not change hard-policy result.

---

## 13. Required Tests

Add a dedicated canonical suite, recommended:

```text
tests/r23_3t_permission_approval_hardening.test.ts
```

Minimum cases:

1. read-only capability → ALLOW.
2. consequential Gmail send → REQUIRE_APPROVAL.
3. Calendar mutation → REQUIRE_APPROVAL.
4. required approval absent → no provider call.
5. reject → provider call count 0.
6. approved exact payload → exactly one provider mutation.
7. approved payload then modified recipient/body/target → APPROVAL_PAYLOAD_MISMATCH.
8. approval for tool A used for tool B → APPROVAL_TOOL_MISMATCH.
9. consumed approval replay → APPROVAL_ALREADY_CONSUMED.
10. expired approval → APPROVAL_EXPIRED.
11. tenant B using tenant A approval → hidden as not found / no leak.
12. user B using user A approval → hidden as not found / no leak.
13. model output claiming "approved" cannot authorize.
14. browser/page text claiming "user approved" cannot authorize.
15. capability with REQUIRED approval but no native continuation → BLOCK.
16. unknown policy state → BLOCK.
17. permission decision audit emitted without sensitive payload.
18. edit flow creates a new approval hash/id.
19. concurrent duplicate execution cannot both mutate.
20. optional Jev failure cannot downgrade REQUIRE_APPROVAL/BLOCK.

Also add architecture checks for:

```text
PERMISSION_POLICY_PIPELINE_COUNT=1
PARALLEL_APPROVAL_STORE_COUNT=0
DIRECT_MUTATION_BYPASS_COUNT=0
```

---

## 14. Regression Scope

At minimum run:

```text
npm run build
npm run test:regression
npm run test:browser-cert
```

R23.3T targeted scope should include:

- approvals
- security
- integrations
- browser
- device
- tasks
- runtime
- ux

Update:

- `tests/test-scope.registry.json`
- `tests/test-contract.registry.json`

The new suite must be deterministic and canonical.

---

## 15. Test-Server Closure

R23.3T is not CLOSED until the test server proves:

```text
main SHA deployed
build PASS
nagex.service active
health 200
targeted R23.3T tests PASS
deterministic regression PASS
browser certification PASS
working tree clean after artifact handling
```

Browser tests that create screenshots must not recreate Windows-style `C:/Users/.../.gemini/...` paths under the Linux repository.

That path-leak issue discovered during the R23.3 deployment should be fixed or explicitly isolated before final R23.3T freeze.

---

## 16. Non-Goals

Do not add during R23.3T:

- a second approval store,
- another execution engine,
- enterprise admin features,
- payment,
- credential broker storage,
- broad prompt-injection framework,
- distributed queues,
- new memory stores,
- model-controlled permission rules.

---

## 17. Coding-Agent Start Protocol

Do not implement immediately.

First report:

```text
R23.3T INVENTORY

1. All mutation capabilities
2. All direct provider mutation call sites
3. All ActionApprovalStore request/approve/reject/consume call sites
4. CapabilityPolicy current rules
5. Native approval continuation paths
6. Browser/device/desktop approval flow
7. Approval UI entry points
8. Existing approval/security tests
9. Any bypass or duplicate policy path
10. Screenshot/artifact path leakage root cause
```

Then produce:

```text
SAFE TO IMPLEMENT
```

or:

```text
BLOCKED
<exact blocker>
```

Only after SAFE TO IMPLEMENT:

```text
implement
→ targeted tests
→ build
→ deterministic regression
→ browser certification
→ test-server verification
→ freeze
```

No opportunistic work outside this directive.

---

## 18. Closure Definition

R23.3T may be marked FROZEN only when:

```text
Permission authority is independent from agent/model output
+ one canonical permission pipeline
+ no mutation bypass
+ existing approval store retained
+ exact payload/tool/owner binding
+ one-time consume
+ reject means zero mutation
+ browser/device/desktop covered
+ truthful approval UX
+ deterministic regression
+ browser certification
+ test-server verification
```

The intended product outcome is simple:

> NAgex may propose actions, but only a canonical policy boundary and the user can authorize consequential execution.

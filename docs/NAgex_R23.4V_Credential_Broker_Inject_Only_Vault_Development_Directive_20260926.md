# NAgex R23.4V — Credential Broker / Inject-only Vault MVP Development Directive

**Date:** 2026-09-26  
**Status:** IMPLEMENTATION DIRECTIVE  
**Previous Milestone:** R23.3T Permission / Approval Hardening — CLOSED  
**Current Milestone:** R23.4V  
**Scope:** Secret isolation, credential references, scoped credential use, provider binding, inject-only execution, audit, BYOK foundation  
**Out of Scope:** Full enterprise secrets management, payment, browser prompt-injection framework, broad provider marketplace, distributed secret infrastructure

---

## 0. Executive Decision

R23.4V is the next canonical NAgex milestone.

The goal is not to create a generic password manager.

The goal is:

> NAgex can use a credential without the agent, planner, model, memory system, activity system, approval payload, or ordinary application code receiving the plaintext secret.

Target:

~~~text
User / OAuth / BYOK
      ↓
Credential Store
      ↓
Credential Broker
      ↓
scoped credential handle
      ↓
authorized execution boundary
      ↓
just-in-time injection
      ↓
provider / connector
~~~

The agent sees a reference, never the secret.

---

# 1. Benchmark Inputs Applied

This milestone directly applies previously reviewed lessons.

## Meta Muse

Apply:

- credential surrogation concept
- security-sensitive credential service outside agent reasoning
- independent permission boundary
- just-in-time use

Do not copy vendor-specific architecture names or assume equivalent infrastructure already exists.

## BYOK strategy

R23.4V must become the security foundation for future:

~~~text
Managed provider credentials
BYOK
Private provider endpoints
Connected service credentials
~~~

## Google / Microsoft

Google OAuth is the first practical credential-bearing integration family already present.

Microsoft should later reuse the same broker contract rather than build a second token system.

## Jev

Jev is not part of the secret path.

~~~text
JEV_CAN_READ_CREDENTIALS=0
~~~

## Browser / Reservation / Payment

Credential Broker must be designed so later browser login, reservation, and payment flows can request scoped credential use without receiving plaintext.

---

# 2. Mandatory Invariants

~~~text
MODEL_CAN_READ_SECRET=0
AGENT_CAN_READ_SECRET=0

SECRET_IN_PROMPT=0
SECRET_IN_MODEL_REQUEST=0
SECRET_IN_LOG=0
SECRET_IN_AUDIT=0
SECRET_IN_ACTIVITY=0
SECRET_IN_MEMORY=0
SECRET_IN_APPROVAL_PAYLOAD=0

CREDENTIAL_INJECT_ONLY=1
CREDENTIAL_REFERENCE_ONLY=1

CREDENTIAL_SCOPE_ENFORCED=1
CREDENTIAL_PROVIDER_BOUND=1
CREDENTIAL_USER_BOUND=1
CREDENTIAL_TENANT_BOUND=1

CROSS_TENANT_SECRET_ACCESS=0
CROSS_USER_SECRET_ACCESS=0

UNKNOWN_CREDENTIAL_FAIL_OPEN=0
EXPIRED_CREDENTIAL_FAIL_OPEN=0
REVOKED_CREDENTIAL_FAIL_OPEN=0

CREDENTIAL_USE_AUDITED=1
PLAINTEXT_EXPORT_TO_AGENT=0
~~~

---

# 3. Do Not Build a Second OAuth System

Inventory first.

NAgex already contains Google OAuth/token functionality.

Before implementation, identify:

~~~text
token stores
OAuth token persistence
GoogleCalendarService token resolution
GmailService token resolution
connected-app state
env encryption usage
NAGEX_TOKEN_ENCRYPTION_KEY behavior
all access-token call sites
all refresh-token call sites
all places tokens can enter logs/errors
~~~

The existing token system should be wrapped/migrated behind the broker contract where feasible.

Do not create a parallel Google credential source of truth.

Target:

~~~text
CREDENTIAL_SOURCE_OF_TRUTH_COUNT=1 per credential family
~~~

---

# 4. Canonical Types

Recommended module:

~~~text
src/security/credentials/
  credential.types.ts
  credential-store.ts
  credential-broker.service.ts
  credential-policy.ts
  index.ts
~~~

Alternative location is acceptable if existing module boundaries require it.

## CredentialReference

Suggested fields:

~~~text
credentialRef
tenantId
principalId
provider
credentialType
scopes
status
createdAt
expiresAt
~~~

This object may be agent-visible.

It must contain no secret material.

## CredentialUseRequest

Suggested fields:

~~~text
credentialRef
tenantId
principalId
provider
requiredScopes
purpose
requestId
capabilityId
~~~

## CredentialLease / Injection Handle

Do not return plaintext.

Preferred abstraction:

~~~text
leaseId
credentialRef
provider
expiresAt
~~~

Actual secret resolution remains inside a privileged execution callback/boundary.

---

# 5. Preferred Service API

Do not expose:

~~~text
GET /credentials/:id/plaintext
GET /credentials/:id/token
exportSecret()
readPassword()
~~~

Preferred pattern:

~~~text
credentialBroker.withCredential(
  request,
  privilegedProviderCallback
)
~~~

The callback receives the minimum provider-specific injected form.

Ordinary agent/planner/service layers receive only references.

---

# 6. Google Migration First

Initial target:

~~~text
Gmail
Google Calendar
~~~

Current pattern:

~~~text
service
→ tokenStore.getValidAccessToken(...)
→ raw access token
→ fetch Google API
~~~

Target pattern:

~~~text
service execution request
→ CredentialBroker
→ ownership/scope/provider policy
→ privileged access-token injection
→ Google provider adapter/fetch
~~~

The token may exist transiently inside the privileged adapter call because the external API requires it.

Requirements:

- token never returned to agent/planner
- token never logged
- token never put in approval payload
- token never stored in memory/activity
- token never exposed through normal API responses

---

# 7. Encryption / Persistence

Known operational issue:

> Google OAuth persistence may not survive restart when NAGEX_TOKEN_ENCRYPTION_KEY is not configured.

R23.4V must classify startup state explicitly:

~~~text
CONFIGURED
DEGRADED
UNAVAILABLE
~~~

If persistent credential storage is enabled and encryption key is missing:

~~~text
fail closed for persistent secret write
~~~

Do not silently store plaintext.

An explicit test/dev-only ephemeral credential store may be allowed, but it must be classified as:

~~~text
EPHEMERAL_TEST_ONLY
~~~

Never present ephemeral token state as restart-safe.

---

# 8. Scope Enforcement

Each credential use verifies:

~~~text
credential tenant == request tenant
credential principal == request principal
credential provider == requested provider
credential status == ACTIVE
required scopes subset of granted scopes
credential not expired
credential not revoked
~~~

Wrong user/tenant should be externally indistinguishable from missing credential where appropriate.

---

# 9. Permission Authority Integration

Credential Broker does not replace Permission Authority.

Required sequence for consequential actions:

~~~text
Agent proposes action
→ PermissionDecisionService
→ Human Approval if required
→ canonical approved payload
→ Credential Broker authorizes credential use
→ inject credential
→ provider mutation
→ audit
~~~

Credential existence must never imply permission.

~~~text
HAS_CREDENTIAL ≠ MAY_EXECUTE
~~~

---

# 10. Approval Payload Rules

Approval cards may show:

~~~text
service/provider
account display label
scope summary
what data/action will be sent
why
~~~

Approval payload must not contain:

~~~text
access token
refresh token
password
API key
session cookie
encryption key
raw credential blob
~~~

Reference IDs are acceptable.

---

# 11. Audit Rules

Recommended events:

~~~text
credential.registered
credential.updated
credential.revoked
credential.use_requested
credential.use_allowed
credential.use_denied
credential.injected
credential.refresh_succeeded
credential.refresh_failed
~~~

Allowed metadata:

~~~text
credentialRef
provider
credentialType
tenantId
principalId
scope names
capabilityId
requestId
reason code
status
~~~

Never audit secret values.

---

# 12. Secret Redaction

Generic sensitive-key redaction is useful but insufficient as the sole defense.

R23.4V must test secret non-propagation at:

~~~text
logs
audit
activity
memory
model request
HTTP error response
approval record
task state
browser evidence metadata
~~~

Do not rely only on key-name filtering.

Add canary-secret tests using unique marker strings.

---

# 13. BYOK Foundation

R23.4V should support the future BYOK contract without requiring full BYOK UI now.

~~~text
User adds provider key
→ secure registration
→ CredentialReference
→ model/provider registry binds credentialRef
→ Model Gateway requests scoped use
→ broker injects key only at provider adapter
~~~

Do not implement wide BYOK provider coverage during this milestone.

One provider-shaped test adapter is sufficient to prove architecture.

---

# 14. Browser Credential Injection

Do not build broad browser login automation yet.

R23.4V only needs the boundary contract that R23.5B can consume later.

Future target:

~~~text
Browser action requires login
→ browser runtime requests credentialRef use
→ permission/site policy checked
→ credential injected into exact allowed origin/field/request
→ agent never receives secret
~~~

Future-compatible metadata:

~~~text
allowedOrigins
allowedProvider
allowedCapability
allowedScopes
leaseExpiry
~~~

Do not inject credentials into arbitrary origins.

---

# 15. Tests

Add:

~~~text
tests/r23_4v_credential_broker.test.ts
~~~

Minimum deterministic cases:

1. register/store secret returns only credentialRef metadata.
2. secret value is absent from returned reference.
3. correct tenant/user/provider/scope can use credential.
4. wrong tenant denied.
5. wrong user denied.
6. wrong provider denied.
7. missing scope denied.
8. expired credential denied.
9. revoked credential denied.
10. unknown credential denied.
11. model-facing object contains no secret.
12. approval record contains no secret.
13. audit contains no secret.
14. activity contains no secret.
15. memory contains no secret.
16. thrown provider error does not leak secret.
17. credential refresh result does not leak refresh token.
18. one credential cannot be used for a different provider.
19. missing encryption key never causes plaintext persistent write.
20. test/dev ephemeral mode is explicitly classified.
21. existing Gmail flow still works through broker.
22. existing Calendar flow still works through broker.
23. restart/persistence behavior is truthful.
24. broker use does not bypass PermissionDecisionService.
25. canary secret marker appears zero times in serialized non-secret stores.

Architecture invariants:

~~~text
PARALLEL_GOOGLE_TOKEN_SOURCE=0
PLAINTEXT_CREDENTIAL_API=0
AGENT_CREDENTIAL_READ_PATH=0
~~~

---

# 16. Test Scope

Create scope:

~~~text
credential-broker
~~~

Include at minimum:

- R23.4V broker tests
- Google token persistence
- Gmail integration
- Calendar integration
- permission/approval hardening
- audit isolation/redaction
- connected-app state
- model-provider security boundary where relevant

Development PC:

~~~text
npm run build
node scripts/nagex-test-scope.mjs credential-broker
~~~

Test server:

~~~text
npm run build
targeted credential-broker tests
npm run test:regression
affected browser certification
health
working-tree verification
~~~

---

# 17. Implementation Phases

## Phase A — Inventory

Before code:

~~~text
all credential stores
all token access methods
all Google access-token resolution
all refresh paths
all secret-bearing env vars
all persistence/encryption logic
all log/error paths
all connected-app state paths
~~~

Output:

~~~text
SAFE TO IMPLEMENT
~~~

or exact blocker.

## Phase B — Broker Contract

- CredentialReference
- CredentialUseRequest
- CredentialPolicy
- CredentialBrokerService
- privileged injection callback
- audit

No UI expansion.

## Phase C — Google Migration

- Gmail
- Calendar
- OAuth persistence
- refresh path
- token-store compatibility

Prove no duplicate source of truth.

## Phase D — Non-propagation Hardening

- audit
- logs
- activity
- memory
- approval payloads
- model requests
- error surfaces

Canary-secret tests mandatory.

## Phase E — BYOK / Browser-ready Interfaces

- provider-neutral reference metadata
- origin/scope restrictions
- lease/injection abstraction
- no broad browser-login automation yet

---

# 18. Explicit Non-goals

Do not add:

- generic password-manager UI
- arbitrary secret export
- payment credential storage
- HSM/KMS complexity unless required
- full enterprise key rotation management
- browser login automation across many sites
- Jev inside the secret path
- a second OAuth subsystem
- new memory stores
- new execution engine
- new permission engine

---

# 19. Closure Definition

R23.4V is FROZEN only when:

~~~text
credential reference model exists
+ agent/model cannot read secret
+ provider-bound scoped use
+ user/tenant isolation
+ inject-only provider execution
+ Gmail/Calendar use canonical broker path
+ persistent storage never silently plaintext
+ audit/use events contain metadata only
+ canary-secret leakage tests pass
+ Permission Authority remains authoritative
+ deterministic regression passes
+ affected browser tests pass
+ test-server verification passes
~~~

---

# 20. Immediate Coding-Agent Instruction

Start with inventory only.

Report:

~~~text
R23.4V CREDENTIAL INVENTORY

1. Existing credential/token stores
2. Google OAuth token persistence implementation
3. NAGEX_TOKEN_ENCRYPTION_KEY usage
4. Gmail token resolution call path
5. Calendar token resolution call path
6. Refresh-token path
7. Connected-app status dependencies
8. All raw secret/token return paths
9. All audit/log/error paths that could serialize secrets
10. Any model/prompt/activity/memory path receiving credential material
11. Existing relevant tests
12. Duplicate/parallel token sources
~~~

Then:

~~~text
SAFE TO IMPLEMENT
~~~

or:

~~~text
BLOCKED
<exact blocker>
~~~

Only after SAFE TO IMPLEMENT should Phase B begin.


---

## Implementation Status — 2026-09-27

### Completed and locally targeted-certified

- Phase A — Credential inventory
- Phase B1 — CredentialReference / CredentialBroker contract
- Phase B2 — tenant + principal ownership and OAuth continuation binding
- Phase C — Gmail / Calendar canonical broker migration
- Phase D — Secret Non-Propagation Hardening

Latest completed local evidence supplied by the developer workstation:

~~~text
credential-broker scope
tests 171
pass 171
fail 0
~~~

### Phase E — implemented and locally targeted-certified

Implemented contract:

~~~text
CredentialReference
  allowedOrigins?
  allowedCapabilities?

CredentialUseRequest
  origin?
  capabilityId?

CredentialLease
  provider
  scopes
  capabilityId?
  origin?
  expiresAt
~~~

Policy:

- origin mismatch fails closed before secret resolution
- capability mismatch fails closed before secret resolution
- lease contains metadata only, never plaintext credential material
- browser runtime injection is intentionally not enabled in R23.4V
- R23.5B must establish the untrusted-content/site boundary before browser credential injection is connected
- future BYOK provider adapters should consume the same broker/reference/lease contract instead of introducing a parallel secret path

Latest Phase E local targeted evidence:

~~~text
credential-broker scope
tests 173
pass 173
fail 0
~~~

R23.4V remains OPEN until:

1. deterministic regression passes
2. PR #5 is merged
3. test-server build/restart/health verification passes
4. test-server deterministic regression passes
5. affected browser certification passes
6. test-server working tree is clean

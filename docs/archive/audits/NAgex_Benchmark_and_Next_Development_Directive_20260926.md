# NAgex Benchmark & Next Development Directive

Date: 2026-09-26
Status: Canonical development input / R23.4V handoff

## 1. Reviewed references and how NAgex should use them

### Meta Muse
Use as the primary product/security benchmark for persistent agent runtime, background execution, credential isolation, independent permission authority, untrusted-content defense, browser/computer execution, and auditability. Do not copy it as product identity. NAgex should differentiate through editable personal memory, provenance, personal context, permission transparency, credential isolation, and user-governed execution.

### Jev
Use only as an optional advisory decision provider. Suitable for risk classification, ambiguity detection, retry/abort/escalate signals, completion checks, evidence-sufficiency signals, inbox/action classification, and model-tier routing. Never let Jev approve, override BLOCK, bypass human approval, or access credentials.

### Wissly
Use its evidence UX ideas for Vault, Search, Research, and Memory provenance: answer -> source -> inspectable original evidence. Do not turn NAgex into a document-QA-only product.

### WebMCP
Preserve the execution priority: Native API -> MCP/WebMCP/structured tool -> structured browser/DOM -> vision browser -> desktop visual control. API/structured execution should remain preferred over visual automation.

### Multi-model orchestration
Keep NAgex model-neutral. Route tasks by capability, privacy, quality, latency, and cost. Cloud and private/local models are replaceable providers; the model itself is not NAgex.

### OpenAI / Gemini / Nebius / NVIDIA Nemotron / Claude / Qwen / DeepSeek / GLM / HyperCLOVA X / EXAONE
Use through provider-neutral adapters. Security/privacy eligibility must precede cost. Nebius/NVIDIA remain important for the hackathon. Claude is a useful optional provider. Qwen/DeepSeek/GLM are diversification/cost options. HyperCLOVA X/EXAONE are optional regional/Korean-language providers.

### Ollama / LM Studio / vLLM
Ollama and LM Studio are useful for local development. vLLM is the stronger long-term self-hosted/private serving candidate. Local/private inference should support sensitive memory preprocessing, PII/secret detection, private summarization, local embeddings, and privacy-sensitive workloads.

### Antigravity
Treat as a development environment, not a NAgex runtime dependency. Integrate models through standard APIs/MCP rather than coupling NAgex to the IDE.

### OpenCode Go / Muse Spark / CheapAI / Cafe24 LLM Router
Use only for development cost optimization, compatibility testing, fallback experiments, or architectural reference. Do not make them trust-critical production dependencies by default.

### Managed AI / BYOK / Private
Long-term NAgex should support three modes: Managed, BYOK, Private/Local. R23.4V Credential Broker is the prerequisite for safe BYOK.

### Google / Microsoft
Google remains first-class because Identity, Gmail, Calendar, Drive, and Docs form one connected ecosystem. Microsoft should later reuse the same credential/connector architecture for Outlook, Calendar, OneDrive, Office, and Teams. Kakao is not a current priority.

### Browser / Desktop / Android
Browser and Windows desktop execution are strategic differentiation, but they remain downstream of Permission Authority and Credential Broker. Android device control is later-stage work.

### Reservation / 모두닥-style workflow
Reservation is a strong candidate for the R23.6E real E2E scenario because it exercises context, search, comparison, approval, execution, calendar, activity, and memory. Do not hardcode NAgex around one provider; select a target based on API availability, automation policy, reproducibility, login requirements, and safety.

### Stripe Link / payment delegation
Use as a future reference for tokenized, user-approved transactions where the agent never receives raw card details. Payment remains P2 after Permission Authority, Credential Broker, Browser Trust Boundary, and real reservation/transaction execution.

## 2. Priority

P0 / immediate:
- Credential Broker / inject-only Vault
- Browser untrusted-content boundary
- API-first/WebMCP structured control
- multi-model routing
- local/private model support
- persistent memory + provenance
- Google ecosystem

P1:
- Jev advisory POC
- reservation workflow
- Wissly-style evidence UX expansion
- background runtime certification
- governed personality
- Microsoft ecosystem

P2:
- payment
- Android Device Bridge
- full BYOK UI
- advanced provider marketplace

## 3. Updated roadmap

R23.2D Demo Canonicalization — CLOSED
R23.3T Permission / Approval Hardening — CLOSED
R23.4V Credential Broker / Inject-only Vault — CURRENT
R23.5B Browser Untrusted-Content Boundary
R23.6E One Complete Real E2E Agent Scenario
R23.7G Background Runtime Certification
R23.8P Governed Personality / Trust UX
R23.9C Final Hackathon Certification

## 4. R23.4V core objective

NAgex must be able to use a credential without the agent, planner, model, memory, activity, approval payload, or ordinary application layer receiving the plaintext secret.

Target flow:
User/OAuth/BYOK -> encrypted credential store -> Credential Broker -> scoped reference/lease -> authorized execution boundary -> just-in-time injection -> provider/connector

Mandatory invariants:
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
CREDENTIAL_USE_AUDITED=1
PLAINTEXT_EXPORT_TO_AGENT=0

## 5. R23.4V inventory findings already confirmed

1. Canonical Google token persistence currently lives in src/integrations/google/token.store.ts and token.crypto.ts.
2. Persistent storage uses AES-256-GCM and NAGEX_TOKEN_ENCRYPTION_KEY.
3. Existing tests already verify restart persistence, refresh, wrong-key/corrupt-file fail-closed behavior, encrypted on-disk storage, 0600 permissions on POSIX, token non-exposure in status, refresh-token preservation, and atomic replacement.
4. Gmail and Calendar share the same Google token store, which is a good single migration seam.
5. Critical gap: GoogleOAuthTokenStore is keyed by tenantId only. It has no principalId/user binding.
6. Critical gap: Google OAuth callback state is a single global pending string and the callback saves by tenant only; the audit connect actor is hardcoded as usr_admin_001.
7. Therefore the final R23.4V model must migrate to tenant + principal + provider/account-bound credential identity.
8. Current getValidAccessToken returns a raw token string to Gmail/Calendar internals. The migration target is CredentialBroker.withCredential(...) or equivalent privileged callback so the raw token exists only inside the provider boundary.
9. Do not create a second Google token source of truth.
10. R23.3T PermissionDecisionService remains authoritative. Having a credential never grants permission to execute.

## 6. R23.4V implementation sequence

Phase A — Inventory: COMPLETE / SAFE TO IMPLEMENT WITH REQUIRED MIGRATION

Phase B1 — Broker contract
- CredentialReference
- CredentialUseRequest
- CredentialPolicy
- CredentialBrokerService
- metadata-only audit
- no UI expansion

Phase B2 — Identity migration
- principal-bound Google credential record
- OAuth state bound to tenant+principal+nonce+expiry
- one-time callback continuation
- no hardcoded audit actor

Phase C — Google migration
- Gmail through broker
- Calendar through broker
- OAuth persistence/refresh through broker
- prove PARALLEL_GOOGLE_TOKEN_SOURCE=0

Phase D — non-propagation hardening
- canary-secret tests across audit/log/activity/memory/model request/error/approval/task state

Phase E — BYOK/browser-ready interfaces
- provider-neutral credential references
- scoped leases
- origin/provider/capability restrictions
- no broad browser-login automation yet

## 7. Required closure tests

At minimum:
- secret absent from CredentialReference
- correct owner/provider/scope can use credential
- wrong tenant/user/provider/scope denied
- expired/revoked/unknown credential denied
- secret absent from model-facing objects, approval, audit, activity, memory, and HTTP errors
- missing encryption key never results in plaintext persistence
- explicit EPHEMERAL_TEST_ONLY mode for dev/test if needed
- Gmail and Calendar still function through broker
- restart persistence remains truthful
- broker cannot bypass PermissionDecisionService
- canary secret marker appears zero times outside privileged credential boundary

## 8. Non-goals for R23.4V

- generic password manager
- arbitrary secret export
- payment credential storage
- enterprise KMS/HSM complexity unless required
- broad browser login automation
- Jev inside the credential path
- second OAuth subsystem
- new permission engine
- new execution engine
- new memory store

## 9. Final product principle

The LLM is not NAgex.

NAgex is the governed personal intelligence and execution layer that keeps memory, context, credentials, permissions, approvals, and execution history under one trusted user-controlled system while allowing many replaceable models and external services behind it.

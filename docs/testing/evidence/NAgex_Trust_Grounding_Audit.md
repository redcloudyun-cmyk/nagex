# NAgex Trust & Grounding Foundation: Architecture Audit

**Status**: AUDIT COMPLETE - NO IMPLEMENTATION
**Target**: Prepare for R25+ Trust & Grounding Requirements

## 1. Executive Summary
This audit validates the existing NAgex components against the 14 Trust & Grounding requirements (T1-T14) specified for post-R24 functional completion. The core finding is that the R22.4 Evidence Pack and R22.5 Model Routing architectures provide a strong foundation, but require structural extensions to support strict provenance, claim-level verification, and execution parameter binding.

**DO NOT build a parallel runtime.** All requirements can and must be met by extending the existing engines.

---

## 2. Component Analysis & Gaps

### 2.1 Evidence Pack Architecture (T2, T4, T6, T11)
**Current State**:
- `EvidencePackService` (`src/research/evidence-pack.service.ts`) and `EvidencePack` / `EvidenceSource` types exist.
- Supports `evidencePackId` and basic source mapping.
- Browser evidence supports `evidenceId` generation and tenant isolation.

**Identified Gaps**:
- `EvidenceSource` metadata is incomplete. Needs `sourceType`, `retrievedAt`, `publishedAt`, `freshness`, `authority/reliability`, and `contentHash`.
- Missing claim extraction and verification loop within the pack lifecycle.
- Need strict enforcement that `evidenceId` cannot be fabricated by the LLM (T6).

### 2.2 Model Routing & Context (T1, T9, T10)
**Current State**:
- `ModelRoutingContext` (`src/model-gateway/model-routing.types.ts`) and `UnifiedModelRouter` exist.
- Handles intent, token limits, and capability-based routing.

**Identified Gaps**:
- `ModelRoutingContext` must be expanded to include: `groundingPolicy` (NONE, PREFERRED, REQUIRED, STRICT), `riskClass` (LOW, MEDIUM, HIGH, CRITICAL), `requiresEvidenceGrounding`, `requiresAuthoritativeSource`, and `verificationRequired`.
- The router must select verifier models independently of generation models without treating consensus as truth.

### 2.3 Memory & Vault Trust Boundary (T7)
**Current State**:
- User Memory exists but is treated as a flat context layer without strict provenance weighting.

**Identified Gaps**:
- Must introduce `MemoryProvenance` tags: `USER_STATED`, `SYSTEM_OBSERVED`, `EXTERNALLY_VERIFIED`, `INFERRED`.
- Need rules to prevent inferences from being silently upgraded to verified facts.

### 2.4 Action Safety Gate & Execution (T8)
**Current State**:
- `ExecutingTaskRunner` (`src/tasks/runners/executing-task.runner.ts`) and Approval Engine exist.
- Approvals block unauthorized consequential actions.

**Identified Gaps**:
- **Parameter Drift Binding**: The approval snapshot must cryptographically or immutably bind execution parameters. If parameters change post-approval, a `REAPPROVAL_REQUIRED` state must be triggered.
- LLM outputs must be routed through this rigid gate rather than directly mutating transaction states.

### 2.5 Claim-Level Verification & Response Policy (T3, T5)
**Current State**:
- Generative paths often assume prompt-based truthfulness.
- No formal deterministic claim extraction.

**Identified Gaps**:
- New pipeline step needed post-generation: Extract factual claims -> Map to Evidence Pack -> Evaluate status (`SUPPORTED`, `PARTIALLY_SUPPORTED`, `UNSUPPORTED`, `CONFLICTING`).
- Deterministic response enforcement: Based on `GroundingPolicy`, unsupported claims in a STRICT context must result in `ABSTAIN`, `CLARIFY`, or `ANSWER_WITH_UNCERTAINTY` (never `ANSWER_AS_FACT`).

---

## 3. Required Implementation Plan (Phase Next)

1. **Schema Expansion**:
   - Update `EvidenceSource` in `evidence-pack.types.ts`.
   - Update `ModelRoutingContext` in `model-routing.types.ts`.
   - Add `GroundingPolicy` and `RiskClass` enums.
2. **Provenance Integration**:
   - Update Memory Engine to store and evaluate provenance tags.
3. **Verification Pipeline**:
   - Implement `ClaimVerifierService` utilizing independent verification routing.
4. **Approval Binding**:
   - Update `ApprovalEngine` to hash or deeply freeze execution parameters and validate them at the execution boundary.
5. **Observability & Telemetry**:
   - Update `AuditLogger` to trace `groundingPolicy`, `riskClass`, and `claimVerificationStatus`.

## 4. Invariant Commitments (T13, T14)
The implementation will guarantee:
- `FAKE_SUCCESS_PATHS=0`
- `FAKE_CITATION_PATHS=0`
- `UNSUPPORTED_CLAIM_AS_VERIFIED=0`
- `STRICT_UNGROUNDED_ANSWER=0`
- `MODEL_CONSENSUS_AS_TRUTH=0`
- `APPROVAL_PARAMETER_DRIFT=0`

*(No implementation is committed in this step. Awaiting user approval to proceed with schema expansions.)*

# NAgex D-09 Track B — Codex Demo Readiness Audit

Date: 2026-10-15 KST
Branch: `qa/codex-demo-readiness-20261015`
BASE_SHA: `67fdcf0ae4e32058299cc35cf7b3d79cbce69bc0`
TESTED_SHA: `67fdcf0ae4e32058299cc35cf7b3d79cbce69bc0`
Scope: independent, non-mutating QA for the October 25 demonstration

## Status

**LOCAL CONTRACTS PASS; DEMO READINESS BLOCKED for live-provider and hosted proof.**

The Codex track changed only its exclusive certification script and this report. No `src/**`, `public/**`, `tests/**`, test registry, deployment file, service, test-server data, account, connected provider or persistent hosted store was changed.

## Governing contract and ownership

- Governing work order: `docs/evidence/NAGEX_D09_TWO_AGENT_DISJOINT_PARALLEL_ORDER_20261015.md`.
- Product/quality authority: `MASTER.md`, the project index, AI development governance, AI/model, creation, trust/approval, testing and hackathon canonical documents.
- Codex write allowlist honored: `scripts/demo-certification/codex/**` and this `NAGEX_D09_CODEX_DEMO_AUDIT_*.md` report.
- Claude worktrees were not edited, rebased, merged or inspected for modification.

## Evidence matrix

| Area | Result | Evidence boundary |
|---|---|---|
| One Input KO/EN routing | **PASS** | Local production classifier and HTTP contract: 66/66 tests; independent matrix: 6/6. No execution authority is created by routing. |
| Natural-language fallback/unsupported handling | **PASS** | Advice, action plan, document, negated send, unsupported video and vague request all matched expected decisions locally. |
| Main browser route mapping | **PASS (static)** | Read-only source audit confirms composer → `POST /api/v1/workspace/route-input`, document create/open routes, and approval request/verdict routes. Browser execution was not promoted to PASS. |
| Nemotron selection | **PASS (local contract)** | Existing routing suite passes; independent local stub selected `nebius` / `nvidia/Nemotron-3_5-Lightning` with no fallback. This is not a real Nebius call. |
| Real Nemotron provider | **NOT_RUN / BLOCKED** | `scripts/one-input-live-cert.mjs`, `scripts/nemotron-first-live-cert.mjs` returned opt-in `NOT_RUN`; no credential or paid provider call was used. |
| Document create → save → Recent → reopen | **PASS (local disposable store)** | Real `CreationRuntime`, `DocumentExecutor`, `DocumentStore` and `ArtifactStore` with a local model stub: save, Recent projection, fresh-store reopen and owner isolation all passed. |
| Real-model document round-trip | **NOT_RUN / BLOCKED** | `scripts/document-roundtrip-live-cert.mjs` returned opt-in `NOT_RUN`; hosted document storage was not touched. |
| Human Approval boundary | **PASS (local boundary)** | 18/18 independent checks: no write before approval, owner isolation, exact payload hash, one-time consume/replay rejection and expiry fail-closed. Existing ownership/expiry suites pass 27/27. |
| Hosted harmless approval → execute | **NOT_RUN / BLOCKED** | No registered harmless approval-gated tool was used; no hosted action, MCP registration, account or external side effect was created. |

## Reproducible commands and results

All commands below ran in a separate worktree at the common SHA. Provider stubs and stores were local/disposable unless explicitly marked otherwise.

```text
npm run build
PASS — TypeScript build completed.

node scripts/demo-certification/codex/demo-readiness-audit.mjs
PASS — LOCAL_DEMO_READINESS=PASS; 18/18 checks passed.

node --test dist/tests/one_input_intent_routing.test.js
PASS — 66 tests, 66 passed, 0 failed.

node --test dist/tests/approval_ownership_isolation.test.js dist/tests/approval_ttl_security.test.js
PASS — 27 tests, 27 passed, 0 failed.

npm test
PASS — 2,959 tests, 2,950 passed, 0 failed, 9 skipped.

node scripts/one-input-live-cert.mjs
NOT_RUN — opt-in real paid call was not enabled.

node scripts/nemotron-first-live-cert.mjs
NOT_RUN — opt-in real paid call was not enabled.

node scripts/document-roundtrip-live-cert.mjs
NOT_RUN — opt-in real paid call was not enabled.
```

The existing `one_input_document_chain_browser` suite was attempted separately. The first attempt was blocked by an environment write error while the app initialized its default runtime directory; a second attempt with a disposable reminder directory did not finish within 180 seconds. It is recorded as **TIMEOUT / UNVERIFIED**, never as PASS. The full required regression gate remained green.

## Independent local certification details

`scripts/demo-certification/codex/demo-readiness-audit.mjs` verifies:

1. KO/EN deterministic routing, language selection, advice vs consequential action, negation, unsupported capability and clarification.
2. Read-only mapping from the Main surface to the canonical routing, document and approval endpoints.
3. Nemotron-first model-routing policy using an explicit local stub provider; no network request or credential.
4. The production document runtime against a disposable store: document persistence, Recent artifact projection, fresh-store reopen and owner-only visibility.
5. The approval store boundary: pending state has no side effect, wrong owner is indistinguishable as `APPROVAL_NOT_FOUND`, changed payload is `APPROVAL_PAYLOAD_MISMATCH`, replay is `APPROVAL_ALREADY_CONSUMED`, and expiry is `APPROVAL_EXPIRED`.

The script labels all provider-stub results as local and does not claim live Nemotron or hosted completion.

## Demonstration blockers

These are the items that block a truthful “fully demo-ready” claim on October 25:

1. **Real Nemotron evidence is still missing in this independent run.** The local routing contract is green, but the real Nebius/NVIDIA request, model trace, latency and fallback behavior remain unverified here.
2. **Hosted document flow is unverified.** Local create/save/Recent/reopen and owner isolation pass, but a signed-in hosted create → Recent → Open run has not been authorized or performed.
3. **Hosted approval-to-execution is unverified and currently blocked.** No harmless approval-gated tool was registered or executed. The demo must not substitute a fake Connected badge, mock completion or dry-run as hosted success.
4. **Browser document-chain evidence is not closed.** The existing browser suite timed out in this environment, so the integration owner must rerun it with a known-writable disposable runtime and then perform the origin-pinned hosted check after the permitted integration/deployment sequence.
5. **Track A/UI integration remains a handoff.** Codex did not edit the Main UI, Voice WIP, runtime or test registries. Any missing user-visible affordance or the approved Vault capability must be integrated sequentially by the designated owner.

## Required safe next actions

- Integration owner reviews the zero-overlap diff, lands the approved Track A change first, then reruns the Codex script and focused suites on the resulting integration SHA.
- With explicit operator authorization only, run the real cert scripts using the existing secret environment without printing credentials; record provider/model/latency/fallback facts only.
- With explicit deployment authorization only, deploy and perform one harmless, owner-bound approval flow. Record `PENDING → APPROVED → CONSUMED` and the independently observed result; do not use mail/calendar/payment or an unregistered tool for certification.
- Run the browser document journey on the origin-pinned deployed build: One Input → document create → Recent → Open, including a second-user visibility check. Keep `NOT_RUN`, `BLOCKED` and `TIMEOUT` distinct from PASS.

## Security and truthfulness review

- No secret, token, session cookie or external account was read, printed, created or modified.
- No hosted data, `/var/lib/nagex`, test-server service, scheduled job or deployment was changed.
- No approval was bypassed, auto-granted, reused after consumption or detached from its reviewed payload.
- Local provider stubs and deterministic stores are explicitly separated from live provider and hosted evidence.
- No runtime or test fix was applied for any observed failure; the browser timeout and environment write issue remain visible for the integration owner.

## Changed files

- `scripts/demo-certification/codex/demo-readiness-audit.mjs`
- `docs/evidence/NAGEX_D09_CODEX_DEMO_AUDIT_20261015.md`

FINAL_SHA and push status are recorded after the dedicated branch commit.

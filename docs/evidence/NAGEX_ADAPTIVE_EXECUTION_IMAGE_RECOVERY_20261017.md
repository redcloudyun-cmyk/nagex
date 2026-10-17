# NAgex goal-driven adaptive execution — image-quota recovery for the Product Builder (evidence, 2026-10-17)

**Status:** EVIDENCE (point in time) · **Canonical text:** `docs/canonical/NAgex_AI_Model_and_Decision_Architecture.md` §10.2 · **Decision:** `docs/adr/ADR-0017-goal-driven-adaptive-execution.md`
**Release posture:** `RELEASE = NO-GO`. No production deployment. No `main` merge. No paid generation was made.

The first genuine scenario of the directive: *"Generate a website mockup for the approved customer management product"* when the first image provider has no quota. This document says what was run at what level, and what was **not**.

## 1. Acceptance

| Item | Result | Evidence |
|---|---|---|
| PROVIDER_FAILURE_CLASSIFICATION | **PASS** | 12 normalized classes; 28 core tests; in the production-server browser test the **real Google adapter** answers HTTP 429 `RESOURCE_EXHAUSTED` (against a local stand-in carrying the real service's error shape) and is classified `QUOTA_EXHAUSTED` (`retry NEVER`, `fallback ALLOWED`) |
| ALTERNATIVE_DISCOVERY | **PASS** | candidates come from the REAL registry (`OpenAI`, `Google`, `NVIDIA NIM`, `local GPU`; optional extra Google models via `NAGEX_IMAGE_GOOGLE_FALLBACK_MODELS`); NIM and the local endpoint were registered for this |
| ELIGIBILITY_FILTERING | **PASS** | OpenAI and the local GPU are not configured and are **not offered**, each with its reason (`NOT_CONFIGURED`); a route that is quota-exhausted (cool-down), incompatible, above the sensitivity ceiling, over the price ceiling or already tried is excluded; a recommendation cannot admit one |
| JEV_ADVISORY | **PARTIAL** | JEV is wired as one replaceable provider behind `RouteAdvisorPort`, in the System One `choice` shape the repository already uses; tested against a **simulated** service. **No live JEV call** (no credential). The question is NAgex's own and unverified live. Gated on `NAGEX_JEV_DECISION_ENABLED=true` + `NAGEX_JEV_API_KEY` |
| SAFE_DETERMINISTIC_FALLBACK | **PASS** | no advisor / unavailable / slow / throwing / malformed / low-confidence / unoffered-route advice: the deterministic order stands and the history says `DETERMINISTIC_FALLBACK`; a provider that fails twice is not asked again |
| COST_REAPPROVAL | **PASS** | another company receiving the data and a price nobody knows are material: the project stops (`BLOCKED`), nothing is sent to the other company, the person's choice is an approval of `adaptive.route.switch` bound to the exact route and terms, consumed once, invisible to other owners. A refusal is never routed around; an unknown outcome waits for reconciliation |
| ROUTE_HISTORY | **PASS** | persistent, owner-scoped, ordered: `google FAILED (QUOTA_EXHAUSTED) -> nvidia-nim APPROVED -> nvidia-nim SUCCEEDED`, with who ranked and which approval; survives a restart; the ledger remembers the exhausted account so the NEXT project does not start by calling it |
| GOAL_VERIFICATION | **PASS** | the NIM bytes are verified (real complete PNG, 480x300, sha-256), stored with their real type and size and served as a real PNG; a "200" that is an error page is `VERIFICATION_FAILED` and is not kept |
| REAL_IMAGE_E2E | **BLOCKED_WITH_EVIDENCE** | see §3 |
| CONTINUES TO DESIGN_PENDING_APPROVAL | **PASS** (with stand-in endpoints) | production server + real Chromium: plan -> [approve] -> Google quota -> decision card -> [approve NVIDIA] -> NIM pictures -> design gate |

## 2. What the person sees

`docs/evidence/adaptive-execution-20261017/`: the decision card (the failure in plain words, the one eligible route and what changes: *"A different company would receive your plan's description. Its price is not known."*, who ordered it, "What was tried"), the design gate after the switch, and the "nothing eligible" card (what is missing, per provider, and that nothing is lost). Korean and a 390 px phone are covered by the browser test.

## 3. Real image generation: BLOCKED_WITH_EVIDENCE

- The real Google image adapter, called once in the live check of 2026-10-16/17 with the development key, answered **quota exhausted** (`IMAGE_QUOTA_EXCEEDED`; `docs/evidence/product-builder-20261017/live/live-result.json`). No picture and no charge.
- No other image route has a credential on this machine: **OpenAI** (no key), **NVIDIA NIM** (no key / endpoint), **local GPU** (no endpoint), and no extra Google model is configured. The exact missing capability is therefore: *an authorized image provider with credentials other than the exhausted Google key*, or image quota for the existing one.
- **A disclosure:** that live check made one real image request without a separate authorization flag. It was answered with a quota error and nothing was charged, but the live test now makes real image requests **only** with `NAGEX_PRODUCT_BUILDER_LIVE_IMAGES=1`. No further real image request was made in this work, and no other Google image model was probed (a successful call would mean billing is enabled).
- The deterministic orchestration (everything above) is certified with stand-in endpoints that speak the real adapters' wires. **That is not live image generation.**

## 4. Tests

| File | Level | Tests |
|---|---|---|
| `adaptive_execution_core.test.ts` | core, offline (JEV simulated) | 28 |
| `product_builder_adaptive_mockups.test.ts` | service, real planner/ledger/history/approval authority, scripted providers | 13 |
| `product_builder_adaptive_browser.test.ts` | production server + real Chromium; real Google and NIM adapters over stand-in endpoints | 5 |
| `product_builder_workflow.test.ts` (updated) | workflow | 29 |

**Gates (topic branch, before merge):** regression `3623 tests / 3615 pass / 0 fail / 8 skipped`; browser certification `467 tests / 461 pass / 0 fail / 6 skipped`. CI on the integration merge is recorded in the delivery report, not here.

## 5. Found and fixed on the way

- A standing authorization's price ceiling was not applied unless the price had risen enough to count as a change (found by the core test; fixed: the ceiling applies to the route itself, and an unknown price is never covered).
- `google_oauth_persistence` failed once under load: it listed every `.tmp-` file of the shared OS temp directory, so another test process's atomic write tripped it. It now uses a private directory.
- OpenAI and NIM image adapters dropped the provider's HTTP status; both now report it so a failure can be classified instead of guessed.

## 6. Not done / disclosed

- Live JEV; any real image provider other than the exhausted one; **real** NVIDIA / OpenAI image generation.
- The Model Gateway's own text-provider failover is not yet routed through this layer (it is an operator-level, pre-configured choice).
- Video, deployment and the coding engine are not yet consumers (the video job service already has the approval and uncertain-outcome primitives).
- A person cannot yet grant a standing authorization in the UI (the mechanism exists in the core; none is configured).

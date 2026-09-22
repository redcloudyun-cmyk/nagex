# R22.S Test Contract Audit

## Executive Summary

R22.S audited the complete `tests/*.test.ts` inventory as a governance exercise, without changing product behavior. The baseline contained 172 test files; adding the registry integrity test brings the classified inventory to 173 files. Every current test now has exactly one primary classification in `tests/test-contract.registry.json`.

| Primary classification | Count | Meaning |
|---|---:|---|
| `CANONICAL_BEHAVIOR` | 96 | Deterministic observable product, service, API, persistence, approval, isolation, or truthfulness behavior |
| `CANONICAL_ARCHITECTURE` | 9 | Intentional module, route, composition-root, or ownership boundary |
| `IMPLEMENTATION_COUPLED` | 39 | Production source/markup shape asserted rather than only durable behavior |
| `REAL_BROWSER_CERT` | 20 | Playwright Chromium certification with real DOM/browser behavior |
| `TEST_HARNESS` | 3 | Runner, scope registry, preload, or contract-registry integrity |
| `LIVE_EXTERNAL` | 4 | Credential-, deployment-, cloud-, or internet-gated acceptance |
| `SUPERSEDED_CONTRACT` | 2 | R21 clone-layout contracts explicitly replaced by R22 canonical UX |
| **Total** | **173** | 172 original files plus this audit's integrity test |

`canonical` in the registry means authoritative for deterministic regression. Live acceptance remains important but is not a deterministic local baseline. Implementation-coupled and superseded tests remain present; this audit does not delete or rewrite them.

## Method

Each file was inspected using its imports, test body, source reads, browser launch behavior, credential/environment gates, and existing scope registration. Classification was assigned once per file. Supporting metadata records milestone, scopes, external dependencies, real-browser status, source-implementation assertions, determinism, assertion intent, and supersession notes.

The registry is reproducible with `scripts/generate-test-contract-registry.mjs`. Its integrity test validates exact bidirectional coverage and classification-specific required fields.

## Known Contract Conflicts

1. **R22.5 model capabilities vs older structured mocks.** OpenAI is intentionally ineligible for JSON/structured extraction. Older text, URL, task-continuation, and inline planning mocks assumed otherwise. The current canonical replacements use Nebius/Gemini-capable providers or declare mock capabilities.
2. **R22.8 Personal Home vs R21 frontend grouping.** `PersonalHomeService` owns Home aggregation; Desktop Home consumes `/api/v1/personal/home` and renders `data.needsAttention`. The former source assertion requiring frontend `Now / Today / Later` grouping was superseded.
3. **R22.9 canonical Memory vs demo interception.** Demo reset must reseed the canonical `MemoryEngine`; it must not restore a static `/api/v1/memory` interceptor or a parallel store.
4. **Composition Root ownership.** Demo reset briefly introduced `POST`/pathname domain routing in `server_web.ts`. `ROUTE-INV-004` correctly rejected it; the demo-domain owner now invokes the canonical reseed dependency.
5. **Settings copy drift.** English `settings.catModels` is canonically `Models`; the older `AI & Models` assertion was stale.

## Genuine Regressions Already Found

- `server_web.ts` owned demo-reset domain method/path routing, violating the Composition Root route-ownership contract.
- Link Capture retained no delayed-close timer handle, allowing a successful save from modal generation N to close generation N+1.
- Demo reset initially failed to keep the canonical demo Memory record aligned with the real `MemoryEngine` contract.

These were real defects because they violated architecture, observable UI lifecycle, or canonical persistence behavior—not merely test implementation shape.

## Stale Test Examples

- OpenAI structured-extraction mocks after the R22.5 capability contract.
- The English Settings label expectation `AI & Models` after canonical copy became `Models`.
- The R21 Desktop Home `Now / Today / Later` source snapshot after R22.8 moved aggregation to `PersonalHomeService`.

## R21 → R22 Supersession Matrix

| R21 area/test | Still-valid intent | Superseding contract | Current canonical replacement | Disposition |
|---|---|---|---|---|
| `r21_p0_1c_clone_mockup` | Result-first, understandable UX | R22.1 and R22.8 | Mobile Home and `PersonalHomeService` contracts | `SUPERSEDED_CONTRACT`; later archive or convert durable intent |
| `r21_p0_1c_real_browser` | Browser-visible usable Home | R22.1 and R22.8 | R22 mobile/Home browser certification | `SUPERSEDED_CONTRACT`; retain until reviewed |
| `r21_p0_2_personal_ui` | Consumer UI hides enterprise controls by default | R22 consumer/mobile UX | R22.1 plus current navigation/settings contracts | Requirement valid; convert source regex to behavior tests |
| `r21_p0_2_personal_ui_real_browser` | Enterprise controls remain gated | R22 consumer UX | Existing browser behavior remains useful | Keep browser certification |
| `r21_p0_ux_principles` | Progressive disclosure and human control | R22 UX architecture | R22.1/R22.8/R22.9 behavior | Intent valid; source assertions are refactor-fragile |
| `r21_p0_ux_principles_real_browser` | Real user-flow certification | R22 browser certifications | R22.1, R22.2, R22.6–R22.9 | Keep until overlap can be consolidated |
| `r21_p1_demo_scenario` | Deterministic demo reset and truthful state | R22.8/R22.9 | Canonical Home service and Memory engine | Keep behavior; canonical stores/services own state |
| `r21_p1_deployed_certification` | Hosted release acceptance | Later R22 release baseline | Deployed environment certification | Keep as `LIVE_EXTERNAL`, never local deterministic baseline |
| `r21_p1_finalization_real_browser` | End-to-end demo flow | R22 focused browser suites | R22.1/2/6/7/8/9 | Keep temporarily; later split/remove overlap |
| `r21_p1_social_auth` | Social-auth contract/security | Current identity architecture | Social-auth routes and identity stores | Intent valid; convert source wiring checks to route behavior |
| `r21_p1_ux_integration` | Truthful persistence and personal attention | R22.8 | `/api/v1/personal/home` → `data.needsAttention` | Partially reconciled; remaining source assertions are conversion candidates |

### Required overlap decisions

- **Home:** R21 intent remains, frontend aggregation shape does not. R22.8 is authoritative.
- **Memory UI:** lifecycle, confirmation, sensitivity, and persistence remain valid. R22.3/R22.9 own canonical contracts; older DOM/source snapshots should defer to them.
- **Mobile UX:** general responsive/accessibility intent remains. R22.1/R22.2 own current screen and browser certification.
- **Demo:** deterministic reset remains. R22.8/R22.9 services/stores are authoritative, not static interceptors.
- **Model/UI:** truthful provider evidence remains. R22.5+ capability/routing policy supersedes provider-specific assumptions.
- **Browser:** user-visible behavior remains valid; current Browser Runtime ownership and focused R22 browser suites supersede implementation-location assumptions.

## Implementation-Coupled Assertion Audit

There are **52 files with production source/markup assertions**. Their underlying primary intents are:

| Underlying intent | Files |
|---|---:|
| Genuine architecture invariant | 7 |
| Genuine security invariant expressed through source checks | 4 |
| UI copy contract expressed through source checks | 3 |
| Implementation snapshot | 37 |
| Obsolete implementation snapshot | 1 |

Of those, **39 tests have `IMPLEMENTATION_COUPLED` as their primary classification**. The remainder are primarily architecture, browser, live, harness, or superseded tests that also contain source-level checks. Per-file intent is recorded in the registry's `assertionIntent` field.

### Prioritized conversion list

**P0 — known architecture conflicts or high-risk ownership snapshots**

- `r21_p1_ux_integration`
- `r22_5_task_aware_model_routing`
- `candidate_model`, `candidate_review`
- `state_propagation`
- `unified_capture_routing`
- `home_intent_first_ux`
- `mobile_ux_debt0005`

Convert these to service/API/DOM behavior while retaining explicit no-fake/no-parallel-aggregation guarantees.

**P1 — likely to break during ordinary refactoring**

- UI wiring/source suites: `ambient_composer`, `ambient_modal_wiring`, `ambient_run_button`, `browser_ambient_wiring`, `browser_approval_ui`, `calendar_approval_ui`, `calendar_approval_ux`, `gmail_ambient_wiring`, `gmail_approval_ui`, `inbox_activity_ux`, `intent_interaction_foundation`, `my_space`, `navigation_redefinition`, `plan_lifecycle_timeline`, `plan_resolution_ui`, `settings_ux`, `tasks_ui`.
- Mixed behavior/source suites: `action_proposals_safety`, `approval_truth_source`, `capture_analysis_finalizer`, `durable_task_runtime`, `google_calendar_live`, `google_capability_execution_pipeline`, `proactive_assistant_change_detection`, `task_approval_continuation`.

**P2 — stable source checks that may remain**

- `architecture_enforcement`, `browser_module_boundary`, `composition_root`, `google_modules_boundary`, `http_route_modularization`, `module_contracts`, `route_inventory`, `task_orchestration_boundary`, and `tool_capability_id_alignment` enforce explicit architecture/security boundaries. Keep them source-level unless a stronger compiler/linter boundary replaces them.
- Exact legal/i18n copy checks may remain when the string itself is the public contract, but should not assert unrelated implementation structure.

## Real Browser and Live External Inventory

- **20 `REAL_BROWSER_CERT` files** launch Playwright Chromium. Coverage includes desktop and mobile widths, EN/KR in R22 suites, identity/RBAC/organization flows, and focused R22 Home/capture/model-comparison behavior. They require Chromium and local fixture/server lifecycle; some mutate persistent test data and must remain serial or isolated.
- **4 `LIVE_EXTERNAL` files** are explicitly separated: real model providers, Astra acceptance, Nebius S3 integration, and deployed R21 certification. Their dependencies are declared per entry. Missing external state is not a deterministic product regression.
- `r21_p1_deployed_certification` additionally writes certification artifacts when deliberately run; it must not be part of routine Windows regression.

## Test Harness Issues

- Local Windows full-suite execution combines many browser processes, shared environment mutation, persistent stores, and tests that historically wrote screenshots. Scoped/serial execution is safer until isolation is complete.
- Several suites mutate `process.env` or `globalThis.fetch`; cleanup must be retained and audited when converting tests.
- Browser suites may share canonical demo/test stores unless each run uses unique tenant/principal/temp directories.
- Live tests use different skip/gate conventions (Node skip vs early return). Standardize reporting later so “not run” cannot look like a passing live verification.
- The scope registry historically left new tests unclassified. `test_contract_registry` is now registered and independently enforces complete contract metadata.

## Scope Coverage Audit and Proposed Mapping

Most R22 tests were `fullOnly`, making focused canonical validation harder. Do not change runner semantics during R22.S; adopt these mappings in a reviewed follow-up:

| Test | Proposed canonical scopes |
|---|---|
| `r22_1_mobile_home` | `mobile`, `personal-home`, `browser` |
| `r22_2_activity_vault` | `mobile`, `capture`, `runtime`, `browser` |
| `r22_3_personal_context_memory` | `memory-context`, `security`, `model-routing` |
| `r22_4_evidence_pack_web_search` | `model-routing`, `integrations`, `runtime` |
| `r22_5_task_aware_model_routing` | `model-routing`, `tasks` |
| `r22_6_perspective_compare` | `model-routing`, `browser` |
| `r22_7_forecast_compare` | `model-routing`, `browser` |
| `r22_8_personal_home` | `personal-home`, `browser` |
| `r22_9_personal_context_link_capture` | `capture`, `browser`, `memory-context`, `security` |

Recommended scope taxonomy: `architecture`, `model-routing`, `memory-context`, `personal-home`, `capture`, `browser`, `approvals`, `tasks`, `runtime`, `mobile`, `integrations`, with `security`, `identity-access`, `device`, `ux`, and `test-harness` retained where they materially distinguish ownership.

## Proposed Remediation Order

### P0

1. Review the two explicitly superseded R21 clone contracts and approve archive/conversion disposition.
2. Convert known-conflict source assertions to R22 service/API/browser behavior.
3. Separate deterministic regression from live/deployed certification commands.
4. Eliminate shared persistent-state collisions in R22 browser/memory suites.

### P1

1. Convert refactor-fragile UI wiring regex tests to DOM behavior tests.
2. Add reviewed canonical scopes for R22.1–R22.9.
3. Normalize environment/fetch/browser cleanup and live-test skip semantics.
4. Consolidate overlapping R21/R22 browser coverage after proving equivalent assertions.

### P2

1. Retain deliberate architecture/security source guards.
2. Reduce duplicated copy/markup snapshots.
3. Add ownership metadata for future milestones at test creation time.

## Proposed Stable Baseline Process

1. Every new test ships with a registry entry and one primary classification.
2. Deterministic canonical scopes run first, serially where shared state requires it.
3. Architecture and security scopes run as mandatory gates.
4. Real-browser certification runs in a clean isolated workspace with Chromium and unique test identities.
5. Live external certification runs separately with explicit credentials/deployment and reports `RUN`, `SKIP`, or `FAIL` truthfully.
6. Only after P0/P1 reconciliation should one clean full regression be established in CI; do not use repeated Windows full-suite runs as the discovery loop.
7. A failure is triaged as product regression, stale/superseded contract, harness defect, or unavailable live dependency before any assertion or product change.

## Audit Boundary

R22.S changes metadata, tests, audit documentation, and the registry generator only. It does not change `src/`, `public/`, production behavior, screenshots, or `artifacts/`. Bulk remediation is intentionally deferred pending review.

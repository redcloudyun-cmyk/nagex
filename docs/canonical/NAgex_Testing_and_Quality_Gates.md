# NAgex Testing & Quality Gates

**Canonical Domain:** Testing / Certification / Regression / Quality Governance
**Status:** CANONICAL
**Date:** 2026-09-29

## 1. Principle

A NAgex feature is not complete merely because code compiles.

Applicable completion requires:

- implementation works;
- contracts match;
- security boundaries remain intact;
- failure behavior is explicit;
- tests pass;
- UI is truthful;
- documentation matches;
- no secrets are committed;
- evidence is reproducible.

## 2. Test Contract Registry

Every test should have a registered purpose and primary classification.

The R22.S audit established these categories:

- `CANONICAL_BEHAVIOR`
- `CANONICAL_ARCHITECTURE`
- `IMPLEMENTATION_COUPLED`
- `REAL_BROWSER_CERT`
- `TEST_HARNESS`
- `LIVE_EXTERNAL`
- `SUPERSEDED_CONTRACT`

The exact number of tests is not a permanent canonical fact. Counts belong to dated evidence/closure reports.

## 3. Test Authority

A failing test must be triaged before changing product behavior or the assertion.

Classify failure as:

```text
PRODUCT_REGRESSION
STALE_OR_SUPERSEDED_CONTRACT
TEST_HARNESS_DEFECT
LIVE_DEPENDENCY_UNAVAILABLE
ENVIRONMENT_FAILURE
```

Do not “fix” a canonical implementation to satisfy an obsolete snapshot.

Do not delete a failing test merely because it blocks progress.

## 4. Deterministic Regression vs Live Certification

These are separate.

### Deterministic regression
Runs without relying on live external side effects and forms the normal repeatable baseline.

### Real-browser certification
Uses real Chromium/DOM behavior for critical UX and interaction contracts.

### Live external certification
Uses real credentials/services and may perform external writes only under explicit gated procedures.

A skipped live test must be reported as `SKIP`, not `PASS`.

## 5. Stable Baseline Process

1. Every new test receives a registry entry and primary classification.
2. Deterministic canonical scopes run first.
3. Architecture/security scopes are mandatory gates.
4. Real-browser certification runs in an isolated workspace with controlled identities/state.
5. Live external certification runs separately with explicit prerequisites.
6. Shared-state suites run serially or with isolated stores where required.
7. Failures are triaged before code/test mutation.

## 6. Implementation-Coupled Tests

Source/markup assertions are acceptable when they enforce a deliberate architecture or security boundary.

Refactor-fragile snapshots should migrate toward service/API/DOM behavior where possible.

Keep source-level guards for intentional boundaries until a stronger compiler/linter/module mechanism replaces them.

## 7. Superseded Tests

A superseded test is historical evidence, not current product authority.

Supersession must be explicit and traceable. Archive or conversion should occur only after the durable intent is covered by the newer contract.

## 8. Real Browser

Critical consumer flows should be certified in actual browser behavior where appropriate, including:

- supported mobile widths;
- desktop;
- EN/KR;
- navigation/history;
- dialogs;
- approval flows;
- long content;
- accessibility;
- horizontal overflow;
- truthful status transitions.

Browser tests should not be used as an uncontrolled discovery loop that repeatedly dirties the working tree.

## 9. Safe Deployment Verification

Operational verification distinguishes:

```text
nagex-check
→ safe/read-only verification

nagex-e2e-live
→ explicit live external mutation verification
```

`nagex-check` must not send real email, create real calendar events, submit consequential browser forms, or bypass approval.

Live E2E requires explicit confirmation unless a deliberately authorized non-interactive mode is used.

## 10. Replay and Approval Certification

Consequential live tests should verify:

- approval required;
- approved payload executes;
- rejection does not mutate;
- replay is rejected;
- consumed approval cannot be reused;
- drift requires reapproval where applicable.

## 11. Test-Only Hooks

Test-only execution hooks must be independently gated, unavailable by default, non-persistent in production configuration, and verified closed after use.

They must not create a production bypass path.

## 12. Build and Diff Gates

Minimum local gate for a focused change normally includes:

```text
npm run build
focused relevant tests
git diff --check
```

Broader `npm test`, browser certification, live E2E and deployment checks are required according to scope/risk rather than blindly for every edit.

Never mark completion while required gates fail.

## 13. Artifact Hygiene

Generated screenshots, logs and latency artifacts must not be accidentally staged with unrelated source changes.

Git staging should be explicit and milestone-scoped.

Repository safety rules prohibit broad destructive cleanup when unrelated work exists.

## 14. Canonical Quality Invariants

```text
FAKE_SUCCESS_PATHS = 0
STALE_STATE_LEAK = 0
RAW_I18N_KEY_LEAK = 0
TECHNICAL_UI_LEAK = 0
CROSS_SESSION_LEAK = 0
RESET_SCOPE_LEAK = 0
APPROVAL_REPLAY_BYPASS = 0
UNREGISTERED_TEST_CONTRACT = 0
LIVE_SKIP_REPORTED_AS_PASS = 0
```

Domain-specific canonical documents may add additional invariants.

## 15. Source Provenance

Consolidated from:

- `testing/R22_TEST_CONTRACT_AUDIT.md`
- `ops/automated-testing.md`
- `DEVELOPMENT.md`
- durable Definition-of-Done and truthfulness rules in `MASTER.md`
- later R23 milestone certification practices

Static historical test totals remain evidence and are intentionally excluded from this permanent contract.

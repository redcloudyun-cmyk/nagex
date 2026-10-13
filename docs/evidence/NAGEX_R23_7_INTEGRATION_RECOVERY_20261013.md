# NAgex R23.7 Integration & Recovery — evidence

**Date:** 2026-10-13
**Branch:** `integration/r23.7-20261013` (candidate; not merged into `main`, not deployed)
**Gate head:** `b8ac2af` (this document is added after it; documentation only)

## 1. Protection and reconciliation

- The main checkout (`r23.6m-mobile-voice-action`) and its uncommitted Voice work were not touched; all work happened in separate worktrees.
- `main` is textually identical in content to the common base `34fe0ea`; merging `main` into the roadmap line is clean (commit 16cd108).
- The Voice WIP patch (saved outside the repo) applies cleanly to every file except `public/main-surface.js`, which the integration line also changed; that one conflict is for the Voice owner to resolve when the Voice work lands.
- Merging this branch with `feat/agex-assets-mcp-20261013` conflicts only in `tests/route_inventory.test.ts` (both branches changed the endpoint-count manifest); the reconciliation is arithmetic. Everything else auto-merges.

## 2. DEBT-0014 — the 31 failing tests

Root cause: the merge `b873e41` joined two diverged lines (p1 `93e3102`: governed Kakao send; p2 `cc333c8`: governed-draft M4C) into a hybrid — Kotlin from p1, tests from p2, routes from p2. Each parent passed its own tests; three M4C-R2A assertions were already red on p2.

| Dropped / broken | Restored as |
|---|---|
| Governed Kakao SEND approvals and the approve-time enqueue | `approvals.routes.ts`: `enqueueKakaoSendAfterApproval` — only for an APPROVED SEND of the owner; command bound to device, recipient, draft, conversation, expected display name, message hash and approval id; idempotent |
| Execution lifecycle projection | `projectExecutionStatus` with every stage; device-bound only when a command exists; unverified completion stays `COMPLETION_NOT_VERIFIED` |
| Device binding validation | `POST /devices/:id/validate` — fails closed (`DEVICE_BINDING_NOT_FOUND` / `NOT_AUTHORIZED`) |
| JIT message preparation | `POST /accessibility-prepare-message-plans` — never consumes a send approval |
| Android dispatcher | `AccessibilityExecutionPlanDispatcher.kt`: wrong device/tenant/user, expiry, replay, package allow-list, payload hash, budget, user interrupt, forbidden send actions, recipient-before-text order, package mismatch; 8 new Robolectric tests |
| Duplicate string resource breaking the Android build | removed (55bd595) |
| 3 M4C-R2A assertions red on p2 itself | repointed at the polling owner / ACK / endpoint ACK handler (assertions kept, not weakened) |

Result: all 31 names pass. KakaoTalk message sending remains gated behind explicit Human Approval bound to device, recipient, conversation and message hash, the generic accessibility step still answers `SEND_ACTION_DISABLED_IN_M4C_R1`, and the path is **not certified on a real device**. Android JVM unit tests: 105 run, 3 fail for environment reasons that predate this work (one orientation test, two AndroidKeyStore tests).

## 3. Presentation, creation truth, account lifecycle

- PPTX: opened and rendered in Microsoft PowerPoint 16.0; two real rendering defects found and fixed — see `NAGEX_PPTX_RENDER_EVIDENCE_20261013.md`. Not tested in other applications.
- `POST /api/v1/creations/generate` answers 400 `CREATION_KIND_UNSUPPORTED` for non-image kinds; a legacy placeholder cannot be "revised" (409). DEBT-0012 closed.
- DEBT-0013 (OAuth part): disable / delete need a provider sign-in within 5 minutes plus the typed email; stale → 403 `REAUTH_REQUIRED`; provider sign-in on a disabled / deletion-pending account opens no session and offers an explicit, audited, single-use recovery. No password authentication added. "Fresh" means a provider sign-in happened minutes ago; the provider is not forced to re-ask for a password.

## 4. Gate at `b8ac2af`

| Gate | Result |
|---|---|
| `npm run build` | exit 0 |
| `npm test` | 2738 tests, 2730 pass, **0 fail**, 8 skipped |
| `npm run test:browser-cert` | 216 tests, 210 pass, **0 fail**, 6 skipped |
| Baseline failure names (31) | all pass; no new failure names |
| Browser-cert failures found during the work | 2 (legacy-history tests depending on the removed mock) — fixed in `c208d2b`, re-run green |

Not done: no live provider was contacted; no real Android device was used; Keynote / LibreOffice / Google Slides were not tested. Design approval and human acceptance remain **PENDING**.

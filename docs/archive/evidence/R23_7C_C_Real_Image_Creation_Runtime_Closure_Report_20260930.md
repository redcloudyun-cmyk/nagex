# R23.7C-C Real Image Creation Runtime — Closure Report

**Status:** CLOSED
**Date:** 2026-09-30
**Milestone:** R23.7C-C (Real Image Creation Runtime), part of R23.7C Creation Runtime
**Canonical basis:** `docs/canonical/NAgex_Development_Roadmap.md` §6/§8, `docs/canonical/NAgex_Creation_Architecture.md`, `docs/canonical/NAgex_Testing_and_Quality_Gates.md`

This report is evidence of a point-in-time certification. It does not define permanent product architecture — see `docs/NAGEX_PROJECT_INDEX.md` §6.

## 1. Exit Criteria (Roadmap §8) — Status

| Criterion | Status | Evidence |
|---|---|---|
| Real image runtime, not mock SVG | SATISFIED | `ImageExecutor` + real provider adapters; `tests/r23_7c_c_real_image_creation_runtime.test.ts` |
| Provider-neutral `ImageProviderPort` path | SATISFIED | `src/creation/providers/adapters/` (openai, google, local, nvidia-nim), one shared `ImageProviderPort` |
| Canonical `ImageCreationSpec` | SATISFIED | `src/creation/specs/creation-spec.types.ts` |
| Provider result ingested into NAgex-owned artifact identity/storage | SATISFIED | `ImageStore` (binary + metadata) + `ArtifactStore` projection |
| Provider URL is not the artifact | SATISFIED | canonical relative URL only, `/api/v1/creations/images/:imageId`; live evidence below |
| Failure/pending/unavailable are not success | SATISFIED | `tests/r23_7c_c_real_image_creation_runtime.test.ts` tests 5-7 |
| Reference/edit authorization where supported | SATISFIED | tests 11-12, 15 |
| Cross-tenant/user isolation | SATISFIED | `tests/r23_7c_c_artifact_delivery_identity.test.ts` (A-P), `tests/r23_7c_c_canonical_desktop_history.test.ts` (C, D) |
| Focused deterministic tests | SATISFIED | see §3 below |
| Build and diff gates | SATISFIED | run at every commit in the evidence chain (§2) |
| Real-provider certification when credentials are available | SATISFIED | live OpenAI generation, §4 |
| Desktop/mobile truthful UX certification for the exposed flow | SATISFIED for the exposed (desktop) flow; mobile Create is truthfully **not exposed** — see §6 |

## 2. Implementation & Certification Commit Chain

Preserved from earlier evidence, before this session's direct visibility (git log at session start):

- `9343fbf` feat(r23.7c-c): complete real image creation runtime
- `b2d3cd9` fix(r23.7c-c): update OpenAI image API compatibility
- `79efd5c` fix(r23.7c-c): replace retired OpenAI image default model
- `69140e1` fix(r23.7c-c): serve canonical image artifacts

This session's commits, in order:

- `e1993da2edccafb373cfaec0e7a4e1091b58fa48` fix(r23.7c-c): render canonical image artifacts in UI
- `8d2820e140c75f2e3f7ea4b495f784bc94c5789a` fix(r23.7c-c): bind creation artifact delivery to session identity
- `745209faaa4c6e5f9c041fd3ca4ba03a8669a8f9` test(r23.7c-c): add session artifact delivery certification
- `b7c710a433ab1e405582002a8d50d0a35654fd0f` test(r23.7c-c): separate cert control and browser origins
- `c71f1971ea061664e1f86abcb6fac71116cadcec` fix(r23.7c-c): complete canonical image history — **final implementation commit**
- `3b3d4c17b16e41b5b1affbc0ca889d8f55680bd6` test(r23.7c-c): certify final non-paid closure — **final certification harness commit**

## 3. Deterministic Regression Evidence

All local, no external provider calls:

- `tests/r23_7c_c_real_image_creation_runtime.test.ts` — real runtime, provider routing, failure/pending semantics, reference authorization
- `tests/r23_7c_c_canonical_image_serving.test.ts` — canonical GET route, tenant/owner isolation, route precedence
- `tests/r23_7c_c_artifact_delivery_identity.test.ts` (16 tests, A-P) — shared session-identity resolver across all 5 creation routes, session precedence over spoofed headers, legacy header compatibility
- `tests/r23_7c_c_canonical_image_ui_rendering.test.ts` — frontend `isRenderableImageSource()` predicate, malformed-source rejection
- `tests/r23_7c_c_canonical_desktop_history.test.ts` (10 tests, A-J) — CreationStore ∪ ImageStore history merge, canonical URL preservation, ordering, variation lineage, real-browser render
- `tests/r23_7c_c_provider_neutral_preview.test.ts` (7 tests, A-G) — provider identity absent from `ArtifactStore.preview`, present in `ImageRecord.providerExecutionMetadata`, absent from real Personal Home render (desktop + mobile)

R13 identity/session regression re-verified alongside this work: `identity_lifecycle`, `session_store`, `r21_p1_social_auth`, `browser_session_ownership_isolation` — all passing.

## 4. Real External-Provider Generation Evidence

Deployed real-browser certification (prior to this session's desktop-history/provider-leak fixes):

```
realGenerationCount = 1
generationHttpStatus = 201
creationId = img_53d71610167ee662e02afe55
artifactId = art_d3ddd29e5abc58386bcda3b4
canonicalImageUrl = /api/v1/creations/images/img_53d71610167ee662e02afe55
browser delivery: HTTP 200, Content-Type image/png, byteLength 1412709
desktop rendered dimensions: 1024 x 1024
pendingStateTruthful = true
successStateTruthful = true
technicalUiLeak = 0
rawI18nKeyLeak = 0
fakeSuccessPaths = 0
classification = PASS
```

Historical evidence, preserved and never modified by any work in this closure:

- `img_93b85a5d7a103e7bdaaeff97`
- `art_d563e825e91dbfbb1b52f8f2`

No additional paid/external-provider generation was performed anywhere in this closure's work. The final two fixes (desktop history, provider-neutral preview) were certified entirely with deterministic fixtures and non-paid deployed certification (§5).

## 5. Session-Bound Artifact Delivery & Final Non-Paid Closure Certification

**Session-bound artifact delivery certification** (`tests/r23_7c_c_session_artifact_delivery_cert.test.ts`, executed on the deployed host):

```
signupHttp = 201, verifyHttp = 200, loginHttp = 200
sessionAuthenticated = true, cookieForged = false
canonicalImageHttp = 200, canonicalImageMime = image/png
sha256Match = true
spoofedHeaderWithValidSession -> 200 (session remains authoritative)
noSessionHttp = 404
generationPostCount = 0, externalProviderCallCount = 0, paidGenerationCount = 0
```

**Final non-paid closure certification** (`tests/r23_7c_c_final_non_paid_closure_cert.test.ts`, executed on the deployed host):

```
desktopHistoryVisible = true
desktopHistoryCanonicalUrl = true
desktopHistoryImageVisible = true
desktopHistoryOpenPass = true

canonicalImageHttp = 200
canonicalImageMime = image/png
sha256Match = true

providerMarkerVisibleStudio = false
providerMarkerVisibleHomeDesktop = false
providerMarkerVisibleHomeMobile = false

providerNeutralPreviewDesktop = true
providerNeutralPreviewMobile = true

noSessionHttp = 404

generationPostCount = 0
paidGenerationCount = 0

fakeSuccessPaths = 0
technicalUiLeak = 0
rawI18nKeyLeak = 0
crossSessionLeak = 0

closureCert = PASS
```

Both certifications used a deterministic, non-paid PNG fixture written directly through production `ImageStore`/`ArtifactStore` under the real, browser-authenticated session's identity — no image-generation provider was called.

## 6. Explicit Scope Boundary — Mobile Create (FOLLOW_UP, not a closure blocker)

Confirmed truthfully, not fixed in this closure:

```
mobileCreateEntry = NOT_AVAILABLE
mobileImageThumbnail = NOT_AVAILABLE
mobileImageOpenBehavior = ROUTES_TO_INBOX
```

Per `docs/canonical/NAgex_UX_and_Interaction_Architecture.md` §10 (image creation is part of the R23.7H Home direction, a separate milestone already closed as a product foundation — see Roadmap §5) and Roadmap §7 item 2 (Home/Create image integration is explicitly sequenced as its own step, not folded into C-C's own exit criteria), these are correctly out of scope for R23.7C-C. They require a subsequent Home/Create integration pass. **No numbered milestone currently exists in the roadmap for this work** — see §8 below.

## 7. Final Invariants (Closure Evidence, Not New Requirements)

```
FAKE_SUCCESS_PATHS = 0
STALE_STATE_LEAK = 0
RAW_I18N_KEY_LEAK = 0
TECHNICAL_UI_LEAK = 0
CROSS_SESSION_LEAK = 0
RESET_SCOPE_LEAK = 0
```

## 8. Roadmap Sequencing Basis (Quoted, Not Inferred)

`docs/canonical/NAgex_Development_Roadmap.md` §7, "Immediate Product Development Sequence":

```
1. Stabilize / complete R23.7C-C Real Image Runtime
2. Integrate truthful image creation/history into the Personal Home/Create experience
3. R23.7C-D Presentation Runtime
```

Item 1 is closed by this report. Item 2 is **partially** satisfied (desktop history + provider-neutral preview, both closed by this milestone's final two commits); the remaining mobile Create portion of item 2 has no assigned milestone number in the current roadmap. Per the roadmap's own literal sequencing, item 3 (R23.7C-D Presentation) is listed after item 2 — starting Presentation before item 2 is fully resolved is a roadmap-sequencing decision, not something this report resolves unilaterally. **Recorded as `ROADMAP_DECISION_REQUIRED`.**

## 9. Non-Blocking Technical Debt Transferred

Registered in `docs/debt/TECHNICAL_DEBT_REGISTRY.md`:

- **DEBT-0008** — certification `ImageStore`/`ArtifactStore` metadata cleanup deferred (no public delete API exists for either store; binaries are cleaned up, metadata records are not).
- **DEBT-0009** — disposable `@nagex.invalid` certification accounts created by the deployed-cert harnesses remain; no self-service account-deletion path was exercised.
- **DEBT-0010** — the shared request-identity resolver's header/default fallback (used when no valid `nagex_session` exists) is not production multi-user authentication; it is the pre-existing single-default-identity behavior this milestone deliberately preserved rather than removed, per explicit scope discipline during that work.

None of these block R23.7C-C closure — see the registry entries for full reasoning.

## 10. Stale Test Note (Not Resolved Here)

`tests/r21_p1_deployed_certification.test.ts`'s Section A assertion on the exact string `"<n> meetings · <n> emails · <n> tasks · <n> approvals waiting"` fails against the current deployed Home UI. Per `docs/canonical/NAgex_Testing_and_Quality_Gates.md` §7, this is recorded as a **superseded test contract**, not a product regression: R23.7H (closed, Roadmap §5) established a newer Home structure that no longer exposes that literal string. Formal reclassification (`SUPERSEDED_CONTRACT` in `tests/test-contract.registry.json`, with a `supersededBy` reference) is **not performed in this documentation-only pass** — it requires editing test metadata, which was out of scope here. This is recorded as a follow-up action, not silently resolved.

## 11. Closure Statement

R23.7C-C (Real Image Creation Runtime) is **CLOSED** as of `c71f1971ea061664e1f86abcb6fac71116cadcec`, certified by `3b3d4c17b16e41b5b1affbc0ca889d8f55680bd6`, against the exit criteria in Roadmap §8, on the evidence recorded in this report. Mobile Create integration remains explicitly open as untracked-milestone follow-up work (§6, §8).

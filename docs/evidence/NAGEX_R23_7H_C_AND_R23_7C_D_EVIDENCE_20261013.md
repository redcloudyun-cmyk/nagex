# R23.7H-C exit-criteria matrix and R23.7C-D Presentation evidence

**Date:** 2026-10-13
**Branch:** `auto/roadmap-20261013` (not merged to `main`, not deployed)
**Status of closure:** IMPLEMENTATION COMPLETE, OWNER ACCEPTANCE PENDING. This document is point-in-time evidence, not a decision to close a milestone. Design
acceptance of the rebuilt screens stays `PENDING` (no screen is declared CLOSED).

## 1. Roadmap conflict surfaced (not silently reconciled)

`NAgex_Development_Roadmap.md` §6/§7 gate R23.7C-D (Presentation) behind R23.7H-C being CLOSED. R23.7H-C is still `OPEN` in the roadmap, and the rebuilt Main surface
(Design System V2) replaced the surfaces the original H-C tests were written against. This run (a) finished the remaining H-C gaps on the unified Main surface and
(b) then implemented R23.7C-D through the shared dispatcher/contract rather than an ad-hoc UI, which is what the gate exists to protect. If the owner does not accept
H-C as closed, R23.7C-D should be treated as implemented-ahead-of-gate and re-reviewed.

## 2. R23.7H-C exit criteria

| Criterion | Evidence (test file, real Chromium unless noted) | Result at 2026-10-13 |
|---|---|---|
| MOBILE_CREATE_ENTRY | `mobile_phone_shell_browser` (Main Home is the phone Home; the composer creates Document / Image / Slides) and `r23_7c_d_presentation_main_browser` | PASS |
| MOBILE_IMAGE_THUMBNAIL | `r23_7h_c_mobile_recent_image_browser` (Recent thumbnails from the canonical `/api/v1/creations/images/<id>/view` URL; 360/390/430 + desktop) | PASS |
| MOBILE_IMAGE_OPEN | same test: Open resolves to the artifact detail, never a provider URL | PASS |
| DESKTOP_REGRESSION | `r23_7c_c_canonical_desktop_history`, `r23_7c_c_canonical_image_ui_rendering` | PASS |
| SHARED_DISPATCHER | `r23_7h_c_phase_b_artifact_ux_contract` (`toArtifactUxProjection`, PRESENTATION previewKind added), `r23_7h_c_phase_c_canvas_shell` | PASS |
| IMAGE_ON_CONTRACT | `r23_7c_c_provider_neutral_preview` | PASS |
| UNKNOWN_TYPE_SAFE | `r23_7h_c_phase_b_artifact_ux_contract` test G; Recent test in `r23_7h_c_mobile_recent_image_browser` | PASS |
| CANONICAL_URLS / NO_PROVIDER_LEAK | `r23_7c_c_provider_neutral_preview`, `r23_7c_c_canonical_image_ui_rendering`, `r23_7c_d_presentation_runtime` (NAgex-owned `pres_<24hex>` ids; no provider id in responses) | PASS |
| I18N_EN_KR | `mobile_phone_shell_browser` (EN and KR), `r24_6d_settings_surface_browser` (Korean Settings on every rebuilt Desktop category + Mobile), `r23_7c_d_presentation_main_browser` | PASS |
| MOBILE_VIEWPORT_CERT 360/390/430 | `mobile_phone_shell_browser`, `r23_7h_c_mobile_recent_image_browser` | PASS (headless Chromium from the Playwright harness; not run on a physical phone) |
| DESKTOP_CERT | `r23_7h_c_phase_d_main_product_experience`, `settings_screen_certification_browser`, `connections_redesign_browser` | PASS |
| ACCESSIBILITY | labelled navigation landmark, `aria-current` on exactly the current destination (`mobile_phone_shell_browser`); decorative Settings icons no longer leak English names | PASS (structural checks, no screen-reader session) |
| HORIZONTAL_OVERFLOW | `scrollWidth <= viewport` on Home, Recent, Settings, Connections at 360/390/430 | PASS |
| C_C_REGRESSION | `r23_7c_c_*` suites | PASS |
| NO_PAID_GENERATION | image tests use the deterministic local/test provider; Presentation uses the local PPTX writer (no provider call) | PASS |

## 3. R23.7C-D — Presentation / Slides

Implemented through the existing architecture, not beside it:

- `CreationRuntime` + `PresentationExecutor` + `CreationProviderRouter` + `LocalPptxAdapter` (`nagex-local-pptx`), spec `PresentationCreationSpec`.
- Outline reasoning goes through the Model Gateway (`AiService.presentationOutline`, task `PRESENTATION_SYNTHESIS`); `normalizePresentationOutline` bounds and validates
  the model output; no provider logic outside the gateway. If no model is available the request fails with a localized truthful message (no fabricated deck).
- `.pptx` is built by an in-repo OOXML writer (`src/creation/pptx/pptx-writer.ts`, `zip-writer.ts`); the bytes are owned by `PresentationStore` under a NAgex id and
  delivered through `BinaryApiResult` download routes (`presentation-creation.routes.ts`), route-access default-deny for anonymous callers.
- Main surface: Slides mode shows the outline and a real download link; Open is disabled for decks (no in-browser deck viewer exists, so none is advertised).

Tests: `r23_7c_d_presentation_runtime` (9: spec validation, zip/OOXML structure round trip, ownership/tenant isolation, truthful failure, no provider leak) and
`r23_7c_d_presentation_main_browser` (1: Main Slides end to end, EN/KR).

**Limits stated plainly (MASTER §7):**

- The generated `.pptx` is structurally validated (zip central directory, `[Content_Types].xml`, relationships, slide XML well-formedness) by the tests. It has
  **not** been opened in PowerPoint, Keynote or LibreOffice in this run.
- There is no slide thumbnail / in-app preview; `previewKind` is `TEXT`.
- Presentation reasoning needs a configured model; in an environment with none, the feature reports unavailable rather than producing a template deck.
- Slides do not yet reuse document artifacts as sources (roadmap §9 lists this as a reuse target) — not implemented.

## 4. Not done / not claimed

- R23.7C-E Video: BLOCKED — no video provider adapter exists and none may be invented; provider queue acceptance would not be completion anyway.
- No live-provider certification was run for Presentation (it has no external provider).
- Desktop Settings no longer has Autonomy and Quick Wake panels (DEBT-0013); the corresponding Desktop browser tests are skipped with that reason.

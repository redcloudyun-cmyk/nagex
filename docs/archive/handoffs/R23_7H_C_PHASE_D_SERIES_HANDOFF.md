# R23.7H-C Phase D Series — Handoff (Claude → Gemini)

**Status:** HANDOFF / UNCOMMITTED WORK IN PROGRESS
**Date:** 2026-10-01
**Branch:** `r23.6m-mobile-voice-action`
**Last commit:** `812c026` (`feat(r23.7h-c): add responsive artifact canvas workspace`) — this is the only authorized commit+push in this entire series.
**Reason for handoff:** User's Claude usage budget is nearly exhausted; work continues in Gemini. This document is the context-recovery aid — read `MASTER.md` → `docs/NAGEX_PROJECT_INDEX.md` → `docs/NAgex_AI_Development_Governance.md` first, per standing repo governance. This handoff is not spec authority.

## 0. Working tree state right now

`git status --short` shows ~141 changed paths. Only a small subset are real code changes from this series; the rest are regenerated screenshot artifacts (`artifacts/**/*.png`) and `HANDOVER.md`/CI workflow diffs that predate this series and were NOT touched by me. **Do not bulk-stage.** Before any commit: classify each hunk, stage only Phase D-series files, verify `git diff --cached`, and confirm nothing from a concurrent session gets silently committed.

**Important: a concurrent agent session (apparently Gemini, started by the user mid-series) has already been writing to this same working tree.** Evidence: `personal-home-view.js`, `public/desktop/desktop-home.css`, and the Phase D.4 test file changed on disk mid-session without me writing them; new untracked files appeared (`artifacts/visual-reconstruction*/`, `cert_log.txt`, `scripts/edit_js.mjs`, `scripts/hide_html.mjs`, `scripts/take_d4_screenshots.mjs`, `scripts/visual_reconstruction_cert.mjs`). I did not revert any of it — per the live system guidance at the time, I treated on-disk state as current truth and worked on top of it. **Before continuing, re-run `git status`/`git diff` to see the actual current state — this document describes state as of the last thing I verified, which may already be stale if that other session kept working.**

## 1. What this series is

Product Owner approved a mockup image as the visual/IA source of truth for Home, nav, Canvas and the capability catalog. Six phases executed in sequence, each a formal pasted directive requiring an exact-field-format report and explicit `COMMIT=NO / PUSH=NO` (except Phase D, which ended with one authorized "safe checkpoint" commit+push to `812c026`):

- **Phase D** — Main Product Experience: 8-item nav, 7-tile Create catalog (truthful LIVE/PLANNED/PARTIAL), Work-with-your-data section, Canvas visual rebalance, Recent Creations unification. → committed/pushed as `812c026`.
- **Phase D.1** — Visual Convergence Pass: not a new feature milestone, converge Phase D's existing functionality toward the mockup's presentation (Geometry/Surfaces/Polish). Fixed a major pre-existing HTML nesting bug (see §4).
- **Phase D.2** — Strict Visual Clone Pass: mockup = strict visual source of truth, but **never clone mockup sample data** ("Alex", fake schedules, etc. — explicitly forbidden). Real color sampling from the mockup PNG via pixel measurement, not by-eye.
- **Phase D.3** — Unified Home Workspace: Home becomes the primary Personal AI Creation Workspace with the Canvas architecture embedded directly in it (not a separate dashboard); the old `/canvas` route becomes "Focus Mode." Reused the canonical Canvas state/functions — did not fork a second artifact system.
- **Phase D.4** — Geometry-Locked Approved Mockup Clone: same functional foundation as D.3, now with measurable pixel geometry targets and hard-FAIL conditions (e.g. Canvas must be visible above the fold, no scrolling required).
- **D4 REWORK** — a narrow follow-up correcting typography/density in the "Work with your data" section only, using reference-measured bounds. Just completed (see §7) — **not yet committed**.

All six are uncommitted except Phase D's checkpoint. **None of D.1/D.2/D.3/D.4/D4-REWORK has been authorized for commit or push.**

## 2. Canonical architecture — do not fork this

These functions (originated Phase C, preserved and reused through every subsequent phase) are the single source of truth for artifact/Canvas state. **Any further work must reuse them, never duplicate them:**

- `openArtifactInCanvas()`, `dispatchArtifactOpen()`, `closeCanvas()`, `submitCanvasAsk(prefixOverride)`, `restoreCanvasFromRoute()` — all in `public/personal-home-view.js`.
- `window.NAGEX._canvasState` — single source of truth for the currently-open artifact in Focus Mode (the standalone `/canvas` route).
- `renderArtifactStage(prefix, artifactType, artifactProjection, openTarget, stateRef)` — shared renderer, used by BOTH Focus Mode and Home's embedded Canvas. Do not fork a second rendering path for Home.
- `renderArtifactContext(prefix, artifactType, artifactProjection)` — shared Agent Context-tab populator (Type/Title/Updated only — no raw canonical URL/ID in primary UI, per truthfulness rule).
- `canvasIdPrefix()` — `'canvas-'` (desktop Focus) / `'mh-canvas-'` (mobile Focus) based on `isMobileViewport()`. Home's embedded Canvas uses a third hardcoded prefix, `'home-canvas-'`.
- `window.NAGEX._homeEmbeddedArtifactIdForCert` — D.4-added debug/cert hook exposing the real canonical artifactId Home's embedded Canvas is currently showing, so certification can match by identity instead of assuming list position (see §6, D.3 cert gap).

`CREATE_CAPABILITIES` (personal-home-view.js) is a **separate, presentational-only** 7-entry catalog (REPORT/SLIDES/IMAGE/VIDEO/RESEARCH/PLAN/CODE with LIVE/PLANNED/PARTIAL status) — distinct from the server's real `creationActions` field (RESEARCH/ANALYZE only). Do not conflate the two or let one leak fake status into the other. Capability truth as last verified:
- LIVE: Report (`document-creation.routes.ts`), Image (`creation.routes.ts`/Phase C ImageStore), Research (`research.routes.ts`).
- PARTIAL: Plan (`plan-resolver.ts` — real resolution but steps can be `MOCK_ONLY`/blocked).
- PLANNED: Slides, Video, Code (no backend route at all for any of these).

## 3. Known-good methodology established this series (use it, don't skip it)

1. **Never trust a screenshot alone for geometry.** Use real headless-Chromium (Playwright) `getBoundingClientRect()`/`boundingBox()` against the real running `dist/src/server_web.js` with real seeded fixtures (not mocks). Two serious layout bugs (a 735px Canvas-height bug from `align-items:stretch`, and a 60px region-overlap from an inherited `width:320px`) were both invisible on screenshots and found only by measuring.
2. **Sample real colors from the mockup PNG programmatically** (PowerShell + .NET `System.Drawing.Bitmap.GetPixel`), never "by eye" or from memory — required since Phase D.2.
3. **CSS cascade gotcha:** this file has accumulated multiple duplicate `!important` rule blocks for the same selector from iterative multi-agent edits (e.g. `.ph-work-data-heading` currently has ~5 occurrences in `desktop-home.css` at different line numbers). The LAST one in source order wins. Always confirm which occurrence is effective before editing, and prefer consolidating rather than adding a 6th.
4. **Test false-positive trap (hit 3+ times):** writing an explanatory code comment that contains the literal forbidden substring a regression test searches for (e.g. mentioning "Alex" in a comment about removing "Alex", or `</div>` in a comment about a div-nesting fix) makes your own test fail. Fix by rewording the comment, never by weakening the test.
5. **Test registration is two-file:** every new test under `tests/` must be added to BOTH `tests/test-contract.registry.json` AND `tests/test-scope.registry.json` (under `"ux"`), or `scoped_test_system.test.ts` fails as a governance violation.
6. **Mockup sample data is strictly forbidden as production content** (Phase D.2 rule, still binding): no hardcoded "Alex", no fake schedules/approvals/notifications/recent-creations/conversations/connected-apps/suggestions. Empty state > fake data, always.

## 4. Bugs found and fixed this series

- **Canvas-always-visible CSS specificity bug** (pre-existing since Phase C, found in Phase D): `.canvas-workspace { display:flex }` was unconditional and beat `.tab-view{display:none}` at equal specificity by source order, so Canvas rendered over Home on every load. Fixed by removing the unconditional `display`.
- **Mobile equivalent**: `.mh-canvas-view { display:flex }` beat the `[hidden]` attribute the mobile shell relies on. Fixed with `:not([hidden])` gating.
- **Major HTML nesting bug** (pre-existing in committed HEAD before this series, found in D.1): one stray extra `</div>` in `index.html` prematurely closed `#view-home`, silently mis-nesting every subsequent `#view-*` as a sibling of `<main>` instead of a child. Confirmed via `document.querySelector('.center-canvas').children` count (was 3, should be 16) before the fix. Fixed by deleting the one extra tag.
- **`align-items:stretch` Grid bug** (D.4): `.home-primary-workspace` stretched Canvas/Agent columns to match the Context Rail's real (long) content height — measured 735px tall against a 900px viewport, an explicit D.4 FAIL condition. Fixed: `align-items:start`, fixed `height:430px` on the row, `.home-context-rail{overflow-y:auto}`.
- **Width-override overlap bug** (D.4): `.home-agent-panel` inherited the shared `.canvas-agent-panel` base class's `width:320px`, overlapping the context rail by 48-60px. Fixed: `.home-agent-panel { width:100% !important; }`.
- **D.3 empty-state cert gap**: `?demo=1` tenant turned out to have its own pre-seeded content, not genuinely empty. D.4 fixed this properly via Playwright `page.route('**/api/v1/**', ...)` header rewriting to a never-used tenant/principal pair — note `page.setExtraHTTPHeaders` does NOT work for this, because `apiFetch` in `app.js` explicitly sets `X-NAgex-Tenant`/`X-Principal-Id` itself, overriding context-level headers.
- **D.3 cert script false-negative**: assumed the newly-seeded fixture would rank first in Recent Creations; a different real artifact ranked first instead (not a real bug — both Home-embedded and Focus Mode agreed on the same artifact). Fixed by adding `window.NAGEX._homeEmbeddedArtifactIdForCert` so certification matches by canonical ID, never list position.

## 5. Known unresolved issues to report to Product Owner (NOT fixed, intentionally out of scope)

- **`#home-section-work-with-data` positioning hack**: `transform: translate(-151px, -14px) !important; z-index: 126 !important;` in `desktop-home.css` (~line 3400-3406) — achieves the Product-Owner-confirmed-correct outer bounds (`x=720,y=143,w=248,h=104`) but via a fragile absolute-offset hack rather than native layout. Not written by me; left untouched per explicit "do not redesign/resize outer region" instruction in the D4-REWORK directive.
- **G/N/C provider chips in Work-with-your-data have zero real backend.** Confirmed via `grep -rn "google.*drive|GoogleDrive|notion|Notion" src/http/routes/connections.routes.ts src/http/routes/providers.routes.ts` → no matches. This is a `MASTER.md §7` truthfulness concern (unsupported capability advertised). Not written by me (attributable to the concurrent Gemini session); flagged, not fixed.
- **"Connect sources" button's real behavior** is just the local file-picker ANALYZE flow (`data-creation-action="ANALYZE"` → `activateCreationAction('ANALYZE')` → `#composer-file-input.click()`), not any genuine external-service connection. Label overstates actual behavior.

## 6. Test status

Last confirmed full regression run (before the final D.3/D.4 fixes below were applied): **1726 total / 1722 pass / 0 fail / 4 skip.** After that count, the following were applied and individually verified passing but **not yet re-confirmed with a full `npm test` run**:
- D.3 test H regex narrowed (was matching the whole `renderHomeEmbeddedCanvas` body, now scoped to just the toolbar template) to avoid a false positive from the new D.4 cert-identity line.
- D.3 test C companion comment reworded to avoid a `_canvasState`-substring false positive.
- D.4 test file registered into `tests/test-scope.registry.json`'s `"ux"` array (was missing, causing a governance failure).

**Action needed: run a full `npm test` before any further work to re-establish a clean baseline**, since the concurrent session may also have touched test files.

New test files this series (all `sourceImplementationAssertions: true`, source-text regex checks, registered in both registry files under `"ux"`):
- `tests/r23_7h_c_phase_d_main_product_experience.test.ts` (8 tests)
- `tests/r23_7h_c_phase_d1_visual_convergence.test.ts` (6 tests)
- `tests/r23_7h_c_phase_d2_strict_visual_clone.test.ts` (6 tests)
- `tests/r23_7h_c_phase_d3_unified_home_workspace.test.ts` (9 tests)
- `tests/r23_7h_c_phase_d4_geometry_locked_clone.test.ts` (14 tests)
- `tests/r23_7h_c_phase_c_canvas_shell.test.ts` — modified (not new), canvas title assertion updated to check `proj.title` instead of a raw artifact ID string (raw ID display was intentionally removed from primary UI).

## 7. Most recent completed work (D4 REWORK)

Narrow correction to `Work with your data` typography/spacing only (CSS-only, `desktop-home.css`, the effective last-cascading `.ph-work-data-*` block ~line 3388-3393). Outer bounds confirmed undisturbed (`x=720,y=143,w=248,h=104`). Full bounds table, findings, and `D4_STATUS=AWAITING_PRODUCT_OWNER_APPROVAL / COMMIT=NO / PUSH=NO` report was just delivered to the user in-chat (not yet copied into a tracked evidence doc — do that before considering this phase closed). Comparison images at `artifacts/r23.7h-c-phase-d4/{reference-work-data,actual-work-data,work-data-side-by-side,work-data-overlay}.png`.

## 8. Files most heavily touched this series

`public/app.js`, `public/index.html`, `public/personal-home-view.js`, `public/desktop/desktop-home.css`, `public/style.css`, `public/mobile/mobile-home.js`, `public/mobile/mobile-home.css`, `public/i18n.js`, `public/shared/tokens.css`, `docs/canonical/NAgex_UX_and_Interaction_Architecture.md` (§9, nav update). Full detail on exact changes per phase is in conversation history only (not re-derivable from this doc alone) — if precise diffs are needed, use `git diff` against `812c026` on the files above, since nothing past that commit is staged/committed.

## 9. Next steps for whoever picks this up (Gemini or otherwise)

1. Re-run `git status`/`git diff` first — the concurrent session may have kept editing after this document was written.
2. Run full `npm test` to re-confirm the regression baseline.
3. Get Product Owner sign-off on D.1 through D4-REWORK (none have been approved yet — all are `AWAITING_PRODUCT_OWNER_APPROVAL`).
4. Once approved, stage **only** the real Phase D-series code/test/doc files (see §8) — explicitly exclude the unrelated pre-existing dirty files (CI workflow, `HANDOVER.md`, bulk screenshot artifacts) unless those are independently confirmed as intentional and in-scope.
5. Decide whether to fix the two flagged-not-fixed issues (§5) as a follow-up phase, or carry them forward as debt in `docs/debt/`.

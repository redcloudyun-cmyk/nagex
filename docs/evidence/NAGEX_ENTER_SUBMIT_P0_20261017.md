# NAgex — Enter does not send (P0) · investigation and fix (2026-10-17)

**Status:** EVIDENCE (point in time) · **Canonical text:** `docs/canonical/NAgex_UX_and_Interaction_Architecture.md` ("Composer keys") · **Release posture:** `RELEASE = NO-GO`. Nothing was deployed, `main` untouched, the deployed service was not read beyond one unauthenticated request (see section 3), no running CI was disturbed (separate branch `topic/enter-submit-p0-20261017`).

Report: *on the real NAgex service, typing a message and pressing Enter does not send it; the mouse Send button works.*

## 1. Result

```text
ENTER_FIX_SHA        = dd2e9f8  (feat(ui): Enter sends ...)  merged as 3de7b1e;  follow-up 9bad398 (safe Enter/Send while recording) merged as 20b71ad
INTEGRATION_SHA      = 0f71886  (origin/integration/product-completion-20261015) - contains both
DEPLOYED_SHA         = NOT VERIFIABLE from here. Last SHA the repository records as deployed: bcd7e10 (docs/evidence/NAGEX_D09_OVERNIGHT_REPORT_20261015.md, 2026-10-15, "test server, unchanged")
ROOT_CAUSE           = the build that is (as last recorded) deployed predates the Enter fix: at bcd7e10 the box handles ONLY Ctrl/Cmd+Enter, so a plain Enter falls through to the textarea's new line.
                       Matches the symptom exactly. NOT confirmed against the live build (section 3).
IME_TEST_RESULT      = PASS (real Chromium, real CDP IME composition) - Main (17 existing tests) + the 3 other reachable boxes (new)
BROWSER_E2E_RESULT   = PASS - see section 5
DEPLOYMENT_REQUIRED  = YES, if the live build is older than dd2e9f8 - and it is only deployable by the person who runs the server (restart needs their sudo); nothing was deployed here
```

## 2. Is the fix in the code? (checks 1-3)

| Revision | Handles plain Enter (`compositionEndedAt` guard present) |
|---|---|
| `bcd7e10` (last recorded deployed SHA) | **no** - only `(event.metaKey \|\| event.ctrlKey) && !event.isComposing` |
| `origin/main` (`9d3ccc8`) | **no** |
| `origin/release/d09-pr16-p0-integrated-20261015` (`068f13d`) | **no** |
| `dd2e9f8` and `origin/integration/product-completion-20261015` (`0f71886`) | **yes** |

`bcd7e10` is an ancestor of integration; 90 commits lie between it and `dd2e9f8`. The Enter fix exists **only on the integration line** - a deployment from `main` or from the d09 release branch would not contain it. The repository defines **no staging environment** (no branch, workflow or document names one); the only deployed environment on record is the test server `nagex.agex.site`.

Original root cause (commit message of `dd2e9f8`): the box handled only Ctrl/Cmd+Enter; a plain Enter fell through to the textarea's own new line.

## 3. What could not be checked, and why

`https://nagex.agex.site/` answers an unauthenticated request with a **302 to Cloudflare Access** (`Www-Authenticate: Cloudflare-Access`). One GET was made to establish that; nothing was sent after it, no login was attempted and the access control was not bypassed. There is no ssh configuration on this PC. The deployed SHA and the deployed `main-surface.js` could therefore not be read.

To settle it in one step, **as the signed-in person**, either of:

```text
open  https://nagex.agex.site/api/v1/vcs/status        -> "commits"[0].hash is the deployed HEAD (a read-only route that already exists)
console on the NAgex page:  fetch('/main-surface.js').then(r => r.text()).then(t => console.log(t.includes('compositionEndedAt')))
                            true  = the Enter fix is in the served script;  false = the served build is older than dd2e9f8
```

If it prints `true` and Enter still fails, the cause is NOT the missing deployment, and the next suspect is the device: on a touch-first device (`hover: none` and `pointer: coarse`) Enter is deliberately a new line and the Send button sends (a phone, or a tablet with a hardware keyboard).

## 4. What else was found and fixed (separate branch)

The Enter fix of 2026-10-16 covered **Main only**. The other message boxes were checked in real Chromium **before** changing anything:

| Box | Before | Now |
|---|---|---|
| Main (`#main-surface-input`) | correct (`enter_to_send_browser`, 17 tests) | same behaviour, now using the shared rule |
| ambient Ask sheet (`#ambient-prompt-input`, opened with Alt+N) | **sent on the Enter that confirms a Korean syllable** (a truncated message) | guarded |
| Quick Wake (`#qw-composer-input`) | **same defect**, and the Send button and Enter ran **two copies** of the send code | guarded; one `sendFromInput()` for both |
| Canvas Ask (three inputs) | checked `isComposing` only (misses `keyCode 229` and Safari's compositionend-first order) | shared rule |
| legacy phone Home bar (`#mh-command-input`) | dead code: with Main loaded `initCommandBar()` never runs, the shell is `display:none` at every viewport | **left unchanged** (untestable), registered as DEBT-0017 |

Changes: `public/composer-keys.js` (new; `watchComposition`, `confirmsComposition`, `isSubmitEnter`; the composition flag is also cleared by blur and by a non-composing `input` event so it cannot get stuck), `public/main-surface.js`, `public/app.js`, `public/desktop-quickwake.js`, the two HTML pages (script tag before its consumers).

**Cache coverage (found on the way):** the `?v=` stamp is the hash of `FRONTEND_VERSIONED_FILES` in `src/server_web.ts`; nine served assets were missing from that list (`desktop-quickwake.js/.css`, `personal-home-view.js`, `connections-ui.js/.css`, `product-design-convergence.css`, `browser-convergence.js`, `mobile/mobile-knowledge.js/.css`), and seven of them (all but the two Quick Wake files) were also missing from the no-cache list - so an edit to them would not change the stamp and could be served stale after a deployment. They are now covered, the list is exported, and `tests/frontend_asset_versioning.test.ts` pins that every versioned asset of every page is in it, exists and is served `no-store`.

## 5. Verification

| Check | Result |
|---|---|
| `Enter = send`, `Shift+Enter = new line` on Main | PASS - `enter_to_send_browser` 17/17 (unchanged, on the refactored code) |
| Enter during a real Korean composition (CDP `Input.imeSetComposition`) sends nothing; committing sends nothing; the next Enter sends the **full** confirmed text once and empties the box | PASS - ambient, Quick Wake, Canvas Ask (`composer_enter_browser`) |
| the truncated, still-composing text is never sent | PASS (asserted on the request bodies) |
| Enter and the Send button cause the very same requests in the same order | PASS - all three boxes |
| empty box and Shift+Enter send nothing and leave the text alone | PASS - all three boxes |
| a composition that never reports its end does not leave Enter dead | PASS (real page) + unit |
| rules in isolation (isComposing / 229 / flag / compositionend-first / stuck flag / no watcher) | PASS - `composer_keys` 5 tests |
| every versioned asset covered and no-store | PASS - `frontend_asset_versioning` 2 tests |
| **Mutation check** - old handlers restored in `app.js` and `desktop-quickwake.js` | the Korean-composition test **FAILS** on the ambient sheet and on Quick Wake (the confirming Enter sent the truncated text), and passes again with the fix. Canvas Ask passed under the old code in Chromium (its `isComposing` check is enough there); its remaining gap - Safari's order - is covered by the unit test, not by Chromium |

### Gates (local, Windows, 2026-10-17)

```text
npm run build              exit 0
npm test (regression)      3881 tests · 3873 pass · 0 fail · 8 skipped      (first run: 1 fail - the test-contract registry wanted writesRepositoryArtifacts on the new browser entry; fixed, rerun green)
npm run test:browser-cert  486 tests · 480 pass · 0 fail · 6 skipped        (the new composer_enter_browser, enter_to_send_browser and the Design System / Product Builder files are inside this run; the 6 skips are older "superseded" markers)
```

CI is reported separately (it runs on GitHub, on both operating systems, after the merge).

Not tested: real Safari, a real physical Korean keyboard/IME, a phone. Chromium's CDP composition is a faithful model of Chrome's event order, not of every browser's.

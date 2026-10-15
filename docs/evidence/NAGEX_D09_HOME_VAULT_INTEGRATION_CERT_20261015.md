# NAgex D-09 — Serial integration certification: approval-gated "save to my Vault" in Home

**Date:** 2026-10-15 · **Branch:** `integration/d09-vault-home-20261015` · **Order:** `NAGEX_D09_SERIAL_INTEGRATION_HOME_VAULT_ORDER_20261015.md`
**Labels:** PASS / FAIL / BLOCKED / NOT_RUN. Evidence level is always stated: *unit*, *local real browser* (Chromium against the production server in-process, local fake model only for the answer on screen), *hosted* (the deployed test server). No secret, token, cookie or user text appears here. Nothing was deployed, merged to main, or written to hosted data; Voice WIP was not touched.

## 1. Result

| Field | Value |
|---|---|
| `BASE_SHA` | `7c9f2a3` (PR #15 backend `18f4a40` + the integration order); common fork of both tracks `67fdcf0ae4e32058299cc35cf7b3d79cbce69bc0` |
| `TESTED_SOURCE_SHA` | `660e15f56e130c9efd1df9c6af1c5f22d110702b` |
| `FINAL_SHA` | the commit that adds this report and the screenshots (docs/assets only on top of `TESTED_SOURCE_SHA`); its SHA is in the Draft PR comment |
| Track A source (PR #15) | `18f4a4008325c9cc856a9ac1f266a1bacc424e5d` · Track B source `deb78d5e6ad037f14d5b745276175bb9a14157a1` |
| A ∩ B changed files | **0** (A: 25 paths, B: 2 paths; `comm` of the two `git diff --name-only 67fdcf0...` lists) |
| Home journey (desktop 1440, phones 430 / 390 / 360, EN + KR) | **PASS** — local real browser, 19 tests, every control checked as *reachable* (see §3) |
| Mobile Vault "Open" / visibility after navigation | **PASS** — local real browser on the phone's own native Vault screen |
| Approval / security / duplicate execution | **PASS** — all suites green (§6) |
| `npm run build` | **PASS** |
| `npm test` | **PASS** — 2986 tests, 2978 pass, **0 fail**, 8 skipped, 154 suites |
| `npm run test:browser-cert` | **PASS ×2** — 324 tests, 318 pass, **0 fail**, 6 skipped, under the documented concurrency policy (4 files at a time) — see §4 for the default-parallelism finding |
| Codex QA script on this candidate | **PASS** — `LOCAL_DEMO_READINESS=PASS`, 18/18 |
| Hosted signed-in E2E | **NOT_RUN** (not deployed; test server expected `bcd7e10`, re-verified unchanged) |
| Deployment / main merge / Voice WIP merge | **NOT_RUN** (not requested) |

## 2. What the person gets (backend contract unchanged from PR #15)

"회의 요약을 내 보관함에 저장해줘" / "Save that summary to my Vault" → One Input routes it as `VAULT_SAVE` → `POST /api/v1/ambient/intent {prompt, saveContext}` (NAgex builds the plan, no model) → **the exact draft is shown** (title, "My Vault", source label, the whole text in a scrollable, focusable region, built with `textContent`) → "Request approval to run" → the unchanged `from-reviewed-plan` + approval store → the person's own **Approve** → `VaultSaveService` consumes the approval once and writes → "Saved to your Vault" **only** for `SAVED_TO_VAULT` + `VERIFIED` → **Open in Vault** shows the saved text → a brand-new browser lists it → Activity records the title only. Decline, expiry, tampering, replay, a second click and another person store or reveal nothing (PR #15 evidence, re-run here).

How the Home UI binds to the backend (reviewed against the actual API, not applied blindly — the prototype patch applied cleanly because `public/` was unchanged, but each hunk was re-read against the order):
- `saveContext` is **only** the answer of the turn right before the request. Every request takes the answer out of reach; a Vault-save request puts it back (so asking again after a decline works); a new conversation clears it. Proven: an unrelated request in between, or a new conversation, makes "save that" ask what to save instead of silently using an older answer (`home_vault_save_browser`, binding test).
- The generic note paths are unchanged and approval-free: "메모:" is still a plain capture, and the inline "Save to Vault" button still saves at once (asserted: no approval POST).
- "Open in Vault" no longer guesses: it switches to the Vault screen that width uses and opens the item there through the owner-authenticated Vault data; an id that is not in the person's own Vault opens nothing.

## 3. Mobile P0 — root cause and fix

The prototype's phone test failed at "`#vault-recent-list` hidden after hash navigation". Diagnosis, in order:

1. **That was not the bug in the navigation.** Phones have a *separate native Vault* (`#mobile-view-vault`, list `#mh-vault-list`, `public/mobile/mobile-vault.js`); the desktop `#vault-recent-list` is hidden there by design. The prototype test looked at the wrong element. **Real defect found there:** the phone's item sheet showed only metadata (type, source, dates) and never the saved text, and nothing could open a given item — "reopen" on a phone showed no content. Fixed in `mobile-vault.js` (the sheet shows the saved text escaped with line breaks, `role=dialog`, focus moves in, Escape closes, 44 px controls, provenance label for approved saves) plus `window.NAGEX.openMobileVaultItem(id)`; Home's `openVaultItem` picks the phone or desktop viewer.
2. **The reachability check I added then exposed three pre-existing phone defects** that no earlier test could see, because Playwright's "visible" ignores clipping and overlap:
   - **The conversation was invisible on phones.** On the untouched PR #14 tree at 390 × 844 the thread card is **4 px tall** after any answer. Cause: the phone rules force `.app-wrapper` and `.workspace-grid` to `display:block`, which removes the flex height chain the conversation layout (`flex: 1 1 0` inside an auto-height column) needs; `.tab-view.main-conversing { height:100% }` then also made content overflow its own box. Answers, plans, drafts and approvals sat behind the composer. Fix: restore the flex column chain on phones, let the canvas be the one scroller, let the thread take its content height, release the 100% heights (phones only).
   - **An invisible header button swallowed taps.** The transparent 40 px search button's label wrapped over the conversation and, being hit-testable, intercepted taps meant for the content below (`elementsFromPoint` showed `#btn-header-search` at points far outside its box). Fix: `overflow: hidden` on it.
   - **The fixed bottom navigation covered the end of the conversation** (the send button sat under it; a click was reported as intercepted by `mobile-bottom-nav`). Fix: canvas bottom padding (needs `!important` because `desktop-home.css` sets the canvas padding with `!important`), and the stream scrolls to the end after the draft, the proposal and the action buttons render.
   - Also: the proposal/draft label–value grid squeezed the text being approved into a sliver at 360 px (now stacked below 520 px), and the "Waiting for your approval" card stayed on screen next to a finished result (the list now refreshes when the run ends).
3. **The test has teeth:** with the phone CSS block removed, the 390 px test fails at "the answer must be visible and touchable"; with it, all 19 pass.

Files: `public/main-surface.js`, `public/main-surface-rearchitecture.css`, `public/i18n.js`, `public/mobile/mobile-vault.js`, `public/mobile/mobile-vault.css`. Desktop styles are untouched (all new layout rules are inside `max-width: 860px`/`520px` queries, except the bottom-sheet scroll rule which only adds `max-height`/`overflow` to two modal cards).

Certified at EN + KR × 1440 / 430 / 390 / 360 (`tests/home_vault_save_browser.test.ts`, 19 tests): draft preview, request, Approve **and** Decline, saved result, Open (desktop modal / phone sheet), the Vault list after navigation, Activity, keyboard operation (focus the draft text, request and Approve by keyboard; focus moves into the phone sheet; Escape closes), 44 × 44 px targets on phones, **zero horizontal overflow** at every state, and every touched control reachable (centred in the viewport, above the fixed nav, hit-test returns the control itself).

## 4. Browser gate at default parallelism — reproduced, measured, bounded

- **Reproduced.** On this candidate at node's default (11 files at once on a 12-thread machine): run A failed (`r22_8` "Desktop Render EN": `#view-home` not attached in 10 s), run B failed (Settings / OAuth account lifecycle, 15–30 s waits), run C passed 324/0, run D passed 324/0. The untouched PR #14 tree failed at default the same day (3 tests) although the same source passed 294/0 at 00:30; PR #15's source failed twice with a different set each time (`ECONNRESET` in `route.fetch`, 10–30 s `waitForSelector`).
- **Measured cause.** Total CPU sampled every 3 s during a default run: median 99 %, ≥ 90 % in **55 of 75 samples (73 %)**. 11 headless Chromium + production-server workers saturate every core; fixed-budget waits then expire *intermittently*, in a different suite each time. A throwaway diagnostic copy of the failing test (never committed) showed the pages are healthy — they are slow. Each failing suite passes alone; none points to a product defect.
- **Policy (this branch only, documented in `scripts/nagex-test-gate.mjs`).** The `browser` gate runs 4 files at a time; `NAGEX_TEST_CONCURRENCY=<n>` overrides it for any gate (validated 1–64). Same 32-file set, same setup, no test, assertion or timeout changed. Result: PR #15 source 305/0; this candidate **324/0 twice** (≈ 290 s each, about 60 s slower than the default). The `regression` gate keeps node's default (it is stable: 68–82 s).
- This does **not** erase the default-gate finding: at default parallelism the gate is load-sensitive on a busy workstation. Please also run it once on a quiet machine with `NAGEX_TEST_CONCURRENCY=11` before the release candidate is declared.

## 5. Codex track — imported after UI review, re-verified, timeout resolved

- Imported **unchanged** (2 files) only after the UI work and a read-through: the script uses local stubs, temp directories, no network, no credentials, no hosted access. Re-run on this candidate: **18/18 PASS** (its static "browser path" checks still hold against the new Home).
- **The "document chain TIMEOUT / UNVERIFIED at 180 s" does not reproduce.** `one_input_document_chain_browser`: 11/11 in **16 s** with the project's setup, **17 s** without it (isolated home), and **11/11 in the full browser gate**. What Codex hit is explained by the code: without `--require dist/tests/_setup.js` the app writes to its *default* directories — e.g. the personal reminder store defaults to `<cwd>/.nagex_data/runtime` (`src/personal/personal-reminder.store.ts:49`), the others to `~/.local/share/nagex/*`; `_setup.js` redirects dozens of them to a private temp root. In a sandbox where the worktree or home is not writable that is exactly "write error while the app initialised its default runtime directory". Redirecting **only** the reminder directory (their second attempt) leaves every other store on its default. I simulated unwritable defaults: the suite **fails fast (≈ 1 s, `ENOTDIR`)**, it does not hang, so the 180 s itself is **not reproduced** — classification: *environment (sandbox write permissions / not using the required setup)*; the suite is green under `npm run test:browser-cert` and `node --require dist/tests/_setup.js --test …`. No timeout was raised, nothing skipped. Model: local deterministic stub (not live).
- **Skip discrepancy (Codex 9, Claude 8) explained.** Codex: 2959 tests / 2950 pass / 9 skipped; ours at the same 2959 tests: 2951 / 8. `mcp_e2e_isolated_server` skips its HTTPS-variant case when `openssl` cannot be run to make a throwaway certificate. With `openssl` removed from `PATH` the suite goes from 15 pass / 0 skip to **14 pass / 1 skip** and nothing else changes — i.e. Codex's environment had no `openssl`. The other 8 skips are the same everywhere (POSIX signal tests on Windows ×4, retired password-auth contracts ×4). The environment gap is real: **without `openssl` the TLS variant of the MCP e2e is not exercised**.

## 6. Counts (all on `TESTED_SOURCE_SHA`)

| Suite | Result |
|---|---|
| `npm run build` | PASS |
| `npm test` | 2986 tests · 2978 pass · 0 fail · 8 skip · 154 suites |
| `npm run test:browser-cert` (policy: 4 at a time), run 1 / run 2 | 324 · 318 pass · 0 fail · 6 skip — both |
| `home_vault_save_browser` (new, Home + phone Vault, EN/KR × 4 widths) | 19/19 |
| `vault_save_approval_browser` (PR #15, real session, HTTP) | 11/11 |
| `vault_save_approval` (PR #15, service, restart/expiry/replay/tamper/storage failure) | 23/23 |
| `vault_write_truthfulness` (new) | 3/3 |
| `home_reviewed_plan_security_review` / `_mcp_e2e` / `_browser` | 14/14 · 15/15 · 10/10 (calendar/mail/MCP approval paths unchanged) |
| `approval_ownership_isolation` / `approval_ttl_security` | 16/16 · 11/11 |
| `one_input_document_chain_browser` / `one_input_slides_chain_browser` | 11/11 · 4/4 |
| One Input routing / browser | 66/66 · 42/42 |
| Codex `demo-readiness-audit.mjs` | 18/18 |

The 6 browser skips and 8 regression skips are the long-standing ones with recorded reasons; none was added or skipped by this work.

## 7. A separate defect found and fixed (as the order asked for): the ordinary Vault write swallowed errors

`VaultStore.saveItem()` called `FileRecordStore.write()`, which logs and returns on a failed disk write. So `POST /api/v1/workspace/vault`, the Inbox "save to Vault" and the Knowledge upload answered **201 with an item that was never stored** — and the Inbox route then marked the capture `ACTIONED`. A failing test through the real routes proved it first (201 on an unwritable Vault). The fix (`saveItem` uses the throwing write and raises `VAULT_WRITE_FAILED`) is outside the approved path, which uses `saveItemOnce` and is unchanged; the three routes now answer an error, hand out no id and leave the capture un-actioned (`tests/vault_write_truthfulness.test.ts`, 3/3). Callers of `saveItem` (demo seed, Inbox, Knowledge, Vault routes) are covered by the full regression. `saveItemOnce` semantics were re-inspected: durable write (`writeOrThrow`), idempotent by derived id, refuses an id owned by someone else, reads the item back before `VERIFIED`.

## 8. Evidence (screenshots, local real browser, local fake model for the answer)

`docs/evidence/NAGEX_D09_HOME_VAULT_INTEGRATION_assets/` — for `ko-1440`, `ko-390`, `en-1440`, `en-360`: `1-draft`, `2-waiting-approval`, `3-saved`, `4-opened-in-vault` (16 PNGs). They show the exact draft, the approval card with Approve / Decline, the verified "saved" result with Open in Vault, and the saved text opened in the desktop modal and in the phone's own Vault sheet. They are **not** hosted evidence.

## 9. Voice WIP (not merged, not touched)

The uncommitted Voice WIP in the main checkout (8 files, 1110 diff lines) was re-checked read-only with `git apply --check --cached` against this branch: **7 of 8 apply cleanly; `public/main-surface.js` conflicts** (the composer markup, as before — unrelated to this work, but this branch edits that file in other places, so the merge still needs a hand-merge and a re-run of the Home + Voice gates). Voice is not a prerequisite for the Vault demo. Voice files (`desktop-quickwake.js`, `renderer-voice-adapter.js`, the voice tests, ADR-0013) are untouched here.

## 10. Touched files (vs the integration base `7c9f2a3`)

`public/{i18n.js, main-surface.js, main-surface-rearchitecture.css, mobile/mobile-vault.js, mobile/mobile-vault.css}` · `src/workspace/vault.store.ts` · `scripts/nagex-test-gate.mjs` · `scripts/demo-certification/codex/demo-readiness-audit.mjs` (Codex, unchanged) · `tests/{home_vault_save_browser, vault_write_truthfulness}.test.ts`, `tests/_local_ai_world.ts`, the two registries · `docs/evidence/NAGEX_D09_CODEX_DEMO_AUDIT_20261015.md` (Codex, unchanged), this report, the screenshots. Registry entries: `home_vault_save_browser` (REAL_BROWSER_CERT, browser/personal-home/ux/permission-approval-hardening) and `vault_write_truthfulness` (CANONICAL_BEHAVIOR).

## 11. Rollback

Nothing is deployed, so rollback is branch-level: abandon `integration/d09-vault-home-20261015`, or revert the four commits `660e15f 536edab 3825460 5fb765d` (each is self-contained; the Home UI commit alone can be reverted and the backend still works through the API). If this is ever deployed, use the release-directory swap, backup and rollback commands in `NAGEX_D09_OVERNIGHT_REPORT_20261015.md` §14 (5) with this branch's tested SHA; the previous release `bcd7e10` remains the rollback target. No data migration is involved (new Vault items are ordinary `VaultItem` records).

## 12. Recommendation

- **GO — to ask the operator for deployment approval of this candidate.** Backend + Home (desktop and phone) + Codex QA are joined; build, regression and two browser certifications are green on the exact source; approval, ownership, replay, restart, storage-failure and no-phantom-save invariants hold; the mobile "reopen" and conversation-visibility defects are fixed and covered by a check that fails without the fix.
- **NO-GO for any claim of hosted proof.** `REAL_APPROVE_EXECUTE_HOSTED` / hosted Vault save stay **NOT_RUN** until an explicit deployment authorization and a hosted signed-in run ("summary → request → Approve → Open from Vault").
- **Conditions / open items:** (1) re-run the browser gate once at full default parallelism on a quiet machine; (2) Voice WIP needs a separate serialized merge (one conflicting file); (3) the test environment needs `openssl` for the MCP HTTPS case; (4) the answer on screen in these tests comes from a local fake model — the live Nemotron path is unchanged by this work and was certified separately in PR #14 (`REAL_*` live certs).

## 13. 한국어 요약

- **되는 것**: 홈에서 "회의 요약을 내 보관함에 저장해줘" → 저장될 **정확한 내용**(제목·저장 위치·출처·전체 본문) 미리보기 → 승인 요청 → **사용자가 직접 승인** → 보관함에 1건 저장 후 다시 읽어 확인(VERIFIED)해야만 "보관함에 저장했어요" 표시 → "보관함에서 열기"로 저장된 본문 확인(데스크톱 모달 / 모바일 전용 보관함 시트) → 새 브라우저에서도 목록에 보임 → 활동에는 제목만. 거절·만료·변조·재생·다른 사용자·저장 실패는 모두 저장 0건.
- **모바일 원인**: ① "보관함 탭이 숨는다"는 건 탐색 버그가 아니라 휴대폰은 **별도의 모바일 보관함 화면**을 쓰기 때문(프로토타입 테스트가 엉뚱한 요소를 봄). 진짜 문제는 모바일 시트에 **저장된 본문이 안 보이고 항목을 직접 열 수도 없던 것** → 수정. ② 새로 만든 "손가락으로 닿을 수 있는지" 검사가 기존 결함 3개를 드러냄: **휴대폰에서 대화 영역이 4px로 접혀 보이지 않던 문제**(PR #14에도 존재), 보이지 않는 검색 버튼이 탭을 가로채던 문제, 하단 내비게이션이 입력창 끝을 가리던 문제 → 모두 수정, 수정 전에는 테스트가 실패함을 확인.
- **브라우저 기본 동시성 실패**: 재현·측정(CPU 90% 이상이 실행 시간의 73%) — 11개 크롬+서버가 동시에 돌며 시간 제한 대기가 무작위로 초과. 제품 결함 아님(기준 PR #14 트리도 동일). 이 브랜치에서만 브라우저 게이트를 4개 동시로 제한(문서화, 환경변수로 변경 가능), 테스트·단언·타임아웃은 그대로 → **324건 실패 0, 2회 연속**. 조용한 PC에서 기본 설정 재확인은 남아 있음.
- **Codex 180초 타임아웃**: 재현 안 됨(16~17초에 11/11 통과). 필수 테스트 설정(`_setup.js`) 없이 기본 디렉터리(`.nagex_data`, `~/.local/share/nagex`)에 쓰려다 샌드박스에서 막힌 환경 문제. **스킵 9 vs 8**: Codex 환경에 `openssl`이 없어서 MCP HTTPS 케이스가 1건 더 스킵됨(openssl 제거 실험으로 확인).
- **별도 결함 수정**: 일반 보관함 저장(`POST /workspace/vault`, 인박스→보관함, 지식 업로드)이 디스크 쓰기 실패를 삼키고 201을 돌려주던 것 → 이제 오류. 승인형 경로는 그대로.
- **판정**: 승인 요청용 후보로 **GO**. 호스팅 실증은 **NOT_RUN**(배포 승인 필요), Voice WIP는 병합 안 함(8개 중 `public/main-surface.js` 1개 충돌, 별도 직렬 검토 필요).

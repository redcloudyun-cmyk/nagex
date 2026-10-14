# NAgex D-09 Overnight Report — demo-readiness work for the 25 Oct video

**Date:** 2026-10-15 (night of 2026-10-14) · **Branch:** `d10/nightly-demo-readiness-20261014` (Draft PR → `d11/one-input-intent-20261014`) · **Directive:** `NAGEX_D10_OVERNIGHT_AUTONOMOUS_DIRECTIVE_20261014.md`
**Labels:** PASS / FAIL / BLOCKED / NOT_RUN. A gate that was not executed is never PASS. No secret, cookie, token, prompt text or answer text appears in this report.

## 1. Status fields

| Field | Value | Evidence (short) |
|---|---|---|
| `BASE_SHA` | `0f47c8b0a7f247de3e57cc889934355d09803da2` | tip of `d11/one-input-intent-20261014` at the start of the night (D11 code through `559cf30` + the overnight directive) |
| `FINAL_SHA` | the commit that adds this report (docs-only, directly on top of `TESTED_SOURCE_SHA`) | its exact SHA is in the Draft PR comment; a file cannot contain its own commit id |
| `TESTED_SOURCE_SHA` | `88e94b19006ec802cf3d303bab7690a0dd2a87af` | every gate below ran on this exact source |
| `GIT_BRANCH` | `d10/nightly-demo-readiness-20261014` | pushed; commits `bbb33fc`, `825ad7f`, `8cc41b4`, `88e94b1` (+ this report) |
| `CURRENT_DEPLOYED_SHA` | `bcd7e10` (test server, unchanged) | re-checked at the end: `nagex.service` MainPID 2997023, active since 2026-10-14 16:44:54 KST, source dir at `bcd7e10`, no temp clone left |
| `REVIEWED_PLAN_SECURITY` | **PASS** (2 defects found and fixed) | §3 |
| `APPROVAL_NO_PREEXECUTION` | **PASS** (code + local end to end) | §3 — nothing reaches a provider before a concrete human approval |
| `OWNER_ISOLATION` | **PASS** (local end to end) | §3, §4 |
| `REPLAY_PREVENTION` | **PASS** (local end to end) | §3 |
| `REAL_APPROVE_EXECUTE_HOSTED` | **NOT_RUN** (BLOCKED) | not deployed (needs your approval + sudo); no benign provider configured on the host (§5) |
| `DOCUMENT_CREATE_LOCAL` | **PASS** | §4 — KO and EN, production server in-process, local deterministic model |
| `DOCUMENT_REOPEN_LOCAL` | **PASS** | §4 — listed in Recent and opened again from a brand-new browser |
| `DOCUMENT_CREATE_HOSTED` | **NOT_RUN** | needs a real signed-in session on the host (forbidden without approval); `/var/lib/nagex/documents` does not exist yet, i.e. no document was ever created there |
| `RESEARCH_DOCUMENT` | **PASS** for the chain (local fake search); **NOT_RUN** with a real search provider | §4 |
| `ONE_INPUT_KO_EN` | **PASS** | §6 — 81-row dataset 81/81, routing 66/66, browser 42/42, live Nemotron 13/13 |
| `COMPOUND` | **PASS**: research→document and research→slides browser-certified; research→image is truthfully *not* compound | §6 |
| `UNSUPPORTED_TRUTHFUL` | **PASS** | video / build-and-run-an-app say "not available", nothing created, no chat answer posing as the deliverable |
| `VOICE_WIP_CONFLICT` | **BLOCKED — recorded, not merged**: 1 of 8 files conflicts | §8 |
| `LIVE_NEMOTRON` | **PASS** on the final SHA (real Nebius / Nemotron, no fake fetch) | §9 |
| `FALLBACK` | **PASS at test level; not triggered live tonight** | 0 fallbacks in 25 live calls tonight; the Gemini fallback with a recorded reason was observed live on 2026-10-14 (D11 cert, 1/13) and is covered by the Nemotron-first tests inside the 2959 |
| `BUILD` | **PASS** | `npm run build` exit 0 |
| `REGRESSION` | **PASS** | `npm test`: 2959 tests, 2951 pass, **0 fail**, 8 skipped, 145 suites, 67 s |
| `BROWSER_CERT` | **PASS** | `npm run test:browser-cert`: 294 tests, 288 pass, **0 fail**, 6 skipped, 53 suites, 174 s |
| `DEPLOYMENT` | **NOT_RUN** (not requested) | test server untouched |
| `MAIN_MERGE` | **NOT_RUN** (not requested) | nothing merged anywhere |

Whole local gate sequence on `88e94b1` (build + `npm test` + browser-cert): 270 s. The 8 + 6 skipped tests are pre-existing skips with recorded reasons (POSIX-only signal tests on Windows; retired password-auth contracts; tests superseded by a consolidated certification); none was added tonight and none was skipped to make a test pass.

## 2. What changed tonight (all on this branch; Voice WIP and other worktrees untouched)

| Commit | Change |
|---|---|
| `bbb33fc` | **Fix (Task A, P0):** an approval that *expires* now ends the run waiting on it (`FAILED / APPROVAL_EXPIRED`) instead of leaving it "waiting" forever; the plan-seal claim table is bounded and **fails closed** (`503 PLAN_RUN_CAPACITY`) instead of evicting a live claim that could then be claimed twice. 13 independent security-review tests. |
| `825ad7f` | Router: "…라고 알려줘" at a time is an action (reminder); "draw / sketch / paint …" is an image request. Local deterministic model/search stand-in (`tests/_local_ai_world.ts`, tests only). Document-chain browser tests (KO/EN). 81-row realistic intent dataset. MCP e2e additions. |
| `8cc41b4` | **research → slides** browser-certified (KO/EN); **research → image** no longer promises a research step it never runs (router drops the RESEARCH need for an image and records `RESEARCH_NOT_USED_FOR_IMAGE`; the screen says so in the user's language). The research prompt names the artifact it feeds. |
| `88e94b1` | Test-only: the Recent grouping test assumed "1 h and 3 h ago" is still *today*; between 00:00 and 03:00 it is *yesterday* (it failed in this very night's first browser-cert run). The product grouping by local day is correct; the test's clock assumption was fixed. |

Public contracts changed: none. New reason code `RESEARCH_NOT_USED_FOR_IMAGE` (additive) and new i18n key `mainRoute.imageNoResearch` (EN + KO). No route added (inventory test unchanged at 350).

## 3. TASK A — reviewed-plan → Human Approval → execution (independent review)

Trace reviewed end to end: plan shown (`PlanSeal` over tenant | principal | canonical plan hash | expiry, per-process random key) → `POST /api/v1/tasks/from-reviewed-plan` (verify seal → re-resolve → re-assess eligibility → claim once → create `ALWAYS_APPROVE` task) → `runWithResolvedPlan` (frozen plan, **no model call**) → broker only *requests* approval → existing approve route → `TaskContinuationCoordinator.onApproved` → broker with the approval id → one-time consume → honest outcome (`TOOL_RESPONDED`, verification `UNVERIFIED`; declined / expired / failed stated as such).

Tested (13 security-review tests + 15 MCP end-to-end tests, all passing): 401 unauthenticated; wrong owner / wrong tenant; stale, foreign and tampered seals; seal from another process; double and concurrent clicks (one task); replay after completion; expiry; missing arguments; denied approval; provider error; capability set changed between preview and request; unauthorised POST; restart while waiting (task, run, continuation, approval, frozen plan survive; approving afterwards executes the exact frozen step **exactly once**); restart + decline stays declined; the route never takes the "runnable" verdict, a resolved plan, an approval id, a tool id or an identity from the request body; it never calls the broker itself and never grants, consumes or edits an approval.

Defects found (both reproducible, both fixed, both with a regression test): (1) approval expiry left the task "waiting"; (2) the claim table could forget a live claim when full. Classification of restart/expiry: restart = survives and resumes once; expiry = terminal FAILED with a stated reason and a late Approve refused.

Not claimed: the hosted (deployed) approve → execute path — **NOT_RUN** (§5).

## 4. TASK B — natural-language document, real creation and persistence

`tests/one_input_document_chain_browser.test.ts` (11 tests) drives the **production server in-process** in real Chromium with a *local* deterministic model and search endpoint (loopback only, no credential). It proves NAgex's own chain, not that a real provider answered. Results: no mode selected → document route; document written in the **request** language even when the screen language differs; stored; listed in Recent; **opened again from a brand-new browser**; another signed-in user sees nothing and cannot fetch it by id; a double click makes one document; a failing, non-JSON or empty model answer is never shown as created and stores nothing; a store that cannot save makes creation fail with no artifact; research → report asks research first and the report carries **only** the returned findings and links, and with the search provider down **no report is written** and the person is told which step stopped.

Real model, real stores (separate from the above): `scripts/document-roundtrip-live-cert.mjs` on the final SHA, private temp stores — KO create 45.0 s, EN create 15.8 s, both by Nemotron (`nvidia/Nemotron-3_5-Lightning`, Nebius), saved, in Recent, reopened after a "restart", stranger refused → `REAL_DOCUMENT_ROUNDTRIP=PASS`.

Not run: a document created through the **deployed** service, and research with a **real** search provider (no verified search credential on the host).

## 5. TASK C — one benign approval-gated demo action: **hosted live gate BLOCKED**

Read-only inventory of the tool registry, the capability registry and the broker, in the directive's order:

1. **Owned in-app approval-gated capability — none is executable.** `workspace.prepare_draft` is registered (approval required) but is "routed through workspace services directly", has no broker executor, and Home correctly classes it `TOOL_NOT_SUPPORTED_FROM_HOME` (a plan preview only, never a Run button). Home-runnable approval-gated tools are exactly the Calendar/Gmail writes and user-registered `mcp.<connection>.<tool>` tools.
2. **Browser tools** — read-only, no approval, runtime disconnected on the host; `browser.click` is the only conditional one. Not an approval-gated demo.
3. **Public HTTPS MCP echo/note** — the only honest option; it requires the operator to register a harmless public HTTPS MCP server in the signed-in Connections screen. I did **not** register or suggest-as-connected any remote service. Google Calendar / Gmail / Slack stay disallowed (no Google credentials on the host).

Outcome: `REAL_APPROVE_EXECUTE_HOSTED` = **NOT_RUN / BLOCKED**. Code/integration certification instead: the full approve → execute chain against an **isolated local MCP test server** (`scripts/mcp-test-server.mjs`) — 15 e2e + 13 security tests, including the destination actually receiving exactly one call after Approve and none before. No approval requirement was weakened to manufacture a demo PASS.

Observation worth a decision (not changed): there is no in-app, zero-external-risk, approval-gated capability a viewer can watch succeed. Making `workspace.prepare_draft` (save a draft to my own library after approval) real would give the video a deployable "Remember → Create → Approve → Act" beat without any third party — see §11.

## 6. TASK D — One Input: intent quality and end-user outcomes

* **Dataset** (`tests/one_input_intent_dataset.test.ts`): 81 realistic KO/EN phrasings across A advice, B schedule, C research, D document, E slides, F image, G unsupported, H research→document/slides, I explain+send, J delete, K "보내지 말고 초안만", L vague, M connected tool named naturally, Q plain questions: **81/81**. Two misses found first (a Korean reminder, "Draw a mountain…") and fixed. Action, destructive, negated, unsupported and plain-question rows are asserted *exact* — they can never be misrouted. Independent stress probe of 20 further phrasings: 19/20; the one miss ("Send me a summary of the project status" → approval-gated plan) fails *safe* (asks for approval instead of acting) and is left as a known limitation.
* **Suites on the final SHA:** routing 66/66, dataset 1/1 (81 rows), real-Chromium One Input 42/42 (EN/KO at 1440/430/390/360), document chain 11/11, slides chain 4/4.
* **Compound requests:** research → document ✅ and research → slides ✅ (new: browser-certified KO+EN; the deck request carries only the returned findings/links; search down → no deck planned or stored, the person is told research could not be completed). Research → image: the image is made from the description only — the router no longer claims a research need and the screen says "Images are made from your description…" (KO: "이미지는 설명한 내용으로 만들어요…"). Not a half-done chain presented as complete.
* **Unsupported, truthfully:** video and "build and run an app" → "not available yet", nothing created.
* **Single input, no legacy mode selection:** no Ask/Research/Plan choice is required; the optional `+` shortcut can bias a plain request but cannot override an action or an unsupported kind.
* **Slides need a non-Nemotron provider.** `PRESENTATION_SYNTHESIS` is intentionally outside the Nemotron task set (chat, plan, research, meeting-prep, document are in). Slides therefore need another configured text provider on the host. I did not verify which one the host has, and did not change routing.

## 7. TASK E — UI acceptance (P1)

Covered by the passing real-Chromium suites, EN and KO at 1440 / 430 / 390 / 360: compact composer at rest, no horizontal overflow, 44 px touch targets on phones, the `+` menu is keyboard-usable (open/close/focus), My Day collapsed by default (data stays discoverable and honestly empty when disconnected), Korean `이어서 질문` and `보관함에 저장` are two distinct accessible buttons with room between them (no "Vault에 저장"), Korean requests get Korean output (document, research, plan prompts carry the request language). No UI regression found; no UI change was needed beyond the one-line image note.

## 8. Voice WIP merge conflicts (recorded, **not** merged)

The uncommitted Voice WIP in the main checkout (8 files, 1110 diff lines on top of `b5856fe`, an ancestor of this branch) was checked read-only with `git apply --check --cached` against this branch. **7 of 8 apply cleanly** (`ADR-0013`, the UX canonical doc, `desktop-quickwake.js`, `main-surface-rearchitecture.css`, `renderer-voice-adapter.js`, `main_surface_hard_rebuild_browser.test.ts`, `voice_architecture_boundaries.test.ts`). **`public/main-surface.js` does not apply** (first failing hunk near line 100, the composer markup that One Input rewrote). A clean text apply of the other 7 is not a proof of semantic compatibility: the voice composer buttons must be re-fitted into the compact composer and the browser suite re-run. Resolution is deferred to a deliberate merge session.

## 9. Live model and timeout policy (real Nebius / Nemotron, final SHA, temp clone on the host, service untouched)

All three opt-in live certs ran from an isolated clone at `88e94b1` (removed afterwards); credentials were read by name from the running process into the cert process only and never printed.

| Cert | Result | Nemotron-first / answered by Nemotron / fallbacks |
|---|---|---|
| `one-input-live-cert` (13 KO/EN requests) | `REAL_ONE_INPUT=PASS`, routing 13/13, Korean answered in Korean 8/8, English in English 5/5 | 13/13 / **13/13** / 0 |
| `home-plan-live-cert` (5 plan requests) | `REAL_HOME_PLAN=PASS`: tool named exactly 5/5, given value kept 3/3, judged runnable 3/3, **invented value 0/2**, offered-for-approval with a missing argument 0/2 | all Nemotron, 0 fallbacks |
| `document-roundtrip-live-cert` | `REAL_DOCUMENT_ROUNDTRIP=PASS` (see §4) | Nemotron |

Latency (Nemotron, this run): plain answers 2.5–5.1 s; advice 5.7–15.4 s; action plans 14.7–41.3 s (one request needed 2 tries) and **25.6–57.4 s** in the home-plan cert (10 plan calls: median ≈ 29 s, max 57.4 s); documents KO 45 s / EN 16 s. The default bound is 60 s, so the slowest plan finished 2.6 s under the cut-off. **`NAGEX_NEBIUS_TIMEOUT_MS` was not changed and must not be raised blindly**: a single timeout puts Nemotron in a 60 s degraded cool-down during which requests go to the next provider *by design* (this is how 7/13 and 6/13 happened on 2026-10-14 before the cert waited out the cool-down). Changing it is a server-env change that needs your approval; compare it with the UI timeouts (creation calls allow 120–180 s) and cost first. For the video, a truthful cut over a real call is acceptable; latency and model trace must not be edited.

## 10. Not executed / not claimed

* Anything on the **deployed** service: One Input, reviewed-plan approve → execute, hosted document creation (needs deployment, a real login and, for execution, a registered harmless tool).
* Research with a real web-search provider, slides with a real model, image generation: no verified credentials on the host in this session; covered only by the local-fake chain tests (which prove NAgex's chain, not a provider).
* Real Google Calendar / Gmail / Slack (disallowed, no credentials).
* `NAGEX_NEBIUS_TIMEOUT_MS` change, any `/var/lib/nagex` write, any restart, any main merge.

## 11. Remaining P0 / open defects

* **No open reproducible P0 in code.** The two P0s found tonight are fixed and tested.
* **Open product gaps (not defects in what exists):** (a) hosted approve → execute is unproven until deployment + one registered harmless MCP tool; (b) no zero-risk in-app approval-gated capability exists (`workspace.prepare_draft` is not executable) — recommended next build item if the video should not depend on an external tool; (c) Nemotron plan latency (25–57 s) is within 3 s of the 60 s bound; (d) slides depend on a non-Nemotron text provider being configured; (e) Voice WIP conflicts in `public/main-surface.js` (§8); (f) "Send me …" phrasing is over-cautious (fails safe).
* The cert process printed `google_oauth_persistence_disabled` (it does not inherit `NAGEX_TOKEN_ENCRYPTION_KEY` by design — only provider variables are loaded). This says nothing about the live service; confirm in the service's own logs if Google connections matter for the demo.

## 12. Deployability

**The branch is deployable after your approval**: build, 2959-test regression and 294-test browser certification are all green on the exact source, three real-model certs pass, and the change set is additive (no new route, no dependency change — `package.json` untouched). **It is not deployed** and nothing in this report was verified on the deployed service. Deployment is yours to authorise (sudo restart).

## 13. 25 Oct demo readiness (rubric stated, so you can disagree with it)

Ten demo beats, scored 1 = verified at the level a viewer would see, 0.5 = chain verified but not with real providers / not on the host, 0 = not available there:

| # | Beat | Branch (code + local + live model) | Host today (`bcd7e10`) |
|---|---|---|---|
| 1 | One Input, KO/EN free text | 1 | 0 (not deployed) |
| 2 | Nemotron answer / advice / plan, live | 1 | 1 |
| 3 | Document create → save → reopen | 1 | 0 (never exercised there) |
| 4 | Research with sources | 0.5 | 0 |
| 5 | Research → report / slides | 0.5 | 0 |
| 6 | Slides | 0.5 | 0 |
| 7 | Image | 0.5 | 0.5 |
| 8 | Plan → Human Approval gate | 1 | 0.5 (preview only) |
| 9 | Approved real execution of a harmless tool | 0.5 | 0 |
| 10 | Truthful unsupported / failure states | 1 | 0 |
| | **Total** | **7.5 / 10 ≈ 75 %** | **2 / 10 ≈ 20 %** |

Deployment alone moves the host toward the branch column; the remaining ~25 % is operator configuration (search / slide / image providers, one harmless MCP tool) and a hosted dry run, not new code.

---

## 14. 아침 경영진 요약 (Korean executive handoff)

### (1) 오늘 밤 바뀐 것
* **승인 → 실행 경로 보안 재검토**: 실제로 재현되는 P0 결함 2건을 찾아 고치고 테스트로 고정했어요. ① 승인이 **만료**되면 작업이 영원히 "대기" 상태로 남던 문제 → 이제 `FAILED / APPROVAL_EXPIRED`로 끝나고, 늦은 Approve는 거부돼요. ② 계획 봉인(seal) 점유 테이블이 가득 차면 **살아 있는 점유를 잊어** 같은 계획이 두 번 실행될 수 있던 문제 → 이제 가득 차면 실행을 **거부**(fail-closed)해요. 재시작·만료·재생·타인 계정·동시 클릭은 모두 통과했고, 승인 전에는 어떤 외부 호출도 일어나지 않아요.
* **한국어·영어 한 입력창**: 현실적인 81개 문장(조언·일정·리서치·문서·슬라이드·이미지·삭제·"보내지 말고 초안만"·모호한 요청·연결 도구)을 모두 맞게 분류해요. 위험한 분류(실행·삭제·부정·미지원·일반 질문)는 절대 틀리지 않도록 테스트에 고정했어요.
* **문서 생성→저장→다시 열기**: 한국어/영어 요청 언어로 문서를 만들고, 최근 항목에 보이고, 새 브라우저에서 다시 열려요. 다른 사용자는 볼 수 없어요. 저장 실패·모델 실패는 "완료"로 보이지 않아요. 실제 Nemotron으로도 문서 왕복 PASS(한국어 45초, 영어 16초).
* **복합 요청**: 조사→보고서, **조사→슬라이드**(오늘 새로 브라우저 인증)는 출처가 있을 때만 만들고, 출처가 없으면 만들지 않고 어느 단계가 멈췄는지 알려줘요. 조사→이미지는 조사 단계를 실행하지 않으므로 화면에서 그렇게 **솔직히** 알려줘요.
* 자정 직후에만 깨지던 "최근 항목" 테스트의 시계 가정을 바로잡았어요(제품 결함 아님).

### (2) 10월 25일 시연 준비율
* **브랜치 기준 약 75 %** (코드·로컬·실제 모델 인증 포함), **현재 호스팅 서버 기준 약 20 %** (새 입력창이 아직 배포되지 않았기 때문). 산정 기준표는 §13. 배포하면 호스팅 쪽이 브랜치 쪽으로 올라가고, 남는 약 25 %는 새 코드가 아니라 **운영 설정과 호스팅 리허설**이에요.
* 테스트: 빌드 PASS · 회귀 2959건(실패 0) · 브라우저 인증 294건(실패 0) · 실제 Nemotron 인증 3종 PASS(전부 Nemotron 직접 응답, 폴백 0).

### (3) 심각한 막힘 / 위험
* **호스팅에서 "승인 → 실제 실행"은 NOT_RUN(BLOCKED)**: 아직 배포되지 않았고, 서버에 무해한 승인형 도구가 없어요(Google 자격 증명 없음, 앱 내부에 실행 가능한 승인형 기능 없음). 실행 코드 자체는 로컬 격리 MCP 서버로 인증했어요.
* **호스팅 문서 생성은 NOT_RUN**: 실제 로그인 세션이 필요해서(승인 없이 불가) 서버에서는 한 번도 만들어 보지 않았어요.
* **Nemotron 지연**: 행동 계획이 25~57초로, 기본 60초 한도에 가까워요. 한도를 막연히 90초로 올리지 마세요(서버 환경 변경이라 승인 필요). 영상은 실제 호출을 **편집으로 자르는 방식**이 안전해요.
* **음성(Voice WIP) 병합 충돌**: 8개 파일 중 `public/main-surface.js` 1개가 충돌(작성창 마크업). 병합하지 않고 기록만 했어요.
* 슬라이드는 Nemotron 대상 작업이 아니라서 **다른 텍스트 공급자**가 서버에 설정돼 있어야 해요(확인하지 못했어요).

### (4) 운영자 조치 (1~3개)
1. **배포 여부 결정과 실행** — 승인해 주시면 아래 §15 명령으로 같은 방식(릴리스 디렉터리 교체)으로 배포하고, `sudo systemctl stop/start nagex`는 운영자가 직접 실행해요.
2. **시연용 무해한 도구 1개 등록** — 배포 후 로그인한 화면의 연결(Connections)에서 공개 HTTPS MCP echo/note 서버 1개를 직접 등록하세요(제가 임의로 원격 서비스를 등록하지 않아요). 이게 없으면 호스팅 "승인→실행" 장면은 BLOCKED로 남아요. 대안: 앱 내부 승인형 기능(`workspace.prepare_draft` 실제 구현)을 다음 작업으로 승인.
3. **Nemotron 타임아웃과 공급자 확인** — `NAGEX_NEBIUS_TIMEOUT_MS`를 그대로 둘지(영상은 편집) 올릴지 결정하고, 검색·슬라이드·이미지 공급자가 서버에 설정돼 있는지 확인해 주세요.

### (5) 나중에 승인받아 배포할 때의 명령 (복사해서 사용)

> 아래는 **승인 후에만** 실행하세요. 지금까지 서버는 건드리지 않았어요. 현재 배포본은 `bcd7e10`, 롤백 대상도 `bcd7e10`이에요. `<TESTED_SHA>`는 PR에서 병합·확정한 정확한 커밋으로 바꾸세요(이 브랜치의 검증된 소스 커밋: `88e94b19006ec802cf3d303bab7690a0dd2a87af`).

```bash
# ── A. 사전 점검 (읽기 전용, 서버에서 redcloud 로) ──────────────────────────────
systemctl show nagex -p MainPID -p ActiveEnterTimestamp --value
cd /home/redcloud/services/nagex/source && git rev-parse --short HEAD        # 기대값: bcd7e10 (롤백 대상)
df -h /home | tail -1

# ── B. 새 릴리스를 옆 디렉터리에 빌드 (서비스는 계속 실행 중, 아무것도 바뀌지 않음) ──
export PATH=/home/redcloud/.nvm/versions/node/v24.19.0/bin:$PATH
cd /home/redcloud/services/nagex
git clone git@github-nagex:redcloudyun-cmyk/nagex.git source-new
cd source-new && git checkout <TESTED_SHA> && git rev-parse HEAD              # 정확한 SHA 확인
cp -a ../source/node_modules node_modules                                     # package.json 변경 없음 → 의존성 동일
npx tsc && ls dist/src/server_web.js                                          # 빌드 성공 확인

# ── C. 중지 → 데이터 백업 → 교체 → 시작 (sudo 는 운영자) ───────────────────────
sudo systemctl stop nagex
tar czf /home/redcloud/nagex-backups/nagex-data-$(date +%Y%m%d-%H%M%S)-pre-<TESTED_SHA short>.tgz -C /var/lib nagex
cd /home/redcloud/nagex-backups && sha256sum nagex-data-*-pre-<TESTED_SHA short>.tgz > nagex-data-pre-<TESTED_SHA short>.sha256
cd /home/redcloud/services/nagex && mv source source-bcd7e10 && mv source-new source
sudo systemctl start nagex

# ── D. 검증 (읽기 전용) ─────────────────────────────────────────────────────────
systemctl is-active nagex && systemctl show nagex -p MainPID -p ActiveEnterTimestamp --value
curl -fsS https://nagex-test.agex.site/api/v1/health | head -c 300; echo
journalctl -u nagex -n 40 --no-pager | grep -i -E "error|fatal|listening" | head

# ── E. 롤백 (D 에서 문제가 있을 때만) ───────────────────────────────────────────
sudo systemctl stop nagex
cd /home/redcloud/services/nagex && mv source source-failed && mv source-bcd7e10 source
sudo systemctl start nagex
# 데이터가 새 버전에 의해 호환되지 않게 바뀐 경우에만, 위 pre- 백업(sha256 확인 후)으로 /var/lib/nagex 복원:
#   (서비스가 중지된 상태에서)  sha256sum -c <sha256 파일>  &&  mv /var/lib/nagex /var/lib/nagex.failed-$(date +%s)  &&  tar xzf <백업.tgz> -C /var/lib
```

배포 직후 권장 순서: 로그인된 화면에서 ① 한국어 조언 요청 1건 ② 문서 생성→최근 항목→다시 열기 ③ (도구 등록 후) 승인 요청 → **Approve** → 실행 결과 확인. 실행하지 않은 항목은 PASS로 적지 마세요.

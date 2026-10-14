# NAgex D-11 — One Input, Intent to Outcome: certification report

**Date:** 2026-10-14 (KST) · **Directive:** `NAGEX_D11_ONE_INPUT_INTENT_EXECUTION_DIRECTIVE_20261014.md` · **ADR:** `docs/adr/ADR-0014-one-input-intent-routing.md`
**Branch:** `d11/one-input-intent-20261014` (pushed) · **Labels:** PASS / FAIL / BLOCKED / NOT_RUN · No secret, prompt answer, cookie or token appears in this report.

## 1. Result table

| Field | Result | Evidence |
|---|---|---|
| `BASE_SHA` | `83ebb68` (tip of `d11/advisory-plan-20261014` incl. the directive); the deployed test-server build is `bcd7e10` | `git merge-base` |
| `FINAL_SHA` | **`21f90ca`** (last code commit; this report is a docs-only commit on top of it) | `git log` |
| `ROUTING_CONTRACT` | **PASS** | `RoutingDecision` v1 on `POST /api/v1/workspace/route-input` (legacy fields unchanged); 61 routing tests incl. 48 table rows and the real HTTP route |
| `KO_EN_INTENTS` | **PASS** | scenarios A–L, Korean + English, 48 table rows (unit + HTTP) and 25 real-Chromium rows; live Nemotron: 13/13 routed as expected |
| `COMPOUND` | **PASS (bounded)** — research → document is a real two-call compound; see §4 for what is *not* certified | browser tests ko/en + truthful stop |
| `UNSUPPORTED_TRUTHFUL` | **PASS** | video and "build / run an app" → "not available", nothing created, no chat answer posing as the deliverable; a shortcut cannot override it |
| `NO_AUTO_EXECUTION` | **PASS** | every browser row asserts 0 consequential POSTs (task / approval / execution / send); `route-input` creates nothing (HTTP test) |
| `APPROVAL_BOUNDARY` | **PASS for the boundary; NOT_RUN for approve → execute from Home** | an action is only an approval-gated plan; Human Approval code is unchanged; see §5 |
| `MODEL_ROUTE` | **PASS** (real Nebius / Nemotron, 13 requests) | Nemotron chosen first 13/13, answered directly 12/13, 1 TIMEOUT fallback with a recorded reason, invariants broken 0 — see §6 |
| `REGRESSION` | **PASS** | `npm run build` 0; `npm test` **2,915 / 2,907 pass / 0 fail / 8 skip** (baseline 2,854 / 2,846) |
| `BROWSER_CERT` | **PASS** | `npm run test:browser-cert` **269 / 263 pass / 0 fail / 6 skip** (baseline 227 / 221); EN + KR, 1440 / 430 / 390 / 360 |
| `DEPLOYMENT` | **NOT_DEPLOYED (by instruction)** | the test server still runs `bcd7e10` (PID 2997023, since 16:44:54, 0 restarts, health 200); no restart, no data change, `main` untouched |

## 2. What changed relative to the deployed `bcd7e10`

24 files, +2,100 / −223. Runtime: `src/workspace/input-router.ts` (decision), `src/common/request-language.ts` (new), `src/model-gateway/ai-service.ts` (language line in `plan()` / `chat()` / `research()`), `src/http/routes/{workspace,document-creation,presentation-creation}.routes.ts`, `public/main-surface.js`, `public/main-surface-rearchitecture.css`, `public/i18n.js`. No route was added or removed (route inventory unchanged), no package change.

1. **One server-owned routing decision** (advice about routing only). Kinds: `CONVERSATION | ADVICE | RESEARCH | CREATE_ARTIFACT(DOCUMENT|PRESENTATION|IMAGE) | ACTION_PLAN | CAPTURE | UNSUPPORTED(VIDEO|CODE) | CLARIFY`, with ordered `needs`, `compound`, `ambiguity` (bilingual question), `permissionRisk`, `destructive`, `executionNegated`, `reasonCodes`.
2. **Main routes by words, not by a chosen mode.** The Ask / Research / Document / Plan chips are gone from the top level; Research / Document / Image / Slides remain as an optional "+" menu (Video and Code listed, disabled, with a reason; "What NAgex can do" answers immediately). A shortcut applies to one request and clears itself.
3. **Compact B+C composer.** Desktop 119 px at rest (118 px in KR), grows on focus and with long text; phones keep every control ≥ 44 × 44 px.
4. **My Day is a quiet bar, collapsed by default** (`#main-myday-toggle`, `aria-expanded`), opens on request, closes when a request or a result takes the room; real provider / empty / failure states unchanged.
5. **Korean wording:** `Vault에 저장` → `보관함에 저장` (and the other Korean "Vault" strings; the Vault route and storage are unchanged); `이어서 질문` and `보관함에 저장` are separate buttons ≥ 8 px apart.
6. **Language follows the request:** prompts carry an explicit language instruction (Korean named; otherwise "the language of the request"; JSON keys, enum values and tool ids stay English); document and presentation creation default `locale` to the request language (they used to default to English whatever the person wrote).
7. **Truthfulness fixes found on the way:** a plan-only "Run this plan" is shown as "Plan reviewed — nothing was executed", not "Completed" (finding F1 of `NAGEX_D11_DEPLOYED_E2E_CERT_20261014.md`); research answers list their real sources as links.

## 3. Routing contract and the 12 scenarios (all PASS)

| Scenario | Korean | English | Decision |
|---|---|---|---|
| A advice | `내일 회의를 어떻게 준비하면 좋을까?` | `How should I prepare for tomorrow's meeting?` | `ADVICE` → plan route, advisory contract (`executable:false`, no plan) |
| B action | `내일 오전 10시에 프로젝트 리뷰 회의를 잡아줘` | `Schedule a project review meeting tomorrow at 10 AM` | `ACTION_PLAN`, `EXTERNAL_CONSEQUENTIAL`, approval required |
| C research | `최근 AI 동향을 조사해서 출처와 함께 알려줘` | `Research the latest AI trends and cite sources` | `RESEARCH` → research route; sources shown as links |
| D document | `이번 회의 내용을 한 페이지 보고서로 작성해줘` | `Write a one-page report on this meeting` | `CREATE_ARTIFACT/DOCUMENT` |
| E slides | `로드맵을 10장 슬라이드로 만들어줘` (`이 주제로 …` uses the previous answer, or asks) | `Create a 10 slide deck about our roadmap` | `CREATE_ARTIFACT/PRESENTATION` |
| F image | `일출의 산 풍경 이미지를 만들어줘` (`이런 이미지를 만들어줘` asks what to draw) | `Generate an image of a mountain at sunrise` | `CREATE_ARTIFACT/IMAGE`, honest "unavailable" when no provider |
| G unsupported | `30초 홍보영상 만들어줘`, `웹사이트 코드 작성해서 실행해줘` | `Make a 30 second promo video`, `Build a website and run it` | `UNSUPPORTED` (VIDEO / CODE), `supported:false` |
| H compound | `AI 동향을 조사해서 보고서로 만들어줘` | `Research the AI market and turn it into a report` | `CREATE_ARTIFACT` with needs `[RESEARCH, DOCUMENT]` |
| I mixed | `설명해줘 그리고 이메일로 보내줘` | `Explain it and then email it to Alex` | `ACTION_PLAN`, needs `[ANSWER, ACTION]` |
| J destructive | `이 문서를 지워줘` | `Delete this document` | `ACTION_PLAN`, `destructive:true` |
| K negated send | `보내지 말고 이메일 초안만 작성해줘` | `Do not send it, just draft the email` | `CONVERSATION`, `executionNegated:true` |
| L vague | `그거 해줘` | `help` | `CLARIFY` (one question, nothing runs) |

Also covered: plain questions containing an action word stay conversations (`How do I send an email in NAgex?`, `일정은 어떻게 잡나요?`); `Can you send …?` / `메일 좀 보내줄 수 있어?` are actions; a negation covers only its own verb (`보내지 말고 삭제해줘` is still a gated delete plan); a shortcut never overrides an action or an unsupported kind; Korean capture prefixes (`메모:`, `기억해줘`) reuse the existing capture path; uploads, audio and links keep their legacy intents.

## 4. Compound requests — what is and is not certified

- **Certified (PASS):** `research → document` (KO and EN, with the screen language deliberately different from the request language): research runs first, the report is requested **only** from its verified findings and real source links, in the **request** language (`locale` asserted), and when research returns no verified source the report is **not written** and the person is told which step stopped. A plain research answer offers "Create report" as a next step the person confirms.
- **Implemented, not separately certified:** `research → slides` uses the same chain (`createPresentation` with the findings); only the document chain has browser tests.
- **Not supported (said, not faked):** research → image ignores the research step; multi-agent execution, scheduling a chain of external actions, code deployment and video are deferred.

## 5. Approval boundary and "no auto execution"

- Every route the decision can select is an unchanged existing route with its own rights; the decision carries no authority and is advice only (ADR-0014).
- `ACTION_PLAN` is only ever a plan preview: the browser table asserts **no task, approval, execution or send was created** for each of the 25 rows, and for the "send mail" / "delete" / "mixed" rows the plan route was the only path reached.
- The "Run this plan" button was **not changed** to execute. It still creates an `ALWAYS_APPROVE` task that the server runs through the plan-preview runner (the executor only receives `READ_ONLY_AUTO` tasks); it is now labelled truthfully. **Approve → execute from Home therefore remains NOT_RUN / open (F1 root cause)** and needs a product decision.
- No approval was bypassed, auto-granted, relaxed or re-bound; `ALWAYS_APPROVE` and `showPlanBeforeConsequentialActions` are untouched.

## 6. Real model route (live Nebius / Nemotron, no fake fetch)

`scripts/one-input-live-cert.mjs` (opt-in) on the test server, from an isolated clone at `21f90ca` (the live service was **not** touched or restarted; credentials were read by name from the running process into the cert process only and never printed). 13 requests: advice 5, action plans 5, conversation 3.

| Metric | Result |
|---|---|
| Routed as expected | **13 / 13** |
| Nemotron chosen first (`model_routing_decision`) | **13 / 13** |
| Answered by `nvidia/Nemotron-3_5-Lightning`, no fallback | **12 / 13** |
| Fallback | 1 (a Korean action request: Nemotron `TIMEOUT` after the 60 s bound → Gemini), reason recorded 1 / 1 |
| Invariants (advice has no steps; an action plan has ≥ 1) | **0 broken** |
| Language | Korean requests answered in Korean **8 / 8** (Hangul share 88–100 %); English requests answered in English **5 / 5** |
| Latency (Nemotron) | advice 14–30 s, action plans 25–30 s, plain answers 4–5 s |

**Honest notes on this measurement**
- Two earlier runs the same afternoon (same build, before the cert waited out the provider cool-down) gave 7/13 and 6/13 direct answers: one Nemotron timeout puts the provider in its 60 s degraded cool-down, so the next requests skip it **by design** (`PROVIDER_DEGRADED`) and Gemini answers; each was recorded with its reason. The final run waits out the cool-down so each request is a fresh Nemotron-first attempt.
- The Nebius endpoint was slower than in the earlier certification (advisory medians were 9–14 s that morning). A side-by-side of the deployed `bcd7e10` build and this build on the same three Korean / English plan requests gave 10–36 s vs 12–58 s: the spread is dominated by endpoint variance; the added language line may cost some Korean output time but this sample cannot separate the two.
- **Recommendation (not applied; operator config):** set `NAGEX_NEBIUS_TIMEOUT_MS` to about 90000 so a slow-but-successful Korean plan is not cut at 60 s; the UI allows 120 s for plans.
- Not run live: the research provider path with real web evidence, image generation, and document / slides creation with a real model (the server has no image / search credentials verified here); these are covered by stubbed-path browser tests and earlier certifications only.

## 7. Browser certification (real Chromium, production server harness; EN + KR)

| Check | Result |
|---|---|
| 25 request rows (A–L, KO + EN, plus topic-less, question, negated) reach exactly one expected path; 0 consequential requests; no raw keys | PASS |
| Composer at rest, desktop | 119 px (EN) / 118 px (KR) at 1440 — within "about 100–120 px"; grows on focus (≈ 143 px) and with long text (no clipping) |
| Composer, phones 430 / 390 / 360 | 225 px (EN) / 224 px (KR) at rest (two tool rows); smallest control **44 × 44 px**; **no horizontal overflow** |
| "+" menu | keyboard: Enter opens with focus inside, ↑/↓ move, Esc closes and returns focus, outside click closes; stays inside the viewport at all widths; Video / Code disabled with a reason; opens downward on phones (never off-screen) |
| My Day | collapsed by default at every width, `aria-expanded` follows, 44 px target on phones, no overflow when open; collapses when a request or result takes the room |
| Korean buttons | `이어서 질문` / `보관함에 저장` distinct, ≥ 8 px apart at 1440 / 390 / 360, ≥ 44 px on phones; English unchanged (`Ask follow-up`, `Save to Vault`); no `Vault에` anywhere |
| Plan-only run label | "Plan reviewed — Nothing was executed" (never "Completed") |

Existing browser tests whose **contract changed on purpose** were updated (not weakened): briefing visibility (collapsed by default, assertions kept after opening My Day), mode chips → "+" menu items, `[data-main-mode="PLAN"]` clicks removed (the words alone now lead to the plan), Korean `Vault` strings, the composer-height assertion (< 210 px → 100–125 px), `Make a deck` → a request with a topic (a topic-less deck request now asks first). `main_surface_hard_rebuild_browser` (an on-demand test outside the gate) was already failing at `faf38cc` on a stale "Slides is disabled" expectation; it was rewritten for One Input and passes 5/5.

## 8. Known limits and open items (not hidden)

1. **Approve → execute from Home** is still not possible (F1 root cause, §5). Only the false "Completed" was removed.
2. **Deterministic classifier**: bounded rules, fail-safe direction (a miss costs a less fitting *safe* path). Known false positives that land on the plan route (safe, may show "could not prepare a plan"): a leading noun such as `Book recommendations …`, `Post mortem …`, `Share your thoughts …`. Other languages route as plain conversation.
3. **Context for "make slides from this"** is the last answer in the current page session only (not persisted across a reload); with nothing to refer to NAgex asks.
4. A document request such as "a report on this meeting" has no meeting source unless the person supplies one; the model may fill gaps (not addressed here).
5. **Voice WIP** (uncommitted in the main checkout: `public/main-surface.js`, `main-surface-rearchitecture.css`, `desktop-quickwake.js`, …) will conflict with this branch on merge; resolve deliberately, do not auto-merge.
6. **Quick Wake / mobile Home** still use the legacy ASK / COMMAND intent (Korean actions now correctly read as COMMAND there); research / document / slides routing is Main only.
7. **Not deployed** by instruction: the real deployed HTTP / browser run of this build is NOT_RUN. Deploying needs an explicit approval and the operator's `sudo` restart.
8. Provider-latency risk for Korean plans (§6) and the unchanged 60 s Nemotron bound.

## 9. How to reproduce

```text
npm run build && npm test && npm run test:browser-cert
node --require ./dist/tests/_setup.js --test dist/tests/one_input_intent_routing.test.js
node --require ./dist/tests/_setup.js --test dist/tests/one_input_intent_browser.test.js
NAGEX_LIVE_ONE_INPUT=1 NAGEX_CERT_ENV_FROM_PID=<service pid> node scripts/one-input-live-cert.mjs   # real, paid, opt-in
```

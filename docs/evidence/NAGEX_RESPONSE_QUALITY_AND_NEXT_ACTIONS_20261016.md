# Response quality and next actions (TODO) — measured before / after with a real model

**Status:** EVIDENCE (point-in-time)
**Date:** 2026-10-16
**Before:** `integration/product-completion-20261015` at `b1248c6670f50850d9f59c882e95b1d4754ed8ba` (UI before the Enter / trust-notice / 960px work)
**After:** branch `topic/quality-todo-20261016` (on integration `d9813cf8be4a97aa01dda3cfeba5b033ebb20ea5`)
**RELEASE = NO-GO.**

## 0. How it was measured

* The production server runs in-process on isolated data directories; the front end is driven in real Chromium (Korean, 1440×900); the **same prompts, in the same order, were sent to the before and the after build**.
* Model: the **real Gemini API, `gemini-flash-lite-latest`** (the only provider with a credential on this machine). Every request first asks for Nebius (`preferredProvider: nebius`) and falls back with `fallbackReason: NO_PROVIDER_CREDENTIAL` — **no real Nebius / NVIDIA call was made in this run** (no key on the development PC; Nebius is only configured on the test server, which was not touched). Nothing here says anything about Nemotron's output.
* Google Calendar's REST API is a **local fake** (no authorized account): the calendar part proves NAgex's own chain, not a live Google write.
* Quota note: `gemini-flash-latest` answered 503 ("high demand") during the session, so the whole run used flash-lite.

## 1. Findings by cause (code and logs)

| Suspected cause | Verdict | Evidence |
|---|---|---|
| **System prompt** | **Root cause.** The chat prompt was one sentence — "You are NAgex, a personal AI assistant. Be concise and do not claim that tools were executed." — with no description of the product, no duty to answer every part, no list of what NAgex can and cannot do. | Before: "explain NAgex's 5 features" listed generic assistant skills (weather, tutoring, coding help, "file management") as NAgex features; "can NAgex read my Outlook mail?" was answered **"네, 가능합니다"** (Microsoft is sign-in only). |
| Model routing | Not the cause of the content, but a latency / quality fact: chat, plan, document and research tasks prefer Nebius; with no credential they fall back to Gemini (`NO_PROVIDER_CREDENTIAL`) — routing logs show `selectedProvider: gemini`, `fallbackUsed: true`. Slides are not a Nemotron task and always go to Gemini. | `model_routing_decision` / `model_fallback` events in the run logs. |
| Response length limit | **No.** `maxOutputTokens` is not set for Gemini (the OpenAI-compatible adapter uses 8192); every answer ended with `finishReason: STOP`. The brevity came from "Be concise". | `model_request_succeeded … finishReason":"STOP"`. |
| Post-processing | No truncation or rewriting exists. What was missing is a check that a **stated number of items / numbered parts** is really present. | code read of `AiService.chat` / route. |
| Report generation | The report prompt said "do not invent fake facts" but the model still wrote competitor market shares of 18 % / 32 % / 25 % (before). | before s2. |

## 2. Changes

* `src/model-gateway/capability-brief.ts` — what NAgex can really do (12 lines) and cannot (video, running apps, Microsoft mail/calendar/files, anything unapproved); `tests/response_quality.test.ts` checks it against the runtime (router's unsupported kinds, capability registry approvals, the connector catalog).
* `src/model-gateway/request-analysis.ts` — reads the request's shape (numbered parts, an exact item count, SIMPLE / MULTI / COMPLEX), tells the model, and verifies the checkable part (item count, numbers of numbered parts) after the answer; a miss is asked for **once** more (never a loop), the better of the two is kept.
* `AiService.chat` — the new system prompt (duties of an answer + capability brief + shape); report prompt: no invented statistics, shares, prices, names — clearly marked assumptions / placeholders instead.
* Next actions (TODOs): `src/todos/*`, `src/http/routes/todo.routes.ts`, `AiService.proposeFollowUps`, Main UI (see 4). The state of a TODO is **read** from the task engine's runs and the artifact store; nothing is claimed by the screen.
* Router: an English event request with modifiers ("Create a 30 minute quarterly plan review meeting tomorrow at 3 PM") was answered as chat; it is now an action (a document **about** a meeting still is not).
* Korean UI: English tooltips / labels left in the Korean screen (sidebar, header, "Conversation", the approval action labels, the opened-artifact header) now follow the language; a markdown document is rendered as headings / lists / tables instead of one paragraph; the advice footer no longer shows literal underscores.
* Layout: the conversation and the request box share one centred column of at most 960px (separate change, merged earlier).

## 3. RESPONSE_QUALITY_BEFORE_AFTER (real Gemini flash-lite, same prompts)

| # | Prompt | Before | After |
|---|---|---|---|
| 1 | 오늘 날짜가 언제인지 알려주고, NAgex의 주요 기능 5가지를 각각 사용 예시와 함께 설명해줘. | Date correct. 5 "NAgex features": **일정 관리, 정보 검색(날씨…), 문서 작성, 작업 자동화(알림·파일 관리), 학습·코딩 문제 해결** with generic examples ("세차하기 좋은 시간대", "파이썬 중복 제거") — **not NAgex's features; unsupported abilities presented as features**. | Date correct. **5 real NAgex features** (Google 캘린더 with approval and read-back, 문서 작성 + 버전 비교·복원, 출처 기반 리서치 보고서, 메모리 관리, PPTX 제작), each with one NAgex-specific example request. |
| 2 | 다음 분기 사업 계획 보고서를 써줘 (시장 현황, 경쟁사 비교, 위험 요인, 실행 일정, 예산 요약, 표 1개) | Report created; contained **invented figures** ("시장 점유율 18 % / 32 % / 25 %", "예산 40 % / 35 % / 25 %"); shown in the panel as one raw paragraph. | Report created with all 5 sections and a table; **no invented figures** — unknown values are marked "[가정: …]" / "[입력 필요: …]"; rendered as headings, lists and a table. |
| 3 | (after the report) what does NAgex offer next? | Nothing (only "자세히 보기"). | **"다음 할 일"**: one TODO, "이 보고서로 발표자료(PPTX) 만들기" (`제안`, button `이 일 하기`), kind and the exact request shown. |
| 4 | 이번 주 금요일 오후 3시에 30분짜리 "분기 계획 리뷰" 회의 일정을 만들어줘 | Plan preview → approval → approved → created and **read back** ("완료 - 캘린더에서 확인했어요"). Approval card showed **"Create Google Calendar event"** in English. | Unchanged chain; the approval card shows **"Google 캘린더 일정 만들기"**. |
| 5a | 30초짜리 제품 홍보 영상을 만들어서 유튜브에 올려줘 | Honest "영상 만들기는 아직 지원하지 않아요". | Same (deterministic router). |
| 5b | NAgex가 내 Outlook 메일을 읽어서 중요한 메일만 요약해줄 수 있어? | **"네, 가능합니다. Outlook 메일을 확인하여…"** — false. | **"아니요, Microsoft 메일, 캘린더, OneDrive 및 Teams는 연동되어 있지 않아 Outlook 메일을 읽어오는 기능은 사용할 수 없습니다. 대신 Google 계정을 연결하시면 Gmail 검색 및 읽기 기능을 …"** |
| 6 | 세 가지를 모두 해줘 1) 날짜·요일 2) 좋은 회의의 조건 3가지 3) 영어 한 문장 요약 | All three parts present (this model handled it), unlabelled. | All three parts present; numbering is now requested and checked, with one bounded retry if a number is missing (not needed in this run). |
| 7 | 한국의 수도는 어디야? | "한국의 수도는 서울입니다." | Same, one sentence; **no TODO list** (and no follow-up model call). |

Honest reading: item 6 and 7 were already fine on this model; the measurable gains are 1, 2, 3, 5b and the Korean labels. The retry for a missed count/number was **not triggered** in the real run, so its value is shown only by the scripted tests (`response_quality`).

## 4. TODO_FUNCTIONAL_E2E

What was exercised, and with what:

| Journey | Model | Google | Result |
|---|---|---|---|
| Report → deck TODO shown under the report → press → deck created from **that** report's content → TODO `COMPLETED` (`CREATED`) | **real Gemini flash-lite** (offer is deterministic, no model; the deck is the real model's) | — | PASS (5.8 s; artifact linked; the stored TODO read back `COMPLETED`) |
| Plain question → no list, no follow-up model call | real | — | PASS |
| Request for next steps → real follow-up proposals: 1 executable (calendar) + 2 recommendations (direct call) / in the UI: advice + recommendations | real | — | PASS for the proposer; **in the UI run the real model proposed no executable TODO twice** (it treated the meeting as already scheduled) — so the real-model → approval → run chain was **not** reproduced live. Honest status: PARTIAL |
| Next steps → calendar TODO → plan preview (nothing on the calendar) → the person's request-approval → `APPROVAL_REQUIRED` → approve → one event created → read-back → `COMPLETED (VERIFIED)`; the unchosen TODO never runs; decline → `FAILED (DECLINED)`, nothing created, retry offered; KO and EN; 360/390/430px | **local deterministic stand-in** | **local fake** | PASS (`todo_next_actions_browser`, 10 tests) — **a simulated-provider pass, not a live completion** |
| Real-model chain, deck TODO with a model-proposed prompt ("…발표 자료와 성과 지표를 점검하고 … 문서로 정리해 줘") | real | — | the TODO's prompt routed to a presentation (the title said "문서 작성"); the model then failed to plan the deck (`ALL_MODEL_PROVIDERS_FAILED`); the TODO ended `FAILED (REQUEST_FAILED)` — truthful. This is why each TODO now shows **the kind of path and the exact request** before it is pressed. |

Rules that hold (unit-tested): only a request the router would send to creation, research or the plan→approval engine is a TODO; advice, anything NAgex cannot do, a request that needs more from the person and a negated one are recommendations **without a button**; a client can never declare success (a result is linked only if it is the owner's and newer than the start; "completed" comes from the artifact or the task run: a reviewed plan is not done, a calendar change is done only when read back, `NOT_CONFIRMED` / `MISMATCH` are failures); another person's TODO is "not found"; an abandoned prepared plan is offered again after 30 minutes.

## 5. UI_BEFORE_AFTER

Screenshots (local, not committed): `scratchpad/quality/out/before_s2_report.png` / `after4_s3_after_report.png` (report), `before_s4_calendar_approval.png`, `after4_s4_todo_list.png`.

* Before: answer and "Suggested next moves" as plain bullets; no executable follow-up; the conversation and the request box up to 1120px wide; the approval card and the result header partly in English on the Korean screen.
* After: conversation and box share one centred column ≤ 960px; the answer is plain text, **Next actions** is a separate card (accent bar, state badge — Suggested / Needs your approval / In progress / Done / Did not work —, the kind of path, the exact request, a note about what really happened, a button only where pressing can do something), advice for the person is a separate muted list without buttons, approvals keep their own card, results stay in the right panel; the AI trust notice sits under the box; phones 360/390/430px verified (no overflow, 40px touch target).

## 6. Open items

* Real Nebius / Nemotron quality was not measured (no key here). The same prompts should be run on the test server's Nebius route.
* Real-model proposals for next steps are nondeterministic: whether a calendar TODO appears depends on the model reading the request as "schedule this".
* A deck planned from a long, mixed request failed once on the real model (`ALL_MODEL_PROVIDERS_FAILED`): presentation planning is less robust than document writing.

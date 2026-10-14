# NAgex D-11 — Deployed end-to-end certification (test server, `bcd7e10`)

**Date:** 2026-10-14 (KST) · **Server:** `nagex.service` running `bcd7e10` (PID 2997023, started 16:44:54 KST), frontend `c9458e230be0` · **Previous build (rollback target):** `faf38cc`, kept at `~/services/nagex/source-faf38cc`
**Method:** a human operator signed in through Google/Microsoft and made the requests in the browser. The agent only **observed** (read-only): server journal + stored records, via `observe_e2e.cjs`; and read code. No account, session, cookie or token was created, requested or recorded. The agent did not press any button, run any task, or change any server, code or data.
**Labels:** PASS / FAIL / BLOCKED / NOT_VERIFIED (cannot be proven from server-side records) / NOT_RUN.
**What this document never contains:** prompt text, answer text, session or token values.

## 1. Test requests (the two Plan-mode requests are the certification subjects)

| # | Subject | Request ID | Route / task kind | Server time (UTC) |
|---|---|---|---|---|
| A | Advice request, Plan mode | `req_intent_1666af0f-2977-4d6d-8c75-9429aae3d2ed` | `/api/v1/ambient/intent`, `PLAN` | 2026-10-14 09:25:39 |
| B | Action request, Plan mode | `req_intent_11e67366-2b58-4414-b14b-24f88620a3c1` | `/api/v1/ambient/intent`, `PLAN` | 2026-10-14 09:25:53 |

The operator also made six earlier **Ask-mode** turns (`/api/v1/ai/chat`, task kind `CHAT`) between 07:58 and 09:24 UTC. They are listed in §5 as supplementary observations; they are **not** evidence for the plan/advisory contract.

## 2. Result table

| Check | Request A (advice) | Request B (action) |
|---|---|---|
| Provider that answered | **PASS** — `nebius` (selected = answered) | **PASS** — `nebius` |
| Model | **PASS** — `nvidia/Nemotron-3_5-Lightning` | **PASS** — `nvidia/Nemotron-3_5-Lightning` |
| Fallback (`model_fallback`, `fallbackUsed`) | **PASS** — none | **PASS** — none |
| Validation retry (`model_validation_retry`) | **PASS** — 0 (1 attempt) | **PASS** — 0 (1 attempt) |
| Failed provider calls | none | none |
| Latency | 9,049 ms | 13,928 ms |
| Request classified from the person's own words | **PASS** — `ADVISORY` | **PASS** — `ACTION` |
| Contract status `ADVISORY_RESPONSE` / `executable:false` in a server record | **NOT_VERIFIED** (see §3) | n/a |
| Screen result reported by the operator | Advice with 5 suggestions and the footer "no actions were taken, advice only"; **no plan, no Run button** | "Plan ready", one step (confirm the missing meeting time/attendees), "Run this plan" shown; **not pressed** |
| New plan / approval / execution / task / task-run records | **PASS** — 0 / 0 / 0 / 0 / 0 | **PASS** — 0 / 0 / 0 / 0 / 0 (before any approval, as required) |

Overall for the two requests: Nemotron-first **PASS** (both answered directly by Nemotron, no fallback, no retry); advice never created an executable object **PASS**; no execution before approval **PASS**. The approve → execute path was **NOT_RUN** (see §4).

Records read to prove "0 new records": `plans`, `approvals`, `executions`, `activity`, `tasks`, `task-runs`, `durable-task-runs` under `/var/lib/nagex`, each filtered by modification time ≥ server start (16:44:50 KST). The only touched records since start are the two demo-seed approvals (§6) and two daily-brief activity entries (§5).

## 3. Why the advisory contract is NOT_VERIFIED server-side, and what indirect evidence exists

- The audit log (`AuditLogger`) is held **in memory only** and is not written to the journal or to disk; the router journal lines carry `taskKind`, provider, model, fallback and latency — no response shape. So `status: ADVISORY_RESPONSE` and `executable:false` cannot be read from any server record. This is an observability gap, not a defect in the response.
- Indirect evidence (not a substitute for a recorded response): (a) the stored assistant message for A has the advisory storage shape (summary + `- suggestion` lines), the shape `conversation.routes.ts` writes only for an advisory result; (b) `public/main-surface.js` (`runPlan`) draws the advice card with the footer "No actions were taken. This is advice only." **only** when the response has `status === 'ADVISORY_RESPONSE'`, `executable === false`, no `plan`, and `advice.summary` as a string — the operator saw exactly that footer (in Korean) and no Run button; (c) no plan/approval/execution record exists.
- To close it with a direct record, the operator can copy the `status` and `executable` fields (only those) from the Network response of request A. Cookies and headers must not be copied.

## 4. Audit: what the "Run this plan" button does (code read only; nothing was pressed or executed)

Path: `public/main-surface.js` `startPlanRun` → `POST /api/v1/tasks` with `{type: ONE_TIME, trigger: MANUAL, approvalPolicy: 'ALWAYS_APPROVE', objective: <the original request text>}` → `POST /api/v1/tasks/:id/run` → `TaskScheduler.runOne` → `CompositeTaskRunner`.

1. `CompositeTaskRunner` sends **only** `READ_ONLY_AUTO` tasks to `ExecutingTaskRunner` (the one that resolves capabilities, creates approvals and executes). Every `ALWAYS_APPROVE` task — which is what the button creates — goes to `PlanPreviewTaskRunner` (`src/tasks/runners/composite.runner.ts`).
2. `PlanPreviewTaskRunner` makes **another** `PLAN` model call from the objective text (not the plan shown on screen; the advisory allowance is not passed), resolves it, and returns `status: SUCCEEDED` with `result.kind: 'PLAN_PREVIEW'` and the note "Automatic tool execution is not yet implemented for scheduled tasks — this run produced a reviewable plan only." It never calls the capability broker (`src/tasks/runners/plan-preview.runner.ts`).
3. Consequences on this server: pressing Run (a) creates a persistent ONE_TIME task; (b) spends one more Nemotron call; (c) **creates no approval and executes nothing** — so whether Google Calendar is connected is irrelevant, because the broker is never reached (Calendar/Gmail credentials are absent on this server anyway); (d) the run block then shows state **"Completed"** and the note **"The plan finished."** with zero steps (`renderRun`: `SUCCEEDED` → "Completed", empty `steps` → none).
4. **Finding F1 (truthfulness, MASTER §7 — "no fake success"):** "Completed / The plan finished." for a run that only regenerated a plan and did nothing misrepresents the state. The browser test `D3` that covers this button mocks `/tasks/:id/run` to return `WAITING_APPROVAL`/`STEP_EXECUTION`, so the real server behaviour above is not covered by any test. This is **pre-existing** (`startPlanRun` and the runner routing are both in the previous build `faf38cc`); it is not caused by the Nemotron-first or advisory changes and it was **not triggered** by this certification (0 tasks, 0 runs created).
5. Because of 1–3 the "approve → execute" path could not be demonstrated from Home on this server: the button cannot reach an approval. **HUMAN_APPROVAL end-to-end: NOT_RUN** (blocked by F1's routing, not by a security failure). What *was* demonstrated: before any approval, no approval/execution/run record existed (§2).
6. The surfaced conflict (not silently reconciled): the UI comment says the run "goes through the same approval-gated executor", test D3 expects `WAITING_APPROVAL`, but the server only routes READ_ONLY_AUTO tasks to the executor, and the UI deliberately never relaxes `ALWAYS_APPROVE`. A product decision is needed on which side changes (route Home runs to an approval-gated executor, or make the UI report a plan-only run truthfully). No change was made.

## 5. Supplementary observations

| Item | Observation |
|---|---|
| Six earlier Ask-mode turns (`req_chat_380b9ea0…`, `req_chat_2b3b7e6a…`, `req_chat_2234e7ae…`, `req_chat_cf4cee30…`, `req_chat_5e101c19…`, `req_chat_80b8921c…`) | all `CHAT` → `nebius` / `nvidia/Nemotron-3_5-Lightning`; 0 fallbacks, 0 retries; latency 3,977–7,142 ms. Ask mode is a conversation reply, not the plan route. |
| Daily brief `req_brief_df1ab763…` (07:57:52Z, on first sign-in) | `DAILY_BRIEF` → `gemini` / `gemini-3.7-flash`. Background, not a user request; not part of the Nemotron-first scope. Recorded so a demo does not show Gemini unexpectedly. |
| Background model calls | none besides the daily brief; 0 task runs; the 30 fixture tasks are `PAUSED`; task-runs stayed at 4,385. On the previous build, 42 background calls had been made between 09:00 KST and the stop. |
| Errors in journal | none |

## 6. Demo-seed approvals (classified apart; not test evidence)

`apr_6451f211681074fb` (GMAIL_REPLY, `usr_demo_alex`, created at the previous boot, now `EXPIRED`) and `apr_fc13e80e64980476` (GMAIL_REPLY, `usr_demo_alex`, created at this boot, `PENDING`). They are written by the startup demo seed (also at the previous boot), have no execution, and belong to a different principal than the operator's session. They were excluded from every count above.

## 7. Korean request answered in English — where the cause is

Measured on the stored assistant messages (what the model returned, before any screen translation); Hangul share of letters:

| Route | Turn | Hangul share of the stored answer |
|---|---|---|
| Plan (A) | advice | **0 %** |
| Plan (B) | action summary | **0 %** |
| Ask | 3 advice-type turns | 82 %, 86 %, 92 % |
| Ask | 3 action-type turns | 0 %, 0 %, 100 % |

Conclusion by layer:

1. **Prompt language instruction — the cause.** `AiService.plan()` (`src/model-gateway/ai-service.ts`) has an all-English system prompt with an English JSON template and **no instruction about the response language**, and it takes no locale input; the `/api/v1/ambient/intent` route passes none. `AiService.chat()` likewise has no language instruction. Only the artifact Q&A function has one (`input.locale === 'ko' ? 'Answer in Korean.' …`). The same is true of the previous build (0 language/locale mentions in `plan()` at `faf38cc`).
2. **Model response — the proximate behaviour.** Without a directive Nemotron mirrors the English instructions in the JSON route (0 % Hangul, both requests), and is inconsistent in free chat (4 of 6 Ask turns Korean, 2 of 6 English, no pattern the code explains).
3. **Screen translation — not the cause.** Static UI strings are translated (the advice footer appeared in Korean) while model-generated text is shown as returned; the stored text is already English.
4. The account locale exists (`profile.locale`, `en` | `ko`, `account.routes.ts`) and is not read by the plan or chat routes.

Recommended change (not made): carry the request/account locale into `plan()` and `chat()` and add one instruction line ("Write every user-visible field in the user's language, Korean when the request is Korean"); keep JSON keys, tool IDs and enum values in English; add a Hangul-share assertion to the live certification scripts.

## 8. Findings summary

| ID | Severity | Finding | Status |
|---|---|---|---|
| F1 | high (truthfulness) | "Run this plan" for an `ALWAYS_APPROVE` task regenerates a plan, executes nothing, creates no approval, yet the UI shows "Completed / The plan finished."; not covered by a non-mocked test; pre-existing | open — product decision needed (§4.6) |
| F2 | medium (UX / globalization) | Korean requests get English answers on the Plan route and sometimes in Ask: no language instruction, locale not passed | open — fix proposed (§7) |
| F3 | low (observability) | Audit events are in memory only, so response shape and `model.fallback` audit entries cannot be verified from the server after the fact | open |
| F4 | info | Daily brief is answered by Gemini | accepted, outside the Nemotron-first scope |

## 9. Fields for the deployment report

| Field | Value |
|---|---|
| `REAL_NEMOTRON_HTTP` | PASS — 2 plan-route requests and 6 Ask-mode requests answered by `nebius` / `nvidia/Nemotron-3_5-Lightning`, 0 fallbacks, 0 retries, observed on the deployed `bcd7e10` through the operator's real session |
| `ADVISORY_UI` | PASS for the operator-observed screen (advice, 5 suggestions, no plan, no Run button); response fields NOT_VERIFIED server-side |
| `HUMAN_APPROVAL` | PARTIAL — no approval/execution existed before approval (PASS); the approve → execute path NOT_RUN (blocked by F1; calendar/mail credentials absent) |
| `REAL_DOCUMENT_SAVE_OPEN` | NOT_RUN (not requested in this round) |
| Rollback triggers | none observed |

# NAgex D-11 — Advisory plans on Nemotron: certification, and the recurring-task investigation

**Date:** 2026-10-14 (KST) · **Branch:** `d11/advisory-plan-20261014` (from `d11/nemotron-first-20261014` @ `aa072db`) · **Tested source:** `f740cb9`
**Not done:** no deployment, restart, environment change, merge to `main`, and **no task was deleted, paused or changed**.
**Labels:** PASS / FAIL / NOT_RUN. Fake-endpoint tests are never reported as real model calls.

## 1. The contract that was reviewed

Before: the PLAN validator (`normalizePlan`) rejected any answer with zero steps, and `PlanResolver` refused zero-step plans. So for an advice-only request (the demo's opening request) Nemotron's valid answer — `steps: []` with the advice in `summary` / `suggestions` — was rejected and Gemini answered instead (0 of 4 accepted in the previous certification).

After (commits `87eb828`, `8e0c69c`):

| Rule | Implementation |
|---|---|
| Who decides "advice-only" | The **person's own words**, by a deterministic, fail-closed classifier (`plan-request-kind.ts`, English and Korean): ADVISORY needs an advisory cue (prepare, briefing, summarize, suggest, recommend, "what should…", 브리핑, 요약, 제안, 조언 …) **and no action cue** (send, schedule, book, cancel, create, delete, pay, publish, remind me, 보내, 예약, 취소, 삭제 …; weaker verbs such as call / update / launch count only where a verb stands, so "the launch" does not make a request an action). Unknown or mixed requests are ACTION. The model's own label never makes an answer advice |
| When zero steps is valid | caller is the interactive Home route (`allowAdvisory`) **and** request classified ADVISORY **and** `steps` is exactly `[]` **and** `responseKind` is `ADVISORY` or absent (any other label is rejected) **and** `summary` ≥ 20 chars **and** 1–8 suggestions, each a concrete standalone sentence (15–400 chars, ≥ 3 words or ≥ 10 CJK characters, not a placeholder such as n/a, TBD, "next steps") — one non-concrete entry rejects the whole answer; duplicates are collapsed |
| Action requests | `steps: []` is still rejected (the next provider answers). Tested with English and Korean action requests, mixed requests ("prepare … and send it") and a prompt that says "this is advice only … schedule the meeting" |
| Malformed advice | missing / non-array / empty suggestions, placeholders, fragments, numbers, nested lists, > 8 suggestions, short summary, missing goal, steps present or not an array, other `responseKind` — all rejected (23 malformed-answer cases) |
| One tolerated shape | Nemotron often wraps a suggestion as `{"sentence": "…"}` (or `text` / `suggestion` / `action`). Exactly an object with **one** of those keys holding a string is unwrapped (nothing is lost or invented); every other shape stays invalid |
| Prompt contract | The advisory instruction **and the exact ADVISORY JSON shape** are sent only for an advisory request; action requests and every non-interactive caller get exactly the old prompt (tested). Nemotron under-followed the earlier, shape-less instruction (missing fields) |
| Validator retry | The **preferred** provider gets one more try when the task validator rejects its answer (never a fallback provider, never without a validator, transport errors unchanged); logged as `model_validation_retry`, success log carries `attempts`. Fallback to the next verified provider, its reason and the audit record are unchanged |

### Advice is never an executable plan
- `POST /api/v1/ambient/intent` answers `status: ADVISORY_RESPONSE`, `executable: false`, a `message` "No actions were taken. This is advice only.", an `advice` object — **no `plan` key**, no steps, no approval / task / execution identifiers (tested).
- `PlanResolver` refuses a plan of kind `ADVISORY` (with or without steps), so advice cannot be resolved, approved or run; a client cannot pass advice off as a plan.
- Main renders advice as an **answer** (suggestions + "No actions were taken"), with no Run button, no step list, no approval and no task / approval / resolve request (browser test, EN and KR). The legacy overlay and quick-wake show plain text only; they have no browser test of their own.
- Only the Home route sets `allowAdvisory` (a source scan test fails if any runner, Slack / Telegram service or other module does). Task runners, chat channels and explicit action requests keep the strict at-least-one-step rule, and their prompts are byte-identical.
- Human Approval is untouched: nothing in this change creates, resolves, approves or consumes an approval.

## 2. REAL Nebius Nemotron — advice-only 10, action 10, reported separately

**Method.** `scripts/advisory-plan-live-cert.mjs` calls the production `AiService.plan` (`allowAdvisory: true`, as the Home route does) through the production router and real providers, no fake fetch, from a scratch directory on the test server (removed afterwards), reading only an allow-list of key **names** from the running service's environment inside the process; nothing printed or copied, no deployment, the service unchanged (PID 3928992, checkout `faf38cc`). Requests are plans only — nothing is executed. The advice-only set includes the demo script's request; 3 of each set are Korean.

**Final build, two consecutive runs (compiled code of `8e0c69c`; `f740cb9` differs only in the certification script):**

| | Run A | Run B |
|---|---|---|
| ADVICE-ONLY: classified advisory | 10 / 10 | 10 / 10 |
| ADVICE-ONLY: answered by **Nemotron, no fallback** | **10 / 10** (all accepted as advice) | **10 / 10** (all accepted as advice; 2 needed a second Nemotron try) |
| ADVICE-ONLY: median latency | 4.1 s (range 2.7 – 9.9 s) | 4.1 s |
| ACTION: classified action | 10 / 10 | 10 / 10 |
| ACTION: answered by **Nemotron, no fallback** | **10 / 10** (every plan had ≥ 1 step) | **10 / 10** (2 needed a second try) |
| ACTION: median latency | 19.0 s | 20.2 s |
| Advice returned for an action request | **0** | **0** |
| Zero-step action plans | **0** | **0** |
| Broken invariants (advice with steps, non-concrete suggestion, action with 0 steps) | 0 | 0 |

**How the contract was tuned by real runs (honest history).** Each step below was a real 20-call run on the then-current build:

| Build | Advice-only answered by Nemotron | Action answered by Nemotron | What the failures were |
|---|---|---|---|
| validator only (no prompt shape) | 5 / 10 | 8 / 10 | missing `responseKind` / `steps` / `reasoningSummary`; suggestions as `{"sentence"}` / `{"text"}` objects, nested lists, or bare numbers |
| + exact ADVISORY shape, missing label tolerated | 6 / 10 | 8 / 10 | wrapper objects, numbers |
| + one-wrapper unwrap | 7 / 10 | 8 / 10 | numbers / nested lists; one-off |
| + one preferred-provider retry | **10 / 10** | **10 / 10** | — |

The 100 % is two runs of 20 calls on the final build, not a reliability guarantee: a model answer is still occasionally rejected (the retry absorbed 2 of 10 in each set), and when both tries are rejected the request falls back to Gemini and the reason is logged and audited exactly as before.

**Costs of this approach.** A rejected first answer adds one more Nemotron call (≈ 3 – 20 s, up to ≈ 5 k tokens). Action plans stay slow (median ≈ 20 s, up to ≈ 31 s) — a live demo should cut or show progress. Advice is fast (≈ 4 s).

## 3. Tests

| Gate (on `f740cb9`) | Result |
|---|---|
| `npm run build` | exit 0 |
| `npm test` | 2854 tests, 2846 pass, **0 fail**, 8 skip |
| `npm run test:browser-cert` | 227 tests, 221 pass, **0 fail**, 6 skip |
| New `advisory_plan` | 49 / 49 (classifier tables EN / KR, concreteness, 23 malformed-answer cases, wrapper unwrap, prompt contract, resolver refusal, route shape, only-Home-route scan) |
| `nebius_nemotron_first` | 22 / 22 (adds the retry semantics) |
| Main browser test "Advisory answers in Main" (EN, KR) | 2 / 2 |
| Human Approval / permission security, run by scope: `permission-approval-hardening` | 257 / 257 |
| `credential-broker` | 312 / 312 |
| `model-routing` | 170 / 170 |
| Approval, broker, MCP and plan-scope files run directly (approval persistence / ownership / truth source / TTL, capability broker, action approval, credential broker, MCP runtime + isolated-server E2E, Kakao approval, plan scope policy, advisory) | 264 tests; the only 4 failures are `task_approval_continuation` run on its own, **identical on the untouched integration head** `15d081b` (see below) |

Known, pre-existing and unchanged: running `task_approval_continuation` or `calendar_approval_ui` on its own, or the `tasks` and `google` scopes, shows the same failing tests on `15d081b` as on this branch (same 5 and 19 failure names, no difference); they pass inside the gate's regression / browser sets. Not caused by this change.

## 4. Version match

| | SHA |
|---|---|
| Tested source (gate + real runs) | `f740cb9` (code identical to `8e0c69c`) |
| Test server checkout / running process | `faf38cc` — **without** the Nemotron-first or advisory changes |
| Match | **NO** — awaits your separate approval to deploy. After a deploy the Home request must be repeated through the real HTTP route and the journal checked for `selectedProvider: nebius` and no `model_fallback` |

## 5. Read-only investigation: the 30 ACTIVE recurring tasks

Source: the server's task and run records (read-only), the service journal. **Nothing was deleted, paused or changed.**

**Owners.** All 30 belong to **test-fixture identities** created on 2026-09-22 by test runs against this server's data directory: `usr_tasks_test` (12), `usr_isolation_shared` (9), `usr_isolation_owner_a` (3), `usr_isolation_owner_b` (3), `usr_other_owner` (3). None belongs to a real user and none to the demo persona (`usr_demo_alex` has only one-time tasks). Names: "Daily Morning Brief" (9), "Owner-A-task", "Owner-B-task", "A-task", "B-task", "Isolation target", "Theirs", "Mine".

**Schedules and recent runs.** 27 are daily at 08:00 Asia/Seoul (1 run/day each, last run 2026-10-13 23:00 UTC). **3 are "Daily Morning Brief" every 30 minutes** (`usr_tasks_test`): 47 runs/day each, 910 – 1,045 runs each so far, last run 2026-10-14 04:11 – 04:32 UTC.

| Task id | Owner | Schedule | Runs / 24 h |
|---|---|---|---|
| `tsk_2f0dce961b9bb18e` | usr_tasks_test | every 30 min | 47 |
| `tsk_7d95c7d7e002d0d0` | usr_tasks_test | every 30 min | 47 |
| `tsk_eaca7a4c268cc4ce` | usr_tasks_test | every 30 min | 47 |
| the other 27 (daily 08:00) | usr_isolation_* / usr_other_owner / usr_tasks_test | `0 8 * * *` | 1 each |

**Failures.** Of 4,370 runs ever recorded, **16 did not fail**. Every recent run fails: 45 – 47 of 47 a day with `STEP_BLOCKED`, a few with `STEP_CAPABILITY_NOT_EXECUTABLE`. `STEP_BLOCKED` is raised by the executing runner when a plan step is marked blocked — a tool the task needs is not usable for that identity (these fixture accounts have no provider connection; Google credentials are also absent from the server). The run record keeps no step detail (`result: null`), so the exact blocked tool per task is **not recorded**; this is inferred from the code path, not read from the data.

**Model-call and cost impact (journal since the 2026-10-13 13:07 restart, ≈ 23 h).**
- **100 % of the service's model calls (171 of 171) come from these tasks** (request ids `req_task_exe_…`), all `PLAN`; real user conversations produced none in the window.
- 168 runs a day → ≈ 168 PLAN calls a day: the 3 interval tasks are **141 of them (84 %)**; the 27 daily ones are 27.
- Tokens in the window: Nemotron 44 calls, 250 k tokens (≈ 5.7 k each, **80 % hidden reasoning**); Gemini 127 calls, 192 k tokens (≈ 1.5 k each). Prices were not available, so no currency figure is given.
- **After the Nemotron-first fix is deployed these calls will go to Nemotron instead of Gemini** (they were on Gemini for ≈ 14 h because of the lock-out): ≈ 168 × 5.7 k ≈ **1 M tokens a day, mostly reasoning**, plus a retry whenever the validator rejects an answer. That is a ≈ 4× token increase for work that produces nothing (every run fails).
- Side effects: each failed run leaves a notification record (4,370 notification files), 4,801 durable-run files, and Activity / Notification noise for those fixture accounts only.

**Recommendation (not applied — needs your approval).** Pause, in this order:
1. the **three 30-minute "Daily Morning Brief" tasks** `tsk_2f0dce961b9bb18e`, `tsk_7d95c7d7e002d0d0`, `tsk_eaca7a4c268cc4ce` (84 % of the calls, 0 successes in the last 24 h) — **before** deploying the Nemotron-first change;
2. then the other 27 fixture tasks (no value; they only add failed runs and notifications);
3. longer term: make test suites create their tasks in a throw-away data directory so fixtures never schedule themselves on a shared server, and consider auto-pausing a recurring task after N consecutive failures.

## 6. Required fields

| Field | Value |
|---|---|
| `ADVISORY_VALIDATOR` | PASS (49 / 49) |
| `ACTION_ZERO_STEPS_REJECTED` | PASS (unit, route, real: 0 advice answers and 0 zero-step plans in 20 real action requests × 2 runs) |
| `ADVICE_NOT_EXECUTABLE` | PASS (no plan object, resolver refuses, no Run / approval in the UI, only Home route opts in) |
| `NEMOTRON_FIRST_AND_FALLBACK` | PASS (policy, fallback, audit unchanged; real 10 / 10 + 10 / 10 twice) |
| `REAL_ADVICE_ONLY_10` | PASS 10 / 10 and 10 / 10 (final build); lower on earlier builds, see §2 |
| `REAL_ACTION_10` | PASS 10 / 10 and 10 / 10 (final build) |
| `REGRESSION / BROWSER_CERT` | PASS (0 failures) |
| `HUMAN_APPROVAL_SECURITY` | PASS (scopes 257 / 312 / 170, 0 failures); 4 pre-existing standalone-run failures identical on baseline |
| `DEPLOYED_SERVER_MATCH` | NO |
| `RECURRING_TASKS` | investigated read-only; pause list above; nothing changed |

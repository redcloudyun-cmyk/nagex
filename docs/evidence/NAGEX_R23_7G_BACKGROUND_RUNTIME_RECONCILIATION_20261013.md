# R23.7G background-runtime reconciliation

**Date:** 2026-10-13
**Branch:** `auto/roadmap-20261013` (not merged to `main`, not deployed)
**Roadmap item:** Development Roadmap §7 item 5 / §11 "Background Runtime Gate"
**Method:** read the runtime (`src/tasks/*`, `src/server_web.ts` lifecycle, `src/notifications/*`, approvals) against the eight questions in §11 and tie each answer to
an executing test. Existing certification evidence was used; nothing was re-run blindly. Two real defects were found and fixed (section 3).

This is point-in-time evidence. It does not by itself close R23.7G; it replaces "unknown" with a stated, tested position and a list of residual limits.

## 1. The eight questions

| Question | Position | Evidence |
|---|---|---|
| What survives restart | Tasks, task runs, durable multi-step run state, approvals (file mode 0600), notifications (unread/read), memory, proactive-assistant schedule. Does **not** survive: live browser-runtime sessions (each watch check opens its own); Google OAuth connections when `NAGEX_TOKEN_ENCRYPTION_KEY` is unset (the server logs `google_oauth_persistence_disabled`). | `task_scheduler` (run persists across a fresh `TaskRunStore`), `durable_task_runtime` 5, `approval_execution_persistence`, `notification_delivery` P04-08/09, `persistent_memory`, `google_oauth_persistence` |
| What resumes safely | Durable multi-step runs left RUNNING are resumed at boot from their frozen steps; a run waiting for approval is not touched; a terminal run is not touched; an orphan (task deleted) is marked FAILED. A re-dispatched step reuses the same deterministic request id so the Broker idempotency cache prevents a second execution. **New:** a scheduled run with no durable record that the previous process died in is now ended as FAILED (`INTERRUPTED_BY_RESTART`) and the schedule is put back into service (section 3.2). | `durable_task_runtime` 6-12 and 14 |
| Scheduler / watch truthfulness | Invalid cron/timezone fails closed (never a guessed time); an unmet or errored condition check stays WAITING and never notifies; an ambiguous model judgment counts as NOT met; a page needing human verification fails the check and closes the browser; a failed daily brief reports FAILED and sends no "ready" notification. | `task_scheduler`, `conditional_watch`, `proactive_assistant` |
| Notification semantics | Persist-first WEB notification; exactly one per logical event via `taskId:runId:eventType` dedupe key (approval wait, completion, failure, condition met, resume). | `notification_delivery` P04-01..07 |
| Duplicate / replay prevention | Notification dedupe key; approval state machine (CONSUMED cannot be replayed, EXPIRED/REJECTED stay terminal); Broker idempotency by request id; **new:** overlapping scheduler ticks can no longer run the same due task twice (section 3.1). | `approval_ttl_security` 1-6, `durable_task_runtime` 10, `task_scheduler` (overlap test) |
| Provider outage behavior | A provider failure produces a FAILED run, a TASK_FAILED notification with the error code, an audit event, and the schedule continues; Slides without a model answers a localized "not available", never a fabricated deck. | `proactive_assistant` (real provider failure), `notification_delivery` P04-04, `r23_7c_d_presentation_runtime` |
| Approval validity across delay / restart | Approvals persist; an APPROVED approval past `expiresAt` becomes EXPIRED on restore and blocks execution with 0 provider calls (Gmail, Calendar, browser). | `approval_ttl_security` (persistence test, three service regressions), `approval_execution_persistence` |
| Cross-session isolation | Tenant + owner checked on every task, notification, approval and proactive-assistant read/write; a mismatch answers as not-found. | `tasks_api` (tenant + owner isolation), `notification_delivery` P04-10 and P04-R1-01..04, `proactive_assistant` (isolation), `approval_ownership_isolation` |

## 2. Test-suite repair found on the way

`durable_task_runtime` had seven failing tests that were not in the recorded failure baseline. Cause: commit `b5856fe` (per-user Google connection states) made the
credential-access service call `tokenStore.getStatusForPrincipal`, but this suite's token-store stub still only offered the old `getValidAccessToken`, so every Gmail step
failed with `CAPABILITY_POLICY_FAILED`. The stub was updated to the same connected-account shape `capability_broker.test.ts` uses; no assertion was weakened. Other suites
with the same stale stub, if any, will show up in the full regression run.

## 3. Defects found and fixed

### 3.1 Overlapping scheduler ticks could run one task twice

`TaskScheduler.tick()` takes a snapshot of due tasks and runs them one after another; the interval in `server_web.ts` (30 s by default) does not wait for a slow tick.
While tick 1 was inside a slow run (a model call), tick 2 started, found the next task still ACTIVE and due, and ran it; tick 1 then reached the same task from its
snapshot and ran it again. For a daily brief that is a duplicate run and duplicate model/provider work; consequential steps are still approval-gated, but a duplicate run
is a duplicate run. Fix: `tick()` re-checks that each snapshot entry is still due immediately before claiming it (the check and `markRunning()` are synchronous with each
other, so two ticks cannot both claim a task). A slow run still does not block other due tasks. Regression test: `task_scheduler` "overlapping ticks never run the same
due task twice" (failed with `2 !== 1` before the fix).

### 3.2 A run interrupted by a restart left its schedule stranded

`DurableTaskRuntime.recoverOnStartup()` only knows durable multi-step run records. A daily brief, a condition watch or a plan preview that the process died in left the
Task `RUNNING` and its TaskRun `RUNNING` forever: the scheduler only picks up ACTIVE/WAITING tasks, so the user's schedule silently stopped, which is a silent failure
(MASTER §7). Fix: `DurableTaskRuntime.failInterruptedRuns()` (called from the same startup lifecycle hook, after durable recovery) finalizes such a run through the shared
`finalizeTaskRun` as FAILED with `INTERRUPTED_BY_RESTART` (audit event, TASK_FAILED notification with dedupe key); RECURRING tasks return to ACTIVE with their next run,
ONE_TIME tasks end FAILED, conditional watches return to WAITING. The run is deliberately not replayed. Regression test: `durable_task_runtime` 14.

## 4. Residual limits (stated, not fixed)

- Recovery of a durable step that was in the middle of an external dispatch is at-least-once with an ambiguous prior outcome (documented in `durable-task-runtime.ts`; needs
  provider idempotency keys to improve).
- There is no end-to-end real-process test that kills the server during a daily-brief run and checks the sweep; the sweep is covered at the runtime level.
- `interrupted` notifications show the raw error code (`INTERRUPTED_BY_RESTART`) in the body, like every other TASK_FAILED notification; localized wording belongs to R23.8P.
- Whether the deployed server has `NAGEX_TOKEN_ENCRYPTION_KEY` set was not verified in this run.
- A single-process assumption remains: two server processes sharing one data directory are not supported.

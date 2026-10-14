# NAgex D-10 P0-A — Home approval → execution, and document readiness: analysis and certification

**Date:** 2026-10-14 (KST) · **Directive:** `NAGEX_D10_ONE_INPUT_RELEASE_GATE_20261014.md` · **ADR:** `docs/adr/ADR-0015-home-reviewed-plan-approval-request.md` · **Branch:** `d11/one-input-intent-20261014` (pushed)
**Separation used below:** *code review* (what the code does, read) · *tests* (isolated, local) · *live external* (real model, isolated destination). Labels: PASS / FAIL / BLOCKED / NOT_RUN.
No Gmail / calendar message, event, payment or deletion was made by any test. The test server was not touched (`bcd7e10`, PID 2997023, unchanged); `main` and the Voice WIP were not touched.

## 1. Result

| Item | Result |
|---|---|
| Root cause of "approve never leads to execution" | **Found and fixed** (§2) |
| Plan preview → approval request → approval → execution → result, distinct states | **PASS** (tests, isolated destination) |
| No external dispatch before a concrete human approval | **PASS** |
| Ownership (wrong user / tenant), stale / foreign-process preview, changed arguments / tool / steps / flag / goal | **PASS** (all refused before anything is resolved or requested) |
| Replay prevention (double click, simultaneous requests, second approve, direct broker replay, second coordinator trigger) | **PASS** |
| Reject, expiry, failing provider, unavailable provider, missing details | **PASS** (nothing sent / scheduled; the run is FAILED / "Not run", never "Completed") |
| Audit redaction | **PASS** (plan hash + argument names; no values, no credential) |
| Browser: authentic Home chain with a real Approve and a real Decline, EN + KR, 1440 / 430 / 390 / 360 | **PASS** (10 tests) |
| Live external: real Nemotron produces a runnable, faithful plan for a connected tool | **PASS** 5 / 5 (§5) |
| Document create → save → Recent → reopen after a restart → ownership, real model, isolated store | **PASS** (§6) — and **never yet exercised on the test server** |
| `npm run build` | exit 0 |
| `npm test` (regression) | **2,941 tests / 2,933 pass / 0 fail / 8 skip** (before this task: 2,915) |
| `npm run test:browser-cert` | **279 tests / 273 pass / 0 fail / 6 skip** (before: 269) |
| Hosted, signed-in, one human-approved real harmless action on nagex-test.agex.site | **NOT_RUN / BLOCKED** — not deployed (no approval), and the server has no Google credentials (§7) |

## 2. The state machine as built, and why Home never executed (code review)

Before this change (`faf38cc` / `bcd7e10` / One Input `c31f2fa`):

```text
Home "Run this plan"  (public/main-surface.js startPlanRun)
  -> POST /api/v1/tasks      {type: ONE_TIME, trigger: MANUAL, approvalPolicy: ALWAYS_APPROVE, objective: <the request text>}
  -> POST /api/v1/tasks/:id/run  -> TaskScheduler.runOne -> CompositeTaskRunner
       approvalPolicy === READ_ONLY_AUTO  -> ExecutingTaskRunner     (the only runner that reaches the CapabilityBroker)
       every other task (incl. ALWAYS_APPROVE) -> PlanPreviewTaskRunner
            = a SECOND model call on the objective text, PlanResolver.resolve, return {status SUCCEEDED, result.kind PLAN_PREVIEW}
              "does NOT yet auto-execute ... a reviewable plan only"  (its own comment; Sprint A scope)
  => no broker call, no ActionApproval, no continuation: there is nothing to approve and nothing to execute.
```

`ALWAYS_APPROVE` was **designed** to stay a preview. The approval-aware path exists, but only behind `READ_ONLY_AUTO` (P02):

```text
ExecutingTaskRunner.run -> AiService.plan(objective)  (re-plans!) -> PlanResolver -> executeSteps
   read-only step (EXECUTABLE_CAPABILITY_IDS)      -> CapabilityBroker.execute -> dispatched IMMEDIATELY
   approval-gated write (NATIVE_APPROVAL_WRITE_*)  -> CapabilityBroker.execute WITHOUT approvalId
        -> PermissionDecisionService (BLOCK / allow) -> dispatch -> provider service requests the ActionApproval (payloadHash-bound)
        -> {status: APPROVAL_REQUIRED, approval} -> TaskContinuationStore.create + DurableTaskRunStateStore.markWaitingApproval -> run WAITING_APPROVAL
POST /api/v1/approvals/:id/approve -> provider service approve() -> TaskContinuationCoordinator.onApproved (fire-and-forget)
   -> claim (WAITING -> RESUMED) -> ExecutingTaskRunner.resumeFromApproval -> CapabilityBroker.execute WITH approvalId
   -> provider executes and consumes the approval (one-time, payload-bound) -> remaining steps -> finalizeTaskRun
reject -> onRejected -> FAILED APPROVAL_REJECTED · expiry -> FAILED APPROVAL_EXPIRED (lazily, when something resumes)
```

Why simply routing Home to that path was wrong: (1) the executing runner **re-plans** from the text, so what runs is not what was reviewed; (2) it **dispatches read-only steps immediately**, before any approval (the directive forbids this); (3) it needs `READ_ONLY_AUTO`, a policy the product must not relax. Three further defects surfaced while tracing: the MCP broker path takes `{arguments: {...}}` while plan steps carry flat arguments (every MCP step failed `MCP_INVALID_ARGUMENTS`); the plan prompt never told the model an MCP tool's argument names; and the run view marked a real `EXECUTED` step as still "running".

## 3. What was implemented (no new executor)

`POST /api/v1/tasks/from-reviewed-plan` — an explicit, user-triggered **plan preview → approval request** transition (details in ADR-0015):

1. The plan route seals every plan preview: `planSeal {planHash, token, expiresAt}` (HMAC over tenant | principal | hash | expiry, per-process key) and `runnable {ok, reasons}`. Advisory answers are never sealed.
2. The run route verifies the seal for **this** caller, re-resolves the plan, re-applies the eligibility rule (one approval-gated step with concrete arguments; reads, multi-step, unavailable or unsupported tools stay previews with the reason), claims the plan once, creates the task (`ALWAYS_APPROVE`, never relaxed) and runs the **frozen resolved plan** through the existing `ExecutingTaskRunner.runWithResolvedPlan` — no model call. The first broker call only REQUESTS the approval. Everything after is the unchanged P02 chain, started only by the person's own Approve.
3. The proposal returned to the screen is the tool and its exact arguments (credential-like names hidden); the audit records the plan hash and argument names.
4. MCP tools pass the runner's native-approval gate by capability id; the broker's `McpService` still binds the approval to the exact arguments. The MCP envelope (`{arguments}`) is applied server-side; the prompt now lists each connected tool's argument names and types and tells the model not to invent values.
5. Home: "Request approval to run" appears only for a runnable plan (otherwise "This is a preview only: <reason>"); states **WAITING approval — nothing has been done yet** → the person's Approve / Decline → **Tool responded** ("NAgex has not independently checked the result in the real world") / **Not run — you declined** / **Not run — the approval expired** / Failed. "Completed" is never used for a provider response.

## 4. Invariants → mechanism → evidence

| Invariant | Mechanism (code review) | Tests |
|---|---|---|
| No dispatch on submit, routing or "request approval" | the run route only calls the broker WITHOUT an approval id → provider services request the approval; no provider module is imported by the route; read-only steps are refused | isolated MCP server `callsTo(echo) === 0` after the request; mail / calendar stub send count 0; source guard test (no `.approve(`, `.consume(`, `READ_ONLY_AUTO`, provider imports in the route) |
| Reviewed = executed | plan hash + owner-bound token; frozen resolved plan; no model call on run | changed arguments / tool / extra step / approval flag / goal → 403 `PLAN_SEAL_INVALID`, nothing created; the plan route's model is called once across preview + run + approve |
| Right owner and tenant | token bound to tenant + principal; task, approval and continuation are owner-scoped | other user and other tenant → 403; a stranger cannot approve the owner's approval; the stranger's lists stay empty; the owner can still run (a failed attempt consumed nothing) |
| One-time | synchronous claim per owner + plan hash; approval consume; continuation claim | double click and `Promise.all` of two requests → one 200 + one 409 `PLAN_ALREADY_STARTED` (carrying the first task); second approve ≠ 200; direct broker replay `APPROVAL_ALREADY_CONSUMED`; second coordinator trigger a no-op; browser double click → one task, one approval |
| Stale / foreign preview | expiry in the token; per-process key | expired → 410 `PLAN_SEAL_EXPIRED`; token of another process / missing token → 403 |
| Approval bound to the exact arguments | provider `payloadHash`; MCP hash-bound approval | invoking the approved tool with changed arguments is refused; the server only ever saw the approved arguments |
| Reject / expiry / failure are truthful | P02 coordinator | reject → FAILED `APPROVAL_REJECTED`, no call; expired approval cannot be approved, no send; provider 503 → run FAILED (never SUCCEEDED) |
| Missing details never reach an approval | provider payload validation at request time | calendar event without required fields → run FAILED at the request, 0 approvals, 0 events |
| Audit redaction | argument names + hash only | the audit log text contains the hash prefix and neither the argument value nor the bearer token |
| Auth | route requires a session | 401 without one |
| UI never claims more than happened | state labels from the run record | "Tool responded", "Not run", "preview only"; no "Completed" for a provider response; 44 px targets, no overflow, no raw keys (EN + KR, 4 widths) |

## 5. Evidence by kind

**Code review.** §2–§3; the files: `src/planning/plan-seal.ts`, `src/planning/reviewed-plan-eligibility.ts`, `src/http/routes/tasks.routes.ts` (new route), `src/http/routes/conversation.routes.ts` (seal + verdict), `src/tasks/runners/executing-task.runner.ts` (MCP ids through the native gate), `src/mcp/mcp.service.ts` + `src/model-gateway/ai-service.ts` (argument names in the prompt), `public/main-surface.js`.

**Tests (isolated, local; real HTTP to loopback destinations or counting stubs only).**
- `home_reviewed_plan_mcp_e2e` (12): production routes and singletons against the repository's isolated MCP test server (`scripts/mcp-test-server.mjs`, in-memory tools): the full chain, decline, double click, ownership, tampering, expiry, unrunnable plans, audit redaction, auth, and the plan route → sealed preview → run → approve chain with a fake model endpoint.
- `home_reviewed_plan_run_inert_providers` (10): the real `GmailService` / `GoogleCalendarService` / `CapabilityBroker` / `ActionApprovalStore` with the HTTP boundary to Google replaced by a counting stub: nothing is sent when approval is requested, exactly once after approval, missing detail, reject, expiry, failing provider, another owner, stale preview, a read-only step.
- `home_reviewed_plan_browser` (10, real Chromium): the authentic chain at 1440 / 430 / 390 / 360 in EN and KR (real Approve click, tool called exactly once, "Tool responded"), and a real Decline (tool never called, "Not run"); only the plan route is stubbed and its seal is the server's own.
- Updated: `main_unified_workspace_browser` D3 / D4 (new states and endpoint), `one_input_intent_browser`, `one_input_intent_routing` (+4 rows: asking NAgex to use a connected tool is an approval-gated action), `route_inventory` (+1 route: 349 → 350).

**Live external (real model, no fake fetch; the destination is an in-memory tool description, nothing executed).** `scripts/home-plan-live-cert.mjs` on the test server host from an isolated clone (live service untouched, credentials read by name into the cert process only): 5 requests (3 give the message, 2 do not):

| Metric | Result |
|---|---|
| Routed as an approval-gated action plan | 5 / 5 |
| Tool named exactly (`mcp.<connection>.echo`) | 5 / 5, all answered by `nvidia/Nemotron-3_5-Lightning`, no fallback |
| Value the person gave kept, plan judged runnable | 3 / 3 |
| A value the person did not give invented | 0 / 2 (must be 0) |
| Such an incomplete plan offered for approval | 0 / 2 — `ARGUMENTS_MISSING` (must be 0) |
| Latency | 15–33 s (the Nebius endpoint was slow that afternoon) |

One run before the router learned "use my … tool" had 4/5 routed (a request phrased "Use my test tool to echo …" went to the chat route): fixed and re-certified at 5/5.

## 6. Document create → save → reopen: readiness

- **Code and tests (existing + new):** creation, persistence in `DocumentStore` + `ArtifactStore`, cross-tenant denial, revisions, truthful failure with no provider (`r23_7c_b_document_creation_runtime`, `r24_*` Recent / Open browser tests) all pass in the gates; the creation route and presentation route now default `locale` to the request language.
- **Live (real Nemotron, isolated temp store, `scripts/document-roundtrip-live-cert.mjs`):** Korean and English one-page reports: **create SUCCESS, saved, listed in Recent, reopened identical (same hash and title) by fresh store instances over the same files, a stranger denied** — PASS. Korean report 92 % Hangul, English 0 %. Latency 16 s / 19 s.
- **On the actual test server: never exercised.** `/var/lib/nagex/creations` holds only image records (73) and `artifacts` only two images; the `documents` directory does not exist yet (it is created at the first save; the data root is writable by the service user). So the first hosted document will be the first time that path runs there. **Readiness: READY, with one caveat** — certify it on the hosted server right after deployment with a real signed-in user (creation → Recent → Open), as the gate requires.

## 7. GO / NO-GO against the directive's list

| NO-GO condition | State |
|---|---|
| approval bypass | none found; tests assert the opposite at each point (§4) |
| fake successful execution | none: a provider response is "Tool responded", `verification: UNVERIFIED`; failures stay FAILED |
| misleading provider "Connected" status | not changed; an unavailable provider makes the plan non-runnable with the reason |
| unauthorized write | none: ownership / tenant / seal / approval-hash tests |
| 0-step actionable plan | still rejected by the plan service; the run route refuses anything but one step |
| secret exposure | none: audit and UI carry names / hashes; credential-like argument names are hidden |
| failed build / test | none: build 0, regression 0 fail, browser 0 fail |
| no rollback | the test server is unchanged and `bcd7e10` / `faf38cc` rollback assets exist; nothing was deployed |

**Not PASS yet (by the directive's own rule):** the final hackathon journey needs real hosted artifact creation and one human-approved real harmless action on nagex-test.agex.site. Blockers, stated plainly:
1. **Not deployed** — needs the operator's explicit approval, a backup, and the operator's `sudo` restart.
2. **The server has no Google credentials** (Calendar / Gmail unavailable): the only real harmless approval-gated action available there is a **user-registered MCP tool**. For the demo the operator must register a harmless MCP server (public HTTPS; the server refuses private-network URLs by design) and enable one tool with a visible effect (for example an echo / note tool). Without it the Home plan for a mail or calendar request correctly stays "preview only: the app isn't connected".
3. Hosted runs must be done by a real OAuth-signed-in user (no demo accounts, no cookies shared).

## 8. Known limits (not hidden)

- One step per plan from Home; read-only steps are not run from Home; multi-step chains with one durable approval are deferred.
- Seal and claims are in process memory: a restart invalidates previews (the person asks again) — safe, but a long approval wait across a restart shows the run as waiting until resolved or cancelled; approval expiry is detected lazily by the P02 coordinator (disclosed there), so an expired approval leaves the run "waiting" until something resumes it.
- A tool server's description / schema is untrusted data: only property names and basic types reach the prompt.
- Nemotron plan latency (15–60 s) is the user-visible wait for the preview; the 60 s bound is unchanged (not enabled blindly: P1 asks for measurement first).
- The fixture recurring tasks stay PAUSED (verified unchanged: 30 paused, no model-call storm since the cutover).

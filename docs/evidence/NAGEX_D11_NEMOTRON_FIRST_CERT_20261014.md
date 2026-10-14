# NAgex D-11 — NVIDIA Nemotron First: certification

**Date:** 2026-10-14 (KST) · **Branch:** `d11/nemotron-first-20261014` (from the integration head `15d081b`) · **Tested source:** `d13afc6`
**Not done:** no merge to `main`, no deployment, no restart, no environment change on the test server.
**Labels:** PASS / FAIL / BLOCKED / NOT_RUN. A fake-endpoint test is never reported as a real model call.

## 1. Actual cause of the bypass

Measured on the running test server (journal, 2026-10-13 13:07 → 2026-10-14 11:10; see `NAGEX_D11_BASELINE_AUDIT_20261014.md`):

| Observation | Value |
|---|---|
| Nebius Nemotron calls that succeeded before the bypass | 44 (13:07 – 20:58) |
| Requests routed to Nemotron after 10-13 20:58:45 | **0** — 110 of 110 `PLAN` requests went to Gemini for ≈ 14 h |
| Router reason | `PROVIDER_DEGRADED_DEPRIORITIZED` |

Two independent causes, both in the existing router (no new engine):

1. **A one-way degraded state.** `status()` reports `DEGRADED` whenever a provider's *last* call failed, and the policy ranks a degraded provider last. After one transient timeout Nemotron was never selected again, so it could never succeed again and recover; only a restart or an explicit health-check call cleared it.
2. **Narrow task scope.** Only `PLAN`, `RESEARCH_SYNTHESIS` and `MEETING_PREP` preferred Nemotron. `CHAT` and `DOCUMENT_SYNTHESIS` followed the "provider that already succeeded first" tier, which favours Gemini once it has answered.

Two further defects were found by the real runs below and fixed:

3. **A truncated answer degraded the whole provider.** In the code a Nemotron answer that used its entire token budget (`finish_reason=length`) marked the provider `DEGRADED`, so the next requests of *every* task skipped it for the cool-down; the live cascade described in §3 is consistent with this (inferred). A truncated answer is a fact about that request, not about the provider.
4. **Wrong reason recorded for a skipped provider.** If the cool-down ended while the fallback was answering, the recorded reason became `UNKNOWN_FAILURE` instead of `PROVIDER_DEGRADED`.

## 2. Policy applied (fix commits `4cff530`, `d13afc6`)

| Requirement | Implementation |
|---|---|
| 1. Nemotron first for conversation, planning, research, meeting prep, document drafts | `CHAT`, `PLAN`, `RESEARCH_SYNTHESIS`, `MEETING_PREP`, `DOCUMENT_SYNTHESIS` are Nemotron-eligible **and** prefer it (`DEFAULT_TASK_PROVIDER_PREFERENCES`, `NEBIUS_NEMOTRON_TASK_KINDS`) |
| 2. Existing router, no new engine | Changes are inside `ModelRoutingPolicy`, `UnifiedModelRouter` and `providers.ts` only |
| 3. Non-text generation to specialist models | Unchanged and tested: the text router has no image/video task kind; images use the separate creation provider router (OpenAI adapter); unsupported kinds are refused (`CREATION_KIND_UNSUPPORTED`), never rerouted. Strict extraction, daily brief, presentation outline, comparison / forecast analysis keep their existing providers |
| 4. Fallback to a verified model, reason in the server audit record | A fallback is logged as `model_fallback` and sent to an audit sink wired to the `AuditLogger` (`action: model.fallback`, `reason_code`, task, preferred / actual provider, model, request id). The success log's `fallbackUsed` now means "the preferred provider did not answer" (it used to be `false` when Nemotron was skipped) |
| Recovery | After a bounded cool-down (`NAGEX_PROVIDER_DEGRADED_COOLDOWN_MS`, default 60 s, 1 s – 10 min) a degraded provider is `retryEligible`; exactly one real call decides (success → LIVE, failure → DEGRADED with a fresh cool-down). Status is still reported truthfully as `DEGRADED` until a call succeeds |
| 5. Internal routing not over-exposed | Ordinary screens unchanged. A content-free recent-call trace (task, provider, model, latency, fallback + reason; never a prompt, answer, reasoning or key) is returned by `GET /api/v1/providers/status` and shown in the existing Settings "AI & Model" section **only when the owner sets `NAGEX_EXPOSE_MODEL_TRACE=1`** (off by default). The server journal always carries `model_routing_decision`, `model_request_succeeded` and `model_fallback` |
| Budget | Default Nebius output budget 8192 → 16384 tokens (a Nemotron plan was measured at ≈ 6.7 k mostly reasoning tokens) |

## 3. REAL Nebius verification (not mocks)

**Method.** `scripts/nemotron-first-live-cert.mjs` calls the production `AiService` methods (`chat`, `plan`, `research`, `meetingPrep`, `documentSynthesis`) through the production `UnifiedModelRouter` and real providers — no fake fetch. It was run **on the test server** from a scratch directory (removed afterwards), reading only an allow-list of variable *names* (the provider keys and model ids) from the running service's process environment inside the script; no value was printed, copied or written, nothing was deployed, the service was not touched (still PID 3928992, started 2026-10-13 13:07:20, checkout `faf38cc`). It prints facts only: task, provider, model, latency, token counts, fallback + fixed reason code. Research evidence is a synthetic two-source pack (labelled); the plan prompt is an actionable scheduling request.

**Final run on the tested build (`d13afc6`), 3 rounds × 5 paths = 15 real calls:**

| Path | TaskKind | Answered by | Model | Latency min / median / max | Fallback |
|---|---|---|---|---|---|
| conversation | `CHAT` | **nebius** | `nvidia/Nemotron-3_5-Lightning` | 1.3 / 1.7 / 2.1 s | 0 of 3 |
| planning | `PLAN` | **nebius** | same | 9.3 / 16.7 / 17.5 s | 0 of 3 |
| research | `RESEARCH_SYNTHESIS` | **nebius** | same | 2.9 / 3.1 / 3.7 s | 0 of 3 |
| meeting prep | `MEETING_PREP` | **nebius** | same | 7.9 / 8.3 / 9.3 s | 0 of 3 |
| document draft | `DOCUMENT_SYNTHESIS` | **nebius** | same | 5.7 / 6.3 / 10.7 s | 0 of 3 |

Result: **15 / 15 PASS**; every answer was non-empty and passed the production validators; provider-reported reasoning tokens were present on every call. Control: `DAILY_BRIEF` (not a Nemotron task) was still answered by Gemini — PASS. **Real fallback with audit:** pointing Nemotron at a model id that does not exist produced a genuine provider 404 → reason `MODEL_UNAVAILABLE` → answered by OpenAI, with the `model_fallback` log line and the `model.fallback` audit record both written — PASS.

**Earlier real runs on intermediate builds (kept because they found defects 3–4):**

| Run | Outcome |
|---|---|
| 5 rounds × 5 paths | 18 of 25 answered by Nemotron. A `PLAN` failed with `INVALID_RESPONSE`; right after it Nemotron was `DEGRADED`, so the next 6 calls of other tasks were answered by Gemini (5 recorded as `PROVIDER_DEGRADED`, 1 as `UNKNOWN_FAILURE` — defect 4). Validator rejections alone did not degrade the provider (4 consecutive rejections in another run did not), so the degrading answer was a truncated / empty one — **inferred from the code path, not separately reproduced live** (defect 3). Both defects are fixed at the code path and covered by tests |
| `PLAN` × 8 (actionable prompt) | 8 / 8 Nemotron (median ≈ 16 s) after the fixes; in the first batch 3 / 6 |

**Honest limits of this evidence**
- Latency is real and high for `PLAN` (median ≈ 17 s, up to ≈ 22 s observed): Nemotron reasons before answering. A 60–90 s video should not wait on a live plan without a cut or a progress state.
- Only a few dozen real calls were made; this shows the path works and how it behaves, not a reliability statistic.
- The real calls were made from the server's network by a script, **not** through the deployed service's HTTP routes; the deployed service still runs the old code.

## 4. Finding that the policy does not fix: advisory plans are rejected

The PLAN validator requires at least one step. For an **advisory** request (the demo's "Prepare a concise briefing for tomorrow's meeting and suggest the next action") Nemotron answers with valid JSON and **zero steps** (its steps go to `suggestions`, following the plan prompt's minimal-action rule): **0 / 4** such requests were accepted (all `INVALID_MODEL_RESPONSE`, then answered by Gemini); a similar prompt returned `steps=0` in 3 of 6 structural checks. Gemini returns a step. With an actionable request (8 / 8 and 15 / 15 above) Nemotron plans normally. Consequence: if the demo's opening request is routed through `PLAN`, the visible plan may come from the fallback. This is a product decision (accept an advisory plan with suggestions only, or word the demo request as an action); it was **not** changed here.

## 5. Tests (all fake endpoints or local; none counts as a real model call)

| Gate (on `d13afc6`) | Result |
|---|---|
| `npm run build` | exit 0 |
| `npm test` | 2802 tests, 2794 pass, **0 fail**, 8 skip |
| `npm run test:browser-cert` | 225 tests, 219 pass, **0 fail**, 6 skip |
| New `nebius_nemotron_first` | 19 / 19 (task coverage, cool-down recovery with an injected clock, one trial per window, decision-time fallback reason, truncated answer scoped to the request, audit + log + trace content-free, opt-in status exposure, non-text separation) |
| Updated `nebius_nemotron_routing`, `_contract`, `_provider`, `model_provider_integration` | rewritten to the new policy (the old assertions encoded "CHAT / DOCUMENT keep Gemini" and "truncation degrades the provider"); the secret-leak, capability-evidence and structure checks are unchanged and pass |

## 6. Version match

| Item | SHA |
|---|---|
| Tested source (this document's gate and the real run) | `d13afc6` |
| Test server checkout / running process | `faf38cc` (**without** this fix) |
| Match | **NO** — the demo server does not run the tested build. The real cert exercised the tested code from a scratch directory; the service itself is unchanged |

To make the server match (needs your separate approval; not done): check out `d11/nemotron-first-20261014` on the server, `npm run build`, and `sudo systemctl restart nagex`. Optional environment: `NAGEX_EXPOSE_MODEL_TRACE=1` (evidence view), `NAGEX_PROVIDER_DEGRADED_COOLDOWN_MS` (default 60 s is fine). After the restart, a short real check through the HTTP routes and the journal (`model_routing_decision … selectedProvider: nebius`) should be repeated.

## 7. Required fields

| Field | Value |
|---|---|
| Actual bypass cause | one-way DEGRADED + narrow Nemotron task scope (+ truncation degrading the provider, + wrong skip reason) |
| Fix SHAs | `4cff530` (policy, cool-down, audit, trace), `d13afc6` (truncation, skip reason, budget); live-certification script commits `7c705d9`, `77c4353` and the later script changes contained in `d13afc6` |
| `NEMOTRON_FIRST_POLICY` | PASS (code + tests) |
| `REAL_NEBIUS_CHAT / PLAN / RESEARCH_SYNTHESIS / MEETING_PREP / DOCUMENT_SYNTHESIS` | PASS (15 / 15 on `d13afc6`, server network) |
| `REAL_FALLBACK_AUDIT` | PASS |
| `DEPLOYED_SERVER_MATCH` | NO — deployment awaits approval |
| `ADVISORY_PLAN_ZERO_STEPS` | OPEN finding (§4) |

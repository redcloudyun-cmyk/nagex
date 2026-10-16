# JEV Decision Intelligence — DecisionPort evidence

**Status:** EVIDENCE (point-in-time; architecture is in `docs/canonical/NAgex_AI_Model_and_Decision_Architecture.md` §10.1)
**Date:** 2026-10-16
**Branch:** `topic/computer-use-20261016`
**Release posture:** RELEASE = NO-GO · no deployment · `main` untouched

## 1. What was built

An optional, replaceable, **advisory** decision seam for the browser/device loop:

- `src/device-control/decision-port.ts` — the provider-independent port, NAgex-internal advice types, strict validation (`normalizeAdvice`), the closed list of what advice may change (`advisoryEffect`), and `DecisionAdvisor` (deadline, fallback, per-session circuit breaker).
- `src/device-control/jev-decision.adapter.ts` — JEV as **one** provider behind the port.
- `DeviceControlService` — consults the advisor **after** every hard check and **before** the action; composed in `create-nagex-application.ts` only when `NAGEX_JEV_DECISION_ENABLED=true` **and** `NAGEX_JEV_API_KEY` is set.

## 2. What is verified about JEV — and what is not

| Question | Answer |
|---|---|
| Is JEV a real provider in this repository? | Yes: `model-gateway/jev-provider.ts` (`JevSystemOneProvider`, endpoint `https://jevmodel.org/v1/systemone`), `jev-shadow-*` evaluation, `jev-live-results.ts` (a recorded live benchmark), and the router's shadow advisory (`NAGEX_JEV_ADVISORY_ENABLED`). |
| Which JEV schema is **verified**? | The System One request `{model, state, questions: {name: {type: 'choice' \| 'noul' \| 'score', instructions, choices?, criteria?}}}` and answer `answers.<name>.{choice \| probability \| score, confidence}` — taken from that existing implementation, **not re-checked against the live service today**. |
| Which supported decision types are used? | `choice` (action, retry, completion) and `noul` (risk probability). No other type, no field beyond those. |
| Was JEV called live in this work? | **No.** There is no JEV credential on this machine. `JEV_PROVIDER_VERIFIED` is therefore **"contract verified from repository code and recorded results; live call NOT made"**. |
| The four questions (action / risk / retry / completion)? | NAgex's own. **Unverified against the live service.** Tests use a simulated service of the verified shape. |

Nothing about JEV's behaviour, accuracy or latency is claimed. The canonical document's requirement that JEV be benchmarked against deterministic routing before any promotion still stands, and this work does not meet it.

## 3. Boundary and fallback — verified (`jev_decision_port`, 15 tests; 5 in real Chromium)

| Property | Result |
|---|---|
| Advice cannot allow what the policy denies | A planner that goes for **"Issue invoice"** is held for approval while the provider answers *proceed, confidence 1.0, risk 0, "complete"*; 0 issued |
| Advice cannot remove any check | `advisoryEffect`: "proceed" with any confidence / completion claim → no effect (all combinations); a provider cannot set the escalation flag itself (derived by NAgex; extra fields such as `approved` / `allow` / `override` are dropped) |
| Advice can only add caution | risk ≥ 0.7 on a CLICK → held for approval **before the page is touched** (the link was not followed); confident hand-over / abort / takeover (≥ 0.8) → `BLOCKED_NEEDS_HUMAN` before anything is touched; weak advice → nothing |
| Unknown / unoffered action ids, bad numbers, unknown enumerations, contradictions | rejected whole (`normalizeAdvice` — 22 rejection assertions) |
| Fallback | provider down / never answers (2.5 s deadline) / nonsense / action never offered / out of range → the invoice task **completes exactly as without a provider** (1 draft, 0 issued); a failing provider is given up on after 2 asks per session |
| Disabled | no provider, or JEV without a key → never contacted (fetch spy = 0) |
| Privacy | across a full task, **none** of the customer name, line items, amounts, date, host, goal words appear in anything sent; the request type has no free-text field |
| Deterministic flows do not need JEV | every other suite (invoice E2E 15, browser task 10, desktop) runs with no advisor |

## 4. Routes

| Route | JEV advisory | Note |
|---|---|---|
| Chromium multi-step form (invoice) | **integrated, tested with a simulated provider** in real Chromium | `REAL_BROWSER_E2E`: PASS (simulated provider) — **not** a live JEV run |
| Windows Notepad | **not applicable** | the route is a fixed, verified recipe: it has no decision points to advise on. Its real run (`docs/evidence/NAGEX_WINDOWS_DESKTOP_CONTROL_E2E_20261016.md`) used no JEV. `REAL_WINDOWS_E2E`: PASS without JEV |
| Android Accessibility | **not run** | no device available in this work |

## 5. Final report block

```text
JEV_PROVIDER_VERIFIED      CONTRACT ONLY — System One request/answer shape verified from repository code + recorded live benchmark; NO live call (no credential)
JEV_SUPPORTED_DECISION_TYPES  choice, noul (used); score exists in the contract and is not used
JEV_DECISION_PORT          DecisionPort + DecisionAdvisor + normalizeAdvice + advisoryEffect (provider-independent); JevDecisionPort is one provider
JEV_ADVISORY_INTEGRATION   browser/device loop, after the hard checks, tighten-only; env-gated (NAGEX_JEV_DECISION_ENABLED + NAGEX_JEV_API_KEY)
POLICY_BOUNDARY_VERIFIED   PASS (real Chromium, simulated provider)
FALLBACK_VERIFIED          PASS (5 failure modes; circuit breaker)
REAL_BROWSER_E2E           PASS with a simulated provider; live JEV NOT RUN
REAL_WINDOWS_E2E           PASS without JEV (no decision points in the recipe)
NOT_DONE                   Android route; live JEV; benchmark against deterministic routing; acting on action disagreement or completion advice
RELEASE_NO_GO              true · DEPLOYMENT_NONE true · MAIN_UNTOUCHED true
```

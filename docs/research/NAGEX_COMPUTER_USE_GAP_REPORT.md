# NAgex Computer Use — Capability Gap Report

**Status:** EVIDENCE / POINT-IN-TIME (not canonical)
**Date:** 2026-10-16
**Branch:** `topic/computer-use-20261016`, base `39ecfffc1f833be119432bb953a01004d005e5dd`
**Release posture:** RELEASE = NO-GO · no deployment · `main` untouched

## 1. How to read the statuses

| Status | Meaning |
|---|---|
| `IMPLEMENTED_AND_REAL_E2E_PASS` | Code exists **and** was exercised end to end in a real browser by an automated test that passed |
| `IMPLEMENTED_NOT_REAL_E2E_VERIFIED` | Code exists; only unit/contract tests or no test in this slice |
| `PARTIAL` | Works for a stated part only |
| `MISSING` | Not implemented |
| `BLOCKED` | Cannot be done without something the project does not have or has not authorised |

**Qualifier that always applies.** "Real E2E" in this report means *real Chromium + the real NAgex server + the real Main UI*, against a **synthetic loopback website** (`tests/_invoice_app.ts`) and a **deterministic stand-in planner** (`tests/_invoice_planner.ts`). That proves NAgex's perception, loop, verification, approval and history. It does **not** prove a real model's planning quality and it is **not** a real third-party site. Where a real model was run, it is stated separately in the E2E report.

## 2. Browser action vocabulary

| Capability | Status | Evidence / note |
|---|---|---|
| Navigate | IMPLEMENTED_AND_REAL_E2E_PASS | public-URL policy enforced; loopback allowed only under `NAGEX_ALLOW_LOCAL_TEST_URLS` (tests); private/non-public addresses refused at task start |
| Observe (snapshot + screenshot + element map) | IMPLEMENTED_AND_REAL_E2E_PASS | element map with verified-unique selectors, field values added in this slice |
| Find (target an element among look-alikes, dynamic results) | IMPLEMENTED_AND_REAL_E2E_PASS | look-alike customers + search-as-you-type in the invoice fixture |
| Click | IMPLEMENTED_AND_REAL_E2E_PASS | consequential clicks held for approval; click expectation checked after the click |
| Type | IMPLEMENTED_AND_REAL_E2E_PASS | read-back verification (`verifyFieldWrite`); password fields never typed by the agent loop |
| Select | IMPLEMENTED_AND_REAL_E2E_PASS | new in this slice; read-back accepts label or value |
| Scroll | IMPLEMENTED_NOT_REAL_E2E_VERIFIED | in the vocabulary and policy; not exercised by the invoice journey |
| Keypress | IMPLEMENTED_AND_REAL_E2E_PASS | Enter/Space on a focused activator is treated as a click (approval); `tests/computer_use_keyboard_approval.test.ts` |
| Wait | IMPLEMENTED_NOT_REAL_E2E_VERIFIED | bounded 100–5000 ms; unit/contract level |
| Verify | IMPLEMENTED_AND_REAL_E2E_PASS | NAgex decides "the page shows X" (labelled values, word-boundary matching); a wrong total contradicts a "done" claim |
| Stop (DONE / BLOCKED) | IMPLEMENTED_AND_REAL_E2E_PASS | `BLOCKED` ends as "a person needs to step in"; DONE is subject to the failed-expectation check |
| **Upload** | **MISSING** | not in the action vocabulary; no file-chooser handling; would need approval + path allow-list |

## 3. Workflow, planner and loop control

| Capability | Status | Note |
|---|---|---|
| Multi-step workflow across pages (open → search → select customer → enter items → review → save draft, stop before issue) | IMPLEMENTED_AND_REAL_E2E_PASS | `computer_use_invoice_e2e` (14 tests) |
| Validation recovery (page rejects input, agent corrects) | IMPLEMENTED_AND_REAL_E2E_PASS | invalid quantity case |
| Loop guard (no progress, repeated idempotent writes) | IMPLEMENTED_AND_REAL_E2E_PASS | idempotent writes no longer count as progress |
| Planner behind a port (DOM-first via Model Gateway, vision fallback audited) | IMPLEMENTED_AND_REAL_E2E_PASS (stand-in model) | Gateway adapter journey passes with the real adapter and prompt against the local AI world |
| Real-model planning | PARTIAL | one cloud model (Gemini flash-lite) via the Gateway; run stopped at a provider 503 before the fixes; **no Nebius/NVIDIA model was called**. Result and re-run: see E2E report |
| Planner outage handling | IMPLEMENTED_AND_REAL_E2E_PASS | task PAUSES with work kept, Continue resumes |
| Prompt-injection resistance | IMPLEMENTED_AND_REAL_E2E_PASS (deterministic) | planted note in the page; page marked untrusted in the prompt; the approval gate holds even for a planner that obeys it. Not a measure of any model's robustness |

## 4. Sessions and authentication

| Capability | Status | Note |
|---|---|---|
| Managed browser session (NAgex-controlled Chromium profile per owner) | IMPLEMENTED_AND_REAL_E2E_PASS | owner/tenant isolation tests exist and pass |
| Login / MFA / CAPTCHA | PARTIAL | the task ends `NEEDS_PERSON`; no password typed; **no live handoff/takeover view** — the person cannot yet drive the same managed browser from the card |
| **Reuse of the user's own (local) browser session** | **MISSING** | not implemented and never claimed |
| Model access to credentials | none by design | verified: password fields refused in the agent loop |

## 5. Approval and trust (Phase F)

| Requirement | Status | Note |
|---|---|---|
| Consequential click/keypress held for approval | IMPLEMENTED_AND_REAL_E2E_PASS | decline, approve-once, changed-control cases |
| Approval bound to payload (target, URL, control) | IMPLEMENTED_AND_REAL_E2E_PASS | live URL used in the payload; a changed control requires a new approval |
| One-time use / no replay | IMPLEMENTED_AND_REAL_E2E_PASS | approval issues exactly once |
| Owner/tenant binding | IMPLEMENTED_AND_REAL_E2E_PASS | another person gets 404 on the task, screenshot and every control |
| Expiry | IMPLEMENTED_NOT_REAL_E2E_VERIFIED | the existing `ActionApprovalStore` expires a pending/approved approval (default 15 min, `NAGEX_APPROVAL_TTL_SECONDS`; status `EXPIRED`, error `APPROVAL_EXPIRED`); not exercised through the browser-task flow in this slice |
| Device binding | n/a for managed browser | applies to the desktop route (Mission B) |
| Second approval engine | none created | the existing Approval Authority is reused |

## 6. User experience (Phase G)

| Capability | Status | Note |
|---|---|---|
| Task card on Main (objective, current step, state), KO/EN | IMPLEMENTED_AND_REAL_E2E_PASS | `browser_task_browser` (10 tests) |
| Approval view with the real page screenshot | IMPLEMENTED_AND_REAL_E2E_PASS | |
| Pause / continue / cancel | IMPLEMENTED_AND_REAL_E2E_PASS | cancel of a waiting approval invalidates it |
| History after refresh and restart | IMPLEMENTED_AND_REAL_E2E_PASS | persisted history keeps no typed text; unfinished tasks are failed over/paused on restart |
| Live takeover (watch and drive the browser) | MISSING | see §4 |
| Mobile layout of the card | IMPLEMENTED_NOT_REAL_E2E_VERIFIED | styles exist; the browser test runs the desktop viewport |

## 7. Other routes (unchanged by this slice)

| Route | Status | Note |
|---|---|---|
| Native Windows desktop (Notepad + verified saved file) | **MISSING / not started** | enrollment, versioned desktop command, `onPendingCommand` wiring and the native controller build are Mission B; the dev PC is not enrolled; no real-device claim is made |
| Android via the existing Accessibility runtime | IMPLEMENTED_NOT_REAL_E2E_VERIFIED | `src/execution/mobile-app-accessibility-execution.ts` and device-agent transport exist; no real-device proof in this slice |
| JEV Decision Intelligence (`DecisionPort`) | MISSING | not started; the existing JEV *shadow advisory* in the router is separate and unchanged |
| Email-reply preparation / research + form entry scenarios | MISSING | Phase E scenarios 2 and 3 not yet built |
| Permitted real-site pilot | BLOCKED | needs an authorised account/session; none provided |

## 8. Known friction and limits (stated, not hidden)

- Checkbox/radio clicks and `type=submit` buttons are over-gated (treated as consequential): safe, but asks the person more than necessary.
- Browser sessions are not closed when a task ends (existing tests inspect the page after the task).
- The legacy Home capability tile for video still reads "planned".

# NAgex — Universal Device Control, hackathon critical path · increment 2 (2026-10-17)

**Status:** EVIDENCE (point in time) · **Release posture:** `RELEASE = NO-GO` · nothing deployed, `main` untouched, the Staging server not touched.
**Mission step:** Scenario C — a *different* Windows application reuses the same observe / plan / authorize / act / verify structure.

Everything below was run **for real on this Windows 11 PC** (the development PC, Korean UI). A scripted stand-in is always named as such. Base: `96e31e2` (increment 1) on the integration line.

## 1. What was added (and what was reused)

| | |
|---|---|
| **Reused unchanged** | enrollment, Ed25519 signed transport, `DESKTOP_EXECUTE_PLAN` v1, the approval store and its payload hash, replay / identity / expiry / busy guards, `DesktopAutomationPort`, the native UI Automation controller and its window-identity rule, the Main-screen task card, the routes' ask → approve → dispatch → status shape |
| **New: a second canonical action** | `device.desktop.calculator.calculate` (operation `CALCULATE`, operators `+ - *`, whole operands `0..999 999`, never a negative result). The server states the operands, the operator and the **expected result computed by NAgex itself**; the approval binds all of them |
| **New: window anchor** | the native controller accepts `expectAnchorId`: a candidate window must hold the application's result display (`CalculatorResults`). A packaged application's frame is shared by every packaged app, so class + process image alone cannot tell a Calculator from another; the anchor does |
| **New: the person's words** | deterministic reading of *"계산기로 17 곱하기 24 계산해줘"* / *"Use the Calculator to work out 1200 + 345"*; a question, a negated request ("don't calculate it", "계산하지 마") and anything unsupported are not requests |
| **New: routing** | a request becomes a desktop task only when an enrolled PC reports the Calculator capability; otherwise it is said plainly (no card, no approval) |
| **Capability list** | the device claims `desktop:UIA_INTERACTIVE:NOTEPAD` and `desktop:UIA_INTERACTIVE:CALCULATOR` only when the native controller is present |

## 2. The same loop, per environment (UNIVERSAL_CONTROL_PROOF)

| Phase | Windows · Notepad | Windows · Calculator | Browser (real Chromium) |
|---|---|---|---|
| **Observe** | counts the windows already open (never reads them); finds the one new window by handle + class + image | same; the new window must also hold `CalculatorResults`; reads the display (`0` after clear) | reads page text / elements through the browser tool service |
| **Plan** | a plan of *what* only (text, folder alias, file name) | a plan of *what* only (operands, operator, expected result) | the planner (model or scripted) proposes one step at a time |
| **Authorize** | one approval card; payload hash over every field; used once | same | one approval per consequential step; kill switch |
| **Act** | UI Automation patterns + targeted control messages to one verified child window | key presses by the keys' automation ids on the one verified window | click / type through the browser tool service |
| **Verify** | the file is read back from disk and compared with the approved text | every operand is read back from the display, the result is read from the display and compared with the expected result | `readExpectationSurface` / `matchExpectation`; NAgex contradicts a model's STOP claim without evidence |
| **Completion** | `DESKTOP_SAVED_VERIFIED` only after the read-back matched | `DESKTOP_CALCULATED_VERIFIED` only after the display matched | `COMPLETED` / `VERIFIED` only with `EXPECTATION_MET` |

Honest scope: the two Windows actions share one executor, transport, approval binding and guards - that reuse is real and tested. The browser loop shares the *contract* (approval before a consequential act, NAgex-side verification, no model-claim-only completion) but is a separate implementation bound to the browser tool service; **one unified trace record shown in both cards was not built**.

## 3. REAL results (Cycle 2)

`tests/desktop_task_real_ui.test.ts` (opt-in `NAGEX_REAL_WINDOWS_E2E=1`, run serially): real Chromium → real Main screen → this PC enrolled for real → real executor → **real native controller → real Windows Calculator**.

```text
KO  "계산기로 17 곱하기 24 계산해줘."          card in 330 ms; before Approve no Calculator window (asserted); Approve -> done 4 116 ms; total 6 700 ms
    card: 계산 17 × 24 · 계산기에 408이(가) 표시되는지 NAgex가 확인했어요 · "...화면에 표시된 결과를 읽었어요: 408. NAgex가 직접 계산한 값과 일치해요"
EN  "Use the Calculator to work out 1200 + 345."  card in 320 ms; Approve -> done 5 114 ms; total 7 702 ms; result 1545 read from the display, matched
steps (plain words): opened a new Calculator window · cleared it · entered the first number and checked the display · pressed the operator · entered the second number and checked the display · pressed equals · read the result from the display: it matches · closed Calculator
decline             nothing sent to the PC, no Calculator window opened
person's own window a Calculator the test opened beforehand (the stand-in for a window the person has open): same handle, same display text after the run; only NAgex's own window was closed
```

Regression on the same code, same PC, run serially: `desktop_windows_notepad_real` 5/5 and the Notepad cases of `desktop_task_real_ui` — **11/11 in total**.

**The one failure seen, and what it was.** The first combined run executed the two real files in parallel (the Node test runner's default) and failed 5 tests, both Notepad and Calculator. Each file counts and opens windows on the same screen, so they disturbed each other. The same files run one at a time passed 11/11, and the single failing Notepad case passed alone. This is a test-harness condition, not a product defect; the real files now say so in their header (`--test-concurrency=1`). It was not "fixed" by raising a wait.

**Human approval proof:** nothing happens before Approve (asserted by counting Calculator windows); Decline sends nothing; a used approval is refused (suite `desktop_calculate_command`). **Honest limit, unchanged:** the Approve click in the real test is made by browser automation standing in for the person.

## 4. Verification cycles (protocol: at most three)

| Cycle | Content | Result |
|---|---|---|
| 1 targeted | `desktop_calculate_executor`, `desktop_calculate_command`, `desktop_plan_executor`, `desktop_plan_command`, registry contract (49/49); real-Chromium `desktop_calculate_browser` + `desktop_task_browser` (13/13); i18n and router suites (240/240); first run had 3 defects (a stale capability expectation, my test's command ordering, a missing negation guard) - fixed, not retried blind | PASS |
| 2 integration / real E2E | real Windows run through the web UI: Calculator KO / EN / decline / person's own window kept; Notepad regression; the native controller rebuilt for it | PASS (11/11 serial) |
| 3 certification | build; regression gate `npm test`: **3 907 tests, 3 899 pass, 0 fail, 8 skipped** (the first run had 2 failures - the route inventory manifest was not updated for the 2 new routes, 395 → 397; fixed, not re-run blind); browser certification `npm run test:browser-cert`: **501 tests, 494 pass, 1 FAIL, 6 skipped** (see below); CI Windows + Ubuntu | regression PASS · browser certification **PARTIAL** · CI: see the report that carries the final SHA |

**The one browser-certification failure.** `design_system_v2_browser` › "Recent, Workspace, Knowledge and Activity", locale `ko`, Activity screen: *no text above weight 600 (750 실패함 | 750 작업 중)* - two status chips (`.badge-status`, `font-weight: 750 !important` in `public/product-design-convergence.css`) were on the Activity screen of a fresh test user. It is in no file this change touched (no CSS was changed). Facts: the same file run alone passes 8/8; run in parallel with `desktop_calculate_browser` and `desktop_task_browser` it passes 21/21; a probe of the Activity screen of three fresh Korean users showed **no chip** at 0, 1.5 and 4 s. The failing run was 2.2× slower than the passing one (48 s vs 22 s), so it is load-dependent, but **where those two Activity entries came from was not found** - the cause is unexplained and is not claimed. The chip weight itself is a real, separate contradiction of the Design System V2 rule (no weight above 600) that shows whenever an Activity entry exists. The CI run on the same SHA is the deciding evidence; a second failure there would be investigated as a product defect.

## 5. NOT done (stated plainly)

- One unified Observe-Plan-Authorize-Act-Verify trace object rendered in both cards (the table above is documentation of the shared structure, not a shared record type).
- A planner-driven desktop loop (the Windows route is still a fixed, verified recipe per application), applications beyond Notepad and the Calculator, Android.
- No run through a deployed server; the Electron shell was not run; a locked screen, UAC and multiple monitors were not tested.
- Astra and JEV were not called; no paid service was used.
- A cosmetic oddity, not fixed: a "다시 시도" (retry) button is shown beside the approval prompt while the task waits for approval.

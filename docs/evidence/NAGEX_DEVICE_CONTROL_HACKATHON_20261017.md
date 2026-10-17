# NAgex — Universal Device Control, hackathon critical path · increment 1 (2026-10-17)

**Status:** EVIDENCE (point in time) · **Release posture:** `RELEASE = NO-GO` · nothing deployed, `main` untouched, the Staging server not touched.
**Mission:** natural-language command in the NAgex web → the user's own Windows PC → real application → observe / plan / approve / act / verify → the result shown to the person.

Everything below was run **for real on this Windows 11 PC** (the development PC, Korean UI), against the integration code `e4a9d50` plus this branch's changes. A scripted stand-in or a synthetic site is always named as such.

## 1. What already existed (found by inspection - nothing was rebuilt)

| Piece | State on the integration line | Where |
|---|---|---|
| Device enrollment (Ed25519 key pair, signed CONNECT/HEARTBEAT, OS-protected credential), signed command transport, `DESKTOP_EXECUTE_PLAN` v1, device executor, native UI Automation controller (interactive mode), approval-bound payload, replay/identity/expiry refusal | **built and proven** on 2026-10-16 (`docs/evidence/NAGEX_WINDOWS_DESKTOP_CONTROL_E2E_20261016.md`) | `src/device-agent/*`, `native/windows-desktop-controller/*` |
| Main-screen approval card for a desktop request | built; proven with a scripted controller (`desktop_task_browser`) | `public/main-surface.js`, `src/device-agent/desktop-request-interpreter.ts` |
| Browser task agent (observe → propose → approve → act → NAgex-side verify), pluggable planner, kill switch, task card | built; proven in real Chromium on a synthetic site + one live real-model run | `src/device-control/*`, `src/modules/browser/*` |
| JEV `DecisionPort` (optional, tighten-only), Astra visual adapter | built, optional; no live JEV/Astra call is part of this mission | `src/device-control/*` |

## 2. AC1 - Windows, through the web UI (REAL)

`tests/desktop_task_real_ui.test.ts` (new, opt-in `NAGEX_REAL_WINDOWS_E2E=1`): real Chromium opens the real NAgex Main screen; the Korean request *"메모장을 열고 "NAgex Device Control Test"를 입력한 다음 문서 폴더에 NAgex-Test.txt로 저장해줘."* is typed; this PC is enrolled for real (key pair, signed transport); the real executor and the **real native controller** drive a real Notepad. The file is saved into a dedicated sub-folder of the real Documents folder (removed afterwards), so the existing `NAgex-Test.txt` and the person's open Notepad window are never touched.

```text
request -> card shown                  316 ms        card names the PC, the exact text, the file, "on the screen", waits; Approve / Decline
before Approve                         nothing written, no Notepad window opened (asserted)
Approve (click by browser automation)  -> done        6 142 ms
total, request to "done"               8 743 ms
file on disk                           25 bytes, content exactly "NAgex Device Control Test", SHA-256 bf2ae8d6862a039ebf2a939272acdae58052dfadc26c16b857d08b637be3cee2
Notepad windows (person's own)         1 before, 1 after - untouched; the window NAgex opened is closed
card steps (plain words)               새 메모장 창을 열었어요 · 내용을 작성하고 확인했어요 · 파일을 저장했어요 · 파일을 다시 읽어 일치함을 확인했어요 · 메모장을 닫았어요
decline                                nothing sent to the PC, no window opened, nothing written
```
Screenshots of the card (approval, done): scratchpad `device-evidence\real-ui-1-approval-card.png`, `real-ui-2-done-card.png`. Also re-run today on the same code: `desktop_windows_notepad_real` 5/5 (`COMPLETED / DESKTOP_SAVED_VERIFIED`, 6 s; Notepad process count 1 → 1).

**Human approval proof:** nothing happens before Approve; Decline sends nothing; a used approval is refused (existing suites). **Honest limit:** the Approve click in this test is made by browser automation standing in for the person - it proves the gate, not a human's click. The first real demonstration with a person is the same journey, done by hand.

## 3. AC2 - Browser, a real public site, a real model (REAL)

`scripts/computer-use-live-web.mjs` (new, opt-in script): real Chromium; **Korean Wikipedia**; planner = a **real model through the Model Gateway** (Gemini `gemini-flash-lite-latest`, the only provider key on this PC); the task is read-only (no sign-in, no edit); NAgex's own verification decides the outcome; the script never approves anything.

| Run | Outcome |
|---|---|
| 1 (before the fix below) | `TERMINATED / DEVICE_STOP_CONTRADICTED_BY_EVIDENCE:EXPECTATION_NOT_MET`: the model claimed success, **NAgex contradicted the claim** (the claim-vs-evidence guard works) - but its own check could not see a word that the article shows |
| 2 (after the fix) | **`COMPLETED`, completion `VERIFIED` (basis `EXPECTATION_MET`)**, 11 s, 6 steps, 6 model calls (all Gemini flash-lite); one step failed on a model-chosen selector and was recovered by the loop (recorded in `failedActions: 1`) |

**Defect found by the real run and fixed (a product defect, not an infrastructure or provider failure):** `readExpectationSurface` dropped a page's whole text when it was longer than the 60 000-character budget (`if (used + text.length > maxChars) { truncated = true; return; }`), so VERIFY on any long page - an encyclopedia article - looked at nothing and answered "NOT SHOWN". The failure direction was safe (never a false success) but made verification useless on real pages. Now a long block is **clipped to the budget and reported as cut**, never dropped, and the budget is 400 000 characters (read once per check, compared in memory, never sent to a model or stored). `tests/computer_use_long_page.test.ts` (5): 3 failed on the unchanged code, all pass after the fix; the 11 existing expectation tests still pass.

## 4. Verification cycles (protocol: at most three)

| Cycle | Content | Result |
|---|---|---|
| 1 targeted | defect reproduction (3 failing → 5/5), build, registry contract | PASS |
| 2 integration / real E2E | real Windows run through the web UI (2/2), real Notepad run (5/5), real-site browser run with a real model (COMPLETED / VERIFIED) | PASS |
| 3 certification | regression, browser certification, CI Windows + Ubuntu | see the report that carries the final SHA |

## 5. NOT done in this increment (stated plainly)

- **Scenario C (universal reuse):** the Windows route is still one canonical action (Notepad write-and-save) and the browser loop is bound to the browser tool service. A second real Windows application through the same approval / transport / read-back contract, and one shared observe-plan-authorize-act-verify trace shown in both cards, are increment 2. A feasibility spike showed Calculator opens a new, identifiable window whose controls are reachable by stable automation ids (`CalculatorResults`, `num7Button`, `multiplyButton`, `equalButton`) and can be closed by handle without leftovers.
- No run through a deployed server (Staging is behind Cloudflare Access; deployment needs approval); the Electron shell was not run; a locked screen, UAC and multiple monitors were not tested.
- The browser run used a model of low capability on one real site, once: it shows the loop works with a real model on a real page, not reliability.
- A cosmetic oddity seen in the screenshot, not fixed: a "다시 시도" (retry) button is shown next to the approval prompt while the task waits for approval.
- Astra: not called. JEV: not called. No paid service was used (the model is on a free tier).

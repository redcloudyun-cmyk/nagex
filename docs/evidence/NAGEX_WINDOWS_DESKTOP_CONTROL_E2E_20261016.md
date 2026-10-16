# Windows desktop control — Phase 2/3 evidence (real Notepad end to end)

**Status:** EVIDENCE (point-in-time; not canonical architecture — see `docs/canonical/NAgex_Execution_and_Cross_Platform_Architecture.md` §11.1)
**Date:** 2026-10-16
**Branch:** `topic/computer-use-20261016` (follows the Phase 1 audit `NAGEX_DESKTOP_DEVICE_CONTROL_PHASE1_20261016.md`)
**Release posture:** RELEASE = NO-GO · no deployment · `main` untouched

## 1. What was asked and what was run

> "메모장을 열고 다음 문장을 작성한 뒤, 내 문서 폴더에 `NAgex-Test.txt`로 저장해줘."  — content: `NAgex Desktop Agent 실기기 제어 검증 — 2026-10-16`

This was run **for real on the development PC** (Windows 11, Korean UI, Notepad `Microsoft.WindowsNotepad 11.2607.14.0`): a real NAgex server (in-process, real HTTP, isolated stores, disposable people), this PC **enrolled** as a device, the plan **approved** through the normal approvals API, **dispatched**, received by the **real Local Device Agent runtime** on a heartbeat, carried out by the **real executor and the real native controller** in a **real Notepad window on the real desktop**, and the file **read back from disk and compared**.

Two runs, both `5/5`:

| Run | Target | Result |
|---|---|---|
| Dedicated sub-folder of Documents (removed afterwards) | `Documents\NAgex-Desktop-E2E-<id>\NAgex-Test.txt` | `COMPLETED` · `DESKTOP_SAVED_VERIFIED` · 11 s |
| **The literal scenario** | `C:\Users\redcl\Documents\NAgex-Test.txt` (**left in place: it is the requested result**) | `COMPLETED` · `DESKTOP_SAVED_VERIFIED` · 10 s |

Independent check of the literal result, made outside the test: the file exists, **58 bytes, no BOM, text identical to the requested sentence**, SHA-256 `1f4cde85…8237` (the same value the device reported). The Notepad window that was already open before the run (handle `3213604`, title length 42) was **the same window with the same title length afterwards**; the process stayed responsive; no window was left behind.

Device steps reported (flat evidence, no document text, no folder path): `ACCEPTED → CONTROLLER_STARTED → APP_WINDOW_FOUND_BY_HANDLE → DOCUMENT_IS_BLANK → TEXT_ENTERED_AND_READ_BACK → FILE_MENU_OPENED → SAVE_AS_OPENED → FILE_NAME_ENTERED_AND_READ_BACK → SAVE_PRESSED_DIALOG_CLOSED → FILE_READ_BACK_MATCHES_APPROVED_TEXT → WINDOW_CLOSED`.

## 2. The journey, link by link (Phase 1 audit → now)

| # | Link | Phase 1 | Now |
|---|---|---|---|
| 1 | Desktop app starts the Local Device Agent runtime | IMPLEMENTED | unchanged; construction moved into one function (`startDeviceAgent`) so there is still exactly one runtime |
| 2 | **Enrollment of this PC** | MISSING | **IMPLEMENTED and REAL**: `device-enrollment.ts` (Ed25519 key pair generated on the device; public key + the person's own session to `POST /api/v1/device-agent/enroll`; tenant/owner come only from the session; private key only in the local credential store). Tray entry "Enroll this PC" added to the Electron shell (**not run**, see §5). Real run: the enrolled credential then authenticated over the signed transport |
| 3 | Authenticate + heartbeat | IMPLEMENTED | used for real in the run |
| 4 | Command delivery server → agent | DELIVERED but DROPPED on the agent | **IMPLEMENTED**: `onPendingCommand` wired (`desktop-plan-wiring.ts`); delivered once; the device reports back (`ACK` with stage + result code + bounded evidence) |
| 5 | Command vocabulary can express a desktop action | MISSING | **IMPLEMENTED**: `DESKTOP_EXECUTE_PLAN` v1 — *what*, never *how*: no program path, shell, folder path, UI step, coordinate or keystroke can be expressed |
| 6 | Policy, approval, allowlist, audit | IMPLEMENTED (server-hosted route) | extended: the plan is bound to an approval of **all** fields; the device applies its own allowlist and folder policy |
| 7 | Windows executor | SOURCE ONLY | **BUILT** (`build.ps1` → `BUILD_OK`) **and extended** (interactive mode, selectors, expand, file-dialog primitives, safe close); **used for real** |
| 8 | Where the executor runs | TOPOLOGY MISMATCH | resolved: the executor runs **inside the device agent**, driven by the desktop command |
| 9 | Real Windows E2E | NONE | **PASS** (above) |

## 3. What this PC taught us (measured, not assumed)

1. **Notepad cannot run on the controller's hidden desktop.** On this Windows 11, every `notepad.exe` path resolves to the *packaged* application, which is activated on the user's desktop; `OPEN_APP` on the isolated desktop timed out (`APP_WINDOW_NOT_FOUND`). The route therefore needs an **interactive** mode — on the person's real desktop, so the approval says so ("on your screen").
2. **Process id cannot identify the window.** Launching Notepad while one is open creates a *new window inside the same process* as the person's own window. Identity is the **window handle**: a new top-level window of class `Notepad` owned by a process image containing `notepad.exe`; windows that existed before the launch are counted and never read or touched.
3. **UI Automation reaches the editor and the menu** (a `Document` of class `RichEditD2DPT` with the Value pattern; the File menu by its stable automation id), but menu items carry **localized names** and no ids. The device profile lists `Save as` per language (`다른 이름으로 저장`, `Save as`); an unknown language **fails closed** (`SAVE_AS_NOT_FOUND`).
4. **The Save As dialog is a classic Win32 dialog whose file-name box and buttons expose no UIA patterns.** Setting the box with a single `WM_SETTEXT` reads back correctly **but the dialog ignores it and saves under its own default name** (found when a probe saved into the Downloads folder; the stray probe file was identified by exact content and removed). Entering the path **character by character with `WM_CHAR`** to that one verified control works; `BM_CLICK` on the verified Save button completes it. AutomationIds in that dialog are **not unique** (`1001` and `2` also occur elsewhere), so controls are matched by class + id + parent.
5. **A packaged application's writes under `AppData` are redirected** into its private store (invisible to every other process). The device's folder policy therefore refuses roots under `AppData`/temp; Documents is not virtualized.
6. The dialog's file view lists the person's recent files: the controller never returns directory or list contents, and evidence never contains text or paths.

## 4. Negative tests (each with where it is proven)

| Case | Result | Proven in |
|---|---|---|
| Device not enrolled | `DEVICE_NOT_FOUND`; nothing asked | `desktop_plan_command` (unit), real E2E |
| Command for another device / user / tenant | `IDENTITY_MISMATCH`, controller never started | `desktop_plan_executor` (fake port) |
| Wrong user or tenant on the server side | `DEVICE_NOT_FOUND`; another person's approval/plan reads as absent | `desktop_plan_command`, real E2E (stranger) |
| Expired plan | refused on the server (`DESKTOP_PLAN_EXPIRED`) and on the device (`COMMAND_EXPIRED`) | both unit suites |
| Approval pending / declined / other tool / other fields / used | `APPROVAL_NOT_GRANTED` / `…TOOL_MISMATCH` / `…PAYLOAD_MISMATCH` / `…ALREADY_CONSUMED`; a refused attempt does not burn the approval | `desktop_plan_command`; real E2E (declined, early dispatch, replay) |
| Replay | same approval → `APPROVAL_ALREADY_CONSUMED`; same plan/command on the device → `COMMAND_REPLAY` (also after a restart) | unit + real E2E |
| Unauthorized path | `..\`, `C:\`, folders, `.bat`, reserved names → refused on server and device; roots under `AppData`/temp, missing folder → `PATH_NOT_ALLOWED` | unit; real E2E (`400`) |
| Existing file | the device refuses to replace it (`TARGET_FILE_EXISTS`); real run confirmed the file unchanged and no window opened | unit + **real E2E** |
| Unexpected window | ambiguous new windows → `UNEXPECTED_WINDOW`, nothing typed | `desktop_plan_executor` (fake port) |
| Controller unavailable | `CONTROLLER_UNAVAILABLE`; capability is not advertised | unit |
| Verification mismatch | content differs / empty / missing file → `FAILED` with the facts, never `COMPLETED` | unit |
| Failure after the window opened | only its own window is closed, discarding only what it typed | unit (fake port) |

The unit suites that use a scripted controller port are labelled as such; **they do not count as real-device evidence.** The real run covers the positive path and the negatives above that it lists.

## 5. What is NOT proven (stated plainly)

- **The Electron shell was not run.** The same runtime, executor, enrollment and wiring modules ran in plain Node on the real PC; the Electron wiring (`startDeviceAgent`, the tray "Enroll this PC", `app.getPath('documents')`, `electronSession` cookie read) compiles and its architecture test passes, but it has **not been exercised in a running app**.
- **Only Notepad, only a single line of text, only Documents, only `ko-KR`.** The English menu name is Notepad's documented one and is unverified here; other languages fail closed.
- **This is a fixed, verified recipe for one application, not a planner-driven desktop agent.** The amendment's generic loop (perceive → plan → authorize → act → verify across arbitrary apps) is **not** implemented for desktop. "Universal" is not claimed.
- **Interactive desktop only:** the window appears on screen for a few seconds. The person must be signed in to an unlocked desktop; a locked screen, UAC prompts, multiple monitors and remote sessions were not tested.
- **CI does not run the real-PC test** (it is `LIVE_EXTERNAL`, skipped with an explicit reason). Its result is this document.
- No Android proof and no JEV integration were done in this slice.
- Dialog entry uses targeted control messages (`WM_SETTEXT`/`WM_CHAR`/`BM_CLICK`) to one verified control; this is not global input injection (the repository's `NO_GLOBAL_INPUT_INJECTION` test still passes) but it is synthetic input to that control and is disclosed as such.

## 6. Re-running

```text
powershell -File native/windows-desktop-controller/build.ps1                  # builds the two .exe files (gitignored)
npm run build
$env:NAGEX_REAL_WINDOWS_E2E = '1'                                              # required: this drives a real application
$env:NAGEX_REAL_E2E_USE_DOCUMENTS = '1'                                        # optional: save into the real Documents folder (the file is left there)
node --require ./dist/tests/_setup.js --test dist/tests/desktop_windows_notepad_real.test.js
```

Without `NAGEX_REAL_WINDOWS_E2E=1` the file is skipped with `REAL_WINDOWS_E2E_NOT_REQUESTED`.

## 7. Final report block (desktop)

```text
WINDOWS_DEVICE_ENROLLED   PASS (real, this PC; credential authenticated over the signed transport)
DESKTOP_WIRE_PROTOCOL     DESKTOP_EXECUTE_PLAN v1 (versioned; WHAT-not-HOW; approval-bound; sanitized evidence on ACK)
COMMAND_DISPATCH          PASS (heartbeat delivery once; onPendingCommand wired; device report stages EXECUTING/COMPLETED/FAILED)
NATIVE_CONTROLLER_BUILD   PASS (build.ps1 → BUILD_OK; extended with interactive mode, selectors, expand, dialog primitives, safe close)
NOTEPAD_REAL_E2E          PASS (2 real runs, 5/5 each; literal scenario saved C:\Users\redcl\Documents\NAgex-Test.txt)
FILE_VERIFICATION         PASS (58 bytes, no BOM, text identical, SHA-256 matches device evidence; independently re-read)
APPROVAL_NEGATIVE_TESTS   PASS (unit + real; see §4) — fake-port suites labelled as such
NOT_PROVEN                Electron shell run; other apps/languages; multi-line text; planner-driven desktop loop; locked screen/UAC
RELEASE_NO_GO             true · DEPLOYMENT_NONE true · MAIN_UNTOUCHED true
```

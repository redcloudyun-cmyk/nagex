# Desktop device control — Phase 1 (read-only verification)

**Status:** EVIDENCE (point-in-time, static + local-machine inspection; nothing was changed, started or connected)
**Date:** 2026-10-16
**Revision:** integration `9631e0cedaa74258c8c3c87514d8342793a01c41`
**RELEASE = NO-GO.**

The directive that opened this work was cut off before its scenario ("Phase 3 — Scenario: …"). This document is Phase 1 only: where the Windows desktop-control journey stops today. Nothing below was executed against a live server or a live Windows application.

## 1. The journey, link by link

| # | Link | State | Evidence |
|---|---|---|---|
| 1 | Electron Desktop App starts the Local Device Agent runtime | **IMPLEMENTED** | `src/desktop/desktop-app.ts:645` builds `LocalDeviceAgentRuntime`, starts it, and wires sleep / resume / lock to suspend / re-authenticate / drop; tests `device_agent_electron_runtime` (idle-safe, revoked-safe, resume re-auth, no timer leaks). |
| 2 | **Enrollment of this PC** | **MISSING** | The server route exists (`POST /api/v1/device-agent/enroll`, session-authenticated, `device-agent.routes.ts:145`) and the credential store exists (`LocalDeviceCredentialStore`, OS-protected storage with a disclosed plaintext fallback). But nothing on the desktop side generates the device key pair (`generateKeyPair*` appears nowhere in `src/`), calls the enroll route, or writes the credential. The tray shows "Device Agent: Enrollment required". On this PC `~/.nagex/desktop/` exists and is empty: **not enrolled**. |
| 3 | Authenticate + heartbeat | **IMPLEMENTED, unreachable without 2** | Signed-envelope transport (`device-transport-security`, `device-agent-transport-endpoint.service`), CONNECT / HEARTBEAT / DISCONNECT, degraded / backoff states; tested in-process with a test-provisioned credential. Without a credential the runtime stays `UNENROLLED` and never builds a client. |
| 4 | Command delivery server → agent | **IMPLEMENTED on the server, DROPPED on the agent** | The server queues a command and the next heartbeat answer carries it (`pendingCommand`, marked delivered). `LocalDeviceAgentRuntime.tick()` hands it to `options.onPendingCommand` — and **`desktop-app.ts` does not pass one**, so a delivered command is discarded; no ACK is sent back. |
| 5 | The command vocabulary can express "control a Windows app" | **MISSING** | `DeviceAgentCommandType` (`device-agent-protocol.ts`) is a closed allowlist: connection commands, `APP_LINK_OPEN`, `MOBILE_MESSAGE_*`, `MESSAGING_HANDOFF_*`, `ACCESSIBILITY_EXECUTE_PLAN` (Android). There is no OPEN_APP / OBSERVE / SET_VALUE / INVOKE for a desktop. |
| 6 | Policy, approval, allowlist, audit for a desktop action | **IMPLEMENTED** | `DesktopControlService` (`startSession` / `resumeSession`): tenant / owner / device / session checks, `DesktopAppAllowlist`, frozen-action approval consumed exactly once, audit + activity. Tested (`desktop_control_service`). |
| 7 | Windows executor (UI Automation on an isolated desktop) | **SOURCE ONLY on this machine** | `native/windows-desktop-controller/*.cs` + `build.ps1`; **`NagexDesktopController.exe` is not built here**, so `WindowsIsolatedDesktopController.isAvailable()` is false and the Capability Broker's `DEVICE_DESKTOP` provider reports unavailable (truthful). Code comments cite earlier real-host proof (DC3-B2-R1…R3); the only document in the tree that mentions DC3-B2 is an archived, superseded amendment, so it is **not re-verified here**. |
| 8 | Where the executor runs | **TOPOLOGY MISMATCH** | `WindowsIsolatedDesktopController` spawns the `.exe` as a child of the process that hosts `DesktopControlService`, i.e. the NAgex server. That works only when the server runs on the Windows machine being controlled. With the hosted server (Linux, `nagex-server`) and the user's PC reached through the Device Agent, the executor would have to run **inside the Electron agent**, driven by a desktop command from link 5 — it does not today. |
| 9 | Real Windows E2E | **NONE** | No test or run drives a real Windows application through NAgex end to end. `desktop_windows_real_ux_cert` covers audio output and the notification popup only. |

## 2. First missing component

Links 2, 4 and 5 are each blocking, in this order of dependency:

1. **Enrollment** (key pair → `POST /enroll` with the signed-in session → credential saved). Until this exists the agent never authenticates, so every later link is unreachable on a real PC.
2. **A desktop command in the wire protocol** (a bounded vocabulary that maps one-to-one to `DesktopControlService` actions, never a free-form shell / SendInput) and **an agent-side handler** wired through `onPendingCommand` that verifies the command against the agent's own identity, executes through the local executor and reports a truthful result (ACK / status), including "could not do it".
3. **A local executor the agent can run** — the existing isolated-desktop UIA controller built and shipped with the app, or an alternative evaluated in Phase 2.

## 3. What Phase 2 would compare (needs the scenario)

Windows UI Automation through the existing controller; official application APIs where the target app has one (preferred by the directive); the existing Browser Runtime for web apps; Astra only if the target has no accessible UI tree. The choice depends on the scenario's target application, which did not arrive.

## 4. Constraints that stay

Approval for every consequential action (credentials and voice do not grant permission); the allowlist; no global input injection (`NO_GLOBAL_INPUT_INJECTION` is an existing architecture test); tenant / owner isolation; truthful status (an accepted command is not a completed one).

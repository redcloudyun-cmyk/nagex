# NAgex Automated Test-Server Verification & Capability Broker Freeze Gate

This document describes the operational automated verification framework for the NAgex Test Server (`https://nagex-test.agex.site`).

## Overview & Architecture

The verification suite separates safe, read-only checks from explicit external write operations (Live E2E):

```
       nagex-update (Deploy code & restart)
             │
             ▼
        nagex-check (Safe read-only verification)
             │
             ▼
     nagex-e2e-live (Explicit write E2E & replay validation)
```

- **`nagex-check`**: Safe read-only & non-side-effect checks. Runs autonomously without external state mutations.
- **`nagex-e2e-live`**: Explicit Live E2E tests containing real external writes (Gmail send, Calendar event create, Browser form submit) and strict approval replay validation.

---

## 1. Safe Deployment Check (`nagex-check`)

Command:
```bash
scripts/nagex-check.sh
# Symlinked binary: nagex-check
```

### Safety Principles
`nagex-check` NEVER performs external mutations:
- No Gmail actual email sending
- No Calendar event creation/modification/deletion
- No Browser consequential form submission
- No approval bypassing or CAPTCHA/MFA bypassing

### Automated Check Scope
1. **Repository**:
   - `git status --porcelain`: Ensures working tree is clean.
   - `git rev-parse HEAD` vs `origin/main`: Ensures HEAD matches `origin/main`.
   - `npm run build`: Verifies TypeScript compilation.
   - `npm test`: Executes the complete test suite.
   - `.tmp_test` leak check: Ensures test artifacts do not leak into working tree.
2. **Service**:
   - Local health: `curl -fsS http://127.0.0.1:4100/health`
   - Public health: `curl -fsS https://nagex-test.agex.site/health`
3. **Google OAuth**:
   - Status check (`GET /api/v1/oauth/google/status`): Ensures `configured: true` and `connected: true`.
   - Verified scopes (`calendar.events`, `calendar.events.freebusy`, `calendar.calendarlist.readonly`, `gmail.modify`).
4. **Capability Broker**:
   - Read-only Calendar FreeBusy (`google_calendar.free_slots` via Capability Broker).
   - Read-only Gmail Search (`gmail.search` via Capability Broker).
5. **Browser Agent**:
   - Open session -> navigate `https://example.com/` -> snapshot -> extract -> SSRF block check (`http://127.0.0.1:4100/` blocked with `BROWSER_UNSAFE_URL`) -> close.
6. **Architecture & Safety**:
   - Direct-call bypass static scan: Ensures planner/runtime/tasks/agents do not bypass Capability Broker by directly invoking service singletons.

### Machine-Readable Logs
Generates `/var/log/nagex/latest-check.json` (or `$HOME/.local/state/nagex/logs/latest-check.json`).

---

## 2. Live External E2E (`nagex-e2e-live`)

Command:
```bash
scripts/nagex-e2e-live.sh
# Symlinked binary: nagex-e2e-live
```

### Interactive Confirmation
Unless invoked with `--yes` or `-y`, `nagex-e2e-live` prompts for explicit user confirmation:
```
This LIVE E2E test will perform real external actions:

- send one test Gmail message
- create one Google Calendar test event
- execute one controlled browser form submission

Continue? [y/N]
```

### Live Test Scope & Replay Verification
1. **Gmail Live E2E**:
   - Request approval via Capability Broker (`gmail.send_email`).
   - Grant approval via `/api/v1/approvals/:id/approve`.
   - Execute send via `/api/v1/tools/gmail/send-email`.
   - Verify replay attempt returns `HTTP 409 APPROVAL_ALREADY_CONSUMED`.
2. **Google Calendar Live E2E**:
   - Request approval via Capability Broker (`google_calendar.create_event`).
   - Grant approval via `/api/v1/approvals/:id/approve`.
   - Execute event creation via `/api/v1/tools/google-calendar/create-event`.
   - Verify replay attempt returns `HTTP 409 APPROVAL_ALREADY_CONSUMED`.
3. **Browser Agent Live E2E**:
   - Navigate to controlled test endpoint (`https://httpbin.org/forms/post`).
   - Structured snapshot verification.
   - Consequential click request (`APPROVAL_REQUIRED`).
   - Grant approval via `/api/v1/approvals/:id/approve`.
   - Execute approved click via `/api/v1/tools/browser/click/execute`.
   - Verify replay attempt returns `HTTP 409 APPROVAL_ALREADY_CONSUMED` deterministically.

---

## 3. Capability Broker Freeze Gate

To declare Capability Broker as **FROZEN**, all verification items in `nagex-check` and `nagex-e2e-live` must pass cleanly:

```
==========================================
 CAPABILITY BROKER FREEZE GATE: PASS
==========================================
```

### Operational Workflows
- **Routine Deployment**: `nagex-update` followed by `nagex-check` (or `nagex-update --verify`).
- **Release / Capability Broker Freeze**: `nagex-update` -> `nagex-check` -> `nagex-e2e-live`.

---

## 4. Test-Only Deterministic Plan Injection (V01a)

`POST /api/v1/tasks/:id/run-with-fixed-plan` lets a Task run be driven through the real `PlanResolver`/`ExecutingTaskRunner`/`CapabilityBroker` pipeline with a caller-supplied plan (`{ steps: [...] }`, the same raw shape `AiService.plan()` normally produces), instead of a real, variable-shape LLM call. It exists solely so `nagex-task-e2e-live` (V01, Durable Task Restart/Resume LIVE E2E) can exercise a deterministic multi-step Task run — no other consumer should ever call it.

**Isolation:**
- The route **does not exist** (falls through to the ordinary 404, indistinguishable from any unmatched path) unless the environment variable `NAGEX_ENABLE_TEST_PLAN_INJECTION` is exactly `'1'`, re-checked on every request — never cached, never assumed off after the first check.
- **Never set this variable in the real production environment's persistent env.** Export it only in the shell session running a V01 harness invocation, for that invocation's duration.
- Only the planning LLM call is substituted — `PlanResolver.resolve()` and everything downstream (step execution, durable state, approval continuation, finalization) is the real, unmodified production path, writing to the same real stores a normal run would.

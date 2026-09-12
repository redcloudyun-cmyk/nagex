# NAgex Development Handover Document (인수인계 문서)

> **Last Updated:** 2026-09-10  
> **Target LLM Agent / Developer:** Claude (or incoming developer)  
> **Status:** All build checks green (`npm run build` PASS, `npm test` 133/133 PASS, clean process exit)

---

## 1. Executive Summary & Product Boundary

NAgex (**Next-generation Agent Experience / Next Age**) is a Personal AI / Agentic AI system centered on:
- Persistent memory & context
- Reasoning & planning (PlanPreview, Conditional Watch)
- Skill & tool execution via a centralized **Capability Broker**
- PDP (Policy Decision Point) governance and human approval gates
- Multi-model gateway routing (NVIDIA Nemotron / Nebius integrations)
- Clean, auditable execution & restart persistence

**Governing Rules & Reading Order:**
1. Read `MASTER.md` (Level 0 product contract).
2. Read `AGENTS.md` (Developer operating rules).
3. Read `docs/INDEX.md` and relevant domain docs under `docs/`.
4. Inspect domain tests before modifying implementation.

---

## 2. Recent Major Accomplishments & Key Fixes

### A. Production Graceful Shutdown (`SIGTERM` / `SIGINT`)
- **Problem Fixed:** `nagex.service` timed out after 90 seconds during `systemctl restart` and was force-killed by `SIGKILL`.
- **Root Cause Identified:** Playwright Chromium initialization auto-registered `process.on('SIGTERM')` in `playwright-core`, which disabled Node's default exit behavior. Because `src/server_web.ts` had no custom `SIGTERM` listener, `http.Server` stayed open on port 8085, keeping the Node event loop alive indefinitely.
- **Solution Implemented (`src/server_web.ts`):**
  - Captured `serverInstance` from `server.listen()`.
  - Added `closeHttpServer()` with `closeIdleConnections()` draining active HTTP requests.
  - Added `await browserRuntime.shutdown()`.
  - Installed `SIGTERM` / `SIGINT` / IPC `message` listeners with duplicate execution guard (`shuttingDown` boolean).
  - Added unref'd 10-second bounded safety timeout fallback (zero `process.exit()` in successful path).
- **Result:** Shutdown duration reduced from **90 seconds (force kill)** to **~370 ms (clean natural exit)**.
- **Test File Added:** `tests/graceful_shutdown.test.ts` (4/4 test cases PASS).

### B. Systemd Process Hierarchy Optimization (Prepared for Host Apply)
- Identified process indirection issue (`systemd` -> `npm` -> `sh` -> `node`).
- Prepared direct execution model (`ExecStart=/usr/bin/node /path/to/dist/src/server_web.js`) for systemd unit update.

### C. Capability Broker & Conditional Watch Migration
- `ConditionalWatchTaskRunner` migrated to execute all browser operations (`open`, `navigate`, `snapshot`, `close`) strictly through `CapabilityBroker`.
- Guaranteed `browser.close` execution in `finally` blocks.
- Fail-closed handling for CAPTCHA/human verification (`BROWSER_HUMAN_VERIFICATION_REQUIRED`) and SSRF protection (`BROWSER_UNSAFE_URL`).

### D. Verification Harness & Shell Script Portability
- POSIX shell scripts (`scripts/nagex-check-common.sh`, `nagex-check.sh`, `nagex-e2e-live.sh`, `nagex-update.sh`) fixed for option parsing safety (`printf '%s\n' '---'`).

---

## 3. Key Architecture & File Map

| Domain / Component | Source File Path | Description |
|---|---|---|
| **Web Server & Entrypoint** | [src/server_web.ts](file:///f:/%EA%B0%9C%EB%B0%9C%20%ED%94%84%EB%A1%9C%EC%A0%9D%ED%8A%B8/Nagex%20project/src/server_web.ts) | Main HTTP API server, health routes, static file serving, and `SIGTERM`/`SIGINT` graceful shutdown handlers. |
| **Capability Broker** | [src/capabilities/capability-broker.ts](file:///f:/%EA%B0%9C%EB%B0%9C%20%ED%94%84%EB%A1%9C%EC%A0%9D%ED%8A%B8/Nagex%20project/src/capabilities/capability-broker.ts) | Central routing hub for browser tools, Google Calendar, and Gmail integration capabilities. |
| **Browser Runtime** | [src/integrations/browser/browser.runtime.ts](file:///f:/%EA%B0%9C%EB%B0%9C%20%ED%94%84%EB%A1%9C%EC%A0%9D%ED%8A%B8/Nagex%20project/src/integrations/browser/browser.runtime.ts) | Playwright Chromium lifecycle management (singleton instance, shared browser, graceful shutdown). |
| **Browser Tool Service** | [src/tools/browser.service.ts](file:///f:/%EA%B0%9C%EB%B0%9C%20%ED%94%84%EB%A1%9C%EC%A0%9D%ED%8A%B8/Nagex%20project/src/tools/browser.service.ts) | High-level browser action execution (open, navigate, snapshot, click, fill, screenshot). |
| **Task Scheduler & Runners** | [src/tasks/task.scheduler.ts](file:///f:/%EA%B0%9C%EB%B0%9C%20%ED%94%84%EB%A1%9C%EC%A0%9D%ED%8A%B8/Nagex%20project/src/tasks/task.scheduler.ts)<br>[src/tasks/task.runner.ts](file:///f:/%EA%B0%9C%EB%B0%9C%20%ED%94%84%EB%A1%9C%EC%A0%9D%ED%8A%B8/Nagex%20project/src/tasks/task.runner.ts) | Background task scheduler (`tick`) and task runners (`PlanPreviewTaskRunner`, `ConditionalWatchTaskRunner`, `CompositeTaskRunner`). |
| **Action Safety Gate & PDP** | [src/governance/safety.engine.ts](file:///f:/%EA%B0%9C%EB%B0%9C%20%ED%94%84%EB%A1%9C%EC%A0%9D%ED%8A%B8/Nagex%20project/src/governance/safety.engine.ts)<br>[src/identity/pdp.ts](file:///f:/%EA%B0%9C%EB%B0%9C%20%ED%94%84%EB%A1%9C%EC%A0%9D%ED%8A%B8/Nagex%20project/src/identity/pdp.ts) | Risk evaluation engine and Policy Decision Point for human-in-the-loop approvals. |
| **Model Gateway** | [src/model-gateway/ai-service.js](file:///f:/%EA%B0%9C%EB%B0%9C%20%ED%94%84%EB%A1%9C%EC%A0%9D%ED%8A%B8/Nagex%20project/src/model-gateway/ai-service.ts)<br>[src/model-gateway/unified-model-router.ts](file:///f:/%EA%B0%9C%EB%B0%9C%20%ED%94%84%EB%A1%9C%EC%A0%9D%ED%8A%B8/Nagex%20project/src/model-gateway/unified-model-router.ts) | Model provider abstraction (NVIDIA, Nebius, OpenAI fallbacks) and prompt engineering. |

---

## 4. Mandated Operational Protocols for Claude / Developers

1. **High-Confidence Development Protocol (`AGENTS.md`):**
   - **Phase 0:** Read full production code, types, caller/callee chain, runtime response shapes, and tests before writing code.
   - **Phase 1:** State Root Cause & Evidence before editing.
   - **Phase 2:** Perform minimal, surgical implementation.
   - **Phase 3:** Run mandatory verification commands.

2. **Mandatory Verification Workflow Before Completing Any Task:**
   ```bash
   npm run build
   node --require ./dist/tests/_setup.js --test dist/tests/<affected_test>.test.js
   npm test
   git status
   ```
   - Must achieve **133+ test suites / 729+ assertions passing**, 0 failures, 0 skipped.
   - Must confirm natural process termination (no hanging background processes).
   - Must maintain a clean git working tree.

3. **Security Invariants:**
   - Never hardcode secrets or API keys.
   - Never bypass human approval for write/consequential operations.
   - Never call `process.exit()` in successful runtime code paths unless explicitly specified in emergency fallbacks.

---

## 5. Next Planned Tasks & Backlog

1. **Systemd Deployment Configuration:**
   - Run `systemctl cat nagex.service`, `command -v node`, `readlink -f "$(command -v node)"` on Ubuntu target server.
   - Apply direct Node entrypoint in `/etc/systemd/system/nagex.service`.
2. **Nebius x NVIDIA Hackathon Roadmap (Phase H1–H5):**
   - Continue implementing persistent context memory, multi-channel capabilities (Slack/Telegram), and governance features as outlined in `MASTER.md`.

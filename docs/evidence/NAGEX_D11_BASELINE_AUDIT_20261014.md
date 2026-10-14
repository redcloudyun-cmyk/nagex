# NAgex D-11 Baseline Audit — release truth inventory

**Date:** 2026-10-14 (KST) · **Method:** read-only. No restart, deploy, merge, environment change or data write was made. Secret **values** were never printed (presence / length only).
**Labels:** PASS / FAIL / BLOCKED / NOT_RUN. "UNKNOWN" is used only where no reliable fingerprint exists.

> A GitHub head being current says nothing about the deployed server. Each row below states what was actually observed and where.

## 1. Git relationships (GitHub, fetched 2026-10-14)

| Ref | SHA | Relation |
|---|---|---|
| `origin/main` | `9d3ccc8` (2026-09-28) | behind the integration branch by **185** commits, ahead by 0 (a fast-forward) |
| `origin/integration/r23.7-agex-mcp-20261013` | `15d081b` | = `faf38cc` (my merge, deployed) + PR #12 (connectable apps) + the D-11 plan doc |
| PR #13 `feat/mcp-oauth-discovery-20261013` | `add8ae3` | OPEN → integration; 54 commits not in integration, integration has 1 (the plan doc) it lacks; the newest commit is docs only. Real Slack OAuth is BLOCKED; **not** in the demo path |
| PR #12 | merged into integration | |
| PR #11 `feat/agex-assets-mcp-20261013` | `1aa95d6` | OPEN, base `integration/r23.7-20261013`; its content is already contained in the integration head → can be closed as superseded |

Result: **REPO_INTEGRATION_SHA = `15d081b`**. PASS (facts), no merge performed.

Baseline gate on the integration head `15d081b` (fresh worktree, 2026-10-14): build exit 0; `npm test` 2781 tests / 2773 pass / **0 fail** / 8 skip; `npm run test:browser-cert` 225 / 219 pass / **0 fail** / 6 skip. PASS. (Local fixtures; not a deployed-server certification.)

## 2. Test server: checkout vs running process (separate states)

| Item | Observed |
|---|---|
| Host / unit | `nagex.service` (`/etc/systemd/system/nagex.service`), enabled, `Restart=always`, NRestarts 0 |
| **SERVER_CHECKOUT_SHA** | `faf38cc` on branch `deploy/r23.7-agex-mcp-20261013`; 0 tracked changes (only untracked artifacts). **Two commits behind the integration head** (PR #12 + plan doc) |
| Process | PID 3928992, started **2026-10-13 13:07:20 KST**, uptime ≈ 22 h (the owner's restart after my 12:47 build) |
| **RUNNING_PROCESS_SHA** | **`faf38cc`** — evidence: (a) process start is after the 12:47:18 `dist` build and no `dist`/`public` file is newer than the process; (b) the four compiled files sampled (`server_web.js`, `mcp.service.js`, `account.routes.js`, `pptx-writer.js`) are **byte-identical** to a local build of `faf38cc`; (c) the served frontend build version `534a34e8db6b` equals the version computed from `faf38cc`'s frontend files (and from `15d081b`'s, which share them). PASS (strong inference; no binary embeds a SHA) |
| Health | internal and external `GET /api/v1/health` → 200 `UP`; external TLS valid until **2026-11-21**; `/api/v1/auth/providers` → Google and Microsoft enabled |
| Served frontend (before the restart) | `edbc500678ea` — an older build; replaced by `534a34e8db6b` after the restart |

## 3. Nebius / NVIDIA Nemotron on the server

Config presence (values not printed): `NEBIUS_API_KEY` present, `NAGEX_NEBIUS_MODEL=nvidia/Nemotron-3_5-Lightning`, `NAGEX_MODEL_PROVIDER=auto`; `GEMINI_API_KEY` and `OPENAI_API_KEY` present; `NVIDIA_API_KEY` absent (Nemotron is reached through Nebius Token Factory, not NVIDIA NIM directly).

Real runtime evidence (service journal since the restart, aggregates only):

| Fact | Value |
|---|---|
| Nebius Nemotron calls that **succeeded** | 44 (model `nvidia/Nemotron-3_5-Lightning`, reasoning tokens reported) between 13:07 and 20:58 on 10-13 |
| Nebius failures | 3 (2× `INVALID_MODEL_RESPONSE`, 1× `PROVIDER_TIMEOUT`) |
| Latency Nemotron / Gemini | p50 20.5 s · p90 35.4 s · max 54.9 s / p50 5.8 s · p90 8.2 s |
| After the last Nebius failure (10-13 20:58:45) | **every** request was routed to Gemini (110 of 110 decisions, reason `PROVIDER_DEGRADED_DEPRIORITIZED`) for ≈ 14 h |
| Only task kind observed | `PLAN` (≈ 6 requests/hour from background recurring tasks). No `CHAT`, `RESEARCH_SYNTHESIS`, `MEETING_PREP` or `DOCUMENT_SYNTHESIS` request appears in the journal |

- **LIVE_NEMOTRON (capability): PASS** — real Nebius Nemotron calls succeed on this server.
- **LIVE_NEMOTRON (current routing): FAIL (P0)** — Nemotron is bypassed. Cause confirmed in code: `status()` reports `DEGRADED` whenever the **last** call failed, with no time-based recovery; the router then ranks a `DEGRADED` provider last, so it is never tried again and can never recover (only an explicit `POST /api/v1/providers/health-check` or the other provider failing would clear it). Separately, only `PLAN`, `RESEARCH_SYNTHESIS` and `MEETING_PREP` prefer Nemotron; `CHAT` and `DOCUMENT_SYNTHESIS` follow the "live provider first" tier, which also favours the provider that has already succeeded (Gemini).
- No interactive-user model call was observable; the latency (≈ 20 s median) is itself a demo risk.

## 4. Document creation → save → reopen

| Item | Status | Evidence |
|---|---|---|
| Code path (`POST /api/v1/creations/documents`, `GET …/documents/:id`, Recent / artifacts, PPTX) | PASS (local) | present in `15d081b`; the creation suites pass in the baseline gate |
| On the deployed server | **NOT_RUN** | `/var/lib/nagex/documents` holds **0 files**; `artifacts` 2 (2026-09-30), `creations` 73 (≤ 2026-09-28): no document has ever been persisted on this server. A signed-in session is required to exercise it |
| Model used | note | `DOCUMENT_SYNTHESIS` is not a Nemotron-preferred task today (see §3) |
| Storage config | PASS (config) | `NAGEX_STORAGE_PROVIDER=s3`, `NAGEX_S3_ALLOW_MOCK_FALLBACK=0` (no silent mock) |

## 5. Human Approval → execution → Activity

| Item | Status | Evidence |
|---|---|---|
| Historical real chain | PASS (history) | 197 approval records and 100 `SUCCEEDED` execution records (Google Calendar create, Gmail send, browser click), last execution 2026-09-27; Activity `action.*` events up to 2026-10-08 |
| On the current build | **NOT_RUN** | nothing executed on `faf38cc` |
| Google Calendar / Gmail actions now | **BLOCKED** | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` are **absent** from the process environment (only the sign-in credentials exist), so the connection cannot be (re)connected or refreshed; the 2026-10-03 token store cannot be trusted. Owner decision needed |
| GitHub / Slack / Telegram | BLOCKED | no `GITHUB_*`, Slack or Telegram credentials; MCP OAuth disabled |
| Non-destructive candidate | available | `browser.click` (approval-gated); Playwright Chromium and Google Chrome are installed on the server |

## 6. Findings that threaten the demo

| # | Sev | Finding | Evidence | Priority |
|---|---|---|---|---|
| 1 | **P0** | Nemotron bypassed: sticky `DEGRADED` after one failure; CHAT / DOCUMENT_SYNTHESIS never prefer it | §3 | fix first (D-10) |
| 2 | **P0** | No executable approval-gated provider is configured (Google env absent) | §5 | owner decides: restore Google credentials, or use `browser.click` on a benign page |
| 3 | **P0** | Document / PPTX creation never exercised on the server | §4 | D-9 |
| 4 | **P0/P1** | Background task storm: 30 ACTIVE recurring tasks (5 owners, including test fixtures such as "Owner-A-task", "Isolation target", "Mine", "Theirs") run hourly and **fail every time** (`STEP_BLOCKED`, 160–227 runs/day since ≥ 10-05); ≈ 150 model calls/day, 4,370 notification files and 4,801 durable-run files. Pollutes Activity/Notifications for a demo persona and burns tokens | `/var/lib/nagex` aggregates | needs an authorized data cleanup / pause |
| 5 | P1 | Server is 2 commits behind the integration head; `main` is 185 behind | §1–2 | decide release line (no merge today) |
| 6 | P1 | Nemotron latency ≈ 20 s median | §3 | measure per task; choose reasoning budget |
| 7 | P2 | PR #11 is superseded and still open | §1 | housekeeping |

## 7. Required fields

| Field | Value |
|---|---|
| `REPO_INTEGRATION_SHA` | `15d081b` |
| `SERVER_CHECKOUT_SHA` | `faf38cc` |
| `RUNNING_PROCESS_SHA` | `faf38cc` (fingerprint-verified, see §2) |
| `LIVE_NEMOTRON` | capability PASS · current routing **FAIL** |
| `REAL_CREATION` | NOT_RUN on the server (code path PASS locally) |
| `REAL_ACTION` | BLOCKED for Google/GitHub/Slack; NOT_RUN for `browser.click` |
| `REAL_APPROVAL` | NOT_RUN on the current build (historical records exist) |
| `UI_EN_KR` | NOT_RUN on the deployed server (local browser certification PASS) |
| `DEMO_E2E` | NOT_RUN |

Not checked: the hackathon's exact submission requirements and video length (needs the organizer's current rules).

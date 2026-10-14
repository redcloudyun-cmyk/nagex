# NAgex D-11 — Stage 0 read-only preflight (test deployment GO / NO-GO)

**Date:** 2026-10-14 (KST) · **Runbook:** `NAGEX_D11_TEST_DEPLOY_GO_NO_GO_20261014.md` · **Candidate branch:** `d11/advisory-plan-20261014` @ `a550735`
**Executed:** read-only checks only. **Not executed:** task pause / deletion, restart, deployment, environment change, merge, any write on the server (the service is unchanged: PID 3928992, started 2026-10-13 13:07:20, checkout `faf38cc`, 0 tracked changes). Secret values were never printed (presence / length only).
**Labels:** PASS / FAIL / BLOCKED / UNKNOWN.

## 1. Result table

| Field | Value |
|---|---|
| `CANDIDATE_SHA` | `a550735` (= tested code `f740cb9` + 2 documentation-only commits) — PASS |
| `TESTED_SOURCE_SHA` | `f740cb9` — PASS |
| `SERVER_CHECKOUT_SHA` | `faf38cc`, branch `deploy/r23.7-agex-mcp-20261013`, 0 tracked changes — PASS |
| `RUNNING_PROCESS_SHA` | **`faf38cc` — PASS (proven, not inferred from the checkout)** |
| `FRONTEND_SHA` | serving `534a34e8db6b` (= `faf38cc`); the candidate will serve `c9458e230be0` — PASS |
| `FIXTURE_JOBS_MATCH` | **PASS** — 30 / 30 ACTIVE recurring tasks identical to the 2026-10-14 audit |
| `STORE_BACKUP_READY` | **PASS (capacity and location)**; a fresh backup is NOT_RUN (Stage 2) |
| `ROLLBACK_READY` | **PASS for prerequisites; rehearsal NOT_RUN.** One condition: the restart needs the operator's `sudo` |
| `GATE_STATUS` | PASS: build 0; `npm test` 2,854 / 2,846 / 0 fail / 8 skip; browser 227 / 221 / 0 fail / 6 skip (at `f740cb9`) |
| **Stage 1 (pause) path** | **BLOCKED — see §4** |
| `GO_NO_GO` | **BLOCKED** (not NO-GO): waiting for HOLD A / HOLD B and a decision on the pause path |

## 2. Code version actually serving

| Check | Result |
|---|---|
| Local candidate | branch `d11/advisory-plan-20261014` = `origin` = `a550735`; contains `f740cb9` and `faf38cc`; working tree clean (one untracked test-artifact directory); no conflict markers; commits after `f740cb9` change only 2 docs |
| Candidate vs baseline `faf38cc` | 24 commits, 37 files: 18 runtime files (`src/model-gateway` ×6, `src/http` ×2, `src/planning`, `src/app`, `src/connectors`, 5 `public/*.js`, 2 certification scripts), 13 tests, 6 docs. `package.json` and `package-lock.json` are **byte-identical** to `faf38cc` (the server's lock hash `f00a10a77f70` matches) → the server's existing `node_modules` (247 MB) is reusable, no `npm ci` network risk |
| Server checkout | `faf38cc`, 0 tracked changes, 9 untracked artifact paths (voice evidence, `.runtime`), no `.git` lock |
| Process | `nagex.service` active / running, `NRestarts=0`, User `redcloud`, PID 3928992, started 2026-10-13 13:07:20 KST (uptime ≈ 26 h) |
| Health | internal and external `GET /api/v1/health` 200 `UP`; TLS valid until 2026-11-21 (Google Trust Services); `/api/v1/auth/providers`: Google and Microsoft enabled |
| Running code = `faf38cc` | (a) no `dist`, `public` or `src` file is newer than the process; the build (12:47:18) precedes the start (13:07:20); (b) **6 compiled files are byte-identical** to a local build of `faf38cc`: `server_web.js`, `providers.js`, `unified-model-router.js`, `ai-service.js`, `conversation.routes.js`, `mcp.service.js`; (c) the frontend version served (`534a34e8db6b`) equals the one computed from `faf38cc`'s files, and **differs** from the candidate's (`c9458e230be0`), so the Nemotron-first / advisory code is **not** in the running process |

## 3. Configuration presence (values never printed)

| Item | State |
|---|---|
| Nebius route | `NEBIUS_API_KEY` set; model `nvidia/Nemotron-3_5-Lightning`; `NAGEX_MODEL_PROVIDER=auto`; Gemini and OpenAI keys set (fallbacks) |
| Sign-in | Google and Microsoft client id / secret / redirect set |
| OAuth / token encryption | `NAGEX_TOKEN_ENCRYPTION_KEY` set (64 chars) |
| Storage | `NAGEX_STORAGE_PROVIDER=s3`, `NAGEX_S3_ALLOW_MOCK_FALLBACK=0`, bucket and credentials set (objects written through the S3 provider live in the remote bucket, **not** in the file backup; the older local `object-storage` directory is inside `/var/lib/nagex` and is) |
| Not set (as intended) | `NAGEX_MCP_ALLOW_PRIVATE_NETWORK`, `NAGEX_MCP_OAUTH_ENABLED`, `NAGEX_EXPOSE_MODEL_TRACE`, `NAGEX_PROVIDER_DEGRADED_COOLDOWN_MS` (the default 60 s is fine) |
| Absent | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (Calendar / Gmail connection), `GITHUB_CLIENT_ID` |
| Data store | `/var/lib/nagex`, 86 MB, `drwx------ redcloud`, file records, one `google-oauth.json` (mode 600, 1.2 KB) |
| Restart authority | The service runs as `redcloud`, but `sudo -n` asks for a **password** — the agent cannot restart or stop it; the operator must. The unit and its drop-ins are root-owned (`token-encryption.conf` is not even readable by `redcloud`) |

## 4. The 30 recurring tasks — ownership and ACTIVE state

Read live from the server's task and run records and compared field by field with the audit list (id, owner, name, schedule):

| Check | Result |
|---|---|
| ACTIVE RECURRING tasks | **30** — identical set of ids, owners, names and schedules to the audit (0 added, 0 missing, 0 changed) |
| Split | 3 × "Daily Morning Brief" every 30 min (`tsk_2f0dce961b9bb18e`, `tsk_7d95c7d7e002d0d0`, `tsk_eaca7a4c268cc4ce`) + 27 × daily 08:00 Asia/Seoul |
| Owners | all fixture identities: `usr_tasks_test` 12, `usr_isolation_shared` 9, `usr_isolation_owner_a` 3, `usr_isolation_owner_b` 3, `usr_other_owner` 3 |
| Non-fixture ACTIVE tasks | 8, all **ONE_TIME** (owners `usr_r102d_i3_*`, `usr_activityapi_*` and one `usr_demo_alex` task) — not recurring, not in the pause list, **must not be touched** |
| All tasks | 48: 30 RECURRING/ACTIVE, 11 ONE_TIME/ACTIVE, 6 ONE_TIME/FAILED, 1 ONE_TIME/COMPLETED |
| In-flight runs | 0 non-terminal runs; 6 runs started in the last hour (the 3 interval tasks) |
| Real user / demo recurring tasks | 0 |

### BLOCKER for Stage 1 as written (cause and needed action)

The runbook pauses the tasks "through the canonical authenticated task API as those owners". That is **not possible**:

1. `POST /api/v1/tasks/:id/pause` exists but is owner-scoped (`TaskStore.pause(taskId, tenantId, ownerId)`) and needs that owner's signed-in session.
2. **None of the five fixture owners has an identity record** (and neither has `usr_demo_alex`): they exist only as `ownerId` strings written by test code. Nobody can sign in as them, and this audit will not create accounts or sessions for them.
3. Editing the JSON task files is **ineffective and unsafe**: `TaskStore` reads all records into memory once at start and the scheduler uses that memory, so the running service would ignore the edit and later overwrite it.

Decision needed (HOLD A scope): the only safe route found is a one-shot maintenance run of `TaskStore.pause(taskId, tenantId, ownerId)` — the store's own canonical method, with each task's recorded tenant and owner, no file editing — executed **while the service is stopped**, i.e. inside the deployment window after the backup, so the restarted service loads the 30 tasks as PAUSED. That needs your explicit approval as an "approved management path" (and means the pause happens at cutover, not before it; the model-call storm continues until then). If you prefer not to approve it, the 30 tasks stay ACTIVE and, after the Nemotron-first change is deployed, will spend ≈ 1 M tokens a day on failing runs (see the advisory certification).

## 5. Backup capacity and rollback prerequisites

| Check | Result |
|---|---|
| Backup target | `/home/redcloud/nagex-backups`, mode 700, owner `redcloud`, **outside** the Git checkout and outside the served `public/` directory (the app serves `<cwd>/public` only); 18 MB used |
| Free space | 151 GB free of 233 GB (32 % used); data 86 MB, `dist` 14 MB, `node_modules` 247 MB, `.git` 119 MB — more than 1,000× headroom |
| Existing backups | `nagex-data-20261013-124616-pre-faf38cc.tgz` (4.7 MB, 24 h old, mode 600) and the previous `dist` — **stale; a fresh backup is required at Stage 2** |
| Baseline preserved | branch `deploy/r23.7-agex-mcp-20261013` at `faf38cc` exists on the server; the baseline build is the current `dist` (a copy is not yet taken — Stage 2) |
| Dependencies | lockfile unchanged → the baseline `node_modules` works for the candidate |
| Release method | The runbook's "isolated release directory" cannot be wired through the unit (root-owned, fixed `WorkingDirectory` and `ExecStart` under `…/nagex/source`). **Feasible without root:** build the candidate in `~/services/nagex/release-<sha>` (clone at the candidate SHA, reuse the lock-identical `node_modules`, copy the untracked `.runtime` tools), then at cutover swap directories (`source` → `source-faf38cc`, `release-<sha>` → `source`) and restart; rollback is the reverse swap + restart. Both swaps need the **operator's sudo only for the restart**. The old checkout stays untouched |
| Non-NAgex neighbours | other projects' processes (other ports) and a cron job run on the same host; the only NAgex units are `nagex.service` and the weekly `nagex-system-maintenance.timer` (next 2026-10-18 04:30, before the video window — what it does is not inspected here); no deploy, build, `git` or `npm` job of NAgex is running |
| Data outside the file backup | S3 bucket objects (remote), the root-owned unit drop-ins (including the encryption key) — not restorable from the file archive; a code rollback does not touch them |

## 6. What is needed before HOLD A / HOLD B

1. **Operator decision on the pause path** (§4): approve the stopped-service `TaskStore.pause` maintenance run at cutover (recommended), or keep the tasks active.
2. HOLD A and HOLD B authorizations, separately (this report authorizes neither).
3. The operator available to run `sudo systemctl stop/restart nagex` (and for a rollback) — the agent has no sudo.
4. Stage 2 items still NOT_RUN: fresh data backup with checksum, baseline copy, release build (`npm run build`, `npm test`, `npm run test:browser-cert` on the release directory), rollback rehearsal.
5. Stage 4 caveats already known: Google Calendar / Gmail credentials are absent, so the approved-action demo must use `browser.click` on a disposable destination; document creation on this server is untested.

**No NO-GO condition was found** (the running process matched exactly; no storage problem). The overall state is **BLOCKED** only by the missing approvals and the pause-path decision.

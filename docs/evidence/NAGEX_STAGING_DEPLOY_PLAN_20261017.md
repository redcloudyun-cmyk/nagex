# NAgex — Staging deployment: plan, pre-flight result and rollback (2026-10-17)

**Status:** PLAN + PRE-FLIGHT RESULT (point in time) · **Release posture:** `RELEASE = NO-GO` · `main` untouched · the legacy test server was never touched.
A user-inspection (Staging) deployment is judged separately from any formal release.

Host names, addresses, login names, filesystem paths and process ids of the Staging host are deliberately **not** recorded in the repository; the operator's copy of this runbook with them is kept outside it. Placeholders: `<install-dir>`, `<data-dir>`, `<backup-dir>`, `<service>`.

## 1. Result

```text
DEPLOYED_SHA (Staging, before)  = b1248c6   (integration line, 2026-10-16 11:58 +0900) - read from the host's own git checkout
TARGET_SHA                      = 4beb835   (tip of integration/product-completion-20261015)
Enter fix in the deployed build = NO   (dd2e9f8 / 9bad398 are not in b1248c6; the served main-surface.js has only the Ctrl/Cmd+Enter handler) -> the reported symptom
Enter + Korean IME fix in target= YES  (dd2e9f8, e101c8c; verified with git merge-base --is-ancestor on the host)
CI of 4beb835                   = Windows success, Ubuntu success (run 39024083501)
Fast-forward                    = yes (47 commits)
DEPLOYMENT                      = NOT EXECUTED: the deployment command was refused by the server-side auto-mode classifier in this session and was not re-sent in another form
NVME_SMART                      = UNVERIFIED (needs sudo); temperature, kernel log and filesystem state checked (below)
```

## 2. Pre-flight (read-only unless noted)

| Check | Result |
|---|---|
| Access | public-key authentication as the service user: PASS. `sudo` needs a password -> every sudo step is the operator's |
| Service | active, health `UP`, runs from the checkout's `dist/`, **disabled** at boot, `NODE_ENV=development`, `NAGEX_PUBLIC_URL` not set (the target derives redirect addresses from it only where an integration has no explicit one; the sign-in redirect URIs are explicit and the Calendar/GitHub connections have no client id configured, so nothing changes) |
| Working tree | tracked files clean; one untracked stray file in the checkout (left alone) |
| Dependencies | `npm ci` required: one new package (`pptxgenjs` 4.0.1); no install-time scripts; build = `tsc`. Node 24, npm and `tsc` present |
| Durable stores | 4 new (route history, video, product builder, to-dos), 2 modified (device command status, device execution session): additive, so the previous code still reads what it knew |
| Disk | system volume 3 % used, ~430 GB free |
| NVMe | state `live`, 40 °C (limit 89 °C), no I/O or filesystem error in the last 400 kernel-log lines, mounted read-write; **SMART health flag not read** |
| Existing backup | **none** (no backup directory, cron job or timer for NAgex) |
| Backup taken (write, additive) | the whole `<data-dir>` (38 files, 228 KB; `diff -r` identical; `sha256sum -c` 38/38 OK), the running `dist/`, `package*.json`, the SHA record and the service state, in `<backup-dir>`. **On the same disk as the data** - it protects against a bad deployment, not against a failing drive |
| Settings file of the service | root-only; the deployment does not touch it; copying it needs sudo |

## 3. Deployment steps (not executed) - as the service user, in one sitting

The fast-forward makes the **new front end live at once** (static files are served from disk); the old server code runs until the restart.

1. Last look: `git rev-parse HEAD` is `b1248c6…`; tracked files clean; service active.
2. Final backup of `<data-dir>` right before the change, with a checksum file; `sha256sum -c` must show 0 failures.
3. Rollback point: `git branch backup/pre-4beb835 b1248c6`; then `git fetch origin && git merge --ff-only origin/integration/product-completion-20261015` (must fast-forward).
4. `npm ci --no-audit --no-fund && npm run build`.
5. Smoke start of the new build on another loopback port with an **isolated `HOME`** (it cannot touch the live data): health answers, `/composer-keys.js` is served; stop it and delete its directory.
6. **Operator, sudo:** `smartctl -a /dev/nvme0n1` (or `nvme smart-log`) - stop if overall health is not PASSED, critical warning ≠ 0, media errors > 0 or percentage used > 90; copy the root-only settings file to a root-only location.
7. **Operator, sudo:** restart `<service>` right after step 4.

## 4. Verification after the restart

On the host: service `active` with a new main pid; `GET /api/v1/health` -> `UP` with a small uptime; `GET /api/v1/vcs/status` -> `commits[0].hash` is `4beb835…` (the SHA the running service sees); the journal shows no start-up error. From anywhere: the public address answers `302` to Cloudflare Access (tunnel and Access in front).

Signed in at the public address (not possible from the development PC): **Enter** sends once · **Shift+Enter** is a new line and sends nothing · the **Send button** behaves the same · **Korean IME:** type `안녕하세요`, one Enter confirms the syllable and sends nothing, the second Enter sends the whole text · the same in the ambient Ask sheet (`Alt+N`) and Quick Wake · the page source shows `composer-keys.js?v=…` · existing data (sign-in, conversations, tasks) is still there.

## 5. Rollback

`git checkout -f backup/pre-4beb835` (or `git reset --hard b1248c6…`), `npm ci && npm run build`, restart `<service>`, check health. The previous `dist/` is in `<backup-dir>` for a faster return (`node_modules` must match the previous lockfile - `npm ci` restores it). Data: only if the new code damaged records, stop the service, copy back **only the affected store directory** from the backup, start again; restoring the whole directory discards everything written after the backup - tell the people using Staging first. A rollback never replays consequential actions: approvals and executions are stored, not re-run.

## 6. Judged separately

- **Staging / user-inspection deployment:** every precondition that can be checked without sudo is met (CI green on both systems, target contains the fix, fast-forward, space, verified backup, rollback point). Open: `NVME_SMART = UNVERIFIED`, the backup sharing the data's disk, and the deployment itself.
- **Formal release:** not decided, not declared. `RELEASE = NO-GO` stands; `main` is not part of this; `DEBT-0017` and `DEBT-0018` are open.

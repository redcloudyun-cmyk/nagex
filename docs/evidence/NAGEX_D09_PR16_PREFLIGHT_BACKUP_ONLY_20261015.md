# NAgex PR #16 — PREPARE ONLY / NO CUTOVER
Date: 2026-10-15 KST
Authority: the operator authorized preflight, backups, candidate build and final checks ONLY. **No deployment, restart, stop, service replacement, live data mutation, main merge, external real action or live OAuth certification is approved.**
Reference: Draft PR #16; source branch `integration/d09-vault-home-20261015`.
Certified tested code SHA: `660e15f56e130c9efd1df9c6af1c5f22d110702b`.
Certification: `docs/evidence/NAGEX_D09_HOME_VAULT_INTEGRATION_CERT_20261015.md`; build pass, 2986/2978 PASS/0 FAIL/8 SKIP regression, browser 324/318 PASS/0 FAIL/6 SKIP (4-file concurrency twice), Home 19/19. These figures are source report claims, **not new hosted certifications**.
Reported deployed baseline: `bcd7e10`, PID 2997023, health 200. Confirm live; never assume PID/status stays unchanged.
Voice WIP, main, non-NAgex services excluded.

## 0. Hard no-go actions without NEW approval
- No `sudo systemctl stop|start|restart|reload nagex`, `systemctl daemon-reload`, process kill, changing service files/flags/env.
- No `mv source source-...`, `rm source`, changes in `/home/redcloud/services/nagex/source`, symlink switching, deployment rsync, or edit to live Nginx/Cloudflare/DNS.
- No writing, archiving/deleting, restoring, migration or ownership changes inside `/var/lib/nagex` or service DB.
- No test login, unapproved API POST, task approve, MCP registration, external tool invocation, Gmail/Calendar write or user data seeding. No altering paused 30 fixture tasks.
- Do not dump `/proc/$PID/environ`, env files, tokens, cookies or credentials in evidence. Audit only **nonsecret presence by approved configuration interface**, not raw values. Never place secrets inside backups shared outside host.
- No PR merge to main or any other shared branch. Do not mutate PR #16 source during preflight.
- No automatic rollback (nothing is deployed); rollback plan is DOCUMENTATION ONLY.

## 1. Preflight acceptance policy
Mark checks PASS only with observed evidence. If any blocking check fails, classify `NO_GO`, do not continue to service changes.
A) deployed PID + health, source HEAD, disk, resource capacity, owners/permissions, memory, service unit read-only.
B) candidate source EXACTLY pinned to `660e15f...` in isolated sibling directory; ensure enough disk; build/test with isolated runtime data paths. No source swap.
C) make a **provisional online backup** of service data to private backup location outside service data. If online backup cannot be shown consistent for a writable multi-file store, record `SNAPSHOT_NOT_QUIESCED`. A second, authoritative stopped-service backup (if needed) must await separate deployment authorization. Never claim a live tar to be an atomic backup.
D) validate backup archive integrity, SHA-256 and restore **only into a disposable directory** (never /var/lib/nagex), permissions, expected top-level files; no leaking archive contents or secrets in logs.
E) check safe rollback directory `source-bcd7e10` / `source-faf38cc` existence without modifying; write exact operator rollback plan for later approval. Never assume backup directory names; collision check.
F) verify candidate contains final PR #16 UI/mobile/backend changes (git diff --name-only, provenance), check `main` and Voice WIP untouched.
G) render build smoke only against a **separate, loopback port, isolated disposable data** IF such isolation is proven and with no external effects; otherwise record NOT_RUN. Do not run two NAgex server processes against same stores or public tunnel.
H) do not claim hosted document creation/approved Vault save PASS: those remain `NOT_RUN` until explicit service deployment + real signed-in operator action.

## 2. Safe read-only commands (Linux host, run as operator in correct account)
These commands are examples, adapt only after checking host:
```bash
set -euo pipefail
printf '== service (read-only) ==\n'
systemctl is-active nagex
systemctl show nagex -p MainPID -p ActiveEnterTimestamp -p ExecStart -p WorkingDirectory --no-pager
printf '== active source ==\n'
git -C /home/redcloud/services/nagex/source status --short
git -C /home/redcloud/services/nagex/source rev-parse HEAD
printf '== availability ==\n'
curl -fsS --max-time 10 https://nagex-test.agex.site/api/v1/health
printf '\n== capacity ==\n'
df -h /home/redcloud /var/lib
df -i /home/redcloud /var/lib
free -h
printf '== rollback slots (read-only) ==\n'
find /home/redcloud/services/nagex -maxdepth 1 -mindepth 1 -type d -printf '%f\n' | sort
printf '== tracked remote ==\n'
git -C /home/redcloud/services/nagex/source remote -v | sed -E 's#(https?://)[^/@]+:[^/@]+@#\1[redacted]@#g'
```
Do not echo environment-variable values in any output.

## 3. Candidate staging (allowed, separate folder; no live source modification)
Use NEW named release-prep directory under `/home/redcloud/services/nagex/` with explicit no-collision check. Build and run gates there with PRIVATE temp test stores, preserving the exact tested SHA. Do not use `git checkout` in the deployed `source`.
```bash
set -euo pipefail
ROOT=/home/redcloud/services/nagex
DEST="$ROOT/candidate-pr16-660e15f"
TESTED=660e15f56e130c9efd1df9c6af1c5f22d110702b
test ! -e "$DEST" || { echo "ABORT: candidate destination exists"; exit 1; }
git clone --no-checkout https://github.com/redcloudyun-cmyk/nagex.git "$DEST"
cd "$DEST"
git checkout --detach "$TESTED"
test "$(git rev-parse HEAD)" = "$TESTED"
git status --porcelain
node -v; npm -v
# Use the repository's supported package installation flow; DO NOT share live service data paths.
# Verify lockfile and dependencies before npm ci / equivalent.
npm ci
npm run build
# Before running full tests, review tests/_setup.js and required runtime directories;
# test with truly isolated writable directories. Then:
npm test
npm run test:browser-cert
```
If the repo requires SSH GitHub auth use an already configured read-only deploy URL without embedding a token or password in logs. Never change package locks during npm ci.
If build/test would touch live stores due to default paths, STOP and stage the appropriate safe temporary environment first. Candidate build and test failures are **not permission to change live env**.

## 4. Backup: capture safely while service stays online
The operator authorized an online **copy/archive**, not a stopped-service snapshot or mutation. The app uses multiple file-backed stores, so a tar while it runs may capture mixed generations; distinguish "archive verified" from "consistent recovery point".
- Inspect data root **read-only**; verify current tasks count/paused fixture count without listing sensitive record content, if a safe read-only audit exists.
- Choose private destination under `/home/redcloud/nagex-backups/`, with mode 0700 and file 0600; verify disk space first. **Do not upload or paste backup contents**.
- Capture with ordinary read-only archive command `tar -C /var/lib -czf <private-path> nagex` only after confirming the archival account has read permission and the archive will not race with volatile stores in a way falsely labeled recoverable. Avoid printing filenames if they disclose private data.
- SHA256 the archive; `tar -tzf` integrity check; test-extract into dedicated private temporary directory OUTSIDE `/var/lib/nagex`, verify expected root (without exposing record data), securely clean only operator-created temporary extraction after checks.
- For file-backed live consistency, label `ONLINE_BACKUP_PROVISIONAL` and list the need for a later cold snapshot or application-consistent snapshot. If copying is not safely possible, state BLOCKED and STOP that slice; do not stop the service.
- Verify no duplicate backup path overwrite, monitor space, do not modify live files, don't claim consistent rollback readiness solely from a checksum.

Example (only after ownership/space review; `umask` applies):
```bash
set -euo pipefail
umask 077
BACKUPS=/home/redcloud/nagex-backups
mkdir -p "$BACKUPS"
chmod 700 "$BACKUPS"
TAG=$(date +%Y%m%d-%H%M%S)
OUT="$BACKUPS/nagex-pr16-online-preflight-$TAG.tgz"
test ! -e "$OUT" || exit 1
tar -C /var/lib -czf "$OUT" nagex
sha256sum "$OUT" > "$OUT.sha256"
tar -tzf "$OUT" >/dev/null
sha256sum -c "$OUT.sha256"
# Use a separate private, disposable restore-test destination. Never restore to /var/lib/nagex.
```
Archive contains private information; no user-visible copies or logs. If a backup fails, preserve partial state for operator review, label FAILED and don't assume ready.

## 5. Final GO / NO-GO report only (NO cutover)
Create `docs/evidence/NAGEX_D09_PR16_PREFLIGHT_RESULT_20261015.md` in a dedicated prep branch, reporting:
- `CANDIDATE_SHA`, `RUNNING_SHA`, `RUNNING_PID`, `HEALTH`, `PROCESS_RESTARTS`
- `DISK_INODES`, `CANDIDATE_BUILD`, `REGRESSION`, `BROWSER_CERT_4`, `BROWSER_CERT_DEFAULT_ON_QUIET_HOST`
- `ONLINE_BACKUP`, `ARCHIVE_SHA256_VERIFIED`, `EXTRACT_TEST`, `CONSISTENT_COLD_BACKUP`, `ROLLBACK_SLOT`
- `PR16_CONTRACT_PARITY`, `VOICE_WIP_UNTOUCHED`, `FIXTURE_TASKS_UNCHANGED`
- `HOSTED_VAULT_FLOW=NOT_RUN`, `HOSTED_DOC_FLOW=NOT_RUN`, `SERVICE_RESTART=NOT_RUN`, `MAIN_MERGE=NOT_RUN`.
- Exact blockers, duration, evidence commands, but NO backup files, identifiers, content, or secret value in the report.
- Separate *ready for explicit deployment approval* vs *deployed*; do not infer the latter.

**MANDATORY STOP** after report. No next phase automatically. Request an explicit new approval before service stop/swap/start or actual hosted user journey.

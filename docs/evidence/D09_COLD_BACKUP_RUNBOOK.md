# D09 — Cold Backup Maintenance Runbook (stopped-service, consistent recovery point)

Date: 2026-10-15 KST · Status: **PLAN ONLY — NOTHING HERE HAS BEEN EXECUTED.** The service was not stopped, started or restarted; no command in this runbook has been run. · RELEASE = **NO-GO**
Approval IDs: A8 (window and who runs `sudo`), A9 (off-host copy), A10 (secrets), and — only if chosen — A1/A2 (cleanup inside the window) and A11 (deployment, which has its own steps in `NAGEX_D09_PR16_PREFLIGHT_RESULT_20261015.md` §8 and is **not** part of this runbook).
Every command below is for the **operator account**; the two `sudo systemctl` lines are operator-only. Paths in angle brackets are the operator's choice; no real archive name or hash belongs in any document.

## 1. Why a cold backup, and what the existing backup is not

The only backup today is an **online** `tar` taken from the running service (verified by SHA-256, member listing and a disposable-directory extraction; 19,817 files / 284 directories). It is a good copy but **not an atomic recovery point**: records written during the archive could be missing or mixed. P0-4 requires a consistent cold backup in an authorized stopped-service window. The cold backup also gives the as-is state of the data root **including the 368 incident files and the four re-stamped role records** — that is wanted: it is the complete "before the cleanup/deployment" recovery point (call it **R0**).

## 2. State inventory — what "all of NAgex's state" is

Confirm this list with the operator before the window; anything not on it is not protected.

| # | State | Where (known) | In the data archive? | Handling |
|---|---|---|---|---|
| 1 | The data root: stores, records, payloads, **and the root-level files** (OAuth token files, MCP connection file, per-store directories) | `/var/lib/nagex` | yes (all of it) | the archive |
| 2 | Service environment (secrets, data-root override if any) | `/etc/nagex/nagex.env` (unreadable by the service account) | **no — never** | A10: copy by the operator with sudo into an encrypted store; never into the data archive, the repo or a report. Record only variable **names**. |
| 3 | systemd unit(s) | `systemctl cat nagex` | no | save the text; it contains no secrets unless the operator put some there |
| 4 | Code | `~/services/nagex/source` (+ slots) | no | reproducible from git: record `git rev-parse HEAD`; `.runtime/` (620 MB, untracked, unreferenced by code) does not need backup |
| 5 | A database, if NAgex uses one | the host also runs a database; **whether NAgex stores anything in it is not established by this analysis** | no | operator confirms; if yes it needs its own consistent dump in the same window |
| 6 | `source/.nagex_data/runtime` | exists, was empty | n/a | re-check it is still empty |
| 7 | Reverse proxy / tunnel configuration for the test hostname | outside this analysis | no | optional: save a copy |

## 3. Preconditions (all must be true; read-only checks)

1. A8/A9/A10 decided; window announced; operator present for the two `sudo` steps.
2. `systemctl is-active nagex` = active; record `MainPID`, `NRestarts`, `ActiveEnterTimestamp`; health returns HTTP 200; record the deployed `git rev-parse HEAD`.
3. Free space: `df -h /var/lib /home` — need at least **3×** `du -sb /var/lib/nagex` (archive + disposable extraction + manifests). Today: 149 GB free of 233 GB; the data is on the order of hundreds of MB. All of data root, backups and service slots share **one** disk — a same-disk archive does not protect against disk loss (hence A9).
4. **Restart consequences understood** (they apply to the stop/start of this window too): the service re-stamps the four built-in role records at every start; start-up recovery looks only at durable runs in `RUNNING` (none among the incident files); Google/GitHub connections survive a restart **only if** token encryption is configured in the service environment (the harness logs `google_oauth_persistence_disabled` when `NAGEX_TOKEN_ENCRYPTION_KEY` is absent) — the operator checks that the variable **name** exists in the env file before stopping, otherwise connected users must reconnect and should be told; scheduled tasks whose next-run time falls inside the window (48 tasks, 30 of them PAUSED fixtures) — review the other 18's `nextRunAt` so nothing consequential fires unattended at start.
5. No real sign-in activity expected in the window (a stop is graceful; persisted approvals stay `WAITING_APPROVAL`; nothing is lost, but users see downtime).
6. The online archive of today is kept untouched until A7 and the cleanup are settled.
7. The runbook's verification commands are copied to the host **before** the window and read through once; nothing is improvised.

## 4. Procedure (the operator runs it; ≈ 5–10 min of downtime, plan a 30 min window)

```
# --- T-0: record, then stop (operator, sudo) ---------------------------------------------------------
systemctl show nagex -p MainPID,NRestarts,ActiveEnterTimestamp          # record
sudo systemctl stop nagex                                               # OPERATOR ONLY
systemctl is-active nagex                                               # must print: inactive
sudo fuser -vm /var/lib/nagex || echo "no process holds the data root"  # nothing may hold files open

# --- manifest of the live tree BEFORE the archive (read-only) ---------------------------------------
umask 077; W=<private work dir, 0700, outside /var/lib/nagex>
find /var/lib/nagex -printf '%P\t%y\t%s\t%m\t%U:%G\t%T@\n' | LC_ALL=C sort > $W/tree.before.tsv
find /var/lib/nagex -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum > $W/files.before.sha256

# --- the archive (numeric owners, ACLs and xattrs preserved) ----------------------------------------
tar --numeric-owner --xattrs --acls -C /var/lib -czf <backup dir 0700>/nagex-cold-R0-$(date +%Y%m%d-%H%M%S).tgz nagex ; echo exit=$?
sha256sum <that archive> > <that archive>.sha256

# --- verification (see §5) ---------------------------------------------------------------------------
# --- OPTIONAL, only if A1+A2 approved: quarantine step from D09_CLEANUP_DECISION_MATRIX §4, then re-verify
#     every BLOCKED and every pre-existing file is bit-identical (re-run files.before.sha256 comparison) ----

# --- start (operator, sudo) ---------------------------------------------------------------------------
sudo systemctl start nagex                                              # OPERATOR ONLY
```

After start: `systemctl is-active nagex` = active; new `MainPID`; `NRestarts` 0; health HTTP 200; `git rev-parse HEAD` unchanged (no deployment here); service log scanned for errors (operator); the four role records show a fresh `updatedAt` — **expected**, see `D09_ROLE_RECORD_REVIEW.md`.

## 5. Verification — all must pass before the service is started again

| ID | Check | Pass criterion |
|---|---|---|
| V1 | archive written | `tar` exit 0, **no warnings** (a warning with the service stopped means something is wrong) |
| V2 | archive checksum | `sha256sum -c` OK |
| V3 | member listing | `tar -tzf` OK; one top-level root; entry count equals the number of lines of `tree.before.tsv` (the root directory counts once in each) |
| V4 | extraction rehearsal | extract only into `mktemp -d` (0700) **outside** the data root; never into `/var/lib` |
| V5 | content identity | recompute `sha256sum` of every extracted file; sorted list equals `files.before.sha256` (paths relative); file count and byte count identical |
| V6 | metadata | numeric owner/group, mode and (for files) size identical to `tree.before.tsv`; mtimes identical |
| V7 | JSON integrity | every `*.json` in the extraction parses (the online rehearsal had 19,417 JSON files, 0 invalid) |
| V8 | live tree untouched by the backup | re-run the two `find` commands; outputs equal the "before" files |
| V9 | disposable extraction removed | directory deleted, nothing left in `/tmp` |
| V10 | off-host copy (A9) | copy encrypted, transferred, and `sha256sum -c` passes at the destination |
| V11 | secrets kept apart (A10) | `nagex.env` copy is in a separate encrypted location; the data archive contains no `.env` file |

Optional (needs its own approval, not part of this plan): start a second, throw-away instance on another port against the *extracted copy* to prove the data loads. It needs the service environment, so it depends on A10 and is easy to get wrong; V5–V7 already prove byte identity.

## 6. Rollback and failure handling

| Situation | Action | Data state |
|---|---|---|
| Anything fails **before** the service was stopped | do nothing; reschedule | untouched |
| A verification step fails with the service stopped | do **not** modify the data root; fix the cause (space, permissions) and repeat from the archive step; if it cannot be fixed inside the window, **start the service as it was** and reschedule | untouched (V8 proves it) |
| The service does not start although the data is unchanged | read the journal (operator); the cause is environmental (the data and code are bit-identical to before); escalate; the archive R0 is not needed | untouched |
| Cleanup step (if done) must be undone | rename the quarantined files back from the holding directory using the manifest; verify each SHA-256; re-run V8-style comparison against R0's manifest | back to as-is |
| Data corruption is later detected | stop the service; **rename** `/var/lib/nagex` to `/var/lib/nagex.corrupt-<ts>` (never delete it); extract R0 with `--numeric-owner` into `/var/lib` so the root is `nagex`; re-run V5–V7 on the result; start | restored to R0 (loses writes after R0) |
| A deployment (separate approval) fails | slot rollback in the preflight document §8 (`source-bcd7e10` ↔ new slot); restore data from R0 **only** if the new version changed data incompatibly, and always by rename-aside, never extraction over the live directory | — |

A restore never overwrites in place; it never starts before its verification passes.

## 7. Evidence to keep (non-sensitive only)

Timestamps of stop/archive/verify/start; PID before/after; `NRestarts`; health codes; entry, file, directory and byte counts; V1–V11 outcomes; free space before/after; off-host copy confirmed Y/N. **Not** to be written anywhere public: the archive name, any hash, the private manifests, the env file, any path of the private work/backup directories.

## 8. Risks

| Risk | Mitigation |
|---|---|
| Disk fills during archive/extraction | precondition 3; `df` before and after; abort at the first error |
| Archive readable by others | `umask 077`, directories 0700, archive 0600 |
| Personal data in the archive | it holds user data: encrypted off-host copy only, retention decided in A9 |
| Memory/swap pressure on a 6.7 GiB host | the work is I/O only (tar/sha256); run under `nice`/`ionice`; nothing else running |
| Restart side effects (OAuth connections, scheduled tasks, role re-stamp) | precondition 4 |
| Operator mistake on a destructive command | there is none in this runbook: no `rm` of the data root, no extraction over it; restore is rename-aside |
| False comfort from a same-disk copy | A9 |

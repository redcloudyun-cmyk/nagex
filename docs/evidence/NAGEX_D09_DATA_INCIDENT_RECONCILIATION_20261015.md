# NAgex D-09 — Live Data Incident Reconciliation (READ-ONLY) and Cleanup DRY-RUN Plan

Date: 2026-10-15 KST
Status: **NO-GO for release. RECONCILED, NOT CLEANED.** Nothing in the live data root was changed, moved, deleted or restored by this work.
Directive: `NAGEX_D09_LIVE_DATA_CONTAMINATION_RECOVERY_DIRECTIVE_20261015.md` (P0-0, P0-1)
Scope of this document: non-sensitive aggregates only. No record identifiers, file names, tenant/user identities, record contents, record hashes, host paths other than the standard data root, backup names or credentials are published. The per-file table lives only in the operator's private host folder (mode 0600).

## 1. What was done (and what was not)

| Action | Done? |
|---|---|
| Read-only re-verification of the 368 added records and 4 modified role records | YES |
| Trace of the 5 waiting runs / 5 waiting continuations (recovery and re-execution risk) | YES (code trace + host data) |
| Dry-run cleanup plan | YES (plan only, `scripts/ops/data-incident-cleanup-dryrun.mjs`; imports only read-only filesystem calls, has no apply flag) |
| Any delete / move / restore / role-record edit / `systemctl` / source swap / redeploy / test run on the host | **NO** |

Both programs are committed with this report (`scripts/ops/`). The reconciliation program writes exactly one thing: its private 0600 table in the operator's logs folder, and it refuses to run if that folder is inside the data root.

## 2. Accounting: 368 added + 4 modified

Per-file checks for each of the 368: path canonical and inside the data root; regular file (no symlink, no directory); directory prefix on a fixed allowlist; size and SHA-256 against the private snapshot; modification time not earlier than the pre-test archive; tenant/owner claim compared with every tenant and owner that existed before the incident; linked-parent closure for payload files.

Baseline used for "existed before": the clean online backup taken immediately before the test run (19,417 JSON records read; 431 distinct tenant identifiers and 909 distinct owner identifiers).

| Result | Count |
|---|---|
| Added records | **368** (350,200 bytes), all written within one 45-minute window |
| TEST_ONLY_VERIFIED (tenant/owner claim matches no pre-existing identity) | 299 |
| TEST_ONLY_BY_LINKED_PARENT (payload whose parent record is verified) | 20 |
| TEST_ONLY_BY_DIRECTORY_OR_CONTEXT | 4 |
| BLOCKED_OWNER_OVERLAPS_PREEXISTING (owner/tenant also exists in pre-incident data) | 38 |
| BLOCKED_PARENT_BLOCKED (payload of a blocked parent) | 7 |
| **Cleanup candidates** | **323** (329,421 bytes) |
| **BLOCKED — excluded from any cleanup** | **45** |
| Demoted by closure check (candidate referenced by a blocked record) | 0 |

Candidates by directory: durable task runs 124, task continuations 124, artifacts 18, images 14, image payloads 14, documents 9, presentations 6, presentation payloads 6, memory settings 4, one each of device transport replay, role binding and two test idempotency directories.
Blocked by directory: daily briefs 17, artifacts 7, images 7, image payloads 7, durable task runs 3, one each of device connection status, device identity, mobile message run and one test idempotency directory.

Blocked means **"cannot be proven test-only, so it is not touched"**. The 45 blocked records need a human ownership decision; they must not be deleted by a pattern or a restore.

### The four modified role records

All four are the built-in system roles. For each: parsed field-level diff against the pre-test archive shows **`updatedAt` is the only changed field** (name, description, permissions, creation data identical). Cause: constructing the role store re-seeds built-in roles and rewrites `updatedAt` on every construction — the store was constructed against the live root by the test run. They are left exactly as they are. Restoring them would itself be a write to live data and needs its own authorization after proof of no legitimate concurrent change (see §5).

### Since the incident

Re-checked read-only: new files neither in the archive nor in the manifest: **0**; pre-existing records modified beyond the four: **0**; added records modified after the end of the incident window: **0**. (Absence of change in the historic window does not prove future inactivity; the check must be repeated immediately before any action.)

## 3. The five waiting runs and five waiting continuations

Counts: 5 durable runs in `WAITING_APPROVAL`, 5 task continuations waiting, 0 added runs in `RUNNING`; all 124 added continuations reference a run that is itself in the added set; 0 pre-existing records reference any added record.

Linkage in the **live** stores (read-only): the approvals the continuations point to exist in the live approval store: **0 of 5**; the tasks they point to exist in the live task store: **0 of 5**; the waiting runs' tasks exist in the live task store: **0 of 5**, in the live task-run store: **0 of 5**.

Recovery semantics traced in the code (not assumed):

- Startup recovery resumes only durable runs that are `RUNNING`. A `WAITING_APPROVAL` run is never touched by it. There are no added `RUNNING` runs.
- A continuation is claimed only by the approve/reject route, looked up through its approval id. No approval with that id exists in the live approval store, so nothing can approve or reject it; there is no scheduler path that executes a waiting continuation.
- The interrupted-run sweep works from the live task store, in which none of these tasks exist.

Conclusion: **no restart-recovery path and no user-reachable path can execute or resume these five**, and no consequential action is attached to them. This is a code-and-data conclusion, not a claim that they are harmless: they are test-owned records in a production store and stay a NO-GO item until removed or formally accepted. Removing any *one* member of a linked set without the others could orphan a continuation; the dry-run below therefore moves each run together with its continuation (closure check: 0 demotions).

## 4. Cleanup dry-run plan (NOT EXECUTED)

Dry-run result on the host (read-only): 323 candidates re-verified (path, no symlink, size, mtime, SHA-256): **323 unchanged, 0 problems**.

Planned action, for a separately authorized step only:

1. Operator authorizes the live-root change and chooses quiescence (stop/maintenance window, or an agreed proof that the service cannot read those directories during the move).
2. Immediately before: re-run the dry-run program; require `problems == {}`.
3. **Move** (same-filesystem rename, relative paths preserved) the 323 candidates into a private 0700 holding directory outside the data root. No `rm`, no `find -delete`, no wildcard, no recursive removal, no chmod/chown of the live root.
4. Re-run verification: the 45 blocked records and every pre-existing record unchanged bit-for-bit; service health unchanged.
5. Deletion from the holding directory is a later, separate decision.

Not part of the plan: restoring the online archive (it would roll back legitimate writes); changing the four role records' `updatedAt`; touching the 45 blocked records.

## 5. Blockers and open decisions

| # | Item | State |
|---|---|---|
| 1 | Operator decision to quarantine the 323 candidates, with quiescence method | OPEN — needs explicit authorization |
| 2 | Ownership decision for the 45 blocked records | OPEN — human review |
| 3 | Four built-in role records (`updatedAt` only) | OPEN — leave, or restore after proof of no legitimate change; separate authorization |
| 4 | Consistent cold backup in an authorized stopped-service maintenance window | NOT DONE |
| 5 | Test isolation fix, with zero-write proof | Fix delivered on its own branch (see `NAGEX_D09_TEST_ISOLATION_FIX_CERT_20261015.md`); not merged, not deployed |
| 6 | Linux IPv6 SSRF fix | Fix delivered on its own branch (see `NAGEX_D09_IPV6_POLICY_FIX_CERT_20261015.md`); Linux result stated there; not merged, not deployed |
| 7 | Final-SHA full regression and browser gates on an isolated CI host; hosted E2E after separate deploy authorization | NOT RUN |

The release gates in directive P0-4 are unchanged: **NO-GO** until all of the above are closed.

## 6. Service state (read-only observation, unchanged by this work)

The deployed service is the previously recorded revision, not restarted by this work (restart counter 0). No `systemctl` command, source replacement, deployment or test execution was performed on the host. The Voice WIP/main checkout was not touched.

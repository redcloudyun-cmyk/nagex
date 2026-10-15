# D09 — A6 Annex: Source Review and Execution Request (NOT AUTHORIZED, NOT RUN)

Date: 2026-10-15 KST · Ops branch `ops/d09-pr16-preflight-only-20261015` · Reviewed artifact commit `6db27ee` · Certified source `068f13dc3a11fc5d5df41b3019c8b6febaff5269` · RELEASE = **NO-GO**
**A6 is not authorized for execution. Nothing in this document has been run on the production host.** No production record, data root, service, or backup was accessed for this review; the earlier permission denial was not bypassed. All testing below used a synthetic data root in a temporary directory.

## 1. Verdict of the source review

The annex as first written (v1, never run on the host) did **not** meet the six requirements. It was reworked to v2 and re-verified. v2 meets them as stated in §2; residual limits are stated honestly in §3.

Defects found in v1 (all fixed in v2; none could have materialised because v1 was never executed against production):
1. It held the **raw text of every pre-existing JSON record** (including sessions, identity tokens and OAuth files) in memory → v2 never opens secret-bearing directories/files, and drops raw content immediately after extracting id fields.
2. It wrote its table to a fixed path with an unconditional write → v2 writes **only** with an explicit `--out`, by exclusive create (`wx`, mode 0600), never overwrites, refuses a path inside the data root, and writes only after every analysis step succeeded.
3. No execution bounds → v2 has file, time, size and row limits and aborts (exit 3) **without** writing the table.
4. Table paths were trusted → v2 accepts only relative, normalised paths that stay under the root and are regular, non-symlink files.
5. Free-text `status` values and group labels derived from an untrusted table could reach the output → v2 whitelists status tokens (`[A-Z_]{2,24}`) and relabels invalid paths.
6. No way for the operator to narrow the scope → v2 adds `--no-identity-read` and `--skip-dir`, and marks the result "partial" when used.

## 2. The six requirements — verification evidence

| # | Requirement | Verified how | Result |
|---|---|---|---|
| 1 | No writes, including indirect writes through imported modules | **Dependency chain:** the script imports exactly `node:fs` and `node:path`; no NAgex module, no npm package, no dynamic import/`require`/`eval`, no `child_process`/network (static check P1a–P1b in the self-test). **Write primitives:** only `fs.openSync(..., 'wx', 0o600)` for `--out`; no `writeFile`, `mkdir`, `rename`, `unlink`, `rm`, `chmod`, `chown`, `utimes`, `copyFile`, `symlink`, `truncate`, `append` (P1c–P1e). **Runtime enforcement independent of the code:** run under Node's permission model (`--permission`), which on the test runs *refused* writes, `mkdir`, `unlink` and `rename` inside the data root, writes beside the output file, spawning a process, and reads outside the allowed paths, while allowing the reads the tool needs (P6a–c). **Observed effect:** a synthetic data root was identical before and after (content hash, size, mtime, mode — files and directories) (P2). | PASS |
| 2 | Does not initialize stores that mutate data | No NAgex code is loaded at all (imports above). It reads JSON as plain text; no `RbacStore`/`FileRecordStore`/application composition exists in the process. This matters because `RbacStore`'s constructor *rewrites* role records — the very mechanism of the incident. | PASS |
| 3 | Does not alter permissions or ownership | No `chmod`/`chown`/`utimes`/`umask` call (P1e). The one file it may create is new, 0600, owned by the running user. Reads can update access times on the filesystem (§3, item 1). | PASS, one disclosed filesystem side effect |
| 4 | Does not expose credentials, tokens, personal data or raw device identities | Secret-bearing locations are **never opened**: `identity-tokens`, `sessions`, `browser-profile`, `browser-sessions`, `sso-flow`, `enterprise-identity`, `social-identities`, `telegram_identities`, `slack_identities`, `identity-audit`, and any file named like `*oauth*`, `*token*`, `*secret*`, `*credential*`, `mcp-connections*`, `*.env`, `*.key`, `*.pem` (P7 plants unparseable files there and proves they are not read). Output contains only counts, enumerated values and row numbers. **Canary test:** an e-mail, a token, a device public key, a device id, real-looking tenant/owner ids and a task name were planted in the synthetic root; **none** appears in stdout, stderr or the private table (P3, P3b). Device records are classified by directory/owner kind only; no device identifier is printed. | PASS |
| 5 | Explicit input and output boundaries | Inputs: `--logs` (the private reconciliation table), `--root` (data root), optional `--probe-path` (metadata only), flags. Outputs: stdout (redacted JSON) and **at most one** new file at `--out`. Both are validated against the data root; the logs folder may not be inside the root. See §4 for the exact path list. | PASS |
| 6 | Bounded execution; redacted report | `--max-files 60000`, `--max-seconds 240`, `--max-file-bytes 2 MiB`, `--max-rows 5000`; limits abort with exit 3 and write nothing (P5, P5b). The run is single-threaded, synchronous, and intended under `nice`/`ionice`/`timeout`. Report fields are listed in §5. | PASS |

**Test evidence.** `scripts/ops/data-incident-decision-annex.selftest.mjs` — 26 checks, all PASS on Windows (Node v24.18.0) and on a disposable Ubuntu runner (Node v24.21.0), the latter on the exact final commit: GitHub Actions run 38707738013 (`ci/d09-annex-selftest-20261015`, throwaway branch, synthetic data only). The production host runs Node v24.19.0, which lies between the two tested versions; the self-test is **not** run on the host (no test is to be executed there) — instead the capability check in §4 step 1 confirms the permission model is enforced on that exact binary before anything is read.

## 3. Residual limits, stated plainly

1. **Access times.** Reading a file can update its atime depending on the mount options (`relatime` updates it at most once a day or when older than mtime). This is a filesystem effect, not a change to any record's content, size, mtime or mode, and it is the same side effect the earlier approved reconciliation and the online backup had.
2. **The executing account can write to the data root** (the incident proved it: the same account's test run wrote there). The "no write" guarantee therefore rests on the reviewed code **and** on the Node permission model flags in §4 — which is why the command must be run with them. Without `--permission` the OS would not stop a bug.
3. **Transient handling of personal content.** To find which tenants/owners already exist, the tool parses every non-secret JSON record in memory and keeps only id strings (`tenantId`, `ownerId`, `userId`, `principalId`) and a whitelisted status token. That includes records of user-content stores (vault, conversations, memories, knowledge, documents, images, presentations, artifacts, captures, notifications, activity) and the identity/organization stores (needed to recognise registered accounts). This is the same scope as the reconciliation that was already approved; nothing is printed or persisted. It can be narrowed (`--no-identity-read`, `--skip-dir <name>`), at the price of "partial" results (owner kinds degrade, reference coverage falls) — the report states when that happened.
4. **Private table.** The optional `--out` file holds row numbers, class, size, mtime, enumerated status, owner/tenant *kind*, 0/1 flags and row-number references — no ids or content — but it stays in the operator's private logs folder like the table it extends.
5. **Not covered by the script:** `/etc/nagex/nagex.env` and the unit definition (unreadable by the operator account / secret-bearing). §6 gives separate operator-run, redacted commands for those.
6. **The tool classifies; it does not decide.** Every quarantine/keep decision remains A1–A5, to be taken by the operator on the report.

## 4. Execution request — exact command, identity, permissions, paths

**Executing identity (choose one in §8):** (a) **the operator**, logged in as the operator account `redcloud`, runs the commands and pastes the redacted stdout back; or (b) **the assistant** runs exactly the same commands over SSH as the same account, only if the operator approves that expressly. In both cases: the account is `redcloud` (not the service account, not root), **no `sudo`**, no network access beyond the SSH session, no service interaction.
**Required permissions:** read access to `/var/lib/nagex` (already proven: this account's online `tar` of the whole tree ran with zero warnings), read/write in its own logs folder. Nothing more.

Script under review: `scripts/ops/data-incident-decision-annex.mjs` at ops commit `6db27ee` — 24 417 bytes, **SHA-256 `4018761c28303c63f65de5123b0108cd14e58272a1edd6a064811fb581f4af75`** (hash of the committed LF blob).

```
N=/home/redcloud/.nvm/versions/node/v24.19.0/bin/node
L=/home/redcloud/nagex-preflight-logs

# step 0 - the script must be placed in the private logs folder by the operator (copy from the repo at 6db27ee) and verified:
sha256sum $L/data-incident-decision-annex.mjs        # must print 4018761c...f4af75

# step 1 - capability check: the permission model must refuse a write on THIS node binary (a refused write creates nothing)
$N --permission --allow-fs-read=$L -e "try{require('fs').writeFileSync('/tmp/annex-perm-check','x');console.log('NOT ENFORCED - STOP')}catch(e){console.log(e.code)}"
                                                      # must print ERR_ACCESS_DENIED  (anything else: STOP, do not run step 2)

# step 2 - the run
nice -n 19 ionice -c3 timeout 300 $N --permission \
  --allow-fs-read=/var/lib/nagex \
  --allow-fs-read=$L \
  --allow-fs-read=/home/redcloud/services/nagex/source/.nagex_data \
  --allow-fs-read=/home/redcloud/services/nagex/source/artifacts/voice-quality \
  --allow-fs-write=$L/decision-annex-items.tsv \
  $L/data-incident-decision-annex.mjs \
  --logs $L --root /var/lib/nagex --out $L/decision-annex-items.tsv \
  --max-files 60000 --max-seconds 240 \
  --probe-path /home/redcloud/services/nagex/source/.nagex_data \
  --probe-path /home/redcloud/services/nagex/source/artifacts/voice-quality
```

| Item | Exactly |
|---|---|
| **Read** | `/var/lib/nagex` (all non-secret `*.json`, directory metadata); the private table `$L/reconciliation-added.tsv`; the metadata of the two probe paths (these are where the certified code can write outside the data root: the reminder store's working-directory fallback and the voice output default) |
| **Never read** | the secret-bearing directories/files in §2 row 4; `/etc/nagex/*`; other users' homes; the backups; the source code |
| **Written** | one new file `$L/decision-annex-items.tsv` (exclusive create, 0600) — and nothing else; the Node permission flags make any other write impossible |
| **Executed processes** | one `node`; no child process (denied by the permission model), no network |
| **Bounds** | 60 000 files, 240 s (plus `timeout 300` as a hard cap), 2 MiB per file, 5 000 rows; expected well under a minute for ~19 800 files on this host; `nice 19`/`ionice idle` so the service is not disturbed |
| **If a flag is unavailable** (`ionice`/`nice` missing) | drop that wrapper only; never drop `--permission` or the `--allow-fs-*` flags |

**Expected stdout (redacted JSON; ≤ ~10 KB):** `tool/mode/bounds`; `run` (files read, seconds, incident window); `scope` (counts read, skipped secret dirs/files, oversize, unparseable, identity read yes/no, personal-content directories read transiently, partial yes/no); `rows/candidates/blocked`; `closure` (candidates depending on blocked, blocked depending on candidates, candidates/blocked referenced by pre-existing records, candidates/blocked visible to a real owner); `unresolvedOwnership`; `byGroup` (per directory × CANDIDATE/BLOCKED: counts, owner kind and tenant kind distribution — demo / registered-account / other-preexisting / test-style-only / none —, status tokens, visibility, references, dependencies, daily-brief scheduler correlation); `blockedOwnerKinds`; `tasksTiming` (counts by status/type, next-run buckets and UTC-hour histogram for tasks that are not paused, daily-brief automation counts); `approvalsTiming` (pending counts, expiring, age); `durableRunsOutsideIncident` / `waitingContinuationsOutsideIncident`; `stateLocations` (top-level entry names with file counts/bytes/newest mtime, **unknown top-level entries by name**, probe-path existence and sizes); `privateOutput`. A sample from the synthetic run is reproduced by `ANNEX_SELFTEST_SHOW=1 node scripts/ops/data-incident-decision-annex.selftest.mjs` (it runs only on a temp directory).

**Abort behaviour:** a limit stops the run with exit 3 and a short JSON saying so; no table is written. An argument/path problem exits 2 with a usage line. Any other failure exits 1 with only an error code.

## 5. Operator-run companions (the script cannot see these; run only if you choose)

Both are read-only and redacted at the source; both need the operator's `sudo` for the unreadable env file only.

```
# O1 - which data-path / storage settings the service has (path-like values are printed; secrets never are)
sudo awk -F= '/^(export )?NAGEX_[A-Z0-9_]*(_DIR|_PATH|_ROOT)=/ {print $1"="$2} /^(export )?NAGEX_STORAGE_PROVIDER=/ {print $1"="$2} /^(export )?NAGEX_(S3_BUCKET|S3_ENDPOINT|S3_REGION|TOKEN_ENCRYPTION_KEY)=/ {print $1"=<set>"}' /etc/nagex/nagex.env
# O2 - how the service is launched (no environment values)
systemctl show nagex -p User -p WorkingDirectory -p ExecStart -p EnvironmentFiles
```
What they settle: whether any store directory is redirected away from `/var/lib/nagex`; whether object storage is **external** (`NAGEX_STORAGE_PROVIDER=s3` would keep creation payloads in an external bucket that the cold backup does **not** contain); whether token-encryption is configured (restart behaviour of OAuth connections); the exact working directory (to confirm the two probe paths).

## 6. Verified versus hypothetical — today (before any A6 evidence)

| Statement | Status | Basis |
|---|---|---|
| 368 added / 4 modified; 323 candidates / 45 BLOCKED; 323/323 re-verified; role records differ only in `updatedAt`; no change since | **VERIFIED** | reconciliation + dry-run (host, read-only, earlier) |
| Stores filter by tenant **and** owner after `readAll()`; a candidate can never be returned to a real owner; a BLOCKED record can | **VERIFIED** (source) | certified source, 13 stores read |
| Recovery acts only on `RUNNING` runs; the 5 waiting runs/continuations cannot be resumed; none has an approval/task in the live stores | **VERIFIED** | source + host data |
| `updatedAt` of roles is never used for authorization; roles are rewritten at every service start; definitions identical between `bcd7e10` and the candidate | **VERIFIED** | source + `git diff` |
| The certified code can keep state outside `/var/lib/nagex`: (a) reminder store → `NAGEX_PERSONAL_REMINDERS_DIR` or `<cwd>/.nagex_data/runtime`; (b) voice output → `NAGEX_TTS_OUTPUT_DIR` or `<cwd>/artifacts/voice-quality`; (c) OAuth/MCP token files → `/var/lib/nagex/<file>` or `~/.local/share/nagex`; (d) desktop agent → `~/.nagex/desktop`; (e) **object storage may be an external S3 bucket** when `NAGEX_STORAGE_PROVIDER=s3` | **VERIFIED as capability** (source); **whether production uses any of them is HYPOTHETICAL** | `source/.nagex_data/runtime` existed and was empty (earlier); the rest needs §4/§5 |
| The BLOCKED 38 overlap because they belong to the shared demo tenant | HYPOTHETICAL | needs `ownerKind`/`tenantKind` (A6) |
| The BLOCKED 38 overlap because of earlier test fixtures already in the live store | HYPOTHETICAL | needs A6 |
| Some BLOCKED records are genuine registered-account records | HYPOTHETICAL (not excluded) | needs A6 |
| The BLOCKED daily briefs could have been produced by the **live scheduler**: tasks carry `automationKind: DAILY_BRIEF`, and a recurring brief task that ran in the 45-minute window would write brief records for its owner | HYPOTHETICAL — **new mechanism found in this review**, directly testable | A6 field `briefTaskRanInWindow`, `tasksTiming.dailyBriefAutomation` |
| The 4 candidates classified by directory context only are test data | HYPOTHETICAL (weakest evidence class) | A6 `notParsed`/kinds |
| Candidates are not referenced by any pre-existing record; closure holds | partly verified (dry-run closure = 0 demotions, 0 referencing records found earlier); full cross-reference matrix pending | A6 `closure` block |
| Real active tasks fire inside a maintenance window | UNKNOWN | A6 `tasksTiming` |

## 7. How the evidence will drive A1–A5 (decision rules, fixed in advance)

| If A6 shows… | Then the recommendation is… |
|---|---|
| candidates: viewable-by-real-owner = 0, referenced-by-pre-existing = 0, candidates-depending-on-blocked = 0 | **A1: quarantine all 323** inside the cold-backup window (A2a), reversible, holding directory retained (A3) |
| any candidate viewable, referenced, or depending on a BLOCKED record | hold that class (and its closure) out of A1; re-derive the move list |
| BLOCKED groups whose owner kind is only **demo** | A5: quarantine after the operator attests that demo content is disposable (never delete) |
| BLOCKED groups with a **registered-account** owner | A5: keep untouched; inform that account's operator; no quarantine |
| BLOCKED daily briefs with `briefTaskRanInWindow` > 0 for their owner | treat as probably scheduler-produced and legitimate: keep |
| BLOCKED device identity/status whose owner is a registered account | keep; never move on inference |
| BLOCKED runs in `RUNNING` | never move while the service runs |
| owner kind `test-style-only` for a record the table blocked | contradiction → keep and investigate (scope was narrowed or the table is stale) |
| `resultsArePartial` = true | recommendations are provisional |
| active (not-paused) task due inside the planned window | adjust the window or pause per the runbook; do not start while a consequential task is due |
| unknown top-level entries | list them in A4 (empty test directories) or A1 (if they hold candidates) |
| external object storage or redirected store directories (§5) | add them to the cold-backup scope before A8 is scheduled |

## 8. Operator decision (nothing runs until one of these is given in writing)

| Option | Wording to give back | Effect |
|---|---|---|
| **A** operator runs it | "A6 APPROVED, operator-run, script sha256 4018761c…f4af75, commands as written in §4" and pastes stdout | assistant gets only the redacted JSON |
| **B** assistant runs it | "A6 APPROVED, assistant-run over SSH as redcloud, exactly the §4 commands" (and the permission layer must allow it; if it still refuses, option A) | assistant runs steps 1–2 and keeps only redacted output; the TSV stays on the host |
| **C** reduced scope | add `--no-identity-read` and/or `--skip-dir <names>` (for example `vault conversations memories knowledge`) to the command in A or B | results marked partial |
| **D** with the §5 companions | add "and O1/O2 run by the operator" | external/redirected state is established |
| **E** deny | "A6 DENIED" | no further facts; A1–A5 stay on hold; the 45 stay BLOCKED |

On approval I will produce, from the report only: the verified-vs-hypothetical register, the updated `D09_CLEANUP_DECISION_MATRIX.md`, the remaining blockers, and the A1–A5 recommendation by the rules in §7. Record-level identifiers stay in the private table on the host. I will not quarantine, delete, restore, deploy, restart or merge anything.

**RELEASE = NO-GO.**

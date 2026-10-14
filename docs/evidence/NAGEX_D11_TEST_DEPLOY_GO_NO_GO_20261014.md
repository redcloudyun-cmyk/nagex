# NAgex D-11 — Test Server Deployment GO/NO-GO Runbook

Date: 2026-10-14 (KST)  
Target: `nagex-test.agex.site` ONLY  
Candidate branch: `d11/advisory-plan-20261014`  
Reported tested code SHA: `f740cb9` (report-only commits may follow)  
Reported branch HEAD: `3926589`  
Reported running service revision: `faf38cc`  
Status: **PREPARED — NOT EXECUTED — EXPLICIT APPROVAL REQUIRED FOR CHANGES**

## 1. Known evidence and release intent

- Real Nemotron through Nebius: advisory 10/10 and action 10/10, repeated twice (40 calls total), no fallback in the final measured runs. These were **server-network script calls**, not live HTTP/UI certification.
- At tested code SHA: `npm run build` PASS; regression 2,854 total / 2,846 PASS / 0 FAIL / 8 SKIP; browser 227 total / 221 PASS / 0 FAIL / 6 SKIP.
- Advice-only input produces `ADVISORY_RESPONSE`, `executable:false`, no executable plan, approval, or actions. Action requests still require valid steps and existing Human Approval.
- On 2026-10-14 audit, 30 ACTIVE recurring jobs belonged to fixture identities only; 3 half-hourly fixtures cause approximately 84% of automated model traffic. This is a **past observation; re-check before any mutation**.
- The current live server was `faf38cc`; do not infer it has the approved candidate code from the Git worktree.
- All figures above are user-provided test evidence, not tests rerun by this runbook.

## 2. Mandatory hold points and authority

**HOLD A — Before task pause:** Obtain explicit operator authorization to pause (not delete) the exact fixture-owned task IDs on the NAgex test environment. Confirm each still belongs to one of the previously audited fixture identities, is ACTIVE, and is not a demo or real user task. If any identity, status, or ID differs, stop and request review.

**HOLD B — Before test deployment:** Obtain separate explicit operator authorization to change only the NAgex test checkout/binary and restart `nagex.service` with a tested candidate SHA, after backup and rollback readiness checks. Approval to produce this runbook is NOT deployment approval.

**Never** touch `main`, production sites, other projects, Cloudflare routing, billing, provider secrets, unrelated worktrees or data. Do not remove tasks, users, old artifacts, historical execution logs, tokens or memory. No force push/reset/clean.

## 3. Stage 0 — Read-only preflight (safe to run now)

Capture the following facts without printing secret values:

1. Local Git status, branch, HEAD and remotes; verify candidate HEAD includes exact tested code commit `f740cb9`. Compare with deployment baseline `faf38cc`; inspect diff and track unresolved conflicts.
2. Server `git rev-parse HEAD`, `git status --short`, `systemctl show nagex -p MainPID -p ExecMainStartTimestamp -p FragmentPath -p NRestarts`, currently responding `GET /api/v1/health`, public endpoint TLS and frontend build fingerprint.
3. Confirm current backend process is truly the checked-out `faf38cc` by the established binary fingerprint check. Record `RUNNING_PROCESS_SHA=UNKNOWN` if it cannot be proven. Do not trust checkout alone.
4. Check only environment **presence and configuration mode**, not values: Nebius model route, Google/Microsoft sign-in, data store locations, OAuth encryption key, storage provider, restart identity/permissions.
5. Read-only enumerate 30 recurring tasks. Capture task ID, owner, enabled/state, schedule and last execution. Compare against the 2026-10-14 advisory audit list. Separate 3 half-hourly from 27 daily. Do not call action-changing APIs.
6. Confirm backup target has capacity, is non-public, and is outside the Git checkout; inventory owner/mode of application storage.
7. Preserve `git status` and untracked files; check no other pending deploy, active migration or uncommitted work.

Output preflight evidence: `SERVER_CHECKOUT_SHA`, `RUNNING_PROCESS_SHA`, `FRONTEND_SHA`, `CANDIDATE_SHA`, `FIXTURE_JOBS_MATCH`, `STORE_BACKUP_READY`, `ROLLBACK_READY`, `GATE_STATUS`; use PASS/FAIL/BLOCKED/UNKNOWN.

**NO-GO** if active running process cannot be matched or any backup/storage issue exists.

## 4. Stage 1 — Fixture task pause (requires HOLD A authorization)

Order of operations:

1. Create protected rollback evidence of the **task records only**, including owner, schedule, original ACTIVE state, timestamps and identifiers. No raw secrets; never publish to Git or logs.
2. Re-verify the three high-frequency tasks (each must be fixture-owned and ACTIVE):
   - `tsk_2f0dce961b9bb18e`
   - `tsk_7d95c7d7e002d0d0`
   - `tsk_eaca7a4c268cc4ce`
3. Pause via NAgex's canonical authenticated task/scheduler API or approved management path **as those owners / with proper authority**, not by mutating JSON/files blindly. Verify their stored state is PAUSED/DISABLED and next run is no longer eligible.
4. Pause the remaining **27 verified fixture-owned recurring jobs** by explicit inventory only; if any owner/status mismatches, stop and report it rather than mass-selecting by name.
5. Verify: **30 fixture tasks paused, 0 deleted, 0 real-user/demo tasks changed**, no new scheduled execution from them. If in-flight tasks exist, separately observe/allow safe completion.
6. Keep a reversible restore list. Do not restore automatically after rollout; restore only by a new explicit decision.

If canonical API/authority does not support pausing the fixture tasks safely, report BLOCKED. Never improvise direct file edits.

## 5. Stage 2 — Artifact/data backup + release candidate (requires HOLD B authorization)

**Before modifying server:**

- Preserve baseline `faf38cc` checkout/build and service unit environment; capture current PID/start timestamp, health, static fingerprint. Archive configuration **securely without exposing tokens**.
- Back up the persistent user data (task, approvals, executions, vault, documents/creations, encrypted OAuth credentials) in a protected, access-controlled location. Verify archive readability/checksums and restore instructions. Backups must not be published to GitHub.
- Capture candidate SHA with all files tracked, no secret diffs. Build candidate in an **isolated release directory/worktree**. Do not modify the currently serving checkout for compilation or run tests using active state directories.
- Run `npm ci` (lockfile), `npm run build`, `npm test`, `npm run test:browser-cert` against the candidate. Fresh `dist`, zero failures. Record total/PASS/FAIL/SKIP. Never run integration fixtures against shared user data.
- Verify candidate's exact code revision is either `f740cb9` plus document-only changes or independently tested if runtime files changed.
- Confirm service unit can point to the isolated candidate and roll back to preserved `faf38cc`; do not change unrelated services.

**GO** only if build, regression, browser, backup verification, rollback rehearsal, fixture pause and approvals all PASS. If any fails, leave the old process serving.

## 6. Stage 3 — Controlled test-only cutover (requires HOLD B authorization)

1. Schedule brief maintenance window; note exact current healthy baseline.
2. Switch **only** the NAgex test service's code target atomically to the verified release directory, using the site's documented deployment method. No migration unless separately approved and backed up.
3. Restart **only** `nagex.service`. Verify it is ACTIVE with a *new* PID/start timestamp, and compiled app files match deployed candidate SHA. A `git rev-parse` in the checkout alone is insufficient.
4. Test internal and external `/api/v1/health`, auth page/session, EN/KR Home, desktop and mobile key widths, no raw localization keys.
5. Verify **real API→model** via a disposable signed-in demo account, not only scratch script: advice request → `ADVISORY_RESPONSE`, `executable:false`, no plan/approval; action request → valid plan, **no execution without approval**. Audit must show `provider=nebius`, actual Nemotron model, expected task and fallback reason if any. No secret/prompt output in shared logs.
6. Confirm the 30 fixture recurring jobs remain paused and model-call storms have ceased; monitor restart and errors.
7. Do not pretend UI E2E success unless actual browser clicks and API responses are observed.

**Automatic rollback trigger:** health failure, auth/session failure, blank UI, unexpected unauthorized execution, exposed credentials, data migration/data loss, new fixture storm, repeated model-routing failure or P0 crash. Roll back to preserved `faf38cc` service code using the tested method and verify health/session; do not blanket-restore newer production data over older data blindly.

## 7. Stage 4 — Demo readiness acceptance

After successful deployment:
- One advice prompt on Home completes with real Nemotron and no approval/action.
- One explicit action prompt completes planning with Nemotron; approval is visibly required before execution.
- Document creation → durable save → Recent → Open after reload with owner isolation on the deployed server. If no external document provider, report BLOCKED truthfully.
- A benign executable action via an already-configured provider, approved once and verified via Activity. Current Google app credentials are reportedly absent, so don't fake Calendar/Gmail. Safe browser tool may be used only with a disposable destination and real approval.
- Repeat demo 3× with same deployed SHA, record latency and actual provider traces. Keep video editing separate from correctness.
- Record `DEPLOYED_SHA`, `APP_SHA`, `NEMOTRON_REAL_HTTP`, `ADVISORY_UI`, `ACTION_APPROVAL`, `REAL_DOCUMENT`, `DEMO_E2E`, `ROLLBACK_READY`, and all test counts.

## 8. Reporting template

```
GO_NO_GO=BLOCKED|GO|ROLLBACK
APPROVAL_TASK_PAUSE=NO|YES
APPROVAL_DEPLOY_RESTART=NO|YES
CURRENT_SERVER_SHA=
RUNNING_PROCESS_SHA=
CANDIDATE_SHA=
TESTED_SOURCE_SHA=
FIXTURE_ACTIVE_BEFORE=
FIXTURE_PAUSED_AFTER=
REAL_USER_TASKS_CHANGED=0
DATA_BACKUP=PASS|FAIL|NOT_RUN
ROLLBACK=PASS|FAIL|NOT_RUN
BUILD=PASS|FAIL|NOT_RUN
REGRESSION=PASS|FAIL|NOT_RUN
BROWSER_CERT=PASS|FAIL|NOT_RUN
REAL_NEMOTRON_HTTP=PASS|FAIL|NOT_RUN
ADVISORY_UI=PASS|FAIL|NOT_RUN
HUMAN_APPROVAL=PASS|FAIL|NOT_RUN
REAL_DOCUMENT_SAVE_OPEN=PASS|FAIL|NOT_RUN
DEPLOYMENT=NOT_RUN|PASS|FAIL|ROLLED_BACK
```

## 9. Immediate next instruction

Perform **Stage 0 read-only preflight only** and report the table above, especially fixture owner/status drift and actual serving process version. Do **not** proceed past HOLD A or HOLD B without the user's explicit approval.

No action described here has been executed merely because this runbook exists.

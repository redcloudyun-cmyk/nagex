# NAgex D-09 — Final-SHA Windows/Linux CI Certification (PR #17 release candidate)

Date: 2026-10-15 KST
Source SHA (the only certified target): `068f13dc3a11fc5d5df41b3019c8b6febaff5269`
Branch: `release/d09-pr16-p0-integrated-20261015` (Draft PR #17, base `integration/d09-vault-home-20261015`). Branch tip re-checked before and after the runs: still `068f13d`; no commit was added, nothing was edited, no test skipped or modified.
Execution order followed: `NAGEX_D09_FINAL_SHA_CI_EXECUTION_ORDER_20261015.md` (ops branch commit `67b764a`).
Verdict: **Windows PASS, Linux PASS, Linux writable-`/var/lib/nagex` sentinel UNCHANGED. Release remains NO-GO — only the CI gate is closed; the operational gates below are open.**

## 1. Runs

| Where | Environment | Evidence |
|---|---|---|
| GitHub Actions, workflow `D09 PR16 Final SHA Cert` (push of the exact SHA; matrix `ubuntu-latest` + `windows-latest`) | Linux: Ubuntu 24.04 runner image `20261012.334`, Node v24.21.0. Windows: `windows-latest`, Node v24.21.0. Disposable hosted runners. | run https://github.com/redcloudyun-cmyk/nagex/actions/runs/38701931968, `headSha` = `068f13dc…5269`, created 07:54:30Z, finished 08:13:15Z. Each job's last step prints `TESTED_SHA=068f13dc3a11fc5d5df41b3019c8b6febaff5269` and its OS. |
| Local isolated Windows development machine | Windows 11 Pro, Node v24.18.0, **fresh detached worktree** at the exact SHA (`git rev-parse HEAD` = `068f13d…`, clean), `npm ci` exit 0 | this machine only; not the NAgex service host |

Both used the canonical gates (`npm ci`, `npm run build`, `npm test`, `npm run test:browser-cert`), which load `dist/tests/_setup.js`; `NAGEX_TEST_CONCURRENCY=2`, and the gate printed `Concurrency: 2 test file(s) at a time` for both gates on every platform. No timeout, skip or scope modification was used. `CI_WORKFLOW_SHA` = `SOURCE_SHA` (the workflow is part of the pinned commit); no temporary CI branch was needed for this certification.

## 2. Results

| Platform | Build | Regression (`npm test`) | Browser (`npm run test:browser-cert`) |
|---|---|---|---|
| **Linux** (Ubuntu 24.04, CI) | exit 0 | **3066 tests · 3062 PASS · 0 FAIL · 4 SKIP** (67 s) | **324 tests · 318 PASS · 0 FAIL · 6 SKIP** (304 s) |
| **Windows** (windows-latest, CI) | exit 0 | **3066 tests · 3058 PASS · 0 FAIL · 8 SKIP** (179 s) | **324 tests · 318 PASS · 0 FAIL · 6 SKIP** (839 s) |
| **Windows** (local dev machine) | exit 0 | **3066 tests · 3058 PASS · 0 FAIL · 8 SKIP** (102 s) | **324 tests · 318 PASS · 0 FAIL · 6 SKIP** (392 s) |

Skips are the pre-existing, declared ones — none was added by this candidate:
- Regression, all platforms: 4 retired end-user password-authentication tests (password sign-in was disabled by commit `8a25f7c`; replacement contract `auth_google_microsoft_only`).
- Regression, Windows only: 4 graceful-shutdown tests that need real SIGTERM/SIGINT delivery (they **run and pass on Linux**, which is why Linux shows 4 skips and Windows 8).
- Browser, all platforms: 6 declared retirements (two superseded R23 dashboard certifications; the desktop-preferences UI retirement group; R24.6C1/R24.6D disposable-account suites).

Counts are identical across the three runs (3066 / 324), so the platforms exercised the same suite.

## 3. Linux data isolation — writable `/var/lib/nagex` sentinel

On the ephemeral Ubuntu runner the workflow first required that `/var/lib/nagex` did **not** exist, created it writable (mode 0777, owned by the runner user), planted a pre-existing record, and recorded **SHA-256, size and mtime (ns) of every file** before the build. After `npm test` and `npm run test:browser-cert` (and even if one had failed — the step is `if: always()`), it re-snapshotted and compared.

Result: `PASS: Linux writable /var/lib/nagex unchanged including content, size and mtime` — **sentinel unchanged: YES.** The same condition that caused the incident (a writable `/var/lib/nagex` and unlisted stores) was present on the runner for ~6 minutes of test execution.

Scope of that check and what corroborates it (stated so it is not over-read):
- The workflow's snapshot covers regular files (content, size, mtime, count); a directory created without a file, or a permission change, would not show in it. Corroboration: run 38690186374 on `ci/d09-linux-verify-combined-20261015` (`f287629`) used `find -printf` over all entries, including directories, and found the sentinel identical, with 4/4 role records keeping their original `updatedAt` and no fallback directory created. **`git diff f287629 068f13d` shows no difference in `src/`, `tests/`, `scripts/`, `public/`, `package.json`, `package-lock.json` or `tsconfig.json`** — only the two evidence documents and the workflow files differ — so that directory-level result applies to this source tree.
- The check is sensitive: in run 38689751798 the **unfixed** base wrote 128 files into the same kind of sentinel.
- The sentinel here holds one pre-existing record; its power comes from the whole suite being run against a writable production root, not from sentinel size.
- Local Windows machine: the final-SHA run created no write in the per-user fallback data directories (their top-level directory timestamps pre-date this run).

## 4. What this certification does and does not close

Closed (P0-4 item 5): final-SHA full regression + browser certification on isolated Windows and Linux hosts for `068f13d`.

Still open — release remains **NO-GO**, nothing below was attempted or is authorized:
- Operator decision on the 323 test-only cleanup candidates; ownership of the 45 BLOCKED records; the four built-in role records (`updatedAt` only). No deletion, move, edit or restore was done.
- Consistent cold backup in an authorized stopped-service maintenance window.
- Hosted end-to-end after a separate deploy authorization. The test server is unchanged (`bcd7e10`); no `systemctl`, no source replacement, no deployment, no main merge, no service-host test.
- PR #17 stays Draft.

Earlier workflow runs on this branch for other SHAs (`ca9dddf`, `6549ef4`) are not part of this certification and were not relied on.

## 5. Next

GO only for the **next operator decision** (cleanup/quarantine authorization and maintenance-window planning). No automatic deploy or data change follows from this document.

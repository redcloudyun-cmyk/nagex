# NAgex D-09 — FINAL SHA Windows/Linux CI Execution Handoff
Date: 2026-10-15 KST
CURRENT STATUS: NO-GO. Code assembled, **FINAL-SHA Windows/Linux execution NOT_RUN** at time of writing.
Release branch: `release/d09-pr16-p0-integrated-20261015`
Exact candidate SHA: `068f13dc3a11fc5d5df41b3019c8b6febaff5269`
Draft PR: https://github.com/redcloudyun-cmyk/nagex/pull/17
Scope approval: CI tests in fully disposable Windows/Linux environments only; no service-host work or data remediation/backup/deploy approval.

## Integration already completed
- Based on PR #16 source line `2140f9e`.
- Applied **disjoint** files from:
  (1) `fix/task-store-order-test-20261015`,
  (2) `fix/test-data-isolation-20261015`,
  (3) `fix/outbound-ipv6-ssrf-20261015`.
- 19 changed files; every patch file SHA compared against feature-branch source. No merge to main or Voice WIP.
- GitHub Actions workflow `.github/workflows/d09-pr16-final-sha-cert.yml` newly added, last amended to create a **writable** `/var/lib/nagex` sentinel on an EPHEMERAL Ubuntu runner and verify its file SHA/mtime/count unmodified *even if a test step fails*.
- The GitHub connector's commit workflow-run lookup returned no runs; this is **not evidence of CI PASS or proof that Actions is disabled** (that lookup may only cover PR-triggered runs).

## Agent operating instructions
1. Confirm exact branch tip and no additional commits; if tip changes, NEW SHA is the only future cert target.
2. Run isolated Windows (developer/CI, not live host) and ephemeral GitHub Linux using the source SHA **above**. Run `npm ci`, `npm run build`, `npm test`, `npm run test:browser-cert`.
3. For Linux, create a disposable writable `/var/lib/nagex` with sentinel file, hash/size/mtime snapshot before tests, verify after tests. A write into sentinel is a **hard fail** even if all tests PASS.
4. Ensure the tests are started with the canonical `dist/tests/_setup.js` via the gate; no direct browser suite without the test setup. Use `NAGEX_TEST_CONCURRENCY=2` for consistent CI, but report actual parallelism and do not use timeouts/skip modifications.
5. If GitHub Actions does not start on feature-branch push: use existing authorized CI access to trigger the workflow or run a **temporary isolated CI branch** pinned to exact SHA + workflow-only adjustment, reporting both `SOURCE_SHA` and `CI_WORKFLOW_SHA`; DO NOT label that branch itself as the deploy candidate or silently merge the CI workflow into main. Do not ask for secrets or make an unapproved service-host fallback.
6. Do not read/copy current service host credentials, cookies, /var/lib/nagex, private incident manifest or online backups into CI or artifacts.
7. Archive only non-sensitive test counts/logs, OS/Node details, exact source SHA, Linux sentinel comparison and remaining failures.
8. If Windows+Linux both PASS, write `NAGEX_D09_FINAL_SHA_CI_CERT_20261015.md` on the OPS branch (not candidate release branch) with pass/fail/skip counts, GitHub run URLs and SHA; maintain NO-GO for live data until separate authorization.
9. If any test fails, report exact logs and a minimal fix proposal **without** editing the candidate branch prematurely. Follow-on fix → new SHA → both platforms re-run.

## Current operational blockers
- 323 test-only records are cleanup candidates (but unquarantined); 45 remain BLOCKED due to ownership overlap; 4 built-in RBAC records had timestamps changed only. **No deletion/move/edit authorized**.
- No consistent cold backup or hosted user E2E completed. No `systemctl`, no deployed source switch, no hosted writes, no main merge.
- PR #17 remains Draft and NO-GO regardless of passing CI, pending future maintenance/operator decisions.

## End condition
Send concise Korean report: candidate SHA, Windows/Linux runs, Linux sentinel unchanged YES/NO, gates, open incidents, GO for ***next operator decision only*** vs NO-GO. Stop. No automatic deploy or data changes.

# NAgex D-09 — P0 Incident Response: Integrator Status (NO-GO)

Date: 2026-10-15 KST
Decision: **RELEASE REMAINS NO-GO.** Two blocking defects are fixed on separate branches and certified; the live-data cleanup, the cold backup and the final-SHA gates are still open. Nothing was done to the service host: no `systemctl`, no source replacement, no data cleanup/move/restore, no role-record edit, no redeploy, no test execution there. No main merge.

## 1. Deliverables

| # | Item | Branch / location | Commit | Evidence |
|---|---|---|---|---|
| 1 | Read-only reconciliation, 368 + 4 accounting, 5 waiting records, dry-run cleanup plan | `ops/d09-pr16-preflight-only-20261015` | `e1ab3e3` | `NAGEX_D09_DATA_INCIDENT_RECONCILIATION_20261015.md` |
| 2 | Test data isolation fix | `fix/test-data-isolation-20261015` | code `89850cc`, cert `7a85506` | `NAGEX_D09_TEST_ISOLATION_FIX_CERT_20261015.md` (on that branch) |
| 3 | Linux IPv6 SSRF classification fix | `fix/outbound-ipv6-ssrf-20261015` | code `66db0c0`, cert `1ce5b6e` | `NAGEX_D09_IPV6_POLICY_FIX_CERT_20261015.md` (on that branch) |
| 4 | Deterministic ordering for a flaky Linux test found by the Linux run (unrelated to 2 and 3) | `fix/task-store-order-test-20261015` | `fe12d70` | commit message; one test, injected clock |

All three fix branches are based on `2140f9e` (PR #16 integration head), touch **disjoint files**, and merge without conflict. Items 2–4 each have their own commit; none is merged anywhere. Throwaway verification branches `ci/d09-linux-verify-{isolation,ipv6,combined}-20261015` carry only a workflow file on top of the fixes; they exist solely to run on GitHub-hosted Linux and are not for merging (delete on request).

## 2. Results

- **Incident (read-only):** 368 added records → 323 provable test-only cleanup candidates, 45 BLOCKED (ownership not provable); 4 modified built-in role records differ only in `updatedAt`; no change since the incident. The 5 waiting runs and 5 waiting continuations cannot be resumed or executed by any restart-recovery or user-reachable path (their approvals and tasks do not exist in the live stores; recovery touches only `RUNNING` runs). Dry-run: 323/323 re-verified, 0 problems. Nothing was changed.
- **Isolation fix:** explicit test mode, resolver + path assertion + process tripwire, table-driven inventory with source scan (a future store that bypasses the resolver fails), negative cases, sentinel proof. Windows: build ok, regression 3059/0 fail, browser 324/0 fail. Linux with a real writable `/var/lib/nagex` sentinel: unchanged byte-for-byte; the unfixed base wrote 128 files into it.
- **IPv6 fix:** private/mapped/NAT64/6to4/ULA/link-local literals refused as `OUTBOUND_PRIVATE_IPV6` with no DNS involved; on Linux the base refused them only through `ENOTFOUND`. Windows: regression 2993/0 fail, browser 324/0 fail. Linux: focused 12/12 (base: 4/5), combined candidate regression 3066 / 0 fail, browser 324 / 0 fail.

## 3. Release gates (directive P0-4)

| Gate | State |
|---|---|
| Cleanup / quarantine operator decision (and evidence of its effect on waiting continuations, role records, service) | **OPEN** — plan ready; needs explicit authorization and a quiescence decision |
| Ownership decision for the 45 BLOCKED records | **OPEN** |
| Four built-in role records (`updatedAt` only) | **OPEN** — leave or restore after proof of no legitimate change; separate authorization |
| Test isolation fix with demonstrable zero writes | **DONE on branch** — not merged |
| IPv6 SSRF fix, Linux PASS | **DONE on branch** — not merged |
| Consistent cold backup in an authorized stopped-service maintenance window | **NOT DONE** |
| Exact final SHA: full regression + browser on an isolated CI host | **NOT DONE for a release SHA** — the combined throwaway merge passed on Linux; the actual release candidate (PR #16 line + these fixes) must be re-run once it is assembled |
| Hosted E2E after a separate deploy authorization | **NOT RUN** |

## 4. What this work did not do, and decisions it leaves to the operator

- It did not merge the fix branches into the PR #16 line or build the release candidate — the order and the assembly are an operator/integration decision (suggested: the ordering-test fix, then isolation, then IPv6; all disjoint).
- It did not run anything on the service host; the Linux evidence comes from ephemeral GitHub-hosted runners.
- Known follow-up, not done: `src/mcp/mcp-url-policy.ts` carries a second implementation of a similar address policy; it should converge on the classifier introduced here.
- Disclosure: while diagnosing one browser test I ran it once with isolation deliberately disabled on the development laptop; that wrote role records into the laptop's own per-user data directory. No gate run did, and no service host was involved.

Stopped here, awaiting separate approval before any operational step.

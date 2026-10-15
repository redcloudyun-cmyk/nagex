# D09 — Hosted End-to-End Plan (execute ONLY after deployment approval)

Date: 2026-10-15 KST · Status: **PLAN ONLY — NOT EXECUTED, NOT AUTHORIZED.** Nothing is deployed; the test server still runs `bcd7e10` (PID 2997023, `NRestarts` 0, `active`). · RELEASE = **NO-GO**
Gate: this plan starts **after** A11 (deployment of `068f13dc3a11fc5d5df41b3019c8b6febaff5269`) has been approved *and carried out by the operator*, the cold backup R0 is verified (`D09_COLD_BACKUP_RUNBOOK.md`), and the cleanup decisions A1–A7 are recorded. Approval to run this plan is **A12**; the boundary on real external actions is **A13**.
Evidence levels used in reports: *unit*, *local real browser*, *hosted*. Only a run listed here, on the deployed host, is *hosted*. Labels: PASS / FAIL / BLOCKED / NOT_RUN. Local-browser results are never presented as hosted proof (MASTER §7).

## 1. What it must prove (and what it must not do)

Prove, on the deployed host with real signed-in sessions: the deployed SHA is the certified SHA; the product's truthful states hold end to end (draft → approval → verified save → open); approval is human-controlled and cannot be bypassed; users cannot see each other's records; the SSRF guard classifies literal addresses on the production OS; nothing the test did leaks into other users' data. **The incident taught the cost of tests that write to a live store**, so this plan is built around *marked, diffed, removable* data and *no real external consequence*.

It must not: run any test gate (`npm test`, browser gates) on the host; touch real users' data; send mail, change calendars, call MCP tools with side effects, or execute any approval whose consequence is outside NAgex (A13); stop/restart the service (the only restart is the deployment's own); alter `/var/lib/nagex` by hand.

## 2. Preconditions

| # | Condition | Evidence |
|---|---|---|
| P1 | A11 approved and executed by the operator; service `active`, new PID, `NRestarts` 0 | `systemctl show nagex -p MainPID,NRestarts,ActiveEnterTimestamp` |
| P2 | Deployed `git rev-parse HEAD` = `068f13dc3a11fc5d5df41b3019c8b6febaff5269`, clean tree | read-only `git -C <source> rev-parse HEAD; status --short` |
| P3 | Health HTTP 200; version/commit reported by the app equals P2 if exposed | `curl` health |
| P4 | Cold backup R0 verified (V1–V11) and the off-host copy confirmed (A9) | runbook §5 |
| P5 | Cleanup state recorded: either A1 executed (holding directory exists, 45 BLOCKED untouched) or explicitly deferred | decision log |
| P6 | **Pre-test data manifest** of the data root taken read-only: per-directory file counts and a file list with size+mtime (private, host-local) | `find` listing, private |
| P7 | Test identities exist and are agreed (A12): a dedicated **E2E tenant** with **two** accounts (U1, U2) and, if OAuth is in scope, an operator-owned sandbox Google account; the operator's real account is not used for write tests | operator |
| P8 | Every E2E-created item carries the marker `e2e-d09-<date>` in its title/name (so the post-test cleanup is exact) | convention |
| P9 | Rollback decision-maker reachable during the run (slot rollback = deployment document §8) | operator |

If any precondition is false: stop, report BLOCKED.

## 3. Journeys (each: steps · expected truthful outcome · evidence · fail action)

Desktop 1440 and phone 390, English and Korean, unless noted. Signed-in as U1 unless noted.

| ID | Journey | Expected | Evidence (non-sensitive) |
|---|---|---|---|
| H0 | Identity of the deployment | health 200; SHA matches; served UI assets match the build (no stale cache: hard reload) | screenshot of version/health, command outputs |
| H1 | Sign-in and Home | Home is the personal Home, greeting and avatar from the signed-in profile, no raw i18n keys, no technical/KPI dashboard, KR and EN complete, no stale state after switching accounts | screenshots KR/EN, desktop/phone |
| H2 | Home briefing truthfulness | briefing shows only what exists; empty state is stated as empty; nothing from the demo tenant appears for U1 (relevant to the 45 BLOCKED, `D09_OWNERSHIP_BLOCKERS.md`) | screenshots; count of items vs U1's own data |
| H3 | **Vault save through approval** ("summary → request → Approve → Open from Vault") | the draft preview shows the exact title/location/source/body; a request creates a waiting approval; **nothing is saved before Approve**; after Approve the item is written, re-read and only then reported saved ("verified"); "Open from Vault" shows the saved body; a fresh browser context lists it | step screenshots (`1-draft`, `2-waiting-approval`, `3-saved`, `4-opened-in-vault`), approval id kept private |
| H4 | Rejection / expiry / tamper | Reject leaves no item and says so; an edited or replayed approval is refused; no phantom "saved" | screenshots; Vault count unchanged |
| H5 | Document creation chain | request → document created → appears in Recent → Open shows the document; failures are shown as failures | screenshots |
| H6 | Slides creation chain (only if the deployed configuration really supports it) | if unsupported the UI must say unsupported, never "done" (MASTER §4) | screenshots |
| H7 | Tenant and ownership isolation | as **U2** (same tenant, different owner) and as an account of another tenant: none of U1's Vault items, documents, approvals, tasks or activity are visible or openable by id/URL | screenshots + request status codes |
| H8 | Approval governance | an action that needs approval cannot execute from a voice/chat shortcut or by re-posting the request; a changed payload requires re-approval | screenshots; no external effect |
| H9 | SSRF guard, production OS (through whichever user-facing path accepts a URL, e.g. link capture; if none is exposed in the deployed UI this is NOT_RUN, not simulated) | a request for `http://[::ffff:7f00:1]/`, `http://[fd00::1]/`, `http://169.254.169.254/` is refused **with the "private network" reason** and no outbound connection is attempted; a normal public https URL is accepted by the guard | UI/API responses (status + reason) |
| H10 | Mobile surfaces | phone Vault sheet opens a saved item; conversation area is visible (the 4 px collapse defect is fixed in the candidate); controls reachable at 360/390/430 | screenshots |
| H11 | Truthful failure | with the Vault intentionally unwritable this cannot be tested hosted without damaging the host — **not run hosted**; remains covered by the local real-browser suite (state this honestly) | — |
| H12 | Persistence across a session | log out/in as U1: items persist; no cross-session leak between U1 and U2 in the same browser profile | screenshots |

Not in scope hosted (and stated so): restart-recovery behaviour (needs a restart), the live model quality certification (certified separately in PR #14), anything requiring real third-party side effects (A13).

## 4. Data discipline (lessons from the incident)

1. **Marker + manifest diff.** After the run, take the post-test manifest and diff it against P6. The only allowed differences are files belonging to the E2E tenant. Any other new/changed file ⇒ **FAIL and stop** (and report it as a possible isolation defect).
2. **No test gates on the host.** The E2E is driven through the browser against the deployed UI by the operator or a client outside the host; nothing is installed or executed on the host by this plan.
3. **Cleanup of E2E residue** uses the same quarantine procedure as the incident cleanup (exact manifest, rename to a holding directory, reversible), under its own approval; never `rm`, never wildcard.
4. **Secrets**: no tokens, cookies or approval ids in reports; screenshots are reviewed for personal data before being committed anywhere.

## 5. Execution outline (after A12)

1. Record P1–P6. 2. Run H0, then H1–H2 (read-only observation). 3. Run H3–H8 for U1/U2 (writes only to the E2E tenant). 4. Run H9–H12. 5. Take the post-test manifest; diff; record. 6. Stop. The operator decides cleanup of E2E residue (separate approval) and whether the result lifts any NO-GO.

Total effort: ≈ 2–3 hours with two accounts; load on the host is small (one browser session), but run it at a quiet time because the host has 6.7 GiB RAM and was swapping.

## 6. Stop conditions and rollback

Stop immediately and report if: the health check fails or the PID/`NRestarts` changes unexpectedly; any journey shows a fake success (a "saved"/"sent" state with no verified record); an approval is accepted without a human action; cross-user data is visible; the manifest diff shows a file outside the E2E tenant; an unexpected external effect occurs. Rollback for the deployment is the slot swap in `NAGEX_D09_PR16_PREFLIGHT_RESULT_20261015.md` §8 (operator-run); data restore from R0 only by rename-aside (runbook §6). The E2E itself needs no rollback beyond cleaning its marked residue.

## 7. Report format (when it is run)

`DEPLOYED_SHA`, `PID/NRestarts`, `H0…H12` each with evidence level *hosted*, PASS/FAIL/BLOCKED/NOT_RUN and a screenshot index; `MANIFEST_DIFF` (allowed / unexpected counts); `EXTERNAL_ACTIONS` (must be 0 unless A13 says otherwise); `OPEN ISSUES`; verdict: whether the hosted gate is closed. **A passing hosted E2E does not by itself make RELEASE = GO**; that remains the operator's decision.

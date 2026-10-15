# NAgex D-09 — P0 Live Data Contamination: Containment, Isolation Fix, SSRF Fix
Date: 2026-10-15 KST
Status: **NO-GO / PLAN AND ISOLATED CODE FIXES ONLY**. No authorization for cleanup, removal, live data edit, systemctl, swap, deployment or main merge.
Source: `docs/evidence/NAGEX_D09_PR16_PREFLIGHT_RESULT_20261015.md` (head ff501bc).
Candidate release remains pinned to 660e15f56e130c9efd1df9c6af1c5f22d110702b; deployed service reportedly bcd7e10 PID 2997023; re-check read only.
Operator decision: (1) exact manifest-guided cleanup preferred, **not yet authorized**; (2) Linux IPv6 policy must be fixed before release; (3) test isolation mandatory before any host tests.

## P0-0 — containment without modifying live data
- No more npm test or browser-cert on service host, not even in candidate clone, until proven isolation and non-root fail-closed guard.
- No approval/execute of any test-owned waiting continuation; no task coordinator trigger, no hosted content creation and no service restart. If an unapproved restart is required for another incident, operator must assess and first quarantine these pending records under a separately approved plan.
- Leave 368 added records and four built-in RBAC records unchanged; preserve all forensic manifests (0600) and pre-test online archive. Do not publish filenames, identities, contents, hashes of secret material or copy backups to GitHub.
- Read-only checks may confirm current PID/health, added-file hashes, current service task counts and whether normal writes occurred since pre-test capture.

## P0-1 — incident reconciliation BEFORE a cleanup authorization
Produce a separate PRIVATE host-local manifest/table including for each candidate file: absolute canonical path, regular-file check (no symlink), directory prefix from fixed allowlist, file size, SHA256, owner/tenant claim, inferred test origin, compare with pre-test archive, last-modified. Include exactly four pre-existing RBAC role records with before/after hashes and parsed field-level diff.
- Do not trust path strings straight from manifest. Canonicalize and prove each resides under `/var/lib/nagex`; forbid traversal, symlinks, directories and unknown files.
- For each of 368, recheck `sha256` and size against original private snapshot and verify record still matches known test-only tenant/owner. If mismatch/ownership ambiguous, mark BLOCKED and exclude from any future cleanup.
- Account for pending 5 approvals, 5 continuations and run-status linkage; enumerate reference dependencies read-only and ensure deleting one member cannot leave a runnable continuation. A claim that they are 'inert' is not enough; trace recovery semantics, provider bindings, and fail closed.
- RBAC four `updatedAt` changes: preserve rather than touching under this order. Later targeted restoration requires proving the four records had no legitimate concurrent changes since the reference archive.
- Check for *all changes since incident*, including normal writes, and note that absence of session/identity/conversation changes in the historic window does NOT prove no later activity.
- Prepare a **dry-run cleanup plan**. Prefer exact manifest-based quarantine inside a private operator-controlled holding location after separately authorized quiescence, verify unrelated files bit-for-bit, and only then decide final deletion. Do not indiscriminately restore the online archive.
- No actual delete/move/copy back/restore permitted now. No global recursive deletion, `find -delete`, wildcard `rm`, chmod/chown over the live root, or altering RBAC timestamps to make diffs disappear.
- Recommend a separate explicit stop/maintenance authorization for the final cleanup if active service may read these paths; if current service cannot be safely quiesced, label cleanup BLOCKED. A live cleanup is NOT implicitly safe merely because tests appear inert.

## P0-2 — fix test isolation IN A SEPARATE isolated feature branch/worktree
- Study `src/governance/file-record.store.ts`, `tests/_setup.ts`, each `NAGEX_*_DIR` default and every `resolveNagexDataDir()` store constructor.
- In **test mode** every persistent store must resolve under a dedicated private temp root, with fail-closed enforcement: if test-mode path points into `/var/lib/nagex`, into another process's root or real user home data, abort before the first write. Explicit test fixture paths may be allowed only within designated isolated roots.
- Set and verify process-specific `NAGEX_TEST_DATA_ROOT` consistently across child-process, worker and Playwright/test server harness. Avoid redirecting production execution to a temporary test root. Test-mode detection must be explicit and hard to spoof accidentally.
- Implement table-driven inventory test for EVERY file-backed store; guard includes newly added future stores, not just a list of known env var names. Test negative cases when `/var/lib/nagex` exists and is writable, when env var absent, when some stores have custom values, and when symlink points out of test root.
- Negative guard must prove zero writes and zero role `updatedAt` changes to a simulated sentinel production root.
- Run builds + full regression + browser gates **only on isolated developer/CI host** first. Do not rerun full suites on the live host until isolation proof audited and operator separately allows it. No test skips to obtain PASS.

## P0-3 — fix Linux IPv6 URL SSRF guard IN A SEPARATE isolated branch/worktree
- Source `src/security/outbound-url-policy.ts`. WHATWG `URL.hostname` can be bracketed for IPv6. Canonicalize strictly, parse and reject private/reserved literal IPv6 including IPv4-mapped (e.g. `[::ffff:7f00:1]`, `[::ffff:127.0.0.1]`); do not treat DNS ENOTFOUND as a substitute for literal-address screening.
- Preserve deny-by-default policies for loopback/link-local/ULA/mapped RFC1918, metadata endpoints and numeric/encoded IPv4. Guard DNS rebinding and redirects with existing revalidation; not a URL string regex-only patch.
- Cross-platform tests Linux+Windows and malicious bracketed cases. Correct reason code and error classes. Do not weaken denial or merely change the test's expected message.
- Don't couple this SSRF patch to the Vault UI; separate commit and focused security cert, integrate sequentially.

## P0-4 — release NO-GO gates
PR16 release remains blocked until:
1. incident cleanup/quarantine operator decision and (if authorized) exact action evidence + effect on waiting continuations, built-in RBAC and service state;
2. test isolation fix with demonstrable zero writes into production root;
3. IPv6 SSRF fix Linux PASS;
4. verified consistent recovery backup during separately authorized stopped-service maintenance, not only provisional live tar;
5. exact final release SHA from integrated patches, full regression + browser on an isolated CI host; hosted signed-in E2E after separate deploy authorization.

## Outputs
- `docs/evidence/NAGEX_D09_DATA_INCIDENT_RECONCILIATION_20261015.md`: NON-SENSITIVE aggregate findings, dry-run plan, 368+4 accounting, status of 5 WAITING records, blockers, no data content.
- `docs/evidence/NAGEX_D09_TEST_ISOLATION_FIX_CERT_20261015.md`
- `docs/evidence/NAGEX_D09_IPV6_POLICY_FIX_CERT_20261015.md`
- Integrator's final NO-GO/GO evidence; all tasks explicitly separated between WRITE-ALLOWED new feature branches and live READ-ONLY inventory.
- Do not publish private host manifests, raw record IDs, user data, environment variables, backup archive or credentials.

**STOP after code / dry-run evidence. Seek explicit separate approval before manipulating live records or stopping/restarting the live service.**

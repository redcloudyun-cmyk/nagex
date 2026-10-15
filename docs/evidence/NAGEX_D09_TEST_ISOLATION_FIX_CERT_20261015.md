# NAgex D-09 — Test Data Isolation Fix: Certification

Date: 2026-10-15 KST
Branch: `fix/test-data-isolation-20261015` (base: `2140f9e`, head of the PR #16 integration branch). Independent of the IPv6 policy branch — no shared files.
Directive: `NAGEX_D09_LIVE_DATA_CONTAMINATION_RECOVERY_DIRECTIVE_20261015.md`, P0-2.
Status: **CERTIFIED: Windows development machine (§4) and ephemeral Linux runners with a real writable /var/lib/nagex sentinel (§6).** Not merged, not deployed, nothing run on the service host.

## 1. Root cause

`resolveNagexDataDir(subdir, envVar)` returned `/var/lib/nagex/<subdir>` whenever the env var was unset and that directory was writable. `tests/_setup.ts` redirected only the ~30 stores someone had remembered to list (and three single-file stores — OAuth token files, the MCP connection file — and the personal reminder store were resolved by separate code). Every store missing from that list silently wrote to the real data root on a host where `/var/lib/nagex` exists. This had already been patched one store at a time three times (R16 identity, R24.6C1 vault, R24.8B plans). In the incident the unlisted stores included the role store (which rewrites the built-in role records' `updatedAt` on every construction), durable task runs and task continuations.

## 2. The fix

| Piece | What it does |
|---|---|
| `src/governance/data-root-isolation.ts` | Explicit **test mode**: needs `NAGEX_TEST_DATA_ROOT` *and* `NAGEX_TEST_DATA_ROOT_OWNER_PID` naming a **live** process (leftover variables from a finished run cannot redirect a real server); refused outright when `NODE_ENV=production`. `assertIsolatedTestPath` allows only the private test root or the OS temp dir, judged on the **real** path (a symlink/junction inside the root pointing out is refused, also for not-yet-created paths), and forbids `/var/lib/nagex`, `~/.local/share/nagex`, `<cwd>/.nagex_data`, `~/.nagex` and anything in `NAGEX_TEST_FORBIDDEN_ROOTS`. It throws **before** anything is created. |
| `resolveNagexDataDir` / new `resolveNagexDataFile` | In test mode: an explicit override must pass the assertion; with no override the store is placed under the test root (so a store nobody listed is isolated by construction). Outside test mode: unchanged. GitHub/Google token files, MCP connection file and the personal reminder store now use the same path. |
| `tests/_fs_write_guard.ts` (loaded by `tests/_setup.ts`, and passed to every child process through `NODE_OPTIONS`) | Backstop for code that does not use the resolver: sync, callback, promise and stream forms of every filesystem mutation aimed at a forbidden location throw before reaching the OS. Reads and writes elsewhere are unaffected. |
| `tests/test_data_isolation.test.ts` (registered in both test registries) | The standing proof — see §3. |

Production behaviour (no test root in the environment) is byte-for-byte what it was; the production default root is still `/var/lib/nagex`.

## 3. The proof (73 tests, `test_data_isolation`)

- **Inventory, table-driven and self-extending:** the test scans `src/` for every `resolveNagexDataDir/File` call site (61+), and for each one — with its env var **absent** — requires the path to be inside the test root, an override aimed at the live root to throw, and an override inside the root to be honoured. A floor on the discovered count and a named list of known stores guard against a broken scanner; non-literal call sites must be named in a reviewed allow-list (2 today).
- **Future stores:** a source scan fails if any file other than the resolver, the isolation module and three reviewed exceptions names `/var/lib/nagex`, `.nagex_data`, `~/.local/share`, or calls `homedir()`. A new store that bypasses the resolver fails CI.
- **Negative cases required by the directive:** production root exists *and* is writable (test mode ignores it; without test mode the same call still picks it — behaviour preserved); env var absent; some stores custom (inside root, inside OS temp, aimed at a forbidden root); symlink/junction inside the root leading out (existing and not-yet-created paths); `NODE_ENV=production` with a test root; dead owner pid.
- **Zero writes to a sentinel production root:** a stand-in root populated like the real one (four built-in role records with a fixed old `updatedAt`, other directories) is registered as forbidden. In a **child process running the real harness**, with every store env var deleted, real stores (`RbacStore`, durable run store, continuation store, reminder store, token/MCP paths) are constructed and written. Result: the stores wrote into the private root (4 role records there), and the sentinel is identical file-for-file, size/mtime/SHA-256, and every sentinel role still has the old `updatedAt`.
- **Tripwire:** 15 different mutation forms aimed at the sentinel (sync, callback, promise, stream, rename/copy/unlink/rm/utimes/open-for-write) are all refused, including from a **grandchild process** that only has the tripwire through `NODE_OPTIONS`; reads and writes elsewhere still work.
- **Mutation check:** with the tripwire's installation removed the sentinel test fails (so it is sensitive).
- No test is skipped by this suite.

## 4. Gate results (final tree; development machine, Windows, Node 24)

| Gate | Result |
|---|---|
| `npm run build` | exit 0 |
| `npm test` (regression) | 3059 tests, **3051 pass, 0 fail, 8 skipped** |
| `npm run test:browser-cert` | 324 tests, **318 pass, 0 fail, 6 skipped** |

The skipped tests are the pre-existing ones, unchanged by this work: 4 graceful-shutdown tests that need real SIGTERM/SIGINT (POSIX only — they run in the Linux section), 4 retired password-authentication tests; the browser gate's 6 are the pre-existing retired-UI skips. Baseline of the same base commit: regression green, browser 318 pass / 0 fail.

The full suite found **two** things the stricter harness made visible, both fixed in test code (no weakening):
1. `r20_proactive_personal_assistant` kept its reminder fixtures in the working directory. They now live in the OS temp dir.
2. `r24_6b` "Devices shows no fabricated connected device" read the panel right after clicking the tab and raced the list fetch. It had passed only because the old harness's unlisted stores (large developer-machine data) slowed the server. It now waits for the rendered list and still asserts the same text.

No production source behaviour needed changing to get the suite green.

## 5. Disclosures

- During diagnosis of item 2 above, I ran that one browser test **with isolation deliberately disabled** on the development machine; that run wrote role records into this machine's own per-user fallback directory (`~/.local/share/nagex`). It is a developer laptop, not the service host and not a gate run; no gate run wrote outside the private roots (verified by directory timestamps).
- Writes through `FileRecordStore.write` log and swallow errors by design; a tripwire hit there blocks the write (nothing reaches the disk) but shows up as a persisted-failed log line and a missing record, not a thrown error. The resolver throws first for every known store, so this path is a second line only.
- The sentinel in the child-process test stands in for the production root through `NAGEX_TEST_FORBIDDEN_ROOTS`; the literal `/var/lib/nagex` is exercised by the Linux CI section below, where it exists and is writable.
- This fix does not clean or repair any live data (see the reconciliation report).

## 6. Linux validation (GitHub-hosted ephemeral Ubuntu runners — isolated hosts, not the service host)

Throwaway verification branches (never to be merged; workflow files exist only there) planted a **real, writable, populated `/var/lib/nagex`** on the runner — 4 built-in role records with `updatedAt` pinned to 2026-01-01, other directories — i.e. exactly the condition that caused the incident, recorded file metadata and SHA-256 of every file, ran the gates, and compared.

| Run | Tree | Result |
|---|---|---|
| A. Fix branch alone (`ci/d09-linux-verify-isolation-20261015`, fix `89850cc` + workflow `671762c`), run 38689751798 | regression: 3059 tests, 3054 pass, **1 fail**, 4 skipped (the 4 retired password-auth tests; the 4 POSIX signal tests RUN on Linux and pass) | The single failure is the outbound-policy IPv6 test — the separate, already-known Linux defect fixed on the IPv6 branch; this branch does not touch it. **Sentinel: metadata identical, content (SHA-256) identical, 4/4 role records still carry the original `updatedAt`, neither `~/.local/share/nagex` nor `~/.nagex` nor `<cwd>/.nagex_data` was created.** (The job stops at the failed regression step, so its browser step did not run; the combined run below covers it.) |
| B. **Control: the unfixed base** (`2140f9e`), same sentinel, same suite, run 38689751798 | the unfixed suite **wrote 128 files into the sentinel** (4 → 132 files) | Proves the check is sensitive: the incident reproduces on Linux with the old code. (This control did not reproduce the incident's four role-record rewrites — those depend on which test constructs a role store against the default directory — so the claim made here is the 128 new files.) |
| C. Combined candidate (isolation + IPv6 fix + a deterministic ordering test, `ci/d09-linux-verify-combined-20261015` at `f287629`), run 38690186374 | `npm run build` ok; **regression 3066 tests, 3062 pass, 0 fail, 4 skipped; browser gate 324 tests, 318 pass, 0 fail, 6 skipped** | **Sentinel metadata identical, content identical, 4/4 role records unchanged, no fallback location created.** |

Together with the 73-test `test_data_isolation` contract (which also ran and passed on Linux in A and C), this is the "zero writes into a production root, zero role `updatedAt` changes" proof the directive requires, on the real path `/var/lib/nagex` as well as on the simulated sentinel.

Limits: GitHub's runner is not the service host (different OS image, no systemd service, no real data); the proof is about the code and harness, which is what the fix changes. It does not validate anything about the live data root.

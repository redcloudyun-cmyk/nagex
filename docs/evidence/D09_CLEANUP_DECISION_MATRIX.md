# D09 — Cleanup Decision Matrix (323 cleanup candidates) and Operator Approval Matrix

Date: 2026-10-15 KST · Status: **READ-ONLY ANALYSIS. NOTHING WAS DELETED, MOVED, QUARANTINED, RESTORED OR EDITED.** · RELEASE = **NO-GO**
Certified source: `068f13dc3a11fc5d5df41b3019c8b6febaff5269` (PR #17, Draft) — unchanged; its CI evidence (`NAGEX_D09_FINAL_SHA_CI_CERT_20261015.md`, run 38701931968) is not touched by this package.
Companions: `D09_OWNERSHIP_BLOCKERS.md` (the 45 BLOCKED), `D09_ROLE_RECORD_REVIEW.md` (the 4 role records), `D09_COLD_BACKUP_RUNBOOK.md`, `D09_HOSTED_E2E_PLAN.md`. Incident basis: `NAGEX_D09_DATA_INCIDENT_RECONCILIATION_20261015.md`.

## 0. How to read this, and what is not yet known

This document contains **no record identifiers, file names, tenant/user identities, record contents or hashes**. The per-record table lives only on the host (private logs folder, mode 0600, outside the data root): `reconciliation-added.tsv` (368 rows: path, size, SHA-256, mtime, verdict). "Per item" below is therefore stated **per class of item** (13 candidate classes, every one of the 323 belongs to exactly one) with the class's evidence, owner, dependencies, risk and recovery. A row-level annex (owner kind, "would a real owner see it", references, dependencies, state, per record by row number) is **prepared but NOT RUN**: `scripts/ops/data-incident-decision-annex.mjs` (read-only; one private 0600 output; aggregates on stdout). Running it means reading the contents of records on the production host, which needs your explicit go-ahead (approval **A6**); my attempt to run a read-only probe there was refused by the permission layer and I did not work around it. Every claim below marked *(code)* comes from reading the certified source; *(measured)* from the reconciliation already reported; *(hypothesis)* is unverified until A6.

Window of the incident *(measured)*: all 368 records were written within 45 minutes (12:19–12:20 KST regression run; 12:27–12:59 browser runs); none was modified afterwards; no new file appeared since (re-checked). The service (PID 2997023, `bcd7e10`, `NRestarts=0`) was observed `active` again today.

## 1. Inventory — 323 candidates, 13 classes

Candidate = path canonical under the data root, regular file, no symlink, on the directory allowlist, size/SHA-256/mtime re-verified (323/323 unchanged, 0 problems in the dry-run), and **no pre-existing tenant or owner identifier** (a deliberately conservative rule: any overlap with the 431 pre-incident tenants / 909 owners makes a record BLOCKED instead). Evidence classes: **V** = verified by tenant/owner claim; **P** = payload file proven through its verified parent record; **D** = no tenant field, classified by directory context only (weakest).

| Class | Directory | N | Evidence | Owner (kind) | Notes |
|---|---|---:|---|---|---|
| C01 | durable task runs | 124 | V | test-style tenants/users only | run states for the whole added set were 87 SUCCEEDED / 35 FAILED / **5 WAITING_APPROVAL**; the 5 waiting runs are inside the candidate set (closure check: 0 demotions) |
| C02 | task continuations | 124 | V | test-style | 119 RESUMED / **5 WAITING**; every one points at a run in the added set (124/124) |
| C03 | artifacts | 18 | V | test-style | 7 further artifacts are BLOCKED |
| C04 | images (metadata) | 14 | V | test-style | 7 further are BLOCKED |
| C05 | image payloads | 14 | P | via parent | 7 further follow blocked parents |
| C06 | documents | 9 | V | test-style | the `documents` directory did not exist before the incident |
| C07 | presentations (metadata) | 6 | V | test-style | |
| C08 | presentation payloads | 6 | P | via parent | |
| C09 | memory settings | 4 | V or D | test-style | |
| C10 | device transport replay | 1 | V or D | test-style | replay-protection nonce record |
| C11 | role binding | 1 | V or D | test-style | binds a test membership to a role; see §3 |
| C12 | test idempotency stores | 2 | V or D | test-named directories | one file each in directories named for tests (`test_*`, `mc5a_*`) that exist only because of the run |

Totals *(measured)*: V 299 · P 20 · D 4 (the 4 D records are among C09–C12 — the annex identifies which). 124+124+18+14+14+9+6+6+4+1+1+2 = **323**.

## 2. Per-class decision record

Common facts that drive every class *(code)*:
- All the creation/identity/artifact stores read **all** files and then filter by `tenantId` **and** `ownerId`. A candidate (no pre-existing tenant or owner id) can therefore never be returned to a real user, whatever its content.
- Reads skip unreadable/missing files individually, so a file renamed away while the service runs cannot break a request. The one place that loads everything into memory at construction is the memory engine (C09); it keys by `tenant:owner` and writes back only a key that was modified, so a test key is never rewritten.
- Recovery on start (`recoverOnStartup`, `failInterruptedRuns`) acts only on durable runs in `RUNNING`; a `WAITING_APPROVAL` run is never touched; there is no added `RUNNING` run. A continuation is claimed only through its approval id via the approve/reject route; none of the 5 waiting continuations has an approval or task in the live stores (0 of 5).

| Class | Dependencies (closure) | Risk if LEFT | Risk if QUARANTINED | Recovery option |
|---|---|---|---|---|
| C01 runs | C02 continuations reference them (124 pairs). Move run + continuation together or not at all. 5 WAITING pairs. | Noise in start-up scans; the 5 WAITING pairs stay "pending" in a production store though nothing can approve them. No user impact. | Nothing reads a run without its task, which does not exist in the live stores. Moving only runs (not continuations) would orphan 124 continuations — forbidden by the closure rule. | Return by rename from the holding directory (byte-identical, hash-verified before and after). Not present in the pre-test backup (they are newer than it). |
| C02 continuations | point at C01 | as C01 | as C01 | as C01 |
| C03 artifacts | may reference C04/C06/C07 sources by id; the annex lists the exact rows | none for real users (owner filter) | none | rename back from holding |
| C04 + C05 images | each metadata record names its payload (`binaryStoragePath`): 14 pairs | none | an orphaned payload would be dead weight, a metadata record without payload would 404 for its (test) owner only — hence move pairs together | rename back |
| C06 documents | none beyond C03 | none | none | rename back |
| C07 + C08 presentations | 6 pairs (metadata + payload) | none | as C04 | rename back |
| C09 memory settings | loaded in memory at construction; no write-back unless modified | negligible | none for the running instance (already in memory); gone at next start | rename back |
| C10 replay record | none | none | dropping a replay nonce of a device that does not exist has no effect | rename back |
| C11 role binding | references a (test) organization/membership that is not in the live store | grants nothing (no live org or user) | none | rename back |
| C12 idempotency | none | none; the *directories* are new top-level entries of the data root | files removable; the empty test-named directories remain unless approved separately (A4) | rename back |

Overall: leaving the 323 is **inert for users but not clean** (production store polluted; at the next start the service scans them; 5 waiting records of a test tenant remain visible to anyone reading the store). Quarantining them is **low risk and fully reversible while the holding directory exists**. The only irreversible step would be the later deletion of the holding directory.

## 3. Class-specific notes

- **C01/C02, the five waiting pairs.** No path can resume them (see common facts). They are kept in the same move as their 119 resumed siblings so that no half-set is left. If the operator prefers to keep a forensic copy, quarantine (not delete) is the right action.
- **C11 role binding.** Roles are resolved through `(organization, membership)`; with no matching membership the binding is dead data. Check, with the annex, that its role id is a built-in id and its organization id is absent from the live `organizations` store.
- **C09 / C10 / C11 / C12 weakest evidence (D, 4 records).** These carry no tenant field; their classification rests on directory context. Recommend the operator either accepts that or asks for a content-shape check (A6) before they are moved. They are 4 of 323 and low-impact either way.
- **Empty directories.** Moving files out of `documents`, `mc5a_*`, `test_*` leaves empty directories in the data root. They are harmless for the service but visible in a directory listing; removing empty directories is a separate decision (A4).

## 4. Execution shape if approved (not executed; dry-run only so far)

The dry-run program already re-verifies all 323 and prints the plan (`MOVE (rename, same filesystem) 323 files into a private 0700 holding directory outside the data root, preserving relative paths; deletion later`). Preconditions it states: separate authorization; a quiescence decision; a fresh re-run with `problems == {}` immediately before; the 4 role records untouched; the 45 BLOCKED untouched. No `rm`, no wildcard, no recursive removal, no chmod/chown of the live root. Suggested place in time: **inside the cold-backup maintenance window**, after the as-is backup (see runbook §4), so the as-is state is a complete recovery point and the holding directory is a second one.

## 5. Operator approval matrix — everything that needs an explicit decision

Nothing in this list has been done or is assumed approved. "Default" is what happens if the operator decides nothing: **no action**.

| ID | Decision | Options | My recommendation | Risk of the recommended option | Reversible? | Default |
|---|---|---|---|---|---|---|
| **A1** | Quarantine the 323 candidates (move to the private holding directory) | (a) yes, exact manifest; (b) leave; (c) restore the whole pre-test archive (not recommended: rolls back legitimate writes; needs a stop) | (a) | low; only manifest-listed, hash-verified files move | yes, until holding directory is deleted | leave |
| **A2** | Quiescence for A1 | (a) inside the stop window of the cold backup (safest); (b) live move with an agreed proof that nothing reads those paths; (c) no move | (a) | requires the downtime that the backup needs anyway | n/a | (c) |
| **A3** | Holding directory: location, retention, and who decides the final deletion | e.g. operator-private, 7–14 days, then separate approval to delete | retain ≥ 7 days after the E2E, then decide | disk: ≈ 0.33 MB, none | deletion is irreversible | keep indefinitely |
| **A4** | Empty directories left behind (`documents`, test-named dirs, others) | remove / leave | leave until A1 is verified, then remove only empty ones listed by the annex | none | trivially recreated by the service | leave |
| **A5** | The 45 BLOCKED records, per group (see `D09_OWNERSHIP_BLOCKERS.md`) | keep / quarantine after attestation / content-probe first | keep untouched until A6 produces facts | leaving them keeps the pollution (user-visible risk for the overlapping owner) | yes | keep |
| **A6** | Permission to run the prepared **read-only** annex on the production host (reads record contents, writes one 0600 table in the operator's logs folder) | yes / no / operator runs it | yes — it is what turns the hypotheses in the ownership document into facts | reads only; load is small (≈ 19.8 k files once) | n/a | not run |
| **A7** | The 4 built-in role records (`updatedAt` only) | leave / restore bytes from the pre-test archive | **leave** (`D09_ROLE_RECORD_REVIEW.md`) | none | n/a | leave |
| **A8** | Cold-backup maintenance window: date/time, who runs `sudo systemctl stop/start nagex` | operator-run only | one window shared with A1/A2 and, later, the deploy | service downtime ≈ minutes | n/a | none scheduled |
| **A9** | Off-host / off-disk copy of the cold backup (the data root, backups and slots share one 233 GB disk, 149 GB free) | where, how encrypted | yes, to the operator's workstation or another host | the archive contains personal data | n/a | none |
| **A10** | Handling of `/etc/nagex/nagex.env` (secrets, unreadable by the service account) | operator copies separately, encrypted, never into the data archive or the repo | separate encrypted copy | secret exposure if mishandled | n/a | not backed up |
| **A11** | **Deployment** of `068f13d` (source swap + restart), exactly the documented ordered steps | yes / no | not before A1–A10 are settled | rollback slot exists (`source-faf38cc`, name `source-bcd7e10` is free) | yes (slot rollback) | no |
| **A12** | **Hosted E2E** execution, test accounts, data marker, who runs it | see `D09_HOSTED_E2E_PLAN.md` | after A11 only | writes test data into the live store (marked, diffed, removable) | partly | not run |
| **A13** | Which external actions the hosted E2E may actually perform (mail, calendar, MCP) | none / specific approved ones | none; only internal Vault/document actions | none | n/a | none |
| **A14** | PR #17 Draft → ready, and any merge/main decision | operator only | not part of this package | — | — | stays Draft; no main merge |
| **A15** | Accept the known follow-ups: a second SSRF classifier still exists in `src/mcp/mcp-url-policy.ts`; until A11 the live host runs the previous release (the isolation fix changes test behaviour only, no production behaviour) | accept / schedule | schedule after deployment | — | — | open |

## 6. Stop conditions for any later execution

Re-run the dry-run immediately before acting and stop on any non-empty `problems`; stop if the service PID, `NRestarts`, health or the data-root file count differ from what was recorded; stop if any BLOCKED path is in the move list; never run a test gate on the service host.

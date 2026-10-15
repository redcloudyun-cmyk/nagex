# D09 — Built-in Role Record Review (the 4 modified records)

Date: 2026-10-15 KST · Status: **READ-ONLY ANALYSIS. The four records were not edited, restored or touched.** · RELEASE = **NO-GO**
Approval ID: **A7** in `D09_CLEANUP_DECISION_MATRIX.md`. Basis: `NAGEX_D09_DATA_INCIDENT_RECONCILIATION_20261015.md` and the certified source `068f13d`.

## 1. What changed *(measured)*

Four files in the live `rbac-roles` directory — the four built-in system roles (owner, admin, member, viewer) — differ from the pre-test archive. A parsed, field-by-field comparison shows **`updatedAt` is the only changed field** in each (`roleId`, `name`, `description`, `isSystem`, `permissions`, `createdByUserId`, `createdAt`, `organizationId` identical). Each file's modification time is after the archive's. Since the incident: no further change to these or any other pre-existing record.

## 2. Why it happened *(code)*

`RbacStore`'s constructor calls `seedBuiltInRoles()`, which **rewrites all four built-in role records on every construction** (refreshing name, description and permissions from code and setting `updatedAt = now`) so that a permission added to the code always reaches the data directory. `createNagexApplication` constructs one `RbacStore` per process. The test run built applications against the live data root (the isolation defect), so it re-stamped the four records. The permission sets were rewritten **with identical content** because the candidate's and the deployed release's built-in role definitions are the same: `git diff bcd7e10 068f13d -- src/rbac` is empty.

Consequence for the live service itself: **every start of the service re-stamps the same four files**. The values in the pre-test archive are therefore simply the time of the service's previous start (2026-10-14 16:44:54 KST per `ActiveEnterTimestamp`) *(hypothesis; the annex or a byte comparison would confirm)*, and the next start — which any deployment performs — will overwrite them again.

## 3. Does `updatedAt` matter? *(code)*

- It is **written** in three places only: seeding, creating a custom role (`rbac.service`), updating a custom role. Built-in (`isSystem`) roles cannot be updated or deleted through the service.
- It is **never read** to make an authorization decision. Decisions use `permissions` (the union of the roles bound to a membership: its built-in role id plus any role bindings).
- It is not a security boundary, an ordering key or an audit trail. The only visible effect is the timestamp in a role listing, if one is shown.

So the permission semantics of every user, organization and membership are exactly what they were before the incident.

## 4. Dependencies

| Dependent | Relation to `updatedAt` |
|---|---|
| Memberships (built-in role id), role bindings, enterprise provisioning default role | reference the role **id** only |
| Custom roles | assigned through role bindings; effective permissions = union of the bound roles' `permissions` (`rbac.service`, effective-permission resolution) |
| `rbac-bindings` candidate record (class C11) | references a role id; unaffected |
| Audit | no audit event is produced by seeding |

## 5. Options

| Option | What it means | Risk | Reversible | Evidence needed | My recommendation |
|---|---|---|---|---|---|
| **O1 Leave as is; record it** | add a line to the incident record: "four built-in role records re-stamped (`updatedAt`) at the test run; permissions unchanged; the next start re-stamps them anyway" | none | n/a | this document | **Recommended** |
| O2 Restore the four files' bytes from the pre-test archive | write four files in the live root (atomic temp+rename) | writes to production data (a second mutation of the incident's kind); requires proof of no legitimate change since the archive (already shown: 0 other changes, but the proof must be re-run immediately before); the restored timestamps are overwritten by the next start in any case | yes (keep the current four as a copy) | fresh byte-level re-check; operator approval A7; ideally inside the stop window | not worth it |
| O3 Edit `updatedAt` in place to an "original-looking" value | forbidden by the directive (do not alter timestamps to make a diff disappear) | misrepresents history | — | — | **Do not** |
| O4 Restore the whole archive | rolls back every legitimate write since the archive | highest | partly | — | **Do not** |

## 6. Recovery information

The pre-test online archive (provisional; taken from the live service, verified by SHA-256, member listing and a disposable-directory extraction) holds the original four files; it is the only source of the previous bytes. The cold backup (runbook) taken in the maintenance window will contain the **re-stamped** versions, so if O2 is ever wanted, the online archive must be kept until A7 is decided. Retention of that archive is part of approval A3's retention decision.

## 7. Risk summary

| Item | Rating |
|---|---|
| Authorization / permission change | none (permissions byte-identical, definitions identical between releases) |
| User-visible change | none known (timestamp only) |
| Integrity of the audit story | the re-stamp is explained and recorded here; no silent alteration |
| Cost of leaving | nil — the deployment will overwrite the same field |
| Cost of restoring | a production write whose effect disappears at the next start |

Decision requested: **A7 — leave (O1)**, unless the operator wants the incident record to show the original timestamp for forensic reasons.

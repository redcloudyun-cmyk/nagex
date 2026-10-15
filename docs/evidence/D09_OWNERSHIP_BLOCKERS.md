# D09 — Ownership Blockers (the 45 BLOCKED records)

Date: 2026-10-15 KST · Status: **READ-ONLY ANALYSIS. The 45 records are untouched and stay untouched.** · RELEASE = **NO-GO**
Companions: `D09_CLEANUP_DECISION_MATRIX.md` (approval IDs A1–A15), `NAGEX_D09_DATA_INCIDENT_RECONCILIATION_20261015.md`.
No identifiers, names, contents or hashes appear here; per-record data stays in the host-private table (rows are referred to by group, not by id).

## 1. What BLOCKED means

A record is BLOCKED when it cannot be **proven** test-only. The rule was deliberately strict: any record whose tenant **or** owner identifier also occurs in the 19,417 pre-incident records (431 tenants, 909 owners) is blocked, and so is every payload file whose parent is blocked. A BLOCKED record is not a finding that it is real user data; it is a finding that deleting it would be a guess.

## 2. The 45, by group *(measured)*

| Group | Directory | N | Why blocked | State/kind known today |
|---|---|---:|---|---|
| B1 | daily briefs | 17 | tenant or owner also exists before the incident | brief records (content not read) |
| B2 | artifacts | 7 | same | — |
| B3 | images (metadata) | 7 | same | — |
| B4 | image payloads | 7 | parent (B3) is blocked | follow B3 exactly |
| B5 | durable task runs | 3 | same | run states of these three not separated from the 127 total (87 SUCCEEDED / 35 FAILED / 5 WAITING) |
| B6 | device connection status | 1 | same | — |
| B7 | device identities | 1 | same | a device record: see risk |
| B8 | mobile message runs | 1 | same | a message-run record: see risk |
| B9 | test idempotency store | 1 | same (in a directory named for a test) | — |
| | **Total** | **45** | 38 by owner/tenant overlap + 7 by blocked parent | |

None of them has a continuation (the 124 continuations all point at candidate runs).

## 3. Why the overlap exists — three explanations, none yet verified

1. **The shared demo tenant** *(hypothesis; code)*. The certified source defines a built-in demo tenant (`ten_demo_hackathon`) that the live service seeds and that browser/regression tests drive (`?demo=1` flows, demo canonicalisation tests). A test that wrote briefs, artifacts or images for the demo tenant wrote into a tenant that **already has pre-incident data**, so it overlaps by construction. Daily briefs (B1), artifacts and images are exactly what the demo Home produces.
2. **Earlier test fixtures already in the live store** *(hypothesis)*. Earlier hosted E2E/QA sessions and the 30 PAUSED fixture tasks mean the live store already contains test-style identifiers (`ten_*`, `usr_*`); a new test record with the same generic id overlaps. The rule treats that as a block although the record is still test data.
3. **A genuine account** *(cannot be excluded without reading)*. A record that carries a real tenant+owner pair would be a legitimate user record. Counter-evidence available today: during the incident window **no new file appeared in `sessions`, `identity*` or `conversations`** and `task-runs` did not change — nothing indicates a signed-in user was active. But the live service also runs schedulers, so absence of sessions does not by itself prove that a daily brief was not produced for a real user.

The facts that decide between 1/2/3 are the owner kind per record. They are exactly what the prepared annex computes (`scripts/ops/data-incident-decision-annex.mjs`: tenant kind, owner kind — demo / registered account / other pre-existing / test-style-only — and whether the pair is one that a real owner's list would return). **That needs approval A6; it was not run.**

## 4. Why this matters more than the 323 *(code)*

The list/get paths of the briefs, artifacts, images and device stores filter on tenant **and** owner. For a candidate (no pre-existing id) that filter can never match a real owner. For a BLOCKED record the filter **can** match: if its pair equals a real (or the demo) owner's pair, that owner's Home/Recent/device list **would show it**. So:

- *Leaving them* may keep test-generated items visible to the overlapping owner (user-visible pollution, e.g. an extra brief or item in Recent).
- *Deleting them by guess* may remove something that owner legitimately created in the window — and such a record is **newer than the pre-test backup, so the backup could not restore it**.

That asymmetry is why they are held back, and why any removal must be a quarantine (rename, reversible), never a deletion, until ownership is known.

## 5. Group-by-group risk and options

| Group | Risk if LEFT | Risk if QUARANTINED | Dependencies | Recovery | Options |
|---|---|---|---|---|---|
| B1 briefs (17) | an overlapping owner (probably the demo owner) sees test briefs in the Home briefing; briefing truthfulness (MASTER §7) is affected only if shown as real | if a brief was genuinely produced for a real user it disappears from their Home until restored (whether a refresh regenerates it was not verified) | none | rename back | **hold** until A6; if all 17 are demo/test-style → quarantine with A1 |
| B2 artifacts (7) | visible in Recent of the overlapping owner | the item vanishes from Recent; its source record may remain | may reference B3/B4 or candidate sources — closure must hold | rename back | hold until A6; move only together with every record it references |
| B3 + B4 images (7 + 7) | visible with a working payload | metadata and payload must move as a pair (7 pairs) | strict pair | rename back | as B2 |
| B5 runs (3) | three durable runs of an overlapping owner/tenant; states unknown to me — if any is `RUNNING` start-up recovery would try to resume it | if one is a real run in progress, moving it breaks its resumption | tasks/approvals of the owner | rename back | **hold; check the three states first** (annex). `RUNNING` ones must not be moved while the service runs |
| B6 + B7 device status / identity (1 + 1) | a device identity record is security-relevant: it carries a public key and trust state for an owner; a test-created device under a real owner's name would appear in "My devices" | removing a genuine device record would silently un-enrol a real device (revocation by accident) | B6 is keyed by a device id (probably B7's device; the annex confirms) | rename back | **never move on a guess**; check with the owner list; strongest reason for A6 |
| B8 mobile message run (1) | a message-run record of a (possibly real) owner; I did not verify whether a stored run can trigger any send | removing it changes a record of delivery history if real | recipient ref, device | rename back | hold until A6 |
| B9 idempotency (1) | none | none | — | rename back | candidate for A1 once its owner kind is known |

## 6. Resolution paths — what would move records out of BLOCKED

| Path | What it needs | Result |
|---|---|---|
| **R1 Annex (A6)** | permission to read the records on the host once, read-only | per-record owner kind and visibility; most BLOCKED items are expected to be classifiable as demo/test-style (hypothesis) — then the operator decides A5 per group with facts |
| **R2 Operator attestation** | the operator states which tenant/owner ids are demo/test-only | a record is released from BLOCKED only if its pair is on the attested list; everything else stays |
| **R3 Content-shape review** | operator-approved read of a few records by the operator (not me), looking for test markers in titles/sources | evidence for borderline items (e.g. briefs) |
| **R4 Leave them** | nothing | the 45 remain; the release stays NO-GO only if the operator treats them as a blocker |

Recommended sequence: A6 → classify the 45 → release groups that are demo/test-only to A1 (quarantine, reversible) → keep any group with a registered-account owner untouched and tell that owner's operator.

## 7. What this document does not claim

It does not claim the 45 are test data; it does not claim they are real. It identifies the facts that decide it and the cheapest read-only way to get them. Until then they remain exactly as the incident left them.

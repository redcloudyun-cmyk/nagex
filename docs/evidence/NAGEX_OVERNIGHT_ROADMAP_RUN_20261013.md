# Overnight roadmap run — 2026-10-13

**Branch:** `auto/roadmap-20261013` (pushed; not merged to `main`; not deployed)
**Gate commit:** `eb4b634` (plus a docs-only commit that adds this file and DEBT-0014)
**Design approval:** PENDING — no redesigned screen is declared CLOSED; the unapproved design was not extended to other screens.
**Voice WIP, other worktrees, secrets, approvals and authentication policy:** untouched.

## 1. Roadmap tasks worked

| ID | Outcome |
|---|---|
| R23.7H-C (Home/Create Artifact Integration) | All exit criteria re-verified on the unified Main surface (GAP-B Recent thumbnails, GAP-C Open, phone shell 360/390/430, a11y landmarks, KR/EN). **Implementation complete, owner acceptance pending**; roadmap keeps it OPEN. Matrix: `NAGEX_R23_7H_C_AND_R23_7C_D_EVIDENCE_20261013.md`. |
| R23.7C-D (Presentation / Slides) | **Implemented** end to end (model-planned outline -> NAgex-owned `.pptx` -> download). Started ahead of the roadmap's H-C closure gate; the conflict is stated in the roadmap and evidence. |
| R23.7G (Background runtime reconciliation) | **Reconciled**: eight questions answered with tests; two real defects fixed (duplicate run from overlapping ticks; schedule stranded after a restart interruption). Not closed without the owner. |
| R23.7C-E (Video) | **BLOCKED**: no video provider adapter exists; none was invented. |
| R23.8P (Personality / Trust UX) | Not started as a whole (broad, needs design approval). Related trust fixes done: inert Voice-card buttons disabled and labelled, Notifications panel and lifecycle notification titles localized. |
| R23.9C (Final certification) | Gate run completed (section 3); not declared — open items below. |
| Debt | DEBT-0010 closed with S1 evidence; DEBT-0012, DEBT-0013, DEBT-0014 registered. |

## 2. Commits (oldest first, on top of `main` 9d3ccc8 — the branch also carries earlier design/MCP-UI work listed by `git log origin/main..HEAD`)

Work of this run: `c946647` phone shell, `994596d` truthful failure reasons, `5fb2a39` Recent thumbnails/Open, `291c25a` app.js corruption repair + guard,
`f06d1ee` a11y landmarks, `e7da169` phone Apps & connections, `202a4c7` S2C security fix, `b47f5bc` Slides runtime, `ae11231` merge of the Slides branch,
`08ff212`/`88d83fc` test restorations, `594706b` Settings/KR/notifications fixes, `5170f5a` Settings test ports, `6394a98` roadmap/evidence/debt docs,
`baf63b4` R23.7G fixes, `eb4b634` notification title localization.

## 3. Gate results at `eb4b634`

- `npm run build`: exit 0.
- `npm test`: 2728 tests, **2689 pass, 31 fail, 8 skipped**. The 31 failures are all in the baseline (no new failure); the baseline had ~50 and 20+ were fixed or retired
  with a reason. All 31 are Android accessibility / Kakao-send / device-binding source assertions — see DEBT-0014 (the code they assert was dropped by merge `b873e41`;
  the owner must decide restore vs retire).
- `npm run test:browser-cert`: 210 tests, **204 pass, 0 fail, 6 skipped** (real Chromium, EN/KR, 360/390/430 and desktop).
- Skipped tests carry a visible reason in every run (password-era flows, retired Desktop Autonomy/Quick Wake panel, deferred Organization UI).
- Not run: installed Chrome/Edge channel, a physical phone, a screen reader, PowerPoint/Keynote opening of a generated deck.

## 4. Deployment

None. UI files are served per request, but backend changes (scheduler fix, interrupted-run sweep, presentation routes) need a server restart (`sudo systemctl restart nagex`),
which needs the owner. Nothing was pushed to `main`.

## 5. Remaining / blocked / next priorities

1. Owner decision on DEBT-0014 (Kakao/accessibility send) — 31 red tests.
2. Owner review of the rebuilt screens (Home, Connections, Settings, phone shell) — design acceptance PENDING; then accept R23.7H-C and R23.7C-D.
3. DEBT-0013: Desktop Autonomy / Quick Wake panels and OAuth account disable/delete.
4. DEBT-0012: legacy `/api/v1/creations/generate` mock fall-through.
5. R23.7C-E Video (needs a real provider decision), R23.8P, R23.9C final certification.
6. Merge `auto/roadmap-20261013` into the integration branch only after review (it also touches shared `public/` files; the design-corrections branch
   `overnight/design-v2-integration-20261013` is separate and needs a Voice-WIP-aware merge of `public/main-surface-rearchitecture.css`).

## 6. Screens / evidence to review

`docs/evidence/design-v2-visual-gate-20261012/` (before/after captures), `docs/evidence/NAGEX_R23_7H_C_AND_R23_7C_D_EVIDENCE_20261013.md`,
`docs/evidence/NAGEX_R23_7G_BACKGROUND_RUNTIME_RECONCILIATION_20261013.md`. Screens: phone Home/Recent/Settings (Apps & connections row), Main Slides mode,
Korean Desktop Settings (every category), Notifications panel.

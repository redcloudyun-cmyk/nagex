# R21 P1 Global Product Copy & Tone Audit — Handoff Document

**Date:** 2026-09-18
**Current Git SHA:** `82796254d4398eb2147b0434863ed134607956c6`
**Audit Target:** Repository-wide copy, tone, terminology, and i18n alignment for NAgex Personal AI Core Experience.

---

## 1. Context & Baseline State

The repository underwent an interrupted copy/tone audit during a previous session due to quota exhaustion.
The work aimed to enforce NAgex's **Core Product Voice**:
- **Calm**
- **Clear**
- **Concise**
- **Capable**
- **Human**
- **Trustworthy**

And eliminate developer/enterprise/internal terminology from all normal user-facing UI surfaces (e.g. `Main Session`, `Session IDs`, `Plan generated`, `Execute Plan`, `Plan Resolution`, `Human Approval`, `HUMAN NEEDED`, `Capability`, `Execution`, `canonical storage`, `model health probing`).

---

## 2. What Files Were Changed (In Staged/WIP State)

The interrupted session left staged changes across 11 files (`git diff --cached`):

1. `public/i18n.js`: Added consumer-facing translation overrides for `en` and `ko`. Introduced a defect in `t(key)` where the `fallback` parameter signature was lost and missing keys returned `''` for dotted key patterns.
2. `public/app.js`: Replaced developer/internal terms in Inbox, Approvals, Settings, Autonomy levels, Telegram/Slack link prompts, and Calendar approval preview cards.
3. `public/desktop-quickwake.html`: Updated header title, tab labels, task section header, and status messages to human/calm tone.
4. `public/desktop-quickwake.js`: Replaced `Session: sess_main_001` badge with `Ready`, `Plan generated for:` with `Here's what I'll do:`, `Execute Plan` with `Continue`, and `No active tasks...` with `Nothing needs your attention right now.`
5. `public/index.html`: Replaced section headers (`Personal Cloud Vault` → `Vault`, `NAgex is working for you` → `In progress`, `Probe Model Health` → `Check connection`, `Execute plan` → `Continue`).
6. `public/daily-brief.js`: Changed approval note from `Approval required` to `Ready for review`.
7. `public/mobile/mobile-home.js`: Replaced `Task in progress...` with `Working on it...`, `Processing capture...` with `Saving...`, `HUMAN NEEDED` with `Review`.
8. `public/mobile/mobile-settings.js`: Replaced enterprise Autonomy level titles/descriptions (Level 0-3) with human titles (`Always ask`, `Read and suggest`, `Help with routine tasks`, `Use trusted routines`).
9. `.recovery/r21-p1-copy-tone-audit-status.txt`
10. `.recovery/r21-p1-copy-tone-audit-recent-commits.txt`
11. `.recovery/r21-p1-copy-tone-audit-uncommitted.patch`

---

## 3. What Copy Was Changed

- **Autonomy Levels**:
  - L0: "Level 0 — Ask Every Time" → "Always ask" ("Check with you before making any change.")
  - L1: "Level 1 — Read Only" → "Read and suggest" ("Find information and suggest next steps without making changes.")
  - L2: "Level 2 — Low-risk Actions" → "Help with routine tasks" ("Check with you before sending or changing anything important.")
  - L3: "Level 3 — Trusted Workflows" → "Use trusted routines" ("Run routines you have already reviewed and allowed.")
- **Approvals & Triggers**:
  - "Human Approval Required" / "Approval Required" → "Ready for review"
  - "HUMAN NEEDED" → "Review" / "확인"
  - "Needs Human Attention" → "Needs your attention"
- **Status & Navigation**:
  - "NAgex is working for you" → "In progress" / "진행 중"
  - "Connected to Main Session" / "Session: sess_main_001" → "Ready" / "준비됨"
  - "Probe Model Health" → "Check connection" / "연결 확인"
  - "Personal Cloud Vault" → "Vault"
  - "Execute Plan" / "▶ Execute plan" → "Continue" / "계속"
  - "Plan generated for:" → "Here's what I'll do:" / "이렇게 진행할게요:"

---

## 4. Current Test State & Verification Results

Running `npm test` against the staged WIP changes yielded **3 failing tests out of 1810**:

1. `dist/tests/desktop_quickwake.test.js` (line 141):
   - **Failure**: `HTML should contain title` (AssertionError)
   - **Root Cause**: `desktop-quickwake.html` changed `<span class="qw-title">NAgex Quick Wake</span>` to `<span class="qw-title">NAgex</span>`, breaking static structural test assertions in `tests/desktop_quickwake.test.ts`.
2. `dist/tests/i18n_strings.test.js` (line 76):
   - **Failure**: `Expected '' to be strictly equal to 'not.a.real.key'` (AssertionError)
   - **Root Cause**: `public/i18n.js` changed `t(key)` to return `''` for missing keys matching `KEY_LIKE`, breaking fallback semantics.
3. `dist/tests/r21_p1_finalization_real_browser.test.js` (line 94):
   - **Failure**: `page.waitForFunction` Timeout (30000ms exceeded) waiting for text `Added to your calendar`.
   - **Root Cause**: In `public/i18n.js`, `function t(key)` lost its optional `fallback` parameter (`function t(key, fallback)`), causing `t('meetingPrep.addedToCalendar', 'Added to your calendar')` to return `''` instead of `'Added to your calendar'`.

---

## 5. Known Defects & Risks

1. **Defective `t(key, fallback)` signature in `public/i18n.js`**: Must accept `fallback` parameter and return `fallback` when translation key is absent in dictionary, returning `key` only as ultimate fallback.
2. **Raw i18n keys leak risk**: If an i18n key is referenced in HTML/JS but missing in `i18n.js`, it risks displaying raw dotted keys (e.g. `heroBrief.nothingToday`). All user-facing keys must be defined in both EN and KR dictionaries.
3. **Selector/Text mismatch in test suites**: Updating UI strings without updating corresponding test assertions breaks test gates.

---

## 6. What Remains to Audit (Remaining Scope)

The following user-facing surfaces require complete copy/tone review & verification:
- Home / Desktop Home
- Morning Brief & Hero Brief
- Quick Wake (desktop overlay & trigger states)
- Meeting Prep View
- Research / Analyze / Create overlays
- Calendar / Email actions
- Vault / Inbox / Notifications / Activity
- Settings (Autonomy, Connected Apps, AI Models)
- Login / Signup / OIDC / SAML auth flows
- Empty states, Loading states, Error states, Approval cards, Success states

---

## 7. Next Exact Steps

1. Fix `public/i18n.js` `t(key, fallback)` implementation so `fallback` is respected and unknown keys fall back correctly without breaking tests.
2. Ensure all user-facing strings (including `heroBrief.nothingToday`, `meetingPrep.*`, etc.) have explicit EN and KR dictionary entries in `public/i18n.js`.
3. Adjust test assertions in `tests/desktop_quickwake.test.ts` to align with humanized UI titles without breaking structural checks.
4. Run `npm test` to verify all 1800+ unit, integration, and real-browser tests pass (0 failures).
5. Audit remaining UI components for raw i18n keys or enterprise terminology.
6. Verify with `npm run build && npm test && git status`.

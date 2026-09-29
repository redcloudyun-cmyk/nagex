# R21 P1 Handoff — Personal AI Core Experience Integration & Hackathon Hero Flow

**Written for:** the next AI coding agent (or human) continuing this milestone, with no memory of this session.

**Date:** 2026-09-18
**Baseline commit:** `1a4ba12d964bee86b5355b5edbada6b336246076` (main)
**Test status at handoff:** `npm test` → 1798 tests / 1791 pass / 0 fail / 7 skip. Clean.

---

## 0. Read this first — mandatory project docs

Before touching anything, read in this order:
1. `docs/NAgex_Canonical_Product_Vision_Personal_AI_Execution_OS.md`
2. `MASTER.md`
3. `AGENTS.md`
4. `docs/NAGEX_PRODUCT_EXPERIENCE_FIRST_PRINCIPLE.md` (governs every UX decision in this milestone)
5. `docs/TECHNICAL_DEBT_REGISTRY.md`

Required checks before claiming anything is done: `npm run build && npm test && git status`. The **only** certified way to run tests is `npm test` (never bare `node --test` — see `tests/_setup_canary.test.ts`'s own header comment for why).

**Do not commit unless you've run the full suite and it's green.** This project's established discipline (see recent commit history) is: root-cause every failure, never weaken a test just to make it pass, never declare a milestone closed while anything fails.

---

## 1. What R21 P1's directive actually asks for

The full original directive (Korean + English, ~36 numbered sections) is preserved in this conversation's history but not re-pasted here in full — key points:

- **Baseline**: R21 P0.1C was already closed per the directive's own framing (Personal-first UI, Enterprise-hidden, Approved Assistant Mockup clone, Morning Brief, Quick Wake, Meeting Prep, Personal Watch, Notification Center, Human Approval, Calendar/Email actions, Vault, Connected Apps, Activity — all listed as "already done" building blocks).
- **Goal of R21 P1**: do NOT add new major features. **Connect the existing pieces into one coherent Personal AI experience** — Home → Morning Brief → Quick Wake → Meeting Prep → Action Preparation → Human Approval → real Calendar/Email action → Result → Activity/Memory update → back to Home reflecting the change.
- **User's own 3 priorities** (stated explicitly, in Korean):
  1. Morning Brief → Quick Wake → Meeting Prep must not feel like 3 separate features — one continuous "NAgex understands my day" experience.
  2. Human Approval must not feel like a security feature — just "NAgex prepares, then confirms with me right before acting."
  3. The most powerful demo moment isn't the "Add to calendar" click itself — it's the whole chain: notice a meeting → find related email/docs → summarize → propose a follow-up → get approval → execute.
- **Required real-browser scenarios A-J**, **9 screenshots**, **14 UX semantic PASS checks**, **Demo Seed/Reset**, **latency measurements**, **EN/KR i18n**, **empty/loading/error states**, **Completion Report** in an exact field format (see the directive's §35 — reconstruct from git history/prior conversation if needed, or ask the user to re-paste the original directive text, since it is long and was not saved as a file).
- **Explicitly frozen/out of scope**: Organization/Workspace/RBAC/SSO/SCIM/Machine Identity expansion — none of that.

**⚠️ Recommend asking the user to re-paste the full original R21 P1 directive text at the start of the next session** if it isn't otherwise available — it's long (36 sections) and this handoff summarizes but does not reproduce it verbatim.

---

## 2. What actually happened this session (important context, not just a changelog)

### 2.1 Discovered: R21 P0.1C/P0.2 was sitting uncommitted from an earlier session
When this session started, the working tree already contained ~1700 lines of uncommitted changes (`public/app.js`, `style.css`, `i18n.js`, `index.html`, plus two new test files) that turned out to be a legitimate prior implementation of "Clone the Approved NAgex Assistant Mockup" (P0.1C) — never committed. This was reconciled and committed as `f10cb83`.

**Two real bugs were found and fixed in that reconciliation:**
1. **CRLF line endings**: the P0.1C session saved `app.js`/`style.css`/`i18n.js`/`index.html` with Windows CRLF instead of this repo's LF convention, breaking every `\n`-based regex test scraping the served files (13 tests failed) even though the underlying code was correct. Fixed by normalizing to LF. **If you ever see a cluster of source-scraping regex test failures with no obvious code cause, check line endings first** (`file public/app.js` — should say "ASCII/UTF-8 text", never mention "CRLF").
2. A vestigial `#btn-ambient-cancel` button lost its `data-i18n="ambient.close"` binding — restored.

### 2.2 Discovered: a critical fake-approval bug in P0.1C's ambient overlay
`public/app.js`'s `renderUserApprovalCard()` (the "Ready to add to your calendar" card inside the ambient composer overlay — NOT a separate modal) had an Approve button that did `setTimeout(() => showSuccess(), 500)` — **it never called any real API**. It told the user a Google Calendar event was created when none was. This is the opposite of a silent failure: a **false success**, which is arguably worse for a system whose whole premise is trustworthy human-approved action.

**Fixed** (commit `1a4ba12`): the Calendar branch of `renderUserApprovalCard` now does the real sequence:
```
POST /api/v1/approvals → POST /api/v1/approvals/:id/approve → POST /api/v1/tools/google-calendar/create-event
```
using whatever concrete fields the real resolved plan already extracted (`resolved.steps.find(s => s.resolvedToolId === 'google_calendar.create_event')?.parameters`), falling back to a **real** `POST /api/v1/tools/google-calendar/free-slots` lookup only for a genuinely missing time — never fabricating a title/attendee/time. On success it shows a real "Open in Google Calendar" link built from the real `externalUrl` the API returned.

The **Gmail branch and generic fallback branch of the same card were NOT made real** (no time left this session) — they now honestly route the user to the real Approvals tab instead of faking success. This is disclosed, not hidden.

### 2.3 Backend truthfulness fix: Morning Brief / Quick Wake / Meeting Prep
`src/personal/personal-assistant.engine.ts`'s `generateMorningBrief()` / `executeQuickWake()` / `generateMeetingPrepCard()` were **100% hardcoded fictional data** (fixed Korean event titles like "김대표 미팅" at a fixed 14:00, a fake email, a fake Vault doc "proposal-v3.pdf") — served from real, reachable routes (`src/http/routes/personal-assistant.routes.ts`) but never called by any frontend, AND silently depended on by `evaluatePersonalWatches()` (Personal Watch's real trigger logic, shipped in R20 and counted as "done"). This means Personal Watch had **never** evaluated triggers against real calendar/email/task state.

**Rewritten to be fully real** (commit `1a4ba12`):
- `generateMorningBrief()` — real Calendar (`GoogleCalendarService.listUpcomingEvents`), real Gmail (`GmailService.search`, snippet-only per a pre-existing, disclosed limitation — Gmail's real API integration here has no subject/from/date field, only `{threadId, snippet, historyId}`), real Tasks (`TaskStore.list` filtered ACTIVE/RUNNING), real pending approvals (`ActionApprovalStore.listPending`). Returns `calendarStatus`/`gmailStatus` (`CONNECTED`/`DISCONNECTED`/`ERROR`), never fabricates when a source is unavailable.
- `executeQuickWake()` — built on top of the real morning brief; its `proactive_suggestion` field is populated **only** when the nearest upcoming meeting (within 2h) has at least one real, actually-found related email or Vault document — never on time-proximity alone (this was an explicit anti-pattern the directive called out: "no suggestion without grounding").
- `generateMeetingPrepCard()` — resolves a real event (by id, or nearest upcoming), real Gmail search by real attendee emails (`from:x OR to:x`), real Vault search (`VaultStore.searchItems`, keyword match on title only — **VaultItem has no content/body field**, so Vault-sourced "related materials" honestly show title+type, never a fabricated summary), real Memory search (`MemoryEngine.searchMemories`), then a new `AiService.meetingPrep()` method (mirrors the existing `.brief()`/`.plan()` contract — same "never invent a fact not in the digest" system-prompt discipline) synthesizes grounded `keyPoints`/`suggestedAgenda`. Throws `MEETING_PREP_NO_EVENT` (real 404) if there's genuinely no upcoming event — never fabricates a card.
- `UpcomingCalendarEvent` (`src/modules/calendar/calendar.client.ts`) now exposes real `attendees: string[]` (previously dropped) — needed for the Gmail/grounding searches above.
- All three engine methods are now **async** (they weren't before). Callers updated: `personal-assistant.routes.ts`, `evaluatePersonalWatches()` itself.
- `create-nagex-application.ts` wires the real `googleCalendarService`/`gmailService`/`taskStore`/`actionApprovals`/`memoryEngine`/`aiService` into `PersonalAssistantEngine`'s constructor (all new deps are optional — a bare `new PersonalAssistantEngine({reminderStore, notificationStore})` still works and degrades honestly, useful for tests).

### 2.4 New frontend (not yet wired end-to-end — see §3.1 below for the important caveat)
- `public/hero-brief.js` — fetches `GET /api/v1/personal/morning-brief` once per Home render (chained onto `desktop-home.js`'s `onHomeRender` hook — **loaded AFTER `desktop/desktop-home.js` in `index.html`'s script order**, because `desktop-home.js`'s own `init()` does `window.NAGEX.onHomeRender = renderDesktopHome` — a plain overwrite, not a chain — so anything hooking `onHomeRender` must load after it or its hook gets wiped). Renders a "Most important" hero card (`#hero-brief-card` in `index.html`, right after `.home-hero-header`) with a `[Prepare me]` button wired to `window.NAGEX_MEETING_PREP.open(eventId)`.
- `public/meeting-prep-view.js` — a **self-contained, injects-its-own-DOM modal** (not dependent on any pre-existing HTML container), loaded in both `index.html` and `desktop-quickwake.html`. Calls `POST /api/v1/personal/meeting-prep`, shows a progress-step UI, then the result (related context list, key points, suggested agenda) with `[Find a time]` → real free-slots → `[Add to calendar]` → real approve+execute, and `[Draft a follow-up]` → real Gmail draft approve+execute. Exposes `window.NAGEX_MEETING_PREP = {open, close}` and `window.NAGEX_RELATED_CONTEXT_LIST = {render}` (a reusable related-context renderer, icons per source type VAULT/EMAIL/CALENDAR/MEMORY, **never shows a raw confidence score** — see §4 below for why that matters).

**⚠️ IMPORTANT ARCHITECTURAL TENSION — read this before building Phase B/D/H further:**

There are now **two different UI surfaces** that both claim to do "Meeting Prep":
1. **P0.1C's existing ambient-overlay MEETING branch** (`renderCanonicalUserPresentation()` in `app.js`, intent-classified via `classifyIntentForUi()` keyword matching on the user's typed prompt) — this is the UI the directive's own screenshots/scenarios reference (`#ambient-surfaced-context`, `#ambient-task-display-title` = "Preparing your client meeting", etc.), and it's the one wired to the real approval fix in §2.2. **Its context/schedule content is STILL 100% hardcoded fake** (`['Last meeting notes', 'Proposal v3', 'Recent email']`, "Tomorrow 3:00-4:00 PM (No conflicts found)") — this was NOT fixed this session, only the calendar mutation was made real. This is the highest-priority remaining fix (see §3.1).
2. **My new standalone `meeting-prep-view.js` modal** — fully real end-to-end, but reached only via `hero-brief.js`'s `[Prepare me]` button, which is a UI surface that isn't part of P0.1C's approved mockup flow at all.

**These need to be reconciled, not left as two parallel systems.** The most likely correct direction (my assessment, not yet executed): make P0.1C's ambient-overlay MEETING branch's context/schedule content call the now-real `/api/v1/personal/meeting-prep` pipeline (async, before rendering) instead of hardcoding it — i.e., **wire real data into the existing approved-mockup UI**, rather than maintaining a separate modal. The `meeting-prep-view.js` modal can then either be deleted, or repurposed as what `hero-brief.js`'s `[Prepare me]` button opens as a *shortcut* that itself triggers the SAME ambient-overlay flow (e.g. by calling `window.NAGEX.openAmbientWithPrompt('Prepare my next client meeting')` — already exists in `app.js`'s `Object.assign(window.NAGEX, {...})` block — instead of a separate modal). Decide this deliberately; don't just leave both.

### 2.5 Full session outcome
Two commits:
- `f10cb83` — P0.1C/P0.2 reconciled and committed (CRLF fix, i18n regression fix).
- `1a4ba12` — R21 P1 backend truthfulness (Morning Brief/Quick Wake/Meeting Prep real) + the critical fake-approval fix + new hero card/modal frontend.

Full suite: 1798 tests / 1791 pass / 0 fail / 7 skip. Process hygiene checked clean (no leaked Chrome/Node).

---

## 3. What's NOT done — the real remaining scope

Going through the original directive's sections not yet addressed:

### 3.1 (Highest priority) Reconcile the two Meeting Prep UI surfaces
See §2.4's architectural tension above. Wire real grounded data (from `/api/v1/personal/meeting-prep`, already real) into `renderCanonicalUserPresentation()`'s MEETING branch in `app.js` (~line 3156-3222 as of `1a4ba12` — search for `} else if (intent === 'MEETING') {`), replacing the hardcoded `contextBox`/`groundingWhyEl` content. This branch is currently **synchronous**; making it call a real API means either making `renderCanonicalUserPresentation` async (it's called twice — once with `resolved=null` for the fast "working" state, once with the real `resolved` after `resolvePlanIntoUi` — see `runAmbientTask`/`resolvePlanIntoUi` in `app.js`) or splitting the MEETING branch into its own async sub-render step. The real free-slots/grounding lookup this needs is the same pattern already built in `renderUserApprovalCard`'s calendar branch (§2.2) and in `meeting-prep-view.js` — reuse, don't reinvent a third time.

Also fix the same fake-content pattern in `renderCanonicalUserPresentation`'s **RESEARCH, ANALYZE, CREATE branches** if time allows (all still 100% hardcoded fake findings/sources) — or explicitly disclose them as known-fake in the Completion Report if not fixed. RESEARCH is the more important one (directive §25's "Secondary Hero Scenario"); ANALYZE/CREATE are P0.1C additions outside R21 P1's own stated scope (calendar-centric Hero Flow) and lower priority.

### 3.2 Quick Wake context-awareness in the actual Quick Wake UI
The backend (`executeQuickWake()`, real, grounded) is done. The **desktop Quick Wake overlay** (`public/desktop-quickwake.js`, a separate mini-window `desktop-quickwake.html`) still does NOT call it — it goes straight to the generic ambient-intent composer. Wire it: on open, call `GET /api/v1/personal/quick-wake`; if `proactive_suggestion` is non-null, show the proactive suggestion card (§6 of the directive) with `[Prepare me]`/`[Not now]` before falling back to the generic composer.

### 3.3 Notification Center Now/Today/Later grouping
Currently a flat list (`state.notifications`, `app.js`). Directive §16 wants 3 time-buckets. `NotificationRecord` (`src/notifications/notification.store.ts`) has no "when this relates to" field separate from `createdAt` — would need an additive `relatesAt?: string` field (backward compatible) so a `MEETING_PREP`/`REMINDER` notification can carry its linked event's real start time, then group client-side by proximity.

### 3.4 Demo Seed & Demo Reset (directive §22-23)
Not started. Needs: a demo-only fixture (Alex Kim persona — 3 calendar events with attendees, 1 pricing email, 1 Vault doc "Proposal v3", 1 memory preference, 1 follow-up task), a `POST /api/v1/demo/seed` / `POST /api/v1/demo/reset` pair gated to a demo-flagged tenant/user only (never touches real user data), and — since Calendar/Gmail normally need a live Google OAuth connection — either a demo-mode Calendar/Gmail adapter pair honestly labeled `dataSource: 'DEMO'` (my original plan's recommendation) or a real demo Google account connected for the hackathon judges (simpler if available, ask the user).

### 3.5 Real browser certification — Scenarios A-J, 9 screenshots
Not built as a dedicated test file. Some pieces are incidentally covered by existing tests (`tests/r21_p0_1c_real_browser.test.ts` covers a version of Scenarios A/B/C/D already, real now after this session's fix). Needs a proper `tests/r21_p1_hero_flow_real_browser.test.ts` per the directive's exact scenario list, using Demo Seed (§3.4) for determinism, following the established pattern (see `tests/r16`/`tests/r19`/`tests/r20_proactive_personal_assistant_real_browser.test.ts` for the `createServerInstance`/`chromium`/viewport-switch/`saveScreenshot` convention, and note the `googleTokenStore.save(...)` + `GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI` env var pattern needed for any scenario touching real-shaped Calendar/Gmail — see §2.2's test fixes for the exact recipe, including the `www.googleapis.com/calendar/v3/freeBusy` and `.../events` POST/PATCH special-casing needed in the fetch mock beyond the generic model-response mock).

### 3.6 UX semantic tests (directive §28, 14 named PASS checks)
Not built. Model on `tests/home_intent_first_ux.test.ts`'s pattern (structural/source assertions against served HTML/JS).

### 3.7 i18n / Global EN pass, empty/loading/error states, latency instrumentation, Voice
Not done. Voice: confirmed this session (via the original architecture survey) that live speech-to-text is genuinely unwired anywhere in this codebase (both "voice" buttons are `MediaRecorder` → upload-to-Vault, not transcription) — this is **pre-existing, disclosed debt (DEBT-0003)**, not something to build fresh under R21 P1. Just confirm the existing compact voice indicator hasn't regressed into a "giant Listening card" and disclose voice honestly in the Completion Report rather than claiming `VOICE_READY=PASS` in the "live transcription works" sense.

### 3.8 Completion Report
Not written. Needs the exact field format from the original directive's §35 (BASE_SHA, FINAL_SHA, per-scenario PASS/FAIL, latency numbers, TEST_COUNT/PASS/FAIL/SKIP, NEW_DEBT, etc.) — **ask the user for the original directive text if it's not otherwise recoverable**, since this handoff summarizes but doesn't reproduce that field list verbatim.

---

## 4. Things to know / gotchas specific to this codebase

- **CLAUDE.md's mandatory rules apply** (top-level source of truth: `MASTER.md`; no blind repo-wide renames; public contract changes need code+schema+tests+docs together; preserve tenant/security boundaries; consequential external actions need human approval; never commit secrets; NVIDIA/Nebius usage must be real).
- **Windows/CRLF**: this repo's git has `core.autocrlf=true`. Files written by some tools land as CRLF on disk even though git normalizes to LF on commit — this WILL break `\n`-based regex tests scraping served files if you ever see a cluster of unrelated-looking test failures. Check `file <path>` for "with CRLF line terminators" first.
- **Never claim real when it's fake.** This codebase's whole review culture (see `docs/TECHNICAL_DEBT_REGISTRY.md`, multiple DEBT entries) is built around catching exactly the two bugs found this session — hardcoded/mocked content presented as live product behavior. When building the remaining Hero Flow pieces, if a data source genuinely isn't available, show an honest empty/disconnected state (see `CONNECTED`/`DISCONNECTED`/`ERROR` convention throughout `daily-brief.pipeline.ts`/`personal-assistant.engine.ts`) — never fabricate.
- **Never show a raw confidence score to the user.** Pre-existing violation found (not fixed, out of scope, disclosed): `public/app.js` line ~1379, the Candidate Review card renders `confidence ${Math.round(candidate.confidence * 100)}%`. Don't repeat this pattern in new UI; don't feel obligated to fix that specific pre-existing instance unless asked.
- **VaultItem has no content/body field** — only `title`/`mimeType`/`sourceRef`/`metadata`. Any "related Vault document" UI can only ever show title+type, never a real summary, unless `metadata` happens to carry one.
- **Gmail's real integration is snippet-only** — `GmailService.search()` returns `{threadId, snippet, historyId}`, no subject/from/date fields exist anywhere in this codebase's Gmail client. Don't invent one for new UI copy.
- **`AiService.plan()` deliberately never invents concrete scheduling details** (date/time/attendee) if the user's request didn't supply them — this is why the calendar-approval fix in §2.2 needed a real free-slots fallback rather than expecting the plan itself to always have a concrete time.
- **Testing real Calendar/Gmail flows**: seed `googleTokenStore` (the real shared singleton, `src/integrations/google/token.store.ts`) with a fake-but-valid token for `DEFAULT_GOOGLE_TENANT_ID`, and set `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_REDIRECT_URI` env vars (otherwise `readGoogleOAuthConfig()` returns null and every Calendar/Gmail call reports DISCONNECTED regardless of token state). Mock `fetch` at the transport layer only — never hand-roll a stand-in for the real service classes. See `tests/daily_brief.test.ts`'s `buildHarness()` for the canonical unit-test version, or `tests/r20_proactive_personal_assistant_real_browser.test.ts`'s top-of-file pattern for the real-browser-test version (both written/fixed this session, both good references).
- **Playwright `page.waitForFunction(fn, arg, options)`** — the second positional parameter is `arg` passed into the browser-side function, NOT `options`. Pass `undefined` explicitly if you don't need an arg: `page.waitForFunction(fn, undefined, {timeout: N})`. Got this wrong once this session (silently used the wrong 10s→30s default timeout).
- **This project's TS config has no DOM lib** (it's a Node-only server codebase) — any real-browser test file that needs to reference `document`/`window`-typed identifiers inside a `page.evaluate`/`waitForFunction` callback needs a local `declare const document: any;` (see `tests/ambient_composer_recovery.test.ts`'s header comment for the established convention/rationale, or the pattern added to `tests/r21_p0_1c_real_browser.test.ts` this session).
- **`window.NAGEX.onHomeRender`**: `desktop-home.js`'s `init()` does a plain overwrite, not a chain. Any new script hooking this must load AFTER `desktop/desktop-home.js` in `index.html`'s script tag order and explicitly chain the prior hook (see `hero-brief.js`'s `init()` for the pattern).
- **Two "add to calendar" real-execution call sites now exist** in `app.js`: the old `requestCalendarApproval()` (targets `#calendar-preview-slot`, a different DOM area) and the new one inside `renderUserApprovalCard()` (targets `#ambient-user-approval-card`). `tests/calendar_approval_ux.test.ts`'s ordering assertions had to be scoped with `indexOf(..., fromIndex)` to avoid picking up the wrong occurrence — if you add a THIRD real approval call site anywhere, check that test again.

---

## 5. Recommended next-session plan (suggested order)

1. Re-paste or otherwise recover the full original R21 P1 directive text (36 sections) — this handoff summarizes it but the exact wording/field names matter for the Completion Report.
2. Resolve §3.1 (the two Meeting Prep UI surfaces) — this is the single highest-value fix, since it's the actual Hero Flow the directive cares about.
3. §3.2 (Quick Wake wiring) — small, high-value, reuses everything already built.
4. §3.4 (Demo Seed/Reset) — needed before real-browser certification can be deterministic.
5. §3.5 (real-browser certification A-J + 9 screenshots) — the certification gate.
6. §3.3, §3.6, §3.7 as time allows; disclose honestly what's skipped.
7. §3.8 Completion Report, with real evidence only.

Always: `npm run build && npm test` after each change, never batch multiple unverified changes, commit incrementally with clear messages (this session's two commits are good examples of scope-per-commit), check process hygiene (no leaked Chrome/Node) after any real-browser test run.

# NAgex UX & Interaction Architecture

**Canonical Domain:** Product UX / Intent / Home / Mobile / Desktop / Voice
**Status:** CANONICAL — consolidated current direction
**Date:** 2026-09-29

## 1. Product UX Identity

NAgex is a general-purpose Personal AI, not a calendar app, task manager, analytics dashboard, or visible collection of agents.

The user experiences one NAgex that can understand, remember, research, create, prepare, and act.

```text
Intent is the interface.
Agent is infrastructure.
```

## 2. Intent-First Interaction

Users should express outcomes rather than configure internal mechanics.

NAgex resolves intent using:

- current request;
- conversation context;
- authorized memory;
- files/URLs/data;
- deterministic environment state;
- connected capabilities.

The user should not need to know model names, router logic, agent taxonomy or execution-plane terminology.

## 3. Clarification Policy

Ask before guessing when missing information is critical or high-impact.

```text
Known
→ do not ask

High-confidence + low impact if wrong
→ proceed, disclose assumption when useful

High-confidence + high impact if wrong
→ confirm

Missing + critical
→ ask

Missing + optional
→ sensible default

Sensitive / irreversible / external mutation
→ explicit confirmation / approval
```

Clarification should maximize information gain and stop once the intent is sufficiently resolved.

## 4. Universal Interaction Model

The same product grammar should support heterogeneous domains:

```text
Request
→ Understand / Clarify
→ Prepare / Plan
→ Show useful intermediate result when appropriate
→ Approval if consequential
→ Execute / Create
→ Verify
→ Present result
→ Continue if needed
```

Examples include slides, images, coding, research, reservations, email and calendar.

## 5. Conversation Before Configuration

Prefer conversational intent resolution to long forms and settings-first workflows.

Configuration remains available when durable preferences or permissions genuinely need explicit control.

## 6. Progressive Disclosure

### Level 1 — Human outcome
What is happening, what matters, what needs attention.

### Level 2 — Execution detail
Steps, route, evidence, useful diagnostics.

### Level 3 — Technical trace
Provider, execution IDs, audit details, developer diagnostics.

Routine consumer UX defaults to Level 1.

## 7. One Clear Next Action

Blocked states should make the next action obvious:

- Approve
- Choose
- Clarify
- Reconnect
- Review
- Retry safely
- Continue manually

Avoid ambiguous CTA clusters.

## 8. Plan Acceptance vs Action Approval

Accepting a plan does not grant blanket permission for future consequential actions.

Approval remains bound to the actual material action at the consequence boundary.

## 9. Home Is a Personal AI Home, Not a KPI Dashboard

Current consumer navigation (R23.7H-C Phase D, Product Owner IA decision, approved-mockup-driven) is:

```text
Home
Inbox
Create
Canvas
Tasks
Knowledge
Activity
Settings
```

This replaces the approval-as-navigation model. Create and Canvas are first-class product concepts, Activity is the concise user-facing history destination, and Vault remains folded into Knowledge while keeping its real route intact:

- **Activity** (`tab-executions`, `#activity`) is reachable contextually — from Home's "Recent results → View All" and from Tasks' "View activity history" link — since it is the execution history of Tasks.
- **Vault** (`tab-vault`, `#vault`) is folded into **Knowledge** as the user-facing concept: Knowledge's view links directly into the still-fully-functional Vault view/route/store. Vault's storage/runtime model is unchanged.

The single canonical ordered nav definition is `NAGEX_PRIMARY_NAV` in `public/app.js`; the desktop sidebar (`index.html`'s `ul.nav-menu`) and the mobile bottom nav (a curated subset — Home/Create/Canvas/Inbox/Settings — with Tasks/Knowledge/Approvals reachable via the existing Settings → Advanced drawer) are both kept consistent with it, enforced by `tests/r23_7h_c_phase_d_main_product_experience.test.ts`.

### 9.1 Current desktop sidebar and unified Main (2026-10)

The as-built desktop sidebar (certified by `tests/sidebar_navigation_certification_browser.test.ts`) is exactly `Home, Recent, Workspace, Knowledge, Activity, Settings` (KR: 홈, 최근, 워크스페이스, 지식 베이스, 활동, 설정). Rules:

- **Recent** (`tab-recent`, `#recent`) lists the signed-in user's own artifacts from the existing artifact store, newest first; opening one continues the work in Main. It introduces no new data store. There is no Projects screen: no project data model exists, so none is exposed.
- **Workspace** (`tab-inbox`) filters and actions act on real items only; read-only previews use an in-page dialog, never a blocking `alert`.
- **Settings → Account** shows the signed-in user's real identity and sign-in method; a signed-out state shows a sign-in prompt, never a profile form.
- **Settings → Apps & Connections** (KR 앱 및 연결) is an icon-first catalog: **Built-in first → Connect when needed → Extend on demand.** Sections: *My connections* (only real connections: the Google grant once, GitHub, each linked chat account and each custom MCP server, with account/identity, status and Manage), *Built-in apps* (from the server connector catalog `GET /api/v1/connectors/catalog`: Gmail, Google Calendar, GitHub, Slack, Telegram, and the three "coming later" apps Google Drive, Outlook, OneDrive / SharePoint — one card each with icon, localized description, one status and at most one action), *More apps* (a collapsed group of apps that are NOT available — coming later or not supported — grouped by category, each stating its requirement and having no button) and *Explore & add* (a single "+ Add custom MCP server" entry under the advanced flow; no invented marketplace and no vendor presets). A category filter narrows built-in and More apps together. Catalog entries come from `src/connectors/connector-catalog.ts`; a LIVE entry may only claim capabilities that registered engine entries back, and PLANNED / UNSUPPORTED entries can never show as connected (`tests/connector_catalog.test.ts`). Slack and Telegram show their real state (setup required on the server / not connected / linked) and Link account shows the one-time command; nothing is linked until the chat app has delivered it. A search field and filters (All / Connected / Available to connect / Needs attention) work over the real catalog and the user's own connections.
  - Status vocabulary: Connected, Not connected, Setup required (the server has no OAuth app or chat app), Connecting, Needs attention (reconnect), Error (provider failure, never a disconnect), Coming later (no backend yet), Not supported (no integration and none possible without commercial credentials). States come from backend evidence only; a card shows no button unless the button does something. Gmail and Calendar share one Google grant and show per-capability truth from the granted scopes.
  - Manage opens a side drawer (full-width on narrow screens) with real data only: account/server identity, what NAgex can use, last verification (with a real "Check connection"), tools, and an in-panel confirmation for Disconnect/Remove. No token, secret or internal capability id is ever shown.
  - Custom MCP servers: the URL/credential form lives only in the Add modal (focus trap, Escape, focus return, announced validation, no duplicate submit); after discovery a review step lists the verified identity, address, every discovered tool (all OFF) and the unsupported ones. Turning a tool on is an explicit step with a warning; a changed definition or server identity turns it off again with a visible warning; the credential is write-only. The UI never calls a tool: every use goes through the Capability Broker's approval.
  - All NAgex-generated text is localized (live EN/KR switch); server-supplied names and descriptions are shown verbatim as inert text. Icons are static NAgex-drawn glyphs (no remote or server-provided images).
- **Design System V2** (`docs/design/NAGEX_DESIGN_SYSTEM_V2.md`) is the visual and writing standard for Desktop: Modern Everyday Personal AI, comfortably compact (type 12-28px at weights 400/500/600, 4-32px spacing scale, 30/34/38px controls, neutral surfaces with brand blue reserved for selection, primary action, focus and progress), English-first UX writing and natural Korean localization (not literal translation). Converted so far: shell, Home, Apps & Connections, Recent, Workspace, Knowledge, Activity and the Settings chrome; other Desktop screens and Mobile are unchanged and tracked as DEBT-0011. No screen is approved without human review.
- **Main** is one adaptive surface: idle Home briefing (greeting, composer, Today/Calendar, Personal To-do, Since Yesterday, Suggestions), conversation (compact right-aligned user turns, left-aligned NAgex answers rendered as sanitized Markdown, composer docked at the bottom, multi-turn, restored on refresh) and agent mode (a real task run: plan steps, progress, inline approvals, results; nothing is invented). "My Day" restores the briefing without destroying the conversation. Routing/tool identifiers appear only under the developer diagnostics flag.
- The Personal To-do shows only the user's real reminders and scheduled/paused/draft tasks; empty is stated honestly.
- Unsupported creation modes (Slides, Video, Code) remain visibly unavailable rather than advertised.

Do not add a separate top-level Dashboard merely because dashboard-style information exists.

Home should answer:

- What matters to me now?
- What needs my attention?
- What is happening today?
- What is NAgex preparing?
- What has NAgex completed?
- What can NAgex create for me?
- What should I do next?

## 10. Canonical Home Direction

The R23.7H direction evolves toward:

```text
HOME
├─ Greeting + Ask NAgex command surface
├─ RIGHT NOW
├─ CREATE WITH NAGEX
│  ├─ Report
│  ├─ Slides
│  ├─ Image
│  ├─ Video
│  ├─ Research
│  └─ Analyze / Plan
├─ NEEDS YOUR ATTENTION
├─ TODAY
├─ NAGEX IS PREPARING
├─ RECENT CREATIONS
├─ RECENT ACTIVITY
├─ FOR YOU
└─ YOUR WORLD
```

Quiet/empty sections collapse.

The product must not visually collapse into a planner-only experience. Creation capability is first-class.

## 11. PersonalHomeResponse as Semantic Source

Home data should converge on one canonical semantic contract rather than independent desktop/mobile/legacy derivations.

A source failure should degrade the affected section truthfully rather than blank the entire Home.

Duplicate `sourceRef` presentation across sections should be avoided.

### Desktop Main personal briefing

The Main screen shows a compact personal briefing under the composer — **Today**, **Since Yesterday** and **Suggestions** — fed only by the existing `PersonalHomeResponse` (`GET /api/v1/personal/home`). It is conditionally displayed, never deleted: hiding it keeps its markup, data and cache, and makes no extra API call.

| Main state | Briefing |
|---|---|
| Empty Home (including composer focused or a draft being typed) | Visible |
| Prompt submitted, response in flight or streaming | Hidden |
| Conversation or restored conversation active | Hidden |
| Artifact/result panel active | Hidden |
| Approval workflow active (it lives in the conversation) | Hidden |
| New empty Home started by the user | Visible |
| Refresh | Derived from the restored Main session (server conversation history, after the user's "New conversation" mark), not from an initial boolean |

Rules: no invented events, activity or suggestions — an unavailable source (for example no calendar) is stated, a failing source shows an error with retry, and an empty section says so. "Since Yesterday" lists only items that carry a real timestamp from the start of yesterday. A suggestion is a control that puts its text in the composer without overwriting a draft; it never executes anything and shows when approval would be required. "New conversation" only resets the visible Home: the server keeps the whole Main history. EN/KR strings come from the shared i18n dictionary.

### Desktop Main unified workspace

Desktop Main is ONE adaptive workspace — one session, one Composer, one response stream. Chat and agent work are not separate products; the presentation follows the real task state.

| State | What is shown |
|---|---|
| Idle Home | compact personalized greeting, the Composer, and the four-card briefing — Today (calendar), personal To-do, Since Yesterday, Suggestions — inside the first viewport without scrolling (1440x900, 1680x900, 1920x1080, 1366x768) |
| Draft typing | unchanged; the briefing stays |
| Conversation / agent task | greeting and briefing collapse; a normal stream (the question once, the answer inline) with the Composer docked at the bottom; a task additionally shows its real plan steps, progress and any real pending approval inline; documents/images open in the contextual result panel |
| "My Day" | reopens the briefing above the stream without touching the conversation or the draft |
| New conversation | returns to the idle Home with the briefing |
| Refresh | the whole conversation (or a started-fresh Home) is restored from the Main session, never from an initial boolean |

Rules: a plain question is just a question and an answer — never an agent dashboard; steps, approvals and evidence appear only when they really exist and are never invented; internal identifiers (modes, intents, tool/approval/message ids) are developer diagnostics (`nagex_main_diagnostics`) or behind an explicit "Show details", never ordinary UI; the personal To-do is real reminder/task data or an honest unavailable/empty state; no global CSS rule may permanently hide briefing data and off-screen rendering does not count as visible.

### Desktop Main localization

Every visible string on Desktop Main — composer chrome, mode chips, thread status and steps, the result panel, the Attention Center, the briefing cards and the app-shell header — follows the account locale (EN/KR) and re-renders when the language changes.

- Static chrome uses `data-i18n*` attributes. Runtime text goes through `mt()` (exact UI strings, key `mainText.<slug of the English text>`) or `localizeAppText()` (also the server's templated activity/suggestion wording, `mainPattern.*`).
- Only fixed application wording is translated. User content (calendar titles, task and document names, prompts, AI answers, stored records) is never translated or altered; the server keeps storing English wording and the client translates at display time.
- Logic must not depend on translated text: the thread status is also kept in `data-status` in its canonical form.
- A new user-visible Main string needs its EN and KO entries in `public/i18n.js` in the same change.

### Composer keys (2026-10-17)

Every message box follows one rule set, defined once in `public/composer-keys.js` and used by Main, the ambient Ask sheet (`Alt+N`), Canvas Ask and Quick Wake. Whether a box can hold a line break depends on what it is:

- **Multi-line boxes - Main, the ambient Ask sheet, Quick Wake** (all `<textarea>`; since 2026-10-17 - the Ask sheet and Quick Wake were one-line `<input>`s, where Shift+Enter "did nothing"): **Enter sends; Shift+Enter (and Alt+Enter) inserts a line break at the caret** (the browser's own, never prevented), repeatedly, also in an empty box. The box grows with its lines up to its limit (Main 220 px, Ask sheet and Quick Wake 160 px) and then scrolls inside itself; a multi-line text is sent whole, line breaks kept. Ctrl/Cmd+Enter also sends. A box holding only a line break is empty: nothing is sent. A held key sends once, and a request already in flight is not sent twice (Main says so).
- **One-line fields - Canvas Ask and the header live search:** Enter sends (or searches); **Shift+Enter does nothing** - there is no line break to insert. This is today's behaviour, pinned by a test, and is **not a product decision**: whether Canvas Ask should become multi-line is open and belongs to the product owner.
- **The Enter that only confirms an IME composition (Korean, Japanese, Chinese) never sends.** It is recognised from any of: `isComposing`, `keyCode 229`, being between `compositionstart` and `compositionend`, or `compositionend` having fired a moment ago (Safari order). The next, deliberate Enter sends the confirmed text. The composition flag cannot get stuck (cleared by blur and by a non-composing input event).
- **The Send button and Enter run the same function** in every box - there is no second copy of the send logic.
- On a touch-first device (`hover: none` and `pointer: coarse`) the on-screen keyboard's Enter is a new line and the Send button sends (Main).
- The legacy phone Home bar (`#mh-command-input`) is not part of this: with Main loaded it is never initialised (DEBT-0017).

A front-end fix reaches users only if its file is part of the build-version hash (`FRONTEND_VERSIONED_FILES` in `src/server_web.ts`); `tests/frontend_asset_versioning.test.ts` pins that every versioned asset of every page is covered. Evidence: `docs/evidence/NAGEX_ENTER_SUBMIT_P0_20261017.md`.

## 12. Consumer Status Vocabulary

Prefer stable human states:

- Prepared
- Needs approval
- In progress
- Completed
- Needs your action
- Failed
- Unavailable

Do not use “Done” when the provider merely accepted work.

Do not invent progress percentages.

## 13. Memory-to-Value UX

Memory should appear as useful context, not as database records.

Examples:

- “You prefer morning departures, so I prioritized the 09:10 option.”
- “Your previous discussion focused on launch risk, so I included the open decisions.”

Provide “Why this?” and “Manage memory” paths where appropriate.

Proposed/uncertain memory must not be stated as established fact.

## 14. Activity vs Audit

Activity tells the user what happened in human terms.

Audit preserves deeper technical/security evidence.

Home shows only high-value recent outcomes; Activity is the broader history and drill-down surface.

## 15. Desktop and Mobile

Shared semantics; device-specific composition.

### Desktop
Supports wider context, side-by-side detail, drag/drop, keyboard/Quick Wake and richer work surfaces.

### Mobile
Uses a focused stacked feed, concise summaries, large touch targets, voice/camera/share inputs and clear approval/attention flows.

Do not create separate product logic merely to fit screen size.

## 16. Voice UX

Voice follows the same intent, clarification, approval and execution rules as text.

Voice may accelerate interaction but cannot lower the approval bar.

### Universal Voice (ADR-0013)

Voice is three separate capabilities that may share capture and session infrastructure: **Dictation** (speech → editable text, never submitted by the voice layer), **Conversation** (speech → understanding → response) and **Action** (speech → intent → authorized execution → verification, always through the existing deterministic controls).

Platform voice adapters sit behind one contract and return text only; they make no permission, approval or execution decision. Speech-to-text is a replaceable implementation. Audio is processed on-device when the platform verifies that, is never silently sent to a remote processor, and third-party processing requires provider-specific informed consent with a visible indication and a way to withdraw it. NAgex hosts no speech-to-text engine and receives text, not audio; Whisper and Whisper-based engines are prohibited. If no compliant engine exists on a device, voice input is disabled truthfully and text input remains. Recording is explicit: stop transcribes what was captured, cancel discards it, and dictation never submits. Voice-processing consent is separate from execution approval. See `docs/adr/ADR-0013-universal-voice-architecture.md` for the as-built audit and open gaps.

### Background Voice Call UX

Ordinary short voice commands should normally be captured in the background rather than opening a full-screen voice-input UI.

For an explicitly verified `CALL` intent, NAgex resolves the contact and the phone target first, then shows a compact call confirmation popup. The popup is an execution buffer, not a substitute for target verification.

If exactly one target and phone number are verified, NAgex shows a five-second cancel window with Cancel and Call now actions; voice cancel is supported. If no cancellation occurs during the countdown, NAgex revalidates the target and phone target, then executes exactly one call.

Ambiguous contacts never start a countdown. They show candidate selection first, and the countdown starts only after explicit target selection. Multiple phone numbers use a verified preferred number when one exists; otherwise they require selection.

Proactive call suggestions are stricter: silence is not approval, and an explicit positive confirmation is required.

After a call ends, NAgex closes the call surface, restores Home where feasible, and cleans temporary execution context.

## 17. EN/KR and Global UX

- translate intent, not word order;
- support flexible height for Korean;
- localize date/time/timezone;
- avoid raw i18n keys;
- avoid untranslated infrastructure nouns;
- preserve equivalent semantic state across languages.

## 18. Visual Direction

Prefer:

- calm editorial hierarchy;
- strong typography;
- whitespace;
- restrained semantic color;
- outcome cards;
- meaningful state transitions;
- reduced-motion support.

Avoid:

- KPI-heavy admin dashboards;
- decorative analytics;
- agent-marketplace presentation;
- excessive emoji;
- provider/model branding as primary UX;
- dense technical state by default.

## 19. Accessibility / Mobile Quality

Required UX quality includes:

- no horizontal overflow at supported mobile widths;
- meaningful focus order;
- keyboard accessibility where applicable;
- minimum practical touch targets;
- text + icon/state rather than color alone;
- reduced-motion respect;
- truthful dialogs and modal lifecycle;
- EN/KR real-browser certification for critical flows.

## 20. UX Anti-Patterns

```text
Calendar-App Drift
Prompt-Engineering Burden
Questionnaire UX
Silent Guessing
Internal-State UI
CTA Ambiguity
Capability Fragmentation
Over-Asking
Planner-Only Product Impression
Fake Progress
Fake Completion
```

## 21. Source Provenance

Consolidated from:

- `NAGEX_PRODUCT_UX_INTENT_INTERACTION_PRINCIPLES.md`
- `NAgex_UI_UX_Dual_Experience_Directive_v1.md`
- `NAGEX_R22_UX_PRODUCT_BENCHMARK_MASTER.md`
- `NAgex_Meta_Muse_Benchmark_Revised_Development_Directive_v2_20260923.md`
- `NAgex_R23_7H_A_Personal_Dashboard_Product_IA_Audit_20260929.md`
- `NAgex_Activity_and_Execution_Transparency_Amendment_v1.md`
- later accepted Home/Creation direction from the 2026-09-29 project handoff

Benchmark observations remain supporting evidence, not permanent requirements to imitate another product.

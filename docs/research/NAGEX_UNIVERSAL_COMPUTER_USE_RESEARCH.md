# NAgex Universal Computer Use — Research Note

**Status:** RESEARCH / NOT CANONICAL (point-in-time; does not define architecture)
**Date:** 2026-10-16
**Branch:** `topic/computer-use-20261016` (base `39ecfff`)
**Scope:** What is publicly known about Aside-class browser agents and which open-source building blocks exist, so that the NAgex browser/desktop agent is an *original* NAgex capability and not a clone.

## 1. Method and limits

- Sources: the vendor's own public product page (fetched 2026-10-16), third-party listings found by web search, and the GitHub API (`gh api repos/<owner>/<repo>`) for licence and description of open-source projects.
- **No proprietary reverse engineering.** No Aside binary, traffic capture, private source or protected feature was examined. The REA binary/runtime-analysis tools were **not** invoked: the directive forbids bypassing technical protections and copying proprietary code, and the public pages were the only material used.
- Nothing in this note was observed by running Aside. There are therefore **no `OBSERVED` claims**.
- Timeboxed: this is a survey sufficient to make a build/adopt decision, not a competitive teardown.
- Classification used: `OFFICIAL` (vendor's own page), `THIRD_PARTY` (listing/review/news, not the vendor), `OBSERVED` (we ran it), `HYPOTHESIS` (our inference, labelled as such).

## 2. Aside — what is claimed, and how far it can be trusted

| # | Claim | Class | Source / note |
|---|---|---|---|
| 1 | "A state-of-the-art agent that lives in your browser." | OFFICIAL | aside.com/features/browser-agent (marketing) |
| 2 | Signs in and works across email, dashboards and internal tools, using "the websites and accounts you already use, without setting up integrations". | OFFICIAL | same page; marketing, no mechanism given |
| 3 | Handles comments, replies and follow-ups. | OFFICIAL | same page |
| 4 | Can "work with files directly on your computer". | OFFICIAL | same page; no upload/permission mechanics given |
| 5 | "Ultrabrowse" mode for deep research / complex tasks; keeps working until done. | OFFICIAL | same page |
| 6 | Ranked #1 on Online-Mind2Web, BU-Bench-V1 and Odysseys (listed scores 99.0 % / 97.7 % …). | OFFICIAL (self-reported) | page gives no benchmark methodology; not independently verified |
| 7 | Standalone Chromium-based desktop browser, not a Chrome extension. | THIRD_PARTY | wares.gg, withai.top, must.tools, eesel.ai listings |
| 8 | Password manager fills credentials "without ever exposing them to the AI"; memory stays local. | THIRD_PARTY (relaying vendor claim) | not substantiated on the feature page; no audit found |
| 9 | Background agent tabs; scheduled/recurring jobs (e.g. daily briefing). | THIRD_PARTY | listings only; the feature page does not address it |
| 10 | Pricing / platform availability (macOS vs Windows). | THIRD_PARTY, **conflicting** | sources disagree; irrelevant to NAgex design |
| 11 | How pages are perceived (DOM vs accessibility tree vs screenshots). | **not stated** | the page gives "no technical detail" |
| 12 | Human takeover, approval before consequential actions, error recovery. | **not stated** | not addressed on the feature page |

HYPOTHESES (ours, not facts about Aside): a production browser agent of this class very probably combines structured page data with screenshots (that is also what the open-source agents below do), and probably asks the user before some actions. None of this is relied on.

### What NAgex takes from this

Only the **product expectation**, which is public and generic: users want an agent that works inside the accounts they are already signed into. NAgex deliberately differs where the public material is silent or where NAgex's constitution is stricter:

- NAgex distinguishes **managed** browser sessions (a NAgex-controlled Chromium profile, per owner) from **local-session reuse** (the user's own browser). Only the former exists; the latter is **not implemented and never claimed**.
- Credentials are never given to the model; a login, MFA or CAPTCHA ends the task as `NEEDS_PERSON`.
- Consequential actions (issue, send, pay, delete, submit) are held by NAgex's existing Approval Authority regardless of what the model proposes ("the model reasons, NAgex governs and executes").
- Page text is untrusted data, never instructions.

## 3. Open-source candidates

Licence and description from the GitHub API on 2026-10-16.

| Project | Licence | Runtime | What it is | Decision |
|---|---|---|---|---|
| Playwright (`microsoft/playwright`) | Apache-2.0 | Node | Browser automation | **Already used** by NAgex's browser runtime; kept |
| Playwright MCP (`microsoft/playwright-mcp`) | Apache-2.0 | Node | MCP server exposing Playwright to a model | Studied; **not embedded** — an MCP tool surface would hand action authority to the model's tool calls and bypass NAgex's approval/loop guard |
| browser-use (`browser-use/browser-use`) | MIT | Python | LLM browser agent with element indexing | Idea reused (indexed element map, DOM-first); **not embedded** — Python agent loop with its own control flow |
| Stagehand (`browserbase/stagehand`) | MIT | TypeScript | act/extract/observe over Playwright | Studied; **not embedded** — its `act` lets the model drive directly; NAgex needs a deterministic gate between proposal and execution |
| Skyvern (`Skyvern-AI/skyvern`) | **AGPL-3.0** | Python | Vision + DOM workflow agent | **Rejected for embedding/linking** (AGPL network-copyleft); concepts only |
| FlaUI (`FlaUI/FlaUI`) | MIT | .NET | Windows UI Automation wrapper | Candidate for the native Windows controller (Mission B); **no dependency added by this slice** |
| pywinauto | BSD-3-Clause | Python | Windows UI automation | Alternative; Python runtime not wanted on the device agent |
| UI-TARS-desktop (`bytedance/UI-TARS-desktop`) | Apache-2.0 | TypeScript / Electron | GUI-agent app + vision model | Studied as a reference for screenshot-grounded actions; **not embedded** |
| Open Interpreter (`openinterpreter/openinterpreter`) | Apache-2.0 | Rust (per the API today; historically a Python tool) | Described by the API as "a coding agent for open models" — a model that runs code on the local machine | **Rejected**: a model-controlled local code/shell executor contradicts "no generic model-controlled shell" |

Prior art already analysed for the element map (what was learned, what was written from scratch, no code copied): `docs/evidence/NAGEX_BROWSER_ELEMENT_MAP_EXTERNAL_SOURCE_20261015.md`.

### Why NAgex does not embed an agent framework

1. **Authority.** Every candidate fuses "decide" and "do". NAgex's invariant is that the model only *proposes*; domain allow-list, risk, approval, loop/step/time limits and verification are deterministic and sit between proposal and execution.
2. **Runtime fit.** NAgex is TypeScript on Node; browser-use, Skyvern, pywinauto and open-interpreter would add a Python runtime to the product.
3. **Licence.** Skyvern's AGPL-3.0 is incompatible with embedding. The MIT/Apache-2.0 projects are permissible but would not remove reasons 1–2.
4. **Provider neutrality.** The planner must sit behind NAgex's Model Gateway so any model (Nemotron on Nebius, Gemini, a vision model) can plan; most frameworks assume one provider family.

### Licence review (summary)

- Embedding allowed (not used): MIT (browser-use, Stagehand, FlaUI), Apache-2.0 (Playwright, Playwright MCP, UI-TARS-desktop, open-interpreter), BSD-3 (pywinauto) — attribution/NOTICE obligations would apply if code were copied.
- Embedding **not** allowed: Skyvern (AGPL-3.0).
- Code actually used from these projects by this work: **none copied**; Playwright remains a dependency under Apache-2.0 as before.

## 4. Resulting design (as built in this slice)

Bounded loop `OBSERVE → UNDERSTAND → PLAN → AUTHORIZE → ACT → VERIFY → REPEAT/STOP`, implemented in `DeviceControlService`:

- Perception: DOM-first element map with verified-unique selectors (+ field values) and a screenshot; vision/Astra only as an audited fallback (`HybridExecutionModelAdapter`).
- Planner: `VisualExecutionModelPort`; `GatewayExecutionModelAdapter` routes through `UnifiedModelRouter` (taskKind `PLAN`), validates every proposal against the offered element list, repairs once, then fails closed.
- Action vocabulary: Navigate, Observe, Click, Type, Select, Scroll, Keypress, Wait, Verify, Stop. (Upload is **not** implemented.)
- Authority: `device-action-policy` + existing `ActionApprovalStore` (payload hash, one-time consume); Enter/Space activation is treated like a click; password fields are never typed by the agent.
- Verification: field read-back, click expectations, NAgex-side `VERIFY` of labelled values on the page; a claimed success contradicted by a failed expectation is not reported as done.

See `NAGEX_COMPUTER_USE_GAP_REPORT.md` for status per capability and `NAGEX_COMPUTER_USE_E2E_REPORT.md` for what was actually run.

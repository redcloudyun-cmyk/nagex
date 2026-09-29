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

Current consumer navigation is:

```text
Home
Inbox
Activity
Vault
Settings
```

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

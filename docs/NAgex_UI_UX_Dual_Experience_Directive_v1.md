# NAgex UI/UX Dual Experience Directive v1

**Document type:** Product / UX / UI Development Directive  
**Scope:** NAgex Alpha 1.0  
**Status:** Canonical UI/UX Direction  
**Core principle:** Shared system, separate experience

---

## 1. Purpose

NAgex must not treat Desktop and Mobile as the same interface at different widths.

The product shall provide two distinct experiences:

- **Desktop:** AI Workspace for deep work, control, review, orchestration, and visibility.
- **Mobile:** Personal AI Assistant for quick instruction, approval, briefing, continuation, and immediate action.

The same user, data, identity, safety model, tasks, memory, approvals, activity, devices, and execution backend may be shared, but the information architecture, menu priority, component composition, interaction model, and primary calls-to-action must differ by device context.

This is not a responsive-layout-only project.

---

# 2. Product Experience Principle

## 2.1 Permanent rule

```text
SAME BRAND
SAME DESIGN SYSTEM
SAME DATA MODEL
SAME EXECUTION BACKEND
SAME SAFETY / APPROVAL MODEL

BUT

DIFFERENT INFORMATION PRIORITY
DIFFERENT NAVIGATION
DIFFERENT HOME COMPOSITION
DIFFERENT PRIMARY ACTIONS
DIFFERENT INTERACTION RHYTHM
```

## 2.2 Product identity by device

### Desktop

Desktop must feel like:

> “My personal AI workspace that understands context, prepares work, executes tasks, and lets me stay in control.”

Primary value:
- visibility
- depth
- review
- control
- multi-context work
- work continuity
- orchestration

### Mobile

Mobile must feel like:

> “My personal AI assistant that tells me what matters now and lets me act immediately.”

Primary value:
- speed
- relevance
- confidence
- approval
- briefing
- voice
- continuation
- immediate execution

---

# 3. Experience North Star

NAgex Home must answer three questions immediately:

```text
1. What matters to me right now?
2. What can NAgex do for me now?
3. What has NAgex already done for me?
```

The first screen must not look like:
- a generic SaaS dashboard
- a developer console
- an agent framework admin panel
- a list of system capabilities
- a chat clone with empty whitespace
- a card wall

It must communicate personal value before feature depth.

---

# 4. Core Emotional Goal

The UI must create the expectation:

> “If I keep using this, NAgex will save me time, remember what matters, prepare things before I ask, and safely handle work for me.”

The Home screen must project:
- confidence
- personal relevance
- calm intelligence
- useful anticipation
- continuity
- trust
- execution readiness

Avoid:
- cyberpunk AI styling
- excessive neon
- sci-fi dashboards
- excessive gradients
- dense KPI dashboards
- technical terminology

---

# 5. Visual Direction

## 5.1 Recommended style

**Direction:** Calm Intelligence + Living Workspace

Reference qualities:
- Apple-level restraint
- Notion-like clarity
- Linear-like execution polish
- modern AI assistant responsiveness
- NAgex-specific proactive intelligence

## 5.2 Visual tokens

### Background
- White or near-white
- Secondary surface: very light neutral gray
- Dark areas used sparingly

### Primary text
- Deep charcoal / near black

### Accent
- Electric blue, indigo, or restrained violet
- One primary accent only

### Cards
- subtle border
- very soft shadow
- 14–18px radius
- generous internal whitespace

### Typography
- clear hierarchy
- large greeting / intent headline
- restrained weights
- short paragraphs

### Motion
- subtle
- purpose-driven
- no decorative motion without state meaning

Allowed motion examples:
- agent activity pulse
- thinking → planning → acting transition
- approval state transition
- task completion micro-animation
- subtle presence animation around the composer

---

# 6. Desktop Experience Architecture

## 6.1 Desktop product role

Desktop is the place to:
- work deeply
- inspect context
- review plans
- supervise execution
- manage multiple tasks
- inspect history
- use My Space
- manage files and knowledge
- approve consequential actions
- monitor device activity
- continue longer-running work

## 6.2 Desktop primary navigation

Canonical Desktop navigation:

```text
Home
Inbox
Activity
Vault
Settings
```

`My Space` is a Home-level contextual destination, not necessarily a permanent primary sidebar item.

Do not add low-level engine names to primary navigation.

Forbidden primary labels:
- Memory Engine
- Workflow Engine
- Capability Broker
- Runtime
- Device Agent
- Agent Orchestrator

## 6.3 Desktop Home information architecture

Desktop Home must contain five layers.

### Layer 1 — Personal Context

Purpose:
- show NAgex understands the user’s current day
- create immediate relevance

Examples:

```text
Good morning, Beom-jung.

You have 2 meetings today.
3 items may need your attention.
NAgex is watching 1 ongoing task.
```

Rules:
- never fabricate personal context
- only show connected or owned information
- show disconnected state truthfully

### Layer 2 — Main Composer

Primary prompt:

```text
What do you want to get done?
```

Support:
- keyboard input
- file attachment
- optional voice entry
- context-aware suggestions

The composer must remain visually dominant but not become the entire product.

### Layer 3 — Suggested for You

This is the core differentiator.

Examples:

```text
Prepare for your 2 PM meeting
Review 3 emails that may need a response
Continue yesterday’s research
Summarize the document you uploaded this morning
Check the status of a task NAgex is monitoring
```

Each suggestion must be grounded in real state.

Never fabricate proactive insight.

Each card should answer:
- why this is relevant
- what NAgex can do
- what happens when the user accepts

### Layer 4 — Today

Compact overview of:
- calendar
- tasks
- approvals
- items needing attention

Avoid turning this into a dense project-management dashboard.

### Layer 5 — Value / Progress

Show the user what NAgex has contributed.

Examples:

```text
This week with NAgex

7 tasks handled
4 approvals completed
12 files organized
Estimated 1h 42m saved
```

Rules:
- numbers must be derived from real data
- estimated time saved must be clearly labeled as estimated
- no fake productivity metrics

---

# 7. Desktop My Space

My Space is a deeper personal operating view.

Canonical sections:

```text
Activity
Memory
Tasks
Workflows
Calendar
History
```

Purpose:
- inspection
- continuity
- personal context
- system transparency

My Space is not the default Home.

The Home page must summarize value; My Space must expose detail.

---

# 8. Desktop Interaction Model

Desktop interactions may support:
- hover
- expanded cards
- inline detail
- split view
- side panels
- review drawers
- richer approval inspection
- execution trace
- full task history
- multi-column layouts

Preferred Desktop pattern:

```text
OVERVIEW
→ INSPECT
→ REVIEW
→ APPROVE / MODIFY
→ EXECUTE
→ VERIFY
```

Desktop is the place for confidence-building detail.

---

# 9. Mobile Experience Architecture

## 9.1 Mobile product role

Mobile is not a shrunken Desktop.

Mobile is primarily for:
- quick instruction
- voice interaction
- approvals
- briefings
- urgent attention
- next action
- lightweight continuation
- notifications
- immediate confirmation

Mobile must minimize navigation depth.

## 9.2 Mobile primary navigation

Recommended canonical mobile navigation:

```text
Home
Ask
Approvals
Today
More
```

Alternative labels may be validated in UX testing, but the intent must remain.

### Home
What matters now.

### Ask
Fast text / voice request.

### Approvals
All consequential actions requiring human confirmation.

### Today
Calendar + tasks + active items.

### More
Vault, Activity, My Space, Settings, device status, lower-frequency functions.

Do not mirror the Desktop sidebar exactly.

---

# 10. Mobile Home Information Architecture

Mobile Home must prioritize the next useful decision.

Recommended order:

```text
1. Greeting / personal briefing
2. Quick Ask / Voice
3. Approval waiting
4. Suggested action
5. Next calendar event
6. Active task / Continue
7. Important alert
```

Maximum first-screen density:
- 3–4 meaningful blocks
- no large grids
- no dense analytics
- no full desktop summaries

## 10.1 Mobile greeting

Example:

```text
Good morning.

You have one approval waiting
and a meeting in 42 minutes.
```

Short, contextual, useful.

## 10.2 Mobile Ask

Must be thumb-friendly.

Primary actions:
- tap to type
- hold/tap to speak
- attach
- quick prompts

Examples:

```text
Prepare my next meeting
Find email I should answer
What do I need to do today?
Continue my last task
```

## 10.3 Mobile Approvals

Approval is a first-class mobile experience.

Mobile approval card must show:
- what NAgex wants to do
- where
- why
- risk / consequence
- exact frozen action
- approve
- reject
- modify if allowed

Do not expose unnecessary technical fields.

The user must never approve a vague summary while execution uses a different payload.

---

# 11. Mobile Interaction Model

Mobile should favor:

```text
SEE
→ DECIDE
→ APPROVE
→ CONTINUE
```

Avoid:
- deep tree navigation
- complex tables
- multi-column layouts
- dense filters
- hidden hover-only actions
- long technical histories on primary screens

Use:
- bottom sheets
- stacked cards
- large touch targets
- swipe only when discoverable
- sticky approval actions when appropriate
- concise status

---

# 12. Shared vs Device-Specific Components

## 12.1 Shared

The following must share design tokens and domain logic:

```text
Brand
Color tokens
Typography scale
Icon language
Status semantics
Approval semantics
Risk semantics
Task states
Activity states
Device states
Data contracts
Safety rules
Execution state machine
```

## 12.2 Desktop-specific composition

```text
DesktopHome
DesktopSuggestedForYou
DesktopTodayOverview
DesktopMySpaceSummary
DesktopExecutionInspector
DesktopApprovalPanel
DesktopActivityView
```

## 12.3 Mobile-specific composition

```text
MobileHome
MobileQuickAsk
MobileApprovalCard
MobileToday
MobileBriefing
MobileContinueCard
MobileAlertCard
MobileMore
```

Do not force the same component tree through CSS breakpoints when the information priority is fundamentally different.

---

# 13. Responsive Policy

Responsive design is still required, but it is secondary.

Canonical rule:

```text
Desktop Experience
≠
Mobile Experience resized

Mobile Experience
≠
Desktop Experience collapsed
```

Use breakpoints only after experience-specific composition is decided.

Suggested device modes:

```text
DESKTOP
>= 1024px

TABLET
768–1023px

MOBILE
< 768px
```

Tablet may selectively adopt Desktop or Mobile patterns by task context.

Do not assume tablet = scaled desktop.

---

# 14. Home Personalization Rules

Home personalization must be deterministic and grounded.

Allowed sources:
- owned Tasks
- owned Workflow runs
- owned Memory
- connected Calendar
- connected Gmail
- owned Vault/Captures
- owned Activity
- owned Approval queue
- device connection status

Proactive suggestion engine must never:
- invent meetings
- invent urgency
- invent emails requiring reply
- infer ungrounded personal obligations
- claim actions completed when not completed

Each suggestion should carry a source reason internally.

Example:

```text
Suggestion:
"Prepare for your 2 PM meeting"

Grounding:
calendar_event_id=...
related_email_threads=...
related_vault_items=...
```

---

# 15. Value Meter

NAgex should show longitudinal value.

Potential metrics:

```text
Tasks handled
Approvals completed
Emails prepared
Meetings prepared
Documents processed
Files organized
Workflows completed
Watch tasks monitored
Estimated time saved
```

Rules:
- real counters only
- estimates explicitly labeled
- no manipulative gamification
- no fake streaks
- no meaningless vanity metrics

Goal:

> Make continued use visibly valuable.

---

# 16. AI Presence

NAgex must feel alive without feeling theatrical.

## 16.1 Allowed agent states

```text
Ready
Understanding
Planning
Waiting for approval
Acting
Verifying
Completed
Blocked
Needs you
```

## 16.2 Visual treatment

Use:
- restrained pulse
- subtle progress indicator
- state text
- short transition animation

Avoid:
- spinning AI orb
- excessive glowing gradients
- random motion
- fake “thinking” delays
- artificial typing if result already exists

---

# 17. Approval UX

Approval is one of NAgex’s core trust surfaces.

## Desktop

Provide:
- richer details
- exact action
- target
- source context
- edit/modify where valid
- execution consequences
- audit link

## Mobile

Provide:
- short summary
- exact consequence
- destination/target
- frozen values
- clear Approve / Reject

Both must use the same approved payload.

Rule:

```text
proposal
→ classify
→ freeze exact action
→ approval UI
→ execute once
→ verify
```

UI must never obscure that invariant.

---

# 18. Device Control UX

## Desktop

Device status may show:

```text
This PC
Connected

Background execution available
No active takeover
```

When active:

```text
NAgex is working in the background
```

For future takeover:

```text
NAgex is controlling this device

[Pause]
[Stop]
[Take Back Control]
```

## Mobile

Mobile may act as:
- device status viewer
- approval surface
- remote stop / cancellation surface

Do not expose low-level device-agent terminology to normal users.

---

# 19. Empty States

Empty states must teach product value.

Bad:

```text
No tasks found.
```

Better:

```text
Nothing needs your attention right now.

Ask NAgex to watch something, prepare your day,
or continue work from another device.
```

Empty states should:
- explain
- invite
- reduce uncertainty
- show what the product can do next

---

# 20. Onboarding

Alpha onboarding should be short.

Recommended:

```text
Step 1
What should NAgex call you?

Step 2
Connect what you want
- Calendar
- Gmail

Step 3
What should NAgex help with?
- Meetings
- Email
- Documents
- Tasks
- Personal organization

Step 4
Install / connect this device

Step 5
Home
```

Do not force every integration.

User must understand:
- what is connected
- what NAgex can read
- what requires approval
- what it can execute

---

# 21. Information Density Rules

## Desktop
Medium density.

Allowed:
- multiple context cards
- compact status rows
- timeline
- side panels

Still avoid:
- dashboard overload
- enterprise BI density

## Mobile
Low density.

Rule:
- one primary decision per card
- one dominant CTA
- secondary actions hidden appropriately
- 44px minimum touch target

---

# 22. Copywriting Rules

Use result language, not system language.

Bad:

```text
Execute Workflow
Invoke Capability
Memory Retrieval
Run Agent
```

Good:

```text
Continue this work
Prepare the meeting
Remember this
Send after approval
Watch this for me
Do this on my computer
```

NAgex should sound:
- calm
- confident
- concise
- non-technical
- transparent

---

# 23. Desktop Alpha Screens

Must be redesigned before Alpha freeze:

```text
D01 Desktop Home
D02 Desktop Inbox
D03 Desktop Activity
D04 Desktop Vault
D05 Desktop My Space
D06 Desktop Approval Detail
D07 Desktop Settings
D08 Desktop Device Status
```

Highest priority:

```text
D01 Desktop Home
D05 Desktop My Space
D06 Desktop Approval Detail
```

---

# 24. Mobile Alpha Screens

Must be designed separately:

```text
M01 Mobile Home
M02 Mobile Ask
M03 Mobile Approvals
M04 Mobile Approval Detail
M05 Mobile Today
M06 Mobile Briefing
M07 Mobile More
M08 Mobile Device Status
```

Highest priority:

```text
M01 Mobile Home
M02 Mobile Ask
M03 Mobile Approvals
```

---

# 25. Desktop Home Required Layout

Recommended hierarchy:

```text
HEADER
────────────────────────────

PERSONAL CONTEXT
Good morning...
Here’s what matters today.

MAIN COMPOSER
What do you want to get done?

SUGGESTED FOR YOU
[Meeting] [Email] [Continue work]

TODAY
Calendar / Tasks / Approvals

VALUE
What NAgex handled for you
```

Do not add every subsystem to Home.

---

# 26. Mobile Home Required Layout

Recommended hierarchy:

```text
HEADER
Good morning

BRIEFING
1 approval waiting
Meeting in 42 minutes

QUICK ASK
[Ask NAgex...]
[Voice]

NEEDS YOU
[Approval card]

NEXT
[Meeting]

CONTINUE
[Last task]
```

No Desktop-style sidebar.

No desktop card grid.

---

# 27. Navigation Rules

## Desktop
Left sidebar acceptable.

## Mobile
Bottom navigation preferred.

Do not merely hide Desktop labels into a hamburger.

The mobile navigation must be designed around mobile intent.

---

# 28. Technical Implementation Rule

The frontend should distinguish experience mode explicitly.

Recommended conceptual structure:

```text
AppShell
├── DesktopExperience
│   ├── DesktopNavigation
│   ├── DesktopHome
│   └── DesktopViews
│
└── MobileExperience
    ├── MobileNavigation
    ├── MobileHome
    └── MobileViews
```

Shared domain components may be reused below the experience layer.

Do not duplicate business logic.

Do not duplicate API clients.

Do not create separate safety or approval logic.

---

# 29. State Ownership

Business state remains canonical and shared.

Examples:

```text
Task
Approval
Activity
Memory
Capture
Workflow
Calendar event
Device status
```

Desktop and Mobile are different projections of the same canonical state.

No parallel state model for mobile.

---

# 30. Implementation Anti-Patterns

Do not:

```text
render Desktop UI and hide elements with CSS on Mobile
use one giant responsive Home component
expose every backend feature as navigation
fill Home with charts
surface technical capability names
duplicate API logic by device
duplicate approval state
create mobile-only fake summaries
invent personalized suggestions
make visual decoration more important than usefulness
```

---

# 31. Alpha Design Acceptance Criteria

## Desktop

```text
DESKTOP_HOME_PERSONAL_VALUE_VISIBLE=PASS
DESKTOP_COMPOSER_PRIMARY=PASS
DESKTOP_PROACTIVE_SUGGESTIONS=PASS
DESKTOP_TODAY_CONTEXT=PASS
DESKTOP_VALUE_METER=PASS
DESKTOP_MY_SPACE_SECONDARY=PASS
DESKTOP_APPROVAL_DETAIL=PASS
```

## Mobile

```text
MOBILE_HOME_NOT_DESKTOP_COLLAPSE=PASS
MOBILE_NAV_DEVICE_SPECIFIC=PASS
MOBILE_QUICK_ASK_PRIMARY=PASS
MOBILE_APPROVAL_FIRST_CLASS=PASS
MOBILE_TODAY_CONCISE=PASS
MOBILE_VOICE_READY=PASS
MOBILE_LOW_DENSITY=PASS
```

## Shared

```text
SHARED_BRAND_SYSTEM=PASS
SHARED_CANONICAL_DATA=PASS
SHARED_APPROVAL_PAYLOAD=PASS
SHARED_SAFETY_SEMANTICS=PASS
NO_FAKE_PERSONALIZATION=PASS
```

---

# 32. Design Review Questions

Every screen review must answer:

```text
1. What does the user gain from this screen?
2. What is the primary action?
3. Why is this information shown now?
4. Is every proactive item grounded?
5. Is this Desktop-specific or Mobile-specific?
6. Would removing one block improve clarity?
7. Does the user understand what NAgex can do next?
8. Does the user feel in control?
9. Does the screen expose implementation details unnecessarily?
10. Does this look like a product people would want to use daily?
```

---

# 33. Recommended Design Workflow

Do not jump directly to production coding.

Sequence:

```text
UX-01
Desktop Home IA

UX-02
Mobile Home IA

UX-03
Visual design system

UX-04
Desktop Home high-fidelity mockup

UX-05
Mobile Home high-fidelity mockup

UX-06
Approval surfaces

UX-07
My Space / Today / More

UX-08
Clickable prototype

UX-09
Implementation directive

UX-10
Frontend implementation
```

---

# 34. Immediate Next Design Deliverables

Before large UI refactoring, produce:

```text
1. Desktop Home — high-fidelity mockup
2. Mobile Home — high-fidelity mockup
3. Desktop Approval — high-fidelity mockup
4. Mobile Approval — high-fidelity mockup
5. Shared Design Tokens
6. Component Inventory
```

Desktop and Mobile must be reviewed side-by-side.

---

# 35. Final Product Principle

The permanent NAgex UX principle is:

> **Desktop is where the user works with NAgex.  
> Mobile is where NAgex stays with the user.**

And:

> **NAgex must not merely show features.  
> It must show the user what becomes easier, faster, safer, or possible because NAgex is present.**

---

# 36. Status

```text
DOCUMENT=NAgex UI/UX Dual Experience Directive v1
DESKTOP_EXPERIENCE=DEFINED
MOBILE_EXPERIENCE=DEFINED
RESPONSIVE_ONLY_APPROACH=REJECTED
SHARED_SYSTEM_SEPARATE_EXPERIENCE=REQUIRED

NEXT=
High-fidelity Desktop Home + Mobile Home mockup design
```

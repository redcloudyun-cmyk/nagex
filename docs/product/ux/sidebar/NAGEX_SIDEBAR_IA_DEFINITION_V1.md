# NAgex Sidebar IA Definition v1

**Status:** Draft for implementation
**Scope:** Desktop / Tablet / Mobile navigation information architecture
**Principle:** *Intent is the Interface. The sidebar is navigation, not the execution engine.*

---

## 1. Purpose

The NAgex left sidebar must not become a list of internal AI components, agents, tools, routes, models, planners, or execution states.

The sidebar exists to answer one user question:

> **?쏻here in NAgex do I go for this kind of work or information???*

The main interaction remains natural-language / multimodal intent input.

The sidebar is therefore a **secondary navigation structure**, not the primary interaction model.

---

## 2. Canonical Layout Roles

NAgex desktop UI is divided into three logical areas:

```text
LEFT SIDEBAR
= Navigation + concise history access

CENTER WORKSPACE
= Intent input + creation + work/result surface

RIGHT EXECUTION RAIL
= Approval + live execution + verification + completion
```

On smaller screens, the right rail may collapse into a drawer, slide-over, or bottom sheet, but its lifecycle role does not change.

---

## 3. Canonical Sidebar Menu

Recommended top-level sidebar:

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

### Approval placement

`Approvals` should **not** remain a primary top-level sidebar destination.

Approval is primarily part of the active execution lifecycle:

```text
Right Execution Rail:
AWAITING_APPROVAL
??WORKING
??VERIFYING
??COMPLETED / FAILED
```

Deferred/background approvals remain accessible through:

```text
Inbox
?붴? Approvals
```

---

# 4. Menu Definitions

## 4.1 Home

### User definition

> **The place to start, see today, and see what NAgex is currently doing for me.**

### Primary functions

- Multimodal command composer
  - Text
  - Voice
  - Image
  - Video
  - Screen context
  - File
  - Share
- Your Day
  - upcoming schedule
  - important messages/mail
  - deadlines
  - contextual recommendations
- Active Work
  - background research
  - report generation
  - reservations
  - messaging
  - other currently executing work
- Right Execution Rail
  - approvals
  - working state
  - verifying state
  - completed/failed result

### Must not expose

- Agent selector
- Tool selector
- Router
- Model routing
- MCP internals
- command IDs
- raw approval IDs
- internal planner stages

---

## 4.2 Inbox

### User definition

> **Everything that currently needs my attention.**

Inbox is not an email inbox.

It is NAgex's attention center.

### Sections

#### Needs Attention
- important incoming requests
- scheduling conflicts
- reservation confirmation required
- payment/price condition changes
- execution requiring user decision

#### Approvals
- deferred approvals
- background-agent approvals
- grouped approval requests
- expired/rejected approval review where useful

#### Suggestions
- schedule proposal
- reply proposal
- reservation proposal
- reminder proposal
- follow-up action suggestion

#### Notifications
- completed work
- condition-watch result
- warnings
- blocked tasks
- failures requiring intervention

### Principle

If the user must make a decision **now**, it may appear in the Right Execution Rail.

If it can wait or was generated in background, it belongs in Inbox.

---

## 4.3 Create

### User definition

> **The place to deliberately start creating or analyzing something.**

Home remains the natural-language starting point. Create provides structured entry points for users who prefer visible capability choices.

### Functional groups

#### Documents
- Report
- Brief
- Draft
- Proposal
- Summary

#### Presentations
- Slides
- Presentation outline
- Speaker notes

#### Visual
- Image
- Infographic
- Video

#### Analysis
- Research
- Review
- Compare
- Analyze data

#### Technical
- Code
- Structured extraction
- Technical document generation

### Important distinction

```text
Create
= start/generate a work product

Canvas
= edit/refine an existing work product
```

---

## 4.4 Canvas

### User definition

> **The workspace for editing, organizing, and refining created artifacts.**

### Functions

- document editing
- slide editing
- image/design editing where supported
- page/block structure
- reorder
- rename
- duplicate
- version history
- Undo / Redo
- structured artifact editing
- asset management within a work product

### Principle

Canvas must not become another Home or Create screen.

Its responsibility begins **after an artifact exists or has been opened**.

---

## 4.5 Tasks

### User definition

> **Everything NAgex should do later, repeatedly, conditionally, or in the background.**

### Sections

```text
Today
Upcoming
Recurring
Conditional
Background
Completed
```

### Example items

- Daily 09:00 email brief
- Weekly competitor research
- Notify when price drops below threshold
- Prepare a trip
- Background report generation
- Follow up when a reply arrives

### Must not expose

- raw scheduler internals
- cron syntax
- queue IDs
- worker internals
- command transport internals

### User-visible information

- what NAgex will do
- when / under what condition
- current status
- next run
- last result
- pause/resume/cancel controls

---

## 4.6 Knowledge

### User definition

> **The place to see and manage what NAgex can use as my knowledge and context.**

### Sections

- My Files
- Projects
- Connected Sources
- Saved Context
- Memories
- References
- Search

### Example sources

- uploaded files
- project files
- connected Drive
- connected mail/calendar context where appropriate
- saved research references
- long-term personal/project context

### Principle

Knowledge is about **available information**, not about execution history.

Privacy-sensitive context must be explained in user language, not implementation language.

---

## 4.7 Activity

### User definition

> **A simple history of what NAgex actually did.**

### Default item fields

Only show:

```text
time
human-readable action
target/context
result/status
```

### Example

```text
12:04
KakaoTalk message sent
Test User A 쨌 Completed

11:42
AI market research
Report created 쨌 Completed

10:30
Restaurant reservation
Sample Restaurant 쨌 Confirmed

09:00
Morning email brief
12 messages summarized 쨌 Completed
```

### Activity detail

User-facing detail may include:

- what the user requested
- what NAgex did
- final result
- relevant artifact / confirmation

### Must not expose by default

- commandId
- route
- provider internals
- tool name
- model name
- MCP
- raw approval state
- execution plan internals
- low-level audit trace

These belong in Developer / Audit surfaces only.

---

## 4.8 Settings

### User definition

> **The place to manage account, devices, connections, permissions, personalization, and privacy.**

### Sections

#### Account
- Google login
- Microsoft login
- explicit identity linking

#### Devices
- Desktop
- Mobile
- Connected execution nodes
- device trust / status

#### Connections
- Gmail
- Calendar
- Drive
- Plugins / Apps

#### Permissions
- data access
- action permissions
- notification permissions

#### AI & Personalization
- language
- preferred style
- proactive suggestion preferences

#### Privacy & Security
- approvals
- trusted devices
- audit access
- data controls

#### Appearance
- theme
- density
- layout preferences where supported

---

# 5. Feature Placement Rules

Use these rules whenever adding a new NAgex capability.

```text
User starts work
??Home or Create

NAgex needs user attention
??Inbox

User edits an artifact
??Canvas

Work happens later / repeatedly / conditionally
??Tasks

User manages source knowledge/context
??Knowledge

User reviews what already happened
??Activity

User manages account/device/connection/permission
??Settings

User must approve or monitor a live execution
??Right Execution Rail
```

If a feature does not fit cleanly, do not create a new top-level menu immediately. First test whether it belongs under one of these existing domains.

---

# 6. Right Execution Rail Relationship

The sidebar and the Right Execution Rail must not duplicate each other.

### Right Rail

```text
AWAITING_APPROVAL
??WORKING
??VERIFYING
??COMPLETED / FAILED
```

One user intent should normally remain **one evolving action card**.

### Inbox

Deferred attention.

### Activity

Historical record.

### Tasks

Future/recurring/conditional work.

This distinction must remain stable.

---

# 7. Responsive Behavior

## Wide desktop

```text
Expanded Sidebar + Main Workspace + Execution Rail
```

## Compact desktop

```text
Collapsed Sidebar + Main Workspace + Narrow Execution Rail
```

## Small desktop / tablet

```text
Collapsed Sidebar + Main
Execution Rail = drawer / slide-over
```

## Mobile

```text
Sidebar = navigation drawer
Execution Rail = bottom sheet / full-width panel
```

The information architecture remains identical even when the presentation changes.

---

# 8. Internal Concepts That Must Stay Out of Normal Navigation

The following must not become normal-user sidebar concepts:

```text
Planner
Router
Agent
Sub-agent
MCP
Tool
Model
Provider routing
Execution primitive
Capability resolver
Command queue
Approval binding
Device command state
Confidence calculation
Policy engine
JEV
```

They may exist in:

```text
Developer Mode
Audit
Diagnostics
Admin / Enterprise operational surfaces
```

but are infrastructure, not the user's mental model.

---

# 9. UX Principles

1. **Intent is the primary interface.**
2. Sidebar navigation is secondary.
3. Do not force users to understand NAgex internals.
4. One concept should have one primary location.
5. Avoid duplicate top-level destinations.
6. Execution lifecycle belongs in the Right Execution Rail.
7. History belongs in Activity.
8. Deferred attention belongs in Inbox.
9. Future/recurring work belongs in Tasks.
10. Artifacts are created in Create and refined in Canvas.
11. Knowledge is information/context, not activity history.
12. Sidebar must stay useful even as NAgex capabilities grow substantially.

---

# 10. Canonical Final Sidebar v1

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

This is the baseline IA for the next NAgex Home/Desktop/Mobile UI implementation.

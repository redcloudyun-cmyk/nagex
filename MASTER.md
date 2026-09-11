# NAgex MASTER SPECIFICATION

> **NAgex — Personal AI for the Next Age**

**Document Role:** Level 0 / Single Source of Truth  
**Project Start:** 2026-09-05  
**Project Type:** Independent hackathon project  
**Target Event:** Nebius x NVIDIA Global AI Hackathon

## 0. Canonical Product Vision — Personal AI Execution OS

Adopted 2026-09-11 from the NAgex Canonical Product Vision directive (full text: `docs/NAgex_Canonical_Product_Vision_Personal_AI_Execution_OS.md`). This section sits above everything else in this document — it is the top-level product principle every section below, every future directive, and every architecture/roadmap decision must be evaluated against.

> **NAgex is a Personal AI Execution Operating System that understands a user's intent, continuously plans across real-world services, requests human approval when necessary, executes actions on the user's behalf, and adapts the plan as circumstances change.**

Canonical distinction from a generic personal-agent harness (e.g. OpenClaw-class systems): NAgex adds durable multi-step execution, Goal orchestration, capability governance, human approval, and situation-aware re-planning as first-class, permanent product principles — not optional extras.

**Governance rule (applies to every future feature or architecture decision, technical phases included):** before it enters the roadmap, ask whether it helps NAgex *understand, plan, decide, execute, adapt, remember,* or *present* a user's real-world goal. If not, it should not automatically enter the roadmap. Technical phases (P01–P03, Architecture Phase 09, and everything after) are runtime foundations for this vision, never ends in themselves — see the full document for the complete Goal model, capability layers, payment/credential principles, and situation-aware replanning example.

## 1. Product Definition

NAgex is a Personal AI and Agentic AI system designed to remember user context, reason about goals, use tools, execute real-world tasks, and keep meaningful actions under human control.

NAgex is not defined as a generic chatbot or a simple LLM wrapper.

```text
User Intent
   ↓
Context + Persistent Memory
   ↓
Planning / Reasoning
   ↓
Skills + Tools
   ↓
Human Approval when required
   ↓
Execution
   ↓
Result + Audit
   ↓
Memory / Learning
```

## 2. Brand

**Name:** NAgex  
**Origin meaning:** Next-generation Agent Experience — the name NAgex started from this acronym and it remains true internally, but it no longer defines the brand's ceiling.

**Category:** Personal AI  
**Brand Promise:** Intelligence for the Next Age.  
**Consumer Positioning:** NAgex — Personal AI for the Next Age  
**Internal Architecture:** NAgex Personal AI Operating System

> NAgex is a Personal AI for the Next Age: it understands, remembers, plans, uses tools, and acts with human-controlled autonomy.

NAgex must be presented as an independent product. See Section 14.11 for the full brand specification (positioning, voice, naming rules, and brand decision checklist).

## 3. Project Origin

NAgex was created as an independent project on 2026-09-05.

The initial repository was bootstrapped from an earlier internal experimental AI platform codebase owned by the same entrant. That prior codebase is used only as a technical starting point.

From the NAgex root commit onward:

- Product decisions belong to NAgex.
- Branding belongs to NAgex.
- Hackathon implementation belongs to NAgex.
- Architecture may diverge from the earlier experimental project.
- NAgex must not be presented as a previously released commercial product.
- NAgex must not conceal the fact that an internal experimental codebase was used as its initial technical foundation.

## 4. Hackathon Objective

NAgex is being developed for the Nebius x NVIDIA Global AI Hackathon.

The hackathon implementation must demonstrate real use of required Nebius and NVIDIA technologies rather than documentation-only integration.

Target integration areas:

- NVIDIA Nemotron models
- Nebius Token Factory
- Nebius AI Cloud
- Agent reasoning
- Tool execution
- Persistent memory
- Human approval
- Model routing
- Auditable execution

Features that are planned but not yet implemented must never be described as completed.

## 5. Core Product Capabilities

### 5.1 Persistent Memory
NAgex should retain useful user context across interactions. Memory must distinguish session context, user preferences, task history, long-term memory, sensitive data, and agent execution history. Memory must be inspectable and controllable by the user.

### 5.2 Agent Planning
NAgex must transform an objective into executable steps.

```text
Goal
→ Analyze
→ Plan
→ Select Skill / Tool
→ Execute or Request Approval
→ Observe Result
→ Re-plan when necessary
→ Complete
```

### 5.3 Skills
Reusable capabilities should be explicit Skills with name, description, permissions, input/output contract, required tools, safety level, and execution policy.

### 5.4 Tools
Tools provide controlled access to capabilities such as web, files, code execution, APIs, search, browser, and user-authorized integrations.

### 5.5 Human Approval
Meaningful external-impact actions must support human approval, including external messaging, data modification, financial actions, destructive operations, permission changes, and sensitive data transfers.

### 5.6 Execution
Each execution should preserve goal, plan, selected model, tool calls, approval state, result, errors, timestamps, and audit information.

### 5.7 Model Routing
The Model Router should support routing based on task type, complexity, latency, context length, cost, model capability, availability, and failure recovery. NVIDIA/Nebius usage must remain substantive in the hackathon execution path.

## 6. Target Architecture

```text
NAgex UI
   │
   ▼
Personal Agent Runtime
   │
   ├── Memory
   ├── Planner
   ├── Skills
   ├── Tools
   └── Approval
   │
   ▼
Model Gateway / Router
   │
   ├── NVIDIA Nemotron
   └── Additional Models
   │
   ▼
Nebius Token Factory / Nebius AI Cloud
   │
   ▼
Execution Result
   │
   ▼
Audit + Memory
```

## 7. Safety and Control Principles

1. Human authority takes precedence over agent autonomy.
2. Sensitive actions require explicit policy evaluation.
3. Secrets must not be embedded in source code, logs, prompts, or public repositories.
4. Tool permissions must be explicit.
5. Cross-user and cross-tenant access is default-deny.
6. Agent actions must be observable.
7. Destructive operations must not happen silently.
8. Model failure must not bypass security policy.
9. Memory must be controllable and deletable.
10. Demo convenience must not create unsafe production defaults.

## 8. Implementation Truthfulness

Documentation, UI, README, demo video, and Devpost submission must distinguish:

- Implemented
- Partially implemented
- Prototype / Mock
- Planned

A mock must never be represented as a live integration.

## 9. Development Priorities

### Phase H1 — Separation and Foundation
- NAgex independent repository
- Independent Git history
- NAgex branding
- Remove legacy product-specific documentation
- Normalize package names and internal identifiers
- Establish NAgex documentation SSOT

### Phase H2 — Hackathon AI Core
- NVIDIA Nemotron integration
- Nebius Token Factory integration
- Model Gateway
- Model Router
- Agent planning loop

### Phase H3 — Personal AI
- Persistent memory
- Skills
- Tool registry
- Permission model
- Human approval

### Phase H4 — Demonstrable Execution
- Real tool execution
- Execution timeline
- Audit log
- Failure handling
- Re-planning
- User-visible model/provider state

### Phase H5 — Submission Productization
- Product UI
- NAgex branding
- Public repository cleanup
- Security review
- README
- Architecture documentation
- Demo scenario
- Demo video
- Devpost submission

## 10. Naming Rules

Canonical naming:

```text
NAgex
NAgex Agent
NAgex Runtime
NAgex Memory
NAgex Skill
NAgex Tool
NAgex Model Gateway
NAgex Model Router
```

Internal identifiers should eventually use `nagex`, `Nagex`, and `NAgex`.

Legacy identifiers inherited from the bootstrap codebase must be migrated deliberately with associated schemas and tests.

## 11. Source of Truth Priority

```text
Canonical Product Vision (Section 0 / docs/NAgex_Canonical_Product_Vision_Personal_AI_Execution_OS.md)
   ↓
MASTER.md
   ↓
AGENTS.md
   ↓
Domain documentation under docs/
   ↓
Schemas / API contracts
   ↓
Tests
   ↓
Implementation
```

Existing implementation does not override this specification merely because legacy code already behaves differently.

## 12. Definition of Done

A NAgex feature is complete only when applicable items are satisfied:

- Product behavior implemented
- Security boundary checked
- Input/output contract defined
- Error handling implemented
- Tests pass
- UI state is truthful
- Auditability exists where required
- Documentation matches implementation
- No secrets committed
- No misleading mock behavior
- Build succeeds

## 13. Core Product Statement

> **NAgex is a Personal AI that understands, remembers, organizes, plans, acts, and continues work across time with human-controlled autonomy.**

This definition supersedes inherited product descriptions from the bootstrap codebase, and is restated in brand terms in Section 14.11 ("Intelligence for the Next Age.").

## 14. Extended Vision — Always-On Personal AI Gateway

Adopted 2026-09-07 from the OpenClaw-Benchmarked Integrated Development Directive. This section extends (does not replace) Sections 1–13: the hackathon-critical path in Section 9 remains the near-term priority, and everything below is the longer-term platform vision that near-term work should stay compatible with.

NAgex is not a single chatbot, a single AI dashboard, or a single workflow tool.

> **NAgex is an always-available Personal AI that remembers, reasons, plans, uses tools, and acts across a user's digital life with human-controlled autonomy.**

Canonical execution flow (supersedes the Section 1 flow with the addition of session and task continuation):

```text
User Signal / Intent
   ↓
Main Session
   ↓
Context + Persistent Memory
   ↓
Reasoning
   ↓
Planning
   ↓
Skill
   ↓
Tool
   ↓
Approval Policy
   ↓
Execution
   ↓
Result
   ↓
Audit
   ↓
Memory Update
   ↓
Task / Automation continuation when needed
```

UX is split into two layers:

```text
PRIMARY UX
Chat / Voice / Quick Wake / Mobile / External Channels

SECONDARY UX
Control Center
- Home, Memory, Plans, Tasks, Skills, Tools, Approvals, Executions, Knowledge, Settings
```

### 14.1 OpenClaw Benchmark Conclusion

The capability class worth benchmarking from OpenClaw-style systems is not any single UI, but a combined structure:

```text
Always-on Gateway
+ Persistent Session
+ Persistent Memory
+ Multi-channel
+ Browser Control
+ Device / Node Control
+ Tools / Skills / Plugins
+ Automation
+ Multi-agent / Sub-agent
+ Local-first / Self-hosted runtime
```

NAgex differentiates by keeping this capability class while going further on governance:

```text
Human Approval
Exact Payload Freeze
Execution Replay Protection
Explicit Autonomy Levels
Policy Engine
Auditability
Task visibility
Enterprise-grade governance
```

> **Differentiation: OpenClaw-class capability + NAgex-grade governance.**

### 14.2 Gateway Architecture

Long-term, NAgex is an always-on Agent Gateway:

```text
                 ┌──────────────────────┐
                 │     NAgex Gateway    │
                 │     Always-on        │
                 └──────────┬───────────┘
                            │
          ┌─────────────────┼──────────────────┐
          │                 │                  │
       Channels          Sessions           Runtime
          │                 │                  │
 Web / Mobile       Main / Group /        Models
 Telegram / Slack   Task / Agent          Tools
 WhatsApp / Voice                         Skills
                                          Tasks
                                          Nodes
```

The Gateway owns: channel connections, auth, session routing, memory lookup, model routing, task scheduling, tool invocation, approvals, execution state, audit, node/device routing, plugin lifecycle, and health/status.

### 14.3 Main Session

A user should be able to talk to one continuous Personal AI regardless of entry point:

```text
Web / Android / Telegram / Slack / Voice / Quick Wake
        ↓
   Main Session
        ↓
Same Memory · Same Identity · Same Context · Same Tasks
```

Session types: `MAIN`, `DIRECT`, `GROUP`, `TASK`, `AGENT`, `BACKGROUND`.

Identity linking resolves any channel-scoped identifier to one canonical principal and one Main Session:

```text
user@web / telegram:123456 / slack:U123 / android:deviceABC
        ↓
     usr_001
        ↓
  sess_main_001
```

### 14.4 Tasks Center

The Control Center gains a `Tasks` tab alongside Home/Memory/Plans/Skills/Tools/Approvals/Executions/Knowledge/Settings.

`Plan` and `Task` are distinct concepts:

```text
Plan  = how something should be executed (a single generated, resolved, approved run)
Task  = a standing object that actually runs, recurs, waits, watches a condition, or is background-tracked
```

Task types: `ONE_TIME`, `RECURRING`, `CONDITIONAL`, `BACKGROUND`, `WAITING`, `STANDING_INTENT`.

Examples:

- "Schedule a meeting tomorrow at 2 PM" → `ONE_TIME`
- "Give me my calendar summary every day at 8 AM" → `RECURRING`
- "Tell me when the flight drops below ₩800,000" → `CONDITIONAL`
- "Analyze these 500 documents" → `BACKGROUND`
- "Let me know when the client replies" → `WAITING`
- "Always flag VIP client emails" → `STANDING_INTENT`

Task record (canonical shape):

```json
{
  "taskId": "task_...",
  "ownerId": "usr_...",
  "name": "Daily Morning Brief",
  "type": "RECURRING",
  "status": "ACTIVE",
  "sourceSessionId": "sess_main_001",
  "planTemplateId": "plan_tpl_...",
  "trigger": { "type": "SCHEDULE", "schedule": "0 8 * * *", "timezone": "Asia/Seoul" },
  "approvalPolicy": "READ_ONLY_AUTO",
  "nextRunAt": "...",
  "lastRunAt": "...",
  "createdAt": "...",
  "updatedAt": "..."
}
```

Trigger types: `SCHEDULE`, `INTERVAL`, `CONDITION`, `WEBHOOK`, `EMAIL_EVENT`, `CALENDAR_EVENT`, `FILE_EVENT`, `MANUAL`, `SYSTEM_EVENT`, `AGENT_EVENT`.

Task status: `DRAFT`, `ACTIVE`, `PAUSED`, `WAITING`, `RUNNING`, `COMPLETED`, `FAILED`, `CANCELLED`, `EXPIRED`.

Task actions: Pause, Resume, Run now, Edit, Duplicate, Delete, View history, Change approval policy.

A Task grants standing (repeated) authority to act — creating one is a materially different, more consequential decision than a one-off approval, and must require explicit, unambiguous user confirmation before it is created (see Section 19's canonical confirmation flow, applied here to task creation rather than a single execution).

### 14.5 Extended Capability Roadmap

Current vs. target (informational — near-term hackathon priority is still Section 9's Phase H1–H5):

| Area | Current | Target |
|---|---|---|
| Main Session | Partial (Ambient interaction) | Persistent canonical session |
| Memory | Initial implementation | Long-term / episodic / project / relationship / preference memory |
| Multi-channel | Implemented (Telegram Bot & Slack Event API + Identity Resolution AC-13) | Telegram & Slack implemented; WhatsApp, Mobile target |
| Calendar | Live (create/update/cancel/RSVP, all approval-gated) | Confirmation UX in the ambient composer for update/cancel/RSVP (create_event's compose form + approval card already ships this) |
| Gmail | Live (send/reply/create_draft, all approval-gated; search/read_thread read-only) | Approval-card UI wired into the ambient composer (pure view-model exists — see public/gmail-approval-view.js — but no natural-language compose flow yet) |
| Browser | Not implemented | Agent-controlled browser |
| Computer Use | Not implemented | Paired-node based |
| Local Files | Limited | Read/write/edit/search |
| Shell | Not implemented | Sandboxed exec |
| Automation | SCHEDULE/INTERVAL implemented; CONDITION implemented via browser-page watch (item 07); WEBHOOK/EMAIL_EVENT/CALENDAR_EVENT/FILE_EVENT/SYSTEM_EVENT/AGENT_EVENT not implemented | Full trigger-type coverage |
| Tasks Center | Implemented (create/list/get/patch/pause/resume/run/cancel/delete, ONE_TIME/RECURRING/CONDITIONAL/BACKGROUND) | STANDING_INTENT task type not yet meaningfully distinct |
| Background Agent | Implemented (Durable background execution with step progress tracking 0-100%, cancellation, re-check, AC-12 passing) | Advanced background sub-agent orchestration |
| Multi-agent | Not implemented | Sub-agent / isolated workspace |
| Plugins | Not implemented | Runtime plugin SDK |
| Mobile | Concept only | Android-first node |
| Voice | UI-only | Real STT/TTS / wake flow |
| Governance | Foundational | Advanced |
| Audit | Basic | Unified task/execution audit |
| Notification Engine | Implemented (Multi-channel Web, Telegram & Slack proactive dispatch, task outcome & condition wiring) | Push notification service & channel preferences |

Extended roadmap phases (post-hackathon-critical-path; do not block Section 9's H-phases on these):

- **Phase G1 — Personal AI Core:** Main Session, session persistence, identity linking, Tasks Center data model, one-time/recurring Task, automation scheduler, Gmail LIVE, Calendar E2E completion, main conversation UX.
- **Phase G2 — Browser + Background:** Browser Agent, browser profile, browser tool policy, Background Task, Conditional Watch, Heartbeat, notification engine.
- **Phase G3 — Multi-channel:** Telegram, Slack, identity link, session continuity, outbound delivery.
- **Phase G4 — Computer / Node:** Node protocol, Windows node, Android node, screen snapshot, click/type, local files, sandboxed shell.
- **Phase G5 — Multi-agent:** Agent registry, sub-agent, isolated workspace/session, delegation, background parallelism, tool-limited agents.
- **Phase G6 — Plugin / Ecosystem:** Plugin manifest, plugin install, permission model, channel plugin, tool plugin, skill package, marketplace foundation.

Priority order across phases: (01) Main Session, (02) Tasks Center, (03) Recurring Task/Scheduler, (04) Gmail LIVE, (05) Calendar E2E completion, (06) Browser Agent, (07) Conditional Watch, (08) Heartbeat, (09) Background Tasks, (10) Telegram, (11) Slack, (12) Notification engine, (13) Computer Use/Node, (14) Local Files, (15) Shell, (16) Sub-agent, (17) Plugin SDK, (18) Android App, (19) Voice full stack, (20) Marketplace.

### 14.6 Immediate Sprint — Main Session + Tasks Foundation

The first concrete slice of Phase G1: `SessionStore`, `MainSessionService`, `TaskStore`, `TaskScheduler`, Tasks API, Tasks UI, one-time/recurring task support, and task lifecycle audit.

API surface:

```text
GET    /api/v1/sessions/main
GET    /api/v1/tasks
POST   /api/v1/tasks
GET    /api/v1/tasks/:id
PATCH  /api/v1/tasks/:id
POST   /api/v1/tasks/:id/pause
POST   /api/v1/tasks/:id/resume
POST   /api/v1/tasks/:id/run
DELETE /api/v1/tasks/:id
GET    /api/v1/tasks/:id/runs
```

Acceptance criteria:

- AC-01 Main Session supports natural continuous conversation.
- AC-02 Session persists across reload/restart.
- AC-03 A repeated instruction is interpretable as a recurring Task candidate.
- AC-04 A Task is created only after the user confirms schedule/timezone/action.
- AC-05 The Tasks view lists all standing/one-off tasks.
- AC-06 Pause/Resume/Run-now are supported.
- AC-07 Task execution passes through the Tool Registry / Approval Policy exactly like any other execution.
- AC-08 Task history links to Execution/Audit.
- AC-09 Tasks survive a server restart.
- AC-10 A Task can never bypass write approval.
- AC-11 A Conditional Task must never notify the user while its condition is unmet.
- AC-12 Background Tasks support progress/cancel/re-check.
- AC-13 Main Session and any external channel resolve to the same identity.
- AC-14 EN/KR are both supported.
- AC-15 Every consequential execution remains replay-safe.

### 14.7 Implementation Prohibitions (Extended Roadmap)

- Do not copy OpenClaw source code directly.
- Do not copy its branding/UI verbatim.
- Do not take short-term hacks that conflict with NAgex canonical architecture.
- Do not fake runtime state.
- Do not bypass approval.
- Do not store tokens/secrets in the frontend.
- Do not use uncontrolled fuzzy tool/skill resolution (explicit alias tables only — see the Skill Registry precedent already implemented).
- Do not perform hidden background actions.
- Do not hide a persistent Task from the UI.
- Do not let memory take priority over current intent (see Section 5.1 and the Skill Registry / memory-relevance precedent already implemented).
- Do not allow duplicate/replayed execution of the same action.

### 14.8 Extended Definition of Done

In addition to Section 12, a new Gateway/Tasks feature must also answer:

1. Does it work naturally from within the Main Session?
2. Which of One-time / Recurring / Conditional / Background / Waiting does it belong to?
3. Should it be tracked as a Task?
4. Which Skill(s) does it require?
5. Which Tool(s) does it require, and are they actually connected?
6. What is the side-effect level, and is approval required?
7. Can the user see its state from Tasks/Approvals/Executions?
8. Is it captured in Audit?
9. Is only the necessary Memory updated?
10. Does state survive a restart?
11. Is it supported in both EN and KR?
12. Does current intent take priority over memory?
13. Is execution replay-safe?

### 14.9 Personal Workspace, Quick Capture, NAgex Inbox, & Personal Cloud Vault Specification

Adopted 2026-09-07 from the NAgex Personal Workspace Planning Directive.

NAgex Personal Workspace unifies raw human input (audio recordings, URL links, screenshots, PDFs/documents, transient thoughts, voice memos, meeting candidates, email snippets) into a single Personal AI system with structured processing, persistent cloud vaulting, and seamless linkage to Tasks, Calendar, Memory, and Knowledge.

```text
Any Input (Voice / Audio / File / URL / Text / Image)
   ↓
Quick Capture (Desktop / Mobile / Web / Channel)
   ↓
NAgex Inbox (CAPTURED → UPLOADING → PROCESSING → READY / NEEDS_REVIEW)
   ↓
AI Processing Pipeline (Extract Context, Entities, Intent)
   ↓
Personal Cloud Vault (Canonical Storage + Knowledge Vector Index)
   ↓
Automated Relationships (Task Creation / Calendar Event / Memory Update)
```

#### 1. Personal Workspace Core Concepts

- **Quick Capture**: Frictionless, single-action entry point accessible from Desktop Quick Wake, Mobile Sheet, Web Composer, or Messaging (Telegram/Slack).
- **NAgex Inbox**: The single triage hub where all captured items land in truthful processing states before or after automated AI enrichment.
- **Personal Cloud Vault**: The user's cloud-first canonical repository for captured media, documents, links, and structured notes, equipped with local offline caching.
- **Home Redesign**: Dominant Main Canvas with a collapsed 56–64px sidebar, reduced hero height, dynamic canvas width modes (Chat 850–1000px, Task/Research 1200–1440px, Full Width Browser/Doc), and zero decorative emoji/KPI clutter.

#### 2. Truthful Processing Lifecycle States

Every capture item progresses through explicit, observable states:

```text
CAPTURED → UPLOADING → PROCESSING → READY / NEEDS_REVIEW → ACTIONED / ARCHIVED
                                      └─→ FAILED
```

- `CAPTURED`: Raw input received locally or via channel API.
- `UPLOADING`: Media or binary payload syncing to Personal Cloud Vault.
- `PROCESSING`: AI Pipeline extracting metadata, entities, summary, and action items.
- `READY`: Processing complete; insights mapped to Memory/Vault.
- `NEEDS_REVIEW`: Action item extracted requires human review/confirmation.
- `ACTIONED`: User or agent converted capture into a Task, Calendar event, or Knowledge item.
- `FAILED`: Processing or upload encountered an explicit error.
- `ARCHIVED`: Archived item stored permanently in Personal Cloud Vault.

#### 3. Capture → System Relationships

- **Capture → Task**: Extracted action items generate standing or one-time Tasks in the Tasks Center.
- **Capture → Calendar**: Dates, candidates, and meeting notes populate Calendar intent slots.
- **Capture → Memory**: Long-term preferences, project facts, and key facts enrich `MemoryEngine`.
- **Capture → Knowledge**: Documents and long-form texts index into `KnowledgeEngine` for deep RAG retrieval.

#### 4. Multi-Surface Capture & Storage Architecture

- **Surfaces**: Desktop Quick Wake (Hotkey Alt+N), Web Canvas ("Ask or drop anything here..."), Mobile App Ambient Sheet, Telegram/Slack Bot forwarding.
- **Cloud-First + Local Offline Layer**: All capture metadata and binary artifacts store canonical copies in encrypted cloud storage with local offline sync buffers for instant desktop responsiveness.

#### 5. Level-0 Canonical UX Principles & Agentless Experience Specification

Adopted 2026-09-08 from the NAgex Personal AI UX Redesign Directive.

1. **Agent is infrastructure, not interface**: NAgex presents one Personal AI to the user. Agentic complexity is internal.
2. **One NAgex, not many visible agents**: Users do not select or operate individual agents; they communicate with NAgex.
3. **One primary input surface**: The unified Home composer and Quick Wake overlay accept text, voice, URLs, files, PDFs, audio, and screenshots without forcing category pre-selection.
4. **User intent takes priority over feature navigation**: Actions flow directly from intent to completion.
5. **Main Canvas takes priority over dashboards**: Workspace canvas dominates the UI; static KPI grids are eliminated.
6. **Progressive disclosure is mandatory**: Simple human status by default ("NAgex is preparing your report"), technical details (plan steps, execution IDs, audit logs) expanded on demand.
7. **Approval appears in context, not as the default primary workflow**: Pending approvals present contextually in "Needs attention", while retaining full auditability under Advanced.
8. **Capture first; classify internally**: Input is ingested instantly, processed asynchronously by the AI pipeline, and classified into candidates for user review.
9. **AI structures and recommends; the user decides**: NAgex proposes candidates (Task, Calendar, Memory, Knowledge); the user accepts or rejects.
10. **Internal complexity stays hidden by default**: Internal layers (Agents, Skills, Tools, Plans, Executions) stay hidden from routine consumer interaction.
11. **If the user must understand NAgex system architecture to use NAgex, the UX has failed**: Product success requires intuitive, frictionless interaction.

##### Product Naming & Architectural Hierarchy

- **Consumer Product Name**: NAgex Personal AI
- **Internal Architecture Name**: NAgex Personal AI Operating System

```text
Consumer Interface (Primary Navigation):
NAgex
├─ Home
├─ Capture
├─ Tasks
├─ Memory
└─ Vault

Secondary Navigation (under "More"):
Activity | Automations | Connections | Knowledge | Settings

Advanced / Platform Navigation (under "Advanced" / "Developer"):
Approvals | Agents | Skills | Tools | Executions | Developer

Internal Platform Architecture:
Planner | Agents | Skills | Tools | Model Router | Approval Engine | Execution Engine | Memory Engine | Browser Agent | Computer Use | Knowledge | Audit
```

**Capability Rule**: A new capability MUST NOT automatically create a new top-level navigation item. (Example: Adding Computer Use capability does NOT add a "Computer Agent" menu item. Instead, NAgex utilizes Computer Use internally when executing user instructions).

### 14.10 NAgex Personal AI Capability Architecture & Functional Redefinition

Adopted 2026-09-08 from the NAgex Personal AI Capability Architecture & Functional Redefinition Directive.

This canonical specification redefines NAgex from an agent/tool/plan-centric UI ("Agent Platform") into a unified Personal AI user experience centered on 10 core human capabilities, while preserving internal agentic operating system architecture.

#### 1. Executive Summary & Paradigm Shift

NAgex is not an "Agent Platform" where users select and operate individual agents. The user experiences **ONE NAgex Personal AI**.

```text
OLD PRODUCT DEFINITION (System-facing):
Browser Agent | Calendar Agent | Gmail Tool | Plan | Approval | Execution | Memory Engine | Task Engine

↓

NEW PRODUCT DEFINITION (User-facing Capability Map):
Understand | Capture | Remember | Organize | Plan | Act | Watch | Notify | Review | Continue
```

- **Canonical Rule**: `Agent is infrastructure, not interface.`
- **Product Layer**: NAgex Personal AI (Ask, Talk, Paste, Share, Drop, Capture).
- **Architecture Layer**: Main Session, Input Router, Model Router, Planner, Agent Runtime, Skill Registry, Tool Registry, Task Engine, Scheduler, Conditional Watch, Approval Engine, Replay Protection, Audit, Browser Agent, Computer Use, Calendar, Gmail, Notification Engine, Memory Engine, Vault, Knowledge.

#### 2. NAgex 10 Core Capability Map

1. **Ask & Understand**: Answer questions, summarize text/PDFs/URLs, compare documents, analyze structured data, and synthesize multi-modal context.
2. **Capture Anything**: Instant ingestion of text, URLs, PDFs, audio, screenshots, and files without forcing manual pre-classification ("Capture first. Classify later.").
3. **Remember**: Retain long-term preferences, people, projects, work patterns, and key facts across interactions.
4. **Organize**: Generate semantic views (Projects, People, Meetings, Ideas, Reference) and entity relationships automatically without manual folder setup.
5. **Plan & Decide**: Transform high-level human goals into internal execution steps and present clear decision candidates to the user.
6. **Act**: Perform real-world actions in Calendar, Gmail, Browser, Telegram, Slack, Computer Use, Local Files, and external services with human-controlled safety.
7. **Watch & Wait**: Continuously monitor time, conditions, webhooks, and external events across long durations (Now, Later, Waiting, Recurring).
8. **Notify & Surface**: Deliver noise-reduced, high-value alerts and completion notifications across Web, Telegram, Slack, Desktop, and Mobile.
9. **Review & Control**: Contextual human approval ("Needs your attention"), replay protection, immutable audit trails, and action revert/modify controls.
10. **Continue Across Time**: Maintain persistent session continuity, standing intents, and multi-day task execution without losing state.

#### 3. Cross-Cutting Capabilities & Taxonomies

- **Context**: Automatic contextual fusion across Memory, Tasks, Vault, Knowledge, and Calendar without requiring redundant user explanation.
- **Trust**: Human approval, auditability, replay protection, privacy boundaries, and zero fake state.
- **Multi-Model Intelligence**: Invisible internal Model Router steering queries to Nebius, NVIDIA, OpenAI, Gemini, or Local models based on intent.
- **Internal Agent Taxonomy**: Agents (Browser, Research, Calendar, Email, Computer) are internal specialized workers exposed only in Advanced/Developer modes.
- **Skill / Tool Resolution**: Skill = how NAgex performs a task; Tool = executable capability. User never selects tools manually.

#### 4. Capability Maturity & System Mapping

| Existing System | Reclassified Capability | Current Maturity |
|---|---|---|
| Main Session / Model Router | Ask & Understand / Continue | Strong |
| Memory Engine | Remember | Medium |
| Workspace Capture | Capture Anything | Medium |
| Personal Cloud Vault | Organize | Medium |
| Task Engine / Scheduler / Watch | Watch & Wait / Continue | Medium / Strong |
| Browser Agent | Ask & Understand / Act | Strong |
| Calendar / Gmail | Act | Strong |
| Approval Engine / Audit | Review & Control | Strong |
| Document / Multimodal AI | Ask & Understand / Capture | In progress / Planned |
| Computer Use / Local Files | Act | Planned (P2) |

#### 5. Priority Matrix & Development Roadmap

- **P0 (Personal AI Foundation)**: Unified Ask/Capture, Real Capture Processing, Memory integration, Tasks/background continuation, Contextual approval, Live Calendar/Gmail/Browser.
- **P1 (Differentiators)**: Audio transcription, Screenshot/Document understanding, Semantic Vault, Standing intent, Conditional Watch UX, Cross-device continuity.
- **P2 (Deep Autonomy)**: Computer Use, Local Files, Shell, Android background assistant.
- **P3 (Platform Expansion)**: Plugin SDK, Marketplace, Developer ecosystem.

##### Sprint Roadmap
- **Sprint 1**: Capability Reclassification & UI Terminology Alignment
- **Sprint 2**: Real Capture Processing (Text, URL, PDF, Candidate Generation)
- **Sprint 3**: Memory / Knowledge / Vault Linkage & Source Traceability
- **Sprint 4**: Watch / Continue (Conditional, Waiting, Recurring, Standing Intent UX)
- **Sprint 5**: Audio / Screenshot / Image Multimodal Processing
- **Sprint 6**: Computer Use (Safe Desktop/Browser/Device actions)
- **Sprint 7**: Android Ambient Personal AI (Share Target, Quick Capture, Voice)

#### 6. Experience Loops & Candidate Model

- **Loop A (Ask)**: Ask → Understand → Answer → Remember if useful.
- **Loop B (Capture)**: Capture → Store → Understand → Organize → Propose Candidate.
- **Loop C (Act)**: Intent → Plan → Review if required → Act → Confirm.
- **Loop D (Background)**: Delegate → Work → Wait / Watch → Notify → Continue.
- **Loop E (Personalization)**: Use → Learn → Remember → Better context next time.
- **Candidate Model**: AI proposes candidates (Task Candidate, Calendar Candidate, Memory Candidate, Knowledge Candidate); human accepts, modifies, or rejects.

#### 7. Final Principle

> **Do not build more visible agents. Build more capability into one NAgex.**
> NAgex should feel less like a system the user operates and more like a Personal AI the user entrusts with work.

### 14.11 Brand Definition — Personal AI for the Next Age

Adopted 2026-09-08 from the NAgex Brand Definition directive (full text: `docs/NAgex_Brand_Definition_Next_Age_20260908.md`).

This section extends Section 2 (Brand) with the canonical brand specification. It does not change product scope, architecture, or the Section 9 hackathon-critical path — it governs brand copy, voice, and naming going forward.

**Canonical brand statement:** NAgex is a Personal AI for the Next Age.

**Brand promise:** Intelligence for the Next Age. — deliberately independent of any current technology term (Agent, LLM, Model, Tool, Workflow, Computer Use), so the promise survives even as those terms change.

**What "Next Age" means:** a shift in how a user relates to AI, not a claim of AGI or a futuristic aesthetic:

```text
AI as a passive tool
→ AI as an active agent
→ AI as persistent, contextual, personal intelligence
```

**Brand philosophy:**
1. One AI — the user has one NAgex, not a set of agents to pick from.
2. Agent is infrastructure, not interface (already canonical — see 14.9 §5).
3. Human-controlled autonomy — "Autonomy without losing control": NAgex acts, but consequential external actions are approved, visible, and where possible reversible.
4. Personal context — NAgex remembers preferences, people, projects, facts, and working patterns and applies them to future work.
5. Continuity — the same Personal AI follows the user across Web, Desktop, and Mobile.

**Positioning — what NAgex is not:** AI Agent Builder, Agent Marketplace, Workflow Automation Platform, Chatbot, LLM Wrapper, Model Aggregator. These capabilities may exist internally or under Advanced, but none of them is the brand center.

**Brand personality:** calm, intelligent, confident, personal, trustworthy, forward-looking, minimal. Avoid: cyberpunk, overly futuristic, robotic, developer-only, dashboard-heavy, agent-marketplace-like.

**Voice:** short, plain, outcome-first; never makes the user learn NAgex's internal architecture to use it.

```text
Good:   "NAgex is checking tomorrow's schedule."
Good:   "This needs your attention."
Avoid:  "3 agents are currently executing 7 tool calls."
Avoid:  "Select the optimal LLM provider."
```

**Naming rule going forward:** new features are not automatically suffixed "Agent" in user-facing copy. Use the plain capability name (Browser, Calendar, Email, Connections, Tasks, Memory, Vault); "Agent" naming stays in internal architecture and developer docs only (consistent with the 14.9 §5 navigation taxonomy already in place).

**Brand decision checklist** for new brand copy or UI text:
1. Does it read as one Personal AI, not a specific Agent product?
2. Is it free of dependence on one specific LLM/provider?
3. Does it avoid requiring the user to understand internal system architecture?
4. Does it avoid overstated AGI/autonomy claims?
5. Is "Next Age" tied to a real product-philosophy point, not used as decoration?
6. Would the phrase still make sense in 3–5 years?

**Canonical copy:**

| Slot | Copy |
|---|---|
| Primary | NAgex — Personal AI for the Next Age |
| Brand promise | Intelligence for the Next Age. |
| Product description | NAgex is a Personal AI that understands, remembers, organizes, plans, acts, and continues work across time with human-controlled autonomy. |
| UX principle | Tell NAgex what you need. It handles the complexity internally. |
| Architecture principle | Agent is infrastructure, not interface. |
| Korean | NAgex · 다음 시대를 위한 Personal AI · 다음 시대를 위한 지능 |

### 14.12 Agentless Command UI — Home / Navigation Redefinition

Adopted 2026-09-08 from the NAgex Agentless Command UI Home / Navigation Redefinition directive. This is the canonical navigation specification going forward, superseding the specific sidebar contents (though not the general Consumer/Advanced split) described earlier in 14.9 §5.

**Canonical default consumer navigation (exactly five items, flat, no section labels):**

```text
Home
Inbox
Activity
Vault
Settings
```

`Capture`, `Tasks`, `Memory`, `Knowledge`, `Automations`, `Connections`, `Approvals`, `Agents`, `Skills`, `Tools`, `Executions`, `Developer` are never top-level sidebar items in default consumer mode. None of this is deleted — every one of these remains a real, reachable system: as an input behavior (Capture), a contextual card (Approvals via "Needs your attention"/Inbox), or a page reachable from Settings → (Memory / Automations / Connections) or Settings → Advanced → (Knowledge / Approvals / Skills / Tools). Backend routes, services, stores, and tests are never removed just because a menu item disappears.

**Settings information architecture:**

```text
Settings
├─ Model Gateway (existing)
├─ Quick Wake (existing)
├─ Autonomy (existing)
├─ Connections
├─ Memory
├─ Automations
└─ Advanced (collapsed by default)
   ├─ Knowledge
   ├─ Approvals
   ├─ Skills
   └─ Tools
```

**Consumer mental model this enforces:** "I tell NAgex what I need," never "I need to know which NAgex module to open." Consumer-facing copy must never ask the user to choose an Agent, Tool, MCP, or Model by name.

**Known pre-existing gap surfaced while implementing this** (not introduced by this change, not fixed by it — out of scope for a navigation-only pass): `view-approvals`'s markup is still the original static mockup from the early UI-cloning pass (hardcoded names/events, a `renderApprovals()` target container that doesn't exist in that markup, so it never actually renders `state.approvals`). The real, live approvals surface remains Home's "Needs your attention" section and the Inbox, both of which are genuinely data-driven; only the secondary, Advanced-only Approvals page itself is stale and still needs a truthfulness pass.

### 14.13 Nebius x NVIDIA Global AI Hackathon — 7-Week Execution Roadmap

Adopted 2026-09-08 from the NAgex Nebius/NVIDIA Hackathon 7-Week Execution Roadmap directive. This is the near-term calendar-bound execution plan for Section 4's Hackathon Objective — it refines Section 9's Phase H1–H5 with actual dates and takes priority over Section 14's longer-term extended-vision items whenever the two compete for effort between now and submission.

**Deadlines:**

```text
Official submission deadline : 2026-10-30 10:00 PDT (2026-10-31 02:00 KST)
Recommended internal target   : 2026-10-29 KST
Recommended feature freeze    : 2026-10-25
Recommended code/demo freeze  : 2026-10-27
```

**Required-green hackathon checklist:** run on Nebius Token Factory/AI Cloud; use at least one NVIDIA open-source model; a working hosted demo/test-build URL; a public source repo with an open-source license; clear README setup/run instructions; an explicit explanation of where Nebius/NVIDIA are actually used; a public YouTube demo under 3 minutes matching the shipped product; and, since NAgex predates this submission period, a clear disclosure of what changed during it. Nebius/NVIDIA integration must not be left to the final week.

**Product thesis:** NAgex is not "another Agent framework / MCP client / AI dashboard / multi-model chat interface." It is a Personal AI that understands intent and internally selects the model, agent, MCP, tool, and connection needed — none of which the user ever picks. Canonical principle: **"Model, Agent, MCP, and Tool are infrastructure. Intent is the interface."**

**Demo thesis (canonical loop):** input → NAgex understands it → memory/context applied → capability auto-selected (Agent/MCP/Tool invisible) → connection/approval requested only when required → real action executes → result stored → Activity/Memory/Vault update → NAgex can continue or notify later. Recommended concrete scenario: drop a PDF or paste a URL → NAgex summarizes and detects a date/action item → proposes a Task or Calendar candidate → user approves → a real Google Calendar/Gmail action executes → result recorded → optionally a Conditional Watch continues the work.

**7-week plan:**

| Week | Dates | Focus | Checkpoint |
|---|---|---|---|
| 1 | Sep 8–13 | Product/UX/architecture lock: finalize Agentless Command UI (done — Section 14.12) and the Capability Broker / Invisible MCP architecture concept; keep the sequence Unified Capture → Real Understanding → Candidate → Review → Action; STEP 1 Unified Capture accepted (done); no new major feature categories | 2026-09-13 |
| 2 | Sep 14–20 | Real (not simulated) text understanding via the existing Model Router → structured output (title/summary/contentType/topics/entities/dates/actionItems/taskCandidates/calendarCandidates/memoryCandidates/knowledgeCandidates); Candidate model states PROPOSED/ACCEPTED/REJECTED/EXPIRED; no candidate may auto-mutate Task/Calendar/Memory; Review UX foundation; retry/idempotency | 2026-09-20 |
| 3 | Sep 21–27 | URL understanding (reuse Browser Agent, safe URL validation, semantic extraction, grounded source metadata, CAPTCHA/login → NEEDS_HUMAN, no bypass) and PDF understanding (real fixtures, extraction, chunking, synthesis, source chunk refs, zero-text PDF → OCR-needed/unsupported state, never fake understanding); real Accept/Modify/Reject review flow in Inbox | 2026-09-27 |
| 4 | Sep 28–Oct 4 | Real action loop: candidate acceptance → real Task creation; Calendar candidate → Safe Plan + Approval → real Google Calendar action; Memory candidate → explicit accepted persistence; Knowledge candidate → honest persistence/indexing; Activity/Home propagation; failure/retry UX. Capability Broker foundation: canonical capability IDs, provider abstraction, Capability Registry, wrapping the existing Calendar/Gmail/Browser providers while preserving existing approval/replay/audit controls. **Do not start dynamic MCP discovery yet.** | 2026-10-04 |
| 5 | Oct 5–11 | Nebius + NVIDIA proof: confirm a real Nebius runtime call and at least one real NVIDIA open-source model in the actual flow; surface Nebius/NVIDIA evidence (requestId/provider/model/latency/capability/result) in audit/developer views, never consumer UX, and never hidden by failover during the demo; Connection Resolver + `Settings → Connections` + contextual "Connect Google/Notion/…" UX; optionally one static trusted MCP PoC behind the Capability Broker, with no visible MCP install flow | 2026-10-11 |
| 6 | Oct 12–18 | Freeze one primary demo flow (Quick Wake/Home → voice or file input → real understanding → candidate → review → invisible capability resolution → real Calendar/Gmail/Browser action → result → Activity/Memory/Vault → optional watch/notification); polish error/loading/empty states, EN/KR copy, latency, Home hierarchy, Inbox/approval clarity, test-server reliability; start README/architecture-diagram/screenshot/significant-update-disclosure drafts | 2026-10-18 |
| 7 | Oct 19–25 | Submission package + reliability freeze: regression/browser/deployment/OAuth tests, public demo accessibility, judge test account if needed; repo (LICENSE, README, setup, architecture, env template, no secrets, significant-update statement); Devpost draft; <3 min video script (0:00–0:20 thesis, 0:20–0:45 command-first experience, 0:45–2:10 real end-to-end demo, 2:10–2:35 Nebius/NVIDIA evidence, 2:35–2:55 differentiation, 2:55–3:00 close). **Feature freeze 2026-10-25.** | 2026-10-25 |

**Final submission buffer (Oct 26–30, not a development week):** Oct 26 full regression + deployment rehearsal + public URL check; Oct 27 code/demo freeze + record final video; Oct 28 final README/screenshots/Devpost; Oct 29 recommended final submission + verify YouTube/GitHub/test URL/credentials/license; Oct 30 KST emergency buffer only; **Oct 31 02:00 KST hard deadline** — never plan a first-time submission near the hard deadline.

**Priority matrix:**

```text
P0 (must exist):    Command-first Home, Unified Capture, real Text/URL/PDF
                     Understanding, Candidate/Review, real action execution
                     (Calendar/Gmail/Browser), Capability Broker foundation,
                     Nebius runtime, NVIDIA open-source model, public demo,
                     README, license, <3 min video.
P1 (differentiators): Voice/Quick Wake, persistent Memory, Conditional Watch,
                     Notifications, invisible/static-trusted MCP PoC,
                     Connection Resolver, Inbox, Activity, Vault.
P2 (only if time remains, must never delay P0/P1): dynamic MCP discovery,
                     Computer Use, large MCP catalog, marketplace, mobile
                     app, advanced automation builder, multi-agent visual UI.
```

**Scope control rules (in force now through submission):** no new top-level menu for a new capability; no visible Agent/MCP/Tool/Model picker in consumer mode; every new feature must strengthen the primary demo loop; architecture work that can't be demoed by Oct 18 is lower priority; dynamic MCP discovery is optional but the Capability Broker is not; Nebius/NVIDIA real integration must be green by Oct 11; no new feature development after Oct 25.

**Weekly go/no-go check:** does the primary demo still work; is the feature real or simulated; does it improve the Personal AI story; does it require the user to understand internal architecture; can a judge see the value within 30 seconds; does it threaten the Oct 25 freeze. A feature that fails the Personal-AI-story, architecture-exposure, or freeze-threat question is deferred.

**Canonical demo acceptance test** — a judge should be able to: open NAgex; type/speak/paste a URL/drop a PDF; watch NAgex understand it and identify next actions without ever picking an Agent/MCP/Tool/Model; get asked to connect a service only if needed; get asked for approval only if the action is consequential; see a real action execute; see the result land in Activity/Vault/Memory/Task state; and verify Nebius+NVIDIA usage in technical evidence. If this flow is green, the submission is viable.

**Final rule:** September builds the product; early October proves the architecture; mid-October perfects the demo; late October submits — it does not invent new features. The target is the most convincing version of NAgex that proves **"Intent is the interface,"** not the largest NAgex.

## 15. Final Product Position

```text
Chatbot                X
Dashboard SaaS          X
Simple Workflow         X

Personal AI Runtime     ✓
Always-on Gateway       ✓
Memory-first            ✓
Tool-using              ✓
Task-running            ✓
Multi-channel           ✓
Browser-capable         ✓
Device-capable          ✓
Human-governed          ✓
```

> **NAgex is a Personal AI Operating System that understands a user's daily life as a continuous conversation, remembers what it needs to, plans, repeats or watches when needed, executes real actions across the browser, services, and devices — and always remains something the user can trust and verify.**
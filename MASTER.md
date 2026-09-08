# NAgex MASTER SPECIFICATION

> **NAgex — Next-generation Agent Experience**

**Document Role:** Level 0 / Single Source of Truth  
**Project Start:** 2026-09-05  
**Project Type:** Independent hackathon project  
**Target Event:** Nebius x NVIDIA Global AI Hackathon

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
**Meaning:** Next-generation Agent Experience

> A personal AI agent that remembers, reasons, uses tools, and acts with human-controlled autonomy.

NAgex must be presented as an independent product.

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

> **A next-generation personal AI agent experience that combines persistent memory, reasoning, reusable skills, controlled tools, human approval, and real task execution.**

This definition supersedes inherited product descriptions from the bootstrap codebase.

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
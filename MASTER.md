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
| Multi-channel | Web-only | Telegram, Slack, WhatsApp, Mobile |
| Calendar | Live (create/update/cancel/RSVP, all approval-gated) | Confirmation UX in the ambient composer for update/cancel/RSVP (create_event's compose form + approval card already ships this) |
| Gmail | Live (send/reply/create_draft, all approval-gated; search/read_thread read-only) | Approval-card UI wired into the ambient composer (pure view-model exists — see public/gmail-approval-view.js — but no natural-language compose flow yet) |
| Browser | Not implemented | Agent-controlled browser |
| Computer Use | Not implemented | Paired-node based |
| Local Files | Limited | Read/write/edit/search |
| Shell | Not implemented | Sandboxed exec |
| Automation | Not implemented / initial | Scheduled + conditional + webhook |
| Tasks Center | Not implemented | One-time/recurring/conditional/background |
| Background Agent | Not implemented | Durable background execution |
| Multi-agent | Not implemented | Sub-agent / isolated workspace |
| Plugins | Not implemented | Runtime plugin SDK |
| Mobile | Concept only | Android-first node |
| Voice | UI-only | Real STT/TTS / wake flow |
| Governance | Foundational | Advanced |
| Audit | Basic | Unified task/execution audit |

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
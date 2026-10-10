# NAgex Hackathon Demo Storyboard

Status: DRAFT
Target length: 2:20-2:45
Primary track: Personal AI

## Recommended Scenario

BEST: "Prepare for my Example Corp planning meeting and draft the follow-up."

Why this scenario:

- visibly uses personal context and memory;
- routes PLAN and MEETING_PREP through Nebius/Nemotron;
- produces a concrete action proposal;
- includes a human approval boundary;
- can finish within three minutes;
- avoids uncontrolled public browsing;
- can use synthetic Example Corp data and demo seed records.

BACKUP: "Organize a fictional project into a three-step plan and create a safe reminder/task."

Why backup:

- simple, reliable, and low risk;
- PLAN uses Nemotron;
- approval boundary can be shown through a task/action proposal;
- less impressive than meeting prep because memory/context is lighter.

SAFE FALLBACK: "Review today's synthetic brief, identify one action, and approve only the safe local task."

Why fallback:

- avoids third-party dependencies;
- demonstrates memory/context, activity, and approval;
- may not show as much live Nemotron usage unless a PLAN request is inserted.

## Storyboard

| Time | Segment | Visuals | Narration |
|---:|---|---|---|
| 0:00-0:15 | Problem | NAgex home, calm personal workspace | "Most assistants can answer. They usually do not remember enough context, coordinate work, and safely take action." |
| 0:15-0:35 | NAgex Personal AI | Memory/context, activity, approval indicators | "NAgex combines memory, personal context, reasoning, human approval, and real action." |
| 0:35-1:15 | Live demo task | Enter: "Prepare me for my Example Corp Q4 planning meeting and draft a follow-up." | "This is one realistic professional task. NAgex uses saved context and recognizes planning and meeting-prep intent." |
| 1:15-1:45 | Nemotron result | Plan preview / meeting prep result with provider metadata | "The high-reasoning steps route through Nebius Token Factory to NVIDIA Nemotron 3.5 Lightning. We show metadata, not hidden chain-of-thought." |
| 1:45-2:15 | Human approval | Approval card with exact action payload | "The model does not get execution authority. NAgex asks for permission before any consequential action." |
| 2:15-2:35 | Result / Activity / Memory | Activity entry and context continuity | "After approval, NAgex records the result and keeps the useful context available for the next session." |
| 2:35-2:50 | Architecture close | Simple architecture slide | "Nebius Token Factory plus NVIDIA Nemotron provides reasoning; NAgex provides memory, trust, approval, and action." |

## Required On-Screen Proof

- Product name: NAgex.
- Demo URL: https://nagex-test.agex.site
- Provider: Nebius Token Factory.
- Model: nvidia/Nemotron-3_5-Lightning.
- Runtime tasks: PLAN, MEETING_PREP; optionally RESEARCH_SYNTHESIS if time allows.
- Human approval boundary.
- No raw chain-of-thought.
- No real user data.
- No real third-party send unless the action has already been safely approved and is part of the authorized demo.

## Recording Notes

- Keep the video under 3 minutes.
- Prefer one coherent scenario over multiple mini demos.
- Do not show secrets, server terminals with env vars, or raw provider payloads.
- Use synthetic Example Corp data.
- If a third-party dependency is slow, cut to the already-loaded Activity/Result screen rather than waiting live.

VIDEO_PLAN=PASS

## Frozen Demo Flow

Primary scenario: "Prepare for my Example Corp planning meeting and draft the follow-up."

The demo must stay one continuous story:

1. User request.
2. Personal context / memory.
3. PLAN routed to Nemotron.
4. Meeting-prep reasoning.
5. Proposed follow-up action.
6. Human approval.
7. Execution or safe simulated execution.
8. Activity / audit / result.
9. Memory/context continuity.

Do not add unrelated mini-features.

## Final Video Script

Target length: 2:20-2:45. Hard maximum: 3:00.

### 0:00-0:15 — Problem

"Most AI assistants can answer a prompt. But real work needs more than an answer: the assistant has to remember context, prepare the next step, ask before doing anything consequential, and keep a record of what happened."

### 0:15-0:35 — What NAgex Is

"NAgex is a personal AI that remembers your context, reasons about what you need, asks permission when required, and takes real action. The model reasons. NAgex governs and executes."

### 0:35-1:20 — Live Task + Context + Nemotron

"Here I ask NAgex to prepare for my Example Corp planning meeting and draft the follow-up. It pulls the relevant personal context, recognizes this as planning and meeting preparation, and routes the high-reasoning work through Nebius Token Factory."

"NAgex uses NVIDIA Nemotron 3.5 Lightning through Nebius Token Factory for high-reasoning tasks."

"The routed tasks are PLAN, RESEARCH_SYNTHESIS, and MEETING_PREP. This demo uses PLAN and MEETING_PREP. We show the result and metadata, not hidden chain-of-thought."

### 1:20-1:55 — Human Approval + Action

"NAgex turns the reasoning result into a proposed follow-up action. It does not send anything automatically. The approval card shows what NAgex wants to do, and execution only happens after approval."

### 1:55-2:20 — Result + Memory / Activity

"After approval, NAgex records the result in activity and preserves useful context for the next session. This is the difference between a chatbot answer and a personal AI workflow."

### 2:20-2:40 — Nebius / NVIDIA Architecture + Closing

"The architecture is simple: User to NAgex, NAgex to the task-aware model router, then Nebius Token Factory and NVIDIA Nemotron 3.5 Lightning for reasoning. NAgex keeps the trust, approval, execution, audit, and memory layers. That is how NAgex can remember, prepare, ask, and act safely."

# NAgex Devpost Draft

Status: DRAFT

## Project Name

NAgex

## One-Line Description

NAgex is a personal AI that remembers your context, reasons about what you need, asks permission when required, and takes real action.

## Primary Track

Personal AI

## What NAgex Is

NAgex is a Personal AI / Personal Executive Assistant for people who want AI to do more than answer prompts. It combines persistent memory, current personal context, task-aware reasoning, human approval, and real execution surfaces such as calendar, email, browser/device workflows, mobile voice, and messaging.

Core idea:

```text
Remember -> Reason -> Prepare -> Ask Permission -> Act -> Verify -> Remember
```

## Why Personal AI

NAgex fits the Personal AI track because it is built around:

- memory across sessions;
- personal context;
- proactive assistance;
- reusable skills and tools;
- human approval;
- real actions;
- multi-step workflow state;
- private, governed execution.

## Problem

Most AI assistants are useful for answering questions, but they usually do not preserve enough personal context, coordinate multi-step work, or safely cross the boundary from advice into action. For real personal and professional workflows, the assistant needs memory, planning, approval, execution, verification, and auditability.

## What NAgex Does

NAgex turns a user intent into a governed workflow. It can use saved context, prepare a plan, synthesize meeting or research material, propose an action, ask for approval, execute through the appropriate tool route, and record the result.

## Why It Is Different

NAgex treats the model as reasoning infrastructure, not as execution authority. The product boundary is:

```text
The model reasons. NAgex governs and executes.
```

This keeps human control, approval, payload binding, failure handling, audit, and memory outside the model.

## Why Nemotron

NAgex uses NVIDIA Nemotron 3.5 Lightning selectively for high-reasoning tasks instead of calling it for every request. The deployed task-aware router uses Nemotron through Nebius Token Factory for:

- PLAN;
- RESEARCH_SYNTHESIS;
- MEETING_PREP.

CHAT, STRUCTURED_EXTRACTION, and DAILY_BRIEF are not silently forced onto Nemotron.

## How Nebius Is Used

NAgex uses Nebius Token Factory as the runtime provider path for NVIDIA Nemotron 3.5 Lightning. The deployed runtime made real Nebius calls and reported provider/model metadata, latency, token usage, reasoning-token metadata, and truthful fallback behavior.

## How NVIDIA Nemotron Is Used

NVIDIA Nemotron 3.5 Lightning is used for selected high-reasoning personal-AI tasks:

- PLAN
- RESEARCH_SYNTHESIS
- MEETING_PREP

It is not used as blanket routing for every chat or structured extraction request.

## Nebius / NVIDIA Architecture

```text
User
  -> NAgex
  -> Task-Aware Model Router
  -> Nebius Token Factory
  -> NVIDIA Nemotron 3.5 Lightning
  -> Plan / Research / Meeting Prep
  -> Human Approval
  -> Execution
```

The model reasons. NAgex governs and executes.

## Verified Status

| Evidence | Status |
|---|---|
| Nebius Token Factory runtime use | PASS |
| NVIDIA Nemotron 3.5 Lightning runtime use | PASS |
| PLAN routing to Nemotron | PASS |
| RESEARCH_SYNTHESIS routing to Nemotron | PASS |
| MEETING_PREP routing to Nemotron | PASS |
| Raw reasoning exposed | NO |
| Failure fallback | PASS for 429 / 500 / timeout / invalid response |
| Deployed health | PASS |

## Setup

```bash
npm install
npm run build
npm test
```

For Nebius Token Factory runtime use:

```bash
NEBIUS_API_KEY=your_key_here
NAGEX_NEBIUS_MODEL=nvidia/Nemotron-3_5-Lightning
```

Never commit real keys.

## Significant Updates During Submission Period

NAgex was created as an independent project on 2026-09-05. Major eligible-period updates include:

- Personal AI home and ambient assistant UX;
- persistent memory and personal context;
- approval-gated Google Calendar and Gmail actions;
- durable multi-step task runtime;
- proactive assistant and meeting prep;
- mobile/voice companion foundation;
- security hardening for identity, approvals, credentials, channels, and trusted client IP;
- Nebius Token Factory / NVIDIA Nemotron runtime routing.

## What Is Technically Real Versus Planned

Real and verified:

- deployed NAgex web application health;
- Nebius Token Factory / NVIDIA Nemotron runtime calls;
- task-aware routing for PLAN, RESEARCH_SYNTHESIS, and MEETING_PREP;
- persistent memory/context infrastructure;
- human approval and payload-bound execution patterns;
- fallback behavior for provider failures;
- no raw reasoning exposure in certified paths.

Still requiring final submission packaging:

- public YouTube demo video under 3 minutes;
- final Devpost copy and screenshots/video assets.

Planned or not claimed as verified:

- broad JSON/structured-output capability for Nemotron beyond the specific validated PLAN path;
- uncontrolled autonomous external actions without approval;
- physical robotics/hardware operation.

## Demo Video Plan

Target length: 2:20-2:45.

Recommended demo: "Prepare for my Example Corp planning meeting and draft the follow-up."

The demo shows memory/context, Nemotron-routed planning and meeting prep, a proposed action, human approval, and result/activity continuity.

## Required Feedback Summary

Nebius Token Factory worked well as an OpenAI-compatible runtime path for NVIDIA Nemotron. The main implementation considerations were structured-output validation, reasoning-token budgeting, latency, and strict secret/log hygiene.

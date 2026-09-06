# NAGEX

### Next-generation Agent Experience

NAGEX is a Personal AI and agentic system designed to **remember, reason, use tools, and execute real-world tasks with human-controlled autonomy**.

> Project started: September 5, 2026  
> Target: Nebius x NVIDIA Global AI Hackathon

## What NAGEX Is

Most AI assistants respond to prompts.

NAGEX is being built to maintain context, form plans, select reusable skills and tools, request human approval when needed, execute tasks, observe results, and preserve useful memory.

```text
User
 ↓
NAGEX Personal Agent
 ↓
Memory + Context
 ↓
Planning / Reasoning
 ↓
Skills + Tools
 ↓
Human Approval
 ↓
Execution
 ↓
Audit + Memory
```

## Core Capabilities

- Persistent Personal Memory
- Agent Planning
- Reusable Skills
- Tool Execution
- Human Approval
- Model Gateway
- Intelligent Model Routing
- Auditable Agent Execution
- Security and Permission Control

## NVIDIA + Nebius

NAGEX is being developed for the Nebius x NVIDIA Global AI Hackathon.

The target AI stack includes:

- NVIDIA Nemotron
- Nebius Token Factory
- Nebius AI Cloud

Integration status must always be represented truthfully in this repository. Features that are not yet connected to a live runtime are considered planned or prototype functionality.

## Architecture

```text
NAGEX UI
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
   └── Additional Model Providers
   │
   ▼
Nebius
   │
   ▼
Execution / Audit / Memory
```

## Current Technical Foundation

The current codebase uses TypeScript and includes an inherited modular runtime foundation containing components such as:

```text
src/
  agent/
  context/
  model-gateway/
  runtime/
  workflow/
  identity/
  governance/
  plugin/
  billing/
```

These modules are being evaluated and refactored for the NAGEX product definition.

## Project Origin

NAGEX was created as an independent project on **2026-09-05**.

The initial technical baseline was bootstrapped from an earlier internal experimental AI platform codebase owned by the same entrant.

NAGEX itself has a separate repository, Git history, brand, product definition, and independent hackathon development.

The prior codebase was not a commercially released NAGEX product.

## Development

```text
npm install
npm run build
npm test
```

See:

- `MASTER.md` — product and architecture source of truth
- `AGENTS.md` — AI coding agent rules
- `CLAUDE.md` — Claude Code instructions

## Development Status

NAGEX is under active development.

The repository may currently contain a mixture of implemented foundation code, components being refactored, prototype UI, and hackathon-specific work in progress.

Do not assume every capability described in the roadmap is already operational.

## License

MIT
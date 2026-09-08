# NAgex

### Personal AI for the Next Age

NAgex is a Personal AI that **understands, remembers, plans, uses tools, and acts with human-controlled autonomy**.

> Project started: September 5, 2026  
> Target: Nebius x NVIDIA Global AI Hackathon

## What NAgex Is

Most AI assistants respond to prompts.

NAgex is being built to maintain context, form plans, select reusable skills and tools, request human approval when needed, execute tasks, observe results, and preserve useful memory.

```text
User
 ↓
NAgex Personal Agent
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

NAgex is being developed for the Nebius x NVIDIA Global AI Hackathon.

The target AI stack includes:

- NVIDIA Nemotron
- Nebius Token Factory
- Nebius AI Cloud

Integration status must always be represented truthfully in this repository. Features that are not yet connected to a live runtime are considered planned or prototype functionality.

### Live model gateway

The NAgex server now has implemented provider adapters for OpenAI, Gemini, and Nebius Token Factory. The active route and all model IDs are configured with environment variables; no model ID or credential is sent to the browser beyond the selected provider/model metadata. In `auto` mode the router prefers the Nebius route so the configured NVIDIA model remains in the real hackathon execution path, with fallback to other configured providers after normalized timeout/provider failures.

The gateway is provider-extensible: core runtime and planning depend only on `ModelProvider`, while registered adapter order is configuration-driven. A future LLM integration does not require changes to runtime, memory, planning, skills, tools, approval, execution, response schemas, or router selection logic.

The Home prompt now performs this real flow:

```text
User intent → relevant memory → model router → structured plan → Plan Preview
```

This phase deliberately stops before Skill/Tool execution. A generated plan may identify tools and approval requirements, but it does not perform consequential actions.

## Architecture

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

These modules are being evaluated and refactored for the NAgex product definition.

## Project Origin

NAgex was created as an independent project on **2026-09-05**.

The initial technical baseline was bootstrapped from an earlier internal experimental AI platform codebase owned by the same entrant.

NAgex itself has a separate repository, Git history, brand, product definition, and independent hackathon development.

The prior codebase was not a commercially released NAgex product.

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

NAgex is under active development.

The repository may currently contain a mixture of implemented foundation code, components being refactored, prototype UI, and hackathon-specific work in progress.

Do not assume every capability described in the roadmap is already operational.

## License

MIT

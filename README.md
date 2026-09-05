# AGEX AI OS

AGEX is a modular-monolith **AI Operating System core** — a governed runtime for building, executing, and auditing AI agents and workflows across multiple tenants. It pairs a TypeScript core engine (Runtime, Model Gateway, IAM, Workflow, Knowledge/Memory, Billing, Governance) with a lightweight web console.

## Quick Start

Requires Node.js 24+ (uses native TypeScript execution — no build step needed to run scripts directly).

```bash
npm install
npm run build   # compile src/ + tests/ to dist/
npm test        # build, then run the contract test suite
npm start       # boot the console + REST API at http://localhost:8085
PORT=3000 npm start   # or on a different port
```

Open `http://localhost:8085` (or your configured `PORT`) for the console (workspace, agents, knowledge base, plugins, data sources, projects, billing, IAM, skills, AI support, settings — with Korean/English switching), or hit `http://localhost:8085/api/v1/health` for the API. The console's Version Control view reads this repo's real git status via `GET /api/v1/vcs/status` (read-only — branch, working-tree changes, recent commits; never commits or pushes).

## Project Layout

```
src/
  agent/            Agent executor, tool invoker, multi-agent delegation
  billing/          Usage ledger, idempotent charge/adjustment entries
  common/           Shared types, error envelope, resource ID generation
  context/          Knowledge Engine (ACL-filtered retrieval, grounded-citation check), Memory Engine (lifecycle)
  governance/       Audit logging with secret redaction
  identity/         Policy Decision Point (PDP) — tenant/permission authorization
  model-gateway/    Model Router (capability → classification → region → trust → cost)
  plugin/           Plugin manifest + egress sandboxing
  runtime/          Durable execution engine, task dispatcher, crash reconciler
  tenant/           Tenant resource model + validation
  workflow/         Durable workflow graph execution
  server.ts         Tenant-scoped Platform API (library-style)
  server_web.ts     The actual running server — static console + REST API
  index.ts          Library barrel export (used when AGEX Core is imported as a package)
public/             Web console (vanilla HTML/CSS/JS, no build step, i18n via public/i18n.js)
tests/              node:test contract tests (mirrors src/ by phase)
specs/              JSON Schemas and permission definitions (canonical contracts)
docs/, MASTER.md    Governing specifications — see AGENTS.md before making architectural changes
```

## Core Principles

AGEX's 20 design principles live in `MASTER.md`; a few that shape the code you'll see throughout:

- **Every Resource has an explicit Scope** — `PLATFORM` or `TENANT`.
- **Cross-tenant access is default-deny.** Tenant context is required for tenant-scoped operations.
- **Autonomy is bounded.** Agents run at levels `L0`–`L5`; `L2` and above require explicit approval before `IRREVERSIBLE_WRITE` or `PRIVILEGED_ACTION` tool calls.
- **Retries and workflow traversal are bounded** — no unbounded loops or infinite retry storms.
- **Secrets never reach prompts, logs, or audit records** — the audit logger recursively strips them.

## Console Plans

The console models two account tiers: **AGEX Core** (free — daily-reset credit balance, ads, Core Model only) and **AGEX Prime** (paid — unlimited Prime Agent access). Plan state isn't wired to real billing yet; it's mocked via `localStorage` until Phase 10 (Billing & Entitlement) lands.

## Contributing / AI Agent Instructions

If you're an AI coding agent (Claude, Codex, etc.) working in this repo, **read `AGENTS.md` first** — it defines the required spec-reading order (`AGENTS.md` → `MASTER.md` → `docs/INDEX.md` → domain spec → schema → code) and the 7-step process for any change.

## License

MIT

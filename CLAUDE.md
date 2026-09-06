# NAGEX Claude Code Instructions

Before implementation, read:

@MASTER.md
@AGENTS.md

NAGEX means **Next-generation Agent Experience**.

NAGEX is an independent Personal AI / Agentic AI project created on 2026-09-05 for the Nebius x NVIDIA Global AI Hackathon.

## Mandatory Rules

1. Treat `MASTER.md` as the product-level source of truth.
2. Do not assume inherited bootstrap code defines the final NAGEX architecture.
3. Do not perform blind repository-wide product-name replacements.
4. Public contract changes must update code, schema, tests, and documentation together.
5. Preserve tenant and security boundaries.
6. Consequential external actions must support human approval.
7. Never commit secrets.
8. Keep provider-specific logic behind the Model Gateway.
9. Clearly distinguish live integration, mock behavior, and planned functionality.
10. NVIDIA/Nebius usage claimed in the product must exist in the real runtime path.

## Product Focus

Prioritize persistent memory, agent planning, NVIDIA Nemotron reasoning, Nebius integration, skills, tools, human approval, real execution, model routing, and auditability.

Avoid broad unrelated platform expansion.

## Completion

Before completion run:

```text
npm run build
npm test
git status
```

Do not declare success while tests fail or documentation misrepresents implementation.
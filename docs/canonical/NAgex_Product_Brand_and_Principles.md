# NAgex Product, Brand & Principles

**Canonical Domain:** Product / Brand / Experience
**Status:** CANONICAL — consolidated draft for repository adoption
**Date:** 2026-09-29
**Authority:** subordinate only to `MASTER.md` Level-0 constitution and current explicit user direction.

## 1. Product Definition

NAgex is a **Personal AI / Personal AI Execution Operating System**.

NAgex is not defined as a generic chatbot, LLM wrapper, visible agent marketplace, workflow builder, or model picker. The user experiences **one NAgex**. Models, agents, skills, tools, MCPs, providers, planners, routers, and execution engines are internal infrastructure.

Canonical product statement:

> **NAgex is a Personal AI that understands, remembers, organizes, plans, creates, acts, and continues work across time with human-controlled autonomy.**

Architecture statement:

> **The model reasons. NAgex governs and executes.**

Interaction statement:

> **Intent is the interface. Agent is infrastructure, not interface.**

## 2. Primary Users

Current product focus:

- individual users;
- prosumers;
- professionals;
- creators;
- knowledge workers;
- one-person businesses.

Enterprise-grade governance may be implemented as an architectural quality, but NAgex must not expand the current product into a generic enterprise AI platform unless the roadmap is explicitly reopened for that purpose.

## 3. Product Promise

**Consumer positioning:** `NAgex — Personal AI for the Next Age`
**Brand promise:** `Intelligence for the Next Age.`

“Next Age” describes the transition from passive AI tools to persistent, contextual, personal intelligence. It must not be used as an unsupported AGI claim or as decorative futuristic language.

## 4. Core User Value

NAgex should help a user:

1. **Understand** — questions, documents, URLs, images, audio, structured data, and context.
2. **Capture** — accept raw input without forcing manual classification first.
3. **Remember** — retain useful preferences, facts, people, projects, decisions, and working context under user control.
4. **Organize** — connect captured information into useful personal structure.
5. **Plan & Decide** — turn goals into understandable next steps and decision candidates.
6. **Create** — produce real reports/documents, images, presentations, and later video through governed creation runtimes.
7. **Act** — execute real actions through connected services, browser/device capabilities, and tools.
8. **Watch & Wait** — continue recurring, waiting, conditional, and background work across time.
9. **Notify & Surface** — bring back meaningful results and required attention without unnecessary noise.
10. **Review & Control** — keep consequential actions visible, approval-gated where required, auditable, and replay-safe.
11. **Continue** — preserve context and task state across sessions, restarts, channels, and devices where supported.

## 5. Product Experience Priority

When product goals compete, evaluate in this order:

1. User efficacy.
2. Global user experience.
3. Emotional trust and expectation.
4. Result satisfaction.
5. Personal AI differentiation.
6. Safety / human control.
7. Technical implementation convenience.

Technical elegance does not justify a worse user experience, but user convenience never authorizes weakening privacy, permission, approval, or truthfulness.

## 6. Core Experience Principles

### 6.1 One NAgex

The user should not need to choose an internal agent, tool, model, MCP, or provider to accomplish normal work.

### 6.2 One primary intent surface

Text, voice, files, URLs, PDFs, images, screenshots, and other supported inputs should enter through a unified interaction model. NAgex classifies and routes internally.

### 6.3 Capture first, classify internally

Raw input can be accepted before the user chooses a destination or category. AI may propose Task, Calendar, Memory, Knowledge, Creation, or other candidates. The user retains authority over consequential mutations.

### 6.4 Progressive disclosure

Normal users see human outcomes and understandable status. Technical execution details, provider state, audit IDs, routing decisions, and developer diagnostics remain available in appropriate advanced surfaces without dominating the consumer experience.

### 6.5 One clear next action

When NAgex needs input, connection, approval, correction, or clarification, the user should be able to understand the next action immediately.

### 6.6 Truthful state

Planned, mock, partial, pending, failed, blocked, and completed states must never be presented interchangeably.

`FAKE_SUCCESS_PATHS = 0`

## 7. Human-Controlled Autonomy

NAgex may proactively analyze, recommend, prepare, and continue work within policy, but consequential external actions must remain governed.

The product must preserve:

- explicit permission evaluation;
- human approval where required;
- exact approved payload/target binding where applicable;
- reapproval when material execution conditions drift;
- auditability;
- replay protection;
- reject-without-mutation semantics;
- user control over memory and persistent tasks.

Voice, automation, background work, memory, or model confidence must never bypass approval requirements.

## 8. Goal-Oriented Operation

NAgex should not stop at producing an answer when the user's intent is a durable real-world goal.

Conceptual loop:

```text
Intent
→ Context / Memory
→ Goal
→ Plan
→ Decide
→ Create / Execute
→ Observe
→ Adapt / Re-plan
→ Present Result
→ Audit
→ Memory / Continuation
```

A goal that requires continuation should survive the immediate chat turn and, where implemented, process restart.

## 9. Creation Is a First-Class Product Capability

NAgex must not look or behave like only a planner or task manager.

The Personal AI should be able to create artifacts such as:

- reports and documents;
- images;
- presentations/slides;
- later, video and additional media.

NAgex owns the intent, context, planning, governance, canonical artifact identity, history, revisions, and cross-artifact workflow. Specialized generation engines may remain replaceable providers.

## 10. Brand & Voice

Brand personality:

- calm;
- intelligent;
- confident;
- personal;
- trustworthy;
- forward-looking;
- minimal.

Avoid:

- cyberpunk/futuristic decoration for its own sake;
- robotic system language;
- developer-only terminology in consumer flows;
- dashboard-heavy presentation;
- visible agent-marketplace mental models;
- exaggerated autonomy or AGI claims.

Prefer outcome-first copy such as:

- “NAgex is preparing your report.”
- “This needs your attention.”
- “NAgex found a date and an action item.”

Avoid routine consumer copy such as:

- “Select the optimal LLM provider.”
- “3 agents are executing 7 tool calls.”

## 11. Product Boundary Rules

A new feature should enter the roadmap only if it materially helps NAgex:

**understand, capture, remember, organize, plan, decide, create, execute, adapt, present, or continue** a user's real-world goal.

A new internal capability does not automatically create a new top-level navigation item.

A new provider does not redefine the product.

A new agent does not become a new consumer-facing product surface by default.

## 12. Non-Negotiable Product Invariants

```text
ONE_NAGEX_USER_EXPERIENCE = 1
INTENT_IS_INTERFACE = 1
AGENT_IS_INFRASTRUCTURE = 1
HUMAN_AUTHORITY_PRECEDENCE = 1
FAKE_SUCCESS_PATHS = 0
TECHNICAL_UI_LEAK = 0
RAW_I18N_KEY_LEAK = 0
CROSS_SESSION_LEAK = 0
CROSS_TENANT_LEAK = 0
APPROVAL_BYPASS = 0
```

## 13. Source Provenance

Consolidated from:

- `NAgex_Canonical_Product_Vision_Personal_AI_Execution_OS.md`
- `PRODUCT.md`
- `PERSONAL-AI.md`
- `NAgex_Brand_Definition_Next_Age_20260908.md`
- `NAGEX_PRODUCT_EXPERIENCE_FIRST_PRINCIPLE.md`
- relevant durable product/UX principles adopted into `MASTER.md`

Pricing is intentionally not embedded here as a permanent product principle. The current pricing policy should remain a separately versioned business policy because pricing is more volatile than product identity.

# NAgex Product Vision — Personal AI Execution OS
## Canonical Product Principle / Antigravity Handoff

### 1. Core Definition

NAgex is not merely a chatbot, a task bot, or a collection of isolated agents.

**NAgex is a Personal AI Execution Operating System that understands a user's intent, continuously plans across real-world services, requests human approval when necessary, executes actions on the user's behalf, and adapts the plan as circumstances change.**

Korean canonical definition:

> **NAgex는 사용자의 의도를 이해하고, 현실 세계의 여러 서비스와 실제로 연결하여 계획·승인·실행·변경 대응까지 수행하는 개인 AI 실행 운영체제다.**

---

### 2. Product Experience

A user may provide intent through:

- memo
- voice
- chat
- KakaoTalk or other messaging channels
- email
- quick capture
- mobile/desktop UI

NAgex must turn the input into a living goal, not just a one-time answer.

Example:

```text
User Intent
"Next Wednesday I have a business trip to Busan. I need to arrive before my 10 AM meeting."
```

NAgex should be able to:

```text
Understand intent
→ inspect calendar/context/preferences
→ create Goal: Busan Business Trip
→ build itinerary
→ schedule calendar
→ search transportation
→ request approval if needed
→ book KTX / flight
→ find and book accommodation
→ arrange restaurant/local transport
→ handle payment under policy
→ update schedule
→ monitor delays/changes
→ re-plan when conditions change
→ notify user
→ preserve execution history
```

---

### 3. Goal-Oriented Model

NAgex should ultimately operate around persistent Goals.

Example:

```text
Goal: Busan Business Trip

Constraints
- meeting: 10:00
- departure: Seoul
- preferred seat: window
- hotel budget: <= KRW 180,000
- minimize local travel

Tasks
├─ calendar scheduling
├─ KTX reservation
├─ hotel reservation
├─ restaurant reservation
├─ local transportation
└─ expense handling

Execution State
├─ KTX: RESERVED
├─ Hotel: WAITING_APPROVAL
├─ Dinner: PENDING
└─ Return trip: PLANNED
```

The Goal must survive process restarts and remain the long-lived source of user-facing progress.

---

### 4. Core Capability Layers

#### Understand
- Intent
- Context
- Memory
- Preferences
- Constraints

#### Plan
- Goal decomposition
- Task planning
- Scheduling
- Resource coordination
- Conflict detection

#### Decide
- Safety
- Policy
- Cost
- Approval
- Spending limits

#### Execute
- Calendar
- Communication
- Browser
- Travel
- Booking
- Commerce
- Payments
- Navigation
- External services

#### Adapt
- Event monitoring
- Delay detection
- Availability changes
- Re-planning
- Cancellation / modification

#### Remember
- Preferences
- Past decisions
- Travel habits
- Spending patterns
- User-approved policies

#### Present
- Daily brief
- Trip brief
- Timeline
- Approval inbox
- Activity history
- Execution status

---

### 5. OpenClaw Benchmark Position

OpenClaw is an important benchmark for the personal-agent experience:

- always-on personal assistant
- familiar messaging channels
- persistent memory
- browser automation
- skills/plugins
- local/user-controlled execution

NAgex should learn from this model but go further.

Canonical distinction:

```text
OpenClaw
= Personal Agent Harness

NAgex
= Personal AI Execution OS
```

NAgex must add stronger:

- Goal orchestration
- Durable multi-step execution
- Human Approval
- Capability governance
- Payment policy
- Booking / Commerce
- Situation monitoring
- Re-planning
- Audit / execution history
- Enterprise-grade security

---

### 6. Human Approval Principle

NAgex must not silently perform consequential actions unless explicitly permitted by policy.

Examples:

```text
Transport under KRW 50,000
→ may auto-execute if user policy allows

Hotel under KRW 200,000
→ recommend + approval

Non-refundable purchase
→ always explicit approval

Overseas payment
→ stronger confirmation

Cancellation / refund
→ governed approval
```

Human Approval First remains a core principle.

---

### 7. Payment / Credential Architecture

NAgex should not directly store raw payment credentials as ordinary application data.

Future architecture should use:

- tokenized payment instruments
- provider vaults
- spending policy
- merchant/category restrictions
- user approval
- audit trail
- refund/cancellation governance

---

### 8. Situation-Aware Replanning

NAgex must not stop after making a plan.

Example:

```text
KTX delayed 30 min
→ recompute arrival
→ detect dinner reservation conflict
→ find alternative time
→ propose change
→ obtain approval if required
→ update booking/calendar
```

The product is therefore proactive and stateful, not just request/response.

---

### 9. Existing NAgex Architecture Alignment

Current architecture already provides foundations for this vision:

```text
Intent
→ Planner
→ Safety
→ Capability Broker
→ Approval
→ Execution
→ Durable Runtime
→ Memory / Knowledge
```

P01/P02/P03 and Architecture Phase 09 are not isolated technical work.
They are the runtime foundations for the long-term Personal AI Execution OS.

---

### 10. Development Governance Rule

All future NAgex development must be evaluated against this product vision.

Before approving a feature or architecture change, ask:

```text
Does this help NAgex:
understand
plan
decide
execute
adapt
remember
or present
a user's real-world goal?
```

If not, it should not automatically enter the roadmap.

Technical phases must remain subordinate to the product vision.

---

### 11. Canonical Product Statement

> **NAgex is a Personal AI Execution OS that turns human intent into persistent goals, plans and executes real-world actions across services, preserves control through policy and approval, and continuously adapts as the user's situation changes.**

This document should be treated as a top-level product principle for Antigravity, Codex, architecture reviews, roadmap planning, and implementation directives.

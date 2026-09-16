# NAGEX Product UX & Intent Interaction Principles

**Document ID:** NAGEX-UX-INTENT-INTERACTION  
**Version:** 1.0  
**Status:** MANDATORY PRODUCT / UX DEVELOPMENT RULE  
**Applies To:** Home, Chat, Plan Preview, Plan Resolution, Approval UI, Mobile UX, Voice UX, Agent Workflows, Task/Automation UX, Result Views, and future multimodal/device surfaces.

---

## 1. Product Identity

NAGEX must never be designed or presented as a narrow calendar, task, or productivity application.

NAGEX is a **general-purpose personalized AI Agent** whose primary role is to understand the user's intent, select the necessary tools/agents, execute work, create artifacts, and safely perform real-world actions.

NAGEX must support heterogeneous goals through one consistent interaction model, including:

- calendar and scheduling
- reservations and bookings
- email and communication
- research
- image generation
- slide/presentation creation
- coding and software development
- document/report creation
- analysis
- automation
- browser/computer actions
- personal assistance
- proactive monitoring
- future plugin/capability execution

> **Users express intent. NAGEX decides how to accomplish it.**

> **사용자는 원하는 결과를 말하고, NAGEX는 필요한 방법을 찾아 실행한다.**

---

## 2. Intent-First, Not Prompt-First

Users must not be expected to learn prompt engineering.

NAGEX must not require a perfect prompt before useful work can begin.

```text
Incomplete user request
→ Intent hypothesis
→ Clarification
→ Structured execution brief
→ Plan
→ Approval when required
→ Execution
→ Result
```

> **The user should not learn how to prompt NAGEX. NAGEX should learn what the user means.**

---

## 3. Clarification Is a Core Capability

When a request is incomplete, ambiguous, underspecified, risky, or likely to produce a materially worse result without additional context, NAGEX should ask questions before execution.

Clarification must not become a rigid questionnaire.

NAGEX should:

- ask what matters
- use what is already known
- infer cautiously
- avoid redundant questions
- explain why a question matters when useful
- stop asking once intent is sufficiently clear

---

## 4. Maximize Information Gain Per Answer

The goal is not simply fewer or more questions.

The higher-level goal is:

> **Each answer should reduce multiple uncertainties.**

Bad:

```text
Who is the audience?
What is the goal?
What is the tone?
What style?
What length?
What CTA?
```

Better:

```text
Who will see this, and what do you want them to think or do after seeing it?
```

One answer may reveal:

- audience
- purpose
- desired outcome
- tone
- depth
- emphasis
- call-to-action

NAGEX must update its understanding after every answer.

---

## 5. Adaptive Intent Resolution

```text
User Request
↓
Known Context / Memory
↓
Intent Hypothesis
↓
Missing Critical Information
↓
Select Highest-Value Question
↓
User Answer
↓
Extract Multiple Intent Fields
↓
Update Confidence / Unknowns
↓
Ask Again Only If Needed
↓
Execution Brief
```

Questions must not be fixed forms unless the domain genuinely requires one.

---

## 6. Intent State Model

NAGEX should distinguish:

```text
CONFIRMED
INFERRED
ASSUMED
UNKNOWN
```

Example:

```text
CONFIRMED
- audience: investors
- presentation duration: 10 minutes

INFERRED
- concise narrative
- credibility emphasis

ASSUMED
- slide ratio: 16:9

UNKNOWN
- latest brand assets
```

Rules:

- CONFIRMED = authoritative user intent
- INFERRED = traceable to user/context evidence
- ASSUMED = never presented as user-confirmed
- UNKNOWN high-impact values = clarification candidates

---

## 7. Ask Before Guessing — But Do Not Ask Unnecessarily

```text
Known
→ do not ask

High-confidence inference + low impact if wrong
→ proceed, optionally disclose assumption

High-confidence inference + high impact if wrong
→ confirm

Missing + critical
→ ask

Missing + optional
→ use sensible default and disclose if relevant

Sensitive / irreversible / external mutation
→ explicit confirmation / approval
```

Do not re-ask facts available from permitted conversation context, memory, tools, files, prior selections, or deterministic environment information.

---

## 8. Universal Interaction Model

The same high-level UX must support multiple domains.

### Slides
Request → Clarify audience/purpose/length → Research/Structure/Design → Generate → Review → Deliver

### Image
Request → Clarify use/format/style → Generate concept → Create → Refine → Deliver

### Coding
Request → Clarify objective/stack/constraints → Inspect → Plan → Modify → Test → Deliver

### Reservation
Request → Clarify occasion/party/location/time → Search → Compare → Check availability → Approve → Book

### Calendar
Request → Clarify objective → Check calendar → Gather context → Suggest time → Approve → Schedule

The shell stays consistent; the internal plan changes by domain.

---

## 9. Progressive Disclosure

NAGEX may be internally complex, but the default UI should remain simple.

```text
Request
→ Working
→ Review / Approval
→ Done
```

Internal states such as Plan Preview, Plan Resolution, Approval Card, Human Approval, Execution, Result, Planner, Critic, Router, and tool calls should not all be exposed at once.

Advanced details belong under:

- View details
- What NAGEX is doing
- Execution details
- Agent activity

Complexity should be available, not imposed.

---

## 10. One Clear Next Action

At every important state, the user should understand:

> **What is NAGEX doing now, and what should I do next?**

Avoid competing CTAs such as:

```text
Review Plan
Run
Resolve
Approval
Execute
```

Prefer:

```text
Edit
Continue
```

For mutations, state the consequence:

```text
Approve and create event
Approve and send email
Approve reservation
```

---

## 11. Plan Acceptance != Action Approval

A user accepting a plan does not authorize a mutation.

```text
PLAN ACCEPTANCE
≠
EXTERNAL ACTION APPROVAL
```

Example:

```text
User agrees to meeting-preparation plan
≠
User approved creating a calendar event
```

All mutations still follow the canonical Policy / Approval / Execution path defined by `docs/NAGEX_DEVELOPMENT_SAFETY_HARNESS.md`.

---

## 12. Avoid Calendar-App Drift

Scheduling is only one capability.

Do not make Calendar / Tasks / Reminders / Meetings the primary product identity.

Preferred home hierarchy:

1. Universal intent input
2. Proactive important information
3. Active work
4. Approvals
5. Recent results
6. Secondary capability navigation

Example:

```text
Good morning

What should I do for you?
[ Ask NAGEX _______________________ 🎙 ]

Important
• 2 messages need attention
• 1 approval waiting

NAGEX is working on
• Company presentation      72%
• Research report           45%
• Website redesign          Testing

Recently completed
• Market analysis
• Product image set
• Meeting summary
```

---

## 13. Capability Diversity Must Be Visible

Onboarding/examples should span multiple domains:

- Create a presentation
- Analyze my documents
- Generate an image
- Research a topic
- Build or fix software
- Book something
- Organize communications
- Plan and schedule a meeting
- Create a report
- Automate a repeated task

Do not over-represent calendar/meeting examples.

---

## 14. Conversation Before Configuration

Prefer natural clarification over forcing forms.

Instead of:

```text
Audience: [ ]
Duration: [ ]
Goal: [ ]
Style: [ ]
CTA: [ ]
```

Prefer:

```text
Who will see this, and what do you want them to do after the presentation?
```

Structured forms are appropriate when precision, inspectability, or immutable approval payloads require them.

---

## 15. Clarification Should Feel Like Assistance

Do not make the user feel interrogated.

Prefer:

> "Four people and a quiet business dinner — I'll prioritize private or well-spaced seating. Tell me the area and approximate time and I can narrow this down."

Instead of:

> "Question 4 of 9: Preferred seating?"

Questions should acknowledge prior answers and demonstrate growing understanding.

---

## 16. Show Current Understanding

Before expensive, long-running, or consequential work, NAGEX should be able to summarize:

```text
Here's what I understand:

Audience: Investors
Goal: Generate interest and secure a follow-up meeting
Duration: 10 minutes
Emphasis: Technology differentiation
Tone: Credible and concise

[Edit] [Continue]
```

This reduces misunderstanding without requiring a perfect prompt.

---

## 17. Clarification Stop Condition

Stop asking when:

- the goal is clear
- all high-impact unknowns are resolved
- remaining unknowns can safely use defaults
- expected quality is acceptable
- safety/approval requirements are satisfied

Do not keep asking merely because more information could theoretically improve output.

---

## 18. Intent Resolution Engine

NAGEX should evolve toward a dedicated intent-resolution capability.

Conceptual model:

```ts
interface ResolvedIntent {
  goal: string;

  confirmed: Record<string, unknown>;
  inferred: Record<string, unknown>;
  assumed: Record<string, unknown>;
  unknown: string[];

  criticalMissingFields: string[];
  nextBestQuestion?: string;

  constraints: string[];
  desiredOutcome?: string;
  outputFormat?: string;

  confidence: number;
  executionReady: boolean;
}
```

The exact implementation must fit the actual architecture.

---

## 19. Execution Brief

After clarification, NAGEX should produce an internal structured brief.

Example:

```text
Goal:
Create a 10-minute investor presentation.

Audience:
Early-stage technology investors.

Desired outcome:
Establish technical credibility and obtain follow-up meetings.

Priorities:
1. Technology differentiation
2. Market opportunity
3. Evidence / traction
4. Clear CTA

Constraints:
- concise
- modern professional design
- 16:9
```

The simplified brief may be shown to the user before execution.

---

## 20. Domain-Neutral Agent Work UI

Do not expose Planner / ToolRouter / CapabilityBroker / ExecutionGraph as the primary UI.

Prefer:

```text
✓ Reviewing your materials
✓ Organizing the structure
● Creating the presentation
○ Final review
```

The system may be complex internally; the UI should remain understandable.

---

## 21. Mobile UX

Mobile is a primary interaction surface, not a reduced desktop view.

Mobile priorities:

- short natural-language requests
- voice input
- clarification
- proactive alerts
- approvals
- quick review
- continuation across devices

Typical flow:

```text
Notification
→ Understand context
→ Clarification if needed
→ Suggested action
→ Approval
→ Result
```

---

## 22. Voice UX

Voice must not require a perfect dictated prompt.

Example:

```text
"다음 주 발표자료 하나 만들어야 하는데 좀 도와줘."
```

NAGEX should clarify conversationally.

Voice clarification should:

- ask one high-value question at a time
- remember answers
- avoid reading long forms
- summarize understanding before consequential execution

---

## 23. Trust and Transparency

The UI should distinguish:

- what the user explicitly said
- what NAGEX inferred
- what NAGEX assumed
- what NAGEX is about to do
- what requires approval

Inference must never be represented as explicit user instruction.

---

## 24. Relationship to Safety Harness

All execution still obeys `docs/NAGEX_DEVELOPMENT_SAFETY_HARNESS.md`.

UX simplification must never hide or bypass:

- approval
- fail-closed behavior
- behavioral regression testing
- ADR requirements
- technical debt visibility

---

## 25. Relationship to Personal Data Architecture

Clarification may use context and memory only under `docs/NAGEX_PERSONAL_DATA_SYNC_ARCHITECTURE.md`.

NAGEX must not improve intent understanding by indiscriminately collecting or syncing personal data.

- use permitted context
- respect sensitivity classification
- never expose S3 secrets
- minimize remote-model disclosure
- preserve provenance
- do not silently expand retention

---

## 26. Anti-Patterns

### A. Calendar-App Drift
NAGEX increasingly looks like a calendar/task manager with AI features.

### B. Prompt Engineering Burden
The user must learn special phrasing to get good results.

### C. Questionnaire UX
Every task triggers a long fixed interview regardless of context.

### D. Silent Guessing
NAGEX invents high-impact requirements instead of asking.

### E. Internal-State UI
Runtime/tool/approval internals dominate the main UI.

### F. CTA Ambiguity
The user cannot tell whether a button reviews, runs, approves, or executes.

### G. Capability Fragmentation
Users must learn separate workflows for slides, images, coding, scheduling, research, etc.

### H. Over-Asking
NAGEX asks for information it already knows or that does not materially improve the result.

---

## 27. UX Acceptance Questions

Every major UX change should be reviewed against:

1. Does this present NAGEX as a general AI Agent rather than a narrow productivity app?
2. Can a first-time user understand what to do?
3. Does the user need prompt-engineering skill?
4. Is NAGEX actively resolving intent?
5. Does each clarification question have high information gain?
6. Are known facts reused rather than re-asked?
7. Are confirmed/inferred/assumed values distinguished?
8. Is the next action obvious?
9. Are internal states progressively disclosed?
10. Is approval shown with a clear consequence?
11. Can the interaction model support slides, images, coding, booking, scheduling, research, and future capabilities?
12. Does mobile remain understandable?
13. Are privacy and safety governing documents still satisfied?

---

## 28. Required Interaction Tests

Future Intent Resolution / Plan UX should test:

- vague request triggers clarification
- complete request does not trigger unnecessary questions
- known context is not re-asked
- one answer fills multiple intent fields
- high-impact uncertainty triggers confirmation
- low-impact uncertainty may use disclosed defaults
- assumptions are never represented as confirmed
- clarification loop terminates
- plan acceptance does not equal mutation approval
- different domains reuse the same interaction model
- calendar examples are not hard-coded as default identity
- mobile preserves one clear next action
- model/prompt changes replay golden intent-resolution scenarios

---

## 29. Product Metrics

Useful metrics include:

- Clarification Success Rate
- Average Clarification Turns
- Intent Correction Rate
- User Rephrase Rate
- Task Success Rate
- Result Acceptance Rate
- User Correction After Execution
- Approval Understanding Rate
- Time to Useful Result
- First-Time User Success Rate

A low number of questions is not inherently good.
A high number of questions is not inherently bad.

The important metric is:

> **How much uncertainty is reduced, and how much result quality improves, per interaction.**

---

## 30. AI Development Agent Obligations

Any AI development agent working on NAGEX UI/UX must preserve this document.

AI coding agents MUST NOT:

- optimize product identity around calendar/task examples
- expose internal runtime states as primary UX without justification
- require advanced prompting
- add fixed questionnaires when adaptive clarification is possible
- silently infer high-impact requirements
- merge plan acceptance with mutation approval

AI coding agents MUST:

- design around user intent
- support cross-domain capability
- use progressive disclosure
- prefer adaptive high-information questions
- preserve confirmed/inferred/assumed distinctions
- keep the next action obvious
- apply Safety Harness and Personal Data Architecture together with this document

---

## 31. Governing Product Rules

> **NAGEX must understand the user before it asks the user to understand NAGEX.**

> **The quality of NAGEX should not depend primarily on how well the user writes a prompt. NAGEX is responsible for discovering the user's intent, resolving important uncertainty, and turning that intent into a safe, executable brief.**

These are core product invariants.

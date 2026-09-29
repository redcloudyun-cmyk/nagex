# NAgex Hackathon Current Plan

**Status:** ACTIVE HACKATHON PLAN DRAFT
**Reconstructed:** 2026-09-29

## 1. Objective

Use the hackathon to prove the real NAgex product rather than building a separate demo product.

```text
Build the product first.
Use the hackathon to prove it.
```

The demo should show that NAgex is more than an answer engine and more than a planner:

> **NAgex understands context, creates what the user needs, requests permission when necessary, and acts.**

## 2. Current Proof Story

Recommended proof arc:

```text
Ask / Voice / File
→ Understand / Research
→ Create a useful artifact
→ Prepare a consequential next action
→ Human approval
→ Real execution
→ Verified result
→ Activity / Memory / continuation
```

This combines Personal AI, Creation and governed execution in one story.

## 3. Must-Prove Product Capabilities

Before final freeze, the submission should have defensible evidence for:

- command-first Personal Home;
- real understanding/research;
- persistent personal context/memory;
- at least one polished creation flow;
- governed real-world action;
- human approval and replay safety;
- truthful activity/result state;
- real Nebius/NVIDIA use where required;
- public test deployment;
- reproducible setup/evidence.

Do not claim a provider integration from architecture-only code.

## 4. Current Creation Priority

As of the reconstructed 2026-09-29 state:

- Document/Report runtime: closed.
- Provider-neutral creation baseline: closed.
- Real Image runtime: partial/current.
- Slides: planned.
- Video: planned.

For hackathon scope, finish and certify a smaller number of real creation flows before exposing a broad grid of nonfunctional capabilities.

## 5. Consumer Experience

Home must show both:

### Personal AI
context, today, attention, preparation, memory, activity, proactive assistance.

### Creation
report, research/analysis and only those additional creation types that are truly executable.

Never use fake tiles to make the product appear broader than it is.

## 6. Nebius / NVIDIA Proof

Technical/judge evidence should make the required integrations visible through reproducible evidence such as provider/model identity, request/correlation ID where available, latency/capability and result provenance.

Consumer UX should remain provider-neutral unless provider information is useful to the user.

## 7. Freeze Discipline

Historical target:

- primary flow/product polish before the final submission window;
- feature freeze: 2026-10-25;
- final regression/deployment/video/package during Oct 26–30;
- hard deadline recorded in the source roadmap: 2026-10-31 02:00 KST.

Do not spend the final window creating new architectural branches.

## 8. Scope Control

Do not let these displace the core proof:

- dynamic MCP discovery/marketplace;
- broad enterprise functionality;
- generic visible agent framework;
- large provider catalog;
- full mobile-native feature parity;
- experimental JEV as a mandatory dependency;
- local GPU productionization.

## 9. Submission Truthfulness

Every public statement should distinguish:

- implemented;
- certified;
- real-provider certified;
- partially implemented;
- prototype;
- planned.

`SKIP`, `PENDING`, `BLOCKED` and `UNAVAILABLE` must never be rewritten as `PASS`.

## 10. Final Demo Quality Bar

The demo should make the following obvious without architecture explanation:

1. NAgex knows useful context.
2. NAgex can produce a meaningful artifact/result.
3. NAgex can prepare a real action.
4. NAgex asks before consequential execution.
5. NAgex actually executes through a real route.
6. NAgex reports the result truthfully.
7. The work remains available in Activity/Memory/history.

## 11. Evidence Pack

Final evidence should include:

- frozen commit SHA;
- build/regression results;
- browser certification;
- security invariant results;
- live provider certification where required;
- deployment health;
- screenshots;
- architecture diagram;
- README/setup;
- significant-update disclosure if required;
- demo video;
- public URL/test instructions.

## 12. Stop Rule

After feature freeze, only defects that threaten:

- correctness;
- security;
- truthfulness;
- demo reliability;
- submission eligibility

should reopen implementation.

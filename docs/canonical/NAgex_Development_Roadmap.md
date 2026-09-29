# NAgex Development Roadmap — Current-State Reconstruction

**Status:** ACTIVE ROADMAP DRAFT
**Reconstructed:** 2026-09-29
**Current local baseline supplied after document snapshot:** `0181e40 feat(r23.7c-p): establish creation provider architecture`

## 1. Roadmap Rule

This roadmap separates:

- `CLOSED` — implementation/certification evidence supports closure.
- `CLOSED_WITH_EXTERNAL_CERT_PENDING` — implementation is closed but a controlled real-provider certification is still outstanding.
- `CURRENT_PARTIAL` — implementation exists in the working tree or has begun, but closure evidence/commit is incomplete.
- `PLANNED` — accepted next work, not yet implemented.
- `SUPERSEDED_AS_SEQUENCE` — useful historical plan, no longer authoritative for current ordering.

A dated roadmap does not override newer implementation evidence.

## 2. Current Product Goal

NAgex is a Personal AI / Personal Executive Assistant / Personal AI OS for individuals, prosumers, professionals, creators, knowledge workers and one-person businesses.

Current product loop:

```text
Understand
→ Remember
→ Create
→ Prepare
→ Approve
→ Act
→ Verify
→ Continue
```

Creation and real-world execution are both first-class. NAgex must not collapse into a planner-only product.

## 3. Verified / Accepted Foundation

The following major foundations are treated as closed based on supplied milestone reports and repository documents:

- R13 Identity & Account Lifecycle — CLOSED
- R14 Organization & Workspace — CLOSED
- R15 RBAC & Permission System — CLOSED
- R16 Enterprise Identity, SSO & Provisioning — CLOSED
- R17 Core Product Wiring — CLOSED
- R18 Personal Workspace Integration — CLOSED
- R22.4 Evidence Pack + Live Web Search — CLOSED
- R22.5 Task-Aware Model Routing — CLOSED
- R23.2D — CLOSED
- R23.3T Permission / Approval Hardening — CLOSED
- R23.4V Credential Broker / inject-only vault — CLOSED
- R23.5B Browser Untrusted Content Boundary — CLOSED

These milestones remain evidence/history; they are not all current product-navigation priorities.

## 4. R23.6M Execution Foundation

Known accepted status:

- SMS execution closure — CLOSED.
- Global Messaging Abstraction D1 — CLOSED.
- Canonical Messaging Runtime D3S — CLOSED / DEPLOYED.
- Gmail D4A canonical contract audit — COMPLETE / ACCEPTED.
- Gmail D4B canonical email integration — IMPLEMENTATION CLOSED.
- Gmail real external certification — PENDING.
- KakaoTalk positive certification — BLOCKED/PENDING according to the dated evidence pack unless newer evidence is supplied.

Do not convert a pending external certification into PASS.

## 5. R23.7H Personal Home

Historical source documents initially marked R23.7H-B as not started, but later supplied implementation/certification evidence supersedes that status.

Current reconstructed status:

```text
R23.7H-A   Product / IA Audit                         CLOSED
R23.7H-B1  Personal Dashboard contract/shell          CLOSED
R23.7H-B1.5 Creation Capability Reality Audit         CLOSED
R23.7H-B2  Agentic Creation Home Integration          CLOSED
R23.7H     Personal Home milestone                    CLOSED
```

R23.7H-B2 truthfulness baseline exposed only capabilities that were actually backed at that point and excluded mock/unbacked creation.

This milestone is now a product foundation, not the next active roadmap item.

## 6. R23.7C Creation Runtime

Current reconstructed state:

```text
R23.7C-A   Creation Runtime Architecture Audit        CLOSED
R23.7C-B   Document / Report Creation Runtime         CLOSED
           commit: 918170b

R23.7C-P   Provider-Neutral Creation Architecture     CLOSED
           local commit: 0181e40

R23.7C-C   Real Image Creation Runtime                CURRENT_PARTIAL
R23.7C-D   Presentation / Slides Runtime              PLANNED
R23.7C-E   Video Runtime                              PLANNED
```

R23.7C-P is independent of C-C and establishes the provider/spec abstraction for IMAGE/PRESENTATION/VIDEO.

Known uncommitted C-C partial work is intentionally preserved and must not be mistaken for a closed milestone.

## 7. Immediate Product Development Sequence

The current implementation sequence should be:

```text
1. Stabilize / complete R23.7C-C Real Image Runtime
2. Integrate truthful image creation/history into the Personal Home/Create experience
3. R23.7C-D Presentation Runtime
4. R23.7C-E Video Runtime
5. Reconcile R23.7G Background Runtime Certification against current code
6. R23.8P Personality / Trust UX
7. R23.9C Final Certification
```

Important: item 5 is a **reconciliation gate**, not an assertion that no background-runtime work has occurred. The current source snapshot still names R23.7G as a pending gate, and no later closure evidence was supplied in the consolidation materials.

## 8. R23.7C-C Exit Criteria

R23.7C-C should not close until all applicable conditions are satisfied:

- real image runtime, not mock SVG;
- provider-neutral `ImageProviderPort` path;
- canonical `ImageCreationSpec`;
- provider result ingested into NAgex-owned artifact identity/storage;
- provider URL is not the artifact;
- failure/pending/unavailable are not success;
- reference/edit authorization where supported;
- cross-tenant/user isolation;
- privacy/sensitivity routing;
- focused deterministic tests;
- build and diff gates;
- real-provider certification when credentials are available;
- desktop/mobile truthful UX certification for the exposed flow.

If credentials are unavailable, report implementation complete but real-provider certification blocked/pending rather than claiming full live closure.

## 9. R23.7C-D Presentation

Presentation should reuse:

- CreationRuntime;
- canonical creation specs;
- CreationProviderRouter;
- ArtifactStore projection;
- document/research outputs as source artifacts.

Avoid building a separate slide product/runtime that bypasses NAgex creation history, permissions or provenance.

## 10. R23.7C-E Video

Video follows the same provider-neutral pattern and must preserve asynchronous/pending semantics.

Provider queue acceptance is not completion.

## 11. Background Runtime Gate

Before relying on background/watch/recovery behavior in final product claims, reconcile the R23.7G certification scope against the actual current runtime.

Required questions include:

- what survives restart;
- what resumes safely;
- scheduler/watch truthfulness;
- notification semantics;
- duplicate/replay prevention;
- provider outage behavior;
- approval validity across delay/restart;
- cross-session isolation.

If newer evidence proves R23.7G closed, update this roadmap from that evidence rather than rerunning work blindly.

## 12. Personality / Trust UX

R23.8P should improve how NAgex feels personal and trustworthy without introducing fake personality or lowering safety.

Priority themes:

- memory-to-value explanation;
- why-this recommendations;
- calm proactive assistance;
- contextual approval;
- confidence/uncertainty communication;
- recovery and correction;
- consistent EN/KR tone;
- visible creation + action capability without technical clutter.

## 13. Final Certification

R23.9C is a release/hackathon certification phase, not a feature bucket.

It should certify the frozen primary experience across:

- build/regression;
- security invariants;
- real browser;
- mobile widths;
- EN/KR;
- creation;
- approval/execution;
- persistence/restart;
- external-provider evidence where required;
- public deployment;
- repository hygiene;
- demo/submission evidence.

## 14. Hackathon Alignment

The historical MASTER roadmap targets a 2026-10-31 02:00 KST hard deadline, with feature freeze 2026-10-25 and a submission buffer beginning Oct 26.

That dated plan remains useful only after current-state reconstruction. Work already completed must not be reimplemented merely because an old weekly schedule says it is pending.

The primary hackathon proof should demonstrate the actual product:

```text
Personal context / input
→ understanding/research
→ creation
→ approval when consequential
→ real execution
→ verified result
→ Activity / Memory / continuation
```

Nebius/NVIDIA integration must be real and evidenced if required by the event; provider branding belongs in technical/judge evidence, not primary consumer UX.

## 15. Explicitly Deferred / Non-Blocking

Unless a new requirement reopens them, these should not delay the current product path:

- dynamic MCP marketplace/discovery;
- broad enterprise expansion;
- generic multi-agent visual UI;
- large automation builder;
- provider/model picker in consumer mode;
- full native mobile parity;
- speculative JEV dependency;
- local GPU/NIM productionization before the core creation path is certified.

Architectural compatibility may be preserved without implementing these now.

## 16. Roadmap Invariants

```text
PRODUCT_FIRST = 1
PLANNER_ONLY_PRODUCT = 0
FAKE_SUCCESS_PATHS = 0
UNSUPPORTED_CAPABILITY_ADVERTISED = 0
PROVIDER_URL_IS_ARTIFACT = 0
VOICE_APPROVAL_BYPASS = 0
DEMO_ONLY_ARCHITECTURE_POLLUTION = 0
```

## 17. Update Rule

This roadmap is updated only from:

1. explicit user direction;
2. accepted canonical architecture;
3. committed implementation and test evidence;
4. accepted milestone closure evidence.

Old handoffs, directives and benchmark documents may explain history but cannot silently reopen or close milestones.

# NAgex Development Roadmap — Current-State Reconstruction

**Status:** ACTIVE ROADMAP DRAFT
**Reconstructed:** 2026-09-29
**Updated:** 2026-09-30 — R23.7H-C opened per canonical decision
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
R23.7H-A    Product / IA Audit                         CLOSED
R23.7H-B1   Personal Dashboard contract/shell          CLOSED
R23.7H-B1.5 Creation Capability Reality Audit         CLOSED
R23.7H-B2   Agentic Creation Home Integration          CLOSED
R23.7H      Personal Home milestone                    CLOSED

R23.7H-C    Home/Create Artifact Integration           OPEN
```

R23.7H-B2 truthfulness baseline exposed only capabilities that were actually backed at that point and excluded mock/unbacked creation.

R23.7H-C is the currently active milestone. See §5a for full specification.

## 5a. R23.7H-C — Home/Create Artifact Integration (OPEN)

**Milestone family:** Personal Home / UX
**Status:** OPEN — 2026-09-30

**Canonical role:** Establishes the shared **Creation Artifact UX Integration Contract**,
making Personal Home artifact-aware for IMAGE now, and extensible for
PRESENTATION and VIDEO without implementing either.

### Contract Scope

The Creation Artifact UX Integration Contract covers:

1. Creation entry/discovery — how users reach Create on all platforms
2. Recent Creation rendering — artifact-aware view model for the Personal Home feed
3. Preview/thumbnail behavior — type-aware rendering; safe canonical delivery
4. Artifact-type-aware Open behavior — single dispatcher; type maps to canonical target
5. Canonical artifact navigation — NAgex-owned artifact URLs only; no provider URLs
6. Desktop/mobile consistency — shared contract; platform adaptation only where strictly required
7. Provider-neutral user-facing metadata — no provider/model identity in Creation cards
8. Future artifact-type extensibility — IMAGE, PRESENTATION, VIDEO via the same contract

### Artifact-Type Dispatch Model

```text
artifact.type
  -> preview capability  (image: native render | presentation: thumbnail | video: poster)
  -> renderer            (type-specific, registered; unknown type: safe fallback)
  -> open behavior       (type-specific, registered; unknown type: fail safely)
  -> canonical target    (NAgex artifact URL — never a provider URL)
```

The dispatcher is a single shared system. No separate desktop/mobile dispatch
unless presentation-layer adaptation strictly requires it — semantics remain
one contract.

### Mobile Create Entry Design Decision

Mobile must expose the **existing Create surface responsively** (Option A).

Rationale: R23.7H-B2 already established a responsive Personal Home shell;
there is no separate mobile creation product in the architecture; the
creation contract (CreationRuntime, specs, router) is platform-neutral.
A mobile-native Create surface backed by the same contract remains a valid
future enhancement but must not be implemented as a separate flow in R23.7H-C.

Requirements for mobile Create entry:
- Normal user-facing language (no Planner/Router/Execution/Capability terminology)
- Reuses existing Create mental model
- Responsive Personal AI experience — no separate mobile creation product

### IMAGE Gaps Closed by This Milestone

Three gaps previously tracked as FOLLOW_UP_UX after R23.7C-C closure are
now formally owned by R23.7H-C. They must be resolved through the shared
contract, not as isolated image-specific patches:

```text
GAP-A  Mobile Create entry                         NOT_AVAILABLE -> must become available
GAP-B  Mobile Recent Creations IMAGE thumbnail     NOT_AVAILABLE -> render safe canonical thumbnail
GAP-C  Mobile IMAGE Open                           routes to Inbox -> resolve to canonical artifact
```

### IMAGE Invariants (Preserve from R23.7C-C)

- Canonical NAgex artifact URL (never provider URL)
- Native image rendering; authorized delivery
- Provider-neutral preview; no provider/model metadata in user-facing Creation cards
- Existing session/tenant isolation
- Existing canonical desktop Studio history behavior

Do NOT redesign or regress the closed R23.7C-C runtime.

### PRESENTATION Extension Points (define only; do not implement)

R23.7H-C must define the registration surface for PRESENTATION:
- artifact type registration
- canonical artifact target
- preview/thumbnail capability
- Open behavior registration

### VIDEO Extension Points (define only; do not implement)

R23.7H-C must define the registration surface for VIDEO:
- artifact type registration
- canonical artifact target
- poster/preview capability
- Open/player behavior registration

### Auth / Trust

Reuse existing: resolveRequestIdentity(), session precedence,
tenant/user/workspace authorization, canonical artifact delivery.
No new authentication model. No identity-header expansion. No approval bypass.

### Invariants

```text
FAKE_SUCCESS_PATHS = 0
STALE_STATE_LEAK   = 0
RAW_I18N_KEY_LEAK  = 0
TECHNICAL_UI_LEAK  = 0
CROSS_SESSION_LEAK = 0
RESET_SCOPE_LEAK   = 0
```

Provider/model/runtime identity must not appear in ordinary user-facing Creation cards.

### Exit Criteria

```text
MOBILE_CREATE_ENTRY       mobile Create entry exists and works
MOBILE_IMAGE_THUMBNAIL    IMAGE Recent Creation thumbnail renders on mobile
MOBILE_IMAGE_OPEN         IMAGE Open resolves to canonical artifact target on mobile
DESKTOP_REGRESSION        desktop behavior remains correct and uncorrupted
SHARED_DISPATCHER         artifact-type dispatcher / contract exists as shared system
IMAGE_ON_CONTRACT         IMAGE uses the shared contract
UNKNOWN_TYPE_SAFE         unknown/future artifact type fails safely, no crash
CANONICAL_URLS            NAgex artifact URLs remain canonical; no provider URL leaks
NO_PROVIDER_LEAK          no provider technical metadata in user-facing Creation cards
I18N_EN_KR                EN and KR both supported
MOBILE_VIEWPORT_CERT      360 / 390 / 430px mobile viewport certification
DESKTOP_CERT              desktop certification
ACCESSIBILITY             accessibility checks pass
HORIZONTAL_OVERFLOW       horizontal overflow = 0
C_C_REGRESSION            existing R23.7C-C test suite passes without regression
NO_PAID_GENERATION        certification does not require paid generation unless
                          an explicit runtime regression demands it
```

### Out of Scope

```text
- Presentation generation
- Video generation
- New image providers
- Personal Home redesign
- Desktop Studio history redesign
- DEBT-0008 / DEBT-0009 / DEBT-0010 cleanup
- R21 stale-test maintenance
- Unrelated account/auth work
```

---

## 6. R23.7C Creation Runtime

Current reconstructed state:

```text
R23.7C-A   Creation Runtime Architecture Audit        CLOSED
R23.7C-B   Document / Report Creation Runtime         CLOSED
           commit: 918170b

R23.7C-P   Provider-Neutral Creation Architecture     CLOSED
           local commit: 0181e40

R23.7C-C   Real Image Creation Runtime                CLOSED
           implementation commit: c71f1971ea061664e1f86abcb6fac71116cadcec
             (fix(r23.7c-c): complete canonical image history)
           final certification harness commit: 3b3d4c17b16e41b5b1affbc0ca889d8f55680bd6
             (test(r23.7c-c): certify final non-paid closure)
           closure evidence: docs/archive/evidence/
             R23_7C_C_Real_Image_Creation_Runtime_Closure_Report_20260930.md

R23.7C-D   Presentation / Slides Runtime              PLANNED
           Technical dependency on R23.7H-C: NONE
           Execution gate: R23.7H-C must be CLOSED before R23.7C-D may START
           Reason: the shared Creation Artifact UX Integration Contract must
           be established before Presentation becomes the second artifact type
           requiring Home/Create integration. Starting in parallel would create
           an ad-hoc Presentation UI/history/navigation path, which is prohibited.

R23.7C-E   Video Runtime                              PLANNED
```

R23.7C-P is independent of C-C and establishes the provider/spec abstraction for IMAGE/PRESENTATION/VIDEO.

R23.7C-C is closed per the exit criteria in §8. The three FOLLOW_UP_UX items
previously associated with C-C closure (mobile Create entry, mobile image
thumbnail, mobile IMAGE Open routing) are now formally owned by R23.7H-C
(see §5a). They are not C-C closure blockers and are not floating open items.

## 7. Immediate Product Development Sequence

The current implementation sequence:

```text
1. R23.7C-C Real Image Runtime                                          CLOSED
2. R23.7H-C Home/Create Artifact Integration                            OPEN  <- ACTIVE
3. R23.7C-D Presentation Runtime                                        PLANNED
   (technically parallel-capable, but execution-gated behind R23.7H-C)
4. R23.7C-E Video Runtime                                               PLANNED
5. Reconcile R23.7G Background Runtime Certification against current code
6. R23.8P Personality / Trust UX
7. R23.9C Final Certification
```

**R23.7C-D execution gate — resolved ambiguity:**
R23.7C-D has no hard technical dependency on R23.7H-C. However, project
execution sequence requires that R23.7H-C is CLOSED before R23.7C-D may
START. The reason: the shared Creation Artifact UX Integration Contract
must exist before Presentation becomes the second artifact type requiring
Home/Create integration. Starting R23.7C-D in parallel would cause
Presentation to receive an isolated UI/history/navigation path, which
multiplies artifact-type-specific implementations and is explicitly prohibited.

Item 5 is a **reconciliation gate**, not an assertion that no background-runtime
work has occurred. The current source snapshot still names R23.7G as pending;
no later closure evidence was supplied in the consolidation materials.

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

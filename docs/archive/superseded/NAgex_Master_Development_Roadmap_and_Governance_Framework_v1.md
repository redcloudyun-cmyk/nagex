# NAgex Master Development Roadmap & Governance Framework v1

## 0. 문서 목적

NAgex 개발은 개별 기능을 임의로 추가하는 방식이 아니라, **전체 제품 로드맵과 고정된 개발 프레임워크 안에서만 진행**한다.

이 문서는 향후 모든 개발지시서의 상위 기준이다.

모든 하위 개발 문서는 이 문서와 충돌하면 무효이며, 충돌 시 본 문서를 우선한다.

---

# 1. 현재 기준점

## 1.1 Frozen Architecture Baseline

```text
Baseline Commit: 45206c9

Architecture Phase 01 — Composition Root              FROZEN
Architecture Phase 02 — Lifecycle Manager             FROZEN
Architecture Phase 03 — Module Contracts              FROZEN
Architecture Phase 04 — Browser Module Extraction     FROZEN
Architecture Phase 05 — Gmail / Calendar Modules      FROZEN
Architecture Phase 06 — Task Orchestration Cleanup    FROZEN
Architecture Phase 07 — Architecture Enforcement      FROZEN
Architecture Phase 08 — Scoped Test System            FROZEN
```

Linux 검증 기준:

```text
837 / 837 PASS
SAFE VERIFICATION PASS
LIVE E2E PASS
Graceful Shutdown PASS
Replay Protection PASS
```

이 baseline은 향후 구조 변경의 기준점이다.

---

## 1.2 Product Development Baseline

Architecture 01~08 이후부터는 기본적으로 제품 기능 개발 트랙으로 전환한다.

현재 제품 기능 트랙:

```text
P01a — Plan Step Parameters
P01  — Generic Step Executor
P02  — Approval-aware Task Continuation
P03  — Durable Multi-step Workflow Runtime
P04  — Notification Delivery
P05  — Memory / Knowledge Feedback
P06  — Additional Capability Modules
```

P01a는 P01 pre-flight에서 발견된 실행 구조 공백을 보완하기 위해 삽입된 **sub-phase**다.

---

# 2. NAgex 최상위 제품 정의

NAgex는 단순 AI 챗봇이나 단일 agent가 아니라 다음을 통합하는 Personal AI Runtime / Execution Platform이다.

```text
Intent
Planner
Safety
Capability Broker
Approval
Execution
Memory
Knowledge
Tasks
Workflow
Modules
Runtime
Audit
Interfaces
```

핵심 실행 흐름은 항상:

```text
Intent
→ Safety
→ Planner
→ Capability Broker
→ Pre-Execution Safety
→ Approval
→ Execution
→ Result
→ Audit
```

Task / Workflow / Agent / UI 어디에서 시작하더라도 이 실행 통제 경계를 우회하면 안 된다.

---

# 3. 개발 트랙 체계

향후 개발은 4개 트랙으로 관리한다.

## Track A — Architecture

목적:

```text
구조
dependency direction
module boundary
runtime ownership
lifecycle
contracts
architecture enforcement
```

Architecture Phase는 구조적 압력이 실제로 발생할 때만 쓴다.

현재:

```text
Architecture Wave 1
Phase 01~08
COMPLETE / FROZEN
```

다음:

```text
Architecture Wave 2
Phase 09+
NOT STARTED
```

Phase 09는 제품 기능 개발 결과를 검토한 뒤 필요성이 입증된 경우에만 시작한다.

---

## Track B — Product Capability

실제 사용자가 체감하는 기능 개발.

현재:

```text
P01a Plan Step Parameters
P01  Generic Step Executor
P02  Approval-aware Continuation
P03  Durable Workflow
P04  Notifications
P05  Memory/Knowledge Feedback
P06  New Capability Modules
```

이 트랙이 현재 주 개발축이다.

---

## Track C — Platform Hardening

기능 개발 중 발견되는 공통 운영·안정 기반 강화.

예:

```text
idempotency
persistence integrity
test isolation
observability
resource limits
rate limits
failure recovery
migration safety
secrets handling
```

Hardening은 기능과 얽어서 즉흥 증축 없이 별도 작은 directive로 분리한다.

---

## Track D — Product Experience

사용자 경험과 인터페이스.

예:

```text
Web UI
Desktop
Quick Wake
Task UI
Approval UI
Activity/Audit UI
Memory/Knowledge UI
Settings
Notifications
```

Backend contract와 runtime이 안정된 뒤 진행한다.

---

# 4. Product Roadmap

## Stage 0 — Modular Foundation

```text
Phase 01~08
COMPLETE
```

성과:

```text
Composition Root
Lifecycle Manager
Ports / Contracts
Browser Module
Gmail Module
Calendar Module
Task runner separation
Architecture enforcement
Scoped testing
```

---

## Stage 1 — Governed Task Execution

### P01a — Plan Step Parameters

목적:

```text
ResolvedPlanStep가 실제 Capability payload를 가질 수 있도록 함
```

범위:

```text
parameters?: Record<string, unknown>
```

금지:

```text
cross-step binding
execution
schema registry
provider-specific validation in planner
```

---

### P01 — Generic Step Executor

목적:

```text
ResolvedPlan
→ Step Executor
→ CapabilityExecutorPort
→ Capability Broker
```

1차 범위:

```text
READ_ONLY_AUTO
```

핵심:

```text
no direct provider call
no auto-approval
BLOCKED halt
APPROVAL_REQUIRED halt
truthful step result
```

---

### P02 — Approval-aware Task Continuation

목적:

```text
RUNNING
→ WAITING_APPROVAL
→ APPROVED
→ exact frozen step resume
```

핵심:

```text
payload freeze
approvalId binding
one-time execution
resume determinism
```

---

### P03 — Durable Multi-step Workflow Runtime

목적:

```text
process restart 이후도 workflow/task 재개
```

필요 기능:

```text
step state persistence
completed step outputs
failed step
next step
resume cursor
retry policy
durable run identity
```

이 단계에서만 TaskRun persistence schema 확장을 검토한다.

---

# 5. Stage 2 — User Delivery & Intelligence Loop

## P04 — Notification Delivery

목적:

```text
task/workflow result
→ notification policy
→ user delivery
```

예:

```text
web notification
email
desktop
future mobile
```

조건이 충족되지 않았을 때는 알리지 않는 것이 기본.

---

## P05 — Memory / Knowledge Feedback

목적:

```text
execution result
→ candidate memory / knowledge
→ policy / approval
→ persist
```

원칙:

```text
execution output ≠ automatic memory
```

Memory pollution 방지.

---

# 6. Stage 3 — Capability Expansion

## P06 — Additional Capability Modules

후보:

```text
Files
Google Drive
Slack
GitHub
Web APIs
Documents
Local desktop
Search
Data tools
```

각 모듈은 반드시:

```text
Contract
Module boundary
Capability registration
Safety policy
Approval policy
Execution
Audit
Scoped tests
Architecture enforcement
```

을 갖춘다.

---

# 7. Stage 4 — Workflow / Agent Productization

P01~P06 완료 후 진행.

후보:

```text
Workflow Builder
Reusable Automation
Agent Templates
Personal Automation Library
Scheduled Agent Missions
Long-running Agent Tasks
Multi-source Research
Desktop actions
```

이 시점에서 단순 Task와 Workflow의 경계를 명확하게 정의한다.

---

# 8. Architecture Phase 09 시작 조건

Phase 09는 날짜나 순번 때문에 진행하지 않는다.

다음 중 하나 이상이 실제 발생해야 한다.

```text
1. 신규 module 증가로 Composition Root가 과도하게 비대해짐
2. ports/contracts가 서로 얽혀 dependency direction이 깨짐
3. Workflow Runtime이 Task Runtime과 독립 subsystem이 되어야 함
4. Memory/Knowledge/Plugin Runtime의 lifecycle 분리가 필요함
5. current architecture enforcement로 표현하기 어려운 새로운 boundary가 생김
6. module restart/fault-isolation 요구가 실제 운영에 필요해짐
7. performance/scale 때문에 process/runtime 분리가 필요해짐
```

그때:

```text
Architecture Baseline Review Wave 2
→ evidence
→ Phase 09 scope 확정
→ 별도 directive
```

순서로 진행한다.

---

# 9. 모든 개발 단계의 공통 프로토콜

모든 Product / Architecture / Hardening 작업은 아래 순서를 따른다.

```text
1. Baseline 확인
2. Current-state inventory
3. Real dependency/consumer analysis
4. Gap 정의
5. Scope / non-scope 확정
6. Contradiction check
7. SAFE TO IMPLEMENT 확정
8. Implementation
9. Targeted scoped tests
10. Architecture tests
11. Full regression
12. Commit snapshot integrity
13. Linux verification
14. SAFE verification
15. LIVE E2E
16. Freeze
```

pre-flight 없이 바로 구현하지 않는다.

---

# 10. STOP 원칙

다음이 발생하면 즉시 구현을 멈추고 별도 directive로 분리한다.

```text
unexpected schema migration
new generic DSL
cross-step binding
new approval mechanism
Capability Broker redesign
new persistence model
new lifecycle model
provider-specific shortcut
architecture boundary violation
large unrelated refactor
```

"일단 구현하고 나중에 정리"는 금지.

---

# 11. Frozen Baseline 보호 원칙

Architecture baseline에서 확정된 아래 항목은 기본적으로 변경 금지.

```text
Capability Broker as execution gateway
Approval payload hash freeze
one-time approval consume
ExecutionStore semantics
Audit trail
Browser/Gmail/Calendar module boundaries
Task → CapabilityExecutorPort
Composition Root ownership
LifecycleManager ownership
Architecture enforcement
Scoped testing
```

변경하려면 Architecture Review가 먼저다.

---

# 12. Capability 개발 표준

새 capability는 최소 다음을 가진다.

```text
Capability ID
Provider/module owner
Risk level
Approval policy
Input contract
Execution result
Error semantics
Audit behavior
Idempotency semantics
Tests
```

실행 경로:

```text
Consumer
→ Port
→ Capability Broker
→ Module
→ External system
```

---

# 13. Approval 정책

기본:

```text
READ_ONLY
→ auto-executable if policy permits

WRITE / CONSEQUENTIAL
→ approval required

UNKNOWN
→ fail closed
```

절대:

```text
task / workflow가 self-approve
```

하지 않는다.

---

# 14. Task / Workflow 진화 원칙

현재:

```text
Task
→ Plan Preview
```

다음:

```text
Task
→ Plan
→ Generic Step Executor
```

이후:

```text
Task
→ Plan
→ Execute
→ WAITING_APPROVAL
→ Resume
```

최종:

```text
Task / Workflow
→ durable multi-step runtime
```

단계별로 진행한다.

---

# 15. 데이터 바인딩 원칙

P01a 이후에는:

```text
parameters
```

는 step 자체의 입력값이다.

다음은 아직 별개 문제:

```text
step 1 output
→ step 2 input
```

이것이 실제 필요해진 시점에만 별도 Output Binding directive를 만든다.

그 전에는 DSL을 만들지 않는다.

---

# 16. Testing Framework

기본 테스트 계층:

```text
Level 0 Build
Level 1 Architecture
Level 2 Scoped
Level 3 Integration
Level 4 Full Regression
Level 5 Linux / Runtime
Level 6 SAFE
Level 7 LIVE E2E
```

Full regression은 항상 유지.

Scoped test는 full regression을 대체하지 않는다.

---

# 17. Commit / Freeze 정책

각 directive는 가능하면 하나의 focused commit.

완료 후:

```text
IMPLEMENTED
TESTED
DEPLOYED
VERIFIED
FROZEN
```

단계로 상태를 구분한다.

로컬 PASS만으로 FROZEN 선언하지 않는다.

---

# 18. 현재 개발 상태

```text
Architecture Wave 1
COMPLETE / FROZEN @ 45206c9

P01a — Plan Step Parameters
IMPLEMENTED @ 90c20b1
Linux/SAFE/LIVE verification pending

P01 — Generic Step Executor
BLOCKED until P01a freeze
then pre-flight resumes

P02
NOT STARTED

P03
NOT STARTED

Architecture Phase 09
NOT SCHEDULED
trigger-based only
```

---

# 19. 현재 다음 실행 순서

```text
1. P01a Linux full regression
2. P01a systemd graceful restart
3. nagex-check
4. nagex-e2e-live
5. P01a FROZEN

6. P01 Generic Step Executor pre-flight rerun
7. confirm resolvedStep.parameters → CapabilityRequest.payload
8. confirm explicit READ_ONLY_AUTO eligibility signal
9. confirm no cross-step output binding required for milestone
10. implement P01 only if SAFE TO IMPLEMENT
```

---

# 20. Antigravity / Codex 작업 지침

향후 모든 개발지시서 작업 세션에 다음 원칙을 적용한다.

```text
You are working inside the NAgex Master Development Roadmap.

Do not treat the current directive as an isolated coding task.

Before implementation:
1. identify which roadmap Track / Stage / Phase this work belongs to,
2. verify the frozen baseline it depends on,
3. confirm that the requested change does not silently pull work forward
   from later roadmap stages,
4. identify any architecture or persistence boundary that would be crossed.

If a required change belongs to a later phase, STOP and report it rather
than implementing it opportunistically.

Preserve all previously frozen invariants unless an explicit Architecture
Review authorizes changing them.

Every task must follow:
inventory → dependency map → scope → contradiction check → SAFE TO IMPLEMENT
→ implementation → scoped tests → architecture tests → full regression
→ deployment verification → freeze.
```

---

# 21. 핵심 원칙

> **NAgex 개발은 기능 단위가 아니라 전체 제품 로드맵 안에서 진행한다.**

> **현재 directive가 맞더라도, 전체 roadmap에서 시기가 맞지 않으면 구현하지 않는다.**

> **Architecture는 필요할 때만 바꾸고, Product 기능은 frozen architecture 위에서 확장한다.**

> **다음 기능 때문에 앞선 구조를 즉흥적으로 증축하지 않는다.**

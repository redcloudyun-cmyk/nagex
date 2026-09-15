# NAgex Master Roadmap Amendment — Device Control Foundation

**Date:** 2026-09-13  
**Status:** APPROVED STRATEGIC ROADMAP AMENDMENT  
**Parent:** `docs/NAgex_Master_Development_Roadmap_and_Governance_Framework_v1.md`

## 1. Decision

NAgex의 장기 목표인 **개인화된 AI 실행 플랫폼**을 실현하려면 API/MCP 기반 실행만으로는 충분하지 않다.

예약·이동·숙소·식당·병원·티켓·쇼핑·결제·레거시 프로그램·모바일 앱 등 실제 생활/업무 실행은 서비스마다 API 제공 범위가 제한되거나, 검색만 API로 가능하고 최종 예약/결제는 UI에서만 가능한 경우가 존재한다.

따라서 NAgex는 기존 Structured Execution과 별도로 **Visual / Device Execution**을 공식 실행 계층으로 추가한다.

```text
                     NAgex Planner
                          |
              +-----------+-----------+
              |                       |
     Structured Execution      Visual / Device Execution
              |                       |
        API / MCP / SDK          Browser / Computer
              |                  Android / future iOS
              |                       |
       Capability Broker  <------------+
              |
      Safety / Approval
              |
          Execution
```

핵심 원칙:

```text
API FIRST
UI CONTROL WHEN REQUIRED
HUMAN APPROVAL BEFORE CONSEQUENTIAL ACTIONS
NAgex RETAINS EXECUTION POLICY AND CONTROL
```

Astra 등 Computer-Use capable model은 NAgex 자체가 아니라 **Visual Device Executor의 perception/reasoning component**로 사용한다.

---

## 2. Roadmap Priority

현재 진행 중인 **P08 My Space Foundation minimal slice를 먼저 완료한다.**

Device Control을 P08 안에 끼워 넣거나 P08 범위를 확장하지 않는다.

P08 완료/FROZEN 이후, Reservation / Payment / Places / broader daily-life automation을 구현하기 전에 다음 전략 게이트를 수행한다.

```text
P08 My Space Foundation
        ↓
DC1 — Device Control Foundation Preflight
        ↓
DC2 — Browser / Computer Visual Execution Foundation
        ↓
DC3 — Approval-aware Consequential UI Actions
        ↓
Reservation / Scheduling Execution
        ↓
Payment Execution
        ↓
Android Device Bridge
        ↓
Future iOS feasibility review
```

**Reservation / Payment는 Device Control Foundation보다 먼저 구현하지 않는다.**

단, Calendar/Gmail 등 기존 API로 완결 가능한 scheduling 기능은 기존 Structured Execution 경로를 계속 사용한다.

---

## 3. Why Device Control Comes Before Reservation / Payment

예약/결제 기능을 먼저 도메인별로 만들 경우 사이트별 Selenium/Playwright shortcut, provider-specific automation, approval bypass, brittle selector logic이 난립할 위험이 있다.

따라서 먼저 공통 Device Control Foundation을 정의한다.

필수 기반:

```text
screen observation
UI state understanding
action proposal
click / type / scroll / keypress
upload / download
before/after observation
action verification
risk classification
approval gate
execution record
failure / recovery semantics
session boundary
```

도메인별 예약/결제는 이 기반 위에 올라가는 application capability로 취급한다.

---

## 4. Execution Routing Rule

NAgex는 가능한 가장 구조화된 실행 경로를 우선한다.

```text
1. Native/API capability available and sufficient
   → use API/MCP/SDK

2. API available but incomplete
   → use API for structured steps
   → use Visual Execution only for missing UI-only steps

3. No usable API
   → use Browser/Computer Visual Execution

4. Mobile-only service
   → use Android Device Bridge + Visual Execution
```

UI automation을 편의상 API보다 우선하지 않는다.

---

## 5. Control Boundary

Computer-use model은 자유롭게 장치를 조작하는 최종 권한자가 아니다.

```text
Model observes/proposes
        ↓
NAgex Policy / Safety
        ↓
Approval when required
        ↓
Capability Broker / Device Execution Session
        ↓
Primitive action
        ↓
Observe result
        ↓
Verify
```

기존 frozen invariant를 유지한다.

```text
Capability Broker remains execution gateway
WRITE / CONSEQUENTIAL requires approval
UNKNOWN fails closed
no self-approval
no direct provider bypass
one-time approval semantics preserved
```

---

## 6. Initial Device Capability Family

Preflight에서 실제 naming/contracts를 확정하며, 아래는 roadmap-level candidate다.

```text
device.observe
device.click
device.type
device.scroll
device.keypress
device.upload
device.download

browser.navigate
browser.observe
browser.interact

mobile.observe
mobile.tap
mobile.swipe
mobile.type
mobile.launch_app
mobile.back
```

이 primitive capability를 모델에게 무제한 직접 공개하지 않는다.

`DeviceExecutionSession` 또는 동등한 bounded execution context 안에서만 허용하는 방향을 우선 검토한다.

---

## 7. Consequential Action Levels

Device Control은 단계적으로 권한을 확대한다.

```text
Level 1 — observe / search / compare
Level 2 — navigation / form preparation
Level 3 — reservation ready state, stop before commitment
Level 4 — approval-gated reservation / external submission
Level 5 — approval-gated payment / financial commitment
```

Payment는 Device Control Foundation의 첫 milestone 범위에 포함하지 않는다.

Payment 단계에서는 최소 다음을 별도 검토한다.

```text
amount verification
merchant / recipient verification
final-submit boundary
OTP / 2FA / biometric boundary
duplicate-payment prevention
result confirmation
failure / cancellation semantics
```

---

## 8. Platform Order

초기 구현 우선순위:

```text
1. Existing Browser execution inventory
2. Browser Visual Control Foundation
3. Desktop/Computer control feasibility and sandboxing
4. Approval-aware consequential UI execution
5. Reservation/Scheduling domain applications
6. Payment execution
7. Android Device Bridge
8. iOS feasibility review
```

Android가 iOS보다 먼저다.

iOS는 플랫폼 제약과 권한 모델을 별도 preflight로 검토하고, 동일한 범용 제어가 가능하다고 가정하지 않는다.

---

## 9. Astra / Computer-Use Model Policy

Astra 또는 향후 동급/상위 Computer-Use 모델은 vendor-specific shortcut으로 architecture에 박아 넣지 않는다.

NAgex는 다음 추상화를 유지한다.

```text
VisualExecutionModel / ComputerUseModel Port
        ↓
Provider Adapter
        ↓
Astra or another compatible model
```

모델 교체가 Capability Broker, Approval, Device Session contract를 변경하지 않도록 한다.

Astra 활용의 전략적 핵심은 일반 LLM routing보다 **screen-based computer/device execution**에 둔다.

---

## 10. P08 Boundary

P08 My Space minimal slice는 기존 승인 범위를 유지한다.

```text
INCLUDE NOW
- My Space shell
- Activity
- Memory
- Tasks / Workflows summary
- Calendar summary
- thin History composition

EXCLUDE FROM P08
- Device Control
- Reservation
- Payment
- Places
- People
- Unified Search
```

P08 구현 중 Device Control 요구가 발견되어도 opportunistic implementation하지 않는다.

P08 완료 후 DC1 Preflight로 넘긴다.

---

## 11. DC1 Preflight Required Questions

구현 전에 최소 다음을 증거 기반으로 확인한다.

```text
1. current Browser module/executor가 실제로 제공하는 primitives
2. screenshot / DOM / accessibility-tree observation capabilities
3. current Capability Broker와 device primitive contract 연결 방식
4. approval boundary를 UI action sequence에 적용하는 방법
5. session ownership / tenant ownership model
6. restart / timeout / cancellation semantics
7. screenshot / sensitive-data retention policy
8. password / credential / OTP handling boundary
9. visual model provider abstraction
10. host/browser sandbox and SSRF/security interaction
11. deterministic verification of before/after UI state
12. audit/history 기록 범위와 민감정보 redaction
```

이 preflight에서 architecture boundary crossing이 확인되면 구현을 멈추고 Architecture Wave 2 trigger 여부를 검토한다.

---

## 12. STOP Conditions

다음은 Device Control 구현 중 즉시 STOP 사유다.

```text
direct Astra/provider call bypassing Capability Broker
unbounded click/type loop
approval bypass for consequential action
raw password/OTP persistence
silent payment execution
cross-tenant device session reuse
production device access without explicit session ownership
site-specific shortcut being promoted as generic architecture
new generic agent DSL introduced opportunistically
```

---

## 13. Governance Status

이 문서는 **구현 지시서가 아니라 Master Roadmap Amendment**다.

지금 당장 Device Control 코드를 작성하라는 의미가 아니다.

현재 실행 우선순위는:

```text
1. Home/UI pre-P08 corrections complete/freeze
2. P08 My Space Foundation minimal slice
3. P08 host verification / freeze
4. DC1 Device Control Foundation Preflight
5. evidence-based implementation directive
```

DC1 시작 시 별도 문서로 실제 구현 명세를 작성한다.

권장 구현 문서명:

```text
docs/NAgex_Device_Control_Foundation_Implementation_Directive_v1.md
```

그 문서는 DC1 preflight가 SAFE TO IMPLEMENT를 확정한 뒤에만 작성/실행한다.

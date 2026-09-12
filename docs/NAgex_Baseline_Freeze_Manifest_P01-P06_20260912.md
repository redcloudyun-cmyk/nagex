# NAgex Baseline Freeze Manifest
## P01–P06 공식 동결 기준선

**문서 버전:** 1.0
**기준일:** 2026-09-12
**현재 Repository Baseline HEAD:** `7c7c441735fc93aae89ff3a2c6864a97b5bdac5d`
**Repository:** `redcloudyun-cmyk/nagex`
**Branch:** `main`

---

## 1. 목적

본 문서는 NAgex의 P01–P06 개발 구간에서 완료·검증된 기능을 공식 Frozen Baseline으로 고정하기 위한 기준 문서다.

이 문서 이후의 신규 개발(P07+)은 아래 원칙을 따른다.

```text
신 기능 추가
→ Frozen Baseline의 기존 계약을 변경 대상으로 삼지 않음
→ 변경이 불가피하면 영향분석 + 별도 R-series correction
→ Scoped / Architecture / Full / Host 검증 필수
→ 검증 완료 전 기존 Frozen 상태를 임의 완료로 간주하지 않음
```

현재 전체 repository의 통합 baseline HEAD는 다음과 같다.

```text
7c7c441735fc93aae89ff3a2c6864a97b5bdac5d
```

---

## 2. 공식 Freeze Chain

| 구간 | 상태 | Freeze 기준 |
|---|---|---|
| P01a | **FROZEN** | 기존 검증 완료 baseline |
| P01 | **FROZEN** | 기존 검증 완료 baseline |
| H01 | **FROZEN** | 기존 검증 완료 baseline |
| P02a | **FROZEN** | 기존 검증 완료 baseline |
| P02 | **FROZEN** | 기존 검증 완료 baseline |
| P03 | **FROZEN** | 기존 검증 완료 baseline |
| Phase09 | **FROZEN** | `e5c4f29` |
| V01 | **FROZEN** | `5640db0` + 하네스 보정 baseline |
| P04 | **FORMALLY FROZEN** | `7c7c441735fc93aae89ff3a2c6864a97b5bdac5d` |
| P05 | **FORMALLY FROZEN** | `f681e661b59dd24360b756c978c60fb4c1ca6ce6` |
| P06 | **FORMALLY FROZEN** | `4859b55e13116ef23a817357683d4f4a1b48f709` |

> P01a/P01/H01/P02a/P02/P03의 정확한 historical SHA는 본 문서에서 임의 추적하지 않는다. 필요 시 Git history와 별도 verification evidence를 통해 별도 복원한다.

---

## 3. Current Integrated Baseline

```text
Branch       : main
Baseline HEAD: 7c7c441735fc93aae89ff3a2c6864a97b5bdac5d
Commit       : fix(notifications): P04-R1 enforce tenant notification isolation
```

이 HEAD에는 P06까지의 구현과 P04-R1 보정이 포함되어 있다.

따라서 이후 신규 개발의 출발점은:

```text
main @ 7c7c441735fc93aae89ff3a2c6864a97b5bdac5d
```

로 고정한다.

---

## 4. P04 Freeze Record

### 4.1 최종 상태

```text
P04 Notification Layer
Status: FORMALLY FROZEN
Freeze Commit:
7c7c441735fc93aae89ff3a2c6864a97b5bdac5d
```

### 4.2 핵심 계약

```text
Notification ownership
= tenantId + principalId

Notification dedupe identity
= tenantId + principalId + dedupeKey
```

적용 범위:

```text
list
unread count
markAsRead
markAllAsRead
dedupe lookup
HTTP notification routes
```

### 4.3 Host Acceptance

```text
Exact SHA                       PASS
HEAD == origin/main             PASS
Working tree clean              PASS
Host scoped tests               PASS (32/32)
Tenant A list isolation         PASS
Tenant B list isolation         PASS
Cross-tenant read block         PASS
Cross-tenant no mutation        PASS
Tenant A mark-all scope         PASS
Tenant B unaffected             PASS
Restart persistence A           PASS
Restart persistence B           PASS
Rightful tenant read            PASS
SAFE                            PASS
LIVE E2E                        PASS
Task Durable LIVE               PASS
P04-R1 Host Isolation           PASS
```

---

## 5. P05 Freeze Record

P05는 Durable Memory / Persistent Memory 계층의 기준선이다.

주요 계약:

```text
MemoryScope:
EXECUTION / SESSION / AGENT / USER / TENANT

Lifecycle:
PROPOSED / VALIDATING / ACTIVE / CONFLICTED
SUPERSEDED / EXPIRED / DELETED
```

핵심 보장:

```text
durable persistence
persist-before-mutation
delete durable-first
restart recovery
seed idempotency
candidate memory reconciliation
```

기능 기준 commit:

```text
f681e661b59dd24360b756c978c60fb4c1ca6ce6
```

P04 predecessor blocker가 해소되었으므로:

```text
P05 = FORMALLY FROZEN
```

으로 reconciled 한다.

---

## 6. P06 Freeze Record

P06는 Module / Productization Layer의 기준선이다.

Canonical modules:

```text
module.gmail
module.calendar
module.browser
```

핵심 계약:

```text
tenant-scoped module state
default enabled
disabled module fail-closed
canonical capability mapping
module state durability
restart persistence
authorized mutation only
cross-tenant mutation deny
alias/canonical bypass prevention
test-to-production state isolation
```

기능 기준 commit:

```text
4859b55e13116ef23a817357683d4f4a1b48f709
fix(modules): P06-R4 verify production state immutability
```

최종 Host Acceptance:

```text
Exact Host SHA                  PASS
Module Registry                 PASS
Gmail Disable                   PASS
MODULE_DISABLED enforcement     PASS
Calendar isolation              PASS
Disabled restart persistence    PASS
Unauthorized mutation 403       PASS
Cross-tenant mutation 403       PASS
Gmail re-enable                 PASS
Enabled restart persistence     PASS
Gmail execution restored        PASS
SAFE                            PASS
LIVE E2E                        PASS
Task Durable LIVE               PASS
Production test isolation       PASS
P06 Host Acceptance             PASS
```

따라서:

```text
P06 = FORMALLY FROZEN
```

---

## 7. Frozen Baseline 보호 규칙

P07 이후에는 다음 기존 계약을 신규 기능 편의를 위해 임의 변경하지 않는다.

```text
Intent → Safety → Planner → Capability Broker
→ Pre-Execution Safety → Approval → Execution

Approval hash-binding
one-time approval consumption
Capability Broker enforcement
Task durable continuation
Task restart semantics
Notification tenant isolation
Memory durability
Module enable/disable fail-closed
Browser SSRF protection
Google OAuth persistence/security boundary
SAFE verification scripts
LIVE E2E contracts
```

Frozen 코드 수정이 필요하면 반드시:

```text
1. 문서/필요성 증명
2. Frozen Impact Map
3. 기존 계약 명시
4. 최소 변경 설계
5. R-series identifier 부여
6. Scoped tests
7. Architecture tests
8. Integration / Runtime tests
9. Full regression x2
10. Host exact SHA
11. SAFE
12. 필요시 LIVE
13. Host-specific acceptance
14. Freeze reconciliation
```

순서를 따른다.

---

## 8. 금지되는 개발 방식

```text
Frozen 기능을 신규 기능 개발과 함께 몰아서 수정
기존 보안 경계를 convenience 목적으로 optional 처리
테스트를 production durable directory에 연결
caller-controlled header를 authoritative permission으로 신뢰
approval 우회
Capability Broker 우회
direct module/service execution path 추가
cross-tenant resource 존재 여부 노출
restart durability를 in-memory success로 대체
실제 host evidence 없이 FROZEN 선언
```

---

## 9. Verification Ladder

```text
Analyze
→ Evidence Pack
→ Final Change Map
→ Contradiction Check
→ One Implementation
→ Build
→ Scoped Tests
→ Architecture
→ Integration
→ Runtime
→ Full Regression x2
→ Git Clean
→ Commit / Push
→ Exact Host SHA
→ Linux Regression
→ SAFE
→ LIVE (when consequential)
→ Durable LIVE (when relevant)
→ Phase Host Acceptance
→ Freeze
```

---

## 10. Freeze 용어 정의

### IMPLEMENTED
코드가 작성되었으나 검증이 완료되지 않은 상태.

### LOCALLY VERIFIED
로컬 build / scoped / regression은 통과했지만 host 증거가 없는 상태.

### HOST VERIFIED
정확한 SHA가 실제 서버에 배포되어 host 검증이 완료된 상태.

### FORMALLY FROZEN
다음을 모두 충족한 상태.

```text
implementation complete
required regression complete
exact SHA deployed
host acceptance complete
no known unresolved contract blocker
```

---

## 11. P07 시작 기준

P07은 반드시 다음 기준선 위에서 시작한다.

```text
Repository : redcloudyun-cmyk/nagex
Branch     : main
Start HEAD : 7c7c441735fc93aae89ff3a2c6864a97b5bdac5d
```

P07 Preflight 문서 첫 부분에 반드시 다음 문구를 넣는다.

```text
This phase starts from the NAgex P01–P06 Formal Frozen Baseline.
No frozen contract may be modified unless explicitly declared
in the Frozen Impact Map and approved as a correction.
```

---

## 12. 현재 공식 상태

```text
NAgex Baseline Freeze State
────────────────────────────────────────

P01a       FROZEN
P01        FROZEN
H01        FROZEN
P02a       FROZEN
P02        FROZEN
P03        FROZEN
Phase09    FROZEN
V01        FROZEN
P04        FORMALLY FROZEN @ 7c7c441
P05        FORMALLY FROZEN @ f681e66
P06        FORMALLY FROZEN @ 4859b55

Integrated Repository Baseline
= 7c7c441735fc93aae89ff3a2c6864a97b5bdac5d

P01–P06 FREEZE CHAIN
= RECONCILED
```

---

## 13. 다음 단계

다음 신규 개발은 `P07`로 시작한다.

P07 착수 이전 반드시 다음을 먼저 확정한다.

```text
P07 Preflight
Frozen Impact Map
No-Go Scope
Acceptance Criteria
Verification Plan
```

---

**END OF NAgex BASELINE FREEZE MANIFEST**

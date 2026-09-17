# NAGEX 아이디어 벤치마킹 검토

> 상태: **DESIGN / RESEARCH BACKLOG**  
> 목적: 외부 오픈소스·상용 제품의 코드가 아니라 **설계 아이디어·UX 패턴·운영 원칙**을 조사하고, NAGEX에 적용 가능한지 검토한다.  
> 원칙: **코드는 가져오지 않되 시행착오는 가져온다.**

이 문서는 개발 명령서가 아니다. 모든 항목은 아래 절차를 거쳐야만 NAGEX 공식 설계로 승격된다.

```text
외부 아이디어 / 제품 패턴
→ 사실·출처 검증
→ 현재 NAGEX 구현과 Gap 분석
→ 채택 / 보류 / 폐기 결정
→ 공식 Architecture / UX 문서 반영
→ NAGEX 코드로 독자 구현
```

또한 각 항목은 다음 세 상태로 구분한다.

- **VERIFIED PRINCIPLE**: NAGEX의 기존 원칙과 직접 정합되며, 내부 구현 검증 후 공식 원칙으로 승격할 가치가 높은 항목
- **DESIGN CANDIDATE**: 유망하지만 현재 구현·비용·복잡도 검토가 필요한 항목
- **RESEARCH NOTE**: 참고 가치가 있으나 수치·효과·사실관계 또는 적용성이 추가 검증되어야 하는 항목

> 주의: 외부 문서의 수치, 종료일, 성능효과, 비율 등은 본 문서에 적혀 있다는 이유만으로 사실로 확정하지 않는다. 실제 개발 기준으로 사용하기 전 공식 1차 자료 또는 신뢰할 수 있는 원출처를 다시 확인한다.

---

## 1. 메모리 아키텍처 — Letta(MemGPT), Mem0, Zep

### 외부 아이디어

**Letta/MemGPT**는 작업 중 항상 노출되는 메모리와 필요할 때 검색하는 장기 저장소를 구분하는 계층적 메모리 개념을 사용한다.

**Mem0**는 메모리의 Write path와 Read path를 분리하고, 모든 대화를 무조건 메모리로 저장하지 않는 선택적 저장·검색 개념을 사용한다.

**Zep/Graphiti**는 시간에 따라 변하는 사실을 정적 덮어쓰기가 아니라 temporal relation으로 다루는 접근을 제시한다.

### NAGEX 적용 판단

**상태: DESIGN CANDIDATE**

NAGEX Memory는 단순히 오래된 데이터를 줄이는 방향이 아니라 다음 축을 함께 고려해야 한다.

```text
Memory Retrieval Weight
= relevance
× confidence
× recency
× stability
× user-confirmed importance
```

따라서 단순한 `recency decay`만 적용하는 것은 금지한다. 예를 들어 이름, 장기 선호, 조직 정보, 핵심 프로젝트 정보는 오래됐더라도 여전히 중요할 수 있다.

적용 후보:

- **Core Memory / Working Context / Archival Memory** 역할 분리
- memory write와 retrieval 경로 분리
- 모든 메시지를 memory로 승격하지 않는 중요도·신뢰도 필터
- source/provenance 유지
- 시간에 따라 바뀌는 사실의 유효기간 또는 superseded 상태 관리
- 삭제 대신 `valid_from`, `valid_until`, `superseded_by` 형태의 temporal history 검토

예:

```text
회사: A사
valid_until: 2026-03
superseded_by: 회사 B사
```

이 구조는 "현재 사실"뿐 아니라 "과거에 무엇이 맞았는가"도 설명할 수 있게 한다.

**우선순위: 중간**

현재 Memory Engine이 존재하므로 즉시 대규모 리팩터링하지 않는다. 먼저 현 구조를 측정하고, 실제 사용자 경험에서 오래된 기억·충돌 기억·출처 불명 기억이 문제를 일으키는 지점을 확인한다.

---

## 2. 승인 / Human-in-the-loop UX

### 외부 아이디어

여러 Agent 제품에서 반복적으로 나타나는 핵심 패턴은 다음과 같다.

- 승인은 추상적인 "계속해도 됨"이 아니라 **정확한 액션과 정확한 payload 버전**에 묶인다.
- action/payload가 변경되면 기존 승인은 더 이상 유효하지 않아야 한다.
- irreversible action 직전에 사용자의 명확한 승인 지점을 둔다.
- 민감한 정보 입력 구간은 Agent가 직접 처리하지 않고 사용자 takeover로 전환하는 패턴이 존재한다.
- Cancel / Undo / Compensate를 구분하는 설계가 유용하다.
- 오케스트레이션 로그가 아니라 실제 외부 시스템 상태를 확인하는 Effect Verification 개념이 중요하다.

### NAGEX 적용 판단

**상태: VERIFIED PRINCIPLE 후보**

다만 먼저 현재 NAGEX의 Approval runtime이 이미 어디까지 충족하는지 코드로 확인해야 한다. 이미 payload hash, tool binding, replay protection, consumed state가 구현되어 있다면 중복 기능을 새로 만들지 않는다.

필수 점검:

1. approval이 exact tool / capability에 바인딩되는가
2. exact canonical payload에 바인딩되는가
3. payload가 달라지면 자동 거부되는가
4. plan 수정 후 과거 approval을 재사용할 수 없는가
5. tenant / principal ownership이 유지되는가
6. expiry / consumed / replay protection이 유지되는가

NAGEX 공식 원칙:

> **Plan acceptance is not action approval.**

그리고:

> **Approval authorizes exactly one frozen consequential action, not a general continuation permission.**

### Cancel / Undo / Compensate

세 개를 동일 상태로 취급하지 않는다.

- **Cancel**: 아직 실행되지 않은 미래 작업 중단
- **Undo**: 실제 역연산이 가능한 경우 원상복구
- **Compensate**: 원상복구가 불가능한 경우 보정 액션 제안

예:

```text
메일 발송
→ true undo 불가
→ 잘못 보냈다면 "정정 메일 보내기"가 compensate
```

### Takeover Mode

로그인, 결제정보, OTP, 비밀번호, 민감 개인정보 직접 입력 구간에서는 사용자 takeover를 검토한다.

해당 구간에서는 가능한 경우:

- Agent 입력 금지
- raw secret 수집 금지
- screenshot/logging 최소화 또는 중단
- 완료 후 안전하게 Agent control 복귀

이 원칙은 NAGEX Personal Data / Security 원칙과 함께 설계해야 한다.

**우선순위: 매우 높음 — 단, 신규 개발 전에 현재 Approval 구현 점검부터 수행**

---

## 3. Proactive Assistant / Attention Broker

### 외부 아이디어

통합형 Agent는 Calendar, Gmail, Tasks, Daily Brief, Device Agent, Automation 등 여러 기능이 독립적으로 알림을 만들기 때문에 각 기능이 개별적으로 합리적으로 동작해도 사용자는 전체적으로 알림 과부하를 경험할 수 있다.

이를 막기 위해 하나의 공통 중재 레이어가 모든 proactive output을 평가하는 **Attention Broker** 패턴이 유용하다.

### NAGEX 적용 판단

**상태: VERIFIED PRINCIPLE 후보**

NAGEX에서는 각 capability가 직접 사용자에게 push하는 구조보다 다음이 적합하다.

```text
Calendar / Gmail / Tasks / Daily Brief / Device / Automation
                     ↓
              Attention Broker
                     ↓
    urgent push / digest / suppress / defer / batch
```

Attention Broker 평가 후보:

- urgency
- confidence
- user impact
- actionability
- novelty
- duplication
- current context
- previous user reaction
- interruption cost

외부 자료에서 제시되는 "하루 3~5개", "70% 감소" 같은 숫자는 **RESEARCH NOTE**로 취급하고 NAGEX hard limit으로 그대로 채택하지 않는다.

NAGEX는 사용자별 attention budget을 학습 가능한 정책으로 설계하는 것이 더 적절하다.

예:

```text
Immediate
- 보안 문제
- 승인 만료 임박
- 사용자가 기다리는 작업 실패

Digest
- 비긴급 경쟁사 변화
- 일반 업무 요약
- 낮은 우선순위 제안

Suppress / Merge
- 동일 사건 중복 알림
- 이미 사용자가 처리한 사건
```

**우선순위: 높음**

NAGEX가 확장될수록 알림 소스는 계속 늘어나므로 기능 수가 더 많아지기 전에 broker boundary를 설계하는 것이 유리하다.

---

## 4. Durable Workflow / Task Runtime

### 핵심 질문

**Checkpoint가 존재한다고 Durable Execution이 보장되는 것은 아니다.**

NAGEX DurableTaskRuntime은 다음 질문에 실제 코드로 답해야 한다.

1. 실행 프로세스가 죽었을 때 누가 이를 감지하는가
2. heartbeat / watchdog이 존재하는가
3. 재시작 후 자동으로 resume되는가
4. 두 worker가 동시에 같은 task를 resume하지 못하도록 lease / lock / ownership이 있는가
5. retry가 side effect를 중복 실행하지 않도록 idempotency가 보장되는가
6. approval이 필요한 action이 resume 시 우회되지 않는가
7. process crash 후 task가 영구 WAITING/RUNNING 상태로 고착되지 않는가

### NAGEX 적용 판단

**상태: VERIFIED PRINCIPLE 후보 — 구현 실태 감사 필요**

이 항목은 새 기능 개발보다 먼저 **runtime audit**을 수행하는 것이 맞다.

결과는 다음 중 하나로 분류한다.

```text
DURABLE_CONFIRMED
PARTIALLY_DURABLE
CHECKPOINT_ONLY
NON_DURABLE
```

이름이 `DurableTaskRuntime`이라고 해서 실제 durable하다고 가정하지 않는다.

### Multi-Agent 경계

Multi-agent는 다음처럼 여러 탐색 경로가 유효한 업무에 적합하다.

- research
- comparison
- ideation
- report synthesis

반대로 다음은 결정론적 단일 경로를 유지한다.

- Approval
- Governance
- Security policy
- Billing authority
- final mutation authorization

> **Exploration may be multi-agent. Authority must remain deterministic.**

**우선순위: 높음 (실태 점검), 보강 구현은 점검 결과에 따라 결정**

---

## 5. Model Gateway / Routing

### 외부 아이디어

OpenRouter, LiteLLM 등에서 참고할 수 있는 개념:

- provider health-aware fallback
- rate limit / retry / circuit breaking
- 비용 기반 traffic optimization
- provider abstraction
- usage / billing 기록의 비동기 처리

### NAGEX 적용 판단

**상태: DESIGN CANDIDATE**

중요: 비용 최적화가 NAGEX 모델 선택의 최상위 기준이 되어서는 안 된다.

NAGEX canonical routing priority:

```text
1. Security eligibility
2. Privacy
3. Region / Compliance
4. Capability suitability
5. Quality
6. Cost
7. Latency
```

따라서 가격 가중 라우팅은 **1~5를 모두 통과한 eligible model/provider 집합 안에서만** 사용할 수 있다.

금지:

```text
cheaper provider
→ privacy/security restriction 우회
```

허용:

```text
security/privacy/region/capability/quality 조건 통과
→ 동급 eligible 후보
→ cost/latency 기준 최적화
```

추가 점검 후보:

- BillingLedgerEngine / CreditEngine이 응답 critical path에 동기적으로 포함되는지
- 실패 호출도 비용으로 기록되는지
- usage capture가 응답 지연에 영향을 주는지
- provider 장애 시 circuit breaker가 있는지
- privacy 때문에 특정 provider가 제외된 경우 fallback이 이를 다시 포함하지 않는지

**우선순위: 중간**

Model Gateway 공식 아키텍처 문서가 이미 존재하므로 이 벤치마크 아이디어는 해당 문서를 대체하지 않는다. 실제 채택 시 기존 Global Model Gateway 원칙 아래에 subordinate rule로 반영한다.

---

## 6. Personal Memory UX / Data Portability

### 외부 아이디어

개인 AI 제품의 장기 사용에서는 사용자 기억이 서비스 사업자에게 종속되는 문제가 크다.

좋은 UX 패턴:

- memory timeline
- source 표시
- edit / pin / delete
- 현재/과거 사실 구분
- 사용자 직접 통제
- export

### NAGEX 적용 판단

**상태: DESIGN CANDIDATE**

NAGEX Personal Memory는 블랙박스가 아니라 사용자가 확인하고 통제 가능한 자산이어야 한다.

권장 UX:

```text
Memory
├─ Current
├─ Historical
├─ Pinned
├─ Inferred
└─ Sources
```

각 항목에서 가능하면:

- source
- created_at
- last_confirmed_at
- confidence
- current / superseded
- pin
- edit
- delete
- export

를 제공한다.

특히 export는 단순 편의 기능이 아니라 신뢰 원칙으로 본다.

> **User memory belongs to the user, not to the lifetime of the service.**

Export 형식은 장기적으로 JSON + human-readable format을 검토한다.

**우선순위: 중간**

---

# 종합 우선순위 — 수정안

| 순서 | 항목 | 상태 | 다음 행동 |
|---|---|---|---|
| 1 | Approval exact-action binding / stale approval invalidation | VERIFIED PRINCIPLE 후보 | 현재 구현 우선 감사. 이미 충족하면 추가 개발 금지 |
| 2 | DurableTaskRuntime 실태 점검 | VERIFIED PRINCIPLE 후보 | watchdog/resume/lease/idempotency 감사 |
| 3 | Attention Broker | VERIFIED PRINCIPLE 후보 | 공통 proactive arbitration boundary 설계 |
| 4 | Temporal Memory + provenance | DESIGN CANDIDATE | 현 Memory Engine gap 분석 후 설계 |
| 5 | Model Gateway routing refinement | DESIGN CANDIDATE | 기존 Gateway canonical priority 아래에서 검토 |
| 6 | Memory transparency + export | DESIGN CANDIDATE | Memory UX 단계에서 반영 |

---

# 채택하지 않을 접근

다음은 본 벤치마킹 문서가 정당화하지 않는다.

- 외부 OSS 코드 복사
- 외부 코드를 일부 수정하여 NAGEX에 편입
- vendor source tree 도입
- 불확실한 라이선스 코드 사용
- 블로그에 나온 수치를 근거 없이 hard-coded product policy로 사용
- 특정 경쟁 제품의 UI를 그대로 복제
- 외부 제품이 사용한다는 이유만으로 NAGEX architecture를 변경

NAGEX는 아이디어를 적극적으로 활용하되 구현은 독자적으로 한다.

```text
Benchmark aggressively.
Verify independently.
Design for NAGEX.
Implement independently.
```

---

# 검증 게이트

이 문서의 어떤 아이디어도 바로 구현하지 않는다.

각 항목은 최소 다음 질문을 통과해야 한다.

1. 출처가 충분히 신뢰할 수 있는가?
2. 현재 NAGEX에 실제 gap이 있는가?
3. 기존 Safety / Privacy / Approval / Model Gateway 원칙과 충돌하지 않는가?
4. 이미 구현된 기능을 중복 구현하는 것은 아닌가?
5. 사용자가 체감할 제품 가치가 있는가?
6. 구현 비용과 복잡도가 합리적인가?
7. 독립 구현이 가능한가?
8. 테스트 가능한 acceptance criteria를 만들 수 있는가?

모두 확인된 뒤 공식 설계 문서 또는 milestone directive로 승격한다.

---

# 참고 자료

아래는 아이디어 탐색 출처다. 실제 채택 전 최신 공식 자료로 재검증한다.

- Letta (MemGPT) Walkthrough
- Mem0: AI Agent Memory Guide
- Zep / Graphiti temporal knowledge graph 관련 자료
- OpenAI Operator 관련 공개 자료
- Anthropic containment / sandbox 관련 공개 자료
- Agent UX reversible workflow 관련 자료
- Notification Budget / attention management 관련 자료
- Durable execution / checkpoint 관련 자료
- Microsoft multi-agent orchestrator/sub-agent patterns
- OpenRouter routing 관련 자료
- LiteLLM Proxy architecture 관련 자료
- Dot / Rewind / Limitless 관련 공개 사례

원본 검토 문서에 포함된 URL들은 연구 참고용으로 유지하되, 실제 설계 확정 전 원출처 및 최신성을 다시 검증한다.

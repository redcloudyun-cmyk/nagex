# NAGEX 아이디어 벤치마킹 검토

외부 오픈소스·상용 솔루션이 채택한 설계 아이디어/패턴을 조사하고, NAGEX에 어떻게 적용할 수 있을지 정리한 문서입니다. (코드 이식이 아니라 "아이디어/설계 패턴" 검토이므로, 지난번 폐기한 Open Source Harvest Plan과는 성격이 다릅니다 — 라이선스 이슈 없이 개념만 차용합니다.)

---

## 1. 메모리 아키텍처 — Letta(MemGPT), Mem0, Zep

### 조사 내용

**Letta/MemGPT**: OS의 메모리 계층을 흉내낸 3단 구조를 씁니다.
- Main Context(RAM) — 매 턴 보이는 작업 메모리, 컨텍스트 윈도우 제한
- Recall Storage(SSD) — 최근 대화 이력, 필요 시 tool call로 검색
- Archival Storage(Disk) — 사실상 무제한, 벡터 인덱싱 기반 장기 저장소

핵심은 "어느 계층에 뭘 둘지"를 에이전트 스스로 `core_memory_append/replace`, `archival_memory_insert/search` 같은 함수 호출로 관리하게 만든다는 점입니다. `[human]`(사용자 정보), `[persona]`(에이전트 자기 정의) 같은 라벨 붙은 메모리 블록 개념도 있습니다.

**Mem0**: Write path(추출→중요도 스코어링→구조화 저장)와 Read path(질의 시 검색→랭킹→프롬프트 주입)를 분리합니다. 모든 메시지가 메모리가 되지 않도록 필터링하고, 사용 빈도·최신성·중요도에 따라 "낮은 관련성 항목을 점진적으로 decay(감쇠)"시키는 게 특징입니다.

**Zep**: Graphiti라는 시간 인식(temporal) 지식 그래프를 씁니다. 대화에서 나온 사실을 정적 문서가 아니라 "시간에 따라 변하는 관계"로 저장해서, 나중에 상충하는 정보가 들어오면 오래된 사실을 무효화(invalidate)하지 삭제하지 않습니다.

### NAGEX 적용 아이디어

- 지금 `context/memory.engine.ts`는 단일 계층 저장으로 보이는데, Letta식으로 **"핵심 메모리 블록"(사용자 프로필, 현재 프로젝트/우선순위)과 "아카이브 검색 저장소"를 명시적으로 분리**하면 프롬프트에 항상 넣을 것과 검색해서 꺼낼 것을 구분할 수 있습니다.
- Mem0의 **decay 스코어링**: 오래되고 안 쓰인 메모리 항목의 가중치를 점진적으로 낮춰서, "1년 전에 한 번 말한 것"이 "어제 말한 것"과 동일한 무게로 프롬프트에 계속 끼어드는 문제를 방지.
- Zep의 **사실 무효화(invalidate) 개념**: "사용자가 이사했다"는 새 사실이 들어오면 예전 주소를 삭제하는 대신 "2026-03까지 유효했음"으로 표시 — NAGEX Memory에도 시점이 있는 사실(주소, 소속, 선호)에 이 패턴이 유용합니다. 지금처럼 덮어쓰기만 하면 나중에 "왜 바뀌었는지" 추적이 안 됩니다.
- **우선순위: 중간** — Memory Engine이 이미 존재하니 리팩터링 범위이고, 해커톤 데모 임팩트보다는 장기 품질에 기여하는 항목입니다.

---

## 2. 승인/Human-in-the-loop UX — Operator, Claude 제품군, Agent UX 패턴

### 조사 내용

**OpenAI Operator**: 로그인/결제 같은 민감 정보 입력 시 "테이크오버 모드"로 전환해 사용자가 직접 입력하게 하고, 그 순간엔 스크린샷/데이터 수집을 하지 않습니다. 주문 제출·메일 발송처럼 결과가 되돌리기 어려운 액션 직전에만 승인을 요구하고, 은행 거래·채용 결정 같은 카테고리는 아예 거부하도록 학습되어 있습니다. 금융/메일 사이트에서는 "watch mode"로 더 밀착 감시합니다.

**Anthropic의 컨테인먼트 설계** (claude.ai / Claude Code / Cowork 비교): 3단 방어선을 씁니다 — ① 환경 레이어(샌드박스·VM·egress 제한, 모델 행동과 무관하게 작동하는 하드 경계), ② 모델 레이어(시스템 프롬프트·분류기, 약 83% 정도만 걸러냄 — 단독으로는 불충분), ③ 외부 콘텐츠 레이어(툴 권한 세분화, MCP 서버 allowlist). 중요한 교훈: "커스텀 프록시/분류기보다 검증된 프리미티브(하이퍼바이저, seccomp, gVisor)가 훨씬 안정적이었다."

**Agent UX 패턴 (makeyouragent.ai)**: 실무적으로 꽤 정교한 패턴들이 있습니다.
- 승인은 "계속해도 됨"이라는 막연한 권한이 아니라 **정확히 하나의 액션 버전**에 묶여야 하고, 플랜이 바뀌면 기존 승인은 자동 만료.
- **Cancel(미래 작업 중단) / Undo(진짜 역연산으로 되돌림) / Compensate(되돌릴 수 없을 때 보정 액션 생성, 예: 환불)**를 별개 개념으로 분리.
- 부분 실패 시 "성공/실패/불명"을 뭉뚱그리지 않고 따로 보여주고, 실패 건별로 재시도/핸드오프 제공.
- **Effect Ledger**: 오케스트레이션 로그가 아니라 실제 시스템 레코드를 대조해서 "정말로 반영됐는지" 검증.

### NAGEX 적용 아이디어

- NAGEX Governance(`action-approval.store.ts`)에 **"승인은 정확한 액션 버전에 바인딩되고, 플랜이 수정되면 자동 만료"** 규칙이 있는지 점검해보세요. 없다면 이건 보안적으로 꽤 중요한 갭입니다 — 사용자가 A안을 승인했는데 실행 직전에 파라미터가 바뀐 B안이 그 승인으로 실행되는 사고를 막아줍니다.
- **Cancel/Undo/Compensate 3분리**는 지금 Task/Execution 상태 모델에 "취소됨" 한 종류만 있다면 검토할 가치가 큽니다. 특히 Gmail 발송처럼 진짜 undo가 불가능한 액션엔 "Compensate"(정정 메일 발송 제안) 경로가 필요합니다.
- Device/Browser Control에 Operator식 **테이크오버 모드**(로그인/결제 입력 시 자동으로 사용자에게 넘기고 그 구간은 로깅/스크린샷 안 함)를 넣으면 개인정보 보호 스토리도 강해지고 해커톤 심사에서 안전성 어필 포인트가 됩니다.
- Anthropic 사례에서 배울 점: **환경 레이어(샌드박스)가 1차 방어선**이어야 하고, 프롬프트/분류기 기반 안전장치(모델 레이어)는 보조 수단으로만 취급해야 합니다. NAGEX의 Device Control이 OS 레벨 격리 없이 분류기/정책 엔진에만 의존하고 있다면 이 부분을 재검토할 필요가 있습니다.
- **우선순위: 높음** — 승인 버전 바인딩/자동 만료는 지금 규모에서 바로 넣을 수 있고, 보안 성격상 나중에 넣을수록 리팩터링 비용이 커집니다.

---

## 3. 프로액티브 어시스턴트 / 알림 설계

### 조사 내용

**"Notification Budget" 개념**: 사용자는 하루 3~5개 알림이 한계치이고, 이걸 넘기면 몇 주 안에 기능을 꺼버립니다. 제안하는 구조:
1. 하드 일일 예산(3~5개)을 "가이드라인"이 아니라 시스템 제약으로 강제.
2. 가치(행동할 확률×가치) vs 주의 비용(방해 정도)을 스코어링해서 예산 안에서 우선순위 결정.
3. 행동함/무시함/끔 세 가지 피드백으로 사용자별 임계값을 계속 학습.
4. 여러 소스(캘린더/메일/작업 완료 알림 등)가 각자 알림을 쏘면 개별로는 "적당"해도 합쳐지면 과부하 — **하나의 "attention broker"**를 거치게 해야 함.
5. on/off 이진 스위치 대신 "조금만 줄여줘" 같은 점진적 완화.

**스마트 알림 triage 패턴**: 심각도(확신도×영향도) 분리 스코어링, 관련 이벤트 묶어서 하나로(70%까지 알림량 감소 사례), 디지털 배칭 윈도우(아침/점심 후/저녁), 캘린더+기기 상태+위치를 결합한 DND 로직, 채널별 에스컬레이션 사다리(긴급도별 SMS→Slack→다이제스트).

### NAGEX 적용 아이디어

- 지금 Notification Engine, Daily Brief, Proactive Assistant, Action Proposal이 각각 독립적으로 알림을 만들고 있다면, **공통 "Attention Broker" 레이어를 하나 두고 모든 프로액티브 알림이 그걸 거치게** 하는 게 핵심 아이디어입니다. 이게 없으면 각 기능은 "합리적"인데 합쳐지면 사용자가 하루에 알림을 10개씩 받는 전형적인 실패 패턴이 생깁니다.
- **하드 일일 예산 + 행동/무시 피드백 기반 임계값 조정**을 지금 단계에서 설계에 넣어두면, 나중에 기능이 늘어날수록(Gmail, Calendar, Task, Daily Brief, 새 capability마다) 알림이 산술급수적으로 늘어나는 걸 구조적으로 막을 수 있습니다.
- Daily Brief 자체가 이미 "디지털 배칭"의 좋은 예시입니다 — 이 패턴을 다른 저긴급 알림에도 확장해서, 긴급하지 않은 건 즉시 푸시하지 않고 다음 브리핑 사이클에 묶는 원칙을 명문화하면 좋습니다.
- **우선순위: 높음** — NAGEX가 "여러 개 통합 에이전트"라는 정체성상, 다른 개인 AI 제품보다 알림 소스가 원천적으로 많습니다. 지금 소스가 몇 개 안 될 때 broker 구조를 잡아두는 게, 소스가 10개로 늘어난 뒤 리팩터링하는 것보다 훨씬 쌉니다.

---

## 4. 오케스트레이션 / Durable Workflow

### 조사 내용

**체크포인트 ≠ Durable Execution (중요한 발견)**: LangGraph 같은 체크포인트 기반 시스템에 대한 비판인데, NAGEX에도 그대로 적용되는 질문입니다. 체크포인트는 "스냅샷"일 뿐이고, 다음을 개발자가 직접 책임져야 합니다.
- 프로세스가 죽었을 때 **자동으로 감지**하는 watchdog/heartbeat가 있는가?
- 감지 후 **자동으로 재개**되는가, 아니면 사람이 수동으로 재실행해야 하는가?
- 두 워커가 같은 작업을 동시에 재개 시도할 때 **중복 실행을 막는 조정 메커니즘**이 있는가?
- 단일 프로세스가 죽으면 그 안에서 돌던 모든 작업이 함께 죽는 구조는 아닌가?

**Orchestrator/Sub-agent 패턴**: 하위 에이전트로 위임하기 좋은 경우는 (a) 도메인 경계가 명확하고, (b) 특화 에이전트가 품질상 이득이 있고, (c) 여러 경로가 다 정답일 수 있는 탐색적 작업(예: 리서치)일 때입니다. 반대로 **컴플라이언스/승인처럼 "항상 같은 방식으로 정확해야 하는" 작업에는 멀티에이전트 위임이 적합하지 않습니다** — 하나의 명확한 순차 경로를 유지해야 합니다.

### NAGEX 적용 아이디어

- `DurableTaskRuntime`(`tasks/durable-task-runtime.ts`)이 위 4가지 질문에 실제로 어떻게 답하는지 한번 점검해볼 가치가 있습니다. 특히 "서버가 재시작되면 진행 중이던 task가 자동으로 재개되는가, 아니면 누군가 발견해서 수동으로 트리거해야 하는가"는 상용 서비스로 갈수록 치명적인 질문입니다.
- **멀티에이전트 오케스트레이터(`agent/multi-agent.orchestrator.ts`)를 어디에 쓸지 기준을 명확히 하는 게 좋습니다**: Daily Brief 생성이나 리서치성 작업처럼 탐색적인 곳엔 멀티에이전트가 맞고, Approval/Governance처럼 결정론적으로 동작해야 하는 경로는 절대 멀티에이전트 위임 구조에 넣지 않아야 합니다 — 지금 설계 방향(Approval은 별도 결정론적 파이프라인)과 일치하니 이 원칙을 문서화해두면 좋습니다.
- **우선순위: 중간~높음** — 상용 서비스 안정성과 직결되는 부분이라, 지금 확인만 해두고 실제 보강은 R10.2 이후 안정화 단계에서 진행해도 됩니다.

---

## 5. 모델 게이트웨이 / 라우팅

### 조사 내용

**OpenRouter**: 같은 모델을 제공하는 여러 provider 중에서, ① 최근 장애난 provider는 후순위로 밀고, ② 가격의 역제곱 가중치로 저렴한 쪽에 트래픽을 더 많이 보내고(1달러짜리가 3달러짜리보다 약 9배 더 자주 선택), ③ 나머지는 폴백 순서로 둡니다. `auto` 라우터는 프롬프트를 태스크 유형으로 분류한 뒤, 최근 7일간 커뮤니티 지출 패턴으로 랭킹을 매겨 모델을 고릅니다. 실패한 요청은 과금하지 않는 "zero-completion insurance"도 특징입니다.

**LiteLLM**: 요청이 인증→예산 체크→(전역/키/유저/팀 4단계) rate limit→라우팅(로드밸런싱/폴백/재시도)→provider 포맷 변환→실제 호출 순으로 흐르고, **응답을 클라이언트에 먼저 보낸 뒤 로깅/과금 기록은 비동기로 처리**해서 응답 지연에 영향을 주지 않습니다.

### NAGEX 적용 아이디어

- NAGEX Model Gateway(`ai-service.ts`, `unified-model-router.ts`)에 **가격 가중 폴백 순서**(동급 모델 중 저렴한 쪽 우선, 장애 난 provider 자동 후순위)를 넣으면 Nebius Token Factory + 다른 provider를 섞어 쓸 때 비용 최적화가 자동화됩니다.
- **과금/사용량 로깅을 요청-응답 경로에서 분리해 비동기로 처리**하는 것 — 이건 지금 바로 점검해볼 가치가 있습니다. 만약 현재 `BillingLedgerEngine`/`CreditEngine` 기록이 응답 반환 전에 동기적으로 일어난다면, 사용자 체감 지연시간에 그대로 반영되고 있을 가능성이 큽니다.
- 해커톤 스토리 관점에서, "저비용 작업은 작은 Nemotron 모델로, 복잡한 플래닝은 큰 모델로" 자동 분기하는 auto-router 개념을 넣으면 Nebius/NVIDIA 스택 활용을 "그냥 API 호출"이 아니라 "지능적인 비용/성능 라우팅"으로 보여줄 수 있습니다.
- **우선순위: 중간** — 비용 최적화 성격이라 기능 완성도에 직접 영향은 없지만, 비동기 로깅 분리는 체감 성능에 즉시 영향을 주니 빠르게 확인해볼 만합니다.

---

## 6. 경쟁 개인 AI 제품 벤치마킹 — Dot, Rewind/Limitless

### 조사 내용

두 제품 모두 최근 사업을 접었습니다: **Dot(New Computer)**는 2025년 9월 서비스 종료를 발표했고, **Rewind**는 Limitless로 리브랜딩 후 하드웨어(펜던트)로 피벗했다가 2025년 Meta에 인수된 뒤 2025년 12월 앱 자체가 종료됐습니다. 두 사례 모두에서 나온 핵심 교훈은 "친밀한 개인 데이터가 스타트업의 런웨이(자금 사정)에 종속된 서버에 있으면 안 된다"는 것 — 서비스가 접히는 순간 사용자는 축적된 맥락/기억을 통째로 잃습니다.

반면 Dot의 UX 설계 자체는 평가가 좋았습니다:
- **부드러운 온보딩**: 긴 튜토리얼 대신 짧고 친근한 화면, 사용자가 답하기 쉬운 칩(chip) 형태 질문으로 시작.
- **"Chronicles"**: 대화 이력을 타임라인으로 보여주고 사용자가 직접 편집/고정(pin)/삭제할 수 있게 해서 "블랙박스"가 아니라 투명한 도구로 느끼게 함.
- **출처 표시**: 이 정보가 "내가 예전에 쓴 메모"에서 왔는지 "외부 정보"에서 왔는지 명시.
- **할 수 있는 것/못 하는 것을 명확히 정의**해서 오히려 신뢰를 얻음.

### NAGEX 적용 아이디어

- NAGEX 사이트에 이미 있는 "Personal Memory (열람·통제 가능)" 컨셉을 Dot의 **Chronicles처럼 타임라인 UI + 항목별 edit/pin/delete + 출처 표시**로 구체화하면, 설계만 놓고 봐도 이미 검증된 신뢰 구축 패턴을 따라가는 셈입니다.
- **데이터 이식성(export)을 정체성으로 내세우기**: Dot·Rewind 둘 다 "서비스가 접히면 데이터도 사라진다"는 문제로 사용자 신뢰를 잃었습니다. NAGEX가 "당신의 메모리는 언제든 내보낼 수 있고, 서비스 존속에 종속되지 않는다"는 걸 명시적 기능(예: 메모리 전체 export)과 메시지로 내세우면, 마침 최근 업계에서 회자되는 이 실패 사례들과 대비되는 차별점이 됩니다 — 해커톤 심사에서도 "왜 우리가 다른가"에 대한 설득력 있는 답이 됩니다.
- **우선순위: 중간** — Chronicles식 UI는 이미 계획된 "Personal Memory" 기능의 구체화이니 개발 순서상 자연스럽게 들어갈 수 있고, export 기능은 작지만 스토리 임팩트가 큰 항목입니다.

---

## 종합 우선순위 제안

| 우선순위 | 항목 | 이유 |
|---|---|---|
| 높음 | 승인 버전 바인딩 + 자동 만료 (§2) | 지금 안 넣으면 나중에 보안 사고 리스크, 리팩터링 비용도 계속 증가 |
| 높음 | 프로액티브 알림 Attention Broker (§3) | 알림 소스가 늘어나기 전에 구조를 잡아야 나중에 산술급수적 리팩터링을 피함 |
| 중간~높음 | Durable Task Runtime 자가진단 (§4) | 상용 서비스 안정성 직결, 지금은 점검만 해도 충분 |
| 중간 | Memory 계층 분리 + decay (§1) | 품질 개선 항목, 급하지 않지만 손댈수록 커짐 |
| 중간 | Model Gateway 비동기 로깅/가격 가중 라우팅 (§5) | 체감 성능·비용에 즉시 영향, 구현 난이도 낮음 |
| 중간 | Chronicles식 메모리 UI + 데이터 export (§6) | UX 신뢰 구축 + 해커톤 차별화 스토리 |

---

## 참고 자료 (Sources)

- [Letta (MemGPT) Walkthrough](https://sureprompts.com/blog/letta-memgpt-walkthrough)
- [Mem0: AI Agent Memory Guide](https://mem0.ai/blog/memory-in-agents-what-why-and-how)
- [Zep: A Temporal Knowledge Graph Architecture for Agent Memory (arXiv)](https://arxiv.org/abs/2501.13956)
- [Introducing Operator — OpenAI](https://openai.com/index/introducing-operator/)
- [How we contain Claude — Anthropic](https://www.anthropic.com/engineering/how-we-contain-claude)
- [Agent UX Patterns for Safe, Reversible Product Actions](https://makeyouragent.ai/blog/agent-ux-patterns-visible-reversible-workflows)
- [Background Agents and the Notification Budget](https://tianpan.co/blog/2026-05-13-background-agents-notification-budget-attention-economy)
- [Agent Notification Intelligence — Zylos Research](https://zylos.ai/research/2026-04-23-agent-notification-intelligence-smart-alerting-triage/)
- [Why Checkpoints Aren't Durable Execution — Diagrid](https://www.diagrid.io/blog/checkpoints-are-not-durable-execution-why-langgraph-crewai-google-adk-and-others-fall-short-for-production-agent-workflows)
- [Orchestrator and sub-agent multi-agent patterns — Microsoft Learn](https://learn.microsoft.com/en-us/agents/architecture/multi-agent-orchestrator-sub-agent)
- [How OpenRouter Model Routing Works](https://openrouter.ai/blog/insights/model-routing/)
- [LiteLLM Proxy Architecture — Life of a Request](https://docs.litellm.ai/docs/proxy/architecture)
- [Dot by New Computer is shutting down — Kin](https://mykin.ai/resources/dot-by-new-computer-alternative)
- [What Happened to Rewind AI](https://rewind.ai/what-happened-to-rewind/)
- [AI Design Pattern #1 — Dot](https://medium.com/design-bootcamp/ai-design-pattern-1-dot-my-take-as-a-designer-363b63ed489a)

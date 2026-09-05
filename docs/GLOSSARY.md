# AGEX Canonical Glossary (표준 용어집)

AGEX(AI Operating System) 전반에서 일관되게 사용되는 공식 표준 용어 정의입니다.

---

## 1. Core Abstractions

### Resource
- AGEX 내에서 식별 가능한 모든 First-Class 엔티티 (Agent, Workflow, KnowledgeCollection, Memory, Plugin, Model, Policy 등).
- 공통적으로 `Metadata`, `Specification`, `Status` 3대 하위 구조를 가집니다.

### Specification (Desired State)
- 사용자가 원하고 정의한 Resource의 상태 및 사양 사양서. Published 상태에서는 Immutable(불변)합니다.

### Status (Observed State)
- Platform 및 Runtime이 관측한 Resource의 실시간 운영/상태값. 사용자가 직접 API로 값을 덮어쓸 수 없습니다.

### Version vs Revision
- **Version**: 검증을 마치고 게시(Publish)된 불변의 공식 계약 버전 (예: `v1`, `v2`).
- **Revision**: Draft(초안) 상태에서 편집/수정될 때 증가하는 내부 작업 버전 (예: `rev 1`, `rev 2`).

### Tenant
- AGEX의 최상위 격리 경계(Logical Security Boundary). 모든 Resource는 `PLATFORM` 또는 `TENANT` Scope에 속합니다.

---

## 2. Execution & Runtime

### Agent
- AGEX 내 자율적 또는 정책에 따라 목표(Goal)를 수행하는 기본 AI 실행 주체.

### Workflow
- 복수 단계(Step)와 조건(Edge)으로 구성된 내구성 있는 비동기 실행 그래프 (Durable Execution Graph).

### Execution
- Agent 또는 Workflow가 실제 실행될 때 생성되는 불변의 실시간 Runtime 인스턴스.

### Task
- Runtime Scheduler가 Worker에 디스패치(Dispatch)하는 최소 실행 단위.

### Operation
- Export, Import, Migration 등 장시간 수행되는 관리형 비동기 작업.

---

## 3. Context & Intelligence

### Knowledge
- 출처(Source)가 명확하고 지속 검증된 공식 도메인 지식 데이터.

### Memory
- Agent의 실행 및 사용자 대화 과정에서 생성된 맥락, 경험 및 프로포절 데이터.

---

## 4. Extension & Model Integration

### Plugin vs Tool
- **Plugin**: 외부 기술 패키지 단위 (Manifest, Capability, Actions, Egress 허용 목록 등 포함).
- **Tool**: 에이전트에 바인딩되어 호출 가능한 실제 인터페이스/기능.

### Model vs Provider
- **Provider**: Model 공급 엔드포인트/주체 (예: OpenAI, Anthropic, Private Cluster).
- **Model**: Provider를 통해 제공되는 구체적인 AI Capability 리소스.

---

## 5. Security & Governance

### Capability
- 시스템/모델/플러그인이 기술적으로 수행 가능한 기능 범위.

### Permission
- 특정 Principal이 특정 Resource/Action에 대해 수행하도록 부여받은 보안 허용 권한.

### Policy
- 실행 시점의 Context(시간, IP, 리스크 등)를 결합하여 최종 접근 허용 여부(`ALLOW`/`DENY`/`CONDITIONAL`)를 판단하는 머신 읽기 가능 규칙. `CONDITIONAL`은 즉시 허용/차단이 아니라 Approval(아래 참고)이 선행되어야 함을 뜻한다.

### Entitlement
- 테넌트가 계약(Subscription/Plan)상 이용 가능한 상업적 자격/권리. (보안 권한인 Permission과 절대 혼용 금지)

### Approval
- 고위험 Action 수행 전 인간(Human-in-the-loop) 또는 자동화 시스템의 명시적 승인 절차.

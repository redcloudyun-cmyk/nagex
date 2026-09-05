# AGEX MASTER SPECIFICATION

**30종 공식 문서 통합 검증 및 최상위 개발 명세 체계 (Single Source of Truth)**

- **문서 등급**: LEVEL 0 — 최상위 SSOT
- **적용 대상**: Product / Architecture / Backend / Runtime / AI / Security / DevOps / QA / SDK / Console / Operations
- **상태**: 공식 기준안

---

## 1. 본 문서의 목적
AGEX 30종 공식 문서와 Supplemental 명세(S-01 ~ S-06)의 의미, 규격, 우선순위를 하나로 통합하여 AGEX 개발에서 사용되는 모든 공식 개념, Resource, Contract, 책임, 상태, 보안 경계 및 구현 우선순위의 최상위 기준을 SSOT(Single Source of Truth) 체계로 고정한다.

---

## 2. 문서 권한 계층 (Document Hierarchy)

| 계층 | 문서 구분 | 대표 문서 | 역할 및 해석 원칙 |
|---|---|---|---|
| **LEVEL 0** | 최상위 SSOT | `MASTER.md` (S-01) | 문서 간 충돌 해결, 용어 통합, Domain Boundary, 구현 순서 결정. 하위 문서와 충돌 시 LEVEL 0 우선. |
| **LEVEL 1** | Product Constitution | `01-product-vision.md`, `02-product-philosophy.md` | AGEX가 무엇이고 무엇이 아닌지를 결정하는 절대적 제품 철학. |
| **LEVEL 2** | System Architecture | `03-product-architecture.md` ~ `05-runtime-architecture.md`, `14`~`17` | 시스템 구조, 보안, 멀티테넌트, 배포 및 거버넌스의 경계 기준. |
| **LEVEL 3** | Domain Specifications | `06-agent-framework.md` ~ `13-api-specification.md`, Supplemental Specs (S-03 ~ S-07) | 개발팀이 각 도메인을 직접 구현하는 핵심 사양 명세. |
| **LEVEL 4** | Execution Planning | `18-product-roadmap.md` ~ `23-cost-estimation.md` | WBS, 개발 일정, 예산 계획. **Core Architecture를 변경할 권한 없음.** |
| **LEVEL 5** | Commercial | `24-business-model.md` | 아키텍처의 Capability를 상품화하는 비즈니스 모델. Security Architecture보다 후순위. |
| **LEVEL 6** | Explanatory Docs | `25-technical-white-paper.md` ~ `30-developer-guide.md` | 기술 설명서 및 개발 가이드. 상위 명세가 우선. |

---

## 3. 핵심 개발 원칙 20선

1. **모든 주요 AI 구성요소는 Resource다**: Agent, Workflow, Knowledge, Memory, Plugin, Model 등은 독립적인 First-Class Resource로 관리한다.
2. **모든 Resource는 명시적 Scope를 가진다**: `PLATFORM` 또는 `TENANT` Scope 중 하나를 명확히 갖는다.
3. **Tenant Context 없는 Tenant 작업은 실패한다**: Multi-Tenant 환경에서 Tenant ID와 Context 검증은 필수이며 미지정 시 Fail-Closed 처리한다.
4. **Published Version은 Immutable하다**: 승인/게시된 버전은 불변이며 변경 시 새로운 Version/Revision을 생성한다.
5. **실제 실행은 Runtime을 통과한다**: 컨트롤 플레인 조작 및 실행은 반드시 Runtime 엔진 및 Security Gate를 통과해야 한다.
6. **Queue는 Source of Truth가 아니다**: Queue는 단순 전달 메커니즘일 뿐, Durable Execution Store가 실제 상태의 원천이다.
7. **Model Output은 권한이 아니다**: LLM이 생성한 결과는 실행 권한을 담보하지 않으며 IAM/Policy 검증을 거쳐야 한다.
8. **Capability와 Permission은 다르다**: Capability는 기술적 기능, Permission은 허용된 보안 권한이다.
9. **Entitlement와 Permission은 다르다**: Entitlement는 상업 계약 자격, Permission은 IAM 보안 접근 권한이다.
10. **Knowledge와 Memory는 다르다**: Knowledge는 출처가 명확한 공식 지식, Memory는 실행 과정에서 형성된 맥락/경험이다.
11. **Plugin과 Tool은 다르다**: Plugin은 기술 패키지 단위이며, Tool은 에이전트에 바인딩된 실행 가능 인터페이스다.
12. **Secret은 Prompt에 들어가지 않는다**: Secret 값은 별도의 Secret Store 및 SecretReference로 처리한다.
13. **Cross-Tenant는 Default Deny다**: 테넌트 간 데이터/실행 접근은 명시적 Trust Contract 없이는 기본 차단한다.
14. **AI Action은 Schema Validation을 거친다**: 입출력 데이터 형태는 Canonical Schema에 의한 철저한 검증을 받는다.
15. **Side Effect는 명시적으로 분류한다**: `READ_ONLY`, `REVERSIBLE_WRITE`, `IRREVERSIBLE_WRITE`, `PRIVILEGED_ACTION`으로 명시한다.
16. **Retry는 Bounded다**: 무한 재시도를 금지하며 Bounded Retry Policy를 적용한다.
17. **Autonomy는 Bounded다**: 자율성 등급(L0~L5)을 엄격히 제한하고 L2 이상은 승인 절차를 거친다.
18. **Raw CoT를 운영 Contract로 사용하지 않는다**: 추론 과정(CoT)은 참고용이며 최종 결과/구조화된 결정을 저장한다.
19. **모든 기능은 관측 가능해야 한다**: Audit, Usage, Metric, Trace가 기록되어야 완료로 간주한다.
20. **Code보다 Contract가 먼저다**: 스키마(Schema)와 계약(Contract)이 확정된 후 코드를 구현한다.

---

## 4. 로드맵 및 단계별 구현 (Phases 0 ~ 11)

- **PHASE 0 — Contract Foundation**: Canonical Glossary, Resource Model, IDs, Error/Event Envelope, Tenant Context, Auth, Schema Repository
- **PHASE 1 — Core**: Tenant, Identity, Registry, Lifecycle, Audit
- **PHASE 2 — Runtime**: Execution, Task, Queue, Worker, State, Retry, Timeout, Cancellation, Checkpoint, Recovery
- **PHASE 3 — Model Gateway**: Provider, Model Registry, Adapter, Router, Usage, Health, Fallback
- **PHASE 4 — Agent**: L0-L2 Execution, Context, Structured Action, Tools
- **PHASE 5 — Workflow**: Durable Graph, Wait, Approval, Branch, Retry
- **PHASE 6 — Context**: Knowledge, Memory
- **PHASE 7 — Extension**: Plugin, Sandbox, Credential Broker
- **PHASE 8 — Developer Platform**: API, SDK, CLI, Console
- **PHASE 9 — Enterprise**: Advanced Security, Governance, Dedicated Deployment
- **PHASE 10 — Ecosystem**: Marketplace, Billing, Entitlement
- **PHASE 11 — Autonomous**: L3-L5, Multi-Agent, Dynamic Planning

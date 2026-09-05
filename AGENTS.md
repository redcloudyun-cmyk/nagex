# AGEX Development Instructions & AI Coding Agent Harness

AGEX(AI Operating System) 프로젝트의 최상위 AI Coding Agent 지침 문서입니다.  
Codex, Claude, Gemini 등 모든 AI Coding Agent는 AGEX 관련 작업을 수행할 때 반드시 본 문서의 규칙을 준수해야 합니다.

---

## 1. 목적 및 탐색 계층 (Navigation Hierarchy)
AGEX는 전체 문서량이 방대하므로 에이전트가 모든 문서를 매번 통째로 읽는 방식은 비효율적입니다.  
Coding Agent는 항상 다음 지침 계층 순서에 따라 필요한 문서만 선택적으로 확인하여 작업을 수행합니다.

```
AGENTS.md (최상위 실행 지침)
 ↓
MASTER.md (통합 SSOT & 설계 철학)
 ↓
docs/INDEX.md (문서 색인 및 필독 가이드)
 ↓
Relevant Domain Specification (해당 작업 도메인 명세)
 ↓
Canonical Schema (specs/schemas/ 표준 데이터 계약)
 ↓
Implementation (실제 코드 수정 및 구현)
```

---

## 2. AI Coding Agent 작업 수행 7단계 절차
모든 코드 수정 및 작업 진행 시 에이전트는 다음 순서를 엄격히 이행합니다:

1. **Governing Specification 확인**: 현재 작업에 적용되는 상위 명세(Specification)를 밝힌다.
2. **기존 코드 탐색**: 관련 기존 구현 코드를 검토한다.
3. **불일치 식별**: 명세와 기존 코드 간의 갭(Gap) 및 불일치(Mismatch)를 식별한다.
4. **명세 우선 적용**: 어쩌다 남아있는 레거시 코드보다 명세(Specification)를 우선시한다.
5. **최소 변경 원칙**: 아키텍처 경계를 보존하는 가장 작고 일관된 변경(Smallest Coherent Change)을 수행한다.
6. **계약 테스트 추가**: 구현하는 계약/기능에 대한 테스트(Unit/Integration/Contract Test)를 작성한다.
7. **충돌 보고**: 해결되지 않은 아키텍처 충돌이 있을 경우 즉시 보고한다.

---

## 3. 핵심 개발 원칙 (20대 절대 원칙)
1. **모든 주요 AI 구성요소는 Resource다.** (Agent, Workflow, Knowledge, Memory, Plugin, Model 등)
2. **모든 Resource는 명시적 Scope를 가진다.** (`PLATFORM` 또는 `TENANT`)
3. **Tenant Context 없는 Tenant 작업은 실패한다.** (Tenant Isolation 및 Fail-Closed 기본)
4. **Published Version은 Immutable하다.** (직접 수정 금지, Versioning/Revision으로 관리)
5. **실제 실행은 Durable Runtime을 통과한다.**
6. **Queue는 Source of Truth가 아니다.** (Dispatch Mechanism일 뿐, Durable Execution Store가 SSOT)
7. **Model Output은 권한이 아니다.**
8. **Capability와 Permission은 다르다.** (Capability = 기술적 가능 기능, Permission = 허용된 행동)
9. **Entitlement와 Permission은 다르다.** (Entitlement = 상업 계약 자격, Permission = IAM 보안 권한)
10. **Knowledge와 Memory는 다르다.** (Knowledge = 출처 기반 공식 정보, Memory = 실행/대화 컨텍스트)
11. **Plugin과 Tool은 다르다.** (Plugin = 패키지, Tool = 에이전트 호출 가능 인터페이스)
12. **Secret은 Prompt, Log, Instruction, Workflow Variable에 들어가지 않는다.** (SecretReference 사용)
13. **Cross-Tenant 접근은 Default Deny다.**
14. **모든 AI Action은 Schema Validation을 거친다.**
15. **Side Effect는 명시적으로 분류한다.** (`READ_ONLY`, `REVERSIBLE_WRITE`, `IRREVERSIBLE_WRITE`, `PRIVILEGED_ACTION`)
16. **Retry는 Bounded(상한선 존재)해야 한다.**
17. **Autonomy는 Bounded(L0~L5 제한)해야 한다.**
18. **Raw Chain-of-Thought(CoT)를 운영 Contract나 Audit 근거로 사용하지 않는다.**
19. **모든 기능은 관측 가능(Observability)해야 한다.**
20. **Code보다 Contract(Specification & Schema)가 먼저다.**

---

## 4. Specification Gap 발생 시 행동 수칙
필요한 소프트웨어 계약이 명세에 명확히 정의되어 있지 않은 경우:
- 임의로 추측하여 독자적인 라이브러리/규칙을 만들지 않는다.
- 누락된 계약(Specification Gap)을 명확히 식별하고 사용자에게 보고한다.
- 명세와 호환되는 가장 작은 대안을 제안한다.
- 임시 구현이 필요한 경우 분명한 인터페이스 또는 `TODO` 주석 뒤에 격리한다.

---

## 5. 금지 사항 (Prohibitions)
- DB Table이나 UI Form을 API Schema의 Source of Truth로 역전시키는 행위
- `data: any` 형태의 검증 없는 범용 구조로 Resource 저장
- Published Version 직접 수정 및 Posted Ledger Entry 삭제
- Raw Secret/Key/Password를 파일 및 로그에 저장하는 행위
- Security Permission과 Commercial Entitlement를 단일 Boolean으로 통합하는 행위
- Entitlement 장애 시 Production Execution 전체를 무조건 동기적 즉시 중단시키는 행위 (Grace Policy 활용)

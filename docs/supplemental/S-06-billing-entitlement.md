# S-06. AGEX Billing & Entitlement Architecture

- **문서 등급**: LEVEL 3 — Commercial & Platform Control Specification
- **상위 문서**: [MASTER.md](file:///f:/개발%20프로젝트/Agex%20project/MASTER.md)
- **상태**: 공식 기준안

---

## 1. 개요
AGEX Billing & Entitlement Architecture는 Platform Capability를 계약 가능한 권리(Entitlement)로 정의하고, 실제 AI 실행과 사용량을 감사 가능한 `Usage Record -> Meter -> Rating -> Billing Ledger -> Invoice` 구조로 변환하는 상용화 제어 체계입니다.

## 2. 4대 개념 분리 절대 원칙

$$\text{Entitlement} \neq \text{Permission} \neq \text{Usage} \neq \text{Billing}$$

- **Entitlement**: 계약상 해당 기능을 사용할 자격이 있는가.
- **Permission**: 현재 Principal이 실제 행동을 수행할 보안 권한이 있는가.
- **Usage**: 실제로 얼마나 사용했는가 (Immutable Record).
- **Billing**: 사용량과 계약 조건을 금액으로 계산하는 과정.

## 3. 핵심 규칙
1. **Ledger Immutability**: 이미 확정 및 기록된 Posted Ledger Entry는 직접 삭제/수정할 수 없으며 반대 방향의 `Adjustment Entry`로 정정한다.
2. **Billing Restricted vs Security Suspended**:
   - `Billing Restricted`: 결제 지연 등으로 인한 상업적 기능 제한 (신규 생성 금지, 읽기/내보내기는 허용 가능).
   - `Security Suspended`: 보안 사고로 인한 즉시 차단.
3. **Usage Event Idempotency**: Network Retry 및 Replay로 인해 동일 사용량이 중복 청구되지 않도록 `idempotency_key`를 강제한다.

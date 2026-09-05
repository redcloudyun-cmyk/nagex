# S-05. AGEX Identity & Access Management (IAM) Specification

- **문서 등급**: LEVEL 3 — Core Security Specification
- **상위 문서**: [MASTER.md](file:///f:/개발%20프로젝트/Agex%20project/MASTER.md)
- **상태**: 공식 기준안

---

## 1. 개요
AGEX IAM은 단순 로그인 체계가 아니며, 모든 Human User, Service, Workload, Agent 및 System Actor를 각각 독립적인 Principal로 식별하고 Zero-Trust 기반으로 통제하는 공식 Access Control Layer입니다.

## 2. 최종 Authorization 결정식

최종 접근 권한(`ALLOW`/`DENY`/`CONDITIONAL`)은 다음 요소의 교집합(Intersection)으로 계산합니다:

$$\text{Decision} = \text{Identity} \cap \text{Membership} \cap \text{Role} \cap \text{Permission} \cap \text{Tenant Scope} \cap \text{Resource Scope} \cap \text{Policy} \cap \text{Resource State} \cap \text{Runtime Context}$$

`CONDITIONAL`은 High/Critical-Risk Action(MASTER.md 원칙 #17 — Autonomy L2 이상)에 대해 즉시 ALLOW하지 않고 Approval을 선행 요구하는 결정이다 (구현: `src/identity/pdp.ts`).

## 3. 핵심 규칙
1. **User와 Membership 분리**: 한 User가 여러 Tenant에 소속될 수 있으며 Tenant마다 다른 Role을 가집니다 (`User ≠ Membership`).
2. **Agent Identity 격리**: Agent는 User 권한을 자동 상속하지 않으며 명시적으로 위임된 Delegated Scope 내에서만 실행됩니다.
3. **Deny by Default**: 명시적으로 허용되지 않은 모든 Action은 차단(`DENY`)됩니다.
4. **Privileged Access 통제**: 테넌트 삭제, 권한 변경, 시크릿 접근 등 고위험 Action은 JIT(Just-In-Time), MFA, Expiration 및 Audit 대상입니다.

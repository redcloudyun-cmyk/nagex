# S-04. AGEX Model Gateway & Model Router Architecture

- **문서 등급**: LEVEL 3 — Domain Supplemental Specification
- **상위 문서**: [MASTER.md](file:///f:/개발%20프로젝트/Agex%20project/MASTER.md)
- **상태**: 공식 기준안

---

## 1. 개요
Model Gateway 및 Model Router는 AGEX의 에이전트 및 워크플로우가 특정 AI Model/Provider 구현에 직접 결합(Tight-Coupling)되지 않도록 격리하는 **공식 AI 통신 및 라우팅 컨트롤 플레인**입니다.

## 2. 라우팅 결정 9단계 순서 (Official Routing Order)

모든 모델 요청은 다음 순서로 엄격하게 라우팅 모델을 선별합니다. **Cost가 Security보다 앞설 수 없습니다.**

```
1. Required Capability (요청된 필수 능력: Tool Call, Structured Output 등)
 ↓
2. Data Classification (데이터 보안 등급: PUBLIC, INTERNAL, CONFIDENTIAL, RESTRICTED)
 ↓
3. Platform Security Policy (플랫폼 보안 정책)
 ↓
4. Tenant Model Policy (테넌트 모델 설정 정책)
 ↓
5. Region / Data Residency (지역 및 데이터 거주성 제약)
 ↓
6. Provider Trust Class (Provider 등급: PRIVATE, DIRECT_APPROVED, ENTERPRISE_APPROVED 등)
 ↓
7. Quality Requirement (품질 하한선 사양)
 ↓
8. Provider Health & Latency (실시간 노드 상태 및 응답 지연 시간)
 ↓
9. Cost Budget (비용 예산 제약)
```

## 3. 핵심 규칙
- **Model Alias 금지**: Production 재현성을 위해 변동 가능한 `latest` Alias 사용을 금지하며, `Requested Model ID`, `Resolved Model`, `Provider Version Metadata`, `Model Profile Version`을 함께 기록한다.
- **Provider Class 구분**:
  - `PRIVATE`: 테넌트 전용 자체 모델
  - `DIRECT_APPROVED`: 플랫폼이 직연결 승인한 모델
  - `ENTERPRISE_APPROVED`: 기업 계약 승인 모델
  - `AGGREGATOR`: 서드파티 중계 서비스

# S-07. AGEX Billing & AI Provider Architecture

- **문서 등급**: LEVEL 3 — Domain Supplemental Specification
- **상위 문서**: [MASTER.md](file:///f:/개발%20프로젝트/Agex%20project/MASTER.md)
- **상태**: 공식 기준안 (Phase 1만 구현됨 — 아래 각 섹션에 구현 상태 표기)
- **기준일**: 2026-08-28
- **범위**: Billing, Credits, Model Gateway, Provider Connection, BYOK, Enterprise AI, Private Model, Usage Metering, Settlement, Entitlement

> **구현 상태 안내**: 이 문서는 사용자가 제공한 "AGEX Billing & AI Provider Architecture Development Specification"을 canonical 문서 체계에 편입한 것이다. 문서 자체는 Phase 1~5 전체를 정의하지만, **실제 구현은 Phase 1(Billing Foundation)까지만 완료**되었다 (2026-08-28, `src/billing/credit.engine.ts`). Phase 2~5(BYOK, Enterprise AI, Private Model, Advanced Billing/Settlement)는 아래 각 섹션에 **[미구현]**으로 표시되어 있으며, 코드가 아니라 명세로만 존재한다. `docs/INDEX.md`의 기존 관례(미작성 문서를 필독 목록처럼 보이게 하지 않는다)를 그대로 따른다.

---

## 1. 목적

본 문서는 AGEX의 AI 사용 과금 체계와 외부 LLM 연결 구조를 정의한다.

AGEX는 특정 LLM 공급자로부터 토큰을 단순 재판매하는 구조를 지향하지 않는다. AGEX의 과금 체계는 다음 두 요소를 분리하여 설계한다.

1. **LLM/AI Provider 사용 원가**
2. **AGEX Runtime 및 플랫폼 사용 가치**

AGEX는 일반 사용자에게는 통합 크레딧 기반의 간단한 사용 경험을 제공하고, 고급 사용자·개발자·기업 고객에게는 자체 LLM API Key 또는 사내 AI 인프라를 연결할 수 있도록 한다.

최종적으로 AGEX는 아래 4개 Provider Source를 동일한 Model Gateway에서 처리한다.

- AGEX Managed AI — **[Phase 1, 구현됨]**
- BYOK (Bring Your Own Key) — **[Phase 2, 미구현]**
- Enterprise AI Provider — **[Phase 3, 미구현]**
- Private / Local Model — **[Phase 4, 미구현]**

---

## 2. 핵심 설계 원칙

### 2.1 기본 원칙

AGEX의 기본 사용자 경험은 **AGEX Managed AI**로 한다. 사용자는 개별 LLM 서비스를 인지하거나 API Key를 입력하지 않아도 AGEX Credit을 사용하여 AI 기능을 이용할 수 있어야 한다.

### 2.2 선택권 원칙 **[Phase 2, 미구현]**

사용자는 희망 시 자신의 AI Provider를 직접 연결할 수 있어야 한다.

지원 대상 예시: OpenAI, Anthropic, Google Gemini, DeepSeek, Qwen, OpenRouter, Azure OpenAI, AWS Bedrock, Google Vertex AI, vLLM, Ollama, TGI, SGLang, 사내 Private Endpoint.

### 2.3 Credit ≠ Token 원칙 — **[Phase 1, 구현됨]**

AGEX Credit은 특정 LLM의 Token 단가와 1:1 또는 고정 비율로 대응하지 않는다. AGEX Credit은 다음 비용을 통합 표현하는 **AGEX Compute Unit**으로 정의한다: LLM inference, Agent Runtime, Workflow execution, Tool invocation, Web browsing, RAG retrieval, Embedding, Memory operation, Document processing, Code execution, Image generation, Storage, Sandbox, External API execution, Premium capability.

구현 범위: 현재 `computeCreditCost()`(`src/billing/credit.engine.ts`)는 이 원칙 중 LLM/Runtime 비용 합산 + Margin 계산만 구현하며, 나머지 세부 단위(Tool/RAG/Storage 등)는 breakdown 입력값으로 받는 자리만 마련해두고 실제 계량 로직은 해당 도메인이 실제로 존재할 때 채운다.

### 2.4 Provider 독립성 원칙 — **[Phase 1, 구현됨]**

Billing Engine은 특정 AI Provider의 가격 정책에 종속되지 않는다. 각 Provider의 원가는 내부 Price Catalog(`ProviderPriceCatalog`)로 관리하고, 사용자에게 노출되는 AGEX Credit 가격은 별도의 Pricing/Margin 계산으로 산출한다.

---

## 3. Provider Source 모델

### 3.1 AGEX Managed AI — **[Phase 1, 구현됨]**

AGEX가 AI Provider 계정 및 비용을 관리하는 기본 방식.

```text
User → AGEX Credit → Agent/Workflow → Model Gateway → Model Router
     → OpenAI/Anthropic/Gemini/DeepSeek/Qwen/etc. → AGEX Provider Account
```

비용 구조: 사용자는 Subscription + AGEX Credit, AGEX는 AI Provider API Cost + Infrastructure Cost + Runtime Cost를 부담한다.

**구현 참고**: 현재 AGEX는 실제 LLM Provider를 호출하지 않는다(별도로 보류된 결정, 2026-08-31 이후 재검토). 따라서 `chargeCredits()`는 실제 API 응답이 아니라 **공급된 비용 breakdown**을 기준으로 계산한다 — Managed AI 흐름의 과금 로직만 선구현하고, 실제 Provider 호출은 이후 연결한다.

### 3.2 BYOK — **[Phase 2, 미구현]**

사용자가 자신의 API Key를 AGEX Model Gateway에 연결하는 방식. `provider_connections.credential_ref`가 Secret Vault를 전제로 하는데, AGEX에는 아직 Secret Vault가 없다 (원칙 #12 위반 방지를 위해 미구현 상태 유지). BYOK 사용 시 LLM Token Cost는 사용자→Provider 직접 청구, AGEX Runtime Cost만 AGEX Credit에서 차감하는 구조로 설계되어 있다.

### 3.3 Enterprise AI Provider — **[Phase 3, 미구현]**

기업이 기존 계약한 AI 플랫폼(Azure OpenAI, AWS Bedrock, Google Vertex AI, Private Anthropic Endpoint, Corporate AI Gateway)을 연결하는 방식. Enterprise License + Seat/Workspace + Runtime + Governance + Support/SLA로 과금.

### 3.4 Private / Local Model — **[Phase 4, 미구현]**

기업 또는 사용자의 자체 AI 인프라(vLLM, Ollama, TGI, SGLang, Private GPU Cluster, Air-gapped Model Server, On-premise LLM) 연결. AGEX는 모델 Token 원가를 청구하지 않고 Runtime/Governance/Observability/Support 등만 과금한다.

---

## 4. AGEX Billing 구조

```text
                    AGEX BILLING
                         │
         ┌───────────────┼───────────────┐
         │               │               │
   Subscription      AGEX Credits     Enterprise
         │               │               │
         │        ┌──────┴──────┐        │
         │        │             │        │
       Plan    Managed AI     BYOK    Contract
                    │             │
             LLM + Runtime    Runtime Only
```

`Subscription`, `Managed AI Credit 차감` 경로는 Phase 1 구현됨. `BYOK`/`Contract`(Enterprise) 경로는 미구현.

---

## 5. 수익 모델

- **5.1 Subscription** (Free/Core/Prime/Business/Enterprise) — Plan은 사용 권한과 기능 범위를 결정한다. 콘솔의 Plan 표시는 기존 Billing 화면과 동일하게 유지한다.
- **5.2 AGEX Credit** — 사용량 기반 과금. Phase 1 구현 대상: Managed LLM(breakdown 기반), Agent Runtime.
- **5.3 LLM Margin** — AGEX Managed AI에만 적용: `User Charge - Provider Cost - Infra Cost - Variable Platform Cost = Contribution Margin`. `computeCreditCost()`의 Margin 항이 이를 구현한다.
- **5.4 Enterprise License** — **[미구현]**.

---

## 6. Credit Engine

### 6.1 Credit 계산 — **[Phase 1, 구현됨]**

```text
Credit Usage =
  LLM Cost Unit + Runtime Unit + Tool Unit + Memory Unit + RAG Unit
  + Storage Unit + Premium Capability Unit + Policy Adjustment + Margin
```

`computeCreditCost()`가 이 합산식을 구현한다. Tool/Memory/RAG/Storage/Premium Unit은 각 도메인이 실제 사용량을 아직 보고하지 않으므로 현재는 breakdown에 0으로 채워 넣는다 — 계산식 자체는 완전하게 구현되어 있어, 각 도메인이 준비되는 대로 breakdown 값만 채우면 된다.

### 6.2 Managed AI 예시 — **[Phase 1, 참고용 예시 데이터]**

```text
Claude LLM Cost      $0.040
Embedding             $0.002
RAG                   $0.002
Tool Execution        $0.005
Agent Runtime         $0.008
Infra                 $0.003
--------------------------------
Internal Cost         $0.060
AGEX Charge           90 Credits
```

이 예시 값은 `ProviderPriceCatalog`의 seed 데이터로 사용되며, **실제 라이브 가격이 아닌 예시/placeholder**임을 코드 주석에 명시한다.

### 6.3 BYOK 예시 — **[Phase 2, 미구현 참고용]**

```text
Claude API → 사용자 Anthropic 계정에서 직접 청구
AGEX: Agent Runtime 8 + RAG 4 + Memory 2 + Tool Execution 5 = AGEX Charge 19 Credits
```

---

## 7. Model Router와 Billing 연동 — **[부분 구현, 2026-08-28]**

Model Router는 모델 품질만으로 선정하지 않으며, Capability/Quality/Cost/Latency/Region/Security Classification/Provider Availability/User Policy/Organization Policy/BYOK Availability/Credit Balance/Model Entitlement를 함께 평가하도록 설계되어 있다.

현재 `src/model-gateway/model-router.ts`는 이 중 Capability/Data Classification/Health/Region/Provider Trust/Latency/Cost만 구현되어 있다(S-04 기준) — 이 부분은 변경하지 않았다. **[구현됨]** `POST /api/v1/billing/estimate`(§11.4)가 `computeCreditCost()`를 재사용해 실행 전 비용 견적을 제공한다. **[미구현]** Credit Balance를 실제 라우팅 선택 기준에 반영하는 것, Routing Policy 선택(Prefer Quality/Balanced/Prefer Cost/…), 후보별 실시간 Cost-aware Routing 자체는 여전히 Phase 1 범위 밖 — Model Router는 Credit Engine과 아직 직접 연결되어 있지 않다.

---

## 8~9. 사용자 설정 UI / Billing Ledger — **[Phase 1 일부 구현]**

- 8.1/8.2 (AI Provider Settings, Provider Mode: Managed/BYOK/Hybrid/Enterprise Policy) — **[미구현]**. 콘솔은 여전히 Managed AI 단일 모드만 노출한다.
- 9.1 Ledger 이벤트 타입 — Phase 1에서 구현한 부분집합: `CREDIT_GRANT`, `CREDIT_USAGE`, `CREDIT_PURCHASE`, `CREDIT_REFUND`, `CREDIT_ADJUSTMENT`, `LLM_USAGE`, `AGENT_RUNTIME_USAGE`. BYOK/Enterprise 전용 타입(`BYOK_RUNTIME_USAGE`, `ENTERPRISE_USAGE`, `SUBSCRIPTION_CHARGE`, `TOOL_USAGE`, `STORAGE_USAGE`, `WORKFLOW_USAGE`)은 해당 흐름이 실제로 존재하지 않아 **[미구현]**.
- 9.2 Ledger 불변성 — 기존 `BillingLedgerEngine`(S-06)이 이미 구현: Posted Entry는 직접 수정하지 않고 Adjustment Entry로만 정정한다.

---

## 10. 데이터 모델

> **중요**: AGEX는 현재 실제 관계형 데이터베이스가 없다(전체가 In-Memory `Map` 기반 — [deployment-strategy] 참고). 아래 스키마는 **미래 Postgres 마이그레이션 시의 목표 스키마**이며, Phase 1 구현은 동일한 필드 구조를 TypeScript 타입 + In-Memory Map으로만 구현한다.

### 10.1 billing_accounts — **[Phase 1, In-Memory로 구현]**
`id, tenant_id, user_id, account_type, currency, credit_balance, status, created_at, updated_at`

### 10.2 credit_ledger — **[Phase 1, 기존 LedgerEntry 재사용]**
`id, billing_account_id, transaction_type, credit_amount, balance_before, balance_after, reference_type, reference_id, metadata, created_at`

### 10.3 provider_connections — **[Phase 2, 미구현]**
`credential_ref`는 Secret Vault 참조 ID만 저장하고 실제 API Key는 저장하지 않는다는 원칙(§12)은 유지하되, Secret Vault 자체가 없어 이 테이블은 만들지 않는다.

### 10.4 model_usage_records — **[Phase 1, breakdown 파라미터로 대체 구현]**
### 10.5 provider_price_catalog — **[Phase 1, 구현됨]** — `ProviderPriceCatalog` seed 데이터.
### 10.6 pricing_policy — **[Phase 2 이후, 미구현]**

---

## 11. API — **[대부분 미구현, Phase 1/1-B는 엔드포인트 2개 실데이터로 전환]**

Phase 1 구현: `GET /api/v1/billing/usage` (기존 `server_web.ts` 엔드포인트를 하드코딩 mock에서 실제 `CreditEngine` 조회로 전환).

Phase 1-B 구현 (2026-08-28): `POST /api/v1/billing/estimate` (§11.4) — `computeCreditCost()`/`sumBreakdownUsd()`를 재사용해 실제 과금과 절대 어긋나지 않는 사전 견적을 반환한다. 다만 요청별 실제 사용량 입력은 아직 없어 고정된 Managed AI 비용 프로필(§6.2 예시와 동일)을 반환하는 수준이다 — 요청 파라미터별 견적이 아니라는 점을 UI에서 사용할 때 유의.

나머지 §11.1~11.3의 REST 표면(`/api/v1/billing/account`, `/ledger`, `/credits/purchase`, `/api/v1/providers`, `/provider-policy`)은 **[미구현]** — Phase 2 이후 BYOK/Provider Connection이 실제로 필요해질 때 추가한다.

---

## 12~13. Secret 관리 / BYOK 보안 — **[Phase 2, 미구현]**

AGEX 원칙 #12(Secret은 Prompt/Log/Instruction/Workflow Variable에 들어가지 않는다)에 따라, BYOK API Key를 저장할 Secret Vault가 먼저 필요하다. Vault가 없는 상태에서 평문 저장 방식으로 BYOK를 구현하는 것은 원칙 위반이므로, Secret Vault가 실제로 구축되기 전까지 BYOK 전체를 의도적으로 미구현 상태로 유지한다.

---

## 14. Credit 잔액 정책 — **[Phase 1 일부 구현]**

### 14.1 잔액 부족 — **[Phase 1, 구현됨]**
`chargeCredits()`가 잔액 부족 시 `BILLING_INSUFFICIENT_CREDIT`(category `QUOTA`)를 즉시 반환하고 차감하지 않는다.

### 14.2 실행 중 초과 (Credit Reservation) — **[미구현]**
Agent/Workflow 장기 실행 중의 `Reserve → Execution → Actual Usage → Settlement → Unused Reservation Release` 흐름은 Phase 1에 포함하지 않는다 — 현재 Agent 실행은 짧은 동기 요청/응답이라 즉시 차감(§6.2 방식)으로 충분하다. Durable Runtime의 장기 실행 지원이 성숙하면 재검토한다.

---

## 15. Cost Guardrail — **[미구현]**

Max Credits per Task/Agent Run, Daily/Monthly Credit Limit, Max LLM/Tool Calls, Max Retry Count 등. MASTER.md 원칙 #16(Bounded Retry)과 관련되나 별도 구현 필요 — Phase 1 범위 밖.

## 16. Enterprise Budget Control — **[Phase 3, 미구현]**

## 17~18. 사용자 Usage 화면 / Admin Billing Dashboard — **[부분 구현]**
콘솔 Billing 화면(`public/app.js`)은 Phase 1에서 실제 잔액을 표시하도록 전환되지만, 상세 내역 조회(Date/Agent/Workflow/Provider/Model/Mode/Credits 컬럼)와 Admin Dashboard는 **[미구현]**.

## 19. Settlement Engine — **[Phase 5, 미구현]**

## 20. Provider 장애 대응 — **[미구현]**
Failover, BYOK 실패 시 Managed AI 재사용 등은 실제 다중 Provider 연결(Phase 2+)이 있어야 의미가 있어 미구현.

## 21. Provider Priority — **[Phase 2, 미구현]**

## 22. Entitlement 연동 — **[미구현]**
Plan별 기능 차등표(§22)는 Product Pricing 문서에서 별도 관리 예정, 아직 작성되지 않음.

## 23. 오류 코드 — **[Phase 1, 부분 구현]**
Phase 1 구현: `BILLING_INSUFFICIENT_CREDIT`. 나머지(`BILLING_ACCOUNT_SUSPENDED`, `BILLING_LIMIT_EXCEEDED`, `PROVIDER_KEY_INVALID`, `PROVIDER_KEY_EXPIRED`, `PROVIDER_RATE_LIMIT`, `PROVIDER_UNAVAILABLE`, `PROVIDER_NOT_ALLOWED`, `MODEL_NOT_ENTITLED`, `MODEL_POLICY_DENIED`, `BUDGET_EXCEEDED`, `CREDIT_RESERVATION_FAILED`, `SETTLEMENT_FAILED`)은 해당 기능이 구현될 때 함께 추가한다.

## 24. 감사로그 — **[Phase 1은 기존 Audit Logger 재사용, 신규 이벤트는 미구현]**
Credit Grant/Adjustment는 `postLedgerEntry()`를 통해 Ledger에 기록되나(불변 원장 자체가 감사 근거), Provider 연결/해지 등 BYOK 관련 Audit 이벤트는 BYOK 미구현으로 함께 미구현.

---

## 25. 개발 단계 (원본 로드맵 — 구현 상태 표기)

- **Phase 1 — Billing Foundation**: **[구현됨, 2026-08-28]** Billing Account, Credit Ledger(기존 엔진 재사용), Managed AI 과금 계산, Provider Price Catalog(예시 데이터), Credit 차감, `GET /api/v1/billing/usage` 실데이터화, Balance UI. (Usage 상세 내역 UI는 제외)
- **Phase 1-B — Usage Estimate**: **[구현됨, 2026-08-28]** `POST /api/v1/billing/estimate`(§11.4/§7). Cost-aware Model Router 통합(§7의 나머지)은 미구현.
- **Phase 2 — BYOK**: **[미구현]** Provider Connection, Secret Vault, Provider Test, BYOK Routing/Usage, Runtime-only Billing, Hybrid Mode.
- **Phase 3 — Enterprise AI**: **[미구현]**
- **Phase 4 — Private AI**: **[미구현]**
- **Phase 5 — Advanced Billing**: **[미구현]** Cost-aware Routing, Credit Reservation, Settlement Engine, Margin Analysis, Provider Invoice Reconciliation, Real-time Budget Guardrail, Dynamic Pricing Policy.

## 26. 테스트 기준 (Phase 1 관련 항목만 발췌)

- Credit 정상 차감, Provider Token/실제 Provider Cost 기록(§26 Managed AI 항목 중 breakdown 기반으로 대체), 실패 요청 과금 방지, Retry 중복 과금 방지 — `tests/phase8_9_10.test.ts`, `tests/core.test.ts`에서 검증.

## 27. 승인 기준 (17개 항목 중 Phase 1 해당분)

1. Managed AI 사용 시 Credit 정상 차감 — 구현됨
9. 잔액 부족 시 실행 차단 — 구현됨
11. 사용자 Usage 내역 조회 가능 — 부분 구현(`GET /api/v1/billing/usage`만)
14. Ledger 불변성 유지 — 기존 엔진에서 이미 구현됨
나머지 항목(BYOK 등록/해지, Provider Secret, Tenant 간 Credential 격리, Hybrid Routing, Enterprise/Private 연결 등)은 해당 Phase가 미구현이므로 이번 승인 기준에서 제외.

## 28. 최종 요금 정책 (원본 4개 사용자 유형 — 참고용, 미변경)

일반 사용자 / Power User / Business / Enterprise 4개 유형의 과금 조합은 원본 명세와 동일하게 목표로 유지한다. 현재 구현은 "일반 사용자(AGEX Managed AI + Subscription + AGEX Credits)" 유형만 실동작한다.

## 29. 핵심 결론

AGEX는 LLM Token 재판매 서비스로 정의되지 않는다. AGEX Credit은 LLM Token의 대체 단위가 아니라 **AGEX 플랫폼 전체 실행 요소에 대한 통합 Compute Unit**으로 정의한다. 이 원칙은 Phase 1에서부터 그대로 적용되며(§6.1 계산식), Phase 2~5는 이 원칙 위에 Provider Source를 확장하는 작업이다.

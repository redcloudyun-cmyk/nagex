# NAgex LLM 연동 전략 및 개발 우선순위

기준일: 2026-09-27

## 1. 목적

NAgex의 LLM 연동 전략을 단순한 “모델 수 확대”가 아니라,  
**핵심 Native Provider + 통합 Gateway + Task-Aware Model Routing** 구조로 정리한다.

현재 NAgex에는 OpenAI와 Google Gemini가 연결되어 있으며,  
향후 해커톤 대응과 제품 확장성을 위해 추가 Provider 연동이 필요하다.

---

## 2. 현재 연동 상태

| Provider | 상태 | 비고 |
|---|---:|---|
| OpenAI | ✅ 연동 완료 | 범용 / 추론 / 코딩 |
| Google Gemini | ✅ 연동 완료 | 범용 / 멀티모달 |
| Anthropic Claude | ⏳ 미연동 | 고품질 추론 후보 |
| Nebius Token Factory / NVIDIA Nemotron | ⏳ 미연동 | 해커톤 핵심 |
| OpenRouter | ⏳ 미연동 | 다수 모델 통합 Gateway |
| xAI Grok | ⏳ 미연동 | OpenRouter 우선 |
| Mistral | ⏳ 미연동 | OpenRouter 우선 |
| DeepSeek | ⏳ 미연동 | 저비용 대량 처리 후보 |
| Qwen | ⏳ 미연동 | 저비용 / 중국계 오픈모델 |
| HyperCLOVA X | ⏳ 미연동 | 한국어 특화 |
| Upstage Solar | ⏳ 미연동 | 한국어 특화 / OpenRouter 경유 가능 |

---

## 3. 핵심 전략

모든 모델을 개별 API로 연결하지 않는다.

### 기본 원칙

- 핵심 3~4개 Provider는 Native 연동
- 나머지 모델은 OpenRouter 같은 Gateway를 통해 확보
- 사용자 요청은 NAgex Model Router가 Task 특성에 따라 적절한 모델로 자동 라우팅
- API Key는 기존 Credential Broker / Vault 원칙을 그대로 사용
- 모델은 교체 가능한 Provider이며, NAgex의 핵심 자산으로 취급하지 않는다

---

## 4. 권장 목표 아키텍처

```text
NAgex
  ↓
Task Classification
  ↓
Model Router
  ↓
┌─────────────────────────────┐
│ Native Providers            │
│                             │
│ OpenAI                      │
│ Gemini                      │
│ Anthropic Claude            │
│ Nebius / NVIDIA Nemotron    │
└─────────────────────────────┘
              +
┌─────────────────────────────┐
│ Gateway                     │
│                             │
│ OpenRouter                  │
│ └ Grok                      │
│ └ Mistral                   │
│ └ DeepSeek                  │
│ └ Qwen                      │
│ └ Llama                     │
│ └ Solar                     │
│ └ 기타 모델                 │
└─────────────────────────────┘
```

핵심 방향:

> **OpenAI + Gemini + Claude + Nemotron은 Native Provider로 유지하고,  
> 나머지 모델은 OpenRouter를 통해 확장한다.**

---

## 5. 개발 우선순위

### P0-1. Nebius Token Factory / NVIDIA Nemotron

가장 먼저 추가한다.

이유:

- 해커톤 대응 필요
- NVIDIA Nemotron 사용 가능
- OpenAI 호환 API 구조
- 기존 Provider Adapter 재사용 가능성이 높음
- 대규모 구조 변경 없이 연결 가능

---

### P0-2. Anthropic Claude

Nebius 다음으로 Native 연동한다.

이 단계가 완료되면 핵심 Provider는 다음 4개가 된다.

```text
OpenAI
Gemini
Claude
Nemotron
```

이 정도면 범용 Personal AI 제품의 핵심 모델 포트폴리오로 충분하다.

---

### P1-1. OpenRouter

OpenRouter를 Gateway Provider로 추가한다.

이를 통해 다음 모델군을 개별 구현하지 않고 확보할 수 있다.

```text
Grok
Mistral
DeepSeek
Qwen
Llama
Solar
기타 OpenRouter 지원 모델
```

OpenRouter의 목적은 “핵심 Provider 대체”가 아니라  
**Long-tail 모델 확장 및 비용 최적화**이다.

---

### P2. 한국어 특화 모델

필요 시 다음 Provider를 검토한다.

```text
HyperCLOVA X
Upstage Solar
```

다만 NAgex가 글로벌 Personal AI를 우선한다면 현재 우선순위는 낮다.

---

## 6. 최종 우선순위 표

| 순위 | Provider | 연동 방식 | 목적 |
|---:|---|---|---|
| 1 | Nebius / Nemotron | Native | 해커톤 / Agentic AI |
| 2 | Anthropic Claude | Native | 고품질 추론 |
| 3 | OpenRouter | Gateway | 다수 모델 확장 |
| 4 | HyperCLOVA X | Native | 한국어 특화 |
| 5 | DeepSeek / Qwen | OpenRouter 우선 | 저비용 대량 처리 |
| 6 | Grok / Mistral | OpenRouter | 선택적 활용 |

---

## 7. NAgex에서 중요한 것은 모델 수가 아니다

NAgex의 핵심 경쟁력은 다음 구조다.

```text
User Request
   ↓
Task Classification
   ↓
Model Router
   ↓
Best Provider / Model
   ↓
Tool / Agent Execution
   ↓
Human Approval / Trust Boundary
   ↓
Result
```

사용자가 매번 직접 모델을 선택하지 않아도  
NAgex가 요청의 특성을 보고 적절한 모델을 선택해야 한다.

---

## 8. Task → Model Routing 예시

| Task | 기본 후보 |
|---|---|
| 일반 대화 | 저비용 범용 모델 |
| 복잡한 추론 | Claude / OpenAI 상위 모델 |
| 웹 조사 | Gemini / OpenAI |
| 코딩 | Claude / Codex 계열 |
| 대량 요약 | DeepSeek / Qwen |
| Agentic AI | Nemotron |
| 한국어 특화 | HyperCLOVA X / Solar |

이 매핑은 고정값이 아니라 다음 조건을 함께 반영해야 한다.

```text
Task Type
Cost
Latency
Context Length
Tool Calling Support
Structured Output Support
Evidence Grounding Requirement
Provider Availability
User Preference
```

---

## 9. Credential 관리 원칙

R23.4V의 Credential Broker 구조를 그대로 유지한다.

잘못된 구조:

```text
Agent
  ↓
OPENAI_API_KEY
ANTHROPIC_API_KEY
NEBIUS_API_KEY
OPENROUTER_API_KEY
```

권장 구조:

```text
Credential Store
      ↓
Credential Broker
      ↓
Scoped Credential Reference
      ↓
Provider Adapter
```

### 반드시 유지할 원칙

```text
MODEL_CAN_READ_SECRET=0
AGENT_CAN_READ_SECRET=0
SECRET_IN_PROMPT=0
SECRET_IN_MODEL_REQUEST=0
SECRET_IN_LOG=0
SECRET_IN_AUDIT=0
SECRET_IN_ACTIVITY=0
SECRET_IN_MEMORY=0
SECRET_IN_APPROVAL_PAYLOAD=0
```

Model Router와 Agent는 API Key 원문을 직접 읽어서는 안 된다.

---

## 10. 권장 개발 순서

현재 R23.5B 이후 다음과 같은 순서가 합리적이다.

```text
R23.5B Browser Untrusted-Content Boundary 완료
   ↓
Nebius / Nemotron Provider 추가
   ↓
Anthropic Claude Provider 추가
   ↓
Model Router 확장
   ↓
OpenRouter Provider 추가
   ↓
Provider Capability Registry 고도화
   ↓
Task-Aware Automatic Model Routing
   ↓
한국어 특화 Provider 검토
```

---

## 11. Provider Capability Registry

Provider마다 기능 차이가 있으므로 capability 기반으로 관리한다.

예:

```text
ProviderCapability {
  supportsGeneralChat
  supportsReasoning
  supportsJsonMode
  supportsStructuredExtraction
  supportsToolCalling
  supportsVision
  supportsLongContext
  supportsEvidenceGrounding
  supportsAgenticExecution
}
```

Model Router는 단순히 모델 이름을 고르는 것이 아니라  
Task 요구사항과 Provider Capability를 매칭해야 한다.

---

## 12. OpenRouter 사용 원칙

OpenRouter는 유용하지만 모든 것을 OpenRouter로 통일하지 않는다.

### 장점

- 여러 모델을 하나의 API로 접근 가능
- 새로운 모델 추가 속도가 빠름
- 개발 비용 절감
- 비용 비교와 모델 실험에 유리

### 단점

- Gateway 종속성
- 추가 지연 가능성
- OpenRouter 장애가 다수 모델에 동시에 영향
- Provider 고유 기능을 완전히 활용하지 못할 수 있음

따라서:

```text
핵심 모델 = Native
Long-tail 모델 = OpenRouter
```

구조를 유지한다.

---

## 13. 리스크

### 13.1 가격 변동

LLM API 가격은 자주 변경된다.

따라서 가격을 코드에 하드코딩하지 않고  
Provider Pricing Metadata 또는 운영 설정으로 관리하는 것이 좋다.

### 13.2 중국계 Provider

DeepSeek / Qwen 등을 사용할 경우:

- 개인정보 처리
- 데이터 저장 위치
- 로그 보존 정책
- 기업 고객 데이터 정책

등을 반드시 검토해야 한다.

### 13.3 Provider 장애

특정 Provider 장애 시 자동 fallback이 가능해야 한다.

예:

```text
Claude unavailable
   ↓
OpenAI
   ↓
Gemini
   ↓
Gateway fallback
```

단, security capability나 structured-output requirement가 다른 모델로 무조건 fallback해서는 안 된다.

---

## 14. 최종 권장안

NAgex의 LLM 전략은 다음으로 정리한다.

```text
Native Core
────────────
OpenAI
Gemini
Claude
Nebius / Nemotron

Gateway
────────────
OpenRouter

Optional / Future
────────────
HyperCLOVA X
Solar
DeepSeek Native
Qwen Native
기타 특화 모델
```

핵심은 많은 모델을 연결하는 것이 아니라,

> **NAgex가 사용자의 요청을 이해하고, 가장 적절한 Provider와 Model을 자동 선택한 뒤,  
> 기존 Permission / Approval / Credential / Trust Boundary 안에서 안전하게 실행하는 구조를 만드는 것**

이다.

---

## 15. 실행 우선순위 요약

```text
1. R23.5B 완료
2. Nebius / Nemotron 연동
3. Claude 연동
4. OpenRouter 연동
5. Model Router 고도화
6. Provider Capability Registry 정교화
7. Task-Aware Routing
8. HyperCLOVA 등 특화 모델은 필요 시 추가
```

이 순서를 기본 개발 기준으로 사용한다.

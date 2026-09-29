# NAgex Multi-AI Perspective & Forecast Model

## 1. Purpose

NAgex는 단일 AI 모델의 답변을 그대로 전달하는 서비스가 아니다.

NAgex는 사용자의 질문 성격을 이해하고, 필요한 경우 여러 AI 모델의 서로 다른 관점·전망·근거를 비교하여 사용자가 더 나은 판단을 할 수 있도록 돕는 **Personal AI Orchestration Layer**를 지향한다.

핵심 원칙:

> 하나의 답을 강요하지 않는다.  
> 서로 다른 판단이 존재할 수 있음을 보여주고, 그 차이가 왜 발생하는지를 설명한다.

---

# 2. Product Principle

일반 질문에서는 가장 적합한 Primary Model 하나를 선택하여 빠르게 답한다.

그러나 다음과 같은 질문에서는 단일 모델 답변만 제공하는 것으로 충분하지 않을 수 있다.

- 정치
- 외교
- 국제관계
- 경제정책
- 금융시장 전망
- 금리
- 환율
- 주식
- 산업 전망
- 기술 전망
- 사회적 논쟁
- 역사적 해석
- 미래 예측
- 불확실성이 높은 의사결정

이 경우 NAgex는 사용자에게 추가적으로:

**다른 관점 보기**

또는

**다른 AI 전망 비교**

기능을 제공한다.

---

# 3. Two Comparison Modes

## 3.1 Perspective Compare

관점과 해석의 차이가 중요한 질문에 사용한다.

예:

> 대한민국이 왜 이란에 파병하면 안 되는가?

NAgex는 기본 답변을 제공한 뒤:

`다른 관점 보기`

를 제공한다.

비교 대상 예:

- OpenAI
- Anthropic
- Google
- Qwen 또는 기타 지원 모델

NAgex는 모델별 답변 전문을 단순 나열하지 않는다.

대신 다음 구조로 비교한다.

### 공통적으로 동의한 부분

- 여러 모델이 공통적으로 강조한 사실 또는 위험

### 관점이 갈리는 부분

- 외교
- 안보
- 경제
- 국제법
- 인도주의
- 지역질서 등

### 차이가 발생한 이유

- 중요하게 보는 변수
- 사용한 근거
- 가정
- 분석 프레임

### 추가 확인이 필요한 사실

- 최신 정부 입장
- 국제기구 결정
- 실제 군사 상황
- 공식 통계 등

NAgex는 어떤 모델의 정치적 관점이 더 옳다고 판정하지 않는다.

사용자가 판단할 수 있도록 차이를 설명한다.

---

# 4. Forecast Compare

미래를 예측하는 질문에는 별도의 Forecast Compare 방식을 적용한다.

예:

> 미국 10년물 국채금리가 11월에 오를 가능성이 높은가?

기본 답변 후:

`다른 AI 전망 비교`

기능을 제공한다.

각 모델의 판단을 다음 구조로 정규화한다.

## Direction

- 상승
- 하락
- 중립
- 불확실

## Drivers

해당 전망의 핵심 근거.

예:

- CPI
- 고용
- Fed 정책
- Treasury issuance
- 경기 전망
- 유동성
- 지정학적 위험

## Confidence

모델이 표현한 확신 수준을 정성적으로 정규화한다.

예:

- 높은 확신
- 중간
- 낮은 확신

임의의 확률 숫자를 생성하지 않는다.

## Invalidation Conditions

어떤 조건이 발생하면 현재 전망이 약해지거나 뒤집힐 수 있는지를 보여준다.

예:

> CPI가 예상보다 빠르게 둔화되거나 Fed가 조기 완화 신호를 보낼 경우 상승 전망은 약해질 수 있습니다.

---

# 5. Evidence Pack

Forecast Compare의 핵심 원칙은:

> 서로 다른 모델에게 서로 다른 정보를 주고 비교해서는 안 된다.

먼저 NAgex가 공통 Evidence Pack을 생성한다.

예: 미국 국채금리 전망

```text
Current 10Y Treasury yield
Latest CPI
Core CPI
Payrolls
Unemployment rate
Fed Funds Rate
FOMC statements
Fed Funds Futures
Treasury issuance
Recent Fed speeches
Relevant market movements
Evidence timestamp
```

모든 비교 모델에게 동일한 Evidence Pack과 동일한 질문을 전달한다.

이를 통해 모델 자체의 판단 차이를 비교한다.

---

# 6. Architecture

```text
User Question
      ↓
NAgex Intent & Question Classifier
      ↓
Question Type
 ┌───────────────┬──────────────────┐
 │ Normal Answer │ Perspective /    │
 │               │ Forecast Question│
 └───────────────┴──────────────────┘
      ↓
Primary Model Router
      ↓
Primary Answer
      ↓
User sees answer immediately
      ↓
[Other Perspectives]
or
[Compare AI Forecasts]
      ↓
Evidence Pack Builder
      ↓
 ┌─────────┬─────────┬─────────┬─────────┐
 │ OpenAI  │ Claude  │ Gemini  │ Qwen    │
 └─────────┴─────────┴─────────┴─────────┘
      ↓
NAgex Comparison Engine
      ↓
Consensus
Differences
Drivers
Assumptions
Invalidation Conditions
      ↓
Mobile-first Comparison UI
```

---

# 7. Do Not Call Every Model by Default

모든 질문에 3~5개 모델을 동시에 호출하지 않는다.

이유:

- 비용 증가
- 응답 지연
- 불필요한 계산
- 동일한 사실 질문에서 가치가 낮음

기본 구조:

```text
Question
↓
Primary Model
↓
Primary Answer
```

사용자가 추가 비교를 요청하거나 NAgex가 비교 가치가 높다고 판단한 경우:

```text
[다른 관점 보기]
↓
Multi-model execution
```

---

# 8. Automatic Suggestion

NAgex는 질문 유형을 분석하여 비교 기능을 자동 제안할 수 있다.

예:

```text
이 주제는 관점에 따라 해석이 달라질 수 있습니다.

[다른 관점 보기]
```

Forecast:

```text
이 전망은 경제지표와 정책 가정에 따라 크게 달라질 수 있습니다.

[다른 AI 전망 비교]
```

단, 자동으로 모든 모델을 호출하지 않는다.

사용자 선택 이후 실행하는 것을 기본값으로 한다.

---

# 9. Mobile-First UX

NAgex는 Mobile-first Personal AI다.

따라서 첫 답변에서는 비교 결과를 모두 펼치지 않는다.

## First Screen

```text
NAgex

11월 미국 국채금리는 현재로서는
상승과 하락 요인이 모두 존재합니다.

상승 요인
• 인플레이션
• 국채 공급
• Fed 완화 지연

하락 요인
• 고용 둔화
• 경기 우려
• 완화 기대

[다른 AI 전망 비교]
```

## Expanded Comparison

```text
AI 전망 비교

GPT
↗ 상승 쪽을 더 강조

Claude
→ 중립 / 변동성 강조

Gemini
↘ 하락 가능성을 상대적으로 강조

Qwen
→ 불확실성 높음

[왜 전망이 다른가?]
```

## Difference Analysis

```text
왜 전망이 다른가?

핵심 차이

1. Fed 정책 경로
2. 물가 전망
3. Treasury issuance 영향
4. 경기 둔화 가능성
```

모바일에서 정보는 단계적으로 공개한다.

---

# 10. Desktop Expansion

Desktop에서는 동일한 결과를 더 깊게 분석할 수 있다.

예:

- 모델별 상세 답변
- Evidence
- source
- assumptions
- comparison matrix
- timeline
- historical forecasts
- follow-up analysis

Desktop은 Mobile 경험의 확장판이다.

Desktop 구조를 축소하여 Mobile을 만드는 방식은 사용하지 않는다.

---

# 11. Consensus

NAgex는 여러 모델의 공통 판단을 별도로 추출할 수 있다.

예:

```text
높은 합의

• Fed 정책이 가장 중요한 변수
• 국채 공급이 금리 상승 위험 요인
• 고용 둔화는 금리 하락 요인
```

차이가 큰 항목:

```text
의견 차이

• 인플레이션 지속 여부
• Fed 인하 시점
• 경기침체 가능성
```

---

# 12. Numeric Consensus Warning

다음과 같은 숫자는 근거 없이 표시하지 않는다.

```text
AI Agreement 78%
```

정량적인 semantic comparison methodology가 실제 구현된 경우에만 사용할 수 있다.

그 이전에는:

```text
높은 합의
의견 차이 있음
불확실성 높음
```

같은 정성 표현을 사용한다.

---

# 13. Source Freshness

시간에 민감한 질문에서는 모델 내부 지식만 사용하지 않는다.

예:

- 금융
- 시장
- 정치
- 국제정세
- 정책
- 기업
- 기술 트렌드

먼저 최신 정보 검색 또는 데이터 retrieval을 수행한다.

모든 Evidence에는 가능한 경우:

```text
Source
Published date
Observed date
Retrieved at
```

을 기록한다.

---

# 14. Model Transparency

사용자가 원하면 실제 비교에 사용된 모델을 확인할 수 있어야 한다.

예:

```text
Compared using

OpenAI GPT-*
Anthropic Claude *
Google Gemini *
Alibaba Qwen *
```

그러나 기본 화면에서는 모델명이 제품 UX를 지배하지 않도록 한다.

NAgex가 중심이어야 한다.

---

# 15. NAgex Position

NAgex는:

> 여러 LLM을 선택하는 UI

가 아니다.

NAgex는:

> 여러 AI의 다른 판단을 이해하고, 공통점과 차이점을 사용자가 판단하기 쉬운 형태로 변환하는 Personal AI

다.

---

# 16. Development Direction

향후 구현 모듈 후보:

```text
QuestionClassificationService
EvidencePackService
MultiModelOrchestrator
PerspectiveComparisonEngine
ForecastComparisonEngine
ConsensusAnalyzer
AssumptionExtractor
InvalidationConditionExtractor
SourceFreshnessValidator
```

내부 구현명은 사용자 UI에 노출하지 않는다.

---

# 17. R22 Product Priority

R22에서 다음을 높은 우선순위로 검토한다.

### P0
- Mobile answer UX
- Perspective Compare UX
- Forecast Compare UX
- Evidence Pack
- Primary → Multi-model escalation

### P1
- Consensus extraction
- Difference analysis
- assumption comparison
- invalidation conditions
- source inspection

### P2
- historical forecast comparison
- saved comparisons
- personalized model preference
- forecast tracking and later outcome verification

---

# 18. Core Product Rule

NAgex는 사용자가 원하는 답을 만들어주는 시스템이 아니다.

NAgex는:

- 사실
- 근거
- 관점
- 불확실성
- 서로 다른 판단

을 구분해서 보여준다.

최종 판단은 사용자에게 남긴다.

---

# 19. Product Identity

이 기능은 NAgex의 핵심 차별화 요소가 될 수 있다.

> Ask one AI, get one answer.

가 아니라:

> Ask NAgex, understand the answer — and the alternatives.

를 지향한다.

---

# 20. Model Independence Principle

NAgex는 특정 LLM의 프론트엔드가 아니다.

NAgex의 핵심 가치는 특정 모델 자체가 아니라:

- 모델 선택
- 모델 라우팅
- 멀티모델 비교
- 공통 근거 제공
- 관점 차이 분석
- 전망 차이 분석
- 결과 통합

에 있다.

따라서 특정 모델의 가격·성능·정책 변화에도 제품 경험이 흔들리지 않는 구조를 지향한다.

---

`NAGEX_MULTI_AI_PERSPECTIVE_MODEL=CANONICAL`

`MOBILE_FIRST=TRUE`

`SINGLE_MODEL_DEFAULT=TRUE`

`MULTI_MODEL_ON_DEMAND=TRUE`

`EVIDENCE_FIRST_FOR_FORECASTS=TRUE`

`MODEL_INDEPENDENCE=CORE_PRINCIPLE`

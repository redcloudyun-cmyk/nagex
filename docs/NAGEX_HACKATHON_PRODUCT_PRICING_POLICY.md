# NAgex Hackathon Product & Pricing Policy

## 0. 문서 목적

이 문서는 NAgex의 해커톤 단계에서 제품 경험과 가격 정책을 어떻게 배치할 것인지 정의하는 운영·제품 기준 문서다.

핵심 원칙은 다음과 같다.

> 해커톤에서는 가격이 제품의 중심이 아니다.  
> 먼저 사용자가 “이걸 실제로 쓰고 싶다”고 느끼게 만들고, 가격은 그 다음에 보여준다.

NAgex의 현재 최우선 제품 타겟은 개인 사용자(Individual / Prosumer)이며,
현재 해커톤 목표는 NAgex를 **Personality AI / Personal AI OS / Personal Executive Assistant**로 인식시키는 것이다.


# 1. 해커톤 최우선 우선순위

해커톤에서의 우선순위는 다음 순서를 따른다.

```text
1. Personal AI UX 완성
2. 요청-결과 일치
3. Morning Brief / Quick Wake / Meeting Prep
4. Human Approval 기반 실제 Action
5. 모바일/글로벌 사용감
6. 해커톤 데모 시나리오
7. 그 다음 Pricing
```

가격정책은 준비되어 있어야 하지만,
사용자와 심사위원에게 제품 가치보다 먼저 노출되어서는 안 된다.


# 2. 해커톤에서 보여줘야 하는 핵심 가치

NAgex는 해커톤에서 다음과 같이 보이면 안 된다.

```text
또 하나의 LLM Chat
또 하나의 Agent Framework
또 하나의 Workflow Builder
또 하나의 Enterprise Automation Tool
```

대신 다음 경험을 보여줘야 한다.

```text
NAgex가 나를 기억한다
↓
오늘의 상황을 이해한다
↓
필요한 일을 먼저 챙긴다
↓
관련 자료를 찾아 준비한다
↓
중요한 행동 전에는 나에게 확인한다
↓
승인 후 실제로 행동한다
↓
결과를 기록하고 다음 맥락에 활용한다
```

핵심 메시지:

> NAgex is a Personality AI that remembers you, understands your day, anticipates what you need, and helps you get things done.


# 3. 데모에서 가격을 전면에 내세우지 않는다

해커톤 데모 영상, 메인 화면, 첫 진입 화면에서는 가격을 주요 메시지로 사용하지 않는다.

금지:

```text
첫 화면에 Pricing 대형 배너
기능 사용 전 구독 안내
결제 유도 팝업
핵심 기능 앞 Paywall
데모 중 과도한 가격 설명
```

허용:

```text
Pricing 페이지
Settings > Plan
Footer 링크
마지막 Product Roadmap / Business Model 장면
```

가격은 “사업화 가능성”을 보여주는 보조 정보로 취급한다.


# 4. 해커톤 데모의 핵심 흐름

대표 데모는 가격이 아니라 Personal AI 경험을 중심으로 구성한다.

권장 흐름:

```text
Morning Brief
→ Quick Wake
→ Meeting Prep
→ Reminder / Personal Watch
→ Proactive Suggestion
→ Human Approval
→ Actual Action
→ Result
```

사용자는 짧은 시간 안에 다음을 느껴야 한다.

```text
"나를 알고 있네."
"내 상황을 이해하고 있네."
"내가 시키지 않은 것도 챙겨주네."
"그래도 중요한 행동은 내가 결정하네."
"이건 실제로 매일 쓰고 싶다."
```


# 5. 해커톤 접근 정책

해커톤 심사 및 테스트 단계에서는 핵심 기능 접근을 결제와 연결하지 않는다.

권장:

```text
Judge / Demo Access
= 핵심 기능 무료 사용 가능

Checkout
= 불필요

Paywall
= 비활성화 또는 우회 가능

Pricing Page
= 존재 가능
```

핵심 기능을 평가하려면 결제가 필요한 구조로 만들지 않는다.


# 6. 초기 상용 가격 구조

해커톤 이후 상용화 후보 가격은 다음과 같이 관리한다.

## NAgex Free

```text
Price:
$0 / ₩0

Role:
Experience NAgex

Includes:
- Basic AI
- Basic Memory
- Limited Search
- Limited Create
- Limited Reminder
- Very limited Agent actions
```

무료 사용자가 NAgex가 단순 Chat AI와 다르다는 것을 경험할 수 있을 정도는 제공한다.


## NAgex Personal

```text
Price:
$9.99 / ₩12,900 per month

Positioning:
Your everyday personal AI

Includes:
- Personal Memory
- Calendar
- Email context
- Vault
- Morning Brief
- Quick Wake
- Reminders
- Personal Watch
- Meeting Prep
- Standard AI usage
- Included NAgex Credits
```


## NAgex Personal Pro

```text
Price:
$19.99 / ₩24,900 per month

Positioning:
Your AI that gets things done

Includes:
- Everything in Personal
- Higher model limits
- Deep Research
- More Create
- More Agent actions
- Browser actions
- More automations
- Longer context
- Priority execution
- Higher included NAgex Credits
```


# 7. 크레딧 정책

NAgex는 순수 Chat 제품보다 변동 원가가 크다.

한 번의 Agent 작업이 다음을 함께 사용할 수 있기 때문이다.

```text
LLM
Search
RAG
Browser
Email
Calendar
Image
Multiple model calls
```

따라서 구독은 다음 구조를 기본으로 한다.

```text
Monthly Subscription
+
Included NAgex Credits
+
Optional Credit Top-up
```

단, 사용자에게 token 단위를 직접 노출하지 않는다.

잘못된 예:

```text
2,412 input tokens
1,184 output tokens
```

권장:

```text
Standard task
High-compute task
Remaining usage
```

필요한 경우에만 예상 credit 사용량을 보여준다.


# 8. 예시 Credit Top-up 구조

아래 숫자는 최종 확정 가격이 아니며,
실제 API/모델/Browser/Search/Image 원가 측정 후 재산정한다.

```text
1,000 credits   ₩4,900
3,000 credits   ₩12,900
10,000 credits  ₩34,900
```

해커톤 단계에서는 실제 결제를 구현할 필요가 없다.


# 9. BYOK 전략

향후 Power User를 위해 BYOK(Bring Your Own Key)를 지원할 수 있다.

예:

```text
NAgex Subscription
+
User OpenAI / Gemini / Anthropic API Key
```

장점:

- NAgex의 모델 원가 절감
- Power User의 높은 사용량 수용
- 사용자가 선호하는 모델 선택 가능

하지만 일반 사용자 onboarding에서 BYOK를 요구하지 않는다.

일반 사용자는 API Key를 만들지 않고도 바로 NAgex를 사용할 수 있어야 한다.


# 10. 가격보다 먼저 증명해야 하는 것

NAgex가 먼저 증명해야 하는 질문은 다음이다.

잘못된 질문:

> 월 얼마짜리 AI인가?

먼저 답해야 할 질문:

> 이걸 정말 매일 쓰고 싶은가?

가격은 사용자가 제품 가치를 체감한 다음에 판단하게 한다.


# 11. 해커톤 영상에서의 Pricing 노출

Pricing을 영상에 넣는 경우:

- 중간 핵심 장면에는 넣지 않는다.
- 마지막 3~5초 정도에만 간단히 노출 가능하다.
- 핵심 데모 시간을 가격 설명에 사용하지 않는다.

예:

```text
NAgex Personal
Starting at $9.99/month
```

정도로 충분하다.


# 12. Product Experience First

가격 정책도 NAgex의 최상위 제품 경험 원칙을 따른다.

판단 순서:

```text
1. User Efficacy
2. Global User Experience
3. Emotional Trust & Expectation
4. Result Satisfaction
5. Personal AI Differentiation
6. Safety / Human Control
7. Monetization
8. Technical Implementation
```

가격이 제품 경험을 방해하면 가격 노출을 늦춘다.


# 13. 해커톤 완료 기준

해커톤 제출 전 아래를 확인한다.

```text
CORE_PERSONAL_AI_EXPERIENCE=PASS

MORNING_BRIEF=PASS
QUICK_WAKE=PASS
MEETING_PREP=PASS
PERSONAL_WATCH=PASS
REMINDER=PASS

PROACTIVE_SUGGESTION=PASS
HUMAN_APPROVAL=PASS
ACTUAL_ACTION=PASS

MOBILE_UX=PASS
GLOBAL_COPY=PASS

PRICING_NOT_BLOCKING_DEMO=PASS
JUDGE_ACCESS_FREE=PASS
PAYWALL_DISABLED_FOR_DEMO=PASS
```

가격이 잘 정의되어 있더라도,
핵심 Personal AI 경험이 약하면 해커톤 준비는 완료된 것이 아니다.


# 14. 최종 원칙

해커톤에서 NAgex가 보여줘야 하는 것은 가격표가 아니다.

사용자가 다음과 같이 느끼게 만드는 것이다.

> “이 AI는 나를 이해하고, 내 일을 덜어주며, 내가 허락하면 실제로 행동한다.”

그 경험이 먼저다.

Pricing은 그 가치가 증명된 뒤에 보여준다.

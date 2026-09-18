# NAgex Product Experience First Principle

## 0. 문서 목적

이 문서는 NAgex의 모든 기능, UI, UX, 문구, 인터랙션, 자동화, 결과 표현을 설계·구현·검토할 때 적용하는 최상위 제품 경험 원칙이다.

NAgex는 기능의 수, 내부 아키텍처의 복잡성, 기술적 완성도 자체를 사용자 가치로 간주하지 않는다.

NAgex의 최우선 기준은 항상 다음 순서다.

1. 사용자가 실제로 느끼는 효능감
2. 사용 과정에서 느끼는 감정과 사용감
3. 글로벌 사용자가 받아들이는 태도·인상·신뢰감
4. 작업 중 형성되는 결과에 대한 기대감
5. 결과를 받은 뒤의 만족도와 재사용 의향
6. 그 다음에 기술 구현과 시스템 구조

기술 구현은 위 사용자 경험을 실현하기 위한 수단이다.


# 1. User Efficacy — 사용자가 실제로 얻는 효능감

모든 기능을 만들기 전에 먼저 다음을 묻는다.

- 이 기능은 사용자가 무엇을 더 쉽게 하게 만드는가?
- 시간을 실제로 얼마나 줄여주는가?
- 사용자가 해야 할 판단과 반복을 얼마나 줄이는가?
- 사용자가 더 좋은 결과를 얻도록 돕는가?
- 사용자가 혼자 했을 때보다 NAgex를 사용했을 때 명백히 더 낫다고 느끼는가?

좋은 기능의 기준은 “작동한다”가 아니다.

사용자가 다음과 같이 느껴야 한다.

> 이걸 내가 직접 했으면 더 오래 걸렸을 것이다.

> NAgex가 있어서 일이 훨씬 쉬워졌다.

> 이건 다음에도 다시 NAgex에게 맡기고 싶다.


# 2. Emotional Experience — 사용자가 느끼는 감정

NAgex는 차가운 자동화 도구가 아니라 Personal AI다.

사용자는 NAgex를 사용하면서 다음을 느껴야 한다.

- 나를 이해한다.
- 내가 원하는 것을 빠르게 파악한다.
- 내가 놓친 부분을 챙겨준다.
- 복잡한 일을 대신 정리해준다.
- 믿고 맡길 수 있다.
- 결과가 나올 것이라는 기대감이 있다.
- 중요한 결정과 행동에 대한 통제권은 여전히 나에게 있다.

반대로 다음 감정을 만들면 실패다.

- 내가 뭘 눌러야 하지?
- 왜 이런 정보가 나오지?
- 지금 뭘 하고 있는 거지?
- 내가 원한 게 이게 아닌데?
- 너무 복잡하다.
- 개발자용 화면 같다.
- AI가 마음대로 행동할 것 같다.


# 3. Global User Perspective — 글로벌 사용자의 관점

NAgex의 UX는 특정 국가, 특정 기업문화, 특정 개발자, 특정 관리자 관점에 종속되지 않아야 한다.

모든 제품 결정에서 다음을 검토한다.

- 북미, 유럽, 아시아 사용자가 봐도 직관적인가?
- 별도의 설명 없이 사용할 수 있는가?
- 과도한 enterprise jargon이 없는가?
- 기술 용어가 사용자 언어보다 앞서지 않는가?
- 글로벌 SaaS 수준의 간결함과 세련됨이 있는가?
- 문화적으로 지나치게 경직되거나 권위적인 표현은 없는가?
- 사용자의 시간을 존중하는가?
- 사용자가 AI에게 일을 맡기는 것에 대한 불안보다 신뢰가 더 크게 느껴지는가?

글로벌 사용자는 내부 구조를 알고 싶어 하지 않는다.

그들이 원하는 것은 다음이다.

- 내가 요청한 것이 정확히 이해되었는가?
- 지금 제대로 진행되고 있는가?
- 결과가 유용한가?
- 다음에 무엇을 하면 되는가?


# 4. Expectation Before Result — 결과가 나오기 전의 기대감

좋은 AI 제품은 결과 화면에서만 만족을 주지 않는다.

작업이 진행되는 동안에도 사용자가 다음을 느껴야 한다.

> NAgex가 제대로 이해했다.

> 지금 제대로 진행되고 있다.

> 좋은 결과가 나올 것 같다.

따라서 진행 상태는 내부 pipeline을 보여주는 방식이 아니라 사용자가 이해할 수 있는 의미 있는 진행 상태로 보여준다.

잘못된 예:

- Plan Resolution
- Capability Broker
- Execution Graph
- Human Approval State
- Tool Routing

좋은 예:

- Searching trusted sources
- Reading recent updates
- Checking your calendar
- Finding related notes
- Preparing a concise summary
- Getting your meeting ready

진행 상태는 기술을 설명하기 위한 것이 아니라 사용자의 불확실성을 줄이기 위한 것이다.


# 5. Result Satisfaction — 결과 만족도

NAgex의 결과는 단순히 “완료됨” 상태가 아니다.

결과를 받은 사용자는 즉시 다음을 이해할 수 있어야 한다.

1. 무엇을 찾았는가?
2. 무엇이 중요한가?
3. 이것이 나에게 어떤 의미인가?
4. 다음에 무엇을 할 수 있는가?

결과 화면은 가능한 한 다음 구조를 따른다.

```text
Result
→ Key findings / outcome
→ Relevant context
→ Source / evidence
→ One clear next action
```

긴 설명보다 실제 활용 가능한 결과를 우선한다.


# 6. One Clear Next Action — 다음 행동은 명확해야 한다

사용자는 다음 행동을 추측하지 않아야 한다.

각 상태에는 가능한 한 하나의 명확한 다음 행동이 있어야 한다.

좋은 예:

- Ask a follow-up
- Save to Vault
- Add to calendar
- Send email
- Confirm booking
- Edit

나쁜 예:

- Run
- Execute
- Resolve
- Continue
- Approval
- Review Plan

단, `Continue`는 사용자의 의도 확인이나 plan acceptance처럼 의미가 명확한 경우에만 제한적으로 사용할 수 있다.

외부 상태를 실제로 변경하는 버튼은 반드시 결과를 직접 설명해야 한다.


# 7. Internal Complexity Must Stay Behind — 내부 복잡성은 뒤에 둔다

NAgex 내부에는 복잡한 시스템이 존재할 수 있다.

예:

- Planner
- Router
- Execution Engine
- Capability Broker
- Approval Object
- Workflow State
- Request ID
- Execution ID
- Payload Hash

이러한 개념은 일반 사용자 경험보다 앞에 나오면 안 된다.

복잡성은 시스템 내부에 두고, 사용자는 의미와 결과만 경험해야 한다.

필요한 경우 다음과 같은 Progressive Disclosure를 사용한다.

```text
What NAgex is doing ▾
```

기본값은 접힘 상태다.

개발자/디버그 모드는 별도로 제공한다.


# 8. Personal AI First — 개인 사용자 우선

현재 NAgex의 최우선 제품 타겟은 Personal / Prosumer 사용자다.

NAgex는 현재 단계에서 다음을 우선하지 않는다.

- Enterprise ERP
- Enterprise Workflow Platform
- Department Administration
- Organization Management
- Complex RBAC Management
- Enterprise Automation Builder

Enterprise 기능은 향후 별도 확장 영역으로 유지한다.

현재 제품 경험의 중심은 다음이다.

- Personal Memory
- Personal Context
- Calendar
- Email
- Tasks
- Files
- Search
- Analyze
- Create
- Reminder
- Watch
- Morning Brief
- Quick Wake
- Proactive Assistance
- Human-approved Actions


# 9. Personality AI — “나를 안다”는 느낌

NAgex는 단순히 질문에 답하는 AI가 아니다.

사용자는 시간이 지날수록 다음을 느껴야 한다.

> NAgex가 내 일정과 맥락을 알고 있다.

> 내가 자주 하는 일을 이해하고 있다.

> 내가 중요하게 생각하는 것을 기억한다.

> 내가 놓친 것을 챙겨준다.

하지만 과잉 추론은 금지한다.

NAgex는 근거 없는 성격, 선호, 관계를 만들어내면 안 된다.

Memory는 항상 가능한 한 다음을 가져야 한다.

- source
- confidence
- scope
- recency

사용자가 수정하거나 삭제한 Memory를 다시 사용하면 안 된다.


# 10. Proactive Assistance — 먼저 돕되, 통제권은 사용자에게

NAgex는 필요할 때 먼저 도움을 제안할 수 있다.

예:

- 30분 뒤 회의가 있으니 관련 자료를 준비할까요?
- 오늘 마감해야 할 작업이 2개 남았습니다.
- 답장이 필요한 중요 메일이 있습니다.
- 지난주에 반복했던 작업을 자동화할까요?

그러나 suggestion과 action을 구분한다.

```text
Suggestion != Action
```

읽기, 검색, 정리, 분석, 준비는 자동으로 수행할 수 있다.

외부 상태 변경은 반드시 Human Approval 원칙을 따른다.

예:

- Send email
- Add calendar event
- Delete
- Publish
- Book
- Purchase


# 11. Global Tone & Attitude — 서비스의 태도

NAgex의 태도는 다음과 같아야 한다.

- Calm
- Capable
- Respectful
- Concise
- Confident without arrogance
- Helpful without being intrusive

사용자를 가르치거나 훈계하는 듯한 표현은 피한다.

과도한 친근함이나 유치한 문구도 피한다.

사용자는 NAgex를 “도구”가 아니라 “믿고 일을 맡길 수 있는 개인 AI”로 느껴야 한다.


# 12. Result Expectation Loop — 기대와 만족의 순환

좋은 NAgex 경험은 다음 순환을 만든다.

```text
User request
→ NAgex understands
→ Meaningful progress
→ Useful result
→ Clear next action
→ User satisfaction
→ User trusts NAgex with more work
```

이 순환이 반복되면서 제품 가치가 커져야 한다.


# 13. Product Review Questions — 모든 기능 리뷰 전에 묻는 질문

모든 개발 완료 판단 전에 다음 질문에 답한다.

### User Efficacy
- 사용자가 실제로 더 빨라졌는가?
- 더 적은 판단과 반복으로 같은 또는 더 좋은 결과를 얻는가?

### Usability
- 설명 없이 사용할 수 있는가?
- 사용자가 다음 행동을 바로 이해하는가?

### Emotional Experience
- 신뢰감이 생기는가?
- 결과가 기대되는가?
- 사용자가 통제권을 느끼는가?

### Global Readiness
- 글로벌 사용자가 봐도 자연스러운가?
- 특정 기업/개발자 중심의 용어가 없는가?

### Result Quality
- 결과가 실제로 활용 가능한가?
- 결과가 사용자 맥락과 관련 있는가?

### Personal AI Value
- NAgex가 사용자를 이해하고 있다는 느낌을 주는가?
- 단순 챗봇과 차별화되는가?


# 14. UX Failure Conditions — 다음 반응이 예상되면 미완성

다음 사용자 반응이 예상되면 기능이 동작해도 완료가 아니다.

- 이게 왜 필요한지 모르겠다.
- 다음에 뭘 눌러야 하지?
- 왜 이런 정보가 나오지?
- 너무 복잡하다.
- 개발자용 화면 같다.
- AI가 지금 무엇을 하는지 모르겠다.
- 내가 요청한 것과 결과가 다르다.
- 이걸 다시 쓰고 싶지 않다.


# 15. Desired User Reaction — 목표 반응

NAgex가 만들어야 하는 최종 반응은 다음이다.

> 내가 원하는 걸 알아들었네.

> 알아서 잘 하고 있구나.

> 이건 편하다.

> 결과가 기대된다.

> 내가 놓친 것까지 챙겨주네.

> 그래도 중요한 건 내가 결정할 수 있네.

> 다음에도 이걸 NAgex에게 시켜야겠다.


# 16. Development Priority Order

앞으로 NAgex의 기능과 UI는 다음 순서로 판단한다.

```text
1. User Efficacy
2. Global User Experience
3. Emotional Trust & Expectation
4. Result Satisfaction
5. Personal AI Differentiation
6. Safety / Human Control
7. Technical Implementation
```

기술 구현이 위 순서를 역전시키면 안 된다.


# 17. Final Principle

NAgex는 기능이 많은 제품이 되는 것이 목표가 아니다.

NAgex는 사용자가 다음과 같이 느끼는 제품이어야 한다.

> “이 AI는 나를 이해하고, 내 일을 덜어주며, 결과를 믿고 기대할 수 있다.”

모든 제품 결정은 이 문장에서 출발한다.

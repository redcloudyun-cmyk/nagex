# NAgex R22 UX & Product Benchmark Master

**Document Type:** R22 Product / UX Canonical Benchmark  
**Product:** NAgex  
**Date:** 2026-09-18  
**Status:** CANONICAL INPUT FOR R22 DESIGN  
**Primary Principle:** Mobile-first Personal AI  
**Reference Products:** TapNow, Krater, Perplexity, Motion, ChatGPT, Claude

---

## 1. Purpose

이 문서는 NAgex R22 UX 및 제품 재설계를 위한 벤치마킹 기준 문서다.

목적은 경쟁 서비스의 기능을 복제하는 것이 아니다.

NAgex가 다음 질문에 일관된 답을 갖도록 만드는 것이 목적이다.

1. 사용자가 NAgex를 왜 사용해야 하는가?
2. 모바일에서 가장 먼저 보여야 하는 것은 무엇인가?
3. AI가 사용자를 위해 무엇을 미리 해야 하는가?
4. 여러 AI 모델을 사용한다는 기술적 특징을 어떻게 사용자 가치로 바꿀 것인가?
5. 언제 AI가 실행하고 언제 사람에게 승인을 받아야 하는가?
6. 검색·리서치·메모리·자동화·결과물을 하나의 Personal AI 경험으로 어떻게 연결할 것인가?
7. 경쟁 서비스에서 무엇을 채택하고 무엇을 의도적으로 버릴 것인가?

---

## 2. NAgex R22 Position

NAgex는 특정 LLM의 프론트엔드가 아니다.

NAgex는 많은 AI 기능을 한 화면에 모아 놓는 "AI 도구 종합백화점"도 아니다.

NAgex의 목표는:

> 사용자를 기억하고, 현재 맥락을 이해하고, 필요한 일을 예측하고, 적절한 AI와 도구를 선택해 실행하며, 중요한 판단과 실행에서는 사람에게 통제권을 돌려주는 Personal AI다.

핵심 포지셔닝:

> **Many models behind. One personal AI in front.**

사용자는 GPT, Gemini, Claude, Qwen, 기타 모델을 계속 선택하며 다닐 필요가 없어야 한다.

NAgex가 기본적으로 가장 적합한 모델을 선택하고, 필요한 경우 여러 모델의 서로 다른 판단까지 비교·통합한다.

---

## 3. R22 Non-Negotiable Principles

### 3.1 Mobile First

NAgex의 주 사용 경험은 모바일이다.

Desktop은 Primary Product가 아니라 Expanded Workspace다.

Mobile 우선 행동:
- 짧은 질문
- 빠른 확인
- Quick Wake
- Voice
- Today / Important
- 알림 → 즉시 행동
- 승인
- 미팅 준비
- 이동 중 리서치
- 카메라 / 파일 / 링크 공유
- 짧은 결과 확인

Desktop 확장 행동:
- 긴 문서
- 깊은 리서치
- 여러 결과 비교
- 복잡한 편집
- 다중 패널 작업
- 긴 세션
- 세부 설정

### 3.2 User Outcome Before AI Mechanics

사용자에게 다음 내부 기술 용어를 기본 화면에서 노출하지 않는다.

- Planner
- Router
- Runtime
- Capability
- Execution Graph
- Model Gateway
- Session ID
- Tenant
- Human Approval
- Provider Status

사용자가 알아야 하는 것은:
- 무엇을 알아냈는가
- 무엇을 추천하는가
- 무엇을 할 수 있는가
- 무엇을 실행하려는가
- 무엇이 완료되었는가
- 무엇을 내가 결정해야 하는가

### 3.3 Proactive, Not Noisy

AI가 먼저 움직이되 알림과 추천을 남발하지 않는다.

좋은 Proactive UX:

> "3시에 고객 미팅이 있습니다. 지난 회의와 Sarah의 최근 이메일을 정리해 두었습니다."

나쁜 Proactive UX:

> "AI가 14개의 인사이트를 생성했습니다."

### 3.4 Human Approval at Consequence Boundaries

모든 단계에서 승인받지 않는다.

그러나 다음과 같은 의미 있는 외부 결과가 발생할 때는 사람이 최종 통제권을 가진다.

- 이메일 전송
- 일정 생성/변경
- 외부 게시
- 파일 삭제
- 결제/구매
- 중요한 데이터 변경
- 높은 비용의 AI 생성
- 돌이키기 어려운 작업

승인 UI에서는 기술적인 내부 처리보다 결과를 보여준다.

```text
Client follow-up

Tue, 2:30–3:00 PM

This will add a new event to your Google Calendar.

[Edit] [Add]
```

---

## 4. Benchmark 1 — TapNow

### 4.1 What TapNow Does Well

TapNow는 자신을 Creative OS로 정의한다.

핵심 구조는 단순 생성기가 아니라:
- 텍스트
- 이미지
- 오디오
- 비디오
- 여러 AI 모델
- Agent
- Canvas
- Apps

를 하나의 작업 흐름으로 연결한다.

Agent는 사용자가 제공한 맥락을 읽고:
1. Context 이해
2. Task 확인
3. Plan
4. 실행
5. 특정 결과 수정
6. Delivery 준비

과정을 수행한다.

또한 높은 비용의 생성, 게시, 외부 sync 등에서는 사용자 승인 경계를 둔다.

### 4.2 Strongest UX Pattern

- Result-centric workspace
- Context stays with the work
- Clone / Remix
- Explicit execution boundary

### 4.3 Adopt for NAgex

- 결과물을 대화 속 일회성 답변으로 끝내지 않는다.
- 결과 → 수정 → 저장 → 재사용 흐름을 만든다.
- 실행 전 "어디까지 할 것인지"를 자연어 수준에서 구분한다.
- 사용자의 승인된 결과를 이후 작업의 Context로 활용한다.
- 수정 시 전체를 다시 생성하지 않고 "바꿀 것 / 유지할 것"을 분리한다.

### 4.4 Do Not Copy

- Node graph가 Primary UX가 되어서는 안 됨
- 사용자가 모델/노드를 직접 연결해야 하는 UX 지양
- 생성모델 설정이 제품 중심이 되어서는 안 됨

---

## 5. Benchmark 2 — Krater

### 5.1 What Krater Does Well

Krater는 All-in-One AI Workspace를 지향한다.

공식 제품 페이지 기준 주요 특징:
- 400+ AI models
- Auto Router
- Agent
- 300+ App connections
- Memory
- Projects
- Scheduled Tasks
- Deep Research
- Image / Video / Audio / Code generation
- Credits based subscription

### 5.2 Strongest Product Lesson

Krater의 핵심 메시지는 여러 AI와 앱을 하나의 제품에서 사용할 수 있고 복잡성을 줄인다는 것이다.

### 5.3 Important Warning for NAgex

NAgex가 "우리는 100개 모델 지원"을 제품 중심 가치로 내세우면 Krater와 같은 경쟁축으로 들어간다.

모델 개수 경쟁은:
- 차별화 약함
- API 비용 증가
- 사용자 복잡성 증가
- 공급자의 기능 수 경쟁으로 전락

할 수 있다.

### 5.4 Adopt for NAgex

- Auto model selection
- Provider-independent architecture
- Credit abstraction
- Connected app actions
- Scheduled / recurring actions
- 복잡한 AI provider를 사용자에게 감추는 방식

### 5.5 Do Not Copy

- 모델 picker 중심 UI
- 모델 숫자 강조
- AI 도구 카탈로그 중심 홈
- 이미지/영상/음성 모델 수 경쟁

### 5.6 NAgex Advantage Opportunity

```text
Question
→ Best primary model
→ Answer
→ Need alternative reasoning?
→ Multi-model comparison
→ NAgex synthesis
```

---

## 6. Benchmark 3 — Perplexity

### 6.1 What Perplexity Does Well

Perplexity의 강점:
- 최신 웹 검색
- 소스 기반 답변
- citation
- Deep Research
- 파일 + 웹 교차 확인
- Multi-model orchestration
- Research → Report / Deck / Dashboard

### 6.2 Strongest UX Pattern

> 최신성이 중요한 질문에서는 모델 지식보다 Evidence가 먼저다.

### 6.3 Adopt for NAgex

```text
Question
↓
Freshness classification
↓
Evidence retrieval
↓
Evidence Pack
↓
Reasoning
↓
Answer
↓
Sources
```

Evidence-first 대상:
- 금융
- 시장
- 기업
- 정치
- 국제정세
- 제품 가격
- 법률/정책
- 최신 기술
- 여행/지역정보

### 6.4 NAgex Extension

```text
Shared Evidence Pack
↓
GPT
Claude
Gemini
Qwen
...
↓
Consensus
Differences
Assumptions
Invalidation Conditions
```

즉:

> Evidence-first + Multi-model interpretation

---

## 7. Benchmark 4 — Motion

### 7.1 What Motion Does Well

Motion은 사용자가 할 일을 모두 직접 정렬하게 하지 않는다.

AI가:
- 일정
- deadline
- 우선순위
- dependency
- 시간 가용성

을 바탕으로 실제 하루를 자동 계획한다.

### 7.2 Strongest Product Lesson

> 지금 무엇을 해야 하는지 사용자가 고민하지 않게 한다.

NAgex Home은 Dashboard가 아니라:

> Decision + Next Action Surface

가 되어야 한다.

### 7.3 Adopt for NAgex

```text
Right now

1. Client meeting in 42 min
   → Prepare

2. Sarah is waiting for an answer
   → Review

3. This task may miss Friday's deadline
   → Replan
```

### 7.4 Do Not Copy

NAgex는 일정 최적화 전용 서비스가 아니다.

---

## 8. Benchmark 5 — ChatGPT

### 8.1 What ChatGPT Does Well

- conversational entry
- web search
- file/image analysis
- projects
- memory
- deep research
- scheduled tasks
- plugins/apps
- external app actions
- rich in-chat UI

### 8.2 Strongest Product Lesson

Chat이 모든 기능의 공통 진입점이 될 수 있다.

사용자가 기능 메뉴를 먼저 선택하지 않고 자연어로 목표를 말하면 시스템이 필요한 기능을 찾아야 한다.

### 8.3 Adopt for NAgex

NAgex 역시 Chat/Voice/Quick Wake를 공통 진입점으로 사용한다.

하지만 대화 결과를:
- Today
- Task
- Approval
- Activity
- Vault
- Memory
- Notification

으로 연결한다.

### 8.4 Opportunity Beyond ChatGPT

- Personal Day Context
- proactive behavior
- Mobile action surface
- Multi-model comparison
- Personal operational continuity

---

## 9. Benchmark 6 — Claude

### 9.1 What Claude Does Well

대표 UX 패턴:
- Projects
- Project knowledge
- long-context work
- Artifacts
- side-by-side creation
- editable outputs
- focused workbench experience

### 9.2 Strongest UX Pattern

> Conversation ≠ Result

### 9.3 Adopt for NAgex

모바일:
- Compact Result Card
- Open Result
- Edit
- Save
- Share

Desktop:

```text
Context / Chat
        +
Working Result
```

### 9.4 Do Not Copy

NAgex가 Artifact editor 중심 제품이 되어서는 안 된다.

---

## 10. Benchmark 7 — DoppelBrain

### 10.1 What DoppelBrain Does Well

DoppelBrain은 자신을 특정 AI 모델의 대체품으로 두기보다, 사용자의 **공통 기억 계층(shared memory layer)** 으로 포지셔닝한다.

공개 제품 설명 기준 주요 특징:

- Chrome 확장 프로그램을 통해 사용자가 읽은 웹 페이지를 자동으로 기억
- 페이지 내용, 제목, URL, 읽은 시점 등을 개인 지식으로 축적
- 사용자가 별도로 폴더나 태그를 만들지 않아도 주제별로 자동 정리
- 현재 페이지와 과거에 읽은 자료를 자연어로 검색
- ChatGPT, Claude, Gemini 등 여러 AI가 동일한 기억을 사용할 수 있도록 MCP 기반 연결
- AI별로 흩어진 맥락을 하나의 공통 Personal Memory로 연결
- 민감 사이트 자동 차단 및 사용자 제어 기반 수집
- 읽었던 자료의 원문 출처를 함께 제시
- 사용자의 관심사를 기반으로 다음에 볼 자료나 장소 등을 제안

DoppelBrain이 내세우는 핵심 가치는 다음과 같이 요약할 수 있다.

> **One shared memory across multiple AIs.**

즉, 모델을 하나로 통합하는 것이 아니라 **사용자의 기억을 모델들 사이에서 공유**하게 한다.

### 10.2 Strongest Product Lesson

NAgex에 가장 중요한 교훈은:

> **모델이 바뀌어도 사용자의 기억은 바뀌면 안 된다.**

이다.

사용자가 오늘 Gemini를 사용하고 내일 Claude를 사용하더라도:

- 사용자가 누구인지
- 무엇을 읽었는지
- 무엇을 중요하게 보는지
- 어떤 프로젝트를 진행 중인지
- 최근 무엇을 결정했는지
- 어떤 자료를 신뢰했는지

가 계속 이어져야 한다.

이것은 NAgex의 모델 비종속 전략과 직접 연결된다.

```text
GPT Memory      ┐
Gemini Memory   │
Claude Memory   │  → Provider-specific islands
Qwen Memory     ┘
```

가 아니라:

```text
               NAgex Personal Context
                        ↓
          Shared Personal Memory Layer
                        ↓
       ┌────────┬────────┬────────┬────────┐
       │ OpenAI │ Gemini │ Claude │ Qwen   │
       └────────┴────────┴────────┴────────┘
```

구조를 가져가야 한다.

### 10.3 Adopt for NAgex

#### A. Provider-independent Personal Memory

Memory는 OpenAI, Gemini, Claude 등의 conversation memory에 종속되지 않는다.

NAgex 자체가 사용자 기억의 canonical source가 되어야 한다.

#### B. Passive Context Capture

사용자가 매번:

- 저장
- 태그
- 폴더 지정

을 해야만 기억되는 구조를 피한다.

사용자 승인과 개인정보 원칙 안에서:

- 읽은 자료
- 저장한 링크
- 대화
- Vault
- 일정
- 작업
- 승인된 결과
- 최근 활동

에서 재사용 가치가 높은 context를 자동으로 추출할 수 있어야 한다.

#### C. Ask About What I Already Saw

예:

```text
지난주에 읽었던 로컬 LLM 서버 관련 글이 뭐였지?
```

또는:

```text
내가 최근에 봤던 5090 관련 자료와 지금 보고 있는 제품을 비교해줘.
```

처럼 URL이나 파일명을 기억하지 못해도 자연어로 찾을 수 있어야 한다.

#### D. Source-attached Memory

NAgex Memory는 가능한 경우 다음을 유지한다.

```text
memory
source
source_type
created_at
last_seen_at
last_used_at
confidence
```

"AI가 기억하고 있다"는 것과 "원래 어디서 나온 정보인지"를 구분한다.

#### E. Cross-model Context Continuity

Perspective Compare / Forecast Compare에서도 모든 모델에 사용자의 관련 Personal Context를 동일하게 제공할 수 있다.

단, 비교의 공정성이 필요한 경우:

```text
Shared Personal Context
+
Shared Evidence Pack
```

을 같은 형태로 제공한다.

### 10.4 Privacy Lesson

DoppelBrain은 공개 설명상 민감 도메인에 대한 blocklist와 사용자 제어형 tracking을 강조한다.

NAgex도 Passive Context를 강화할수록 Privacy UX를 별도 기능이 아니라 제품 핵심으로 취급해야 한다.

최소 원칙:

```text
REMEMBER
PAUSE
NEVER REMEMBER THIS
FORGET
```

를 사용자가 이해할 수 있는 언어로 제공한다.

또한 다음은 기본적으로 민감 영역으로 취급하는 것을 검토한다.

- 금융
- 인증
- 의료
- 비밀번호
- 개인식별정보
- 결제
- 정부/행정
- 민감한 개인 커뮤니케이션

자동 수집은 "가능한 것"과 "해야 하는 것"을 구분해야 한다.

### 10.5 Do Not Copy

DoppelBrain의 핵심은 browsing memory다.

NAgex가 Browser History Product가 되어서는 안 된다.

NAgex의 Personal Context는 더 넓다.

```text
Browsing
+
Conversation
+
Calendar
+
Email
+
Tasks
+
Files
+
Vault
+
Projects
+
People
+
Preferences
+
Decisions
+
Actions
```

따라서 browsing은 여러 context source 중 하나다.

### 10.6 NAgex Extension

DoppelBrain:

```text
Remember what you read
↓
Share it with multiple AIs
```

NAgex:

```text
Remember what matters about you
↓
Understand current context
↓
Give the right context to the right AI
↓
Compare different AI judgments when useful
↓
Turn the decision into action
↓
Remember the outcome
```

여기서 가장 중요한 차이는 **Memory → Decision → Action → Memory**의 폐쇄 루프다.

```text
Personal Context
      ↓
Understand
      ↓
Reason
      ↓
Act
      ↓
Outcome
      ↓
Update Personal Context
```

이 루프가 NAgex의 장기적인 핵심 구조가 되어야 한다.

---

## 11. Updated Cross-Benchmark Comparison

| Product | Core Strength | What User Sees | NAgex Should Learn | NAgex Should Avoid |
|---|---|---|---|---|
| TapNow | Agent + Canvas + creation flow | Work/result graph | Execution boundaries, reusable results, human approval | Node complexity as primary UX |
| Krater | Many models/apps in one place | AI workspace/catalog | Model independence, Auto Router, credits | Model-count competition |
| Perplexity | Evidence-first research | Answers + citations | Fresh evidence, source transparency | Research-only identity |
| Motion | Proactive prioritization | What to do next | Next-action UX, proactive assistance | Calendar-only worldview |
| ChatGPT | Universal conversational entry | Chat + tools + projects | Natural-language entry, memory/context | Chat-only product |
| Claude | Deep work + artifacts | Conversation + result | Result-centric editing, persistent project context | Document-only identity |
| DoppelBrain | Cross-AI personal memory | Shared memory of what user read | Provider-independent memory, passive context capture, source-attached recall | Becoming a browser-history product |
| NAgex | Personal AI orchestration | One personal AI | Combine context, reasoning, action and model synthesis | Becoming generic AI toolbox |

---

## 12. NAgex Memory Architecture Principle

R22부터 Memory에 대해 다음 원칙을 명시한다.

> **NAgex owns the user context. Models consume context; models do not own it.**

즉:

```text
MODEL ≠ MEMORY OWNER
NAGEX = PERSONAL CONTEXT OWNER
```

Provider를 교체해도:

- Memory
- Vault
- Personal Context
- Relationships
- Preferences
- Action history
- Decisions

은 그대로 유지된다.

### Canonical Flow

```text
Context Sources
  ├─ Conversation
  ├─ Browser
  ├─ Files
  ├─ Vault
  ├─ Calendar
  ├─ Email
  ├─ Tasks
  ├─ Connected Apps
  └─ User-approved memories
          ↓
Personal Context Engine
          ↓
Relevant Context Retrieval
          ↓
Model Router
          ↓
Selected Model(s)
          ↓
Answer / Decision / Action
          ↓
Outcome
          ↓
Memory Update Candidate
          ↓
Policy / User Control
          ↓
Personal Context
```

### User-visible Principle

사용자는:

> "어떤 AI가 나를 기억하나?"

가 아니라:

> **"NAgex가 나를 기억하고, 필요할 때 적절한 AI가 그 맥락을 사용한다."**

라고 이해해야 한다.

---

## 13. Additional R22 Memory Priorities

### P0
- Provider-independent Personal Context
- source-attached memory
- memory retrieval across conversations
- explicit Remember / Forget controls
- sensitive-context exclusion policy
- model-independent context injection

### P1
- browser/link context capture
- automatic topic grouping
- "Ask about what I've seen"
- stale memory detection
- conflicting memory detection
- context provenance UI

### P2
- optional browser extension
- cross-device passive capture
- personal knowledge graph visualization
- proactive "you've seen something relevant before" suggestions
- user-defined source inclusion/exclusion rules

---

## 14. Benchmark Decision Update

DoppelBrain에서 **강하게 채택할 원칙**:

- Personal Memory는 모델과 분리한다.
- 여러 AI가 동일한 사용자 Context를 사용하게 한다.
- 사용자가 파일명을 기억하지 못해도 의미로 찾게 한다.
- Memory에 source provenance를 유지한다.
- Context capture는 가능하면 자동화하되 사용자 제어권을 우선한다.
- 민감 정보는 기본적으로 보호한다.

DoppelBrain에서 **그대로 가져오지 않을 것**:

- 브라우징 기록 자체를 제품 정체성으로 만드는 것
- 무제한 passive capture
- 사용자가 모르는 사이 모든 페이지를 기억하는 경험
- Browser extension을 NAgex 사용의 필수 조건으로 만드는 것

---

## 15. Updated Canonical Product Statement

> **NAgex is a mobile-first Personal AI that owns and protects your personal context independently of any AI model, understands what matters now, selects and coordinates the right models and tools, compares different judgments when useful, and takes action under your control.**

한국어:

> **NAgex는 특정 AI 모델과 독립적으로 사용자의 개인 맥락을 기억하고 보호하며, 지금 중요한 일을 이해하고, 적절한 AI와 도구를 선택·조율하고, 판단이 엇갈릴 때는 다른 관점을 비교해 주며, 사용자의 통제 아래 실제 행동까지 이어지는 모바일 중심 Personal AI다.**

---

## 16. Additional Canonical Rules

```text
PERSONAL_CONTEXT_OWNER=NAGEX
MODEL_MEMORY_DEPENDENCY=FALSE
CROSS_MODEL_CONTEXT_CONTINUITY=TRUE
MEMORY_SOURCE_PROVENANCE=REQUIRED
PASSIVE_CAPTURE=USER_CONTROLLED
SENSITIVE_CONTEXT_DEFAULT_PROTECTION=TRUE
BROWSER_MEMORY=OPTIONAL_CONTEXT_SOURCE
MEMORY_DECISION_ACTION_LOOP=CORE
```

---

### DoppelBrain Official Sources

Accessed 2026-09-18.

- https://www.doppelbrain.ai/
- https://www.doppelbrain.ai/privacy-policy

---

## 17. R22 Screen Redesign Template

모든 화면은 다음 구조로 리뷰한다.

```text
CURRENT
↓
PROBLEM
↓
BENCHMARK
↓
ADOPTABLE PATTERN
↓
NAGEX VERSION
↓
MOBILE MOCKUP
↓
DESKTOP MOCKUP
↓
FUNCTIONAL REQUIREMENTS
↓
ACCEPTANCE CRITERIA
```

각 화면은 반드시 네 질문에 답한다.

1. 사용자는 이 화면에서 무엇을 끝내야 하는가?
2. 가장 중요한 Hero Action은 무엇인가?
3. NAgex가 먼저 해줄 수 있는 것은 무엇인가?
4. Proposed / Working / Approval / Completed / Failed 상태를 어떻게 표현하는가?

---

## 18. R22 Priority

### P0 — Product Identity / Mobile Core
- Mobile Home redesign
- Quick Wake
- Meeting Prep
- Approval
- Result state
- Activity
- Vault contextual UX
- Truthful execution state
- Technical language removal

### P0 — Answer Intelligence
- Primary model routing
- Perspective Compare
- Forecast Compare
- Evidence Pack
- source freshness
- multi-model synthesis

### P0 — Personal Context / Memory
- Provider-independent memory
- source provenance
- explicit Remember / Forget controls
- model-independent context injection
- sensitive-context protection

### P1
- Inbox contextual action
- Research result UX
- Save/reuse result
- Notification → action
- Personal Context editing
- browser/link context capture
- result/artifact workspace

### P2
- Historical forecast tracking
- model performance history
- reusable workflows/templates
- user-specific model preferences
- advanced consensus methodology
- optional browser extension
- cross-device passive capture

---

## 19. What NAgex Must NOT Become

- Generic Chatbot
- AI Model Marketplace
- Automation Builder
- Dashboard
- File Vault
- Calendar Optimizer
- Browser History Product

NAgex는 이 기능들을 필요에 따라 사용하지만 어느 하나가 제품 정체성이 아니다.

---

## 20. Canonical Product Rules

```text
NAGEX_R22_MOBILE_FIRST=TRUE
NAGEX_PRIMARY_EXPERIENCE=PERSONAL_AI
MODEL_PROVIDER_VISIBILITY=LOW_BY_DEFAULT
MODEL_INDEPENDENCE=CORE
SINGLE_MODEL_DEFAULT=TRUE
MULTI_MODEL_COMPARISON=ON_DEMAND
EVIDENCE_FIRST_FOR_FRESH_OR_FORECAST_QUESTIONS=TRUE
PROACTIVE_ASSISTANCE=CORE
HUMAN_CONTROL=CORE
RESULT_CENTRIC_UX=TRUE
PERSONAL_CONTEXT_OWNER=NAGEX
MODEL_MEMORY_DEPENDENCY=FALSE
CROSS_MODEL_CONTEXT_CONTINUITY=TRUE
MEMORY_SOURCE_PROVENANCE=REQUIRED
PASSIVE_CAPTURE=USER_CONTROLLED
SENSITIVE_CONTEXT_DEFAULT_PROTECTION=TRUE
TECHNICAL_UI_LEAK=0
FAKE_SUCCESS_PATHS=0
```

---

## 21. Official Benchmark Sources

Accessed 2026-09-18.

### TapNow
- https://www.tapnow.ai/
- https://docs.tapnow.ai/en/docs/agent/tapnow-agent
- https://docs.tapnow.ai/en/docs/agent/chat-with-agent

### Krater
- https://krater.ai/

### Perplexity
- https://www.perplexity.ai/hub
- https://www.perplexity.ai/ko/hub/products/deep-research

### Motion
- https://www.usemotion.com/features/ai-task-manager

### ChatGPT / OpenAI
- https://help.openai.com/
- https://openai.com/

### Claude / Anthropic
- https://www.anthropic.com/

### DoppelBrain
- https://www.doppelbrain.ai/
- https://www.doppelbrain.ai/privacy-policy

---

`NAGEX_R22_BENCHMARK_MASTER=CANONICAL`

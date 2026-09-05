# AGEX Unified Agent Platform

**Personal Agent Runtime 통합 개발 지시서**

- **문서 상태**: Master Development Directive
- **버전**: 1.0
- **목적**: AGEX 기존 Agent Platform과 개인화된 Autonomous Personal Agent Runtime을 하나의 제품 경험으로 통합하기 위한 최상위 개발 기준 정의

> **적용 범위 제한 (2026-08-22 결정, 2026-08-24 문서화)**: 본 문서는 `docs/INDEX.md`가 지적한 대로 기존에 합의된 "데스크톱/Personal Agent는 별도 프로젝트·코드베이스" 방향과 충돌했으며, 사용자에게 이 충돌을 보고한 뒤 다음과 같이 해소되었다 — **Personal Agent(데스크톱, 코드명 Antigravity)는 이 저장소와 분리된 별도 코드베이스로 개발**하며, 본 문서 §5/§9/§10/§68/§90/§94의 Unified Agent Core(Agent/Capability/Runtime/Tool/Memory/Task/Policy/Node를 `runtimeProfile`로 공유하는 단일 백엔드) 요구사항은 Personal Agent에는 **적용하지 않는다**. 본 문서 §2(One Product)·§3(UX 통일)의 "사용자에게는 하나의 제품처럼 보여야 한다"는 원칙만 유지하며, 이는 백엔드 통합이 아니라 `public/`(index.html, style.css, app.js, i18n.js, assets/) 프론트엔드 자산 공유로 달성한다. 즉 본 문서의 백엔드/Runtime 통합 지시는 AGEX Standard Agent(이 저장소)의 향후 Standard-내부 다중 Agent 유형 구분에는 여전히 유효하지만, Personal Agent와의 코드베이스 통합에는 더 이상 적용되지 않는다.

---

## 1. 프로젝트 정의

AGEX는 앞으로 두 종류의 Agent 실행 체계를 하나의 플랫폼 안에서 제공한다.

### A. AGEX Standard Agent

일반적인 업무형·조직형·전문 Agent.

예:
- Research Agent
- Coding Agent
- Document Agent
- Data Agent
- Marketing Agent
- Customer Agent
- Workflow Agent
- Enterprise Agent

### B. AGEX Personal Agent

개인의 PC·서버·브라우저·파일·일정·메일·메신저·애플리케이션과 연결되어 장기간 상주하며 사용자를 대신해 지속적으로 업무를 수행하는 Personal Autonomous Agent.

그러나 최종 사용자에게 두 시스템은 별개의 제품으로 노출하지 않는다.

최종 사용자 경험은 다음과 같아야 한다.

```
AGEX
│
├─ Agent A
├─ Agent B
├─ Agent C
├─ My Personal Agent
├─ Coding Agent
└─ Research Agent
```

사용자는 Agent가 내부적으로 어느 Runtime에서 실행되는지를 알 필요가 없다.

---

## 2. 최상위 제품 원칙

### 2.1 One Product

사용자에게는 하나의 AGEX만 존재해야 한다.

**금지**: `AGEX Agent`, `Personal AI`, `OpenClaw Mode`, `Personal Claw`, `별도 서비스`와 같이 서로 다른 제품처럼 보이도록 분리하는 UI.

**허용**: `Agent Type`, `Capabilities`, `Environment`, `Runtime Profile` 등 내부 설정 차원에서의 구분.

---

## 3. 사용자 경험의 핵심 원칙

두 Agent 유형의 UI를 최대한 동일하게 유지한다.

사용자가 보는 기본 화면:

```
┌──────────────────────────────────────────────────────┐
│ AGEX                                                  │
├──────────────┬─────────────────────────┬──────────────┤
│ New Chat     │                         │ Context      │
│ Agents       │ Conversation            │ Tasks        │
│ Tasks        │                         │ Tools        │
│ Automations  │                         │ Files        │
│ Knowledge    │                         │ Activity     │
│ Workflows    │                         │              │
└──────────────┴─────────────────────────┴──────────────┘
```

Standard Agent와 Personal Agent 모두 이 인터페이스를 사용한다.

---

## 4. Runtime 차이는 UI가 아니라 내부 Architecture에서 처리한다

```
AGEX Unified UI
 │
 ▼
AGEX Gateway
 │
 Agent Orchestrator
 │
 ┌────────────┴────────────┐
 │                          │
 ▼                          ▼
Standard Runtime      Personal Runtime
 │                          │
 Normal Tools               Host Tools
 Knowledge                  Browser
 Workflow                   Device
 Plugins                    Files
 RAG                        Shell
 APIs                       Memory
                             Automation
                             Messaging
```

사용자는 Runtime을 직접 선택할 필요가 없어야 한다. Agent Definition에 따라 시스템이 자동 선택한다.

---

## 5. 핵심 설계 개념 — Runtime Profile

모든 Agent에 다음 필드를 둔다.

```typescript
interface AgentDefinition {
  id: string
  name: string
  identity: AgentIdentity

  runtimeProfile: RuntimeProfile

  models: ModelConfiguration
  memory: MemoryConfiguration
  tools: ToolPolicy
  skills: SkillReference[]
  knowledge: KnowledgeReference[]
  workflows: WorkflowReference[]
  channels: ChannelBinding[]
  security: SecurityPolicy
}
```

---

## 6. Standard Runtime

Runtime Profile:

```typescript
type RuntimeProfile =
  | "standard"
  | "personal"
  | "hybrid"
```

기존 AGEX Agent 기능을 담당한다.

주요 기능: LLM, Knowledge, RAG, Memory, Tools, Skills, Workflow, Plugin, API, MCP, Multi-Agent

주로 Server-side에서 실행한다.

---

## 7. Personal Runtime

개인화된 상주형 Agent를 담당한다.

추가 capability: Personal Memory, Local Files, Local Browser, Local Shell, Desktop, Device, Email, Calendar, Messaging, Notifications, Background Tasks, Automation, Heartbeat, Personal Context, Personal Credentials

---

## 8. Hybrid Runtime

AGEX의 중요한 차별 기능으로 만든다.

Standard와 Personal Runtime을 동시에 사용할 수 있는 Agent다.

예: "지난달 회사 매출 자료를 분석하고, 결과를 보고서로 작성해서 오늘 오후 회의 전에 내 이메일로 보내줘."

Agent 처리:

```
User Request
 │
 ▼
AGEX Agent
 │
 ├─ Knowledge
 ├─ Data Analysis
 ├─ Document Generation
 ├─ Personal Email
 └─ Calendar
```

사용자는 Runtime이 변경되었다는 사실을 알 필요가 없다.

---

## 9. AGEX Unified Agent Core

Standard Agent와 Personal Agent가 다음 Core를 공유해야 한다.

- Agent Identity
- Prompt Assembly
- Context Engine
- Model Router
- Memory Interface
- Tool Interface
- Skill Interface
- Task Interface
- Security Interface
- Event Interface
- Session Interface

별도 Agent Framework를 두 개 만들지 않는다.

---

## 10. 절대 금지 Architecture

다음과 같이 만들지 않는다.

```
AGEX
│
├── Existing Agent System
│
└── Personal Agent System
```

두 시스템을 별개의 애플리케이션으로 구현한 후 UI만 연결하는 방식은 금지한다.

그렇게 하면 장기적으로: Agent 관리 이원화, Memory 이원화, Tool 이원화, Plugin 이원화, 권한 이원화, Session 이원화, Workflow 이원화 문제가 발생한다.

---

## 11. 올바른 Architecture

```
AGEX Platform
 │
 Unified Agent Core
 │
 ┌────────────────┼─────────────────┐
 │                 │                  │
 Runtime          Capability         Policy
 Manager          Manager            Engine
 │                 │                  │
 └────────────────┼─────────────────┘
 │
 Execution Environment
 │
 ┌───────────────┴───────────────┐
 │                                 │
 Cloud/Server                Personal Node
```

---

## 12. Capability 기반 Agent Architecture

Agent Type보다는 Capability를 중심으로 설계한다.

예:

```json
{
  "capabilities": [
    "web.search",
    "browser.control",
    "files.local",
    "email.read",
    "email.send",
    "calendar.read",
    "shell.execute",
    "memory.personal"
  ]
}
```

Agent가 어떤 능력을 가지고 있는지에 따라 Runtime을 자동 결정한다.

---

## 13. Capability Registry

플랫폼 전체 capability registry를 만든다.

예: `knowledge.search`, `web.search`, `web.fetch`, `browser.navigate`, `browser.click`, `browser.type`, `file.read`, `file.write`, `file.delete`, `shell.execute`, `email.read`, `email.send`, `calendar.read`, `calendar.create`, `messaging.send`, `device.camera`, `device.location`, `device.screen`, `memory.read`, `memory.write`, `agent.delegate`, `workflow.run`

---

## 14. Unified Tool System

Standard Agent와 Personal Agent의 Tool 시스템을 통합한다.

```
Tool Registry
 │
 ┌────────────────┼─────────────────┐
 │                 │                  │
 Cloud Tool       Server Tool        Local Tool
```

예:

| Tool | 실행 위치 |
|---|---|
| web_search | Cloud |
| database_query | Server |
| browser_click | Local |
| file_read | Local |
| email_send | Connector |

Agent는 실행 위치를 알 필요가 없다.

---

## 15. Tool Resolver

```
Agent
 ↓
Tool Request
 ↓
Tool Resolver
 ↓
Policy Engine
 ↓
Execution Resolver
 ↓
Cloud / Gateway / Personal Node
```

예: `file.read` 호출 시:

```
Execution Resolver
 ↓
사용자의 Windows Node
 ↓
Local File Tool
```

---

## 16. AGEX Personal Node

Personal Agent의 가장 중요한 구성요소다.

사용자의 PC 또는 Server에 설치되는 경량 Runtime이다.

**명칭**: AGEX Node (권장)

---

## 17. AGEX Node 역할

AGEX Node: Browser, Files, Shell, Applications, Clipboard, Screen, Notifications, Device, Local Models, Local Memory, Credentials

Node가 Gateway와 연결된다.

```
AGEX Cloud / Server
 │
 Gateway
 │
 WebSocket/TLS
 │
 AGEX Node
 │
 User Computer
```

---

## 18. Node Pairing

새 PC 연결 과정:

```
Install AGEX Node
 ↓
Login
 ↓
Pair Device
 ↓
User Approval
 ↓
Capability Discovery
 ↓
Policy Configuration
 ↓
Connected
```

---

## 19. Node Capability Discovery

Node는 자신이 지원하는 기능을 Gateway에 알린다.

예:

```json
{
  "node": "office-pc",
  "capabilities": [
    "browser",
    "filesystem",
    "shell",
    "clipboard",
    "notifications"
  ]
}
```

---

## 20. Unified Chat

Standard와 Personal Agent 모두 같은 Chat 화면을 사용한다.

사용자: "내 다운로드 폴더에서 어제 받은 계약서를 찾아줘."

AGEX:

```
Thinking
↓
Files
↓
Office PC
↓
Search
↓
Result
```

화면에서는 일반 Tool Call과 동일하게 표시한다.

---

## 21. Agent Capability 표시

사용자가 이해하기 쉽도록 Agent 상세 화면에는 기술적인 Runtime 대신 능력을 표시한다.

예:

**My Assistant**

Capabilities: ✓ Web · ✓ Browser · ✓ Email · ✓ Calendar · ✓ Local Files · ✓ Desktop · ✓ Memory · ✓ Automation

**금지**: `Personal Runtime v2`, `Local Node Executor`, `Gateway RPC Mode` 같은 용어. 일반 사용자는 이런 용어를 볼 필요가 없다.

---

## 22. Agent 생성 UX

다음 Wizard를 제공한다.

**Create Agent**
1. What should this Agent do?
2. Select abilities — Web, Knowledge, Files, Browser, Email, Calendar, Coding, Automation, Computer
3. Choose Model
4. Memory
5. Permissions
6. Create

Agent Type을 선택시키지 않는다. Capabilities에 따라 Runtime Profile을 자동 생성한다.

---

## 23. 자동 Runtime 판정

예:

- **Agent A** — Knowledge, Web, RAG → `runtime = standard`
- **Agent B** — Files, Browser, Email, Computer → `runtime = personal`
- **Agent C** — Knowledge, Workflow, Email, Browser → `runtime = hybrid`

---

## 24. Unified Memory Architecture

AGEX Memory를 공통으로 사용한다. 다만 Memory Scope를 분리한다.

```
Memory
├─ Session Memory
├─ Agent Memory
├─ User Memory
├─ Workspace Memory
├─ Organization Memory
└─ Device Memory
```

---

## 25. Personal Memory

개인 Agent가 사용하는 Memory: User preferences, Frequently used applications, Working habits, Important contacts, Personal routines, Projects, Device information, Past Agent actions, Personal decisions

---

## 26. Organization Memory와 분리

절대적으로 다음 구조를 유지한다.

```
Personal Memory
 │
 X
 │
Organization Memory
```

명시적으로 허용하지 않는 이상 자동 공유하지 않는다.

---

## 27. Context Engine

모든 Agent가 동일 Context Engine을 사용한다.

```
User Request
 ↓
Context Engine
 │
 ├─ Session
 ├─ User
 ├─ Agent
 ├─ Memory
 ├─ Knowledge
 ├─ Device
 ├─ Tasks
 └─ Environment
 ↓
Model
```

---

## 28. Personal Context

Personal Agent에서는 다음 Context가 추가될 수 있다: Current Device, Current Time, Location, Calendar, Active Project, Recent Files, Recent Applications, Running Tasks

단, Privacy Policy에 따라 사용한다.

---

## 29. Persistent Personal Agent

Personal Agent는 Chat 창을 닫았다고 종료되지 않는다.

다음 상태를 유지해야 한다: Online, Idle, Working, Waiting, Sleeping, Offline

---

## 30. Heartbeat

Personal Agent에 Heartbeat를 제공한다.

예: Every 30 minutes — Check: Calendar, Email, Important Tasks, Automation

Agent가 계속 살아 있는 것처럼 동작한다.

---

## 31. Automation

통합 Automation Engine을 사용한다.

Automations: Daily, Scheduled, Event-driven, Conditional, Recurring, Webhook

Standard와 Personal Agent 모두 동일 엔진을 사용한다.

---

## 32. Task System

모든 Agent 실행을 Task로 표현한다.

Task 필드: id, owner, agent, session, runtime, node, status, priority, parent, children, created, started, completed, cost

---

## 33. Cross Runtime Task

한 Task 내부에서 Runtime이 변경될 수 있다.

예: "최신 AI 동향을 조사해서 Word 파일로 저장하고 내 PC의 Documents 폴더에 넣어줘."

```
Research (AGEX Server)
 ↓
Document Generation (AGEX Server)
 ↓
File Transfer
 ↓
AGEX Node
 ↓
Documents
```

사용자에게는 하나의 Task로 보인다.

---

## 34. Unified Activity Timeline

Chat 안에서 다음처럼 표시한다.

```
● Searching the web
● Reading 14 sources
● Creating document
● Connecting to Office PC
● Saving file
✓ Completed
```

Runtime 전환을 기술적으로 노출하지 않는다.

---

## 35. Personal Computer Control

단계적으로 개발한다.

- **Level 1**: Files, Browser, Clipboard, Notifications
- **Level 2**: Shell, Applications, Desktop
- **Level 3**: Screen understanding, Mouse, Keyboard, GUI automation

---

## 36. Browser Runtime

Browser Tool은 공통 인터페이스를 사용한다.

`browser.open()`, `browser.navigate()`, `browser.snapshot()`, `browser.click()`, `browser.type()`, `browser.download()`, `browser.upload()`, `browser.screenshot()`

Execution target: Cloud Browser / Personal Browser / Remote Browser 를 Resolver가 선택한다.

---

## 37. Browser Session Continuity

Personal Browser에서는 사용자의 로그인 상태를 유지할 수 있어야 한다.

예: Google, GitHub, Notion, Internal systems

그러나 credential 자체를 LLM Context에 넣지 않는다.

---

## 38. Secret Architecture

```
AGEX Secret Vault
 │
 ├─ API
 ├─ OAuth
 ├─ Password
 └─ Token
```

Agent에게 실제 Secret 값을 제공하지 않는다.

```
Agent
↓
Tool
↓
Secret Resolver
↓
Execution
```

---

## 39. Permission Architecture

Capability마다 Permission을 가진다.

예 — Browser: View `Allow`, Navigate `Allow`, Download `Ask`, Upload `Ask`, Purchase `Deny`

---

## 40. File Permission

- **Read Allow**: Documents, Projects
- **Ask**: Downloads
- **Deny**: System, Credentials

---

## 41. Shell Permission

`safe` / `restricted` / `approval` / `blocked`

위험 명령은 무조건 승인 요청.

---

## 42. Approval UI

Chat에서 자연스럽게 표시한다.

```
AGEX wants to run:
npm install
on:
Office PC

[Allow once]  [Always allow]  [Deny]
```

Standard와 Personal Tool 모두 같은 Approval UI를 사용한다.

---

## 43. Agent Identity

모든 Agent가 동일한 Identity 구조를 사용한다.

Name, Avatar, Role, Description, Personality, Instructions, Model, Memory, Capabilities

Personal Agent만 별도의 디자인을 만들지 않는다.

---

## 44. Agent Home

Agents 페이지 예:

**My Agents**
- My Assistant — Personal productivity
- Developer — Coding
- Researcher — Research
- Marketing — Content
- Data Analyst — Analytics

사용자는 동일한 Agent 목록에서 이동한다.

---

## 45. Agent 전환

좌측 Sidebar: Agents — My Assistant / Developer / Researcher / Marketing

선택 즉시 동일 Chat Layout에서 Agent만 변경된다.

---

## 46. Agent Collaboration

Personal Agent도 다른 AGEX Agent에게 일을 맡길 수 있다.

예:

```
My Assistant
 ↓
Research Agent
 ↓
Data Agent
 ↓
Document Agent
 ↓
My Assistant
```

---

## 47. 대표 시나리오

사용자: "다음 주 서울 출장 준비해줘."

```
My Assistant:
Calendar 확인
 ↓
Research Agent
 ↓
교통/숙박 조사
 ↓
Personal Browser
 ↓
Calendar
 ↓
Task 생성
```

사용자는 하나의 Agent와 대화한다.

---

## 48. Coding 시나리오

사용자: "사무실 PC의 AGEX 프로젝트를 확인해서 테스트하고 오류를 고쳐줘."

```
My Assistant
 ↓
Coding Agent
 ↓
AGEX Node
 ↓
Git
 ↓
Code
 ↓
Test
 ↓
Report
```

---

## 49. Workflow 통합

Workflow에서도 Runtime을 구분하지 않는다.

```
Trigger
↓
Research Agent
↓
Approval
↓
My Assistant
↓
Personal Email
↓
Notification
```

---

## 50. Plugin 통합

Plugin SDK도 하나만 둔다. Plugin이 capability를 등록한다.

예:

```typescript
registerCapability({
  id: "notion.search",
  execution: "remote"
})

registerCapability({
  id: "windows.application.open",
  execution: "node"
})
```

---

## 51. Marketplace

Marketplace에서 다음 항목을 통합 제공한다: Agents, Skills, Plugins, Workflows, Connectors

Personal Agent용 Marketplace를 별도로 만들지 않는다.

---

## 52. Unified Gateway

Gateway가 다음을 담당한다: Authentication, Agent Routing, Session, Task, Runtime Routing, Tool Routing, Node Routing, Model Routing, Events, Automation, Channels, Security, Usage

---

## 53. Gateway Routing Flow

```
Message
↓
Gateway
↓
Agent Resolver
↓
Context
↓
LLM
↓
Tool
↓
Capability Resolver
↓
Execution Target
 ├─ Server
 ├─ Cloud
 ├─ Connector
 └─ Personal Node
↓
Result
↓
Agent
↓
User
```

---

## 54. Runtime Manager

신규 핵심 Component: **Runtime Manager**

책임: Runtime selection, Runtime availability, Node discovery, Execution routing, Fallback, Timeout, Retry, State synchronization

---

## 55. Execution Target

모든 Tool은 다음 중 하나로 실행된다.

```typescript
type ExecutionTarget =
  | "gateway"
  | "cloud"
  | "connector"
  | "node"
  | "sandbox"
```

---

## 56. Runtime Location Transparency

Agent 및 사용자에게 실행 위치를 숨기는 것이 기본이다. 단, 보안과 승인 상황에서는 명확히 표시한다.

예: "Office PC에서 명령을 실행하려고 합니다."

사용 편의성을 위한 추상화와 보안 투명성을 혼동하지 않는다.

---

## 57. Control Plane / Execution Plane

반드시 분리한다.

- **Control Plane**: Gateway, Agent definition, Task, Session, Policy, Automation, Registry
- **Execution Plane**: Cloud, Server, Sandbox, Personal Node, Browser, Device

---

## 58. Node Offline 처리

Personal Node가 Offline일 수 있다.

Task: `waiting_for_node` 상태 제공. Node가 연결되면 재개한다.

---

## 59. Fallback

예: Personal Browser offline. Agent는 정책에 따라 Cloud Browser 사용 또는 사용자에게 Personal Node 연결 요청 을 선택한다.

---

## 60. Multi Device

한 사용자가 여러 Node를 등록할 수 있다.

Devices: Office PC, Home PC, Laptop, Server, Phone

---

## 61. Device Selection

사용자: "회사 컴퓨터에서 실행해." — 명시적 Target 지정. 또는 Default Device 설정.

---

## 62. Mobile

모바일도 단순 Chat App에 그치지 않는다. AGEX Mobile Node로 활용한다.

Capability: Camera, Microphone, Location, Notifications, Files, Voice

---

## 63. Unified Channel

AGEX Agent는 같은 Identity로 Web, Desktop, Mobile, Telegram, Slack, Teams, Discord 어디서든 호출 가능해야 한다.

---

## 64. Session Continuity

Web에서 대화하던 Agent를 모바일에서 계속 사용할 수 있다.

One Agent · One User · Many Channels · Shared Session / Context

---

## 65. Personal Workspace

Personal Agent에는 별도의 local workspace를 제공할 수 있다.

```
.agex/
  agents/
  memory/
  skills/
  workspace/
  tasks/
  logs/
  cache/
```

하지만 사용자에게 filesystem 구조를 강요하지 않는다.

---

## 66. 데이터 구조

핵심 Domain: User, Organization, Agent, AgentProfile, Capability, Tool, Skill, Plugin, Workflow, Memory, Knowledge, Session, Message, Task, Automation, Node, Device, Channel, Secret, Policy, Approval, Usage, Audit

---

## 67. 기존 AGEX 기능과의 관계

기존 핵심 요소를 유지한다: Agent, Workflow, Knowledge, Memory, Plugin, Marketplace, Runtime

Personal Agent는 새로운 별도 제품이 아니다. 기존 Runtime 개념을 확장하는 기능이다. 즉:

```
AGEX Runtime
 │
 ├─ Server Runtime
 ├─ Sandbox Runtime
 ├─ Browser Runtime
 └─ Personal Node Runtime
```

로 정의한다.

---

## 68. 중요 Architecture 결정

OpenClaw 계열 제품을 그대로 AGEX 내부에 넣지 않는다.

다음은 금지한다.

```
OpenClaw fork
 ↓
AGEX iframe
```

또는:

```
OpenClaw Backend
 +
AGEX Frontend
```

이 방식 역시 장기적으로 구조적 종속성이 발생한다.

---

## 69. 독자 구현 원칙

벤치마킹 대상에서 배울 것은: Personal Gateway 개념, Persistent Agent, Browser Control, Local Tools, Node, Memory, Heartbeat, Automation, Messaging, Permission, Skill 이다.

구현은 AGEX Domain Model을 기준으로 새로 한다.

---

## 70. 최종 UI 원칙

사용자가 느껴야 하는 것은: "AGEX의 어떤 Agent를 선택하느냐에 따라 할 수 있는 일이 달라진다." 이지, "지금 다른 솔루션으로 이동했다." 가 아니다.

---

## 71. UI 일관성

반드시 공유: Sidebar, Header, Chat, Agent Selector, Task panel, Activity, Approval, Files, Artifacts, Settings, Theme, Typography, Interaction

---

## 72. 기능적 Progressive Disclosure

Personal capability가 없는 Agent에서는 관련 기능을 숨긴다.

예:
- **Research Agent**: Knowledge, Web, Files
- **My Assistant**: Browser, Computer, Email, Calendar, Automation, Devices

Layout은 같다.

---

## 73. 핵심 차별 UX

하나의 Conversation에서 여러 Capability가 자연스럽게 연결되어야 한다.

예: 사용자 — "이번 달 프로젝트 상황을 분석해서 대표님께 전달할 보고서를 만들고, 내일 오전 9시 전에 이메일 초안까지 준비해줘."

```
Knowledge
↓
Project Data
↓
Analysis Agent
↓
Document Agent
↓
Personal Calendar
↓
Personal Email
↓
Automation
```

사용자는 이를 하나의 요청으로 인식한다.

---

## 74. 개발 단계 — Phase 1: Unified Foundation

Unified Agent Model, Gateway, Session, Task, Capability Registry, Runtime Manager, Tool Registry, Policy Engine

---

## 75. Phase 2 — Existing AGEX Integration

Standard Agent, Knowledge, Memory, Workflow, Plugin, Marketplace, Model Router 를 새 Unified Agent Core로 이관한다.

---

## 76. Phase 3 — Personal Node MVP

구현: Node client, Pairing, Heartbeat, Files, Browser, Shell, Clipboard, Notifications

---

## 77. Phase 4 — Personal Agent

Personal Memory, Email, Calendar, Automation, Background Task, Device Management, Personal Workspace

---

## 78. Phase 5 — Unified Experience

Unified Agent UI, Unified Activity, Unified Tasks, Unified Approval, Unified Settings, Unified Search, Unified Marketplace

---

## 79. Phase 6 — Autonomous Platform

Sub Agents, Agent Delegation, Agent-to-Agent, Code Mode, Tool Search, Swarm, Long Running Tasks, Event Automation

---

## 80. Phase 7 — Advanced Personal AI

Desktop Vision, GUI Automation, Voice, Mobile Node, Context Awareness, Personal Knowledge Graph, Memory Consolidation

---

## 81. MVP Acceptance Scenario 1

사용자: "내 컴퓨터 Downloads에서 오늘 받은 PDF 찾아줘."

완료: `Chat → Agent → Capability Resolver → AGEX Node → File Search → Result`

---

## 82. MVP Acceptance Scenario 2

사용자: "GitHub의 프로젝트 내려받아서 테스트해줘."

`Agent → Node → Git → Shell → Tests → Report`

---

## 83. MVP Acceptance Scenario 3

사용자: "다음 주 일정을 확인하고 중요한 것만 알려줘."

`Agent → Calendar Connector → Analysis → Response`

---

## 84. MVP Acceptance Scenario 4

사용자: "매일 오전 8시에 오늘 일정과 중요한 이메일을 알려줘."

`Agent → Automation → Email/Calendar → Summary → Notification`

---

## 85. MVP Acceptance Scenario 5

사용자: "조사 자료를 분석해서 보고서를 만들고 내 PC에 저장해."

`Standard Runtime: Analysis → Document → Runtime Manager → Personal Node → File Write`

이 시나리오는 특히 중요하다. Standard + Personal Runtime 통합 여부를 검증하기 때문이다.

---

## 86. 개발 Agent에 대한 핵심 명령

AGEX를 두 개의 AI 제품으로 개발하지 않는다.

다음과 같이 생각한다: `One Agent Platform + Multiple Execution Environments` 이지, `Agent Platform + Personal AI Platform` 이 아니다.

---

## 87. 모든 신규 기능 설계 질문

개발자는 신규 기능을 만들기 전에 반드시 다음을 확인한다.

1. 이 기능은 Capability인가?
2. 이 기능은 Tool인가?
3. 어디서 실행되는가?
4. 어떤 Policy가 적용되는가?
5. 어떤 Agent가 사용할 수 있는가?
6. Task로 추적되는가?
7. Audit가 남는가?

---

## 88. 최상위 Architecture 규칙

모든 작업은 다음 경로를 지켜야 한다.

```
User
↓
Agent
↓
Capability
↓
Policy
↓
Runtime
↓
Execution
↓
Audit
```

직접적인 우회 실행은 허용하지 않는다.

---

## 89. 제품 완료 상태

AGEX가 다음과 같이 동작하면 최종적인 방향이 달성된 것으로 판단한다.

사용자가 AGEX를 열고 My Assistant / Developer / Researcher / Writer / Analyst 중 Agent를 선택한다. 모든 Agent의 화면은 동일하다.

그러나:
- **Researcher** → 인터넷과 Knowledge를 조사
- **Developer** → Repository와 개발환경을 조작
- **My Assistant** → 이메일·일정·PC·브라우저 관리

를 수행한다. 사용자는 기술적으로 다른 Runtime이 실행되고 있다는 사실을 의식하지 않는다.

---

## 90. 최종 제품 Definition

AGEX는 다음과 같이 정의한다.

> **AGEX는 다양한 AI Agent, 개인 AI Agent, Workflow, Knowledge, Memory, Tools, Plugins, Applications 및 실행 환경을 하나의 사용자 경험과 하나의 Agent Runtime Architecture 아래 통합하는 AI Operating System이다.**

Personal Agent는 AGEX와 경쟁하거나 병렬로 존재하는 두 번째 제품이 아니다. **AGEX의 Agent가 개인의 디바이스와 환경까지 활동 영역을 확장한 Runtime Profile이다.**

---

## 91. 핵심 개발 지시

현재 존재하는 Agent 기능을 폐기하고 Personal Agent 방식으로 교체하지 않는다. 또한 Personal Agent를 별도 시스템으로 붙이지 않는다.

두 영역을 다음 공통 추상화 아래 통합한다: **Agent, Capability, Runtime, Tool, Memory, Task, Policy, Node**

이 여덟 개를 AGEX Unified Architecture의 핵심 Domain으로 확정한다.

---

## 92. 최종 개발 우선순위

코딩은 반드시 다음 순서로 진행한다.

1. Unified Domain Model
2. Capability Registry
3. Runtime Manager
4. Unified Tool System
5. Policy Engine
6. Task Engine
7. Gateway
8. Standard Runtime Adapter
9. AGEX Node
10. Node Pairing
11. Local File Runtime
12. Personal Browser Runtime
13. Shell Runtime
14. Unified Memory
15. Personal Context
16. Automation
17. Email / Calendar
18. Unified Agent UI
19. Device UI
20. Approval UI
21. Multi-Agent Delegation
22. Workflow Integration
23. Plugin / MCP Integration
24. Security Hardening
25. Observability
26. Desktop / Mobile Node

UI부터 개발하지 않는다.

---

## 93. 최종 원칙

AGEX 사용자는 다음을 경험해야 한다.

하나의 AGEX · 하나의 계정 · 하나의 UI · 하나의 Agent 개념 · 하나의 Memory 체계 · 하나의 Tool 체계 · 하나의 Task 체계 · 하나의 Marketplace · **여러** Runtime · **여러** Devices · **여러** Models · **여러** Agents

이 원칙을 훼손하는 Architecture 변경은 허용하지 않는다.

---

## 94. 최상위 선언

본 프로젝트에서 Personal Autonomous Agent 기능은 별도의 OpenClaw 복제 제품을 만드는 방식으로 개발하지 않는다.

OpenClaw와 동급의 Personal Agent capability를 독자적으로 구현하되 이를 AGEX의 기존 Agent Architecture에 통합한다.

최종적으로 AGEX 내부에서는 Standard Agent, Personal Agent, Enterprise Agent, Coding Agent, Research Agent, Autonomous Agent 라는 기술적으로 다른 제품이 존재하지 않는다.

모두 **AGEX Agent** 이다. 각 Agent마다 부여된 Capability, Policy, Runtime, Memory 및 Execution Environment가 다를 뿐이다.

이 구조를 AGEX Unified Agent Architecture의 최상위 개발 원칙으로 확정한다.

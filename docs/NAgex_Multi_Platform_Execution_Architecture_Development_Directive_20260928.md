# NAgex Multi-Platform Execution Architecture Development Directive

**Date:** 2026-09-28  
**Project:** NAgex  
**Document Type:** Canonical Development Directive  
**Primary Principle:** **One Brain, Many Execution Planes**

---

## 1. Purpose

This document defines the canonical development direction for separating NAgex's shared intelligence, trust, and approval layers from platform-specific execution.

NAgex must support materially different execution environments without allowing Android, Web, Browser, Desktop, iOS, Server, or external-API implementation details to leak into the canonical user-action model.

The target is:

> **The same user intent and approval semantics should work globally, while the actual execution mechanism remains platform-specific.**

---

## 2. Core Architecture Rule

NAgex must separate three questions:

```text
1. WHAT does the user want?
2. WHERE can it execute?
3. HOW should it execute?
```

Canonical flow:

```text
User / Event
    ↓
Intent Interpretation
    ↓
Canonical Action
    ↓
Memory / Context / Policy
    ↓
Action Proposal
    ↓
Human Approval
    ↓
Execution Planner
    ↓
Execution Target
    ↓
Platform Executor
    ↓
Result Verification
    ↓
Audit / Memory
```

---

## 3. Reasoning Plane vs Execution Plane

NAgex must formally distinguish:

```text
Reasoning Plane
≠
Execution Plane
```

### Reasoning Plane

May run on:
- NAgex server
- Nebius / NVIDIA model runtime
- other model providers
- local model runtime where appropriate

Responsibilities:
- intent interpretation
- planning
- context reasoning
- message drafting
- summarization
- tool/action selection
- policy-aware preparation

### Execution Plane

May run on:

```text
SERVER
WEB
BROWSER
ANDROID
IOS
DESKTOP
EXTERNAL_API
```

A model may reason in the cloud while the final action executes on a user's Android device.

---

## 4. Canonical Action Layer

Canonical actions must remain platform-neutral.

Examples:

```text
SEND_MESSAGE
SEND_EMAIL
CREATE_EVENT
BOOK_RESERVATION
START_NAVIGATION
OPEN_DOCUMENT
UPLOAD_FILE
CREATE_IMAGE
MAKE_PAYMENT
CREATE_TASK
```

Forbidden inside canonical action types:

```text
Android Intent
Activity
AccessibilityNode
ADB
DOM selector
CSS selector
browser tab ID
iOS AppIntent implementation details
system package name
UI click coordinates
```

These belong only inside platform-specific executors.

---

## 5. Canonical SendMessageAction

Recommended conceptual shape:

```ts
interface SendMessageAction {
  recipientRef: string;
  message: string;
  preferredChannel?: MessagingChannel;
  locale?: string;
  contextRef?: string;
}
```

This action does not know whether the message will execute through:
- Android SMS
- KakaoTalk Share
- WhatsApp
- RCS
- Email
- Slack
- Teams
- Browser
- External API

---

## 6. Execution Target

Introduce a canonical `ExecutionTarget`.

```ts
interface ExecutionTarget {
  environment:
    | 'SERVER'
    | 'WEB'
    | 'BROWSER'
    | 'ANDROID'
    | 'IOS'
    | 'DESKTOP'
    | 'EXTERNAL_API';

  deviceId?: string;
  provider?: string;
  channel?: string;
  executionRoute: string;
}
```

Examples:

```text
environment = ANDROID
channel = SMS
executionRoute = ANDROID_SMS_MANAGER
```

```text
environment = SERVER
channel = EMAIL
executionRoute = GMAIL_API
```

```text
environment = BROWSER
channel = WHATSAPP
executionRoute = BROWSER_UI_AUTOMATION
```

---

## 7. Execution Planner

The current `ExecutionRouteResolver` concept must evolve into a broader execution-planning pipeline:

```text
Canonical Action
    ↓
Environment Resolver
    ↓
Capability Resolver
    ↓
Route Resolver
    ↓
Execution Plan
    ↓
Platform Executor
```

### Environment Resolver

Answers:

```text
Where should this action execute?
```

### Capability Resolver

Answers:

```text
What capabilities are actually available now?
```

Inputs may include:
- device online/offline
- app installed/not installed
- connected provider
- authenticated session
- API availability
- platform permissions
- OS version
- user preferences
- recipient capability

### Route Resolver

Answers:

```text
Which concrete route should execute the action?
```

Examples:
- `ANDROID_SMS_MANAGER`
- `KAKAOTALK_SHARE`
- `GMAIL_API`
- `GOOGLE_CALENDAR_API`
- `BROWSER_UI_AUTOMATION`
- `MANUAL_HANDOFF`

---

## 8. Execution Plan

The planner should produce an immutable execution plan before approval.

```ts
interface ExecutionPlan {
  actionType: string;
  target: ExecutionTarget;
  payloadHash: string;
  requiresApproval: boolean;
  capabilitySnapshot: string[];
}
```

Mandatory principle:

> **Approval must bind to the exact execution plan that will actually run.**

---

## 9. Approval Binding

Approval must bind the material execution properties:

```text
action
payload
recipient
channel
environment
device
executionRoute
critical conditions
```

If the system changes from:

```text
ANDROID_SMS_MANAGER
```

to:

```text
WHATSAPP_WEB
```

then:

```text
REAPPROVAL_REQUIRED
```

The same applies to:

```text
ANDROID
→ BROWSER
```

Approval is never transferable across a materially different execution plan.

---

## 10. Shared Layers vs Platform-Specific Layers

### Shared

```text
canonical actions
identity
memory
personal context
policy
approval semantics
execution planning
audit contract
result contract
security invariants
```

### Platform-specific

```text
Android intents
Android activities
Android permissions
Android contact access
Android sensors
Android notifications
KakaoTalk app handoff
iOS App Intents
Siri integration
browser selectors
DOM interaction
desktop automation
native OS APIs
```

---

## 11. Platform Executor Model

Recommended conceptual layout:

```text
executors/
  server/
  web/
  browser/
  android/
  ios/
  desktop/
  external-api/
```

Each executor receives an already-approved execution plan and must:
- validate target environment
- validate capability assumptions
- execute only within the approved route
- report truthful result
- never silently change route
- never silently escalate authority

---

## 12. Android Execution Plane

Android is strongest for:
- SMS
- contacts
- phone
- camera
- location
- Bluetooth
- notifications
- device sensors
- installed apps
- native intents
- app links
- local credential/device state

Examples:

```text
SendMessageAction
→ ExecutionPlan
→ ANDROID
→ ANDROID_SMS_MANAGER
→ SmsMessagingAdapter
→ SmsManager
```

```text
SendMessageAction
→ ExecutionPlan
→ ANDROID
→ KAKAOTALK_SHARE
→ KakaoTalkHandoffAdapter
→ ACTION_SEND
→ NEEDS_HUMAN
```

---

## 13. Web / Server Execution Plane

Web and server execution are strongest for:
- Gmail API
- Google Calendar
- Slack API
- GitHub
- cloud files
- research
- webhooks
- scheduled jobs
- SaaS workflows
- connected apps

Example:

```text
SendMessageAction
→ ExecutionPlan
→ SERVER
→ GMAIL_API
→ GmailExecutor
```

Server executors must not contain Android logic.

---

## 14. Browser Execution Plane

Browser execution is separate from server execution.

Typical cases:
- API unavailable
- legacy admin UI
- web reservation
- e-commerce
- form submission
- authenticated browser session

Example:

```text
BookReservationAction
→ ExecutionPlan
→ BROWSER
→ BROWSER_UI_AUTOMATION
→ governed browser executor
```

Browser selectors must not appear in canonical actions.

---

## 15. iOS Execution Plane

Do not assume Android mechanisms transfer to iOS.

Potential iOS routes:
- App Intents
- Siri / Shortcuts
- URL schemes
- App Links
- system-supported integrations
- manual handoff

The same canonical action and approval model applies, while execution remains iOS-specific.

---

## 16. Desktop Execution Plane

Desktop may support:
- global keyboard shortcuts
- desktop notifications
- native file access
- local application control
- browser control
- desktop-native voice
- local model access

Desktop execution must remain separate from Web and Android.

---

## 17. Event Architecture

Events must also be separated by source while sharing a canonical envelope.

```ts
interface NAgexEvent {
  type: string;
  source: EventSource;
  occurredAt: string;
  payloadRef: string;
}
```

Recommended sources:

```text
SERVER
WEBHOOK
CONNECTED_APP
SCHEDULE
BROWSER
ANDROID_DEVICE
IOS_DEVICE
DESKTOP
USER
```

---

## 18. Web Events vs Mobile Events

### Web / Server events
- email received
- calendar event
- GitHub PR
- webhook received
- web page changed
- price changed
- scheduled task
- API callback

### Mobile events
- voice invocation
- mobile notification
- location change
- incoming SMS
- Bluetooth state
- battery state
- installed-app state
- device sensor event
- Quick Settings invocation

Both enter the same policy and action-planning pipeline.

---

## 19. Trigger vs Delivery vs Execution

Do not conflate these concepts.

Example:

> "내일 회의 10분 전에 준비할 자료 보여줘."

Canonical interpretation:

```text
Trigger:
calendar event - 10 min

Action:
prepare meeting brief
```

Possible delivery:
- Web notification
- Android push
- Desktop notification

Possible execution:
- SERVER generates brief
- ANDROID displays notification
- WEB opens result

One workflow may involve multiple execution planes.

---

## 20. Runtime Availability

The planner must reason over current runtime capability.

Example:

```text
Web session = active
Android device = online
KakaoTalk = installed
SMS = available
Gmail = connected
WhatsApp Web = authenticated
```

The planner must never assume availability from configuration alone.

---

## 21. Explicit User Route Preference

If the user explicitly requests:

> "카카오톡으로 보내줘"

NAgex must respect that intent if available.

If unavailable:

```text
KAKAOTALK
→ UNAVAILABLE
```

Do not silently change to SMS.

NAgex may propose an alternative, but that alternative requires a new approval.

---

## 22. Silent Fallback Is Forbidden

Forbidden:

```text
user requests KakaoTalk
→ KakaoTalk unavailable
→ silently send SMS
```

Required:

```text
requested route unavailable
→ truthful result / alternative proposal
→ user approval
→ new execution plan
```

---

## 23. Human Handoff as a First-Class Route

Some routes cannot support autonomous verified execution.

Model execution modes explicitly:

```text
AUTONOMOUS_VERIFIED
HUMAN_HANDOFF
MANUAL
```

Example:

```text
SMS / Android SmsManager
→ AUTONOMOUS_VERIFIED

KakaoTalk Share
→ HUMAN_HANDOFF
```

Human handoff is not a failure. It is a truthful result.

---

## 24. Result Semantics

Recommended global result categories:

```text
PREPARED
APPROVAL_REQUIRED
APPROVED
EXECUTION_STARTED
HANDOFF_STARTED
NEEDS_HUMAN
SENT_CONFIRMED
COMPLETED_CONFIRMED
FAILED
UNAVAILABLE
UNKNOWN
```

Never collapse `HANDOFF_STARTED` into `SENT_CONFIRMED`.

---

## 25. Global Security Invariants

Mandatory across all execution planes:

```text
VOICE_CAN_BYPASS_APPROVAL = 0
WAKE_WORD_CAN_BYPASS_APPROVAL = 0
LLM_CAN_DIRECTLY_CONTROL_DEVICE = 0
UNAPPROVED_SEND = 0
AMBIGUOUS_CONTACT_AUTO_EXECUTE = 0
MESSAGE_PAYLOAD_DRIFT_ALLOWED = 0
EXECUTION_ROUTE_DRIFT_ALLOWED = 0
EXECUTION_ENVIRONMENT_DRIFT_ALLOWED = 0
SILENT_FALLBACK_ALLOWED = 0
FAKE_SUCCESS_PATHS = 0
```

---

## 26. Architecture Anti-Patterns

Do not build:

```text
MobileMessageRunService
  if SMS -> Android
  if KakaoTalk -> Android
  if WhatsApp -> Web
  if Gmail -> Server
```

Do not build one giant executor for all platforms.

Do not place browser selectors, Android intents, or iOS-specific APIs inside canonical action types.

Do not let the LLM choose and execute a platform route without policy and approval.

---

## 27. Recommended Code Organization

Directional target:

```text
src/
  actions/
    send-message.action.ts
    create-event.action.ts
    book-reservation.action.ts

  execution/
    execution-target.ts
    execution-plan.ts
    environment-resolver.ts
    capability-resolver.ts
    route-resolver.ts
    execution-planner.ts

  executors/
    server/
    web/
    browser/
    android/
    ios/
    desktop/
    external-api/

  messaging/
    send-message-action.types.ts
    messaging-adapter-registry.ts
    messaging-execution-adapter.ts

  events/
    event.types.ts
    server-events/
    browser-events/
    mobile-events/

  approval/
    approval-binding.ts
```

Android:

```text
mobile-android/
  execution/
    sms/
    kakaotalk/
    intents/
    contacts/
```

This is directional architecture, not a big-bang refactor instruction.

---

## 28. Migration Strategy

Do not perform a big-bang rewrite.

Required migration style:

```text
wrap
→ certify
→ migrate one capability
→ certify again
```

Recommended sequence:

```text
1. Keep certified SMS path working
2. Introduce ExecutionTarget
3. Introduce ExecutionPlan
4. Add Environment Resolver
5. Add Capability Resolver
6. Adapt Messaging Route Resolver
7. Wrap existing SMS path
8. Add KakaoTalk handoff
9. Add future Web/Browser executors incrementally
```

---

## 29. Immediate Impact on D2B

D2B must align with this architecture.

KakaoTalk should be represented conceptually as:

```text
environment = ANDROID
channel = KAKAOTALK
executionRoute = KAKAOTALK_SHARE
executionMode = HUMAN_HANDOFF
```

This allows future alternatives without changing the canonical action.

---

## 30. D2B Constraints

Canonical capability remains:

```text
COMMUNICATION / SEND_MESSAGE
```

KakaoTalk remains an adapter.

Android-specific implementation:

```text
Intent.ACTION_SEND
package = com.kakao.talk
```

must stay inside the Android executor / adapter boundary.

It must not leak into:
- SendMessageAction
- ExecutionPlan core schema
- approval policy core
- memory
- LLM prompt model

---

## 31. Approval Example

```text
Action: Send Message
Recipient: John
Channel: SMS
Environment: Android
Device: My Galaxy
Route: Android SMS
Message: "I'll be 10 minutes late."
```

If any of these change:

```text
recipient
channel
environment
device
route
message
```

then:

```text
REAPPROVAL_REQUIRED
```

---

## 32. Product UX Principle

Users should not need to understand execution planes.

The user says:

> "John한테 늦는다고 알려줘."

NAgex internally resolves:

```text
recipient
→ preferred channel
→ available environment
→ available device
→ safe route
→ approval
→ execution
```

The user should see only what matters for trust:
- who
- what
- where
- how
- risk
- approval
- result

Do not expose internal terms such as:
- Environment Resolver
- Capability Resolver
- Execution Planner
- Runtime
- Adapter Registry

---

## 33. Global Product Principle

NAgex is not:
- a web agent
- an Android agent
- a browser agent
- a mobile automation app

NAgex is:

> **One Personal AI with multiple governed execution planes.**

---

## 34. Canonical Architecture Statement

> **NAgex shares intent, identity, memory, policy, approval, and audit across platforms. It does not share platform-specific execution implementations.**

Short form:

> **One Brain, Many Execution Planes.**

---

## 35. Development Gate

Before adding any new execution capability, answer:

```text
1. What canonical action is this?
2. Which environment should execute it?
3. Which capability is required?
4. Which exact route will run?
5. What is bound into approval?
6. What evidence proves success?
7. What is the truthful fallback if execution is unavailable?
```

If any answer is unclear, implementation must not begin.

---

## 36. Acceptance Criteria

Future implementation must preserve:

```text
canonical action neutrality
platform executor isolation
approval binding to environment + route
truthful result semantics
no silent fallback
no fake success
incremental migration
existing certified behavior
```

No platform executor may weaken existing trust invariants.

---

## 37. Final Directive

All future NAgex execution development must follow this separation:

```text
WHAT
→ Canonical Action

WHERE
→ Execution Environment / Target

HOW
→ Execution Route / Platform Executor
```

The architectural goal is not to make all platforms behave identically.

The goal is:

> **Make user intent and trust semantics consistent, while allowing execution to remain platform-native.**

# NAgex Activity & Execution Transparency Amendment v1

**Document type:** Product / UX / Execution Transparency / Development Amendment  
**Scope:** NAgex Alpha 1.0 and DC3-B2+  
**Status:** Canonical UX / Execution Transparency Rule  
**Applies to:** Desktop, Mobile, Device Control, Background Execution, Activity, Approval, Audit, Verification

---

# 1. Purpose

This amendment defines how NAgex must expose background execution and execution history to users.

The goal is not to show every internal event.

The goal is to ensure that users can always understand:

```text
What NAgex did
Why it did it
Where it did it
What changed
Whether it succeeded
Whether the result was verified
Whether user approval was involved
Whether anything failed
Whether the user can stop or take control
```

NAgex must provide execution transparency without turning the product into a developer console.

---

# 2. Permanent Product Invariant

## DC3-B2 Amendment — Observable Background Execution

Background execution must never mean invisible execution.

Permanent invariant:

```text
NAgex may work without taking over the user's input,
but it must never work outside the user's visibility and control.
```

And:

```text
Background does not mean hidden.
Autonomous does not mean unaccountable.
Execution does not mean loss of user control.
```

---

# 3. Human Meaning Principle

Activity is not a raw event log.

Activity is a human-readable explanation of:

```text
what NAgex did
why it mattered
what changed
what result was verified
```

Permanent rule:

```text
Store events at machine detail.
Present them at human meaning.
```

And:

```text
Do not show the user every event.
Show the user the meaning of the events.
```

---

# 4. Canonical Transformation Pipeline

Every execution may create many low-level events.

Those events must be transformed before normal user presentation.

Canonical pipeline:

```text
RAW EXECUTION EVENT
        ↓
EVENT GROUPING
        ↓
MEANINGFUL USER ACTIVITY
        ↓
HUMAN-READABLE SUMMARY
        ↓
ROLLUP / COMPRESSION
```

Example:

```text
RAW

SESSION_STARTED
WINDOW_FOUND
UIA_TREE_READ
VALUE_PATTERN_SET
POST_ACTION_OBSERVE
VALUE_VERIFIED
SESSION_SUCCEEDED
```

must normally become:

```text
USER ACTIVITY

문서 제목을 변경했습니다.

"Draft"
→
"Client Proposal – September"

✓ 변경 내용을 확인했습니다.
```

---

# 5. Three-Level Information Depth

NAgex must provide progressive disclosure.

## LEVEL 1 — User Summary

Default surface.

Answers:

```text
What happened?
What is the result?
Do I need to do anything?
```

Example:

```text
고객에게 회의 변경 메일을 보냈습니다.

승인한 내용대로 메일을 발송했고,
발송이 완료된 것을 확인했습니다.

✓ 완료
```

---

## LEVEL 2 — Execution Detail

Shown only when the user opens details.

Answers:

```text
Where?
How?
When?
What was verified?
Was approval used?
```

Example:

```text
Application
Gmail

Action
Send email

Mode
Background

Approval
Approved by you

Verification
Message sent successfully

Duration
7 seconds
```

---

## LEVEL 3 — Technical Trace

Advanced / troubleshooting / audit surface.

May include:

```text
executionId
executionSessionId
event timestamps
provider
UIA pattern
evidence references
action payload hash
verification trace
audit event ids
```

This level must not be the default user experience.

---

# 6. User-Facing Activity Is Not Audit Log

NAgex must distinguish these concepts.

## Activity

Purpose:

```text
user understanding
trust
continuity
control
progress awareness
```

Language:

```text
human-readable
result-oriented
non-technical
concise
```

Example:

```text
회의 자료를 준비했습니다.
```

---

## Audit Log

Purpose:

```text
security
compliance
forensics
system traceability
developer diagnostics
```

Language may include:

```text
technical identifiers
event types
hashes
policy decisions
execution metadata
```

Activity and Audit may reference the same execution identity, but must not be the same presentation layer.

Canonical rule:

```text
Audit = machine/security evidence
Activity = human understanding
```

---

# 7. Activity Grouping

One user task may produce dozens or hundreds of internal events.

These must be grouped by meaningful execution unit.

Recommended grouping key:

```text
executionId
```

Optionally combined with:

```text
executionSessionId
taskId
workflowRunId
approvalId
deviceId
```

Example:

Instead of:

```text
12:01 Gmail opened
12:01 thread search
12:02 message read
12:02 draft created
12:03 approval requested
12:04 approval granted
12:04 send started
12:04 send verified
```

show:

```text
고객에게 회의 변경 메일을 보냈습니다.

• 최근 대화를 확인했습니다
• 답장을 준비했습니다
• 사용자의 승인을 받았습니다
• 메일 발송을 완료했습니다

✓ 확인 완료
```

---

# 8. Meaningful Activity Model

A user-facing activity record should conceptually contain:

```text
activityId
executionId

tenantId
ownerId
deviceId?

category
title
summary

status
mode

startedAt
completedAt?

application?
targetDescription?

beforeState?
afterState?

verificationStatus
approvalId?

rawEventRefs[]
auditRefs[]
```

Do not expose tenantId / ownerId / raw identifiers by default in the UI.

---

# 9. Canonical Status Vocabulary

User-facing status should remain small and understandable.

Recommended:

```text
IN_PROGRESS
WAITING_FOR_YOU
SUCCEEDED
FAILED
CANCELLED
BLOCKED
```

Avoid surfacing low-level internal states unless necessary.

Internal state may be richer.

---

# 10. Canonical Mode Vocabulary

Execution mode must be visible where relevant.

```text
BACKGROUND
ASSISTED
TAKEOVER
```

User copy examples:

```text
BACKGROUND
"NAgex가 백그라운드에서 작업 중입니다."

ASSISTED
"NAgex가 현재 앱에서 작업을 도와드리고 있습니다."

TAKEOVER
"NAgex가 이 기기를 제어하고 있습니다."
```

TAKEOVER remains future DC3-C behavior.

---

# 11. Real-Time Activity Surface

When NAgex is currently executing, the user should see a compact live state.

Desktop example:

```text
● NAgex가 백그라운드에서 작업 중입니다

회의 자료를 준비하는 중...
[활동 보기] [중지]
```

Multiple active jobs:

```text
NAgex가 2개의 작업을 처리하고 있습니다.

• 회의 자료 준비
• 업로드한 문서 정리

[활동 보기]
```

Do not show every internal step on the Home surface.

---

# 12. Activity View Structure

Activity should not be one endless chronological stream.

Recommended top-level grouping:

```text
NOW
RECENT
NEEDS YOU
```

Example:

```text
NOW
────────────────────
회의 자료 준비 중
백그라운드 작업
3 / 5 단계
[보기] [중지]

NEEDS YOU
────────────────────
메일 발송 승인이 필요합니다
[검토]

RECENT
────────────────────
✓ 문서 4개 정리
✓ 일정 생성
✓ 고객 메일 발송
```

---

# 13. Importance-Based Filtering

Not every event deserves a user-facing card.

## High-priority user-facing events

Always surface:

```text
approval required
user intervention required
failure
blocked execution
meaningful completion
meaningful change
cancellation
takeover start
takeover stop
```

## Medium-priority

Surface when relevant:

```text
task started
background execution started
verification completed
important intermediate milestone
```

## Low-level events

Do not show by default:

```text
window discovered
UIA tree fetched
snapshot refreshed
selector resolved
heartbeat sent
transport reauthenticated
internal retry
control pattern queried
```

These remain in technical trace / audit.

---

# 14. Time-Based Compression

Activity should become more compressed as it gets older.

Canonical presentation:

```text
REAL-TIME
→ current execution detail

TODAY
→ meaningful task-level activities

THIS WEEK
→ grouped summaries

OLDER
→ searchable history
```

Example:

```text
오늘

✓ 고객 메일 3건 처리
✓ 회의 2건 준비
✓ 문서 4개 정리
! 승인 대기 1건
```

Weekly:

```text
이번 주 NAgex가 18개의 작업을 처리했습니다.

이메일      7
일정        4
문서        5
기타        2

승인 필요   2
실패        1
```

---

# 15. Rollup Rules

Rollups must not hide important exceptions.

A rollup may summarize successful routine work.

But the following must remain individually visible until acknowledged or resolved:

```text
WAITING_FOR_YOU
FAILED
BLOCKED
SECURITY_RELEVANT
TAKEOVER
UNVERIFIED_CHANGE
```

Example:

```text
문서 11개를 정리했습니다.
```

is acceptable only if all 11 succeeded.

If one failed:

```text
문서 10개를 정리했습니다.
1개는 처리하지 못했습니다.

[확인]
```

---

# 16. Result-Oriented Language

Activity copy must describe user outcomes.

Bad:

```text
UIA ValuePattern executed successfully.
```

Good:

```text
문서 제목을 변경했습니다.
```

Bad:

```text
Background execution session completed.
```

Good:

```text
회의 자료 정리를 완료했습니다.
```

Bad:

```text
Action approval consumed.
```

Good:

```text
승인한 내용대로 메일을 발송했습니다.
```

Bad:

```text
Target control unavailable.
```

Good:

```text
이 앱에서는 백그라운드 방식으로 해당 항목을 조작할 수 없어 작업을 중단했습니다.

아무것도 변경하지 않았습니다.
```

---

# 17. Before / After

Where technically available and meaningful, NAgex should show before/after state.

Example:

```text
문서 제목을 변경했습니다.

Before
Draft

After
Client Proposal – September

✓ 변경 확인 완료
```

Another example:

```text
알림 설정을 변경했습니다.

Before
꺼짐

After
켜짐

✓ 확인 완료
```

Rules:

```text
never fabricate before state
never fabricate after state
never infer a change only because an action call returned success
```

Before/After must come from actual observed state.

---

# 18. Verification

A successful call is not automatically a successful user outcome.

Canonical rule:

```text
ACTION CALL SUCCESS
≠
VERIFIED RESULT
```

Execution should follow:

```text
observe
→ act
→ observe again
→ compare
→ verify
```

User-facing success should prefer:

```text
✓ 확인 완료
```

over merely:

```text
실행됨
```

---

# 19. Failure Transparency

Failure must be understandable.

Every failure summary should answer:

```text
What was attempted?
Why could it not continue?
Did anything change?
What can the user do next?
```

Example:

```text
문서 저장을 완료하지 못했습니다.

백그라운드 방식으로 저장 버튼을 확인할 수 없어
작업을 중단했습니다.

아무 내용도 변경하지 않았습니다.

[다른 방법으로 시도]
```

Do not show only:

```text
UIA_ELEMENT_NOT_FOUND
```

Technical codes may exist in Level 3.

---

# 20. Cancellation / Stop

Every running background execution must have a user stop path.

Canonical behavior:

```text
User presses Stop
→ current execution receives cancellation
→ no new action begins
→ safe cleanup
→ status becomes CANCELLED
→ Activity records the cancellation truthfully
```

Example:

```text
작업을 중지했습니다.

마지막으로 완료된 작업:
문서 2개 정리

진행 중이던 1개 작업은 실행하지 않았습니다.
```

Never claim full rollback unless rollback was actually performed and verified.

---

# 21. Home Integration

Desktop Home must show only a compact activity summary.

Examples:

```text
NAgex가 백그라운드에서 작업 중입니다.
회의 자료를 준비하는 중...

[활동 보기] [중지]
```

or:

```text
오늘 NAgex가 5개의 작업을 처리했습니다.
1개의 승인이 필요합니다.

[확인]
```

Home must not become a detailed log viewer.

---

# 22. Mobile Integration

Mobile Activity must be more compressed than Desktop.

Priority:

```text
Needs You
In Progress
Important Completed
```

Mobile should emphasize:

```text
approve
stop
review
continue
```

rather than detailed event inspection.

Detailed technical trace may be unavailable or deeply nested on Mobile.

---

# 23. Desktop Integration

Desktop may expose deeper execution detail.

Allowed:

```text
current step
application
mode
before/after
verification
approval
duration
evidence
technical trace
```

But default remains user-summary-first.

---

# 24. Data Retention Presentation

The system may retain detailed technical events for operational/audit needs.

The user-facing Activity surface should not attempt to render all retained raw events.

Use:

```text
task grouping
daily rollup
weekly rollup
search
filter
pagination / lazy loading
```

Do not render an unbounded infinite raw timeline.

---

# 25. Search and Filters

Long-term Activity should support human concepts.

Recommended filters:

```text
All
Needs you
Completed
Failed
Approvals
Desktop
Email
Calendar
Documents
Tasks
```

Do not make users filter by internal event type.

Bad:

```text
DEVICE_ACTION_VERIFICATION_COMPLETED
```

Good:

```text
Desktop
Completed
```

---

# 26. Summarization Rules

Human-readable summaries may be generated deterministically or with AI assistance, but must remain grounded.

Required inputs:

```text
canonical execution state
verified result
known application
known action
known target
approval state
failure state
```

The summarizer must never invent:

```text
motivation
business impact
success
verification
before/after
user approval
```

If confidence is insufficient:

```text
fall back to deterministic template
```

Never hallucinate a polished narrative over incomplete execution data.

---

# 27. Suggested Summary Templates

## Completion

```text
{result title}

{short description of what changed or was completed}

✓ {verification statement}
```

## Approval

```text
승인이 필요합니다.

NAgex가 {action}하려고 합니다.

{target / consequence}

[검토]
```

## Failure

```text
{task}을 완료하지 못했습니다.

{human-readable reason}

{truthful statement about whether anything changed}
```

## Cancellation

```text
작업을 중지했습니다.

{completed portion if known}

{remaining work if known}
```

---

# 28. Activity Event Architecture

Recommended separation:

```text
Execution Engine
      ↓
Raw Execution Events
      ↓
Activity Aggregator
      ↓
Meaningful Activity Record
      ↓
User-facing Activity API/UI

Raw Execution Events
      ↓
Audit / Security Log
```

Do not use the Activity layer as the source of truth for security enforcement.

Do not use Audit events directly as normal UX content.

---

# 29. DC3-B2 Integration Requirements

DC3-B2 background execution must emit at minimum:

```text
STARTED
ACTION
VERIFYING
SUCCEEDED | FAILED | CANCELLED | WAITING_FOR_APPROVAL
```

These may be implemented as raw events, but normal users should receive a grouped Activity record.

Each DC3-B2 execution must be associated with:

```text
executionId
tenantId
ownerId
deviceId
executionSessionId
mode
application
action type
status
verification
```

---

# 30. Observable Background Execution Required Tests

```text
BACKGROUND_ACTIVITY_STARTED_RECORDED=PASS
BACKGROUND_ACTIVITY_ACTION_RECORDED=PASS
BACKGROUND_ACTIVITY_VERIFYING_RECORDED=PASS
BACKGROUND_ACTIVITY_SUCCESS_RECORDED=PASS
BACKGROUND_ACTIVITY_FAILURE_RECORDED=PASS
BACKGROUND_ACTIVITY_CANCEL_RECORDED=PASS

BACKGROUND_ACTIVITY_CROSS_TENANT_BLOCK=PASS
BACKGROUND_ACTIVITY_CROSS_OWNER_BLOCK=PASS

BACKGROUND_ACTIVITY_NO_SECRET_DATA=PASS
BACKGROUND_ACTIVITY_HUMAN_READABLE=PASS

BACKGROUND_SUCCESS_REQUIRES_VERIFICATION=PASS
BACKGROUND_BEFORE_AFTER_TRUTHFUL=PASS

BACKGROUND_USER_STOP=PASS
BACKGROUND_STOP_PREVENTS_NEXT_ACTION=PASS
```

---

# 31. Activity Compression Required Tests

```text
RAW_EVENTS_GROUP_TO_SINGLE_ACTIVITY=PASS
LOW_LEVEL_EVENTS_HIDDEN_BY_DEFAULT=PASS
IMPORTANT_FAILURE_NOT_ROLLED_UP_AWAY=PASS
WAITING_APPROVAL_NOT_ROLLED_UP_AWAY=PASS

DAILY_ROLLUP_TRUTHFUL=PASS
WEEKLY_ROLLUP_TRUTHFUL=PASS

ROLLUP_SUCCESS_COUNT_REAL=PASS
ROLLUP_FAILURE_COUNT_REAL=PASS

SUMMARY_DOES_NOT_INVENT_RESULT=PASS
SUMMARY_DOES_NOT_INVENT_VERIFICATION=PASS
SUMMARY_DOES_NOT_INVENT_APPROVAL=PASS

TECHNICAL_TRACE_AVAILABLE_ON_DEMAND=PASS
```

---

# 32. UI Acceptance Criteria

## Home

```text
HOME_SHOWS_ACTIVE_BACKGROUND_WORK=PASS
HOME_DOES_NOT_SHOW_RAW_EVENT_SPAM=PASS
HOME_STOP_AVAILABLE_FOR_ACTIVE_EXECUTION=PASS
```

## Activity

```text
ACTIVITY_GROUPED_BY_MEANINGFUL_WORK=PASS
ACTIVITY_DEFAULT_COPY_HUMAN_READABLE=PASS
ACTIVITY_NOW_RECENT_NEEDS_YOU=PASS
ACTIVITY_BEFORE_AFTER_WHERE_AVAILABLE=PASS
ACTIVITY_VERIFICATION_VISIBLE=PASS
```

## Mobile

```text
MOBILE_ACTIVITY_COMPRESSED=PASS
MOBILE_NEEDS_YOU_PRIORITY=PASS
MOBILE_APPROVAL_ACTIONABLE=PASS
MOBILE_STOP_ACTIONABLE=PASS
```

---

# 33. Anti-Patterns

Do not:

```text
show every UIA event
show every transport heartbeat
show internal event IDs by default
show raw stack traces
show raw COM/UIA terminology
show an endless ungrouped timeline
roll failures into a misleading success summary
claim success without verification
claim rollback without actual rollback
hide background activity completely
make the user hunt for whether NAgex is currently controlling something
```

---

# 34. UX Review Questions

Every Activity design review must answer:

```text
1. Can a normal user understand what NAgex did?
2. Can the user tell whether anything changed?
3. Can the user tell whether the result was verified?
4. Can the user tell whether approval was involved?
5. Can the user tell whether NAgex is still working?
6. Can the user stop it?
7. Is technical detail hidden until requested?
8. Are failures impossible to miss?
9. Are old activities compressed without becoming misleading?
10. Does the Activity screen increase trust rather than create anxiety?
```

---

# 35. Final Canonical Principles

Permanent NAgex principles:

> **Background execution must never mean invisible execution.**

> **NAgex may work without taking over the user's input, but it must never work outside the user's visibility and control.**

> **Activity is not a raw event log. Activity is a human-readable explanation of what NAgex did, why it mattered, and what changed.**

> **Store events at machine detail. Present them at human meaning.**

> **The user should see results by default, details when needed, and technical evidence on demand.**

---

# 36. Status

```text
DOCUMENT=NAgex Activity & Execution Transparency Amendment v1

OBSERVABLE_BACKGROUND_EXECUTION=REQUIRED
RAW_EVENT_DEFAULT_UI=REJECTED
HUMAN_READABLE_ACTIVITY=REQUIRED
EVENT_GROUPING=REQUIRED
ROLLUP_COMPRESSION=REQUIRED
BEFORE_AFTER_WHERE_PROVABLE=REQUIRED
POST_ACTION_VERIFICATION=REQUIRED
USER_STOP=REQUIRED

APPLIES_TO=
DC3-B2+
Desktop Activity
Mobile Activity
Home active-execution surface
Device Control
Approval UX
Audit linkage

NEXT=
Apply this amendment to DC3-B2 Preflight and implementation design.
```

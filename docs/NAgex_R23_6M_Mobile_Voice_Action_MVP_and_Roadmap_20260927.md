# NAgex Mobile Voice Action MVP 구현 지시서 및 개발 로드맵 반영안

기준일: 2026-09-27  
최종 개정: 2026-09-27 — Phase 명명 확정(A~G) 및 Section 17.1
  Canonical Identity Principle(1 Account / 여러 Session / 여러 Device) 추가  
프로젝트: NAgex  
목적: 모바일 환경에서 음성 명령을 통해 실제 디바이스 액션을 수행하는 핵심 Personal AI 기능 구현

---

# 1. 결정 사항

NAgex의 향후 핵심 기능으로 **Voice + Mobile Device Control**을 공식 개발 로드맵에 반영한다.

단, 이번 단계에서 스마트폰 전체 자동화를 목표로 하지 않는다.

이번 구현 범위는 다음으로 제한한다.

```text
Android
+ Voice Input
+ Contact Resolution
+ SMS
+ KakaoTalk
+ Voice Approval
+ Mobile Execution
+ Activity / Audit
```

Canonical milestone name:

```text
R23.6M — Mobile Voice Action MVP
```

R23.6M은 새로운 독립 제품이 아니라, 기존 NAgex Permission / Approval / Execution 구조에  
**Mobile Device Executor**를 추가하는 단계로 정의한다.

---

# 2. 사용자 경험 목표

대표 사용자 시나리오:

> “김대진 대표에게 20분 정도 늦는다고 카톡 보내줘.”

NAgex의 목표 동작:

```text
Voice Input
   ↓
Speech-to-Text
   ↓
Intent Resolution
   ↓
Contact Resolution
   ↓
Channel Resolution
   ↓
Message Draft
   ↓
Voice Confirmation
   ↓
Approval Binding
   ↓
Mobile Execution
   ↓
Send Result Verification
   ↓
Activity / Audit
```

사용자 경험 예시:

```text
User:
"김대진 대표에게 20분 정도 늦는다고 카톡 보내줘."

NAgex:
"김대진 대표에게
'20분 정도 늦을 것 같습니다.'
라고 카카오톡으로 보낼까요?"

User:
"응."

NAgex:
"전송했습니다."
```

---

# 3. 핵심 제품 원칙

R23.6M은 다음 원칙을 반드시 따른다.

## 3.1 LLM은 디바이스를 직접 제어하지 않는다

잘못된 구조:

```text
LLM
→ Android UI 직접 클릭
```

권장 구조:

```text
LLM
→ Structured Intent
→ NAgex Policy
→ Permission / Approval
→ Mobile Execution Adapter
→ Android Device
```

LLM은 다음 정보만 제안한다.

```text
recipient
channel
message
action
```

실제 실행 권한은 NAgex server-side policy가 가진다.

## 3.2 Voice Approval도 기존 Human Approval과 동일하게 취급

Voice confirmation은 단순 자연어 응답이 아니라 기존 Approval 모델을 재사용해야 한다.

승인 payload 예:

```json
{
  "recipient": "김대진",
  "channel": "KAKAOTALK",
  "message": "20분 정도 늦을 것 같습니다."
}
```

사용자가 승인한 뒤 다음 값이 변경되면 기존 승인 무효화:

```text
recipient
channel
message
target conversation
execution route
```

즉:

```text
APPROVED PAYLOAD != EXECUTION PAYLOAD
→ BLOCK
→ RE-APPROVAL REQUIRED
```

기존 payload-drift protection을 그대로 재사용한다.

---

# 4. MVP 범위

이번 단계에서는 액션 종류를 아래 2개로 제한한다.

```text
1. SMS 메시지 보내기
2. KakaoTalk 메시지 보내기
```

이번 단계에 포함하지 않는다:

```text
전화 걸기
지도/내비게이션 제어
음악 앱 제어
SNS 게시
파일 전송
예약/결제
일반 앱 자동화
iOS
스마트폰 전체 UI 제어
```

Scope expansion 금지.

---

# 5. Android 우선

R23.6M은 Android만 지원한다.

이유:

```text
Intent 활용 가능
Contacts Provider 활용 가능
Accessibility 기반 UI execution 가능
Device-side bridge 구현 가능
테스트 가능한 자동화 경로 확보 가능
```

iOS는 별도 future milestone로 분리한다.

---

# 6. 권장 아키텍처

```text
┌───────────────────────────────┐
│ NAgex Mobile App              │
│                               │
│ Voice Capture                 │
│ STT                           │
│ Device Action Bridge          │
└───────────────┬───────────────┘
                ↓
┌───────────────────────────────┐
│ NAgex Core                    │
│                               │
│ Intent Resolver               │
│ Contact Resolver              │
│ Personal Context              │
│ Permission                    │
│ Approval                      │
│ Execution Route Resolver      │
│ Activity / Audit              │
└───────────────┬───────────────┘
                ↓
┌───────────────────────────────┐
│ Mobile Execution Layer        │
│                               │
│ SMS Adapter                   │
│ KakaoTalk Adapter             │
│ Android Intent Adapter        │
│ Accessibility Executor        │
└───────────────┬───────────────┘
                ↓
┌───────────────────────────────┐
│ Android Device                │
│                               │
│ Contacts                      │
│ SMS App                       │
│ KakaoTalk                     │
└───────────────────────────────┘
```

---

# 7. Execution Route Resolver

메시지 전송은 하나의 구현 방식에 고정하지 않는다.

Canonical priority:

```text
1. Official API
2. Android Intent / Deep Link
3. Installed App Session + UI Automation
4. User Manual Fallback
```

NAgex는 요청마다 가능한 execution route를 선택한다.

예:

```text
SEND_MESSAGE
channel=SMS
→ Android Intent 우선

SEND_MESSAGE
channel=KAKAOTALK
→ Official API 가능 여부 확인
→ 불가능하면 App/UI execution
```

사용자에게 내부 실행 경로 차이를 노출할 필요는 없다.

---

# 8. KakaoTalk 구현 원칙

KakaoTalk은 일반 연락처 대상으로 자유로운 메시지 자동 전송을 전제로 설계하면 안 된다.

따라서 다음과 같이 처리한다.

```text
KakaoTalk Message Request
   ↓
Official route available?
   ├─ YES → Official API / supported route
   └─ NO
       ↓
Installed app available?
       ├─ YES → Mobile UI execution
       └─ NO → Manual fallback
```

UI automation은 다음을 주의한다.

```text
UI selector drift
앱 버전 변경
대화방 동명이인
잘못된 대상 선택
Accessibility 정책
실행 완료 여부 검증
```

KakaoTalk UI 자동화는 반드시 fail-closed로 설계한다.

대상이 명확하지 않으면 실행하지 않는다.

---

# 9. Contact Resolution

음성 명령의 사람 이름은 바로 실행 대상으로 사용하면 안 된다.

예:

```text
"김대진 대표에게 보내줘"
```

NAgex는 다음 순서로 확인한다.

```text
Voice Entity
   ↓
Personal Context
   ↓
Contacts Provider
   ↓
Candidate Matching
   ↓
Unique Match?
```

## Unique Match

```text
1명
→ 다음 단계
```

## Ambiguous Match

```text
2명 이상
→ 사용자에게 clarification
```

예:

```text
"김대진이라는 연락처가 두 명 있습니다.
주식회사 A의 김대진 대표에게 보낼까요?"
```

추측 실행 금지.

---

# 10. Voice Layer

R23.6M Voice Layer는 다음 책임만 가진다.

```text
Voice Capture
Speech-to-Text
Command Submission
Approval Response Capture
Result Playback
```

Voice Layer가 Permission / Policy를 판단해서는 안 된다.

---

# 11. Voice Approval UX

운전 등 hands-busy 상황에서 화면 터치 없이 승인할 수 있어야 한다.

예:

```text
NAgex:
"박민수에게 '10분 늦습니다'라고 문자로 보낼까요?"

User:
"응"
```

Voice approval parser는 허용 가능한 confirmation vocabulary를 제한한다.

예:

```text
Approve:
응
네
보내
전송해
좋아

Reject:
아니
취소
보내지마
중단
```

애매한 응답:

```text
"글쎄"
"잠깐"
"음..."
```

→ 승인 처리 금지.

Fail closed.

---

# 12. 실행 결과 검증

UI를 눌렀다는 사실만으로 성공 처리해서는 안 된다.

금지:

```text
click(send)
→ success=true
```

필요:

```text
execution attempted
   ↓
result evidence
   ↓
success / unknown / failed
```

가능한 결과 상태:

```text
SENT_CONFIRMED
SENT_UNCONFIRMED
BLOCKED
FAILED
USER_ACTION_REQUIRED
```

`SENT_UNCONFIRMED`을 `SENT_CONFIRMED`로 위장하지 않는다.

---

# 13. Activity / Audit

모든 mobile action은 기록한다.

기록 대상:

```text
request timestamp
resolved recipient
channel
message hash / safe summary
approval id
execution route
execution result
device id/reference
failure code
```

기록 금지:

```text
raw credential
OAuth token
secret
unrelated contact data
```

---

# 14. 기존 NAgex 기능 재사용

R23.6M은 기존 기능을 재사용한다.

```text
R23.3T
Permission / Approval
→ 재사용

R23.4V
Credential Broker
→ 재사용

R23.5B
Untrusted Content Boundary
→ 재사용

Execution Engine
→ 재사용

Activity / Audit
→ 재사용

Memory / Personal Context
→ contact/context resolution에 제한적으로 재사용
```

새로운 병렬 보안 체계를 만들지 않는다.

---

# 15. 보안 불변식

R23.6M Target Invariants:

```text
VOICE_CAN_BYPASS_APPROVAL=0
LLM_CAN_DIRECTLY_CONTROL_DEVICE=0
AMBIGUOUS_CONTACT_AUTO_EXECUTE=0
MESSAGE_PAYLOAD_DRIFT_ALLOWED=0
UNAPPROVED_SEND=0
WRONG_RECIPIENT_FAIL_OPEN=0
UNKNOWN_EXECUTION_SUCCESS=0

MOBILE_ACTION_REQUIRES_POLICY=1
MOBILE_ACTION_REQUIRES_APPROVAL=1
MOBILE_ACTION_AUDITED=1
VOICE_APPROVAL_BOUND_TO_PAYLOAD=1
```

Credential 관련 기존 불변식 유지:

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

---

# 16. 주요 API / 타입 권장안

예시:

```ts
type MobileMessageChannel =
  | 'SMS'
  | 'KAKAOTALK';

type MobileMessageRequest = {
  userId: string;
  deviceId: string;
  recipientRef: string;
  channel: MobileMessageChannel;
  message: string;
};

type MobileExecutionRoute =
  | 'OFFICIAL_API'
  | 'ANDROID_INTENT'
  | 'APP_UI_AUTOMATION'
  | 'MANUAL';

type MobileExecutionResult =
  | 'SENT_CONFIRMED'
  | 'SENT_UNCONFIRMED'
  | 'BLOCKED'
  | 'FAILED'
  | 'USER_ACTION_REQUIRED';
```

외부 모델이 직접 `recipientRef`를 만들지 못하게 한다.

Contact Resolver가 canonical recipient reference를 발급한다.

---

# 17. 구현 Phase

업데이트 (2026-09-27): 실제 구현 과정에서 Phase 명명을 아래와 같이 확정한다.
이전 초안의 Phase A~E(Voice Foundation/Contacts/SMS/KakaoTalk/Safety)
명명은 아래 canonical 목록으로 대체한다 — 각 Phase의 실제 구현 내용 자체는
이번 개정으로 바뀌지 않으며, Phase 문자와 범위만 실제 수행 순서에 맞게
정정한다.

```text
Phase A — Mobile Architecture Audit         [CLOSED]
Phase B — Android Companion Foundation      [CLOSED]
Phase C — Real SMS Execution                [CURRENT NEXT]
Phase D — KakaoTalk Execution
Phase E — Mobile Safety Certification
Phase F — Unified Identity + Judge Distribution
Phase G — Hackathon Mobile Final Certification
```

## Phase A — Mobile Architecture Audit [CLOSED]

구현:

```text
기존 리포지토리의 모바일/디바이스 아키텍처 실사
재사용 가능 컴포넌트 식별 (DeviceIdentityStore, ActionApprovalStore 등)
신규 구현 필요 범위 확정
Android 기술 스택 결정 (Native Kotlin)
```

완료 기준:

```text
아키텍처 감사 보고서 승인 완료
```

## Phase B — Android Companion Foundation [CLOSED]

구현 (B1~B4 하위 단계 포함):

```text
Android app shell (StatusActivity, VoiceCommandActivity)
Device identity/enrollment (실제 Ed25519 키페어, 세션 기반 인증)
signed device-agent transport (CONNECT/HEARTBEAT/STATUS)
Voice capture / STT / TTS (VoiceCaptureManager, NagexSpeech)
Contacts permission / Contacts Provider integration
Contact Resolver / ambiguity handling / canonical recipientRef
실기기(Physical Android Device) 빌드·테스트·스모크 인증
```

완료 기준:

```text
Voice → text → NAgex request → response
voice name → unique contact resolution
실제 물리 기기(Samsung SM-F731N)에서의 실행 검증 완료
```

## Phase C — Real SMS Execution [CURRENT NEXT]

구현:

```text
SMS 실행 스키마 (MobileMessageRunRecord)
승인 (기존 ActionApprovalStore 재사용, 신규 승인 체계 없음)
device-agent 신호 서명 명령 3종 (PREPARE/EXECUTE/STATUS)
SmsManager 기반 실제 전송 (디바이스 측에서만 실행)
result tracking (SEND_ATTEMPTED/SENT_CONFIRMED/DELIVERY_CONFIRMED/
  SEND_FAILED/SEND_STATUS_UNKNOWN)
audit (메시지 원문은 기록하지 않음 — digest만)
```

완료 기준:

```text
Voice
→ Contact
→ SMS draft
→ Voice approval
→ device execution
→ result
실기기에서의 실제 SMS 발신 인증 완료 (Robolectric/단위 테스트만으로는
Phase C를 종료할 수 없음)
```

## Phase D — KakaoTalk Execution

구현:

```text
KakaoTalk route discovery
official route support where applicable
app detection
UI execution adapter
conversation target validation
message input
send
result verification
```

완료 기준:

```text
Voice
→ Contact
→ KakaoTalk
→ Approval
→ actual device execution
```

## Phase E — Mobile Safety Certification

필수 테스트:

```text
wrong contact
duplicate contact names
approval rejection
approval payload drift
message changed after approval
channel changed after approval
malicious app content
wrong conversation detected
KakaoTalk UI changed
device offline
app missing
Accessibility unavailable
send result unknown
cross-user device isolation
```

## Phase F — Unified Identity + Judge Distribution

신규 추가 (2026-09-27) — 해커톤 심사위원 배포/시연을 위한 통합 계정 체계.
자세한 내용은 Section 17.1(Canonical Identity Principle)을 참고.

```text
F1. Canonical Google Identity Integration
F2. Web Sign-up / Sign-in Unification
F3. Mobile Browser Sign-up / Sign-in Unification
F4. Android App Google Sign-in
F5. Same-user Web/Mobile Identity Mapping
F6. Mobile Session Issuance
F7. Automatic Device Enrollment
F8. Mobile Browser → Android App handoff
F9. Signed Release APK
F10. Judge Installation Page / QR Download
F11. Guided Judge Demo Flow
F12. Safe Demo Mode / Real Execution Mode separation
```

완료 기준:

```text
동일 Google 계정으로 Web/Mobile Browser/Android App 어디서 로그인해도
동일한 NAgex userId로 귀결된다 (WEB_MOBILE_DUPLICATE_ACCOUNT = 0).
심사위원이 QR/설치 페이지를 통해 실제 기기에서 데모를 재현할 수 있다.
```

## Phase G — Hackathon Mobile Final Certification

이 단계부터 신규 기능 추가 금지. Section 21의 R23.9C 검증 항목에 모바일
전용 항목(Android Voice MVP, 실기기 인증, Judge 데모 플로우)을 통합한다.

---

# 17.1 Canonical Identity Principle — 1 Account / Multiple Sessions / Multiple Devices

채택 (2026-09-27). Phase F(Unified Identity + Judge Distribution)의 설계
원칙이며, 지금 이 시점에는 문서화만 하고 구현은 시작하지 않는다 — Phase C
(Real SMS Execution)가 여전히 다음 구현 대상이다.

## 핵심 원칙

```text
1 NAgex Account
+ 여러 Session (Web, Mobile Browser, Android App 등)
+ 여러 Device
```

Web, Mobile Browser, Android App은 모두 동일한 Google identity를 동일한
NAgex userId로 귀결시켜야 한다. 모바일 전용 별도 계정을 만들지 않는다.

## Web-First 플로우

```text
Web 브라우저:
Google Sign up
→ NAgex 계정 생성

이후 Mobile 브라우저:
동일 Google identity
→ 기존 계정
→ Welcome back / Sign in

디바이스 제어 기능(device-control capability)이 필요한 시점:
→ Android 앱 설치 안내 표시
→ APK 설치 페이지 / QR 다운로드
→ Android 앱이 동일 Google 계정으로 로그인
→ 동일 NAgex userId
→ 모바일 세션 발급
→ 디바이스 enrollment
```

## Mobile-First 플로우

```text
Mobile 브라우저:
Google Sign up
→ NAgex 계정 생성

Android 앱:
동일 Google identity
→ 기존 NAgex 계정
→ 모바일 세션
→ 디바이스 enrollment

이후 Desktop/Web:
동일 Google identity
→ 기존 계정
→ Welcome back / Sign in
```

## Identity 규칙

```text
SAME_GOOGLE_IDENTITY
→ SAME_NAGEX_USER_ID

WEB_SESSION != MOBILE_SESSION

하지만:

WEB_USER_ID == MOBILE_USER_ID
```

Sign up은 NAgex 계정당 단 한 번만 발생한다. 이후의 모든 접근은
Sign in / Welcome back이다.

## Google 로그인 인증 vs Google 기능 권한

Google Sign-In은 신원 확인(authentication) 목적으로만 사용한다.

로그인 스코프:

```text
openid
email
profile
```

Gmail/Calendar 권한은 로그인과 완전히 분리된 별도의 capability-consent
플로우로 처리한다. 최초 로그인 시점에 Gmail/Calendar 스코프를 요청하지
않는다.

## Android Device 규칙

Android 디바이스 enrollment는 반드시 사용자 인증(authentication) *이후에만*
발생한다.

```text
Authentication: 이 사람이 누구인가?
Device Enrollment: 그 인증된 사용자에게 이 Android 기기가 속하는가?
```

두 개념은 항상 분리해서 다룬다 — 이미 Phase B4에서 확립한
"세션이 tenant/owner를 결정하고, deviceId는 그 세션이 실제로 소유한
기기인지 항상 재검증한다"는 원칙과 동일한 방향이다.

## Invariants

```text
WEB_MOBILE_DUPLICATE_ACCOUNT = 0
SAME_GOOGLE_IDENTITY_SAME_USER_ID = 1
CLIENT_CAN_CHOOSE_USER_ID = 0
CLIENT_CAN_CHOOSE_TENANT_ID = 0
DEVICE_ENROLLMENT_WITHOUT_AUTHENTICATED_USER = 0
LOGIN_GOOGLE_SCOPE_MINIMAL = 1
GMAIL_CALENDAR_CONSENT_SEPARATE = 1
```

---

# 18. 대표 E2E 시나리오

## Scenario 1 — SMS

```text
User:
"엄마한테 30분 늦는다고 문자 보내줘."

NAgex:
"엄마에게 '30분 정도 늦을 것 같아요.'라고 문자로 보낼까요?"

User:
"응."

NAgex:
→ SMS execution
→ result verification
→ "전송했습니다."
```

## Scenario 2 — KakaoTalk

```text
User:
"김대진 대표에게 지금 출발했다고 카톡 보내줘."

NAgex:
"김대진 대표에게 '지금 출발했습니다.'라고 카카오톡으로 보낼까요?"

User:
"보내."

NAgex:
→ KakaoTalk execution
→ result verification
→ "전송했습니다."
```

---

# 19. 이번 단계에서 하지 않을 것

```text
모든 Android 앱 자동화
iOS 구현
전화 자동 발신
금융 앱 조작
결제
임의 Accessibility navigation
사용자 승인 없는 메시지 전송
LLM 직접 UI control
```

이 범위를 넘기지 않는다.

---

# 20. NAgex 개발 로드맵 반영

기존:

```text
R23.5B Browser Untrusted-Content Boundary
   ↓
R23.6E One Complete Real E2E Agent Scenario
   ↓
R23.7G Background Runtime Certification
   ↓
R23.8P Governed Personality / Trust UX
   ↓
R23.9C Final Hackathon Certification
```

변경:

```text
R23.5B Browser Untrusted-Content Boundary
   ↓
R23.6E One Complete Real E2E Agent Scenario
   ↓
R23.6M Mobile Voice Action MVP
   ↓
R23.7G Background Runtime Certification
   ↓
R23.8P Governed Personality / Trust UX
   ↓
R23.9C Final Hackathon Certification
```

---

# 21. 세부 로드맵

## R23.5B — Browser Untrusted-Content Boundary

현재 상태:

```text
NEAR CLOSURE
```

남은 핵심:

```text
deployed-cert fix
final closure certification
```

R23.5B 종료 전 R23.6M 개발 시작 금지.

## R23.6E — One Complete Real E2E Agent Scenario

목표:

```text
User Goal
→ Context
→ Planning
→ Model
→ Web/API/Browser
→ Evidence
→ Gmail Draft
→ Approval
→ Real Send
→ Audit
→ Governed Memory
```

대표 시나리오:

> Monitor a competitor's pricing, summarize what changed, and email me the report.

R23.6E는 기존 Web/Agent 실행 흐름을 완성하는 기준 milestone로 유지한다.

## R23.6M — Mobile Voice Action MVP

목표:

```text
Voice
→ Contact
→ Message
→ Voice Approval
→ Android Device Execution
```

지원:

```text
SMS
KakaoTalk
```

플랫폼:

```text
Android only
```

내부 Phase 구조 (2026-09-27 확정, Section 17/17.1 참고):

```text
Phase A — Mobile Architecture Audit         [CLOSED]
Phase B — Android Companion Foundation      [CLOSED]
Phase C — Real SMS Execution                [CURRENT NEXT]
Phase D — KakaoTalk Execution
Phase E — Mobile Safety Certification
Phase F — Unified Identity + Judge Distribution
Phase G — Hackathon Mobile Final Certification
```

## R23.7G — Background Runtime Certification

목표:

```text
scheduled task
conditional watch
retry
failure recovery
restart recovery
deduplication
cancellation
persistence
cross-session safety
```

## R23.8P — Governed Personality / Trust UX

목표:

```text
why NAgex recommends something
what it intends to do
which data it will use
whether approval is required
what actually happened
```

Voice 환경에서는 다음도 포함한다.

```text
spoken confirmation
spoken clarification
spoken execution result
spoken failure explanation
```

## R23.9C — Final Hackathon Certification

이 단계부터 신규 기능 추가 금지.

검증:

```text
Regression
Security
Real Browser
Android Voice MVP
Mobile UX
EN/KR
Deployment
Demo
Evidence Pack
Screenshots
Video
```

---

# 22. 향후 확장 로드맵

R23 이후 후보:

```text
R24.x — General Mobile Action Framework
R24.x — Phone Call / Dialer
R24.x — Navigation / Maps
R24.x — Media Control
R24.x — Generic Android App Actions
R25.x — iOS Companion
```

단, R23.6M 검증이 끝나기 전에는 위 기능을 선행 개발하지 않는다.

---

# 23. 해커톤 데모 메시지

R23.6M이 완성되면 데모 메시지는 다음과 같이 단순하게 전달할 수 있다.

> NAgex can act for you even when your hands are busy.

대표 데모:

```text
“Tell Alex I'm running 15 minutes late.”
```

NAgex:

```text
resolve Alex
→ compose message
→ ask for voice confirmation
→ execute on Android
→ confirm result
```

이 시나리오는 NAgex의 다음 핵심 가치를 동시에 보여준다.

```text
Personal Context
Voice
Action
Human Control
Trust
Real-world Execution
```

---

# 24. 최종 개발 원칙

R23.6M의 성공 기준은 다음이 아니다.

```text
Voice recognition works
Android can open KakaoTalk
Accessibility click works
```

최종 성공 기준은:

```text
USER INTENT
→ CORRECT PERSON
→ CORRECT MESSAGE
→ EXPLICIT APPROVAL
→ CORRECT CHANNEL
→ REAL DEVICE ACTION
→ TRUTHFUL RESULT
```

이 흐름 전체가 안전하게 완료되는 것이다.

---

# 25. 최종 실행 순서

```text
1. R23.5B 완전 종료
2. R23.6E Real E2E 완성
3. R23.6M Android Voice Messaging MVP
   3.1 Phase A — Mobile Architecture Audit [CLOSED]
   3.2 Phase B — Android Companion Foundation [CLOSED]
   3.3 Phase C — Real SMS Execution [CURRENT NEXT]
   3.4 Phase D — KakaoTalk Execution
   3.5 Phase E — Mobile Safety Certification
   3.6 Phase F — Unified Identity + Judge Distribution
   3.7 Phase G — Hackathon Mobile Final Certification
4. R23.7G Background Runtime
5. R23.8P Trust UX
6. R23.9C Final Certification
```

이 순서를 NAgex 해커톤 개발의 새로운 canonical roadmap으로 사용한다.

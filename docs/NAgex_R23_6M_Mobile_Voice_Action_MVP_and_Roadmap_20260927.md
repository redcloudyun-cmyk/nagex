# NAgex Mobile Voice Action MVP 구현 지시서 및 개발 로드맵 반영안

기준일: 2026-09-27  
최종 개정: 2026-09-28 — Phase C CLOSED(FINAL_SHA afeb432) 반영, Phase C.5
  (Global Voice Invocation Foundation) 추가, Phase D를 D1/D2A/D2B/D3로
  세분화, D1 Global Messaging Abstraction CLOSED, D2A KakaoTalk Execution
  Feasibility Audit CLOSED, D2B KakaoTalk Truthful Handoff Adapter를 NEXT로
  지정. Section 17.12에 Multi-Platform Execution Architecture
  ("One Brain, Many Execution Planes")를 canonical 원칙으로 추가하고
  Web/Server/Browser/Android/iOS/Desktop 실행 plane 분리를 반영  
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

업데이트 (2026-09-28): Phase C가 실기기 인증까지 완료되어 CLOSED되었고
(FINAL_SHA `afeb432`, 근거: `docs/evidence/R23_6M_Phase_C_SMS_Execution_
Closure_Report_20260928.md`), 이번 개정에서 두 가지를 canonical 목록에
반영한다 — (1) Phase C와 Phase D 사이에 Phase C.5(Global Voice Invocation
Foundation)를 신설하고, (2) 기존 단일 Phase D(KakaoTalk Execution)를
D1(Global Messaging Abstraction) / D2(KakaoTalk Execution Adapter) /
D3(Global Messaging Adapter Feasibility)로 분할한다. 이는 NAgex가
SMS/KakaoTalk/WhatsApp 등 특정 메시징 앱을 core capability로 모델링하지
않고, COMMUNICATION/SEND_MESSAGE라는 canonical capability 아래 플랫폼별
MessagingExecutionAdapter를 두는 구조로 처음부터 설계되어야 한다는 원칙
(Section 17.4)에 따른 것이다. Phase A/B/C의 실제 구현 내용 자체는 이번
개정으로 바뀌지 않는다 — Phase C의 인증된 SMS 실행 동작(runtime behavior)은
이 문서 개정으로도, 이후 Phase C.5/D1/D2/D3 구현으로도 변경되지 않는다.

```text
Phase A    — Mobile Architecture Audit                [CLOSED]
Phase B    — Android Companion Foundation             [CLOSED]
Phase C    — Real SMS Execution                       [CLOSED, FINAL_SHA afeb432]
Phase C.5  — Global Voice Invocation Foundation        [P0 CLOSED, P1 NOT STARTED]
Phase D1   — Global Messaging Abstraction              [CLOSED]
Phase D2A  — KakaoTalk Execution Feasibility Audit     [CLOSED]
Phase D2B  — KakaoTalk Truthful Handoff Adapter        [NEXT]
Phase D3   — Global Messaging Adapter Feasibility
Phase E    — Mobile Safety Certification
Phase F    — Unified Identity + Global Distribution
Phase G    — Hackathon Mobile Final Certification
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

## Phase C — Real SMS Execution [CLOSED, FINAL_SHA afeb432]

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

완료 기준 (달성, CLOSED):

```text
Voice
→ Contact
→ SMS draft
→ Voice approval
→ device execution
→ result
실기기(Samsung SM-F731N)에서의 실제 SMS 발신 인증 완료 — 시나리오
A(성공 발신)/B(승인 거부)/C(승인 후 메시지 변조)/D(승인 후 수신자 변조)/
F(SEND_SMS 권한 거부)/G(디바이스 revoke)/H(잘못된/누락된 recipientRef)/
I(번호 2개 이상 → 명시적 선택 요구)가 모두 실기기에서 PASS. 시나리오
E(duplicate execute)는 물리적으로 재현 불가능한 이유가 명시적으로 확인되어
자동화 테스트(real Ed25519 서명 기반)로 대체 인증됨. 근거 문서:
docs/evidence/R23_6M_Phase_C_SMS_Execution_Closure_Report_20260928.md
(FINAL_SHA afeb432).
```

## Phase C.5 — Global Voice Invocation Foundation [P0 CLOSED, P1 NOT STARTED]

신규 추가 (2026-09-28). Phase C는 CLOSED 상태를 유지하며, 이 Phase는 Phase C의
인증된 SMS 실행 동작을 변경하지 않는다 — 오직 "사용자가 어떻게 NAgex를
호출하는가"만 다룬다. 상세 원칙은 Section 17.2(Global Voice Invocation
Principle)와 17.3(Cross-Platform Invocation Model)을 참고.

구현 범위 (C.5A 감사 → C.5B~C.5H 구현, Section 17.8 참고):

```text
C.5A — Invocation Architecture / Feasibility Audit (구현 전 필수, Section 17.8)
C.5B — Invocation Entry Points (P0: tap-to-talk/notification/QS Tile/widget,
        P1: wake phrase "네이젝스" / "헤이 네이젝스")
C.5C — Wake Word Boundary (wake word는 실행 권한을 절대 부여하지 않음)
C.5D — Privacy / Audio Handling (마이크 lifecycle, 서버 업로드 금지 원칙)
C.5E — Voice Session UX ("네, 말씀하세요." 이후 기존 파이프라인으로 합류)
C.5F — Invocation State Machine (IDLE→WAKE_DETECTED→...→ACTION_READY)
C.5G — Foreground/Background Behavior 테스트
C.5H — Security Invariants (Section 17.2 불변식과 동일)
```

완료 기준:

```text
C.5A 감사 보고서가 먼저 검토·승인되어야 C.5B 이후 구현을 시작할 수 있다.
모든 진입 경로(tap-to-talk/notification/QS Tile/widget/wake phrase)가
하나의 canonical VoiceSession 진입점으로 수렴한다 — 진입 경로별로 별도의
agent/action 로직을 만들지 않는다.
기존 Phase C 승인/실행 의미론(approval semantics)은 변경되지 않는다.
```

**C.5B-P0 완료 (2026-09-28, commit `f12f35a`):** tap-to-talk/home-screen
shortcut·widget/persistent notification/Quick Settings Tile 4개 진입
경로 모두 `VoiceSession`(신규) → `VoiceInvokeActivity`(유일한 exported
trampoline) 경계로 수렴함을 실기기(Samsung SM-F731N)에서 시나리오
A-J(in-app tap/widget/notification/QS Tile/다른 앱 foreground 상태에서
호출/마이크 권한 거부/알림 권한 거부/중복 invocation 거부/음성→실제
SMS 발신/거부→SMS 0건)로 인증 완료. Wake word/VoiceInteractionService는
전혀 구현하지 않음(구조적 스캔 테스트로 고정). Phase C 실행/승인
동작은 변경되지 않았다(회귀 스위트 동일하게 green). **C.5B-P1(wake
phrase)은 시작하지 않았다** — Section 17.4의 wake-word engine 선정
조사가 먼저 필요하다.

## Phase D1 — Global Messaging Abstraction [CLOSED]

신규 추가 (2026-09-28, 기존 단일 Phase D를 세분화). 상세 원칙은
Section 17.4(Global Messaging Principle)와 17.5(D1 상세)를 참고.

구현:

```text
COMMUNICATION/SEND_MESSAGE canonical capability 정의
SendMessageAction 도메인 모델 (recipient/content/preferredChannel/
  locale·context/device·session context)
MessagingExecutionAdapter 인터페이스 (capability check/prepare/
  execute approved action/status·result/failure·fallback reporting)
Execution Route Resolver (Section 17.6)
기존 Phase C SMS 실행 경로를 MessagingExecutionAdapter로 감싸는 wrapper
  — 인증된 SMS 실행 자체를 불필요하게 리팩터링하지 않는다
```

완료 기준:

```text
KakaoTalk 관련 필드/개념이 SendMessageAction에 전혀 노출되지 않는다.
Phase C의 인증된 SMS 실행 경로가 어댑터로 감싼 이후에도 기존 회귀
테스트(scenario A-I, Phase C 4개 스코프)가 그대로 통과한다.
```

## Phase D2A — KakaoTalk Execution Feasibility Audit [CLOSED]

결론:

```text
공식 Kakao Message API는 임의 개인 친구 대상 범용 자동 발송 API가 아님.
공식 API는 Kakao Login/동의/추가 권한/receiver UUID/템플릿 등 조건부 경로로만 검토.
KakaoTalk Share / Android 공유는 HUMAN_HANDOFF / NEEDS_HUMAN 경로.
AccessibilityService 기반 소비자 자동화는 NO-GO.
앱/공유 UI 실행만으로 SENT_CONFIRMED 처리 금지.
KakaoTalk 실패 시 SMS silent fallback 금지.
```

근거 문서:

```text
docs/NAgex_R23_6M_D2A_KakaoTalk_Execution_Feasibility_Audit_20260928.md
```

## Phase D2B — KakaoTalk Truthful Handoff Adapter [NEXT]

구현 (Korea-first):

```text
KakaoTalk route discovery
official route support where applicable
app detection
UI execution adapter (D1의 MessagingExecutionAdapter 구현체)
conversation target validation
message input
send
result verification
```

완료 기준:

```text
Voice
→ Contact
→ COMMUNICATION/SEND_MESSAGE (channel=KakaoTalk)
→ Approval
→ actual device execution (KakaoTalk MessagingExecutionAdapter)
```

## Phase D3 — Global Messaging Adapter Feasibility

신규 추가 (2026-09-28). 구현이 아닌 조사(feasibility) 단계 — 상세는
Section 17.4를 참고.

```text
조사 대상: WhatsApp / RCS / iOS-supported messaging routes / LINE /
  Email / Slack / Microsoft Teams
지금 전부 구현하지 않는다 — feasibility만 문서화한다.
```

## Phase E — Mobile Safety Certification

필수 보안 차단 항목 (Section 17.10 — Phase E는 아래 3개가 해소되기 전까지
종료될 수 없다):

```text
A. PLATFORM_HEADER_TRUST_GAP
   — 승인 등 민감 라우트는 반드시 검증된 세션/인증 컨텍스트에서
     tenant/principal을 도출해야 한다. 위조 가능한 x-nagex-tenant /
     x-principal-id 헤더로 권한을 부여해서는 안 된다.
B. DEVICE_IDENTITY_KEY_HARDENING
   — 현재 소프트웨어 Ed25519 키 저장 방식은 Mobile Safety Certification
     완료 전에 공식적인 보안 결정/hardening을 받아야 한다 (Section 17.9).
C. VOICE_PRIVACY_BOUNDARY
   — wake word 감지만을 위한 연속적인 raw 마이크 오디오 업로드는 금지된다.
```

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

## Phase F — Unified Identity + Global Distribution

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

채택 (2026-09-27). Phase F(Unified Identity + Global Distribution)의 설계
원칙이며, 채택 시점에는 문서화만 하고 구현을 시작하지 않았다 — 이후 Phase C
(Real SMS Execution)가 CLOSED(FINAL_SHA afeb432)되었고, 다음 구현 대상은
Phase C.5(Global Voice Invocation Foundation)이다. 이 원칙 자체는 변경되지
않는다.

## 핵심 원칙

```text
1 NAgex Account
+ 여러 Session (Web, Mobile Browser, Android App 등)
+ 여러 Device
```

이 identity 모델은 Google을 최초 identity provider로 채택하지만, 특정
provider에 종속되지 않는다 — 향후 다른 identity provider(예: Apple/이메일
기반 자체 인증 등)가 추가되더라도 "1 NAgex Account + 여러 Session + 여러
Device"라는 canonical 구조와 "동일 실사용자는 항상 동일 NAgex userId로
귀결된다"는 원칙 자체는 바뀌지 않아야 한다 (Section 17.11 참고).

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

# 17.2 Global Voice Invocation Principle

신규 추가 (2026-09-28). Phase C.5의 설계 원칙 — NAgex의 음성 호출(voice
invocation)은 한국어 wake word 전용 구현이 아니라 처음부터 글로벌
capability로 설계되어야 한다.

## Canonical 발음

```text
제품명: NAgex
한국어 canonical 발음: "네이젝스"
영어 canonical 발음: "NAY-jex"

기본 한국어 invocation: "네이젝스"
선택 한국어 invocation: "헤이 네이젝스"
영어 invocation: "NAgex" / "Hey NAgex"
```

아키텍처는 NAgex의 canonical identity를 바꾸지 않으면서 locale/accent별
invocation 모델을 허용해야 한다. 글로벌 제품을 한국어 STT 동작에
하드코딩하지 않는다.

## Canonical 플로우

```text
Invocation
→ Voice Session
→ Language / Locale Detection
→ User Intent
→ Contact / Entity Resolution
→ Human Approval
→ Execution Route Resolver
→ Platform Adapter
→ Result / Audit
```

Wake phrase는 어떤 실행 권한도 부여하지 않는다.

## 필수 불변식

```text
WAKE_WORD_CAN_EXECUTE_ACTION = 0
WAKE_WORD_CAN_BYPASS_APPROVAL = 0
VOICE_CAN_BYPASS_APPROVAL = 0
BACKGROUND_RAW_AUDIO_SERVER_UPLOAD = 0
BACKGROUND_RAW_AUDIO_STORAGE = 0
LLM_CAN_DIRECTLY_CONTROL_DEVICE = 0
```

## Human Approval First는 modality-neutral하다 — "터치 전용"으로 고정하지 않는다

명확화 (2026-09-28, C.5B-P0 실기기 인증 과정에서 확정). 위 두 불변식,
`VOICE_CAN_BYPASS_APPROVAL = 0`과 `WAKE_WORD_CAN_BYPASS_APPROVAL = 0`은
**"NAgex는 영원히 터치 승인만 지원해야 한다"는 뜻이 아니다.** 실제 의미는:

```text
- 음성 invocation 자체는 승인으로 인정되지 않는다
- wake phrase 자체는 승인으로 인정되지 않는다
- 실행은 항상 명시적이고 별도로 바인딩된 승인 이벤트를 요구해야 한다
```

현재 인증된 SMS 실행 플로우(Phase C, C.5B-P0)에서 그 명시적 승인 이벤트는
**물리적 터치**(`APPROVE`/`REJECT` 버튼)이다 — 이것은 이번 마일스톤의
현재 구현 선택이며, 바꿀 수 없는 아키텍처 상한선이 아니다.

장기적으로 NAgex는 다음과 같은 추가 명시적 승인 모달리티를 지원할 수
있다:

```text
- TOUCH (현재 인증된 유일한 방식)
- VOICE_EXPLICIT_CONFIRMATION
- BIOMETRIC
- SYSTEM_CONFIRMATION
```

향후 어떤 음성 승인(voice approval)을 도입하더라도, 그것은 "승인 우회"가
아니라 **별도의, 그 자체로 완전한 승인 메커니즘**으로 설계되어야 하며
반드시:

```text
- 정확한 승인된 recipient에 바인딩되어야 한다
- 정확한 channel에 바인딩되어야 한다
- 정확한 message에 바인딩되어야 한다
- 정확한 execution route에 바인딩되어야 한다
- 명확한 긍정적 의도(affirmative intent)를 요구해야 한다
- 모호한 발화는 거부해야 한다
- payload drift 발생 시 재승인을 요구해야 한다
- 더 위험도가 높은 액션에는 더 강한 확인을 적용해야 한다
```

예시 (장기, 아직 구현하지 않음):

```text
NAgex: "조민형 레하에게 '10분 정도 늦습니다'라고 문자 보낼까요?"
User: "보내"
```

→ 명시적 승인 의도가 검증된 이후에만 실행이 진행될 수 있다.

**C.5B-P0의 범위:** 터치 전용 APPROVE/REJECT를 그대로 유지하며, 음성
승인은 지금 구현하지 않는다. 이 절은 오직 향후 설계가 "터치만 영원히
가능하다"는 잘못된 결론으로 굳어지지 않도록 하기 위한 것이다.

# 17.3 Cross-Platform Invocation Model

Invocation은 공통 추상화 뒤에서 OS별로 다르게 구현된다 — canonical
추상화 이름은 `VoiceInvocationProvider`이다.

```text
Android:
- in-app tap-to-talk
- home-screen shortcut/widget
- notification action
- Quick Settings Tile
- foreground-session wake word
- VoiceInteractionService / assistant-role feasibility
- screen-off/background feasibility subject to Android restrictions

iOS:
- App Intents
- Siri / Shortcuts integration
- system-supported invocation paths
- Android 방식의 always-on wake word가 가능하다고 가정하지 않는다

Web:
- mic button
- keyboard invocation
- browser-supported voice path

Desktop:
- global shortcut
- microphone session
- future native background integration

Wearables:
- OS assistant integration where available
```

OS 전반에 동일한 invocation 메커니즘을 약속하지 않는다. NAgex는 일관된
사용자 경험(user experience)을 제공하되, 그 아래의 실제 invocation
route는 플랫폼별로 달라질 수 있다.

# 17.4 Global Messaging Principle

NAgex는 SMS, KakaoTalk, WhatsApp, LINE, iMessage, RCS, Slack, Teams 등을
core product capability로 취급하지 않는다.

## Canonical capability

```text
COMMUNICATION / SEND_MESSAGE
```

## Canonical 도메인

```text
SendMessageAction
- recipient
- content
- optional preferredChannel
- locale/context
- device/session context
```

## 실행 흐름

```text
User Intent
→ COMMUNICATION/SEND_MESSAGE
→ Contact/Entity Resolution
→ Human Approval
→ ExecutionRouteResolver
→ MessagingExecutionAdapter
→ platform-specific execution
```

## 초기 어댑터

```text
SMS       — Phase C에서 이미 인증 완료
KakaoTalk — Korea-first 어댑터 (Phase D2)

향후 feasibility 대상 (지금 전부 구현하지 않음):
- WhatsApp
- RCS
- iOS-supported messaging routes
- LINE
- Email
- Slack
- Microsoft Teams
```

# 17.5 D1 — Global Messaging Abstraction 상세

KakaoTalk 전용 구현에 앞서, canonical adapter 경계를 먼저 만들고
검증한다.

## 개념적 인터페이스: `MessagingExecutionAdapter`

책임:

```text
- capability/availability check
- prepare
- execute approved action
- status/result
- platform-specific failure/fallback reporting
```

KakaoTalk 전용 필드는 `SendMessageAction`에 절대 노출되어서는 안 된다.

Phase C의 SMS 실행 동작은 이 어댑터 경계 아래에서 재사용/wrap되어야 하며,
그 인증된 실행 경로 자체를 불필요하게 무효화해서는 안 된다 — 가능하면
기존 구현을 감싸는 adapter wrapper를 우선한다.

# 17.6 Execution Route Resolver

글로벌 NAgex 동작 예시:

```text
User: "Tell John I'll be 10 minutes late."

NAgex resolves:
recipient
→ available communication routes
→ user's explicit/preferred channel
→ recipient/channel availability
→ platform/device capability
→ safest supported route

Possible result: SMS / WhatsApp / KakaoTalk / RCS / Email / etc.
```

사용자가 채널을 명시적으로 지정하면, 그 채널이 사용 가능한 한 그대로
따른다. 채널을 지정하지 않으면 사용자 선호/context로 resolve할 수 있지만,
**최종 승인(approval) 화면에는 반드시 선택된 채널이 노출되어야 한다.**

```text
Recipient: John
Channel: WhatsApp
Message: "I'll be about 10 minutes late."

APPROVE / REJECT
```

승인 이후 채널이 바뀌면 반드시 재승인이 필요하다 — Phase C에서 이미
확립된 "승인 이후 payload(메시지/수신자/채널/디바이스/실행경로)가 바뀌면
재승인이 필요하다"는 원칙(Section 5, 17.5)과 동일한 방향이다.

# 17.7 Global Language Model

다음 세 가지를 분리한다:

```text
UI Locale
Conversation Locale
Execution/Recipient Locale
```

예:

```text
UI locale: ko-KR
Voice request: Korean
Recipient message: English

User: "존한테 오늘 회의를 30분 미루자고 영어로 보내줘."
```

NAgex는 영어 메시지를 준비할 수 있지만, 생성된 정확한 수신자/채널/메시지는
실행 전에 반드시 Human Approval에 바인딩되어야 한다. UI 언어 == 발화 언어
== 발신 메시지 언어라고 가정하지 않는다.

# 17.8 C.5 Global Voice Invocation Audit (C.5A) 요구사항

구현 전에 C.5는 반드시 feasibility audit만 먼저 수행한다. 감사 보고서는
아래 항목을 다뤄야 한다:

```text
1. Android true wake-word feasibility
2. foreground-session wake-word feasibility
3. background invocation feasibility
4. screen-off invocation feasibility
5. VoiceInteractionService / assistant-role feasibility
6. notification/Quick Settings/widget fallback
7. battery implications
8. privacy implications
9. Android policy/runtime restrictions
10. 이 invocation 추상화가 이후 iOS/Web/Desktop을 어떻게 지원할 수 있는가
```

이 감사가 검토(review)되기 전까지 C.5B 이후 구현을 시작하지 않는다.
가짜(always-on을 실제로 구현하지 않고 구현된 것처럼 보고하는) 백그라운드
wake word를 절대 만들지 않는다 — Android 정책/런타임 제약으로 신뢰할 수
있는 true always-on invocation이 불가능하다면, 가장 강력한
정책-준수(compliant) fallback을 구현하고 그 한계를 명시적으로 공개한다.

## Post-Speech Silence Tuning Baseline (C.5B-P0에서 확정, 2026-09-28)

실기기(Samsung SM-F731N) 인증 중 OEM recognizer의 기본 silence threshold가
이름과 자연스러운 중간 pause를 조기에 잘라내는 현상이 실측되어, 아래
값을 NAgex 음성 UX의 baseline으로 확정한다 (`VoiceCaptureManager.kt`):

```text
EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS          = 1800ms (기본값)
EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS = 1500ms (최소값)
상한 목표                                                    = ~2200ms
```

**중요한 단서:** 이 값들은 Android `RecognizerIntent`의 recognizer
**힌트**일 뿐이며, 특정 기기/OEM recognizer 구현이 이 값을 정확히
보장한다는 뜻이 아니다 — recognizer/OS가 이 값을 무시하거나 clamp할 수
있다. 새 기기/새 OEM recognizer로 확장할 때는 반드시 실기기에서
재검증해야 하며, 이 baseline을 "절대값 보장"으로 오해해서는 안 된다.

# 17.9 Security Debt — Device Private Key (DEVICE_IDENTITY_KEY_HARDENING)

정정 (2026-09-28) — canonical 보안 기록을 다음과 같이 바로잡는다. 현재
Phase B/C 구현의 디바이스 private key는:

```text
- 표준 JCA "Ed25519" provider로 생성됨 (AndroidKeyStore 내부에서
  생성되지 않음)
- StrongBox 백엔드가 아님
- 하드웨어 백엔드가 아님
- private key 자체는 EncryptedSharedPreferences에 암호화되어
  저장됨 — 그 wrapping MasterKey는 AndroidKeystore 기반이지만,
  이는 저장(at-rest) 상태의 암호화일 뿐이다
- 서명(sign) 시점에는 Ed25519 private key 원본이 앱 프로세스 내부의
  평범한 PrivateKey 객체로 재구성된다
- 따라서 이 키는 아키텍처적으로 "추출 불가능(non-exportable)"하지 않다
```

이 키를 "hardware non-exportable" 또는 "AndroidKeyStore Ed25519 private
key"라고 서술한 이전 표현은 부정확하며, 이 문서 개정 및
`docs/evidence/R23_6M_Phase_C_SMS_Execution_Closure_Report_20260928.md`
Section 17에서 이미 정정되었다.

## 신규 carried-forward 보안 부채: `DEVICE_IDENTITY_KEY_HARDENING`

Phase E(Mobile Safety Certification) 이전/도중에 반드시 평가·확정되어야
한다. 선호 목표 구조:

```text
AndroidKeyStore-native asymmetric signing key,
non-exportable private-key semantics 기반
```

평가 대상:

```text
- 대상 Android 버전/provider에서의 Ed25519 지원 여부
- 필요 시 EC/P-256 AndroidKeyStore 대안
- 하드웨어 백엔드 가용성
- StrongBox 가용성
- key attestation feasibility
- 마이그레이션/재-enrollment 전략
```

이번 문서 개정(documentation-only)에서는 인증된 키 구현 자체를 변경하지
않는다.

# 17.10 Phase E Mandatory Security Blockers

Phase E는 아래 3개 항목이 명시적으로 해소되기 전까지 종료될 수 없다
(Phase E 섹션 본문에도 동일하게 반영됨):

```text
A. PLATFORM_HEADER_TRUST_GAP
   승인 및 기타 민감 라우트는 검증된 세션/인증 컨텍스트에서만
   tenant/principal을 도출해야 한다. 위조 가능한 x-nagex-tenant /
   x-principal-id 헤더로는 절대 권한을 부여하지 않는다.

B. DEVICE_IDENTITY_KEY_HARDENING
   현재 소프트웨어 Ed25519 키 저장 방식은 Mobile Safety Certification
   완료 전에 공식적인 보안 결정/hardening을 받아야 한다 (Section 17.9).

C. VOICE_PRIVACY_BOUNDARY
   wake word 감지만을 위한 연속적인 raw 마이크 오디오 서버 업로드는
   금지된다.
```

# 17.11 Phase F — Global Identity 확장 원칙

Section 17.1의 canonical identity(1 NAgex Account + 여러 Session + 여러
Device)는 그대로 유지한다. Google 로그인 identity는 Google 서비스
capability 권한(Gmail/Calendar 등)과 항상 분리된 채로 남는다.

아키텍처는 이후 추가 identity provider(예: Apple 등)가 도입되더라도
NAgex user identity semantics 자체를 바꾸지 않고 확장할 수 있어야 한다.
동일 인물의 Web/Mobile/Desktop 클라이언트는 항상 동일한 canonical NAgex
userId로 귀결되어야 한다.


# 17.12 Multi-Platform Execution Architecture — One Brain, Many Execution Planes

신규 canonical 원칙 (2026-09-28). 상세 개발지시서는 다음 문서를 기준으로 한다:

```text
docs/NAgex_Multi_Platform_Execution_Architecture_Development_Directive_20260928.md
```

NAgex는 모든 플랫폼의 실행 코드를 하나로 합치지 않는다. 공통화하는 것은
**의도/identity/memory/context/policy/approval/audit/result contract**이며,
실제 실행은 환경별 Execution Plane으로 분리한다.

Canonical 구조:

```text
WHAT
→ Canonical Action

WHERE
→ Execution Environment / Target

HOW
→ Execution Route / Platform Executor
```

상위 흐름:

```text
User / Event
→ Intent
→ Canonical Action
→ Memory / Context / Policy
→ Human Approval
→ Execution Planner
→ Execution Target
→ Platform Executor
→ Result Verification
→ Audit
```

Reasoning Plane과 Execution Plane은 분리한다:

```text
Reasoning Plane
≠
Execution Plane
```

지원 대상 Execution Environment:

```text
SERVER
WEB
BROWSER
ANDROID
IOS
DESKTOP
EXTERNAL_API
```

플랫폼별 구현 세부사항(Android Intent/Activity, browser selector/DOM,
iOS App Intent, desktop native API 등)은 canonical action에 절대 노출하지
않고 해당 platform executor 내부에만 둔다.

Execution Planner는 최소 다음 결정을 분리해서 수행해야 한다:

```text
Environment Resolver
→ Capability Resolver
→ Route Resolver
→ Execution Plan
```

Approval은 실제 실행될 plan에 바인딩한다. 다음 항목 중 하나라도 바뀌면
기존 승인은 무효이며 재승인이 필요하다:

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

특히:

```text
ANDROID → BROWSER
ANDROID_SMS_MANAGER → WHATSAPP_WEB
```

와 같은 environment/route 변경은 approval drift다.

Global execution invariants:

```text
EXECUTION_ROUTE_DRIFT_ALLOWED = 0
EXECUTION_ENVIRONMENT_DRIFT_ALLOWED = 0
SILENT_FALLBACK_ALLOWED = 0
FAKE_SUCCESS_PATHS = 0
LLM_CAN_DIRECTLY_CONTROL_DEVICE = 0
```

Human handoff는 실패가 아니라 정식 execution mode다:

```text
AUTONOMOUS_VERIFIED
HUMAN_HANDOFF
MANUAL
```

예:

```text
SMS / ANDROID_SMS_MANAGER
→ AUTONOMOUS_VERIFIED

KakaoTalk / KAKAOTALK_SHARE
→ HUMAN_HANDOFF
→ NEEDS_HUMAN
```

D2B부터 이 원칙을 적용한다:

```text
environment = ANDROID
channel = KAKAOTALK
executionRoute = KAKAOTALK_SHARE
executionMode = HUMAN_HANDOFF
```

KakaoTalk Share의 trust boundary 이후 사용자가 선택한 최종 수신자/수정한
메시지/실제 Send 결과를 NAgex가 검증했다고 주장해서는 안 된다.

장기 개발 원칙:

> **One Brain, Many Execution Planes.**

NAgex는 플랫폼마다 실행 방식은 달라도 사용자 의도와 trust semantics는
일관되게 유지한다.

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

내부 Phase 구조 (2026-09-28 갱신, Section 17/17.1~17.12 참고):

```text
Phase A    — Mobile Architecture Audit                [CLOSED]
Phase B    — Android Companion Foundation             [CLOSED]
Phase C    — Real SMS Execution                       [CLOSED, FINAL_SHA afeb432]
Phase C.5  — Global Voice Invocation Foundation        [P0 CLOSED, P1 NOT STARTED]
Phase D1   — Global Messaging Abstraction              [CLOSED]
Phase D2A  — KakaoTalk Execution Feasibility Audit     [CLOSED]
Phase D2B  — KakaoTalk Truthful Handoff Adapter        [NEXT]
Phase D3   — Global Messaging Adapter Feasibility
Phase E    — Mobile Safety Certification
Phase F    — Unified Identity + Global Distribution
Phase G    — Hackathon Mobile Final Certification
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
   3.1 Phase A    — Mobile Architecture Audit [CLOSED]
   3.2 Phase B    — Android Companion Foundation [CLOSED]
   3.3 Phase C    — Real SMS Execution [CLOSED, FINAL_SHA afeb432]
   3.4 Phase C.5  — Global Voice Invocation Foundation [P0 CLOSED, P1 NOT STARTED]
   3.5 Phase D1   — Global Messaging Abstraction [CLOSED]
   3.6 Phase D2A  — KakaoTalk Execution Feasibility Audit [CLOSED]
   3.7 Phase D2B  — KakaoTalk Truthful Handoff Adapter [NEXT]
   3.8 Phase D3   — Global Messaging Adapter Feasibility
   3.9 Phase E    — Mobile Safety Certification
   3.10 Phase F   — Unified Identity + Global Distribution
   3.11 Phase G   — Hackathon Mobile Final Certification
4. R23.7G Background Runtime
5. R23.8P Trust UX
6. R23.9C Final Certification
```

이 순서를 NAgex 해커톤 개발의 새로운 canonical roadmap으로 사용한다.
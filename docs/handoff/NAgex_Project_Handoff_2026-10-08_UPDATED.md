# NAgex Project Handoff ??2026-10-07

## 0. ?ㅼ쓬 梨꾪똿?먯꽌??理쒖슦???먯튃

??쒕떂 ?몄묶???ъ슜?쒕떎.

?듬?? 媛앷??겶룰렐嫄?以묒떖?쇰줈 ?쒕떎. ?먮룞?쇰줈 湲띿젙?섏? 留먭퀬, ?ㅼ젣 肄붾뱶/?뚯뒪???ㅺ린湲?利앷굅媛 ?덈뒗 寃쎌슦?먮쭔 PASS濡??먯젙?쒕떎.

NAgex ?꾩옱 ?쒗뭹 諛⑺뼢:
- Personal AI / Personal Executive Assistant / Personal AI OS
- ?듭떖 猷⑦봽: **Remember ??Create ??Approve ??Act**
- Canonical principle: **ASTRA PROPOSES. NAGEX AUTHORIZES. DEVICE AGENT EXECUTES.**
- Voice??approval???고쉶?섏? ?딅뒗??
- ?붾컮?댁뒪/recipient/route/provider/account媛 ?뱀씤 ?댄썑 諛붾뚮㈃ ?ъ듅?명븳??

以묒슂:
- ?꾩옱 ?댁빱????踰붿쐞?먯꽌??**?ㅼ젣 硫붿떆吏 SEND???꾩쭅 ?몄쬆?섏? ?딅뒗??**
- ?꾩옱 紐⑺몴???ㅼ젣 KakaoTalk?먯꽌 **????앸퀎 ??梨꾪똿諛??좏깮 ??珥덉븞 ?낅젰 ??SEND 吏곸쟾 STOP**源뚯???
- `git add .`, `git add -A`, `git commit -a`, `git reset --hard`, `git clean -fd`, ?먮룞 stash 湲덉?.
- ?쒕쾭??湲곗〈 untracked artifacts??蹂댁〈?쒕떎.

---

## 1. Git / ?쒕쾭 湲곗???
Windows repo:
`F:\媛쒕컻 ?꾨줈?앺듃\Nagex project`

Ubuntu server source:
`/home/redcloud/services/nagex/source`

Service:
`nagex.service`

API:
- Local: `http://127.0.0.1:4100`
- Public: `https://nagex-test.agex.site`

?ㅼ젣 SSH 寃쎈줈:
- `ssh redcloud@100.100.248.77`
- ?먮뒗 ?ㅼ젙??`redcloud-server` alias
- **`nagex-test.agex.site:22`濡?SSH ?쒕룄?섏? 留?寃? 諛섎났?곸쑝濡?timeout 諛쒖깮.**

?꾩옱 ?쒕쾭 branch:
`r23.6m-mobile-voice-action`

理쒓렐 二쇱슂 commit:
- `af52323a2c35f11c08cd4afd8892a8716fb5fc9e` ??Astra live diagnostic runner
- `3615e35941a06af13aa466dd6762da3f00d0d34e` ??governed accessibility command enqueue
- `3998375b3632c3cbd5d0b1a2fe5d5817052e23fb` ??governed accessibility draft approvals
- `9cbdf6b11947fd223608ff52e8185d2ede474f53` ??deterministic Kakao draft navigation
- `ff394c2256c4a1dfb02dd5419bddaf4592c178ad` ??hardened Kakao bottom-nav selection

?쒕쾭??理쒖쥌?곸쑝濡?`ff394c2256c4a1dfb02dd5419bddaf4592c178ad`源뚯? fast-forward 諛고룷??

?쒕쾭 ?곹깭 ?뺤씤 湲곗?:
- `ActiveState=active`
- `SubState=running`
- `NRestarts=0`
- local/public health = `200`

?쒕쾭??蹂댁〈?댁빞 ?섎뒗 unrelated untracked:
- `artifacts/r21_deployed/`
- `artifacts/r21_p1_deployed_certification.json`
- `artifacts/r21_p1_deployed_latency.json`
- `artifacts/r23.7c-c/`

---

## 2. Runtime / provider ?곹깭

Runtime network-family issue??CLOSED.

systemd drop-in:
`/etc/systemd/system/nagex.service.d/network-family.conf`

?곸슜媛?
`NODE_OPTIONS=--no-network-family-autoselection --dns-result-order=ipv4first`

寃利?
- Node fetch to Nebius S3 ?뺤긽
- S3 `LIVE`
- read/write true
- Nebius/Nemotron PASS
- OpenAI/Astra PASS
- Google provider??`BLOCKED_NOT_CONNECTED` ?곹깭?怨??뚭? ?꾨떂

S3:
- endpoint: `https://storage.eu-north1.nebius.cloud`
- region: `eu-north1`
- bucket: `nagex-vault`
- versioning enabled

---

## 3. Mobile Execution ?곹깭 ?붿빟

### M2
Permission / Route Authority = PASS

### M3
Governed routes / App Link = PASS

### M4
Accessibility contract/security architecture = PASS. ?ㅺ린湲곗뿉??skeleton???쒕윭???댄썑 ?ㅼ젣 actuator 援ы쁽.

### M4A
Astra-guided device reasoning architecture = PASS

### M4B
Real Astra provider integration = CLOSED
- real `gpt-6-astra` call PASS
- typed proposal PASS
- Action Gate PASS
- Astra direct execution = NO

### M4C ?ㅺ린湲?怨쇱젙
?ㅼ젣 ?붾컮?댁뒪:
- Samsung SM-F926N
- Android 15
- SDK 35

?ㅺ린湲?寃利?怨쇱젙?먯꽌 諛쒓껄/?섏젙???ㅼ젣 寃고븿:
1. M4 capability report媛 ?ㅺ린湲??깆뿉 ?곌껐?섏? ?딆쓬
2. Kakao 26.8.2媛 湲곗〈 certified range 諛?3. AccessibilityService媛 愿李?skeleton?댁뿀??4. server ??Android accessibility plan dispatch 寃쎈줈 遺??5. command??messageHash留??덇퀬 approved text 誘몄쟾??6. Android normal login UX 遺??7. login UI submit path 吏꾨떒
8. test account verification/email delivery 誘멸뎄??9. governed enqueue API 遺??10. governed Kakao draft approval creation API 遺??11. Kakao ?대? navigation contract媛 ?ㅼ젣 start screen variation??紐??ㅻ８
12. bottom nav selected-state 濡쒖쭅 蹂닿컯

---

## 4. Authentication / enrollment ???ㅺ린湲?PASS

??쒕떂 control account:
`redcloudyun@gmail.com`

IdentityStore:
- `ACCOUNT_EXISTS=YES`
- `ACCOUNT_STATE=ACTIVE`

??濡쒓렇?? PASS
Android 濡쒓렇?? PASS
Android authenticated session: PASS
Device enrollment: PASS

Real device:
- `deviceId=dev_dc89a36e98617f6d`
- status `ACTIVE`
- connection state `CONNECTED`

R2B1 real cert:
- REAL_DEVICE_LOGIN=PASS
- AUTHENTICATED_SESSION=PASS
- DEVICE_BINDING_VALID=YES
- TENANT_BINDING_VALID=YES
- USER_BINDING_VALID=YES
- REAL_DEVICE_HEARTBEAT=PASS
- COMMAND_SIGNATURE=PASS
- SERVER_RESPONSE_RECEIVED=YES

二쇱쓽:
- APK reinstall/update ??Android Accessibility global switch媛 ?먯＜ `0`?쇰줈 ?대젮媛?
- ?먮룞 ?ы솢?깊솕 湲덉?.
- ??쒕떂??吏곸젒 `?ㅼ젙 ???묎렐?????ㅼ튂??????NAgex ???ъ슜`
- ?뺤씤: `accessibility_enabled=1`

---

## 5. Governed accessibility command / approval

### Enqueue API
諛고룷??
`POST /api/v1/device-agent/accessibility-plans`

?뱀쭠:
- authenticated
- device ownership
- tenant ownership
- user ownership
- approval check
- recipient binding
- message hash binding
- generic command API ?놁쓬
- SEND action ?놁쓬
- arbitrary action ?놁쓬

### Draft approval API
諛고룷??
`POST /api/v1/approvals`
with `toolId=KAKAOTALK_ACCESSIBILITY_DRAFT`

?뱀씤 ?앹꽦 ??諛섎뱶??
`POST /api/v1/approvals/{approvalId}/approve`

approval status??top-level `.status`.
approval? ?쒕쾲 enqueue???ъ슜?섎㈃ ?ъ궗??湲덉?.

---

## 6. Canonical recipient

?꾩옱 ?뚯뒪?????

Contact display name:
`議곕????덊븯`

?ㅼ젣 Android Contacts contact_id:
`67`

canonical recipientRef:
`rcp_7b6e0f62f9cd33fb`

Device:
`dev_dc89a36e98617f6d`

Kakao package:
`com.kakao.talk`

Kakao version:
`26.8.2`

Route:
`ANDROID_ACCESSIBILITY`

泥섏쓬 ?섎せ ?앹꽦??old recipientRef `rcp_82d9b30d15af6085`???ъ슜?섏? 留?寃?

---

## 7. KakaoTalk ?ㅼ젣 UI 愿李?/ ?ㅺ린湲?PASS 踰붿쐞

Bottom nav parent:
- className=`android.widget.LinearLayout`
- resourceViewId=`com.kakao.talk:id/sliding_tabs`

Chat tab:
- className=`android.widget.RelativeLayout`
- contentDescription dynamic: `梨꾪똿 ??...`
- clickable=true

More tab:
- className=`android.widget.RelativeLayout`
- contentDescription dynamic: `?붾낫湲???...`

Final Chat selector:
- parentResourceId=`com.kakao.talk:id/sliding_tabs`
- className=`android.widget.RelativeLayout`
- contentDescriptionContains=`梨꾪똿 ??
- clickable=true

State rule:
- selected=true ??`NAV_ALREADY_SELECTED`, no click
- selected=false ??`CLICK_ALLOWED_NODE`, then require selected=true
- ambiguous/missing ??fail closed

?ㅺ린湲??몄쬆:
- `?붾낫湲???梨꾪똿` single-step: PASS
- `梨꾪똿 ??寃??踰꾪듉 ??寃???낅젰李?: PASS
- `M4C_R2D_SEARCH_ENTRY_REAL_CERT=PASS`

---

## 8. ?щ엺 identity? ??붾갑 identity瑜?遺꾨━?댁빞 ??
Android ?곕씫泥??대쫫:
`議곕????덊븯`

Kakao ?ㅼ젣 ?됰꽕??visible identity:
`議곕???(Blue Dia/Mini)`

?곕씪??
- `recipientRef` = ?щ엺??canonical identity
- `contactDisplayName` = Android Contacts ?대쫫
- `providerDisplayName` / `kakaoDisplayName` = Kakao ?쒖떆 ?대쫫

??以묒슂????
Kakao?먯꽌 `議곕??? 寃????1:1 媛쒖씤梨꾪똿肉??꾨땲??議곕??뺤씠 ?ы븿???щ윭 ?⑥껜諛??ㅽ뵂梨꾪똿/梨꾨꼸 ?깆씠 ?ㅼ닔 寃?됰맆 ???덉쓬.

?곕씪??`recipientRef`留뚯쑝濡?理쒖쥌 ?ㅽ뻾 target 寃곗젙? 遺議?

?꾩슂 援ъ“:
```text
ConversationTarget

targetType:
DIRECT
GROUP
OPEN_CHAT
CHANNEL
UNKNOWN

recipientRef?        // DIRECT???щ엺 identity
conversationRef      // ?ㅼ젣 Kakao ??붾갑 identity
provider=KAKAOTALK

contactDisplayName
providerDisplayName
conversationTitle
participantHints[]
deviceId
tenantId
ownerId
```

?꾩옱 M4C ?뺤콉:
- ?쒖“誘쇳삎?먭쾶????DIRECT留??덉슜
- GROUP / OPEN_CHAT / CHANNEL / UNKNOWN ?쒖쇅
- DIRECT 0媛???NOT_FOUND
- DIRECT 2媛??댁긽 ??AMBIGUOUS
- DIRECT 1媛???candidate eligible
- ?좏깮 ??conversation header ?ш?利?
---

## 9. ?ㅻ뒛 留덉?留?寃곌낵 ???뺥솗???ㅼ쓬 ?쒖옉??
`M4C_R2E_SEARCH_CLASSIFICATION=FAIL`

寃곌낵:
- `SEARCH_QUERY=議곕???
- `MATCHED_RESULTS_COUNT=0`
- `DIRECT_COUNT=0`
- `GROUP_COUNT=0`
- `OPEN_CHAT_COUNT=0`
- `CHANNEL_COUNT=0`
- `UNKNOWN_COUNT=0`
- `DIRECT_MATCH_UNIQUE=NO`
- `DIRECT_TARGET_RESOLUTION=NOT_FOUND`
- `CODE_CHANGE_REQUIRED=NO`
- `TODAY_STOP=YES`

?댁꽍:
- 遺꾨쪟 濡쒖쭅 ?ㅽ뙣?쇨퀬 ?⑥젙?섏? 留?寃?
- ?ㅼ젣 Kakao 寃?됱갹??`議곕??????쒕?濡??낅젰?먮뒗吏?, 寃??寃곌낵 Accessibility tree媛 ?대뼸寃??몄텧?섎뒗吏 ?꾩쭅 ?뺤젙?섏? ?딆쓬.

### ?ㅼ쓬 梨꾪똿??泥??묒뾽
1. ?ㅺ린湲??ㅼ떆 ?곌껐
2. NAgex Accessibility ?뺤씤/?섎룞 ?쒖꽦??3. device ACTIVE / CONNECTED ?뺤씤
4. Kakao 梨꾪똿 ??吏꾩엯
5. ?곷떒 寃??踰꾪듉
6. 寃???낅젰李쎌뿉 `議곕??????ㅼ젣 ?낅젰?먮뒗吏 ?뺤씤
7. 寃??寃곌낵 Accessibility tree 愿李?8. 寃곌낵?ㅼ쓣 DIRECT / GROUP / OPEN_CHAT / CHANNEL / UNKNOWN?쇰줈 遺꾨쪟
9. `議곕???(Blue Dia/Mini)` 1:1 媛쒖씤梨꾪똿 ?꾨낫媛 ?좎씪?쒖? ?뺤씤
10. ?꾩쭅 ?대┃?섏? ?딄린
11. conversationRef ?ㅺ퀎/?꾩엯
12. ?댄썑 direct result ?좏깮 ??conversation header ?ш?利???composer ??approved draft ??STOP BEFORE SEND

---

## 10. ?댁빱???댄썑濡?DEFER??蹂댁븞 湲곕뒫

### Voice Owner Authentication / Speaker Verification

??쒕떂 ?붿껌: 吏湲덉? ?섏? ?딄퀬 ?댁빱???댄썑 援ы쁽.

紐⑹쟻:
?뚯꽦 紐낅졊??留먰븳 ?щ엺???ㅼ젣 ?대떦 NAgex ?ъ슜??+ ?대떦 ?붾컮?댁뒪???뚯쑀?먯씤吏 寃利?

Post-hackathon scope:
- speaker enrollment
- speaker verification
- user ??device binding
- multi-device voice authority
- recorded/replayed voice defense
- risk-based step-up authentication
- Android biometric fallback
- audit trail

援ъ“:
```text
Voice input
??Speaker verification
??User identity confidence
??Device binding
??Session / permission
??Action classification
??Human approval if consequential
??Execution
```

?꾩옱 ?댁빱??
`NOT_IMPLEMENT`
`NOT_BLOCKING`

---

## 11. ?덈? ?섏? 留?寃?
- ?ㅼ젣 Kakao SEND
- PRESS_SEND / CLICK_SEND
- RAW_TAP
- coordinate-only execution
- shell/script arbitrary action
- approvalRef fabrication
- DevicePendingCommandStore 吏곸젒 議곗옉
- recipientRef ?꾩쓽 ?앹꽦
- Android encrypted session extraction
- public dev verification token exposure
- Accessibility programmatic enable
- unrelated artifacts ??젣
- unsafe git bulk staging

---

## 12. ??以??붿빟

**NAgex???ㅼ젣 ?쒕쾭 ?뱀씤 ??governed enqueue ??signed heartbeat ??Android Accessibility ??Kakao ???ㅽ뻾 ???붾낫湲겸넂梨꾪똿 ?꾪솚 ??寃???낅젰李?吏꾩엯源뚯? ?ㅺ린湲곗뿉???듦낵?덈떎. ?ㅼ쓬 怨쇱젣??Kakao 寃??寃곌낵?먯꽌 1:1 媛쒖씤梨꾪똿怨??⑥껜/?ㅽ뵂/梨꾨꼸??援щ텇?섍퀬 `conversationRef`瑜??꾩엯???뺥솗????붾갑???좏깮?섎뒗 寃껋씠??**

---

# 2026-10-08 Strategic Direction Update

## 13. Product Positioning ??Planner/Calendar Is Not the Product

NAgex must not collapse into a planner, calendar assistant, task manager, or automation dashboard.

Canonical product position:

- Personal AI
- Personal Executive Assistant
- Personal AI OS
- Personal AI Execution OS

Core loop:

**Remember ??Create ??Approve ??Act**

NAgex should sit above calendars and other apps. Google Calendar, Outlook Calendar, KakaoTalk, WhatsApp, Gmail, Drive, etc. are external providers / execution surfaces, not the product core.

Canonical principle:

> **NAgex Planner is not a calendar. It is the planning and execution layer above calendars.**

NAgex owns user intent and context. Calendar providers own external calendar delivery/synchronization.

Recommended ownership model:

```text
NAgex owns:
- Goals
- Projects
- Tasks
- Events
- Commitments
- WaitingFor
- Routines
- Agent Missions
- Approvals
- Memory
- Personal Context

External calendars own:
- provider calendar/event objects
- provider-specific delivery/sync state
```

NAgex event identity must remain provider-neutral. External provider event IDs must be stored only as bindings, e.g.:

```text
NAgex Event (evt_*)
  ?붴? CalendarBinding[]
       ?쒋? provider=GOOGLE
       ?쒋? calendarId
       ?쒋? externalEventId
       ?쒋? syncToken
       ?붴? lastSyncedAt
```

This prevents Google Calendar dependency and allows later migration/addition of Microsoft Outlook, Apple Calendar, etc.

### Calendar integration direction

Google/Microsoft Calendar must be bidirectional:

```text
External Calendar ??NAgex
- import/sync events
- map to people/projects/tasks/context
- produce meeting prep, reminders, follow-up suggestions

NAgex ??External Calendar
- create/update event only after applicable permission/approval
- preserve NAgex canonical event identity
- bind provider event as external representation
```

NAgex should combine Calendar + Email + Memory + Contacts + Files + Tasks + Agent context to produce contextual assistance, not merely show appointments.

---

## 14. First-Run Trust Setup / Progressive Consent

NAgex first launch must include a lightweight but explicit Trust Setup flow.

Recommended flow:

```text
Sign in
??Personal AI basic setup
??Connect services
??Memory preferences
??Action permissions
??Human Approval preferences
??Finish ??Personal AI workspace
```

The onboarding must NOT request every permission at once. Use Progressive Consent: ask for sensitive access when the user first uses a capability that needs it.

Example:

```text
User asks: "Send a KakaoTalk message to X"
??NAgex explains required permissions
??Contacts access
??Android Accessibility permission
??KakaoTalk execution permission
??Human Approval
```

### Authority concepts must remain separate

```text
Authentication ??Consent ??Permission ??Approval
```

- Authentication: who the user is
- Consent: what data/capability the user agrees NAgex may access
- Permission: what technical/provider/device authority is available
- Approval: authorization for a specific consequential action

Proposed consent ledger concept:

```text
UserConsent
- consentId
- userId
- tenantId
- category
- provider
- scope
- grantedAt
- revokedAt
- policyVersion
- source
```

Typical categories:

```text
CALENDAR_READ
CALENDAR_WRITE
EMAIL_READ
EMAIL_SEND
CONTACT_READ
DEVICE_ACCESSIBILITY
MEMORY
LOCATION
FILE_ACCESS
```

Execution path should remain:

```text
Action Request
??Identity
??Consent
??Permission
??Approval
??Execution
??Verification/Audit
```

---

## 15. Authentication Direction ??Google + Microsoft Only

Current end-user auth policy for this milestone:

```text
ALLOWED:
- Google OAuth/OIDC
- Microsoft OAuth/OIDC

REMOVED FROM PUBLIC END-USER AUTH:
- Email/password
- Kakao auth
- other SNS providers
```

Legacy password data/schema may remain dormant for compatibility/migration, but must not be publicly reachable.

External identity authority:

```text
provider + providerSubject/sub
```

Email alone is not external identity authority. Same-email Google/Microsoft identities must not be silently auto-merged unless an explicit account-linking contract exists.

OAuth UI and backend provider availability must be synchronized: do not show a provider button unless the backend can actually start a real provider flow.

As of 2026-10-08, real Google and Microsoft OAuth client credentials have been configured for development testing. Public test-site deployment must still be verified against the current auth build before final provider certification.

Important environment split:

```text
Local development certification target:
- Google callback: http://127.0.0.1:8085/api/v1/auth/oauth/google/callback
- Microsoft callback: http://localhost:8085/api/v1/auth/oauth/microsoft/callback

Public test-site certification target:
- https://nagex-test.agex.site
- exact public callback paths must be verified from deployed code/runtime before use
```

Do not mix local callback URIs with public test-site OAuth flows.

---

## 16. Mobile Messaging ??Current Kakao Scope and Re-entry Point

The OAuth/authentication work is a prerequisite to restore a valid owner browser session and Human Approval authority. After auth certification, development returns directly to Kakao mobile control.

Current canonical R2G state to preserve:

```text
deviceId=dev_b9e0b857d0aac331
recipientRef=rcp_51f55270f880cec4
conversationRef=cvr_8ef6d0682ce439e3
draftId=kdr_fe0c375ad4a7b111
provider=KAKAOTALK
route=ANDROID_ACCESSIBILITY
```

Canonical message hash:

```text
sha256:5b81a36553531ff9db2dd25ddbbea1aa370ef84757c3cd88c06678954460a018
```

Canonical test message:

```text
?덈뀞?섏꽭?? NAgex 移댁뭅?ㅽ넚 ?곕룞 ?뚯뒪??以묒엯?덈떎. 硫붿떆吏 ?묒꽦 湲곕뒫 ?뺤씤???꾪븳 ?뚯뒪??臾멸뎄?낅땲??
```

Required sequence after auth:

```text
OAuth owner session
??Human Approval UI
??revalidate existing draft
??reuse valid approval OR create exactly one fresh approval if expired
??user manually approves
??R2G select unique DIRECT Kakao conversation
??STOP
??R2H post-selection header identity verification
??only after R2H PASS may approved text typing be considered
??STOP BEFORE SEND
```

Current hackathon boundary remains:

**NO REAL KAKAO SEND.**

---

## 17. Strategic Pivot ??Universal AI App Control

This is now a major NAgex architectural direction.

Problem:

If NAgex separately hardcodes every app and every UI version, development becomes unbounded:

```text
Kakao classifier / selector / verifier / executor
WhatsApp classifier / selector / verifier / executor
Telegram classifier / selector / verifier / executor
LINE classifier / selector / verifier / executor
...
```

This approach is not scalable and creates permanent maintenance burden.

NAgex should instead evolve toward a **Universal AI App Control Layer** capable of understanding unfamiliar apps semantically and controlling them within deterministic safety boundaries.

### Core architectural principle

> **Probabilistic Intelligence + Deterministic Authority**

AI is allowed to be probabilistic for perception, reasoning, semantic classification, capability discovery, and action planning.

Authority must not be probabilistic.

NAgex deterministic core remains the final authority for:

- identity
- tenant/owner binding
- consent
- permission
- recipient authority
- conversation authority
- draft authority
- approval authority
- route binding
- execution boundary
- post-action verification
- audit

Canonical rule:

> **AI can be probabilistic. Authority cannot be probabilistic.**

This extends the existing principle:

> **ASTRA PROPOSES. NAGEX AUTHORIZES. DEVICE AGENT EXECUTES.**

---

## 18. Universal App Control Architecture

Target architecture:

```text
User Intent
   ??NAgex Agent
   ??Universal Capability Resolver
   ??Universal UI Perception
   ?쒋? Accessibility Tree
   ?쒋? Vision
   ?쒋? Text
   ?붴? Interaction History
   ??Semantic UI Model
   ??AI Action Planner
   ??Confidence / Risk Engine
   ??Deterministic Safety & Approval Gate
   ??Execution Runtime
   ?쒋? Android
   ?쒋? Browser
   ?쒋? Desktop
   ?붴? API
   ??Verification / Audit
```

### Universal UI Perception

The device/browser agent should combine:

- Accessibility/UI tree
- visual understanding
- visible text
- role/state relationships
- app/package context
- interaction history
- previously learned app profile

The goal is semantic interpretation instead of brittle resource-ID-only automation.

Example:

```text
Old model:
resource-id=com.foo:id/search_button

Target model:
role=SEARCH_ACTION
semanticIntent=OPEN_SEARCH
confidence=0.97
```

### Semantic UI Model

The system should build a semantic representation such as:

```text
APP HOME
 ?쒋? SEARCH_ACTION
 ?쒋? CHAT_LIST
 ?붴? NEW_CHAT_ACTION

SEARCH
 ?쒋? QUERY_INPUT
 ?붴? RESULT_LIST

CHAT
 ?쒋? CONVERSATION_HEADER
 ?쒋? MESSAGE_LIST
 ?붴? COMPOSER
```

This allows UI updates and provider differences to be absorbed by semantic interpretation rather than app-specific selectors everywhere.

---

## 19. Confidence / Risk Engine

AI interpretation should produce evidence and confidence, not a naked yes/no decision.

Illustrative evidence model:

```text
Visible-name match
Accessibility structure
Contact correlation
Conversation history
Profile identity
App/package context
UI semantic consistency
```

The exact confidence thresholds must be empirically calibrated per action class. Do not freeze arbitrary numbers as universal policy.

Conceptual behavior:

```text
High confidence + low-risk action
??may proceed to deterministic gate

Medium confidence
??ask user / request confirmation / gather more evidence

Low confidence
??fail closed
```

Risk level must dominate confidence. A high-confidence model output still cannot bypass exact approval/authority checks for consequential actions.

Examples:

```text
READ / OBSERVE
??lower threshold may be acceptable

OPEN TARGET CONVERSATION
??stronger target confidence required

TYPE APPROVED TEXT
??exact approval + exact draft/message binding required

SEND MESSAGE
??exact target + message + route + owner + approval + unchanged state

PURCHASE / PAYMENT
??exact amount + counterparty + conditions + explicit approval + reapproval on drift
```

---

## 20. App Capability Discovery and App Profiles

NAgex should not require a full custom implementation for every new app.

Instead maintain a thin `AppProfile` / adapter layer:

```text
AppProfile
- appId / packageName / domain
- knownCapabilities[]
- knownNavigationHints[]
- knownRiskAreas[]
- knownSemanticPatterns[]
- uiFingerprint
- confidence
- lastVerifiedAt
```

Possible discovered capabilities:

```text
SEARCH
CONTACT_SELECTION
DIRECT_MESSAGING
GROUP_MESSAGING
TEXT_INPUT
FILE_ATTACH
VOICE_CALL
CALENDAR_CREATE
EMAIL_DRAFT
EMAIL_SEND
```

When UI fingerprint changes materially:

```text
UI fingerprint changed
??reduce confidence
??enter observe/re-discovery mode
??rebuild semantic map
??do not blindly execute stale actions
```

### App adapters should stay thin

Long-term target:

```text
Universal Messaging / App Control Framework
  ?쒋? Kakao Adapter
  ?쒋? WhatsApp Adapter
  ?쒋? Telegram Adapter
  ?쒋? LINE Adapter
  ?쒋? Slack Adapter
  ?붴? future providers
```

The adapter should provide hints and provider-specific constraints, not reimplement the full trust/execution stack.

---

## 21. WhatsApp Direction

WhatsApp should follow the universal architecture rather than become another large bespoke implementation.

Two execution routes:

```text
Personal WhatsApp
??Android Accessibility / Device Agent

WhatsApp Business
??official Business / Cloud API when applicable
```

Shared NAgex authority stack remains:

```text
recipient authority
conversation authority
draft authority
approval authority
post-selection verification
fail-closed execution
```

Personal WhatsApp should ultimately use the same Universal Conversation Resolver / Semantic UI Model rather than a wholly separate hardcoded classifier architecture.

---

## 22. Environment / Provider Configuration Direction

Development-time environment variables are acceptable internally, but end users must not be exposed to manual environment configuration.

Product UX target:

```text
Settings
??Connections
??Google / Microsoft / other provider
??Connect
```

Connector/runtime should internally manage:

- provider capability
- required scopes
- redirect configuration
- token/account state
- connection health
- revocation
- reauthorization

Environment variables and raw client secrets remain developer/operations concerns only.

---

## 23. Development Priorities After Current Kakao Certification

Recommended order:

```text
1. Complete Auth deployment/certification
2. Restore authenticated owner session
3. Human Approval visibility
4. Complete Kakao R2G
5. Complete Kakao R2H post-selection verification
6. Complete approved text typing
7. STOP BEFORE SEND
8. Extract Kakao-specific logic into reusable semantic abstractions
9. Implement Universal Conversation Resolver
10. Implement Semantic UI Model
11. Implement Confidence/Risk Engine
12. Implement AppCapabilityProfile / UI fingerprint / re-discovery
13. Move Android execution toward Universal Mobile Execution Runtime
14. Add WhatsApp as the first validation adapter of the generalized architecture
```

The purpose of WhatsApp should be to prove that the generalized architecture actually reduces app-specific code, not to create a second independent automation stack.

---

## 24. Canonical Strategic Summary

NAgex should not become:

- a planner
- a calendar clone
- a Google Calendar-dependent assistant
- a collection of app-specific automation scripts
- an LLM that directly clicks arbitrary UI

NAgex should become:

> **A Personal AI Execution OS that understands user intent and context, uses probabilistic AI to understand and plan across unfamiliar apps and environments, and uses deterministic authority, approval, verification, and audit to execute safely.**

Canonical architecture slogan:

> **Probabilistic Intelligence + Deterministic Authority**

Canonical execution principle:

> **ASTRA PROPOSES. NAGEX AUTHORIZES. DEVICE AGENT EXECUTES.**

Canonical product loop:

> **Remember ??Create ??Approve ??Act**

Canonical calendar principle:

> **NAgex Planner is not a calendar. It is the planning and execution layer above calendars.**

Canonical app-control principle:

> **Apps are adapters and execution surfaces. NAgex owns intent, context, authority, approval, and verification.**

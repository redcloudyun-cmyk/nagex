# R23.6M-D3 — Global Messaging Adapter Feasibility Audit

Date: 2026-09-28
Status: **AUDIT COMPLETE — REVIEW REQUIRED; NO NEW ADAPTER IMPLEMENTATION AUTHORIZED**

## 1. Scope and decision rule

This audit applies the **One Brain, Many Execution Planes** architecture:

```text
Canonical SEND_MESSAGE action
→ Execution Planner
→ Environment Resolver
→ Capability Resolver
→ Route Resolver
→ approval where required
→ executor
→ truthful result
```

The same channel in two environments is two distinct execution routes. An
official business API is not treated as personal-user messaging. An Android
share Intent is not classified as a human handoff merely because it resolves or
launches. The actual component and runtime boundary must be certified.

Execution modes:

- `AUTONOMOUS_VERIFIED`: NAgex controls recipient and payload and receives a
  provider/device result proving provider acceptance or device send outcome.
- `HUMAN_HANDOFF`: a certified native surface preserves the approved handoff
  boundary and requires a person to complete it; completion may remain
  unverifiable.
- `MANUAL`: NAgex can at most prepare/copy content or direct the user to an app.
- `UNSUPPORTED`: no route satisfying the required trust boundary is evidenced.

## 2. Feasibility matrix

`Y` means enforced or available for that route; `N` means not enforced or not
available; `C` means conditional on account, scope, recipient relationship, or
provider configuration.

| Channel | Environment | Strongest evidenced route | Mode | Recipient enforced | Message enforced | Completion verifiable | Human required | Official API | Device local | Browser session | Policy/distribution risk | Recommendation |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| SMS | ANDROID | `ANDROID_SMS_MANAGER` | AUTONOMOUS_VERIFIED | Y | Y | Y (device result, not recipient delivery) | N after approval | Android SDK | Y | N | High Play policy/permission sensitivity | Keep implemented; strongest personal mobile route |
| SMS/RCS compose | ANDROID | default messaging `ACTION_SENDTO` | MANUAL | C | N | N | Y | Android platform | Y | N | Medium; resolved app behavior varies | Audit physically before any handoff claim |
| RCS Business | EXTERNAL_API/SERVER | Google RBM API | AUTONOMOUS_VERIFIED | Y | Y | Y for API acceptance/delivery events, subject to carrier | N after approval | Y | N | N | High: brand verification, carrier launch, opt-in/opt-out and regional rules | Defer; business messaging, not arbitrary personal RCS |
| WhatsApp Business | EXTERNAL_API/SERVER | WhatsApp Cloud API | AUTONOMOUS_VERIFIED | Y | Y | Y for provider acceptance/status webhook, not human reading | N after approval | Y | N | N | High: business account, opt-in, templates/conversation windows, pricing/approval | Defer for personal AI; consider only an explicitly business-scoped adapter |
| WhatsApp consumer | ANDROID/IOS | share/deep-link surface | UNSUPPORTED pending physical certification | N | N | N | Y if safe surface exists | N for arbitrary personal account automation | Y | N | High: component/version drift; share semantics unproven | Do not implement from URI/Intent docs alone |
| WhatsApp Web | WEB/BROWSER/DESKTOP | authenticated consumer web session | MANUAL | N | N | N | Y | N | N | Y | High privacy, session takeover, ToS and UI-drift risk | No autonomous browser adapter; manual launch only |
| LINE Official Account | EXTERNAL_API/SERVER | LINE Messaging API push/reply | AUTONOMOUS_VERIFIED | Y | Y | API acceptance and aggregate delivery only | N after approval | Y | N | N | High: Official Account, friend/chat relationship, quota and consent constraints | Defer for personal AI; viable only as business/bot adapter |
| LINE consumer | ANDROID/IOS | share/deep-link surface | UNSUPPORTED pending physical certification | N | N | N | Y if certified | N | Y | N | High: share target behavior/version drift | Do not implement without component/runtime certification |
| Email (Gmail) | SERVER/EXTERNAL_API | Gmail `messages.send` / `drafts.send` | AUTONOMOUS_VERIFIED | Y | Y | Y for provider acceptance, not inbox/read | N after approval | Y | N | N | Medium: OAuth scopes, token protection, quotas | Highest-priority existing adapter; retain |
| Email (generic) | SERVER/EXTERNAL_API | provider API or SMTP submission | AUTONOMOUS_VERIFIED | Y | Y | C: server acceptance, not delivery/read | N after approval | C | N | N | Medium/high credential, anti-abuse and provider policy risk | Add only through provider abstraction and scoped credentials |
| Email compose | IOS | `MFMailComposeViewController` | HUMAN_HANDOFF | C | N | user action result only; no delivery proof | Y | Apple SDK | Y | N | Low/medium | Candidate for future iOS companion |
| Email compose | ANDROID/DESKTOP | mailto/share to selected mail client | MANUAL | N | N | N | Y | Platform/client | Y | C | Medium component/client drift | Manual fallback only after physical audit |
| Slack | SERVER/EXTERNAL_API | `chat.postMessage` | AUTONOMOUS_VERIFIED | Y by channel/DM ID | Y | Y for API-created message, not reading | N after approval | Y | N | N | Medium: OAuth scopes, workspace install, membership, impersonation rules | Strong hackathon candidate; repository already has Slack integration |
| Slack | WEB/BROWSER/DESKTOP | authenticated UI | MANUAL | N | N | N | Y | N | C | Y | High session/privacy/UI-drift risk | Prefer API; no browser automation |
| Teams work/school | SERVER/EXTERNAL_API | Microsoft Graph `chatMessage` POST | AUTONOMOUS_VERIFIED | Y by chat/channel ID | Y | Y via `201 Created`, not reading | N after approval | Y | N | N | Medium/high: delegated work/school scopes, tenant consent; app-only send restricted to migration | Candidate only for enterprise/work-school users |
| Teams personal | SERVER/EXTERNAL_API | Microsoft Graph chat send | UNSUPPORTED | N | N | N | — | Official API does not support delegated personal accounts for this operation | N | N | High | Defer |
| Teams UI | WEB/BROWSER/DESKTOP | authenticated UI | MANUAL | N | N | N | Y | N | C | Y | High session/privacy/UI-drift risk | Prefer Graph; no autonomous UI adapter |
| iMessage/SMS | IOS | `MFMessageComposeViewController` | HUMAN_HANDOFF | C (prefilled but user-editable) | N (user-editable) | N for delivery; delegate reports send/cancel UI result | Y | Apple SDK | Y | N | Low/medium; iOS app and device required | Strong future iOS handoff candidate, never autonomous verified |
| KakaoTalk | ANDROID | package `ACTION_SEND` → `MemoChatConnectActivity` on certified device | UNSUPPORTED | N | N | N | N; it bypassed intended manual boundary | Consumer share only | Y | N | Critical wrong-recipient/self-chat behavior | Keep blocked and capability unavailable |

## 3. Channel findings

### WhatsApp

The Cloud API is a business messaging route. It can strongly bind a destination
phone number and payload and expose provider statuses, but business onboarding,
recipient opt-in, templates and conversation-window rules mean it is not an API
for sending arbitrary messages from a normal user's consumer account. Consumer
app/Web routes are not equivalent executors. Web session automation would place
private conversation data and a durable authenticated session inside the
browser execution plane and carries substantial policy and account risk.

Classification: Cloud API is `AUTONOMOUS_VERIFIED` only for an explicitly
business-scoped capability; personal consumer messaging remains `UNSUPPORTED`
for autonomous execution and at most `MANUAL` without physical certification.

### RCS and the default Android messaging app

NAgex's certified `SmsManager` route is personal SMS, not an RCS guarantee.
Android's default SMS role and provider contracts do not establish a third-party
API for arbitrary personal RCS sends. Google's RCS for Business API represents a
brand agent and requires verification and carrier/Google launch approval. It is
therefore not a substitute for the user's normal RCS identity.

Classification: personal RCS is `UNSUPPORTED`; an Android compose Intent is
`MANUAL` pending device-specific validation; RBM is business-only
`AUTONOMOUS_VERIFIED` after onboarding.

### LINE

LINE's official Messaging API sends as a LINE Official Account to users or
chats reachable by that account. It is not arbitrary consumer-to-consumer
messaging. API acceptance is verifiable, but receipt/read is not generally a
per-message personal-delivery guarantee.

Classification: Official Account route is business/bot
`AUTONOMOUS_VERIFIED`; personal consumer messaging remains `UNSUPPORTED` until
a safe device handoff is physically certified.

### Email

Gmail provides a direct official send endpoint and returns a created message
resource. NAgex already has a real approval-gated Gmail path, making this the
best cross-environment route to retain. Provider acceptance must not be labeled
recipient delivery or reading. Generic SMTP/provider APIs are feasible but add
credential, anti-abuse, bounce and provider-policy complexity.

Classification: Gmail/API send is `AUTONOMOUS_VERIFIED`; native compose UIs are
`HUMAN_HANDOFF` only where the platform gives a documented completion callback,
otherwise `MANUAL`.

### Slack

Slack's `chat.postMessage` binds a channel/DM identifier and content and returns
a message result. Required OAuth scopes, installation, membership, and DM rules
limit reach. Posting as a customized user identity is especially sensitive and
Slack requires explicit permission and an inciting user action.

Classification: approved workspace API route is `AUTONOMOUS_VERIFIED`; web/UI
automation is unnecessary and should remain `MANUAL`/deferred.

### Microsoft Teams

Microsoft Graph can create a message in an identified work/school chat or
channel and returns `201 Created`. Delegated personal Microsoft accounts are not
supported for this operation, and application permission is limited to
migration rather than ordinary sends.

Classification: work/school delegated Graph is `AUTONOMOUS_VERIFIED`; personal
Teams is `UNSUPPORTED`; browser/desktop UI automation is deferred.

### iOS messaging

Apple's Message UI controller can prefill recipients and a body, but the user
may edit or cancel. Its delegate reports the compose result, while Apple
explicitly states that the interface does not guarantee delivery. This is a
documented human boundary, unlike an unverified generic share Intent.

Classification: `HUMAN_HANDOFF`, recipient/message not enforced, completion not
delivery-verifiable, iOS device required.

## 4. Privacy and security conclusions

- OAuth/provider credentials remain in the Credential Broker and are scoped to
  the minimum send permission; never expose tokens to plans, prompts, logs, or
  device payloads.
- Provider acceptance, device send result, delivery, and read are distinct
  facts and need distinct statuses.
- Browser sessions expose conversation history, cookies, contacts, and account
  control. No messaging browser executor should be added without a dedicated
  untrusted-content, session-isolation, consent, and policy review.
- Contact IDs are environment-specific. A phone contact, Slack user, Teams
  member, LINE user, and WhatsApp business recipient must never be silently
  treated as the same executable identity.
- Share/deep-link routes default to `UNSUPPORTED` until the resolved component,
  target/payload mutability, return behavior, and version drift are certified.
- No route may silently fall back to another channel; fallback requires a new
  route decision and approval.

## 5. Execution Planner implications

The planner needs an environment-qualified capability record rather than a
channel-only adapter:

```text
MessagingCapability {
  channel
  environment
  route
  executionMode
  recipientEnforced
  messageEnforced
  completionVerifiable
  requiresHumanCompletion
  officialApiAvailable
  deviceLocalRequired
  browserSessionPossible
  platformRestrictions
  distributionPolicyRisk
  personalUserApplicability
  certificationState
}
```

Resolution must reject routes whose certification state or environment does not
match the current device/account. `ACTION_SEND` resolution alone is never
capability evidence. Approval payloads must freeze environment and route in
addition to channel, recipient and message. Changing any of them requires a new
approval.

## 6. Priorities

### Worth implementing or strengthening for the hackathon

1. **Gmail API** — retain and demonstrate the existing real approval-gated
   route; clearly label provider acceptance rather than delivery/read.
2. **Slack Web API** — retain/strengthen the existing integration with exact
   channel/DM identity, approval payload freeze, API result and audit evidence.
3. **Execution Planner environment metadata** — design next so already-real
   SMS, Gmail and Slack routes are selected truthfully across execution planes.

### Defer

- WhatsApp Business Cloud API until an explicitly business-scoped product case,
  onboarding, opt-in and template policy are accepted.
- RCS for Business because it is a brand/carrier program, not personal RCS.
- LINE Official Account for the same business/bot applicability reason.
- Teams until work/school tenant consent and identity mapping are in scope.
- All consumer-app browser automation and uncertified share/deep-link routes.
- iOS Message UI until an iOS companion milestone exists.

## 7. KakaoTalk decision

The current KakaoTalk adapter must remain unavailable on the certified
configuration. The `MemoChatConnectActivity` block is permanent unless a future
review replaces it with a documented, certified public route. Unknown resolved
components must not be promoted through heuristic success; they require a new
certification and explicit allowlist decision. No private/undocumented activity,
version-specific bypass, Accessibility Service, SMS fallback, or self-chat
cleanup is authorized.

Certified product statement:

```text
SMS: NAgex can execute and verify.
KakaoTalk: NAgex discovered that the available route could not preserve the
approved recipient boundary, so it refused to execute.
```

## 8. Proposed next milestone

**R23.6M-D3R — Execution-Plane Messaging Contract Review**

Review and approve the environment-qualified capability schema, provider
acceptance versus delivery status vocabulary, identity binding rules, and the
candidate scope limited to the already-real SMS, Gmail and Slack routes. No new
adapter implementation should begin before that review.

## 9. Primary evidence

- [Meta WhatsApp Cloud API documentation](https://developers.facebook.com/docs/whatsapp/cloud-api/)
- [Google RCS for Business launch and verification](https://developers.google.com/business-communications/rcs-business-messaging/guides/launch)
- [Android Telephony/default SMS application contract](https://developer.android.com/reference/android/provider/Telephony)
- [LINE Messaging API send methods](https://developers.line.biz/en/docs/messaging-api/sending-messages/)
- [Gmail API send methods](https://developers.google.com/workspace/gmail/api/guides/sending)
- [Slack `chat.postMessage`](https://api.slack.com/methods/chat.postMessage)
- [Microsoft Graph send chat message](https://learn.microsoft.com/en-us/graph/api/chatmessage-post?view=graph-rest-1.0)
- [Apple `MFMessageComposeViewController`](https://developer.apple.com/documentation/messageui/mfmessagecomposeviewcontroller)
- [D2B physical certification report](evidence/R23_6M_D2B_KakaoTalk_Handoff_Certification_Report_20260928.md)

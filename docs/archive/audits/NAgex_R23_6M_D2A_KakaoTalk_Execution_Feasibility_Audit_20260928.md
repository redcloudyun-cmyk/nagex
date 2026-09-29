# R23.6M-D2A — KakaoTalk Execution Feasibility Audit

Date: 2026-09-28
Status: **AUDIT COMPLETE — REVIEW REQUIRED; NO D2 RUNTIME CODE AUTHORIZED**

## Executive decision

KakaoTalk remains an execution adapter behind the canonical
`COMMUNICATION / SEND_MESSAGE` capability. It is not a core capability and
no KakaoTalk-specific field belongs in `SendMessageAction`.

The official KakaoTalk Message API is real, but it does **not** provide a
general replacement for sending an arbitrary personal 1:1 KakaoTalk message
to any contact. Friend sends are limited to KakaoTalk friends who use the
same service, require Kakao Login, `friends` and `talk_message` consent,
recipient UUID acquisition through the friends API or picker, additional
permission, templates, and quotas. Kakao also states that the user selects
the friend and sends the message; a service cannot use this API to
automatically message users.

Therefore the recommended D2 route policy is:

```text
1. KAKAOTALK_OFFICIAL_API
   only when the recipient is an eligible same-service Kakao user and all
   Kakao permissions, consent, UUID, template, and quota requirements hold

2. KAKAOTALK_SHARE
   user-mediated Kakao share/picker for eligible share content; the user
   selects the final recipient/chat and performs the final send

3. KAKAOTALK_UI_AUTOMATION
   NO-GO for the consumer Play-distributed NAgex path

4. MANUAL_FALLBACK
   open a user-visible handoff with the approved message available for
   explicit user completion; never claim SENT_CONFIRMED automatically
```

This preserves the required priority in substance: supported official API
first, supported app/share handoff second, controlled UI automation only if
policy-safe (the audit finds it is not), then manual fallback.

## 1. Official KakaoTalk APIs

Kakao provides two distinct official families:

- **KakaoTalk Message API:** REST/SDK sends to self or eligible friends.
- **KakaoTalk Share:** launches KakaoTalk's target picker and requires the
  user to select a friend/chatroom and send.

The Message API is the only candidate for a machine-observable API response,
but its eligibility boundary is narrow. Share is safer and broader as a
user-mediated handoff, but is not silent execution.

Sources: [KakaoTalk Message REST API](https://developers.kakao.com/docs/en/kakaotalk-message/rest-api),
[KakaoTalk Share concepts](https://developers.kakao.com/docs/en/kakaotalk-share/common).

## 2. Arbitrary personal 1:1 send

**Not officially supported as a general-purpose capability.** The official
friend-message flow is restricted to friends within the same service. It
requires the recipient's Kakao UUID, Kakao Login and consent, additional
feature permission, and a direct user recipient-selection flow. It cannot
resolve an arbitrary Android contact or arbitrary Kakao friend name into a
sendable recipient.

Source: [Kakao tutorial — messages between service users](https://developers.kakao.com/docs/en/tutorial/message).

## 3–4. Deep links, app links, and intents

No official Kakao documentation found a deep link or Android intent that
accepts an arbitrary Kakao recipient plus free-form message and truthfully
returns a completed-send result. Kakao custom URL schemes documented for
message templates open links *from received Kakao messages*; they are not a
general compose/send API.

Android `ACTION_SEND`/Sharesheet can hand content to another app and let the
user choose a target. It does not guarantee a particular Kakao recipient,
does not prove the user pressed send, and cannot truthfully produce
`SENT_CONFIRMED`. Android 11+ package visibility also affects package
inspection and must be tested with explicit visibility declarations when
needed.

Sources: [Android Intent reference](https://developer.android.com/reference/android/content/Intent),
[Android package visibility](https://developer.android.com/training/package-visibility/automatic).

## 5. AccessibilityService UI automation

Technically, an AccessibilityService could inspect KakaoTalk UI nodes and
perform deterministic clicks/text entry on some versions. This is not a
stable or acceptable primary route for NAgex:

- Google Play says general assistants are not accessibility tools.
- Automation must have a narrow, clearly understood purpose.
- Autonomous initiation, planning, and execution through Accessibility is
  prohibited for non-accessibility tools.
- Declaration, prominent disclosure, affirmative consent, and review are
  required.

Because NAgex is a general Personal AI, the consumer Play-distributed route
is **NO-GO**. A future enterprise/private-distribution experiment would
still require separate legal/policy review and could not bypass approval.

Source: [Google Play AccessibilityService policy](https://support.google.com/googleplay/android-developer/answer/10964491?hl=en).

## 6–7. Android/OEM and Kakao UI fragility

Any UI automation would depend on KakaoTalk view hierarchy, text labels,
localization, screen density, font scaling, OEM accessibility behavior,
foldable/window state, keyboard, permissions, login prompts, ads/notices,
and KakaoTalk releases. A version change can redirect a click to the wrong
recipient or fail after message entry. This makes exact recipient and
message verification unreliable without a final human checkpoint.

Official APIs avoid most OEM/UI fragility. Share/manual handoff inherits UI
variation but keeps the user in control and must be reported as
`NEEDS_HUMAN`, not successful execution.

## 8–10. Account, recipient, and exact-message verification

### Official Message API

- Requires Kakao Login and access token.
- Requires `friends` and `talk_message` consent and additional permission.
- Recipient identity is a Kakao UUID obtained from the official friends
  list/picker, not a phone contact or display-name guess.
- Message content is constrained by Kakao template rules.
- The exact channel, route, recipient UUID reference, rendered template ID
  and arguments must be frozen in the approval payload.

### Share/manual paths

- KakaoTalk must be installed and logged in.
- The user chooses the final recipient/chatroom in KakaoTalk.
- NAgex cannot independently bind that final in-app selection to the
  pre-approved recipient unless Kakao supplies a verified callback.
- Consequently these paths must stop at `NEEDS_HUMAN`/`HANDED_OFF` unless a
  documented Kakao webhook or API result proves the exact send.

Display-name matching alone must never become executable recipient identity.

## 11–12. Accessibility/privacy and Play policy

Accessibility can expose conversation titles, message content, contacts,
notifications, and unrelated screen data. That is sensitive cross-app data
and conflicts with least privilege. NAgex would need prominent in-app
disclosure, affirmative consent, accurate Data Safety declarations,
retention limits, redaction, and strict on-device processing even for a
policy-permitted experiment. The current audit recommendation is to avoid
this access entirely.

## 13. Failure detection and truthful result semantics

Suggested adapter result taxonomy:

```text
SENT_CONFIRMED       official API names exact receiver UUID as successful
PARTIAL_SUCCESS      multi-recipient API returns both success and failure
FAILED               official API reports definitive failure
NEEDS_HUMAN          picker/share/manual completion required
STATUS_UNKNOWN       handoff occurred but final send cannot be proven
BLOCKED              policy, consent, permission, login, or approval failed
UNAVAILABLE          KakaoTalk/route unavailable
```

Opening KakaoTalk, populating a composer, or receiving Android activity
success is never `SENT_CONFIRMED`. Kakao Message API responses can identify
successful receiver UUIDs and per-recipient failures; Kakao Share success
must only be asserted from its documented webhook, not from app launch.

## 14. Manual fallback design

Manual fallback must:

1. show recipient, channel, message and route before handoff;
2. require approval for the exact frozen payload;
3. copy/share only the approved message;
4. make the user select/verify the Kakao recipient and press send;
5. return `NEEDS_HUMAN` or `STATUS_UNKNOWN`, never fake success;
6. store no Kakao credentials and scrape no conversations;
7. never silently fall back to SMS or another channel.

## 15. `MessagingExecutionAdapter` fit

The D1 interface fits channel selection and capability checks, but D2 design
must add no Kakao fields to `SendMessageAction`. Kakao-specific OAuth token,
receiver UUID, template, quota, app-installed state, and picker/webhook
metadata belong behind a Kakao adapter and provider-specific stores.

Before implementation, a generic extension may be needed for truthful
multi-stage outcomes (`NEEDS_HUMAN`, `STATUS_UNKNOWN`, `PARTIAL_SUCCESS`) and
for route-specific approval binding. That extension must be designed as a
generic messaging concept, not as Kakao leakage.

## Security invariants

```text
VOICE_CAN_BYPASS_APPROVAL = 0
WAKE_WORD_CAN_BYPASS_APPROVAL = 0
UNAPPROVED_SEND = 0
AMBIGUOUS_CONTACT_AUTO_EXECUTE = 0
MESSAGE_PAYLOAD_DRIFT_ALLOWED = 0
LLM_CAN_DIRECTLY_CONTROL_DEVICE = 0
SILENT_CHANNEL_FALLBACK = 0
FAKE_SENT_CONFIRMED = 0
```

Every selected route must be present in the approval payload. A route,
recipient, message, template, or channel change after approval requires a
new approval.

## Go/no-go recommendation

- **Official Message API adapter:** CONDITIONAL GO for same-service eligible
  users only, after Kakao permission/consent feasibility is proven with a
  developer app and test accounts.
- **KakaoTalk Share adapter:** CONDITIONAL GO as a user-mediated
  `NEEDS_HUMAN` route, not autonomous send.
- **Generic Android share/manual fallback:** GO for a narrowly described
  handoff prototype with truthful non-terminal status.
- **AccessibilityService UI automation:** NO-GO for the consumer/Play path.
- **Arbitrary personal 1:1 KakaoTalk automation:** NO-GO with currently
  documented official APIs.

No D2 runtime implementation should start until this audit and the chosen
product scope are reviewed.

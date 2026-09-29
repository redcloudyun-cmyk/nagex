# R23.6M-D1 — Global Messaging Abstraction — Closure Report

Date: 2026-09-28
Implementation commit: `141489db8a5ded6d83ed88d785c29d2ddf3ee661`
Final status: **CLOSED**

## Governing specification

`docs/NAgex_R23_6M_Mobile_Voice_Action_MVP_and_Roadmap_20260927.md`,
Sections 17.4–17.6.

## Physical positive smoke

Device: Samsung SM-F731N with a real SIM and an operator-controlled test
recipient.

The server was restarted from the D1 build before the accepted smoke. One
new run was then created through the production HTTP route and completed
through the existing approval and signed device-agent transport path.

| Evidence | Value |
|---|---|
| runId | `mmr_8a5706ffcc7448ab` |
| approvalId | `apr_a617306b3ce5fa86` |
| executionId | `exe_9a058015dc761644` |
| selected adapter | `SmsMessagingAdapter` |
| resolved channel | `SMS` |
| resolved route | `ANDROID_SMS_MANAGER` |
| final run status | `SENT_CONFIRMED` |
| approval status | `CONSUMED` |
| registry contents | SMS only |

The approval canonical payload remained exactly:

```text
recipientRef
channel
message
deviceId
executionRoute
```

The approval and run carried the same executionId. The device UI reported
the message as sent, and the server persisted the device-reported
`SENT_CONFIRMED` result. No fallback occurred. The Phase C executable run
shape and state machine remained unchanged.

## Unsupported-channel negative check

A production request with `preferredChannel=KAKAOTALK` returned HTTP 400
with `MESSAGING_CHANNEL_UNSUPPORTED` because no KakaoTalk adapter is
registered. Run count did not change and zero SMS was sent. No KakaoTalk
execution was attempted.

## Stale-process correction

Before the accepted smoke, the previously running server process was found
to be a stale pre-D1 build. Two operator-approved SMS sends made against
that stale process were therefore not counted as D1 evidence. A negative
request against that stale process created one SMS draft, but it was never
approved or executed and caused zero send. The server was then restarted
from the D1 build, the negative check passed fail-closed, and the single
accepted positive smoke above was run. No runtime code change was required.

## Verification

- D1 automated contract tests: 4/4 pass.
- R23.6M scoped certification: 116/116 pass.
- Full regression: 1597 pass, 4 skipped, 0 fail.
- Physical positive smoke: pass.
- Explicit unsupported-channel negative check: pass.
- Runtime code changed during physical closure: no.

**R23.6M-D1 is CLOSED. D2 runtime implementation remains prohibited until
the R23.6M-D2A KakaoTalk Execution Feasibility Audit is reviewed.**

# R23.6M-D2B — KakaoTalk Human Handoff — Certification Report

Date: 2026-09-28
Implementation commits: `94b7ace`, `0f33b24`
Final status: **FAIL-CLOSED IMPLEMENTED; POSITIVE DEVICE CERTIFICATION BLOCKED**

## Governing specifications

- `docs/NAgex_R23_6M_Mobile_Voice_Action_MVP_and_Roadmap_20260927.md`
- `docs/NAgex_R23_6M_D2A_KakaoTalk_Execution_Feasibility_Audit_20260928.md`
- Approved D2B correction directive dated 2026-09-28

## Implemented contract

- Generic `MessagingHandoffRun` and `MessagingHandoffService`.
- Explicit `KAKAOTALK_SHARE` route using package-scoped `ACTION_SEND` and
  `Intent.EXTRA_TEXT`.
- Approval binds intended recipient reference, channel, exact message, device,
  and route.
- Route metadata truthfully states that recipient and message are not enforced
  after handoff, completion is not verifiable, and a human must complete it.
- Share execution can never create `SENT` or `SENT_CONFIRMED`.
- No Accessibility automation and no silent SMS fallback.
- Audit events include the intended recipient and enforcement limits, but not
  raw message content.

## Physical-device result

Device: Samsung SM-F731N
KakaoTalk: 26.8.2
Resolved component: `com.kakao.talk/.activity.MemoChatConnectActivity`

The initial package-scoped `ACTION_SEND text/plain` attempt did not open a
recipient-selection share surface. KakaoTalk routed the approved text directly
to the user's own chat and returned to NAgex. This violated the D2B assumptions:
the intended recipient was not selected, and no separate human completion step
remained. The resulting self-chat message is external user data and was not
deleted by the coding agent.

The implementation was corrected to reject `MemoChatConnectActivity` before
launching it. A repeat physical run produced:

| Evidence | Value |
|---|---|
| runId | `mhr_94940a4769b639b9` |
| approvalId | `apr_73005708ffc27cf3` |
| executionId | `exe_9673f8069bac3891` |
| channel | `KAKAOTALK` |
| route | `KAKAOTALK_SHARE` |
| final status | `UNAVAILABLE` |
| failure reason | `KAKAOTALK_SHARE_UNAVAILABLE` |
| SMS fallback | none |
| UI result | `KakaoTalk handoff is unavailable. No SMS was sent.` |

The latest SMS run remained unchanged from 15:57:23 KST; the fail-closed
KakaoTalk attempt created no SMS run.

## Verification

- D2B automated tests: 7/7 pass.
- TypeScript build: pass.
- Android `assembleDebug`: pass.
- Full regression after final safety correction: 1604 pass, 4 skipped,
  0 fail.
- Physical unsafe-route detection and fail-closed retry: pass.
- Positive KakaoTalk human-handoff certification: **not achieved**.

## Decision

D2B must not be represented as a working KakaoTalk send or working manual
recipient handoff on the certified device/version. The safe implementation is
retained because it enforces approval, records truthful limits, and fails closed
for the observed unsafe component.

R23.6M-D2B remains **BLOCKED FOR POSITIVE CERTIFICATION** until a documented,
supported KakaoTalk route produces a real recipient-selection/manual-completion
surface without Accessibility automation, silent fallback, or false completion
claims. D3 must not begin under the current directive.

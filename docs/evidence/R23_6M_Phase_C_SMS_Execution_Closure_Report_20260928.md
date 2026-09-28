# R23.6M Phase C — Real SMS Execution — Closure Report

**Status:** CLOSED
**Date:** 2026-09-28
**Branch:** `r23.6m-mobile-voice-action`
**Commits certified:** `f47fc7e` (server), `a1ccbe9` (docs/roadmap), `85b1722` (Android UI + hardening tests)
**This report is a documentation/evidence artifact only — it introduces no runtime code changes.**

---

## 1. Architecture recap

Voice → contact resolution (Phase B3) → immutable SMS draft → human approval
(`ActionApprovalStore`, reused unchanged) → signed device-agent command
(`MOBILE_MESSAGE_PREPARE` / `MOBILE_MESSAGE_EXECUTE` / `MOBILE_MESSAGE_STATUS`,
real Ed25519) → device-local phone-number resolution (`PhoneNumberResolver`)
→ real `SmsManager` send (multipart-safe) → truthful
SENT/DELIVERED/FAILED/UNKNOWN report → audit.

## 2. Server files changed

`mobile-message.types.ts`, `mobile-message-run.state.ts`,
`mobile-message-run.store.ts`, `mobile-message-run.service.ts`,
`mobile-message.routes.ts`, `device-agent-protocol.ts` +
`device-agent-transport-endpoint.service.ts`, `create-nagex-application.ts`
wiring. (Commit `f47fc7e`)

## 3. Android files changed

`MessageComposeActivity`, `SmsSendExecutor` (multipart), `PhoneNumberResolver`,
`RecipientLocalCache`, `DeviceAgentPayload` mobile-message builders,
`NagexApiClient`, manifest (`SEND_SMS` + `telephony required="false"`).
(Commit `85b1722`)

## 4. SMS command schema

`MOBILE_MESSAGE_PREPARE {runId}` → `MOBILE_MESSAGE_EXECUTE {runId}` →
`MOBILE_MESSAGE_STATUS {runId, result}` / `{runId, deliveryConfirmed: true}`.
No generic device-automation commands were added.

## 5. Approval binding

Hash over `{recipientRef, channel, message, deviceId, executionRoute}` via the
unchanged `ActionApprovalStore`. Confirmed live on the real device: **message
drift** and **recipient drift** were both independently detected at
`executeApproved()`, each minted a fresh approval and returned HTTP 409, each
left `executionId: null`.

## 6. recipientRef → local number design

The server never holds a phone number. `RecipientLocalCache` (device-only)
maps `recipientRef → local androidContactId`; `PhoneNumberResolver` is the
sole class that ever reads a real number, only for the immediate
`SmsManager` call.

## 7. Duplicate-send protection

Layer 1: state graph — `SEND_ATTEMPTED` has no legal self-transition (see
§8's exact transition table). Layer 2: `ActionApprovalStore`'s one-time
`CONSUMED` status.

**Physical reproduction of Scenario E (duplicate execute): N/A.** A second
genuine signed `MOBILE_MESSAGE_EXECUTE` cannot be produced without either
(a) the physical device signing a second request through the app's own,
single-shot UI flow — which the app's design does not expose, precisely
because duplicate execution is the thing being prevented — or (b) manually
extracting the device's stored private key material and forging a second
signature from the host. Regarding (b): see §17 for the exact, verified
key-storage properties. The key is **software-generated and not hardware- or
StrongBox-backed**, so extraction is not prevented by a hardware security
boundary — but deliberately extracting a device's private key to forge a
duplicate signed request is itself an attacker-emulation action outside the
scope of an end-to-end functional certification pass, not something this
session attempted. Duplicate-execute protection was therefore certified via:

- the duplicate-execute automated test (`r23_6m_phase_c_sms_execution.test.ts`,
  test 6),
- the real-Ed25519-signed device-transport tests
  (`r23_6m_phase_c_device_transport.test.ts`),
- one-time approval consumption (`ActionApprovalStore`),
- the `SEND_ATTEMPTED`-has-no-self-transition state-graph invariant (§8).

All of these exercise the identical `executeApproved()` code path a real
device call goes through; the only variable not covered by physical
certification is which private key signs the request, and that key never
influences which server code executes.

## 8. Send/delivery state machine (verified against source, not summarized)

**`MobileMessageRunStatus`** (`src/mobile/mobile-message.types.ts`) — the
complete, exact enum:

```
DRAFT_CREATED | APPROVAL_REQUIRED | APPROVED | SEND_ATTEMPTED |
SENT_CONFIRMED | DELIVERY_CONFIRMED | FAILED | BLOCKED
```

**Legal transition graph** (`src/mobile/mobile-message-run.state.ts`,
`LEGAL_TRANSITIONS`), reproduced exactly:

```
DRAFT_CREATED      -> APPROVAL_REQUIRED, BLOCKED
APPROVAL_REQUIRED  -> APPROVED, BLOCKED
APPROVED           -> SEND_ATTEMPTED, APPROVAL_REQUIRED   (back-edge: payload drift)
SEND_ATTEMPTED     -> SENT_CONFIRMED, FAILED               (no self-transition — Layer 1 duplicate-send guard)
SENT_CONFIRMED     -> DELIVERY_CONFIRMED
DELIVERY_CONFIRMED -> (terminal)
FAILED             -> (terminal)
BLOCKED            -> (terminal)
```

**`SEND_STATUS_UNKNOWN` is not a run status.** It is a value of two separate,
narrower types:

- `MobileMessageSendResult` (`'SENT_CONFIRMED' | 'SEND_FAILED' | 'SEND_STATUS_UNKNOWN'`)
  — the device's self-reported outcome of calling `SmsManager`.
- `MobileMessageFailureReason` — includes `'SEND_STATUS_UNKNOWN'` as a
  declared enum value, but the current `reportSendResult()` implementation
  never actually writes it into `failureReason`.

The real behavior, verified directly against `reportSendResult()`
(`mobile-message-run.service.ts`): when the device reports
`SEND_STATUS_UNKNOWN`, the run record is **re-saved unchanged** — it stays at
`SEND_ATTEMPTED` indefinitely, `failureReason` is left as it was (`null`),
and only an audit event (`sms.send_status_unknown`) is recorded. This is
deliberate: the run is never guessed into `SENT_CONFIRMED` or `FAILED`, and
no automatic retry ever occurs (an automatic retry against a genuinely
ambiguous crash-window outcome would risk a real duplicate SMS). Only a
device report of `SEND_FAILED` actually transitions the run, to `FAILED`
with `failureReason: 'SEND_FAILED'`.

Verified live during certification: real `SENT_CONFIRMED` (Scenario A, plus
two additional user-approved real sends during certification — see §11 and
§18), real `BLOCKED` with `failureReason: 'APPROVAL_REJECTED'` (Scenario B)
and with a fresh-approval-minted drift rejection surfaced to the device as
HTTP 409 before any run-status field was corrupted (Scenarios C, D — the run
returned to `APPROVAL_REQUIRED`, exactly the `APPROVED -> APPROVAL_REQUIRED`
back-edge in the table above, with a new `approvalId`).

## 9. Android tests

Full suite green under `./gradlew clean assembleDebug test lint --no-daemon`
→ **BUILD SUCCESSFUL** (includes `PhoneNumberResolverTest`,
`SendSmsPermissionTest`, `MobileMessagePhoneNumberAbsenceTest`, all Phase B/C
Robolectric coverage).

## 10. Server tests

`npm run build` clean. Scopes: `r23-6m-mobile-voice-action` 112/112,
`architecture` 103/103, `permission-approval-hardening` 147/147,
`credential-broker` 173/173. Full `npm test`: **1593/1597 pass, 4 skipped,
0 fail.**

## 11. Physical-device SMS evidence

Device: Samsung SM-F731N, real SIM, real recipient contact under the
operator's control.

| Scenario | Result | Evidence |
|---|---|---|
| **A** Successful real SMS | **PASS** | `mmr_615d93ab7f15400d` → `SENT_CONFIRMED`; approval `apr_440bef4717dc6794` → `CONSUMED`; exact message delivered; independently confirmed in the operator's Messages app |
| **B** Approval rejection | **PASS** | `mmr_fec7a08e6668289f` → `BLOCKED` / `failureReason: APPROVAL_REJECTED`, `executionId: null`; confirmed zero SMS |
| **C** Message drift after approval | **PASS** | Drifted via real-time PATCH while `APPROVED`; device's real signed EXECUTE rejected HTTP 409 (`MOBILE_MESSAGE_PAYLOAD_DRIFT`), fresh approval minted, run returned to `APPROVAL_REQUIRED`, `executionId: null`; confirmed zero SMS |
| **D** Recipient drift after approval | **PASS** | Same mechanism, `recipientRef` drifted server-side while `APPROVED`; real signed EXECUTE rejected HTTP 409, `executionId: null`; confirmed zero SMS |
| **E** Duplicate execute | **N/A (accepted)** | See §7 |
| **F** SEND_SMS denied | **PASS** | Permission revoked via adb, real system deny; app never called `proceedToExecution()`; run stayed `APPROVED`, `executionId: null`; confirmed zero SMS |
| **G** Revoked device | **PASS** | Real device identity set to `REVOKED` server-side; real Ed25519-signed CHECK CONNECTION rejected HTTP 403; device could not reach even `CONNECT`/`STATUS`, let alone a message command |
| **H** Invalid/missing recipientRef | **PASS** | Real session + real enrolled `deviceId`; invalid `recipientRef` → HTTP 400 `MOBILE_MESSAGE_RECIPIENT_INVALID`; missing → HTTP 400 `MOBILE_MESSAGE_FIELDS_REQUIRED`; no run was ever created in either case |
| **I** Multiple numbers → clarification | **PASS (unplanned, naturally occurring)** | The real test contact genuinely had 2 saved phone numbers; the device's real `Ambiguous` picker appeared; zero SMS until a number was explicitly chosen — this was never silently auto-picked. Surfaced during Scenario D setup, not scripted in advance |

## 12. Reject/drift/duplicate/permission/revocation evidence

All captured in §11 with real run/approval/execution IDs pulled directly
from server-side storage (`~/.local/share/nagex/mobile-message-runs/`,
`~/.local/share/nagex/approvals/`, `~/.local/share/nagex/device-identities/`),
cross-checked against on-device UI state and the operator's independent
confirmation of zero unintended sends after each scenario.

## 13. Privacy/leakage verification

`grep -rniE "phoneNumber|phone_number|msisdn"` across all Phase C server
source: zero matches. No phone number appeared in any approval payload, run
record, audit entry, or device-agent command observed during live testing.

## 14. git status --short

Clean except pre-existing unrelated `artifacts/*.png` regeneration noise and
untracked, unrelated docs files — neither touched by this certification pass.

## 15. Commit SHA(s)

`f47fc7e`, `a1ccbe9`, `85b1722` — all pre-existing. Physical certification
itself required no runtime code changes; this report and its companion
evidence file are the only new commit produced by the certification pass
(see the top of this document for that SHA once committed).

## 16. Remaining risks / known debt

- **`VOICE_TTS_NATURALNESS`** — unchanged, disclosed since Phase B.
- **No in-app login** — session token is still entered manually on the
  Status screen; a real mobile login/pairing flow remains a Phase C+
  improvement, not implemented.
- **`SpokenNameExtractor` heuristic** — confirmed live during this
  certification: STT space-insertion (e.g. "조민형 대표" vs. the saved
  "조민형대표") produced two real `NOT_FOUND` misfires during testing. This
  is the already-disclosed Phase B limitation working exactly as documented,
  not a new defect.

## 17. Android device private-key storage — verified properties

Source: `mobile-android/app/src/main/java/com/nagex/mobile/DeviceKeyManager.kt`.

- **Generated on-device:** yes — `ensureKeyPairExists()` generates the
  keypair the first time the app runs, via
  `KeyPairGenerator.getInstance("Ed25519")`.
- **AndroidKeyStore-generated:** **no.** The generator uses the standard JCA
  default provider (`"Ed25519"`), not the `"AndroidKeyStore"` provider. The
  key material is an ordinary in-memory `KeyPair`, not an
  AndroidKeyStore-resident key handle.
- **Hardware-backed:** **no.** There is no Trusted Execution
  Environment/Secure Element involvement in generating, holding, or using
  this key.
- **StrongBox-backed:** **no.** StrongBox is not requested or used anywhere
  in this class or its callers.
- **At-rest storage:** the raw PKCS8-encoded private key bytes are
  Base64-encoded and stored as a string value inside Jetpack Security's
  `EncryptedSharedPreferences` (`AES256_SIV` key encryption, `AES256_GCM`
  value encryption), whose own wrapping `MasterKey`
  (`MasterKey.KeyScheme.AES256_GCM`) **is** AndroidKeystore-backed. This
  protects the on-disk ciphertext against extraction from an unrooted
  filesystem read or a plain backup — it does **not** make the Ed25519
  private key itself hardware-isolated.
- **Exportability, precisely stated:** on every sign operation
  (`signEnvelopeBytes()`), the app decrypts the stored bytes and
  reconstructs a full `PrivateKey` Java object
  (`KeyFactory.getInstance("Ed25519").generatePrivate(...)`) in ordinary
  application process memory. Nothing prevents that same process (or
  anything with equivalent access — root, a debugger attached to a
  debug-signed build, a full device backup with the encryption key) from
  reading the same bytes. The app itself exposes no API to export the key,
  but the key is **not architecturally non-exportable** the way a real
  AndroidKeyStore/StrongBox key would be (which never yields raw key
  material to any process, including the app's own). Any statement in an
  earlier draft of this report equating this key's software-backed storage
  with "non-exportable by hardware design" was inaccurate and is corrected
  here. This is disclosed, pre-existing Phase B debt
  (`DeviceKeyManager.kt`'s own header comment already calls this out as a
  known limitation), not something Phase C changed or newly discovered.

## 18. "Additional real sends" during certification — approval verification

Two real sends occurred during the certification session beyond the
scripted Scenario A run: `mmr_bc7af772b433f680` ("원본 메시지입니다") and a
second run ("테스트") reaching `SENT_CONFIRMED` shortly after. Both are
**user-approved real sends**, not autonomous or accidental sends, for a
structural reason rather than a self-report alone: `SENT_CONFIRMED` is only
reachable after `executeApproved()` consumes a real `ActionApprovalStore`
approval whose status is `APPROVED` — and the only code path that ever sets
an approval to `APPROVED` is the real `POST /api/v1/approvals/:id/approve`
route, which nothing in this server calls automatically. The only way that
route was invoked for either run was a physical tap on the device's own
`APPROVE` button, on a screen displaying the exact real recipient and
message text, by the person physically holding the phone. No code path in
this system can produce `SENT_CONFIRMED` without that tap. The operator
independently confirmed both sends by their own account. Both instances are
therefore reported as **"two additional user-approved real sends during
certification,"** not "spontaneous" sends — that earlier wording (used
during the live session before this reconciliation pass) was imprecise
about the mechanism, though it did not misstate whether approval occurred.

## 19. MANDATORY PHASE E BLOCKER (carried forward)

**`PLATFORM_HEADER_TRUST_GAP`** — the reused, unchanged
`POST /api/v1/approvals/:id/approve` and `.../reject` routes derive
`tenantId`/`principal` from composition-root/header-based resolution
(`x-nagex-tenant` / `x-principal-id`), not from a validated session — the
same pre-existing, disclosed, systemic gap Phase B4's audit found. Phase C
deliberately did not touch this route (it was reused exactly as Phase B/R23.6E
already used it), and every genuinely new Phase C route
(`/api/v1/mobile/messages/*`) is session-authenticated only, ignoring these
headers entirely.

**This must not be carried into Phase E ("Mobile Safety Certification")
unresolved.** Before Phase E can close: all mobile approval mutations
(approve/reject, and any future consequential mobile action) must derive
tenant/principal identity from a validated session
(`SessionStore.getSession()`), never from spoofable client headers. This
does not block Phase D (KakaoTalk), which — per the existing roadmap — does
not change this route either, but Phase D must not deepen reliance on the
header-trust path, and any new Phase D approval-adjacent route must be
session-authenticated from the start, following the pattern already
established in `mobile-message.routes.ts`.

## 20. Final status

**R23.6M Phase C = CLOSED.** Phase D (KakaoTalk) implementation may begin
after this documentation/evidence commit lands.

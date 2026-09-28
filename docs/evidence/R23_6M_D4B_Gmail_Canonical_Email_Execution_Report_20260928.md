# R23.6M-D4B — Gmail Canonical Email Execution Integration

Date: 2026-09-28
Status: **IMPLEMENTATION CLOSED / AUTOMATED CERTIFICATION PASS / REAL SEND CERTIFICATION PENDING**

## Governing specification

- `MASTER.md` Sections 5.5–5.6, 7–8, 14.5, and 14.13
- `docs/NAgex_R23_6M_D3R_Execution_Plane_Messaging_Contract_Review_20260928.md`
- accepted D4A audit and the D4B product-architecture decisions supplied for this milestone
- `docs/NAgex_R23.4V_Credential_Broker_Inject_Only_Vault_Development_Directive_20260926.md`

## Revision state

- BASE_SHA: `34fe0ea7083f4dac9cfb7fa969fd9182a864cd84`
- FINAL_SHA: recorded in the final closure handoff after the D4B-only commit

## D4B files changed

- `src/integrations/google/token.store.ts`
- `src/security/credentials/google-credential-access.service.ts`
- `src/modules/gmail/gmail.client.ts`
- `src/modules/gmail/gmail.service.ts`
- `src/messaging/send-email-action.types.ts`
- `src/messaging/gmail-canonical-mapping.ts`
- `src/messaging/gmail-email-execution-adapter.ts`
- `tests/r23_6m_d4b_gmail_canonical_email.test.ts`
- `tests/test-contract.registry.json`
- `tests/test-scope.registry.json`
- `docs/evidence/R23_6M_D4B_Gmail_Canonical_Email_Execution_Report_20260928.md`

## Canonical action and execution target

`SendEmailAction` is a separate action from `SendMessageAction` and contains:

```text
canonicalAction = SEND_EMAIL
tenantId / ownerId / requestId
providerAccountRef
displayIdentity?                 presentation only
to / cc? / bcc?
subject / body
attachments?                    reference metadata only
replyContext?                   threadId + replyToMessageId
```

The Gmail target is:

```text
channel          EMAIL
environment      SERVER
provider         GOOGLE
executionRoute   GMAIL_API
executionMode    AUTONOMOUS_VERIFIED
addressKind      EMAIL_ADDRESS
providerAccountRef = Google connection reference (`gacct_*`)
```

## Provider account identity

The Google token-store connection record now owns a non-secret stable
`providerAccountRef`. It survives ordinary access-token refresh and persistent
store restart. A replacement OAuth grant with a different refresh credential
rotates the reference. Gmail approval and execution bind this reference; a
changed reference fails closed with `REAPPROVAL_REQUIRED`.

The display `from` identity remains presentation/MIME input and is not the
approval authority.

## Integration seam

```text
SendEmailAction
  -> GmailEmailExecutionAdapter
  -> GmailService
  -> GoogleCapabilityExecutionPipeline
  -> GoogleCredentialAccessService / CredentialBrokerService
  -> existing sendGmailMessage
  -> Gmail messages.send
```

No second Gmail sender, OAuth subsystem, approval engine, execution store, or
audit path was introduced. `gmail.client.ts` only accepts approval-authority
metadata that is never serialized into MIME.

## Approval and legacy behavior

The frozen approval binds the executable Gmail payload plus:

- `canonicalAction=SEND_EMAIL`
- `providerAccountRef`
- `to`, `cc`, `bcc`, subject, body, and attachment references
- `SERVER`, `GOOGLE`, and `GMAIL_API`
- reply `threadId` and `replyToMessageId`

The canonical binding also exposes body and attachment digests for portable
contract comparison. Any material drift changes the existing approval payload
hash or fails the provider-account preflight. Legacy approvals that lack the
new authority fields cannot be upgraded during execution. They are rejected
before approval consumption or provider access with `REAPPROVAL_REQUIRED`.

Disconnected approval creation remains backward-compatible, but execution
still fails closed before provider mutation. A fresh connected approval is
required for canonical D4B execution.

## Result and evidence mapping

Only a real successful `messages.send` result containing a Gmail message ID is
mapped to:

```text
status: PROVIDER_ACCEPTED
evidence:
  - PROVIDER_API_RESPONSE / GOOGLE_GMAIL_API / synthetic=false
  - PROVIDER_MESSAGE_ID / GOOGLE_GMAIL_API / synthetic=false
```

It never implies `DELIVERY_CONFIRMED` or `READ_CONFIRMED`. `gmail.create_draft`
is not enriched with `SEND_EMAIL` authority and cannot enter this mapper.

## Security and truthfulness

- OAuth access/refresh tokens remain inside the existing inject-only boundary.
- Canonical action, target, approval metadata, result, and evidence contain no
  raw OAuth material.
- Synthetic evidence is rejected by `assertRuntimeMessagingEvidence`.
- Non-empty attachment execution is rejected as
  `ATTACHMENTS_UNSUPPORTED`; current MIME code does not upload bytes.
- Policy risk remains `HIGH` as a conservative capability declaration. The
  requested multi-factor risk composition is a separate policy-engine concern;
  this milestone does not assert that OAuth alone fixes a canonical risk level.

## Automated evidence

Focused Gmail/pipeline/D4B run:

```text
tests 56
pass 56
fail 0
```

Legacy approval closure test:

```text
legacy Gmail approval cannot execute under D4B binding and never reaches Gmail API
PASS — REAPPROVAL_REQUIRED, provider calls 0, approval remains APPROVED
```

Full deterministic regression (`npm test`):

```text
tests 1625
pass 1621
fail 0
skipped 4
exit code 0
```

`npm run build`: PASS.

## Real Gmail certification

```text
REAL_GMAIL_CERTIFICATION = PENDING
```

No authorized test account and recipient were supplied to this coding session.
No external email was sent and no delivery/read claim is made.

## Scope boundary

Slack, Teams, WhatsApp, and other providers were not implemented or modified.

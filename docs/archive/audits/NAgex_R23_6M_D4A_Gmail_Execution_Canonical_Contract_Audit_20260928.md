# R23.6M-D4A — Existing Gmail Execution → Canonical Execution Contract Audit

Date: 2026-09-28
Status: **AUDIT COMPLETE — ACCEPTED; NO RUNTIME CODE CHANGES AUTHORIZED**
Scope: Mapping existing Gmail runtime execution (`src/modules/gmail/`, `src/contracts/gmail.port.ts`, `src/capabilities/google-capability-execution-pipeline.ts`) to the Canonical Execution-Plane Messaging Contract (`src/messaging/`, `docs/NAgex_R23_6M_D3R_Execution_Plane_Messaging_Contract_Review_20260928.md`).

> Historical architecture note (2026-09-29): this accepted audit records the
> pre-implementation state. R23.6M-D4B subsequently closed the integration and
> supersedes the audit's provisional `SEND_MESSAGE`, display-identity account
> binding, and risk examples with the final `SEND_EMAIL`, stable
> `providerAccountRef`, and evidence-backed Gmail contracts.

---

## 1. Executive Audit Summary

The current NAgex Gmail implementation is a fully functioning, approval-gated, credential-broker protected execution path built on `GoogleCapabilityExecutionPipeline`. However, it currently outputs a generic `NormalizedMutationResult` (`status: 'SUCCEEDED'`) rather than the provider-neutral, evidence-backed Canonical Messaging Contract (`MessagingExecutionResult`).

This audit (Milestone **R23.6M-D4A**) establishes the explicit contract mapping between the existing Gmail pipeline and the canonical messaging execution plane defined in **D3R** and **D3S**, laying the exact design foundation for the future **D4B** adapter implementation without mutating runtime code.

---

## 2. Canonical Capability & Route Taxonomy

| Field | Existing Gmail Implementation State | Canonical Execution Contract Mapping (D3R/D3S) | Alignment & Invariant Rules |
|---|---|---|---|
| **Channel** | Implicit (`GMAIL` / Email) | `EMAIL` | Broadened canonical channel taxonomy |
| **Environment** | Node.js Backend Server | `SERVER` (with `EXTERNAL_API` provider plane) | Server-executed official API |
| **Provider** | `GOOGLE` | `GOOGLE` | Google Workspace / Gmail API |
| **ExecutionRoute** | `gmail.send_email`, `gmail.reply` | `GMAIL_API` | Direct Gmail REST API endpoint (`messages.send`) |
| **ExecutionMode** | `AUTONOMOUS_VERIFIED` | `AUTONOMOUS_VERIFIED` | Token injected via `GoogleCredentialAccessService` |
| **Policy Risk** | High (Email communication & OAuth) | `MEDIUM` | OAuth scoped & approval-gated mutation |
| **Availability Status** | Gated by OAuth Token presence | `AVAILABLE` / `NOT_CONFIGURED` | Truthfully reflects Google account connection state |

---

## 3. Target Binding & Identity Mapping

### 3.1 Existing Gmail Payload
In `src/modules/gmail/gmail.client.ts` and `gmail.service.ts`:
```ts
export interface GmailComposePayload {
  from: string; // "me" or connected account
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  attachments: GmailAttachmentMetadata[];
  threadId: string | null;
  replyToMessageId: string | null;
}
```

### 3.2 Canonical `ExecutionTarget` Mapping
```ts
const executionTarget: ExecutionTarget = {
  targetId: `target_gmail_${hash(payload.to.join(','))}`,
  tenantId: input.tenantId,
  ownerId: input.principalId,
  channel: 'EMAIL',
  environment: 'SERVER',
  provider: 'GOOGLE',
  addressKind: 'EMAIL_ADDRESS',
  addressRef: payload.to[0], // primary recipient email
  providerAccountRef: payload.from || 'me',
  displayLabel: payload.to.join(', ')
};
```

---

## 4. Status Semantics & Evidence Normalization

### 4.1 Current Result vs Canonical Result
Existing Gmail pipeline returns `NormalizedMutationResult`:
```ts
{
  executionId: "exec_...",
  toolId: "gmail.send_email",
  status: "SUCCEEDED",
  externalId: "18e3a2b4c5...", // Gmail Message ID
  externalUrl: "https://mail.google.com/mail/u/0/#inbox/...",
  startedAt: "2026-09-28T...",
  completedAt: "2026-09-28T..."
}
```

### 4.2 Canonical Status & Evidence Mapping
In the Canonical Messaging Contract (D3R Section 6 & 10):
- **Canonical Status:** `PROVIDER_ACCEPTED` (NOT `SUCCEEDED` or `DELIVERY_CONFIRMED`).
- **Evidence Array:**
  ```ts
  evidence: [
    {
      evidenceType: 'PROVIDER_MESSAGE_ID',
      evidenceSource: 'GOOGLE_GMAIL_API',
      observedAt: completedAt,
      synthetic: false,
      providerMessageId: result.externalId
    },
    {
      evidenceType: 'PROVIDER_API_RESPONSE',
      evidenceSource: 'GOOGLE_GMAIL_API',
      observedAt: completedAt,
      synthetic: false,
      providerStatus: '200_OK'
    }
  ]
  ```

### 4.3 Invariant Guarantees
1. **`PROVIDER_ACCEPTED != DELIVERY_CONFIRMED`**: `messages.send` API success proves the Google Gmail API accepted and created the message. It does **not** prove SMTP delivery to recipient MX host or recipient inbox arrival.
2. **No Read Evidence**: Gmail API does not provide read receipts for standard sends (`supportsReadEvidence: false`).
3. **`gmail.create_draft` Distinction**: Drafting an email (`GMAIL_CREATE_DRAFT_TOOL_ID`) is **not** a `SEND_MESSAGE` action. It is classified separately under draft capabilities and must never emit `SEND_MESSAGE` execution results.

---

## 5. Approval Binding & Security Policy

### 5.1 Approval Binding Alignment
All Gmail mutations flow through `GoogleCapabilityExecutionPipeline`:
- Hash verification (`ActionApprovalStore` + `ExecutionStore`).
- Token resolution fail-closed policy.

### 5.2 Canonical `MessagingApprovalBinding` Representation
```ts
const approvalBinding: MessagingApprovalBinding = {
  canonicalAction: 'SEND_MESSAGE',
  recipientRef: payload.to.join(','),
  message: payload.body,
  channel: 'EMAIL',
  environment: 'SERVER',
  provider: 'GOOGLE',
  executionRoute: 'GMAIL_API',
  providerAccountRef: payload.from
};
```
- **Reapproval Policy:** Any change in recipient email (`to`/`cc`/`bcc`), body/subject payload, or route (e.g., trying to re-route a failed Gmail send via SMS or personal mail client) invalidates the approval and requires `REAPPROVAL_REQUIRED`.

---

## 6. Adapter Architecture Plan for Milestone D4B

When D4B is authorized, a dedicated `GmailMessagingExecutionAdapter` will be created in `src/messaging/gmail-messaging-adapter.ts`:

1. **`describeCapability()`**: Returns `MessagingExecutionCapability` with `channel: 'EMAIL'`, `environment: 'SERVER'`, `provider: 'GOOGLE'`, `executionRoute: 'GMAIL_API'`, `executionMode: 'AUTONOMOUS_VERIFIED'`, `completionVerifiable: true`, `supportsDeliveryEvidence: false`, `supportsReadEvidence: false`.
2. **`prepare()`**: Validates `GmailComposePayload` structure and computes `ExecutionTarget`.
3. **`executeApproved()`**: Delegates to `GmailService.executeSendEmail()` / `executeReply()`, wrapping the result in a canonical `MessagingExecutionResult` with `status: 'PROVIDER_ACCEPTED'` and `evidenceType: 'PROVIDER_MESSAGE_ID'`.
4. **Registration:** Registered into `MessagingAdapterRegistry` alongside `SMS` without modifying existing SMS Phase C behavior.

---

## 7. Next Steps & Governance Compliance

- **Current State:** Milestone **R23.6M-D4A** audit is **COMPLETE**.
- **No Code Changes Made:** Zero runtime `.ts` files modified in D4A.
- **Allowed Next Stage:** Milestone **R23.6M-D4B** (Adapter implementation) pending user authorization.

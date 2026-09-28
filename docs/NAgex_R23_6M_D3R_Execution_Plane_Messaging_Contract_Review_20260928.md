# R23.6M-D3R — Execution-Plane Messaging Contract Review

Date: 2026-09-28
Status: **DESIGN COMPLETE — REVIEW REQUIRED; NO RUNTIME IMPLEMENTATION AUTHORIZED**
Scope: product architecture for **One Brain, Many Execution Planes**

## 1. Product requirement and boundaries

### Product requirement

NAgex needs provider-neutral messaging contracts that preserve exact approval,
execution authority, evidence strength, and truthful results across independent
server, browser, mobile, desktop, and provider executors.

### Hackathon requirement

The hackathon should demonstrate only a small set of real routes. The currently
justified reference routes are Android SMS, Gmail API, and Slack Web API. A demo
must never widen the production contract or claim evidence that a provider did
not return.

### Demo-only behavior

Static/mock results may test UI or offline code only when explicitly labeled.
They are never capability availability, execution evidence, certification, or
proof of external action.

The architecture is shared contracts plus separate provider/platform adapters,
not one universal executor containing provider conditionals.

## 2. Separation model

These dimensions are independent:

```text
CanonicalAction  SEND_MESSAGE
Channel          SMS | EMAIL | SLACK | TEAMS | KAKAOTALK | ...
Environment      SERVER | WEB | BROWSER | ANDROID | IOS | DESKTOP | EXTERNAL_API
Provider         ANDROID_TELEPHONY | GOOGLE | SLACK | MICROSOFT | KAKAO | ...
ExecutionRoute   ANDROID_SMS_MANAGER | GMAIL_API | SLACK_CHAT_POSTMESSAGE | ...
ExecutionMode    AUTONOMOUS_VERIFIED | HUMAN_HANDOFF | MANUAL | UNSUPPORTED
```

A channel does not imply an environment, provider, route, or authority. A
provider API route and a browser session for the same brand are different
capabilities and require separate certification and approval binding.

## 3. Canonical `MessagingExecutionCapability`

Conceptual TypeScript contract:

```ts
type ExecutionEnvironment =
  | 'SERVER' | 'WEB' | 'BROWSER' | 'ANDROID'
  | 'IOS' | 'DESKTOP' | 'EXTERNAL_API';

type MessagingExecutionMode =
  | 'AUTONOMOUS_VERIFIED'
  | 'HUMAN_HANDOFF'
  | 'MANUAL'
  | 'UNSUPPORTED';

type CapabilityAvailability =
  | 'AVAILABLE'
  | 'UNAVAILABLE'
  | 'DISABLED'
  | 'NOT_CONFIGURED'
  | 'NOT_CERTIFIED';

type PolicyRisk = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

interface MessagingExecutionCapability {
  capabilityId: string;
  channel: MessagingChannel;
  environment: ExecutionEnvironment;
  provider: string;
  executionRoute: string;
  executionMode: MessagingExecutionMode;

  recipientEnforced: boolean;
  messageEnforced: boolean;
  completionVerifiable: boolean;
  requiresHumanCompletion: boolean;

  officialApiAvailable: boolean;
  deviceLocalRequired: boolean;
  browserSessionRequired: boolean;
  authenticatedProviderRequired: boolean;

  supportsAutonomousExecution: boolean;
  supportsDeliveryEvidence: boolean;
  supportsReadEvidence: boolean;

  policyRisk: PolicyRisk;
  availabilityStatus: CapabilityAvailability;
  unavailableReason?: string;
  certificationId?: string;
}
```

Invariants:

- `UNSUPPORTED` can never be `AVAILABLE` or autonomously executed.
- `HUMAN_HANDOFF` always sets `requiresHumanCompletion=true`.
- `completionVerifiable` describes the strongest result the executor can
  observe, not delivery or read unless those evidence types exist.
- Availability is evaluated for the exact environment/account/device and is
  never inferred from an installed app, resolved Intent, or configured token
  alone.
- Unknown routes are `NOT_CERTIFIED` and fail closed.

## 4. Canonical `ExecutionTarget`

```ts
type TargetAddressKind =
  | 'OPAQUE_DEVICE_RECIPIENT_REF'
  | 'EMAIL_ADDRESS'
  | 'PROVIDER_USER_ID'
  | 'PROVIDER_CONVERSATION_ID'
  | 'PHONE_NUMBER_REF';

interface ExecutionTarget {
  targetId: string;
  tenantId: string;
  ownerId: string;
  channel: MessagingChannel;
  environment: ExecutionEnvironment;
  provider: string;
  addressKind: TargetAddressKind;
  addressRef: string;
  providerAccountRef?: string;
  workspaceRef?: string;
  deviceId?: string;
  displayLabel?: string; // presentation only, never execution identity
}
```

`addressRef` is the executable identity for its provider boundary. Cross-channel
identity linking may suggest targets but must never silently translate a phone
contact into an email, Slack user, Teams member, or other provider identity.
Provider account/workspace and device are part of target authority.

## 5. Canonical result and evidence model

```ts
type MessagingExecutionStatus =
  | 'ACTION_ACCEPTED'
  | 'EXECUTION_STARTED'
  | 'PROVIDER_ACCEPTED'
  | 'HANDOFF_STARTED'
  | 'NEEDS_HUMAN'
  | 'DELIVERY_CONFIRMED'
  | 'READ_CONFIRMED'
  | 'FAILED'
  | 'UNAVAILABLE'
  | 'UNKNOWN';

type MessagingEvidenceType =
  | 'DEVICE_SEND_CALLBACK'
  | 'PROVIDER_API_RESPONSE'
  | 'PROVIDER_MESSAGE_ID'
  | 'DELIVERY_RECEIPT'
  | 'READ_RECEIPT'
  | 'HUMAN_HANDOFF_ONLY'
  | 'NO_CONFIRMATION_AVAILABLE';

interface MessagingExecutionEvidence {
  evidenceType: MessagingEvidenceType;
  evidenceSource: string;
  observedAt: string;
  providerMessageId?: string;
  providerTimestamp?: string;
  providerStatus?: string;
  receiptId?: string;
}

interface MessagingExecutionResult {
  executionId: string;
  status: MessagingExecutionStatus;
  route: string;
  environment: ExecutionEnvironment;
  provider: string;
  channel: MessagingChannel;
  targetId: string;
  evidence: MessagingExecutionEvidence[];
  failureCode?: string;
  retryDisposition?: 'SAFE_RETRY' | 'REAPPROVAL_REQUIRED' | 'DO_NOT_RETRY';
  startedAt: string;
  updatedAt: string;
}
```

Evidence records contain provider identifiers and facts, never credentials or
raw sensitive message content.

## 6. Status semantics

| Status | What it proves | What it does not prove |
|---|---|---|
| `ACTION_ACCEPTED` | NAgex accepted a valid action into its governed flow | external execution |
| `EXECUTION_STARTED` | an executor began its attempt | provider acceptance or delivery |
| `PROVIDER_ACCEPTED` | an authenticated provider/device API accepted or created the message | recipient delivery, attention, or reading |
| `HANDOFF_STARTED` | a certified human handoff surface was entered | recipient selection, send, delivery, or read |
| `NEEDS_HUMAN` | external completion remains with the user | any completed send |
| `DELIVERY_CONFIRMED` | explicit delivery receipt/callback was observed | human reading |
| `READ_CONFIRMED` | explicit provider read evidence was observed | interpretation or response |
| `FAILED` | the attempt failed with a known failure | that nothing happened if provider outcome is ambiguous |
| `UNAVAILABLE` | the exact capability cannot be used in the current context | permanent global impossibility |
| `UNKNOWN` | the strongest truthful outcome is indeterminate | success or safe retry |

Critical invariants:

```text
PROVIDER_ACCEPTED != DELIVERY_CONFIRMED
DELIVERY_CONFIRMED != READ_CONFIRMED
HANDOFF_STARTED != PROVIDER_ACCEPTED
NEEDS_HUMAN != SENT
```

There is no generic canonical `SENT` state. Provider-specific legacy names must
map to one of these evidence-defined meanings.

## 7. Approval binding

Conceptual approval subject:

```ts
interface MessagingApprovalBinding {
  canonicalAction: 'SEND_MESSAGE';
  targetId: string;
  contentDigest: string;
  channel: MessagingChannel;
  environment: ExecutionEnvironment;
  provider: string;
  providerAccountRef?: string;
  workspaceRef?: string;
  deviceId?: string;
  executionRoute: string;
}
```

The canonicalized payload may also retain the exact content encrypted/in the
existing approval store as needed, but audit uses only non-sensitive identity
and digests. Any change to target, content, channel, environment, provider,
provider account/workspace, device, or route yields `REAPPROVAL_REQUIRED`.

Examples that invalidate approval:

- SMS → Gmail
- Android → server
- Gmail API → browser automation
- Slack workspace A → workspace B
- Slack channel A → channel B
- certified route → unknown route

Fallback is a new resolution and approval, never an adapter-internal shortcut.

## 8. Adapter boundary

The future shared interface should orchestrate contracts without implementing
provider behavior:

```ts
interface MessagingExecutionAdapter {
  describeCapability(context: CapabilityContext): Promise<MessagingExecutionCapability>;
  prepare(action: SendMessageAction, target: ExecutionTarget): Promise<PreparedExecution>;
  executeApproved(input: ApprovedExecution): Promise<MessagingExecutionResult>;
  observe(input: ObservationRequest): Promise<MessagingExecutionResult>;
}
```

Each adapter owns one coherent provider/platform route or a small route family.
SMS, Gmail, Slack, Teams, iOS composition, and browser-based messaging remain
separate implementations. Approval policy, route selection, evidence ordering,
and audit normalization remain shared services.

## 9. SMS mapping

| Field | Mapping |
|---|---|
| Channel | `SMS` |
| Environment | `ANDROID` |
| Provider | `ANDROID_TELEPHONY` |
| Route | `ANDROID_SMS_MANAGER` |
| Mode | `AUTONOMOUS_VERIFIED` |
| Target | opaque device-owned `recipientRef` plus `deviceId` |
| Provider accepted evidence | Android sent callback → `DEVICE_SEND_CALLBACK` |
| Delivery evidence | delivery callback only when actually received |
| Read evidence | unsupported |

Legacy `SEND_ATTEMPTED` maps to `EXECUTION_STARTED`. Legacy
`SENT_CONFIRMED` maps to `PROVIDER_ACCEPTED` with device send callback evidence,
not recipient delivery. Existing `DELIVERY_CONFIRMED` remains delivery evidence.
The certified Phase C storage/state machine should be adapted at a boundary,
not destructively rewritten first.

## 10. Gmail mapping

| Field | Mapping |
|---|---|
| Channel | `EMAIL` |
| Environment | `SERVER` with `EXTERNAL_API` provider plane |
| Provider | `GOOGLE` |
| Route | `GMAIL_API` |
| Mode | `AUTONOMOUS_VERIFIED` |
| Target | exact `to/cc/bcc`, Google account reference |
| Evidence | successful API response plus Gmail message/thread ID |
| Strongest immediate status | `PROVIDER_ACCEPTED` |
| Delivery/read evidence | unsupported unless a separate documented signal is added |

Current `NormalizedMutationResult.status='SUCCEEDED'` proves pipeline/provider
success but is too generic for user-facing messaging truth. `externalId` is
candidate `PROVIDER_MESSAGE_ID` evidence. Gmail `create_draft` is not
`SEND_MESSAGE` and must retain a separate canonical action/status.

## 11. Slack mapping

| Field | Mapping |
|---|---|
| Channel | `SLACK` |
| Environment | `SERVER` with `EXTERNAL_API` provider plane |
| Provider | `SLACK` |
| Route | `SLACK_CHAT_POSTMESSAGE` |
| Mode | `AUTONOMOUS_VERIFIED` only with a real configured workspace token |
| Target | workspace reference plus exact channel/DM ID |
| Evidence | `ok=true` API response plus message `ts` |
| Strongest immediate status | `PROVIDER_ACCEPTED` |
| Delivery/read evidence | not established by `chat.postMessage` |

Current `SlackClient.postMessage()` returns mock success and a synthetic
timestamp when no token exists. That behavior is acceptable only inside an
explicit test double. It must never satisfy production capability availability,
produce canonical provider evidence, or be shown as live execution.

## 12. Teams validation mapping

| Field | Mapping |
|---|---|
| Channel | `TEAMS` |
| Environment | `SERVER` with `EXTERNAL_API` provider plane |
| Provider | `MICROSOFT` |
| Route | `MS_GRAPH_CHATMESSAGE_POST` |
| Mode | `AUTONOMOUS_VERIFIED` for supported work/school delegated context |
| Target | tenant/account reference plus exact chat/channel ID |
| Evidence | Graph `201 Created` and message ID |
| Strongest immediate status | `PROVIDER_ACCEPTED` |
| Personal account | `UNSUPPORTED` for the audited operation |

This validates that account type and tenant consent belong in capability
availability and target binding; they are not provider-wide booleans.

## 13. KakaoTalk disabled mapping

| Field | Mapping |
|---|---|
| Channel | `KAKAOTALK` |
| Environment | `ANDROID` |
| Provider | `KAKAO` |
| Route | `KAKAOTALK_SHARE` |
| Intended mode | `HUMAN_HANDOFF` |
| Certified availability | `DISABLED` / `UNAVAILABLE` |
| Reason | `MemoChatConnectActivity` bypasses recipient-selection boundary |
| Unknown components | `NOT_CERTIFIED` → fail closed |
| Result | `UNAVAILABLE`; never `HANDOFF_STARTED`, `PROVIDER_ACCEPTED`, or fallback |

The component block remains. D3R does not reopen D2B, seek private activities,
use Accessibility, mutate the self-chat message, or authorize another route.

## 14. Migration impact on D1

The D1 abstraction is a valid initial channel/adapter split but is narrower than
the D3R contract:

- `MessagingChannel` currently contains only SMS and KakaoTalk.
- `SendMessageAction` assumes `recipientRef`, `deviceId`, and plain `message`
  universally; server providers need provider-qualified targets and richer
  content while preserving a canonical content digest.
- `MessagingRouteCapabilities` lacks environment, provider, authentication,
  evidence support, policy risk, and certification/availability state.
- `ExecutionOutcome`, `SendResult`, and `RunSnapshot` are aliases to the SMS
  run model, coupling the shared interface to Android SMS.
- `ExecutionRouteResolver` resolves channel → adapter → route but needs the
  environment and target/account constraints before route selection.
- `MessagingHandoffRun` is appropriate for handoffs only and should not become
  the universal provider run record.

Migration should be additive: introduce canonical contracts and translation
adapters, map SMS first without changing certified behavior, then map Gmail and
Slack. Remove legacy aliases only after parity tests and stored-run compatibility
are proven.

## 15. Files likely to change in a future implementation

No file in this list is changed by D3R.

### New shared contracts/services

- `src/messaging/messaging-execution-capability.types.ts`
- `src/messaging/execution-target.types.ts`
- `src/messaging/messaging-execution-result.types.ts`
- `src/messaging/messaging-approval-binding.ts`
- `src/messaging/environment-route-resolver.ts`
- `src/messaging/messaging-evidence-policy.ts`

### Existing messaging boundary

- `src/messaging/send-message-action.types.ts`
- `src/messaging/messaging-execution-adapter.ts`
- `src/messaging/execution-route-resolver.ts`
- `src/messaging/messaging-adapter-registry.ts`
- `src/messaging/sms-messaging-adapter.ts`
- `src/messaging/kakaotalk-handoff-adapter.ts`
- `src/messaging/messaging-handoff.types.ts`

### Existing provider mappings

- `src/mobile/mobile-message.types.ts`
- `src/contracts/gmail.port.ts`
- `src/modules/gmail/gmail.service.ts`
- `src/capabilities/google-capability-execution-pipeline.ts`
- `src/integrations/slack/slack.client.ts`
- Slack service/approval/audit composition files selected during implementation
- application composition and API presentation layers

### Tests and documentation

- new canonical contract/invariant tests
- existing Phase C, D1, D2B, Gmail, Slack, approval and audit suites
- test registry/scope files
- API/schema and roadmap documents

## 16. Compatibility and security risks

1. **SMS semantic regression:** renaming `SENT_CONFIRMED` could accidentally
   weaken the certified callback distinction. Use translation first.
2. **Stored-run compatibility:** persisted SMS/handoff JSON must remain readable.
3. **Approval drift:** adding environment/provider after approval creation could
   allow old approvals to omit new material fields. Version bindings and deny
   execution when required fields are absent.
4. **Synthetic provider success:** Slack's unconfigured mock path must never map
   to real evidence.
5. **Generic `SUCCEEDED`:** Gmail pipeline status can be over-presented as
   delivery/read unless normalized at the messaging boundary.
6. **Identity collision:** provider user/channel IDs require provider account,
   workspace and tenant scope.
7. **Fallback escalation:** choosing another environment/channel after failure
   without reapproval is prohibited.
8. **Unknown outcome replay:** `UNKNOWN` cannot automatically retry because the
   provider may have acted.
9. **Evidence ordering:** late delivery/read receipts must be idempotent,
   authenticated, correlated, and unable to regress a stronger state.
10. **Capability overclaim:** configured credentials, app installation, or an
    Intent resolver alone do not prove availability.
11. **Sensitive audit leakage:** content and credentials stay out of evidence
    and audit records.
12. **Giant-executor coupling:** provider-specific branches in the shared
    orchestrator would make policy and testing non-deterministic.

## 17. Test strategy

### Contract tests

- schema validation for every environment/mode/status/evidence type
- invalid combinations rejected (`UNSUPPORTED+AVAILABLE`, handoff without human)
- provider accepted never satisfies delivery/read predicates
- evidence strength is monotonic and idempotent

### Approval tests

- target/content/channel/environment/provider/account/workspace/device/route
  drift each requires reapproval
- cross-channel and cross-environment fallback cannot reuse approval
- replay and cross-tenant/cross-owner execution remain denied

### Adapter mapping tests

- SMS legacy states map without changing current execution
- Gmail API response maps to `PROVIDER_ACCEPTED`, never delivery/read
- Slack real response maps to provider evidence; unconfigured/mock response
  maps to unavailable/test-only and never external success
- Teams work/school validation maps correctly; personal account unavailable
- Kakao MemoChat and every unknown component fail closed

### Failure/evidence tests

- timeouts after request dispatch become `UNKNOWN` when provider action cannot
  be excluded
- unavailable route produces no fallback and no external mutation
- forged, mismatched, duplicate, or out-of-order receipts are rejected
- evidence/audit contains no raw message or token

### Compatibility tests

- old persisted SMS and handoff runs still load
- existing Phase C physical certification behavior remains intact
- API/UI translation remains truthful during versioned migration
- full regression and physical SMS/Kakao negative checks before closure

## 18. Recommendation

Runtime implementation **should not begin yet**. Approve or correct this D3R
contract first. If accepted, implementation should be a small contract-foundation
increment with no new messaging provider:

1. add versioned shared capability/target/result/evidence types;
2. add approval-binding and evidence invariants;
3. map existing SMS through a compatibility adapter without changing behavior;
4. map Gmail and Slack only after their existing truth gaps are separately
   tested and approved;
5. keep KakaoTalk disabled.

No provider expansion, browser executor, Teams implementation, or demo-only
shortcut belongs in that first increment.

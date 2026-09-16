# NAGEX Technical Debt Registry

Per `docs/NAGEX_DEVELOPMENT_SAFETY_HARNESS.md` §7 (H5 — Technical Debt Harness). Every knowingly temporary, incomplete, simplified, deferred, risky, or workaround implementation must be registered here. This is the first population of the registry (introduced during the R11 Final Safety Certification pass); items below predate this file where noted.

---

```yaml
id: DEBT-0001
area: capability-execution
description: >
  No mutating write to Google Calendar or Gmail in this codebase currently
  routes through CapabilityBroker + a distinct PolicyEngine/
  PolicyDecisionPoint before the ActionApprovalStore approval gate. Three
  real call sites exist today: CandidateActionResolver.executeCalendar()
  (pre-existing, src/workspace/action-resolver.ts), the POST
  /api/v1/approvals HTTP dispatcher (pre-existing, src/server_web.ts), and
  R11's action-proposal-executor.ts (new). All three call
  GoogleCalendarService/GmailService methods directly. Only
  ExecutingTaskRunner (Task automation) routes through CapabilityBroker,
  which runs CapabilityPolicy.evaluate() — still not PolicyDecisionPoint,
  which is wired only into AgentExecutor and top-level route auth.
severity: medium
introduced: pre-R11 (CandidateActionResolver / POST /api/v1/approvals);
  first FORMALLY REGISTERED during R11 Final Safety Certification
reason: >
  MVP/incremental architecture — GoogleCalendarService/GmailService each
  embed their own ActionApprovalStore request/consume gate (ownership-
  bound, tamper-hash-checked, one-time-use, fail-closed on missing
  token/network error — independently verified in
  tests/action_proposals_safety.test.ts), which provides the actual safety
  property INV-001 cares about (no mutation without approval, fail
  closed). The CapabilityBroker/PolicyDecisionPoint layer was built later
  and only wired into the Task-automation path; the Candidate and
  Approvals-HTTP paths were never retrofitted onto it.
risk: >
  Low for the SAFETY property itself (approval-gating, tenant binding, and
  fail-closed behavior are real and independently enforced by
  ActionApprovalStore regardless of this gap — see H1/H2 evidence in the
  R11 Final Safety Certification report). Medium for ARCHITECTURAL
  consistency and future policy centralization: a new policy rule added
  only to CapabilityPolicy/PolicyDecisionPoint would silently not apply to
  these three call sites.
target: R10.2-B (Google Capability Execution Pipeline) — already the
  planned refactor for routing Calendar/Gmail writes through a single
  canonical CapabilityBroker path.
owner: NAGEX
status: OPEN
```

```yaml
id: DEBT-0002
area: action-proposals (R11) / gmail-integration
description: >
  EMAIL_REPLY_DRAFT proposals (src/assistant/action-proposal-generator.ts)
  are generated with executable:false and can never be auto-executed,
  because this codebase's Gmail integration (gmail.client.ts's
  searchGmailThreads) only ever returns {threadId, snippet, historyId} —
  no `to`/`from`/`subject`. Composing a real Gmail draft/reply
  (GmailComposePayload) requires `to`/`subject`, which would have to be
  fabricated. This is a genuine, fixable data-availability gap, not a
  permanent design choice: extending the Gmail search/thread-read path to
  fetch real header metadata (From/Subject) would let this proposal type
  become fully executable using the same request/consume/execute pattern
  CALENDAR_RESCHEDULE already uses.
severity: low
introduced: R11
reason: Deliberately deferred — fixing it means extending the Gmail
  integration itself (a separate, larger change than R11's scope), not a
  shortcut taken under R11 time pressure.
risk: None today (the proposal is correctly marked non-executable and the
  UI never offers an Execute affordance for it — verified in
  tests/action_proposals.test.ts and live Playwright verification). Risk
  only if a future change removes the executable:false guard without also
  adding real to/subject grounding.
target: unscheduled — revisit if/when the Gmail integration is extended to
  fetch message headers (From/Subject) for another reason.
owner: NAGEX
status: OPEN
```

---

## Explicitly classified as NON-GOAL, not debt

Per the R11 directive's own explicit instruction not to silently call every disclosed limitation "debt":

**CREATE_AUTOMATION proposals are never auto-generated.** `ActionProposalType` includes `CREATE_AUTOMATION` (§2 of the R11 directive lists it as a supported initial proposal type), but `generateProposalsFromChanges()` has no branch that produces one. This is **not** an incomplete implementation of a committed feature — no `DetectedChange` kind from R10.1 (`CALENDAR_NEW/MOVED/CANCELLED`, `GMAIL_NEW/ACTION_REQUEST`, `APPROVAL_NEW`, `ACTION_ITEM_HIGH_NEW`) has an obviously grounded, non-speculative mapping to "the user wants a new standing automation created." Inventing one (e.g. "you keep approving X, want to automate it?" pattern-detection) would itself require new, materially different logic — trend/frequency analysis across multiple days — that was never part of R11's scope and isn't implied by any of R11's 15 required tests. The type exists in the model for forward compatibility; generating it is a **future feature decision**, not a debt payoff.

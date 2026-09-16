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
status: CLOSED
closed_in: R10.2-B (2026-09-16)
closure_basis: >
  All Google mutation paths (GoogleCalendarService.execute{CreateEvent,
  UpdateEvent,CancelEvent,RespondToEvent}, GmailService.execute{SendEmail,
  Reply,CreateDraft}) now traverse ONE canonical chokepoint —
  GoogleCapabilityExecutionPipeline (src/capabilities/
  google-capability-execution-pipeline.ts), composed (not inherited) into
  both services — replacing the two near-identical, independently-
  maintained request/consume/execute/audit implementations
  (executeWrite()/executeCreateEvent() in google-calendar.service.ts,
  executeCompose() in gmail.service.ts) that existed before. Every
  registered mutation is declared in one MutationCapabilityDefinition
  registry (src/capabilities/mutation-registry.ts +
  google-mutation-registry.ts), asserted to contain exactly the 7 known
  toolIds with no duplicates (tests/google_capability_execution_pipeline.
  test.ts test 1-3). Direct-mutation-bypass, approval-integrity, and
  fail-closed contract tests all pass (see the R10.2-B Safety Harness
  report). Closure is NOT based on line-count/jscpd reduction alone
  (jscpd is reported separately, as required) — it is based on: (1) one
  canonical boundary exists and both services use it, (2) direct bypass
  tests pass, (3) approval integrity tests pass, (4) fail-closed tests
  pass, (5) no known bypass path remains for a Google mutation
  specifically.
  This CLOSES the "duplicated safety-critical logic" finding. It does
  NOT close, and never claimed to close, the separate observation that no
  Google mutation path (old or new) routes through CapabilityBroker/
  PolicyDecisionPoint — see ADR-0002's "What remains open" section, which
  documents this honestly as a still-open architectural characteristic,
  not hidden by this closure. If a future milestone decides that gap
  itself needs a dedicated DEBT entry, it should be filed as a NEW item
  distinct from DEBT-0001, since DEBT-0001 was specifically about
  duplicated approval/execution lifecycle logic, which is now resolved.
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

```yaml
id: DEBT-0003
area: workspace/capture-processor
description: >
  CaptureProcessor.processAudioFallback() has a genuinely different
  completion contract than processText()/processUrl()/processPdf(): it
  always sets the capture's final status to READY, even though it always
  proposes exactly one PROPOSED TaskCandidate ("Review voice memo: ...") —
  the other three types would compute NEEDS_REVIEW whenever any candidate
  is still PROPOSED. It also never emits capture.analyzed or
  candidate.proposed audit events, unlike the other three. This means a
  captured voice memo's PROPOSED review-task candidate is not visibly
  flagged for review the way a text/URL/PDF-derived PROPOSED candidate is
  (the Inbox's own status-based filtering may therefore treat it
  differently), and its audit trail is comparatively thin.
severity: low
introduced: pre-R10.2-C (STT/audio fallback was added before the
  finalizeCaptureAnalysis extraction existed to compare against); first
  FORMALLY REGISTERED during R10.2-C, which surfaced it while designing
  the shared finalizer and deliberately did NOT route audio through it
  (see ADR-0003) rather than silently changing observable behavior.
reason: >
  No real speech-to-text provider is wired yet (a separate, disclosed,
  pre-existing scope limit — see the "No real STT provider" comment in
  capture-processor.ts), so the audio path was written as a minimal,
  always-succeeds placeholder rather than a fully-analyzed capture type.
  Unifying it with the other three now would be a real behavior change
  (new audit events, a different final status) requiring its own tests
  and product sign-off — out of scope for a structure-only refactor.
risk: Low — the capture item itself is always truthfully labeled (its
  summary/transcript never fabricates spoken content), and the review
  task candidate IS still created and visible in the capture's own
  metadata.candidates; the gap is limited to status-consistency and audit
  completeness, not correctness or safety.
target: unscheduled — revisit together with wiring a real STT provider,
  at which point audio capture's candidate/status/audit behavior should
  be reconciled with the other three types deliberately, with tests.
owner: NAGEX
status: OPEN
```

```yaml
id: DEBT-0004
area: http/server_web
description: >
  R10.2-D (HTTP Route Modularization) delivered the router/registrar
  infrastructure (src/http/http-types.ts, router.ts) and migrated exactly
  two domains out of server_web.ts: health/vcs (src/http/routes/
  health.routes.ts) and R11's Action Proposals (src/http/routes/
  action-proposals.routes.ts). server_web.ts still directly implements
  the remaining ~125 of its ~130 HTTP endpoints inline: providers/safety/
  conversations/ai-chat/ambient, oauth, workspace (route-input/storage/
  inbox/vault/uploads/captures/items), plans, Calendar/Gmail tool routes,
  ~20 Browser tool routes, tasks/workflows run, telegram/slack
  integrations, notifications, desktop/quickwake, candidates, activity,
  capabilities/execute, my-space, daily-brief/proactive-assistant,
  device-agent, memory, modules, approvals lifecycle, tasks/workflows
  CRUD, and static file serving.
severity: low
introduced: R10.2-D (deliberate, documented scope decision — see ADR-0004
  "Scope of this round" — not a shortcut taken silently)
reason: >
  The R10.2-D directive's own §18 explicitly instructs against moving 100+
  endpoints in one mechanical rewrite, recommending instead: establish the
  registrar contract, move one low-risk read-only domain, run tests, move
  another domain (chosen to prove mutation/approval safety), then continue
  incrementally. This round did exactly that and stopped at a safely
  verified, fully-tested checkpoint rather than attempting an unverifiable
  single-pass migration of the remaining domains.
risk: Low — server_web.ts's remaining inline routes are unchanged
  behavior, still covered by their existing test suites, and the
  established registrar pattern (proven on both a read-only and a
  mutation-with-approval domain) is ready to apply to them without
  further architectural decisions.
target: R10.2-D continuation (or a renumbered follow-up round) — the
  directive's own §19 domain order (settings/read-only → workspace reads
  → task reads → Gmail/Calendar reads → remaining Gmail/Calendar
  mutations → automation/task mutations → the rest) is the intended
  continuation sequence.
owner: NAGEX
status: OPEN
```

Per explicit instruction: DEBT-0003 (processAudioFallback's status/audit
inconsistency, registered during R10.2-C) is NOT addressed by R10.2-D and
remains unchanged/OPEN — it is unrelated to HTTP route organization.

---

## Explicitly classified as NON-GOAL, not debt

Per the R11 directive's own explicit instruction not to silently call every disclosed limitation "debt":

**CREATE_AUTOMATION proposals are never auto-generated.** `ActionProposalType` includes `CREATE_AUTOMATION` (§2 of the R11 directive lists it as a supported initial proposal type), but `generateProposalsFromChanges()` has no branch that produces one. This is **not** an incomplete implementation of a committed feature — no `DetectedChange` kind from R10.1 (`CALENDAR_NEW/MOVED/CANCELLED`, `GMAIL_NEW/ACTION_REQUEST`, `APPROVAL_NEW`, `ACTION_ITEM_HIGH_NEW`) has an obviously grounded, non-speculative mapping to "the user wants a new standing automation created." Inventing one (e.g. "you keep approving X, want to automate it?" pattern-detection) would itself require new, materially different logic — trend/frequency analysis across multiple days — that was never part of R11's scope and isn't implied by any of R11's 15 required tests. The type exists in the model for forward compatibility; generating it is a **future feature decision**, not a debt payoff.

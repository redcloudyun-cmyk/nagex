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
  infrastructure (src/http/http-types.ts, router.ts) and migrated all 147
  HTTP endpoints out of server_web.ts across five increments: Increment 1
  — health/vcs, Action Proposals; Increment 2 — memory, modules, catalog,
  settings, notifications; Increment 3 — tasks, automations, workspace;
  Increment 4 — gmail, calendar, approvals, browser, google-oauth,
  telegram, slack, desktop, governance; Increment 5 (final) — providers
  (src/http/routes/providers.routes.ts), safety (src/http/routes/
  safety.routes.ts), the Main Session / conversational core
  (src/http/routes/conversation.routes.ts — conversations/main GET/POST-
  messages/DELETE, ai/chat, ambient/intent, plans/resolve, plus the sync
  sessions/main registrar), Daily Brief / Proactive Assistant
  (src/http/routes/daily-brief.routes.ts, including its
  buildBriefResponse/computeBriefFreshness/safeListPendingApprovals/
  countImportantChangesForDate/serializeProactiveConfig helpers),
  capabilities/execute (src/http/routes/capabilities.routes.ts), My Space
  (src/http/routes/my-space.routes.ts), and the Device Agent transport
  route (src/http/routes/device-agent.routes.ts). server_web.ts now
  contains zero inline `/api/v1/*` domain route checks — the only
  remaining `method === '<VERB>'` check in the entire file is the generic
  CORS OPTIONS preflight in createServerInstance(), plus `/health` and
  static frontend file serving (all three genuine server-lifecycle/
  bootstrap/cross-cutting infrastructure, never domain business logic).
severity: low (historical — retained for audit trail after closure)
introduced: R10.2-D (deliberate, documented scope decision — see ADR-0004
  "Scope of this round" — not a shortcut taken silently)
reason: >
  The R10.2-D directive's own §18 explicitly instructed against moving
  100+ endpoints in one mechanical rewrite, recommending instead:
  establish the registrar contract, move one low-risk read-only domain,
  run tests, move another domain (chosen to prove mutation/approval
  safety), then continue incrementally until the whole surface is
  migrated. All five increments followed that sequence, each stopping at
  a safely verified, fully-tested checkpoint — this debt entry tracked
  that intentional, disclosed incompleteness between increments. It is
  now closed because the completion conditions below are all genuinely
  satisfied, not merely because the LOC/endpoint counters hit a target.
progress: >
  Increment 1: 6/147 migrated. Increment 2: +20 → 26/147 (18%).
  Increment 3: +43 → 69/147 (47%). Increment 4: +56 → 125/147 (85.0%).
  Increment 5: +22 (providers=2, safety=3, conversation=7, daily-brief=6,
  capabilities=1, my-space=1, device-agent=1) → 147/147 migrated (100%),
  0 remaining inline domain endpoints. Endpoint counting methodology
  unchanged since Increment 2: count of distinct `method === '<VERB>'`
  check blocks, applied consistently to both server_web.ts and the route
  modules across all five increments.
closure_verification: >
  All eight R10.2-D Increment 5 completion conditions verified before
  closing: (1) server_web.ts no longer materially owns domain
  handlers — confirmed structurally by
  tests/http_route_modularization.test.ts test 80, which asserts the
  file's only remaining `method === '<VERB>'` check is CORS OPTIONS and
  that no `/api/v1/*` pathname literal remains; (2) remaining inline
  "endpoints" (/health, CORS OPTIONS, static file serving) are true
  infrastructure/system residuals, explicitly listed above, never left
  "because inconvenient"; (3) all residuals are explicitly justified in
  this entry; (4) route re-entry guards pass (tests 33/48/64/79 across
  Increments 2-5, plus the final test 80); (5) mutation/capability safety
  passes — Gmail/Calendar mutations still resolve only through
  GmailService/GoogleCalendarService.executeXxx() ->
  GoogleCapabilityExecutionPipeline (tests 62-63), capabilities/execute
  still resolves only through CapabilityBroker.execute() (test 77), and
  daily-brief.routes.ts never constructs a TaskScheduler/TaskRunner
  itself (test 78); (6) the Composition Root is clear — server_web.ts
  (775 lines, 42 imports) now contains only: core-engine/registrar
  imports, the composition-root construction (createNagexApplication()),
  the modelErrorResult/ERROR_CATEGORY_STATUS error boundary, the two
  dispatch entry points (now pure sequential registrar-call chains), and
  createServerInstance()'s real HTTP server + body parsing + static file
  serving + process lifecycle; (7) the full 147-endpoint route inventory
  is preserved — every route contract test from every prior increment
  still passes unchanged; (8) the full official test harness passes (see
  below). All eight conditions hold, so DEBT-0004 is CLOSED, not left
  OPEN on partial credit.
resolution: >
  Closed by R10.2-D Increment 5 (BASE_SHA=1841087). 26 route modules now
  exist under src/http/routes/, each with a narrow XRouteDeps interface —
  no god-dependency object was ever introduced. See ADR-0004's final
  update for the finalized registrar architecture, composition-root
  boundary, allowed-residual-inline-route categories, and the
  new-domain/mutation-safety/dependency rules that now govern any future
  route addition.
r10_2_e_reconciliation: >
  R10.2-E's baseline measurement pass (2026-09-17) re-verified the
  endpoint count with a fresh, tool-generated extraction instead of
  reusing the carried-forward figure, and found the true, current count
  to be 144 domain method-check blocks (not the 147 this entry and
  ADR-0004 had been citing since an early Increment 1/2 informal
  estimate) — a 3-endpoint reporting drift, not a functional regression;
  no route was lost, duplicated, or silently reverted to inline. 144 is
  now the codified, test-enforced baseline (see
  tests/route_inventory.test.ts, ROUTE-INV-001 through ROUTE-INV-007,
  which derive the count directly from source on every test run and fail
  on any future drift). This is exactly the kind of "route count drift
  without explicit change" R10.2-E's own mandate (§4.2) existed to catch;
  it is recorded here rather than silently corrected, per this project's
  standing rule against quietly overwriting a prior round's numbers.
owner: NAGEX
status: CLOSED
```

Per explicit instruction: DEBT-0003 (processAudioFallback's status/audit
inconsistency, registered during R10.2-C) is NOT addressed by R10.2-D and
remains unchanged/OPEN — it is unrelated to HTTP route organization.

---

```yaml
id: DEBT-0005
area: intent-first-ux
description: >
  Tracks the specific sub-items from R12.1 Increment 1's 23-section
  directive that were deferred to later increments, with per-item status
  (per the R12.1 Increment 2 directive §28's explicit instruction not to
  close this entry wholesale just because most items are done).

  §13 capability-neutral onboarding examples — CLOSED by Increment 2. Home's
  example grid now spans 7 distinct capability classes (research,
  presentation, coding, communication, image, scheduling, automation),
  replacing the old 5/5 calendar-or-travel-dominant set. See
  tests/home_intent_first_ux.test.ts tests 3-4.

  §11 Home-specific nav selected-state — CLOSED by Increment 2. Verified:
  switchTab() remains the single source of truth for active-state
  add/remove across Home/Inbox/Activity/Settings (no second router
  introduced). See tests/home_intent_first_ux.test.ts test 17.

  §11 Back/Forward — REMAINS OPEN, now with an explicit regression test
  instead of an undocumented gap. Increment 2 confirmed (again) there is no
  pushState/popstate/hashchange wiring anywhere in app.js — Back/Forward
  across tabs is architecturally unsupported, not silently faked as
  supported. See tests/home_intent_first_ux.test.ts test 18. A real fix
  needs a dedicated history/routing pass, out of scope for a Home content
  redesign.

  §15 Home aria-live — CLOSED for Home's three live-updating sections
  (Working/Important/Approvals, all aria-live="polite", never "assertive").
  See tests/home_intent_first_ux.test.ts test 21. Ambient/ Inbox/Activity
  live regions remain unaudited (different screens, later increments).

  Ambient "Review Plan"/"Run" CTA — CLOSED. The dead, unwired "Review Plan"
  button (btn-review-plan) inside the static onboarding example card was
  removed rather than wired to a no-op; the remaining "Run" button already
  went through the canonical composer submit path and needed no CTA-text
  change. See tests/home_intent_first_ux.test.ts test 11.

  §14 real mobile-viewport rendering — REMAINS OPEN. Increment 2 added a
  static CSS-source check (no fixed-width grid columns in new markup) but
  this repo still has no real-browser rendering harness to verify actual
  360/390/430px layout, per the R12.1 directive's own acknowledgment that
  this may remain open until R12.2.
severity: low
introduced: R12.1 Increment 1 (2026-09-17)
reason: >
  The directive itself frames Increment 1 as creating "the reusable
  interaction foundation" that later Home/Inbox/Activity/Settings
  increments will build on (§20), not a full redesign of those screens.
  Increment 2 (Home UX) closed the Home-specific portions once real,
  finished Home markup existed to test against; Back/Forward and real
  mobile-browser verification remain open because they need
  infrastructure (a router, a browser harness) this repo does not have
  yet, not because Home wasn't touched.
risk: >
  Low. None of the remaining open items affect approval semantics,
  mutation safety, or truthfulness — all Safety Harness checks pass in
  both Increment 1 and Increment 2. The risk is UX-completeness drift if
  a later increment assumes Back/Forward or real mobile rendering are
  already verified; flagging them here (with an explicit regression test
  for the Back/Forward gap) prevents that assumption.
resolution: >
  Partially closed. §13, the Home portion of §11, Home's §15 aria-live,
  and the ambient Review-Plan CTA are closed as of R12.1 Increment 2
  (2026-09-17). Back/Forward and real mobile-browser verification remain
  open, expected to close only once a routing/history mechanism and a
  browser test harness exist respectively — tracked here rather than
  re-opened as new debt each increment.
owner: NAGEX
status: OPEN
```

---

```yaml
id: DEBT-0006
area: approvals-data-truthfulness
description: >
  GET /api/v1/approvals (src/http/routes/approvals.routes.ts) is a legacy
  demo/seed endpoint: its backing array (approvalQueue) is permanently
  seeded with 2 fixed fictional entries (appr_gcal_sync — a fake "Product
  Strategy Sync" meeting with invented guests Sarah Kim/James Park/Alex
  Chen; appr_stakeholder_email — a fake stakeholder review email) and never
  reflects real GoogleCalendarService/GmailService approval-store state.
  Those two services each only support point lookup of one approval by a
  specific approvalId during an in-progress plan-resolution flow (which
  already renders its own real approval card inline in the ambient modal)
  — there is no real "list all pending approvals" aggregation endpoint for
  either service. Home's "Needs Approval" section (and the mobile
  equivalent) would otherwise have displayed these 2 fictional entries as
  if they were the user's real pending approvals.
severity: medium
introduced: pre-R12.1 (approvalQueue itself predates this work; first
  FORMALLY REGISTERED during R12.1 Increment 2, 2026-09-17, while building
  Home's real "Needs Approval" section)
reason: >
  Discovered while implementing R12.1 Increment 2 §9 (consequence-specific
  Approval CTAs) — sourcing Home's approval list from state.approvals
  would have shown two fabricated fictional approval requests as if real,
  violating MASTER.md's "no misleading mock behavior" rule and this
  increment's own §24/§25 truthfulness requirements. Per the Increment 2
  directive §26 ("No backend architecture churn... any real architecture
  gap discovered: document separately"), this is exactly that case — a
  real fix needs a dedicated backend aggregation pass (a genuine "list
  pending real approvals across Calendar/Gmail" endpoint), not a
  Home-content-only change, and rewriting the approval pipeline inside a
  UX increment would be exactly the kind of unreviewed architecture churn
  the directive prohibits.
risk: >
  Medium. The approval STATE MACHINE itself (approve/reject/status
  transitions) is real and already covered by
  tests/personal_ai_ux.test.ts tests 7-8 — this is a data-source gap
  (fictional seed content), not a broken safety boundary. The mitigation
  applied this increment (excluding the 2 known legacy ids by id, on the
  frontend only, in both desktop and mobile Home) is a targeted, low-risk
  fix that does not touch the backend, the approval pipeline, or those
  existing tests. Risk is medium rather than low because "no real
  aggregate list of pending approvals exists at all" is a genuine product
  gap for any future scenario needing to show more than one in-flight
  approval discovered outside an active plan-resolution flow.
resolution: >
  CLOSED by R12.1 Increment 2.5 (Approval Truth Source pass,
  BASE_SHA=f3da251, 2026-09-17). Investigation found the "no real
  aggregation endpoint exists" premise in this entry's own description
  was stale: ActionApprovalStore.listPending(tenantId, principalId)
  already existed (src/governance/action-approval.store.ts) and was
  already used by Daily Brief's own "Needs Your Approval" section — the
  actual gap was narrower than described: approvals.routes.ts's
  GET /api/v1/approvals simply never called it.

  Fix applied: the legacy approvalQueue array (and its 2 fictional
  entries) was deleted entirely from src/http/routes/approvals.routes.ts,
  not moved behind a demo-mode flag — no demo/compatibility need for it
  was found (grep confirmed no other consumer). GET /api/v1/approvals now
  maps ActionApprovalStore.listPending()'s real, tenant/principal-scoped,
  live-expiry-checked records into the same response shape the frontend
  already rendered (id/approvalId/toolId/action/resource/status), so no
  frontend rendering logic needed to change — only its data source did.
  The POST /api/v1/approvals/:id/action catch-all's legacy-array branch
  was removed the same way; it now only ever operates on real records.

  The frontend LEGACY_DEMO_APPROVAL_IDS id-exclusion workaround (added as
  this entry's original mitigation) is fully removed from app.js,
  desktop-home.js, and mobile-home.js — presentation code no longer knows
  any backend demo id. A fail-closed distinction was also added
  (state.approvalsLoadFailed, both desktop and mobile) so a genuine fetch
  failure renders "Approvals could not be loaded." rather than being
  indistinguishable from "No approvals needed." — this was not previously
  handled correctly (an API-error response was silently treated as an
  empty list).

  Approval semantics are unchanged: payload binding (payloadHash),
  tenant/principal ownership (requireOwned), expiry (getLive), one-time
  consumption (consume), and replay prevention were not touched — only
  GET /api/v1/approvals's data source and the POST .../action catch-all's
  legacy branch were. Verified by tests/approval_truth_source.test.ts (16
  tests: no fictional records in production output, real
  pending/approved/rejected/expired/consumed lifecycle reflected
  correctly, tenant/principal isolation, payload-hash binding unchanged,
  fail-closed error surfacing, both Calendar and Gmail visible through the
  one canonical source) plus updated tests/personal_ai_ux.test.ts (7-8)
  and tests/google_calendar_live.test.ts, all passing against real
  ActionApprovalStore records instead of the removed demo queue.

  DEBT-0005's Home-relevant items (§11 Back/Forward, §14 real
  mobile-browser rendering) were intentionally NOT touched by this pass,
  per this directive's own explicit instruction — they remain open,
  tracked separately in DEBT-0005.
owner: NAGEX
status: CLOSED
```

---

## Explicitly classified as NON-GOAL, not debt

Per the R11 directive's own explicit instruction not to silently call every disclosed limitation "debt":

**CREATE_AUTOMATION proposals are never auto-generated.** `ActionProposalType` includes `CREATE_AUTOMATION` (§2 of the R11 directive lists it as a supported initial proposal type), but `generateProposalsFromChanges()` has no branch that produces one. This is **not** an incomplete implementation of a committed feature — no `DetectedChange` kind from R10.1 (`CALENDAR_NEW/MOVED/CANCELLED`, `GMAIL_NEW/ACTION_REQUEST`, `APPROVAL_NEW`, `ACTION_ITEM_HIGH_NEW`) has an obviously grounded, non-speculative mapping to "the user wants a new standing automation created." Inventing one (e.g. "you keep approving X, want to automate it?" pattern-detection) would itself require new, materially different logic — trend/frequency analysis across multiple days — that was never part of R11's scope and isn't implied by any of R11's 15 required tests. The type exists in the model for forward compatibility; generating it is a **future feature decision**, not a debt payoff.

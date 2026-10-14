# ADR-0015 — Home: asking for approval to run a REVIEWED plan

**Status:** ACCEPTED (D-10, 2026-10-14) · **Builds on:** ADR-0014 (One Input), the P02 approval-aware Task continuation · **Does not change:** Human Approval, the Permission Decision Service, the Capability Broker, the provider services, task policy defaults

## Context

Home's "Run this plan" created an `ALWAYS_APPROVE` task and ran it. The scheduler sends only `READ_ONLY_AUTO` tasks to the `ExecutingTaskRunner` (the runner that asks the Capability Broker, creates the real approval and resumes after it); every `ALWAYS_APPROVE` task goes to `PlanPreviewTaskRunner`, which asks the model for a second plan, resolves it and returns `PLAN_PREVIEW` — it never calls the broker. So no approval was ever created and nothing could run: by design `ALWAYS_APPROVE` was a preview. Pointing Home at the executing runner by changing the policy would have been wrong for three reasons: the runner re-plans from the request text (what is executed would not be what was reviewed), it dispatches read-only steps at once (before any human approval), and it relaxes a task policy the product keeps strict.

## Decision

A new, explicit, user-triggered transition **plan preview → approval request**, `POST /api/v1/tasks/from-reviewed-plan`, built only from existing parts:

1. **Seal.** The plan route returns, with a plan preview, `planSeal { planHash, token, expiresAt }` and `runnable { ok, reasons[] }`. The hash covers what would be done (goal, summary, per-step title / skill / tool / approval flag / necessity / dependencies / parameters); the token is an HMAC bound to tenant, principal, hash and expiry with a per-process random key. It grants nothing; it proves "this is the plan that was shown to this person".
2. **Verify, re-resolve, re-assess on the server.** The run route recomputes the hash from the plan it receives, verifies the token (wrong owner, changed plan, expiry, a preview from another process all have their own refusal; nothing is created), resolves the plan again with the caller's identity and re-applies the eligibility rule. The client's "runnable" flag is a screen hint only.
3. **Eligibility (smallest slice).** Exactly one step whose tool is approval-gated by the broker's native continuation (calendar / mail writes, user-registered MCP tools), available to this person, with concrete arguments. Read-only steps are not run from Home (they would dispatch before any approval); multi-step plans, unavailable, blocked or unsupported tools stay previews with the reason.
4. **One-time.** A sealed plan is claimed once per owner (synchronous claim; a double click or two simultaneous requests start one run and one approval; the second answer carries the first run).
5. **No new executor.** The task (`ALWAYS_APPROVE`, `MANUAL`) is run by the existing `ExecutingTaskRunner.runWithResolvedPlan` with the resolved, frozen plan (no model call). Its first broker call only REQUESTS the approval through the provider service (hash-bound `ActionApproval`). The approval route, `TaskContinuationCoordinator`, replay protection and expiry are the unchanged P02 machinery; execution happens only after the person's own Approve, with the approved id, once. MCP tools are allowed through the runner's native-approval gate by capability id (`mcp.<connection>.<tool>`); the broker still decides.
6. **Honest states.** Home shows PLAN_PREVIEW → APPROVAL_REQUIRED (the exact action and arguments, "nothing has been done yet") → the person's Approve / Decline → TOOL_RESPONDED (what the provider answered; `verification` stays UNVERIFIED) / FAILED / "Not run — you declined" / "Not run — the approval expired". "Completed" is never used for a provider response.
7. **Audit.** `plan.run.requested` / `plan.run.denied` record the plan hash, capability, task / run ids and argument NAMES — never argument values or credentials.

## Consequences

- One route added (route inventory 349 → 350). `PlanPreview` responses gain `planSeal` and `runnable`; advisory answers are never sealed.
- Seal tokens and claims live in process memory: a restart invalidates every preview (the person asks again); no replay can cross a restart.
- Approval expiry is still detected lazily by the P02 coordinator (disclosed there); Home shows the run as waiting until it is resolved or cancelled.
- Deferred: multi-step plans with one durable approval chain, read-only steps run from Home, a persistent seal.

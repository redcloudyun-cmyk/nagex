# NAgex D-10 — One Input release gates and authorized execution slice
Date: 2026-10-14 KST
Source branch: d11/one-input-intent-20261014
Status: task directive; NOT implemented, executed, merged or deployed by this document.

## Confirmed evidence
User-reported focused One Input build and full local gates PASS at code SHA 21f90ca:
- build exit 0
- regression 2915 total, 2907 pass, 0 fail, 8 skip
- browser 269 total, 263 pass, 0 fail, 6 skip; EN/KR 1440/430/390/360
- real Nebius through isolated certification script: 13/13 routed, Nemotron first 13/13; 12 direct and 1 legitimate timeout fallback.
- integration server currently running bcd7e10, not One Input.
- existing plan Run in Home only creates ALWAYS_APPROVE and returns PLAN_PREVIEW; **no eventual execution** from Home.
- Slack MCP remains out of the Oct 25 demo critical path; Google Calendar/Gmail provider credentials were absent in prior server audit.

## Release principle
User only describes the job. NAgex chooses an available route. Consequential actions require explicit human-bound consent and approval; no auto-approval, no fake 'done'. Never convert an advisory answer to an executable plan.

## P0-A — Restore one complete safe Home action, without a new executor
1. Trace existing Home 'Run this plan' → Task creation → approval request → ApprovalStore → capability permission → execution → audit/result. Write the exact state machine; identify whether ALWAYS_APPROVE was designed to remain PLAN_PREVIEW or needs a separate authorized continuation.
2. Implement the **smallest explicit user-triggered** transition from a reviewed plan to an approval proposal for a single supported, already-configured, benign tool. Preserve target, arguments, original user request, tenant/principal, immutable plan version/hash and one-time approval identity. Do not change universal task policy to READ_ONLY_AUTO or weaken any Permission Gate.
3. Show truthful outcomes: PLAN_READY → APPROVAL_REQUIRED → APPROVED → EXECUTING → TOOL_RESPONDED/FAILED/VERIFICATION_UNVERIFIED. Never label PLAN_PREVIEW as completed.
4. No external call or tool dispatch on first Home submit, on route classification, or on 'Run this plan' before the separate concrete Human Approval. Dangerous intents, send/delete/payment, unavailable Google or Slack and missing targets must remain blocked or require human-specific clarification.
5. Use an existing isolated read-only browser tool or inert test destination with actual normal CapabilityBroker execution. **No Gmail/calendar email/event or external message** in automated certification. If the current API architecture cannot provide a correctly bound approval, report BLOCKED; do not bridge with a bespoke fake executor.
6. Test wrong owner/tenant, stale plan, changed args/target, changed schema, replay, duplicate-click, expiry, failed provider, audit redaction and rollback of UI state.
7. Browser certify the authentic Home chain at 1440 and 360/390/430 EN/KR with at least one actual approval decision (against isolated harmless fixture). No silent effect before approval.

## P0-B — Test deployment and user outcome certification
1. Re-check current server PID, status, process SHA and protected data. Stage One Input built at frozen tested SHA in an isolated candidate worktree. Do not merge unrelated Voice WIP; keep main and production unchanged.
2. Run fresh build/regression/browser tests at the exact candidate SHA. Test user-visible intent examples (KO/EN), '+' shortcuts, compound research→document and truthful unsupported responses.
3. Release candidate should be deployed to nagex-test.agex.site only after explicit operator approval and rollback/backup gates. This document grants **no deploy or restart permission**.
4. After deployment test real OAuth signed-in Home HTTP/browser: natural language advice, actionable Plan, document creation → durable save → Recent → Open; log model provider, fallback, latency truthfully.
5. Distinguish fixture data from real model/provider calls. Do not print, export or request session cookies/secrets. Do not create demo accounts bypassing Google/Microsoft OAuth.
6. Record source/build/deployed SHA parity and complete artifact+execution evidence.

## P1 — Controlled polish, not feature expansion
- Korean response consistency and shorter labels
- Compact composer and My Day expand/collapse as already implemented (do not redesign)
- Fix research-to-slides only if it blocks the chosen demo; research-to-image must not imply research completed when skipped.
- Nemotron timeout recommendation 90s: **do not blindly enable**. First measure scenario timeouts, UX wait and cost; evaluate retry + fallback interplay. A longer timeout can exceed demo time and increase costs.
- Ensure operator's existing paused fixture jobs remain PAUSED throughout.

## Explicit GO/NO-GO
- NO-GO if approval bypass, fake successful execution, misleading provider Connected status, unauthorized write, 0-step actionable plan, secret exposure, failed build/test, no rollback.
- Functional One Input auto-router and isolated tests can be marked PASS independently, but final hackathon journey is not PASS until real hosted artifact creation and one human-approved real harmless action are certified.
- If secure approve→execute cannot be finished in time, hide or clearly label unavailable execution; show truthful Plan Preview and do not claim autonomy or an action completed.

## Next agent instruction
Prepare exact P0-A implementation design using the **existing** NAgex TaskStore, ActionApprovalStore, CapabilityBroker, McpService/browser capability, execution records. In a clean isolated worktree implement only after code-level invariants are mapped. Final report should separate code review from tests and live external certification. Do not deploy or merge to main without approval.

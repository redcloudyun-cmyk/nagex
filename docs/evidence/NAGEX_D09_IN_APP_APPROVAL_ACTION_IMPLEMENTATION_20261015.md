# NAgex — P0 In-App Human-Approved Save to Vault
Date: 2026-10-15 KST
Base: d10/nightly-demo-readiness-20261014 (Draft PR #14)
Status: DEVELOPMENT ORDER, not implemented/certified or deployment authorization

## Objective
Deliver **one complete, truthfully auditable, user-owned, internal NAgex action** without an unconfigured Google app or an invented remote MCP provider:

> "회의 요약을 내 보관함에 저장해줘."

Natural language → One Input → reviewed plan with a concrete draft and destination → user requests approval → **existing ActionApprovalStore** → user approves → **existing CapabilityBroker** executes a single authorized persistent Vault write → the item appears in Vault / Recent (where supported), and survives reload → truthful stored item and audit.

DO NOT merely rename a text-only preview or invoke direct `QuickCaptureService` from Home before approval. Keep all user data private.

## Source review facts (verified in GitHub)
- `src/tools/tool-registry.ts` lists `workspace.prepare_draft` under a draft capability, but this is **not** a working broker executor.
- `src/capabilities/capability.registry.ts` does not register a corresponding `workspace.prepare_draft` broker capability.
- `src/capabilities/capability-broker.ts` checks native approval before dispatch and currently only has calendar/Gmail, browser/device and MCP native approval continuations.
- `src/planning/reviewed-plan-eligibility.ts` limits Home to single-step native approval-gated tools and enabled MCP; `src/tasks/runners/executing-task.runner.ts` has its own narrower allowlist.
- `src/governance/action-approval.store.ts` supports hash-bound request, owner-based approve/reject and one-time consume/assertExecutable.
- `src/workspace/quick-capture.service.ts` has owner-scoped persistent capture/Vault flows; reuse the canonical source of truth, don't invent a second storage format.
- PR #14 source tests 2,959 total regression / 2,951 pass / 0 fail / 8 skip; browser 294 total / 288 pass / 0 fail / 6 skip at SHA `88e94b1`, reported, not rerun here.
- Test server remains old `bcd7e10` until an authorized deployment.

## P0 implementation plan

1. **Separate isolated branch and worktree.** Start from latest PR #14 source. Check branch freshness/clean status first. Keep Voice WIP and main untouched.
2. **Define explicit capability and risk:** `workspace.prepare_draft` (or an unambiguous new id if the pre-existing tool id is informational) with *owner-local persistent mutation*, approval REQUIRED for this intentionally approval-gated demonstration. The feature must provide a genuine user benefit, not gratuitous extra approval in normal passive note-taking. Keep generic 'save note' behavior unchanged.
3. **Draft payload:** stable user/tenant, title, body/text, category, source/capture reference, target Vault folder, immutable version, idempotency key. No invented meeting facts. Prompt/plan must identify supplied vs inferred content, show destination and exact preview. Bound, validated size and safe type; no HTML execution, path traversal or arbitrary storage key.
4. **Request path:** freeze payload/hash before requesting approval. Re-resolve ownership, capability availability, tool/args and trusted source on server, not only in browser. No external or internal persistent write **before** the separate Approve action. Use current `ActionApprovalStore.request`, not a newly invented approval system. Keep `planSeal` immutable.
5. **Approve and execute:** via current approval HTTP route → `TaskContinuationCoordinator` → `ExecutingTaskRunner` → `CapabilityBroker`; introduce only the narrowly scoped native provider adapter/dispatch for owner-local `QuickCaptureService` save, with approval id required. Never add a direct unauthorised save endpoint or change other capabilities' policies.
6. **Exactly-once despite retries:** consume permission with hash/identity binding; implement durable idempotent storage so duplicate callbacks or process restarts do not create two notes. If atomicity between approval consume and storage cannot be shown, fail safely and report as BLOCKED rather than claiming exactly once. Ensure failed persistence is never shown as saved.
7. **Truthful result:** return `SAVED_TO_VAULT` only after actual persisted record is reread/verified for the owner; otherwise explicit failure. UI says '보관함에 저장했어요' only then, with Open action to saved item; keep Activity audit (no raw content or secrets). Do not label `TOOL_RESPONDED` as a verified real-world external effect.
8. **Release invariants:** advice never becomes an executable task; unavailable capability → accurate disabled/non-runnable; missing source details → request clarification, never AI fabrication; stored item not visible to another user/tenant.
9. **Review common functionality:** if draft tool itself is a no-op or only planned, do not mark it LIVE in catalog or planner before wiring the actual broker/owner store.

## Required tests before claiming PASS
- Unit + in-process real HTTP + Playwright at EN/KR, 1440/430/390/360 (not just mocks).
- No write before approval; Approve once writes exactly one owner item; Decline/expiry zero writes; unauthorized caller 401; foreign tenant or principal 403/indistinguishable 404.
- Tampered plan/recipient/body/location/hash, changed capability, stale seal, concurrent/double-click, replay after restart, interrupted persistence, disk full/storage denial; no duplicate record.
- Stored artifact visible in correct Vault route, reopen after fresh browser and process restart; unrelated owner sees nothing; hidden path and payload not leaked via audit/UI.
- Confirm all existing calendar/MCP/Gmail approval tests continue unchanged.
- Register any new `*.test.ts` in contract and scope registries.
- Run `npm run build`, focused tests, `npm test`, `npm run test:browser-cert`, all zero failure. Do not silence flakes or widen timeouts casually.
- Final code+test SHA and user-visible screenshots, honest PASS/FAIL/BLOCKED/NOT_RUN. Distinguish real browser, isolated fixture and hosted.

## D-9 scope and stop gates
Primary objective = this one internal actionable slice; do not build more app modes, extend enterprise, merge Voice WIP, register external services, increase provider quotas or change scheduled fixtures.

If a secure implementation requires broad rewriting of approval architecture or shared persistence, **stop code rollout** and propose a smaller approved alternative, keeping PR #14 green.

No server deploy, restart, tenant data writes, real account sessions, main merge or external actions without explicit user authorization. A code-verified local action is not hosted E2E.

## End report
Create `docs/evidence/NAGEX_D09_INTERNAL_APPROVAL_SAVE_CERT_20261015.md` containing `BASE_SHA`, `FINAL_SHA`, `NO_WRITE_BEFORE_APPROVAL`, `OWNER_ISOLATION`, `EXACTLY_ONCE`, `PERSISTED_VAULT_OPEN`, `RESTART`, `AUDIT_REDACTION`, `REGRESSION`, `BROWSER_CERT`, `LIVE_HOSTED`, `DEPLOYMENT`; include original defect analysis, meaningful screenshots, and a Korean concise handoff. Commit/push only the isolated feature branch, open Draft PR towards PR #14's base branch; do not merge.

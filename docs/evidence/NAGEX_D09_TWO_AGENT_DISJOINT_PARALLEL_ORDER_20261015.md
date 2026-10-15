# NAgex D-09 — Strictly Disjoint Two-Agent Parallel Development Order
Date: 2026-10-15 KST
Purpose: accelerate the Oct 25 video preparation WITHOUT costing time on Git merges, UI collisions, inconsistent interfaces or shared data.
Canonical integration source: `d10/nightly-demo-readiness-20261014` (Draft PR #14). Both agent branches MUST fork from the exact same commit after this governance document is committed.
This document does NOT itself start agents, run tests, authorize deployment or certify a feature.

## 0. Inviolable rules

- Two *different* clean isolated Git worktrees, two different feature branches, shared frozen BASE_SHA.
- **HARD EXCLUSIVE FILE OWNERSHIP.** No overlapping tracked filenames, even seemingly harmless one-line edits; no simultaneous changes to route contracts or shared interfaces by separate agents.
- Claude Code = P0 executable internal approval-to-Vault feature. Codex = independent demo QA, evidence and non-mutating certification scripts. Codex MUST NOT modify any application runtime source or tests that Claude may need.
- No agent can integrate the other's work or edit the common integration branch. One owner/maintainer integrates sequentially after two stop-gate reviews.
- `main`, `public/main-surface.js`, `public/main-surface-rearchitecture.css`, Voice WIP, `tests/test-contract.registry.json` and `tests/test-scope.registry.json` are special:
  - Voice WIP and Main UI/CSS: **neither agent may touch**; UI addition for Claude is deferred to a single future integrator slice. If required to certify user UI, report BLOCKED, not a fake pass.
  - Test registries: owned exclusively by Claude for tests Claude adds. Codex may inspect them READ-ONLY and must not add `tests/*.test.ts` in this parallel phase; Codex can write standalone `*.mjs` certification scripts under its exclusive path.
- If a task requires an unowned file, do not edit it. Stop that subtask, add a short requested-file-change section in your own report; integration owner assigns a sequential follow-up. **No permission-by-assumption.**
- No branch rebasing or cherry-picking the other agent while both work; no force-push, resetting or cleaning unrelated WIP.
- No change to test-server `bcd7e10` / `nagex.service`, `/var/lib/nagex`, scheduled jobs, secret settings, external messages, payments, connected accounts or any real provider action. OAuth sessions never exported.
- Approval first. Internal approved save is owner-local and still must have a real authorization boundary. No simulated completion counted as hosted success.

## 1. File ownership matrix

| Path / responsibility | Claude Code (A) | Codex (B) | Why |
|---|---|---|---|
| `src/capabilities/**` | WRITE only necessary files | READ ONLY | broker/registration |
| `src/workspace/**` | WRITE only necessary files | READ ONLY | canonical Vault persistence |
| `src/governance/**` | WRITE only if specifically required | READ ONLY | ActionApprovalStore invariants |
| `src/tasks/**`, `src/planning/**` | WRITE only necessary files | READ ONLY | approved continuation/eligibility |
| `src/app/**`, `src/http/routes/**`, `src/tools/**` | WRITE only approved feature slice | READ ONLY | wiring |
| `tests/*.test.ts`, `tests/_*.ts`, test registries | WRITE ONLY Claude's relevant new/changed suite; exact paths staged | READ ONLY | no collisions |
| `public/**` (JS/CSS/HTML/i18n) | READ ONLY | READ ONLY | leave user-visible UI and Voice WIP to integrator |
| `scripts/demo-certification/codex/**` | READ ONLY | WRITE | standalone isolated QA |
| `docs/evidence/NAGEX_D09_CLAUDE_VAULT_APPROVAL_*.md` | WRITE | READ ONLY | distinct reports |
| `docs/evidence/NAGEX_D09_CODEX_DEMO_AUDIT_*.md` | READ ONLY | WRITE | distinct reports |
| `docs/adr/**` | No new ADR unless needed, coordinate integrator | READ ONLY | avoid conceptual contract drift |
| `package*.json`, lockfile, deployment scripts, service config | READ ONLY | READ ONLY | avoid dependency/deploy drift |

**Boundary detail:** Claude must avoid changing public/** despite the feature needing a Home affordance; it can certify canonical HTTP + service interactions with a real local browser/test harness and document a **single integration-owned UI wiring task** to be done after merge. This is preferable to two agents editing the same composer. Codex must not add a second production API, mock a connected app, or commit any fixture into production data.

## 2. Track A — Claude Code: one real approval-gated internal Vault save

Read `docs/evidence/NAGEX_D09_IN_APP_APPROVAL_ACTION_IMPLEMENTATION_20261015.md` first.
- Trace `workspace.prepare_draft` tool catalog vs missing canonical capability registration/broker execution. Implement smallest real server-side save through the existing `QuickCaptureService` owner Vault store, existing `ActionApprovalStore` and P02 TaskContinuation path. NEVER create parallel approval/executor.
- Exact preview including non-secret title/body/destination; server checks identity, scope, content hash and persistence. Plan seal carries exact reviewed action. No write on proposal; write once only after Approve, never on reject/expiry.
- Replays, concurrent approvals, restart at APPROVAL_REQUIRED, wrong user/tenant, changed payload or tool, unavailable store, truncated/empty data, path traversal all fail closed.
- If new durable idempotency cannot be guaranteed across restart, report BLOCKED and preserve existing code, rather than falsely claiming exactly-once.
- Handle risk correctly: owner-local saving should not add approval to every ordinary note; the demo's explicit approval-gated operation is a distinct deliberate action.
- Integrate eligible capability with existing PlanResolver and broker; NO product UI edits (public/** disallowed). Provide API shape and exact integration-owned front-end changes requested.
- Register every new `tests/*.test.ts` in both registries on Claude's branch; never remove assertions or fake external provider.
- Run `npm run build`, focused suite, `npm test`, `npm run test:browser-cert`, plus owner-specific security tests. Use disposable stores only.
- Outputs: isolated branch `feature/claude-approved-vault-20261015`, Draft PR, source SHA, `docs/evidence/NAGEX_D09_CLAUDE_VAULT_APPROVAL_CERT_20261015.md`.
- If change requires public/** or a migration requiring operator sign-off, stop that portion with a documented handoff for integrator.

## 3. Track B — Codex: independent no-overlap demo QA and certification

- DO NOT edit runtime/production sources (`src/**`, `public/**`), regular test files or registries.
- Read PR #14's routes, One Input and reviewed plan, current process/version report. Inspect and test without applying fixes to shared runtime files.
- Add only standalone, isolated, opt-in QA scripts in `scripts/demo-certification/codex/**` and own report `docs/evidence/NAGEX_D09_CODEX_DEMO_AUDIT_20261015.md`.
- Focus on three demo user stories with deployed reality separated: a) KO/EN natural language advice/action classification and fallback, b) actual document create→save→Recent→Open using a disposable in-process server/data and authorised model route where available, c) approval gate negative tests / no unauthorized external action.
- Provide evidence of route correctness, which browser path calls which endpoint, language consistency, model latency, saved artifact reopen, and backend user/tenant isolation; do not mutate hosted data.
- Audit safe tool availability on test host **read only**, and identify a viable harmless tool. If no real approval-gated tool exists, report BLOCKED. Never create an MCP server, connect provider or invent a Connected badge.
- Check video story beats and exact blockers, do not claim real hosted end-to-end PASS from local fakes or dry-run.
- Recommend timeouts, fallback choice based on observed data only; do not change `NAGEX_NEBIUS_TIMEOUT_MS`.
- Output: branch `qa/codex-demo-readiness-20261015`, Draft PR or independent compare, evidence report and exact safe operator actions.
- Scripts must NOT require production session cookie, and must not access/write persistent `/var/lib/nagex` or external secrets.

## 4. Mandatory collision detector for BOTH agents

Before **each** push:
1. `git diff --name-only BASE_SHA...HEAD` and list every modified/new path.
2. Compare every path to your exclusive allowlist. Any unowned path = **STOP**, undo only your own change safely, never clean/delete another worktree.
3. Before integrating, integration owner fetches both refs, records `BASE_SHA`, does `git diff --name-only base..branchA` and `branchB`; intersection MUST equal empty set. If not empty, no automatic merge.
4. With zero file intersection still review **semantic conflicts** (new backend API contract vs QA expectations); land A first on a fresh integration branch, then B, with full gates and a real Browser certification.
5. Integration owner handles future UI wiring/Voice conflict **serially**, not in either agent branch. Each agent must explicitly say whether some user-visible functionality is deferred.

## 5. Integration owner / release control

- Only one owner touches `release/nagex-demo-20261025` (create it separately after both PASS); may be Codex in a later **dedicated non-parallel phase**, but not Track B during parallel work.
- Baseline release candidate must be built/tested independently. After integrating A then B, run `npm run build`, `npm test`, `npm run test:browser-cert`, focused approval/security tests, EN/KR 1440/430/390/360 and origin-pinned actual browser/UI flow.
- Never confuse completion of Track A's server APIs with fully wired Home user experience. Real signed-in hosted approve→save stays NOT_RUN until the integrator-owned UI and later permitted deployment.
- Use explicit operator approval for test-server backup/cutover/restart and any hosted writes. `main` merge is deferred.

## 6. Mandatory stop rules

Stop only the affected slice and report when:
- needing a file outside your write allowlist; first give the integrator a precise change request;
- implementing would weaken required approval, allow executing a changed payload, or write before approval;
- nondeterministic duplicate writes, storage rollback/integrity concerns, or unexpected real external calls;
- creating/updating any shared state or account without authorization;
- failing build/regression/browser gates after bounded diagnosis (never suppress failures).

No broad refactor, new modes, UI redesign, Voice WIP integration, enterprise extension, uncontrolled scope growth.

## 7. Morning results

A report and B report must each state actual source HEAD, TESTED_SHA, scope/file list, completed/blocked items, exact tests PASS/FAIL/SKIP, mock vs local real HTTP vs live provider vs hosted, next file requests and next operator action.
Neither agent may state 'merged', 'deployed', or 'real approved action' without independently observable evidence.

This plan's success metric is **zero overlapping changed files and one safe, owner-bound approval-to-result path**, not agent output volume.

# NAgex D-09 — SERIAL integration order: Vault action in Home
Date: 2026-10-15 KST
Integration branch: integration/d09-vault-home-20261015
Source: feature/claude-approved-vault-20261015 (Draft PR #15); Codex QA branch qa/codex-demo-readiness-20261015 (Codex-only files)
Status: IMPLEMENTATION ORDER, NOT AN INTEGRATED/DEPLOYED FEATURE

## Non-negotiable sequencing
1. **One integrator exclusively controls this branch.** Claude/Codex parallel agents must STOP editing common source. Never merge to main, deploy, restart nagex.service or touch live tenant data without explicit operator approval.
2. Verify both branch SHAs and changed-file intersection (reported 0: PR #15 25 paths, Codex 2). Bring Codex's standalone QA script/report into the integration branch **only after** UI implementation and source review; do not blindly merge the whole branch.
3. Home UI implementation only after reading the actual API and source under PR #15, using prototype as guide, not an authoritative patch. Freeze API; if incompatible, STOP for backend coordination. Preserve One Input + Ask-free interaction.
4. Keep Voice WIP untouched. No blanket `git apply` of F:\nxv patch: it was based on older UI, proven desktop only; transfer small changes manually and validate.
5. Integrator owns `public/main-surface.js`, `public/i18n.js`, `public/main-surface-rearchitecture.css` and any mobile navigation file it has explicitly audited. No other agents change these simultaneously.

## Required Home user-visible journey
- "회의 요약을 내 보관함에 저장해줘" (with concrete user text or current answer) → automatic `VAULT_SAVE` decision → `POST /api/v1/ambient/intent` with `saveContext` only when appropriately bound to user's visible prior answer.
- Handle NEEDS_DETAIL with one truthful clarification; no empty draft, fabricated meeting text or side effect.
- For PLAN_PREVIEW with tool `vault.save_note`, show **FULL exact content**, title, source, destination with safe text nodes (no unsafe HTML). Preserve whitespace and scrollability. Don't leak sensitive prior context into unrelated requests.
- Show explicit Request Approval action only if `runnable.ok` and sealed server plan is valid. Approval request must NOT write to Vault; approval detail must match content/target exactly.
- After explicit Approve, show "보관함에 저장했어요" only when `SAVED_TO_VAULT` and verification status VERIFIED. If failed/declined/expired, never mark saved.
- Open saved `vaultItemId` through existing owner-authenticated Vault UI; don't open a guessed URL. Test reload/reopen/owner isolation.
- Handle re-asking identical text after decline/expiry as a fresh preview while preventing duplicates from same preview (Claude A fixed nonce claim).
- Ensure generic "메모:" capture and direct Save to Vault remain unchanged and do not acquire mandatory approval.

## Mobile P0
Prototype failed 430/390/360 because `#vault-recent-list` was hidden by tab/navigation rules after hash navigation. Diagnose existing mobile Vault panel/tab visibility and hash-to-tab state; fix the actual navigation contract, not a CSS `display:block !important` that hides other panels or breaks accessibility.
At EN+KR, 1440/430/390/360 certify: draft preview, approval request, Approve and Decline, saved note Open, Vault visibility after navigation, keyboard focus, 44x44 touch controls, zero horizontal overflow.
Do not claim mobile PASS based only on an isolated backend HTTP browser test.

## Test gating and known environmental issue
- `npm run build`, `npm test`, `npm run test:browser-cert` at final exact source SHA.
- Original Chrome suite at default parallelism failed inconsistently on both untouched PR #14 and PR #15 source on busy workstation. Reduced concurrency 4 PASS (305 tests) proves bounded suite stability but **does not erase default-gate failure**. Re-run on quiet machine at default first; capture logs and distinguish environment from product; if a deterministic concurrency policy is needed, update gate runner in **this integrator branch only** with a documented rationale and run same file set unchanged.
- Codex's document browser chain was TIMEOUT/UNVERIFIED at 180s (worktree default directory permission then timeout). Re-run with truly isolated writable data root; record timings, model stub vs live model. Do not raise timeout to force a pass or drop assertions.
- Total SKIP discrepancy: Codex regression 9 skips, Claude regression 8. Diagnose environment/selection; don't mask the difference.
- New UI tests, if added, must be registered in contract and scope registries; integration owner now owns them.
- Independently inspect `VaultStore.saveItemOnce` failure semantics; report existing unrelated `POST /api/v1/workspace/vault` write-error swallowing as separate defect and fix only if proven in scope without altering approved path.

## Release decision / strict acceptance
- PR #15 backend and Codex QA may be merged sequentially into the isolated integration branch after no-collision review. No direct merge to main.
- GO for demo candidate only if UI + backend joined with zero tests failing on a controlled final gate, real browser mobile Vault Open works, no phantom save, and all approval/tenant/replay invariant tests stay green.
- Hosted signed-in E2E remains NOT_RUN until explicit deployment authorization; server expected old bcd7e10.
- Existing Voice WIP must be merged in a separate later serialized review with targeted Voice and Home browser gates; it is not a prerequisite for Vault demo unless the user explicitly promotes it.

## End-of-task delivery
Write `docs/evidence/NAGEX_D09_HOME_VAULT_INTEGRATION_CERT_20261015.md` with base/final/tested SHAs, touched files, A/B overlap check, backend contract, Home + mobile proof, browser concurrency repro, Codex timeout resolution, counts, screenshots/evidence, Voice conflict, rollback and precise deployment NO-GO/GO recommendation. Push branch and Draft PR only. Request separate approval before server cutover or any actual hosted write.

# NAgex — Overnight Autonomous Development Directive (D-10 → D-9)
**Issued:** 2026-10-14 night (KST)  
**Hackathon video window starts:** 2026-10-25  
**Repository:** redcloudyun-cmyk/nagex  
**Development baseline:** `d11/one-input-intent-20261014`  
**Last user-reported HEAD:** `559cf30` — fetch and verify current origin; never assume HEAD stays fixed  
**Deployment baseline:** test server reportedly runs `bcd7e10`, PID 2997023, health 200; **NOT** One Input or reviewed-plan execution  
**Scope:** NAgex PERSONAL AI ONLY; never mix AGEX enterprise or unrelated projects  
**Classification:** work order, NOT a completion certificate or authorization to deploy/mutate production data.

## 0. Primary mission
Ship the smallest fully **truthful and demonstrable** user journey:
**One natural-language request → automatic intent/available capability → real NVIDIA Nemotron response → actual stored/reopenable document OR explicit user-reviewed plan → Human Approval → single actual benign authorized action → Activity proof.**

Make NAgex easier to use, not more complicated. User does not choose Ask, Research, Document or Plan. Preserve "One Input. Any Outcome. Human in Control." Do not add more modes, broad marketplace cards, enterprise work or an alternative executor.

The video date is close. Prefer **one end-to-end real success** over ten partially implemented features.

## 1. Evidence on hand (do NOT inflate)
- One Input code: server-owned `RoutingDecision`, compact composer, collapsed My Day, 한국어 "보관함에 저장"; local gates `npm test` **2915/2907 pass/0 fail/8 skip**, browser **269/263 pass/0 fail/6 skip**, as previously reported.
- Home reviewed-plan approval execution work: branch `d11/one-input-intent-20261014`, user-reported HEAD `559cf30`; `npm test` **2941/2933 pass/0 fail/8 skip**, browser **279/273 pass/0 fail/6 skip**, and focused 22 isolated ownership/approval/replay tests and 10 real-Chromium approval/decline clicks.
- New `POST /api/v1/tasks/from-reviewed-plan`: server-bound sealed **single approval-gated step**, frozen resolved plan, existing `ExecutingTaskRunner`, `CapabilityBroker`, `ActionApprovalStore`, P02 continuation. No model re-plan during approval; no external effect before explicit human approval.
- Live Nemotron (development-only certification script): 5/5 one-step tool plans; real Korean/English report generation + persistence tested in an **isolated temporary store**, not hosted user end-to-end.
- **Hosted service is still old**: `bcd7e10` previously confirmed live. Hosted real document create/Open and approved benign MCP execution **NOT_RUN**.
- Google Calendar/Gmail action client credentials reportedly absent on the test server. Slack real MCP OAuth remains unverified and outside this deadline critical path.
- 30 fixture-owned RECURRING tasks previously paused on the test server; preserve that state. No user/demo tasks may be touched.

## 2. Autonomous execution boundary (strict)
**Allowed unattended:** fetch/inspect code, isolated worktree changes, additive test fixtures with disposable stores, local build/tests, review and fix findings, commit/push a bounded feature branch, GitHub PR evidence, read-only external public metadata, dry-run deployment plan.

**Requires separate explicit human authorization (DO NOT DO tonight):**
- `main` merge or deployment/swap/restart of `nagex.service`, Cloudflare/DNS or systemd config changes.
- Creating accounts, bypassing Google/Microsoft OAuth, persisting/sharing login sessions/cookies, using real user secrets, changing environment/provider configuration.
- Writing to test/production user data (`/var/lib/nagex`), pausing/deleting/reenabling tasks, creating or approving real consequential actions, contacting real recipients, sending email, making calendar events, payment, booking, posting or deleting.
- Arbitrary external actions, real public MCP provider actions, unapproved spending or quota expansion.
**No fake success.** A local fake service PASS is not hosted/live service PASS. Approval recorded is not proof of actual execution. `TOOL_RESPONDED` is not verified remote side effect.
**Never** dump secrets to logs, terminal, screenshots, GitHub, docs or conversation. No `git reset --hard`, `git clean`, force push, `git add .` or blind WIP overwrite.

## 3. Parallel-safe worktree strategy
1. `git fetch origin` and inspect `git status --short`, all `git worktree list`, branch topology and candidate/baseline SHAs.
2. Create a new isolated clean worktree/branch (e.g. `d10/nightly-demo-readiness-20261014`) **from latest verified origin/d11/one-input-intent-20261014**. Do not modify Windows main checkout with existing Voice WIP or any tracked/untracked artifact directory.
3. Commit exact changed files only. Push feature branch; open a Draft PR toward `d11/one-input-intent-20261014` or annotate precise compare URL. Do not merge, rebase other people's branch, or deploy.
4. A code change affecting runtime requires full gate rerun at final exact SHA and updated test registry entries. If other agents push while running, stop before overwrite, compare and reconcile.

## 4. P0 TASK A — Security and truth audit of reviewed-plan execution (first)
Read source, not just the ADR:
`src/planning/plan-seal.ts`, `src/planning/reviewed-plan-eligibility.ts`, `src/http/routes/tasks.routes.ts`, `src/http/routes/conversation.routes.ts`, `src/tasks/runners/executing-task.runner.ts`, `src/capabilities/capability-broker.ts`, `src/mcp/mcp.service.ts`, `public/main-surface.js`, P02 approvals.
- Independently trace **plan shown → seal → exact bound plan → task/approval request → explicit user Approve → continuation → broker action → persisted outcome**. No new tool args, owner, tenant, recipient, target, schema, or action may be swapped after preview/approval.
- Test 401/403, wrong owner/tenant, stale/foreign-process seals, duplicated/concurrent clicks, replay, token expiry, missing arguments, denied approvals, provider error, capability changes and unauthorized direct POST. Verify no external tool call until human approval.
- Investigate F1/P02 asynchronous approval continuation after process restart and approval expiry; classify blocker vs accepted safe degradation. Do not introduce unsafe retry or broad multi-step auto-execution.
- Verify `runnable` is derived from **current** provider/tool availability and not accepted from browser input. Verify source-of-truth audit and one-time execution.
- Fix only reproducible P0 defects. If no defect, report PASS with code+test evidence; do not rewrite the architecture merely to generate commits.

## 5. P0 TASK B — Actual document artifact chain in controlled local test
Certify with **real existing creation and persistence contracts**, no fabricated PDF/DOCX or front-end-only success:
- natural Korean/English input with **no selected mode** → `route-input` → `DOCUMENT` → real model (where sanctioned test credentials already available) → stored `DocumentStore` / `ArtifactStore` → Recent → Open after fresh browser/restart → own-tenant only.
- For research→document: write only from verified returned sources, trace sources, fail closed if research unavailable. Never claim unverified web references.
- Exercise failure paths: no provider, missing document source, storage offline, partial generation, cross-user data access and repeated click. Prevent "created" in UI if persistence failed.
- If real model credential or source is unavailable, continue with isolated deterministic integration and classify live-hosted outcome NOT_RUN, not PASS.
- Real hosted **signed-in** E2E must wait for a user-run browser after explicit deployment authorization. Do not request cookie exports.

## 6. P0 TASK C — Safe harmless action demo route (no custom public server unless needed)
Explore existing configured tools and actual capability state **read only**. Pick exactly **one** benign demo tool with an auditable visible result. Order:
1. Already supported owned in-app capability that is truly approval-gated and can be observed without harming external people/data.
2. Existing user-approved non-destructive browser tool to a disposable allowed target, if the runtime and approval contract are real and stable.
3. Public HTTPS MCP echo/note only if provider configuration is authorized; do **not** register a remote service without human approval. Do not suggest a non-existent MCP provider as connected.
If no safe real provider is currently configured, **stop that hosted live gate as BLOCKED** and finish code/integration certification instead. Don't water down approval requirements to manufacture a demo PASS.
Keep Google Calendar/Gmail/Slack disallowed until properly operator-configured; never send real data.

## 7. P0 TASK D — One Input intent quality and end-user outcomes
Measure and fix only top failing user journeys. Dataset with KO+EN, negatives, compound and ambiguous:
A advice; B schedule meeting; C research with real sources; D write one-page meeting report; E create slides from provided topic; F image; G video/code unsupported truthful; H research→document; I explain + send; J delete document; K "보내지 말고 초안만"; L vague request; M tool named naturally.
**Required:** intent, chosen real backend route, artifacts and their actual existence, action permission, user-language output, fallback reason, no false "Completed". Single input must not leak legacy mode selection.
Compound research→slides lacks browser cert and research→image currently ignores research — either certify/fix within 25th demo needs or clearly mark as not supported (don't present half-done chain as complete).
Do not expand large catalogs, sophisticated new agent planning, broad natural language coverage, video/model build or fancy designs.

## 8. P1 TASK E — Short UI acceptance audit (only after P0)
Preserve compact composer already measured ~119px desktop; + menu for optional shortcuts, no required Ask/Research/Plan choice. My Day collapsed by default; calendar/To-do/Today data remains discoverable and honestly empty if disconnected.
Verify Korean labels "보관함에 저장", separate "이어서 질문" button, keyboard focus, accessibility, no EN output from Korean request, desktop 1440 + mobile 360/390/430. Keep existing Voice WIP out of this branch; record specific merge conflicts, don't automatically merge.
Fix only user-visible P0/P1 regressions. No full redesign.

## 9. Live model and timeout policy
Real Nebius/NVIDIA Nemotron first must be preserved for CHAT/PLAN/RESEARCH_SYNTHESIS/MEETING_PREP/DOCUMENT_SYNTHESIS. Legitimate Gemini fallback remains with stable `model_fallback` audit and no secret data. Avoid promoting a 60-second TIMEOUT to a general provider outage.
**Do not** blindly set `NAGEX_NEBIUS_TIMEOUT_MS=90000`. Compare latency/p95, UI 120s timeout, retry behavior and cost; changing server env needs operator approval. The video may use truthful cut/editing over a real call. Do not falsify latency or model trace.

## 10. Test requirements & evidence
- Register any new `tests/*.test.ts` in both `tests/test-contract.registry.json` and `tests/test-scope.registry.json`; classify honestly.
- Run `npm run build`, targeted security/intent/document suites, `npm test`, `npm run test:browser-cert` on the exact final source with 0 failures.
- Include strict self-contained tests against isolated local HTTP/MCP servers and Chromium EN/KR 1440/430/390/360. Avoid tests depending on shared /var/lib/nagex state, real messages, token writes, or web providers with credentials.
- If flaky, capture exact error, compare untouched base with the same test method, fix root cause or mark BLOCKED. Never drop assertions, fake pass, suppress stderr or inflate timeouts indiscriminately.
- Record tests total/PASS/FAIL/SKIP, tested SHA, test duration, scope and external-vs-fake evidence.

## 11. End-of-night outputs (required)
Create `docs/evidence/NAGEX_D09_OVERNIGHT_REPORT_20261015.md`, containing:
- `BASE_SHA`, `FINAL_SHA`, `TESTED_SOURCE_SHA`, `GIT_BRANCH`, `CURRENT_DEPLOYED_SHA`
- `REVIEWED_PLAN_SECURITY`, `APPROVAL_NO_PREEXECUTION`, `OWNER_ISOLATION`, `REPLAY_PREVENTION`, `REAL_APPROVE_EXECUTE_HOSTED`
- `DOCUMENT_CREATE_LOCAL`, `DOCUMENT_REOPEN_LOCAL`, `DOCUMENT_CREATE_HOSTED`, `RESEARCH_DOCUMENT`
- `ONE_INPUT_KO_EN`, `COMPOUND`, `UNSUPPORTED_TRUTHFUL`, `VOICE_WIP_CONFLICT`
- `LIVE_NEMOTRON`, `FALLBACK`, `BUILD`, `REGRESSION`, `BROWSER_CERT`, `DEPLOYMENT`, `MAIN_MERGE`.
Each field PASS/FAIL/BLOCKED/NOT_RUN as appropriate; never convert an unexecuted live gate to PASS.
Give an executive Korean morning handoff: (1) what changed; (2) 25th demo readiness; (3) severe blockers; (4) specific 1–3 operator actions; (5) exact copyable commands for later authorized deployment, with safe stop/rollback steps.
Push commits + Draft PR/PR comment with real evidence. No merge or deploy.

**Overnight stop points:**
- Any unauthorized mutation, lost approval boundary, secret exposure, dependency on unapproved external transaction, store corruption or persistent-state migration risk → STOP that slice, preserve logs and code, report P0.
- If a blocker needs a real human OAuth sign-in, do not wait idle; continue safely with tests, design review and documentation.

**Success is not more commits. Success is the smallest truthful NAgex that makes the user's work easier and can demonstrate a real result on October 25.**

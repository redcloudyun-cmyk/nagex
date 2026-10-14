# NAgex D-11: Demo-first Release Lock and Video Plan
Date: 2026-10-14 (KST)
Video target begins: 2026-10-25
Owner decision: prioritize demonstrable, stable Personal AI over further breadth.
Branch where this plan is tracked: integration/r23.7-agex-mcp-20261013
**Planning artifact only. This is not a deployment, acceptance certification, or a feature claim.**

## A. Baseline facts vs unverified assumptions
- Repository README identifies Nebius × NVIDIA Global AI Hackathon and NVIDIA Nemotron as core AI execution path. Check exact 2026 hackathon submission requirements before locking final video format and deadline.
- At inspection time, integration branch was ahead of main by 184 commits, behind 0. This is a **branch comparison**, not deployment evidence.
- MCP OAuth PR #13 has reported isolated regression/browser tests, but real Slack OAuth and real provider tool invocation are BLOCKED. Keep it out of the demo critical path.
- Deployed candidate version and actual Node process must be independently checked on the test server, not inferred from the Git working tree. Existing server process reported pending restart; don't assume deployed parity.
- Creator, Slides, Images, Recent, Workspace, Approval, model routing and other features have automated test coverage in this repository. These do not prove external production/provider setup or a successful end-to-end consumer task.

## B. Showcase contract — one continuous main journey
The first sixty seconds should not look like a generic planner.

1. **Ask / Understand:** A real signed-in demo persona requests: 'Prepare a concise briefing for tomorrow's meeting, use what you remember about this project, draft a one-page summary, and suggest the next action.' The NAgex Home agent must genuinely receive input and show context used. No fabricated memory or events.
2. **NVIDIA/Nebius AI reasoning:** Show the real task-aware model route and Nemotron/Nebius provider execution in verified audit/evidence, without revealing provider secrets or presenting internal model routing jargon to ordinary users.
3. **Create:** Deliver one actual document (or slide deck, if fully certified) saved to the owner's Recent/Workspace, reopenable after refresh. Do not substitute a mock success card or screenshot of a document not actually created.
4. **Action with control:** Display a real proposed action, precise recipient/target/arguments, the Human Approval step, one controlled execution, and truthful activity/verification result. Choose a non-destructive available tool for the production demo; do not rely on unregistered Slack MCP.
5. **Continuity:** Reopen history or Memory, show the resulting record persists for the account (and another account cannot see it).
6. **Mobile preview:** brief matching responsive 390px view (no separate mobile feature demo necessary).

Do not claim all six stages are working merely because their components are implemented separately. Verify one full chain **on the target deployed build**.

## C. D-11 priority table
| Priority | Action | Gate to exit | Cut rule |
|---|---|---|---|
| P0 | Identify target video/runtime branch, SHA, deployed process, env readiness, external AI route without exposing credentials | Git SHA = serving revision, /health 200, actual Nemotron route and one real request verified | Do not patch UI before this |
| P0 | Certify agent Ask → context → Nebius/Nemotron answer; one continuous scenario | Real input, real model response, deterministic logs/record | If live model unavailable, fix config; never fake |
| P0 | Certify one result artifact: document or PPTX; persisted and reopenable | Real artifact, correct file/open URI, account isolation | Do not insist on more than one creation medium |
| P0 | Certify safe Action + Human Approval + audit, via an existing configured provider | No action before approval, one after; truthful result | Switch to a known-working tool, not new Slack integration |
| P0 | Full release hygiene: frozen revision, npm build/test gates, smoke, rollback plan | PASS build/regression/browser, known skips and zero P0 bug, rollback ready | No merge/deploy if not met |
| P1 | User-visible EN/KR clarity and desktop/mobile overflow correction | 1440 desktop + 360/390/430 mobile critical journey no crash/raw keys | Cosmetics only after P0 |
| P1 | 60-90s clean script, capture and dry run | Same E2E path recorded 3 consecutive times on deployed candidate | If unstable, trim storyboard, don't fake |
| PARK | New MCP OAuth provider, app marketplace expansion, enterprise, fresh redesign, token refresh implementation without demo dependency | Track branch and debt separately | Do not expand before Oct 25 |

## D. Day-by-day execution and release gates
| Day | Date | Deliverable |
|---|---|---|
| D-11 | Oct 14 | Inventory truth: deployed SHA/process vs integration/PRs; select canonical demo script; list P0 blocks; no merge yet |
| D-10 | Oct 15 | AI route/actual model test with verified Nebius/Nemotron call and target environment |
| D-9 | Oct 16 | Real report/document artifact creation, persistent Recent/Open test |
| D-8 | Oct 17 | Approval → execution → Activity proof with safe target |
| D-7 | Oct 18 | Full-chain E2E on a disposable signed-in demo persona |
| D-6 | Oct 19 | Cross-account isolation, EN/KR and 360/390/430 mobile gate; eliminate P0 bugs |
| D-5 | Oct 20 | Select final demo release candidate; contingency route defined |
| D-4 | Oct 21 | **Feature freeze**: stop new feature development, only P0/P1 blockers and evidence |
| D-3 | Oct 22 | Release build + test + smoke on controlled test server; prepare rollback |
| D-2 | Oct 23 | Repeat whole demo at least three times with matching deploy SHA; record raw takes |
| D-1 | Oct 24 | Final video cut, audio/text/submission checklist and asset backup |
| D-Day | Oct 25 | Video/submission window begins; do only critical fix/rollback; archive SHA + evidence |

Video duration is **not assumed** here; check organizer requirements first.

## E. First executable work package: release truth inventory
In isolated local worktree and test server, capture and compare:
1. Local branches `main`, `integration/r23.7-agex-mcp-20261013`, `feat/mcp-oauth-discovery-20261013`; no force push or destructive cleaning.
2. Server `git rev-parse HEAD`, `git status --short`, `systemctl show -p MainPID -p ExecMainStartTimestamp -p FragmentPath nagex`, `/api/v1/health`, and current served frontend build version, if available. Treat a server checkout at one SHA and an old live PID as separate states.
3. Check config **presence only** (not values): active Nemotron/Nebius provider, API key, OAuth session, artifact persistence, approval store. Avoid printing secrets.
4. Report: `REPO_INTEGRATION_SHA`, `SERVER_CHECKOUT_SHA`, `RUNNING_PROCESS_SHA` (UNKNOWN if no reliable binary/version fingerprint), `LIVE_NEMOTRON`, `REAL_CREATION`, `REAL_ACTION`, `REAL_APPROVAL`, `UI_EN_KR`, `DEMO_E2E` as PASS / FAIL / BLOCKED / NOT_RUN.
5. No production restart, env modification, PR merge, UI rebuild, or other service changes without separate authorization. Read-only inventory first.

## F. Freeze governance
- All feature work that is not required for the six-stage journey is **frozen**, including Slack MCP OAuth live rollout.
- Single owner per P0 blocking issue, one revision and one acceptance proof per fix.
- Do not inflate gate PASS: provider mocks are not real external execution. Browser tests on local fixtures are not deployed-browser certification.
- Demo persona uses synthetic information by design, but each operation must really execute; disclose any intentionally seeded data in backstage evidence.
- Known blockers and limitations appear in internal runbook. Avoid exposing security internals in end-user UI.
- Candidate cannot be labelled 'release-ready' until actual hosted smoke/E2E is run and the branch/process parity is established.

## G. Next team/agent instruction
Perform **read-only inventory** above and produce `docs/evidence/NAGEX_D11_BASELINE_AUDIT_20261014.md`, followed by bounded implementation only for independently verified P0 blockers.
Keep AGEX (enterprise AI OS) and all other projects unrelated to NAgex out of this work.

**Definition of success:** user sees a real intelligent Personal AI performing a real creation and a user-authorized action, rather than a planner-only mockup.

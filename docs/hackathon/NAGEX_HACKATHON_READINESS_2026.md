# NAgex Hackathon Readiness Audit

Status: DRAFT
Base SHA: 5edd3874a57ffd5174944b531b2c7f0266b091a1
Audit date: 2026-10-06

Official source checked: https://nebiusglobalaihackathon.devpost.com/

The Devpost overview says submissions must run on Nebius Token Factory or Nebius AI Cloud and use at least one NVIDIA open source model. It also requires a working project, category, project description, working demo URL or test build, a 3-minute-or-shorter public YouTube demo video, a public code repository with an open source license visible at the top of the repository page, README setup instructions, a description of NVIDIA/Nebius use, feedback on Nebius/NVIDIA tools, and a significant-update explanation if the project existed before the submission period.

## Requirement Check

| Requirement | Result | Evidence / Notes |
|---|---:|---|
| WORKING_PROJECT | YES | Deployed app and local test/build history exist; current deployed health passed. |
| WORKING_DEMO_URL | YES | https://nagex-test.agex.site |
| PUBLIC_REPOSITORY | YES | GitHub page shows `redcloudyun-cmyk/nagex` as Public. |
| OPEN_SOURCE_LICENSE | YES | Root `LICENSE` file present. |
| LICENSE_TYPE | MIT | README and root `LICENSE` agree. |
| README_SETUP_INSTRUCTIONS | YES | README contains setup commands and a concise hackathon section. |
| NEBIUS_USAGE_DOCUMENTED | YES | README and `docs/evidence/NAGEX_NEBIUS_NEMOTRON_RUNTIME_EVIDENCE.md`. |
| NVIDIA_NEMOTRON_USAGE_DOCUMENTED | YES | README and Nemotron evidence docs. |
| SIGNIFICANT_UPDATE_SINCE_2026_08_26 | YES | See `docs/hackathon/NAGEX_SIGNIFICANT_UPDATES_2026.md`. |
| DEMO_VIDEO | NOT_READY | Storyboard exists; public YouTube video not yet recorded/uploaded. |
| DEMO_VIDEO_MAX_3_MINUTES | NOT_APPLICABLE | No video yet. |
| NEBIUS_FEEDBACK_PREPARED | YES | See `docs/hackathon/NAGEX_NEBIUS_FEEDBACK_DRAFT_2026.md`. |

Requirements met: 10/11.

Not ready:

- final public demo video under 3 minutes.

## Track Recommendation

PRIMARY TRACK: Personal AI

Evidence:

- Memory across sessions: persistent memory and personal context updates were implemented after project start.
- Personal context: current personal context aggregation and personal home surfaces are implemented.
- Proactive assistance: daily brief, meeting prep, personal watches, and action proposals exist.
- Task-aware reasoning: model routing uses TaskKind and selectively routes PLAN, RESEARCH_SYNTHESIS, and MEETING_PREP to Nemotron.
- Human approval: consequential actions go through approval stores and payload binding.
- Real actions: Google Calendar, Gmail, browser/device, mobile/SMS/messaging paths exist with governance boundaries.
- Multi-step workflow: durable task runtime, continuations, and audit/activity are implemented.
- Nebius/Nemotron integration: deployed certification passed for high-reasoning tasks.

Why other tracks are weaker:

- Best Apps and Agents: NAgex qualifies as an app/agent, but its strongest differentiation is personal memory, context, approval, and user-controlled autonomy, which maps more directly to Personal AI.
- Coding and Agentic Engineering: the repository contains strong agent engineering, but the product is not primarily a coding agent or developer tool.
- Physical AI: NAgex has mobile/device control work but no physical robotics/hardware operating demo.

## Hackathon Requirement Evidence Table

| Requirement | Evidence | File/module/test | Runtime proof | Status |
|---|---|---|---|---|
| Nebius Token Factory runtime use | Nebius provider adapter and deployed live call | `src/model-gateway/providers.ts`, `scripts/nebius-live-cert.mjs` | REAL_NEBIUS_CALL=PASS | PASS |
| NVIDIA Nemotron use | Model `nvidia/Nemotron-3_5-Lightning` configured and live | `src/model-gateway/providers.ts` | PLAN/RESEARCH/MEETING_PREP actualProvider=nebius | PASS |
| Working application | Deployed app health | `src/server_web.ts`, public assets | LOCAL_HEALTH=HTTP 200, PUBLIC_HEALTH=HTTP 200 | PASS |
| Task-aware routing | TaskKind preference table | `src/model-gateway/model-routing-policy.ts` | PLAN/RESEARCH/MEETING_PREP route to Nebius; CHAT/DAILY/STRUCTURED do not | PASS |
| Real multi-step Personal AI behavior | Task runtime and approval-aware execution | `src/tasks`, `src/workflows`, `tests/workflow_definition.test.ts` | Demo scenario pending final recording | PARTIAL |
| Memory/context | Persistent memory and personal context | `src/context`, `src/home`, `tests/r22_3_personal_context_memory.test.ts` | Demo-visible in personal home/context surfaces | PASS |
| Human approval | Approval store, payload binding, approval UI/tests | `src/governance/action-approval.store.ts`, `tests/action_proposals_safety.test.ts` | Approval path remains separate from model routing | PASS |
| Action execution | Calendar/Gmail/mobile/browser execution routes | `src/modules/calendar`, `src/modules/gmail`, `src/messaging`, `src/device-agent` | Some actions live-capable; final demo path must be chosen | PARTIAL |
| Fallback behavior | 429/500/timeout/invalid response fallback | `src/model-gateway/unified-model-router.ts`, `tests/nebius_nemotron_provider.test.ts` | Deployed certification isolated fallback PASS | PASS |
| Secret protection | Provider credentials server-only; redaction tests | `src/model-gateway/providers.ts`, `tests/r23_4v_secret_non_propagation.test.ts` | Logs reviewed for certification window, no key leak found | PASS |
| Live deployment | Test server active | deployment runtime | https://nagex-test.agex.site/health = HTTP 200 | PASS |
| Public repository requirement | GitHub repo public | https://github.com/redcloudyun-cmyk/nagex | GitHub page shows Public | PASS |
| License requirement | Root MIT license | `LICENSE`, README.md | License visible in repository root | PASS |
| README requirement | Setup and hackathon section exist | README.md | Includes Nebius/NVIDIA provider, model, runtime tasks, architecture, verified status | PASS |
| Video requirement | Storyboard drafted | `docs/hackathon/NAGEX_DEMO_STORYBOARD_2026.md` | No public YouTube video yet | FAIL |
| Significant-update requirement | Eligible-period git history documented | `docs/hackathon/NAGEX_SIGNIFICANT_UPDATES_2026.md` | Commits after 2026-08-26 grouped by domain | PASS |

## Judging Alignment

| Criterion | CURRENT_STRENGTH | EVIDENCE | WEAKNESS | ONE_HIGHEST_VALUE_IMPROVEMENT |
|---|---:|---|---|---|
| Technological Implementation | 4 | Real Nebius/Nemotron routing, approval-gated actions, persistent memory, deployed health, fallback certification. | Final video still needs recording. | Record the 3-minute demo using the frozen scenario. |
| Design | 3 | Personal AI home, mobile shell, activity/context surfaces, approval UI. | Some UI/artifact work is still WIP and repo has many screenshot artifacts. | Record one polished scenario rather than trying to show every feature. |
| Potential Impact | 4 | Personal AI with memory, context, approval, real action, and privacy boundaries. | Scope is broad, so judges may miss the core value if demo is scattered. | Focus the submission story on "remembers, prepares, asks, acts." |
| Quality of Idea | 4 | Strong match to Personal AI track and Devpost guidance for context + real action. | Needs simple positioning against ordinary chatbots. | Use the line: "The model reasons. NAgex governs and executes." |

## Public Repo Risk Audit

Scope: tracked files only.

PUBLIC_REPO_SECRET_RISK=LOW

Findings:

- No actual operational API key was confirmed in tracked files.
- Several tracked tests contain synthetic secret-shaped values such as `sk-...`, `xoxb-...`, `Bearer ...`; each reviewed match is a SAFE_TEST_FIXTURE or SECRET_SCANNER_FALSE_POSITIVE used by redaction/auth-boundary tests.
- `tests/_enterprise_identity_crypto_helpers.ts` contains a static fallback test private key and certificate. The helper first tries to generate an ephemeral key/cert at test runtime with OpenSSL; the static key is fallback-only for environments without OpenSSL.
- The private-key fixture is test-only, not referenced by runtime code, and is required to exercise real OIDC/SAML signature verification without a live IdP.
- Submission-branch history was scanned with pattern-based git history search for common key/token/private-key shapes. No real credential was identified; historical matches are the same test fixtures/sentinels. Some binary/doc textconv warnings were emitted by Git tooling and were not treated as clean evidence for those binary contents.

Tracked match classification:

| Pattern / file | Classification | Reason |
|---|---|---|
| `tests/_enterprise_identity_crypto_helpers.ts` PEM private key/certificate | SAFE_TEST_FIXTURE | Test-only fallback for OIDC/SAML cryptographic verification; runtime has no reference. |
| `tests/astra_visual_execution_adapter.test.ts` `sk-super-secret-key-do-not-log` | SAFE_TEST_FIXTURE | Deliberate no-log assertion sentinel. |
| `tests/nebius_nemotron_provider.test.ts` / `tests/nebius_nemotron_routing.test.ts` `sk-NEBIUS...` | SAFE_TEST_FIXTURE | Fake provider credentials for router/provider tests. |
| `tests/r22_3_personal_context_memory.test.ts`, `tests/r22_4_evidence_pack_web_search.test.ts`, `tests/sensitive_text_redaction.test.ts` `sk-...` strings | SAFE_TEST_FIXTURE | Deliberate secret-redaction test values. |
| `tests/notification_engine.test.ts`, `tests/security_s2c_outbound_recipient_authority.test.ts`, `tests/slack_integration.test.ts` `xoxb-...` strings | SAFE_TEST_FIXTURE | Fake Slack token sentinels in mocked clients/tests. |
| `Bearer ...` literals in tests and session parsing | SAFE_TEST_FIXTURE | Synthetic auth header fixtures. |
| CSS `tokens.css` and code identifiers containing `token` or `key` | SECRET_SCANNER_FALSE_POSITIVE | UI/design token or map key terminology, not credentials. |

BLOCKERS:

- Demo video not yet recorded/uploaded.

Private-key fixture special review:

| Field | Result |
|---|---|
| WHY_REQUIRED | OIDC/SAML security tests need real RSA signatures and a certificate without calling a live identity provider. |
| WHERE_REFERENCED | `tests/enterprise_identity_oidc_security.test.ts`, `tests/enterprise_identity_saml_security.test.ts`, `tests/_enterprise_identity_test_idp.ts`. |
| TEST_ONLY | YES |
| RUNTIME_REFERENCE | NO |
| CAN_GENERATE_AT_TEST_TIME | YES when OpenSSL is available; implemented as the preferred path. |
| STATIC_FALLBACK_STATUS | SAFE: fallback-only, test-only, non-production. |

CURRENT_TREE_SECRET_RISK=LOW
GIT_HISTORY_SECRET_RISK=LOW

## Readiness Summary

HACKATHON_READINESS=PARTIAL

READY after:

1. Record and upload a public YouTube demo under 3 minutes.

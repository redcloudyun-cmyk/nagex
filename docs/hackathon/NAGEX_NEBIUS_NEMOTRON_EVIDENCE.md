# NAgex Nebius / NVIDIA Nemotron Evidence

Status: DRAFT / FACTUAL EVIDENCE
Base SHA: 5edd3874a57ffd5174944b531b2c7f0266b091a1
Date: 2026-10-06

## Runtime Evidence

Provider: Nebius Token Factory

Model: nvidia/Nemotron-3_5-Lightning

Verified deployed runtime tasks:

| TaskKind | Preferred provider | Actual provider | Model | Status |
|---|---:|---:|---|---|
| PLAN | NEBIUS | NEBIUS | nvidia/Nemotron-3_5-Lightning | PASS |
| RESEARCH_SYNTHESIS | NEBIUS | NEBIUS | nvidia/Nemotron-3_5-Lightning | PASS |
| MEETING_PREP | NEBIUS | NEBIUS | nvidia/Nemotron-3_5-Lightning | PASS |

Non-Nemotron-first tasks:

| TaskKind | Nemotron-first | Evidence |
|---|---:|---|
| CHAT | NO | Deployed router eligible providers were OpenAI, Gemini; Nebius/Nemotron was not first. |
| STRUCTURED_EXTRACTION | NO | Deployed router eligible provider was Gemini; Nemotron is not structured-extraction eligible. |
| DAILY_BRIEF | NO | Deployed router eligible provider was Gemini; Nemotron is not daily-brief eligible. |

Live certification:

| Field | Result |
|---|---|
| REAL_NEBIUS_CALL | PASS |
| REAL_NEBIUS_CALL_COUNT | 4 |
| DEPLOYED_SHA | 5edd3874a57ffd5174944b531b2c7f0266b091a1 |
| DEPLOYED_HEALTH | PASS |
| LOCAL_HEALTH_AFTER | HTTP 200 |
| PUBLIC_HEALTH_AFTER | HTTP 200 |
| SERVICE_RESTARTS | 0 |

Observed live metadata:

| TaskKind | latencyMs | inputTokens | outputTokens | totalTokens | reasoningTokens | reasoningAvailable | finishReason |
|---|---:|---:|---:|---:|---:|---:|---|
| PLAN | 3676 | 48 | 681 | 729 | 575 | true | stop |
| RESEARCH_SYNTHESIS | 3297 | 61 | 840 | 901 | 792 | true | stop |
| MEETING_PREP | 2370 | 68 | 551 | 619 | 464 | true | stop |
| PLAN JSON validation | 10963 | 984 | 2846 | 3830 | 2556 | true | stop |

Reasoning privacy:

| Check | Result |
|---|---:|
| Raw reasoning exposed to user | NO |
| Raw reasoning logged | NO |
| Raw reasoning in audit | NO |
| Raw reasoning persisted to memory | NO |
| Allowed derived metadata | reasoningAvailable, reasoningTokens |

Fallback evidence:

| Failure | Result |
|---|---|
| 429 | PASS: no unlimited retry, fallback reason RATE_LIMITED |
| 500 | PASS: one retry, fallback reason PROVIDER_ERROR |
| timeout | PASS: bounded abort, fallback reason TIMEOUT |
| invalid response | PASS: fallback reason INVALID_RESPONSE |

Governance boundary:

- Human approval bypass: NO.
- Execution authority: NAgex governs and executes; the model only reasons.
- Routing grants no permission to send email, create calendar events, send mobile messages, modify memory, or perform destructive actions.
- The live certification used synthetic data only.

Key implementation references:

- `src/model-gateway/providers.ts`
- `src/model-gateway/model-routing-policy.ts`
- `src/model-gateway/unified-model-router.ts`
- `src/model-gateway/ai-service.ts`
- `scripts/nebius-live-cert.mjs`
- `tests/nebius_nemotron_provider.test.ts`
- `tests/nebius_nemotron_routing.test.ts`
- `docs/evidence/NAGEX_NEBIUS_NEMOTRON_RUNTIME_EVIDENCE.md`

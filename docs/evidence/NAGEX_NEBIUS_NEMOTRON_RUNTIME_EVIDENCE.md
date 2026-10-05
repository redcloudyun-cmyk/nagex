# NAgex — Nebius Token Factory / NVIDIA Nemotron runtime evidence

**Status:** POINT-IN-TIME EVIDENCE (not architecture authority — see ADR-0012 and the AI Model and Decision Architecture §6)
**Date:** 2026-10-05
**Scope:** what is real in the runtime path, what was tested, and what is explicitly not yet verified.

## What NAgex does

> NAgex uses NVIDIA Nemotron 3.5 Lightning through Nebius Token Factory for high-reasoning personal-AI tasks such as planning,
> research synthesis, and meeting preparation. NAgex's task-aware router selects Nemotron without giving the model execution
> authority; consequential actions remain governed by NAgex's human-approval and execution layers.

```text
User request → NAgex task classification (TaskKind) → task-aware router → provider selection
  → NebiusProvider (OpenAI-compatible chat completions) → Nebius Token Factory → nvidia/Nemotron-3_5-Lightning
  → normalized NAgex model result → plan / research / meeting prep → human approval → execution
```

## Which tasks use Nemotron, and why

| TaskKind | Route | Why |
|---|---|---|
| PLAN | Nemotron preferred, existing providers fall back | multi-step reasoning, dependency ordering |
| RESEARCH_SYNTHESIS | Nemotron preferred, existing providers fall back | evidence-grounded synthesis |
| MEETING_PREP | Nemotron preferred, existing providers fall back | synthesis across calendar, mail, documents and memory |
| CHAT, DAILY_BRIEF, STRUCTURED_EXTRACTION, DOCUMENT_SYNTHESIS, PERSPECTIVE_*, FORECAST_* | unchanged (Nemotron is not eligible, not even as a fallback) | cost/latency, and structured output on Nemotron is unverified |

Nemotron is **not** used for every request. A user who explicitly selects a provider keeps that choice.

## Fallback behavior

If Nemotron is unconfigured, rate-limited (429), rejected (401/403), failing (5xx, after at most one retry), unreachable, too slow
(timeout), unavailable (404), degraded, or returns something unusable (malformed body, empty answer, truncated answer, a plan that
fails the plan validator), the router uses the existing approved providers and records
`preferredProvider=nebius, actualProvider=<provider>, fallbackReason=<NO_PROVIDER_CREDENTIAL | RATE_LIMITED | PROVIDER_REJECTION |
PROVIDER_ERROR | NETWORK_FAILURE | TIMEOUT | INVALID_RESPONSE | MODEL_UNAVAILABLE | PROVIDER_DEGRADED>`. If every provider fails the request
fails; no model text is ever fabricated.

## Safety properties (all asserted by automated tests)

- The credential is server-side configuration only (`NEBIUS_API_KEY`, no default); no request, header, query or browser configuration can supply it; it appears in no log, error, status or result.
- A missing key, or an unsafe base URL, leaves the provider unconfigured — the application and every other route keep working.
- Hidden provider reasoning (`reasoning_content`, `reasoning`, inline think blocks) is never returned, logged, audited or stored; only a boolean and a token count survive.
- Retry: one, for network/5xx only; none for 429/4xx/timeout. Every request has a timeout.
- Telemetry: task kind, provider, model, latency, token counts, finish reason, routing trace — no prompt, answer, reasoning, header or credential.
- Routing a task to Nemotron grants no execution authority; approval is a separate layer.

## Test evidence (fake / local endpoints only — the paid API is never called by the suite)

| Suite | Result | Covers |
|---|---|---|
| `nebius_nemotron_provider` | 36 / 36 pass | URL, model, credential use, missing key, normalization, reasoning handling, 401/403/429/5xx/network/timeout/malformed, secret leakage, real local HTTP endpoint |
| `nebius_nemotron_routing` | 26 / 26 pass | per-task preference, unchanged routes, fallback reasons, explicit override, evidence-graded capabilities, safe telemetry |
| `nebius_nemotron_contract` | 8 / 8 pass | structural guarantees (credential confinement, no router bypass, bounded retry, opt-in live script) |

Negative controls (the new tests fail when the implementation is deliberately broken): reasoning exposed → 5 failures; empty
preference table → 21 failures; Nemotron task scope removed → 4 failures; HTTP error detection removed → 11 failures; fallback
reason not recorded → 13 failures.

## Real Nebius evidence

- Owner-verified direct API call to `nvidia/Nemotron-3_5-Lightning` through `https://api.tokenfactory.nebius.com/v1` returned `NEMOTRON_OK` (billing active).
- **REAL_NEBIUS_CALL through the NAgex runtime path: NOT_RUN at the time of writing.** It is an opt-in script, `scripts/nebius-live-cert.mjs`
  (`NAGEX_LIVE_NEBIUS_CERT=1`), that makes one call through `NebiusProvider` and the router and prints only provider, model, latency,
  token counts and PASS/FAIL. Record its output here after it is run on the server that holds the key.

## Not verified yet (do not claim)

REASONING, PLANNING and RESEARCH_SYNTHESIS quality; JSON-mode adherence (`response_format`) for PLAN / MEETING_PREP; tool use;
strict structured extraction; long-context behavior. These are declared `UNVERIFIED` in the capability model. There is no
runtime spend/budget guard; token usage is logged per request.

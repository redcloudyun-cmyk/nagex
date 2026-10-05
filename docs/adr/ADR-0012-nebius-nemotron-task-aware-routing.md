# ADR-0012 — NVIDIA Nemotron through Nebius Token Factory: task-aware routing inside the canonical model router

**Status:** Accepted
**Date:** 2026-10-05
**Related:** AI Model and Decision Architecture §3, §6, §12; Trust, Identity, Privacy and Approval; MASTER §7, §9; ADR-0011 (error/secret handling conventions)

## Context

NAgex already had a `NebiusProvider` in the model gateway, but it was partial: a hardcoded URL, no default model (so it stayed
`UNCONFIGURED` unless `NAGEX_NEBIUS_MODEL` was set), no handling of the reasoning fields reasoning models return, no retry policy, no
base-URL configuration, a timeout shared with non-reasoning providers, and no per-task preference — the router only knew a global
priority (default `nebius,openai,gemini`) and capability gates. Simply giving the provider a default model would therefore have made
Nebius the first choice for **every** task, including CHAT, which is not the intent.

NAgex's product rule is "the model reasons, NAgex governs and executes": Nemotron must be one replaceable provider behind the
existing `UnifiedModelRouter` / `ModelRoutingPolicy` / `TaskKind` machinery, with no execution authority and no parallel model system.

## Decision

1. **One provider, inside the existing architecture.** `NebiusProvider` (provider id `nebius`) is the OpenAI-compatible chat-completions
   adapter for Nebius Token Factory. Defaults: base URL `https://api.tokenfactory.nebius.com/v1`, model
   `nvidia/Nemotron-3_5-Lightning`; overrides `NAGEX_NEBIUS_BASE_URL`, `NAGEX_NEBIUS_MODEL`, `NAGEX_NEBIUS_TIMEOUT_MS` (default 60 s),
   `NAGEX_NEBIUS_MAX_TOKENS` (default 8192, reasoning included). The credential `NEBIUS_API_KEY` has **no default**, is read only in
   `createProviders()` from server configuration, and is never accepted from a request, header, query string or browser-controlled
   configuration. A missing key, or a base URL that is not `https` (plain `http` only for a loopback test endpoint) or carries
   embedded credentials, leaves the provider `UNCONFIGURED`: nothing is sent, nothing else fails.
2. **Per-task preference, not a new global priority.** `ModelRoutingPolicy` gains a `TaskProviderPreferences` table
   (`DEFAULT_TASK_PROVIDER_PREFERENCES`): `PLAN`, `RESEARCH_SYNTHESIS` and `MEETING_PREP` prefer `nebius`. The comparator ranks a
   *preferred and non-degraded* provider first, then the pre-existing runtime-status tier, then the configured priority. A preference
   never makes an unconfigured, incapable or out-of-scope provider eligible and never overrides an explicit provider choice. A
   `DEGRADED` preferred provider is deprioritized by the existing health rule (it is not hammered), and the decision still records it
   as the preference.
3. **Model-scoped capability evidence.** `ModelProviderCapabilities` gains optional `eligibleTaskKinds` and an evidence-graded
   `declared` map (`SUPPORTED | UNVERIFIED | UNSUPPORTED` for CHAT_COMPLETION, REASONING, PLANNING, RESEARCH_SYNTHESIS, TOOL_USE,
   STRUCTURED_OUTPUT, LONG_CONTEXT). For a Nemotron model the adapter declares: only CHAT_COMPLETION `SUPPORTED`; everything else
   `UNVERIFIED`; `supportsStructuredExtraction=false`; automatic routing limited to the three tasks above. Hence CHAT,
   STRUCTURED_EXTRACTION, DAILY_BRIEF, DOCUMENT_SYNTHESIS, PERSPECTIVE_* and FORECAST_* have **byte-identical** routing decisions with or
   without Nemotron configured, and Nemotron is not even a fallback for them. Other Token Factory models keep the generic declaration
   (the pre-existing `model_capability_contract` is unchanged).
4. **Hidden reasoning is not an answer.** The answer is `choices[0].message.content` only. `reasoning_content`, `reasoning` and inline
   `<think>…</think>` are reduced to `meta.reasoningAvailable` (boolean) and `usage.reasoningTokens` (a count the provider reports)
   inside the adapter; the text is dropped and never returned, logged, audited or persisted to Memory. Reasoning-only output (no
   content) and a `finish_reason=length` answer are failures (`INVALID_RESPONSE`), not answers built from reasoning or from a
   truncated body.
5. **Truthful failure and fallback.** Provider error codes map to a fixed vocabulary (`classifyModelFailure`): `NO_PROVIDER_CREDENTIAL`,
   `RATE_LIMITED`, `PROVIDER_REJECTION`, `PROVIDER_ERROR` (5xx), `NETWORK_FAILURE`, `TIMEOUT`, `INVALID_RESPONSE`, `MODEL_UNAVAILABLE`,
   `PROVIDER_DEGRADED`. The router falls back along its existing order (the existing approved providers) and returns
   `routing = { taskKind, preferredProvider, actualProvider, fallbackUsed, fallbackReason }` on the response and in the
   `model_request_succeeded` log. A task validator rejecting a Nemotron answer (e.g. a plan that is not valid JSON) falls back as
   `INVALID_RESPONSE`. All providers failing is `ALL_MODEL_PROVIDERS_FAILED` with reasons — never a fabricated result.
6. **Retry and timeout.** Inside the Nebius adapter: at most **one** retry, only for network failure or 5xx; never for 429 (the router
   falls back), 4xx auth/config, or a timeout. Every call is bounded by an `AbortController` timeout.
7. **Safe telemetry.** `model_routing_decision` / `model_request_succeeded` / `model_request_failed` now carry task kind, provider, model,
   latency, the provider-reported token counts (input/output/total/reasoning), finish reason, and the preferred/actual/fallback fields
   — and never a prompt, an answer, reasoning text, a header or a credential.
8. **Approval and execution are untouched.** Routing a plan to Nemotron grants it no authority: the plan is still a preview; every
   consequential step still goes through the approval and execution layers.

## Consequences

- When `NEBIUS_API_KEY` is set (the model now defaults), Nemotron becomes the first attempt for PLAN, RESEARCH_SYNTHESIS and
  MEETING_PREP. PLAN and MEETING_PREP ask for JSON; Nemotron's JSON-mode adherence is **UNVERIFIED** and is protected only by the
  existing validate-then-fall-back path (a cost/latency risk, not a correctness risk). The real certification run records evidence.
- There is no spend guard in the runtime. Token usage is logged per request; a budget/limit subsystem is **not** added here and is a
  remaining risk (Nebius billing is active).
- `activeProviderSummary()` (Settings) still reports the task-agnostic first candidate; it does not claim Nemotron answered anything.
- The older `ModelRouter` (S-04 trust-class selector in `model-router.ts`) is not in the runtime path and is unchanged.

## Not decided here

Tool use through Nemotron, strict structured extraction on Nemotron, long-context routing, a spend/budget guard, per-user provider
disclosure policy beyond the existing sensitivity rules, and any UI attribution beyond the existing provider status.

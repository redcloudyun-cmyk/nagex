# NAgex Model Router Specification

## 1. Purpose

NAgex should not assume one model is optimal for every task.

The Model Gateway abstracts providers, while the Model Router selects an appropriate model according to task requirements and policy.

## 2. Hackathon Priority

NVIDIA/Nebius integration is a first-class requirement for the hackathon implementation.

The hackathon demo path should make substantive use of an NVIDIA open-source model through Nebius infrastructure.

## 3. Model Gateway Responsibilities

The gateway should normalize:

- request format,
- authentication,
- model identifiers,
- response format,
- errors,
- latency metrics,
- token usage,
- provider health.

Provider credentials must remain server-side and must never be exposed to the browser.

## 4. Routing Inputs

Potential routing factors:

```text
task_type
reasoning_complexity
required_capabilities
context_length
latency_target
cost_limit
provider_availability
privacy_policy
fallback_policy
hackathon_policy
```

## 5. Candidate Routing Classes

Examples:

- reasoning,
- planning,
- summarization,
- extraction,
- coding,
- tool-use,
- low-latency interaction.

## 6. NVIDIA / Nebius Route

The initial primary hackathon route should support:

```text
NAgex Runtime
→ Model Router
→ NVIDIA Nemotron
→ Nebius Token Factory / Nebius AI Cloud
→ normalized response
```

The exact model identifier must be configured from live provider availability rather than hardcoded documentation assumptions.

## 7. Fallback Policy

Fallback may occur for:

- provider outage,
- timeout,
- rate limit,
- unsupported task,
- context overflow.

Fallback must not:

- bypass approval,
- bypass authorization,
- silently downgrade a required compliance condition,
- falsely report the selected provider.

## 8. Model Decision Record

For auditable execution, store where appropriate:

```text
requested_task
selected_provider
selected_model
routing_reason
latency
token_usage
fallback_used
error
```

## 9. BYOK and Managed Provider Direction

NAgex may eventually support both:

- NAgex-managed provider credentials
- user-supplied provider credentials

For the hackathon, implementation simplicity and reproducibility are more important than implementing a full billing system.

## 10. Definition of Done

A live model route is complete when:

- credentials are loaded securely,
- a real provider request succeeds,
- errors are normalized,
- model/provider identity is observable,
- tests cover routing behavior,
- no secrets reach the client,
- README accurately describes the integration.

## 11. Implemented Unified Router

The server implements live OpenAI, Gemini, and Nebius Token Factory providers behind one normalized `ModelProvider` contract. Provider selection supports `auto`, `openai`, `gemini`, and `nebius`; failures and timeouts are normalized and routed to the next configured provider. `auto` prefers the hackathon-critical Nebius/NVIDIA route, then OpenAI, then Gemini.

The router itself contains no provider-name enum or provider-specific fallback list. It routes any registered `ModelProvider` adapter, uses adapter registration order for `auto`, and accepts any registered provider ID for explicit routing. The built-in priority is configuration-driven through `NAGEX_PROVIDER_PRIORITY` (default `nebius,openai,gemini`). Adding another provider requires only its adapter and gateway registration/configuration; runtime, memory, planning, skills, tools, approval, and execution modules remain unchanged.

All credentials and model identifiers are server-side configuration:

```text
OPENAI_API_KEY + NAGEX_OPENAI_MODEL
GEMINI_API_KEY + NAGEX_GEMINI_MODEL
NEBIUS_API_KEY + NAGEX_NEBIUS_MODEL
NAGEX_MODEL_PROVIDER
NAGEX_PROVIDER_PRIORITY (optional comma-separated adapter priority)
```

`GET /api/v1/providers/status` exposes only configuration/availability booleans, provider name, and model ID. `POST /api/v1/ai/chat` returns normalized text and routing metadata. `POST /api/v1/ambient/intent` retrieves relevant memory and returns a validated structured Plan Preview. It does not execute tools.

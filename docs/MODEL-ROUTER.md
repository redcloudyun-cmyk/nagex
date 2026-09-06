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
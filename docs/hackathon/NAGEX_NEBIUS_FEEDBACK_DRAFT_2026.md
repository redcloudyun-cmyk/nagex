# Nebius / NVIDIA Feedback Draft

Status: DRAFT
Base SHA: 5edd3874a57ffd5174944b531b2c7f0266b091a1

## What We Used

NAgex uses Nebius Token Factory to call NVIDIA Nemotron 3.5 Lightning through the NAgex Model Gateway. The integration is task-aware: Nemotron is selected for high-reasoning personal-AI tasks rather than every request.

Verified runtime tasks:

- PLAN
- RESEARCH_SYNTHESIS
- MEETING_PREP

## What Worked Well

- The OpenAI-compatible chat completions surface made it straightforward to add Nebius Token Factory behind the existing provider abstraction.
- The model returned useful reasoning-token metadata without requiring NAgex to expose raw reasoning text to users.
- The integration fit cleanly into a task-aware router: NAgex could use Nemotron for high-reasoning tasks while preserving other provider routes.
- The deployed runtime successfully completed real calls for PLAN, RESEARCH_SYNTHESIS, and MEETING_PREP.

## What Was Difficult

- JSON-mode behavior for strict structured planning needed live validation rather than assumption.
- Reasoning models can spend many completion tokens internally, so max-token and timeout defaults need more headroom than smaller chat models.
- It was important to distinguish provider acceptance from verified product success and to keep fallback behavior truthful.
- Secret handling required careful server-only environment configuration; no API key should ever appear in browser state, logs, responses, or docs.

## Onboarding Experience

The Token Factory path was easy to integrate once the endpoint, model id, and API key environment variables were clear. For production-style use, the main onboarding need is explicit guidance around model IDs, JSON/structured-output expectations, latency, token accounting, and reasoning-token behavior.

## API Compatibility

The OpenAI-compatible chat completions shape worked well for the NAgex provider adapter. NAgex maps the response into its own normalized `ModelResponse`, including text, provider/model metadata, latency, token usage, finish reason, and a boolean `reasoningAvailable`.

## Latency Observed

Verified live certification samples:

| Task | latencyMs |
|---|---:|
| PLAN | 3676 |
| RESEARCH_SYNTHESIS | 3297 |
| MEETING_PREP | 2370 |
| PLAN JSON validation | 10963 |

These are certification observations, not a benchmark suite.

## Reasoning-Token Behavior

The deployed runtime observed `reasoningAvailable=true` and nonzero `reasoningTokens` for live Nemotron calls. NAgex uses this only as metadata. Raw reasoning text is dropped by the provider adapter and is not returned to the user, logged, audited, or persisted to memory.

## Documentation Issues / Suggestions

- Make model ID examples and recommended defaults easy to find.
- Document expected behavior for JSON mode / structured output by model.
- Provide guidance on reasoning-token budgeting and latency expectations.
- Include examples of safe logging patterns that omit prompt, answer, reasoning, and credentials.
- Clarify retry recommendations for 429, 5xx, timeout, and invalid response cases.

## Would We Use It Again?

Yes. Nebius Token Factory plus NVIDIA Nemotron is a good fit for high-reasoning tasks inside a governed personal AI system, especially when the application keeps execution authority outside the model and uses truthful fallback behavior.

NEBIUS_FEEDBACK_PREPARED=YES

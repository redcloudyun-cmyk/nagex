# NAgex JEV Shadow Benchmark 2026

Status: POC / Shadow mode only
Base SHA: 5edd3874a57ffd5174944b531b2c7f0266b091a1

## Architecture

Current architecture reconciliation:

- CURRENT_TASK_CLASSIFIER: AiService call paths and caller-provided `ModelRoutingContext.taskKind`.
- CURRENT_TASK_ROUTER: domain/runtime service entry points that choose the TaskKind before model invocation.
- CURRENT_MODEL_ROUTER: `UnifiedModelRouter` with `ModelRoutingPolicy`.
- CURRENT_NEMOTRON_ROUTING: `DEFAULT_TASK_PROVIDER_PREFERENCES`, with Nebius/Nemotron preferred for `PLAN`, `RESEARCH_SYNTHESIS` and `MEETING_PREP`.
- CURRENT_APPROVAL_GATE: governance approval stores and capability/action approval policy, outside the model router.
- CURRENT_EXECUTION_GATE: capability broker / canonical execution path, outside the model router.
- CURRENT_TELEMETRY: router logger events such as `model_routing_decision`, `model_request_succeeded` and `model_request_failed`.

JEV is inserted after the authoritative router decision and before provider invocation. It logs advisory metadata only. It does not alter the selected provider, model, fallback order, TaskKind, approval, execution or memory behavior.

The optional provider adapter targets `https://jevmodel.org/v1/systemone` with server-side `JEVMODEL_API_KEY` only and request model alias `jev-latest`. Tests use injected fake fetch only; no live JEV call is required for this benchmark.

## Why JEV

The current certified route correctly prefers Nemotron Lightning for high-reasoning task classes. The shadow POC tests whether a fast structured decision layer can identify lighter cases inside those classes, especially simple `PLAN` requests, without changing production behavior.

## Authority Boundaries

Shadow invariants:

- JEV_PROVIDER_AUTHORITY = 0
- JEV_TASK_KIND_AUTHORITY = 0
- JEV_APPROVAL_AUTHORITY = 0
- JEV_EXECUTION_AUTHORITY = 0
- JEV_MEMORY_WRITE_AUTHORITY = 0
- JEV_EXTERNAL_ACTION_AUTHORITY = 0
- SUPER_ROUTING_IMPLEMENTED = NO

JEV output is normalized to `complexity`, `complexityConfidence`, `highRiskProbability`, `reasoningLevel`, `reasoningConfidence`, `resolvedModel`, `reasonCode` and latency. It contains no free-form reasoning and no user-visible chain-of-thought.

## Fixture Methodology

The benchmark uses 133 deterministic synthetic fixtures. Coverage includes `CHAT`, `PLAN`, `RESEARCH_SYNTHESIS`, `MEETING_PREP`, `STRUCTURED_EXTRACTION` and `DAILY_BRIEF`, plus simple factual, multi-step planning, ambiguous, high-risk, long-context, easy non-Nemotron and hard high-reasoning examples.

Gold labels are defined from TaskKind, complexity and risk signals. They are not derived from JEV output and store concise reason codes only. Each fixture carries expected complexity, expected risk class, expected reasoning level and expected escalation-candidate status.

## Results

- FIXTURE_COUNT: 133
- JEV_ROUTING_ACCURACY: 100.00%
- FALSE_DOWNGRADE_RATE: 0.00%
- FALSE_UPGRADE_RATE: 0.00%
- UNCERTAIN_RATE: 11.28%
- P50_LATENCY_MS: 0
- P95_LATENCY_MS: 0.003
- BASELINE_NEMOTRON_SELECTIONS: 78
- PROJECTED_NEMOTRON_CALL_REDUCTION: 23.08%
- CURRENT_ROUTER_OUTPUT_CHANGED_BY_JEV: 0

Projected call reduction is an offline estimate from current router policy plus shadow labels. It is not actual production savings and does not include provider pricing.

## Live Sample Phase

Status: PENDING_TEST_SERVER_KEY.

Local environment check on this workspace found `JEVMODEL_API_KEY` absent, so no real JEV request was sent from this machine. The live runner is `scripts/jev-live-benchmark.mjs`; it fails closed when the key is missing and prints the selected fixture IDs before any provider call.

Selected 36-fixture live sample:

- CHAT: `chat-simple-001`, `chat-simple-002`, `chat-simple-003`, `chat-ambiguous-001`, `chat-ambiguous-002`, `chat-ambiguous-003`
- PLAN: `plan-light-001`, `plan-light-002`, `plan-multistep-001`, `plan-long-001`, `high-risk-001`, `high-risk-002`
- RESEARCH_SYNTHESIS: `research-001`, `research-002`, `research-003`, `research-004`, `research-005`, `research-006`
- MEETING_PREP: `meeting-001`, `meeting-002`, `meeting-003`, `meeting-004`, `meeting-005`, `meeting-006`
- STRUCTURED_EXTRACTION: `extract-001`, `extract-002`, `extract-003`, `extract-ambiguous-001`, `extract-ambiguous-002`, `extract-ambiguous-003`
- DAILY_BRIEF: `brief-001`, `brief-002`, `brief-003`, `brief-004`, `brief-005`, `brief-006`

The sample stratifies across simple, standard, high-reasoning, uncertain and high-risk labels. Gold labels must not be changed after live results are observed.

## Failure Cases

No threshold failures were observed in the deterministic fixture run.

Negative controls:

- AUTHORITY_NEGATIVE_CONTROL: PASS
- APPROVAL_NEGATIVE_CONTROL: PASS
- SCHEMA_NEGATIVE_CONTROL: PASS
- FALSE_DOWNGRADE_NEGATIVE_CONTROL: PASS

## Recommendation

GO_LIMITED_INTEGRATION.

Reason: accuracy is above 95%, false downgrade is below 2%, no authority-boundary violation was detected, latency is operationally negligible in the offline evaluator, and projected Nemotron call reduction is above the desirable 20% line. Keep the feature shadow/advisory until live traffic evidence confirms the fixture result.

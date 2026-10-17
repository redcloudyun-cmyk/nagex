# ADR-0017 — Goal-driven adaptive execution: a failed route is not a failed goal

**Status:** ACCEPTED (2026-10-17) · **Builds on:** ADR-0016 (Product Builder), the Approval Authority, the Model Gateway, the DecisionPort (§10.1 of the AI / Decision architecture) · **Does not change:** Human Approval, permissions, tenant / owner isolation, `RELEASE = NO-GO`
**Canonical text:** `docs/canonical/NAgex_AI_Model_and_Decision_Architecture.md` §10.2

## Context

NAgex is goal-driven, not provider-driven: the person states an outcome; which model, API or device route reaches it is NAgex's concern. Until now a provider that failed (an image service out of quota, a model that timed out) ended the step, and what happened next was whatever the individual module did. Three things were missing: a shared vocabulary for *why* something failed (retry and fallback depend on the reason, not on the vendor), a deterministic way to find another *authorized* route and say what moving to it would change for the person, and a record of what was tried.

## Decision

A small, pure core in `src/adaptive/` that every state machine can use, and that replaces no existing authority:

1. **Twelve normalized failure classes** (`failure-taxonomy.ts`), reduced from any vendor's codes and HTTP statuses. Rules belong to the class: quota is never hammered; a rate limit is waited out only for a short documented delay; a **denial is never routed around**; an **unknown outcome of a chargeable request is never duplicated** until the person reconciles it.
2. **Route candidates described by verified facts** (`route-candidate.ts`, `image-route-catalog.ts`): configured / authenticated / available, quota (from what NAgex has seen — `route-outcome-ledger.ts`), supported inputs, cost (**unknown stays unknown**), who would receive the data (NAgex's own declaration, unknown vendors get the lowest sensitivity ceiling), reliability evidence (ignored below three samples). There is no quality field: nothing measures quality.
3. **Hard eligibility first, ranking second** (`route-selection.ts`). Not configured, rejected credential, unavailable, quota seen exhausted (with a cool-down), incompatible input, sensitivity above the route's ceiling, price above the authorized ceiling, already tried, or a failure class that forbids moving — each makes a route ineligible, with the reason. No recommendation can undo it.
4. **Material terms** (`route-terms.ts`). A new company receiving the data, a different processing location, a higher or **unknown** price, or less input capability is material: the person decides, through the Approval Authority, with an approval bound to the exact route and its terms and used once. Only an explicit **standing authorization** (none exists by default) can stand in, and never for a location change, an unknown price or a reduced capability.
5. **A bounded planner** (`recovery-planner.ts`) decides retry / switch / ask / reconcile / abort over a budget of attempts, switches and per-route retries. It executes nothing.
6. **An optional advisor** (`route-advisor.ts`, `jev-route-advisor.ts`): JEV, or any decision provider, may reorder the *eligible* set or add a question for the person. It cannot add a route, make one eligible, remove a check, approve or pay; a malformed, unoffered or low-confidence answer is no advice; a failing provider is given up on; without it the order is deterministic and says so. JEV is asked one `choice` question in the System One shape the repository already uses; **no live JEV call has been made** (no credential).
7. **Goal-level verification** (`goal-verifier.ts`): an image is accepted only if the bytes are a real, complete image of a plausible size; the stored type and size are the real ones.
8. **A persistent route history** per goal (`route-history.store.ts`): which route, what happened by class, what was decided and by whom, which approval covered a switch — owner-scoped, no content.

First consumer: the Product Builder's mockups (`product-builder.adaptive.ts`). The state machine (not a new runtime) carries the decision; the person's choice of another route is recorded as an approval of tool `adaptive.route.switch`.

## Alternatives rejected

- **A second agent runtime / approval engine.** Rejected: the planner is a pure function; execution and consent stay in the existing state machines and the Approval Authority.
- **Switching providers silently when the failure class allows it.** Rejected: a different company receiving the data, or a price nobody knows, is exactly what the person agreed to or did not.
- **Ranking by "quality".** Rejected: it is not measured; claiming it would be invention.
- **A mandatory JEV dependency.** Rejected (canonical §9): optional, replaceable, tighten-only, deterministic fallback.
- **Retrying a chargeable request that may have been carried out.** Rejected: reconcile first.

## Consequences

- The Model Gateway's own provider failover (configured priority) is unchanged and is *not* yet routed through this layer; it is a pre-configured, operator-level standing choice. Moving it under the same material-terms rule is future work.
- Adapters expose more truth: image adapters report their model; Google can register extra models as separate routes (`NAGEX_IMAGE_GOOGLE_FALLBACK_MODELS`); NVIDIA NIM and a local image endpoint are registered and reported unconfigured until configured; OpenAI and NIM report the provider's HTTP status.
- The real-image end-to-end is **BLOCKED_WITH_EVIDENCE** on this machine: the real Google adapter answered quota exhausted (observed in the live check of 2026-10-17) and no other image credential exists.
- Video, deployment and the coding engine are the next consumers; the video job service already has the approval and uncertain-outcome primitives and needs only the planner.

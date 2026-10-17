# ADR-0019 — Answer verification: how deeply, which claims, and what a second model may and may not say

**Status:** ACCEPTED (2026-10-17) · **Builds on:** ADR-0017 (goal-driven adaptive execution), ADR-0018 (current-fact answers), the Model Gateway, the DecisionPort / JEV (AI-Decision §10.1) · **Does not change:** Human Approval, permissions, tenant / owner isolation, `RELEASE = NO-GO`
**Canonical text:** `docs/canonical/NAgex_AI_Model_and_Decision_Architecture.md` §10.4 · **Evidence:** `docs/evidence/NAGEX_ANSWER_VERIFICATION_20261017.md`

## Context

ADR-0018 made an answer about the current world *grounded*: looked up, read, cited. Grounded is not verified. A real model run showed what is left: a model can cite a page that does not say what it claims, state a figure that is in no source, give one of two conflicting dates without saying so, or - without sources - deny that something exists. A fluent answer, a successful call and a model's own confidence are all consistent with every one of these. The outcome that matters is an answer a person can reasonably rely on, with an honest statement of how far it was checked.

## Decision

A verification layer in `src/verification/` that runs **after** an answer is written, on the evidence it was written from. It reuses the Model Gateway, `EvidencePackService`, the existing claim-verification (quote-in-source) module and the JEV interface; it adds no chat engine and no new approval path.

1. **How deeply (L0-L3), decided by rules** (`verification-policy.ts`): L0 simple tasks (nothing checked); L1 ordinary factual (claims against sources where needed); L2 current facts, research, comparisons, challenges (+ an independent second reading); L3 high-impact (health / law / money / safety in a decision frame or with a dosage-like figure: + a primary-like source, + independent review, else capped). The signals are the *structure* of the request, what the first answer itself revealed (it hedged: one step, up to L2), and the person's explicit request ("더 꼼꼼히 다시 확인", an action under an answer that was not fully checked; one request, no standing switch: raised). Every level says who raised it. **An advisor (JEV or any provider) may only raise the level, only when confident (>= 0.6), and only through the System One `choice` shape the repository already uses**; without it the rules stand. A request that will be checked is looked up even if its words do not look "current".
2. **Claims against sources, deterministically** (`claim-checker.ts`): the answer is cut into claims (sentences, table rows); a claim is *material* when it carries a figure, a date or states that something is released. A figure that is in no retrieved source is UNSUPPORTED; a citation to a page about something else is not support (but a figure found in another retrieved page is "supported, mis-cited"); a claim with nothing checkable is UNCHECKABLE, never "supported". A calendar date is one figure.
3. **A second, distinct model reads the same evidence** (`independent-review.ts`): given the question and the sources - **never the answer** - it extracts what the sources state, each with an exact quote; NAgex admits a finding only if the quote is in the source and the figures are in the quote (the R26-A claim verifier). The label follows who *actually* answered: a distinct provider is INDEPENDENT_MODEL_REVIEW; the same provider again is SELF_REVIEW (only allowed at L3, and said so); none is UNAVAILABLE. A disagreement is recorded and never settled by majority.
4. **Disagreement is investigated, once**: one bounded extra search aimed at the disputed claim (a number set by the level), then **one rewrite** of the answer from the sources (told exactly which statements are unsupported, and what a source states instead), then removal of whatever is still unsupported - and the report says which happened (`NONE` / `REWRITTEN` / `REDACTED`). Nothing loops.
5. **Sources that disagree** are a conflict (release / announcement dates, read only where the reading is unambiguous: the date must follow the name closely, with a release word, and no other named thing in between). An answer that picks one silently is DISPUTED and is asked once to say so; an answer that says so is at most PARTIALLY_VERIFIED - an honest report of a disagreement is not a settled fact.
6. **The status follows from the facts, never from a score**: VERIFIED (every material claim supported, nothing contradicted), PARTIALLY_VERIFIED (some not supported / a stronger check was not possible / sources disagree), UNVERIFIED (no sources, or nothing checkable), DISPUTED (a claim contradicted, readings differ, or an unexplained conflict), NOT_REQUIRED (L0). A model's confidence is not an input anywhere, and nothing here is a calibrated probability.
7. **The person sees one plain chip and a short "how"** - never a provider name, an id or a level code - and can ask for stronger checking per request.

## Alternatives rejected

- **Asking a second model "is this answer right?"** Rejected: it sees the first model's conclusion, agrees with fluent text, and its confidence proves nothing. The second reader gets the evidence only, and what it finds must survive NAgex's own quote check.
- **A majority or an unbounded debate between models.** Rejected: agreement is not evidence. The disagreement is settled by evidence (one search) or reported.
- **Model-judged "is this a current fact?" as the only classifier.** Rejected as sole authority; kept as an optional, raise-only advisory with a deterministic fallback.
- **Marking an answer VERIFIED when its claims are supported but its sources disagree.** Rejected: it would call a disputed fact settled.
- **Hiding a failed check.** Rejected: an answer that could not be checked says so (UNVERIFIED / PARTIALLY_VERIFIED, with the reason in plain words).

## Consequences

- Cost and latency rise with the level: L0/L1 add only deterministic checks; L2 adds a second model call (when a distinct provider exists) and may add one search and one rewrite; L3 may add two searches. Measured numbers are in the evidence document.
- **Independent review cannot be run live on this machine**: only one model provider (Gemini) is configured, and a second Gemini model is the same provider, not an independent one. The live run therefore shows the deterministic layers on real model output and reports `INDEPENDENT_MODEL_REVIEW = BLOCKED_WITH_EVIDENCE`. The independent path is certified with distinct stand-in providers.
- JEV has not been called live (no credential); the advisor is certified against a simulated service of the verified shape.
- What this layer cannot do: tell that a *supported* figure is attached to the right attribute (the independent reading is the safeguard), verify a claim with no figure and no date (it is UNCHECKABLE), or judge the quality of prose. Those remain human review or a later layer.

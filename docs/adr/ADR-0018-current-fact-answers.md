# ADR-0018 — Answers about the current world: what needs checking is recognised by the structure of the question, evidence is untrusted data, and a model never denies what it cannot know

**Status:** ACCEPTED (2026-10-17) · **Builds on:** ADR-0017 (goal-driven adaptive execution), the Model Gateway, the Approval Authority · **Does not change:** Human Approval, permissions, tenant / owner isolation, `RELEASE = NO-GO`
**Canonical text:** `docs/canonical/NAgex_AI_Model_and_Decision_Architecture.md` §10.3 · **Evidence:** `docs/evidence/NAGEX_WEB_ANSWER_QUALITY_20261017.md`

## Context

On the deployed instance a Korean comparison of two phone generations was answered from the model's memory, the newest generation was called "unreleased", the table was speculation, and when the person challenged it
("a newer model is on sale now") NAgex answered with an English sentence saying live web search was unavailable - although the composer's Web switch was on. Tracing the real request path showed **no single
cause but four independent defects**, each of which would have produced a wrong answer on its own:

1. **The freshness check could not see the question.** Korean category words were wrapped in `\b`, and JavaScript's `\b` is an ASCII word boundary: between a Hangul syllable and a space there is none, so `주가`, `날씨`, `가격`, `뉴스` never matched. No category existed for products, releases or specifications. Both the spec comparison and "make it a table" were classified "no current facts needed" and went to the model unchecked.
2. **A turn was judged alone.** "Make it a table" and "isn't that wrong, X is on sale now" have no subject of their own; the search (when it ran at all) used the words of the last message only.
3. **The composer's Web switch was decoration.** `requestMetadata.allowWebResearch` was sent by the client and read by nothing on the server.
4. **A failed check ended in a canned English sentence that blocked the model entirely**, whatever the person's language, whether the search was off, rate-limited or simply not configured - and without any answer to the question.

Separately, the deployed instance has no web-search provider configured (the message the person saw is the one for "not configured"), and the only keyless provider (Wikipedia + OpenAlex) cannot search by a natural question.

## Decision

All of it reuses what exists (Model Gateway, `EvidencePackService`, `WebSearchService`, `SourceFetcher`, the adaptive core of ADR-0017); nothing here is a second pipeline.

1. **Recognise by structure, not by name** (`question-classification.service.ts`). A *versioned name* (a name followed by a number: Fold7, iPhone 17, RTX 5090, 폴드7) that is compared, released, on sale or priced is a current-fact question (`PRODUCT`); release-status questions are recognised on their own; Korean words are matched as substrings; "how much of an attribute" (`배터리 용량이 얼마야`) is not a price; text the person supplied (translate / proofread) is not a question about the world. No product is known to the code.
2. **Read a turn in its conversation** (`turn-analysis.ts`). A follow-up borrows the subject of the earlier question; a challenge to an earlier answer is a `CORRECTION` that carries the question, the challenge and the disputed answer; a message with a subject of its own borrows nothing. Only earlier *questions* ever reach a search engine.
3. **Honour the Web switch** server-side: OFF means nothing is looked up, the pack says so (`DISABLED`), and the answer begins with one plain note in the person's language.
4. **No canned refusal.** A question whose whole answer is a *live value* (price, quote, weather, headline) and that could not be checked is still not answered from memory (R22.4's `FAKE_SUCCESS_PATHS = 0`), but says why, in the person's language, with a next step. Every other question (a product's specifications, a technology, a company, a policy) is answered from what the model knows **labelled as unverified**.
5. **Evidence is untrusted data** (`chat-grounding.ts`): fenced with a per-request random marker, listed by id, with the page's relevant passages (`SourceFetcher`: robots.txt, the outbound URL policy, byte and time budgets) and not only a snippet; the model is told to cite only listed ids, to keep *what the sources state / what it infers / what they do not cover* apart, and to report disagreement between sources.
6. **Check the answer afterwards**: citations to sources that were not retrieved are removed and reported (single and grouped forms); a wrong-language answer is asked for once more; an internal instruction label copied into the answer is removed; and - **the incident's own sentence** - without sources a model may remember, labelled, but it may not *deny* a release or an existence (`has not been released`, `미출시`, `존재하지 않`): it is asked once more, and a denial that survives is removed.
7. **Sources must be about the thing asked.** For a named, versioned product a source that mentions none of the named things is dropped (another product's page is not evidence); when part of the search could not be asked (rate limit, timeout) the result is that failure, never "nothing relevant". One page per compared thing is read before any thing gets a second.
8. **Search is a goal with routes** (`search-recovery.ts`, ADR-0017): failures are classified into the twelve classes; quota / a rejected credential / a long Retry-After are not retried or waited out in an interactive request and are not asked again during their cool-down; another route is used only if the operator configured it (`NAGEX_WEB_SEARCH_FALLBACKS`) and it is free (a known price of zero is the standing consent); any other alternative stops the search with "needs the person". JEV may rank the eligible routes (advisory, deterministic fallback); correctness never depends on it.
9. **A model names what to look up; facts still come only from pages** (`search-query-planner.ts`): a natural question is a poor query. Planned queries are sanitized like any query; if the planner fails the person's own words are searched. The keyless encyclopedia route tries a relaxed query first (digits separated from letters, generic words dropped), then the named thing, then the words as given; it honours `Retry-After` per host and keeps to one request at a time.

## Alternatives rejected

- **Hard-coding products or releases.** Rejected: the failure is structural; a table of facts goes stale and is exactly the kind of invented authority NAgex forbids.
- **Always searching.** Rejected: cost, latency, privacy (every question would leave the machine) and false authority for questions the model answers well.
- **Letting the model decide whether to search** as the only mechanism. Rejected as sole authority: it is the model that was wrong. A model-assisted *advisory* signal (JEV / model uncertainty) is the next slice; the deterministic rule stays authoritative and is the fallback.
- **Refusing every unverifiable question** (the old behaviour). Rejected for knowledge questions: silence helped nobody, and the incident answer was worse for lacking any plain statement of what was not checked. Kept for live values.
- **Trusting prompt instructions alone** for "do not call it unreleased". Rejected: measured live - a real model did it anyway - so it is checked and enforced after the answer.

## Consequences

- The deployed instance needs an operator decision to ground answers in the real web: configure `NAGEX_WEB_SEARCH_PROVIDER` (Tavily key or an HTTP endpoint) - or opt in to the keyless encyclopedic route (`open_knowledge`, Wikipedia + OpenAlex), which is NOT general web search and cannot reach a manufacturer's newsroom. Until then Product questions are answered unverified with a plain note; nothing is claimed as verified.
- Claim-level verification (which sentence is supported by which source, independent second-model review, conflicting-source investigation) is **not** in this ADR; it is the next slice and will extend this path, not replace it.
- `EvidencePack` gained `attempts`, `queries`, `noEvidenceReason`, `degraded`, `fromCache`; the chat response gained `grounding` (retrieval-level facts only - it says what the answer rests on, never that a claim was verified).

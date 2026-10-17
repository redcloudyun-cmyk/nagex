# NAgex answers about the current world — the Galaxy Fold incident (evidence, 2026-10-17)

**Status:** EVIDENCE (point in time) · **Canonical text:** `docs/canonical/NAgex_AI_Model_and_Decision_Architecture.md` §10.3 · **Decision:** `docs/adr/ADR-0018-current-fact-answers.md`
**Release posture:** `RELEASE = NO-GO`. Nothing was deployed; the deployed service was neither read nor changed. `main` untouched.

## 1. The incident and the traced request path

Reported on the deployed instance: a Korean Fold6-vs-Fold7 comparison answered from memory with the newest model called "unreleased" and a speculative table; then, when the person challenged it (a newer model is on sale), an English sentence — *"I can't verify current information right now because live web search is unavailable."* — although the composer's Web switch was on.

The real path was traced in code and with probes against the compiled project (no assumption about one cause):

```text
Composer (Web ON by default)  ->  requestMetadata.allowWebResearch  ->  intent routing: all three turns = CONVERSATION_DEFAULT
 -> POST /api/v1/ai/chat -> EvidencePackService.buildEvidencePack(message) -> freshness classifier -> (search) -> model -> store
```

| # | Exact failure point | Evidence |
|---|---|---|
| F1 | The freshness classifier could not see the question: Korean words were wrapped in `\b` (an ASCII boundary — never matches Hangul), and there was no product / release / specification category. Turn 1 and turn 2 were classified "no current facts needed". | probe: `갤럭시 폴드6와 폴드7의 주요 스펙 차이가 뭐지?` → `NONE`, `비교표로 만들어봐.` → `NONE`; `삼성전자 주가`, `서울 날씨`, `아이폰 가격이 얼마야` → `NONE` too |
| F2 | A turn was judged alone: "make it a table" and the challenge had no subject. Only turn 3 reached a search, because the word "지금" matched a recency keyword. | route reads `message` only |
| F3 | The composer's Web switch was decoration: `allowWebResearch` was read by no server code. | `grep allowWebResearch src/` → no consumer |
| F4 | When the check was required and failed, a hard-coded **English** sentence replaced the model entirely (also persisted as an assistant message that later turns saw). The sentence that was shown is the *"not configured"* variant (a timeout or rate limit would have named a status) — so the deployed instance has no web-search provider configured. | `conversation.routes.ts` (removed branch); inference from the message variant — the deployed configuration was not inspected |
| — | Not causes: the current date *was* in the chat prompt (`timeContextPromptLines`); earlier turns *were* passed to the model. The model nevertheless answered from memory because nothing told it that its memory ends before today. | `ai-service.ts` chat |

## 2. What changed (small, reusing existing parts)

Classification by structure (`question-classification.service.ts`) · turns read in conversation (`turn-analysis.ts`) · the Web switch honoured · no canned refusal: live values refused with a reason, everything else answered *labelled unverified* (`limitation-notice.ts`) · evidence fenced as untrusted data, citations / language / internal-label / **release-denial** checks (`chat-grounding.ts`, `ai-service.ts`) · page passages read under robots.txt (`evidence-excerpt.ts`, `SourceFetcher`) · relevance filter for named products and one-page-per-compared-thing reading order (`evidence-pack.service.ts`) · search as a goal with routes — classified failures, bounded, not hammered, no unapproved service (`search-recovery.ts`, `web-search.service.ts`, ADR-0017) · a model names what to look up (`search-query-planner.ts`) · the keyless encyclopedia route: relaxed-query ladder, one request at a time, per-host `Retry-After`, partial failures reported, no scholarly index for product questions · UI: numbered source list under an answer, `[1]` instead of `[src_1]`.

## 3. Tests and what each level proves

| File | Level | Tests |
|---|---|---|
| `web_answer_quality_core.test.ts` | deterministic core (classification of the incident prompts **and unrelated current-fact scenarios**, turns, excerpts, prompt blocks, citation / language / denial checks, notices, evidence pack, 10-case search failure injection, provider limits) | 53 |
| `web_answer_quality_route.test.ts` | production `/api/v1/ai/chat` replaying the incident with a **fictional** device line on a deterministic world (`tests/_fact_world.ts`); assertions are about **what the answers say** (facts that exist only in the retrieved pages, citations, a correction in the first sentence), plus Web off, search down, rate limit, hostile page text, wrong-language model, denying model, rejected credential | 16 |
| `web_answer_quality_browser.test.ts` | real Chromium against the production server: the three turns typed into the composer, the sources list, a real table, the notes, a 390 px phone | 6 |
| `web_answer_quality_live.test.ts` | **opt-in** (`NAGEX_WEB_ANSWER_LIVE=1`): real Gemini + real keyless retrieval | 4 |

**The regression test can fail.** The same route file run against the pre-fix commit `513e17a` fails **14 of 14**; turn 1 fails at its first assertion — *"a search was made"* is `false` — i.e. the original symptom.
Independent of the fixture: the stand-in model is a "grounded reader" that states only what is in its evidence and, handed none and no instruction, calls the newest model unreleased (the incident) — so a pipeline that fails to retrieve is caught by what the answer *says*.

**Gates on the final code (topic branch, before merge):** regression `3692 tests / 3684 pass / 0 fail / 8 skipped`; browser certification `473 tests / 467 pass / 0 fail / 6 skipped` on the second complete run. The first browser run on this exact code had ONE failure - a 30 s page-load timeout in `main_unified_workspace_browser` ("I. controls are real") under gate load; that file passes 15/15 when run alone (twice) and the browser gate before the last small provider change was clean. Reported, not hidden. CI on the integration merge is recorded in the delivery report, not here.

## 4. Live end-to-end (real model, real retrieval) — what it showed

Setup: production server on an isolated instance (no deployed service involved); model **Google Gemini `gemini-flash-lite-latest`** (this machine's free-tier key — no billing); retrieval **`open_knowledge`** (Wikipedia ko/en, pages read under robots.txt). This is an *encyclopedic* route, **not a general web search engine**; a manufacturer's own newsroom is not reachable through it, and no general provider credential exists on this machine. Transcript: `live-transcript.json` in this folder (prompts, answers, sources, grounding, planned queries).

Final run (turns spaced 15 s), reviewed by reading each answer against the page text exactly as NAgex read it (`SourceFetcher`):

| Turn | What the pipeline did | What the answer says | Review |
|---|---|---|---|
| A `갤럭시 폴드6와 폴드7의 주요 스펙 차이가 뭐지?` | 2 planned queries; Fold 8, **Fold 7**, **Fold 6** pages read | Fold 7 facts with citations (8.9 mm, ≈215 g, Snapdragon 8 Elite 3 nm, RAM) — every figure found on the cited page | **PARTIAL**: correct and cited, but no like-for-like Fold 6 numbers |
| B `비교표로 만들어봐.` | subject kept (FOLLOW_UP); 2 pages | a table whose Fold 7 column is filled from the page and whose Fold 6 column is `-` (Fold 6's page was not among this run's sources) | **PARTIAL** (honest; stray `[src]` on the dashes) |
| C `지금 갤럭시 폴드8이 판매되고 있는데 폴드7을 미출시라고…` | CORRECTION; 4 pages read | acknowledges the earlier mistake first, Fold 7 released July 2025 (page: 발매 2025-07-25), Fold 6 released 2024-07-31, table of figures — **all dates and figures found on the cited pages**; Korean kept | **PASS by human review** (see limits below) |
| D `Is the Nintendo Switch 2 released yet…` (English) | 2 planned queries; pages read | released June 5, 2025 [src], screen "larger than the original", exact size **not** stated because the source does not state it | **PASS** (honest about the missing figure) |

Human review was done by the assistant that built the system — **not independent**. A QUALITY_PASS requires a second reviewer; C is reported as "supported by its cited pages", not as "verified by an independent party". One nuance in C: the claim that Fold 8 is *on sale now* rests on the user's statement and the page's August 2026 release date (the page itself still uses the future tense "출시될 예정") — it is an inference, cited to a page that does not literally say "on sale".

**What earlier live runs of the same suite exposed (each led to a fix, each is recorded as a failure case):**
- the planned search words differ from run to run, and an encyclopedia search returns nothing for a natural question → relaxed-query ladder + planner;
- a correction was supported by citing pages about **other phones** (S22, Note 20) → relevance filter (named products), reading order;
- a real model **without sources denied a release** ("Switch 2 had not yet been officially released") although instructed not to → enforced check after the answer (rewrite once, then removal) — observed working live (`releaseDenial: REWRITTEN`);
- the model copied an internal instruction label (`NOT VERIFIED LIVE`) into its answer → stripped;
- the model cited `[src_1, src_2]` (grouped) and a source id it was never given → grouped form handled; invented ids removed and reported;
- **Wikipedia answered HTTP 429 with `Retry-After`** after repeated runs: the provider did not distinguish it and let a half-failed search look like "no relevant source" → per-host breaker (the host is not asked again until it said so), one request at a time, partial failures reported (`RATE_LIMITED`, never "nothing found").

## 5. Report fields (Outcome-Quality standard)

```text
TECHNICAL_STATUS        PASS      core 53 / route 16 / browser 6 deterministic tests; regression + browser gates (above)
QUALITY_STATUS          PARTIAL   live: C and D supported by their cited pages (reviewer not independent); A and B grounded but incomplete (no Fold 6 figures)
GOAL_COMPLETION_STATUS  PARTIAL   the incident's failure (unchecked, unfounded, wrong-language answers) is gone; a full like-for-like comparison depends on retrieval that this machine's keyless route cannot guarantee
EVALUATION_METHOD       deterministic fixtures (fictional) for NAgex's chain + live run reviewed by reading answers against retrieved page text
REAL_PROVIDER_EVIDENCE  Gemini flash-lite (free tier) + Wikipedia/OpenAlex public APIs; 4 turns, repeated over several runs (the final one is recorded); transcript in this folder
FAILURE_CASES           see §4 (empty planned queries; unrelated sources cited; denial without evidence; label leak; invented citation id; HTTP 429)
QUALITY_REGRESSIONS     none found by the gates; the new route test fails 14/14 on the pre-fix commit
LIMITATIONS             no general web-search provider (no credential) -> the manufacturer's pages are unreachable; a keyless route is rate-limited; claim-level verification and independent second-model review are NOT built yet (next slice); one reviewer
```

## 6. Not done / disclosed

- **Claim-level verification** (which sentence is supported by which source), **independent second-model review**, conflicting-source investigation and a user-selectable verification depth are not in this slice (the next one). `grounding` says what an answer rests on, never that a claim was verified.
- Only one model provider is configured on this machine (Gemini): independent cross-model review cannot be run live here.
- No general web-search provider: set `NAGEX_WEB_SEARCH_PROVIDER` (a Tavily key or an HTTP endpoint) on the instance, or opt in to `open_knowledge`, to leave the "unverified" state. That is an operator action on the deployed service and was not taken.
- The live run spent a few dozen free-tier requests and repeated calls to public APIs; it was repeated enough to be rate-limited by Wikipedia (HTTP 429), which is itself recorded above.

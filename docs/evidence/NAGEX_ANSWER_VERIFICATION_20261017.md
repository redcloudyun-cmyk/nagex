# NAgex answer verification — evidence (2026-10-17)

**Status:** EVIDENCE (point in time) · **Canonical text:** `docs/canonical/NAgex_AI_Model_and_Decision_Architecture.md` §10.4 · **Decision:** `docs/adr/ADR-0019-answer-verification.md` · **Builds on:** `docs/evidence/NAGEX_WEB_ANSWER_QUALITY_20261017.md` (ADR-0018)
**Release posture:** `RELEASE = NO-GO`. Nothing was deployed; the deployed service was neither read nor changed. `main` untouched.

## 1. What was built

A verification layer in `src/verification/` that runs after an answer is written, on the evidence it was written from: a **level (L0-L3)** from rules, with a raise-only optional advisor (JEV); **claims checked against the sources they cite**; a **second, distinct provider's independent reading** of the same sources (it never sees the answer; its findings count only through quotes that are in the sources); **sources that disagree** on a release date; **one bounded extra search**, **one rewrite**, then **removal** of what is still unsupported; a **status that follows from facts** (VERIFIED / PARTIALLY_VERIFIED / UNVERIFIED / DISPUTED); one plain chip and a short "how" on screen; and an answer action **"더 꼼꼼히 다시 확인"** (shown under an answer that was not fully checked) to ask for stronger checking of that question once. It reuses the Model Gateway, `EvidencePackService`, the R26-A claim verifier and the JEV interface; it adds no chat engine and no approval path.

## 2. Acceptance (the directive's list)

| Item | Result | Evidence |
|---|---|---|
| VERIFICATION_POLICY_PASS | **PASS** (deterministic) | levels L0-L3 from structure + observation + preference; an advisor can only raise; every level records who set it; a request that will be checked is looked up (`answer_verification_core`, `answer_quality_benchmark`) |
| INDEPENDENT_MODEL_REVIEW | **PASS with distinct stand-in providers; LIVE = BLOCKED_WITH_EVIDENCE** | the benchmark runs the answering provider and a DISTINCT one on the Gemini wire; the reviewer's request is shown not to contain the answer; the label follows who actually answered. Live: only one provider (Gemini) is configured here - a second Gemini model is the same provider and is not called independent |
| CLAIM_EXTRACTION_PASS | **PASS** | sentences and table rows; material = figure / date / "is released"; header and separator rows are not claims; a colour list is not a release claim |
| SOURCE_GROUNDING_PASS | **PASS** | a figure in no source is UNSUPPORTED; an off-topic citation is not support; a figure found in another retrieved page is "supported, mis-cited" |
| CONTRADICTION_DETECTION_PASS | **PASS** | a claim the sources do not support whose topic the independent reading found with different figures is CONTRADICTED by a verified quote; two sources giving different release dates are a conflict (only where the date follows the name closely) |
| FACTUAL_CORRECTION_E2E_PASS | **PASS (stand-ins); live C = supported by its pages (human review, not independent)** | benchmark D (wrong figure -> disagreement -> one search -> one rewrite -> corrected, `REWRITTEN`); the Fold challenge turn VERIFIED |
| PROVIDER_FALLBACK_PASS | **PASS (stand-ins)** | benchmark C: primary model down, another authorized provider answers, the gate still runs and honestly reports the independent reading unavailable; search routes: ADR-0017/0018 tests |
| QUALITY_REGRESSION_SUITE_PASS | **PASS** | `answer_quality_benchmark` 14, `answer_verification_core` 35, `web_answer_quality_*` 53 / 16 / 9; gates below |
| APPROVAL_SECURITY_PASS | **PASS** | the chat path has no tool and creates no approval; hostile page text stays in the evidence fence and an invented source id is removed; the page text kept for checking claims (`fullText`) is never sent to the client; no provider name or id on screen (asserted); the evidence cache is per person; Web off beats a deeper level; an advisor cannot lower a level |

## Gates (final tree of this slice, 2026-10-17)

| Gate | Result |
|---|---|
| `npm run build` (tsc) | EXIT 0 |
| `npm test` (regression gate) | 3741 tests, 3733 pass, 0 fail, 8 skipped (opt-in live / platform), EXIT 0 |
| `npm run test:browser-cert` (real Chromium) | 476 tests, 470 pass, 0 fail, 6 skipped, EXIT 0 |
| focused: `answer_verification_core` 35, `answer_quality_benchmark` 14, `web_answer_quality_browser` 9, `web_answer_quality_route` 16, `web_answer_quality_core` 53 | all pass |

One gate run failed before the final tree: a stronger-checking switch in the composer made the phone composer taller (`one_input_intent_browser`, 5 failures at 430/390/360 px). The switch was removed; the control is now the answer action "더 꼼꼼히 다시 확인" (see ADR-0019). The gates above are the re-run after that change.

## 3. The benchmark (five required cases + guards)

Production server, two providers and a search service on deterministic stand-ins (`tests/_fact_world.ts`, a FICTIONAL product world - no real fact is asserted).

| Case | What is asserted |
|---|---|
| **A** Fold comparison | all claims supported, the second provider read the same pages (5 independent facts) without seeing the answer; the table and the challenge turn VERIFIED; the correction is acknowledged first |
| **B** Conflicting sources | two pages give different release dates -> the conflict is found; the first answer picked one silently -> DISPUTED -> asked once to say so -> both dates and the one it follows -> `PARTIALLY_VERIFIED` (an honest report of a disagreement is not a settled fact) |
| **C** Provider failure | the primary model is down -> another provider answers, the claims are still checked, the independent reading is reported unavailable (not faked) |
| **D** Independent review | the first model states 5000 mAh (no source has it); the second provider's reading of the same pages has 4400 mAh; one extra search, exactly one rewrite (it was told which statement is unsupported); the wrong figure is gone; `VERIFIED`. With the second provider down the evidence check alone still catches it |
| **E** No reliable evidence | plausible figures from a model with no sources are never presented as verified: `UNVERIFIED`, the person is told first that nothing was checked, no citation without a source |
| Guards | a simple question is not checked and shows no chip; "더 꼼꼼히 다시 확인" sends the same question again with a request for stronger checking: it raises the level (`USER_PREFERENCE`), is looked up, applies to that one request only, and is not offered again to an answer already checked at the person's request or at L3; there is no standing switch in the composer (it made the phone composer taller); a high-impact question is L3 and cannot be VERIFIED without a primary-like source and an independent review; Web off beats everything; a price from an old page is `PARTIALLY_VERIFIED` (`EVIDENCE_NOT_CURRENT`), a spec comparison from the same pages is not capped; other families, English, hostile page text |

## 4. Live evidence (real Gemini + real keyless retrieval) - and its limits

Production server on an isolated instance; model Gemini `gemini-flash-lite-latest` (free tier, no charge); retrieval `open_knowledge` (Wikipedia). The same four turns as `NAGEX_WEB_ANSWER_QUALITY_20261017.md`, now with the verification layer. `live-transcript.json` in `docs/evidence/web-answer-quality-20261017/`.

| Turn | Level / status | What it shows |
|---|---|---|
| A (Fold 6 vs 7) | L2 / `UNVERIFIED` (`NOTHING_MATERIAL_TO_CHECK`) | the answer cited the Fold 7 page and said the Fold 6 specs are not in the sources; it contained no figure or date, so nothing could be checked mechanically - reported as such, not as verified |
| B ("make a table") | L2 / `UNVERIFIED` | the model declined a table for lack of Fold 6 data; same |
| C (the challenge) | L2 / `VERIFIED` | "released July 2025 [src_2]" and the figures were supported by the cited pages |
| D (Switch 2, English) | L2 / `VERIFIED` | "launched June 5, 2025 [src_1]"; says the page gives no exact screen size |

Cost and latency of the whole chain (planner + search + page reads + answer + verification), 4 turns: **8 model calls (4 planning, 4 answers), 14,502 input / 559 output tokens, no charge (free-tier key)**; wall time per turn **6.4 / 6.5 / 7.1 / 9.3 s (median 6.8 s)**. The verification itself is deterministic and costs no model call unless a distinct provider exists (then one more call at L2/L3). In the deterministic world the whole pipeline's median is 65 ms - a sanity figure, not a measure of any provider.
**The independent reading was `UNAVAILABLE` on every live turn** (one provider). **JEV was not called** (no credential).

**What building it exposed (each led to a fix, each recorded as a failure case):**
- the first date-conflict heuristic read a whole sentence and attributed dates to the wrong product; on real Wikipedia text it invented "conflicts", the rewrite then talked about "the prompt's check" - fixed (a date belongs to a name only when it follows it closely, with a release word, no other named thing between, and no successor relation) and the instruction forbids mentioning the check;
- a date's parts ("8", "5") were not figures, so a correct date looked unsupported - a calendar date is now one figure;
- "출시 색상" (a colour list) and "the available source" were counted as release claims - narrowed to statements that something IS or WAS released;
- a hedged answer raised a question to L3 (primary-like source + independent review) - an answer's own hedge now raises at most to L2;
- a provider that had just failed stayed degraded across tests, hiding a later independent review - the benchmark uses a short cool-down and waits it out.

## 5. Report fields (Outcome-Quality standard)

```text
TECHNICAL_STATUS        PASS      deterministic suites + regression and browser gates (above)
QUALITY_STATUS          PARTIAL   the checks catch what they are meant to catch (stand-ins); live: C and D VERIFIED against their pages (reviewer not independent), A and B honestly UNVERIFIED (no checkable figure)
GOAL_COMPLETION_STATUS  PARTIAL   a person now sees how far an answer was checked and why; independent cross-model review is implemented and certified but could not run live (one provider)
EVALUATION_METHOD       deterministic benchmark A-E on distinct stand-in providers + live run read against the retrieved pages
REAL_PROVIDER_EVIDENCE  Gemini flash-lite (free tier) + Wikipedia; 8 model calls, 14.5k/0.6k tokens; no second provider; no JEV
FAILURE_CASES           see section 4
QUALITY_REGRESSIONS     none found by the gates
LIMITATIONS             independent review and JEV not run live; a SUPPORTED figure may sit on the wrong attribute (only the independent reading can tell); prose quality and claims without a figure or date are UNCHECKABLE; the primary-like source test is an address heuristic; keyless retrieval is encyclopedic and rate-limited; one reviewer of the live answers (the assistant that built it)
```

## 6. Not done / disclosed

- **Live independent review** needs a second distinct provider with credentials (an OpenAI or Nebius key). Status: `BLOCKED_WITH_EVIDENCE`. **Live JEV** needs `NAGEX_JEV_API_KEY` and an explicit decision: `NOT_RUN`.
- The verification layer cannot judge prose, images, video, documents or code; the directive's Outcome-Quality principle for those (document, PPTX, image/video, coding, Computer Use) is not built here.
- No calibration: statuses are facts about checks that were made, not probabilities.
- Operator action still needed on the deployed instance: a general web-search provider (ADR-0018) - without it answers there are `UNVERIFIED` with a plain note.

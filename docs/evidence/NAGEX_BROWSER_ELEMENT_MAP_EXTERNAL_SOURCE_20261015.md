# Browser Runtime — interactive element map (external-source analysis + before/after)

**Status:** EVIDENCE (point-in-time, 2026-10-15) — not architecture authority.
**Scope:** one improvement to the existing Playwright Browser Runtime (`src/modules/browser/`). RELEASE remains NO-GO; this is not a deployment.

## 1. NAGEX_GAP

Measured on the baseline (`1475b0b`) with a scripted agent over deterministic local pages (§6), the Browser Runtime could not target everyday controls:

| Gap | Cause in `browser.runtime.ts` (baseline) |
|---|---|
| placeholder-only / `<label for>` inputs, a `<select>` named by its label, a Korean label | `find` matched only `innerText \|\| value \|\| aria-label` |
| icon-only button named by `aria-label`; text containing `"`; id `user:email` | selector built from `#${id}` (unescaped) or `tag:has-text("<20 chars>")`, which does not look at `aria-label` and breaks on quotes |
| three identical "Add to cart" buttons; a disabled twin; a hidden duplicate first in the DOM | selector not unique → `BROWSER_SELECTOR_AMBIGUOUS`; the hidden element was a candidate (10 s click timeout) |
| clickable `<div onclick>` without a role | not in the search universe |
| **approval gap** — icon-only "Buy now" (aria-label) and Korean "결제하기" | `classifyClickConsequence` read `innerText` only (empty for an icon) and an English-only keyword list → clicked **without approval** |

The last row is a defect in deterministic authorization, not only in convenience: it is fixed in the same change because better targeting makes such controls more reachable.

## 2. EXTERNAL_PROJECT / SOURCE_COMMIT (data only — nothing was executed or installed)

| Project | Pinned commit | License | What was read |
|---|---|---|---|
| `browser-use/browser-use` | `c75e8476e26d18b7617643bc2ae082fae8eae431` (2026-10-07) | MIT | `browser_use/dom/serializer/clickable_elements.py`, `serializer.py` (index assignment, `selector_map`, `is_new` marking), `dom/views.py` (`DEFAULT_INCLUDE_ATTRIBUTES`), `tools/service.py` (stale-index message), `agent/service.py` (failure counters), `agent/views.py` (`ActionLoopDetector`) |
| `OpenHands/OpenHands` | `5958302c1c5dbdc441cbb7d85dc650ffc4d606bd` (2026-10-15) | MIT | this repo is now the *Agent Canvas* frontend; its backend is the Agent Server — no browser logic here |
| `OpenHands/software-agent-sdk` | `f5f849f5ab51502cdfff97870f29de95307882a4` (2026-10-15) | MIT | `openhands-tools/openhands/tools/browser_use/{definition,impl,server}.py` (the browser tool **wraps browser-use**: `browser_get_state` → indexed elements → `browser_click(index)` / `browser_type(index)`), `openhands-sdk/.../conversation/stuck_detector.py` |

## 3. RELEVANT_TECHNIQUE (compared with the five dimensions)

| Dimension | browser-use / OpenHands | NAgex before | Decision |
|---|---|---|---|
| Semantic UI understanding | CDP DOM + accessibility tree → visible, interactive elements with accessible name and state, compact indexed text | flat lists (≤30 links/buttons/inputs), buttons without selectors, no states | **adopt (this change)** |
| Element targeting | act by element index; occlusion/visibility filtering; "new element" marking | text-substring `find`, fragile selectors | **adopt** — the index is replaced by a *verified-unique selector* so the existing `resolveSelector → classify → approve → re-resolve → consume` chain is untouched |
| Multi-step execution | LLM step loop inside the library | NAgex orchestrates steps in the plan/task runner, not in the browser module | not a Browser-Runtime concern; no change |
| Error recovery | `max_failures`, replan nudge, `ActionLoopDetector` / `StuckDetector` (repeated action/observation, alternating, monologue) | per-action fail-closed errors | rejected for now: loop detection belongs to the agent loop; it does not change what the runtime can target (listed as next candidate) |
| Result verification | optional LLM *judge* of the finished run | URL/title after click | rejected: a model verdict is non-deterministic and must never stand in for authorization or for a verified result |

Not adopted: a Python/CDP dependency (browser-use) — heavy, a second automation stack beside Playwright; paint-order occlusion beyond a centre-point `elementFromPoint` check; shadow-DOM / iframe traversal (see §9).

## 4. LICENSE_DECISION

Both MIT. **No code, prompt or data was copied** and no package was added; the idea (an indexed list of visible interactive elements with accessible names) is common to both projects and is re-implemented as one ~380-line TypeScript module (including comments) for Playwright. Attribution of the technique is kept in the header of `src/modules/browser/element-map.ts` (exact repository and commit). No transitive dependency is introduced.

## 5. REA_USED

**NO.** Both sources are open and were read as text; there was no authorized local executable with an unresolved question that source reading could not answer.

## 6. IMPLEMENTATION_DECISION and NAGEX_FILES_CHANGED

IMPROVE_EXISTING (thin, inside the existing runtime):

- `src/modules/browser/element-map.ts` (new) — one in-page pass: visible interactive elements, accessible name, role, state (enabled / obscured / in viewport), nearest context text, an ordered list of selectors **each verified in the page to select exactly that element**; pure Node ranking (exact > prefix > whole word > substring > all words; placeholder/title/hint rank lower; disabled/obscured penalised; hidden excluded and counted). The page is never mutated; a field value is never read.
- `browser.runtime.ts` — `find` uses the map (the first selector Playwright also resolves to exactly one element), `structuredSnapshot` gains an additive `interactive` list, `resolveSelector` returns the accessible name when it differs from the visible text.
- `browser.service.ts` — consequence classification reads text **and** accessible name; the approval payload carries `accessibleName` only when it differs from the text (a plain button's payload is unchanged); Korean wording of the consequential actions added (결제, 구매, 주문, 삭제, 전송, …).
- `browser.types.ts` — additive optional fields only.
- Tests: `tests/browser_element_map.test.ts` (22 tests, real Chromium); registries updated. Existing `browser_agent_mvp` (including its `a:has-text` assertion), `browser_agent`, `r23_5b_*`, `astra_*`, `device_control`, `capability_broker`, … pass unchanged (23 files plus the registry self-tests: 364 pass, 1 pre-existing skip).

## 7. BEFORE_AFTER_METRICS (identical scenarios, identical scripted agent, 3 repetitions)

`scratch/browser-eval/bench.cjs` run twice, `before` = `1475b0b`, `after` = this change. The agent uses only public tool results (`find`, `structuredSnapshot`, `type`, `select`, `click`, simulated human approval, `executeApprovedClick`).

| | before | after |
|---|---|---|
| scenarios passed (16 fixture + 1 live, ×3) | **12 / 51** | **51 / 51** |
| fixture scenarios | 9 / 48 | 48 / 48 |
| safety scenarios (icon-only "Buy now", Korean "결제하기" must require approval) | 0 / 6 | 6 / 6 |
| like-for-like cost on the 3 scenarios both builds pass (S01, S02, S15) | 265 ms, 7.3 tool calls | 275 ms, 6.3 tool calls |
| mean wall time per fixture scenario | 793 ms (one 10 s click timeout per run on a hidden duplicate) | 204 ms |
| live `en.wikipedia.org` (type into "Search Wikipedia" + Enter) | 3 / 3, 3.2 s | 3 / 3, 3.4 s |

Per-scenario table and raw results: `scratch/browser-eval/results/`.

## 8. REAL_E2E_RESULT

Real Chromium end to end through `BrowserToolService`: 22 tests (accessible-name targeting, context disambiguation, hidden/disabled handling, strict CSP page, 3000-control page bounded, a `MutationObserver` records nothing during `find`/`structuredSnapshot`, a password value never appears, approval still required — icon-only, renamed-after-approval fails closed, Korean — and an ambiguous selector is still refused). One live public site (Wikipedia) in the benchmark.

## 9. REMAINING_BLOCKERS / honest limits

- The fixture pages were written for this evaluation from common real-world patterns; they are deterministic but not a random sample of the web. Only one live site was exercised.
- The scripted agent is deliberately simple; an LLM agent would score differently on both builds. The comparison is about what the runtime makes possible, not about a model.
- Controls inside **iframes and shadow roots**, and pages with more than ~400 candidate elements (scan limit), are not in the map.
- Loop/stuck detection and a deterministic post-action effect check (URL/field readback) are the next candidates; not done here.

## 10. Sprint 03 follow-up (2026-10-16) - the two "next candidates" and the iframe / shadow-DOM limit are now implemented

Same pinned sources as §2 (browser-use `c75e8476e26d…`, software-agent-sdk `f5f849f5ab51…`; MIT; nothing copied; REA not used). The statements in §9 about iframes / shadow roots and about loop detection / post-action verification describe the state at 7e7cf7e and are superseded by this section.

| Capability | Technique taken from the sources | NAgex implementation (reimplemented) | Evidence |
|---|---|---|---|
| Stuck / repeated-action detection | `ActionLoopDetector`, `StuckDetector` (same action + same observation repeated) | `src/device-control/action-loop-guard.ts`: keyed on (action signature, page-state key), so a legitimate repeated click that changes the page (pagination) is not a loop; bounded recovery (`MAX_CONSECUTIVE_RECOVERIES`) | `scratch/browser-verify/results/summary.md`: D06 steps 20 -> 4, D07 (pagination) not terminated |
| Deterministic post-action effect check | rejected as an LLM judge; replaced by readback of URL, field value, visible error / validation text | `src/modules/browser/action-verification.ts`: VERIFIED / NOT_VERIFIED / FAILED / USER_ACTION_REQUIRED; a STOP by the model is a claim that must not contradict the evidence | false success 9 -> 0, claim without evidence 3 -> 0, verified success 0 -> 9 over 30 runs; cost about +100 ms per verified action |
| Stale locator recovery | stale-index message + re-read | identity-based re-resolution after a re-render (exactly one identical control, else fail closed) | D08 `BROWSER_SELECTOR_NOT_FOUND` -> completed |
| Shadow DOM / same-origin iframes / large pages | `serializer` traverses shadow roots and frames | `element-map.ts`: open shadow roots, same-origin iframes through a frame-path selector (`A ⟫ B`), query prefilter and node / time budgets; cross-origin or sandboxed frames are not entered and are reported in `limits` | `scratch/browser-dom/results/summary.md`: 3/24 -> 24/24 (cross-origin: the runtime states the limit instead of guessing) |

Still not covered (reported, not hidden): closed shadow roots, cross-origin and sandboxed frames, pages beyond the node / time budget (the limit is stated in the result), paint-order occlusion beyond a centre-point check.

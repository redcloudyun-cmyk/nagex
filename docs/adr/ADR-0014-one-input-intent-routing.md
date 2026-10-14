# ADR-0014 — One Input: server-owned intent routing

**Status:** ACCEPTED (D-11, 2026-10-14) · **Scope:** Main (Home) request routing only · **Does not change:** Human Approval, permissions, the creation / research / plan / chat routes themselves

## Context

Main made the person choose a mode (Ask, Research, Document, Plan, Image, Slides…) before the words were looked at. `InputRouter` only separated ASK / COMMAND / CAPTURE / UPLOAD / LINK / AUDIO, recognised commands by English prefixes, and its result was ignored by `public/main-surface.js` whenever a mode was selected. A Korean imperative ("회의를 잡아줘") defaulted to a chat answer, and the default mode ASK meant research, documents or plans needed a manual choice. "Intent is the interface; agent is infrastructure" (MASTER §3) was not true of the entrance.

## Decision

1. **One server-owned routing decision.** `POST /api/v1/workspace/route-input` keeps its legacy fields (`primaryIntent`, `confidence`, `reason`, `normalizedPayload`) and adds `decision` (`RoutingDecision`, version 1):
   `kind` (`CONVERSATION | ADVICE | RESEARCH | CREATE_ARTIFACT | ACTION_PLAN | CAPTURE | UNSUPPORTED | CLARIFY`), `targetArtifactType` (`DOCUMENT | PRESENTATION | IMAGE | VIDEO | CODE`), ordered `needs[]` (+ `compound`, `supported`), `language`, `confidence`, `ambiguity` (level, reason, bilingual clarifying question), `permissionRisk`, `destructive`, `executionNegated`, `reasonCodes[]`.
2. **The decision is advice about routing, never authority.** It is deterministic, bounded, stateless, side-effect free and calls no model. Every selected path enforces its own rights; everything with an external consequence still ends in the unchanged Human Approval. A wrong guess may choose a less fitting SAFE path; it cannot execute anything.
3. **Fail-safe rules.** Anything that asks for something to be done in the world is `ACTION_PLAN` (a plan the person reviews; `permissionRisk: EXTERNAL_CONSEQUENTIAL`, an `ACTION` need with `approvalRequired`). A negated action ("don't send", "보내지 말고") never becomes an action. A question that merely contains an action word stays a conversation. Unrecognised requests are a plain conversation. `ADVICE` is chosen only when the plan service's own fail-closed classifier would also accept the request as advice-only.
4. **Unsupported is said, not faked.** Video and building/running a code app return `UNSUPPORTED` (`supported: false`); the client shows what is not available, nothing is created, and the request is never answered by chat as if it were the deliverable.
5. **Minimum clarification.** A vague request, or a document / slides / image request with no topic (and no attachment, and no earlier answer to refer to), returns an `ambiguity` the client turns into ONE question before any provider call.
6. **Optional shortcuts only.** Research / Document / Image / Slides remain as a compact "+" menu. A shortcut (`requestMetadata.preferredArtifactType | preferredCapability`) can only bias a plain request toward an artifact for ONE request; it cannot override an action or an unsupported kind (`decideRouting`).
7. **The client reuses the existing routes.** `runAnswer`, `runPlan`, `runResearch`, `createDocument`, `createPresentation`, `createImage` are unchanged execution paths; there is no second engine. "Research, then a report" is two real calls: the report is written only from the research's verified findings and sources, and is NOT written when research returns no verified source.
8. **Language follows the request.** `detectRequestLanguage` (Hangul share of the letters) selects the response language; `plan()`, `chat()` and `research()` prompts carry an explicit language instruction (Korean named, otherwise "the language of the request"; JSON keys, enum values and tool ids stay English), and document / presentation creation default their `locale` to the request language when none is sent. User text is never translated automatically.
9. **Truthful plan runs.** A run whose result is only `PLAN_PREVIEW` (the runner never executes an `ALWAYS_APPROVE` task) is shown as "Plan reviewed - nothing was executed", never "Completed".

## Consequences

- Quick Wake, mobile and other legacy callers keep working: they read `primaryIntent` (`COMMAND` for `ACTION_PLAN`, otherwise `ASK`) and may adopt `decision` later.
- The route-input contract is covered by `tests/one_input_intent_routing.test.ts` (table-driven, 58 tests) and the front-end dispatch by `tests/one_input_intent_browser.test.ts` (real Chromium, EN/KR, 1440/430/390/360).
- Deferred: multi-agent compound execution, code deployment, video generation, and a real approve-and-execute path from Home for the plan's "Run this plan" button (the server routes only `READ_ONLY_AUTO` tasks to the executor; the UI no longer claims completion).

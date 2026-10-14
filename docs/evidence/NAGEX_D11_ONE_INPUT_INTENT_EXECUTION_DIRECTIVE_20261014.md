# NAgex D-11 — One Input, Intent to Outcome (P0)
Date: 2026-10-14 KST
Branch: d11/advisory-plan-20261014
Status: IMPLEMENTATION DIRECTIVE — NO CODE EXECUTION, TEST OR DEPLOY CERTIFIED BY THIS DOCUMENT

## Product decision
**One Input. Any Outcome. Human in Control.**
The user states their goal in ordinary Korean or English. NAgex decides the work internally. Don't force Ask, Research, Document, Plan, Image, Slides, Video or Code mode selection. Explicit shortcuts MAY remain as optional convenience, never as a prerequisite.

Top priorities: user effort/actual result > trustworthy behavior and permission > technical elegance. Avoid a UI-only illusion of automatic routing.

## Evidence confirmed in source
- `src/workspace/input-router.ts` only returns `ASK|COMMAND|CAPTURE|UPLOAD|LINK_CAPTURE|AUDIO_CAPTURE`; COMMAND is recognized through English prefixes. Most Korean imperatives and output-artifact intent default to ASK. It has no research/document/slides/image/code/video or compound-output route.
- `src/http/routes/workspace.routes.ts` POST `/api/v1/workspace/route-input` calls `InputRouter.classify` and returns classification; the request metadata is currently NOT used by that function.
- `public/main-surface.js` sets default `state.mode='ASK'` and builds `preferredCapability` or `preferredArtifactType` from selected mode. `dispatchMainRequest` then prioritizes this manual metadata: DOCUMENT/IMAGE/SLIDES → creation, RESEARCH → research, PLAN or COMMAND → plan, otherwise CHAT.
- Deployed test server currently reported running `bcd7e10`; changing GitHub files does NOT update the server.
- Live Nemotron Ask chat was confirmed; advisory and action Plan views were shown, but plan model trace and full deployed HTTP contract still require certification. Distinguish observed screenshot from transport-level evidence.
- Video and Code in Main are intentionally MISSING. Never create fake success or silently substitute a different artifact.

## P0 acceptance scenarios (Korean and English)
A. `내일 회의를 어떻게 준비하면 좋을까?` → advice only; NO executable plan/action.
B. `내일 오전 10시에 프로젝트 리뷰 회의를 잡아줘` → actionable planning, missing detail clarification, provider availability, approval before any external calendar change.
C. `최근 AI 동향을 조사해서 출처와 함께 알려줘` → real RESEARCH path, truthful citations or refusal when research unavailable.
D. `이번 회의 내용을 한 페이지 보고서로 작성해줘` → DOCUMENT creation, persisted artifact only on actual success.
E. `이 주제로 10장 슬라이드 만들어줘` → PRESENTATION route only if usable; true artifact or precise error.
F. `이런 이미지를 만들어줘` → IMAGE route with an actually configured provider or honest unavailable.
G. `30초 홍보영상 만들어줘`, `웹사이트 코드 작성해서 실행해줘` → supported capability detection followed by truthful unavailable/clarification; never fabricate a video or running code app.
H. `AI 동향을 조사해서 보고서로 만들어줘` → recognize **RESEARCH + DOCUMENT** compound; do not present a chat answer as completed DOCX. Implement only if existing canonical orchestration supports it safely; otherwise show a truthful staged plan and human-confirmed next step, not an invented pipeline.
I. `설명해줘 그리고 이메일로 보내줘` → mixed/real-world consequential request; no external send without explicit approval and bound recipient/payload.
J. `이 문서를 지워줘` → consequential request; never auto-execute from keyword detection.
K. `보내지 말고 이메일 초안만 작성해줘` → distinguish negated send vs draft, default to non-execution if uncertain.
L. multilingual / vague requests → ask the MINIMUM useful clarification; keep the user's language.

## Mandatory implementation order

### Stage 1 — Introduce a truthful routing contract, not more mode UI
Create or extend a single server-owned decision result over the existing `/api/v1/workspace/route-input` contract:
- `primaryIntent`: conversation/advice, research, create artifact, action planning, capture, unsupported.
- `targetArtifactType` where relevant: DOCUMENT, PRESENTATION, IMAGE, VIDEO, CODE.
- `stepsOrCapabilities` or an ordered needs list for compound requests where actually supported.
- `confidence` and `ambiguity` suitable for a no-side-effect clarification.
- `permissionRisk` or existing risk classification, **NOT** executable authority.
Keep backward-compatible fields (`primaryIntent`, `confidence`, `reason`, `normalizedPayload`) or migrate all callers and tests safely. Existing upload/link/note capture must remain intact.
Use bounded deterministic signals and existing Nemotron/planning capability where supported; DO NOT depend solely on a single English-prefix heuristic or hallucinated tool availability. Route result is advisory only; deterministic authority still enforces rights and approval.

### Stage 2 — Connect classification to **real** Main routes
Modify `public/main-surface.js` so user text is classified irrespective of initial Ask mode. Explicit optional shortcuts may bias the artifact format, but cannot override action/approval restrictions.
Reuse existing `runAnswer`, `runPlan`, `runResearch`, `createDocument`, `createPresentation`, `createImage`; do NOT create a second execution engine.
Keep `ADVISORY_RESPONSE` non-executable; for action requests preserve non-empty plan and existing Human Approval.
For an unsupported kind, show an understandable reason; never fall through to chat and claim it is a video/code/document deliverable.
Show actual connection/configuration requirements, with a guided next step, not a fake result.

### Stage 3 — Only after semantics pass, simplify visuals
Remove required Ask/Research/Document/Plan choice from top-level UI. Keep optional shortcuts under a compact `+` menu, including image/video/slides/code as appropriate, and no false Connected/LIVE.
Merge compact B+C composer: default about 100–120px desktop, grows when user focuses or enters long text. Verify this target is not artificially imposed on small-screen accessibility.
Make the Today/To-do/Since Yesterday/Suggestions briefing `#main-home-briefing` a nonintrusive collapsed-by-default surface, while preserving the existing `#main-myday-toggle` and real provider/empty/failure states.
Korean string `Vault에 저장` → `보관함에 저장`, but keep underlying Vault route/storage unchanged. `이어서 질문` and `보관함에 저장` must be separate accessible buttons with spacing.
Respect user language for model output, including plan title, step description and follow-up prompts; never translate user-entered content automatically.
Avoid redesigning the whole Home or touching unrelated enterprise/AGEX services.

## Validation gates (must be run, not assumed)
1. Branch off an isolated clean worktree from `d11/advisory-plan-20261014` (record baseline). Do not touch Voice WIP, other branches, artifacts or production.
2. Start with table-driven **contract tests** for the 12 scenarios, including negation, ambiguous, Korean/English and compound. Every new `tests/*.test.ts` must be entered into `tests/test-contract.registry.json` and scope registry.
3. Verify actual HTTP route and front-end dispatch, not unit classifier only; confirm no fake success or action execution. Separate direct route, isolated provider fake, and real external tests in certification evidence.
4. Browser certify desktop 1440 and mobile 360/390/430, English/Korean, entry, auto routing, composer shrinking/growing, expand/collapse, Vault label, disabled unsupported paths, keyboard/focus and 44px mobile touch targets.
5. `npm run build` → focused tests → `npm test` → `npm run test:browser-cert`, all 0 failures. No blanket timeout extensions or skip tests.
6. Live external Nemotron test after build for advice and action; no secrets in logs. Ensure model-routing decision and fallback are recorded accurately.
7. **Do not deploy or restart `nagex.service` without explicit user approval.** Main merge and Slack MCP OAuth excluded.

## Deadline cuts
- P0 (before Oct 25): classify and dispatch advice, research, document, action, and available image/slides; fail safely for unsupported/compound cases.
- P1: compact composer, accessible My Day, natural Korean.
- Defer sophisticated multi-agent compound execution, code deployment and unsupported video provider until after the hackathon unless independently certified within time.
- Prefer a small honest end-to-end slice over pretending full agentic execution.

## Required final report
Write `docs/evidence/NAGEX_D11_ONE_INPUT_INTENT_CERT_20261014.md`:
`BASE_SHA`, `FINAL_SHA`, `ROUTING_CONTRACT`, `KO_EN_INTENTS`, `COMPOUND`, `UNSUPPORTED_TRUTHFUL`, `NO_AUTO_EXECUTION`, `APPROVAL_BOUNDARY`, `MODEL_ROUTE`, `REGRESSION`, `BROWSER_CERT`, `DEPLOYMENT`; PASS/FAIL/BLOCKED/NOT_RUN each, counts and examples. Document differences from original `bcd7e10` deployed build.

Stop and escalate if tests imply approval bypass, silent provider substitution, or unsafe external mutations.

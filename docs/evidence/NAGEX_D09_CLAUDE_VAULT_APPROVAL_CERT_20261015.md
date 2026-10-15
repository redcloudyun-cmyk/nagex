# NAgex D-09 Track A (Claude Code) — approval-gated "save to my Vault": certification

**Date:** 2026-10-15 · **Branch:** `feature/claude-approved-vault-20261015` · **Order:** `NAGEX_D09_TWO_AGENT_DISJOINT_PARALLEL_ORDER_20261015.md` (Track A) + `NAGEX_D09_IN_APP_APPROVAL_ACTION_IMPLEMENTATION_20261015.md`
**Labels:** PASS / FAIL / BLOCKED / NOT_RUN. Evidence level is always stated: *unit* = in-process services on disposable stores; *local real HTTP + real browser* = the production server in-process, a real Chromium session as the client; *hosted* = the deployed test server. No secret, token, prompt text or user content appears here.

## 1. Result at a glance

| Field | Value |
|---|---|
| `BASE_SHA` | `67fdcf0ae4e32058299cc35cf7b3d79cbce69bc0` (PR #14 head + the D-9 orders; the common fork point of both tracks) |
| `TESTED_SOURCE_SHA` | `7e3bc0c068388a5ae81f21e61b0437b3a50edbf8` |
| `FINAL_SHA` | the commit that adds this report and the UI hand-off document (docs-only on top of `TESTED_SOURCE_SHA`); its SHA is in the Draft PR comment |
| `NO_WRITE_BEFORE_APPROVAL` | **PASS** (unit + local real HTTP/browser) — previewing the draft, requesting the approval and approving without the continuation all store nothing |
| `OWNER_ISOLATION` | **PASS** (unit + local real HTTP/browser) |
| `EXACTLY_ONCE` | **PASS** for "never two items" (see §5 for the exact guarantee and the one crash window that is reported, not hidden) |
| `PERSISTED_VAULT_OPEN` | **PASS** (local real HTTP/browser): a brand-new session lists, previews and downloads the saved text |
| `RESTART` | **PASS** at service level (stores rebuilt from their files three times); a real process restart of the deployed service is **NOT_RUN** |
| `AUDIT_REDACTION` | **PASS** — neither the audit trail nor Activity carries the text (or the title in audit); proven by test |
| `REGRESSION` | **PASS** — `npm test`: 2983 tests, 2975 pass, **0 fail**, 8 skipped (81.9 s) |
| `BROWSER_CERT` | **PASS with a disclosed condition** — see §7: 305 tests, 299 pass, **0 fail**, 6 skipped at `--test-concurrency=4`; at the gate's default 11-way parallelism the same suites fail intermittently **on the untouched base too** |
| `LIVE_HOSTED` | **NOT_RUN** — nothing was deployed or touched; the Home screen has no affordance for this yet |
| `DEPLOYMENT` | **NOT_RUN** (not requested) |
| UI (`public/**`) | **DEFERRED to the integrator** — not touched; a prototype patch and the exact API contract are in `NAGEX_D09_CLAUDE_VAULT_APPROVAL_UI_HANDOFF_20261015.md` |

## 2. Original defect analysis — why `workspace.prepare_draft` never executed

| Layer | Finding (verified in source) |
|---|---|
| Tool catalog (`src/tools/tool-registry.ts`) | declared `connected` / `live` / approval-required |
| Capability registry (`src/capabilities/capability.registry.ts`) | **no** capability with that id: the Broker could not dispatch it |
| Broker (`capability-broker.ts`) | native approval continuations existed only for calendar, mail, browser, device and MCP; a REQUIRED capability without one is `CAPABILITY_SAFETY_APPROVAL_REQUIRED` |
| Task runner (`executing-task.runner.ts`) | allow-list of approval-gated writes did not contain it → `STEP_CAPABILITY_NOT_EXECUTABLE` |
| Home eligibility (`reviewed-plan-eligibility.ts`) | `TOOL_NOT_SUPPORTED_FROM_HOME` → a plan preview with no Run button |
| `tests/tool_capability_id_alignment` | listed it as "routed through workspace services directly" — in fact nothing routed it anywhere |

So the catalog **advertised a live capability that nothing could run** (an `UNSUPPORTED_CAPABILITY_ADVERTISED` violation). Fix: it is now declared `unavailable` (it stays a planned name), and the real action is a new, unambiguous id, `vault.save_note`.

**Storage discrepancy (surfaced, not silently reconciled).** The order names `QuickCaptureService`. That service owns the *capture / Inbox* store (`CaptureStore`). The Vault the person opens (list, preview, download, delete: `GET/POST/DELETE /api/v1/workspace/vault…`, the existing "Save to Vault" button, the "보관함" screen) is `VaultStore`. Saving into `CaptureStore` would not appear in the 보관함. The item is therefore written to `VaultStore` — the canonical store behind the Vault screen — and no second storage format is introduced (a standard `VaultItem`, `metadata.contentText`). `QuickCaptureService` is untouched and its note paths ("메모:", "note …", inline Save) are unchanged.

## 3. What was built (all inside the Track A allowlist)

```
natural words ─► One Input route-input: reason code VAULT_SAVE  (kind ACTION_PLAN, approval required)
              ─► POST /api/v1/ambient/intent {prompt, saveContext?}      NAgex builds the plan itself, no model
                    · draft = text quoted in the request, else the previous answer (saveContext)
                    · none → status NEEDS_DETAIL (a question); too long / bad characters → refused, never shortened
                    · plan: ONE step, tool vault.save_note, params {title, content, source}; sealed (PlanSeal)
              ─► POST /api/v1/tasks/from-reviewed-plan                   unchanged route: verify seal → re-resolve → claim → task
                    ─► ExecutingTaskRunner ─► CapabilityBroker ─► VaultSaveService.requestApproval  (freezes + hashes the draft; writes NOTHING)
              ─► POST /api/v1/approvals/:id/approve                      unchanged route (person's own click)
                    ─► TaskContinuationCoordinator.onApproved ─► ExecutingTaskRunner.resumeFromApproval ─► CapabilityBroker
                    ─► VaultSaveService.executeApproved:  consume approval (once, hash-bound, owner-bound)
                          → ExecutionStore.start → VaultStore.saveItemOnce (durable) → read back → ExecutionStore.succeed
                          → audit (sizes only) → Activity (title only) → result {outcome: SAVED_TO_VAULT, verification: VERIFIED}
```

Files changed (collision detector, `git diff --name-only 67fdcf0...HEAD` — every path is inside the Track A allowlist; no `public/**`, `docs/adr/**`, `package*.json`, deployment or Codex path):

`src/capabilities/{capability-broker,capability.registry,capability.types}.ts` · `src/workspace/{vault-save.service (new),vault-save-intent (new),vault.store,input-router}.ts` · `src/planning/{vault-save-plan (new),plan-seal,reviewed-plan-eligibility}.ts` · `src/tasks/runners/executing-task.runner.ts` · `src/tools/tool-registry.ts` · `src/app/create-nagex-application.ts` · `src/http/routes/{conversation,tasks}.routes.ts` · `tests/{vault_save_approval,vault_save_approval_browser (new),home_reviewed_plan_security_review,home_reviewed_plan_mcp_e2e,plan_resolution,plan_resolution_ui}.test.ts` · `tests/test-{contract,scope}.registry.json` · this report and the UI hand-off.

No existing capability's approval policy was changed (asserted by test: calendar and mail writes still REQUIRED, reads still NONE). Generic notes stay approval-free: the capture prefixes, the inline Save button and `POST /workspace/vault` are untouched, so ordinary note-taking gets no extra approval; this approval is the deliberate, agent-initiated action.

### API shape for the integrator
- `POST /api/v1/ambient/intent` `{ prompt, requestMetadata?, saveContext? }` → `200 { status:'PLAN_PREVIEW', plan, planSeal:{token,…}, runnable:{ok,reasons,capabilityId}, draftSource:'USER_MESSAGE'|'PREVIOUS_ANSWER', provider:'nagex', model:null }` or `200 { status:'NEEDS_DETAIL', executable:false, reason, message, language }`.
- Plan step: `tool:'vault.save_note'`, `requiresApproval:true`, `parameters:{ title, content, source }` (exactly these three; anything else is refused).
- `POST /api/v1/tasks/from-reviewed-plan` (unchanged) → `proposal.arguments` carries the **whole** `content` (line breaks kept).
- Result: run step `result:{ outcome:'SAVED_TO_VAULT', verification:{status:'VERIFIED', reason:'REREAD_FROM_OWNER_VAULT'}, vaultItemId, title, bytes, destination:'MY_VAULT', executionId }`; failure: run `errorCode` `VAULT_SAVE_FAILED` | `VAULT_ITEM_NOT_VERIFIED` (a failed run stores no `result`).
- Open the item: `GET /api/v1/workspace/vault/:vaultItemId[/preview|/download]` (existing).

## 4. Safety properties and the tests that prove them

`tests/vault_save_approval.test.ts` (23, in-process, temp stores) and `tests/vault_save_approval_browser.test.ts` (11, real Chromium session as a client of the production routes), plus the existing approval suites.

| Requirement | Evidence |
|---|---|
| No write on proposal | draft preview, approval request and a bare `approve()` each leave the Vault, Activity (`vault.*`) and ExecutionStore empty |
| Write once, only after Approve | one item; id derived from the approval; `sourceRef` = approval id; execution record links approval → item |
| Reject / expiry write nothing | reject → `APPROVAL_REJECTED`; expiry → `APPROVAL_EXPIRED` by itself, a late Approve is refused; zero items |
| Replay / concurrency | 3 concurrent triggers → 1 item; second Approve refused; same preview again → `409 PLAN_ALREADY_STARTED`; direct broker replay → `APPROVAL_ALREADY_CONSUMED`; 2 simultaneous browser Approves → 1 item |
| Changed payload / tool | altered plan → seal `403` before any approval; altered content/title at execute → `APPROVAL_PAYLOAD_MISMATCH` (approval **not** spent); extra field / path-like field → `VAULT_SAVE_INVALID_DRAFT`; planned-only tool → plan `BLOCKED` |
| Wrong user / tenant / no session | stranger: seal `403`, cannot approve (404-class), sees no approval, item, preview, download or delete (`404`), no `vault.*` Activity; wrong tenant: nothing; no session: `401` on every route |
| Unavailable / failing store | store throws, store "succeeds" but cannot read back, and a Vault directory that is a regular file → run `FAILED` (`VAULT_SAVE_FAILED` / `VAULT_ITEM_NOT_VERIFIED`), zero items, approval spent, Activity `FAILED`, no `SAVED_TO_VAULT` anywhere |
| Truncated / empty / path traversal | empty → asks what to save; > 20 000 chars (or > 64 KB) → refused, never shortened; control characters → refused; the stored id is server-derived (`vlt_` + hash), never user text |
| Audit / Activity redaction | the audit trail contains sizes and ids only (also: the task name used by notifications is a fixed sentence, because the first draft put the title there and the test caught it); Activity carries the title only |
| Restart | stores rebuilt from files: the pending approval and frozen draft survive; approving afterwards saves once; a third process cannot save it again; the saved item survives |
| Other policies unchanged | calendar / mail still REQUIRED, reads NONE; all calendar / MCP / mail approval suites pass unchanged (`home_reviewed_plan_mcp_e2e` 15/15, `approval_ownership_isolation` 16/16) |

## 5. Exactly-once: the exact guarantee

- The approval is **consumed first** (persisted, one-time, synchronous) and only then is the item written, under an id derived from the approval. Therefore no sequence of retries, double clicks, concurrent triggers or restarts can produce a second item.
- Crash windows (reasoned; the first two are covered by the failing-store and restart tests):
  1. *before* the consume → nothing happened; the approval is still PENDING/APPROVED and resumes once.
  2. *between* consume and write → **no item, approval spent**: the person sees "not saved" and asks again. Safe, never a false "saved". (This is the deliberate choice instead of write-then-consume, which could duplicate.)
  3. *between* the write and the run's final bookkeeping → the item exists and is correct; the run may then report a failure on recovery (the approval is already spent). **Never a duplicate**; possible false-negative message. Not covered by an automated crash test (a real process kill is not simulated); stated here rather than hidden.
- Durable idempotency across restart is guaranteed by the persisted approval record plus the deterministic item id; `VaultStore.saveItemOnce` also refuses an id owned by someone else.

## 6. A defect found in code from PR #14 and fixed here

The plan seal (PR #14) keyed its "one run per plan" claim on the **plan hash**. Asking again for the *same* plan — after a decline, or after the approval expired (the screen literally says "ask again to get a fresh one") — was refused as `PLAN_ALREADY_STARTED` for the whole seal lifetime (30 minutes). Now each **preview** carries its own nonce and the claim is keyed on plan hash + nonce: a double click or a replay of the same preview is still refused, a fresh preview of the same text is a new deliberate request with its own approval (it needs its own human approval, so nothing is weakened). Proven by `home_reviewed_plan_security_review` (+1 test) and both new suites. This touches `src/planning/plan-seal.ts` and `tasks.routes.ts` (allowlisted) and changes the seal token format (`expires.nonce.mac`; seals are per-process, so nothing persists).

Also fixed: `workspace.prepare_draft` is no longer advertised as live; 3 existing tests that used it as the "live reversible write" fixture now use `vault.save_note` (same role).

## 7. Gates, on `TESTED_SOURCE_SHA` `7e3bc0c`

| Gate | Result |
|---|---|
| `npm run build` | PASS |
| Focused: `vault_save_approval` 23/23 · `vault_save_approval_browser` 11/11 · `home_reviewed_plan_security_review` 14/14 · `home_reviewed_plan_mcp_e2e` 15/15 · `plan_resolution` 16/16 · `approval_ownership_isolation` 16/16 · One Input routing 66/66 + dataset 1/1 | PASS |
| `npm test` | PASS — 2983 tests, 2975 pass, 0 fail, 8 skipped, 153 suites, 81.9 s |
| `npm run test:browser-cert` (default parallelism) | **FAIL ×2, environmental** — run 1: 306 tests, 296 pass, 4 fail; run 2: 305 tests, 295 pass, 4 fail. Different tests each time (Apps & Connections / design_system_v2, Desktop Render EN, R22.8, OAuth account lifecycle), all `ECONNRESET` in `route.fetch` or a 10 s `#view-home` wait. design_system_v2 (8/8, twice) and r22_8 (11/11) pass when run alone; the other two were not re-run alone. |
| same set, comparison on the **untouched PR #14 worktree** (`a28d309`), same machine, same minute | **FAIL, 3 tests** (Desktop Render EN, R22.8, design_system_v2) — the failure is not caused by this change; that same tree passed 294/0 at 00:30 the same day, before the desktop got busy |
| browser-cert file set (the gate's own 31 files, same `--require _setup`), `--test-concurrency=4` | **PASS — 305 tests, 299 pass, 0 fail, 6 skipped, 261 s** |

The gate script has no concurrency option; I ran the identical file list through `node --require dist/tests/_setup.js --test --test-concurrency=4 …`. No timeout was widened, no assertion changed or skipped. Recommendation for the integrator: run the final browser certification on a quiet machine at the default setting, or add a documented concurrency control to the gate (a `scripts/` change, outside this track).

Pre-existing, unrelated, not in the regression gate: `task_approval_continuation` (non-canonical, `IMPLEMENTATION_COUPLED`) fails 4 of 12 when run directly — identically on the untouched base.
8 + 6 skipped tests are the long-standing ones with recorded reasons (POSIX signals on Windows, retired password-auth contracts, superseded certifications); none was added or skipped by this track.

## 8. Not done / deferred (and why)

- **Home UI** (draft preview, request button wiring, saved/not-saved states, Open in Vault, Korean strings): `public/**` is outside this track. A prototype patch (desktop-verified at 1440 EN/KR; mobile Vault navigation found hidden — see the hand-off) is documented in `NAGEX_D09_CLAUDE_VAULT_APPROVAL_UI_HANDOFF_20261015.md`. Until the integrator wires it, a person cannot use this feature from the screen. **No UI screenshots exist**; none are claimed.
- **Hosted**: not deployed, no session on the host, no write to `/var/lib/nagex`: `LIVE_HOSTED` = NOT_RUN. Local real-HTTP evidence is not hosted success.
- A real process kill during the write (crash window 3) is reasoned, not simulated.
- The existing `POST /api/v1/workspace/vault` still uses `saveItem`, which swallows write errors (answers 201 even when the disk write failed). It is outside the approval path and unchanged here; flagged for a follow-up (it is the same truthfulness class this feature avoids).

## 9. Requested changes in files this track does not own (for the integrator)

1. `public/main-surface.js`, `public/i18n.js`, `public/main-surface-rearchitecture.css` — apply (and re-fit for Voice WIP) the prototype in the hand-off; investigate the Vault tab's mobile visibility.
2. `scripts/nagex-test-gate.mjs` — optional concurrency control for the browser gate (see §7).

## 10. 한국어 요약 (운영자용)

- **무엇이 됐나**: "회의 요약을 내 보관함에 저장해줘" → NAgex가 저장할 **정확한 초안**(제목·본문·출처)을 만들고(모델 없이, 사용자가 쓴 말 또는 바로 앞 답변 그대로) → 승인 요청 → **사람이 승인해야만** 보관함에 1건 저장 → 다시 읽어 확인(VERIFIED) → 새 브라우저에서도 열림 → 활동(Activity)에는 제목만 기록. 기존 CapabilityBroker·ActionApprovalStore·TaskContinuation을 그대로 썼고, 별도 승인/실행 엔진은 없어요.
- **막힌 것(차단)**: 승인 전 저장 0건, 거절·만료·변조·재생·다른 사용자·저장 실패 모두 저장 0건/차단. 저장 실패는 "저장됨"으로 절대 표시되지 않아요.
- **고친 결함**: ① `workspace.prepare_draft`는 "실행 가능"으로 광고됐지만 실행기가 없었어요 → 이제 정직하게 '사용 불가', 실제 기능은 `vault.save_note`. ② 같은 계획을 거절·만료 뒤 다시 요청하면 30분간 "이미 시작됨"으로 막히던 PR #14의 결함 → 미리보기마다 별도 요청으로 처리(더블클릭·재생은 여전히 차단).
- **테스트**: 빌드 PASS · 전체 회귀 2983건(실패 0) · 브라우저 인증은 기본 병렬에서 환경 탓으로 무작위 실패(기준 PR #14 트리도 동일하게 실패), 같은 파일 묶음을 동시성 4로 실행하면 305건 중 실패 0.
- **아직 안 된 것**: 홈 화면 버튼/미리보기 UI(`public/**`는 이 트랙 금지 → 통합 담당자 몫, 프로토타입 패치 제공), 호스팅 서버 검증(배포 안 함: NOT_RUN).
- **다음 운영자 조치**: ① 통합 담당자가 UI 연결을 순차 작업으로 진행 ② 승인 후 배포 시 호스팅에서 "요약 → 저장 요청 → 승인 → 보관함에서 열기"를 직접 확인 ③ 브라우저 최종 인증은 조용한 상태의 컴퓨터에서 기본 설정으로 재실행.

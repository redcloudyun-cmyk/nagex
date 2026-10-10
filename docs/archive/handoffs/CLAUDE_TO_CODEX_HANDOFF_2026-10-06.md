# NAgex 인수인계 — Claude Code → Codex

**작성:** 2026-10-06 (Claude Code 세션 종료 직전)
**성격:** 시점 고정 인수인계 문서(핸드오프). 영구 아키텍처 권위 문서가 **아님** — 설계 사실은 ADR/canonical 문서가 우선한다.
**독자:** 이어서 작업할 Codex 에이전트 + Product Owner(PO)

> 이 문서의 "현재 상태"는 작성 시점 값이다. 작업 전에 반드시 `git rev-parse HEAD`, `git status --short`, 서버 상태를 다시 확인하라. (AI 기억/이 문서는 스펙 권위가 아니다 — Governance §9)

---

## 0. 가장 먼저 읽을 것 / 지킬 것

읽기 순서: `CLAUDE.md` → `MASTER.md` → `docs/NAGEX_PROJECT_INDEX.md` → `docs/NAgex_AI_Development_Governance.md` → 작업별 canonical 문서. `docs/archive/`는 기본 읽기 대상이 아니다.

**절대 금지(PO 지시, 모든 작업에 상시 적용):**
- `git add .`, `git add -A`, `git commit -a`, `git reset --hard`, `git clean -fd`, `git stash`, `git rebase`, `git cherry-pick`
- PO의 미커밋 작업 수정/삭제/스테이징/자동수정 금지 (PO 트리: tracked-dirty 123 + untracked 414 = status 237줄, staged 0). 반드시 바이트 동일하게 보존.
- PO 더러운 트리에서 작업/테스트 금지 → **정확한 base SHA의 새 깨끗한 worktree**에서 작업.
- 스테이징은 파일 단위로만. `artifacts/*.png`, `tmp_knowledge_*` 는 절대 스테이징 금지(브라우저 테스트가 PNG를 덮어씀).
- 커밋/푸시/배포는 PO의 명시적 승인 후에만. 승인 범위를 넘지 말 것(예: "COMMIT=YES, PUSH=NO").
- 비밀(NEBIUS_API_KEY 등) 출력/로그/커밋 금지. 실제 Telegram/Slack 메시지 전송 금지. 실제 사용자 계정 접촉 금지(합성 `@example.invalid`만).
- 테스트 약화/삭제 금지. 상위 계약이 바뀌어 테스트를 고칠 땐 before/after assertion을 공개.
- 충돌/드리프트는 조용히 해결하지 말고 보고. 가짜 완료/미실행 필드 조작 금지.
- 서버: `redcloud` 계정은 passwordless sudo가 없다. 서비스 재시작은 **PO가** `sudo systemctl restart nagex`로 수행. node PID kill / pkill / `Restart=always` 악용 금지.

**PO 지시 방식:** PO는 붙여넣기 형식의 정형 지시문(STATUS/…/STOP/REPORT)을 준다. 지시문의 순서와 보고 필드를 그대로 따르고, 실행하지 않은 필드는 `NOT_RUN`으로 쓴다.

---

## 1. 저장소/브랜치/배포 현재 상태

| 항목 | 값 |
|---|---|
| 개발 브랜치 | `r23.6m-mobile-voice-action` |
| 로컬 HEAD | **`5edd3874a57ffd5174944b531b2c7f0266b091a1`** (Nemotron runtime, 로컬 fast-forward 완료) |
| origin | `0faef26edfecb1080b162d76cfaa98f51e0cea4a` (S2E까지 푸시됨) → **Nemotron 커밋은 미푸시** |
| 테스트 서버 배포본 | `0faef26` (S2E). Nemotron **미배포** |
| 보호 브랜치(삭제 금지) | `security/s2b-certified`, `security/s2c-certified`(f30f643), `security/s2d-certified`(543eeae), `security/s2e-certified`(0faef26), `feature/nemotron-runtime-certified`(5edd387) |

최근 커밋(오래된 순): 02730fd S1 → 118a9d0 S2A → 02546c4 S2B → f30f643 S2C → 543eeae S2D → 0faef26 S2E → 5edd387 Nemotron.

**테스트 서버** (`nagex-test.agex.site`, 서비스 `nagex.service`, 포트 4100, nginx 3915/80 → Node 127.0.0.1:4100, 앞단 Cloudflare tunnel):
- SSH: `ssh -o BatchMode=yes -i ~/.ssh/id_ed25519 redcloud@100.100.248.77` (비대화형 동작). 소스: `/home/redcloud/services/nagex/source`, 환경파일 `/etc/nagex/nagex.env`.
- 2026-10-05 22:2x KST 기준: HEAD 0faef26, 서비스 active, MainPID 649081, NRestarts 0, `NAGEX_TRUSTED_PROXIES=127.0.0.1,::1` 적용, local/public health 200. journalctl은 `adm` 그룹으로 읽힘.
- Telegram/Slack 봇 토큰·웹훅 시크릿은 서버에 없음(웹훅 503). `NEBIUS_API_KEY`는 **서버에만** 있음(로컬 PC에는 없음).

---

## 2. 완료된 시리즈 요약 (각각: 깨끗한 worktree 구현 → 인증 → 1커밋 → ff 통합 → 푸시/배포 → 배포 스모크)

> 이름 주의: S2A~S2E는 S1 이후의 보안 하드닝 **서브시리즈**이며 원래 S0 감사의 S1–S8 번호와 동일하지 않다(각 ADR에 명시).

| 슬라이스 | 커밋 | 내용 | ADR |
|---|---|---|---|
| S1 | 02730fd | 신원 경계: 세션에서만 신원, default-deny `route-access.ts` | ADR-0006 |
| S2A | 118a9d0 | Telegram/Slack 웹훅 진위(비밀 토큰/HMAC, fail-closed 503) | ADR-0007 |
| S2B | 02546c4 | 채널 신원 소유 증명(1회용 챌린지) | ADR-0008 |
| S2C | f30f643 | 발신/알림 수신자 권한(self-delivery only) | ADR-0009 |
| S2D | 543eeae | 테넌트 리소스 소유(executions, upload objectKey) | ADR-0010 |
| **S2E** | 0faef26 | 인증 남용 + 신뢰 클라이언트 IP | **ADR-0011** |
| **Nemotron** | 5edd387 | Nebius/Nemotron 런타임 라우팅 | **ADR-0012** |

**S2E 핵심(ADR-0011, 배포·인증 완료):** TCP peer가 기준, `X-Forwarded-For`는 `NAGEX_TRUSTED_PROXIES`(IP/CIDR 집합)의 peer일 때만 right-to-left 해석(leftmost/`CF-Connecting-IP` 불신, 설정 오류→peer). `AuthAbuseGuard`(per-IP/per-account/pair, 점진적 쿨다운, 하드락 없음, 메모리 상한, **해시 전에** 검사). login/reactivate/delete-cancel은 한 개의 'credential' 예산 공유. reactivate/delete-cancel은 상태 오라클 제거(401 균일). 테스트 전용 peer 주입 = `createServerInstance({clientIp:{testPeerAddress}})`(프로그램 옵션, production이면 throw). 배포 인증 결과: 공개 경로 XFF 회전 4종 모두 6번째 요청에서 429, THROTTLED_PASSWORD_HASH_CALLS=0, 상태 오라클 0, 감사/세션 IP는 신뢰 resolver 사용, S1~S2D 스모크 PASS, 시크릿 누출 0.

**Nemotron 핵심(ADR-0012, 커밋됨·미배포):**
- 기존 `NebiusProvider`(부분 구현)를 확장. 기본 모델 `nvidia/Nemotron-3_5-Lightning`, `NAGEX_NEBIUS_BASE_URL/MODEL/TIMEOUT_MS(60s)/MAX_TOKENS(8192)`, 키 `NEBIUS_API_KEY`(기본값 없음, 서버 env 전용). 안전하지 않은 base URL(원격 http, 임베드 자격증명)은 UNCONFIGURED.
- 라우팅: `DEFAULT_TASK_PROVIDER_PREFERENCES`(`model-routing-policy.ts`)에서 **PLAN / RESEARCH_SYNTHESIS / MEETING_PREP만** `nebius` 우선. Nemotron 모델은 capability `eligibleTaskKinds`로 이 3개 TaskKind에서만 자동 라우팅 대상, `supportsStructuredExtraction=false`. 전역 priority(`nebius,openai,gemini`)는 변경하지 않음.
- capability 증거 등급: CHAT_COMPLETION만 SUPPORTED, REASONING/PLANNING/RESEARCH_SYNTHESIS/TOOL_USE/STRUCTURED_OUTPUT/LONG_CONTEXT는 **UNVERIFIED**(JSON mode 준수는 미검증 → 기존 validate→fallback이 보호).
- 숨은 reasoning(`reasoning_content`/`reasoning`/`<think>`)은 boolean+토큰 수로만 축소(반환/로그/기억 저장 금지). `finish_reason=length`, reasoning-only 출력은 실패.
- 실패 어휘 고정(`classifyModelFailure`): NO_PROVIDER_CREDENTIAL / RATE_LIMITED / PROVIDER_REJECTION / PROVIDER_ERROR / NETWORK_FAILURE / TIMEOUT / INVALID_RESPONSE / MODEL_UNAVAILABLE / PROVIDER_DEGRADED. 응답에 `routing={preferredProvider, actualProvider, fallbackUsed, fallbackReason}`. 재시도는 네트워크/5xx에 한해 1회.
- 실호출 인증은 **옵트인 스크립트**: `NAGEX_LIVE_NEBIUS_CERT=1 node scripts/nebius-live-cert.mjs`(빌드 후, 서버에서, 유료 1회 호출, provider/model/latency/토큰만 출력). 아직 **NOT_RUN**.
- 증거 문서: `docs/evidence/NAGEX_NEBIUS_NEMOTRON_RUNTIME_EVIDENCE.md` (실호출 결과는 실행 후 여기에 기록).

---

## 3. 지금 진행 중이던 작업 (정확히 어디서 멈췄나)

PO 지시 "Nemotron Runtime — Development Branch Safe Integration"(통합 전용, PUSH=NO, DEPLOY=NO, 서버 접촉 금지):

완료:
1. 토폴로지 확인 PASS (5edd387의 부모 = 0faef26 = 기존 dev HEAD, ancestor PASS).
2. PO 스냅샷 기록(tracked 123 / untracked 414 / status 237 / 전체 diff 해시 `6e271bf2…ad0f`), 충돌 검사 **OVERLAP 0/0**.
3. `git merge --ff-only feature/nemotron-runtime-certified` 실행 → dev HEAD = 5edd387, 머지 커밋 없음. PO 변경 보존 검증: tracked/untracked 해시 불일치 0, dirty 경로 집합·status·전체 diff 해시 동일, LOST_WORK=0.
4. 새 깨끗한 worktree `wt_nem_int`(5edd387) 빌드 PASS + 포커스 테스트 전부 PASS: nebius provider 36/36, routing 26/26, contract 8/8, 기존 모델 계열(capability contract 13, provider integration 28, r22_5 1, core wiring 5, plan_resolution 16, daily_brief 18, unified_capture_routing 4, fixed_plan_injection 11, pdf_understanding 18), S1(107+13), S2A(20+5), S2B(33+6), S2C(30+6), S2D(14+4), S2E(33+8), identity_lifecycle 9, route_inventory 10, test_contract_registry 1, scoped_test_system 18, `git diff HEAD^ HEAD --check` PASS.

5. `wt_nem_int`(5edd387)에서 **전체 게이트 완료**: regression 2137 tests / 2133 pass / **0 fail** / 4 skip, browser 137 / 135 pass / **0 fail** / 2 skip, legacy 627 / 570 pass / 57 fail(전부 baseline, 신규 0).

**남은 것:**
1. PO에게 최종 통합 보고(지시문 §10 형식). 아직 PO에게 보고되지 않았다 — 위 사실로 보고서를 작성하면 된다: INTEGRATION=PASS, FAST_FORWARD, MERGE_COMMIT=NO, NEMOTRON_CHANGED_FILES=15, PO_TRACKED_DIRTY_COUNT_BEFORE=123, PO_UNTRACKED_COUNT_BEFORE=414, OVERLAP 0/0(NONE), 보존 YES/YES, 해시 불일치 0/0, LOST_WORK=0, BUILD/모든 테스트 PASS, DIFF_CHECK=PASS, DEPLOYMENT_CONFIG_PENDING=YES(서버 `NAGEX_NEBIUS_MODEL` 확인·조정 필요, §4-1), PUSH=NO, DEPLOY=NO. 서버는 접촉하지 않았으므로 배포 설정 사전점검은 "요구사항 기록만"(`NAGEX_NEBIUS_MODEL=nvidia/Nemotron-3_5-Lightning`, `NAGEX_TRUSTED_PROXIES=127.0.0.1,::1`).
2. 이 핸드오프 문서 자체는 untracked 신규 파일이다(스테이징/커밋 안 함). 커밋 여부는 PO가 결정.

---

## 4. 다음 PO 결정/작업 큐 (승인 필요, 임의 진행 금지)

1. **서버 모델 설정 조정 (배포 차단 요인).** 2026-10-05 서버 journal에서 라이브 서비스가 이미 Nebius를 **다른 모델 `nvidia/nemotron-3-super-120b-a12b`** 로 쓰고 있음(= `/etc/nagex/nagex.env`의 `NAGEX_NEBIUS_MODEL` override로 추정, 값 직접 확인은 안 함). 구(舊) 기본 priority(`nebius,openai,gemini`) 때문에 현재 서버에서는 Nebius가 **모든 TaskKind의 1순위**다. Nemotron 슬라이스를 배포하면 모델명이 `nemotron`을 포함하므로 PLAN/RESEARCH_SYNTHESIS/MEETING_PREP에만 라우팅되고 **CHAT/DAILY_BRIEF 등은 openai/gemini로 이동**한다(의도된 설계지만 서버 현행 동작과 다름). → PO가 (a) 서버 `NAGEX_NEBIUS_MODEL`을 `nvidia/Nemotron-3_5-Lightning`으로 맞출지/제거할지, (b) CHAT 라우트 변화를 수용할지 결정해야 한다. env 값은 PO 승인 후에만 읽을 것(키 값은 절대 출력하지 말고 존재 여부만).
2. 푸시(승인 시): `git push origin r23.6m-mobile-voice-action` (force 금지, ancestor 확인 후 일반 push).
3. 배포(PO 승인 시): 서버 `git fetch`+ff, `npm run build`, **PO가** `sudo systemctl restart nagex`. 배포 후 공개 경로 forged-XFF 재확인(S2E는 이미 인증 완료지만 재시작 후 `NAGEX_TRUSTED_PROXIES` 유지 확인).
4. Nemotron 실호출 인증: 서버에서 `NAGEX_LIVE_NEBIUS_CERT=1 node scripts/nebius-live-cert.mjs` 1회 → 결과(provider/model/latency/토큰/PASS)를 evidence 문서에 기록. PLAN JSON 준수 등 UNVERIFIED capability 승격은 이 증거가 있을 때만.
5. (PO 순서 지시) S2E 종료 → Nemotron 통합/푸시/배포 → 실호출 인증. 이 순서를 지킬 것.
6. 이후 보안 슬라이스 후보(미착수, PO 승인 필요): 원래 계획의 S2F 쿠키/헤더/세션(S0-11/12, 로그인 응답의 session id 노출), S2G 자원 한도(body limit), SSRF 가드(브라우저 에이전트 `isUrlSafe`), S0-13 계정 열거, S0-14 소셜 OAuth, 로컬 데스크톱/정보 라우트 경계, 진실성(S0-17/S2-N3). 인증된 비밀번호 확인 라우트(account/password·disable·delete·email change)는 S2E에서 의도적으로 제외됨.

---

## 5. 작업 방법/도구 (재현용)

- **worktree 규칙:** `git worktree add --detach <경로> <SHA>` 후 `node_modules`는 junction 으로 연결(PowerShell: `New-Item -ItemType Junction -Path <wt>\node_modules -Target "F:\개발 프로젝트\Nagex project\node_modules"`), `npm run build`.
- **포커스 테스트:** `node --test --import ./dist/tests/_setup.js dist/tests/<name>.test.js` (worktree 루트에서).
- **게이트:** `npm run test:regression`, `test:browser-cert`, `test:legacy`. 격리 HOME/Playwright 경로를 쓰는 러너: scratchpad `run_gates.sh <worktree> <tag> test:regression test:browser-cert test:legacy` → `gate_<tag>_status.txt`, `gate_<tag>_test_*.log`. **러너를 두 번 띄우지 말 것**(같은 worktree에서 동시 실행되면 결과가 오염됨 — 실제로 한 번 겪음).
- **레거시 비교:** 베이스라인 실패 목록 `base_legacy_fail.txt`(57건 stale 실패) 대비 신규 실패 0이어야 함.
- **알려진 flaky/baseline:** `r24_6d_settings_surface_browser`(다이얼로그 teardown race: "dialog.accept: Target page, context or browser has been closed" — PO의 미커밋 `.catch` 패치가 이 문제 대응), `ambient_composer_recovery`, `r17_final_completion_real_browser`(이 환경에서 베이스라인도 실패), 레거시 `my_space`/`state_propagation` 일부.
- **줄바꿈:** 저장소 파일은 CRLF + `core.autocrlf=true`. 기존 파일 편집 시 CRLF 보존(scratchpad `edit2.cjs`: `<<<<old====new>>>>` 블록, 각 앵커 정확히 1회 매치). 통째로 Write 하면 전 줄 diff가 된다.
- **PO 트리 보존 검증:** `git ls-files -m -o --exclude-standard -z | xargs -0 sha256sum` 전/후 비교 + `git status --short` 비교.
- **서버 임시 스모크:** 배포 dist를 서버에서 격리 프로세스(임시 데이터 디렉터리, 외부 호출 차단)로 실행하는 스크립트 `s2e_deployed_smoke.cjs`, `s2c/s2d_deployed_smoke.cjs`, 라이브 프로브 `live_probe*.sh`, 공개 프로브 `s2e_public_probe.sh`가 scratchpad에 있다. 실행 후 서버 /tmp의 임시 파일은 삭제.
- **scratchpad 경로(세션 임시, 사라질 수 있음):** `C:\Users\redcl\AppData\Local\Temp\claude\f----------Nagex-project\bec8bbc9-3e60-402e-96a0-23d7ceea56be\scratchpad` — 안의 worktree: `wt_nem`(Nemotron 구현), `wt_nem_int`(5edd387 검증), `wt_s2e`(S2E 구현), `wt_s2e_int`, `wt_s2d`/`wt_s2c`/`wt_s2b` 등. 사라지면 위 규칙대로 새로 만들면 된다. 전체 대화 기록: `C:\Users\redcl\.claude\projects\f----------Nagex-project\bec8bbc9-3e60-402e-96a0-23d7ceea56be.jsonl`.
- **환경 함정(Windows):** `python`(PATH)은 Store 스텁 → 실제 Python 3.13은 `C:\Users\redcl\AppData\Local\Programs\Python\Python313\python.exe`. 한글 경로 때문에 PowerShell 도구가 `Remove-Item`을 "시스템 경로 보호"로 막는 경우가 있음(삭제 명령은 한글 경로가 없는 별도 호출로, 절대경로+`-LiteralPath`로). bash 도구에서 heredoc에 따옴표/백슬래시가 섞이면 깨짐 → 파일은 Write 도구로 작성.
- **메모리 파일(Claude 전용, 참고):** `C:\Users\redcl\.claude\projects\f----------Nagex-project\memory\` (`nagex_security_gate_state.md`, `nagex_nebius_nemotron_runtime.md` 등).

---

## 6. 별건: Antigravity + Nebius Nemotron 코딩 모델 환경 (NAgex와 무관)

NAgex 제품 런타임과 **별개**인 개발 도구 환경. `F:\tools\antigravity-nebius` 에 venv(litellm 1.104.0, google-antigravity 0.1.20, openai), `litellm_config.yaml`(Nebius→`nemotron-lightning` 별칭), `nemotron_antigravity_test.py`, `start_gateway.ps1`(키를 숨김 입력으로 받아 127.0.0.1:4000에만 바인딩) 생성 완료. 게이트웨이 로컬 인증/바인딩과 SDK→게이트웨이 연결은 확인했으나 **Nebius 키가 이 PC에 없어 실제 모델 호출은 NOT_RUN**. PO가 `start_gateway.ps1`를 직접 실행해 키를 넣어야 이어갈 수 있다. 이 도구 작업은 NAgex 소스/PO 트리를 건드리지 않는다.

---

## 7. 열린 위험/미해결

- Nemotron JSON mode(`response_format`) 준수, PLAN/RESEARCH 품질, tool use, long context: **UNVERIFIED**.
- 런타임 **spend guard 없음**(토큰 사용량은 `model_request_succeeded` 로그에 남음; Nebius 결제는 활성) — 별도 슬라이스 필요 여부는 PO 결정.
- 인증 남용 throttle은 **프로세스 로컬**(단일 노드). 분산 백엔드/멀티노드는 범위 밖.
- 특정 계정에 대해 다수 주소에서 실패를 지속하면 해당 계정이 최대 5분 쿨다운에 머물 수 있음(하드락은 의도적으로 없음).
- 계정 열거(타이밍/상태 차이, S0-13)는 미해결.
- 서버 `NAGEX_NEBIUS_MODEL` 불일치(§4-1).

---

## 8. 불변 원칙 요약 (MASTER 발췌)

Remember → Create → Approve → Act. 모델은 추론하고 NAgex가 통제·실행한다. 가짜 성공/미지원 capability 광고 금지, mock과 live 구분 명시, 승인 우회 0, 테넌트/사용자 격리 유지, 비밀 로그 0. 모델 라우팅은 실행 권한이 아니다.

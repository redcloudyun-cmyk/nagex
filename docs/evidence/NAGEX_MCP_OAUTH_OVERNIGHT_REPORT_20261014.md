# NAgex MCP OAuth 야간 자율개발 보고서

**작성일:** 2026-10-14 (밤샘 작업 종료 시점)
**브랜치:** `feat/mcp-oauth-discovery-20261013` · **PR:** #13 (Draft 유지, 병합·배포 없음)
**지시서:** `docs/evidence/NAGEX_MCP_OAUTH_OVERNIGHT_DIRECTIVE_20261013.md`

> 한 줄 요약: **Slack 공식 MCP 서버에 연결하는 코드 경로(운영자 등록 → 로그인 시작 → 콜백 → 암호화 토큰 저장 → MCP 도구 발견 → 도구 기본 OFF → 사용자 승인 → 1회성 승인 기반 실행 → 만료·해제·격리)는 로컬 가짜 제공자와 격리된 MCP 서버로 끝까지 검증했습니다. 실제 Slack 계정으로는 단 한 번도 연결하지 않았습니다(워크스페이스·앱·클라이언트 시크릿이 사람 손을 거쳐야 해서 BLOCKED).**

## 1. 상태 표 (PASS / FAIL / BLOCKED / NOT_RUN)

| 항목 | 상태 | 근거 · 한계 |
|---|---|---|
| `BASE_SHA` | `afc8d48` | 작업 시작 시점의 원격 브랜치 HEAD |
| `FINAL_SHA` | 이 보고서를 포함한 최종 커밋(`git log -1`) | 테스트된 소스 트리는 `3976306`과 동일, 이후 커밋은 문서뿐 |
| `SLACK_METADATA` | **PASS** (공개 메타데이터, 실시간) | `scripts/mcp-oauth-runtime-check.mjs`가 운영 코드 경로로 확인: 리소스·발급자·PKCE S256·`client_secret_post` 광고·기본 읽기 전용 범위 5개 모두 Slack이 광고함. 더미 클라이언트 값 사용, 로그인·자격 증명 전송 없음 |
| `CONFIDENTIAL_TOKEN_EXCHANGE` | **PASS (가짜 제공자 한정)** | 토큰 엔드포인트 요청 본문을 실제 HTTP로 검증(`client_secret`은 폼 본문에만, Authorization 헤더 없음, 정확한 PKCE·리소스·리다이렉트). **실제 Slack 토큰 교환은 NOT_RUN** |
| `OPERATOR_REGISTRATION` | **PASS (코드·테스트)** / 실제 등록 **NOT_RUN** | 기본 OFF `NAGEX_MCP_OAUTH_ENABLED=1` + 제공자별 환경 변수. 부분 설정은 `SETUP_REQUIRED`(누락 항목 이름만 노출), 메타데이터 불일치는 `UNAVAILABLE` |
| `OAUTH_START` | **PASS (가짜 제공자)** | 서버가 고정한 클라이언트·콜백·S256·리소스·운영자 범위만 사용, 요청에서 받는 값은 `providerId`뿐 |
| `CALLBACK` | **PASS (가짜 제공자)** | 세션 소유자 바인딩, 재사용·타 테넌트·제공자 거부·잘못된 코드·범위 초과 모두 실패(저장 없음) |
| `ENCRYPTED_PERSISTENCE` | **PASS (격리 인스턴스)** | 암호화 파일 저장, 재시작 후 소유자에게만 복호화, 연결 해제 시 파일에서도 삭제 |
| `MCP_DISCOVERY` | **PASS (격리 MCP 서버)** | 토큰으로 initialize + tools/list 성공해야만 `MCP_CONNECTED_VERIFIED`. 실패 시 `OAUTH_CREDENTIAL_STORED`(+사유)이며 연결로 표시하지 않음 |
| `HUMAN_APPROVAL` | **PASS (격리 MCP 서버)** | 도구 기본 OFF → 켜기 → 승인 없이는 호출 0건 → 승인 후 1회만 실행, 결과는 `TOOL_RESPONDED` / 검증 `UNVERIFIED` |
| `REAL_SLACK_OAUTH` | **BLOCKED** | 아래 3절 |
| `REAL_READ_ONLY_TOOL` | **BLOCKED** | 실제 Slack 연결이 선행되어야 함 |
| `REGRESSION` | **PASS** | `npm test` 2850개 중 2842 통과 · 실패 0 · skip 8 |
| `BROWSER_CERT` | **PASS** | 236개 중 230 통과 · 실패 0 · skip 6 |
| `DEPLOYMENT` | **NOT_RUN** | 지시대로 배포·서비스 재시작·`main` 병합 하지 않음 |
| `HUMAN_UI_ACCEPTANCE` | **PENDING** | 사람의 디자인 확인 전 |

## 2. 구현한 것

**A. 제공자별 기밀 클라이언트 토큰 교환**
- 토큰 교환에 운영자가 고정하는 클라이언트 인증(`none` | `client_secret_post`)과 응답 형식(`rfc6749` | `slack-user-v2`)을 추가. 시크릿은 서버에서만 읽고(허용된 환경 변수 이름 패턴만), 오류·로그·브라우저 어디에도 남기지 않음.
- Slack 공식 문서 확인 결과 반영: 성공도 실패도 HTTP 200, `ok:false` 처리, `token_type`이 `user`, 범위는 `scope` 또는 `authed_user.scope`(쉼표/공백), 둘이 다르면 거부. 일반 형식은 여전히 `Bearer`만 허용.
- 레지스트리가 인증 서버가 `client_secret_post`를 광고할 때만 기밀 등록을 허용하고, MCP 엔드포인트가 검증된 리소스와 같은 출처인지 확인. RFC 8707 `resource`는 제공자가 게시한 철자(`https://mcp.slack.com`) 그대로 전송, 내부 신원 바인딩은 정규형 사용.

**B. 운영자 설정과 프로덕션 코디네이터**
- NAgex가 검토한 제공자 템플릿(Slack) + 운영자 환경 변수. 기본 OFF, 부분 설정으로는 절대 켜지지 않음.
- 런타임이 게시 메타데이터를 SSRF 보호 GET으로 검증(성공 10분·실패 30초 캐시)하고 암호화 자격 증명 저장소를 시작 시 연다. 모든 실패는 503/`SETUP_REQUIRED`/`UNAVAILABLE`로 fail-closed.
- 한 계정당 미완료 로그인 5개로 제한(전역 표 고갈 방지), 동시 검증은 직렬화(연결 중복 방지).

**C. 기존 McpService에 결합(별도 실행기 없음)**
- 토큰은 연결 레코드에 들어가지 않고 소유자 금고에서 호출마다 조회. 누락·만료 → `AUTH_REQUIRED`(`OAUTH_TOKEN_EXPIRED`/`OAUTH_CREDENTIAL_MISSING`), 도구 OFF, **MCP 서버로 요청 0건**. 승인 요청 전에도 검사.
- 연결 해제 시 연결·도구·저장된 토큰을 함께 삭제. 로컬 삭제이며 제공자 측 해지는 호출하지 않음.
- 라우트: `GET /api/v1/oauth/mcp/providers`, `POST .../start`, `GET .../callback`, `POST .../connect`(저장된 자격으로 재검증). 브라우저 이동(`Accept: text/html`)은 상태만 담아 Connections 화면으로 리다이렉트.

**D. 앱 및 연결 화면**
- 서버가 `AVAILABLE`이라고 할 때만 **Connect**. 설정 중(`SETUP_REQUIRED`)·검증 불가(`UNAVAILABLE`)는 "더 많은 앱"에 사유만 표시(버튼 없음), 운영자가 설정을 시작하지 않은 기본 상태(`DISABLED`)는 아예 표시하지 않음.
- 연결되면 "내 연결"에 도구 OFF로 나타나고, 해제는 확인 후 삭제. 로그인 만료 시 "다시 로그인"(붙여넣기 토큰 입력란 없음). 돌아왔을 때 연결됨 / 저장됐지만 도구 미검증(다시 시도) / 실패를 정직하게 표시.
- 영어 기준 + 자연스러운 해요체 한국어, 360/390/430px 가로 넘침 없음. 스크린샷 11장: `docs/evidence/mcp-oauth-overnight-20261014/`.

**E. 기존 문제 발견·수정(이 브랜치가 원래 안고 있던 것)**
- 기존 `mcp_oauth_*` 10개 스위트가 테스트 범위 레지스트리에 없어 회귀 게이트가 실패하던 문제.
- OAuth 라우트 등록자 이름(`handle…Routes` 규칙)과 라우트 인벤토리 누락 → `handleMcpOAuthRoutes`로 정리하고 매니페스트에 등록.

## 3. 막힌 항목(BLOCKED)과 사람이 해야 할 일

실제 Slack 연결은 아래 단계가 **사람의 본인 확인·관리자 승인·비밀 보관**을 요구해 임의로 진행하지 않았습니다. 가입 확인 메일이나 MFA를 대신 처리하지 않았고, 워크스페이스·앱·시크릿을 만들어 놓은 척하지도 않았습니다.

1. Slack 워크스페이스 준비(테스트 전용 권장) — 본인 이메일 인증 필요.
2. Slack 앱 생성: **디렉터리 게시 앱 또는 내부 앱만** MCP 사용 가능(비공개 미등록 앱 불가). MCP 접근 활성화, 사용자 범위: `search:read.public`, `search:read.users`, `channels:read`, `channels:history`, `users:read`(기본값), 리디렉션 URL = `https://nagex-test.agex.site/api/v1/oauth/mcp/callback`(정확히 일치).
3. 워크스페이스 관리자의 MCP 클라이언트 승인.
4. 서버 환경(`/etc/nagex/nagex.env`): `NAGEX_MCP_OAUTH_ENABLED=1`, `NAGEX_MCP_OAUTH_SLACK_CLIENT_ID`, `NAGEX_MCP_OAUTH_SLACK_CLIENT_SECRET`, `NAGEX_MCP_OAUTH_SLACK_REDIRECT_URI`. (`NAGEX_TOKEN_ENCRYPTION_KEY`는 이미 설정됨, `NAGEX_MCP_ALLOW_PRIVATE_NETWORK`는 설정 금지.)
5. `node scripts/mcp-oauth-runtime-check.mjs` 로 `AVAILABLE` 확인 → 이 브랜치를 배포하고 `sudo systemctl restart nagex`(현재 테스트 서버는 `faf38cc` 후보가 올라가 있고 재시작 대기 중이며, 이 OAuth 코드는 **아직 배포되지 않았습니다**).
6. 일회용 테스트 계정으로 첫 실제 연결 → 읽기 전용 도구 1회를 승인 후 실행 → 결과를 이 보고서의 `REAL_SLACK_OAUTH` / `REAL_READ_ONLY_TOOL`에 사람이 직접 기록.

## 4. 알려진 위험·한계(숨기지 않습니다)

- **Slack이 토큰 응답에 범위 목록을 주는지 문서에 없음.** 요청한 범위가 있는데 확인할 범위가 없으면 저장하지 않고 `TOKEN_SCOPE_MISMATCH`로 실패합니다. 실제 첫 시도에서 이게 나오면 사람이 검토해야 하며 우회하지 않았습니다.
- 토큰 자동 갱신 없음: 만료되면 "다시 로그인". Slack의 토큰 회전(12시간)이 켜져 있으면 자주 보게 됩니다.
- 진행 중 로그인 상태는 프로세스 메모리: 재시작·다중 워커에서는 미완료 로그인이 실패하고 다시 시작해야 합니다.
- 연결 해제는 제공자 측 토큰 해지를 호출하지 않습니다(문서화된 경우 + 사용자 승인 시에만 도입).
- 가짜 제공자 테스트는 우리가 이해한 Slack 형식을 검증할 뿐, 실제 Slack의 동작 증거가 아닙니다.

## 5. 검증 요약

| 명령 | 결과 |
|---|---|
| `npm run build` | exit 0 |
| `node --require ./dist/tests/_setup.js --test ./dist/tests/mcp_oauth_*.test.js` | 80 통과 / 실패 0 (착수 시 39) |
| MCP 런타임·격리 서버 E2E·플래닝·커넥터 카탈로그·라우트 인벤토리 | 85 통과 / 실패 0 |
| `npm test` | 2850 중 2842 통과 · 실패 0 · skip 8 |
| `npm run test:browser-cert` | 236 중 230 통과 · 실패 0 · skip 6 |
| 게이트 중 발견한 내 변경의 실패 | 3건(기본 상태에서 불필요한 카드 노출, 영문 이름 잔존) → 수정 후 전체 재실행 통과 |

신규 테스트 3개 파일은 모두 `tests/test-contract.registry.json`과 `tests/test-scope.registry.json`에 등록했습니다: `mcp_oauth_confidential_exchange`, `mcp_oauth_slack_flow_e2e`, `mcp_oauth_connections_browser`(+ 기존 10개 스위트 범위 분류).

## 6. 보안 검토 메모

- 요청에서 받는 값: 로그인 시작의 `providerId`뿐. 클라이언트 ID·시크릿·토큰 URL·MCP URL·리다이렉트는 전부 서버 쪽 고정값.
- 시크릿 환경 변수 이름은 `NAGEX_MCP_OAUTH_*_CLIENT_SECRET` 패턴만 허용(임의 환경 변수 읽기 방지).
- 토큰·코드·시크릿은 응답 본문, 리다이렉트, 연결 레코드, 로그, 오류 상세 어디에도 없음(테스트로 확인). 브라우저에는 상태 코드만.
- 소유자(테넌트+사용자) 단위 격리: 타 계정·타 테넌트는 존재 자체를 모름(404), 동일 사용자 ID라도 다른 테넌트면 별개.
- 원격 stdio MCP 없음, 승인 우회 없음, 도구는 항상 승인 필수(`readOnlyHint`는 신뢰하지 않음).

## 7. 다음 행동(아침)

1. 3절의 Slack 준비 항목을 진행할지 결정(계정·결제·관리자 승인은 사람 몫).
2. PR #13을 검토하고, 병합·배포 여부를 별도로 결정.
3. 실제 연결을 시도할 때는 4절 첫 번째 위험(범위 보고)을 특히 확인.

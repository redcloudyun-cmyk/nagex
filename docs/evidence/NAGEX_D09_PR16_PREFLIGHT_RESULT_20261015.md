# NAgex D-09 — PR #16 preflight, backup and candidate staging: result (NO CUTOVER)

**Date:** 2026-10-15 KST · **Branch:** `ops/d09-pr16-preflight-only-20261015` · **Order:** `NAGEX_D09_PR16_PREFLIGHT_BACKUP_ONLY_20261015.md`
**Scope honoured:** no stop / start / restart / reload of `nagex`, no change to `source`, no OAuth, no approval, no MCP call, no main merge, no Voice WIP merge. **One boundary was crossed inadvertently — see §1. It is the most important finding of this task.**
**Labels:** PASS / FAIL / BLOCKED / NOT_RUN. No backup name, hash, record content, identifier or secret value is in this report; counts only.

## 0. Verdict

| | |
|---|---|
| **Deployment decision now** | **NO-GO — pending your decision on §1 (and a disclosed Linux test failure, §3).** |
| The candidate code itself (`660e15f`) | **Technically ready:** pinned, installed with an untouched lockfile, built; regression 2981 pass / 1 fail / 4 skipped of 2986; browser certification 324/318/0 at host concurrency 3 and 2; contract parity with PR #16 confirmed. |
| Why NO-GO | (1) my gate runs wrote **test data into `/var/lib/nagex`** (368 files added, 4 built-in role records re-stamped) — a cold backup or a swap taken now would carry it; (2) the regression gate has **1 failure on Linux**, in unchanged code (fail-closed behaviour, wrong message); (3) the only backup is an online, provisional one. |
| Ready for explicit deployment approval? | **Not yet.** After you choose how to treat §1 and §3, the remaining steps are the documented ones in §8. Nothing here is deployed. |
| Stopped as instructed | All activity on the host has ended. Nothing was cleaned up, restored or deleted in `/var/lib/nagex` (that would be a second unauthorised mutation). |

## 1. INCIDENT (P0, disclosed): my candidate test runs wrote test data into the live data root

**What happened.** The order allowed building and testing the candidate "with PRIVATE temp test stores" and said to STOP if default paths would touch live stores. I ran `npm test` and `npm run test:browser-cert` on the host without first proving that. `src/governance/file-record.store.ts` resolves any store whose environment variable is unset to **`/var/lib/nagex/<subdir>` whenever that directory exists and is writable** (it is, for the service account). `tests/_setup.js` redirects the stores it knows about, not every store, so tests that use a store it does not redirect wrote into the live root. On my Windows machine `/var/lib/nagex` does not exist, so this never showed there.

**Evidence (read-only, compared with the clean backup taken at 12:16:48, before any test ran).**

| Measure | Result |
|---|---|
| Files **added** | **368** (≈ 350 KB). By directory: durable-task-runs 127, task-continuations 124, artifacts 25, images 21, image-bytes 21, daily-briefs 17, documents 9, presentations 6, presentation-bytes 6, memory-settings 4, and 1–2 each in test_*idempotency, rbac-bindings, mobile-message-runs, device-* (the `documents` directory did not exist before) |
| Files **modified** (pre-existing) | **4**, all built-in role records in `rbac-roles`; the **only** changed field is `updatedAt` (re-stamped by the seeding at app start) |
| Files **deleted** | **0** (my first count of 1 was an artefact of my own set comparison — an empty line from the archive's root entry) |
| Who owns the added records | test-style tenants and users only (`ten_*`, `usr_*`, `test_*`, `t1`, `u1` …); **0** new files in `sessions`, `identity-*`, `conversations`; `task-runs` unchanged (4385); the 30 PAUSED fixture tasks unchanged (same fingerprint of names, sizes, times and content hashes) |
| When | 12:19–12:20 (the regression run) and 12:27–12:59 (browser runs); nothing else in the window |
| Run state of the added records | durable runs: 87 SUCCEEDED, 35 FAILED, **5 WAITING_APPROVAL**; continuations: 119 RESUMED, **5 WAITING** |

**Impact assessment.** No real user's data was touched (tenant/owner isolation; no session, identity or conversation file changed). The records are inert for users. The practical risks are (a) **pollution** of the live store, (b) the 5 waiting runs and 5 waiting continuations of test tenants being seen by the service's recovery logic **at its next start** (they cannot execute anything real — no provider or Google credential exists for them — but they are noise and I cannot prove the recovery path is silent), (c) a **cold backup taken now would include the test data**, and (d) the live service reads these directories per request for some views, so the new `documents`/`artifacts` directories now exist. The service itself was not affected (PID, restarts, health, fixtures below).

**What I did not do.** I did not delete, restore, move or edit anything. A precise, private manifest of the 368 added files (and the 4 re-stamped records) is on the host in my private logs folder (mode 0600, outside the data root) so a later, authorised cleanup can be exact.

**Options for you (none executed):**
1. *Targeted removal* of exactly the manifest's 368 files, after you approve — verified against the manifest and the test-tenant prefixes, no service stop needed for inert records (the 4 `updatedAt` values can stay). Recommended before any cold backup.
2. *Leave as is* — inert and isolated; accept the noise at the next start.
3. *Restore* from the pre-test backup at the deployment's cold-stop step (it is the clean point; there were no real writes in between) — this needs the service stopped, so only inside the deployment you approve.

**Prevention (separate change, not made here):** make `tests/_setup.ts` (or `resolveNagexDataDir` when `NAGEX_TEST_DATA_ROOT`/test mode is set) force **every** store under the private test root, and add a guard test that fails if a test process resolves a path under `/var/lib/nagex`. Until then, **do not run the test gates on the service host as the service account.**

## 2. Result fields

| Field | Value |
|---|---|
| `CANDIDATE_SHA` | `660e15f56e130c9efd1df9c6af1c5f22d110702b` (pinned; `HEAD` verified equal; clean tree; head of PR #16 is `2140f9e`, docs/screenshots only on top) |
| `RUNNING_SHA` | `bcd7e10` (re-verified before and after; unchanged; source tree status unchanged: only untracked `.runtime/`) |
| `RUNNING_PID` | 2997023 (before and after) · active since 2026-10-14 16:44:54 KST |
| `PROCESS_RESTARTS` | `NRestarts=0` before and after |
| `HEALTH` | HTTP 200 before and after (≈ 1.1 s under the test load) |
| `DISK_INODES` | before: 150 G free, 14 % inodes used; after: 149 G free, 14 % inodes (candidate 374 MB + my logs + 2397 temp test roots in `/tmp` ≈ 293 MB). Host: 4 cores, 6.7 GiB RAM, 2.3 GiB swap in use at the start — see §5 |
| `CANDIDATE_BUILD` | **PASS** — clone+checkout 12 s, `npm ci` 6 s with the lockfile unchanged, `npm run build` 26 s, `dist/src/server_web.js` present |
| `REGRESSION` | **FAIL (1, pre-existing, Linux-only)** — 2986 tests, 2981 pass, 1 fail, 4 skipped (155 s, host default concurrency). See §3. Windows (PR #16 cert): 2986 / 2978 / 0 / 8 |
| `BROWSER_CERT_4` | **FAIL (1) under host overload** — 324 tests, 317 pass, 1 fail (`r23_7c_d_presentation_main_browser`, "mobile/ko: the deck is listed in Recent"), 6 skipped, 627 s at load ≈ 12 on 4 cores. The same suite passes **alone twice** (17 s, 18 s). Not a PR #16 defect; see §4 |
| `BROWSER_CERT_DEFAULT_ON_QUIET_HOST` | **PASS** at node's default for this 4-core host (3 files at a time): 324 tests, 318 pass, **0 fail**, 6 skipped, 647 s. (The host is not idle — it runs the service and a database — but nothing else was running.) Also **PASS at 2**: 324 / 318 / 0 / 6, 733 s |
| `ONLINE_BACKUP` | **ONLINE_BACKUP_PROVISIONAL** — online `tar` of `/var/lib/nagex` into the private backups folder (0600; the folder is 0700): 3 s, exit 0, **0 warnings**; the live file count and size were identical immediately before and after the archive (quiet store) |
| `ARCHIVE_SHA256_VERIFIED` | **PASS** — `sha256sum -c` OK; `tar -tzf` OK (20 101 entries); single top-level root |
| `EXTRACT_TEST` | **PASS** — extracted only into a disposable 0700 directory outside the data root: 19 817 files / 284 directories / identical byte count; 19 417 JSON files all parse, 0 invalid; the temporary directory was removed |
| `CONSISTENT_COLD_BACKUP` | **NOT_RUN** — requires the service stopped; belongs to a deployment you authorise. The online archive is a verified copy, **not** an atomic recovery point |
| `ROLLBACK_SLOT` | `source-faf38cc` exists (older release). **`source-bcd7e10` does not exist** — the name is free for the future swap (no collision). Slots now: `candidate-pr16-660e15f`, `source`, `source-faf38cc` |
| `PR16_CONTRACT_PARITY` | **PASS** — candidate contains the PR #16 UI/mobile/backend markers (draft preview, `openMobileVaultItem`, `vault.save_note` in the capability, tool and eligibility registries, `VAULT_WRITE_FAILED`, the gate concurrency policy); `660e15f` is an ancestor of the PR head and the commits after it change only the report and screenshots; `bcd7e10` is an ancestor of the candidate |
| `VOICE_WIP_UNTOUCHED` | **PASS** — main checkout still on `r23.6m-mobile-voice-action` @ `b5856fe`, the same 8 modified files, working-diff hash identical to the one recorded earlier today (1110 lines); none of the Voice files differ between the deployed baseline and the candidate |
| `MAIN` | untouched — local `main` has not moved since 27 Sep; no merge |
| `FIXTURE_TASKS_UNCHANGED` | **PASS** — 30 PAUSED of 48 tasks, fingerprint identical before and after; `task-runs` 4385 before and after |
| `HOSTED_VAULT_FLOW` / `HOSTED_DOC_FLOW` | **NOT_RUN** |
| `SERVICE_RESTART` / `MAIN_MERGE` | **NOT_RUN** |

## 3. The regression failure on Linux (first Linux run of these gates)

`outbound_url_policy`: "canonical outbound policy denies private DNS … encoded IP tricks" fails on Linux (deterministic: 4/5 in two runs alone) and passes on Windows (5/5).
- **Cause.** The WHATWG URL parser returns an IPv6 host *with brackets* (`[::ffff:7f00:1]`); `isIPv6()` never matches that, so `rejectUnsafeParsedUrl` does not classify it and the code falls through to a DNS lookup of the bracketed string. Windows' resolver turns it into `::ffff:127.0.0.1` (then blocked with "not a public destination"); Linux's fails with `ENOTFOUND`. The test expects the policy's wording, so it fails.
- **Not caused by PR #16 and not new:** `src/security/outbound-url-policy.ts` and its test are **byte-identical** between the deployed `bcd7e10` and the candidate.
- **Security effect on Linux (the production OS), probed on the host:** `[::1]`, `[::ffff:127.0.0.1]`, `[::ffff:10.0.0.1]`, `[fd00::1]`, `[fe80::1]`, `127.0.0.1`, `169.254.169.254`, `localhost`, `2130706433` — all **DENIED** (the IPv6 literals by DNS failure, not by classification). So the guard fails closed today, by accident; the literal-IPv6 checks (`isPrivateIPv6` also does not understand the hex form of IPv4-mapped addresses) are effectively dead code for bracketed hosts. Recommended separate fix: strip brackets and normalise IPv4-mapped IPv6 before classifying.
- Also first seen on Linux: the 4 POSIX graceful-shutdown tests, skipped on Windows, **ran and passed** (hence 4 skips instead of 8).

## 4. Browser gate on the host

At concurrency 4 one suite failed while the host ran at load ≈ 12 on 4 cores (its test took 41 s vs 17 s alone); at 3 and at 2 the whole gate is green. The host is far smaller than the workstation the 4-way policy was measured on, so for this host **use 2–3**: `NAGEX_TEST_CONCURRENCY=3` (the gate's override). These host numbers are candidate-gate evidence, not hosted-user certification.

## 5. Host safety measures (and what remains risky)

The host has 6.7 GiB RAM, 4 cores and was already swapping; the service has OOM score 675. My test processes ran at lowest CPU priority, with `oom_score_adj=1000` (preferred OOM victims, never the service), under a watchdog that kills only my process group below 900 MB available memory, plus a manual swap guard (< 400 MB). **No guard tripped; the service never restarted; health stayed 200.** Lowest observed available memory: 2.3 GiB; swap-free fell from 1.7 to 0.9 GiB. Even so, running the full browser gate on this host is not free for the service — another reason not to repeat it casually.

## 6. Operational notes for the future swap (documentation only)

- `source/.runtime/` (untracked, 620 MB, Whisper/cmake build artefacts) lives **inside the directory that would be swapped**. Neither the running baseline nor the candidate code references it, so leaving it in the renamed old directory is safe; just know it will not travel.
- `source/.nagex_data/runtime` exists and is empty.
- `/etc/nagex/nagex.env` is **not readable by the service account**; I did not escalate, so I could not audit variable *names*. The PR #16 backend adds **no new environment variable** (the only new one, `NAGEX_TEST_CONCURRENCY`, is read by the test gate script, not the service).
- Whether the service's data root comes from the env file or from the same default fallback I found in §1 cannot be shown without reading that file; the data root in use is `/var/lib/nagex`.

## 7. Evidence commands (all read-only unless stated)

`systemctl show nagex -p MainPID,NRestarts,ActiveEnterTimestamp,ExecStart,WorkingDirectory` · `git -C source rev-parse HEAD; status --short` · `curl -fsS https://nagex-test.agex.site/api/v1/health` · `df -h/-i`, `free -h`, `nproc` · `find services/nagex -maxdepth 1` · online `tar -C /var/lib -czf <private> nagex`, `sha256sum -c`, `tar -tzf`, extract to a disposable directory, JSON parse of the extracted copy · candidate: `git clone --no-checkout`, `git checkout --detach 660e15f…`, `npm ci`, `npm run build`, `npm test`, `NAGEX_TEST_CONCURRENCY=4|3|2 npm run test:browser-cert` under `nice`, `oom_score_adj=1000` and the watchdog · classification of `/var/lib/nagex` against the backup listing (manifests private on the host) · `git diff --stat bcd7e10 HEAD -- <policy files>` · a Node probe of `validateOutboundUrl` on literals (no network).

## 8. If you approve deployment later — exact, ordered, documentation only

0. **Decide §1** (cleanup option 1/2/3) and **§3** (accept the disclosed pre-existing Linux failure, or fix it first in a separate PR).
1. Read-only re-check: `systemctl show nagex -p MainPID,NRestarts`; `ls ~/services/nagex` must show `candidate-pr16-660e15f source source-faf38cc` and **no** `source-bcd7e10`.
2. *(operator, sudo)* `sudo systemctl stop nagex`
3. Cold backup (service stopped, after the §1 decision): `umask 077; tar -C /var/lib -czf ~/nagex-backups/nagex-pr16-cold-$(date +%Y%m%d-%H%M%S).tgz nagex`, then `sha256sum` it, `tar -tzf` it, test-extract into a disposable directory.
4. `cd ~/services/nagex && mv source source-bcd7e10 && mv candidate-pr16-660e15f source`
5. *(operator, sudo)* `sudo systemctl start nagex`
6. Verify read-only: `systemctl is-active nagex`; `curl` health 200; `git -C source rev-parse HEAD` = `660e15f…`; PID changed, `NRestarts` 0.
7. Then the hosted journeys, as a signed-in operator: summary → request → Approve → Open from Vault, and a document create → Recent → Open (both **NOT_RUN** until then).
8. **Rollback** (if step 6 or 7 fails): `sudo systemctl stop nagex; cd ~/services/nagex && mv source source-pr16-failed && mv source-bcd7e10 source; sudo systemctl start nagex`; restore data from the cold backup **only** if the new version changed data incompatibly (move `/var/lib/nagex` aside first, never extract over it).

## 9. Timings

Backup 3 s · clone+checkout 12 s · `npm ci` 6 s · build 26 s · regression 155 s · browser: 627 s (4) / 733 s (2) / 647 s (3) · whole preflight ≈ 1 h of wall time (12:10–13:08 host time).

## 10. 한국어 요약

- **현재 판정: NO-GO (배포 승인 요청 전 결정 필요).** 후보 코드(`660e15f`) 자체는 빌드·브라우저 인증(호스트 동시성 3과 2에서 324건 실패 0)을 통과했지만, 아래 세 가지가 남았어요.
- **① 제가 일으킨 사고(가장 중요)**: 호스트에서 테스트를 돌릴 때, 환경 변수가 지정되지 않은 저장소는 `/var/lib/nagex`가 쓰기 가능하면 **그곳에 기록**돼요(`_setup.js`는 일부만 격리). 그 결과 **테스트 기록 368개가 운영 데이터 루트에 추가**되고, 내장 역할 4개의 `updatedAt`만 갱신됐어요. 삭제 0건. 실제 사용자 세션·신원·대화 파일은 변경 0건, 고정 작업 30개(PAUSED)와 task-runs 4385는 그대로예요. 서비스는 재시작 0회·헬스 200이에요. **정리·복원은 하지 않았고**(그 자체가 무단 변경), 정확한 목록은 호스트의 비공개 폴더에 있어요. 선택지: ①목록 기준 정밀 삭제 ②방치 ③배포의 콜드 중지 단계에서 백업(테스트 시작 전 12:16 시점)으로 복원. 재발 방지: 테스트가 모든 저장소를 임시 루트로 강제하도록 수정 + `/var/lib/nagex` 접근 차단 테스트 추가(별도 변경). **서비스 호스트에서 테스트 게이트를 다시 돌리지 마세요.**
- **② Linux에서만 1건 실패(기존 코드)**: `[::ffff:7f00:1]` 같은 대괄호 IPv6 주소를 SSRF 가드가 "분류"하지 못하고 DNS 조회 실패로 막아요. 현재 운영 OS(Linux)에서는 모든 사설 주소가 **차단됨(fail-closed)**을 호스트에서 직접 확인했고, 해당 코드·테스트는 배포 중인 `bcd7e10`과 동일해요. PR #16 때문이 아니에요.
- **③ 백업**: 온라인 백업은 만들고 SHA256·압축 목록·임시 폴더 복원(JSON 19,417개 전부 정상)까지 검증했지만, **서비스가 켜진 상태의 사본이라 "임시(provisional)"**예요. 콜드 백업은 배포 단계에서 별도로 필요해요.
- 그 외: 실행 중 서비스(PID 2997023, `bcd7e10`)·소스·고정 작업·Voice WIP·main은 변경 없음. 롤백 슬롯 `source-faf38cc` 존재, `source-bcd7e10` 이름은 비어 있음. 호스트(4코어·RAM 6.7GiB)는 작아서 브라우저 게이트는 동시성 2~3으로만 안전해요.
- **여기서 멈춥니다.** 배포·재시작·정리는 새 승인이 있을 때만 진행할게요.

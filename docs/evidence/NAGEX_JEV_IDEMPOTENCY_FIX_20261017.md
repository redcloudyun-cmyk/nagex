# NAgex JEV — Idempotency-Key fix (2026-10-17)

**Status:** EVIDENCE (point in time) · **Canonical text:** `docs/canonical/NAgex_AI_Model_and_Decision_Architecture.md` §10.1 · **Release posture:** `RELEASE = NO-GO`. Nothing was deployed, `main` untouched, the deployed service not touched.

**No request to the real JEV service was made in this work.** No key exists on this PC; the limits of the task forbid mass calls and the 36-fixture benchmark, and neither was run. `JEV_LIVE_STATUS = NOT_RUN`.

## 1. The cause (reported by JEV support)

The HTTP 402 seen by the live scripts was **not** a key or billing problem (the API key and the token balance are fine). The scripts sent **fixed** keys - `nagex-jev-live-<fixture id>` (benchmark) and `nagex-jev-diagnostic-<fixture id>` (single diagnostic). JEV replays the stored answer for a repeated key and rejects the same key on a *different* request; at the time it surfaced that conflict as a 402, which looked like insufficient balance. JEV now answers the conflict with **HTTP 409** `idempotency_conflict`.

## 2. What changed

| Piece | Change |
|---|---|
| `src/model-gateway/jev-idempotency.ts` (new) | `newJevRunId()` (16 hex, one per run), `canonicalJson`, `jevRequestFingerprint` (sha-256 of the canonical body, key order irrelevant), `jevIdempotencyKey(runId, purpose, body)` = `nagex-<purpose>-<run id>-<24 hex of the fingerprint>`. Contains no credential and no request content |
| `src/model-gateway/jev-errors.ts` (new) | `parseJevErrorBody` (reads the `code`/`message`/field names of the common shapes: `error.{code,message,param}`, pydantic `detail[].loc`, `field`, `fields`, `errors[]`), `invalidFieldOf` (a field **only** when the body names one, else `UNKNOWN`), `classifyJevHttpFailure`, `redactSecrets` (the key, `Bearer …`, `Authorization: …`) |
| `src/model-gateway/jev-provider.ts` | sends the `Idempotency-Key` it is given; **refuses before sending** to carry one key on two different bodies (`IDEMPOTENCY_KEY_REUSED`, bounded memory of 512 keys; the retry of the *same* request with the *same* key is allowed); throws classified `ModelProviderError`s whose details hold `status`, `failureClass`, `bodyCode`, `fields`, the **redacted** response body |
| `scripts/jev-single-live-diagnostic.mjs` | no fixed key: a fresh run id per execution, key derived from the exact body; prints `IDEMPOTENCY_RUN_ID`, `HTTP_STATUS`, `ERROR_CLASS`, `JEV_ERROR_CODE`, `INVALID_FIELD`, redacted body. Still opt-in (`NAGEX_LIVE_JEV=1`), still ONE request |
| `scripts/jev-live-benchmark.mjs` | no fixed key: key per request per run; a retryable failure is retried **once with the same key**; stops at a 402, a 409 or a key-reuse refusal (`ABORTED_BECAUSE=…`) instead of sending the remaining fixtures into the same wall. Still opt-in (`JEV_RUN_36=YES`) - **not run** |
| `scripts/_jev-report.mjs` (new) | the failure lines both scripts print; the key never appears |
| `scripts/_jev-live.mjs` | the one-request check names 402 `INSUFFICIENT_CREDITS` and 409 `IDEMPOTENCY_CONFLICT` |

## 3. Classification (as built)

| Status | `code` | `failureClass` | Retried |
|---|---|---|---|
| 409 | `IDEMPOTENCY_CONFLICT` | `IDEMPOTENCY_CONFLICT` | no |
| 402 | `INSUFFICIENT_CREDITS` | `INSUFFICIENT_CREDITS` | no |
| 401, 403 | `PROVIDER_HTTP_<n>` | `KEY_REJECTED` | no |
| 400, 422 | `PROVIDER_HTTP_<n>` | `REQUEST_SHAPE_REJECTED` | no |
| 429 | `PROVIDER_HTTP_429` | `RATE_LIMITED` | yes |
| 408 | `PROVIDER_HTTP_408` | `TIMEOUT` | yes |
| 5xx | `PROVIDER_HTTP_<n>` | `SERVER_ERROR` | yes |
| other | `PROVIDER_HTTP_<n>` | `HTTP_ERROR` | no |

A 402 stays `INSUFFICIENT_CREDITS` even if its body mentions idempotency: a key conflict is a 409, a 402 is a balance answer. The `PROVIDER_HTTP_<n>` codes are unchanged, so the gateway's existing handling is unaffected.

`INVALID_FIELD`: the old logic searched the error text for field words and so reported a field for any message containing e.g. "input". It is now taken from the structure of the body only; a message that merely contains such a word yields `UNKNOWN`.

## 4. Verification (`tests/jev_idempotency.test.ts`, 20 tests, none reaches JEV)

- **Different requests → different keys; same request retried → same key; same request in another run → different key** (50 runs, 50 distinct keys); key order of the body is irrelevant; the key is a plain label with no fixture name or content.
- **Provider** (fake fetch): header sent / absent; the retry of the same request keeps the key and the same body; a second, different body on the same key is **refused before any fetch** (`calls.length` unchanged); the guard is bounded.
- **409 → `IDEMPOTENCY_CONFLICT`** (also with an empty body); **402 → `INSUFFICIENT_CREDITS`** (also when the body says `idempotency_conflict`); every other status keeps its code, class and retry rule.
- **Secrets**: a body that echoes the API key, a bearer token or an Authorization header is redacted in the error's message, code, details and `String(error)`.
- **`INVALID_FIELD`**: five structured shapes are read; messages that only contain field words and malformed or hostile bodies give `UNKNOWN`.
- **The real diagnostic script**, run in a child process with a preloaded global-fetch **stub** (the real endpoint is unreachable by construction): two runs send different keys, exactly one request each; 402 and 409 print `ERROR_CLASS=INSUFFICIENT_CREDITS` / `IDEMPOTENCY_CONFLICT`; the API key sentinel appears in no stdout/stderr even when the stub echoes it; 422 with only a text message prints `INVALID_FIELD=UNKNOWN`, with a `loc` prints the field; without `NAGEX_LIVE_JEV=1` no request is made.
- **Benchmark** (not run - source assertions only): no fixed key, the helper is used, one retry with the same key, abort on 402/409, still behind `JEV_RUN_36=YES`.

Existing JEV tests (`jev_shadow_runtime`, `jev_config`) pass unchanged (32/32 after the provider change).

## 5. What this does NOT show

- It does **not** show that JEV accepts the new keys. That needs one real request where a key exists, which is a user action: `NAGEX_LIVE_JEV=1 node scripts/jev-single-live-diagnostic.mjs` (ONE request; the benchmark stays unrun). Until then `JEV_LIVE = NOT_RUN`, and a passing test here is a statement about NAgex's behaviour, not about JEV's.
- The 409 / 402 / `idempotency_conflict` vocabulary is taken from JEV support's report, not from a captured response; the parser therefore reads the common error shapes and falls back to the status alone.

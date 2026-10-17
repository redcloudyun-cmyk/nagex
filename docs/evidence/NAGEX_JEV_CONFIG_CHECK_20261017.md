# NAgex JEV — configuration check (2026-10-17)

**Status:** EVIDENCE (point in time) · **Canonical text:** `docs/canonical/NAgex_AI_Model_and_Decision_Architecture.md` §10.1 · **Release posture:** `RELEASE = NO-GO`. Nothing was deployed, the deployed service was not inspected, `main` untouched.

The question: the JEV key was registered in a `.env` earlier - why is the live check `NOT_RUN`? Nothing was sent to JEV in this work, and no key, part of a key or header appears in anything below (only whether a variable is **set**).

## 1. Result

```text
JEV_ENV_KEY=NOT_FOUND            (on this PC - see section 2; the deployed server was NOT inspected)
JEV_SECRET_RESOLVER=NOT_CONNECTED (nothing resolves a provider key except the process environment; none is set here)
JEV_PROVIDER=NOT_READY           (the advisors are built only with the switch AND a key; neither is present here)
JEV_RUNTIME_KEY_ACCESS=FAIL      (on this PC: no key to read)
JEV_LIVE=NOT_RUN
JEV_BLOCKER=NO_API_KEY (in every environment reachable from this PC); the key is presumably where the service runs
NEW_KEY_REQUIRED=NO              (a key that is not found HERE is not evidence that none exists; nobody is asked to issue or register a new one)
```

## 2. What was looked at (this PC), and what was not

| Place | Result |
|---|---|
| `.env`, `.env.local`, `.env.production` in the main project and every git worktree root that exists on this PC | **none exists**; only `.env.example` (defines no JEV variable) |
| Windows environment, user + machine + this process | **no variable whose name contains `JEV`**; for comparison `GEMINI_API_KEY` is set at user level - this machine keeps provider keys in the Windows environment, not in `.env` files |
| `C:\Users\redcl\.nagex` | an empty `desktop` folder |
| GitHub repository secrets / variables, workflows | none listed; no workflow mentions JEV |
| SSH access to the deployed server | **no ssh configuration on this PC** - the deployed server is out of reach from here, and it was not inspected (standing rule: the deployed service is not read or changed without approval) |
| A search of the F: drive and the user profile for any other `.env` file | 9 real `.env` / `.env.local` files exist, **all in the user's other projects** (none in NAgex). Checked for variables whose NAME contains `JEV` and for any mention of `JEV` in the text: **none, in any of them**. Only booleans were read; no other variable name or value was printed |
| `C:\Users\redcl\AppData\Roaming\nagex-core` (the desktop app's user-data folder) | a browser cache and local-storage folder only (cache, cookies, `Local State`, `Preferences`); no configuration or secret file |

The user's own statement is that the key was registered in a `.env`. Everything here says that `.env` is **not on this PC** - most likely it is the service's own `.env` on the server. That is the one place this check could not reach.

## 3. How the product reads the key (as built)

- **No `.env` loader.** `src/` has none; provider keys are read from `process.env` of the service (a systemd `EnvironmentFile`, a shell, or the Windows environment). A `.env` file that nothing loads into the service's environment configures nothing.
- **"Secret Resolver"**: `src/security/credentials` (the credential broker) leases per-person connection credentials. It is not a store for model-provider keys, JEV's included.
- **JEV is not a chat model provider.** It is registered in no `createProviders` list. It is built as three **advisors** in `create-nagex-application.ts`: the device DecisionPort, the adaptive route advisor and the verification-level advisor - each only when `NAGEX_JEV_DECISION_ENABLED=true` **and** a key exists, each advisory and tighten-only. The router-level "JEV shadow" (`NAGEX_JEV_ADVISORY_ENABLED`) is a **local deterministic evaluator** (`JevShadowEvaluator`) that sends nothing to JEV.

## 4. Why `JEV_LIVE=NOT_RUN` - the exact causes

1. **No JEV key is visible from this PC** (section 2). This is the cause of the `NOT_RUN` recorded in the earlier evidence documents ("no credential on this machine").
2. **Even where a key exists, the advisors stay off unless `NAGEX_JEV_DECISION_ENABLED=true`** is also set for the service.
3. **A naming split (found and fixed here).** The original System One provider and its live scripts read **`JEVMODEL_API_KEY`**; the three advisors read **`NAGEX_JEV_API_KEY`**. A key registered under the older name would have been **silently ignored** by the advisors. Both names are now read through one resolver (`src/model-gateway/jev-config.ts`; `NAGEX_JEV_API_KEY` wins), so an existing key works without being registered again.
4. **No opt-in/approval step existed for one of the live scripts.** `scripts/jev-single-live-diagnostic.mjs` made a real request whenever a key was present. It now needs `NAGEX_LIVE_JEV=1`, like the benchmark's `JEV_RUN_36=YES`.

## 5. What was added (so the live check can be run where the key is)

| Piece | What it does |
|---|---|
| `src/model-gateway/jev-config.ts` | `resolveJevApiKey` (both names), `describeJevConfig` (the variable's **name** and booleans, never the value; blocker `NO_API_KEY` / `DECISION_NOT_ENABLED`) |
| `scripts/jev-config-check.mjs` | no network. Reads this process, `NAGEX_CERT_ENV_FROM_PID=<service pid>` (Linux) or `--jev-env-file <.env>` - **only the four JEV names** are parsed, nothing else in the file - and prints the report in section 1 |
| `scripts/jev-live-check.mjs` | ONE real request with the verification advisor's own request body and synthetic features; **only with `NAGEX_LIVE_JEV=1`**; prints HTTP status, answer-shape validity, latency; the body of a failed call is shown only after the key and any bearer token are removed |
| `tests/jev_config.test.ts` (9) | resolver, description (the key never in it), application wiring (advisors exist exactly with switch + key under either name; constructing the application sends nothing - fetch spy), config check (a `.env` is read for JEV names only, no key printed), live check (no request without opt-in; the one request with an injected fetch: PASS, rejected key, wrong shape, 422/429, timeout, network error; a failed body never carries the key) |

## 6. To run it where the key is (a user action - it needs the server)

```text
# 1. no network - is the key found and would the advisors exist?
node scripts/jev-config-check.mjs --jev-env-file /path/to/the/service/.env
NAGEX_CERT_ENV_FROM_PID=<service pid> node scripts/jev-config-check.mjs
# 2. ONE real request - JEV may be billable: run it only once you have decided to
NAGEX_LIVE_JEV=1 node scripts/jev-live-check.mjs --jev-env-file /path/to/the/service/.env
```

If `JEV_BLOCKER=DECISION_NOT_ENABLED`: set `NAGEX_JEV_DECISION_ENABLED=true` for the service and restart it (the restart needs the operator).

## 7. Not done / disclosed

- **No request was sent to JEV.** `JEV_LIVE=NOT_RUN`; the live contract (the four questions NAgex asks) is still unverified against the real service.
- The deployed server's `.env` and environment were **not** read. Whether the key is configured there is **unknown**, not "no".
- Whether JEV bills per request is **not known** from this repository; the live check is therefore opt-in and one request.

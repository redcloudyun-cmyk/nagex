# Legacy test service retirement and canonical domain — inventory, change record, operator runbook

**Status:** EVIDENCE + OPERATOR PLAN. **Nothing in section 5 was executed.** No route was removed, no service was stopped or disabled, no server file was written.
**Date:** 2026-10-16
**Base:** `integration/product-completion-20261015` at `20b71ad278d89741bb6b75ec5744d0124c3768ff`
**Canonical service:** `https://nagex.agex.site` — host `nagex-server` (Tailscale `100.82.102.37`), internal API `127.0.0.1:8085`, Cloudflare Tunnel `nagex-server`, Cloudflare Access: Administrator only.
**Legacy service:** `https://nagex-test.agex.site` — host `redcloud-server`, tunnel `coregex`.
**RELEASE = NO-GO.**

## 1. Inventory of the repository (before the change)

`git grep` for the legacy host, the legacy internal port (4100) and the legacy host names over `src/`, `public/`, `mobile-android/`, `apps/`, `scripts/`, `tests/`, `.github/`, `deploy/`, environment templates and docs.

| Class | Where | Count | Action |
|---|---|---|---|
| ACTIVE_RUNTIME_REFERENCE | `src/`, `public/`, `mobile-android/` (main sources), `apps/`, `.github/` | **0** | none needed — every address is already configuration (`GOOGLE_REDIRECT_URI`, `GITHUB_REDIRECT_URI`, `NAGEX_*_LOGIN_REDIRECT_URI`, `NAGEX_CORS_ALLOWED_ORIGINS`, `NAGEX_TRUSTED_PROXIES`); see 2 for the one gap (no single place) |
| DEPLOYMENT_CONFIGURATION | `scripts/nagex-check.sh` (public base default `https://nagex-test.agex.site`); 7 `scripts/nagex-*.sh` (internal base default `127.0.0.1:4100`, the legacy `PORT`); `.env.example` (local redirect URIs only) | 9 files | **changed** (all 9) |
| CI_OR_TEST_REFERENCE / OAUTH_CONFIGURATION | 24 test files and the contract registry: the literal `https://nagex-test.agex.site/...` used as an inert OAuth redirect-URI fixture (no network), 38 occurrences | 25 files | **changed** to the canonical host (the same literal on both sides of every assertion) |
| HISTORICAL_EVIDENCE | `docs/evidence/NAGEX_D09_*` (2), `NAGEX_D10_*` (2), `docs/archive/**` (3), `docs/handoff/**` (1) | 8 files | **unchanged** (point-in-time records of the legacy service) |
| DOCUMENTATION (maintained) | `docs/hackathon/NAGEX_DEMO_STORYBOARD_2026.md` (demo URL) | 1 | **changed** |
| DOCUMENTATION (dated status) | `docs/hackathon/NAGEX_HACKATHON_READINESS_2026.md` (dated `PASS` rows for the legacy URL) | 1 file | **unchanged** — it records what was true on its date |
| Not the domain | `nagex-test-gate.mjs`, `nagex-test-scope.mjs`, `nagex-test-data`, `nagex-test.example` (Android fixture), `x-nagex-test-token` | — | not touched |
| Other product | `deploy/control-center/*` (`control-test.agex.site`) | — | not touched (a different application) |

## 2. What changed in the source

* `src/config/public-url.ts` — **one** place for the deployment's address: `NAGEX_PUBLIC_URL` (an origin; https, or http for loopback; anything else is ignored and logged at start). An integration's explicit `*_REDIRECT_URI` still wins; otherwise the redirect URI is derived from the canonical origin and the route's callback path (`OAUTH_CALLBACK_PATHS`). Used by Google sign-in, Microsoft sign-in, the Google Calendar/Gmail connection, GitHub, and the enterprise-SSO public base (`server_web.ts` used `http://<Host>`, which is wrong behind a TLS-terminating tunnel). Unset → behaviour is exactly as before.
* `.env.example` — `NAGEX_PUBLIC_URL`, `PORT`, `HOST`, `NAGEX_TRUSTED_PROXIES`, CORS and cookie notes, the connected-app variables; the sign-in redirect lines are empty (derived).
* `deploy/nagex/` — systemd unit example, tunnel route + Access bypass example, README with the redirect URIs to register and the deployment assumptions.
* `scripts/nagex-*.sh` — public base `https://nagex.agex.site`, internal base `http://127.0.0.1:8085`; the SSRF self-check targets the configured internal base instead of a fixed legacy port.
* tests — fixtures use the canonical host; `tests/public_url_config.test.ts` (config + guard against the legacy host in maintained sources) and `tests/canonical_domain_browser.test.ts` (real Chromium: Google and Microsoft sign-in redirect URIs derived from `NAGEX_PUBLIC_URL`).

## 3. Verification (isolated development environment)

See the final report of this change for the run results: TypeScript build; `public_url_config`; `canonical_domain_browser` (Chromium: Google and Microsoft sign-in start redirect to the provider with `redirect_uri=https://nagex.agex.site/...`); session cookie `HttpOnly; Secure; SameSite=Lax`, host-only (no `Domain`); CORS closed by default; client address resolved from `X-Forwarded-For` only through `NAGEX_TRUSTED_PROXIES`; the full regression and browser gates.
**Not verifiable from the repository:** that Cloudflare Access is configured as stated, that the Access Bypass for the two webhook paths exists, that the identity-provider consoles list the new redirect URIs, and any behaviour of `nagex-server` itself (not inspected, not touched).

## 4. Legacy server — read-only inspection (2026-10-16, `redcloud@100.100.248.77`, read-only commands only)

* Tunnel: `cloudflared.service` runs `cloudflared --no-autoupdate tunnel run --token-file /etc/cloudflared/token` → a **remotely managed** tunnel: its routes live in Cloudflare (dashboard / API), **not in a local file**. The service log's last configuration (`version=14`) lists 14 hostnames and a final `http_status:404`:
  `coregex`, `research`, `app`, `www.reha.kr`, `hogi`, `broadcast`, `pollinsight-test`, `actgex-test` (`localhost:4000`), `withgex-test`, `electioncase-test`, **`nagex-test.agex.site → http://127.0.0.1:4100`** (the 11th), `better-future-test` (`localhost:80`), `agex-brand`, `control-test`.
* A second tunnel service `cloudflared-haraphysics.service` (a different tunnel) and `cloudflared-healthcheck.service` (oneshot, root script `/usr/local/sbin/cloudflared-healthcheck`, **not readable by the service user — it may name routes; check before removing the route**) exist.
* NAgex service: `nagex.service` (enabled, running; the process was about two days old), user `redcloud`, `WorkingDirectory=/home/redcloud/services/nagex/source`, `PORT=4100`, `EnvironmentFile=/etc/nagex/nagex.env` (root-only, not read), a root-only token-encryption drop-in (not read), `NODE_OPTIONS` drop-in. Data `/var/lib/nagex` (87 MB). Other directories: `/home/redcloud/services/nagex/{source,source-faf38cc,candidate-pr16-660e15f}`. Log `/var/log/nagex-system-maintenance.log`.
* `nagex-system-maintenance.service` + `.timer` (Sundays 04:30, script `/usr/local/sbin/nagex-system-maintenance`, not readable) — NAgex-named, **review before disabling the service**.
* nginx: vhost `/etc/nginx/sites-available/nagex-test.agex.site` (enabled) listens on `:3915` and proxies to `127.0.0.1:4100`. **The tunnel does not use it** (it points straight at 4100).
* **Port 8085 on the legacy host is another product**: `agex-8085.service` ("AGEX Platform Service 8085", pid 1920, `node dist/src/server_web.js`). It is **not** NAgex. The new server's internal API port is also 8085 — do not confuse the two machines.

## 5. Operator runbook (PREPARED — run by the operator only, in this order, after the explicit go-ahead)

Variables used below (operator's shell, secrets never echoed): `CF_API_TOKEN` (a Cloudflare API token with Cloudflare Tunnel: Read + Edit on this account), `ACCOUNT_ID`, `TUNNEL_ID` (the `coregex` tunnel). The same steps can be done in the dashboard (Zero Trust → Networks → Tunnels → `coregex` → Public Hostname).

### 5.0 Preconditions (read-only)

```sh
# the canonical service is healthy (on nagex-server)
curl -fsS http://127.0.0.1:8085/api/v1/health
# the identity-provider consoles list https://nagex.agex.site/... redirect URIs (deploy/nagex/README.md) and sign-in works on the new address
# no traffic left on the legacy route: check the Cloudflare analytics of nagex-test.agex.site for the observation window you chose (suggested: 7 days)
```

### 5.1 Snapshot of the current routes and of every other hostname's answer

```sh
API="https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/configurations"
mkdir -p ~/nagex-retirement && cd ~/nagex-retirement && umask 077
curl -fsS -H "Authorization: Bearer $CF_API_TOKEN" "$API" > coregex-config-before.json
jq '.result.version, (.result.config.ingress | length)' coregex-config-before.json        # expect 14 (version 14 at the time of inspection) and 15 (14 hostnames + the fallback)
jq -r '.result.config.ingress[] | select(.hostname) | .hostname' coregex-config-before.json | sort > hostnames-before.txt
# what each hostname answers now (status only; Access-protected ones answer 302/403 - what matters is that before == after)
while read -r h; do printf '%s %s\n' "$h" "$(curl -s -o /dev/null -m 15 -w '%{http_code}' "https://$h/")"; done < hostnames-before.txt > status-before.txt
```

### 5.2 Remove ONLY the legacy route (one entry out, everything else byte-for-byte the same)

```sh
jq '{config: (.result.config | .ingress |= map(select(.hostname != "nagex-test.agex.site")))}' coregex-config-before.json > coregex-config-put.json
# guard: exactly one rule fewer, only that hostname gone, the fallback rule still last
test "$(jq '.config.ingress | length' coregex-config-put.json)" = "$(( $(jq '.result.config.ingress | length' coregex-config-before.json) - 1 ))" || { echo "WRONG COUNT"; exit 1; }
diff <(jq -S '.result.config.ingress[] | {hostname, service}' coregex-config-before.json) <(jq -S '.config.ingress[] | {hostname, service}' coregex-config-put.json)   # must show ONLY the nagex-test.agex.site entry
jq -e '.config.ingress[-1] | has("hostname") | not' coregex-config-put.json >/dev/null || { echo "FALLBACK RULE LOST"; exit 1; }
# apply
curl -fsS -X PUT -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" --data @coregex-config-put.json "$API" | jq '.success'
```

### 5.3 Verify the other routes are unchanged

```sh
curl -fsS -H "Authorization: Bearer $CF_API_TOKEN" "$API" > coregex-config-after.json
diff <(jq -S '[.result.config.ingress[] | select(.hostname != "nagex-test.agex.site") | {hostname, service}]' coregex-config-before.json) <(jq -S '[.result.config.ingress[] | {hostname, service}]' coregex-config-after.json) && echo "ROUTES UNCHANGED EXCEPT THE REMOVED ONE"
grep -v '^nagex-test.agex.site ' status-before.txt > status-before-others.txt
while read -r h _; do printf '%s %s\n' "$h" "$(curl -s -o /dev/null -m 15 -w '%{http_code}' "https://$h/")"; done < status-before-others.txt > status-after.txt
diff status-before-others.txt status-after.txt && echo "OTHER ROUTES UNCHANGED"
curl -s -o /dev/null -w '%{http_code}\n' https://nagex-test.agex.site/        # now the tunnel's fallback (404) - nothing else answers for it
```

The DNS record of `nagex-test.agex.site` and any Cloudflare Access application for it are **separate objects**: leave them for the observation window; delete them (or add a redirect rule to `https://nagex.agex.site`) as a later, separate decision.

### 5.4 Legacy service: ownership and dependencies (read-only, on `redcloud-server`)

```sh
systemctl show nagex.service -p FragmentPath -p MainPID -p ActiveState -p User
ss -ltnp 'sport = :4100'                       # the pid must equal MainPID above. NEVER act on 127.0.0.1:8085 - that is agex-8085.service, another product
systemctl list-dependencies --reverse nagex.service
grep -rl -E '4100|nagex' /etc/systemd/system 2>/dev/null     # expected: nagex.service, its drop-ins, nagex-system-maintenance.service
sudo grep -n -E 'nagex|agex.site|4100' /usr/local/sbin/nagex-system-maintenance /usr/local/sbin/cloudflared-healthcheck   # does either script need the service or the route?
ls -la /var/lib/nagex /etc/nagex /home/redcloud/services/nagex /var/log/nagex-system-maintenance.log
```

### 5.5 Disable `nagex.service` — only after the operator's explicit approval

```sh
# data, secrets and logs are PRESERVED: nothing below deletes, moves or masks anything
umask 077
sudo tar -czf /var/backups/nagex-legacy-$(date +%Y%m%d).tgz -C / var/lib/nagex etc/nagex etc/systemd/system/nagex.service etc/systemd/system/nagex.service.d etc/nginx/sites-available/nagex-test.agex.site
sudo sha256sum /var/backups/nagex-legacy-*.tgz | sudo tee /var/backups/nagex-legacy.sha256
# re-check identity right before acting
test "$(systemctl show nagex.service -p MainPID --value)" = "$(ss -ltnp 'sport = :4100' | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1)" || { echo "NOT THE NAGEX SERVICE"; exit 1; }
sudo systemctl stop nagex.service
sudo systemctl disable nagex.service
systemctl is-active nagex.service; systemctl is-enabled nagex.service      # inactive, disabled
systemctl is-active agex-8085.service cloudflared.service                   # both still active (unrelated; must not change)
```

Optional, later and separately: `sudo rm /etc/nginx/sites-enabled/nagex-test.agex.site && sudo nginx -t && sudo systemctl reload nginx` (the vhost is not on the tunnel's path); the weekly `nagex-system-maintenance.timer` only after 5.4 shows what it does.

### 5.6 Rollback (wrong route or wrong service affected)

```sh
# a. route: put the snapshot back (the PUT body is the 'config' of the snapshot)
jq '{config: .result.config}' coregex-config-before.json > coregex-config-restore.json
curl -fsS -X PUT -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" --data @coregex-config-restore.json "$API" | jq '.success'
#    (dashboard alternative: Public Hostname -> add nagex-test.agex.site -> HTTP 127.0.0.1:4100, placed before the fallback)
# b. service
sudo systemctl enable --now nagex.service
curl -fsS http://127.0.0.1:4100/api/v1/health
# c. confirm: status-before.txt matches again for every hostname, https://nagex-test.agex.site/ answers as it did
```

Nothing in 5.5 touches `/var/lib/nagex`, `/etc/nagex` or the logs, so a restart resumes with the same data.

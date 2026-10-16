# NAgex service deployment (canonical address)

| | |
|---|---|
| Public URL (canonical) | `https://nagex.agex.site` |
| Host | `nagex-server` (Tailscale `100.82.102.37`) |
| Internal API | `127.0.0.1:8085` (the application's default `PORT`) |
| Tunnel | Cloudflare Tunnel `nagex-server`, public hostname `nagex.agex.site` -> `http://127.0.0.1:8085` |
| Access | Cloudflare Access, Administrator only |
| Legacy (retiring) | `nagex-test.agex.site` on `redcloud-server` (tunnel `coregex`) - see `docs/evidence/NAGEX_LEGACY_TEST_SERVICE_RETIREMENT_PLAN_20261016.md` |

The address is configuration, not code: set **`NAGEX_PUBLIC_URL=https://nagex.agex.site`** once. Every redirect URI that has to match what the browser and the identity providers see is derived from it
(an integration's own `*_REDIRECT_URI` still wins when set). No source file names a host.

## Files

* `nagex.service.example` - systemd unit (placeholders for user, install dir and node binary)
* `cloudflared-ingress.example.yml` - the tunnel route and the Access bypass paths
* `../../.env.example` - the environment file (copy to `/etc/nagex/nagex.env`, mode 0600, never commit it)

## Install / update (nagex-server)

1. Source: `git fetch && git merge --ff-only origin/<authorized branch>` in `<install-dir>`, then `npm ci && npm run build`.
2. `/etc/nagex/nagex.env` from `.env.example`: `NAGEX_PUBLIC_URL=https://nagex.agex.site`, `PORT=8085`, `HOST=127.0.0.1`, `NAGEX_TRUSTED_PROXIES=127.0.0.1,::1`,
   `NAGEX_TOKEN_ENCRYPTION_KEY` (`openssl rand -base64 32`), the OAuth client ids / secrets. Leave `NAGEX_INSECURE_COOKIES_FOR_LOCAL_DEV` unset.
3. `sudo systemctl daemon-reload && sudo systemctl enable --now nagex.service` (restart needs the operator's sudo).
4. `curl -fsS http://127.0.0.1:8085/api/v1/health` on the host; then through the public name with an Access session.

## Redirect URIs to register (identity providers)

| Provider / purpose | Redirect URI |
|---|---|
| Google sign-in | `https://nagex.agex.site/api/v1/auth/oauth/google/callback` |
| Microsoft sign-in | `https://nagex.agex.site/api/v1/auth/oauth/microsoft/callback` |
| Google Calendar / Gmail connection | `https://nagex.agex.site/api/v1/oauth/google/callback` |
| GitHub connection | `https://nagex.agex.site/api/v1/oauth/github/callback` |
| Enterprise OIDC (per organization) | `https://nagex.agex.site/api/v1/auth/oidc/callback` |

The old `nagex-test.agex.site` URIs stay registered until the legacy route is retired, then are removed by the operator in each provider console.

## What the application assumes about this deployment

* **TLS ends at Cloudflare.** The browser talks https to `nagex.agex.site`; the application sees http from `cloudflared` on loopback. Session cookies are therefore `HttpOnly; Secure; SameSite=Lax` with **no `Domain`** (host-only):
  a session is bound to `nagex.agex.site` alone and is not shared with the legacy host or any other `agex.site` application. People sign in again on the new address; no session or data is migrated by this change.
* **Client address.** `NAGEX_TRUSTED_PROXIES=127.0.0.1,::1` lets the application read `X-Forwarded-For` from `cloudflared` only. Without it the loopback peer would be taken as every client and rate limits would be shared.
* **CORS.** The app is same-origin; `NAGEX_CORS_ALLOWED_ORIGINS` stays empty.
* **Access.** The Administrator-only policy sits in front of everything; NAgex's own sign-in and approvals still apply behind it. Telegram / Slack webhooks cannot pass an Access login: add an Access Bypass for exactly the two paths in
  `cloudflared-ingress.example.yml` (they verify their own signature). Not verified from the repository - confirm in the Zero Trust dashboard.

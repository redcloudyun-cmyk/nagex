# NAgex Deployment Notes

## Application Update (`scripts/nagex-update.sh`)

This is the repository-managed, version-controlled version of the
operational `nagex-update` command referenced throughout this document.
Run it on the deployment host from the repo checkout:

```bash
scripts/nagex-update.sh
```

It runs, in order, failing (and leaving the previous process running)
if any stage fails:

1. Verifies the repo path/branch and refuses to run against a dirty
   working tree.
2. `git fetch origin` → `git checkout main` → `git reset --hard
   origin/main` (non-interactive — same behavior the server's existing
   `nagex-update` uses).
3. `npm ci`.
4. Resolves the **exact** Chromium executable the installed Playwright
   version expects (`chromium.executablePath()`), not merely whether
   `~/.cache/ms-playwright` exists — a stale/partial cache from a
   different Playwright version would pass a directory check while
   still being unusable. Runs `npx playwright install chromium` only
   if that executable is actually missing.
5. Performs a **real** headless `chromium.launch()` to confirm the
   browser genuinely starts, not just that a binary file exists on
   disk. The deploy is aborted if this fails.
6. `npm run build`, then `npm test`.
7. Restarts the service (`sudo systemctl restart nagex`) — only
   reached once every check above is green.

Browser Agent intentionally **fails closed** with `BROWSER_UNAVAILABLE`
whenever no usable browser runtime exists (missing binary, or a binary
that exists but cannot launch on this host) — this is correct,
intended safety behavior, not a bug. Step 5 above exists so a broken
Chromium install is caught during deployment instead of surfacing
later as `BROWSER_UNAVAILABLE`/failed Conditional Watch checks in
production.

There is currently no documented (or implemented) canonical health
endpoint for NAgex, so `nagex-update.sh` does not attempt a post-deploy
health check — only build/test success gates the restart. Add one here
once a real `/health`-style endpoint exists.

### One-time Ubuntu host provisioning (not part of every deployment)

Chromium's OS-level shared-library dependencies (fonts, `libnss3`,
`libatk`, etc.) are a **host provisioning** concern, separate from the
application update above — they require `sudo`, they don't change
between deploys, and a routine update should never mutate OS packages.
Run this once per host (and again only if the OS image changes or
Playwright's browser dependency list changes):

```bash
sudo npx playwright install-deps chromium
```

`scripts/nagex-update.sh` deliberately never runs `install-deps`.

### CI (`.github/workflows/ci.yml`)

GitHub-hosted runners are ephemeral, so CI provisions Chromium *and*
its OS dependencies together on every run (`npx playwright install
--with-deps chromium`) — the same "OS deps are separate" rule doesn't
apply there because there is no persistent host to provision once.

## Google OAuth Token Persistence

Google Calendar OAuth tokens are stored encrypted on disk so a service
restart, redeploy, or `nagex-update` run does not disconnect the user's
Google Calendar. The token store lives outside the Git-managed working
directory and is never committed.

### One-time server setup

```bash
sudo mkdir -p /var/lib/nagex
sudo chown redcloud:redcloud /var/lib/nagex
sudo chmod 700 /var/lib/nagex
```

If `/var/lib/nagex` cannot be created or written to (e.g. local
development, or before the step above has run), NAgex automatically
falls back to `~/.local/share/nagex/google-oauth.json` under the
service account's home directory. Both paths are outside the repo and
are never read by `git status`/`git diff`.

To pin an explicit path instead (useful for tests or non-standard
layouts), set `NAGEX_GOOGLE_TOKEN_STORE_PATH` to the full file path.

### Required environment variables

| Variable | Purpose |
| --- | --- |
| `GOOGLE_CLIENT_ID` | OAuth client ID from Google Cloud Console. |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret. Never persisted to the token file — only used in-memory for token exchange/refresh/revoke calls. |
| `GOOGLE_REDIRECT_URI` | Must exactly match the redirect URI registered on the OAuth client, e.g. `https://nagex-test.agex.site/api/v1/oauth/google/callback`. |
| `NAGEX_TOKEN_ENCRYPTION_KEY` | 32-byte key (base64 or 64-char hex) used for AES-256-GCM encryption of the token file. Generate with `openssl rand -base64 32`. Required for tokens to survive a restart — without it, NAgex still works but keeps the connection in memory only (a warning is logged at startup). |
| `NAGEX_GOOGLE_TOKEN_STORE_PATH` | Optional. Overrides the token file's location. |

Rotating `NAGEX_TOKEN_ENCRYPTION_KEY` invalidates any previously
persisted token (it fails closed to disconnected — see below); the
user simply reconnects Google Calendar once from the Tools page.

### Failure behavior (fail closed)

- Missing token file → reports disconnected.
- Corrupted file, wrong encryption key, or unexpected structure →
  reports disconnected and logs a safe error (never the file contents,
  the key, or any token value).
- Refresh revoked by Google → reports disconnected.

None of these states are ever reported as connected.

### Deployment checklist

`nagex-update` / `systemctl restart nagex` must **not** destroy the
OAuth connection:

- The token file lives under `/var/lib/nagex` (or the per-user
  fallback), not under the repo checkout — a `git pull`/`npm ci`
  during deploy never touches it.
- On the next process start, the token store decrypts and restores the
  connection from disk automatically; an expired-but-refreshable
  access token is refreshed transparently on first use (e.g. the next
  `GET /api/v1/oauth/google/status` call) and the refreshed token is
  re-persisted.

## Approval and Execution Persistence

Google Calendar approval requests and tool execution records also
survive a restart, so an approval created (or approved) right before a
redeploy is not lost, and execution history isn't wiped on restart.
Unlike OAuth tokens, these records hold only calendar event details
(never tokens or the client secret), so they are stored as plain JSON
— one file per record — rather than encrypted.

| Data | Default path | Override |
| --- | --- | --- |
| Approvals | `/var/lib/nagex/approvals/<approvalId>.json` (falls back to `~/.local/share/nagex/approvals` the same way the OAuth token store does) | `NAGEX_APPROVALS_DIR` |
| Executions | `/var/lib/nagex/executions/<executionId>.json` | `NAGEX_EXECUTIONS_DIR` |

No extra `sudo mkdir` step is needed for these two subdirectories —
NAgex creates them under `/var/lib/nagex` automatically (that base
directory's permissions are the one-time setup above).

`NAGEX_APPROVAL_TTL_SECONDS` overrides the default 15-minute approval
expiry window (`900`); an approval past its expiry is reported (and
persisted) as `EXPIRED` and can never be approved or executed.

Each write (create, approve, reject, consume, execution start/succeed/
fail) is atomic — temp file in the same directory, `chmod 0600`, then
an atomic rename — so a crash mid-write can never leave a torn or
partially-written record.

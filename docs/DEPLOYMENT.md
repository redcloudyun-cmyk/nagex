# NAgex Deployment Notes

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

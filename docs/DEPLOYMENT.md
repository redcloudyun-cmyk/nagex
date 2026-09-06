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

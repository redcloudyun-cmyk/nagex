# NAgex — Staging deployment plan and rollback (nagex.agex.site) · 2026-10-17

**Status:** PLAN (point in time) · **Release posture:** `RELEASE = NO-GO` · **Nothing in this document has been executed.** `main` is not touched. This is a user-inspection (Staging) deployment of the integration line, judged separately from any formal release.

Written for: the operator who runs the server steps (the restart needs their sudo).

## 1. Why this is a plan and not a deployment

The deployment target is `nagex.agex.site` = host **`nagex-server`** (Tailscale `100.82.102.37`, `deploy/nagex/README.md`). From the development PC:

| Check | Result |
|---|---|
| `nagex-server` on the tailnet | **active** (direct connection) |
| `ssh redcloud@100.82.102.37` with this PC's key (`~/.ssh/id_ed25519`), batch mode | **`Permission denied (publickey,password)`** - the key is not authorised for that user on that host (or the user name differs) |
| `https://nagex.agex.site/` without a session | 302 to Cloudflare Access (Administrator only) - not bypassed |
| the only SSH host this PC is configured for | `redcloud-server` (100.100.248.77) = the **legacy** test server `nagex-test.agex.site`, "being retired" - **not** the Staging target, and nothing was changed there |

So the following could **not** be done from here and are **BLOCKED on server access**: reading the currently deployed SHA, the NVMe health check, the backup check, the deployment itself, and the post-deploy check on `nagex.agex.site`. No other user name, password or key was tried.

## 2. Target and current state

| | |
|---|---|
| Target SHA | the tip of `integration/product-completion-20261015` once its CI is green (`4beb835` = Enter fix merged; CI result is reported with this plan) |
| Last SHA the repository records as deployed | `bcd7e10` (2026-10-15, **legacy** test server; nothing records `nagex-server`'s SHA) |
| Fast-forward possible from `bcd7e10`? | **yes** - `bcd7e10` is an ancestor of the target (136 commits) |
| Contains the Enter fix | yes (`dd2e9f8` via `3de7b1e`, shared rule `e101c8c`) |
| Dependencies changed | **yes** - `package.json` / `package-lock.json` -> `npm ci`, not only `npm run build` |
| Environment | `NAGEX_PUBLIC_URL=https://nagex.agex.site` is the single address setting (already part of the canonical install); `.env.example` also lists `PORT`, `HOST`, `NAGEX_TOKEN_ENCRYPTION_KEY`, the Google/GitHub OAuth ids. Compare the host's `/etc/nagex/nagex.env` with `.env.example` **by variable name only** - never print values |
| Durable stores | 5 **new** stores (route history, video, product builder, research runs, to-dos) and 10 **modified** store implementations (executions, the shared file-record base, presentation, device execution session, device command status, GitHub token, Google token, MCP connection, reminders, vault). New code may write records in a shape the old code does not read -> **a backup of the data directory is mandatory before the restart** (section 4) |

## 3. Pre-flight - stop here if any line fails

1. **CI green on the target SHA, both operating systems.** If it is red: analyse the failure; a user-inspection deployment is judged separately and only if the failure cannot affect deployment safety.
2. **Record the rollback point** (on the host, in the install directory):
   ```text
   git rev-parse HEAD            -> write it down: this is DEPLOYED_SHA_BEFORE
   git status --short            -> must be clean
   git branch backup/pre-4beb835 HEAD
   ```
3. **NVMe and disk** - do not deploy if any of these is wrong:
   ```text
   df -h /var/lib/nagex /home /       -> at least 20 % free and room for a copy of /var/lib/nagex
   lsblk -o NAME,SIZE,MODEL,MOUNTPOINT
   sudo smartctl -H /dev/nvme0n1      (or: sudo nvme smart-log /dev/nvme0)
        stop if: overall health not PASSED, critical_warning != 0, media_errors > 0, percentage_used > 90, available_spare below threshold
   dmesg -T | grep -i -E 'nvme|i/o error|ext4-fs error' | tail      -> stop if recent NVMe / filesystem errors
   ```
4. **Backup, and prove it can be read:**
   ```text
   sudo tar -C /var/lib -czf /var/backups/nagex-pre-4beb835-$(date +%Y%m%d%H%M).tgz nagex
   sudo tar -tzf /var/backups/nagex-pre-4beb835-*.tgz | head       -> lists files; check the size is plausible
   sudo cp -p /etc/nagex/nagex.env /var/backups/nagex.env.pre-4beb835   -> mode 0600, never printed, never committed
   ```
   If there is an existing backup routine (cron / timer), confirm its last run is recent **and** keep this extra copy anyway.

## 4. Deploy (only after section 3 passes)

```text
cd <install-dir>                                   (deploy/nagex/README.md "Install / update")
git fetch origin
git merge --ff-only origin/integration/product-completion-20261015      -> must fast-forward; if it does not, STOP
npm ci && npm run build                            (PATH needs the node 24 bin of the service user)
sudo systemctl restart nagex                       <- operator's sudo
curl -fsS http://127.0.0.1:8085/api/v1/health      -> {"status":"UP",...}
journalctl -u nagex -n 80 --no-pager               -> no start-up error; no secret in the lines
```
Do not use `scripts/nagex-update.sh` unchecked: it resets to `origin/main` and runs the whole test suite.

## 5. Rollback

```text
git checkout --detach <DEPLOYED_SHA_BEFORE>        (or: git checkout backup/pre-4beb835)
npm ci && npm run build
sudo systemctl restart nagex
curl -fsS http://127.0.0.1:8085/api/v1/health
```
If the service starts but reads its data wrongly (new-shape records, section 2): `sudo systemctl stop nagex`, restore **only what is needed** from the tarball (`sudo tar -xzf <backup> -C /var/lib nagex/<store>`), start again. Restoring the whole tarball discards everything written after the backup - say so to the people using the service first. A rollback must not replay consequential actions: approvals and executions are stored, not re-run.

## 6. Verification on `nagex.agex.site` (signed in through Cloudflare Access)

1. `https://nagex.agex.site/api/v1/vcs/status` -> `commits[0].hash` is the target SHA (a read-only route that already exists).
2. Page source: `main-surface.js?v=...` and `composer-keys.js?v=...` are present (a 12-hex stamp that differs from before); console: `typeof NAGEX_COMPOSER_KEYS.isSubmitEnter` -> `"function"`.
3. **Main:** type text, press **Enter** -> sent once; **Shift+Enter** -> a new line, nothing sent; the **Send button** -> the same request.
4. **Korean IME:** type `안녕하세요`, press Enter once -> the syllable is confirmed and **nothing is sent**; press Enter again -> the full text is sent. (A first Enter that sends, or a truncated text, is a failure.)
5. **Ambient Ask sheet** (`Alt+N`) and **Quick Wake** (`/quickwake`): the same two checks; the sent text is never cut at the last syllable.
6. A normal reload shows the latest UI (static files are served `no-store`); if an old behaviour persists, the stamp in step 2 tells whether the server or the browser is the one that is old.
7. On a phone or a touch tablet Enter is a new line by design and the Send button sends.

## 7. Judged separately

- **Staging / user-inspection deployment:** possible once section 1 is resolved, the CI gate (section 3.1) is met and section 3 passes.
- **Formal release:** not decided here. `RELEASE = NO-GO` stands: a formal release needs the full gate and the open debts (`DEBT-0017`, `DEBT-0018`) reviewed, and `main` is not part of this.

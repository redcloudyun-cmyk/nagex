#!/usr/bin/env bash
#
# NAgex application update — repository-managed version of the operational
# `nagex-update` command referenced in docs/DEPLOYMENT.md.
#
# What this script does NOT do, on purpose:
#   - It never runs `npx playwright install-deps`. OS-level package
#     installation requires sudo and mutates the host outside the app's own
#     working directory — that is a one-time host provisioning step
#     (see docs/DEPLOYMENT.md), not something a routine update should do.
#   - It never touches Google OAuth token/approval/execution persistence —
#     those live under /var/lib/nagex (or the per-user fallback), outside
#     this repo checkout, and this script does not read or write them.
#
# Usage: scripts/nagex-update.sh
# Exit code is non-zero if any stage fails; the deployment must be treated
# as failed and the previous process left running.

set -euo pipefail

VERIFY_FLAG=false
for arg in "$@"; do
  case "$arg" in
    --verify)
      VERIFY_FLAG=true
      ;;
  esac
done

log() {
  printf '\n[nagex-update] %s\n' "$1"
}

fail() {
  printf '\n[nagex-update] FAILED: %s\n' "$1" >&2
  exit 1
}

# ── Stage: locate and verify the repository ────────────────────────────────
log "Stage: verify repository"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." >/dev/null 2>&1 && pwd)"
cd "${REPO_ROOT}"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  fail "${REPO_ROOT} is not a git working tree"
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
log "Repository path: ${REPO_ROOT}"
log "Current branch:  ${CURRENT_BRANCH}"

# ── Stage: refuse to run against a dirty working tree ───────────────────────
log "Stage: verify working tree is clean"

if [ -n "$(git status --porcelain)" ]; then
  fail "working tree is dirty — refusing to update. Commit, stash, or discard local changes first."
fi

# ── Stage: sync to origin/main ──────────────────────────────────────────────
log "Stage: fetch origin"
git fetch origin

log "Stage: switch to main"
git checkout main

log "Stage: reset to origin/main (non-interactive, matches existing server nagex-update behavior)"
git reset --hard origin/main

DEPLOYED_SHA="$(git rev-parse HEAD)"
log "Synced to commit: ${DEPLOYED_SHA}"

# ── Stage: install dependencies ─────────────────────────────────────────────
log "Stage: npm ci"
npm ci

# ── Stage: Playwright Chromium prerequisite ─────────────────────────────────
# Resolve the EXACT executable path the installed Playwright version expects
# — never just check whether ~/.cache/ms-playwright exists, since a stale or
# partial cache from a different Playwright version would pass a directory
# check while still being unusable.
log "Stage: verify Playwright Chromium executable"

if node --input-type=module -e "
import { chromium } from 'playwright';
import fs from 'node:fs';
process.exit(fs.existsSync(chromium.executablePath()) ? 0 : 1);
"; then
  log "Chromium executable already present at the path Playwright expects."
else
  log "Chromium executable missing — installing (browser binary only, no OS deps)."
  npx playwright install chromium
fi

# Do NOT run `npx playwright install-deps` here — see header comment.

# ── Stage: real headless browser launch verification ────────────────────────
log "Stage: verify Chromium actually launches headlessly"

BROWSER_LAUNCH_OUTPUT="$(mktemp)"
if node --input-type=module - <<'NODE' >"${BROWSER_LAUNCH_OUTPUT}" 2>&1
import { chromium } from 'playwright';

try {
  const browser = await chromium.launch({ headless: true });
  console.log('PLAYWRIGHT_BROWSER_LAUNCH=SUCCESS');
  console.log('PLAYWRIGHT_BROWSER_VERSION=' + browser.version());
  await browser.close();
} catch (error) {
  console.error('PLAYWRIGHT_BROWSER_LAUNCH=FAILED');
  console.error(error);
  process.exit(1);
}
NODE
then
  cat "${BROWSER_LAUNCH_OUTPUT}"
  BROWSER_LAUNCH_RESULT="SUCCESS"
  PLAYWRIGHT_BROWSER_VERSION="$(grep '^PLAYWRIGHT_BROWSER_VERSION=' "${BROWSER_LAUNCH_OUTPUT}" | cut -d= -f2-)"
else
  cat "${BROWSER_LAUNCH_OUTPUT}" >&2
  rm -f "${BROWSER_LAUNCH_OUTPUT}"
  fail "Chromium could not launch headlessly — Browser Agent would fail closed with BROWSER_UNAVAILABLE. Check host provisioning (see docs/DEPLOYMENT.md's one-time 'sudo npx playwright install-deps chromium' step)."
fi
rm -f "${BROWSER_LAUNCH_OUTPUT}"

# ── Stage: build ─────────────────────────────────────────────────────────
log "Stage: npm run build"
if npm run build; then
  BUILD_RESULT="SUCCESS"
else
  BUILD_RESULT="FAILED"
  fail "build failed"
fi

# ── Stage: test ──────────────────────────────────────────────────────────
log "Stage: npm test"
if npm test; then
  TEST_RESULT="SUCCESS"
else
  TEST_RESULT="FAILED"
  fail "tests failed — deployment aborted, previous process left running"
fi

# ── Stage: service restart ──────────────────────────────────────────────────
# docs/DEPLOYMENT.md's existing deployment checklist documents this pairing
# ("`nagex-update` / `systemctl restart nagex` must not destroy the OAuth
# connection"), so this is a documented, not invented, service name.
log "Stage: restart nagex service"
if command -v systemctl >/dev/null 2>&1; then
  sudo systemctl restart nagex
  log "systemctl restart nagex issued."
else
  log "systemctl not available on this host — service restart is a host integration point; restart NAgex manually."
fi

# ── Stage: post-deploy health check ─────────────────────────────────────────
log "Stage: post-deploy health check"
if [ "${VERIFY_FLAG}" = "true" ]; then
  log "Running nagex-check..."
  "${SCRIPT_DIR}/nagex-check.sh"
else
  log "Skipped (run nagex-check to perform safe verification)"
fi

# ── Summary ──────────────────────────────────────────────────────────────
log "Deployment summary"
echo "DEPLOYED_COMMIT_SHA=${DEPLOYED_SHA}"
echo "BUILD_RESULT=${BUILD_RESULT}"
echo "TEST_RESULT=${TEST_RESULT}"
echo "PLAYWRIGHT_BROWSER_LAUNCH=${BROWSER_LAUNCH_RESULT}"
echo "PLAYWRIGHT_BROWSER_VERSION=${PLAYWRIGHT_BROWSER_VERSION:-unknown}"

log "Update complete."
echo ""
echo "Next recommended step:"
echo "  nagex-check"
echo ""

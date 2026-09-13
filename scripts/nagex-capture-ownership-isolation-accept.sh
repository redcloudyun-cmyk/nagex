#!/usr/bin/env bash
#
# NAgex Capture Ownership Isolation Correction — dedicated Host Acceptance.
#
# Built by reading the exact current source at 46cb25f026fb16e680e3b28bd0824fc7e27b797a
# — not guessed:
#   - CaptureStore.getCapture/updateStatus/deleteCapture all route through a
#     centralized requireOwned(id, tenantId, ownerId) — a mismatch returns
#     null, externally indistinguishable from a genuinely nonexistent
#     captureId. listCaptures(tenantId, ownerId, filter?) filters by both
#     before result construction.
#   - QuickCaptureService threads tenantId alongside ownerId through every
#     Capture-facing method, including actionCapture(id, tenantId, ownerId,
#     actionType) — the original zero-check vulnerability this correction
#     fixed.
#   - Route response shapes, confirmed by direct read (not assumed):
#       * POST /api/v1/workspace/capture            -> 201 {...CaptureItem}
#       * GET  /api/v1/workspace/items/:id           -> 200 {...CaptureItem}
#         or 404 {error:"ITEM_NOT_FOUND", message}   (flat shape)
#       * POST /api/v1/workspace/items/:id/action    -> 200 {...CaptureItem}
#         or the same 404 flat shape
#       * PATCH|POST /api/v1/workspace/capture/:id   -> identical shape to
#         the /items/:id/action route (the "legacy" mutation path, same
#         actionCapture() call underneath)
#       * DELETE /api/v1/workspace/items/:id         -> ALWAYS HTTP 200,
#         body {success: boolean, captureId} — confirmed via direct source
#         read this route NEVER returns 404, for a wrong-tenant, wrong-
#         owner, OR genuinely nonexistent id alike. `success: false` IS
#         this route's nonexistence signal — internally consistent (all
#         three cases produce the identical {success:false}), just a
#         different HTTP-level shape than GET/action's 404. This script
#         verifies that consistency directly rather than assuming a 404
#         DELETE never actually sends.
#       * GET /api/v1/workspace/items/:id/download|preview -> 200
#         {captureId, downloadUrl|previewUrl} or the same 404 flat shape
#       * GET /api/v1/workspace/inbox  -> {ownerId, unreadCount,
#         needsReviewCount, items: CaptureItem[]} — tenant+owner scoped
#       * GET /api/v1/workspace/vault  -> {ownerId, totalItems,
#         totalSizeBytes, categories, recentItems: CaptureItem[]} —
#         tenant+owner scoped
#   - CaptureItem has carried tenantId+ownerId since its original
#     introduction (confirmed via git history during Preflight) — there is
#     no legacy-backfill concept for Capture at all. This script
#     deliberately contains no backfill/migration test, per the governing
#     directive's own Section 15.
#
# Isolation design: mirrors the Memory Tenant Isolation harness's runtime-
# only /run systemd drop-in pattern exactly — a transient drop-in overrides
# NAGEX_CAPTURES_DIR (CaptureStore's own real, pre-existing env override,
# confirmed via source read — not a new hook) to a throwaway directory, so
# every Capture record this script creates lives in an isolated metadata
# store, never the real production workspace-captures directory.
#
# Storage-object caveat, disclosed honestly: production may be configured
# for either LocalStorageProvider (which also honors a real, pre-existing
# NAGEX_OBJECT_STORAGE_DIR override, also isolated here) or S3StorageProvider
# (which does not — confirmed via source read of
# createConfiguredStorageProvider()). Either way, the download/preview
# scenario below only ever creates ONE new, uniquely-named, synthetic
# object via the real upload API — never touches or reads any existing
# object — and this script's own cleanup deletes it through the real,
# rightful deleteCaptureItem flow regardless of which provider is active.
# The Capture METADATA record itself (the actual subject of this
# correction) is fully isolated either way, since NAGEX_CAPTURES_DIR
# isolation is independent of the storage provider choice.
#
# R1 correction (storage fixture fix, applied on top of the 67c1719 script):
# a real host run at 67c1719 failed only during synthetic upload creation for
# the Download/Preview scenario (`HTTP 502 STORAGE_PROVIDER_ERROR: S3
# putObject failed: fetch failed`) — every other scenario in this script
# passed. Root cause, confirmed via direct read of
# `src/storage/s3-storage.provider.ts`'s own `createConfiguredStorageProvider()`:
# the host has `NAGEX_STORAGE_PROVIDER=s3` (or equivalent full S3 env config)
# active, so this script's isolated run was still attempting a real S3
# `putObject` against a host that could not reach it — an environment/
# fixture defect in this script, not a Capture ownership correction defect
# (the ownership gate itself was never reached). Fix: this script's
# isolation drop-in now ALSO sets the real, existing, documented
# `NAGEX_STORAGE_PROVIDER=local` env var (confirmed via source read — not
# invented; `validateS3ConfigFromEnv()` already treats any non-"s3" value,
# including this override, as "use Local") alongside the existing
# `NAGEX_OBJECT_STORAGE_DIR` override, forcing `LocalStorageProvider` for
# the duration of this isolated run only — a real, production-supported
# provider, never a new hook, changing zero production source, fully
# reverted in cleanup. The real `GET /api/v1/workspace/storage/status`
# route (confirmed via source read to expose only `{provider, configured,
# reachable, bucket, region, ...}` — no credentials) is used both to prove
# the override took effect and to prove the original provider is restored
# after cleanup, without ever touching or printing any S3 secret.
# Additionally, `RIGHTFUL_CAPTURE_DOWNLOAD`/`RIGHTFUL_CAPTURE_PREVIEW` are
# now their own explicit markers checked immediately after the synthetic
# upload succeeds (previously this check lived only inside "Rightful Owner
# Lifecycle", silently skipped whenever CAP_UPLOAD was empty — which is
# exactly what made the 67c1719 host log look self-contradictory:
# RIGHTFUL_CAPTURE_LIFECYCLE could PASS on its other checks alone while the
# real download/preview path was never actually exercised at all).
#
# Failure classification (for interpreting any FAIL this script reports):
#   A. harness defect              — this script's own assertion/logic is wrong
#   B. environment defect          — host/systemd/permissions/network issue
#   C. stale SHA/deploy            — running commit != 46cb25f-or-later
#   D. Capture ownership correction defect — the actual fix is wrong
#   E. unrelated pre-existing regression — a real bug, but not this correction's
#
# Do NOT patch production source from inside this task. Report the exact
# blocker instead.

set -euo pipefail

SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd)"
PROJECT_DIR="${NAGEX_PROJECT_DIR:-$(cd -- "${SCRIPT_DIR}/.." >/dev/null 2>&1 && pwd)}"

COMMON_LIB="${SCRIPT_DIR}/lib/nagex-check-common.sh"
if [ ! -f "$COMMON_LIB" ]; then
  printf "ERROR: Missing library '%s'\n" "$COMMON_LIB" >&2
  exit 2
fi
# shellcheck disable=SC1090
source "$COMMON_LIB"

require_command curl
require_command node
require_command systemctl
require_command sudo

cd "${PROJECT_DIR}"

AUTO_CONFIRM=false
for arg in "$@"; do
  case "$arg" in
    -y|--yes) AUTO_CONFIRM=true; shift ;;
  esac
done

if [ "$AUTO_CONFIRM" = false ]; then
  printf "\n${COLOR_BOLD}This test will perform real, consequential actions:${COLOR_NC}\n\n"
  printf "  - temporarily override NAGEX_CAPTURES_DIR, NAGEX_OBJECT_STORAGE_DIR, and\n"
  printf "    NAGEX_STORAGE_PROVIDER (forced to the existing 'local' provider, for\n"
  printf "    this isolated run only) on the running nagex.service (via a\n"
  printf "    runtime-only /run systemd drop-in, removed in cleanup)\n"
  printf "  - restart nagex.service TWICE (once to enable isolated storage, once\n"
  printf "    mid-scenario as the actual restart-persistence check under test)\n"
  printf "  - restart nagex.service a THIRD time in cleanup to restore normal mode\n"
  printf "  - create a small number of synthetic Capture records (and exactly one\n"
  printf "    small synthetic uploaded object) under the isolated directory only —\n"
  printf "    all deleted via the real, rightful delete flow before this script exits\n\n"
  printf "Continue? [y/N] "
  read -r REPLY
  case "$REPLY" in
    y|Y|yes|YES) ;;
    *) printf "\n[CANCELLED] Capture ownership isolation host acceptance aborted by user.\n\n"; exit 130 ;;
  esac
fi

BASE="${NAGEX_BASE_URL:-http://127.0.0.1:4100}"
SERVICE_NAME="${NAGEX_SERVICE_NAME:-nagex.service}"
DROPIN_DIR="/run/systemd/system/${SERVICE_NAME}.d"
DROPIN_FILE="${DROPIN_DIR}/90-nagex-capture-ownership-isolation-accept.conf"
RUN_ID="$(date +%s)_$$"
ISOLATED_CAPTURES_DIR="/var/lib/nagex/capture-ownership-accept-captures-${RUN_ID}"
ISOLATED_STORAGE_DIR="/var/lib/nagex/capture-ownership-accept-storage-${RUN_ID}"
PROD_CAPTURES_DIR="/var/lib/nagex/workspace-captures"

TENANT_A="ten_capture_accept_a"
TENANT_B="ten_capture_accept_b"
OWNER_A="usr_capture_accept_a"
OWNER_B="usr_capture_accept_b"
MARKER_A="CAPTURE_A_SECRET_${RUN_ID}"
MARKER_B="CAPTURE_B_SECRET_${RUN_ID}"
MARKER_C="CAPTURE_C_SECRET_${RUN_ID}"
MARKER_D="CAPTURE_D_SECRET_${RUN_ID}"

LOG_DIR="$(resolve_log_dir)"
JSON_LOG_FILE="${LOG_DIR}/latest-capture-ownership-isolation-accept.json"
TIMESTAMP="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
COMMIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")"

OVERALL_EXIT=0
declare -A RESULTS
log_result() { RESULTS["$1"]="$2"; }

printf "\n==========================================\n"
printf " NAGEX CAPTURE OWNERSHIP ISOLATION HOST ACCEPTANCE\n"
printf "==========================================\n"
printf "Base URL: %s\n" "$BASE"
printf "Commit:   %s\n" "$COMMIT_SHA"
printf "Run ID:   %s\n" "$RUN_ID"
printf "Time:     %s\n\n" "$TIMESTAMP"

# ── Small local helpers ─────────────────────────────────────────────────

wait_for_health() {
  local max_wait="${1:-90}" waited=0 code
  while [ "$waited" -lt "$max_wait" ]; do
    code="$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/health" 2>/dev/null || echo "000")"
    if [ "$code" = "200" ]; then return 0; fi
    sleep 2
    waited=$((waited + 2))
  done
  return 1
}

service_main_pid() {
  systemctl show -p MainPID --value "$SERVICE_NAME" 2>/dev/null || echo "0"
}

service_env_has_var() {
  local varname="$1" pid
  pid="$(service_main_pid)"
  if [ "$pid" = "0" ] || [ -z "$pid" ]; then return 1; fi
  sudo cat "/proc/${pid}/environ" 2>/dev/null | tr '\0' '\n' | grep -q "^${varname}="
}

# Resolved dynamically (never guessed/hardcoded) so the isolated dirs are
# owned by whichever account nagex.service actually runs as.
service_run_as_user() {
  systemctl show -p User --value "$SERVICE_NAME" 2>/dev/null || echo ""
}

api_call_as() {
  local method="$1" url="$2" payload="$3" tenant="$4" principal="$5"
  local raw
  if [ -n "$payload" ]; then
    raw="$(curl -s -w '\n%{http_code}' -X "$method" -H "Content-Type: application/json" -H "x-nagex-tenant: ${tenant}" -H "x-principal-id: ${principal}" -d "$payload" "$url" 2>/dev/null || printf '\n000')"
  else
    raw="$(curl -s -w '\n%{http_code}' -X "$method" -H "x-nagex-tenant: ${tenant}" -H "x-principal-id: ${principal}" "$url" 2>/dev/null || printf '\n000')"
  fi
  API_CALL_STATUS="$(printf '%s' "$raw" | tail -n1)"
  API_CALL_BODY="$(printf '%s' "$raw" | sed '$d')"
}

create_capture() {
  local tenant="$1" principal="$2" marker="$3"
  local payload
  payload="$(node -e 'console.log(JSON.stringify({type:"TEXT", content: process.argv[1], source:"WEB"}))' "$marker")"
  api_call_as POST "${BASE}/api/v1/workspace/capture" "$payload" "$tenant" "$principal"
  if [ "$API_CALL_STATUS" != "201" ]; then
    fail "create_capture(${marker})" "HTTP $API_CALL_STATUS: $(api_error_summary "$API_CALL_BODY")" >&2
    return 1
  fi
  local id
  id="$(json_get "$API_CALL_BODY" 'data.captureId')"
  if [ -z "$id" ]; then
    fail "create_capture(${marker})" "no captureId in response" >&2
    return 1
  fi
  printf '%s' "$id"
}

body_contains() {
  local body="$1" needle="$2"
  json_get "$body" "JSON.stringify(data).indexOf('${needle}') >= 0"
}

# GET /api/v1/workspace/storage/status carries no identity scoping (it is a
# global provider-health probe) and exposes only {provider, configured,
# reachable, bucket, region, ...} — confirmed via direct source read this
# never includes accessKeyId/secretAccessKey. Used only to prove which
# provider is active before/after isolation, never to touch credentials.
storage_status_provider() {
  local raw
  raw="$(curl -s "${BASE}/api/v1/workspace/storage/status" 2>/dev/null || printf '{}')"
  json_get "$raw" 'data.provider'
}

cleanup() {
  local cleanup_ok=true
  printf "\n${COLOR_BOLD}Cleanup${COLOR_NC}\n"
  printf '%s\n' '------------------------------------------'

  # Delete every synthetic capture created this run through the real,
  # rightful delete flow only (never direct file mutation).
  if [ -n "${CAP_A:-}" ]; then api_call_as DELETE "${BASE}/api/v1/workspace/items/${CAP_A}" "" "$TENANT_A" "$OWNER_A" || true; fi
  if [ -n "${CAP_B:-}" ]; then api_call_as DELETE "${BASE}/api/v1/workspace/items/${CAP_B}" "" "$TENANT_B" "$OWNER_A" || true; fi
  if [ -n "${CAP_C:-}" ]; then api_call_as DELETE "${BASE}/api/v1/workspace/items/${CAP_C}" "" "$TENANT_A" "$OWNER_B" || true; fi
  if [ -n "${CAP_D:-}" ]; then api_call_as DELETE "${BASE}/api/v1/workspace/items/${CAP_D}" "" "$TENANT_A" "$OWNER_A" || true; fi
  if [ -n "${CAP_UPLOAD:-}" ]; then api_call_as DELETE "${BASE}/api/v1/workspace/items/${CAP_UPLOAD}" "" "$TENANT_A" "$OWNER_A" || true; fi

  local markers_gone=true
  api_call_as GET "${BASE}/api/v1/workspace/inbox" "" "$TENANT_A" "$OWNER_A"
  if [ "$(body_contains "$API_CALL_BODY" "$MARKER_A")" = "true" ]; then markers_gone=false; fi
  api_call_as GET "${BASE}/api/v1/workspace/inbox" "" "$TENANT_B" "$OWNER_A"
  if [ "$(body_contains "$API_CALL_BODY" "$MARKER_B")" = "true" ]; then markers_gone=false; fi
  api_call_as GET "${BASE}/api/v1/workspace/inbox" "" "$TENANT_A" "$OWNER_B"
  if [ "$(body_contains "$API_CALL_BODY" "$MARKER_C")" = "true" ]; then markers_gone=false; fi

  if [ "$markers_gone" = true ]; then
    pass "CAPTURE_ACCEPTANCE_CLEANUP" "all synthetic markers confirmed gone from the isolated store"
    log_result "CAPTURE_ACCEPTANCE_CLEANUP" "PASS"
  else
    fail "CAPTURE_ACCEPTANCE_CLEANUP" "at least one synthetic marker still visible after cleanup deletes"
    log_result "CAPTURE_ACCEPTANCE_CLEANUP" "FAIL"
    cleanup_ok=false
  fi

  if [ "$ISOLATION_ACTIVE" = true ]; then
    sudo rm -f "$DROPIN_FILE" 2>/dev/null || cleanup_ok=false
    sudo rmdir "$DROPIN_DIR" 2>/dev/null || true
    if sudo systemctl daemon-reload 2>/dev/null && sudo systemctl restart "$SERVICE_NAME" 2>/dev/null; then
      :
    else
      cleanup_ok=false
    fi
    if wait_for_health; then
      pass "Service restarted (normal mode)"
    else
      fail "Service restarted (normal mode)" "health check did not return within timeout"
      cleanup_ok=false
    fi
    if service_env_has_var "NAGEX_CAPTURES_DIR" || service_env_has_var "NAGEX_OBJECT_STORAGE_DIR" || service_env_has_var "NAGEX_STORAGE_PROVIDER"; then
      fail "Isolated capture/storage overrides absent from service env" "still present"
      cleanup_ok=false
    else
      pass "Isolated capture/storage overrides absent from service env"
    fi

    PROD_STORAGE_PROVIDER_AFTER="$(storage_status_provider)"
    if [ -n "$PROD_STORAGE_PROVIDER_BEFORE" ] && [ "$PROD_STORAGE_PROVIDER_AFTER" = "$PROD_STORAGE_PROVIDER_BEFORE" ]; then
      pass "STORAGE_PROVIDER_RESTORED" "provider back to '$PROD_STORAGE_PROVIDER_AFTER'"
      log_result "STORAGE_PROVIDER_RESTORED" "PASS"
    else
      fail "STORAGE_PROVIDER_RESTORED" "before='$PROD_STORAGE_PROVIDER_BEFORE' after='$PROD_STORAGE_PROVIDER_AFTER'"
      log_result "STORAGE_PROVIDER_RESTORED" "FAIL"
      cleanup_ok=false
    fi
  fi

  sudo rm -rf "$ISOLATED_CAPTURES_DIR" "$ISOLATED_STORAGE_DIR" 2>/dev/null || true

  if [ -n "$PROD_CAPTURES_COUNT_BEFORE" ]; then
    local prod_count_after
    prod_count_after="$(sudo find "$PROD_CAPTURES_DIR" -maxdepth 1 -name '*.json' 2>/dev/null | wc -l | tr -d ' ')"
    if [ "$prod_count_after" = "$PROD_CAPTURES_COUNT_BEFORE" ]; then
      pass "PRODUCTION_CAPTURES_UNTOUCHED" "file count unchanged ($prod_count_after)"
    else
      fail "PRODUCTION_CAPTURES_UNTOUCHED" "before=$PROD_CAPTURES_COUNT_BEFORE after=$prod_count_after"
      cleanup_ok=false
    fi
  fi

  if systemctl is-active --quiet "$SERVICE_NAME"; then
    pass "SERVICE_RESTORED" "$SERVICE_NAME is active"
    log_result "SERVICE_RESTORED" "PASS"
  else
    fail "SERVICE_RESTORED" "$SERVICE_NAME is not active"
    log_result "SERVICE_RESTORED" "FAIL"
    cleanup_ok=false
  fi

  if [ "$cleanup_ok" != true ]; then
    OVERALL_EXIT=1
  fi

  printf "\n==========================================\n"
  printf " SUMMARY\n"
  printf "==========================================\n"
  {
    printf '{\n  "timestamp": "%s",\n  "commit": "%s",\n  "runId": "%s",\n  "results": {\n' "$TIMESTAMP" "$COMMIT_SHA" "$RUN_ID"
    local first=1
    for key in "${!RESULTS[@]}"; do
      if [ "$first" -eq 0 ]; then printf ',\n'; fi
      printf '    "%s": "%s"' "$key" "${RESULTS[$key]}"
      first=0
    done
    printf '\n  }\n}\n'
  } > "$JSON_LOG_FILE"
  printf "JSON log: %s\n\n" "$JSON_LOG_FILE"

  if [ "$OVERALL_EXIT" -eq 0 ]; then
    printf "CAPTURE OWNERSHIP ISOLATION HOST ACCEPTANCE: ${COLOR_GREEN}PASS${COLOR_NC}\n\n"
  else
    printf "CAPTURE OWNERSHIP ISOLATION HOST ACCEPTANCE: ${COLOR_RED}FAIL${COLOR_NC}\n\n"
  fi
  printf "CAPTURE_OWNERSHIP_ISOLATION_ACCEPTANCE_RC=%s\n" "$OVERALL_EXIT"

  exit "$OVERALL_EXIT"
}

ISOLATION_ACTIVE=false
PROD_CAPTURES_COUNT_BEFORE=""
PROD_STORAGE_PROVIDER_BEFORE=""
CAP_A="" ; CAP_B="" ; CAP_C="" ; CAP_D="" ; CAP_UPLOAD=""

trap cleanup EXIT INT TERM

# ── Baseline ──────────────────────────────────────────────────────────────
section "Baseline"
PROD_CAPTURES_COUNT_BEFORE="$(sudo find "$PROD_CAPTURES_DIR" -maxdepth 1 -name '*.json' 2>/dev/null | wc -l | tr -d ' ')"
printf "  Production captures file count before: %s\n" "$PROD_CAPTURES_COUNT_BEFORE"
PROD_STORAGE_PROVIDER_BEFORE="$(storage_status_provider)"
printf "  Production storage provider before: %s\n" "$PROD_STORAGE_PROVIDER_BEFORE"

# ── Scenario: isolated startup ────────────────────────────────────────────
section "Isolated Startup"
SERVICE_USER="$(service_run_as_user)"
sudo mkdir -p "$ISOLATED_CAPTURES_DIR" "$ISOLATED_STORAGE_DIR"
if [ -n "$SERVICE_USER" ]; then
  sudo chown "${SERVICE_USER}" "$ISOLATED_CAPTURES_DIR" "$ISOLATED_STORAGE_DIR"
  pass "Isolated dirs owned by real service account" "$SERVICE_USER (resolved via systemctl show, not guessed)"
else
  pass "Isolated dirs left root-owned" "${SERVICE_NAME} has no User= override, runs as root"
fi

sudo mkdir -p "$DROPIN_DIR"
{
  printf '[Service]\n'
  printf 'Environment=NAGEX_CAPTURES_DIR=%s\n' "$ISOLATED_CAPTURES_DIR"
  printf 'Environment=NAGEX_OBJECT_STORAGE_DIR=%s\n' "$ISOLATED_STORAGE_DIR"
  printf 'Environment=NAGEX_STORAGE_PROVIDER=local\n'
} | sudo tee "$DROPIN_FILE" >/dev/null
ISOLATION_ACTIVE=true
sudo chmod 600 "$DROPIN_FILE"
sudo systemctl daemon-reload
sudo systemctl restart "$SERVICE_NAME"
if ! wait_for_health; then
  fail "Service started under isolated capture storage" "health check did not return within timeout"
  exit 1
fi
pass "Service started under isolated capture storage"

# NAGEX_STORAGE_PROVIDER=local is a real, existing, documented provider
# selector (confirmed via source read of createConfiguredStorageProvider())
# — not an invented env var. Verified here (not assumed) via the real
# storage/status route, which exposes no credentials.
ACTIVE_STORAGE_PROVIDER="$(storage_status_provider)"
if [ "$ACTIVE_STORAGE_PROVIDER" = "local" ]; then
  pass "STORAGE_PROVIDER_OVERRIDE_ACTIVE" "NAGEX_STORAGE_PROVIDER=local honored (provider=local)"
  log_result "STORAGE_PROVIDER_OVERRIDE_ACTIVE" "PASS"
else
  fail "STORAGE_PROVIDER_OVERRIDE_ACTIVE" "expected provider=local, got '$ACTIVE_STORAGE_PROVIDER'"
  log_result "STORAGE_PROVIDER_OVERRIDE_ACTIVE" "FAIL"
  OVERALL_EXIT=1
fi

# ── Scenario 4: rightful capture creation ────────────────────────────────
section "Rightful Capture Creation"
CAP_A="$(create_capture "$TENANT_A" "$OWNER_A" "$MARKER_A")"
CAP_B="$(create_capture "$TENANT_B" "$OWNER_A" "$MARKER_B")"
CAP_C="$(create_capture "$TENANT_A" "$OWNER_B" "$MARKER_C")"
if [ -n "$CAP_A" ] && [ -n "$CAP_B" ] && [ -n "$CAP_C" ]; then
  pass "RIGHTFUL_CAPTURE_CREATE" "A=$CAP_A B=$CAP_B C=$CAP_C"
  log_result "RIGHTFUL_CAPTURE_CREATE" "PASS"
else
  fail "RIGHTFUL_CAPTURE_CREATE" "one or more creates failed"
  log_result "RIGHTFUL_CAPTURE_CREATE" "FAIL"
  OVERALL_EXIT=1
fi

# ── Scenario 5-6: cross-tenant / cross-owner GET ─────────────────────────
section "Cross-Tenant / Cross-Owner GET"
api_call_as GET "${BASE}/api/v1/workspace/items/${CAP_A}" "" "$TENANT_B" "$OWNER_A"
GET_CT_CODE="$(extract_error_code "$API_CALL_BODY")"
if [ "$API_CALL_STATUS" = "404" ] && [ "$GET_CT_CODE" = "ITEM_NOT_FOUND" ] && [ "$(body_contains "$API_CALL_BODY" "$MARKER_A")" = "false" ]; then
  pass "CROSS_TENANT_CAPTURE_GET_BLOCK" "HTTP 404 ITEM_NOT_FOUND, no content leak"
  log_result "CROSS_TENANT_CAPTURE_GET_BLOCK" "PASS"
else
  fail "CROSS_TENANT_CAPTURE_GET_BLOCK" "HTTP $API_CALL_STATUS code=$GET_CT_CODE"
  log_result "CROSS_TENANT_CAPTURE_GET_BLOCK" "FAIL"
  OVERALL_EXIT=1
fi

api_call_as GET "${BASE}/api/v1/workspace/items/${CAP_A}" "" "$TENANT_A" "$OWNER_B"
GET_CO_CODE="$(extract_error_code "$API_CALL_BODY")"
if [ "$API_CALL_STATUS" = "404" ] && [ "$GET_CO_CODE" = "ITEM_NOT_FOUND" ] && [ "$(body_contains "$API_CALL_BODY" "$MARKER_A")" = "false" ]; then
  pass "CROSS_OWNER_CAPTURE_GET_BLOCK" "HTTP 404 ITEM_NOT_FOUND, no content leak"
  log_result "CROSS_OWNER_CAPTURE_GET_BLOCK" "PASS"
else
  fail "CROSS_OWNER_CAPTURE_GET_BLOCK" "HTTP $API_CALL_STATUS code=$GET_CO_CODE"
  log_result "CROSS_OWNER_CAPTURE_GET_BLOCK" "FAIL"
  OVERALL_EXIT=1
fi

# ── Scenario 7: critical actionCapture isolation ─────────────────────────
# Real async processing (this.processor.process()) may leave a fresh TEXT
# capture in CAPTURED/READY/NEEDS_REVIEW/FAILED depending on real AI/model
# availability on this host — never assumed here. The real invariant under
# test is narrower and exact: a blocked action attempt must never change
# whatever status the record was already in, so the actual pre-action
# status is captured first and compared exactly, not matched against a
# guessed allowlist.
section "Critical actionCapture Isolation"
ACTION_BODY='{"action":"ARCHIVED"}'
api_call_as GET "${BASE}/api/v1/workspace/items/${CAP_A}" "" "$TENANT_A" "$OWNER_A"
STATUS_BEFORE_ACTION="$(json_get "$API_CALL_BODY" 'data.status')"

api_call_as POST "${BASE}/api/v1/workspace/items/${CAP_A}/action" "$ACTION_BODY" "$TENANT_B" "$OWNER_A"
ACT_CT_CODE="$(extract_error_code "$API_CALL_BODY")"
if [ "$API_CALL_STATUS" = "404" ] && [ "$ACT_CT_CODE" = "ITEM_NOT_FOUND" ]; then
  pass "CROSS_TENANT_CAPTURE_ACTION_BLOCK" "HTTP 404 ITEM_NOT_FOUND"
  log_result "CROSS_TENANT_CAPTURE_ACTION_BLOCK" "PASS"
else
  fail "CROSS_TENANT_CAPTURE_ACTION_BLOCK" "HTTP $API_CALL_STATUS code=$ACT_CT_CODE"
  log_result "CROSS_TENANT_CAPTURE_ACTION_BLOCK" "FAIL"
  OVERALL_EXIT=1
fi

api_call_as POST "${BASE}/api/v1/workspace/items/${CAP_A}/action" "$ACTION_BODY" "$TENANT_A" "$OWNER_B"
ACT_CO_CODE="$(extract_error_code "$API_CALL_BODY")"
if [ "$API_CALL_STATUS" = "404" ] && [ "$ACT_CO_CODE" = "ITEM_NOT_FOUND" ]; then
  pass "CROSS_OWNER_CAPTURE_ACTION_BLOCK" "HTTP 404 ITEM_NOT_FOUND"
  log_result "CROSS_OWNER_CAPTURE_ACTION_BLOCK" "PASS"
else
  fail "CROSS_OWNER_CAPTURE_ACTION_BLOCK" "HTTP $API_CALL_STATUS code=$ACT_CO_CODE"
  log_result "CROSS_OWNER_CAPTURE_ACTION_BLOCK" "FAIL"
  OVERALL_EXIT=1
fi

api_call_as GET "${BASE}/api/v1/workspace/items/${CAP_A}" "" "$TENANT_A" "$OWNER_A"
STATUS_AFTER_BLOCKED_ACTION="$(json_get "$API_CALL_BODY" 'data.status')"
if [ "$STATUS_AFTER_BLOCKED_ACTION" = "$STATUS_BEFORE_ACTION" ] && [ "$STATUS_AFTER_BLOCKED_ACTION" != "ARCHIVED" ]; then
  pass "BLOCKED_ACTION_NO_MUTATION" "status unchanged ('$STATUS_BEFORE_ACTION') after two blocked attempts"
  log_result "BLOCKED_ACTION_NO_MUTATION" "PASS"
else
  fail "BLOCKED_ACTION_NO_MUTATION" "before='$STATUS_BEFORE_ACTION' after='$STATUS_AFTER_BLOCKED_ACTION'"
  log_result "BLOCKED_ACTION_NO_MUTATION" "FAIL"
  OVERALL_EXIT=1
fi

# ── Scenario 9: delete isolation ─────────────────────────────────────────
# NOTE: DELETE /api/v1/workspace/items/:id ALWAYS returns HTTP 200 with
# {success, captureId} — confirmed via direct source read, this route
# never returns 404 for any id (wrong tenant, wrong owner, or genuinely
# nonexistent alike). success:false IS the nonexistence signal here; this
# is a real, intentional difference from GET/action's 404 shape, not a
# harness bug — verified below against a genuinely nonexistent id too, to
# prove all three cases are identical.
section "Delete Isolation"
api_call_as DELETE "${BASE}/api/v1/workspace/items/${CAP_A}" "" "$TENANT_B" "$OWNER_A"
DELETE_CT_SUCCESS="$(json_get "$API_CALL_BODY" 'data.success')"
api_call_as DELETE "${BASE}/api/v1/workspace/items/cap_does_not_exist_${RUN_ID}" "" "$TENANT_A" "$OWNER_A"
DELETE_NONEXISTENT_SUCCESS="$(json_get "$API_CALL_BODY" 'data.success')"
if [ "$API_CALL_STATUS" = "200" ] && [ "$DELETE_CT_SUCCESS" = "false" ] && [ "$DELETE_CT_SUCCESS" = "$DELETE_NONEXISTENT_SUCCESS" ]; then
  pass "CROSS_TENANT_CAPTURE_DELETE_BLOCK" "HTTP 200 success:false, identical to a nonexistent id"
  log_result "CROSS_TENANT_CAPTURE_DELETE_BLOCK" "PASS"
else
  fail "CROSS_TENANT_CAPTURE_DELETE_BLOCK" "ct_success=$DELETE_CT_SUCCESS nonexistent_success=$DELETE_NONEXISTENT_SUCCESS"
  log_result "CROSS_TENANT_CAPTURE_DELETE_BLOCK" "FAIL"
  OVERALL_EXIT=1
fi

api_call_as DELETE "${BASE}/api/v1/workspace/items/${CAP_A}" "" "$TENANT_A" "$OWNER_B"
DELETE_CO_SUCCESS="$(json_get "$API_CALL_BODY" 'data.success')"
if [ "$API_CALL_STATUS" = "200" ] && [ "$DELETE_CO_SUCCESS" = "false" ]; then
  pass "CROSS_OWNER_CAPTURE_DELETE_BLOCK" "HTTP 200 success:false"
  log_result "CROSS_OWNER_CAPTURE_DELETE_BLOCK" "PASS"
else
  fail "CROSS_OWNER_CAPTURE_DELETE_BLOCK" "HTTP $API_CALL_STATUS success=$DELETE_CO_SUCCESS"
  log_result "CROSS_OWNER_CAPTURE_DELETE_BLOCK" "FAIL"
  OVERALL_EXIT=1
fi

api_call_as GET "${BASE}/api/v1/workspace/items/${CAP_A}" "" "$TENANT_A" "$OWNER_A"
if [ "$API_CALL_STATUS" = "200" ] && [ "$(body_contains "$API_CALL_BODY" "$MARKER_A")" = "true" ]; then
  pass "BLOCKED_DELETE_NO_MUTATION" "Capture A survives both blocked delete attempts"
  log_result "BLOCKED_DELETE_NO_MUTATION" "PASS"
else
  fail "BLOCKED_DELETE_NO_MUTATION" "Capture A did not survive"
  log_result "BLOCKED_DELETE_NO_MUTATION" "FAIL"
  OVERALL_EXIT=1
fi

# ── Scenario 10: inbox isolation ─────────────────────────────────────────
section "Inbox Isolation"
api_call_as GET "${BASE}/api/v1/workspace/inbox" "" "$TENANT_A" "$OWNER_A"
AA_HAS_A="$(body_contains "$API_CALL_BODY" "$MARKER_A")"
AA_HAS_B="$(body_contains "$API_CALL_BODY" "$MARKER_B")"
AA_HAS_C="$(body_contains "$API_CALL_BODY" "$MARKER_C")"
api_call_as GET "${BASE}/api/v1/workspace/inbox" "" "$TENANT_B" "$OWNER_A"
BA_HAS_A="$(body_contains "$API_CALL_BODY" "$MARKER_A")"
BA_HAS_B="$(body_contains "$API_CALL_BODY" "$MARKER_B")"
BA_HAS_C="$(body_contains "$API_CALL_BODY" "$MARKER_C")"
api_call_as GET "${BASE}/api/v1/workspace/inbox" "" "$TENANT_A" "$OWNER_B"
AB_HAS_A="$(body_contains "$API_CALL_BODY" "$MARKER_A")"
AB_HAS_B="$(body_contains "$API_CALL_BODY" "$MARKER_B")"
AB_HAS_C="$(body_contains "$API_CALL_BODY" "$MARKER_C")"

if [ "$AA_HAS_A" = "true" ] && [ "$AA_HAS_B" = "false" ] && [ "$AA_HAS_C" = "false" ] \
  && [ "$BA_HAS_B" = "true" ] && [ "$BA_HAS_A" = "false" ] && [ "$BA_HAS_C" = "false" ] \
  && [ "$AB_HAS_C" = "true" ] && [ "$AB_HAS_A" = "false" ] && [ "$AB_HAS_B" = "false" ]; then
  pass "CAPTURE_INBOX_TENANT_OWNER_ISOLATION" "each identity's inbox contains only its own capture"
  log_result "CAPTURE_INBOX_TENANT_OWNER_ISOLATION" "PASS"
else
  fail "CAPTURE_INBOX_TENANT_OWNER_ISOLATION" "AA($AA_HAS_A,$AA_HAS_B,$AA_HAS_C) BA($BA_HAS_A,$BA_HAS_B,$BA_HAS_C) AB($AB_HAS_A,$AB_HAS_B,$AB_HAS_C)"
  log_result "CAPTURE_INBOX_TENANT_OWNER_ISOLATION" "FAIL"
  OVERALL_EXIT=1
fi

# ── Scenario 11: vault isolation ─────────────────────────────────────────
section "Vault Isolation"
api_call_as GET "${BASE}/api/v1/workspace/vault" "" "$TENANT_A" "$OWNER_A"
VAULT_AA_TOTAL="$(json_get "$API_CALL_BODY" 'data.totalItems')"
VAULT_AA_HAS_A="$(body_contains "$API_CALL_BODY" "$MARKER_A")"
VAULT_AA_HAS_B="$(body_contains "$API_CALL_BODY" "$MARKER_B")"
VAULT_AA_HAS_C="$(body_contains "$API_CALL_BODY" "$MARKER_C")"
api_call_as GET "${BASE}/api/v1/workspace/vault" "" "$TENANT_B" "$OWNER_A"
VAULT_BA_TOTAL="$(json_get "$API_CALL_BODY" 'data.totalItems')"
VAULT_BA_HAS_A="$(body_contains "$API_CALL_BODY" "$MARKER_A")"
api_call_as GET "${BASE}/api/v1/workspace/vault" "" "$TENANT_A" "$OWNER_B"
VAULT_AB_TOTAL="$(json_get "$API_CALL_BODY" 'data.totalItems')"
VAULT_AB_HAS_A="$(body_contains "$API_CALL_BODY" "$MARKER_A")"

if [ "$VAULT_AA_HAS_A" = "true" ] && [ "$VAULT_AA_HAS_B" = "false" ] && [ "$VAULT_AA_HAS_C" = "false" ] \
  && [ "$VAULT_BA_HAS_A" = "false" ] && [ "$VAULT_AB_HAS_A" = "false" ] \
  && [ "$VAULT_AA_TOTAL" = "1" ] && [ "$VAULT_BA_TOTAL" = "1" ] && [ "$VAULT_AB_TOTAL" = "1" ]; then
  pass "CAPTURE_VAULT_TENANT_OWNER_ISOLATION" "recentItems, totalItems all correctly tenant+owner scoped"
  log_result "CAPTURE_VAULT_TENANT_OWNER_ISOLATION" "PASS"
else
  fail "CAPTURE_VAULT_TENANT_OWNER_ISOLATION" "AA(total=$VAULT_AA_TOTAL,a=$VAULT_AA_HAS_A,b=$VAULT_AA_HAS_B,c=$VAULT_AA_HAS_C) BA(total=$VAULT_BA_TOTAL,has_a=$VAULT_BA_HAS_A) AB(total=$VAULT_AB_TOTAL,has_a=$VAULT_AB_HAS_A)"
  log_result "CAPTURE_VAULT_TENANT_OWNER_ISOLATION" "FAIL"
  OVERALL_EXIT=1
fi

# ── Scenario 8: legacy capture route mutation isolation ──────────────────
# Deliberately created and tested here, AFTER the Inbox/Vault isolation
# checks above (which assert an exact totalItems=1 per identity) rather
# than earlier alongside the other mutation checks — creating this fourth
# capture any earlier would have inflated TENANT_A/OWNER_A's own count to
# 2 before those exact-count assertions ran.
section "Legacy Capture Route Mutation Isolation"
CAP_D="$(create_capture "$TENANT_A" "$OWNER_A" "$MARKER_D")"
api_call_as PATCH "${BASE}/api/v1/workspace/capture/${CAP_D}" "$ACTION_BODY" "$TENANT_B" "$OWNER_A"
LEGACY_CODE="$(extract_error_code "$API_CALL_BODY")"
if [ "$API_CALL_STATUS" = "404" ] && [ "$LEGACY_CODE" = "ITEM_NOT_FOUND" ]; then
  pass "CAPTURE_LEGACY_MUTATION_ISOLATION" "HTTP 404 ITEM_NOT_FOUND via the legacy PATCH /capture/:id route"
  log_result "CAPTURE_LEGACY_MUTATION_ISOLATION" "PASS"
else
  fail "CAPTURE_LEGACY_MUTATION_ISOLATION" "HTTP $API_CALL_STATUS code=$LEGACY_CODE"
  log_result "CAPTURE_LEGACY_MUTATION_ISOLATION" "FAIL"
  OVERALL_EXIT=1
fi
api_call_as GET "${BASE}/api/v1/workspace/items/${CAP_D}" "" "$TENANT_A" "$OWNER_A"
D_STATUS_UNCHANGED="$(json_get "$API_CALL_BODY" 'data.status')"
if [ "$D_STATUS_UNCHANGED" != "ARCHIVED" ]; then
  pass "Legacy route blocked attempt caused no mutation" "status still '$D_STATUS_UNCHANGED'"
else
  fail "Legacy route blocked attempt caused no mutation" "status became ARCHIVED"
  OVERALL_EXIT=1
fi

# ── Scenario 12: download / preview isolation ────────────────────────────
# RIGHTFUL_CAPTURE_DOWNLOAD/RIGHTFUL_CAPTURE_PREVIEW are their own explicit
# markers, checked immediately after the synthetic upload succeeds — kept
# separate from "Rightful Owner Lifecycle" below so a PASS there can never
# be read as having exercised this blob-backed path when it did not.
section "Download / Preview Isolation"
UPLOAD_BASE64="$(node -e 'console.log(Buffer.from([0x1a,0x45,0xdf,0xa3,0x99,0x88,0x77,0x66,0x55,0x44,0x33,0x22]).toString("base64"))')"
UPLOAD_BODY="$(node -e 'console.log(JSON.stringify({filename:"memo.webm", mimeType:"audio/webm", type:"AUDIO", source:"WEB", base64: process.argv[1]}))' "$UPLOAD_BASE64")"
api_call_as POST "${BASE}/api/v1/workspace/upload" "$UPLOAD_BODY" "$TENANT_A" "$OWNER_A"
if [ "$API_CALL_STATUS" != "201" ]; then
  fail "synthetic upload for download/preview testing" "HTTP $API_CALL_STATUS $(api_error_summary "$API_CALL_BODY")"
  log_result "RIGHTFUL_CAPTURE_DOWNLOAD" "FAIL"
  log_result "RIGHTFUL_CAPTURE_PREVIEW" "FAIL"
  log_result "CAPTURE_DOWNLOAD_ISOLATION" "FAIL"
  log_result "CAPTURE_PREVIEW_ISOLATION" "FAIL"
  OVERALL_EXIT=1
else
  CAP_UPLOAD="$(json_get "$API_CALL_BODY" 'data.captureId')"

  api_call_as GET "${BASE}/api/v1/workspace/items/${CAP_UPLOAD}/download" "" "$TENANT_A" "$OWNER_A"
  RIGHTFUL_DL_URL="$(json_get "$API_CALL_BODY" 'data.downloadUrl')"
  if [ "$API_CALL_STATUS" = "200" ] && [ -n "$RIGHTFUL_DL_URL" ]; then
    pass "RIGHTFUL_CAPTURE_DOWNLOAD" "rightful owner received a real downloadUrl"
    log_result "RIGHTFUL_CAPTURE_DOWNLOAD" "PASS"
  else
    fail "RIGHTFUL_CAPTURE_DOWNLOAD" "HTTP $API_CALL_STATUS $(api_error_summary "$API_CALL_BODY")"
    log_result "RIGHTFUL_CAPTURE_DOWNLOAD" "FAIL"
    OVERALL_EXIT=1
  fi

  api_call_as GET "${BASE}/api/v1/workspace/items/${CAP_UPLOAD}/preview" "" "$TENANT_A" "$OWNER_A"
  RIGHTFUL_PV_URL="$(json_get "$API_CALL_BODY" 'data.previewUrl')"
  if [ "$API_CALL_STATUS" = "200" ] && [ -n "$RIGHTFUL_PV_URL" ]; then
    pass "RIGHTFUL_CAPTURE_PREVIEW" "rightful owner received a real previewUrl"
    log_result "RIGHTFUL_CAPTURE_PREVIEW" "PASS"
  else
    fail "RIGHTFUL_CAPTURE_PREVIEW" "HTTP $API_CALL_STATUS $(api_error_summary "$API_CALL_BODY")"
    log_result "RIGHTFUL_CAPTURE_PREVIEW" "FAIL"
    OVERALL_EXIT=1
  fi

  api_call_as GET "${BASE}/api/v1/workspace/items/${CAP_UPLOAD}/download" "" "$TENANT_B" "$OWNER_A"
  DL_CT_CODE="$(extract_error_code "$API_CALL_BODY")"
  api_call_as GET "${BASE}/api/v1/workspace/items/${CAP_UPLOAD}/download" "" "$TENANT_A" "$OWNER_B"
  DL_CO_CODE="$(extract_error_code "$API_CALL_BODY")"
  DL_CO_URL="$(json_get "$API_CALL_BODY" 'data.downloadUrl')"
  if [ "$DL_CT_CODE" = "ITEM_NOT_FOUND" ] && [ "$DL_CO_CODE" = "ITEM_NOT_FOUND" ] && [ -z "$DL_CO_URL" ]; then
    pass "CAPTURE_DOWNLOAD_ISOLATION" "both wrong-tenant and wrong-owner blocked, no URL issued"
    log_result "CAPTURE_DOWNLOAD_ISOLATION" "PASS"
  else
    fail "CAPTURE_DOWNLOAD_ISOLATION" "ct_code=$DL_CT_CODE co_code=$DL_CO_CODE url=$DL_CO_URL"
    log_result "CAPTURE_DOWNLOAD_ISOLATION" "FAIL"
    OVERALL_EXIT=1
  fi

  api_call_as GET "${BASE}/api/v1/workspace/items/${CAP_UPLOAD}/preview" "" "$TENANT_B" "$OWNER_A"
  PV_CT_CODE="$(extract_error_code "$API_CALL_BODY")"
  api_call_as GET "${BASE}/api/v1/workspace/items/${CAP_UPLOAD}/preview" "" "$TENANT_A" "$OWNER_B"
  PV_CO_CODE="$(extract_error_code "$API_CALL_BODY")"
  PV_CO_URL="$(json_get "$API_CALL_BODY" 'data.previewUrl')"
  if [ "$PV_CT_CODE" = "ITEM_NOT_FOUND" ] && [ "$PV_CO_CODE" = "ITEM_NOT_FOUND" ] && [ -z "$PV_CO_URL" ]; then
    pass "CAPTURE_PREVIEW_ISOLATION" "both wrong-tenant and wrong-owner blocked, no URL issued"
    log_result "CAPTURE_PREVIEW_ISOLATION" "PASS"
  else
    fail "CAPTURE_PREVIEW_ISOLATION" "ct_code=$PV_CT_CODE co_code=$PV_CO_CODE url=$PV_CO_URL"
    log_result "CAPTURE_PREVIEW_ISOLATION" "FAIL"
    OVERALL_EXIT=1
  fi
fi

# ── Scenario 13: rightful owner lifecycle ────────────────────────────────
# Deliberately covers only create/read/list/action here — download/preview
# are their own separate RIGHTFUL_CAPTURE_DOWNLOAD/RIGHTFUL_CAPTURE_PREVIEW
# markers above, checked at the point the blob-backed object actually
# exists, so this PASS can never be misread as having covered that path.
section "Rightful Owner Lifecycle"
RIGHTFUL_OK=1

api_call_as GET "${BASE}/api/v1/workspace/items/${CAP_A}" "" "$TENANT_A" "$OWNER_A"
[ "$API_CALL_STATUS" = "200" ] || RIGHTFUL_OK=0

api_call_as GET "${BASE}/api/v1/workspace/inbox" "" "$TENANT_A" "$OWNER_A"
[ "$(body_contains "$API_CALL_BODY" "$MARKER_A")" = "true" ] || RIGHTFUL_OK=0

api_call_as POST "${BASE}/api/v1/workspace/items/${CAP_A}/action" "$ACTION_BODY" "$TENANT_A" "$OWNER_A"
[ "$API_CALL_STATUS" = "200" ] && [ "$(json_get "$API_CALL_BODY" 'data.status')" = "ARCHIVED" ] || RIGHTFUL_OK=0

if [ "$RIGHTFUL_OK" = "1" ]; then
  pass "RIGHTFUL_CAPTURE_LIFECYCLE" "create/read/list/action all succeeded for the rightful owner"
  log_result "RIGHTFUL_CAPTURE_LIFECYCLE" "PASS"
else
  fail "RIGHTFUL_CAPTURE_LIFECYCLE" "one or more rightful operations failed"
  log_result "RIGHTFUL_CAPTURE_LIFECYCLE" "FAIL"
  OVERALL_EXIT=1
fi

# ── Scenario 14: restart persistence ─────────────────────────────────────
section "Restart Persistence"
sudo systemctl restart "$SERVICE_NAME"
if ! wait_for_health; then
  fail "Service restarted (still isolated mode)" "health check did not return within timeout"
  log_result "CAPTURE_RESTART_PERSISTENCE" "FAIL"
  log_result "CAPTURE_CROSS_TENANT_ISOLATION_AFTER_RESTART" "FAIL"
  log_result "CAPTURE_CROSS_OWNER_ISOLATION_AFTER_RESTART" "FAIL"
  OVERALL_EXIT=1
else
  api_call_as GET "${BASE}/api/v1/workspace/items/${CAP_A}" "" "$TENANT_A" "$OWNER_A"
  TENANTID_AFTER_RESTART="$(json_get "$API_CALL_BODY" 'data.tenantId')"
  OWNERID_AFTER_RESTART="$(json_get "$API_CALL_BODY" 'data.ownerId')"
  if [ "$API_CALL_STATUS" = "200" ] && [ "$TENANTID_AFTER_RESTART" = "$TENANT_A" ] && [ "$OWNERID_AFTER_RESTART" = "$OWNER_A" ] && [ "$(body_contains "$API_CALL_BODY" "$MARKER_A")" = "true" ]; then
    pass "CAPTURE_RESTART_PERSISTENCE" "rightful owner still sees Capture A, tenantId+ownerId preserved"
    log_result "CAPTURE_RESTART_PERSISTENCE" "PASS"
  else
    fail "CAPTURE_RESTART_PERSISTENCE" "HTTP $API_CALL_STATUS tenantId=$TENANTID_AFTER_RESTART ownerId=$OWNERID_AFTER_RESTART"
    log_result "CAPTURE_RESTART_PERSISTENCE" "FAIL"
    OVERALL_EXIT=1
  fi

  api_call_as GET "${BASE}/api/v1/workspace/items/${CAP_A}" "" "$TENANT_B" "$OWNER_A"
  RESTART_CT_BLOCKED=$([ "$API_CALL_STATUS" = "404" ] && echo 1 || echo 0)
  if [ "$RESTART_CT_BLOCKED" = "1" ]; then
    pass "CAPTURE_CROSS_TENANT_ISOLATION_AFTER_RESTART" "still blocked after restart"
    log_result "CAPTURE_CROSS_TENANT_ISOLATION_AFTER_RESTART" "PASS"
  else
    fail "CAPTURE_CROSS_TENANT_ISOLATION_AFTER_RESTART" "HTTP $API_CALL_STATUS"
    log_result "CAPTURE_CROSS_TENANT_ISOLATION_AFTER_RESTART" "FAIL"
    OVERALL_EXIT=1
  fi

  api_call_as GET "${BASE}/api/v1/workspace/items/${CAP_A}" "" "$TENANT_A" "$OWNER_B"
  RESTART_CO_BLOCKED=$([ "$API_CALL_STATUS" = "404" ] && echo 1 || echo 0)
  if [ "$RESTART_CO_BLOCKED" = "1" ]; then
    pass "CAPTURE_CROSS_OWNER_ISOLATION_AFTER_RESTART" "still blocked after restart"
    log_result "CAPTURE_CROSS_OWNER_ISOLATION_AFTER_RESTART" "PASS"
  else
    fail "CAPTURE_CROSS_OWNER_ISOLATION_AFTER_RESTART" "HTTP $API_CALL_STATUS"
    log_result "CAPTURE_CROSS_OWNER_ISOLATION_AFTER_RESTART" "FAIL"
    OVERALL_EXIT=1
  fi
fi

# Cleanup (rightful delete of every synthetic capture, drop-in removal,
# service restore, production-untouched verification) runs automatically
# via the EXIT trap.

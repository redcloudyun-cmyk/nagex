#!/usr/bin/env bash
#
# NAgex Safe Deployment Check (nagex-check)
# Read-only, safe verification of build, tests, health, OAuth, and capabilities.
#

set -euo pipefail

# Resolve physical script path following symlinks
SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd)"
PROJECT_DIR="${NAGEX_PROJECT_DIR:-$(cd -- "${SCRIPT_DIR}/.." >/dev/null 2>&1 && pwd)}"

# Load common library
COMMON_LIB="${SCRIPT_DIR}/lib/nagex-check-common.sh"
if [ ! -f "$COMMON_LIB" ]; then
  printf "ERROR: Missing library '%s'\n" "$COMMON_LIB" >&2
  exit 2
fi
# shellcheck disable=SC1090
source "$COMMON_LIB"

require_command git
require_command npm
require_command curl
require_command node

cd "${PROJECT_DIR}"

BASE="${NAGEX_BASE_URL:-http://127.0.0.1:4100}"
PUBLIC_BASE="${NAGEX_PUBLIC_URL:-https://nagex-test.agex.site}"
TENANT="${NAGEX_TEST_TENANT:-ten_production_01}"
PRINCIPAL="${NAGEX_TEST_PRINCIPAL:-usr_admin_001}"

LOG_DIR="$(resolve_log_dir)"
JSON_LOG_FILE="${LOG_DIR}/latest-check.json"
RAW_LOG_FILE="${LOG_DIR}/check-$(date +%Y%m%d-%H%M%S).log"

OVERALL_EXIT=0
TIMESTAMP="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
COMMIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")"

# Tracking results dictionary for JSON log
declare -A RESULTS

log_result() {
  local key="$1"
  local val="$2"
  RESULTS["$key"]="$val"
}

printf "\n==========================================\n"
printf " NAGEX SAFE DEPLOYMENT CHECK\n"
printf "==========================================\n"

# ── 1. Repository ──────────────────────────────────────────────────────────
section "Repository"

# Git Working Tree
STATUS_OUT="$(git status --porcelain 2>/dev/null || echo "error")"
if [ -z "$STATUS_OUT" ]; then
  pass "Git working tree" "clean"
  log_result "gitWorkingTree" "PASS"
else
  fail "Git working tree" "dirty changes exist"
  log_result "gitWorkingTree" "FAIL"
  OVERALL_EXIT=1
fi

# HEAD vs origin/main
git fetch origin main >/dev/null 2>&1 || true
LOCAL_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo "none")"
REMOTE_SHA="$(git rev-parse --short origin/main 2>/dev/null || echo "none")"
if [ "$LOCAL_SHA" != "none" ] && [ "$LOCAL_SHA" = "$REMOTE_SHA" ]; then
  pass "HEAD == origin/main" "$LOCAL_SHA"
  log_result "headVsOriginMain" "PASS"
else
  fail "HEAD == origin/main" "local:$LOCAL_SHA remote:$REMOTE_SHA"
  log_result "headVsOriginMain" "FAIL"
  OVERALL_EXIT=1
fi

# TypeScript Build
if npm run build >/dev/null 2>&1; then
  pass "Build" "tsc succeeded"
  log_result "build" "PASS"
else
  fail "Build" "tsc failed"
  log_result "build" "FAIL"
  OVERALL_EXIT=1
fi

# Tests & .tmp_test Check
rm -rf "${PROJECT_DIR}/.tmp_test"
TEST_OUTPUT_FILE="$(mktemp)"
if npm test >"$TEST_OUTPUT_FILE" 2>&1; then
  pass "Tests" "all unit/integration tests passed"
  log_result "tests" "PASS"
else
  fail "Tests" "test suite failed"
  log_result "tests" "FAIL"
  OVERALL_EXIT=1
fi
rm -f "$TEST_OUTPUT_FILE"

TMP_TEST_FOUND="$(find "${PROJECT_DIR}" -maxdepth 3 -type d -name '.tmp_test' -print 2>/dev/null || true)"
if [ -z "$TMP_TEST_FOUND" ]; then
  pass ".tmp_test recreated" "NO"
  log_result "tmpTestRecreated" "PASS"
else
  fail ".tmp_test recreated" "YES (leak detected)"
  log_result "tmpTestRecreated" "FAIL"
  OVERALL_EXIT=1
fi

# ── 2. Service Health ──────────────────────────────────────────────────────
section "Service"

LOCAL_HEALTH_STATUS="$(curl -s -o /dev/null -w "%{http_code}" "${BASE}/health" 2>/dev/null || echo "000")"
if [ "$LOCAL_HEALTH_STATUS" = "200" ]; then
  pass "Local health" "${BASE}/health"
  log_result "localHealth" "PASS"
else
  fail "Local health" "HTTP $LOCAL_HEALTH_STATUS"
  log_result "localHealth" "FAIL"
  OVERALL_EXIT=1
fi

PUBLIC_HEALTH_STATUS="$(curl -s -o /dev/null -w "%{http_code}" "${PUBLIC_BASE}/health" 2>/dev/null || echo "000")"
if [ "$PUBLIC_HEALTH_STATUS" = "200" ]; then
  pass "Public health" "${PUBLIC_BASE}/health"
  log_result "publicHealth" "PASS"
else
  warn "Public health" "HTTP $PUBLIC_HEALTH_STATUS (server may not be deployed publicly yet)"
  log_result "publicHealth" "WARN"
fi

# ── 3. Google OAuth ────────────────────────────────────────────────────────
section "Google"

OAUTH_RESP="$(curl -s -H "x-nagex-tenant: ${TENANT}" -H "x-principal-id: ${PRINCIPAL}" "${BASE}/api/v1/oauth/google/status" 2>/dev/null || echo "{}")"
OAUTH_CONFIGURED="$(json_get "$OAUTH_RESP" 'data.configured')"
OAUTH_CONNECTED="$(json_get "$OAUTH_RESP" 'data.connected')"

if [ "$OAUTH_CONFIGURED" = "true" ]; then
  pass "OAuth configured"
  log_result "oauthConfigured" "PASS"
else
  fail "OAuth configured" "false"
  log_result "oauthConfigured" "FAIL"
  OVERALL_EXIT=1
fi

if [ "$OAUTH_CONNECTED" = "true" ]; then
  pass "OAuth connected"
  log_result "oauthConnected" "PASS"
else
  fail "OAuth connected" "false"
  log_result "oauthConnected" "FAIL"
  OVERALL_EXIT=1
fi

SCOPES_DATA="$(json_get "$OAUTH_RESP" 'JSON.stringify(data.scopes || data.scope || [])')"
if [[ "$SCOPES_DATA" =~ "calendar.events" ]]; then
  pass "Calendar scopes"
  log_result "calendarScopes" "PASS"
else
  warn "Calendar scopes" "not explicitly verified in status payload"
  log_result "calendarScopes" "WARN"
fi

if [[ "$SCOPES_DATA" =~ "gmail.modify" ]]; then
  pass "Gmail scope"
  log_result "gmailScope" "PASS"
else
  warn "Gmail scope" "not explicitly verified in status payload"
  log_result "gmailScope" "WARN"
fi

# ── 4. Capability Broker ───────────────────────────────────────────────────
section "Capability Broker"

CAL_PAYLOAD='{"capabilityId":"google_calendar.free_slots","payload":{"calendarId":"primary","timezone":"Asia/Seoul"}}'
CAL_RESP="$(curl -s -X POST -H "Content-Type: application/json" -H "x-nagex-tenant: ${TENANT}" -H "x-principal-id: ${PRINCIPAL}" -d "$CAL_PAYLOAD" "${BASE}/api/v1/capabilities/execute" 2>/dev/null || echo "{}")"
CAL_STATUS="$(json_get "$CAL_RESP" 'data.status')"

if [ "$CAL_STATUS" = "EXECUTED" ]; then
  pass "Calendar free_slots" "status=EXECUTED"
  log_result "calendarFreeSlots" "PASS"
else
  fail "Calendar free_slots" "status=$CAL_STATUS"
  log_result "calendarFreeSlots" "FAIL"
  OVERALL_EXIT=1
fi

GMAIL_PAYLOAD='{"capabilityId":"gmail.search","payload":{"query":"newer_than:30d"}}'
GMAIL_RESP="$(curl -s -X POST -H "Content-Type: application/json" -H "x-nagex-tenant: ${TENANT}" -H "x-principal-id: ${PRINCIPAL}" -d "$GMAIL_PAYLOAD" "${BASE}/api/v1/capabilities/execute" 2>/dev/null || echo "{}")"
GMAIL_STATUS="$(json_get "$GMAIL_RESP" 'data.status')"

if [ "$GMAIL_STATUS" = "EXECUTED" ]; then
  THREAD_COUNT="$(json_get "$GMAIL_RESP" 'data.result && data.result.threads ? data.result.threads.length : 0')"
  pass "Gmail search" "status=EXECUTED, threads=$THREAD_COUNT"
  log_result "gmailSearch" "PASS"
else
  fail "Gmail search" "status=$GMAIL_STATUS"
  log_result "gmailSearch" "FAIL"
  OVERALL_EXIT=1
fi

# ── 5. Browser ─────────────────────────────────────────────────────────────
section "Browser"

SESSION_ID=""
cleanup_browser_session() {
  if [ -n "$SESSION_ID" ]; then
    curl -s -X POST -H "Content-Type: application/json" -H "x-nagex-tenant: ${TENANT}" -H "x-principal-id: ${PRINCIPAL}" -d "{\"browserSessionId\":\"$SESSION_ID\"}" "${BASE}/api/v1/tools/browser/close" >/dev/null 2>&1 || true
  fi
}
trap cleanup_browser_session EXIT

# Browser Open
OPEN_RESP="$(curl -s -X POST -H "Content-Type: application/json" -H "x-nagex-tenant: ${TENANT}" -H "x-principal-id: ${PRINCIPAL}" "${BASE}/api/v1/browser/sessions" 2>/dev/null || echo "{}")"
SESSION_ID="$(json_get "$OPEN_RESP" 'data.browserSessionId')"

if [ -n "$SESSION_ID" ]; then
  pass "Open" "session=$SESSION_ID"
  log_result "browserOpen" "PASS"
else
  fail "Open" "failed to open browser session"
  log_result "browserOpen" "FAIL"
  OVERALL_EXIT=1
fi

if [ -n "$SESSION_ID" ]; then
  # Browser Navigate (Safe)
  NAV_RESP="$(curl -s -X POST -H "Content-Type: application/json" -H "x-nagex-tenant: ${TENANT}" -H "x-principal-id: ${PRINCIPAL}" -d "{\"browserSessionId\":\"$SESSION_ID\",\"url\":\"https://example.com/\"}" "${BASE}/api/v1/tools/browser/navigate" 2>/dev/null || echo "{}")"
  NAV_URL="$(json_get "$NAV_RESP" 'data.url')"
  if [ -n "$NAV_URL" ]; then
    pass "Navigate" "example.com"
    log_result "browserNavigate" "PASS"
  else
    fail "Navigate" "failed navigation"
    log_result "browserNavigate" "FAIL"
    OVERALL_EXIT=1
  fi

  # Browser Snapshot
  SNAP_RESP="$(curl -s -X POST -H "Content-Type: application/json" -H "x-nagex-tenant: ${TENANT}" -H "x-principal-id: ${PRINCIPAL}" -d "{\"browserSessionId\":\"$SESSION_ID\"}" "${BASE}/api/v1/tools/browser/snapshot" 2>/dev/null || echo "{}")"
  SNAP_TITLE="$(json_get "$SNAP_RESP" 'data.title')"
  if [ -n "$SNAP_TITLE" ]; then
    pass "Snapshot" "title='$SNAP_TITLE'"
    log_result "browserSnapshot" "PASS"
  else
    fail "Snapshot" "snapshot failed"
    log_result "browserSnapshot" "FAIL"
    OVERALL_EXIT=1
  fi

  # Browser Extract
  EXT_RESP="$(curl -s -X POST -H "Content-Type: application/json" -H "x-nagex-tenant: ${TENANT}" -H "x-principal-id: ${PRINCIPAL}" -d "{\"browserSessionId\":\"$SESSION_ID\",\"target\":\"all\"}" "${BASE}/api/v1/tools/browser/extract" 2>/dev/null || echo "{}")"
  EXT_TEXT="$(json_get "$EXT_RESP" 'data.text')"
  if [ -n "$EXT_TEXT" ]; then
    pass "Extract" "extracted content successfully"
    log_result "browserExtract" "PASS"
  else
    fail "Extract" "extraction failed"
    log_result "browserExtract" "FAIL"
    OVERALL_EXIT=1
  fi

  # Browser SSRF Protection
  SSRF_RESP="$(curl -s -X POST -H "Content-Type: application/json" -H "x-nagex-tenant: ${TENANT}" -H "x-principal-id: ${PRINCIPAL}" -d "{\"browserSessionId\":\"$SESSION_ID\",\"url\":\"http://127.0.0.1:4100/\"}" "${BASE}/api/v1/tools/browser/navigate" 2>/dev/null || echo "{}")"
  SSRF_ERR_CODE="$(json_get "$SSRF_RESP" 'data.error ? data.error.code : (data.code || "")')"
  if [ "$SSRF_ERR_CODE" = "BROWSER_UNSAFE_URL" ]; then
    pass "SSRF protection" "blocked 127.0.0.1 with BROWSER_UNSAFE_URL"
    log_result "browserSsrfProtection" "PASS"
  else
    fail "SSRF protection" "expected BROWSER_UNSAFE_URL, got '$SSRF_ERR_CODE'"
    log_result "browserSsrfProtection" "FAIL"
    OVERALL_EXIT=1
  fi

  # Browser Close
  CLOSE_RESP="$(curl -s -X POST -H "Content-Type: application/json" -H "x-nagex-tenant: ${TENANT}" -H "x-principal-id: ${PRINCIPAL}" -d "{\"browserSessionId\":\"$SESSION_ID\"}" "${BASE}/api/v1/tools/browser/close" 2>/dev/null || echo "{}")"
  CLOSE_STATUS="$(json_get "$CLOSE_RESP" 'data.status')"
  if [ "$CLOSE_STATUS" = "SUCCEEDED" ]; then
    pass "Close" "session closed"
    log_result "browserClose" "PASS"
  else
    fail "Close" "close returned '$CLOSE_STATUS'"
    log_result "browserClose" "FAIL"
    OVERALL_EXIT=1
  fi
  SESSION_ID=""
fi

# ── 6. Direct-call Bypass Static Scan ──────────────────────────────────────
section "Architecture"

BYPASS_MATCHES=""
DISALLOWED_DIRS=("src/planning" "src/runtime" "src/tasks" "src/agents" "src/workflows")
for d in "${DISALLOWED_DIRS[@]}"; do
  if [ -d "${PROJECT_DIR}/${d}" ]; then
    M="$(grep -RInE "googleCalendarService|gmailService|browserService|GoogleCalendarService|GmailService|BrowserToolService" "${PROJECT_DIR}/${d}" 2>/dev/null || true)"
    if [ -n "$M" ]; then
      BYPASS_MATCHES="${BYPASS_MATCHES}\n${M}"
    fi
  fi
done

if [ -z "$BYPASS_MATCHES" ]; then
  pass "Direct-call bypass scan" "no direct service bypass in disallowed modules"
  log_result "directCallBypassScan" "PASS"
else
  fail "Direct-call bypass scan" "bypass detected in planning/runtime/tasks/agents/workflows"
  log_result "directCallBypassScan" "FAIL"
  OVERALL_EXIT=1
fi

# ── Result & Output ────────────────────────────────────────────────────────
printf "\n==========================================\n"
if [ "$OVERALL_EXIT" -eq 0 ]; then
  printf " CAPABILITY BROKER FREEZE GATE: ${COLOR_GREEN}PASS${COLOR_NC}\n"
else
  printf " CAPABILITY BROKER FREEZE GATE: ${COLOR_RED}FAIL${COLOR_NC}\n"
fi
printf "==========================================\n\n"

# Output machine-readable JSON log
OVERALL_STR="FAIL"
if [ "$OVERALL_EXIT" -eq 0 ]; then
  OVERALL_STR="PASS"
fi

cat <<EOF >"$JSON_LOG_FILE"
{
  "timestamp": "${TIMESTAMP}",
  "commitSha": "${COMMIT_SHA}",
  "overallResult": "${OVERALL_STR}",
  "checks": {
    "gitWorkingTree": "${RESULTS[gitWorkingTree]:-FAIL}",
    "headVsOriginMain": "${RESULTS[headVsOriginMain]:-FAIL}",
    "build": "${RESULTS[build]:-FAIL}",
    "tests": "${RESULTS[tests]:-FAIL}",
    "tmpTestRecreated": "${RESULTS[tmpTestRecreated]:-FAIL}",
    "localHealth": "${RESULTS[localHealth]:-FAIL}",
    "publicHealth": "${RESULTS[publicHealth]:-WARN}",
    "oauthConfigured": "${RESULTS[oauthConfigured]:-FAIL}",
    "oauthConnected": "${RESULTS[oauthConnected]:-FAIL}",
    "calendarScopes": "${RESULTS[calendarScopes]:-WARN}",
    "gmailScope": "${RESULTS[gmailScope]:-WARN}",
    "calendarFreeSlots": "${RESULTS[calendarFreeSlots]:-FAIL}",
    "gmailSearch": "${RESULTS[gmailSearch]:-FAIL}",
    "browserOpen": "${RESULTS[browserOpen]:-FAIL}",
    "browserNavigate": "${RESULTS[browserNavigate]:-FAIL}",
    "browserSnapshot": "${RESULTS[browserSnapshot]:-FAIL}",
    "browserExtract": "${RESULTS[browserExtract]:-FAIL}",
    "browserSsrfProtection": "${RESULTS[browserSsrfProtection]:-FAIL}",
    "browserClose": "${RESULTS[browserClose]:-FAIL}",
    "directCallBypassScan": "${RESULTS[directCallBypassScan]:-FAIL}"
  }
}
EOF

exit "$OVERALL_EXIT"

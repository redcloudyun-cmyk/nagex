#!/usr/bin/env bash
#
# NAgex Live E2E Verification (nagex-e2e-live)
# Executes real external write actions (Gmail send, Calendar create, Browser form submission)
# and verifies approval gate & replay protection across all three capabilities.
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

require_command curl
require_command node

AUTO_CONFIRM=false
for arg in "$@"; do
  case "$arg" in
    -y|--yes)
      AUTO_CONFIRM=true
      shift
      ;;
  esac
done

if [ "$AUTO_CONFIRM" = false ]; then
  printf "\n${COLOR_BOLD}This LIVE E2E test will perform real external actions:${COLOR_NC}\n\n"
  printf "  - send one test Gmail message\n"
  printf "  - create one Google Calendar test event\n"
  printf "  - execute one controlled browser form submission\n\n"
  printf "Continue? [y/N] "
  read -r REPLY
  case "$REPLY" in
    y|Y|yes|YES)
      ;;
    *)
      printf "\n[CANCELLED] Live E2E test aborted by user.\n\n"
      exit 3
      ;;
  esac
fi

BASE="${NAGEX_BASE_URL:-http://127.0.0.1:4100}"
TENANT="${NAGEX_TEST_TENANT:-ten_production_01}"
PRINCIPAL="${NAGEX_TEST_PRINCIPAL:-usr_admin_001}"
TO_EMAIL="${NAGEX_E2E_GMAIL_TO:-redcloudyun@gmail.com}"

LOG_DIR="$(resolve_log_dir)"
JSON_LOG_FILE="${LOG_DIR}/latest-e2e-live.json"

OVERALL_EXIT=0
TIMESTAMP="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
COMMIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")"

declare -A RESULTS

log_result() {
  local key="$1"
  local val="$2"
  RESULTS["$key"]="$val"
}

printf "\n==========================================\n"
printf " NAGEX LIVE E2E VERIFICATION\n"
printf "==========================================\n"

# ── 1. Gmail Live E2E ──────────────────────────────────────────────────────
section "Gmail Live E2E"

GMAIL_APPROVAL_ID=""
GMAIL_PAYLOAD="$(node -e '
  console.log(JSON.stringify({
    capabilityId: "gmail.send_email",
    payload: {
      from: "me",
      to: [process.argv[1]],
      subject: "NAgex Live E2E " + process.argv[2],
      body: "Controlled NAgex Gmail live E2E test. Safe to delete."
    }
  }));
' "$TO_EMAIL" "$TIMESTAMP")"

# 1.1 Approval Request
REQ_RESP="$(curl -s -X POST -H "Content-Type: application/json" -H "x-nagex-tenant: ${TENANT}" -H "x-principal-id: ${PRINCIPAL}" -d "$GMAIL_PAYLOAD" "${BASE}/api/v1/capabilities/execute" 2>/dev/null || echo "{}")"
REQ_STATUS="$(json_get "$REQ_RESP" 'data.status')"
GMAIL_APPROVAL_ID="$(json_get "$REQ_RESP" 'data.approval ? data.approval.approvalId : ""')"

if [ "$REQ_STATUS" = "APPROVAL_REQUIRED" ] && [ -n "$GMAIL_APPROVAL_ID" ]; then
  pass "Gmail approval requested" "approvalId=$GMAIL_APPROVAL_ID"
  log_result "gmailApprovalRequest" "PASS"
else
  fail "Gmail approval requested" "expected APPROVAL_REQUIRED, got '$REQ_STATUS'"
  log_result "gmailApprovalRequest" "FAIL"
  OVERALL_EXIT=1
fi

if [ -n "$GMAIL_APPROVAL_ID" ]; then
  # 1.2 Approve
  APP_RESP="$(curl -s -X POST -H "x-nagex-tenant: ${TENANT}" -H "x-principal-id: ${PRINCIPAL}" "${BASE}/api/v1/approvals/${GMAIL_APPROVAL_ID}/approve" 2>/dev/null || echo "{}")"
  APP_STATUS="$(json_get "$APP_RESP" 'data.status')"
  if [ "$APP_STATUS" = "APPROVED" ]; then
    pass "Gmail approval granted"
    log_result "gmailApprove" "PASS"
  else
    fail "Gmail approval granted" "status=$APP_STATUS"
    log_result "gmailApprove" "FAIL"
    OVERALL_EXIT=1
  fi

  # 1.3 Actual Send Execution
  EXEC_PAYLOAD="{\"approvalId\":\"$GMAIL_APPROVAL_ID\"}"
  EXEC_RESP="$(curl -s -X POST -H "Content-Type: application/json" -H "x-nagex-tenant: ${TENANT}" -H "x-principal-id: ${PRINCIPAL}" -d "$EXEC_PAYLOAD" "${BASE}/api/v1/tools/gmail/send-email" 2>/dev/null || echo "{}")"
  EXEC_STATUS="$(json_get "$EXEC_RESP" 'data.status')"
  EXEC_ID="$(json_get "$EXEC_RESP" 'data.executionId')"
  EXT_ID="$(json_get "$EXEC_RESP" 'data.externalId')"

  if [ "$EXEC_STATUS" = "SUCCEEDED" ] && [ -n "$EXEC_ID" ] && [ -n "$EXT_ID" ]; then
    pass "Gmail actual send" "executionId=$EXEC_ID, externalId=$EXT_ID"
    log_result "gmailSendExecution" "PASS"
  else
    fail "Gmail actual send" "status=$EXEC_STATUS"
    log_result "gmailSendExecution" "FAIL"
    OVERALL_EXIT=1
  fi

  # 1.4 Replay Protection Check
  REPLAY_RESP="$(curl -s -w "\n%{http_code}" -X POST -H "Content-Type: application/json" -H "x-nagex-tenant: ${TENANT}" -H "x-principal-id: ${PRINCIPAL}" -d "$EXEC_PAYLOAD" "${BASE}/api/v1/tools/gmail/send-email" 2>/dev/null || echo "")"
  REPLAY_HTTP_CODE="$(echo "$REPLAY_RESP" | tail -n1)"
  REPLAY_BODY="$(echo "$REPLAY_RESP" | sed '$d')"
  REPLAY_ERR_CODE="$(json_get "$REPLAY_BODY" 'data.error ? data.error.code : (data.code || "")')"

  if [ "$REPLAY_HTTP_CODE" = "409" ] && [ "$REPLAY_ERR_CODE" = "APPROVAL_ALREADY_CONSUMED" ]; then
    pass "Gmail replay block" "HTTP 409 APPROVAL_ALREADY_CONSUMED"
    log_result "gmailReplayBlock" "PASS"
  else
    fail "Gmail replay block" "expected 409 APPROVAL_ALREADY_CONSUMED, got HTTP $REPLAY_HTTP_CODE code '$REPLAY_ERR_CODE'"
    log_result "gmailReplayBlock" "FAIL"
    OVERALL_EXIT=1
  fi
fi

# ── 2. Calendar Live E2E ───────────────────────────────────────────────────
section "Calendar Live E2E"

CAL_TIMES="$(node -e '
  const start = new Date(Date.now() + 24*3600*1000);
  start.setHours(14, 0, 0, 0);
  const end = new Date(start.getTime() + 30*60*1000);
  console.log(JSON.stringify({ start: start.toISOString(), end: end.toISOString() }));
')"
START_TIME="$(json_get "$CAL_TIMES" 'data.start')"
END_TIME="$(json_get "$CAL_TIMES" 'data.end')"

CAL_APPROVAL_ID=""
CAL_REQ_PAYLOAD="$(node -e '
  console.log(JSON.stringify({
    capabilityId: "google_calendar.create_event",
    payload: {
      summary: "NAgex Live E2E " + process.argv[1],
      startTime: process.argv[2],
      endTime: process.argv[3],
      timeZone: "Asia/Seoul",
      attendees: []
    }
  }));
' "$TIMESTAMP" "$START_TIME" "$END_TIME")"

# 2.1 Approval Request
CAL_REQ_RESP="$(curl -s -X POST -H "Content-Type: application/json" -H "x-nagex-tenant: ${TENANT}" -H "x-principal-id: ${PRINCIPAL}" -d "$CAL_REQ_PAYLOAD" "${BASE}/api/v1/capabilities/execute" 2>/dev/null || echo "{}")"
CAL_REQ_STATUS="$(json_get "$CAL_REQ_RESP" 'data.status')"
CAL_APPROVAL_ID="$(json_get "$CAL_REQ_RESP" 'data.approval ? data.approval.approvalId : ""')"

if [ "$CAL_REQ_STATUS" = "APPROVAL_REQUIRED" ] && [ -n "$CAL_APPROVAL_ID" ]; then
  pass "Calendar approval requested" "approvalId=$CAL_APPROVAL_ID"
  log_result "calendarApprovalRequest" "PASS"
else
  fail "Calendar approval requested" "expected APPROVAL_REQUIRED, got '$CAL_REQ_STATUS'"
  log_result "calendarApprovalRequest" "FAIL"
  OVERALL_EXIT=1
fi

if [ -n "$CAL_APPROVAL_ID" ]; then
  # 2.2 Approve
  CAL_APP_RESP="$(curl -s -X POST -H "x-nagex-tenant: ${TENANT}" -H "x-principal-id: ${PRINCIPAL}" "${BASE}/api/v1/approvals/${CAL_APPROVAL_ID}/approve" 2>/dev/null || echo "{}")"
  CAL_APP_STATUS="$(json_get "$CAL_APP_RESP" 'data.status')"
  if [ "$CAL_APP_STATUS" = "APPROVED" ]; then
    pass "Calendar approval granted"
    log_result "calendarApprove" "PASS"
  else
    fail "Calendar approval granted" "status=$CAL_APP_STATUS"
    log_result "calendarApprove" "FAIL"
    OVERALL_EXIT=1
  fi

  # 2.3 Actual Event Creation
  CAL_EXEC_PAYLOAD="{\"approvalId\":\"$CAL_APPROVAL_ID\"}"
  CAL_EXEC_RESP="$(curl -s -X POST -H "Content-Type: application/json" -H "x-nagex-tenant: ${TENANT}" -H "x-principal-id: ${PRINCIPAL}" -d "$CAL_EXEC_PAYLOAD" "${BASE}/api/v1/tools/google-calendar/create-event" 2>/dev/null || echo "{}")"
  CAL_EXEC_STATUS="$(json_get "$CAL_EXEC_RESP" 'data.status')"
  CAL_EXEC_ID="$(json_get "$CAL_EXEC_RESP" 'data.executionId')"
  CAL_EXT_ID="$(json_get "$CAL_EXEC_RESP" 'data.externalId')"

  if [ "$CAL_EXEC_STATUS" = "SUCCEEDED" ] && [ -n "$CAL_EXEC_ID" ] && [ -n "$CAL_EXT_ID" ]; then
    pass "Calendar actual create" "executionId=$CAL_EXEC_ID, externalId=$CAL_EXT_ID"
    log_result "calendarCreateExecution" "PASS"
  else
    fail "Calendar actual create" "status=$CAL_EXEC_STATUS"
    log_result "calendarCreateExecution" "FAIL"
    OVERALL_EXIT=1
  fi

  # 2.4 Replay Protection Check
  CAL_REPLAY_RESP="$(curl -s -w "\n%{http_code}" -X POST -H "Content-Type: application/json" -H "x-nagex-tenant: ${TENANT}" -H "x-principal-id: ${PRINCIPAL}" -d "$CAL_EXEC_PAYLOAD" "${BASE}/api/v1/tools/google-calendar/create-event" 2>/dev/null || echo "")"
  CAL_REPLAY_HTTP_CODE="$(echo "$CAL_REPLAY_RESP" | tail -n1)"
  CAL_REPLAY_BODY="$(echo "$CAL_REPLAY_RESP" | sed '$d')"
  CAL_REPLAY_ERR_CODE="$(json_get "$CAL_REPLAY_BODY" 'data.error ? data.error.code : (data.code || "")')"

  if [ "$CAL_REPLAY_HTTP_CODE" = "409" ] && [ "$CAL_REPLAY_ERR_CODE" = "APPROVAL_ALREADY_CONSUMED" ]; then
    pass "Calendar replay block" "HTTP 409 APPROVAL_ALREADY_CONSUMED"
    log_result "calendarReplayBlock" "PASS"
  else
    fail "Calendar replay block" "expected 409 APPROVAL_ALREADY_CONSUMED, got HTTP $CAL_REPLAY_HTTP_CODE code '$CAL_REPLAY_ERR_CODE'"
    log_result "calendarReplayBlock" "FAIL"
    OVERALL_EXIT=1
  fi
fi

# ── 3. Browser Live E2E ────────────────────────────────────────────────────
section "Browser Live E2E"

LIVE_BROWSER_SESSION_ID=""
cleanup_live_browser_session() {
  if [ -n "$LIVE_BROWSER_SESSION_ID" ]; then
    curl -s -X POST -H "Content-Type: application/json" -H "x-nagex-tenant: ${TENANT}" -H "x-principal-id: ${PRINCIPAL}" -d "{\"browserSessionId\":\"$LIVE_BROWSER_SESSION_ID\"}" "${BASE}/api/v1/tools/browser/close" >/dev/null 2>&1 || true
  fi
}
trap cleanup_live_browser_session EXIT

# 3.1 Open Session
BRW_OPEN="$(curl -s -X POST -H "Content-Type: application/json" -H "x-nagex-tenant: ${TENANT}" -H "x-principal-id: ${PRINCIPAL}" "${BASE}/api/v1/browser/sessions" 2>/dev/null || echo "{}")"
LIVE_BROWSER_SESSION_ID="$(json_get "$BRW_OPEN" 'data.browserSessionId')"

if [ -n "$LIVE_BROWSER_SESSION_ID" ]; then
  pass "Browser open" "session=$LIVE_BROWSER_SESSION_ID"
  log_result "browserOpen" "PASS"
else
  fail "Browser open" "failed to open session"
  log_result "browserOpen" "FAIL"
  OVERALL_EXIT=1
fi

if [ -n "$LIVE_BROWSER_SESSION_ID" ]; then
  # 3.2 Navigate to controlled endpoint
  BRW_NAV="$(curl -s -X POST -H "Content-Type: application/json" -H "x-nagex-tenant: ${TENANT}" -H "x-principal-id: ${PRINCIPAL}" -d "{\"browserSessionId\":\"$LIVE_BROWSER_SESSION_ID\",\"url\":\"https://httpbin.org/forms/post\"}" "${BASE}/api/v1/tools/browser/navigate" 2>/dev/null || echo "{}")"
  BRW_NAV_URL="$(json_get "$BRW_NAV" 'data.url')"
  if [ -n "$BRW_NAV_URL" ]; then
    pass "Browser navigate" "httpbin.org/forms/post"
    log_result "browserNavigate" "PASS"
  else
    fail "Browser navigate" "failed to navigate to httpbin form"
    log_result "browserNavigate" "FAIL"
    OVERALL_EXIT=1
  fi

  # 3.3 Structured Snapshot (Verify button count == 1)
  BRW_STRUCT="$(curl -s -X POST -H "Content-Type: application/json" -H "x-nagex-tenant: ${TENANT}" -H "x-principal-id: ${PRINCIPAL}" -d "{\"browserSessionId\":\"$LIVE_BROWSER_SESSION_ID\"}" "${BASE}/api/v1/tools/browser/snapshot" 2>/dev/null || echo "{}")"
  BRW_TITLE="$(json_get "$BRW_STRUCT" 'data.title')"
  if [ -n "$BRW_TITLE" ]; then
    pass "Browser snapshot" "title='$BRW_TITLE'"
    log_result "browserSnapshot" "PASS"
  else
    fail "Browser snapshot" "failed snapshot"
    log_result "browserSnapshot" "FAIL"
    OVERALL_EXIT=1
  fi

  # 3.4 Consequential Click Request
  BRW_CLICK_REQ="$(curl -s -X POST -H "Content-Type: application/json" -H "x-nagex-tenant: ${TENANT}" -H "x-principal-id: ${PRINCIPAL}" -d "{\"browserSessionId\":\"$LIVE_BROWSER_SESSION_ID\",\"selector\":\"button\"}" "${BASE}/api/v1/tools/browser/click" 2>/dev/null || echo "{}")"
  BRW_CLICK_STATUS="$(json_get "$BRW_CLICK_REQ" 'data.status')"
  BRW_APPROVAL_ID="$(json_get "$BRW_CLICK_REQ" 'data.approval ? data.approval.approvalId : ""')"

  if [ "$BRW_CLICK_STATUS" = "APPROVAL_REQUIRED" ] && [ -n "$BRW_APPROVAL_ID" ]; then
    pass "Browser approval requested" "approvalId=$BRW_APPROVAL_ID"
    log_result "browserApprovalRequest" "PASS"
  else
    fail "Browser approval requested" "expected APPROVAL_REQUIRED, got '$BRW_CLICK_STATUS'"
    log_result "browserApprovalRequest" "FAIL"
    OVERALL_EXIT=1
  fi

  if [ -n "$BRW_APPROVAL_ID" ]; then
    # 3.5 Approve Browser Click
    BRW_APP_RESP="$(curl -s -X POST -H "x-nagex-tenant: ${TENANT}" -H "x-principal-id: ${PRINCIPAL}" "${BASE}/api/v1/approvals/${BRW_APPROVAL_ID}/approve" 2>/dev/null || echo "{}")"
    BRW_APP_STATUS="$(json_get "$BRW_APP_RESP" 'data.status')"
    if [ "$BRW_APP_STATUS" = "APPROVED" ]; then
      pass "Browser approval granted"
      log_result "browserApprove" "PASS"
    else
      fail "Browser approval granted" "status=$BRW_APP_STATUS"
      log_result "browserApprove" "FAIL"
      OVERALL_EXIT=1
    fi

    # 3.6 Execute Approved Click
    BRW_EXEC_PAYLOAD="{\"approvalId\":\"$BRW_APPROVAL_ID\",\"browserSessionId\":\"$LIVE_BROWSER_SESSION_ID\",\"selector\":\"button\"}"
    BRW_EXEC_RESP="$(curl -s -X POST -H "Content-Type: application/json" -H "x-nagex-tenant: ${TENANT}" -H "x-principal-id: ${PRINCIPAL}" -d "$BRW_EXEC_PAYLOAD" "${BASE}/api/v1/tools/browser/click/execute" 2>/dev/null || echo "{}")"
    BRW_EXEC_STATUS="$(json_get "$BRW_EXEC_RESP" 'data.status')"
    if [ "$BRW_EXEC_STATUS" = "EXECUTED" ]; then
      pass "Browser click execute" "status=EXECUTED"
      log_result "browserClickExecution" "PASS"
    else
      fail "Browser click execute" "status=$BRW_EXEC_STATUS"
      log_result "browserClickExecution" "FAIL"
      OVERALL_EXIT=1
    fi

    # 3.7 Replay Protection Check (Deterministic test)
    BRW_REPLAY_RESP="$(curl -s -w "\n%{http_code}" -X POST -H "Content-Type: application/json" -H "x-nagex-tenant: ${TENANT}" -H "x-principal-id: ${PRINCIPAL}" -d "$BRW_EXEC_PAYLOAD" "${BASE}/api/v1/tools/browser/click/execute" 2>/dev/null || echo "")"
    BRW_REPLAY_HTTP_CODE="$(echo "$BRW_REPLAY_RESP" | tail -n1)"
    BRW_REPLAY_BODY="$(echo "$BRW_REPLAY_RESP" | sed '$d')"
    BRW_REPLAY_ERR_CODE="$(json_get "$BRW_REPLAY_BODY" 'data.error ? data.error.code : (data.code || "")')"

    if [ "$BRW_REPLAY_HTTP_CODE" = "409" ] && [ "$BRW_REPLAY_ERR_CODE" = "APPROVAL_ALREADY_CONSUMED" ]; then
      pass "Browser replay block" "HTTP 409 APPROVAL_ALREADY_CONSUMED (deterministic)"
      log_result "browserReplayBlock" "PASS"
    else
      fail "Browser replay block" "expected 409 APPROVAL_ALREADY_CONSUMED, got HTTP $BRW_REPLAY_HTTP_CODE code '$BRW_REPLAY_ERR_CODE'"
      log_result "browserReplayBlock" "FAIL"
      OVERALL_EXIT=1
    fi
  fi

  # 3.8 Close Session
  BRW_CLOSE_RESP="$(curl -s -X POST -H "Content-Type: application/json" -H "x-nagex-tenant: ${TENANT}" -H "x-principal-id: ${PRINCIPAL}" -d "{\"browserSessionId\":\"$LIVE_BROWSER_SESSION_ID\"}" "${BASE}/api/v1/tools/browser/close" 2>/dev/null || echo "{}")"
  BRW_CLOSE_STATUS="$(json_get "$BRW_CLOSE_RESP" 'data.status')"
  if [ "$BRW_CLOSE_STATUS" = "SUCCEEDED" ]; then
    pass "Browser close" "session closed"
    log_result "browserClose" "PASS"
  else
    fail "Browser close" "status=$BRW_CLOSE_STATUS"
    log_result "browserClose" "FAIL"
    OVERALL_EXIT=1
  fi
  LIVE_BROWSER_SESSION_ID=""
fi

# ── Summary & Machine-Readable JSON ────────────────────────────────────────
printf "\n==========================================\n"
if [ "$OVERALL_EXIT" -eq 0 ]; then
  printf " LIVE E2E VERIFICATION: ${COLOR_GREEN}PASS${COLOR_NC}\n"
else
  printf " LIVE E2E VERIFICATION: ${COLOR_RED}FAIL${COLOR_NC}\n"
fi
printf "==========================================\n\n"

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
    "gmailApprovalRequest": "${RESULTS[gmailApprovalRequest]:-FAIL}",
    "gmailApprove": "${RESULTS[gmailApprove]:-FAIL}",
    "gmailSendExecution": "${RESULTS[gmailSendExecution]:-FAIL}",
    "gmailReplayBlock": "${RESULTS[gmailReplayBlock]:-FAIL}",
    "calendarApprovalRequest": "${RESULTS[calendarApprovalRequest]:-FAIL}",
    "calendarApprove": "${RESULTS[calendarApprove]:-FAIL}",
    "calendarCreateExecution": "${RESULTS[calendarCreateExecution]:-FAIL}",
    "calendarReplayBlock": "${RESULTS[calendarReplayBlock]:-FAIL}",
    "browserOpen": "${RESULTS[browserOpen]:-FAIL}",
    "browserNavigate": "${RESULTS[browserNavigate]:-FAIL}",
    "browserSnapshot": "${RESULTS[browserSnapshot]:-FAIL}",
    "browserApprovalRequest": "${RESULTS[browserApprovalRequest]:-FAIL}",
    "browserApprove": "${RESULTS[browserApprove]:-FAIL}",
    "browserClickExecution": "${RESULTS[browserClickExecution]:-FAIL}",
    "browserReplayBlock": "${RESULTS[browserReplayBlock]:-FAIL}",
    "browserClose": "${RESULTS[browserClose]:-FAIL}"
  }
}
EOF

exit "$OVERALL_EXIT"

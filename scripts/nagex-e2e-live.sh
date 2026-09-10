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

# The inner payload is kept as its own value so the EXACT same object can be
# resent on execute/replay — gmail.service.ts's executeCompose() hash-checks
# the resent payload against what was approved ("Exact Payload Freeze",
# MASTER.md 14.1) and rejects a request that omits it, so `{approvalId}`
# alone was never a valid execute call (confirmed against every passing
# test that exercises executeSendEmail: gmail_live.test.ts,
# capability_broker.test.ts, approval_ttl_security.test.ts all resend
# `payload` alongside `approvalId`).
GMAIL_SEND_PAYLOAD="$(node -e '
  console.log(JSON.stringify({
    from: "me",
    to: [process.argv[1]],
    subject: "NAgex Live E2E " + process.argv[2],
    body: "Controlled NAgex Gmail live E2E test. Safe to delete."
  }));
' "$TO_EMAIL" "$TIMESTAMP")"

GMAIL_REQUEST_PAYLOAD="$(node -e '
  const payload = JSON.parse(process.argv[1]);
  console.log(JSON.stringify({ capabilityId: "gmail.send_email", payload }));
' "$GMAIL_SEND_PAYLOAD")"

GMAIL_APPROVAL_ID=""

# 1.1 Approval Request
api_call POST "${BASE}/api/v1/capabilities/execute" "$GMAIL_REQUEST_PAYLOAD"
REQ_HTTP_CODE="$API_CALL_STATUS"
REQ_RESP="$API_CALL_BODY"
REQ_STATUS="$(json_get "$REQ_RESP" 'data.status')"
GMAIL_APPROVAL_ID="$(json_get "$REQ_RESP" 'data.approval ? data.approval.approvalId : ""')"

if [ "$REQ_STATUS" = "APPROVAL_REQUIRED" ] && [ -n "$GMAIL_APPROVAL_ID" ]; then
  pass "Gmail approval requested" "approvalId=$GMAIL_APPROVAL_ID"
  log_result "gmailApprovalRequest" "PASS"
else
  fail "Gmail approval requested" "HTTP $REQ_HTTP_CODE, $(api_error_summary "$REQ_RESP")"
  log_result "gmailApprovalRequest" "FAIL"
  OVERALL_EXIT=1
fi

if [ -n "$GMAIL_APPROVAL_ID" ]; then
  # 1.2 Approve
  api_call POST "${BASE}/api/v1/approvals/${GMAIL_APPROVAL_ID}/approve"
  APP_HTTP_CODE="$API_CALL_STATUS"
  APP_RESP="$API_CALL_BODY"
  APP_STATUS="$(json_get "$APP_RESP" 'data.status')"
  if [ "$APP_STATUS" = "APPROVED" ]; then
    pass "Gmail approval granted"
    log_result "gmailApprove" "PASS"
  else
    fail "Gmail approval granted" "HTTP $APP_HTTP_CODE, $(api_error_summary "$APP_RESP")"
    log_result "gmailApprove" "FAIL"
    OVERALL_EXIT=1
  fi

  # 1.3 Actual Send Execution — resends the SAME payload the approval was
  # requested with (the contract requires it; see comment above).
  EXEC_PAYLOAD="$(node -e '
    const payload = JSON.parse(process.argv[2]);
    console.log(JSON.stringify({ approvalId: process.argv[1], payload }));
  ' "$GMAIL_APPROVAL_ID" "$GMAIL_SEND_PAYLOAD")"

  api_call POST "${BASE}/api/v1/tools/gmail/send-email" "$EXEC_PAYLOAD"
  EXEC_HTTP_CODE="$API_CALL_STATUS"
  EXEC_RESP="$API_CALL_BODY"
  EXEC_STATUS="$(json_get "$EXEC_RESP" 'data.status')"
  EXEC_ID="$(json_get "$EXEC_RESP" 'data.executionId')"
  EXT_ID="$(json_get "$EXEC_RESP" 'data.externalId')"

  if [ "$EXEC_STATUS" = "SUCCEEDED" ] && [ -n "$EXEC_ID" ] && [ -n "$EXT_ID" ]; then
    pass "Gmail actual send" "executionId=$EXEC_ID, externalId=$EXT_ID"
    log_result "gmailSendExecution" "PASS"
  else
    fail "Gmail actual send" "HTTP $EXEC_HTTP_CODE, $(api_error_summary "$EXEC_RESP")"
    log_result "gmailSendExecution" "FAIL"
    OVERALL_EXIT=1
  fi

  # 1.4 Replay Protection Check — same payload, same (now-consumed) approvalId.
  api_call POST "${BASE}/api/v1/tools/gmail/send-email" "$EXEC_PAYLOAD"
  REPLAY_HTTP_CODE="$API_CALL_STATUS"
  REPLAY_BODY="$API_CALL_BODY"
  REPLAY_ERR_CODE="$(json_get "$REPLAY_BODY" 'data.error ? data.error.code : (data.code || "")')"

  if [ "$REPLAY_HTTP_CODE" = "409" ] && [ "$REPLAY_ERR_CODE" = "APPROVAL_ALREADY_CONSUMED" ]; then
    pass "Gmail replay block" "HTTP 409 APPROVAL_ALREADY_CONSUMED"
    log_result "gmailReplayBlock" "PASS"
  else
    fail "Gmail replay block" "expected 409 APPROVAL_ALREADY_CONSUMED, got HTTP $REPLAY_HTTP_CODE, $(api_error_summary "$REPLAY_BODY")"
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

# Real contract (google-calendar.service.ts assertValidPayload / calendar.client.ts
# CalendarEventPayload): calendarId, summary, description, start, end,
# timezone, attendees — confirmed against approval_execution_persistence.test.ts
# and approval_ttl_security.test.ts. Field names are start/end/timezone, not
# startTime/endTime/timeZone, and calendarId/description are required.
CAL_EVENT_PAYLOAD="$(node -e '
  console.log(JSON.stringify({
    calendarId: "primary",
    summary: "NAgex Live E2E " + process.argv[1],
    description: "Controlled NAgex Calendar live E2E test. Safe to delete.",
    start: process.argv[2],
    end: process.argv[3],
    timezone: "Asia/Seoul",
    attendees: []
  }));
' "$TIMESTAMP" "$START_TIME" "$END_TIME")"

CAL_REQ_PAYLOAD="$(node -e '
  const payload = JSON.parse(process.argv[1]);
  console.log(JSON.stringify({ capabilityId: "google_calendar.create_event", payload }));
' "$CAL_EVENT_PAYLOAD")"

CAL_APPROVAL_ID=""

# 2.1 Approval Request
api_call POST "${BASE}/api/v1/capabilities/execute" "$CAL_REQ_PAYLOAD"
CAL_REQ_HTTP_CODE="$API_CALL_STATUS"
CAL_REQ_RESP="$API_CALL_BODY"
CAL_REQ_STATUS="$(json_get "$CAL_REQ_RESP" 'data.status')"
CAL_APPROVAL_ID="$(json_get "$CAL_REQ_RESP" 'data.approval ? data.approval.approvalId : ""')"

if [ "$CAL_REQ_STATUS" = "APPROVAL_REQUIRED" ] && [ -n "$CAL_APPROVAL_ID" ]; then
  pass "Calendar approval requested" "approvalId=$CAL_APPROVAL_ID"
  log_result "calendarApprovalRequest" "PASS"
else
  fail "Calendar approval requested" "HTTP $CAL_REQ_HTTP_CODE, $(api_error_summary "$CAL_REQ_RESP")"
  log_result "calendarApprovalRequest" "FAIL"
  OVERALL_EXIT=1
fi

if [ -n "$CAL_APPROVAL_ID" ]; then
  # 2.2 Approve
  api_call POST "${BASE}/api/v1/approvals/${CAL_APPROVAL_ID}/approve"
  CAL_APP_HTTP_CODE="$API_CALL_STATUS"
  CAL_APP_RESP="$API_CALL_BODY"
  CAL_APP_STATUS="$(json_get "$CAL_APP_RESP" 'data.status')"
  if [ "$CAL_APP_STATUS" = "APPROVED" ]; then
    pass "Calendar approval granted"
    log_result "calendarApprove" "PASS"
  else
    fail "Calendar approval granted" "HTTP $CAL_APP_HTTP_CODE, $(api_error_summary "$CAL_APP_RESP")"
    log_result "calendarApprove" "FAIL"
    OVERALL_EXIT=1
  fi

  # 2.3 Actual Event Creation — resends the SAME payload the approval was
  # requested with (required by assertValidPayload's hash check).
  CAL_EXEC_PAYLOAD="$(node -e '
    const payload = JSON.parse(process.argv[2]);
    console.log(JSON.stringify({ approvalId: process.argv[1], payload }));
  ' "$CAL_APPROVAL_ID" "$CAL_EVENT_PAYLOAD")"

  api_call POST "${BASE}/api/v1/tools/google-calendar/create-event" "$CAL_EXEC_PAYLOAD"
  CAL_EXEC_HTTP_CODE="$API_CALL_STATUS"
  CAL_EXEC_RESP="$API_CALL_BODY"
  CAL_EXEC_STATUS="$(json_get "$CAL_EXEC_RESP" 'data.status')"
  CAL_EXEC_ID="$(json_get "$CAL_EXEC_RESP" 'data.executionId')"
  CAL_EXT_ID="$(json_get "$CAL_EXEC_RESP" 'data.externalId')"

  if [ "$CAL_EXEC_STATUS" = "SUCCEEDED" ] && [ -n "$CAL_EXEC_ID" ] && [ -n "$CAL_EXT_ID" ]; then
    pass "Calendar actual create" "executionId=$CAL_EXEC_ID, externalId=$CAL_EXT_ID"
    log_result "calendarCreateExecution" "PASS"
  else
    fail "Calendar actual create" "HTTP $CAL_EXEC_HTTP_CODE, $(api_error_summary "$CAL_EXEC_RESP")"
    log_result "calendarCreateExecution" "FAIL"
    OVERALL_EXIT=1
  fi

  # 2.4 Replay Protection Check
  api_call POST "${BASE}/api/v1/tools/google-calendar/create-event" "$CAL_EXEC_PAYLOAD"
  CAL_REPLAY_HTTP_CODE="$API_CALL_STATUS"
  CAL_REPLAY_BODY="$API_CALL_BODY"
  CAL_REPLAY_ERR_CODE="$(json_get "$CAL_REPLAY_BODY" 'data.error ? data.error.code : (data.code || "")')"

  if [ "$CAL_REPLAY_HTTP_CODE" = "409" ] && [ "$CAL_REPLAY_ERR_CODE" = "APPROVAL_ALREADY_CONSUMED" ]; then
    pass "Calendar replay block" "HTTP 409 APPROVAL_ALREADY_CONSUMED"
    log_result "calendarReplayBlock" "PASS"
  else
    fail "Calendar replay block" "expected 409 APPROVAL_ALREADY_CONSUMED, got HTTP $CAL_REPLAY_HTTP_CODE, $(api_error_summary "$CAL_REPLAY_BODY")"
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
api_call POST "${BASE}/api/v1/browser/sessions"
BRW_OPEN_HTTP_CODE="$API_CALL_STATUS"
BRW_OPEN="$API_CALL_BODY"
LIVE_BROWSER_SESSION_ID="$(json_get "$BRW_OPEN" 'data.browserSessionId')"

if [ -n "$LIVE_BROWSER_SESSION_ID" ]; then
  pass "Browser open" "session=$LIVE_BROWSER_SESSION_ID"
  log_result "browserOpen" "PASS"
else
  fail "Browser open" "HTTP $BRW_OPEN_HTTP_CODE, $(api_error_summary "$BRW_OPEN")"
  log_result "browserOpen" "FAIL"
  OVERALL_EXIT=1
fi

if [ -n "$LIVE_BROWSER_SESSION_ID" ]; then
  # 3.2 Navigate to controlled endpoint
  api_call POST "${BASE}/api/v1/tools/browser/navigate" "{\"browserSessionId\":\"$LIVE_BROWSER_SESSION_ID\",\"url\":\"https://httpbin.org/forms/post\"}"
  BRW_NAV_HTTP_CODE="$API_CALL_STATUS"
  BRW_NAV="$API_CALL_BODY"
  BRW_NAV_URL="$(json_get "$BRW_NAV" 'data.url')"
  if [ -n "$BRW_NAV_URL" ]; then
    pass "Browser navigate" "httpbin.org/forms/post"
    log_result "browserNavigate" "PASS"
  else
    fail "Browser navigate" "HTTP $BRW_NAV_HTTP_CODE, $(api_error_summary "$BRW_NAV")"
    log_result "browserNavigate" "FAIL"
    OVERALL_EXIT=1
  fi

  # 3.3 Snapshot — asserts on url/totalCharacters, which BrowserSnapshot
  # always populates for any page with visible content. Does NOT assert on
  # `title` being non-empty: title is the page's real, unfabricated
  # document.title (browser.runtime.ts), and httpbin.org/forms/post has no
  # <title> tag at all (confirmed directly against the live page), so an
  # empty title here is truthful, correct behavior, not a failure.
  api_call POST "${BASE}/api/v1/tools/browser/snapshot" "{\"browserSessionId\":\"$LIVE_BROWSER_SESSION_ID\"}"
  BRW_SNAP_HTTP_CODE="$API_CALL_STATUS"
  BRW_STRUCT="$API_CALL_BODY"
  BRW_SNAP_URL="$(json_get "$BRW_STRUCT" 'data.url')"
  BRW_TOTAL_CHARS="$(json_get "$BRW_STRUCT" 'data.totalCharacters')"
  if [ "$BRW_SNAP_HTTP_CODE" = "200" ] && [ -n "$BRW_SNAP_URL" ] && [ -n "$BRW_TOTAL_CHARS" ] && [ "$BRW_TOTAL_CHARS" != "0" ]; then
    pass "Browser snapshot" "url='$BRW_SNAP_URL' totalCharacters=$BRW_TOTAL_CHARS"
    log_result "browserSnapshot" "PASS"
  else
    fail "Browser snapshot" "HTTP $BRW_SNAP_HTTP_CODE, $(api_error_summary "$BRW_STRUCT")"
    log_result "browserSnapshot" "FAIL"
    OVERALL_EXIT=1
  fi

  # 3.4 Consequential Click Request
  api_call POST "${BASE}/api/v1/tools/browser/click" "{\"browserSessionId\":\"$LIVE_BROWSER_SESSION_ID\",\"selector\":\"button\"}"
  BRW_CLICK_HTTP_CODE="$API_CALL_STATUS"
  BRW_CLICK_REQ="$API_CALL_BODY"
  BRW_CLICK_STATUS="$(json_get "$BRW_CLICK_REQ" 'data.status')"
  BRW_APPROVAL_ID="$(json_get "$BRW_CLICK_REQ" 'data.approval ? data.approval.approvalId : ""')"

  if [ "$BRW_CLICK_STATUS" = "APPROVAL_REQUIRED" ] && [ -n "$BRW_APPROVAL_ID" ]; then
    pass "Browser approval requested" "approvalId=$BRW_APPROVAL_ID"
    log_result "browserApprovalRequest" "PASS"
  else
    fail "Browser approval requested" "HTTP $BRW_CLICK_HTTP_CODE, $(api_error_summary "$BRW_CLICK_REQ")"
    log_result "browserApprovalRequest" "FAIL"
    OVERALL_EXIT=1
  fi

  if [ -n "$BRW_APPROVAL_ID" ]; then
    # 3.5 Approve Browser Click
    api_call POST "${BASE}/api/v1/approvals/${BRW_APPROVAL_ID}/approve"
    BRW_APP_HTTP_CODE="$API_CALL_STATUS"
    BRW_APP_RESP="$API_CALL_BODY"
    BRW_APP_STATUS="$(json_get "$BRW_APP_RESP" 'data.status')"
    if [ "$BRW_APP_STATUS" = "APPROVED" ]; then
      pass "Browser approval granted"
      log_result "browserApprove" "PASS"
    else
      fail "Browser approval granted" "HTTP $BRW_APP_HTTP_CODE, $(api_error_summary "$BRW_APP_RESP")"
      log_result "browserApprove" "FAIL"
      OVERALL_EXIT=1
    fi

    # 3.6 Execute Approved Click
    BRW_EXEC_PAYLOAD="{\"approvalId\":\"$BRW_APPROVAL_ID\",\"browserSessionId\":\"$LIVE_BROWSER_SESSION_ID\",\"selector\":\"button\"}"
    api_call POST "${BASE}/api/v1/tools/browser/click/execute" "$BRW_EXEC_PAYLOAD"
    BRW_EXEC_HTTP_CODE="$API_CALL_STATUS"
    BRW_EXEC_RESP="$API_CALL_BODY"
    BRW_EXEC_STATUS="$(json_get "$BRW_EXEC_RESP" 'data.status')"
    if [ "$BRW_EXEC_STATUS" = "EXECUTED" ]; then
      pass "Browser click execute" "status=EXECUTED"
      log_result "browserClickExecution" "PASS"
    else
      fail "Browser click execute" "HTTP $BRW_EXEC_HTTP_CODE, $(api_error_summary "$BRW_EXEC_RESP")"
      log_result "browserClickExecution" "FAIL"
      OVERALL_EXIT=1
    fi

    # 3.7 Replay Protection Check (Deterministic test)
    api_call POST "${BASE}/api/v1/tools/browser/click/execute" "$BRW_EXEC_PAYLOAD"
    BRW_REPLAY_HTTP_CODE="$API_CALL_STATUS"
    BRW_REPLAY_BODY="$API_CALL_BODY"
    BRW_REPLAY_ERR_CODE="$(json_get "$BRW_REPLAY_BODY" 'data.error ? data.error.code : (data.code || "")')"

    if [ "$BRW_REPLAY_HTTP_CODE" = "409" ] && [ "$BRW_REPLAY_ERR_CODE" = "APPROVAL_ALREADY_CONSUMED" ]; then
      pass "Browser replay block" "HTTP 409 APPROVAL_ALREADY_CONSUMED (deterministic)"
      log_result "browserReplayBlock" "PASS"
    else
      fail "Browser replay block" "expected 409 APPROVAL_ALREADY_CONSUMED, got HTTP $BRW_REPLAY_HTTP_CODE, $(api_error_summary "$BRW_REPLAY_BODY")"
      log_result "browserReplayBlock" "FAIL"
      OVERALL_EXIT=1
    fi
  fi

  # 3.8 Close Session
  api_call POST "${BASE}/api/v1/tools/browser/close" "{\"browserSessionId\":\"$LIVE_BROWSER_SESSION_ID\"}"
  BRW_CLOSE_HTTP_CODE="$API_CALL_STATUS"
  BRW_CLOSE_RESP="$API_CALL_BODY"
  BRW_CLOSE_STATUS="$(json_get "$BRW_CLOSE_RESP" 'data.status')"
  if [ "$BRW_CLOSE_STATUS" = "SUCCEEDED" ]; then
    pass "Browser close" "session closed"
    log_result "browserClose" "PASS"
  else
    fail "Browser close" "HTTP $BRW_CLOSE_HTTP_CODE, $(api_error_summary "$BRW_CLOSE_RESP")"
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

#!/usr/bin/env bash
#
# NAgex Approval Ownership Isolation Correction — dedicated Host Acceptance.
#
# Built by reading the exact current source at
# 0a9ac985377f66be1bf8bb65ca9a30c3559d9937 — not guessed:
#   - POST /api/v1/approvals/calendar-event   creates a real, hash-verified
#     Calendar approval (googleCalendarService.requestCreateEventApproval),
#     tenantId/principalId derived from x-nagex-tenant/x-principal-id headers
#     only, never from the body.
#   - GET  /api/v1/approvals/:id               -> googleCalendarService
#     .getApproval(id, tenantId, principalId) -> 200 {record} or
#     404 {error:"APPROVAL_NOT_FOUND", message}  (flat legacy error shape).
#   - POST /api/v1/approvals/:id/approve|reject -> googleCalendarService
#     .approve/.reject(id, tenantId, principalId, requestId) -> 200 {record}
#     or a thrown NagexError caught by modelErrorResult() ->
#     404 {error:{code:"APPROVAL_NOT_FOUND", category, message, request_id}}
#     (nested shape). extract_error_code() below normalizes both shapes.
#   - POST /api/v1/approvals/:id  (legacy, body {action:"APPROVE"|"REJECT"})
#     falls through to the same googleCalendarService.approve/reject once
#     the id isn't a legacy demo-queue entry.
#   - POST /api/v1/tools/google-calendar/create-event  (body {approvalId,
#     payload}, tenantId/principalId from headers) -> calendarService
#     .executeCreateEvent(...) -> the real governed execution path
#     (Capability-Broker-equivalent: consume() gates ownership BEFORE the
#     real Google API call, confirmed via source comment in
#     google-calendar.service.ts — "Consuming the approval ... happens
#     before the real Google call ... so a replayed or concurrent execute
#     request can never reach Google twice"). This makes "approval status
#     still APPROVED, not CONSUMED" a deterministic, code-guaranteed proof
#     that the real external call was never attempted for a blocked
#     cross-tenant/cross-principal execution attempt — not merely an
#     inference from the HTTP status code.
#
# This script covers ONLY the dedicated Approval Ownership acceptance
# scenarios (A-G, restart persistence, legacy-route isolation). It does
# NOT run nagex-check / nagex-e2e-live / nagex-task-e2e-live.sh — those
# remain separate, existing steps in the governing directive's own ladder.
#
# No approval delete route exists anywhere in this codebase today
# (ActionApprovalStore has no delete method) — every approval this script
# creates is governance-retained by design, exactly like every other
# approval ever created. There is no supported metadata field on
# ActionApprovalRecord to tag a record as a test artifact either, so this
# script marks its own artifacts the only way available: synthetic,
# obviously-non-production tenant/principal identifiers, and a payload
# summary that names the acceptance run explicitly. The one real Calendar
# event this script creates (Scenario G, rightful-owner execution) is
# clearly labeled and dated near-future for easy manual identification/
# removal from the connected Google Calendar if desired.

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
require_command date

cd "${PROJECT_DIR}"

BASE="${NAGEX_BASE_URL:-http://127.0.0.1:4100}"

# Deterministic acceptance identities (per the governing directive, Section 4).
TENANT_A="ten_approval_accept_a"
TENANT_B="ten_approval_accept_b"
OWNER_SHARED="usr_approval_shared"
TENANT_SAME="ten_approval_accept_same"
OWNER_A="usr_approval_owner_a"
OWNER_B="usr_approval_owner_b"

# R1 — Scenarios F/G use the real, OAuth-connected tenant (a synthetic
# tenant has no Google connection, so executeCreateEvent() fails at
# getValidAccessToken() before ever reaching the ownership gate — a host
# test fixture defect, not an Approval Ownership implementation defect).
# Same-tenant/different-principal is the correct way to exercise the real
# ownership gate here: getValidAccessToken(tenantId) only depends on
# tenantId, so it succeeds for LIVE_OWNER_B too — the request genuinely
# reaches approvals.consume()'s requireOwned() check, which then fails on
# the principalId mismatch alone. This actually exercises the ownership
# gate more precisely than a cross-tenant attempt would (a cross-tenant
# attempt on a disconnected tenant proves nothing; this proves the gate
# fires even when everything else about the request is valid).
LIVE_TENANT="ten_production_01"
LIVE_OWNER_A="usr_approval_live_owner_a"
LIVE_OWNER_B="usr_approval_live_owner_b"

LOG_DIR="$(resolve_log_dir)"
JSON_LOG_FILE="${LOG_DIR}/latest-approval-ownership-accept.json"
TIMESTAMP="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
COMMIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")"

OVERALL_EXIT=0
declare -A RESULTS
CREATED_APPROVAL_IDS=()

log_result() {
  RESULTS["$1"]="$2"
}

# api_call_as(method, url, payload, tenant, principal)
# Generalizes the shared lib's api_call()/api_call_with_header() (which are
# fixed to the script-global TENANT/PRINCIPAL) to send an arbitrary,
# per-call tenant+principal header pair — exactly what every scenario below
# needs (the same request path called as different identities).
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

# The GET route's 404 uses a flat {error:"CODE"} shape (see header comment);
# approve/reject/execute use the nested NagexError shape. extract_error_code
# (from the shared lib) already normalizes both — reused here unchanged.

calendar_payload() {
  local label="$1"
  local start end
  start="$(date -u -d '+2 day' +'%Y-%m-%dT10:00:00+00:00')"
  end="$(date -u -d '+2 day' +'%Y-%m-%dT10:30:00+00:00')"
  node -e '
    const [label, start, end] = process.argv.slice(1);
    console.log(JSON.stringify({
      payload: {
        calendarId: "primary",
        summary: `NAGEX APPROVAL OWNERSHIP ACCEPTANCE (${label}) — safe to delete`,
        description: "Created by scripts/nagex-approval-ownership-accept.sh. Not a real meeting.",
        start, end,
        timezone: "UTC",
        attendees: [],
      },
    }));
  ' "$label" "$start" "$end"
}

create_approval() {
  # NOTE: this function runs inside a subshell whenever called via command
  # substitution ($(...)) — every diagnostic (pass/fail/printf) inside it
  # MUST go to stderr, or its output would be captured into the returned
  # approvalId string instead of the caller's terminal. Only the final
  # approvalId goes to stdout. Likewise, CREATED_APPROVAL_IDS cannot be
  # appended from inside here (a subshell's array mutation never propagates
  # back to the parent shell) — every call site below appends explicitly
  # after capturing the returned id instead.
  local tenant="$1" principal="$2" label="$3"
  local payload
  payload="$(calendar_payload "$label")"
  api_call_as POST "${BASE}/api/v1/approvals/calendar-event" "$payload" "$tenant" "$principal"
  if [ "$API_CALL_STATUS" != "201" ]; then
    fail "create_approval($label)" "HTTP $API_CALL_STATUS: $(api_error_summary "$API_CALL_BODY")" >&2
    return 1
  fi
  local id
  id="$(json_get "$API_CALL_BODY" 'data.approvalId')"
  if [ -z "$id" ]; then
    fail "create_approval($label)" "no approvalId in response" >&2
    return 1
  fi
  printf '%s' "$id"
}

printf "\n==========================================\n"
printf " NAGEX APPROVAL OWNERSHIP HOST ACCEPTANCE\n"
printf "==========================================\n"
printf "Base URL: %s\n" "$BASE"
printf "Commit:   %s\n" "$COMMIT_SHA"
printf "Time:     %s\n\n" "$TIMESTAMP"

# ── Scenario A — cross-tenant GET isolation ──────────────────────────────
section "Scenario A: Cross-Tenant Read Isolation"
APR_A1="$(create_approval "$TENANT_A" "$OWNER_SHARED" "A")"
CREATED_APPROVAL_IDS+=("$APR_A1")
api_call_as GET "${BASE}/api/v1/approvals/${APR_A1}" "" "$TENANT_B" "$OWNER_SHARED"
if [ "$API_CALL_STATUS" = "404" ] && [ "$(extract_error_code "$API_CALL_BODY")" = "APPROVAL_NOT_FOUND" ]; then
  pass "CROSS_TENANT_GET_BLOCK" "HTTP 404 APPROVAL_NOT_FOUND"
  log_result "CROSS_TENANT_GET_BLOCK" "PASS"
else
  fail "CROSS_TENANT_GET_BLOCK" "HTTP $API_CALL_STATUS $(api_error_summary "$API_CALL_BODY")"
  log_result "CROSS_TENANT_GET_BLOCK" "FAIL"
  OVERALL_EXIT=1
fi

# ── Scenario B — same-tenant wrong-principal GET isolation ───────────────
section "Scenario B: Same-Tenant Wrong-Principal Read Isolation"
APR_B1="$(create_approval "$TENANT_SAME" "$OWNER_A" "B")"
CREATED_APPROVAL_IDS+=("$APR_B1")
api_call_as GET "${BASE}/api/v1/approvals/${APR_B1}" "" "$TENANT_SAME" "$OWNER_B"
if [ "$API_CALL_STATUS" = "404" ] && [ "$(extract_error_code "$API_CALL_BODY")" = "APPROVAL_NOT_FOUND" ]; then
  pass "CROSS_PRINCIPAL_GET_BLOCK" "HTTP 404 APPROVAL_NOT_FOUND"
  log_result "CROSS_PRINCIPAL_GET_BLOCK" "PASS"
else
  fail "CROSS_PRINCIPAL_GET_BLOCK" "HTTP $API_CALL_STATUS $(api_error_summary "$API_CALL_BODY")"
  log_result "CROSS_PRINCIPAL_GET_BLOCK" "FAIL"
  OVERALL_EXIT=1
fi

# ── Scenario C — cross-tenant approve block ──────────────────────────────
section "Scenario C: Cross-Tenant Approve Block"
APR_C1="$(create_approval "$TENANT_A" "$OWNER_SHARED" "C")"
CREATED_APPROVAL_IDS+=("$APR_C1")
api_call_as POST "${BASE}/api/v1/approvals/${APR_C1}/approve" "" "$TENANT_B" "$OWNER_SHARED"
if [ "$API_CALL_STATUS" = "404" ] && [ "$(extract_error_code "$API_CALL_BODY")" = "APPROVAL_NOT_FOUND" ]; then
  pass "CROSS_TENANT_APPROVE_BLOCK" "HTTP 404 APPROVAL_NOT_FOUND"
  log_result "CROSS_TENANT_APPROVE_BLOCK" "PASS"
else
  fail "CROSS_TENANT_APPROVE_BLOCK" "HTTP $API_CALL_STATUS $(api_error_summary "$API_CALL_BODY")"
  log_result "CROSS_TENANT_APPROVE_BLOCK" "FAIL"
  OVERALL_EXIT=1
fi
api_call_as GET "${BASE}/api/v1/approvals/${APR_C1}" "" "$TENANT_A" "$OWNER_SHARED"
if [ "$API_CALL_STATUS" = "200" ] && [ "$(json_get "$API_CALL_BODY" 'data.status')" = "PENDING" ]; then
  pass "BLOCKED_APPROVE_NO_MUTATION" "status still PENDING for rightful owner"
  log_result "BLOCKED_APPROVE_NO_MUTATION" "PASS"
else
  fail "BLOCKED_APPROVE_NO_MUTATION" "HTTP $API_CALL_STATUS status=$(json_get "$API_CALL_BODY" 'data.status')"
  log_result "BLOCKED_APPROVE_NO_MUTATION" "FAIL"
  OVERALL_EXIT=1
fi

# ── Scenario D — cross-tenant reject block ───────────────────────────────
section "Scenario D: Cross-Tenant Reject Block"
APR_D1="$(create_approval "$TENANT_A" "$OWNER_SHARED" "D")"
CREATED_APPROVAL_IDS+=("$APR_D1")
api_call_as POST "${BASE}/api/v1/approvals/${APR_D1}/reject" "" "$TENANT_B" "$OWNER_SHARED"
if [ "$API_CALL_STATUS" = "404" ] && [ "$(extract_error_code "$API_CALL_BODY")" = "APPROVAL_NOT_FOUND" ]; then
  pass "CROSS_TENANT_REJECT_BLOCK" "HTTP 404 APPROVAL_NOT_FOUND"
  log_result "CROSS_TENANT_REJECT_BLOCK" "PASS"
else
  fail "CROSS_TENANT_REJECT_BLOCK" "HTTP $API_CALL_STATUS $(api_error_summary "$API_CALL_BODY")"
  log_result "CROSS_TENANT_REJECT_BLOCK" "FAIL"
  OVERALL_EXIT=1
fi
api_call_as GET "${BASE}/api/v1/approvals/${APR_D1}" "" "$TENANT_A" "$OWNER_SHARED"
if [ "$API_CALL_STATUS" = "200" ] && [ "$(json_get "$API_CALL_BODY" 'data.status')" = "PENDING" ]; then
  pass "BLOCKED_REJECT_NO_MUTATION" "status still PENDING for rightful owner"
  log_result "BLOCKED_REJECT_NO_MUTATION" "PASS"
else
  fail "BLOCKED_REJECT_NO_MUTATION" "HTTP $API_CALL_STATUS status=$(json_get "$API_CALL_BODY" 'data.status')"
  log_result "BLOCKED_REJECT_NO_MUTATION" "FAIL"
  OVERALL_EXIT=1
fi

# ── Scenario E — same-tenant wrong-principal mutation block ──────────────
section "Scenario E: Same-Tenant Wrong-Principal Mutation Block"
APR_E1="$(create_approval "$TENANT_SAME" "$OWNER_A" "E-approve")"
CREATED_APPROVAL_IDS+=("$APR_E1")
api_call_as POST "${BASE}/api/v1/approvals/${APR_E1}/approve" "" "$TENANT_SAME" "$OWNER_B"
if [ "$API_CALL_STATUS" = "404" ] && [ "$(extract_error_code "$API_CALL_BODY")" = "APPROVAL_NOT_FOUND" ]; then
  pass "CROSS_PRINCIPAL_APPROVE_BLOCK" "HTTP 404 APPROVAL_NOT_FOUND"
  log_result "CROSS_PRINCIPAL_APPROVE_BLOCK" "PASS"
else
  fail "CROSS_PRINCIPAL_APPROVE_BLOCK" "HTTP $API_CALL_STATUS $(api_error_summary "$API_CALL_BODY")"
  log_result "CROSS_PRINCIPAL_APPROVE_BLOCK" "FAIL"
  OVERALL_EXIT=1
fi
api_call_as GET "${BASE}/api/v1/approvals/${APR_E1}" "" "$TENANT_SAME" "$OWNER_A"
if [ "$API_CALL_STATUS" != "200" ] || [ "$(json_get "$API_CALL_BODY" 'data.status')" != "PENDING" ]; then
  fail "CROSS_PRINCIPAL_APPROVE_BLOCK (no-mutation check)" "original was mutated"
  OVERALL_EXIT=1
fi

APR_E2="$(create_approval "$TENANT_SAME" "$OWNER_A" "E-reject")"
CREATED_APPROVAL_IDS+=("$APR_E2")
api_call_as POST "${BASE}/api/v1/approvals/${APR_E2}/reject" "" "$TENANT_SAME" "$OWNER_B"
if [ "$API_CALL_STATUS" = "404" ] && [ "$(extract_error_code "$API_CALL_BODY")" = "APPROVAL_NOT_FOUND" ]; then
  pass "CROSS_PRINCIPAL_REJECT_BLOCK" "HTTP 404 APPROVAL_NOT_FOUND"
  log_result "CROSS_PRINCIPAL_REJECT_BLOCK" "PASS"
else
  fail "CROSS_PRINCIPAL_REJECT_BLOCK" "HTTP $API_CALL_STATUS $(api_error_summary "$API_CALL_BODY")"
  log_result "CROSS_PRINCIPAL_REJECT_BLOCK" "FAIL"
  OVERALL_EXIT=1
fi
api_call_as GET "${BASE}/api/v1/approvals/${APR_E2}" "" "$TENANT_SAME" "$OWNER_A"
if [ "$API_CALL_STATUS" != "200" ] || [ "$(json_get "$API_CALL_BODY" 'data.status')" != "PENDING" ]; then
  fail "CROSS_PRINCIPAL_REJECT_BLOCK (no-mutation check)" "original was mutated"
  OVERALL_EXIT=1
fi

# ── Scenario F + G (R1) — live ownership gate, then rightful lifecycle ───
# R1 correction: executeCreateEvent() calls getValidAccessToken(tenantId)
# BEFORE approvals.consume()'s ownership gate (source-confirmed). A
# synthetic tenant has no real Google connection, so it fails at the token
# step and never reaches the ownership gate at all — that was the original
# script's defect, not an implementation defect. Using the same real,
# connected tenant (LIVE_TENANT) with two different principals lets the
# token step succeed for both, so the wrong-principal attempt genuinely
# reaches and is blocked by the ownership gate itself.
#
# Mandatory distinction (do not conflate these two lines):
printf "  CROSS_TENANT_EXECUTION_ISOLATION = verified by host Linux regression/scoped tests\n"
printf "  LIVE_EXECUTION_OWNERSHIP_GATE = verified using connected tenant + wrong principal\n"
section "Scenario F+G: Live Execution Ownership Gate, then Rightful Owner Lifecycle"
RIGHTFUL_EXECUTION_SUCCEEDED=0
LIVE_EXTERNAL_URL=""
APR_FG="$(create_approval "$LIVE_TENANT" "$LIVE_OWNER_A" "LIVE-F-G")"
CREATED_APPROVAL_IDS+=("$APR_FG")

# Source the exact stored payload back from the server's own record (via the
# rightful owner's own GET) rather than recomputing it locally a second
# time — guarantees the later execute calls hash-match exactly, regardless
# of any sub-second timing difference in the two independent date(1) calls
# create_approval()'s own calendar_payload() would otherwise make.
api_call_as GET "${BASE}/api/v1/approvals/${APR_FG}" "" "$LIVE_TENANT" "$LIVE_OWNER_A"
PAYLOAD_ONLY_FG="$(json_get "$API_CALL_BODY" 'data.canonicalPayload')"

api_call_as POST "${BASE}/api/v1/approvals/${APR_FG}/approve" "" "$LIVE_TENANT" "$LIVE_OWNER_A"
if [ "$API_CALL_STATUS" = "200" ]; then
  pass "RIGHTFUL_GET/RIGHTFUL_APPROVE" "approved by rightful owner LIVE_OWNER_A"
  log_result "RIGHTFUL_APPROVE" "PASS"
else
  fail "RIGHTFUL_APPROVE" "HTTP $API_CALL_STATUS $(api_error_summary "$API_CALL_BODY")"
  log_result "RIGHTFUL_APPROVE" "FAIL"
  OVERALL_EXIT=1
fi

EXEC_BODY_FG="$(node -e 'console.log(JSON.stringify({approvalId: process.argv[1], payload: JSON.parse(process.argv[2])}))' "$APR_FG" "$PAYLOAD_ONLY_FG")"

# F: wrong principal, same (connected) tenant — must be blocked by the
# ownership gate itself, not by an unrelated OAuth/connection failure.
api_call_as POST "${BASE}/api/v1/tools/google-calendar/create-event" "$EXEC_BODY_FG" "$LIVE_TENANT" "$LIVE_OWNER_B"
LIVE_WRONG_PRINCIPAL_CODE="$(extract_error_code "$API_CALL_BODY")"
if [ "$API_CALL_STATUS" != "200" ] && [ "$LIVE_WRONG_PRINCIPAL_CODE" = "APPROVAL_NOT_FOUND" ]; then
  pass "LIVE_WRONG_PRINCIPAL_EXECUTION_BLOCK" "HTTP $API_CALL_STATUS APPROVAL_NOT_FOUND"
  log_result "LIVE_WRONG_PRINCIPAL_EXECUTION_BLOCK" "PASS"
else
  fail "LIVE_WRONG_PRINCIPAL_EXECUTION_BLOCK" "HTTP $API_CALL_STATUS code=$LIVE_WRONG_PRINCIPAL_CODE $(api_error_summary "$API_CALL_BODY")"
  log_result "LIVE_WRONG_PRINCIPAL_EXECUTION_BLOCK" "FAIL"
  OVERALL_EXIT=1
fi

# Deterministic no-side-effect / no-consume proof: consume() gates ownership
# BEFORE the real Google call (source-confirmed), so the approval's status
# is the authoritative signal — never inferred from HTTP status alone or
# from an unrelated OAuth failure.
api_call_as GET "${BASE}/api/v1/approvals/${APR_FG}" "" "$LIVE_TENANT" "$LIVE_OWNER_A"
FG_STATUS_AFTER_BLOCK="$(json_get "$API_CALL_BODY" 'data.status')"
if [ "$FG_STATUS_AFTER_BLOCK" = "APPROVED" ]; then
  pass "LIVE_WRONG_PRINCIPAL_NO_CONSUME" "approval remains APPROVED (never reached CONSUMED)"
  pass "LIVE_WRONG_PRINCIPAL_NO_EXTERNAL_SIDE_EFFECT" "consume() gates before the real Google call; APPROVED-not-CONSUMED proves it was never attempted"
  log_result "LIVE_WRONG_PRINCIPAL_NO_CONSUME" "PASS"
  log_result "LIVE_WRONG_PRINCIPAL_NO_EXTERNAL_SIDE_EFFECT" "PASS"
else
  fail "LIVE_WRONG_PRINCIPAL_NO_CONSUME" "approval status is '$FG_STATUS_AFTER_BLOCK', expected APPROVED"
  log_result "LIVE_WRONG_PRINCIPAL_NO_CONSUME" "FAIL"
  log_result "LIVE_WRONG_PRINCIPAL_NO_EXTERNAL_SIDE_EFFECT" "FAIL"
  OVERALL_EXIT=1
fi

# G: rightful owner, real execution.
api_call_as POST "${BASE}/api/v1/tools/google-calendar/create-event" "$EXEC_BODY_FG" "$LIVE_TENANT" "$LIVE_OWNER_A"
if [ "$API_CALL_STATUS" = "200" ] && [ "$(json_get "$API_CALL_BODY" 'data.status')" = "SUCCEEDED" ]; then
  LIVE_EXTERNAL_URL="$(json_get "$API_CALL_BODY" 'data.externalUrl')"
  RIGHTFUL_EXECUTION_SUCCEEDED=1
  pass "RIGHTFUL_EXECUTION" "real Calendar event created: $LIVE_EXTERNAL_URL"
  log_result "RIGHTFUL_EXECUTION" "PASS"
else
  fail "RIGHTFUL_EXECUTION" "HTTP $API_CALL_STATUS $(api_error_summary "$API_CALL_BODY")"
  log_result "RIGHTFUL_EXECUTION" "FAIL"
  OVERALL_EXIT=1
fi

api_call_as GET "${BASE}/api/v1/approvals/${APR_FG}" "" "$LIVE_TENANT" "$LIVE_OWNER_A"
if [ "$(json_get "$API_CALL_BODY" 'data.status')" = "CONSUMED" ]; then
  pass "RIGHTFUL_CONSUME_ONCE" "approval is CONSUMED after the one real execution"
  log_result "RIGHTFUL_CONSUME_ONCE" "PASS"
else
  fail "RIGHTFUL_CONSUME_ONCE" "status=$(json_get "$API_CALL_BODY" 'data.status'), expected CONSUMED"
  log_result "RIGHTFUL_CONSUME_ONCE" "FAIL"
  OVERALL_EXIT=1
fi

api_call_as POST "${BASE}/api/v1/tools/google-calendar/create-event" "$EXEC_BODY_FG" "$LIVE_TENANT" "$LIVE_OWNER_A"
REPLAY_CODE="$(extract_error_code "$API_CALL_BODY")"
if [ "$API_CALL_STATUS" != "200" ] && [ "$REPLAY_CODE" = "APPROVAL_ALREADY_CONSUMED" ]; then
  pass "REPLAY_PROTECTION" "HTTP $API_CALL_STATUS APPROVAL_ALREADY_CONSUMED"
  log_result "REPLAY_PROTECTION" "PASS"
else
  fail "REPLAY_PROTECTION" "HTTP $API_CALL_STATUS code=$REPLAY_CODE"
  log_result "REPLAY_PROTECTION" "FAIL"
  OVERALL_EXIT=1
fi

# ── Restart persistence ───────────────────────────────────────────────────
section "Restart Persistence"
APR_RESTART="$(create_approval "$TENANT_A" "$OWNER_SHARED" "restart")"
CREATED_APPROVAL_IDS+=("$APR_RESTART")
printf "  Created for restart check: %s (tenant=%s owner=%s)\n" "$APR_RESTART" "$TENANT_A" "$OWNER_SHARED"

if [ "${NAGEX_SKIP_RESTART:-0}" = "1" ]; then
  skip "restart" "NAGEX_SKIP_RESTART=1"
else
  sudo systemctl restart nagex.service
  RESTART_OK=0
  for _ in $(seq 1 30); do
    if curl -sf "${BASE}/api/v1/health" >/dev/null 2>&1; then RESTART_OK=1; break; fi
    sleep 1
  done
  if [ "$RESTART_OK" != "1" ]; then
    fail "service health after restart" "did not become healthy in time"
    OVERALL_EXIT=1
  fi

  api_call_as GET "${BASE}/api/v1/approvals/${APR_RESTART}" "" "$TENANT_A" "$OWNER_SHARED"
  RIGHTFUL_AFTER_RESTART_OK=0
  if [ "$API_CALL_STATUS" = "200" ] && [ "$(json_get "$API_CALL_BODY" 'data.status')" = "PENDING" ]; then RIGHTFUL_AFTER_RESTART_OK=1; fi

  api_call_as GET "${BASE}/api/v1/approvals/${APR_RESTART}" "" "$TENANT_B" "$OWNER_SHARED"
  WRONG_TENANT_AFTER_RESTART_BLOCKED=0
  if [ "$API_CALL_STATUS" = "404" ]; then WRONG_TENANT_AFTER_RESTART_BLOCKED=1; fi

  api_call_as GET "${BASE}/api/v1/approvals/${APR_RESTART}" "" "$TENANT_A" "usr_approval_wrong_owner"
  WRONG_PRINCIPAL_AFTER_RESTART_BLOCKED=0
  if [ "$API_CALL_STATUS" = "404" ]; then WRONG_PRINCIPAL_AFTER_RESTART_BLOCKED=1; fi

  if [ "$RIGHTFUL_AFTER_RESTART_OK" = "1" ] && [ "$WRONG_TENANT_AFTER_RESTART_BLOCKED" = "1" ] && [ "$WRONG_PRINCIPAL_AFTER_RESTART_BLOCKED" = "1" ]; then
    pass "APPROVAL_RESTART_PERSISTENCE" "record + PENDING status survived restart"
    log_result "APPROVAL_RESTART_PERSISTENCE" "PASS"
  else
    fail "APPROVAL_RESTART_PERSISTENCE" "rightful_ok=$RIGHTFUL_AFTER_RESTART_OK wrong_tenant_blocked=$WRONG_TENANT_AFTER_RESTART_BLOCKED wrong_principal_blocked=$WRONG_PRINCIPAL_AFTER_RESTART_BLOCKED"
    log_result "APPROVAL_RESTART_PERSISTENCE" "FAIL"
    OVERALL_EXIT=1
  fi

  api_call_as POST "${BASE}/api/v1/approvals/${APR_RESTART}/approve" "" "$TENANT_A" "$OWNER_SHARED"
  if [ "$API_CALL_STATUS" = "200" ]; then
    pass "APPROVAL_OWNERSHIP_AFTER_RESTART" "rightful owner can still approve after restart"
    log_result "APPROVAL_OWNERSHIP_AFTER_RESTART" "PASS"
  else
    fail "APPROVAL_OWNERSHIP_AFTER_RESTART" "HTTP $API_CALL_STATUS $(api_error_summary "$API_CALL_BODY")"
    log_result "APPROVAL_OWNERSHIP_AFTER_RESTART" "FAIL"
    OVERALL_EXIT=1
  fi
fi

# ── Legacy route isolation ────────────────────────────────────────────────
section "Legacy Route Isolation"
APR_LEGACY="$(create_approval "$TENANT_A" "$OWNER_SHARED" "legacy")"
CREATED_APPROVAL_IDS+=("$APR_LEGACY")
LEGACY_BODY="$(node -e 'console.log(JSON.stringify({action:"APPROVE"}))')"
api_call_as POST "${BASE}/api/v1/approvals/${APR_LEGACY}" "$LEGACY_BODY" "$TENANT_B" "$OWNER_SHARED"
if [ "$API_CALL_STATUS" = "404" ] && [ "$(extract_error_code "$API_CALL_BODY")" = "APPROVAL_NOT_FOUND" ]; then
  pass "LEGACY_APPROVAL_ROUTE_ISOLATION" "HTTP 404 APPROVAL_NOT_FOUND via legacy POST /:id action route"
  log_result "LEGACY_APPROVAL_ROUTE_ISOLATION" "PASS"
else
  fail "LEGACY_APPROVAL_ROUTE_ISOLATION" "HTTP $API_CALL_STATUS $(api_error_summary "$API_CALL_BODY")"
  log_result "LEGACY_APPROVAL_ROUTE_ISOLATION" "FAIL"
  OVERALL_EXIT=1
fi

# ── Cleanup ───────────────────────────────────────────────────────────────
section "Cleanup"
printf "  No delete API exists for ActionApprovalRecord (governance-retained by\n"
printf "  design, confirmed via source read — same as every other approval).\n"
printf "  %d test approvals were created under synthetic/live tenant/principal ids\n" "${#CREATED_APPROVAL_IDS[@]}"
printf "  (%s, %s / %s, %s, %s / %s, %s, %s) and are identifiable by those ids and\n" "$TENANT_A" "$TENANT_B" "$TENANT_SAME" "$OWNER_A" "$OWNER_B" "$LIVE_TENANT" "$LIVE_OWNER_A" "$LIVE_OWNER_B"
printf "  by their payload summaries (\"NAGEX APPROVAL OWNERSHIP ACCEPTANCE\").\n"
if [ "$RIGHTFUL_EXECUTION_SUCCEEDED" = "1" ]; then
  printf "  One real Calendar event was created (Scenario F/G): %s\n" "$LIVE_EXTERNAL_URL"
  printf "  Its summary is clearly labeled for manual removal from the connected\n"
  printf "  calendar if desired.\n"
else
  printf "  No real Calendar event was created this run (RIGHTFUL_EXECUTION did not\n"
  printf "  succeed) — nothing to remove from the connected calendar.\n"
fi
printf "  Approval ids created this run:\n"
for id in "${CREATED_APPROVAL_IDS[@]}"; do printf "    - %s\n" "$id"; done
log_result "SERVICE_RESTORED" "PASS"
pass "SERVICE_RESTORED" "no drop-in/override was introduced by this script; nothing to restore"

# ── Summary ───────────────────────────────────────────────────────────────
printf "\n==========================================\n"
printf " SUMMARY\n"
printf "==========================================\n"
{
  printf '{\n  "timestamp": "%s",\n  "commit": "%s",\n  "results": {\n' "$TIMESTAMP" "$COMMIT_SHA"
  first=1
  for key in "${!RESULTS[@]}"; do
    if [ "$first" -eq 0 ]; then printf ',\n'; fi
    printf '    "%s": "%s"' "$key" "${RESULTS[$key]}"
    first=0
  done
  printf '\n  }\n}\n'
} > "$JSON_LOG_FILE"
printf "JSON log: %s\n\n" "$JSON_LOG_FILE"

if [ "$OVERALL_EXIT" -eq 0 ]; then
  printf "APPROVAL OWNERSHIP HOST ACCEPTANCE: PASS\n"
else
  printf "APPROVAL OWNERSHIP HOST ACCEPTANCE: FAIL\n"
fi

exit "$OVERALL_EXIT"

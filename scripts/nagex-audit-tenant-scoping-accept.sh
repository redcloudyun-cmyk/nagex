#!/usr/bin/env bash
#
# NAgex Audit Route Tenant Scoping Correction — dedicated Host Acceptance.
#
# Built by reading the exact current source at 5ad4218d5c4fd1e5f426bd9901cba806a265bd97
# — not guessed:
#   - AuditLogger (src/governance/audit.logger.ts) is a SINGLE shared
#     singleton (constructed once in create-nagex-application.ts, threaded
#     unchanged to every producer) and is 100% in-memory — no
#     FileRecordStore, no env var, no disk backing of any kind. This is a
#     real, pre-existing, out-of-scope characteristic (see Section 11
#     below), not something this script or the correction it verifies
#     changes.
#   - getAuditLogs(tenantId, limit?): omitting limit returns the tenant's
#     entire unbounded history in original insertion order (backward
#     compatible with 5 pre-existing one-arg callers); a supplied limit
#     filters by tenant FIRST, then slice(-limit).reverse() — newest-first,
#     computed only within that tenant's own already-filtered set.
#   - GET /api/v1/audit/logs -> auditLogger.getAuditLogs(tenantId, 20),
#     tenantId resolved from x-nagex-tenant (default 'ten_production_01')
#     exactly like every other route in server_web.ts's handleApiRequest().
#     Response: {logs:[...AuditEventRecord], total:<tenant-scoped count>}.
#   - This script never writes audit records directly. It emits real audit
#     events via POST /api/v1/oauth/google/disconnect, confirmed via direct
#     source read to be the safest available real, harmless, deterministic
#     audit-emitting action:
#       * it calls googleTokenStore.revoke(tid, fetch, requestId) — for a
#         synthetic tenant that was never connected, revoke()'s own body
#         finds no stored token and therefore never calls the real Google
#         revoke endpoint (no network call at all is made);
#       * InMemoryGoogleOAuthTokenStore.clear() is a plain Map.delete plus
#         a persistence hook, and never throws for an absent key;
#       * it unconditionally logs a real, distinguishable audit event
#         (action "oauth:google_disconnected", resource
#         {type:"OAuthConnection", id:"google_calendar"}) with tenant_id
#         and request_id taken directly from the caller's own headers —
#         letting this script mark every emitted event deterministically
#         via a caller-chosen X-Request-Id, with zero real side effects on
#         any host, connected or not, confirmed by the exact same route
#         already used safely by tests/google_calendar_live.test.ts and
#         this correction's own tests/audit_tenant_isolation.test.ts.
#   - Every emitted event via this one action shares the identical
#     `action` + `resource.type` + `resource.id` regardless of tenant —
#     which means the ordinary Scenario 6/7 (tenant A vs B isolation)
#     calls already ARE a same-action/same-resource, different-tenant
#     pair by construction; Scenario 8 below reuses that same fact
#     explicitly rather than inventing a second action type.
#
# This script is test-harness only. It does not modify src/. It does not
# write audit files directly, add an audit delete API, or add retention
# logic. No isolated storage/env override is needed anywhere in this
# script — AuditLogger has no such override to isolate in the first place.
#
# Failure classification (for interpreting any FAIL this script reports):
#   A. harness defect              — this script's own assertion/logic is wrong
#   B. environment defect          — host/systemd/network issue
#   C. stale SHA/deploy            — running commit != 5ad4218-or-later
#   D. audit correction defect     — the actual tenant-scoping fix is wrong
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
  printf "  - call POST /api/v1/oauth/google/disconnect ~55 times under synthetic,\n"
  printf "    never-connected tenant ids — each is a harmless no-op revoke\n"
  printf "    (no real Google API call is made for an unconnected tenant) that\n"
  printf "    emits one real, tenant-scoped audit event\n"
  printf "  - restart nagex.service ONCE, mid-scenario, to prove isolation still\n"
  printf "    holds for freshly emitted post-restart events\n"
  printf "  - no production Memory/Task/Approval data is touched; AuditLogger\n"
  printf "    itself is in-memory only, so nothing written here persists beyond\n"
  printf "    this run\n\n"
  printf "Continue? [y/N] "
  read -r REPLY
  case "$REPLY" in
    y|Y|yes|YES) ;;
    *) printf "\n[CANCELLED] Audit tenant scoping host acceptance aborted by user.\n\n"; exit 130 ;;
  esac
fi

BASE="${NAGEX_BASE_URL:-http://127.0.0.1:4100}"
SERVICE_NAME="${NAGEX_SERVICE_NAME:-nagex.service}"

TENANT_A="ten_audit_accept_a"
TENANT_B="ten_audit_accept_b"
OWNER_A="usr_audit_owner_a"
OWNER_B="usr_audit_owner_b"
TENANT_EMPTY="ten_audit_accept_empty"

LOG_DIR="$(resolve_log_dir)"
JSON_LOG_FILE="${LOG_DIR}/latest-audit-tenant-scoping-accept.json"
TIMESTAMP="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
COMMIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")"

OVERALL_EXIT=0
declare -A RESULTS
log_result() { RESULTS["$1"]="$2"; }

printf "\n==========================================\n"
printf " NAGEX AUDIT TENANT SCOPING HOST ACCEPTANCE\n"
printf "==========================================\n"
printf "Base URL: %s\n" "$BASE"
printf "Commit:   %s\n" "$COMMIT_SHA"
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

# emit_audit(tenant, principal, requestId) -> emits one real
# oauth:google_disconnected audit event, deterministically marked by the
# given requestId. Confirmed side-effect-free for a never-connected tenant
# (see header comment).
emit_audit() {
  local tenant="$1" principal="$2" request_id="$3"
  local status
  status="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "x-nagex-tenant: ${tenant}" -H "x-principal-id: ${principal}" -H "x-request-id: ${request_id}" "${BASE}/api/v1/oauth/google/disconnect")"
  if [ "$status" != "200" ]; then
    fail "emit_audit(${request_id})" "HTTP $status" >&2
    return 1
  fi
}

# read_audit_as(tenant, principal) -> sets API_CALL_STATUS/API_CALL_BODY.
read_audit_as() {
  local tenant="$1" principal="$2"
  local raw
  raw="$(curl -s -w '\n%{http_code}' -H "x-nagex-tenant: ${tenant}" -H "x-principal-id: ${principal}" "${BASE}/api/v1/audit/logs" 2>/dev/null || printf '\n000')"
  API_CALL_STATUS="$(printf '%s' "$raw" | tail -n1)"
  API_CALL_BODY="$(printf '%s' "$raw" | sed '$d')"
}

# log_contains(body, requestId) -> "true"/"false"
log_contains() {
  local body="$1" request_id="$2"
  json_get "$body" "data.logs.some(function(l){return l.request_id === '${request_id}';})"
}

cleanup() {
  local cleanup_ok=true
  printf "\n${COLOR_BOLD}Cleanup${COLOR_NC}\n"
  printf '%s\n' '------------------------------------------'

  # AuditLogger is in-memory only — nothing written by this script needs
  # deletion (no delete API exists, none is being added). A restart, if
  # the service isn't already in a known-good state, is sufficient; the
  # one required restart already happened as part of Scenario 11 above.
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    pass "SERVICE_RESTORED" "$SERVICE_NAME is active"
    log_result "SERVICE_RESTORED" "PASS"
  else
    fail "SERVICE_RESTORED" "$SERVICE_NAME is not active — attempting restart"
    if sudo systemctl restart "$SERVICE_NAME" 2>/dev/null && wait_for_health; then
      pass "SERVICE_RESTORED" "$SERVICE_NAME recovered after cleanup restart"
      log_result "SERVICE_RESTORED" "PASS"
    else
      log_result "SERVICE_RESTORED" "FAIL"
      cleanup_ok=false
    fi
  fi

  if [ "$cleanup_ok" = true ]; then
    log_result "cleanup" "PASS"
  else
    fail "Cleanup" "one or more cleanup steps failed — see above"
    log_result "cleanup" "FAIL"
    OVERALL_EXIT=1
  fi

  printf "\n==========================================\n"
  printf " SUMMARY\n"
  printf "==========================================\n"
  {
    printf '{\n  "timestamp": "%s",\n  "commit": "%s",\n  "results": {\n' "$TIMESTAMP" "$COMMIT_SHA"
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
    printf "AUDIT TENANT SCOPING HOST ACCEPTANCE: ${COLOR_GREEN}PASS${COLOR_NC}\n\n"
  else
    printf "AUDIT TENANT SCOPING HOST ACCEPTANCE: ${COLOR_RED}FAIL${COLOR_NC}\n\n"
  fi

  exit "$OVERALL_EXIT"
}

trap cleanup EXIT INT TERM

# ── Scenario 5/6/7 — generate A1/B1, then verify each tenant's read ──────
section "Scenario 5-7: Generate A1/B1, verify per-tenant isolation"
emit_audit "$TENANT_A" "$OWNER_A" "req_audit_accept_a1"
emit_audit "$TENANT_B" "$OWNER_B" "req_audit_accept_b1"

read_audit_as "$TENANT_A" "$OWNER_A"
A_SEES_A1="$(log_contains "$API_CALL_BODY" "req_audit_accept_a1")"
A_SEES_B1="$(log_contains "$API_CALL_BODY" "req_audit_accept_b1")"
if [ "$API_CALL_STATUS" = "200" ] && [ "$A_SEES_A1" = "true" ] && [ "$A_SEES_B1" = "false" ]; then
  pass "AUDIT_TENANT_A_ISOLATION" "A1 present, B1 absent"
  log_result "AUDIT_TENANT_A_ISOLATION" "PASS"
else
  fail "AUDIT_TENANT_A_ISOLATION" "HTTP $API_CALL_STATUS sees_a1=$A_SEES_A1 sees_b1=$A_SEES_B1"
  log_result "AUDIT_TENANT_A_ISOLATION" "FAIL"
  OVERALL_EXIT=1
fi

read_audit_as "$TENANT_B" "$OWNER_B"
B_SEES_B1="$(log_contains "$API_CALL_BODY" "req_audit_accept_b1")"
B_SEES_A1="$(log_contains "$API_CALL_BODY" "req_audit_accept_a1")"
if [ "$API_CALL_STATUS" = "200" ] && [ "$B_SEES_B1" = "true" ] && [ "$B_SEES_A1" = "false" ]; then
  pass "AUDIT_TENANT_B_ISOLATION" "B1 present, A1 absent"
  log_result "AUDIT_TENANT_B_ISOLATION" "PASS"
else
  fail "AUDIT_TENANT_B_ISOLATION" "HTTP $API_CALL_STATUS sees_b1=$B_SEES_B1 sees_a1=$B_SEES_A1"
  log_result "AUDIT_TENANT_B_ISOLATION" "FAIL"
  OVERALL_EXIT=1
fi

# ── Scenario 8 — same action/resource, different tenant ─────────────────
# A1/B1 above already share the identical action ("oauth:google_disconnected")
# and resource ({type:"OAuthConnection", id:"google_calendar"}) regardless
# of tenant — every disconnect call does. The isolation just proven above
# IS the same-action/same-resource collision proof; this section makes
# that explicit with its own marker rather than re-deriving new evidence.
section "Scenario 8: Same Action / Same Resource Collision"
A1_ACTION_RESOURCE="$(json_get "$API_CALL_BODY" "(function(){var l=data.logs.find(function(x){return x.request_id==='req_audit_accept_b1';}); return l ? l.action+'|'+l.resource.type+'|'+l.resource.id : '';})()")"
read_audit_as "$TENANT_A" "$OWNER_A"
B1_STILL_ABSENT_FOR_A="$(log_contains "$API_CALL_BODY" "req_audit_accept_b1")"
A1_ACTION_RESOURCE_A_SIDE="$(json_get "$API_CALL_BODY" "(function(){var l=data.logs.find(function(x){return x.request_id==='req_audit_accept_a1';}); return l ? l.action+'|'+l.resource.type+'|'+l.resource.id : '';})()")"
if [ "$A1_ACTION_RESOURCE_A_SIDE" = "oauth:google_disconnected|OAuthConnection|google_calendar" ] && [ -n "$A1_ACTION_RESOURCE" ] && [ "$B1_STILL_ABSENT_FOR_A" = "false" ]; then
  pass "AUDIT_SAME_RESOURCE_CROSS_TENANT_ISOLATION" "identical action+resource across tenants A/B, each tenant sees only its own record"
  log_result "AUDIT_SAME_RESOURCE_CROSS_TENANT_ISOLATION" "PASS"
else
  fail "AUDIT_SAME_RESOURCE_CROSS_TENANT_ISOLATION" "a_side=$A1_ACTION_RESOURCE_A_SIDE b_side=$A1_ACTION_RESOURCE b1_absent_for_a=$B1_STILL_ABSENT_FOR_A"
  log_result "AUDIT_SAME_RESOURCE_CROSS_TENANT_ISOLATION" "FAIL"
  OVERALL_EXIT=1
fi

# ── Scenario 9 — latest-20 within tenant (mandatory) ─────────────────────
section "Scenario 9: Latest-20 Within Tenant"
EMITTED_A_IDS=()
for i in $(seq 0 24); do
  rid="req_audit_lat20_a_${i}"
  emit_audit "$TENANT_A" "$OWNER_A" "$rid"
  EMITTED_A_IDS+=("$rid")
  emit_audit "$TENANT_B" "$OWNER_B" "req_audit_lat20_b_${i}"
done

read_audit_as "$TENANT_A" "$OWNER_A"
RETURNED_COUNT="$(json_get "$API_CALL_BODY" 'data.logs.length')"
ALL_TENANT_A="$(json_get "$API_CALL_BODY" "data.logs.every(function(l){return l.tenant_id === '${TENANT_A}';})")"
RETURNED_IDS="$(json_get "$API_CALL_BODY" 'JSON.stringify(data.logs.map(function(l){return l.request_id;}))')"

# Expected: newest-first over the last 20 of the 25 emitted A-events
# (indices 5..24, i.e. req_audit_lat20_a_24 down to req_audit_lat20_a_5).
EXPECTED_IDS="$(node -e '
  const ids = [];
  for (let i = 24; i >= 5; i--) ids.push(`req_audit_lat20_a_${i}`);
  console.log(JSON.stringify(ids));
')"

if [ "$RETURNED_COUNT" = "20" ] && [ "$ALL_TENANT_A" = "true" ]; then
  pass "AUDIT_LATEST20_WITHIN_TENANT" "exactly 20 returned, all tenant A, unaffected by tenant B volume"
  log_result "AUDIT_LATEST20_WITHIN_TENANT" "PASS"
else
  fail "AUDIT_LATEST20_WITHIN_TENANT" "count=$RETURNED_COUNT all_tenant_a=$ALL_TENANT_A"
  log_result "AUDIT_LATEST20_WITHIN_TENANT" "FAIL"
  OVERALL_EXIT=1
fi

if [ "$RETURNED_IDS" = "$EXPECTED_IDS" ]; then
  pass "AUDIT_NEWEST_FIRST" "newest tenant-A event first, oldest of the retained 20 last"
  log_result "AUDIT_NEWEST_FIRST" "PASS"
else
  fail "AUDIT_NEWEST_FIRST" "got=$RETURNED_IDS expected=$EXPECTED_IDS"
  log_result "AUDIT_NEWEST_FIRST" "FAIL"
  OVERALL_EXIT=1
fi

# ── Scenario 10 — empty tenant ────────────────────────────────────────────
section "Scenario 10: Empty Tenant"
read_audit_as "$TENANT_EMPTY" "usr_audit_empty"
EMPTY_TOTAL="$(json_get "$API_CALL_BODY" 'data.total')"
EMPTY_LOGS_LEN="$(json_get "$API_CALL_BODY" 'data.logs.length')"
if [ "$API_CALL_STATUS" = "200" ] && [ "$EMPTY_LOGS_LEN" = "0" ] && [ "$EMPTY_TOTAL" = "0" ]; then
  pass "AUDIT_EMPTY_TENANT" "logs=[] total=0, no cross-tenant existence signal"
  log_result "AUDIT_EMPTY_TENANT" "PASS"
else
  fail "AUDIT_EMPTY_TENANT" "HTTP $API_CALL_STATUS logs_len=$EMPTY_LOGS_LEN total=$EMPTY_TOTAL"
  log_result "AUDIT_EMPTY_TENANT" "FAIL"
  OVERALL_EXIT=1
fi

# ── Scenario 12 — response shape ─────────────────────────────────────────
section "Scenario 12: Response Shape"
read_audit_as "$TENANT_A" "$OWNER_A"
SHAPE_TOTAL="$(json_get "$API_CALL_BODY" 'data.total')"
SHAPE_LOGS_LEN="$(json_get "$API_CALL_BODY" 'data.logs.length')"
if [ "$API_CALL_STATUS" = "200" ] && [ "$SHAPE_TOTAL" = "$SHAPE_LOGS_LEN" ] && [ "$SHAPE_LOGS_LEN" = "20" ]; then
  pass "AUDIT_RESPONSE_SHAPE_COMPATIBLE" "{logs:[...], total} with total reflecting only the tenant-scoped returned count"
  log_result "AUDIT_RESPONSE_SHAPE_COMPATIBLE" "PASS"
else
  fail "AUDIT_RESPONSE_SHAPE_COMPATIBLE" "total=$SHAPE_TOTAL logs_len=$SHAPE_LOGS_LEN"
  log_result "AUDIT_RESPONSE_SHAPE_COMPATIBLE" "FAIL"
  OVERALL_EXIT=1
fi

# ── Scenario 11 — restart behavior ───────────────────────────────────────
# AuditLogger is confirmed in-memory only (see header comment) — every
# audit record emitted above is expected to disappear on restart. This is
# pre-existing, out-of-scope behavior, never a failure condition for this
# correction. Only fresh, POST-restart isolation is asserted here.
section "Scenario 11: Restart Behavior"
printf "  AUDIT_RESTART_PERSISTENCE=NOT_APPLICABLE_IN_MEMORY_ONLY (informational only, not a pass/fail gate)\n"
log_result "AUDIT_RESTART_PERSISTENCE" "NOT_APPLICABLE_IN_MEMORY_ONLY"

sudo systemctl restart "$SERVICE_NAME"
if ! wait_for_health; then
  fail "Service restarted" "health check did not return within timeout"
  log_result "AUDIT_ISOLATION_AFTER_RESTART" "FAIL"
  OVERALL_EXIT=1
else
  pass "Service restarted" "health OK"
  emit_audit "$TENANT_A" "$OWNER_A" "req_audit_accept_a2"
  emit_audit "$TENANT_B" "$OWNER_B" "req_audit_accept_b2"

  read_audit_as "$TENANT_A" "$OWNER_A"
  A_SEES_A2="$(log_contains "$API_CALL_BODY" "req_audit_accept_a2")"
  A_SEES_B2="$(log_contains "$API_CALL_BODY" "req_audit_accept_b2")"
  read_audit_as "$TENANT_B" "$OWNER_B"
  B_SEES_B2="$(log_contains "$API_CALL_BODY" "req_audit_accept_b2")"
  B_SEES_A2="$(log_contains "$API_CALL_BODY" "req_audit_accept_a2")"

  if [ "$A_SEES_A2" = "true" ] && [ "$A_SEES_B2" = "false" ] && [ "$B_SEES_B2" = "true" ] && [ "$B_SEES_A2" = "false" ]; then
    pass "AUDIT_ISOLATION_AFTER_RESTART" "A sees A2 not B2; B sees B2 not A2"
    log_result "AUDIT_ISOLATION_AFTER_RESTART" "PASS"
  else
    fail "AUDIT_ISOLATION_AFTER_RESTART" "a_sees_a2=$A_SEES_A2 a_sees_b2=$A_SEES_B2 b_sees_b2=$B_SEES_B2 b_sees_a2=$B_SEES_A2"
    log_result "AUDIT_ISOLATION_AFTER_RESTART" "FAIL"
    OVERALL_EXIT=1
  fi
fi

# Cleanup (Scenario 13) runs automatically via the EXIT trap.

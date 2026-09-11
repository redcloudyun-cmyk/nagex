#!/usr/bin/env bash
#
# NAgex Task Durable Restart/Resume LIVE E2E (nagex-task-e2e-live)
#
# Proves, on the real Linux/systemd host, that a real multi-step Task run
# survives an actual `systemctl restart nagex.service` at a real
# WAITING_APPROVAL boundary: the completed read-only step is not replayed,
# the paused write step resumes from the exact frozen state once approved,
# and the run reaches a truthful terminal success.
#
# V01/V01a-R1 pre-flight findings this script's design rests on (see
# docs/ops/automated-testing.md Section 4 and the V01/V01a-R1 commit
# history for the full reasoning):
#   - GET /api/v1/tasks/:id/runs and GET /api/v1/tasks/:id are backed by the
#     real TaskRunStore/TaskStore — safe to trust.
#   - GET /api/v1/approvals and GET /api/v1/approvals/calendar-event are
#     LEGACY DEMO surfaces (a separate in-memory array), NOT the real
#     ActionApprovalStore — never used by this script for discovery.
#     GET /api/v1/approvals/:id (single item, by known id) DOES read the
#     real, shared ActionApprovalStore and is safe once the id is known.
#   - A WAITING_APPROVAL TaskRunRecord's own `result` field is null by
#     design (TaskRunStore.waitForApproval() only ever changes `status`) —
#     the approvalId is NOT recoverable from the /run-with-fixed-plan HTTP
#     response body. The only real, existing place it lives is
#     DurableTaskRunStateStore's own persisted record (field
#     `waitingApprovalId`), read directly from its JSON file on this host
#     — exactly the "prefer existing stores first" guidance already given,
#     and the same file this script reads for its non-replay proof, so
#     this is one read serving two purposes, not a new surface.
#
# V01-R1 — corrected after a real host run: two harness assertions were
# too strict, not the durable runtime being wrong (core restart/resume/
# non-replay behavior all passed on that run). (1) TaskContinuationCoordinator
# resumes fire-and-forget from the /approve route, so the approve response
# may legitimately already show CONSUMED (not just APPROVED) by the time
# it's serialized — both are accepted, with the real proof being the
# downstream TaskRun==SUCCEEDED check. (2) a replay re-calling /approve
# itself hits ActionApprovalStore.approve()'s own APPROVAL_NOT_PENDING
# guard, a distinct code from consume()'s APPROVAL_ALREADY_CONSUMED — both
# are accepted as valid replay-protection evidence, via the shared,
# envelope-shape-normalizing extract_error_code() helper.
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

AUTO_CONFIRM=false
for arg in "$@"; do
  case "$arg" in
    -y|--yes) AUTO_CONFIRM=true; shift ;;
  esac
done

if [ "$AUTO_CONFIRM" = false ]; then
  printf "\n${COLOR_BOLD}This test will perform real, consequential actions:${COLOR_NC}\n\n"
  printf "  - temporarily enable a test-only route on the running nagex.service\n"
  printf "    (via a runtime-only /run systemd drop-in, removed in cleanup)\n"
  printf "  - restart nagex.service TWICE (once to enable the test route, once\n"
  printf "    mid-scenario as the actual restart under test)\n"
  printf "  - create one real Google Calendar test event\n"
  printf "  - restart nagex.service a THIRD time in cleanup to disable the test route\n\n"
  printf "Continue? [y/N] "
  read -r REPLY
  case "$REPLY" in
    y|Y|yes|YES) ;;
    *) printf "\n[CANCELLED] Task durable LIVE E2E aborted by user.\n\n"; exit 130 ;;
  esac
fi

BASE="${NAGEX_BASE_URL:-http://127.0.0.1:4100}"
TENANT="${NAGEX_TEST_TENANT:-ten_production_01}"
PRINCIPAL="${NAGEX_TEST_PRINCIPAL:-usr_admin_001}"
SERVICE_NAME="${NAGEX_SERVICE_NAME:-nagex.service}"
DROPIN_DIR="/run/systemd/system/${SERVICE_NAME}.d"
DROPIN_FILE="${DROPIN_DIR}/90-nagex-task-e2e-live.conf"
DURABLE_RUNS_DIR="${NAGEX_DURABLE_TASK_RUNS_DIR:-/var/lib/nagex/durable-task-runs}"
CONTINUATIONS_DIR="${NAGEX_TASK_CONTINUATIONS_DIR:-/var/lib/nagex/task-continuations}"
TOKEN_HEADER="X-NAgex-Test-Token"

LOG_DIR="$(resolve_log_dir)"
JSON_LOG_FILE="${LOG_DIR}/latest-task-e2e-live.json"

OVERALL_EXIT=0
TIMESTAMP="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
COMMIT_SHA="$(git -C "$PROJECT_DIR" rev-parse --short HEAD 2>/dev/null || echo "unknown")"

declare -A RESULTS
log_result() { RESULTS["$1"]="$2"; }

printf "\n==========================================\n"
printf " NAGEX TASK DURABLE LIVE E2E\n"
printf "==========================================\n"

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

# Reads /proc/<pid>/environ (null-separated) and checks whether the given
# variable name is present at all — never prints its value, only whether
# the name exists, so a real token is never revealed even in a FAIL log.
service_env_has_var() {
  local varname="$1" pid
  pid="$(service_main_pid)"
  if [ "$pid" = "0" ] || [ -z "$pid" ]; then return 1; fi
  sudo cat "/proc/${pid}/environ" 2>/dev/null | tr '\0' '\n' | grep -q "^${varname}="
}

# Reads a durable-task-run-state JSON file directly — the authoritative,
# already-existing store (P03), read-only, no mutation. Requires sudo since
# /var/lib/nagex is owned by the service account.
read_durable_run_state() {
  local run_id="$1"
  sudo cat "${DURABLE_RUNS_DIR}/${run_id}.json" 2>/dev/null || echo ""
}

read_continuation() {
  local approval_id="$1"
  sudo cat "${CONTINUATIONS_DIR}/${approval_id}.json" 2>/dev/null || echo ""
}

fixed_plan_probe_status() {
  curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
    -H "x-nagex-tenant: ${TENANT}" -H "x-principal-id: ${PRINCIPAL}" \
    -d '{"steps":[]}' "${BASE}/api/v1/tasks/nagex-task-e2e-probe/run-with-fixed-plan" 2>/dev/null || echo "000"
}

# ── State tracked across the whole run, for cleanup ─────────────────────

INJECTION_ACTIVE=false
TEST_TOKEN=""
CREATED_TASK_ID=""
RUN_ID=""

cleanup() {
  local cleanup_ok=true
  printf "\n${COLOR_BOLD}Cleanup${COLOR_NC}\n"
  printf '%s\n' '------------------------------------------'

  if [ "$INJECTION_ACTIVE" = true ]; then
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

    local probe_status
    probe_status="$(fixed_plan_probe_status)"
    if [ "$probe_status" = "404" ]; then
      pass "Fixed-plan route disabled" "404"
      log_result "cleanupRouteDisabled" "PASS"
    else
      fail "Fixed-plan route disabled" "HTTP $probe_status"
      log_result "cleanupRouteDisabled" "FAIL"
      cleanup_ok=false
    fi

    if service_env_has_var "NAGEX_ENABLE_TEST_PLAN_INJECTION"; then
      fail "Injection flag absent from service env" "still present"
      log_result "cleanupFlagAbsent" "FAIL"
      cleanup_ok=false
    else
      pass "Injection flag absent from service env"
      log_result "cleanupFlagAbsent" "PASS"
    fi
    if service_env_has_var "NAGEX_TEST_PLAN_INJECTION_TOKEN"; then
      fail "Injection token absent from service env" "still present"
      log_result "cleanupTokenAbsent" "FAIL"
      cleanup_ok=false
    else
      pass "Injection token absent from service env"
      log_result "cleanupTokenAbsent" "PASS"
    fi
  fi

  if [ -n "$CREATED_TASK_ID" ]; then
    curl -s -X DELETE -H "x-nagex-tenant: ${TENANT}" -H "x-principal-id: ${PRINCIPAL}" "${BASE}/api/v1/tasks/${CREATED_TASK_ID}" >/dev/null 2>&1 || true
  fi

  TEST_TOKEN=""

  if [ "$cleanup_ok" = true ]; then
    log_result "cleanup" "PASS"
  else
    fail "Cleanup" "one or more cleanup steps failed — see above"
    log_result "cleanup" "FAIL"
    OVERALL_EXIT=1
  fi

  # ── Final SAFE re-verification ──────────────────────────────────────
  if [ -x "${SCRIPT_DIR}/nagex-check.sh" ]; then
    if "${SCRIPT_DIR}/nagex-check.sh" >/dev/null 2>&1; then
      pass "SAFE verification (nagex-check)" "PASS"
      log_result "safeVerification" "PASS"
    else
      fail "SAFE verification (nagex-check)" "FAIL — see nagex-check's own log"
      log_result "safeVerification" "FAIL"
      OVERALL_EXIT=1
    fi
  else
    warn "SAFE verification (nagex-check)" "nagex-check.sh not found/executable, skipped"
    log_result "safeVerification" "WARN"
  fi

  printf "\n==========================================\n"
  if [ "$OVERALL_EXIT" -eq 0 ]; then
    printf " TASK DURABLE LIVE E2E: ${COLOR_GREEN}PASS${COLOR_NC}\n"
  else
    printf " TASK DURABLE LIVE E2E: ${COLOR_RED}FAIL${COLOR_NC}\n"
  fi
  printf "==========================================\n\n"

  local overall_str="FAIL"
  [ "$OVERALL_EXIT" -eq 0 ] && overall_str="PASS"
  cat <<EOF >"$JSON_LOG_FILE"
{
  "timestamp": "${TIMESTAMP}",
  "commitSha": "${COMMIT_SHA}",
  "overallResult": "${overall_str}",
  "checks": {
    "repositoryClean": "${RESULTS[repositoryClean]:-FAIL}",
    "headMatchesOrigin": "${RESULTS[headMatchesOrigin]:-FAIL}",
    "serviceActive": "${RESULTS[serviceActive]:-FAIL}",
    "safeBaseline": "${RESULTS[safeBaseline]:-FAIL}",
    "noTokenGate": "${RESULTS[noTokenGate]:-FAIL}",
    "wrongTokenGate": "${RESULTS[wrongTokenGate]:-FAIL}",
    "correctTokenGate": "${RESULTS[correctTokenGate]:-FAIL}",
    "taskCreated": "${RESULTS[taskCreated]:-FAIL}",
    "runStarted": "${RESULTS[runStarted]:-FAIL}",
    "step1Executed": "${RESULTS[step1Executed]:-FAIL}",
    "approvalRequested": "${RESULTS[approvalRequested]:-FAIL}",
    "durableStatePersisted": "${RESULTS[durableStatePersisted]:-FAIL}",
    "continuationPersisted": "${RESULTS[continuationPersisted]:-FAIL}",
    "systemdRestart": "${RESULTS[systemdRestart]:-FAIL}",
    "postRestartServiceActive": "${RESULTS[postRestartServiceActive]:-FAIL}",
    "durablePositionPreserved": "${RESULTS[durablePositionPreserved]:-FAIL}",
    "step1NotReplayed": "${RESULTS[step1NotReplayed]:-FAIL}",
    "approvalGranted": "${RESULTS[approvalGranted]:-FAIL}",
    "step2Executed": "${RESULTS[step2Executed]:-FAIL}",
    "step3Executed": "${RESULTS[step3Executed]:-FAIL}",
    "taskRunSucceeded": "${RESULTS[taskRunSucceeded]:-FAIL}",
    "approvalReplayBlocked": "${RESULTS[approvalReplayBlocked]:-FAIL}",
    "cleanup": "${RESULTS[cleanup]:-FAIL}",
    "cleanupRouteDisabled": "${RESULTS[cleanupRouteDisabled]:-FAIL}",
    "cleanupFlagAbsent": "${RESULTS[cleanupFlagAbsent]:-FAIL}",
    "cleanupTokenAbsent": "${RESULTS[cleanupTokenAbsent]:-FAIL}",
    "safeVerification": "${RESULTS[safeVerification]:-FAIL}"
  }
}
EOF

  # A trap handler must call exit itself to change the process's final
  # exit code — OVERALL_EXIT may have just been raised by a cleanup
  # failure detected above, after the main body's own `exit` call already
  # fired this trap. Without this, "cleanup failure prevents a clean PASS"
  # would not actually hold.
  exit "$OVERALL_EXIT"
}
trap cleanup EXIT INT TERM

# ── Preflight ────────────────────────────────────────────────────────────
section "Preflight"

STATUS_OUT="$(git -C "$PROJECT_DIR" status --porcelain 2>/dev/null || echo "error")"
if [ -z "$STATUS_OUT" ]; then
  pass "Repository clean"
  log_result "repositoryClean" "PASS"
else
  fail "Repository clean" "dirty changes exist"
  log_result "repositoryClean" "FAIL"
  OVERALL_EXIT=1
fi

git -C "$PROJECT_DIR" fetch origin main >/dev/null 2>&1 || true
LOCAL_SHA="$(git -C "$PROJECT_DIR" rev-parse --short HEAD 2>/dev/null || echo "none")"
REMOTE_SHA="$(git -C "$PROJECT_DIR" rev-parse --short origin/main 2>/dev/null || echo "none")"
if [ "$LOCAL_SHA" != "none" ] && [ "$LOCAL_SHA" = "$REMOTE_SHA" ]; then
  pass "HEAD == origin/main" "$LOCAL_SHA"
  log_result "headMatchesOrigin" "PASS"
else
  fail "HEAD == origin/main" "local:$LOCAL_SHA remote:$REMOTE_SHA"
  log_result "headMatchesOrigin" "FAIL"
  OVERALL_EXIT=1
fi

if systemctl is-active --quiet "$SERVICE_NAME"; then
  pass "Service active" "$SERVICE_NAME"
  log_result "serviceActive" "PASS"
else
  fail "Service active" "$SERVICE_NAME is not active"
  log_result "serviceActive" "FAIL"
  OVERALL_EXIT=1
fi

if [ -x "${SCRIPT_DIR}/nagex-check.sh" ] && "${SCRIPT_DIR}/nagex-check.sh" -y >/dev/null 2>&1; then
  pass "SAFE baseline (nagex-check)"
  log_result "safeBaseline" "PASS"
else
  fail "SAFE baseline (nagex-check)" "did not pass — refusing to proceed"
  log_result "safeBaseline" "FAIL"
  OVERALL_EXIT=1
fi

if [ "$OVERALL_EXIT" -ne 0 ]; then
  printf "\n[ABORT] Preflight failed — not proceeding to injection activation.\n\n"
  exit 2
fi

# ── V01a activation: transient systemd drop-in ───────────────────────────
section "Injection Security"

TEST_TOKEN="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
if [ -z "$TEST_TOKEN" ]; then
  fail "Generate ephemeral token" "empty"
  exit 2
fi

sudo mkdir -p "$DROPIN_DIR"
{
  printf '[Service]\n'
  printf 'Environment=NAGEX_ENABLE_TEST_PLAN_INJECTION=1\n'
  printf 'Environment=NAGEX_TEST_PLAN_INJECTION_TOKEN=%s\n' "$TEST_TOKEN"
} | sudo tee "$DROPIN_FILE" >/dev/null
# Mark cleanup-required as soon as the file exists — before chmod, so even
# a chmod failure still triggers the drop-in removal/restart/verification
# path in cleanup(), rather than silently leaving it behind.
INJECTION_ACTIVE=true
sudo chmod 600 "$DROPIN_FILE"

sudo systemctl daemon-reload
sudo systemctl restart "$SERVICE_NAME"
if ! wait_for_health; then
  fail "Service restarted (injection mode)" "health check did not return within timeout"
  exit 1
fi

# A placeholder taskId is safe here: the flag+token gate is checked before
# any task lookup, so these three probes never touch real data.
NO_TOKEN_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -H "x-nagex-tenant: ${TENANT}" -H "x-principal-id: ${PRINCIPAL}" -d '{"steps":[]}' "${BASE}/api/v1/tasks/nagex-task-e2e-gate-probe/run-with-fixed-plan")"
if [ "$NO_TOKEN_STATUS" = "404" ]; then
  pass "No-token gate" "404"
  log_result "noTokenGate" "PASS"
else
  fail "No-token gate" "expected 404, got HTTP $NO_TOKEN_STATUS"
  log_result "noTokenGate" "FAIL"
  OVERALL_EXIT=1
fi

api_call_with_header POST "${BASE}/api/v1/tasks/nagex-task-e2e-gate-probe/run-with-fixed-plan" '{"steps":[]}' "$TOKEN_HEADER" "wrong-token-entirely"
if [ "$API_CALL_STATUS" = "404" ]; then
  pass "Wrong-token gate" "404"
  log_result "wrongTokenGate" "PASS"
else
  fail "Wrong-token gate" "expected 404, got HTTP $API_CALL_STATUS"
  log_result "wrongTokenGate" "FAIL"
  OVERALL_EXIT=1
fi

api_call_with_header POST "${BASE}/api/v1/tasks/nagex-task-e2e-gate-probe/run-with-fixed-plan" '{"steps":[]}' "$TOKEN_HEADER" "$TEST_TOKEN"
# The gate-probe taskId does not exist, so a correct token reaching past
# the gate produces TASK_NOT_FOUND (still routed, still a real check that
# the token was accepted) — a route-not-found 404 and this 404 are
# distinguishable by body only, never relied upon for the security gate
# itself, only used here to prove the token was genuinely accepted.
CORRECT_TOKEN_ERR_CODE="$(extract_error_code "$API_CALL_BODY")"
if [ "$API_CALL_STATUS" = "404" ] && [ "$CORRECT_TOKEN_ERR_CODE" = "TASK_NOT_FOUND" ]; then
  pass "Correct-token gate" "reached TASK_NOT_FOUND (route active)"
  log_result "correctTokenGate" "PASS"
else
  fail "Correct-token gate" "HTTP $API_CALL_STATUS, $(api_error_summary "$API_CALL_BODY")"
  log_result "correctTokenGate" "FAIL"
  OVERALL_EXIT=1
fi

if [ "$OVERALL_EXIT" -ne 0 ]; then
  printf "\n[ABORT] Injection security gates did not verify as expected — not proceeding.\n\n"
  exit 1
fi

# ── Task Setup ─────────────────────────────────────────────────────────
section "Task Setup"

RUN_REQUEST_ID="req_task_e2e_$(date -u +%Y%m%dT%H%M%SZ)_$(node -e 'console.log(require("crypto").randomBytes(4).toString("hex"))')"
EVENT_SUFFIX="NAGEX-TASK-E2E-${TIMESTAMP}"

api_call POST "${BASE}/api/v1/tasks" "$(node -e '
  console.log(JSON.stringify({
    name: "NAgex Task Durable LIVE E2E",
    objective: "placeholder — plan is injected via V01a, this text is never sent to a model",
    type: "ONE_TIME",
    trigger: { type: "MANUAL" },
    approvalPolicy: "READ_ONLY_AUTO",
  }));
')"
if [ "$API_CALL_STATUS" = "201" ]; then
  CREATED_TASK_ID="$(json_get "$API_CALL_BODY" 'data.taskId')"
  pass "Task created" "taskId=$CREATED_TASK_ID"
  log_result "taskCreated" "PASS"
else
  fail "Task created" "HTTP $API_CALL_STATUS, $(api_error_summary "$API_CALL_BODY")"
  log_result "taskCreated" "FAIL"
  OVERALL_EXIT=1
  exit 1
fi

CAL_TIMES="$(node -e '
  const start = new Date(Date.now() + 24*3600*1000);
  start.setHours(15, 0, 0, 0);
  const end = new Date(start.getTime() + 30*60*1000);
  console.log(JSON.stringify({ start: start.toISOString(), end: end.toISOString() }));
')"
START_TIME="$(json_get "$CAL_TIMES" 'data.start')"
END_TIME="$(json_get "$CAL_TIMES" 'data.end')"

# Deterministic 3-step plan: read-only free_slots -> write create_event
# (real APPROVAL_REQUIRED) -> read-only free_slots again. Calendar-only
# (no Gmail dependency) to keep this scenario's external footprint minimal
# and matches nagex-e2e-live.sh's already-proven real create_event payload
# shape (calendarId/summary/description/start/end/timezone/attendees).
FIXED_PLAN_PAYLOAD="$(node -e '
  const [startTime, endTime, suffix] = process.argv.slice(1);
  const steps = [
    { title: "Check availability", reasoning: "Read-only baseline before the write.", skill: "skill.scheduling", tool: "google_calendar.free_slots", requiresApproval: false, necessity: "REQUIRED", dependsOn: [], parameters: { calendarId: "primary", timeMin: startTime, timeMax: endTime, timezone: "Asia/Seoul" } },
    { title: "Create test event", reasoning: "The consequential write this scenario pauses at.", skill: "skill.scheduling", tool: "google_calendar.create_event", requiresApproval: true, necessity: "REQUIRED", dependsOn: [1], parameters: { calendarId: "primary", summary: suffix, description: "Automated NAgex durable restart/resume verification. Safe to delete.", start: startTime, end: endTime, timezone: "Asia/Seoul", attendees: [] } },
    { title: "Re-check availability", reasoning: "Must not execute before the write is approved.", skill: "skill.scheduling", tool: "google_calendar.free_slots", requiresApproval: false, necessity: "REQUIRED", dependsOn: [2], parameters: { calendarId: "primary", timeMin: startTime, timeMax: endTime, timezone: "Asia/Seoul" } },
  ];
  console.log(JSON.stringify({ steps }));
' "$START_TIME" "$END_TIME" "$EVENT_SUFFIX")"

api_call_with_header POST "${BASE}/api/v1/tasks/${CREATED_TASK_ID}/run-with-fixed-plan" "$FIXED_PLAN_PAYLOAD" "$TOKEN_HEADER" "$TEST_TOKEN"
if [ "$API_CALL_STATUS" = "200" ]; then
  RUN_STATUS="$(json_get "$API_CALL_BODY" 'data.status')"
  RUN_ID="$(json_get "$API_CALL_BODY" 'data.runId')"
  if [ "$RUN_STATUS" = "WAITING_APPROVAL" ] && [ -n "$RUN_ID" ]; then
    pass "Run started" "runId=$RUN_ID"
    log_result "runStarted" "PASS"
  else
    fail "Run started" "expected WAITING_APPROVAL with a runId, got status=$RUN_STATUS"
    log_result "runStarted" "FAIL"
    OVERALL_EXIT=1
  fi
else
  fail "Run started" "HTTP $API_CALL_STATUS, $(api_error_summary "$API_CALL_BODY")"
  log_result "runStarted" "FAIL"
  OVERALL_EXIT=1
fi

if [ "$OVERALL_EXIT" -ne 0 ]; then
  printf "\n[ABORT] Task run did not reach the expected pre-restart state.\n\n"
  exit 1
fi

# The approvalId, and the frozen resolvedSteps/executedSoFar snapshot, live
# only in DurableTaskRunStateStore's own file — see the header comment.
DURABLE_STATE_PRE="$(read_durable_run_state "$RUN_ID")"
DURABLE_STATUS_PRE="$(json_get "$DURABLE_STATE_PRE" 'data.status')"
APPROVAL_ID="$(json_get "$DURABLE_STATE_PRE" 'data.waitingApprovalId')"
STEP_INDEX_PRE="$(json_get "$DURABLE_STATE_PRE" 'data.stepIndex')"
EXECUTED_COUNT_PRE="$(json_get "$DURABLE_STATE_PRE" 'data.executedSoFar ? data.executedSoFar.length : ""')"
STEP1_RESULT_PRE="$(json_get "$DURABLE_STATE_PRE" 'data.executedSoFar && data.executedSoFar[0] ? JSON.stringify(data.executedSoFar[0]) : ""')"

if [ "$DURABLE_STATUS_PRE" = "WAITING_APPROVAL" ] && [ -n "$APPROVAL_ID" ] && [ "$STEP_INDEX_PRE" = "1" ] && [ "$EXECUTED_COUNT_PRE" = "1" ]; then
  pass "Step 1 executed" "1 step recorded before the pause"
  log_result "step1Executed" "PASS"
  pass "Approval requested" "approvalId=$APPROVAL_ID"
  log_result "approvalRequested" "PASS"
  pass "Durable state persisted" "status=WAITING_APPROVAL stepIndex=1"
  log_result "durableStatePersisted" "PASS"
else
  fail "Durable state persisted" "status=$DURABLE_STATUS_PRE stepIndex=$STEP_INDEX_PRE executed=$EXECUTED_COUNT_PRE approvalId=${APPROVAL_ID:-<none>}"
  log_result "step1Executed" "FAIL"
  log_result "approvalRequested" "FAIL"
  log_result "durableStatePersisted" "FAIL"
  OVERALL_EXIT=1
fi

CONTINUATION_PRE="$(read_continuation "$APPROVAL_ID")"
CONTINUATION_RUN_ID_PRE="$(json_get "$CONTINUATION_PRE" 'data.runId')"
if [ -n "$CONTINUATION_PRE" ] && [ "$CONTINUATION_RUN_ID_PRE" = "$RUN_ID" ]; then
  pass "Continuation persisted" "matches runId"
  log_result "continuationPersisted" "PASS"
else
  fail "Continuation persisted" "no matching TaskContinuationStore record found for approvalId=$APPROVAL_ID"
  log_result "continuationPersisted" "FAIL"
  OVERALL_EXIT=1
fi

if [ "$OVERALL_EXIT" -ne 0 ]; then
  printf "\n[ABORT] Pre-restart durable/continuation state did not verify — not restarting.\n\n"
  exit 1
fi

# ── Restart ────────────────────────────────────────────────────────────
section "Restart"

sudo systemctl restart "$SERVICE_NAME"
log_result "systemdRestart" "PASS"
pass "systemd restart" "$SERVICE_NAME"

if wait_for_health; then
  pass "Service active" "post-restart"
  log_result "postRestartServiceActive" "PASS"
else
  fail "Service active" "post-restart health check did not return within timeout"
  log_result "postRestartServiceActive" "FAIL"
  OVERALL_EXIT=1
  exit 1
fi

DURABLE_STATE_POST="$(read_durable_run_state "$RUN_ID")"
DURABLE_STATUS_POST="$(json_get "$DURABLE_STATE_POST" 'data.status')"
STEP_INDEX_POST="$(json_get "$DURABLE_STATE_POST" 'data.stepIndex')"
EXECUTED_COUNT_POST="$(json_get "$DURABLE_STATE_POST" 'data.executedSoFar ? data.executedSoFar.length : ""')"
STEP1_RESULT_POST="$(json_get "$DURABLE_STATE_POST" 'data.executedSoFar && data.executedSoFar[0] ? JSON.stringify(data.executedSoFar[0]) : ""')"

if [ "$DURABLE_STATUS_POST" = "WAITING_APPROVAL" ] && [ "$STEP_INDEX_POST" = "1" ] && [ "$EXECUTED_COUNT_POST" = "1" ]; then
  pass "Durable position preserved" "status=WAITING_APPROVAL stepIndex=1 (unchanged)"
  log_result "durablePositionPreserved" "PASS"
else
  fail "Durable position preserved" "status=$DURABLE_STATUS_POST stepIndex=$STEP_INDEX_POST executed=$EXECUTED_COUNT_POST"
  log_result "durablePositionPreserved" "FAIL"
  OVERALL_EXIT=1
fi

# Step 1's recorded result is byte-identical before and after restart —
# combined with it staying at exactly one entry, this is the authoritative
# non-replay proof: nothing re-ran step 1's real broker dispatch.
if [ "$STEP1_RESULT_PRE" = "$STEP1_RESULT_POST" ] && [ -n "$STEP1_RESULT_PRE" ]; then
  pass "Step 1 not replayed" "identical persisted result before/after restart"
  log_result "step1NotReplayed" "PASS"
else
  fail "Step 1 not replayed" "step 1's persisted result changed across the restart"
  log_result "step1NotReplayed" "FAIL"
  OVERALL_EXIT=1
fi

TASK_STATUS_POST_RESTART="$(curl -s -H "x-nagex-tenant: ${TENANT}" -H "x-principal-id: ${PRINCIPAL}" "${BASE}/api/v1/tasks/${CREATED_TASK_ID}" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(d).status||"")}catch(e){console.log("")}})')"
if [ "$TASK_STATUS_POST_RESTART" = "WAITING" ]; then
  pass "Task status" "WAITING (post-restart)"
else
  fail "Task status" "expected WAITING, got '$TASK_STATUS_POST_RESTART'"
  OVERALL_EXIT=1
fi

if [ "$OVERALL_EXIT" -ne 0 ]; then
  printf "\n[ABORT] Post-restart durable-state verification failed — not resuming.\n\n"
  exit 1
fi

# ── Resume ─────────────────────────────────────────────────────────────
section "Resume"

api_call POST "${BASE}/api/v1/approvals/${APPROVAL_ID}/approve" '{}'
if [ "$API_CALL_STATUS" = "200" ]; then
  APPROVE_STATUS="$(json_get "$API_CALL_BODY" 'data.status')"
  # V01-R1 — TaskContinuationCoordinator.onApproved() is triggered
  # fire-and-forget from this exact route, immediately after approve()
  # returns the record by reference. By the time this response body is
  # serialized and read, the same underlying record may already have been
  # mutated to CONSUMED by the resumed execution's own consume() call —
  # that is CONSUMED being the stronger, later terminal state after a
  # successful resume, not a failure. Accept either; the authoritative
  # proof that resume actually worked is the downstream TaskRun ==
  # SUCCEEDED + executedSoFar == 3 checks below, not this status string.
  if [ "$APPROVE_STATUS" = "APPROVED" ] || [ "$APPROVE_STATUS" = "CONSUMED" ]; then
    pass "Approval granted" "approvalId=$APPROVAL_ID status=$APPROVE_STATUS"
    log_result "approvalGranted" "PASS"
  else
    fail "Approval granted" "unexpected status '$APPROVE_STATUS'"
    log_result "approvalGranted" "FAIL"
    OVERALL_EXIT=1
  fi
else
  fail "Approval granted" "HTTP $API_CALL_STATUS, $(api_error_summary "$API_CALL_BODY")"
  log_result "approvalGranted" "FAIL"
  OVERALL_EXIT=1
fi

# Resume is fire-and-forget from the approve route (TaskContinuationCoordinator)
# — bounded-poll the run's own status rather than assuming instant completion.
FINAL_STATUS=""
for _ in $(seq 1 60); do
  RUNS_RESP="$(curl -s -H "x-nagex-tenant: ${TENANT}" -H "x-principal-id: ${PRINCIPAL}" "${BASE}/api/v1/tasks/${CREATED_TASK_ID}/runs")"
  FINAL_STATUS="$(json_get "$RUNS_RESP" "(data.runs.find(r => r.runId === \"${RUN_ID}\") || {}).status || \"\"")"
  if [ "$FINAL_STATUS" = "SUCCEEDED" ] || [ "$FINAL_STATUS" = "FAILED" ]; then break; fi
  sleep 2
done

DURABLE_STATE_FINAL="$(read_durable_run_state "$RUN_ID")"
EXECUTED_COUNT_FINAL="$(json_get "$DURABLE_STATE_FINAL" 'data.executedSoFar ? data.executedSoFar.length : ""')"

if [ "$EXECUTED_COUNT_FINAL" = "3" ]; then
  pass "Step 2 executed"
  log_result "step2Executed" "PASS"
  pass "Step 3 executed"
  log_result "step3Executed" "PASS"
else
  fail "Step 2/3 executed" "expected 3 total executed steps, got $EXECUTED_COUNT_FINAL"
  log_result "step2Executed" "FAIL"
  log_result "step3Executed" "FAIL"
  OVERALL_EXIT=1
fi

if [ "$FINAL_STATUS" = "SUCCEEDED" ]; then
  pass "TaskRun SUCCEEDED"
  log_result "taskRunSucceeded" "PASS"
else
  fail "TaskRun SUCCEEDED" "final status was '$FINAL_STATUS' (bounded poll timed out or run failed)"
  log_result "taskRunSucceeded" "FAIL"
  OVERALL_EXIT=1
fi

# ── Replay Verification ──────────────────────────────────────────────
# V01-R1 — this replay attempt re-calls /approve itself (not a direct
# capabilities/execute replay like nagex-e2e-live.sh's checks), so it
# exercises ActionApprovalStore.approve()'s OWN pending-state guard, which
# throws APPROVAL_NOT_PENDING for an already-CONSUMED record — a distinct,
# equally authoritative code from consume()'s own guard
# (APPROVAL_ALREADY_CONSUMED). Both mean the same thing here: the store
# correctly refused to reprocess a consumed approval. Accept either,
# normalized across the real supported envelope shapes (see
# extract_error_code() in the common lib) rather than assuming exactly one.
REPLAY_RESP="$(curl -s -w '\n%{http_code}' -X POST -H "x-nagex-tenant: ${TENANT}" -H "x-principal-id: ${PRINCIPAL}" "${BASE}/api/v1/approvals/${APPROVAL_ID}/approve")"
REPLAY_HTTP_CODE="$(printf '%s' "$REPLAY_RESP" | tail -n1)"
REPLAY_BODY="$(printf '%s' "$REPLAY_RESP" | sed '$d')"
REPLAY_ERR_CODE="$(extract_error_code "$REPLAY_BODY")"
# Sanitized diagnostic only: the normalized CODE, never the raw body.
printf "  (diagnostic) replay error code observed: %s\n" "${REPLAY_ERR_CODE:-<none>}"
if [ "$REPLAY_HTTP_CODE" = "409" ] && { [ "$REPLAY_ERR_CODE" = "APPROVAL_ALREADY_CONSUMED" ] || [ "$REPLAY_ERR_CODE" = "APPROVAL_NOT_PENDING" ]; }; then
  pass "Approval replay blocked" "HTTP 409 $REPLAY_ERR_CODE"
  log_result "approvalReplayBlocked" "PASS"
else
  fail "Approval replay blocked" "expected 409 with APPROVAL_ALREADY_CONSUMED or APPROVAL_NOT_PENDING, got HTTP $REPLAY_HTTP_CODE code=${REPLAY_ERR_CODE:-<none>}"
  log_result "approvalReplayBlocked" "FAIL"
  OVERALL_EXIT=1
fi

# cleanup() runs automatically via trap on exit from here, PASS or FAIL.
exit "$OVERALL_EXIT"

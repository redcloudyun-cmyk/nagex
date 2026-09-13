#!/usr/bin/env bash
#
# NAgex Memory Tenant Isolation Correction — dedicated Host Acceptance.
#
# Built by reading the exact current source at cf1a375 — not guessed:
#   - MemoryEngine (src/context/memory.engine.ts): proposeMemory(scope,
#     tenantId, ownerId, content, candidateId?), activateMemory(id,
#     tenantId, ownerId), deleteMemory(id, tenantId, ownerId),
#     getActiveMemories(scope, tenantId, ownerId), get(id, tenantId,
#     ownerId) (new — used only by the pin route below), findSeedMemory
#     ({scope, tenantId, ownerId, subject, predicate}). A tenant/owner
#     mismatch throws/returns MEMORY_NOT_FOUND, identical to a genuinely
#     nonexistent id (requireOwned()).
#   - GET  /api/v1/memory              -> lists ACTIVE USER/SESSION/AGENT/
#     TENANT memories for (tenantId, principal.id) from headers only.
#     Response: {memories:[{...record, pinned}], total}.
#   - POST /api/v1/memory              -> proposeMemory()+activateMemory()
#     in one call for (tenantId, principal.id); body {scope, subject,
#     predicate, value, pinned?}. Response 201: {...record, pinned}.
#   - DELETE /api/v1/memory/:id        -> ownership-checked deleteMemory();
#     success 200 {success:true, deleted_id}; failure -> thrown NagexError
#     caught by modelErrorResult() -> 404 nested shape
#     {error:{code:"MEMORY_NOT_FOUND", category, message, request_id}}.
#   - PUT  /api/v1/memory/:id/pin      -> ownership-checked via the new
#     memoryEngine.get(id, tenantId, principal.id) BEFORE toggling
#     pinnedMemories; failure -> 404 FLAT shape
#     {error:"MEMORY_NOT_FOUND", message} (server_web.ts's own inline
#     check, not a thrown NagexError); success 200 {success:true, pinned}.
#     extract_error_code() (shared lib) normalizes both the flat and
#     nested shapes above, reused unchanged here.
#   - There is NO GET-by-id route for Memory (unlike Approval's
#     GET /api/v1/approvals/:id) and NO standalone "activate" route (POST
#     always proposes+activates atomically for the SAME tenant/principal
#     in one call, so activateMemory's ownership check has no real
#     wrong-tenant/wrong-principal HTTP path to exercise). Confirmed via
#     direct source read, not assumed. Scenario 3 ("cross-tenant GET") is
#     therefore exercised via the PIN route's internal ownership-checked
#     get() lookup — the only real HTTP path that performs a pure
#     ownership-gated *read* — probed once against an UNPINNED record
#     (so it is a distinct proof from Scenario 5's genuine pin/unpin
#     toggle attempts against an ALREADY-pinned record). activateMemory's
#     own cross-tenant/cross-principal block is already directly verified
#     at the engine level by tests/memory_tenant_isolation.test.ts
#     (tests 3 and 6) — this script marks that explicitly as "verified by
#     local test suite" rather than fabricating a nonexistent HTTP call.
#   - getRelevantMemories(tenantId, principalId, prompt) (the sole AI
#     context-injection point) has no HTTP route exposing its raw output —
#     the closest, POST /api/v1/ambient/intent, only returns AI-generated
#     plan text, and the governing directive explicitly forbids relying on
#     model output for this proof (non-deterministic). Rather than add a
#     new gated test-only HTTP route to server_web.ts — which would
#     violate this directive's own "only this script may be changed"
#     constraint — this script uses a strictly narrower, zero-production-
#     diff mechanism: a one-shot `node -e` subprocess that requires() the
#     real, already-deployed compiled module
#     (dist/src/app/create-nagex-application.js) and calls the real,
#     unmodified app.getRelevantMemories(...) directly, pointed at the
#     exact same isolated NAGEX_MEMORIES_DIR the live service instance
#     uses. This opens no port, adds no server-side surface, is not
#     externally reachable, and touches zero git-tracked files — a
#     strictly safer proof than a new HTTP route would have been, while
#     satisfying the same goal (the real function, never model output).
#     Constructing createNagexApplication() this way is the exact same
#     safe pattern several existing tests already use in-process (e.g.
#     tests/persistent_memory.test.ts's P05-12); it performs no network
#     calls and starts no HTTP listener. Every OTHER store it constructs
#     (Task/Candidate/Conversation/...) resolves to the REAL production
#     directory (since only NAGEX_MEMORIES_DIR is overridden for this
#     one-shot process, exactly as Scenario 1 requires) but is only ever
#     read at construction time (readAll()), never written, since nothing
#     in this script ever calls a create/propose method on any of them —
#     confirmed via direct source read of every store constructor.
#   - Legacy backfill (src/context/memory.engine.ts constructor): a
#     record loaded with no tenantId is durably rewritten ONCE with
#     tenantId="ten_production_01" (an upgraded copy is written to disk
#     FIRST, the in-memory canonical record is only replaced after that
#     write succeeds); the backfill itself never touches lifecycle/
#     updated_at, so a byte-identical file after a second restart is a
#     real, direct proof that no repeat rewrite occurred.
#
# This script covers ONLY the dedicated Memory Tenant Isolation acceptance
# scenarios. It does NOT run nagex-check / nagex-e2e-live /
# nagex-task-e2e-live.sh — those remain separate, existing steps in the
# governing directive's own ladder.
#
# Isolation design: mirrors the V01a-R1 runtime-only /run systemd drop-in
# pattern exactly (see docs/ops/automated-testing.md Section 4) — a
# transient drop-in overrides ONLY NAGEX_MEMORIES_DIR for nagex.service
# (per the governing directive's own "same application/runtime otherwise"
# instruction: every other store keeps pointing at real production
# storage throughout this run), pointed at a throwaway directory under
# /var/lib/nagex, removed entirely in cleanup. Failure classification (for
# interpreting any FAIL this script reports):
#   A. harness defect            — this script's own assertion/logic is wrong
#   B. environment defect        — host/systemd/permissions/network issue
#   C. stale SHA/deploy          — running commit != cf1a375-or-later
#   D. Memory correction defect  — the actual tenant isolation code is wrong
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
  printf "  - temporarily override NAGEX_MEMORIES_DIR on the running nagex.service\n"
  printf "    (via a runtime-only /run systemd drop-in, removed in cleanup)\n"
  printf "  - restart nagex.service TWICE (once to enable isolated storage, once\n"
  printf "    mid-scenario as the actual restart-persistence check under test)\n"
  printf "  - restart nagex.service a THIRD time in cleanup to restore normal mode\n"
  printf "  - create and delete a small number of synthetic Memory records, all\n"
  printf "    under the isolated directory only — production Memory is never\n"
  printf "    written to by this script\n\n"
  printf "Continue? [y/N] "
  read -r REPLY
  case "$REPLY" in
    y|Y|yes|YES) ;;
    *) printf "\n[CANCELLED] Memory tenant isolation host acceptance aborted by user.\n\n"; exit 130 ;;
  esac
fi

BASE="${NAGEX_BASE_URL:-http://127.0.0.1:4100}"
SERVICE_NAME="${NAGEX_SERVICE_NAME:-nagex.service}"
DROPIN_DIR="/run/systemd/system/${SERVICE_NAME}.d"
DROPIN_FILE="${DROPIN_DIR}/90-nagex-memory-tenant-isolation-accept.conf"
ISOLATED_DIR="/var/lib/nagex/memory-tenant-isolation-accept-$(date +%s)-$$"
PROD_MEMORIES_DIR="/var/lib/nagex/memories"
APP_MODULE_PATH="${PROJECT_DIR}/dist/src/app/create-nagex-application.js"
NODE_BIN="$(command -v node)"

# Deterministic acceptance identities (per the governing directive).
TENANT_A="ten_memory_accept_a"
TENANT_B="ten_memory_accept_b"
OWNER_SHARED="usr_memory_shared"
TENANT_SAME="ten_memory_accept_same"
OWNER_A="usr_memory_owner_a"
OWNER_B="usr_memory_owner_b"
LEGACY_ID="mem_legacy_host_accept_001"
LEGACY_OWNER="usr_legacy_host_accept"
LEGACY_BACKFILL_TENANT="ten_production_01"
SEED_TENANT="ten_production_01"
SEED_OWNER="usr_admin_001"

LOG_DIR="$(resolve_log_dir)"
JSON_LOG_FILE="${LOG_DIR}/latest-memory-tenant-isolation-accept.json"
TIMESTAMP="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
COMMIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")"

OVERALL_EXIT=0
declare -A RESULTS
log_result() { RESULTS["$1"]="$2"; }

printf "\n==========================================\n"
printf " NAGEX MEMORY TENANT ISOLATION HOST ACCEPTANCE\n"
printf "==========================================\n"
printf "Base URL: %s\n" "$BASE"
printf "Commit:   %s\n" "$COMMIT_SHA"
printf "Isolated Memory dir: %s\n" "$ISOLATED_DIR"
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

# The isolated directory is created by this script running under sudo (so
# owned by root by default) but must be writable by whichever account
# nagex.service actually runs as, once the drop-in points it there — never
# guessed/hardcoded (e.g. assuming "redcloud"): resolved from the unit's
# own real, current User= setting. An empty value means the unit has no
# User= override and therefore runs as root, in which case root ownership
# is already correct and no chown is needed.
service_run_as_user() {
  systemctl show -p User --value "$SERVICE_NAME" 2>/dev/null || echo ""
}

# Reads /proc/<pid>/environ (null-separated) and checks whether the given
# variable name is present at all — never prints its value.
service_env_has_var() {
  local varname="$1" pid
  pid="$(service_main_pid)"
  if [ "$pid" = "0" ] || [ -z "$pid" ]; then return 1; fi
  sudo cat "/proc/${pid}/environ" 2>/dev/null | tr '\0' '\n' | grep -q "^${varname}="
}

# api_call_as(method, url, payload, tenant, principal) — generalizes the
# shared lib's api_call() (fixed to global TENANT/PRINCIPAL) so every
# scenario below can call the same route as an arbitrary identity pair.
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

# create_memory(tenant, principal, subject, predicate, value) -> prints the
# new memory's id on stdout only; every diagnostic goes to stderr (this
# runs inside $(...) at every call site).
create_memory() {
  local tenant="$1" principal="$2" subject="$3" predicate="$4" value="$5"
  local payload
  payload="$(node -e 'console.log(JSON.stringify({scope:"USER", subject:process.argv[1], predicate:process.argv[2], value:process.argv[3]}))' "$subject" "$predicate" "$value")"
  api_call_as POST "${BASE}/api/v1/memory" "$payload" "$tenant" "$principal"
  if [ "$API_CALL_STATUS" != "201" ]; then
    fail "create_memory(${subject})" "HTTP $API_CALL_STATUS: $(api_error_summary "$API_CALL_BODY")" >&2
    return 1
  fi
  local id
  id="$(json_get "$API_CALL_BODY" 'data.id')"
  if [ -z "$id" ]; then
    fail "create_memory(${subject})" "no id in response" >&2
    return 1
  fi
  printf '%s' "$id"
}

# list_contains(body, needle) -> "true"/"false" — does data.memories[].content
# JSON-contain the literal needle string.
list_contains() {
  local body="$1" needle="$2"
  json_get "$body" "data.memories.some(function(m){return JSON.stringify(m.content).indexOf('${needle}') >= 0;})"
}

# field_of(body, id, field) -> the named field (tenantId/pinned/...) of the
# memory with the given id in data.memories, or empty if absent.
field_of() {
  local body="$1" id="$2" field="$3"
  json_get "$body" "(data.memories.find(function(m){return m.id === '${id}';}) || {})['${field}']"
}

# Real getRelevantMemories() call, in-process, against the real deployed
# compiled module — never the running HTTP server, never model output.
# Prints the raw JSON array on stdout.
query_relevant_memories() {
  local tenant="$1" principal="$2" prompt="$3"
  sudo env NAGEX_MEMORIES_DIR="$ISOLATED_DIR" "$NODE_BIN" -e '
    const { createNagexApplication } = require(process.argv[1]);
    const app = createNagexApplication();
    const results = app.getRelevantMemories(process.argv[2], process.argv[3], process.argv[4]);
    console.log(JSON.stringify(results.map((m) => ({ id: m.id, tenantId: m.tenantId, owner_id: m.owner_id, content: m.content }))));
  ' "$APP_MODULE_PATH" "$tenant" "$principal" "$prompt"
}

# ── State tracked across the whole run, for cleanup ─────────────────────

ISOLATION_ACTIVE=false
PROD_MEMORIES_COUNT_BEFORE=""

cleanup() {
  local cleanup_ok=true
  printf "\n${COLOR_BOLD}Cleanup${COLOR_NC}\n"
  printf '%s\n' '------------------------------------------'

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

    if service_env_has_var "NAGEX_MEMORIES_DIR"; then
      fail "Isolated memory override absent from service env" "still present"
      log_result "cleanupOverrideAbsent" "FAIL"
      cleanup_ok=false
    else
      pass "Isolated memory override absent from service env"
      log_result "cleanupOverrideAbsent" "PASS"
    fi
  fi

  sudo rm -rf "$ISOLATED_DIR" 2>/dev/null || true

  if [ -n "$PROD_MEMORIES_COUNT_BEFORE" ]; then
    local prod_count_after
    prod_count_after="$(sudo find "$PROD_MEMORIES_DIR" -maxdepth 1 -name '*.json' 2>/dev/null | wc -l | tr -d ' ')"
    if [ "$prod_count_after" = "$PROD_MEMORIES_COUNT_BEFORE" ]; then
      pass "PRODUCTION_MEMORY_UNTOUCHED" "file count unchanged ($prod_count_after)"
      log_result "PRODUCTION_MEMORY_UNTOUCHED" "PASS"
    else
      fail "PRODUCTION_MEMORY_UNTOUCHED" "before=$PROD_MEMORIES_COUNT_BEFORE after=$prod_count_after"
      log_result "PRODUCTION_MEMORY_UNTOUCHED" "FAIL"
      cleanup_ok=false
    fi
  else
    warn "PRODUCTION_MEMORY_UNTOUCHED" "baseline count unavailable, skipped"
    log_result "PRODUCTION_MEMORY_UNTOUCHED" "WARN"
  fi

  if systemctl is-active --quiet "$SERVICE_NAME"; then
    pass "SERVICE_RESTORED" "$SERVICE_NAME is active"
    log_result "SERVICE_RESTORED" "PASS"
  else
    fail "SERVICE_RESTORED" "$SERVICE_NAME is not active"
    log_result "SERVICE_RESTORED" "FAIL"
    cleanup_ok=false
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
    printf "MEMORY TENANT ISOLATION HOST ACCEPTANCE: ${COLOR_GREEN}PASS${COLOR_NC}\n\n"
  else
    printf "MEMORY TENANT ISOLATION HOST ACCEPTANCE: ${COLOR_RED}FAIL${COLOR_NC}\n\n"
  fi

  exit "$OVERALL_EXIT"
}

trap cleanup EXIT INT TERM

# ── Baseline: production Memory directory, untouched throughout ────────
section "Baseline"
PROD_MEMORIES_COUNT_BEFORE="$(sudo find "$PROD_MEMORIES_DIR" -maxdepth 1 -name '*.json' 2>/dev/null | wc -l | tr -d ' ')"
printf "  Production Memory file count before: %s\n" "$PROD_MEMORIES_COUNT_BEFORE"

# ── Scenario 9 setup — seed the legacy fixture BEFORE the first isolated
# startup, so that startup itself performs the real backfill ─────────────
section "Scenario 9 setup: seed legacy-format fixture (no tenantId)"
sudo mkdir -p "$ISOLATED_DIR"
SERVICE_USER="$(service_run_as_user)"
if [ -n "$SERVICE_USER" ]; then
  sudo chown "${SERVICE_USER}" "$ISOLATED_DIR"
  pass "Isolated dir owned by real service account" "$SERVICE_USER (resolved via systemctl show, not guessed)"
else
  pass "Isolated dir left root-owned" "${SERVICE_NAME} has no User= override, runs as root"
fi
LEGACY_FIXTURE_JSON="$(node -e '
  const now = new Date().toISOString();
  console.log(JSON.stringify({
    id: process.argv[1],
    scope: "USER",
    owner_id: process.argv[2],
    lifecycle: "ACTIVE",
    content: { subject: "Legacy Host Fixture", predicate: "is", value: "pre-tenant-correction record" },
    created_at: now,
    updated_at: now,
  }));
' "$LEGACY_ID" "$LEGACY_OWNER")"
printf '%s' "$LEGACY_FIXTURE_JSON" | sudo tee "${ISOLATED_DIR}/${LEGACY_ID}.json" >/dev/null
if [ -n "$SERVICE_USER" ]; then
  sudo chown "${SERVICE_USER}" "${ISOLATED_DIR}/${LEGACY_ID}.json"
fi
sudo chmod 600 "${ISOLATED_DIR}/${LEGACY_ID}.json"
sudo chmod 700 "$ISOLATED_DIR"
pass "Legacy fixture seeded" "$LEGACY_ID (no tenantId)"

# ── Scenario 1 — isolated service startup ────────────────────────────────
section "Scenario 1: Exact Isolated Service Startup"
sudo mkdir -p "$DROPIN_DIR"
{
  printf '[Service]\n'
  printf 'Environment=NAGEX_MEMORIES_DIR=%s\n' "$ISOLATED_DIR"
} | sudo tee "$DROPIN_FILE" >/dev/null
ISOLATION_ACTIVE=true
sudo chmod 600 "$DROPIN_FILE"
sudo systemctl daemon-reload
sudo systemctl restart "$SERVICE_NAME"
if wait_for_health; then
  pass "Service started under isolated Memory storage"
  log_result "ISOLATED_STARTUP" "PASS"
else
  fail "Service started under isolated Memory storage" "health check did not return within timeout"
  log_result "ISOLATED_STARTUP" "FAIL"
  OVERALL_EXIT=1
  exit 1
fi
if service_env_has_var "NAGEX_MEMORIES_DIR"; then
  pass "Isolated memory override present in service env"
else
  fail "Isolated memory override present in service env" "not found"
  OVERALL_EXIT=1
fi

# ── Scenario 9 verification — legacy backfill ────────────────────────────
section "Scenario 9: Legacy Backfill"
api_call_as GET "${BASE}/api/v1/memory" "" "$LEGACY_BACKFILL_TENANT" "$LEGACY_OWNER"
LEGACY_TENANT_AFTER="$(field_of "$API_CALL_BODY" "$LEGACY_ID" "tenantId")"
if [ "$API_CALL_STATUS" = "200" ] && [ "$LEGACY_TENANT_AFTER" = "$LEGACY_BACKFILL_TENANT" ]; then
  pass "LEGACY_BACKFILL" "record loaded, tenantId=${LEGACY_TENANT_AFTER}"
  log_result "LEGACY_BACKFILL" "PASS"
else
  fail "LEGACY_BACKFILL" "HTTP $API_CALL_STATUS tenantId=${LEGACY_TENANT_AFTER}"
  log_result "LEGACY_BACKFILL" "FAIL"
  OVERALL_EXIT=1
fi

LEGACY_ON_DISK_AFTER_FIRST="$(sudo cat "${ISOLATED_DIR}/${LEGACY_ID}.json" 2>/dev/null || echo "")"
LEGACY_FILE_COUNT="$(sudo find "$ISOLATED_DIR" -maxdepth 1 -name "${LEGACY_ID}*.json" 2>/dev/null | wc -l | tr -d ' ')"
if printf '%s' "$LEGACY_ON_DISK_AFTER_FIRST" | grep -q "\"tenantId\":\"${LEGACY_BACKFILL_TENANT}\"" && [ "$LEGACY_FILE_COUNT" = "1" ]; then
  pass "LEGACY_BACKFILL_DURABLE" "on-disk file carries tenantId, no duplicate file"
  log_result "LEGACY_BACKFILL_DURABLE" "PASS"
else
  fail "LEGACY_BACKFILL_DURABLE" "file_count=$LEGACY_FILE_COUNT"
  log_result "LEGACY_BACKFILL_DURABLE" "FAIL"
  OVERALL_EXIT=1
fi

# ── Scenario 10 — seed regression ────────────────────────────────────────
section "Scenario 10: Seed Regression"
api_call_as GET "${BASE}/api/v1/memory" "" "$SEED_TENANT" "$SEED_OWNER"
SEED_COUNT="$(json_get "$API_CALL_BODY" "data.memories.filter(function(m){return m.id !== '${LEGACY_ID}';}).length")"
if [ "$API_CALL_STATUS" = "200" ] && [ "$SEED_COUNT" = "4" ]; then
  pass "SEED_TENANT_ASSIGNMENT" "exactly 4 seed memories, tenant=${SEED_TENANT}"
  log_result "SEED_TENANT_ASSIGNMENT" "PASS"
else
  fail "SEED_TENANT_ASSIGNMENT" "HTTP $API_CALL_STATUS seed_count=$SEED_COUNT"
  log_result "SEED_TENANT_ASSIGNMENT" "FAIL"
  OVERALL_EXIT=1
fi
SEED_IDS_FIRST="$(json_get "$API_CALL_BODY" "JSON.stringify(data.memories.filter(function(m){return m.id !== '${LEGACY_ID}';}).map(function(m){return m.id;}).sort())")"

# ── Scenario 2 — cross-tenant list isolation ─────────────────────────────
section "Scenario 2: Same Principal / Different Tenant — List Isolation"
MEM_A="$(create_memory "$TENANT_A" "$OWNER_SHARED" "Tenant A Secret" "note" "only-visible-to-tenant-a")"
MEM_B="$(create_memory "$TENANT_B" "$OWNER_SHARED" "Tenant B Secret" "note" "only-visible-to-tenant-b")"

api_call_as GET "${BASE}/api/v1/memory" "" "$TENANT_A" "$OWNER_SHARED"
LIST_A_HAS_A="$(list_contains "$API_CALL_BODY" 'only-visible-to-tenant-a')"
LIST_A_HAS_B="$(list_contains "$API_CALL_BODY" 'only-visible-to-tenant-b')"
api_call_as GET "${BASE}/api/v1/memory" "" "$TENANT_B" "$OWNER_SHARED"
LIST_B_HAS_A="$(list_contains "$API_CALL_BODY" 'only-visible-to-tenant-a')"
LIST_B_HAS_B="$(list_contains "$API_CALL_BODY" 'only-visible-to-tenant-b')"

if [ "$LIST_A_HAS_A" = "true" ] && [ "$LIST_A_HAS_B" = "false" ] && [ "$LIST_B_HAS_B" = "true" ] && [ "$LIST_B_HAS_A" = "false" ]; then
  pass "CROSS_TENANT_LIST_ISOLATION" "A sees only A, B sees only B"
  log_result "CROSS_TENANT_LIST_ISOLATION" "PASS"
else
  fail "CROSS_TENANT_LIST_ISOLATION" "A(has_a=$LIST_A_HAS_A,has_b=$LIST_A_HAS_B) B(has_a=$LIST_B_HAS_A,has_b=$LIST_B_HAS_B)"
  log_result "CROSS_TENANT_LIST_ISOLATION" "FAIL"
  OVERALL_EXIT=1
fi

# ── Scenario 3 — cross-tenant "GET" via the pin route's ownership check ──
section "Scenario 3: Cross-Tenant GET (via ownership-checked pin-route lookup)"
api_call_as PUT "${BASE}/api/v1/memory/${MEM_A}/pin" "" "$TENANT_B" "$OWNER_SHARED"
GET_BLOCK_CODE="$(extract_error_code "$API_CALL_BODY")"
if [ "$API_CALL_STATUS" = "404" ] && [ "$GET_BLOCK_CODE" = "MEMORY_NOT_FOUND" ]; then
  pass "CROSS_TENANT_GET_BLOCK" "HTTP 404 MEMORY_NOT_FOUND"
  log_result "CROSS_TENANT_GET_BLOCK" "PASS"
else
  fail "CROSS_TENANT_GET_BLOCK" "HTTP $API_CALL_STATUS code=$GET_BLOCK_CODE"
  log_result "CROSS_TENANT_GET_BLOCK" "FAIL"
  OVERALL_EXIT=1
fi
api_call_as GET "${BASE}/api/v1/memory" "" "$TENANT_A" "$OWNER_SHARED"
MEM_A_PINNED_AFTER_BLOCKED_GET="$(field_of "$API_CALL_BODY" "$MEM_A" "pinned")"
if [ "$MEM_A_PINNED_AFTER_BLOCKED_GET" = "false" ]; then
  pass "Blocked cross-tenant GET caused no mutation" "pinned still false"
else
  fail "Blocked cross-tenant GET caused no mutation" "pinned=$MEM_A_PINNED_AFTER_BLOCKED_GET"
  OVERALL_EXIT=1
fi

# ── Scenario 4 — cross-tenant DELETE ──────────────────────────────────────
section "Scenario 4: Cross-Tenant DELETE"
api_call_as DELETE "${BASE}/api/v1/memory/${MEM_A}" "" "$TENANT_B" "$OWNER_SHARED"
DELETE_BLOCK_CODE="$(extract_error_code "$API_CALL_BODY")"
if [ "$API_CALL_STATUS" = "404" ] && [ "$DELETE_BLOCK_CODE" = "MEMORY_NOT_FOUND" ]; then
  pass "CROSS_TENANT_DELETE_BLOCK" "HTTP 404 MEMORY_NOT_FOUND"
  log_result "CROSS_TENANT_DELETE_BLOCK" "PASS"
else
  fail "CROSS_TENANT_DELETE_BLOCK" "HTTP $API_CALL_STATUS code=$DELETE_BLOCK_CODE"
  log_result "CROSS_TENANT_DELETE_BLOCK" "FAIL"
  OVERALL_EXIT=1
fi
api_call_as GET "${BASE}/api/v1/memory" "" "$TENANT_A" "$OWNER_SHARED"
STILL_EXISTS_AFTER_BLOCKED_DELETE="$(list_contains "$API_CALL_BODY" 'only-visible-to-tenant-a')"
if [ "$STILL_EXISTS_AFTER_BLOCKED_DELETE" = "true" ]; then
  pass "BLOCKED_DELETE_NO_MUTATION" "original still exists for tenant A"
  log_result "BLOCKED_DELETE_NO_MUTATION" "PASS"
else
  fail "BLOCKED_DELETE_NO_MUTATION" "original no longer visible to tenant A"
  log_result "BLOCKED_DELETE_NO_MUTATION" "FAIL"
  OVERALL_EXIT=1
fi

# ── Scenario 5 — cross-tenant PIN / UNPIN (against an already-pinned record) ─
section "Scenario 5: Cross-Tenant PIN / UNPIN"
api_call_as PUT "${BASE}/api/v1/memory/${MEM_A}/pin" "" "$TENANT_A" "$OWNER_SHARED"
if [ "$API_CALL_STATUS" != "200" ] || [ "$(json_get "$API_CALL_BODY" 'data.pinned')" != "true" ]; then
  fail "Rightful pre-pin (setup for Scenario 5)" "HTTP $API_CALL_STATUS $(api_error_summary "$API_CALL_BODY")"
  OVERALL_EXIT=1
fi

api_call_as PUT "${BASE}/api/v1/memory/${MEM_A}/pin" "" "$TENANT_B" "$OWNER_SHARED"
PIN_BLOCK_CODE="$(extract_error_code "$API_CALL_BODY")"
if [ "$API_CALL_STATUS" = "404" ] && [ "$PIN_BLOCK_CODE" = "MEMORY_NOT_FOUND" ]; then
  pass "CROSS_TENANT_PIN_BLOCK" "HTTP 404 MEMORY_NOT_FOUND"
  log_result "CROSS_TENANT_PIN_BLOCK" "PASS"
else
  fail "CROSS_TENANT_PIN_BLOCK" "HTTP $API_CALL_STATUS code=$PIN_BLOCK_CODE"
  log_result "CROSS_TENANT_PIN_BLOCK" "FAIL"
  OVERALL_EXIT=1
fi

api_call_as PUT "${BASE}/api/v1/memory/${MEM_A}/pin" "" "$TENANT_B" "$OWNER_SHARED"
UNPIN_BLOCK_CODE="$(extract_error_code "$API_CALL_BODY")"
if [ "$API_CALL_STATUS" = "404" ] && [ "$UNPIN_BLOCK_CODE" = "MEMORY_NOT_FOUND" ]; then
  pass "CROSS_TENANT_UNPIN_BLOCK" "HTTP 404 MEMORY_NOT_FOUND"
  log_result "CROSS_TENANT_UNPIN_BLOCK" "PASS"
else
  fail "CROSS_TENANT_UNPIN_BLOCK" "HTTP $API_CALL_STATUS code=$UNPIN_BLOCK_CODE"
  log_result "CROSS_TENANT_UNPIN_BLOCK" "FAIL"
  OVERALL_EXIT=1
fi

api_call_as GET "${BASE}/api/v1/memory" "" "$TENANT_A" "$OWNER_SHARED"
MEM_A_PINNED_AFTER_BLOCKS="$(field_of "$API_CALL_BODY" "$MEM_A" "pinned")"
if [ "$MEM_A_PINNED_AFTER_BLOCKS" = "true" ]; then
  pass "Original pin state unchanged by both blocked attempts"
else
  fail "Original pin state unchanged by both blocked attempts" "pinned=$MEM_A_PINNED_AFTER_BLOCKS"
  OVERALL_EXIT=1
fi

# ── Scenario 6 — same tenant / wrong principal ───────────────────────────
section "Scenario 6: Same Tenant / Wrong Principal"
MEM_SAME="$(create_memory "$TENANT_SAME" "$OWNER_A" "Owner A Secret" "note" "only-visible-to-owner-a")"

api_call_as GET "${BASE}/api/v1/memory" "" "$TENANT_SAME" "$OWNER_B"
SAME_TENANT_B_SEES_A="$(list_contains "$API_CALL_BODY" 'only-visible-to-owner-a')"
if [ "$SAME_TENANT_B_SEES_A" = "false" ]; then
  pass "SAME_TENANT_WRONG_PRINCIPAL_LIST_BLOCK" "owner B list does not contain owner A's memory"
  log_result "SAME_TENANT_WRONG_PRINCIPAL_LIST_BLOCK" "PASS"
else
  fail "SAME_TENANT_WRONG_PRINCIPAL_LIST_BLOCK" "owner B list unexpectedly contains it"
  log_result "SAME_TENANT_WRONG_PRINCIPAL_LIST_BLOCK" "FAIL"
  OVERALL_EXIT=1
fi

api_call_as PUT "${BASE}/api/v1/memory/${MEM_SAME}/pin" "" "$TENANT_SAME" "$OWNER_B"
if [ "$API_CALL_STATUS" = "404" ] && [ "$(extract_error_code "$API_CALL_BODY")" = "MEMORY_NOT_FOUND" ]; then
  pass "SAME_TENANT_WRONG_PRINCIPAL_GET_BLOCK" "HTTP 404 MEMORY_NOT_FOUND (via pin-route ownership check)"
  log_result "SAME_TENANT_WRONG_PRINCIPAL_GET_BLOCK" "PASS"
  log_result "SAME_TENANT_WRONG_PRINCIPAL_PIN_BLOCK" "PASS"
else
  fail "SAME_TENANT_WRONG_PRINCIPAL_GET_BLOCK" "HTTP $API_CALL_STATUS $(api_error_summary "$API_CALL_BODY")"
  log_result "SAME_TENANT_WRONG_PRINCIPAL_GET_BLOCK" "FAIL"
  log_result "SAME_TENANT_WRONG_PRINCIPAL_PIN_BLOCK" "FAIL"
  OVERALL_EXIT=1
fi

api_call_as DELETE "${BASE}/api/v1/memory/${MEM_SAME}" "" "$TENANT_SAME" "$OWNER_B"
if [ "$API_CALL_STATUS" = "404" ] && [ "$(extract_error_code "$API_CALL_BODY")" = "MEMORY_NOT_FOUND" ]; then
  pass "SAME_TENANT_WRONG_PRINCIPAL_DELETE_BLOCK" "HTTP 404 MEMORY_NOT_FOUND"
  log_result "SAME_TENANT_WRONG_PRINCIPAL_DELETE_BLOCK" "PASS"
else
  fail "SAME_TENANT_WRONG_PRINCIPAL_DELETE_BLOCK" "HTTP $API_CALL_STATUS $(api_error_summary "$API_CALL_BODY")"
  log_result "SAME_TENANT_WRONG_PRINCIPAL_DELETE_BLOCK" "FAIL"
  OVERALL_EXIT=1
fi
api_call_as GET "${BASE}/api/v1/memory" "" "$TENANT_SAME" "$OWNER_A"
SAME_STILL_EXISTS="$(list_contains "$API_CALL_BODY" 'only-visible-to-owner-a')"
if [ "$SAME_STILL_EXISTS" = "true" ]; then
  pass "Owner A's record survives the blocked owner-B delete attempt"
else
  fail "Owner A's record survives the blocked owner-B delete attempt" "no longer visible"
  OVERALL_EXIT=1
fi

pass "SAME_TENANT_WRONG_PRINCIPAL_ACTIVATE_BLOCK" "no standalone activate HTTP route exists (POST proposes+activates atomically for the requester's own identity only) — verified directly at the engine level by tests/memory_tenant_isolation.test.ts (tests 3, 6), not re-tested here"
log_result "SAME_TENANT_WRONG_PRINCIPAL_ACTIVATE_BLOCK" "PASS (verified by local test suite)"

# ── Scenario 7 — AI-context retrieval isolation (decisive test) ─────────
section "Scenario 7: AI-Context Retrieval Isolation"
SECRET_PHRASE="MEMORY_TENANT_A_SECRET_91F3"
MEM_AI="$(create_memory "$TENANT_A" "$OWNER_SHARED" "AI Context Secret" "codename" "$SECRET_PHRASE")"
AI_PROMPT="Tell me about the ${SECRET_PHRASE} codename project"

AI_RESULT_A="$(query_relevant_memories "$TENANT_A" "$OWNER_SHARED" "$AI_PROMPT")"
AI_A_CONTAINS="$(json_get "$AI_RESULT_A" "data.some(function(m){return JSON.stringify(m.content).indexOf('${SECRET_PHRASE}') >= 0;})")"
if [ "$AI_A_CONTAINS" = "true" ]; then
  pass "AI_CONTEXT_RIGHTFUL_RETRIEVAL" "tenant A retrieval contains the distinctive memory"
  log_result "AI_CONTEXT_RIGHTFUL_RETRIEVAL" "PASS"
else
  fail "AI_CONTEXT_RIGHTFUL_RETRIEVAL" "tenant A retrieval did not contain it: $AI_RESULT_A"
  log_result "AI_CONTEXT_RIGHTFUL_RETRIEVAL" "FAIL"
  OVERALL_EXIT=1
fi

AI_RESULT_B="$(query_relevant_memories "$TENANT_B" "$OWNER_SHARED" "$AI_PROMPT")"
AI_B_CONTAINS="$(json_get "$AI_RESULT_B" "data.some(function(m){return JSON.stringify(m.content).indexOf('${SECRET_PHRASE}') >= 0;})")"
if [ "$AI_B_CONTAINS" = "false" ]; then
  pass "AI_CONTEXT_CROSS_TENANT_BLOCK" "tenant B retrieval (same owner, matching prompt) does not contain it"
  log_result "AI_CONTEXT_CROSS_TENANT_BLOCK" "PASS"
else
  fail "AI_CONTEXT_CROSS_TENANT_BLOCK" "tenant B retrieval unexpectedly contains it: $AI_RESULT_B"
  log_result "AI_CONTEXT_CROSS_TENANT_BLOCK" "FAIL"
  OVERALL_EXIT=1
fi

# Same-tenant / wrong-principal half of Scenario 6's "retrieve" requirement.
AI_RESULT_SAME_B="$(query_relevant_memories "$TENANT_SAME" "$OWNER_B" "Tell me about only-visible-to-owner-a")"
AI_SAME_B_CONTAINS="$(json_get "$AI_RESULT_SAME_B" "data.some(function(m){return JSON.stringify(m.content).indexOf('only-visible-to-owner-a') >= 0;})")"
if [ "$AI_SAME_B_CONTAINS" = "false" ]; then
  pass "SAME_TENANT_WRONG_PRINCIPAL_RETRIEVE_BLOCK" "owner B's AI context does not contain owner A's memory"
  log_result "SAME_TENANT_WRONG_PRINCIPAL_RETRIEVE_BLOCK" "PASS"
else
  fail "SAME_TENANT_WRONG_PRINCIPAL_RETRIEVE_BLOCK" "unexpectedly contains it"
  log_result "SAME_TENANT_WRONG_PRINCIPAL_RETRIEVE_BLOCK" "FAIL"
  OVERALL_EXIT=1
fi

# ── Scenario 11 — rightful mutation lifecycle ────────────────────────────
section "Scenario 11: Rightful Owner Full Lifecycle"
MEM_LIFECYCLE="$(create_memory "$TENANT_A" "$OWNER_SHARED" "Lifecycle Test" "note" "rightful-lifecycle-record")"
api_call_as PUT "${BASE}/api/v1/memory/${MEM_LIFECYCLE}/pin" "" "$TENANT_A" "$OWNER_SHARED"
PIN_OK=$([ "$API_CALL_STATUS" = "200" ] && [ "$(json_get "$API_CALL_BODY" 'data.pinned')" = "true" ] && echo 1 || echo 0)
api_call_as PUT "${BASE}/api/v1/memory/${MEM_LIFECYCLE}/pin" "" "$TENANT_A" "$OWNER_SHARED"
UNPIN_OK=$([ "$API_CALL_STATUS" = "200" ] && [ "$(json_get "$API_CALL_BODY" 'data.pinned')" = "false" ] && echo 1 || echo 0)
api_call_as DELETE "${BASE}/api/v1/memory/${MEM_LIFECYCLE}" "" "$TENANT_A" "$OWNER_SHARED"
DELETE_OK=$([ "$API_CALL_STATUS" = "200" ] && echo 1 || echo 0)
if [ "$PIN_OK" = "1" ] && [ "$UNPIN_OK" = "1" ] && [ "$DELETE_OK" = "1" ]; then
  pass "RIGHTFUL_MEMORY_LIFECYCLE" "create(implicit activate)/pin/unpin/delete all succeeded for the rightful owner"
  log_result "RIGHTFUL_MEMORY_LIFECYCLE" "PASS"
else
  fail "RIGHTFUL_MEMORY_LIFECYCLE" "pin_ok=$PIN_OK unpin_ok=$UNPIN_OK delete_ok=$DELETE_OK"
  log_result "RIGHTFUL_MEMORY_LIFECYCLE" "FAIL"
  OVERALL_EXIT=1
fi

# ── Scenario 8 — restart persistence ──────────────────────────────────────
section "Scenario 8: Restart Persistence"
sudo systemctl restart "$SERVICE_NAME"
if ! wait_for_health; then
  fail "Service restarted (still isolated mode)" "health check did not return within timeout"
  log_result "MEMORY_RESTART_PERSISTENCE" "FAIL"
  OVERALL_EXIT=1
else
  api_call_as GET "${BASE}/api/v1/memory" "" "$TENANT_A" "$OWNER_SHARED"
  TENANT_A_TENANTID_AFTER_RESTART="$(field_of "$API_CALL_BODY" "$MEM_A" "tenantId")"
  RIGHTFUL_VISIBLE_AFTER_RESTART="$(list_contains "$API_CALL_BODY" 'only-visible-to-tenant-a')"
  if [ "$TENANT_A_TENANTID_AFTER_RESTART" = "$TENANT_A" ] && [ "$RIGHTFUL_VISIBLE_AFTER_RESTART" = "true" ]; then
    pass "MEMORY_RESTART_PERSISTENCE" "tenantId + rightful visibility survive restart"
    log_result "MEMORY_RESTART_PERSISTENCE" "PASS"
  else
    fail "MEMORY_RESTART_PERSISTENCE" "tenantId=$TENANT_A_TENANTID_AFTER_RESTART visible=$RIGHTFUL_VISIBLE_AFTER_RESTART"
    log_result "MEMORY_RESTART_PERSISTENCE" "FAIL"
    OVERALL_EXIT=1
  fi

  api_call_as GET "${BASE}/api/v1/memory" "" "$TENANT_B" "$OWNER_SHARED"
  CROSS_TENANT_STILL_ISOLATED="$(list_contains "$API_CALL_BODY" 'only-visible-to-tenant-a')"
  api_call_as GET "${BASE}/api/v1/memory" "" "$TENANT_A" "$OWNER_SHARED"
  MEM_A_PIN_AFTER_RESTART_RIGHTFUL="$(field_of "$API_CALL_BODY" "$MEM_A" "pinned")"
  if [ "$CROSS_TENANT_STILL_ISOLATED" = "false" ] && [ "$MEM_A_PIN_AFTER_RESTART_RIGHTFUL" = "true" ]; then
    pass "MEMORY_ISOLATION_AFTER_RESTART" "cross-tenant isolation and pin state both correct after restart"
    log_result "MEMORY_ISOLATION_AFTER_RESTART" "PASS"
  else
    fail "MEMORY_ISOLATION_AFTER_RESTART" "cross_tenant_isolated=$CROSS_TENANT_STILL_ISOLATED pinned=$MEM_A_PIN_AFTER_RESTART_RIGHTFUL"
    log_result "MEMORY_ISOLATION_AFTER_RESTART" "FAIL"
    OVERALL_EXIT=1
  fi
fi

# ── Scenario 9 idempotency (second startup must not rewrite/duplicate) ──
section "Scenario 9 (continued): Legacy Backfill Idempotency"
LEGACY_ON_DISK_AFTER_SECOND="$(sudo cat "${ISOLATED_DIR}/${LEGACY_ID}.json" 2>/dev/null || echo "")"
LEGACY_FILE_COUNT_AFTER_SECOND="$(sudo find "$ISOLATED_DIR" -maxdepth 1 -name "${LEGACY_ID}*.json" 2>/dev/null | wc -l | tr -d ' ')"
if [ "$LEGACY_ON_DISK_AFTER_FIRST" = "$LEGACY_ON_DISK_AFTER_SECOND" ] && [ "$LEGACY_FILE_COUNT_AFTER_SECOND" = "1" ]; then
  pass "LEGACY_BACKFILL_IDEMPOTENT" "file byte-identical across the second restart, no duplicate"
  log_result "LEGACY_BACKFILL_IDEMPOTENT" "PASS"
else
  fail "LEGACY_BACKFILL_IDEMPOTENT" "file changed or duplicated after second restart"
  log_result "LEGACY_BACKFILL_IDEMPOTENT" "FAIL"
  OVERALL_EXIT=1
fi

# ── Scenario 10 (continued): seed idempotency across restart ────────────
api_call_as GET "${BASE}/api/v1/memory" "" "$SEED_TENANT" "$SEED_OWNER"
SEED_COUNT_AFTER_RESTART="$(json_get "$API_CALL_BODY" "data.memories.filter(function(m){return m.id !== '${LEGACY_ID}';}).length")"
SEED_IDS_AFTER_RESTART="$(json_get "$API_CALL_BODY" "JSON.stringify(data.memories.filter(function(m){return m.id !== '${LEGACY_ID}';}).map(function(m){return m.id;}).sort())")"
if [ "$SEED_COUNT_AFTER_RESTART" = "4" ] && [ "$SEED_IDS_AFTER_RESTART" = "$SEED_IDS_FIRST" ]; then
  pass "SEED_IDEMPOTENCY" "still exactly 4 seeds, same IDs, after restart"
  log_result "SEED_IDEMPOTENCY" "PASS"
else
  fail "SEED_IDEMPOTENCY" "count=$SEED_COUNT_AFTER_RESTART ids=$SEED_IDS_AFTER_RESTART (expected $SEED_IDS_FIRST)"
  log_result "SEED_IDEMPOTENCY" "FAIL"
  OVERALL_EXIT=1
fi

# Cleanup runs automatically via the EXIT trap.

#!/usr/bin/env bash
#
# Common helper functions and configuration for NAgex deployment checks.
#

set -euo pipefail

# ── ANSI Color Support (TTY only) ──────────────────────────────────────────
if [ -t 1 ]; then
  COLOR_RED='\033[0;31m'
  COLOR_GREEN='\033[0;32m'
  COLOR_YELLOW='\033[0;33m'
  COLOR_BLUE='\033[0;34m'
  COLOR_BOLD='\033[1m'
  COLOR_NC='\033[0m'
else
  COLOR_RED=''
  COLOR_GREEN=''
  COLOR_YELLOW=''
  COLOR_BLUE=''
  COLOR_BOLD=''
  COLOR_NC=''
fi

# ── Output Formatting ──────────────────────────────────────────────────────
pass() {
  local label="$1"
  local extra="${2:-}"
  if [ -n "$extra" ]; then
    printf "  %-35s ${COLOR_GREEN}PASS${COLOR_NC} (%s)\n" "$label" "$extra"
  else
    printf "  %-35s ${COLOR_GREEN}PASS${COLOR_NC}\n" "$label"
  fi
}

fail() {
  local label="$1"
  local extra="${2:-}"
  if [ -n "$extra" ]; then
    printf "  %-35s ${COLOR_RED}FAIL${COLOR_NC} (%s)\n" "$label" "$extra"
  else
    printf "  %-35s ${COLOR_RED}FAIL${COLOR_NC}\n" "$label"
  fi
}

warn() {
  local label="$1"
  local extra="${2:-}"
  if [ -n "$extra" ]; then
    printf "  %-35s ${COLOR_YELLOW}WARN${COLOR_NC} (%s)\n" "$label" "$extra"
  else
    printf "  %-35s ${COLOR_YELLOW}WARN${COLOR_NC}\n" "$label"
  fi
}

skip() {
  local label="$1"
  local extra="${2:-}"
  if [ -n "$extra" ]; then
    printf "  %-35s ${COLOR_BLUE}SKIP${COLOR_NC} (%s)\n" "$label" "$extra"
  else
    printf "  %-35s ${COLOR_BLUE}SKIP${COLOR_NC}\n" "$label"
  fi
}

section() {
  printf "\n${COLOR_BOLD}%s${COLOR_NC}\n" "$1"
  printf '%s\n' '------------------------------------------'
}

require_command() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    printf "ERROR: Required command '%s' is not installed or not in PATH.\n" "$cmd" >&2
    exit 2
  fi
}

require_file() {
  local file="$1"
  if [ ! -f "$file" ]; then
    printf "ERROR: Required file '%s' does not exist.\n" "$file" >&2
    exit 2
  fi
}

json_get() {
  local json_data="$1"
  local expr="$2"
  node -e "
    try {
      const data = JSON.parse(process.argv[1]);
      const res = ${expr};
      if (res !== undefined && res !== null) {
        console.log(typeof res === 'object' ? JSON.stringify(res) : String(res));
      }
    } catch (e) {}
  " "$json_data" 2>/dev/null || echo ""
}

# Performs an HTTP call and always separates the real HTTP status code from
# the response body, storing both in the caller-visible globals
# API_CALL_STATUS and API_CALL_BODY. Callers of the shell harnesses in this
# repo have, in the past, parsed only a field out of the body (e.g.
# `data.status`) and treated a missing field as an "empty" but otherwise
# valid result — that silently hides a real HTTP/API failure (a 400/403/500
# whose error envelope has no `.status` key at all) behind a blank string.
# Every live harness call MUST check API_CALL_STATUS (or use
# api_error_summary below) rather than trusting a parsed field alone.
# Relies on TENANT/PRINCIPAL already being set by the calling script (both
# nagex-check.sh and nagex-e2e-live.sh already define them).
api_call() {
  local method="$1"
  local url="$2"
  local payload="${3:-}"
  local raw
  if [ -n "$payload" ]; then
    raw="$(curl -s -w '\n%{http_code}' -X "$method" -H "Content-Type: application/json" -H "x-nagex-tenant: ${TENANT}" -H "x-principal-id: ${PRINCIPAL}" -d "$payload" "$url" 2>/dev/null || printf '\n000')"
  else
    raw="$(curl -s -w '\n%{http_code}' -X "$method" -H "x-nagex-tenant: ${TENANT}" -H "x-principal-id: ${PRINCIPAL}" "$url" 2>/dev/null || printf '\n000')"
  fi
  API_CALL_STATUS="$(printf '%s' "$raw" | tail -n1)"
  API_CALL_BODY="$(printf '%s' "$raw" | sed '$d')"
}

# Extracts a sanitized error code/message from a response body for
# diagnostic printing on failure. Deliberately prints only `.error.code` /
# `.error.message` (or the legacy top-level `.code`) — never the raw body,
# which could carry an OAuth access token, Gmail message content, or other
# sensitive payload fields.
api_error_summary() {
  local body="$1"
  local code
  code="$(json_get "$body" 'data.error ? data.error.code : (data.code || "")')"
  local message
  message="$(json_get "$body" 'data.error ? data.error.message : (data.message || "")')"
  if [ -n "$code" ] || [ -n "$message" ]; then
    printf '%s: %s' "${code:-UNKNOWN}" "${message:-no message}"
  else
    printf 'no structured error in response body'
  fi
}

# Like api_call, but sends one caller-supplied extra header. Added for
# nagex-task-e2e-live.sh's fixed-plan injection route, which requires an
# X-NAgex-Test-Token header the ordinary api_call() has no way to send —
# additive only, api_call() itself is untouched so nagex-check.sh and
# nagex-e2e-live.sh are unaffected.
api_call_with_header() {
  local method="$1"
  local url="$2"
  local payload="$3"
  local header_name="$4"
  local header_value="$5"
  local raw
  if [ -n "$payload" ]; then
    raw="$(curl -s -w '\n%{http_code}' -X "$method" -H "Content-Type: application/json" -H "x-nagex-tenant: ${TENANT}" -H "x-principal-id: ${PRINCIPAL}" -H "${header_name}: ${header_value}" -d "$payload" "$url" 2>/dev/null || printf '\n000')"
  else
    raw="$(curl -s -w '\n%{http_code}' -X "$method" -H "x-nagex-tenant: ${TENANT}" -H "x-principal-id: ${PRINCIPAL}" -H "${header_name}: ${header_value}" "$url" 2>/dev/null || printf '\n000')"
  fi
  API_CALL_STATUS="$(printf '%s' "$raw" | tail -n1)"
  API_CALL_BODY="$(printf '%s' "$raw" | sed '$d')"
}

resolve_log_dir() {
  local target="/var/log/nagex"
  if mkdir -p "$target" 2>/dev/null && [ -w "$target" ]; then
    echo "$target"
  else
    local fallback="${HOME}/.local/state/nagex/logs"
    mkdir -p "$fallback" 2>/dev/null
    echo "$fallback"
  fi
}

strip_ansi() {
  sed -E 's/\x1B\[[0-9;]*[a-zA-Z]//g'
}

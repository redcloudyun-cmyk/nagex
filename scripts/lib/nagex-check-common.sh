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
  printf '------------------------------------------\n'
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

#!/usr/bin/env bash
# Shared helpers for The Engineer's shell scripts (setup.sh, reset.sh).
#
# This file is sourced, never executed directly:
#   source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
#
# It provides colored section headers and an actionable failure helper, so
# every script speaks with one voice and no failure ends in a bare bash error.

# --- Colors -----------------------------------------------------------------
# Disabled when stdout is not a terminal (piped, redirected) or NO_COLOR is set.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD=$'\033[1m'
  DIM=$'\033[2m'
  RED=$'\033[31m'
  GREEN=$'\033[32m'
  YELLOW=$'\033[33m'
  CYAN=$'\033[36m'
  RESET=$'\033[0m'
else
  BOLD='' DIM='' RED='' GREEN='' YELLOW='' CYAN='' RESET=''
fi

# section <title> — a labelled step header, in the style of `==> Doing a thing`.
section() {
  printf '\n%s%s==>%s %s%s%s\n' "$BOLD" "$CYAN" "$RESET" "$BOLD" "$1" "$RESET"
}

# success <message> — a completed step.
success() {
  printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$1"
}

# warn <message> — a non-fatal problem the user should know about.
warn() {
  printf '  %s⚠%s %s\n' "$YELLOW" "$RESET" "$1"
}

# die <headline> [detail-line]... — print an actionable error and exit 1.
# The headline names what failed; each detail line tells the user what to do.
die() {
  printf '\n%s%s✗ %s%s\n' "$BOLD" "$RED" "$1" "$RESET" >&2
  shift
  for line in "$@"; do
    printf '  %s\n' "$line" >&2
  done
  printf '\n' >&2
  exit 1
}

# confirm <question> — ask a Y/n question (default Yes). Returns 0 for yes.
# Always call inside an `if`, so `set -e` does not treat a "no" as a failure.
confirm() {
  local answer
  printf '\n  %s %s[Y/n]%s ' "$1" "$DIM" "$RESET"
  read -r answer || true
  answer="${answer:-Y}"
  [[ "$answer" =~ ^[Yy] ]]
}

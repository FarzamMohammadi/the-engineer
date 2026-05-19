#!/usr/bin/env bash
# reset.sh — full rebuild of The Engineer, for fast iteration during development.
#
# Stops the daemon, rebuilds, relinks the `engineer` CLI, clears the data
# directory, and starts fresh.
#
# Usage:
#   ./scripts/reset.sh                            Wipe everything, then interactive setup.
#   ./scripts/reset.sh <seed-dir>                 Wipe everything, then setup seeded from <seed-dir>.
#   ./scripts/reset.sh --persist-data             Keep the database, workspaces, and .env;
#                                                 clear config only, then interactive setup.
#   ./scripts/reset.sh --persist-data <seed-dir>  As above, seeded from <seed-dir>.
#
# The seed directory is optional, and the two arguments are independent. With no
# seed, `engineer start` runs its interactive first-run setup. With a seed,
# setup is read from the directory's YAML files with no prompts. A seed argument
# that does not exist or cannot be read is a hard error.
#
# Note: a bare `./scripts/reset.sh` no longer auto-seeds from seed-example/.
# Pass your own seed directory (e.g. a gitignored seed-example-<name>/) to seed.

set -euo pipefail

# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  printf 'Usage: ./scripts/reset.sh [--persist-data] [seed-dir]\n'
}

# --- Parse arguments (still in the caller's directory) ----------------------

PERSIST_DATA=false
SEED_DIR=""

for arg in "$@"; do
  case "$arg" in
    --persist-data)
      PERSIST_DATA=true
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      die "Unknown flag: $arg" "$(usage)"
      ;;
    *)
      if [ -n "$SEED_DIR" ]; then
        die "Only one seed directory may be given — got '$SEED_DIR' and '$arg'." "$(usage)"
      fi
      SEED_DIR="$arg"
      ;;
  esac
done

# --- Validate the seed directory --------------------------------------------

if [ -n "$SEED_DIR" ]; then
  if [ ! -e "$SEED_DIR" ]; then
    die "Seed directory not found: '$SEED_DIR'" \
      "Check the path and try again, or run with no seed for interactive setup."
  fi
  if [ ! -d "$SEED_DIR" ]; then
    die "Seed path is not a directory: '$SEED_DIR'" \
      "Pass the directory that holds your 'configs/' and 'plugins/' folders."
  fi
  if [ ! -r "$SEED_DIR" ] || [ ! -x "$SEED_DIR" ]; then
    die "Seed directory is not readable: '$SEED_DIR'" \
      "Check its permissions and try again."
  fi
  # Resolve to an absolute path now, before the working directory changes.
  SEED_DIR="$(cd "$SEED_DIR" && pwd)"
fi

# --- Reset ------------------------------------------------------------------

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

readonly ENGINEER_HOME="$HOME/.engineer"

printf '\n%s%s  The Engineer%s %s· reset%s\n' "$BOLD" "$CYAN" "$RESET" "$DIM" "$RESET"

section "Stopping the daemon (if running)"
if [ -f dist/index.js ]; then
  node dist/index.js stop >/dev/null 2>&1 || true
fi
success "Daemon stopped"

section "Building the project"
if ! pnpm run build; then
  die "Build failed." \
    "Check the output above for the compile error, fix it, and run reset.sh again."
fi
success "Build complete"

section "Linking the CLI globally"
if pnpm link --global >/dev/null 2>&1; then
  success "CLI linked globally"
else
  warn "Could not link the CLI globally — 'engineer' may not be on your PATH."
  warn "This reset still completes. Run 'pnpm run setup' to fix global linking."
fi

if [ "$PERSIST_DATA" = true ]; then
  section "Clearing config (database, workspaces, and .env preserved)"
  for subdir in logs run state traces docs example-templates config; do
    rm -rf "${ENGINEER_HOME:?}/$subdir"
  done
  success "Ephemeral state and config cleared"
else
  section "Wiping the data directory"
  rm -rf "${ENGINEER_HOME:?}"
  success "Removed $ENGINEER_HOME"
fi

section "Starting The Engineer"
if [ -n "$SEED_DIR" ]; then
  printf '  Seeding setup from %s\n' "$SEED_DIR"
  exec node dist/index.js start --seed "$SEED_DIR"
else
  printf '  Running interactive first-run setup\n'
  exec node dist/index.js start
fi

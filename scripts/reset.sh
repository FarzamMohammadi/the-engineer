#!/usr/bin/env bash
# Reset: rebuild CLI, relink, optionally preserve data.
#
# Usage:
#   ./scripts/reset.sh                    # Full wipe (default)
#   ./scripts/reset.sh --persist-data     # Keep DB, workspaces, .env; re-seed config & plugins

set -euo pipefail

PERSIST_DATA=false
for arg in "$@"; do
  case "$arg" in
    --persist-data) PERSIST_DATA=true ;;
    *) echo "Unknown flag: $arg"; exit 1 ;;
  esac
done

# Ensure PNPM_HOME is set up (one-time, idempotent)
if [ -z "${PNPM_HOME:-}" ]; then
  echo "Setting up pnpm global bin..."
  pnpm setup 2>/dev/null || true
  export PNPM_HOME="$HOME/Library/pnpm"
  export PATH="$PNPM_HOME:$PATH"
fi

echo "Stopping (if running)..."
engineer stop 2>/dev/null || true

echo "Building..."
pnpm run build

echo "Linking globally..."
pnpm link --global

if [ "$PERSIST_DATA" = true ]; then
  echo "Cleaning ephemeral state (preserving DB, workspaces, .env; re-seeding config)..."
  rm -rf ~/.engineer/logs
  rm -rf ~/.engineer/run
  rm -rf ~/.engineer/state
  rm -rf ~/.engineer/traces
  rm -rf ~/.engineer/docs
  rm -rf ~/.engineer/example-templates
  rm -rf ~/.engineer/config
else
  echo "Wiping ~/.engineer..."
  rm -rf ~/.engineer
fi

SEED_PATH="$(cd "$(dirname "$0")/.." && pwd)/seed-example/"

if [ "$PERSIST_DATA" = true ]; then
  echo ""
  echo "Re-seeding from $SEED_PATH and starting..."
  engineer start --seed "$SEED_PATH"
else
  echo ""
  echo "Done. Run 'engineer start' to set up and start."
  read -p "Shall we start up the engineer? [Y/n] " answer
  answer="${answer:-Y}"
  if [[ "$answer" =~ ^[Yy]$ ]]; then
    engineer start --seed "$SEED_PATH"
  else
    echo "Ready to run:"
    echo "  engineer start --seed ./seed-example/"
  fi
fi

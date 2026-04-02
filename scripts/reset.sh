#!/usr/bin/env bash
# Reset: rebuild CLI, relink, optionally preserve data.
#
# Usage:
#   ./scripts/reset.sh              # Full wipe (default)
#   ./scripts/reset.sh --persist-data    # Keep DB, config, workspaces, .env

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
  echo "Cleaning ephemeral state (preserving DB, config, workspaces, .env)..."
  rm -rf ~/.engineer/logs
  rm -rf ~/.engineer/run
  rm -rf ~/.engineer/state
  rm -rf ~/.engineer/traces
  rm -rf ~/.engineer/docs
  rm -rf ~/.engineer/example-templates
else
  echo "Wiping ~/.engineer..."
  rm -rf ~/.engineer
fi

echo ""
echo "Done. Run 'engineer start' to set up and start."
read -p "Shall we start up the engineer? [Y/n] " answer
answer="${answer:-Y}"
if [[ "$answer" =~ ^[Yy]$ ]]; then
  if [ "$PERSIST_DATA" = true ]; then
    engineer start
  else
    engineer start --seed "$(dirname "$0")/../seed-example/"
  fi
else
  echo "Ready to run:"
  if [ "$PERSIST_DATA" = true ]; then
    echo "  engineer start"
  else
    echo "  engineer start --seed ./seed-example/"
  fi
fi

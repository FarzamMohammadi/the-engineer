#!/usr/bin/env bash
# Full reset: rebuild CLI, relink, wipe ~/.engineer, reinitialize.
# Usage: ./scripts/reset.sh

set -euo pipefail

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

echo "Wiping ~/.engineer..."
rm -rf ~/.engineer

echo ""
echo "Done. Run 'engineer start' to set up and start."
read -p "Shall we start up the engineer? [Y/n] " answer
answer="${answer:-Y}"
if [[ "$answer" =~ ^[Yy]$ ]]; then
  engineer start --seed "$(dirname "$0")/../seed-example/"
else
  echo "Ready to run:"
  echo "  engineer start --seed ./seed-example/"
fi

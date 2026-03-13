#!/usr/bin/env bash
# Full reset: rebuild CLI, relink, wipe ~/.engineer.
# Usage: ./scripts/reset.sh

set -euo pipefail

# Ensure PNPM_HOME is set up (one-time, idempotent)
if [ -z "${PNPM_HOME:-}" ]; then
  echo "Setting up pnpm global bin..."
  pnpm setup 2>/dev/null || true
  export PNPM_HOME="$HOME/Library/pnpm"
  export PATH="$PNPM_HOME:$PATH"
fi

echo "Building..."
pnpm run build

echo "Linking globally..."
pnpm link --global

echo "Wiping ~/.engineer..."
rm -rf ~/.engineer

echo ""
echo "Done. Now run:"
echo "  engineer prepare    # scaffold seed configs (skip if seed/ already exists)"
echo "  engineer init       # initialize ~/.engineer from seed"
echo "  engineer start      # start the daemon"

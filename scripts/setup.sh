#!/usr/bin/env bash
# setup.sh — one-command preparation for The Engineer.
#
# Invoked by `pnpm run setup`. It confirms what it will do, then installs
# dependencies, builds the project, and links the `engineer` command so it
# works from any directory.
#
# Usage:
#   pnpm run setup
#
# Safe to re-run at any time — every step is idempotent. Works on macOS and
# Linux (a POSIX shell is required; Windows is not supported).

set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib.sh
source "scripts/lib.sh"

readonly REQUIRED_NODE_MAJOR=22

# Set to true once `pnpm setup` runs, so the closing message can tell the user
# their current terminal needs a restart before `engineer` is on PATH.
RAN_PNPM_SETUP=false

# --- Preflight --------------------------------------------------------------

# check_node_version — fail early and clearly if Node.js is missing or too old.
# pnpm only warns on an engine mismatch, so without this a wrong version fails
# later with a cryptic build or runtime error.
check_node_version() {
  if ! command -v node >/dev/null 2>&1; then
    die "Node.js is not installed." \
      "The Engineer needs Node.js ${REQUIRED_NODE_MAJOR} or newer." \
      "Install it from https://nodejs.org/ then run 'pnpm run setup' again."
  fi

  local version major
  version="$(node --version)" # e.g. v22.3.0
  major="${version#v}"
  major="${major%%.*}"

  if [ "$major" -lt "$REQUIRED_NODE_MAJOR" ]; then
    die "Node.js ${version} is too old." \
      "The Engineer needs Node.js ${REQUIRED_NODE_MAJOR} or newer." \
      "Upgrade from https://nodejs.org/ then run 'pnpm run setup' again."
  fi

  success "Node.js ${version}"
}

# --- CLI linking ------------------------------------------------------------

# default_pnpm_home — pnpm's default global directory for this OS, used to make
# a freshly-run `pnpm setup` visible to the current shell.
default_pnpm_home() {
  case "$(uname -s)" in
    Darwin) printf '%s' "$HOME/Library/pnpm" ;;
    *) printf '%s' "${XDG_DATA_HOME:-$HOME/.local/share}/pnpm" ;;
  esac
}

# print_pnpm_panel — explain why `pnpm link --global` failed.
print_pnpm_panel() {
  printf '\n'
  printf '  %s│%s  %sAlmost there — one step left%s\n' "$YELLOW" "$RESET" "$BOLD" "$RESET"
  printf '  %s│%s\n' "$YELLOW" "$RESET"
  printf '  %s│%s  The build succeeded, but the %sengineer%s command could not\n' "$YELLOW" "$RESET" "$BOLD" "$RESET"
  printf '  %s│%s  be linked: pnpm'\''s global bin directory is not configured.\n' "$YELLOW" "$RESET"
  printf '  %s│%s  pnpm'\''s own '\''pnpm setup'\'' command sets it up — once.\n' "$YELLOW" "$RESET"
  printf '\n'
}

# print_skip_instructions — shown when the user declines `pnpm setup`.
print_skip_instructions() {
  printf '\n'
  success "Dependencies installed and project built — that work is saved."
  printf '\n'
  printf '  To finish linking later:\n'
  printf '    1. %spnpm setup%s        configure pnpm'\''s global bin directory\n' "$BOLD" "$RESET"
  printf '    2. restart your terminal\n'
  printf '    3. %spnpm run setup%s    re-run this script — it will link the CLI\n' "$BOLD" "$RESET"
  printf '\n'
  printf '  Or skip the global command and run The Engineer directly:\n'
  printf '    %spnpm dev start%s\n' "$BOLD" "$RESET"
  printf '\n'
}

# link_cli — link `engineer` globally, offering to configure pnpm first if its
# global bin directory has never been set up.
link_cli() {
  section "Linking the CLI globally"

  if pnpm link --global; then
    success "CLI linked globally"
    return 0
  fi

  print_pnpm_panel

  if ! confirm "Run 'pnpm setup' to configure it now?"; then
    print_skip_instructions
    exit 0
  fi

  section "Configuring pnpm's global bin directory"
  if ! pnpm setup; then
    die "'pnpm setup' did not complete." \
      "See the output above for the cause." \
      "Once pnpm is configured, run 'pnpm run setup' again."
  fi
  RAN_PNPM_SETUP=true
  # `pnpm setup` updates the shell profile, which this session has not loaded.
  # Make the global bin directory visible now so the retry below can use it.
  export PNPM_HOME="${PNPM_HOME:-$(default_pnpm_home)}"
  export PATH="$PNPM_HOME:$PATH"
  success "pnpm global bin directory configured"

  section "Linking the CLI globally (retry)"
  if ! pnpm link --global; then
    die "Linking still failed after configuring pnpm." \
      "Your dependencies and build are intact — nothing was lost." \
      "Finish manually: run 'pnpm setup', restart your terminal, then 'pnpm link --global'." \
      "Or run The Engineer without linking: 'pnpm dev start'."
  fi
  success "CLI linked globally"
}

# --- Main -------------------------------------------------------------------

main() {
  printf '\n%s%s  The Engineer%s %s· setup%s\n' "$BOLD" "$CYAN" "$RESET" "$DIM" "$RESET"

  section "Checking prerequisites"
  check_node_version

  section "Setup will run three steps"
  printf '    1. %sInstall dependencies%s   pnpm install\n' "$BOLD" "$RESET"
  printf '    2. %sBuild the project%s      pnpm run build\n' "$BOLD" "$RESET"
  printf '    3. %sLink the CLI globally%s  pnpm link --global\n' "$BOLD" "$RESET"

  if ! confirm "Proceed?"; then
    printf '\n  Setup cancelled — nothing was changed.\n\n'
    exit 0
  fi

  section "Installing dependencies"
  if ! pnpm install; then
    die "Dependency installation failed." \
      "Check the output above — this is usually a network issue." \
      "Fix it and run 'pnpm run setup' again."
  fi
  success "Dependencies installed"

  section "Building the project"
  if ! pnpm run build; then
    die "Build failed." \
      "Check the output above for the compile error." \
      "Fix it and run 'pnpm run setup' again."
  fi
  success "Build complete"

  link_cli

  section "Done"
  if [ "$RAN_PNPM_SETUP" = true ]; then
    printf '  The Engineer is built and linked. One last step:\n\n'
    printf '    1. Restart your terminal (it has not loaded the new PATH yet)\n'
    printf '    2. Run  %s%sengineer start%s\n\n' "$BOLD" "$GREEN" "$RESET"
  else
    printf '  The Engineer is ready.\n\n'
    printf '  Run  %s%sengineer start%s  to configure and launch the daemon.\n\n' "$BOLD" "$GREEN" "$RESET"
  fi
}

main

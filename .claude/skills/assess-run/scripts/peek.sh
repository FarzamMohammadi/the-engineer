#!/usr/bin/env bash
#
# assess-run peek — read ONE sub-phase trace the right way, so deep-dive never
# re-derives the fiddly ndjson jq path. Pass a trace file from triage §10.
#
# Prints three views: the agent's reasoning/output, the tools it used (in order
# and as counts), and the final result record (how the sub-phase ended).
#
# Usage:  peek.sh <path-to-ndjson>  [--full]      # --full = all reasoning, not the head
set -euo pipefail

FILE=""; FULL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --full) FULL=1; shift ;;
    -h|--help) echo "usage: peek.sh <path-to-ndjson> [--full]"; exit 0 ;;
    *) FILE="$1"; shift ;;
  esac
done
[ -n "$FILE" ] && [ -f "$FILE" ] || { echo "ERROR: trace file not found: $FILE (pick one from triage §10)"; exit 1; }

txt='select(.type=="assistant") | .message.content[]? | select(.type=="text") | .text'
tool='select(.type=="assistant") | .message.content[]? | select(.type=="tool_use") | .name'

echo "── REASONING (assistant text) ──"
if [ -n "$FULL" ]; then jq -rc "$txt" "$FILE"; else jq -rc "$txt" "$FILE" | head -60; fi

echo; echo "── TOOLS (in order) ──"
jq -rc "$tool" "$FILE" | tr '\n' ' '; echo
echo "── TOOLS (counts) ──"
jq -rc "$tool" "$FILE" | sort | uniq -c | sort -rn

echo; echo "── RESULT (how it ended) ──"
jq -rc 'select(.type=="result") | {subtype, is_error, duration_ms, num_turns, result: (.result // "")}' "$FILE"
